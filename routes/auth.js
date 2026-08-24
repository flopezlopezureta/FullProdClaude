const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { checkVpnOrProxy } = require('../services/ipIntelligence');
const { logAction } = require('../services/logger');

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
// Public self-registration is closed — new accounts (client, driver, or otherwise) are created
// by an admin through the user-management panel now. This endpoint used to accept `role`
// straight from the request body with no restriction (anyone could self-register as ADMIN by
// just sending that value); rather than leave a narrowed-but-still-public account-creation path
// sitting on the internet, it's disabled outright.
router.post('/register', async (req, res) => {
    return res.status(403).json({ message: 'El registro público está deshabilitado. Contacta a un administrador para crear tu cuenta.' });
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

        // Checked only after the password is confirmed correct — no point spending a lookup (or
        // giving an attacker any signal) on a guess that was wrong anyway. Fails open: if the
        // lookup service errors out, checkVpnOrProxy resolves isVpn:false and login proceeds
        // normally, so a broken third-party API can never lock everyone out.
        const clientIp = req.headers['cf-connecting-ip'] || req.ip;
        const { isVpn } = await checkVpnOrProxy(clientIp);
        if (isVpn) {
            await logAction(user.id, user.name, 'LOGIN_BLOCKED_VPN', { ip: clientIp, email: user.email });
            return res.status(403).json({ message: 'No se puede iniciar sesión desde una conexión VPN o proxy. Desactívala e intenta de nuevo.' });
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