const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const timeService = require('../services/timeService');
const { buildDriverDayRoute, isIsoDate } = require('../services/driverDayRoute');

// POST /api/geo/update-location
router.post('/update-location', authMiddleware, async (req, res) => {
    const { driverId, latitude, longitude } = req.body;
    
    // Quick validation
    if (req.user.id !== driverId && req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'No tienes permiso para actualizar esta ubicación.' });
    }

    try {
        await db.query(
            'UPDATE users SET latitude = $1, longitude = $2, "lastLocationUpdate" = $3 WHERE id = $4',
            [latitude, longitude, new Date(), driverId]
        );
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar la ubicación.' });
    }
});

// GET /api/geo/active-drivers
router.get('/active-drivers', authMiddleware, async (req, res) => {
    try {
        // Get drivers with a location update in the last 5 minutes
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const { rows: drivers } = await db.query(
            'SELECT id, name, email, latitude, longitude, "lastLocationUpdate" FROM users WHERE role = \'DRIVER\' AND status = \'APROBADO\' AND "lastLocationUpdate" > $1',
            [fiveMinutesAgo]
        );
        res.json(drivers);
    } catch (err) {
        if (err.code === '42P01' || err.code === '42703') { // undefined_table or undefined_column
            return res.json([]); // Return empty if table/column doesn't exist
        }
        console.error(err);
        res.status(500).json({ message: 'Error al obtener la ubicación de los conductores.' });
    }
});

// GET /api/geo/driver-route?driverId=...[&date=YYYY-MM-DD]
// Paradas de un conductor en un día (por defecto hoy, día lógico con corte 02:00) con la hora real de cada visita, para dibujar su ruta
// realizada y calcular la sugerida en el Mapa en Vivo. Solo lectura; solo administradores y operadores (trae direcciones de clientes).
router.get('/driver-route', authMiddleware, async (req, res) => {
    if (!['ADMIN', 'OPERADOR_SISTEMAS'].includes(req.user.role)) {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }
    try {
        const tz = await timeService.getSystemTimezone();
        const today = await timeService.getLogicalDate();
        const date = req.query.date ? String(req.query.date) : today;
        if (!isIsoDate(date)) return res.status(400).json({ message: 'date debe ser una fecha válida YYYY-MM-DD.' });
        if (date > today) return res.status(400).json({ message: 'No hay rutas de días futuros.' });
        const driverId = String(req.query.driverId || '');
        if (!driverId || driverId.length > 100) return res.status(400).json({ message: 'Falta driverId.' });
        const result = await buildDriverDayRoute({ query: (text, params) => db.query(text, params), driverId, date, tz, today });
        if (!result) return res.status(404).json({ message: 'Conductor no encontrado.' });
        res.json(result);
    } catch (err) {
        console.error('Error in driver-route:', err);
        res.status(500).json({ message: 'Error al obtener la ruta del conductor.' });
    }
});

module.exports = router;