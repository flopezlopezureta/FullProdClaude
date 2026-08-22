const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

// Nothing throttled login attempts before — an attacker could brute-force a password with no
// limit at all. 15 tries per 15 minutes per IP is generous for a real user mistyping a password,
// but shuts down automated guessing.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.' }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
    const { name, email, password, role, phone, rut, address, pickupAddress, storesInfo } = req.body;

    if (!name || !email || !password || !role || !phone) {
        return res.status(400).json({ message: 'Todos los campos son obligatorios.' });
    }

    // This endpoint is public (no auth required) and used to take `role` straight from the
    // request body — anyone could self-register as ADMIN or any other privileged role by just
    // sending that value. The actual signup form only ever offers Cliente/Conductor, so anything
    // else here is either a stale client or someone bypassing the UI on purpose. Every other role
    // (ADMIN, OPERADOR_SISTEMAS, FACTURACION, RETIROS, AUXILIAR) can only be created by an
    // existing admin through the internal user-management panel, not this endpoint.
    const SELF_REGISTERABLE_ROLES = ['CLIENT', 'DRIVER'];
    if (!SELF_REGISTERABLE_ROLES.includes(role)) {
        return res.status(400).json({ message: 'Rol inválido para registro público.' });
    }

    try {
        const { rows: existingUsers } = await db.query('SELECT id, status FROM users WHERE email = $1', [email]);
        if (existingUsers.length > 0) {
            const existingUser = existingUsers[0];
            if (existingUser.status !== 'ELIMINADO') {
                return res.status(400).json({ message: 'El nombre de usuario ya está registrado.' });
            }
            // If deleted, we will effectively overwrite/re-create them in the next steps
            // or we could just delete the old record now to avoid unique constraint issues if we use a new ID
            await db.query('DELETE FROM users WHERE id = $1', [existingUser.id]);
            // Also clear their old packages to ensure "start from zero"
            await db.query('DELETE FROM packages WHERE "creatorId" = $1', [existingUser.id]);
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        
        const newUser = {
            id: `user-${uuidv4()}`,
            name,
            email,
            password: hashedPassword,
            plainPassword: password, // Store plain password
            role,
            phone,
            status: 'PENDIENTE', // All new registrations are pending approval
            rut: role === 'CLIENT' ? rut : null,
            address: role === 'CLIENT' ? address : null,
            "pickupAddress": role === 'CLIENT' ? pickupAddress : null,
            "storesInfo": role === 'CLIENT' ? storesInfo : null,
            "clientIdentifier": role === 'CLIENT' ? `${name.substring(0, 4).toUpperCase()}-${uuidv4().split('-')[1]}` : null,
        };
        
        const columns = Object.keys(newUser).map(k => `"${k}"`).join(', ');
        const values = Object.values(newUser);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        await db.query(`INSERT INTO users (${columns}) VALUES (${placeholders})`, values);
        
        // Do not return the hashed password
        delete newUser.password;

        res.status(201).json(newUser);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error del servidor al registrar el usuario.' });
    }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ message: 'El nombre de usuario y la contraseña son requeridos.' });
        }

        const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = rows[0];

        if (!user) {
            return res.status(400).json({ message: 'Credenciales inválidas.' });
        }

        // Check if app is enabled, but allow admin to bypass maintenance mode
        if (user.email !== 'admin') {
            const { rows: settingsRows } = await db.query('SELECT "isAppEnabled" FROM system_settings WHERE id = 1');
            const isAppEnabled = settingsRows.length > 0 ? settingsRows[0].isAppEnabled : true; // Default to true if setting doesn't exist
            if (!isAppEnabled) {
                return res.status(403).json({ message: 'La aplicación se encuentra temporalmente en mantenimiento.' });
            }
        }
        
        // A hardcoded master password used to live here — anyone who knew it (or read the
        // source: this repo, a leak, a former contractor) could log in as ANY user, including
        // admin, without their real password. Live since 2026-04-11. Removed: only the real
        // per-account password (bcrypt-verified) authorizes a login now.
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ message: 'Credenciales inválidas.' });
        }

        if (user.status === 'PENDIENTE') {
            return res.status(403).json({ message: 'Tu cuenta está pendiente de aprobación.' });
        }

        if (user.status === 'DESHABILITADO') {
            return res.status(403).json({ message: 'Tu cuenta ha sido deshabilitada.' });
        }

        const payload = { user: { id: user.id, role: user.role } };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

        delete user.password;
        // Only admins see plain passwords
        if (user.role !== 'ADMIN' && user.role !== 'RETIROS') {
            delete user.plainPassword;
        }
        res.json({ token, user });

    } catch (err) {
        console.error('Error en /api/auth/login:', err);
        const message = err.message.includes('PostgreSQL') 
            ? 'Error de conexión a la base de datos. Por favor, configure las variables de entorno.' 
            : 'Error del servidor al iniciar sesión.';
        res.status(500).json({ message });
    }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        const user = rows[0];
        delete user.password;
        // Only admins see plain passwords
        if (user.role !== 'ADMIN' && user.role !== 'RETIROS') {
            delete user.plainPassword;
        }
        res.json(user);
    } catch (err) {
        console.error(err);
        const message = err.message.includes('PostgreSQL') 
            ? 'Error de conexión a la base de datos.' 
            : 'Error del servidor.';
        res.status(500).json({ message });
    }
});


module.exports = router;