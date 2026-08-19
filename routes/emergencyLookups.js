const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const isSuperUserEmail = (email) => email === 'admin' || email === 'admin@admin.cl';
async function requireSuperUser(req, res, next) {
    try {
        const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user?.id]);
        if (isSuperUserEmail(rows[0]?.email)) return next();
    } catch (e) { /* falls through to 403 below */ }
    return res.status(403).json({ message: 'Solo el super admin puede ver este registro.' });
}

// GET /api/emergency-lookups
// Log of every driver scan-to-dispatch that didn't find the package locally
// and had to fall back to an emergency live lookup against Mercado Libre —
// lets an admin see which clients/times this is happening for, and how long
// the lookup itself takes, to diagnose "assignment gets stuck" complaints.
router.get('/', authMiddleware, requireSuperUser, async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT
                l.id,
                l."searchedCode",
                l."driverId",
                d.name AS "driverName",
                l."clientId",
                c.name AS "clientName",
                l.success,
                l."durationMs",
                l."createdAt"
            FROM meli_emergency_lookups l
            LEFT JOIN users d ON d.id = l."driverId"
            LEFT JOIN users c ON c.id = l."clientId"
            ORDER BY l."createdAt" DESC
            LIMIT 500
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching emergency lookups:', err);
        res.status(500).json({ message: 'Error al obtener el registro de búsquedas de emergencia.' });
    }
});

module.exports = router;
