const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const timeService = require('../services/timeService');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { logAction } = require('../services/logger');

// Middleware to check for Admin or Retiros role
const adminOrRetirosOnly = (req, res, next) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'RETIROS') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }
    next();
};

const adminOnly = (req, res, next) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    next();
};


// GET /api/users - Get all users
router.get('/', authMiddleware, async (req, res) => {
    try {
        const { rows: users } = await db.query(`
            SELECT u.*, COUNT(p.id)::int as "packageCount"
            FROM users u
            LEFT JOIN packages p ON u.id = p."creatorId"
            GROUP BY u.id
            ORDER BY u.name ASC
        `);
        const safeUsers = users.map(user => {
            delete user.password;
            // Only admins can see plain passwords
            if (req.user.role !== 'ADMIN' && req.user.role !== 'RETIROS') {
                delete user.plainPassword;
            }
            return user;
        });
        res.json(safeUsers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al obtener los usuarios.' });
    }
});

// POST /api/users - Create a new user (Admin only)
router.post('/', authMiddleware, adminOnly, async (req, res) => {
    const { name, email, password, role, ...otherData } = req.body;

     if (!name || !email || !password || !role) {
        return res.status(400).json({ message: 'Nombre, email, password y rol son obligatorios.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = {
            id: `user-${uuidv4()}`,
            name,
            email,
            password: hashedPassword,
            plainPassword: password, // Store plain password for admin visibility
            role,
            status: 'APROBADO', // User created by admin is auto-approved
             ...otherData,
        };
        
        if (role === 'CLIENT') {
             newUser.clientIdentifier = `${name.substring(0, 4).toUpperCase()}-${uuidv4().split('-')[1]}`;
        }
        
        const columns = Object.keys(newUser).map(k => `"${k}"`).join(', ');
        const values = Object.values(newUser);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        await db.query(`INSERT INTO users (${columns}) VALUES (${placeholders})`, values);
        
        await logAction(req.user.id, req.user.name, 'CREATE_USER', { targetUserId: newUser.id, targetUserEmail: email, role });

        delete newUser.password;
        res.status(201).json(newUser);

    } catch (err) {
        console.error(err);
        if (err.code === '23505') { // PG unique violation
            return res.status(400).json({ message: 'El correo electrónico ya existe.' });
        }
        res.status(500).json({ message: 'Error del servidor al crear el usuario.' });
    }
});

// PUT /api/users/:id - Update a user
router.put('/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { password, ...incomingData } = req.body;

    // Authorization check: Admin can update anyone. Others can only update themselves.
    if (req.user.role !== 'ADMIN' && req.user.id !== id) {
        return res.status(403).json({ message: 'Acceso denegado. No tienes permiso para editar este perfil.' });
    }

    try {
        let updateData = {};

        if (req.user.role === 'ADMIN') {
            // Admins can update everything
            updateData = { ...incomingData };
        } else {
            // Non-admins (Clients/Drivers) can only update specific safe fields
            const safeFields = ['name', 'phone', 'address', 'pickupAddress', 'integrations', 'rut'];
            safeFields.forEach(field => {
                if (incomingData[field] !== undefined) {
                    updateData[field] = incomingData[field];
                }
            });
            
            // Log attempt to change protected fields if any
            const protectedFields = ['role', 'status', 'pricing', 'clientIdentifier', 'billingName', 'billingRut'];
            const attemptedProtected = protectedFields.filter(f => incomingData[f] !== undefined);
            if (attemptedProtected.length > 0) {
                console.warn(`User ${req.user.id} attempted to update protected fields: ${attemptedProtected.join(', ')}`);
            }
        }

        if (password) {
            const salt = await bcrypt.genSalt(10);
            updateData.password = await bcrypt.hash(password, salt);
            updateData.plainPassword = password; // Update plain password
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ message: 'No se enviaron campos válidos para actualizar.' });
        }

        const fields = Object.keys(updateData);
        const values = Object.values(updateData);
        const setClause = fields.map((field, i) => `"${field}" = $${i + 1}`).join(', ');

        const queryText = `UPDATE users SET ${setClause} WHERE id = $${fields.length + 1}`;
        const queryParams = [...values, id];
        
        const result = await db.query(queryText, queryParams);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        
        await logAction(req.user.id, req.user.name, 'UPDATE_USER', { targetUserId: id, updatedFields: fields });

        const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
        const updatedUser = rows[0];
        delete updatedUser.password;
        
        res.json(updatedUser);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar el usuario.' });
    }
});


// DELETE /api/users/:id - Delete a user (Admin only, with password verification)
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ message: 'La contraseña de administrador es requerida.' });
    }

    try {
        // 1. Verify admin password
        const { rows: adminRows } = await db.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        const admin = adminRows[0];
        const isMatch = await bcrypt.compare(password, admin.password);
        
        if (!isMatch) {
            return res.status(401).json({ message: 'Contraseña de administrador incorrecta.' });
        }

        // 2. Soft delete user (mark as ELIMINADO)
        const result = await db.query("UPDATE users SET status = 'ELIMINADO' WHERE id = $1", [id]);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        // 3. Clear integrations to prevent conflicts
        await db.query("UPDATE users SET integrations = '{}' WHERE id = $1", [id]);

        await logAction(req.user.id, req.user.name, 'SOFT_DELETE_USER', { targetUserId: id });

        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar el usuario.' });
    }
});

// POST /api/users/:id/reintegrate - Reintegrate a deleted user (Admin only)
router.post('/:id/reintegrate', authMiddleware, adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        // 1. Reactivate user
        const result = await db.query("UPDATE users SET status = 'APROBADO' WHERE id = $1", [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        // 2. Clear shipments (Start from zero)
        await db.query('DELETE FROM packages WHERE "creatorId" = $1', [id]);

        await logAction(req.user.id, req.user.name, 'REINTEGRATE_USER', { targetUserId: id });

        const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
        const user = rows[0];
        delete user.password;
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al reintegrar el usuario.' });
    }
});

// POST /api/users/:id/approve - Approve a user
router.post('/:id/approve', authMiddleware, adminOnly, async (req, res) => {
    try {
        const result = await db.query("UPDATE users SET status = 'APROBADO' WHERE id = $1", [req.params.id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
        const user = rows[0];
        delete user.password;
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al aprobar el usuario.' });
    }
});

// POST /api/users/:id/toggle-status
router.post('/:id/toggle-status', authMiddleware, adminOnly, async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await db.query('SELECT status FROM users WHERE id = $1', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });
        const newStatus = rows[0].status === 'APROBADO' ? 'DESHABILITADO' : 'APROBADO';
        await db.query('UPDATE users SET status = $1 WHERE id = $2', [newStatus, id]);
        const { rows: updatedRows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
        const user = updatedRows[0];
        delete user.password;
        res.json(user);
    } catch(err) {
        console.error(err);
        res.status(500).json({ message: 'Error al cambiar el estado del usuario.' });
    }
});


router.get('/fleet-status', authMiddleware, adminOnly, async (req, res) => {
    try {
        const targetDate = req.query.date || await timeService.getLogicalDate();
        const { start, nextDayStart } = await timeService.getLogicalRange(targetDate, targetDate);
        
        // Fetch system timezone dynamically
        const { rows: settingsRows } = await db.query('SELECT timezone FROM system_settings WHERE id = 1');
        const systemTZ = settingsRows.length > 0 ? settingsRows[0].timezone : 'America/Santiago';
        
        const query = `
            WITH active_drivers AS (
                -- Conductores con paquetes programados o asignados para la fecha objetivo
                SELECT DISTINCT "driverId" as driver_id FROM packages
                WHERE "driverId" IS NOT NULL
                AND (
                    ("estimatedDelivery" >= $1 AND "estimatedDelivery" <= $2)
                    OR ("assignedAt" >= $1 AND "assignedAt" <= $2)
                )
            )
            SELECT 
                u.id as driver_id, 
                u.name as driver_name, 
                u.phone,
                COALESCE(p_stats.total, 0) as total_packages,
                COALESCE(p_stats.delivered, 0) as delivered_packages,
                COALESCE(p_stats.problems, 0) as problem_packages,
                COALESCE(p_stats.pending, 0) as pending_packages,
                p_stats.last_pkg_update
            FROM active_drivers ad
            JOIN users u ON ad.driver_id = u.id
            LEFT JOIN (
                SELECT 
                    "driverId",
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'ENTREGADO') as delivered,
                    COUNT(*) FILTER (WHERE status IN ('PROBLEMA', 'REPROGRAMADO', 'DEVUELTO')) as problems,
                    COUNT(*) FILTER (WHERE status IN ('PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO')) as pending,
                    MAX("updatedAt") as last_pkg_update
                FROM packages
                WHERE "driverId" IS NOT NULL
                AND (
                    ("estimatedDelivery" >= $1 AND "estimatedDelivery" <= $2)
                    OR ("assignedAt" >= $1 AND "assignedAt" <= $2)
                )
                GROUP BY "driverId"
            ) p_stats ON u.id = p_stats."driverId"
            WHERE u.status NOT IN ('ELIMINADO', 'DESHABILITADO', 'PENDIENTE')
            ORDER BY pending DESC, u.name ASC
        `;
        
        const { rows } = await db.query(query, [start, nextDayStart]);
        
        // Final logic adjustment in JS for clarity
        const processedRows = rows.map(row => {
            const hasPackages = parseInt(row.total_packages) > 0;
            const isCompleted = (hasPackages && parseInt(row.pending_packages) === 0);
            
            return {
                ...row,
                last_update: row.last_pkg_update,
                is_completed: isCompleted
            };
        });
        
        res.json(processedRows);
    } catch (err) {
        console.error('Error fetching fleet status:', err);
        res.status(500).json({ message: 'Error al obtener el estado de la flota.' });
    }
});

// GET /api/users/analytics - Advanced productivity metrics for reports
router.get('/analytics', authMiddleware, adminOnly, async (req, res) => {
    try {
        const targetDate = req.query.date || await timeService.getLogicalDate();
        const { start, nextDayStart } = await timeService.getLogicalRange(targetDate, targetDate);
        
        // Fetch system timezone dynamically
        const { rows: settingsRows } = await db.query('SELECT timezone FROM system_settings WHERE id = 1');
        const systemTZ = settingsRows.length > 0 ? settingsRows[0].timezone : 'America/Santiago';

        // 1. Flow of deliveries per hour (Total packages delivered by hour)
        const hourlyQuery = `
            SELECT 
                EXTRACT(HOUR FROM p."updatedAt" AT TIME ZONE 'UTC' AT TIME ZONE $3)::text || ':00' as hour,
                COUNT(*)::int as count
            FROM packages p
            WHERE p.status = 'ENTREGADO'
            AND p."updatedAt" >= $1 AND p."updatedAt" <= $2
            GROUP BY hour
            ORDER BY hour ASC
        `;

        // 2. Efficiency Ranking
        const rankingQuery = `
            SELECT 
                u.name,
                COUNT(*)::int as delivered,
                ROUND(AVG(EXTRACT(EPOCH FROM (p."updatedAt" - p."assignedAt")))/60, 1) as "avg_minutes",
                COUNT(*)::float as "efficiency_score"
            FROM packages p
            JOIN users u ON p."driverId" = u.id
            WHERE p.status = 'ENTREGADO'
            AND p."updatedAt" >= $1 AND p."updatedAt" <= $2
            AND p."assignedAt" IS NOT NULL
            GROUP BY u.name
            ORDER BY delivered DESC
        `;

        const [hourlyData, rankingData] = await Promise.all([
            db.query(hourlyQuery, [start, nextDayStart, systemTZ]),
            db.query(rankingQuery, [start, nextDayStart])
        ]);

        const totalDelivered = rankingData.rows.reduce((sum, r) => sum + r.delivered, 0);
        const avgGlobal = rankingData.rows.length > 0 
            ? Math.round(rankingData.rows.reduce((sum, r) => sum + r.avg_minutes, 0) / rankingData.rows.length)
            : 0;

        res.json({
            hourly_flow: hourlyData.rows,
            driver_efficiency: rankingData.rows,
            summary: {
                total_delivered: totalDelivered,
                avg_delivery_time: avgGlobal,
                top_driver: rankingData.rows[0]?.name || '-',
                efficiency_trend: 'STABLE'
            }
        });
    } catch (err) {
        console.error('Error fetching analytics:', err);
        res.status(500).json({ message: 'Error al obtener estadísticas avanzadas.' });
    }
});

// GET /api/users/fleet-control-center - Datos multimodales unificados para el Centro de Control
router.get('/fleet-control-center', authMiddleware, adminOrRetirosOnly, async (req, res) => {
    try {
        const targetDate = req.query.date || await timeService.getLogicalDate();
        const { start, nextDayStart } = await timeService.getLogicalRange(targetDate, targetDate);

        // Fetch timezone settings
        const { rows: settingsRows } = await db.query('SELECT timezone FROM system_settings WHERE id = 1');
        const systemTZ = settingsRows.length > 0 ? settingsRows[0].timezone : 'America/Santiago';

        // 1. Auditoría de Cierres
        const closureQuery = `
            SELECT 
                u.id as "driverId",
                u.name as "driverName",
                u.phone as "driverPhone",
                COUNT(p.id)::int as "totalPackages",
                COUNT(p.id) FILTER (WHERE p.status = 'ENTREGADO')::int as "delivered",
                COUNT(p.id) FILTER (WHERE p.status IN ('PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO'))::int as "pending",
                COUNT(p.id) FILTER (WHERE p.status IN ('PROBLEMA', 'REPROGRAMADO', 'DEVUELTO'))::int as "failed",
                EXISTS (
                    SELECT 1 FROM daily_closures dc 
                    WHERE dc."driverId" = u.id AND dc."date" = $1
                ) as "hasClosedInApp",
                (
                    SELECT dc."createdAt" FROM daily_closures dc 
                    WHERE dc."driverId" = u.id AND dc."date" = $1 
                    LIMIT 1
                ) as "closureTimestamp",
                (
                    SELECT COUNT(*)::int FROM daily_closures dc
                    WHERE dc."driverId" = u.id AND dc."createdAt" >= NOW() - INTERVAL '30 days'
                ) as "closuresLast30Days"
            FROM users u
            JOIN packages p ON p."driverId" = u.id
            WHERE u.role = 'DRIVER'
            AND u.status NOT IN ('ELIMINADO', 'DESHABILITADO', 'PENDIENTE')
            AND (
                (p."estimatedDelivery" >= $2 AND p."estimatedDelivery" <= $3)
                OR (p."assignedAt" >= $2 AND p."assignedAt" <= $3)
                OR (p."updatedAt" >= $2 AND p."updatedAt" <= $3)
                OR (p."createdAt" >= $2 AND p."createdAt" <= $3)
            )
            GROUP BY u.id, u.name, u.phone
            ORDER BY "pending" DESC, "hasClosedInApp" ASC, u.name ASC
        `;

        // 2. Cadencia y Tiempos entre Entregas
        const cadenceQuery = `
            WITH delivery_times AS (
                SELECT 
                    p."driverId",
                    p."updatedAt",
                    LAG(p."updatedAt") OVER (PARTITION BY p."driverId" ORDER BY p."updatedAt") as prev_delivery
                FROM packages p
                WHERE p.status = 'ENTREGADO'
                AND p."updatedAt" >= $2 AND p."updatedAt" <= $3
            )
            SELECT 
                u.id as "driverId",
                u.name as "driverName",
                COUNT(dt."updatedAt")::int as "deliveredCount",
                COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (dt."updatedAt" - dt.prev_delivery))/60)::numeric, 1), 0) as "avgMinutesBetweenDeliveries",
                COALESCE(MAX(ROUND(EXTRACT(EPOCH FROM (dt."updatedAt" - dt.prev_delivery))/60)::numeric), 0) as "maxMinutesGap",
                COALESCE(COUNT(dt."updatedAt") FILTER (WHERE EXTRACT(EPOCH FROM (dt."updatedAt" - dt.prev_delivery))/60 > 45), 0)::int as "idleAlertsCount"
            FROM users u
            LEFT JOIN delivery_times dt ON u.id = dt."driverId" AND dt.prev_delivery IS NOT NULL
            WHERE u.role = 'DRIVER' AND u.status NOT IN ('ELIMINADO', 'DESHABILITADO')
            GROUP BY u.id, u.name
            HAVING COUNT(dt."updatedAt") > 0
            ORDER BY "avgMinutesBetweenDeliveries" ASC
        `;

        // 3. Cronometría de Jornada (Horarios de inicio, fin y duración)
        const chronometryQuery = `
            SELECT 
                u.id as "driverId",
                u.name as "driverName",
                MIN(p."updatedAt" AT TIME ZONE 'UTC' AT TIME ZONE $4) as "firstActivity",
                MAX(p."updatedAt" AT TIME ZONE 'UTC' AT TIME ZONE $4) as "lastActivity",
                ROUND(EXTRACT(EPOCH FROM (MAX(p."updatedAt") - MIN(p."updatedAt")))/3600::numeric, 2) as "totalHoursActive",
                COUNT(p.id) FILTER (WHERE p.status = 'ENTREGADO')::int as "deliveredCount"
            FROM users u
            JOIN packages p ON p."driverId" = u.id
            WHERE u.role = 'DRIVER'
            AND p."updatedAt" >= $2 AND p."updatedAt" <= $3
            GROUP BY u.id, u.name
            ORDER BY "firstActivity" ASC
        `;

        const [closuresRes, cadenceRes, chronometryRes] = await Promise.all([
            db.query(closureQuery, [targetDate, start, nextDayStart]),
            db.query(cadenceQuery, [start, nextDayStart]),
            db.query(chronometryQuery, [targetDate, start, nextDayStart, systemTZ])
        ]);

        res.json({
            date: targetDate,
            closures: closuresRes.rows,
            cadence: cadenceRes.rows,
            chronometry: chronometryRes.rows
        });

    } catch (err) {
        console.error('Error fetching fleet control center data:', err);
        res.status(500).json({ message: 'Error al cargar el Centro de Control Multimodal.' });
    }
});

// POST /api/users/notify-driver-closure - Enviar recordatorio de cierre a un conductor
router.post('/notify-driver-closure', authMiddleware, adminOrRetirosOnly, async (req, res) => {
    const { driverId } = req.body;
    if (!driverId) {
        return res.status(400).json({ message: 'Se requiere driverId' });
    }

    try {
        const { rows } = await db.query('SELECT id, name, phone FROM users WHERE id = $1', [driverId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Conductor no encontrado.' });
        }

        const driver = rows[0];
        
        // Registrar notificación en la BD para la app del conductor
        await db.query(`
            INSERT INTO notifications (id, "userId", title, message, type, "isRead", "createdAt")
            VALUES ($1, $2, $3, $4, $5, false, NOW())
        `, [
            `notif-${uuidv4()}`,
            driver.id,
            '🚨 RECORDATORIO DE CIERRE DE JORNADA',
            'Hola, recuerda que debes realizar el Cierre de Jornada en tu aplicación para liquidar tus entregas del día.',
            'SYSTEM'
        ]);

        await logAction(req.user.id, req.user.name, 'NOTIFY_DRIVER_CLOSURE', { driverId, driverName: driver.name });

        res.json({ message: `Recordatorio enviado con éxito a ${driver.name}` });
    } catch (err) {
        console.error('Error sending closure notification:', err);
        res.status(500).json({ message: 'Error al enviar la notificación.' });
    }
});

module.exports = router;
