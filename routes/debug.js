const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { emitDriverEvent } = require('../services/driverEvents');

// This file was missing and is referenced in server.js.
// Creating a placeholder to ensure server stability.

// Example debug route to check DB connection
router.get('/db-check', async (req, res) => {
    try {
        const { rows: dbInfo } = await db.query("SELECT current_database(), current_user, inet_server_addr()");
        const { rows: packageCount } = await db.query("SELECT count(*) FROM packages");
        
        res.status(200).json({ 
            status: 'ok', 
            message: 'Database connection successful.',
            database: dbInfo[0].current_database,
            user: dbInfo[0].current_user,
            server_addr: dbInfo[0].inet_server_addr,
            packageCount: parseInt(packageCount[0].count),
            envHost: process.env.DB_HOST,
            envName: process.env.DB_NAME,
            nodeEnv: process.env.NODE_ENV
        });
    } catch (err) {
        res.status(500).json({ 
            status: 'error', 
            message: 'Database connection failed.', 
            error: err.message,
            envHost: process.env.DB_HOST,
            envName: process.env.DB_NAME
        });
    }
});


router.get('/meli-check/:id', async (req, res) => {
    const shipmentId = req.params.id;
    const https = require('https');
    const meliPollingService = require('../services/meliPollingService');

    const makeMeliRequest = (path, accessToken) => {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.mercadolibre.com',
                path,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
                });
            });
            req.on('error', (e) => reject(e));
            req.end();
        });
    };

    try {
        const { rows: users } = await db.query("SELECT id, name FROM users WHERE integrations->'meli' IS NOT NULL");
        let results = [];
        
        for (const user of users) {
            try {
                const token = await meliPollingService.getValidMeliToken(user.id);
                if (!token) continue;
                
                const shipment = await makeMeliRequest(`/shipments/${shipmentId}`, token);
                results.push({
                    client: user.name,
                    clientId: user.id,
                    found: !!shipment.id,
                    details: shipment.id ? shipment : shipment.message || shipment
                });
            } catch (err) {
                results.push({ client: user.name, error: err.message });
            }
        }
        res.json({ shipmentId, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/debug/simulate-meli-closure
// Admin-only testing tool. Exercises the exact same downstream path as a real
// Mercado Libre delivery-closure detection (mark "meliDeliveredNeedsPhotos" +
// push the MELI_DELIVERY_CLOSED SSE signal) WITHOUT calling the real ML API,
// so the real-time auto-open-modal feature can be tested without needing to
// actually close a live shipment. Only ever touches the one package passed in.
router.post('/simulate-meli-closure', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Solo administradores pueden usar esta herramienta.' });
    }
    const { packageId } = req.body;
    if (!packageId) {
        return res.status(400).json({ message: 'Se requiere packageId.' });
    }
    try {
        const { rows } = await db.query(
            'SELECT id, "driverId", status, "meliOrderId", "meliFlexCode" FROM packages WHERE id = $1',
            [packageId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Paquete no encontrado.' });
        }
        const pkg = rows[0];
        if (!pkg.driverId) {
            return res.status(400).json({ message: 'Este paquete no tiene conductor asignado.' });
        }

        await db.query(
            'UPDATE packages SET "meliDeliveredNeedsPhotos" = true, "updatedAt" = NOW() WHERE id = $1',
            [packageId]
        );

        emitDriverEvent(pkg.driverId, {
            packageId: pkg.id,
            trackingId: pkg.meliOrderId || pkg.meliFlexCode || null,
            type: 'MELI_DELIVERY_CLOSED'
        });

        res.json({
            success: true,
            message: `Simulación enviada: paquete ${packageId} marcado como cerrado en Meli para el conductor ${pkg.driverId}.`
        });
    } catch (err) {
        res.status(500).json({ message: 'Error al simular el cierre.', error: err.message });
    }
});

module.exports = router;
