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

// TEMPORARY — repairs the 2 Falabella Directo UAT test packages (GOLIVERY3/4) that got stuck
// ENTREGADO locally but never actually closed on Falabella's side, because they were pushed
// before the IN_TRANSIT_001-sequencing and empty-recipientId bugs were fixed. Retroactively
// pushes the same status sequence a healthy delivery would have sent. Super-admin only, and
// meant to be removed in a follow-up cleanup commit once run once successfully.
const isSuperUserEmail = (email) => email === 'admin' || email === 'admin@admin.cl';
async function requireSuperUserDebug(req, res, next) {
    try {
        const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user?.id]);
        if (isSuperUserEmail(rows[0]?.email)) return next();
    } catch (e) { /* falls through to 403 below */ }
    return res.status(403).json({ message: 'Solo el super admin puede ejecutar esta reparación.' });
}

router.post('/repair-falabella-direct-stuck', authMiddleware, requireSuperUserDebug, async (req, res) => {
    const falabellaDirectService = require('../services/falabellaDirectService');
    const { signPhotoToken } = require('../services/falabellaCrypto');
    const PACKAGE_IDS = ['FALDIR-8b6e5665', 'FALDIR-7c8ed7ac']; // GOLIVERY3, GOLIVERY4
    const TEST_RUT = '11.111.111-1'; // placeholder — these are Falabella's own UAT test LPNs

    const results = [];

    for (const pkgId of PACKAGE_IDS) {
        const steps = [];
        try {
            const { rows } = await db.query('SELECT * FROM packages WHERE id = $1', [pkgId]);
            const pkg = rows[0];
            if (!pkg) { results.push({ pkgId, skipped: true, reason: 'not found' }); continue; }

            const { rows: driverRows } = await db.query('SELECT latitude, longitude FROM users WHERE id = $1', [pkg.driverId]);
            const latitude = driverRows[0]?.latitude ?? 0;
            const longitude = driverRows[0]?.longitude ?? 0;

            await falabellaDirectService.pushStatusUpdate(pkg.falabellaDirectLpn, 'IN_TRANSIT_001', 'Paquete recibido por Full Envíos (registro retroactivo).', { latitude, longitude });
            steps.push('IN_TRANSIT_001: OK');

            await falabellaDirectService.pushStatusUpdate(pkg.falabellaDirectLpn, 'OUT_FOR_DELIVERY_001', 'Recibido por el conductor, en reparto (registro retroactivo).', { latitude, longitude });
            steps.push('OUT_FOR_DELIVERY_001: OK');

            await db.query('UPDATE packages SET "deliveryReceiverId" = $1 WHERE id = $2', [TEST_RUT, pkgId]);

            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const images = Array.from({ length: 2 }, (_, i) =>
                `${baseUrl}/api/packages/public/falabella-photo/${pkgId}/${i}?token=${signPhotoToken(pkgId, i)}`
            );
            await falabellaDirectService.pushStatusUpdate(pkg.falabellaDirectLpn, 'DELIVERED_001', `Entregado a ${pkg.deliveryReceiverName}.`, {
                latitude, longitude,
                deliveryProof: { recipientName: pkg.deliveryReceiverName, recipientId: TEST_RUT, images },
            });
            steps.push('DELIVERED_001: OK — cerrado correctamente en Falabella.');
            await db.query('UPDATE packages SET "falabellaDirectLastPushedStatus" = $1, "falabellaDirectLastPushedAt" = NOW() WHERE id = $2', ['DELIVERED_001', pkgId]);

            results.push({ pkgId, lpn: pkg.falabellaDirectLpn, success: true, steps });
        } catch (e) {
            results.push({ pkgId, success: false, steps, error: e.message });
        }
    }

    const { rowCount } = await db.query(
        `DELETE FROM integration_sync_queue WHERE "packageId" = ANY($1) AND integration = 'FALABELLA_DIRECTO'`,
        [PACKAGE_IDS]
    );

    res.json({ results, removedQueuedRetries: rowCount });
});

// TEMPORARY — companion to the repair endpoint above, but for the case where Falabella wants a
// genuine corrected resend rather than a silent backend patch: deletes the 2 stuck GOLIVERY3/4
// test packages entirely (and their tracking_events/queued retries) so their LPN is free again —
// routes/falabellaDirect.js's /import-scanned is idempotent on falabellaDirectLpn, so as long as
// the old row exists, rescanning just returns "ya había sido escaneado" and does nothing new.
// Super-admin only, meant to be removed in a follow-up cleanup commit once run once successfully.
router.post('/reset-falabella-direct-stuck', authMiddleware, requireSuperUserDebug, async (req, res) => {
    const PACKAGE_IDS = ['FALDIR-8b6e5665', 'FALDIR-7c8ed7ac']; // GOLIVERY3, GOLIVERY4

    await db.query('DELETE FROM integration_sync_queue WHERE "packageId" = ANY($1)', [PACKAGE_IDS]);
    await db.query('DELETE FROM tracking_events WHERE "packageId" = ANY($1)', [PACKAGE_IDS]);
    const { rows } = await db.query('DELETE FROM packages WHERE id = ANY($1) RETURNING id, "falabellaDirectLpn"', [PACKAGE_IDS]);

    res.json({ deleted: rows, message: 'Listo. Los LPN de GOLIVERY3 y GOLIVERY4 quedan libres para volver a escanearse como paquetes nuevos.' });
});

module.exports = router;
