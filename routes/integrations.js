const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const https = require('https');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const bcrypt = require('bcryptjs');

const meliPollingService = require('../services/meliPollingService');
const { normalizeCommune } = require('../utils/normUtil');

// --- MULTI-ACCOUNT HELPERS ---
const ensureMultiAccountStructure = (integrations) => {
    if (!integrations) integrations = { accounts: [] };
    if (!integrations.accounts) {
        const accounts = [];
        
        // Migrate old 'meli' structure
        if (integrations.meli) {
            accounts.push({
                id: `meli-${integrations.meli.userId || uuidv4()}`,
                type: 'MERCADO_LIBRE',
                nickname: 'Mercado Libre (Principal)',
                credentials: { ...integrations.meli },
                settings: { 
                    autoImport: true, 
                    syncInterval: 30,
                    lastSync: integrations.meli.lastSync 
                },
                connectedAt: integrations.meli.connectedAt || new Date().toISOString()
            });
        }
        
        // Migrate old 'shopify' structure
        if (integrations.shopify) {
            accounts.push({
                id: `shopify-${uuidv4()}`,
                type: 'SHOPIFY',
                nickname: 'Shopify (Principal)',
                credentials: { 
                    shopUrl: integrations.shopify.shopUrl,
                    accessToken: integrations.shopify.accessToken
                },
                settings: { 
                    autoImport: integrations.shopify.autoImport || false, 
                    syncInterval: integrations.shopify.syncInterval || 5,
                    lastSync: integrations.shopify.lastSync
                },
                connectedAt: integrations.shopify.connectedAt || new Date().toISOString()
            });
        }

        // Migrate old 'woocommerce' structure
        if (integrations.woocommerce) {
            accounts.push({
                id: `woo-${uuidv4()}`,
                type: 'WOOCOMMERCE',
                nickname: 'WooCommerce (Principal)',
                credentials: { ...integrations.woocommerce },
                settings: { 
                    autoImport: integrations.woocommerce.autoImport || false, 
                    syncInterval: integrations.woocommerce.syncInterval || 30 
                },
                connectedAt: new Date().toISOString()
            });
        }

        // Migrate old 'jumpseller' structure
        if (integrations.jumpseller) {
            accounts.push({
                id: `jump-${uuidv4()}`,
                type: 'JUMPSELLER',
                nickname: 'Jumpseller (Principal)',
                credentials: { ...integrations.jumpseller },
                settings: { 
                    autoImport: integrations.jumpseller.autoImport || false, 
                    syncInterval: integrations.jumpseller.syncInterval || 10 
                },
                connectedAt: new Date().toISOString()
            });
        }

        integrations.accounts = accounts;
        // We keep old keys for a while to avoid breaking other parts until they are updated,
        // but we prioritize 'accounts' in the logic.
    }
    return integrations;
};

// GET /api/integrations/accounts - List all linked accounts
router.get('/accounts', authMiddleware, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT integrations FROM users WHERE id = $1', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
        
        const integrations = ensureMultiAccountStructure(rows[0].integrations);
        
        // Return accounts without sensitive credential details (optional, but safer)
        const safeAccounts = integrations.accounts.map(acc => ({
            id: acc.id,
            type: acc.type,
            nickname: acc.nickname,
            settings: acc.settings,
            status: acc.status || 'CONNECTED',
            connectedAt: acc.connectedAt,
            // Only return identifying info, not tokens
            identifier: acc.type === 'SHOPIFY' ? acc.credentials.shopUrl : (acc.type === 'MERCADO_LIBRE' ? acc.credentials.userId : null)
        }));

        res.json(safeAccounts);
    } catch (err) {
        console.error('[GetAccounts] Error:', err);
        res.status(500).json({ message: 'Error al obtener cuentas vinculadas' });
    }
});

// PATCH /api/integrations/accounts/:accountId - Update account nickname or settings
router.patch('/accounts/:accountId', authMiddleware, async (req, res) => {
    const { accountId } = req.params;
    const { nickname, settings } = req.body;

    try {
        const { rows } = await db.query('SELECT integrations FROM users WHERE id = $1', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
        
        const integrations = ensureMultiAccountStructure(rows[0].integrations);
        const accountIndex = integrations.accounts.findIndex(acc => acc.id === accountId);
        
        if (accountIndex === -1) return res.status(404).json({ message: 'Cuenta no encontrada' });
        
        if (nickname !== undefined) integrations.accounts[accountIndex].nickname = nickname;
        if (settings !== undefined) {
            integrations.accounts[accountIndex].settings = {
                ...integrations.accounts[accountIndex].settings,
                ...settings
            };
        }

        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), req.user.id]);
        res.json({ message: 'Cuenta actualizada correctamente', account: integrations.accounts[accountIndex] });
    } catch (err) {
        console.error('[UpdateAccount] Error:', err);
        res.status(500).json({ message: 'Error al actualizar cuenta' });
    }
});

// DELETE /api/integrations/accounts/:accountId - Remove a linked account
router.delete('/accounts/:accountId', authMiddleware, async (req, res) => {
    const { accountId } = req.params;

    try {
        const { rows } = await db.query('SELECT integrations FROM users WHERE id = $1', [req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
        
        const integrations = ensureMultiAccountStructure(rows[0].integrations);
        const newAccounts = integrations.accounts.filter(acc => acc.id !== accountId);
        
        if (newAccounts.length === integrations.accounts.length) {
            return res.status(404).json({ message: 'Cuenta no encontrada' });
        }
        
        integrations.accounts = newAccounts;

        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), req.user.id]);
        res.json({ message: 'Cuenta eliminada correctamente' });
    } catch (err) {
        console.error('[DeleteAccount] Error:', err);
        res.status(500).json({ message: 'Error al eliminar cuenta' });
    }
});

// TEMP DEBUG: List all clients and IDs
router.get('/list-clients-debug', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN') return res.status(403).send('Forbidden');
    try {
        const { rows } = await db.query("SELECT id, name FROM users WHERE integrations->'meli' IS NOT NULL LIMIT 20");
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/debug-poll/:clientId', async (req, res) => {
    const { clientId } = req.params;

    const executeDebug = async (user) => {
        const debugLogs = [];
        const log = (msg, data = null) => debugLogs.push({ timestamp: new Date().toISOString(), msg, data });

        try {
            log('Starting debug poll for client', clientId);
            if (!user) {
                const { rows: userRows } = await db.query('SELECT id, name, integrations, "clientIdentifier" FROM users WHERE id = $1', [clientId]);
                if (userRows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado', debugLogs });
                user = userRows[0];
            }
            
            const meliIntegration = user.integrations?.meli;
            if (!meliIntegration) return res.status(400).json({ message: 'Usuario no tiene integraciÃ³n ML', debugLogs });

            log('Getting access token...');
            const accessToken = await meliPollingService.getValidMeliToken(clientId);
            if (!accessToken) {
                log('FAILED to get access token. Check integration_settings or refresh token.');
                return res.status(401).json({ message: 'Error de autenticaciÃ³n ML', debugLogs });
            }
            log('Access token obtained successfully');

            log(`Searching orders for seller ${meliIntegration.userId}...`);
            const path = `/orders/search?seller=${meliIntegration.userId}&order.status=paid&sort=date_desc&limit=20`;
            
            // Raw fetch for debug details
            const response = await fetch(`https://api.mercadolibre.com${path}`, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            const ordersData = await response.json();

            log(`Found ${ordersData.results?.length || 0} orders in search`);
            
            const detailedResults = [];
            if (ordersData.results) {
                for (const order of ordersData.results) {
                    const orderId = order.id.toString();
                    const shipmentId = order.shipping?.id;
                    const shippingMode = order.shipping?.mode;
                    
                    const report = { orderId, shipmentId, shippingMode, status: 'evaluating' };
                    
                    if (!shipmentId) {
                        report.status = 'skipped_no_shipment';
                        detailedResults.push(report);
                        continue;
                    }

                    // Check duplicate
                    const { rows: existing } = await db.query('SELECT id FROM packages WHERE "meliOrderId" = $1 OR "meliFlexCode" = $2', [orderId, shipmentId.toString()]);
                    if (existing.length > 0) {
                        report.status = 'skipped_already_imported';
                        report.existingId = existing[0].id;
                        detailedResults.push(report);
                        continue;
                    }

                    if (shippingMode !== 'self_service') {
                        report.status = 'skipped_not_flex_mode';
                        detailedResults.push(report);
                        continue;
                    }

                    log(`Fetching shipment details for ${shipmentId}...`);
                    const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
                        headers: { 'Authorization': `Bearer ${accessToken}` }
                    });
                    const shipment = await shipRes.json();

                    report.mlShipmentStatus = shipment.status;
                    const stateName = shipment.receiver_address?.state?.name || 'N/A';
                    report.stateName = stateName;

                    if (shipment.status === 'delivered' || shipment.status === 'cancelled') {
                        report.status = 'skipped_past_history';
                    } else {
                        report.status = 'eligible_for_import';
                    }
                    detailedResults.push(report);
                }
            }

            res.json({ 
                success: true, 
                client: user.name,
                meliUserId: meliIntegration.userId,
                debugLogs,
                orderSummary: detailedResults 
            });

        } catch (err) {
            log('FATAL ERROR during debug poll', err.message);
            res.status(500).json({ success: false, error: err.message, debugLogs });
        }
    };

    return authMiddleware(req, res, () => {
        if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
            return res.status(403).json({ message: 'No autorizado' });
        }
        return executeDebug(req.user);
    });
});

// GET /api/integrations/meli-tracking/:packageId - Get real ML tracking_id for label QR
router.get('/meli-tracking/:packageId', authMiddleware, async (req, res) => {
    const { packageId } = req.params;
    try {
        // Get package + creator from DB
        const { rows: pkgRows } = await db.query(
            'SELECT p."meliFlexCode", p."trackingId", p."creatorId", p."meliOrderId" FROM packages p WHERE p.id = $1',
            [packageId]
        );
        if (pkgRows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado' });

        const pkg = pkgRows[0];

        // If we already have a trackingId stored, return it directly
        if (pkg.trackingId) {
            return res.json({ trackingId: pkg.trackingId, source: 'cached' });
        }

        // Otherwise fetch fresh from ML API
        if (!pkg.meliFlexCode) {
            return res.status(400).json({ message: 'El paquete no tiene ID de envÃ­o ML' });
        }

        const accessToken = await meliPollingService.getValidMeliToken(pkg.creatorId);
        if (!accessToken) return res.status(401).json({ message: 'Token ML no disponible' });

        // Make HTTPS request to ML API
        const shipmentData = await new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.mercadolibre.com',
                path: `/shipments/${pkg.meliFlexCode}`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${accessToken}` }
            };
            require('https').get(options, (mlRes) => {
                let data = '';
                mlRes.on('data', chunk => data += chunk);
                mlRes.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            }).on('error', reject);
        });

        const trackingId = shipmentData.tracking_id ? String(shipmentData.tracking_id) : null;

        // Cache it in DB for next time
        if (trackingId) {
            await db.query('UPDATE packages SET "trackingId" = $1 WHERE id = $2', [trackingId, packageId]);
        }

        res.json({ trackingId, shipmentStatus: shipmentData.status, source: 'live' });
    } catch (err) {
        console.error('[MeliTracking] Error:', err);
        res.status(500).json({ message: 'Error al obtener tracking de ML', error: err.message });
    }
});

// GET /api/integrations/meli-label/:packageId - Fetch official PDF label from ML
router.get('/meli-label/:packageId', authMiddleware, async (req, res) => {
    const { packageId } = req.params;
    try {
        const { rows: pkgRows } = await db.query(
            'SELECT p."meliFlexCode", p."creatorId", p."trackingId" FROM packages p WHERE p.id = $1',
            [packageId]
        );
        if (pkgRows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado' });

        const pkg = pkgRows[0];
        if (!pkg.meliFlexCode) return res.status(400).json({ message: 'El paquete no tiene ID de envÃ­o ML' });

        const accessToken = await meliPollingService.getValidMeliToken(pkg.creatorId);
        if (!accessToken) return res.status(401).json({ message: 'Token ML no disponible' });

        // [NUEVO] Si no tenemos el trackingId (SCA), lo buscamos y guardamos ahora
        if (!pkg.trackingId) {
            try {
                const shipment = await makeMeliGetRequest(`/shipments/${pkg.meliFlexCode}`, accessToken);
                if (shipment.tracking_id) {
                    await db.query('UPDATE packages SET "trackingId" = $1 WHERE id = $2', [String(shipment.tracking_id), packageId]);
                    console.log(`[MeliLabel] Sincronizado trackingId ${shipment.tracking_id} para ${packageId}`);
                }
            } catch (err) {
                console.warn(`[MeliLabel] No se pudo sincronizar trackingId: ${err.message || 'Error desconocido'}`);
            }
        }

        const url = `https://api.mercadolibre.com/shipment_labels?shipment_ids=${pkg.meliFlexCode}&response_type=pdf`;
        
        try {
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[MeliLabel] Meli API Error (${response.status}):`, errorText);
                return res.status(response.status).json({ message: 'Error al obtener etiqueta de ML', meliStatus: response.status });
            }

            // Pipe PDF stream to the client
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=etiqueta_${pkg.meliFlexCode}.pdf`);
            
            // Using Readable.fromWeb for Node 18+ fetch compatibility
            const { Readable } = require('stream');
            Readable.fromWeb(response.body).pipe(res);

        } catch (fetchError) {
            console.error('[MeliLabel] Fetch Error:', fetchError);
            res.status(500).json({ message: 'Error de conexiÃ³n con ML' });
        }

    } catch (err) {
        console.error('[MeliLabel] Error:', err);
        res.status(500).json({ message: 'Error interno', error: err.message });
    }
});

// DELETE /api/integrations/:clientId/:source - Delete an integration (Admin only)
router.delete('/:clientId/:source', authMiddleware, async (req, res) => {
    const { clientId, source } = req.params;
    const { password } = req.body;

    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Solo los administradores pueden eliminar integraciones.' });
    }

    if (!password) {
        return res.status(400).json({ message: 'La contraseÃ±a de administrador es requerida.' });
    }

    try {
        // 1. Verify admin password
        const { rows: adminRows } = await db.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        const admin = adminRows[0];
        const isMatch = await bcrypt.compare(password, admin.password);
        
        if (!isMatch) {
            return res.status(401).json({ message: 'ContraseÃ±a de administrador incorrecta.' });
        }

        // 2. Remove integration from user
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) {
            return res.status(404).json({ message: 'Cliente no encontrado.' });
        }

        const integrations = userRows[0].integrations || {};
        delete integrations[source];

        // También eliminar de la estructura de múltiples cuentas si existe
        if (integrations.accounts && Array.isArray(integrations.accounts)) {
            const mapType = {
                'meli': 'MERCADO_LIBRE',
                'shopify': 'SHOPIFY',
                'woocommerce': 'WOOCOMMERCE',
                'falabella': 'FALABELLA',
                'jumpseller': 'JUMPSELLER'
            };
            const accountType = mapType[source];
            if (accountType) {
                integrations.accounts = integrations.accounts.filter(acc => acc.type !== accountType);
            }
        }

        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);

        res.json({ message: `IntegraciÃ³n ${source} eliminada con Ã©xito.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar la integraciÃ³n.' });
    }
});

// --- MELI API HELPERS ---
const makeMeliRequest = (options, postData = null) => {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => { chunks.push(chunk); });
            res.on('end', () => {
                // Concatenate raw Buffers before decoding — string-concatenating chunks
                // (`data += chunk`) decodes each partial chunk as UTF-8 independently,
                // corrupting any multi-byte character (Ñ, á, é...) split across a chunk
                // boundary (e.g. commune names like "Ñuñoa" in shipment addresses).
                const data = Buffer.concat(chunks).toString('utf8');
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedData);
                    } else {
                        reject({ statusCode: res.statusCode, body: parsedData });
                    }
                } catch (e) {
                    reject({ statusCode: res.statusCode, body: data, isRaw: true });
                }
            });
        });
        req.on('error', (e) => reject(e));
        if (postData) req.write(postData);
        req.end();
    });
};

// --- WOOCOMMERCE API HELPERS ---
const makeWooCommerceRequest = (wooUrl, consumerKey, consumerSecret, path, method = 'GET', postData = null) => {
    return new Promise((resolve, reject) => {
        if (!wooUrl) return reject(new Error('La URL de WooCommerce es requerida.'));
        if (!consumerKey) return reject(new Error('El Consumer Key de WooCommerce es requerido.'));
        if (!consumerSecret) return reject(new Error('El Consumer Secret de WooCommerce es requerido.'));

        // Clean URL
        let cleanUrl = wooUrl.trim().replace(/\/$/, '');
        if (!cleanUrl.startsWith('http')) {
            cleanUrl = 'https://' + cleanUrl;
        }

        const url = new URL(`${cleanUrl}/wp-json/wc/v3${path}`);
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        const req = (url.protocol === 'https:' ? https : require('http')).request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedData);
                    } else {
                        reject({ statusCode: res.statusCode, body: parsedData });
                    }
                } catch (e) {
                    reject({ statusCode: res.statusCode, body: data, isRaw: true });
                }
            });
        });
        req.on('error', (e) => reject(e));
        if (postData) req.write(postData);
        req.end();
    });
};

// --- FALABELLA API HELPERS ---
const { encrypt, decrypt, buildFalabellaSignature } = require('../services/falabellaCrypto');

const makeFalabellaRequest = (apiKey, sellerId, action, method = 'GET', extraParams = null) => {
    return new Promise((resolve, reject) => {
        if (!apiKey) return reject(new Error('La API Key de Falabella es requerida.'));
        if (!sellerId) return reject(new Error('El Seller ID de Falabella es requerido.'));

        // Decrypt API key if it is encrypted
        const decryptedApiKey = apiKey.includes(':') ? decrypt(apiKey) : apiKey;

        const timestamp = new Date().toISOString();
        const baseParams = {
            Action: action,
            Timestamp: timestamp,
            UserID: sellerId,
            Version: '1.0',
            Format: 'JSON',
            ...extraParams
        };

        const signature = buildFalabellaSignature(baseParams, decryptedApiKey);

        const sortedKeys = Object.keys(baseParams).sort();
        const queryString = sortedKeys
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(baseParams[key])}`)
            .join('&') + `&Signature=${encodeURIComponent(signature)}`;

        const options = {
            hostname: 'sellercenter-api.falabella.com',
            path: `/?${queryString}`,
            method: method,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        // Falabella can return 200 OK but with an ErrorResponse payload
                        if (parsedData.ErrorResponse) {
                            reject({ statusCode: res.statusCode, body: parsedData, isFalabellaError: true });
                        } else {
                            resolve(parsedData);
                        }
                    } else {
                        reject({ statusCode: res.statusCode, body: parsedData });
                    }
                } catch (e) {
                    reject({ statusCode: res.statusCode, body: data, isRaw: true });
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.end();
    });
};

const makeMeliGetRequest = (path, accessToken) => makeMeliRequest({
    hostname: 'api.mercadolibre.com',
    path,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${accessToken}` }
});

const makeMeliPostRequest = (path, postData) => makeMeliRequest({
    hostname: 'api.mercadolibre.com',
    path,
    method: 'POST',
    headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
    }
}, postData);

const getValidMeliIntegration = async (clientId, accountId = null) => {
    const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
    if (userRows.length === 0) throw new Error('Cliente no encontrado.');
    
    let integrations = userRows[0].integrations || {};
    let meliIntegration = null;
    let accountIndex = -1;

    if (accountId) {
        if (!integrations.accounts) integrations = ensureMultiAccountStructure(integrations);
        accountIndex = integrations.accounts.findIndex(acc => acc.id === accountId);
        if (accountIndex === -1) throw new Error('Cuenta de Mercado Libre no encontrada.');
        meliIntegration = integrations.accounts[accountIndex].credentials;
    } else {
        meliIntegration = integrations.meli;
        if (!meliIntegration && integrations.accounts) {
            accountIndex = integrations.accounts.findIndex(acc => acc.type === 'MERCADO_LIBRE');
            if (accountIndex > -1) {
                meliIntegration = integrations.accounts[accountIndex].credentials;
                accountId = integrations.accounts[accountIndex].id;
            }
        }
    }

    if (!meliIntegration) throw new Error('El cliente no tiene Mercado Libre conectado.');

    // Refresh Token if needed
    if (Date.now() >= meliIntegration.expiresAt) {
        const { rows: settingsRows } = await db.query('SELECT meli_app_id, meli_client_secret FROM integration_settings WHERE id = 1');
        if (settingsRows.length === 0) throw new Error('ConfiguraciÃ³n de app ML no encontrada.');
        
        const { meli_app_id, meli_client_secret } = settingsRows[0];
        const postData = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: meli_app_id,
            client_secret: meli_client_secret,
            refresh_token: meliIntegration.refreshToken
        }).toString();

        const tokenData = await makeMeliPostRequest('/oauth/token', postData);
        meliIntegration = {
            ...meliIntegration,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in * 1000)
        };

        if (accountId && accountIndex > -1) {
            integrations.accounts[accountIndex].credentials = meliIntegration;
        } else {
            integrations.meli = meliIntegration;
        }

        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
    }
    return meliIntegration;
};

// [TEMPORAL] Ruta administrativa para limpiar pedidos fuera de zona (AuditorÃ­a profunda)
// Borra datos reales (paquetes + su historial) â€” exige sesiÃ³n de administrador real. AntÃ©s
// solo pedÃ­a una palabra fija en la URL (visible en el cÃ³digo fuente), lo que equivalÃ­a a no
// pedir nada.
router.get('/admin/cleanup-deep', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN') return res.status(403).send('Forbidden');

    try {
        const queryFind = `
            SELECT id, "recipientName", "recipientCity", "recipientCommune", source, status 
            FROM packages 
            WHERE 
               LOWER("recipientCity") LIKE '%puerto montt%' OR 
               LOWER("recipientCity") LIKE '%loncoche%' OR 
               LOWER("recipientCommune") LIKE '%puerto montt%' OR 
               LOWER("recipientCommune") LIKE '%loncoche%' OR
               (
                 source = 'MERCADO_LIBRE' AND 
                 LOWER("recipientCity") NOT LIKE '%metropolitana%' AND 
                 LOWER("recipientCity") NOT LIKE '%santiago%' AND 
                 LOWER("recipientCity") != 'rm'
               )
        `;
        const { rows: toDelete } = await db.query(queryFind);
        const count = toDelete.length;

        if (count > 0) {
            const ids = toDelete.map(r => r.id);
            await db.query('DELETE FROM tracking_events WHERE "packageId" = ANY($1)', [ids]);
            await db.query('DELETE FROM packages WHERE id = ANY($1)', [ids]);
        }

        res.json({ message: `Limpieza profunda completada. Se eliminaron ${count} paquetes.`, deletedCount: count, samples: toDelete });
    } catch (err) {
        console.error('[CleanupDeep] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/integrations/import/meli-scanned
router.post('/import/meli-scanned', authMiddleware, async (req, res) => {
    let { clientId, scannedId, flexCode } = req.body;

    // [NUEVO] Si scannedId o flexCode vienen como JSON (etiqueta oficial), extraer solo el ID
    const extractId = (text) => {
        if (text && typeof text === 'string' && text.startsWith('{')) {
            try {
                const parsed = JSON.parse(text);
                if (parsed.id) return String(parsed.id);
            } catch (e) {}
        }
        return text;
    };

    scannedId = extractId(scannedId);
    flexCode = extractId(flexCode);

    try {
        // 1. Get Valid Integration

        // 2. Get Shipment Details from ML
        const shipment = await makeMeliGetRequest(`/shipments/${scannedId}`, meliIntegration.accessToken);
        
        // 3. Create local package
        const now = new Date();
        // [NUEVO] ValidaciÃ³n estricta de RegiÃ³n (Solo Santiago / RM)
        let stateName = shipment.receiver_address?.state?.name || 'Santiago';
        const lowerState = stateName.toLowerCase();
        const isRM = lowerState.includes('metropolitana') || 
                     lowerState.includes('santiago') || 
                     lowerState === 'rm' ||
                     lowerState.includes('r.m.');

        if (!isRM) {
            return res.status(400).json({ message: `No se puede importar: El destino (${stateName}) estÃ¡ fuera de la RegiÃ³n Metropolitana.` });
        }
        stateName = 'RegiÃ³n Metropolitana';

        const newPackage = {
            id: `${userRows[0].clientIdentifier}-${uuidv4().split('-')[0]}`,
            recipientName: shipment.receiver_address?.receiver_name || 'N/A',
            recipientPhone: shipment.receiver_address?.receiver_phone || 'N/A',
            status: 'PENDIENTE',
            shippingType: 'SAME_DAY',
            origin: 'Centro de DistribuciÃ³n',
            recipientAddress: shipment.receiver_address?.address_line || 'N/A',
            recipientCommune: shipment.receiver_address?.city?.name || 'N/A',
            recipientCity: stateName,
            notes: `ML ID: ${scannedId}`,
            estimatedDelivery: now,
            createdAt: now,
            updatedAt: now,
            creatorId: req.user.id,
            source: 'MERCADO_LIBRE',
            meliOrderId: scannedId,
            meliFlexCode: flexCode || scannedId,
            trackingId: shipment.tracking_id ? String(shipment.tracking_id) : null
        };

        const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
        const values = Object.values(newPackage).map(v => v === undefined ? null : v);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
        await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
            [newPackage.id, 'Creado', newPackage.origin, 'Importado vÃ­a escaneo ML.', now]);

        // [NUEVO] Sincronizar trackingId original de forma asÃ­ncrona
        meliPollingService.syncTrackingId(newPackage.id);

        res.status(201).json({ message: `Paquete para ${newPackage.recipientName} importado!`, pkg: newPackage });

    } catch (err) {
        console.error("Meli Scanned Import Error:", err.body || err);
        res.status(500).json({ message: err.message || 'Error al importar desde ML.' });
    }
});

// GET /api/integrations/status/:shipmentId
router.get('/status/:shipmentId', authMiddleware, async (req, res) => {
    const { shipmentId } = req.params;

    try {
        const { rows: pkgRows } = await db.query('SELECT "creatorId" FROM packages WHERE "meliOrderId" = $1 OR id = $1', [shipmentId]);
        if (pkgRows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado localmente.' });

        const clientId = pkgRows[0].creatorId;
        const meliIntegration = await getValidMeliIntegration(clientId);

        const shipmentData = await makeMeliGetRequest(`/shipments/${shipmentId}`, meliIntegration.accessToken);
        res.json({ status: shipmentData.status, substatus: shipmentData.substatus });

    } catch (err) {
        console.error("Meli Status Check Error:", err.body || err);
        res.status(500).json({ message: err.message || 'Error al consultar ML.' });
    }
});

// GET /api/integrations/:clientId/meli/orders
router.get('/:clientId/meli/orders', authMiddleware, async (req, res) => {
    const { clientId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para ver estos pedidos.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
        
        const integrations = ensureMultiAccountStructure(userRows[0].integrations);
        const meliAccounts = integrations.accounts.filter(acc => acc.type === 'MERCADO_LIBRE');

        if (meliAccounts.length === 0) {
            return res.json([]);
        }

        let allOrders = [];
        for (const account of meliAccounts) {
            try {
                const meliIntegration = await getValidMeliIntegration(clientId, account.id);
                const ordersData = await makeMeliGetRequest(`/orders/search?seller=${meliIntegration.userId}&order.status=paid&sort=date_desc&limit=30`, meliIntegration.accessToken);

                if (ordersData && ordersData.results) {
                    // Exclude orders already imported into our system (e.g. by the
                    // auto-import worker) so this manual browsing list only shows
                    // orders that genuinely still need to be imported.
                    const orderIds = ordersData.results.map(o => o.id.toString());
                    const shipmentIds = ordersData.results.map(o => o.shipping?.id?.toString()).filter(Boolean);
                    const { rows: existingPackages } = await db.query(
                        'SELECT "meliOrderId", "meliFlexCode" FROM packages WHERE "meliOrderId" = ANY($1) OR "meliFlexCode" = ANY($2)',
                        [orderIds, shipmentIds]
                    );
                    const importedOrderIds = new Set(existingPackages.map(p => p.meliOrderId).filter(Boolean));
                    const importedShipmentIds = new Set(existingPackages.map(p => p.meliFlexCode).filter(Boolean));
                    const pendingOrders = ordersData.results.filter(order => {
                        const shipmentId = order.shipping?.id?.toString();
                        return !importedOrderIds.has(order.id.toString()) && !(shipmentId && importedShipmentIds.has(shipmentId));
                    });

                    const mappedOrders = await Promise.all(pendingOrders.map(async (order) => {
                        const shipmentId = order.shipping?.id;
                        let shipment = null;
                        if (shipmentId) {
                            try {
                                shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, meliIntegration.accessToken);
                            } catch (e) {
                                console.error(`Error fetching shipment ${shipmentId} for account ${account.nickname}`);
                            }
                        }

                        return {
                            id: order.id.toString(),
                            recipientName: shipment?.receiver_address?.receiver_name || order.buyer?.nickname || 'N/A',
                            address: shipment?.receiver_address?.address_line || 'N/A',
                            // Normalized so this matches auth.activeCommunes exactly on the
                            // frontend (raw ML values can have missing accents/spacing quirks
                            // that the actual import already tolerates via normalizeCommune,
                            // but a naive string comparison here would not).
                            commune: normalizeCommune(shipment?.receiver_address?.city?.name || 'N/A'),
                            city: shipment?.receiver_address?.state?.name || 'N/A',
                            notes: `ML Order: ${order.id} (${account.nickname})`,
                            shipmentId: shipmentId,
                            sourceAccountId: account.id,
                            sourceAccountName: account.nickname
                        };
                    }));
                    allOrders = [...allOrders, ...mappedOrders];
                }
            } catch (accErr) {
                console.error(`Error fetching orders for account ${account.nickname}:`, accErr.message);
                // Continue with next account
            }
        }

        res.json(allOrders);
    } catch (err) {
        console.error("Meli Fetch Orders Error:", err.body || err);
        res.status(500).json({ message: err.message || 'Error al obtener pedidos de Mercado Libre.' });
    }
});

// GET /api/integrations/:clientId/meli/sync-status
router.get('/:clientId/meli/sync-status', authMiddleware, async (req, res) => {
    const { clientId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para ver este estado.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });

        const integrations = ensureMultiAccountStructure(userRows[0].integrations);
        const meliAccounts = integrations.accounts.filter(acc => acc.type === 'MERCADO_LIBRE');

        res.json({
            accounts: meliAccounts.map(acc => {
                const settings = acc.settings || {};
                // Same default as the poller itself (meliPollingService.js) so this
                // matches what will actually happen, not just a guess.
                const syncIntervalMin = settings.syncInterval !== undefined ? settings.syncInterval : 2;
                const lastAttempt = settings.lastAttemptAt || settings.lastSync || null;
                const nextExpectedAt = lastAttempt
                    ? new Date(new Date(lastAttempt).getTime() + syncIntervalMin * 60000).toISOString()
                    : null;
                return {
                    id: acc.id,
                    nickname: acc.nickname,
                    lastSync: settings.lastSync || null,
                    lastAttemptAt: settings.lastAttemptAt || null,
                    autoImport: settings.autoImport ?? false,
                    nextExpectedAt
                };
            })
        });
    } catch (err) {
        console.error("Meli Sync Status Error:", err.body || err);
        res.status(500).json({ message: err.message || 'Error al obtener el estado de sincronización.' });
    }
});

// POST /api/integrations/:clientId/meli/import
router.post('/:clientId/meli/import', authMiddleware, async (req, res) => {
    const { clientId } = req.params;
    const { orderIds, orderAccountMap } = req.body; // orderAccountMap is optional: { orderId: accountId }

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para importar estos pedidos.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations, "clientIdentifier" FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado.' });
        
        const clientIdentifier = userRows[0].clientIdentifier;
        const integrations = ensureMultiAccountStructure(userRows[0].integrations);
        const meliAccounts = integrations.accounts.filter(acc => acc.type === 'MERCADO_LIBRE');

        const results = [];
        for (const orderId of orderIds) {
            try {
                // Determine which account to use
                let accountToUse = null;
                const explicitAccountId = orderAccountMap ? orderAccountMap[orderId] : null;
                
                if (explicitAccountId) {
                    accountToUse = meliAccounts.find(acc => acc.id === explicitAccountId);
                }

                // If not found or not provided, try to find by fetching order details (expensive but safe fallback)
                if (!accountToUse) {
                    for (const acc of meliAccounts) {
                        try {
                            const testIntegration = await getValidMeliIntegration(clientId, acc.id);
                            const orderTest = await makeMeliGetRequest(`/orders/${orderId}`, testIntegration.accessToken);
                            if (orderTest && orderTest.id) {
                                accountToUse = acc;
                                break;
                            }
                        } catch (e) { continue; }
                    }
                }

                if (!accountToUse) {
                    results.push({ orderId, status: 'error', message: 'No se encontrÃ³ la cuenta vinculada para este pedido.' });
                    continue;
                }

                const meliIntegration = await getValidMeliIntegration(clientId, accountToUse.id);
                
                // 1. Get Order Details
                const order = await makeMeliGetRequest(`/orders/${orderId}`, meliIntegration.accessToken);
                const shipmentId = order.shipping?.id;
                
                if (!shipmentId) {
                    results.push({ orderId, status: 'error', message: 'No se encontrÃ³ un ID de envÃ­o para este pedido.' });
                    continue;
                }

                // 2. Get Shipment Details
                const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, meliIntegration.accessToken);

                // 3. Check if already imported
                const { rows: existing } = await db.query('SELECT id FROM packages WHERE "meliOrderId" = $1 OR "meliFlexCode" = $2', [orderId.toString(), shipmentId.toString()]);
                if (existing.length > 0) {
                    results.push({ orderId, status: 'skipped', message: 'Ya importado.' });
                    continue;
                }

                // 4. Create local package
                const now = new Date();
                
                // Normalize Region/City name for RM and SKIP if outside
                let stateName = shipment.receiver_address?.state?.name || 'Santiago';
                const lowerState = stateName.toLowerCase();
                const isRM = lowerState.includes('metropolitana') || 
                             lowerState.includes('santiago') || 
                             lowerState === 'rm' ||
                             lowerState.includes('r.m.');

                if (!isRM) {
                    results.push({ orderId, status: 'error', message: `El destino (${stateName}) estÃ¡ fuera de la RegiÃ³n Metropolitana.` });
                    continue;
                }
                stateName = 'RegiÃ³n Metropolitana';

                const newPackage = {
                    id: `${clientIdentifier}-${uuidv4().split('-')[0]}`,
                    recipientName: shipment.receiver_address?.receiver_name || order.buyer?.nickname || 'N/A',
                    recipientPhone: shipment.receiver_address?.receiver_phone || 'N/A',
                    status: 'PENDIENTE',
                    shippingType: 'SAME_DAY',
                    origin: 'Centro de DistribuciÃ³n',
                    recipientAddress: shipment.receiver_address?.address_line || 'N/A',
                    recipientCommune: shipment.receiver_address?.city?.name || 'N/A',
                    recipientCity: stateName,
                    notes: `ML Order: ${orderId}`,
                    estimatedDelivery: now,
                    createdAt: now,
                    updatedAt: now,
                    creatorId: clientId,
                    meliOrderId: orderId.toString(),
                    meliFlexCode: shipmentId.toString(),
                    meliSellerId: meliIntegration.userId.toString(),
                    sourceAccountId: accountToUse.id,
                    isFlex: shipment.logistic_type === 'self_service',
                    source: 'MERCADO_LIBRE'
                };

                const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
                const placeholders = Object.keys(newPackage).map((_, i) => `$${i + 1}`).join(', ');
                const values = Object.values(newPackage);

                const { rows: inserted } = await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders}) RETURNING id`, values);
                
                // Add tracking event
                await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
                    [inserted[0].id, 'Creado', newPackage.origin, 'Importado desde Mercado Libre.', now]);

                results.push({ orderId, status: 'success', packageId: inserted[0].id });

            } catch (err) {
                console.error(`[MeliImport] Error importing order ${orderId}:`, err.message);
                results.push({ orderId, status: 'error', message: err.message || 'Error desconocido.' });
            }
        }

        res.json(results);
    } catch (err) {
        console.error("Meli Import Error:", err);
        res.status(500).json({ message: 'Error interno al importar pedidos.' });
    }
});

// --- SHOPIFY API HELPERS ---
const makeShopifyRequest = (shopUrl, accessToken, path, method = 'GET', postData = null) => {
    return new Promise((resolve, reject) => {
        if (!shopUrl) return reject(new Error('La URL de la tienda es requerida.'));
        if (!accessToken) return reject(new Error('El Access Token de Shopify es requerido.'));

        // Extract only the hostname (e.g., shopname.myshopify.com)
        let hostname = shopUrl.trim();
        
        // Remove protocol
        hostname = hostname.replace(/^https?:\/\//, '');
        
        // Remove path if present (e.g. tienda.myshopify.com/admin)
        hostname = hostname.split('/')[0];
        
        // Remove port if present
        hostname = hostname.split(':')[0];

        // Basic validation: if no dots, assume it's just the shop name
        if (hostname && !hostname.includes('.')) {
            hostname += '.myshopify.com';
        }

        if (!hostname) {
            return reject(new Error('URL de tienda invÃ¡lida. Por favor usa el formato "tienda.myshopify.com".'));
        }

        const options = {
            hostname: hostname,
            path: `/admin/api/2026-01${path}`,
            method: method,
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'X-Shopify-Api-Version': '2026-01',
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedData);
                    } else {
                        // Shopify often returns errors as { errors: "..." } or { errors: { field: ["error"] } }
                        reject({ statusCode: res.statusCode, body: parsedData });
                    }
                } catch (e) {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject({ statusCode: res.statusCode, body: data, isRaw: true });
                    }
                }
            });
        });

        req.on('error', (e) => {
            console.error(`Shopify Request Error (${hostname}):`, e.message);
            reject(new Error(`Error de red al contactar a Shopify (${hostname}): ${e.message}`));
        });

        if (postData) {
            req.write(JSON.stringify(postData));
        }
        req.end();
    });
};

const getValidShopifyIntegration = async (clientId, accountId = null) => {
    const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
    if (userRows.length === 0) throw new Error('Cliente no encontrado.');
    
    let integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
    let shopifyIntegration = null;

    if (accountId) {
        const acc = integrations.accounts.find(a => a.id === accountId && a.type === 'SHOPIFY');
        if (acc) shopifyIntegration = acc.credentials;
    } else {
        shopifyIntegration = integrations.shopify;
        if (!shopifyIntegration && integrations.accounts) {
            const acc = integrations.accounts.find(a => a.type === 'SHOPIFY');
            if (acc) shopifyIntegration = acc.credentials;
        }
    }
    
    // If not in user, check global settings
    if (!shopifyIntegration || !shopifyIntegration.shopUrl || !shopifyIntegration.accessToken) {
        const { rows: settingsRows } = await db.query('SELECT shopify_shop_url, shopify_access_token FROM integration_settings WHERE id = 1');
        if (settingsRows.length > 0 && settingsRows[0].shopify_shop_url && settingsRows[0].shopify_access_token) {
            shopifyIntegration = {
                shopUrl: settingsRows[0].shopify_shop_url,
                accessToken: settingsRows[0].shopify_access_token
            };
        }
    }

    if (!shopifyIntegration || !shopifyIntegration.shopUrl || !shopifyIntegration.accessToken) {
        throw new Error('El cliente no tiene Shopify configurado.');
    }

    // decrypt() safely returns its input unchanged if it isn't actually encrypted (see
    // falabellaCrypto.js) — so tokens saved before this change (still plaintext) keep working
    // exactly as before, while anything saved from now on comes back correctly decrypted.
    return { ...shopifyIntegration, accessToken: decrypt(shopifyIntegration.accessToken) };
};

const getValidWooCommerceIntegration = async (clientId, accountId = null) => {
    const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
    if (userRows.length === 0) throw new Error('Cliente no encontrado.');
    
    let integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
    let wooIntegration = null;

    if (accountId) {
        const acc = integrations.accounts.find(a => a.id === accountId && a.type === 'WOOCOMMERCE');
        if (acc) wooIntegration = acc.credentials;
    } else {
        wooIntegration = integrations.woocommerce;
        if (!wooIntegration && integrations.accounts) {
            const acc = integrations.accounts.find(a => a.type === 'WOOCOMMERCE');
            if (acc) wooIntegration = acc.credentials;
        }
    }
    
    // If not in user, check global settings
    if (!wooIntegration || !wooIntegration.wooUrl || !wooIntegration.wooConsumerKey || !wooIntegration.wooConsumerSecret) {
        const { rows: settingsRows } = await db.query('SELECT woo_url, woo_consumer_key, woo_consumer_secret FROM integration_settings WHERE id = 1');
        if (settingsRows.length > 0 && settingsRows[0].woo_url && settingsRows[0].woo_consumer_key && settingsRows[0].woo_consumer_secret) {
            wooIntegration = {
                wooUrl: settingsRows[0].woo_url,
                wooConsumerKey: settingsRows[0].woo_consumer_key,
                wooConsumerSecret: settingsRows[0].woo_consumer_secret
            };
        }
    }

    if (!wooIntegration || !wooIntegration.wooUrl || !wooIntegration.wooConsumerKey || !wooIntegration.wooConsumerSecret) {
        throw new Error('El cliente no tiene WooCommerce configurado.');
    }

    return wooIntegration;
};

const getValidFalabellaIntegration = async (clientId, accountId = null) => {
    const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
    if (userRows.length === 0) throw new Error('Cliente no encontrado.');
    
    let integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
    let falabellaIntegration = null;

    if (accountId) {
        const acc = integrations.accounts.find(a => a.id === accountId && a.type === 'FALABELLA');
        if (acc) falabellaIntegration = acc.credentials;
    } else {
        falabellaIntegration = integrations.falabella;
        if (!falabellaIntegration && integrations.accounts) {
            const acc = integrations.accounts.find(a => a.type === 'FALABELLA');
            if (acc) falabellaIntegration = acc.credentials;
        }
    }
    
    // If not in user, check global settings
    if (!falabellaIntegration || !falabellaIntegration.falabellaApiKey || !falabellaIntegration.falabellaSellerId) {
        const { rows: settingsRows } = await db.query('SELECT falabella_api_key, falabella_seller_id FROM integration_settings WHERE id = 1');
        if (settingsRows.length > 0 && settingsRows[0].falabella_api_key && settingsRows[0].falabella_seller_id) {
            falabellaIntegration = {
                falabellaApiKey: settingsRows[0].falabella_api_key,
                falabellaSellerId: settingsRows[0].falabella_seller_id
            };
        }
    }

    if (!falabellaIntegration || !falabellaIntegration.falabellaApiKey || !falabellaIntegration.falabellaSellerId) {
        throw new Error('El cliente no tiene Falabella configurado.');
    }

    return falabellaIntegration;
};

const getValidJumpsellerIntegration = async (clientId, accountId = null) => {
    const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
    if (userRows.length === 0) throw new Error('Cliente no encontrado.');
    
    let integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
    let jumpsellerIntegration = null;

    if (accountId) {
        const acc = integrations.accounts.find(a => a.id === accountId && a.type === 'JUMPSELLER');
        if (acc) jumpsellerIntegration = acc.credentials;
    } else {
        jumpsellerIntegration = integrations.jumpseller;
        if (!jumpsellerIntegration && integrations.accounts) {
            const acc = integrations.accounts.find(a => a.type === 'JUMPSELLER');
            if (acc) jumpsellerIntegration = acc.credentials;
        }
    }
    
    if (!jumpsellerIntegration || !jumpsellerIntegration.login || !jumpsellerIntegration.token) {
        throw new Error('El cliente no tiene Jumpseller configurado.');
    }

    return jumpsellerIntegration;
};

// POST /api/integrations/test/shopify
router.post('/test/shopify', authMiddleware, async (req, res) => {
    const { shopifyShopUrl, shopifyAccessToken } = req.body;

    if (!shopifyShopUrl || !shopifyAccessToken) {
        return res.status(400).json({ message: 'URL de la tienda y Access Token son requeridos.' });
    }

    try {
        // Test by fetching shop info
        const shopData = await makeShopifyRequest(shopifyShopUrl, shopifyAccessToken, '/shop.json');
        res.json({ 
            message: 'ConexiÃ³n exitosa con Shopify.',
            shopName: shopData?.shop?.name
        });
    } catch (err) {
        console.error("Shopify Test Connection Error:", err.body || err);
        let errorMsg = 'Error al conectar con Shopify.';
        let statusCode = 500;
        
        if (err.statusCode) {
            statusCode = err.statusCode;
            if (err.statusCode === 401) {
                errorMsg = 'No autorizado. Verifica que el Access Token sea correcto y tenga los permisos necesarios.';
            } else if (err.statusCode === 404) {
                errorMsg = 'No encontrado. Verifica que la URL de la tienda sea correcta.';
            } else if (err.statusCode === 403) {
                errorMsg = 'Acceso prohibido. El token no tiene permisos para acceder a la informaciÃ³n de la tienda.';
            }
        }

        if (err.body && err.body.errors) {
            if (typeof err.body.errors === 'string') {
                errorMsg = err.body.errors;
            } else if (typeof err.body.errors === 'object') {
                errorMsg = JSON.stringify(err.body.errors);
            }
        } else if (err.message) {
            errorMsg = err.message;
        }

        res.status(statusCode).json({ message: `Error de Shopify: ${errorMsg}` });
    }
});

// POST /api/integrations/test/woocommerce
router.post('/test/woocommerce', authMiddleware, async (req, res) => {
    const { wooUrl, wooConsumerKey, wooConsumerSecret } = req.body;
    
    if (!wooUrl || !wooConsumerKey || !wooConsumerSecret) {
        return res.status(400).json({ message: 'URL, Consumer Key y Consumer Secret son requeridos.' });
    }

    try {
        // Test by fetching system status or just a simple endpoint
        await makeWooCommerceRequest(wooUrl, wooConsumerKey, wooConsumerSecret, '/system_status');
        res.json({ message: 'ConexiÃ³n exitosa con WooCommerce.' });
    } catch (err) {
        console.error("WooCommerce Test Connection Error:", err.body || err);
        let errorMsg = 'Error al conectar con WooCommerce.';
        let statusCode = 500;
        
        if (err.statusCode) {
            statusCode = err.statusCode;
            if (err.statusCode === 401) {
                errorMsg = 'No autorizado. Verifica que el Consumer Key y Consumer Secret sean correctos.';
            } else if (err.statusCode === 404) {
                errorMsg = 'No encontrado. Verifica que la URL sea correcta y la API REST estÃ© habilitada.';
            }
        }

        if (err.body && err.body.message) {
            errorMsg = err.body.message;
        } else if (err.message) {
            errorMsg = err.message;
        }

        res.status(statusCode).json({ message: `Error de WooCommerce: ${errorMsg}` });
    }
});

// POST /api/integrations/test/falabella
router.post('/test/falabella', authMiddleware, async (req, res) => {
    const { falabellaApiKey, falabellaSellerId } = req.body;
    
    if (!falabellaApiKey || !falabellaSellerId) {
        return res.status(400).json({ message: 'API Key y Seller ID son requeridos.' });
    }

    try {
        let apiKey = falabellaApiKey;
        if (falabellaApiKey === '************************') {
            const { rows } = await db.query('SELECT falabella_api_key FROM integration_settings WHERE id = 1');
            if (rows.length > 0) {
                apiKey = rows[0].falabella_api_key;
            }
        }
        const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        await makeFalabellaRequest(apiKey, falabellaSellerId, 'GetOrders', 'GET', { Limit: 1, CreatedAfter: createdAfter });
        res.json({ message: 'Conexión exitosa con Falabella Seller Center (API Key y Seller ID válidos).' });
    } catch (err) {
        console.error("Falabella Test Connection Error:", err.body || err);
        let errorMsg = 'Error desconocido al conectar con Falabella';
        if (err.body && err.body.ErrorResponse && err.body.ErrorResponse.Head) {
            errorMsg = err.body.ErrorResponse.Head.ErrorMessage || err.body.ErrorResponse.Head.ErrorCode;
        } else if (err.statusCode === 403) {
            errorMsg = 'Acceso Denegado (403). Verifica que el Seller ID y la API Key sean correctos y pertenezcan a Falabella.';
        } else if (err.message) {
            errorMsg = err.message;
        } else if (err.body) {
            errorMsg = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
        }
        res.status(500).json({ message: 'Error al conectar con Falabella: ' + errorMsg });
    }
});

// GET /api/integrations/:clientId/shopify/orders
router.get('/:clientId/shopify/orders', authMiddleware, async (req, res) => {
    const { clientId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para ver estos pedidos.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
        
        const integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
        const shopifyAccounts = integrations.accounts.filter(acc => acc.type === 'SHOPIFY');

        if (shopifyAccounts.length === 0) {
            // Check legacy field or global settings
            try {
                const legacyShopify = await getValidShopifyIntegration(clientId);
                if (legacyShopify) {
                    shopifyAccounts.push({
                        id: 'legacy-shopify',
                        nickname: 'Shopify (Principal)',
                        credentials: legacyShopify
                    });
                }
            } catch (e) {
                return res.json([]);
            }
        }

        let allOrders = [];
        for (const account of shopifyAccounts) {
            try {
                // Fetch open orders
                const data = await makeShopifyRequest(
                    account.credentials.shopUrl, 
                    account.credentials.accessToken, 
                    '/orders.json?status=open&fulfillment_status=unfulfilled'
                );
                
                if (data && data.orders) {
                    const mapped = data.orders.map(order => ({
                        id: order.id.toString(),
                        recipientName: `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim() || order.customer?.first_name || 'N/A',
                        recipientPhone: order.shipping_address?.phone || order.customer?.phone || 'N/A',
                        address: `${order.shipping_address?.address1 || ''} ${order.shipping_address?.address2 || ''}`.trim() || 'N/A',
                        commune: normalizeCommune(order.shipping_address?.city || 'N/A'),
                        city: order.shipping_address?.province || 'N/A',
                        notes: `Shopify Order: ${order.name || order.id} (${account.nickname})`,
                        orderNumber: order.order_number?.toString() || order.name || order.id.toString(),
                        sourceAccountId: account.id,
                        sourceAccountName: account.nickname
                    }));
                    allOrders = [...allOrders, ...mapped];
                }
            } catch (err) {
                console.error(`Error fetching Shopify orders for ${account.nickname}:`, err.message);
            }
        }

        res.json(allOrders);
    } catch (err) {
        console.error("Shopify Fetch Orders Error:", err.body || err);
        res.status(500).json({ message: err.message || 'Error al obtener pedidos de Shopify.' });
    }
});

// POST /api/integrations/shopify/webhook
// Receiver for Shopify 'orders/create' webhooks
router.post('/shopify/webhook', async (req, res) => {
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];

    console.log(`[ShopifyWebhook] Received ${topic} from ${shopDomain}`);

    if (topic !== 'orders/create' && topic !== 'orders/updated') {
        // We only care about new orders or significant updates for now
        return res.status(200).send('OK');
    }

    try {
        const order = req.body;
        const orderId = order.id.toString();

        // 1. Find the client/user associated with this shop domain
        const { rows: userRows } = await db.query(
            "SELECT id, name, \"clientIdentifier\", \"pickupAddress\", address FROM users WHERE integrations->'shopify'->>'shopUrl' ILIKE $1 OR integrations->'shopify'->>'shopUrl' ILIKE $2",
            [shopDomain, shopDomain.replace('.myshopify.com', '')]
        );

        if (userRows.length === 0) {
            console.error(`[ShopifyWebhook] No client found for shop domain: ${shopDomain}`);
            return res.status(404).send('Shop not found in our system');
        }

        const client = userRows[0];
        console.log(`[ShopifyWebhook] Mapping order ${orderId} to client ${client.name} (${client.id})`);

        // 2. Check if already imported
        const { rows: existing } = await db.query('SELECT id FROM packages WHERE "shopifyOrderId" = $1', [orderId]);
        if (existing.length > 0) {
            console.log(`[ShopifyWebhook] Order ${orderId} already exists (ID: ${existing[0].id}), ignoring.`);
            return res.status(200).send('Already imported');
        }

        // 3. Map Shopify Order to Full Envios Package
        const now = new Date();
        const origin = client.pickupAddress || client.address || 'Shopify Webhook';

        // Extract address data
        const shipping = order.shipping_address || {};
        const customer = order.customer || {};

        const newPackage = {
            id: `${client.clientIdentifier}-${uuidv4().split('-')[0]}`,
            recipientName: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim() || `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'N/A',
            recipientPhone: shipping.phone || customer.phone || 'N/A',
            status: 'PENDIENTE',
            shippingType: 'SAME_DAY',
            origin: origin,
            recipientAddress: `${shipping.address1 || ''} ${shipping.address2 || ''}`.trim() || 'N/A',
            recipientCommune: shipping.city || 'N/A',
            recipientCity: shipping.province || 'N/A',
            notes: `Shopify Order: ${order.name || order.id}`,
            estimatedDelivery: now,
            createdAt: now,
            updatedAt: now,
            creatorId: client.id,
            source: 'SHOPIFY',
            shopifyOrderId: orderId,
            shopifyOrderNumber: order.order_number?.toString() || order.name || orderId
        };

        const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
        const values = Object.values(newPackage).map(v => v === undefined ? null : v);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
        await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
            [newPackage.id, 'Creado', newPackage.origin, 'Importado automÃ¡ticamente vÃ­a Webhook de Shopify.', now]);

        console.log(`[ShopifyWebhook] Order ${orderId} imported successfully as package ${newPackage.id}`);
        res.status(201).send('Order Imported');

    } catch (err) {
        console.error("[ShopifyWebhook] Error processing webhook:", err);
        res.status(500).send('Internal Server Error');
    }
});

// GET /api/integrations/:clientId/woocommerce/orders
router.get('/:clientId/woocommerce/orders', authMiddleware, async (req, res) => {
    const { clientId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para ver estos pedidos.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });
        
        const integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
        const wooAccounts = integrations.accounts.filter(acc => acc.type === 'WOOCOMMERCE');

        if (wooAccounts.length === 0) {
            try {
                const legacyWoo = await getValidWooCommerceIntegration(clientId);
                if (legacyWoo) {
                    wooAccounts.push({
                        id: 'legacy-woo',
                        nickname: 'WooCommerce (Principal)',
                        credentials: legacyWoo
                    });
                }
            } catch (e) {
                return res.json([]);
            }
        }

        let allOrders = [];
        for (const account of wooAccounts) {
            try {
                const ordersData = await makeWooCommerceRequest(
                    account.credentials.wooUrl, 
                    account.credentials.wooConsumerKey, 
                    account.credentials.wooConsumerSecret, 
                    '/orders?status=processing,completed'
                );
                
                if (ordersData && Array.isArray(ordersData)) {
                    // Evitar mostrar órdenes antiguas creadas antes de conectar la cuenta
                    const connectionDate = new Date(account.connectedAt || 0);
                    const buffer = 2 * 60 * 60 * 1000; // 2 horas de buffer
                    
                    const filtered = ordersData.filter(order => {
                        const orderDateStr = order.date_created_gmt ? order.date_created_gmt + 'Z' : order.date_created;
                        const orderDate = new Date(orderDateStr);
                        return orderDate.getTime() >= (connectionDate.getTime() - buffer);
                    });

                    const mapped = filtered.map(order => ({
                        id: order.id.toString(),
                        recipientName: `${order.shipping?.first_name || ''} ${order.shipping?.last_name || ''}`.trim() || `${order.billing?.first_name || ''} ${order.billing?.last_name || ''}`.trim() || 'N/A',
                        recipientPhone: order.billing?.phone || 'N/A',
                        address: `${order.shipping?.address_1 || ''} ${order.shipping?.address_2 || ''}`.trim() || order.billing?.address_1 || 'N/A',
                        commune: normalizeCommune(order.shipping?.city || order.billing?.city || 'N/A'),
                        city: order.shipping?.state || order.billing?.state || 'N/A',
                        notes: `Woo Order: ${order.number || order.id} (${account.nickname})`,
                        sourceAccountId: account.id,
                        sourceAccountName: account.nickname
                    }));
                    allOrders = [...allOrders, ...mapped];
                }
            } catch (err) {
                console.error(`Error fetching WooCommerce orders for ${account.nickname}:`, err.message);
            }
        }

        res.json(allOrders);
    } catch (err) {
        console.error("WooCommerce Fetch Orders Error:", err.body || err);
        res.status(500).json({ message: 'Error al obtener pedidos de WooCommerce.' });
    }
});

function decodeHtmlEntities(str) {
    if (!str) return '';
    const htmlEntitiesMap = {
        '&style;': ' ', '&nbsp;': ' ', '&deg;': '°', '&ordm;': '°',
        '&value;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
        '&quot;': '"', '&apos;': "'",
        '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
        '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
        '&ntilde;': 'ñ', '&Ntilde;': 'Ñ', '&uuml;': 'ü', '&Uuml;': 'Ü'
    };
    return str
        .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/&#x([a-fA-F0-9]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&[a-zA-Z0-9#]+;/g, (match) => htmlEntitiesMap[match] || match);
}

// GET /api/integrations/:clientId/falabella/orders
router.get('/:clientId/falabella/orders', authMiddleware, async (req, res) => {
    const { clientId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para ver estos pedidos.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });
        
        const integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
        const falabellaAccounts = integrations.accounts.filter(acc => acc.type === 'FALABELLA');

        if (falabellaAccounts.length === 0) {
            // Check legacy integration credentials or global settings as fallback
            try {
                const legacyFalabella = await getValidFalabellaIntegration(clientId);
                if (legacyFalabella) {
                    falabellaAccounts.push({
                        id: 'legacy-falabella',
                        nickname: 'Falabella (Principal)',
                        credentials: {
                            falabellaApiKey: legacyFalabella.falabellaApiKey,
                            falabellaSellerId: legacyFalabella.falabellaSellerId
                        }
                    });
                }
            } catch (e) {
                return res.json([]);
            }
        }

        let allOrders = [];
        const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        for (const account of falabellaAccounts) {
            try {
                const fetchOrdersByStatus = async (status) => {
                    const response = await makeFalabellaRequest(
                        account.credentials.falabellaApiKey,
                        account.credentials.falabellaSellerId,
                        'GetOrders',
                        'GET',
                        { CreatedAfter: createdAfter, Status: status }
                    );
                    const ordersRaw = response?.SuccessResponse?.Body?.Orders;
                    if (!ordersRaw) return [];
                    // Falabella returns an array [{Order:{...}},{Order:{...}}] for multiple orders
                    // but {Order:{...}} for a single order
                    if (Array.isArray(ordersRaw)) {
                        return ordersRaw.map(item => item.Order).filter(Boolean);
                    } else if (ordersRaw.Order) {
                        return Array.isArray(ordersRaw.Order) ? ordersRaw.Order : [ordersRaw.Order];
                    }
                    return [];
                };

                const [pendingOrders, readyOrders] = await Promise.all([
                    fetchOrdersByStatus('pending'),
                    fetchOrdersByStatus('ready_to_ship')
                ]);

                const combinedOrders = [...pendingOrders, ...readyOrders];

                if (combinedOrders.length > 0) {
                    const mapped = combinedOrders.map(order => {
                        const rawFirstName = order.CustomerFirstName || '';
                        const rawLastName = order.CustomerLastName || '';
                        const fullName = decodeHtmlEntities(`${rawFirstName} ${rawLastName}`.trim());

                        const address1 = order.AddressBilling?.Address1 || '';
                        const address2 = order.AddressBilling?.Address2 || '';
                        const fullAddress = decodeHtmlEntities([address1, address2].filter(Boolean).join(', ').trim());

                        return {
                            id: order.OrderId ? order.OrderId.toString() : uuidv4(),
                            recipientName: fullName || 'N/A',
                            recipientPhone: order.AddressShipping?.Phone || order.AddressBilling?.Phone || order.CustomerPhone || 'N/A',
                            address: fullAddress || 'N/A',
                            // Falabella sends "COMUNA - SECTOR" (e.g. "Lo Barnechea - La Dehesa")
                            // for Ward — normalizeCommune resolves that to the real commune name
                            // so this matches auth.activeCommunes exactly, instead of the raw
                            // string never matching and showing every order as wrongly "inactive"
                            // (with its checkbox disabled) in the import screen.
                            commune: normalizeCommune(decodeHtmlEntities(order.AddressShipping?.Ward || order.AddressBilling?.Ward || 'N/A')),
                            city: decodeHtmlEntities(order.AddressShipping?.City || order.AddressBilling?.City || 'N/A').toUpperCase().trim(),
                            notes: decodeHtmlEntities(order.Remarks || order.Notes || `Falabella Order: ${order.OrderNumber || order.OrderId}`),
                            orderNumber: order.OrderNumber ? order.OrderNumber.toString() : (order.OrderId ? order.OrderId.toString() : 'N/A'),
                            sourceAccountId: account.id,
                            sourceAccountName: account.nickname
                        };
                    });
                    
                    allOrders = [...allOrders, ...mapped];
                }
            } catch (err) {
                console.error(`Error fetching Falabella orders for ${account.nickname}:`, err.message || err);
            }
        }

        // Filter out already imported orders so they disappear from the list
        if (allOrders.length > 0) {
            const { rows: existing } = await db.query(
                'SELECT "falabellaOrderId" FROM packages WHERE "creatorId" = $1 AND "falabellaOrderId" IS NOT NULL',
                [clientId]
            );
            const importedIds = new Set(existing.map(p => p.falabellaOrderId));
            allOrders = allOrders.filter(order => !importedIds.has(order.id));
        }

        res.json(allOrders);
    } catch (err) {
        console.error("Falabella Fetch Orders Error:", err);
        res.status(500).json({ message: 'Error al obtener pedidos de Falabella: ' + (err.message || 'Error desconocido') });
    }
});

// GET /api/integrations/:clientId/falabella/sync-status
router.get('/:clientId/falabella/sync-status', authMiddleware, async (req, res) => {
    const { clientId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para ver este estado.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado' });

        const integrations = ensureMultiAccountStructure(userRows[0].integrations);
        const falabellaAccounts = integrations.accounts.filter(acc => acc.type === 'FALABELLA');

        res.json({
            accounts: falabellaAccounts.map(acc => {
                const settings = acc.settings || {};
                // Same default as the poller itself (falabellaPollingService.js).
                const syncIntervalMin = settings.syncInterval !== undefined ? settings.syncInterval : 5;
                const lastAttempt = settings.lastAttemptAt || settings.lastSync || null;
                const nextExpectedAt = lastAttempt
                    ? new Date(new Date(lastAttempt).getTime() + syncIntervalMin * 60000).toISOString()
                    : null;
                return {
                    id: acc.id,
                    nickname: acc.nickname,
                    lastSync: settings.lastSync || null,
                    lastAttemptAt: settings.lastAttemptAt || null,
                    autoImport: settings.autoImport ?? false,
                    nextExpectedAt
                };
            })
        });
    } catch (err) {
        console.error("Falabella Sync Status Error:", err.body || err);
        res.status(500).json({ message: err.message || 'Error al obtener el estado de sincronización.' });
    }
});

// GET /api/integrations/meli/auth
// Inicia el flujo de OAuth con Mercado Libre
router.get('/meli/auth', authMiddleware, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT meli_app_id FROM integration_settings WHERE id = 1');
        if (rows.length === 0 || !rows[0].meli_app_id) {
            return res.status(500).json({ message: 'El administrador no ha configurado el App ID de Mercado Libre.' });
        }

        const clientId = rows[0].meli_app_id;
        const host = req.get('host');
        // Usamos https por defecto ya que producciÃ³n exige SSL, localhost se maneja por proxy o directamente
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const redirectUri = encodeURIComponent(`${protocol}://${host}/api/integrations/meli/callback`);
        
        // El 'state' es fundamental para saber a quÃ© usuario asignar la cuenta al volver
        const authUrl = `https://auth.mercadolibre.cl/authorization?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&state=${req.user.id}`;
        
        res.redirect(authUrl);
    } catch (err) {
        console.error('[MeliAuth] Error:', err);
        res.status(500).json({ message: 'Error interno al iniciar autenticaciÃ³n con ML' });
    }
});

// GET /api/integrations/meli/callback
// Recibe el cÃ³digo de ML y guarda la cuenta en el array de integraciones del usuario
router.get('/meli/callback', async (req, res) => {
    const { code, state: userId } = req.query;

    if (!code || !userId) {
        return res.status(400).send('Faltan parÃ¡metros de autorizaciÃ³n (code o state).');
    }

    try {
        // 1. Obtener credenciales de la App
        const { rows: settingsRows } = await db.query('SELECT meli_app_id, meli_client_secret FROM integration_settings WHERE id = 1');
        if (settingsRows.length === 0) return res.status(500).send('ConfiguraciÃ³n de ML no encontrada.');
        
        const { meli_app_id, meli_client_secret } = settingsRows[0];
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const redirectUri = `${protocol}://${host}/api/integrations/meli/callback`;
        
        // 2. Intercambiar cÃ³digo por tokens
        const postData = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: meli_app_id,
            client_secret: meli_client_secret,
            code: code,
            redirect_uri: redirectUri
        }).toString();

        const tokenData = await makeMeliPostRequest('/oauth/token', postData);
        const meliUserId = tokenData.user_id.toString();

        // 3. Obtener informaciÃ³n bÃ¡sica del vendedor (nickname)
        let nickname = `Mercado Libre (${meliUserId})`;
        try {
            const userData = await makeMeliGetRequest(`/users/${meliUserId}`, tokenData.access_token);
            if (userData && userData.nickname) nickname = userData.nickname;
        } catch (e) { console.error('Error fetching ML user info:', e); }

        // 4. Verificar duplicados (Â¿EstÃ¡ esta cuenta de ML en otro usuario?)
        // Buscamos tanto en la estructura vieja como en el nuevo array 'accounts'
        const duplicateCheckQuery = `
            SELECT id, name FROM users 
            WHERE (
                integrations->'meli'->>'userId' = $1 
                OR integrations->'accounts' @> $3
            ) 
            AND id != $2
        `;
        const accountMatchJson = JSON.stringify([{ type: 'MERCADO_LIBRE', credentials: { userId: meliUserId } }]);
        const { rows: duplicateRows } = await db.query(duplicateCheckQuery, [meliUserId, userId, accountMatchJson]);

        if (duplicateRows.length > 0) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="es">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Cuenta ya vinculada | Full EnvÃ­os</title>
                    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
                    <style>
                        :root {
                            --brand-primary: #6366f1;
                            --error: #ef4444;
                            --bg: #0f172a;
                        }
                        body {
                            margin: 0;
                            font-family: 'Outfit', sans-serif;
                            background: var(--bg);
                            color: white;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            height: 100vh;
                            overflow: hidden;
                        }
                        .container {
                            background: rgba(30, 41, 59, 0.7);
                            backdrop-filter: blur(12px);
                            border: 1px solid rgba(255, 255, 255, 0.1);
                            padding: 3rem;
                            border-radius: 2rem;
                            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                            max-width: 450px;
                            text-align: center;
                            animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
                        }
                        @keyframes slideUp {
                            from { opacity: 0; transform: translateY(30px); }
                            to { opacity: 1; transform: translateY(0); }
                        }
                        .icon-circle {
                            width: 80px;
                            height: 80px;
                            background: rgba(239, 68, 68, 0.1);
                            color: var(--error);
                            border-radius: 50%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 2.5rem;
                            margin: 0 auto 2rem;
                            border: 2px solid rgba(239, 68, 68, 0.2);
                        }
                        h2 { margin: 0 0 1rem; font-weight: 700; font-size: 1.75rem; background: linear-gradient(to right, #ff4d4d, #f97316); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
                        p { color: #94a3b8; line-height: 1.6; margin-bottom: 2rem; }
                        .highlight { color: white; font-weight: 600; }
                        .btn {
                            background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
                            color: white;
                            border: none;
                            padding: 1rem 2rem;
                            border-radius: 1rem;
                            font-weight: 700;
                            cursor: pointer;
                            transition: all 0.3s;
                            box-shadow: 0 10px 15px -3px rgba(239, 68, 68, 0.3);
                            text-transform: uppercase;
                            letter-spacing: 1px;
                            font-size: 0.875rem;
                        }
                        .btn:hover { transform: translateY(-2px); box-shadow: 0 20px 25px -5px rgba(239, 68, 68, 0.4); }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="icon-circle">âœ•</div>
                        <h2>Cuenta ya vinculada</h2>
                        <p>La tienda <span class="highlight">${nickname}</span> ya pertenece al cliente <span class="highlight">${duplicateRows[0].name}</span>.</p>
                        <p style="font-size: 0.85rem;">Por seguridad, una cuenta de plataforma solo puede estar asociada a un Ãºnico usuario en Full EnvÃ­os.</p>
                        <button onclick="window.close()" class="btn">Cerrar Ventana</button>
                    </div>
                </body>
                </html>
            `);
        }

        // 5. Preparar objeto de cuenta
        const meliIntegration = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in * 1000),
            userId: meliUserId,
            connectedAt: new Date().toISOString()
        };

        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [userId]);
        if (userRows.length === 0) return res.status(404).send('Usuario no encontrado.');
        
        const integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
        
        const newAccount = {
            id: `meli-${meliUserId}`,
            type: 'MERCADO_LIBRE',
            nickname: nickname,
            credentials: meliIntegration,
            settings: { autoImport: true, syncInterval: 30 },
            connectedAt: new Date().toISOString()
        };

        // Actualizar si existe, o aÃ±adir si es nueva
        const existingIndex = integrations.accounts.findIndex(acc => acc.type === 'MERCADO_LIBRE' && acc.credentials.userId === meliUserId);
        if (existingIndex > -1) {
            integrations.accounts[existingIndex] = {
                ...integrations.accounts[existingIndex],
                credentials: meliIntegration,
                nickname: nickname // Actualizar nickname por si cambiÃ³
            };
        } else {
            integrations.accounts.push(newAccount);
        }

        // Mantener compatibilidad con el campo viejo si es la primera cuenta
        if (!integrations.meli || integrations.meli.userId === meliUserId) {
            integrations.meli = meliIntegration;
        }

        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), userId]);

        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Conexión Exitosa | Full Envíos</title>
                <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --brand-primary: #6366f1;
                        --success: #10b981;
                        --bg: #0f172a;
                    }
                    body {
                        margin: 0;
                        font-family: 'Outfit', sans-serif;
                        background: var(--bg);
                        color: white;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        overflow: hidden;
                    }
                    .container {
                        background: rgba(30, 41, 59, 0.7);
                        backdrop-filter: blur(12px);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        padding: 3rem;
                        border-radius: 2rem;
                        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                        max-width: 450px;
                        text-align: center;
                        animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
                    }
                    @keyframes slideUp {
                        from { opacity: 0; transform: translateY(30px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    .icon-circle {
                        width: 80px;
                        height: 80px;
                        background: rgba(16, 185, 129, 0.1);
                        color: var(--success);
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 1.5rem;
                    }
                    h1 { margin: 0 0 0.5rem; font-size: 1.8rem; font-weight: 700; }
                    p { color: #94a3b8; line-height: 1.6; margin-bottom: 2rem; }
                    .btn {
                        background: var(--brand-primary);
                        color: white;
                        text-decoration: none;
                        padding: 0.8rem 2rem;
                        border-radius: 0.8rem;
                        font-weight: 600;
                        display: inline-block;
                        transition: all 0.2s;
                        border: none;
                        cursor: pointer;
                        box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.3);
                    }
                    .btn:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 20px 25px -5px rgba(99, 102, 241, 0.4);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon-circle">
                        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    </div>
                    <h1>Conexión Exitosa</h1>
                    <p>Tu cuenta de Mercado Libre <strong>${nickname}</strong> ha sido vinculada correctamente a Full Envíos.</p>
                    <button onclick="if (window.opener) { window.close(); } else { window.location.href = '/'; }" class="btn">Volver al Sistema</button>
                </div>
                <script>
                    // Intentar avisar al sistema principal si es un popup
                    if (window.opener) {
                        window.opener.postMessage({ type: 'INTEGRATION_SUCCESS', platform: 'MERCADO_LIBRE' }, '*');
                        setTimeout(() => window.close(), 3000);
                    }
                </script>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('[MeliCallback] Error:', err);
        res.status(500).send('Error interno en la vinculaciÃ³n con Mercado Libre.');
    }
});

// GET /api/integrations/shopify/auth
// Inicia el flujo de OAuth con Shopify
router.get('/shopify/auth', authMiddleware, async (req, res) => {
    try {
        let { shop, clientId: queryClientId } = req.query;
        if (!shop) return res.status(400).json({ message: 'La URL de la tienda es requerida.' });

        // Si no se pasa clientId, usamos el del usuario actual (el que estÃ¡ haciendo clic)
        // Pero si es un ADMIN, podrÃ­a estar vinculando para otro usuario
        const targetUserId = queryClientId || req.user.id;

        // Clean shop URL
        shop = shop.trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
        if (!shop.includes('.')) shop += '.myshopify.com';

        const { rows } = await db.query('SELECT shopify_client_id FROM integration_settings WHERE id = 1');
        if (rows.length === 0 || !rows[0].shopify_client_id) {
            return res.status(500).json({ message: 'El administrador no ha configurado el Client ID de Shopify en la configuraciÃ³n global.' });
        }

        const clientId = rows[0].shopify_client_id;
        const host = req.get('host');
        const protocol = host.includes('localhost') ? 'http' : 'https';
        const redirectUri = `${protocol}://${host}/api/integrations/shopify/callback`;
        
        // Permisos necesarios para el polling de pedidos
        const scopes = 'read_orders,read_shipping,read_products,read_customers';
        const state = targetUserId; 

        const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        
        res.redirect(authUrl);
    } catch (err) {
        console.error('[ShopifyAuth] Error:', err);
        res.status(500).json({ message: 'Error interno al iniciar autenticaciÃ³n con Shopify' });
    }
});

// GET /api/integrations/shopify/callback
// Recibe el cÃ³digo de Shopify y guarda la cuenta
router.get('/shopify/callback', async (req, res) => {
    const { code, shop, state: userId, hmac } = req.query;

    if (!code || !userId || !shop) {
        return res.status(400).send('Faltan parÃ¡metros de autorizaciÃ³n de Shopify (code, shop o state).');
    }

    try {
        // 1. Obtener credenciales de la App Global
        const { rows: settingsRows } = await db.query('SELECT shopify_client_id, shopify_client_secret FROM integration_settings WHERE id = 1');
        if (settingsRows.length === 0) return res.status(500).send('ConfiguraciÃ³n global de Shopify no encontrada.');
        
        const { shopify_client_id, shopify_client_secret } = settingsRows[0];

        // 2. Intercambiar cÃ³digo por Access Token
        // Shopify requiere una peticiÃ³n POST a la tienda del cliente
        const postData = {
            client_id: shopify_client_id,
            client_secret: decrypt(shopify_client_secret),
            code: code
        };

        const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(postData)
        });

        const tokenData = await response.json();
        if (!tokenData.access_token) {
            console.error('[ShopifyCallback] Error exchanging code:', tokenData);
            return res.status(401).send('Error al obtener el Access Token de Shopify. Verifica las credenciales de la App.');
        }

        // 3. Guardar la cuenta en el usuario
        const { rows: userRows } = await db.query('SELECT id, name, integrations FROM users WHERE id = $1', [userId]);
        if (userRows.length === 0) return res.status(404).send('Usuario no encontrado.');

        let integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
        
        // Evitar duplicados para la misma tienda
        integrations.accounts = integrations.accounts.filter(acc => !(acc.type === 'SHOPIFY' && acc.credentials.shopUrl === shop));

        integrations.accounts.push({
            id: `shopify-${uuidv4().split('-')[0]}`,
            type: 'SHOPIFY',
            nickname: `Shopify (${shop.split('.')[0]})`,
            credentials: {
                shopUrl: shop,
                accessToken: encrypt(tokenData.access_token)
            },
            settings: {
                autoImport: true,
                syncInterval: 5
            },
            connectedAt: new Date().toISOString()
        });

        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), userId]);

        // 4. Responder con HTML de Ã©xito
        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Conexión Exitosa | Full Envíos</title>
                <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --brand-primary: #6366f1;
                        --success: #10b981;
                        --bg: #0f172a;
                    }
                    body {
                        margin: 0;
                        font-family: 'Outfit', sans-serif;
                        background: var(--bg);
                        color: white;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        overflow: hidden;
                    }
                    .container {
                        background: rgba(30, 41, 59, 0.7);
                        backdrop-filter: blur(12px);
                        border: 1px solid rgba(255, 255, 255, 0.1);
                        padding: 3rem;
                        border-radius: 2rem;
                        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                        max-width: 450px;
                        text-align: center;
                        animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
                    }
                    @keyframes slideUp {
                        from { opacity: 0; transform: translateY(30px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                    .icon-circle {
                        width: 80px;
                        height: 80px;
                        background: rgba(16, 185, 129, 0.1);
                        color: var(--success);
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 1.5rem;
                    }
                    h1 { margin: 0 0 0.5rem; font-size: 1.8rem; font-weight: 700; }
                    p { color: #94a3b8; line-height: 1.6; margin-bottom: 2rem; }
                    .btn {
                        background: var(--brand-primary);
                        color: white;
                        text-decoration: none;
                        padding: 0.8rem 2rem;
                        border-radius: 0.8rem;
                        font-weight: 600;
                        display: inline-block;
                        transition: all 0.2s;
                        border: none;
                        cursor: pointer;
                        box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.3);
                    }
                    .btn:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 20px 25px -5px rgba(99, 102, 241, 0.4);
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon-circle">
                        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    </div>
                    <h1>Conexión Exitosa</h1>
                    <p>Tu tienda de Shopify <strong>${shop}</strong> ha sido vinculada correctamente.</p>
                    <button onclick="if (window.opener) { window.close(); } else { window.location.href = '/'; }" class="btn">Volver al Sistema</button>
                </div>
                <script>
                    if (window.opener) {
                        window.opener.postMessage({ type: 'INTEGRATION_SUCCESS', platform: 'SHOPIFY' }, '*');
                        setTimeout(() => window.close(), 3000);
                    }
                </script>
            </body>
            </html>
        `);

    } catch (err) {
        console.error('[ShopifyCallback] Error:', err);
        res.status(500).send('Error interno en la vinculaciÃ³n con Shopify.');
    }
});

// --- SHOPIFY GDPR WEBHOOKS (MANDATORIOS PARA APROBACIÃ“N) ---
// Estos endpoints son requeridos por Shopify para cumplir con las leyes de protecciÃ³n de datos.

// Verifica que la llamada realmente venga de Shopify, comparando la firma HMAC del header
// contra una firma calculada con el client secret de la app (nunca confiar en estos webhooks
// sin esto: cualquiera podrÃ­a llamarlos y pedir el borrado de datos de otro comercio).
const verifyShopifyWebhookHmac = async (req) => {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!hmacHeader || !req.rawBody) return false;

    const { rows } = await db.query('SELECT shopify_client_secret FROM integration_settings WHERE id = 1');
    const secret = rows[0] && decrypt(rows[0].shopify_client_secret);
    if (!secret) return false;

    const digest = crypto.createHmac('sha256', secret).update(req.rawBody).digest('base64');
    try {
        return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
    } catch {
        return false; // largos distintos -> firma invÃ¡lida
    }
};

// Encuentra al cliente dueÃ±o de una tienda Shopify, ya sea que la tenga guardada en la
// estructura antigua (integrations.shopify) o en la de multi-cuenta (integrations.accounts).
const findClientByShopDomain = async (shopDomain) => {
    const bareDomain = (shopDomain || '').replace('.myshopify.com', '');
    const { rows } = await db.query(
        `SELECT id, name, "clientIdentifier", integrations FROM users
         WHERE integrations->'shopify'->>'shopUrl' ILIKE $1
            OR integrations->'shopify'->>'shopUrl' ILIKE $2
            OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(integrations->'accounts', '[]'::jsonb)) acc
                WHERE acc->>'type' = 'SHOPIFY'
                  AND (acc->'credentials'->>'shopUrl' ILIKE $1 OR acc->'credentials'->>'shopUrl' ILIKE $2)
            )`,
        [shopDomain, bareDomain]
    );
    return rows[0] || null;
};

// 1. Solicitud de datos de un cliente (el comprador pidiÃ³ a la tienda saber quÃ© datos
// tenemos de Ã©l). Shopify no exige devolver los datos en la respuesta HTTP: exige que la
// tienda reciba esos datos por otra vÃ­a dentro de 30 dÃ­as. AquÃ­ dejamos el hallazgo
// registrado con detalle para que el equipo lo pueda entregar a tiempo.
router.post('/shopify/gdpr/customer-data', async (req, res) => {
    const valid = await verifyShopifyWebhookHmac(req);
    if (!valid) {
        console.error('[ShopifyGDPR] customer-data: firma HMAC invÃ¡lida, solicitud rechazada.');
        return res.status(401).send('Invalid HMAC');
    }

    try {
        const { shop_domain, customer, orders_requested } = req.body;
        const client = await findClientByShopDomain(shop_domain);
        if (!client) {
            console.warn(`[ShopifyGDPR] customer-data: no se encontrÃ³ cliente para la tienda ${shop_domain}`);
            return res.status(200).send('OK');
        }

        const orderIds = (orders_requested || []).map(String);
        const { rows: matches } = await db.query(
            `SELECT id, "recipientName", "recipientPhone", "recipientEmail", "recipientAddress", "shopifyOrderId", "createdAt"
             FROM packages
             WHERE "creatorId" = $1
               AND (
                    "shopifyOrderId" = ANY($2::text[])
                 OR "recipientEmail" ILIKE $3
                 OR "recipientPhone" = $4
               )`,
            [client.id, orderIds, customer?.email || '', customer?.phone || '']
        );

        console.log(`[ShopifyGDPR][ACCION REQUERIDA] Solicitud de datos del comprador ${customer?.email || customer?.id} en tienda de "${client.name}" (${shop_domain}). Se encontraron ${matches.length} paquete(s) asociados. Entregar esta informaciÃ³n al comercio dentro del plazo exigido por Shopify.`, matches.map(m => m.id));

        res.status(200).send('OK');
    } catch (err) {
        console.error('[ShopifyGDPR] Error en customer-data:', err);
        res.status(500).send('Error interno');
    }
});

// 2. Solicitud de borrado de datos de un comprador especÃ­fico.
router.post('/shopify/gdpr/customer-redact', async (req, res) => {
    const valid = await verifyShopifyWebhookHmac(req);
    if (!valid) {
        console.error('[ShopifyGDPR] customer-redact: firma HMAC invÃ¡lida, solicitud rechazada.');
        return res.status(401).send('Invalid HMAC');
    }

    try {
        const { shop_domain, customer, orders_to_redact } = req.body;
        const client = await findClientByShopDomain(shop_domain);
        if (!client) {
            console.warn(`[ShopifyGDPR] customer-redact: no se encontrÃ³ cliente para la tienda ${shop_domain}`);
            return res.status(200).send('OK');
        }

        const orderIds = (orders_to_redact || []).map(String);
        const { rows: redacted } = await db.query(
            `UPDATE packages
             SET "recipientName" = 'Comprador eliminado (GDPR)',
                 "recipientPhone" = NULL,
                 "recipientEmail" = NULL,
                 "recipientAddress" = 'Eliminado por solicitud GDPR',
                 "updatedAt" = NOW()
             WHERE "creatorId" = $1
               AND (
                    "shopifyOrderId" = ANY($2::text[])
                 OR "recipientEmail" ILIKE $3
                 OR "recipientPhone" = $4
               )
             RETURNING id`,
            [client.id, orderIds, customer?.email || '', customer?.phone || '']
        );

        console.log(`[ShopifyGDPR] Borrado de comprador ${customer?.email || customer?.id} en tienda de "${client.name}" (${shop_domain}): ${redacted.length} paquete(s) anonimizados.`, redacted.map(r => r.id));

        res.status(200).send('OK');
    } catch (err) {
        console.error('[ShopifyGDPR] Error en customer-redact:', err);
        res.status(500).send('Error interno');
    }
});

// 3. Borrado de datos de una tienda completa (se dispara ~48h despuÃ©s de que el comercio
// desinstala la app). Se elimina la credencial guardada y se anonimizan solo los paquetes
// que vinieron de Shopify para ese cliente â€” no se toca su cuenta ni sus otros canales
// (Meli, Falabella, etc.), ya que la app no fue desinstalada de esos.
router.post('/shopify/gdpr/shop-redact', async (req, res) => {
    const valid = await verifyShopifyWebhookHmac(req);
    if (!valid) {
        console.error('[ShopifyGDPR] shop-redact: firma HMAC invÃ¡lida, solicitud rechazada.');
        return res.status(401).send('Invalid HMAC');
    }

    try {
        const { shop_domain } = req.body;
        const client = await findClientByShopDomain(shop_domain);
        if (!client) {
            console.warn(`[ShopifyGDPR] shop-redact: no se encontrÃ³ cliente para la tienda ${shop_domain}`);
            return res.status(200).send('OK');
        }

        const { rows: redacted } = await db.query(
            `UPDATE packages
             SET "recipientName" = 'Comprador eliminado (GDPR)',
                 "recipientPhone" = NULL,
                 "recipientEmail" = NULL,
                 "recipientAddress" = 'Eliminado por solicitud GDPR',
                 "updatedAt" = NOW()
             WHERE "creatorId" = $1 AND "shopifyOrderId" IS NOT NULL
             RETURNING id`,
            [client.id]
        );

        let integrations = client.integrations || {};
        if (integrations.shopify) delete integrations.shopify;
        if (Array.isArray(integrations.accounts)) {
            integrations.accounts = integrations.accounts.filter(acc => acc.type !== 'SHOPIFY');
        }
        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), client.id]);

        console.log(`[ShopifyGDPR] Tienda ${shop_domain} desinstalada. Cliente "${client.name}": credencial eliminada, ${redacted.length} paquete(s) anonimizados.`, redacted.map(r => r.id));

        res.status(200).send('OK');
    } catch (err) {
        console.error('[ShopifyGDPR] Error en shop-redact:', err);
        res.status(500).send('Error interno');
    }
});

// POST /api/integrations/sync-shipment/:id
// This route attempts to find and import a single shipment from ML by its ID
router.post('/sync-shipment/:id', authMiddleware, async (req, res) => {
    const shipmentId = req.params.id;
    
    try {
        // 1. Search in ML across all clients that have ML integration
        // We prioritize ML search as requested: "LA HERRAMIENTA DEBE BUSCAR EL ENVIO EN ml Y NO EN EL SISTEMA"
        const { rows: clients } = await db.query(
            "SELECT id, integrations, \"clientIdentifier\" FROM users WHERE role = 'CLIENT' AND (integrations->'meli' IS NOT NULL OR integrations->'accounts' IS NOT NULL)"
        );

        if (clients.length === 0) {
            return res.status(404).json({ message: 'No hay clientes con integraciÃ³n de Mercado Libre configurada.' });
        }

        let foundShipment = null;
        let clientUsed = null;
        let accountUsed = null;

        // Try each client until we find the shipment in ML
        for (const client of clients) {
            const integrations = ensureMultiAccountStructure(client.integrations);
            const meliAccounts = integrations.accounts.filter(acc => acc.type === 'MERCADO_LIBRE');

            for (const account of meliAccounts) {
                try {
                    const meliIntegration = await getValidMeliIntegration(client.id, account.id);
                    const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, meliIntegration.accessToken);
                    
                    if (shipment && shipment.id) {
                        // Verify that the shipment's seller matches the account's Meli User ID
                        const sellerId = shipment.sender_id?.toString() || meliIntegration.userId;
                        if (sellerId !== meliIntegration.userId.toString()) {
                            console.warn(`[SyncShipment] Seller mismatch for client ${client.id} account ${account.id} (Expected ${meliIntegration.userId}, got ${sellerId})`);
                            continue;
                        }
                        foundShipment = shipment;
                        clientUsed = client;
                        accountUsed = account;
                        break;
                    }
                } catch (err) {
                    continue;
                }
            }
            if (foundShipment) break;
        }

        if (!foundShipment) {
            return res.status(404).json({ message: 'No se encontrÃ³ el envÃ­o en Mercado Libre con ninguna de las cuentas conectadas.' });
        }

        // 2. Check if it already exists locally to return the full local record if available
        const { rows: existingRows } = await db.query(
            'SELECT * FROM packages WHERE "meliFlexCode" = $1 OR "meliOrderId" = $2',
            [foundShipment.id.toString(), foundShipment.order_id?.toString()]
        );
        
        if (existingRows.length > 0) {
            // Return the local record which has more system-specific info (driver, zone, etc.)
            return res.json(existingRows[0]);
        }

        // 3. If not found locally, check if it's a Flex shipment to import it
        // logistic_type 'self_service' is Flex
        if (foundShipment.logistic_type !== 'self_service') {
            // If it's not Flex, we just return a "virtual" object for the UI to display
            return res.json({
                id: `ML-${foundShipment.id}`,
                recipientName: foundShipment.receiver_address?.receiver_name || 'N/A',
                status: foundShipment.status.toUpperCase(),
                recipientAddress: foundShipment.receiver_address?.address_line || 'N/A',
                recipientCommune: foundShipment.receiver_address?.city?.name || 'N/A',
                updatedAt: new Date().toISOString(),
                notes: `ML ID: ${foundShipment.id} (No es FLEX - ${foundShipment.logistic_type})`,
                isFlex: false,
                source: 'MERCADO_LIBRE'
            });
        }

        // It is FLEX and not in our system, let's import it automatically
        const now = new Date();
        const newPackage = {
            id: `${clientUsed.clientIdentifier}-${uuidv4().split('-')[0]}`,
            recipientName: foundShipment.receiver_address?.receiver_name || 'N/A',
            recipientPhone: foundShipment.receiver_address?.receiver_phone || 'N/A',
            status: 'PENDIENTE',
            shippingType: 'SAME_DAY',
            origin: 'Centro de DistribuciÃ³n',
            recipientAddress: foundShipment.receiver_address?.address_line || 'N/A',
            recipientCommune: foundShipment.receiver_address?.city?.name || 'N/A',
            recipientCity: foundShipment.receiver_address?.state?.name || 'Santiago',
            notes: `ML ID: ${foundShipment.id}`,
            estimatedDelivery: now,
            createdAt: now,
            updatedAt: now,
            creatorId: clientUsed.id,
            meliOrderId: foundShipment.order_id?.toString(),
            meliFlexCode: foundShipment.id?.toString(),
            meliSellerId: foundShipment.sender_id?.toString() || (accountUsed?.credentials?.userId?.toString()),
            sourceAccountId: accountUsed?.id,
            isFlex: true,
            source: 'MERCADO_LIBRE'
        };

        const query = `
            INSERT INTO packages (
                id, "recipientName", "recipientPhone", status, "shippingType", origin, 
                "recipientAddress", "recipientCommune", "recipientCity", notes, 
                "estimatedDelivery", "createdAt", "updatedAt", "creatorId", 
                "meliOrderId", "meliFlexCode", "meliSellerId", "sourceAccountId", "isFlex", source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
            RETURNING *
        `;
        const values = [
            newPackage.id, newPackage.recipientName, newPackage.recipientPhone, newPackage.status,
            newPackage.shippingType, newPackage.origin, newPackage.recipientAddress,
            newPackage.recipientCommune, newPackage.recipientCity, newPackage.notes,
            newPackage.estimatedDelivery, newPackage.createdAt, newPackage.updatedAt,
            newPackage.creatorId, newPackage.meliOrderId, newPackage.meliFlexCode, 
            newPackage.meliSellerId, newPackage.sourceAccountId, newPackage.isFlex,
            newPackage.source
        ];

        const { rows: insertedRows } = await db.query(query, values);
        
        // Add tracking event
        await db.query(
            'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [insertedRows[0].id, 'Creado', 'Centro de DistribuciÃ³n', 'Sincronizado manualmente desde Mercado Libre.', now]
        );

        res.json(insertedRows[0]);

    } catch (err) {
        console.error("Sync Shipment Error:", err);
        res.status(500).json({ message: 'Error interno al sincronizar el envÃ­o.' });
    }
});

// --- NUEVO FLUJO OAUTH SHOPIFY 2026 ---

// GET /api/integrations/shopify/install
// Inicia el flujo OAuth redirigiendo a la tienda Shopify con el Client ID global.
router.get('/shopify/install', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const { shop } = req.query; // e.g. "mi-tienda.myshopify.com"

    if (!shop) {
        return res.status(400).json({ message: 'El parÃ¡metro "shop" es obligatorio. Debe ser el dominio de tu tienda Shopify.' });
    }

    try {
        const { rows: settingsRows } = await db.query('SELECT shopify_client_id FROM integration_settings WHERE id = 1');
        if (settingsRows.length === 0 || !settingsRows[0].shopify_client_id) {
            return res.status(500).json({ message: 'Error: El administrador de Full Envios debe configurar el Client ID de Shopify primero.' });
        }
        
        const clientId = settingsRows[0].shopify_client_id;
        const scopes = 'read_orders,write_orders,read_customers,read_fulfillments,write_fulfillments';
        const host = req.get('host');
        
        // Determinar el protocolo dinÃ¡micamente: localhost permite http, servidores reales exigen https
        const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
        const redirectUri = encodeURIComponent(`${protocol}://${host}/api/integrations/shopify/callback`);
        const formattedShop = shop.replace(/^https?:\/\//, '').split('/')[0].trim();

        // Security: include userId securely in the state to assign the final token strictly to them
        const state = encodeURIComponent(userId);
        
        const installUrl = `https://${formattedShop}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${redirectUri}&state=${state}`;
        res.redirect(installUrl);
    } catch (err) {
        console.error("Shopify Install Error:", err);
        res.status(500).json({ message: 'Error interno del servidor al iniciar la instalaciÃ³n de Shopify.' });
    }
});

// GET /api/integrations/shopify/callback
// Endpoit que recibe el 'code' de Shopify, lo intercambia por el shpat_ token offline y lo guarda en la base de datos del usuario.
router.get('/shopify/callback', async (req, res) => {
    const { code, shop, state: userId, hmac } = req.query;

    if (!code || !shop || !userId) {
        return res.status(400).send('Faltan parÃ¡metros obligatorios en la respuesta de Shopify.');
    }

    try {
        const { rows: settingsRows } = await db.query('SELECT shopify_client_id, shopify_client_secret FROM integration_settings WHERE id = 1');
        if (settingsRows.length === 0 || !settingsRows[0].shopify_client_id || !settingsRows[0].shopify_client_secret) {
            return res.status(500).send('ConfiguraciÃ³n global de Shopify faltante.');
        }

        const clientId = settingsRows[0].shopify_client_id;
        const clientSecret = settingsRows[0].shopify_client_secret;

        const postData = JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code: code
        });

        const options = {
            hostname: shop,
            path: '/admin/oauth/access_token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const reqApi = require('https').request(options, (resApi) => {
            let data = '';
            resApi.on('data', (chunk) => { data += chunk; });
            resApi.on('end', async () => {
                try {
                    const response = JSON.parse(data);
                    
                    if (resApi.statusCode >= 200 && resApi.statusCode < 300 && response.access_token) {
                        const accessToken = response.access_token;
                        
                        // Guardar en la base de datos del usuario especÃ­fico (userId = state)
                        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [userId]);
                        if (userRows.length === 0) {
                            return res.status(404).send('Usuario propietario no encontrado.');
                        }
                        
                        const currentIntegrations = userRows[0].integrations || {};
                        const integrations = ensureMultiAccountStructure(currentIntegrations);
                        
                        const shopifyAccount = {
                            id: `shopify-${uuidv4()}`,
                            type: 'SHOPIFY',
                            nickname: `Shopify (${shop})`,
                            credentials: {
                                shopUrl: shop,
                                accessToken: accessToken
                            },
                            settings: {
                                autoImport: false,
                                syncInterval: 5
                            },
                            connectedAt: new Date().toISOString()
                        };

                        // Check if this specific shop is already connected
                        const existingIndex = integrations.accounts.findIndex(acc => acc.type === 'SHOPIFY' && acc.credentials.shopUrl === shop);
                        if (existingIndex > -1) {
                            integrations.accounts[existingIndex] = shopifyAccount;
                        } else {
                            integrations.accounts.push(shopifyAccount);
                        }

                        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [
                            JSON.stringify(integrations),
                            userId
                        ]);

                        // Redirect back to frontend
                        return res.send(`
                            <html>
                                <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f3f4f6;">
                                    <div style="background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); text-align: center;">
                                        <h2 style="color: #059669;">Â¡Tienda Conectada Correctamente!</h2>
                                        <p>Se ha configurado la aplicaciÃ³n Full Envios en <strong>${shop}</strong> y obtenido el token seguro.</p>
                                        <p>Ya puedes cerrar esta ventana y regresar a tu panel.</p>
                                        <button onclick="window.close()" style="margin-top: 15px; padding: 10px 20px; background-color: #10b981; color: white; border: none; border-radius: 5px; cursor: pointer;">Cerrar Ventana</button>
                                    </div>
                                    <script>setTimeout(() => window.close(), 5000);</script>
                                </body>
                            </html>
                        `);
                    } else {
                        return res.status(400).send(`Error de AutenticaciÃ³n con Shopify: ${JSON.stringify(response)}`);
                    }
                } catch (e) {
                    return res.status(500).send('Respuesta invÃ¡lida de Shopify durante el intercambio de token.');
                }
            });
        });

        reqApi.on('error', (e) => {
            console.error("Shopify OAuth Connection Error:", e);
            return res.status(500).send(`Error de red al conectar con Shopify: ${e.message}`);
        });

        reqApi.write(postData);
        reqApi.end();

    } catch (err) {
        console.error("Shopify Callback Root Error:", err);
        res.status(500).send('Error interno guardando las credenciales de Shopify.');
    }
});


// --- JUMPSELLER API HELPERS ---
const makeJumpsellerRequest = (login, token, path, method = 'GET', postData = null) => {
    return new Promise((resolve, reject) => {
        if (!login) return reject(new Error('El Login de Jumpseller es requerido.'));
        if (!token) return reject(new Error('El API Token de Jumpseller es requerido.'));

        const url = new URL(`https://api.jumpseller.com/v1${path}`);
        url.searchParams.append('login', login);
        url.searchParams.append('authtoken', token);

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsedData);
                    } else {
                        reject({ statusCode: res.statusCode, body: parsedData });
                    }
                } catch (e) {
                    reject({ statusCode: res.statusCode, body: data, isRaw: true });
                }
            });
        });
        req.on('error', (e) => reject(e));
        if (postData) req.write(JSON.stringify(postData));
        req.end();
    });
};

// POST /api/integrations/test/jumpseller - Test Jumpseller connection
router.post('/test/jumpseller', authMiddleware, async (req, res) => {
    const { jumpsellerLogin, jumpsellerToken } = req.body;
    try {
        const response = await makeJumpsellerRequest(jumpsellerLogin, jumpsellerToken, '/store/info.json');
        res.json({ message: `ConexiÃ³n exitosa con tienda: ${response.store?.name || 'Jumpseller'}` });
    } catch (err) {
        console.error("Jumpseller Test Error:", err.body || err);
        res.status(err.statusCode || 500).json({ message: 'Error de conexiÃ³n con Jumpseller. Verifica tus credenciales.', error: err.body || err.message });
    }
});

// GET /api/integrations/:clientId/jumpseller/orders - Fetch orders from Jumpseller
router.get('/:clientId/jumpseller/orders', authMiddleware, async (req, res) => {
    const { clientId } = req.params;

    if (req.user.role !== 'ADMIN' && req.user.id !== clientId) {
        return res.status(403).json({ message: 'No tienes permiso para ver estos pedidos.' });
    }

    try {
        const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).json({ message: 'Cliente no encontrado.' });
        
        const integrations = ensureMultiAccountStructure(userRows[0].integrations || {});
        const jumpAccounts = integrations.accounts.filter(acc => acc.type === 'JUMPSELLER');

        if (jumpAccounts.length === 0) {
            try {
                const legacyJump = await getValidJumpsellerIntegration(clientId);
                if (legacyJump) {
                    jumpAccounts.push({
                        id: 'legacy-jump',
                        nickname: 'Jumpseller (Principal)',
                        credentials: legacyJump
                    });
                }
            } catch (e) {
                return res.json([]);
            }
        }

        let allOrders = [];
        for (const account of jumpAccounts) {
            try {
                // Fetch recent orders (Ready or Paid)
                const orders = await makeJumpsellerRequest(account.credentials.login, account.credentials.token, '/orders.json?status=all&limit=50');
                
                if (orders && Array.isArray(orders)) {
                    const mapped = orders
                        .filter(o => o.order.status === 'Paid' || o.order.status === 'Ready')
                        .map(o => {
                            const order = o.order;
                            const shipping = order.shipping_address || {};
                            const customer = order.customer || {};
                            
                            return {
                                id: order.id.toString(),
                                recipientName: shipping.fullname || customer.fullname || 'N/A',
                                address: shipping.address || 'N/A',
                                commune: normalizeCommune(shipping.municipality || 'N/A'),
                                city: shipping.city || 'N/A',
                                notes: `Jump Order: ${order.id} (${account.nickname})`,
                                shipmentId: order.id.toString(),
                                sourceAccountId: account.id,
                                sourceAccountName: account.nickname
                            };
                        });
                    allOrders = [...allOrders, ...mapped];
                }
            } catch (err) {
                console.error(`Error fetching Jumpseller orders for ${account.nickname}:`, err.message);
            }
        }

        res.json(allOrders);
    } catch (err) {
        console.error("Jumpseller Fetch Orders Error:", err.body || err);
        res.status(500).json({ message: err.message || 'Error al obtener pedidos de Jumpseller.' });
    }
});



// POST /api/integrations/jumpseller/webhook - Handle Jumpseller webhooks (e.g., order_paid)
router.post('/jumpseller/webhook', async (req, res) => {
    const orderData = req.body;
    const order = orderData.order || orderData;
    if (!order || !order.id) return res.status(400).send('Invalid webhook data');
    if (order.status !== 'Paid' && order.status !== 'Ready') return res.status(200).send('Order status not eligible');

    try {
        const { clientId } = req.query;
        const { rows: userRows } = await db.query('SELECT id, "clientIdentifier", address, "pickupAddress", integrations FROM users WHERE id = $1', [clientId]);
        if (userRows.length === 0) return res.status(404).send('Client not found');
        const client = userRows[0];

        let sourceAccountId = null;
        let sourceAccountName = null;
        if (client.integrations && client.integrations.accounts) {
            const jumpsellerAcc = client.integrations.accounts.find(a => a.type === 'JUMPSELLER');
            if (jumpsellerAcc) {
                sourceAccountId = jumpsellerAcc.id;
                sourceAccountName = jumpsellerAcc.nickname;
            }
        }

        const shipping = order.shipping_address || {};
        const now = new Date();
        const packageId = `${client.clientIdentifier}-${uuidv4().split('-')[0]}`;
        const origin = client.pickupAddress || client.address || 'Centro de Distribución';

        const newPackage = {
            id: packageId,
            recipientName: shipping.fullname || order.customer?.fullname || 'N/A',
            recipientPhone: shipping.phone || order.customer?.phone || 'N/A',
            recipientEmail: order.customer?.email || '',
            status: 'PENDIENTE',
            shippingType: 'SAME_DAY',
            origin: origin,
            destination: shipping.address || 'N/A',
            recipientAddress: shipping.address || 'N/A',
            recipientCommune: shipping.municipality || 'N/A',
            recipientCity: shipping.city || 'Santiago',
            notes: `Auto-Import Jumpseller Order: ${order.id}`,
            estimatedDelivery: now,
            createdAt: now,
            updatedAt: now,
            creatorId: clientId,
            source: 'JUMPSELLER',
            jumpsellerOrderId: order.id.toString(),
            sourceAccountId,
            sourceAccountName
        };

        const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
        const values = Object.values(newPackage);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
        await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', [packageId, 'Creado', origin, 'Auto-importado vía Webhook.', now]);
        res.status(200).send('OK');
    } catch (err) {
        console.error('[JumpsellerWebhook] Error:', err);
        res.status(500).send('Error');
    }
});



// POST /api/integrations/accounts - Link a new account manually (Jumpseller, Falabella, WooCommerce)
router.post('/accounts', authMiddleware, async (req, res) => {
    const userId = req.user.id;
    const { type, nickname, credentials } = req.body;

    if (!type || !credentials) {
        return res.status(400).json({ message: 'Tipo de cuenta y credenciales son obligatorios.' });
    }

    try {
        const { rows } = await db.query('SELECT integrations FROM users WHERE id = $1', [userId]);
        if (rows.length === 0) return res.status(404).json({ message: 'Usuario no encontrado.' });

        let integrations = ensureMultiAccountStructure(rows[0].integrations);

        let identifier = '';
        if (type === 'JUMPSELLER') identifier = credentials.shopUrl || credentials.login;
        if (type === 'FALABELLA') identifier = credentials.falabellaSellerId;
        if (type === 'WOOCOMMERCE') identifier = credentials.wooUrl;

        const existing = integrations.accounts.find(acc => acc.type === type && (
            (type === 'JUMPSELLER' && (acc.credentials.shopUrl === identifier || acc.credentials.login === identifier)) ||
            (type === 'FALABELLA' && acc.credentials.falabellaSellerId === identifier) ||
            (type === 'WOOCOMMERCE' && acc.credentials.wooUrl === identifier)
        ));

        if (existing) {
            return res.status(400).json({ message: 'Esta cuenta ya está vinculada a tu perfil.' });
        }

        // Only Shopify's shape is touched here — this endpoint is shared with Jumpseller/
        // Falabella/WooCommerce, which have different credential fields entirely.
        const storedCredentials = (type === 'SHOPIFY' && credentials.accessToken)
            ? { ...credentials, accessToken: encrypt(credentials.accessToken) }
            : credentials;

        const newAccount = {
            id: `${type.toLowerCase()}-${uuidv4()}`,
            type: type,
            nickname: nickname || `${type} Account`,
            credentials: storedCredentials,
            settings: {
                autoImport: true,
                // Was 30 — the same stale legacy default found and fixed for Meli accounts
                // earlier: nothing in the actual polling cycles runs faster than 5 minutes
                // anyway, so a per-account interval above that only makes checks less frequent
                // than the schedule already allows, never more.
                syncInterval: 5
            },
            connectedAt: new Date().toISOString(),
            status: 'CONNECTED'
        };

        integrations.accounts.push(newAccount);

        await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), userId]);

        res.status(201).json(newAccount);
    } catch (err) {
        console.error("Create Integration Account Error:", err);
        res.status(500).json({ message: 'Error interno al crear la cuenta de integración.' });
    }
});

module.exports = router;
