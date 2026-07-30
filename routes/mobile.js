const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const https = require('https');
const timeService = require('../services/timeService');

// --- MELI API HELPERS ---
const makeMeliRequest = (options, postData = null) => {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                         resolve(parsedData);
                    } else { reject({ statusCode: res.statusCode, body: parsedData }); }
                } catch (e) { reject({ statusCode: res.statusCode, body: data, isRaw: true }); }
            });
        });
        req.on('error', (e) => reject(e));
        if (postData) req.write(postData);
        req.end();
    });
};
const makeMeliGetRequest = (path, accessToken) => makeMeliRequest({
    hostname: 'api.mercadolibre.com', path, method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}` }
});
const makeMeliPostRequest = (path, postData) => makeMeliRequest({
    hostname: 'api.mercadolibre.com', path, method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
}, postData);
// --- END MELI HELPERS ---

/**
 * GET /api/entregas
 * Entrega la lista de entregas pendientes para el conductor autenticado.
 * Estructura ultra ligera para App Android Nativa.
 */
router.get('/entregas', authMiddleware, async (req, res) => {
    try {
        // Solo conductores pueden ver sus entregas
        if (req.user.role !== 'DRIVER' && req.user.role !== 'ADMIN') {
            return res.status(403).json({ message: 'Acceso denegado.' });
        }

        const driverId = req.user.id;
        
        // Buscamos paquetes asignados al conductor con estado PENDIENTE o EN_TRANSITO
        const { rows: entregas } = await db.query(
            `SELECT 
                id, 
                "recipientName" as cliente, 
                "recipientAddress" || ', ' || "recipientCommune" as direccion, 
                "recipientPhone" as telefono, 
                status as estado, 
                "destLatitude" as latitud, 
                "destLongitude" as longitud 
             FROM packages 
             WHERE "driverId" = $1 AND status IN ('PENDIENTE', 'EN_TRANSITO', 'ASIGNADO', 'PROBLEMA')
             ORDER BY "createdAt" ASC`,
            [driverId]
        );

        res.json(entregas);

    } catch (err) {
        console.error('Error en GET /api/entregas:', err);
        res.status(500).json({ message: 'Error al obtener las entregas.' });
    }
});

/**
 * POST /api/cerrar-entrega
 * Cierra una entrega recibiendo el ID y una imagen en base64 como evidencia.
 */
router.post('/cerrar-entrega', authMiddleware, async (req, res) => {
    const { id, imagen } = req.body;

    if (!id || !imagen) {
        return res.status(400).json({ message: 'ID de entrega e imagen son requeridos.' });
    }

    try {
        // Verificar que el paquete existe y está asignado al conductor (o es admin)
        const { rows: pkgRows } = await db.query('SELECT "driverId", status FROM packages WHERE id = $1', [id]);
        
        if (pkgRows.length === 0) {
            return res.status(404).json({ message: 'Entrega no encontrada.' });
        }

        if (req.user.role !== 'ADMIN' && pkgRows[0].driverId !== req.user.id) {
            return res.status(403).json({ message: 'No tienes permiso para cerrar esta entrega.' });
        }

        // --- NEW MELI VALIDATION (CONDITIONAL) ---
        const { rows: settingsRows } = await db.query('SELECT "meliFlexValidation" FROM system_settings WHERE id = 1');
        const meliFlexValidation = settingsRows.length > 0 ? settingsRows[0].meliFlexValidation : true;

        let meliDeliveredAt = null;

        if (meliFlexValidation) {
            try {
                const { rows: pkgFullRows } = await db.query('SELECT "meliOrderId", "creatorId", "meliFlexCode" FROM packages WHERE id = $1', [id]);
                if (pkgFullRows.length > 0 && (pkgFullRows[0].meliOrderId || pkgFullRows[0].meliFlexCode)) {
                    const { meliOrderId, creatorId, meliFlexCode } = pkgFullRows[0];
                    const shipmentId = meliFlexCode || meliOrderId;
                    const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [creatorId]);
                    let meliIntegration = userRows[0]?.integrations?.meli;
                    
                    if (meliIntegration) {
                        if (Date.now() >= meliIntegration.expiresAt) {
                            try {
                                const { rows: integrationSettingsRows } = await db.query('SELECT meli_app_id, meli_client_secret FROM integration_settings WHERE id = 1');
                                if (integrationSettingsRows[0]?.meli_app_id) {
                                    const { meli_app_id, meli_client_secret } = integrationSettingsRows[0];
                                    const refreshData = new URLSearchParams({ grant_type: 'refresh_token', client_id: meli_app_id.trim(), client_secret: meli_client_secret.trim(), refresh_token: meliIntegration.refreshToken }).toString();
                                    const refreshedTokenData = await makeMeliPostRequest('/oauth/token', refreshData);
                                    meliIntegration = { ...meliIntegration, accessToken: refreshedTokenData.access_token, refreshToken: refreshedTokenData.refresh_token, expiresAt: Date.now() + (refreshedTokenData.expires_in * 1000) };
                                    await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify({ ...userRows[0].integrations, meli: meliIntegration }), creatorId]);
                                }
                            } catch (refreshError) {
                                console.error(`[Mobile Deliver] Error refreshing ML token:`, refreshError);
                            }
                        }
                        
                        let shippingDetails = null;
                        const maxAttempts = 3;
                        const delayMs = 3000;
                        
                        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                            try {
                                shippingDetails = await makeMeliGetRequest(`/shipments/${shipmentId}`, meliIntegration.accessToken);
                                if (shippingDetails && shippingDetails.status === 'delivered') {
                                    break; // Success!
                                }
                            } catch (meliError) {
                                console.warn(`[Mobile Deliver] Meli status verification failed on attempt ${attempt} for shipment ${shipmentId}. Bypassing check to avoid blocking driver.`, meliError.body || meliError.message);
                                shippingDetails = { status: 'delivered' }; // Bypass on API error
                                break;
                            }
                            
                            if (attempt < maxAttempts) {
                                console.log(`[Mobile Deliver] Shipment ${shipmentId} status is ${shippingDetails?.status}. Retrying in ${delayMs/1000}s (Attempt ${attempt}/${maxAttempts})...`);
                                await new Promise(resolve => setTimeout(resolve, delayMs));
                            }
                        }
                        
                        if (shippingDetails && shippingDetails.status !== 'delivered') {
                            return res.status(400).json({ message: 'No se logro cerrar la entrega en la app de Mercado Libre Flex. Por favor intentelo en unos segundos mas y luego confirma nuevamente aquí.' });
                        }
                        
                        // Extract delivery time from ML history
                        if (shippingDetails && shippingDetails.status_history && Array.isArray(shippingDetails.status_history)) {
                            const deliveredEvent = shippingDetails.status_history.find(h => h.status === 'delivered');
                            if (deliveredEvent && deliveredEvent.date) {
                                meliDeliveredAt = new Date(deliveredEvent.date);
                            }
                        }
                    }
                }
            } catch (validationError) {
                console.error('[Mobile Deliver] Error in Meli validation:', validationError);
            }
        }
        // --- END MELI VALIDATION ---

        // Actualizar el estado del paquete
        const now = new Date();
        await db.query(
            `UPDATE packages 
             SET status = 'ENTREGADO', 
                 "deliveryPhotosBase64" = $1, 
                 "updatedAt" = $2 
             WHERE id = $3`,
            [JSON.stringify([imagen]), now, id]
        );

        // Registrar evento de seguimiento (Nuestro App)
        await db.query(
            'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [id, 'ENTREGADO', 'Destino Final', 'Entrega cerrada desde App Móvil.', now]
        );

        // Registrar evento especial de ML si se obtuvo la hora
        if (meliDeliveredAt) {
            await db.query(
                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [id, 'CIERRE_OFICIAL_ML', 'Mercado Libre API', `Hora de entrega real registrada en ML: ${meliDeliveredAt.toISOString()}`, meliDeliveredAt]
            );
        }
        res.json({ message: 'Entrega cerrada con éxito.', id });
    } catch (err) {
        console.error('Error en POST /api/cerrar-entrega:', err);
        res.status(500).json({ message: 'Error al cerrar la entrega.' });
    }
});

/**
 * GET /api/closures/summary
 * Obtiene un resumen de la carga de hoy para el cierre de ruta.
 */
router.get('/closures/summary', authMiddleware, async (req, res) => {
    try {
        const driverId = req.user.id;
        const { start, nextDayStart } = await timeService.getLogicalTodayRange();
        
        const query = `
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'ENTREGADO') as delivered,
                COUNT(*) FILTER (WHERE status IN ('PROBLEMA', 'REPROGRAMADO', 'DEVUELTO')) as problems,
                COUNT(*) FILTER (WHERE status IN ('PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO')) as pending
            FROM packages 
            WHERE "driverId" = $1 
            AND "updatedAt" >= $2 AND "updatedAt" < $3
        `;

        const { rows } = await db.query(query, [driverId, start, nextDayStart]);

        res.json(rows[0]);
    } catch (err) {
        console.error('Error en GET /api/closures/summary:', err);
        res.status(500).json({ message: 'Error al obtener resumen de cierre.' });
    }
});

/**
 * POST /api/closures
 * Registra el cierre de jornada del conductor.
 */
router.post('/closures', authMiddleware, async (req, res) => {
    const { total, delivered, problems, cancelled, pending, notes } = req.body;
    const driverId = req.user.id;
    const driverName = req.user.name;
    try {
        const today = await timeService.getLogicalDate();
        await db.query(`
            INSERT INTO daily_closures 
            ("driverId", "driverName", date, "totalPackages", "deliveredCount", "pendingCount", "problemCount", "cancelledCount", notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT ("driverId", date) 
            DO UPDATE SET 
                "totalPackages" = EXCLUDED."totalPackages",
                "deliveredCount" = EXCLUDED."deliveredCount",
                "pendingCount" = EXCLUDED."pendingCount",
                "problemCount" = EXCLUDED."problemCount",
                "cancelledCount" = EXCLUDED."cancelledCount",
                notes = EXCLUDED.notes,
                "closedAt" = NOW()
        `, [driverId, driverName, today, total, delivered, pending, problems, cancelled, notes]);

        res.json({ message: 'Cierre de jornada registrado con éxito.' });
    } catch (err) {
        console.error('Error en POST /api/closures:', err);
        res.status(500).json({ message: 'Error al registrar el cierre.' });
    }
});

module.exports = router;
