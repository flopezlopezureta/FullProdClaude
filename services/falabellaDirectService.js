const db = require('../db');
const https = require('https');
const { encrypt, decrypt } = require('./falabellaCrypto');

// --- FALABELLA DIRECTO (COURIER) API HELPERS (own https.request wrapper,
// duplicated intentionally rather than shared — matches this repo's existing
// per-integration independence convention, see meliPollingService.js) ---
const makeRequest = (options, body = null) => {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = data;
                try { parsed = JSON.parse(data); } catch (e) { /* leave as raw string */ }
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(parsed);
                } else {
                    reject(new Error(`Falabella Directo API returned HTTP ${res.statusCode}: ${data}`));
                }
            });
        });
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('Falabella Directo API request timed out after 15s'));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
};

const getHostname = (env) => (env === 'PROD' ? 'logistic-api-prod.falabella.com' : 'logistic-api-qa.falabella.com');

// --- TOKEN CACHE ---
// Single global credential pair for the whole company (Falabella issues one client_id/secret
// per courier company, not per-client — unlike Mercado Libre's per-account OAuth).
let cachedToken = null; // { accessToken, expiresAt, environment }

async function getSettings() {
    const { rows } = await db.query(
        'SELECT falabella_direct_client_id, falabella_direct_client_secret, falabella_direct_environment FROM integration_settings WHERE id = 1'
    );
    if (!rows.length || !rows[0].falabella_direct_client_id || !rows[0].falabella_direct_client_secret) {
        throw new Error('Falabella Directo no está configurado. Ingresa el client_id y client_secret en Configuración > Integraciones.');
    }
    return {
        clientId: rows[0].falabella_direct_client_id,
        clientSecret: decrypt(rows[0].falabella_direct_client_secret),
        environment: rows[0].falabella_direct_environment || 'UAT',
    };
}

async function authenticate(clientId, clientSecret, environment) {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
    }).toString();

    const response = await makeRequest({
        hostname: getHostname(environment),
        path: '/schn-trmg-3pl-directo/v1/authorization',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-environment': environment,
            'Content-Length': Buffer.byteLength(body),
        },
    }, body);

    if (!response || !response.access_token) {
        throw new Error('Falabella Directo no devolvió un access_token válido.');
    }
    return response;
}

async function getValidToken() {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 60000) {
        return cachedToken;
    }
    const { clientId, clientSecret, environment } = await getSettings();
    const authData = await authenticate(clientId, clientSecret, environment);
    // expires_in comes back as a string (confirmed against the real UAT endpoint), not a number.
    const expiresInMs = parseInt(authData.expires_in, 10) * 1000;
    cachedToken = {
        accessToken: authData.access_token,
        expiresAt: Date.now() + expiresInMs,
        environment,
    };
    return cachedToken;
}

// --- TEST CONNECTION (used by the admin settings "Probar Conexión" button) ---
async function testConnection(clientId, clientSecret, environment) {
    const authData = await authenticate(clientId, clientSecret, environment);
    return { success: true, expiresIn: authData.expires_in };
}

// --- GET ORDER BY LPN ---
async function getOrderByLpn(lpn) {
    const token = await getValidToken();
    return makeRequest({
        hostname: getHostname(token.environment),
        path: `/schn-trmg-3pl-directo/v1/orders/${encodeURIComponent(lpn)}`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token.accessToken}`,
            'x-country': 'CL',
            'x-environment': token.environment,
        },
    });
}

// --- PUSH STATUS UPDATE ---
// extra: { latitude, longitude, deliveryProof: { recipientName, recipientId, images } }
async function pushStatusUpdate(lpn, statusCode, description, extra = {}) {
    const token = await getValidToken();
    const statusEntry = {
        statusCode,
        // Falabella requires exactly YYYY-MM-DDTHH:mm:ssZ — no milliseconds — confirmed via a
        // real 400 validation error against UAT ("must match pattern ^\d{4}-\d{2}-\d{2}T...Z$").
        statusDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        description: description || statusCode,
    };
    if (extra.deliveryProof) {
        statusEntry.deliveryProof = extra.deliveryProof;
    }

    const body = JSON.stringify({
        updates: [{
            lpn,
            carrier: 'GO DELIVERY',
            latitude: extra.latitude ?? 0,
            longitude: extra.longitude ?? 0,
            statuses: [statusEntry],
        }],
    });

    return makeRequest({
        hostname: getHostname(token.environment),
        path: '/schn-trmg-3pl-directo/v1/webhook/directo',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token.accessToken}`,
            'x-country': 'CL',
            'x-environment': token.environment,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    }, body);
}

// --- INTERNAL STATUS -> FALABELLA STATUS CODE MAPPING ---
// Reference only today — routes/packages.js builds these status codes inline at each call site,
// not through this map (mapInternalStatusToFalabella is currently unused). Kept in sync anyway so
// it doesn't mislead. Confirmed 2026-08-10 against Falabella's real status-code dictionary
// (https://developer-prod.falabella.com/docs/carriers/actualizar-estado):
//   - No cancellation code exists, and none is needed — once a seller marks an order ready to
//     dispatch, Falabella says it can no longer be cancelled on their side.
//   - DELIVERY_ATTEMPTED_002 means specifically "failed due to recipient unavailability" — only
//     matches our "Destinatario ausente en domicilio" reason. Every other failure reason has no
//     more specific code and falls back to the generic DELIVERY_ATTEMPTED_001.
const STATUS_MAP = {
    SCAN_INTAKE: 'IN_TRANSIT_001',
    DISPATCHED_TO_DRIVER: 'OUT_FOR_DELIVERY_001',
    DELIVERED: 'DELIVERED_001',
    PROBLEM_RECIPIENT_ABSENT: 'DELIVERY_ATTEMPTED_002',
    PROBLEM_OTHER: 'DELIVERY_ATTEMPTED_001',
    RETURNED: 'UNDELIVERED_001',
};

function mapInternalStatusToFalabella(internalTrigger) {
    return STATUS_MAP[internalTrigger] || null;
}

// --- RETRY QUEUE PROCESSOR ---
// Drains integration_sync_queue for all three Falabella-adjacent integrations (Seller Center,
// Envíame, and this one) — the queue was previously write-only, nothing ever processed it after
// the inline 3-attempt retry in routes/packages.js gave up.
const QUEUE_MAX_ATTEMPTS = 10;

async function processIntegrationSyncQueue() {
    const { rows } = await db.query(
        'SELECT * FROM integration_sync_queue WHERE "nextAttemptAt" <= NOW() ORDER BY "nextAttemptAt" ASC LIMIT 20'
    );

    for (const row of rows) {
        try {
            await db.query('DELETE FROM integration_sync_queue WHERE id = $1', [row.id]);
        } catch (e) {
            console.error('[IntegrationSyncQueue] Failed to remove row before retry, skipping to avoid duplicate processing:', e);
            continue;
        }

        const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});

        try {
            if (row.integration === 'FALABELLA') {
                // Lazy require to avoid a circular dependency (routes/packages.js requires this
                // service for the outbound status-push hooks).
                const packagesRoute = require('../routes/packages.js');
                if (row.action === 'READY_TO_SHIP') {
                    if (typeof packagesRoute.syncReadyToShipToFalabella === 'function') {
                        await packagesRoute.syncReadyToShipToFalabella(row.packageId, 1);
                    }
                } else if (typeof packagesRoute.syncDeliveryToFalabella === 'function') {
                    await packagesRoute.syncDeliveryToFalabella(row.packageId, payload.trackingId, 1);
                }
            } else if (row.integration === 'ENVIAME') {
                const packagesRoute = require('../routes/packages.js');
                if (typeof packagesRoute.syncDeliveryToEnviame === 'function') {
                    await packagesRoute.syncDeliveryToEnviame(row.packageId, payload.trackingId, 1);
                }
            } else if (row.integration === 'FALABELLA_DIRECTO') {
                await pushStatusUpdate(payload.lpn, payload.statusCode, payload.description, payload.extra || {});
                console.log(`[IntegrationSyncQueue] Falabella Directo retry succeeded for lpn=${payload.lpn}, statusCode=${payload.statusCode}.`);
            } else {
                console.warn(`[IntegrationSyncQueue] Unknown integration "${row.integration}" in queue row id=${row.id}, dropping.`);
            }
        } catch (err) {
            const attempts = (row.attempts || 1) + 1;
            console.error(`[IntegrationSyncQueue] Retry failed for row id=${row.id} integration=${row.integration} (attempt ${attempts}):`, err.message);
            if (attempts <= QUEUE_MAX_ATTEMPTS) {
                await db.query(
                    'INSERT INTO integration_sync_queue ("packageId", integration, action, payload, error, attempts, "nextAttemptAt") ' +
                    'VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL \'15 minutes\')',
                    [row.packageId, row.integration, row.action, JSON.stringify(payload), err.message, attempts]
                );
            } else {
                console.error(`[IntegrationSyncQueue] Giving up on row (packageId=${row.packageId}, integration=${row.integration}) after ${attempts} attempts. Manual intervention needed.`);
            }
        }
    }
}

module.exports = {
    getValidToken,
    testConnection,
    getOrderByLpn,
    pushStatusUpdate,
    mapInternalStatusToFalabella,
    processIntegrationSyncQueue,
};
