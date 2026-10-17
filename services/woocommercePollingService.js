const db = require('../db');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { normalizeCommune, normalizeCity, checkOrderCommune } = require('../utils/normUtil');
const { triggerBackgroundGeocoding } = require('./geocodingService');

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

        // Set 15s timeout
        req.setTimeout(15000, () => {
            req.destroy();
            reject(new Error('WooCommerce API request timed out after 15s'));
        });

        req.on('error', (e) => reject(e));
        if (postData) req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
        req.end();
    });
};

let isPolling = false;
let pollingStartTime = null;
let lastPollTime = Date.now();
let currentIntervalMs = 5 * 60 * 1000;
let nextScheduledTime = lastPollTime + currentIntervalMs;
let lastImportCount = 0;

async function pollWooCommercePackages() {
    if (isPolling) {
        console.log('[WooCommercePolling] Already polling, skipping...');
        return;
    }
    isPolling = true;
    pollingStartTime = Date.now();
    lastPollTime = Date.now();
    console.log('[WooCommercePolling] Starting poll cycle...');
    try {
        let autoImportEnabled = false;
        try {
            const { rows: settingsRows } = await db.query('SELECT "woocommerceAutoImport" FROM system_settings WHERE id = 1');
            autoImportEnabled = settingsRows.length > 0 && settingsRows[0].woocommerceAutoImport;
        } catch (settingsErr) {
            console.warn('[WooCommercePolling] Could not fetch woocommerceAutoImport from DB. Defaulting to true for active customers.');
            autoImportEnabled = true; 
        }

        if (autoImportEnabled) {
            const { rows: activeRows } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
            const activeCommunes = activeRows.map(r => normalizeCommune(r.name).toLowerCase());
            
            await autoImportWooCommercePackages(activeCommunes);
        }
    } catch (err) {
        console.error('[WooCommercePolling] Fatal error in poll cycle:', err);
    } finally {
        isPolling = false;
        pollingStartTime = null;
        nextScheduledTime = Date.now() + currentIntervalMs;
        if (timeoutId !== null) {
            timeoutId = setTimeout(pollWooCommercePackages, currentIntervalMs);
        }
    }
}

const ensureMultiAccountStructure = (integrations) => {
    if (!integrations) integrations = { accounts: [] };
    if (!integrations.accounts) {
        integrations.accounts = [];
    }
    const hasWoo = integrations.accounts.some(acc => acc.type === 'WOOCOMMERCE');
    if (!hasWoo && integrations.woocommerce) {
        integrations.accounts.push({
            id: `woocommerce-legacy`,
            type: 'WOOCOMMERCE',
            nickname: 'WooCommerce (Principal)',
            credentials: {
                wooUrl: integrations.woocommerce.wooUrl || integrations.woocommerce.storeUrl,
                wooConsumerKey: integrations.woocommerce.wooConsumerKey || integrations.woocommerce.consumerKey,
                wooConsumerSecret: integrations.woocommerce.wooConsumerSecret || integrations.woocommerce.consumerSecret
            },
            settings: { 
                autoImport: integrations.woocommerce.autoImport || false, 
                syncInterval: integrations.woocommerce.syncInterval || 15,
                lastSync: integrations.woocommerce.lastSync
            },
            connectedAt: integrations.woocommerce.connectedAt || new Date().toISOString()
        });
    }
    return integrations;
};

async function autoImportWooCommercePackages(activeCommunes = []) {
    console.log('[WooCommercePolling] Starting WooCommerce auto-import cycle...');
    
    const fallbackRM = [
        'santiago', 'cerrillos', 'cerro navia', 'conchali', 'el bosque', 'estacion central', 
        'huechuraba', 'independencia', 'la cisterna', 'la florida', 'la granja', 'la pintana', 
        'la reina', 'las condes', 'lo barnechea', 'lo espejo', 'lo prado', 'macul', 'maipu', 
        'ñuñoa', 'pedro aguirre cerda', 'peñalolen', 'providencia', 'pudahuel', 'quilicura', 
        'quinta normal', 'recoleta', 'renca', 'san joaquin', 'san miguel', 'san ramon', 
        'vitacura', 'puente alto', 'pirque', 'san jose de maipo', 'colina', 'lampa', 'tiltil', 
        'san bernardo', 'buin', 'calera de tango', 'paine', 'melipilla', 'alhue', 'curacavi', 
        'maria pinto', 'san pedro', 'talagante', 'el monte', 'isla de maipo', 'padre hurtado', 'peñaflor'
    ];
    
    const validCommunes = activeCommunes.length > 0 ? activeCommunes : fallbackRM;
    let importedThisCycle = 0;

    try {
        const { rows: users } = await db.query(`
            SELECT id, integrations, "clientIdentifier" 
            FROM users 
            WHERE role = 'CLIENT' 
            AND (integrations->'woocommerce' IS NOT NULL OR integrations->'accounts' IS NOT NULL)
        `);
        
        for (const user of users) {
            const clientId = user.id;
            const clientIdentifier = user.clientIdentifier || 'CLI';
            
            let integrations = ensureMultiAccountStructure(user.integrations);
            const wooAccounts = integrations.accounts.filter(acc => acc.type === 'WOOCOMMERCE');

            if (wooAccounts.length === 0) continue;

            for (const account of wooAccounts) {
                try {
                    const woo = account.credentials;
                    const settings = account.settings || {};

                    if (!woo.wooUrl || !woo.wooConsumerKey || !woo.wooConsumerSecret) continue;
                    if (settings.autoImport !== true) continue;

                    const syncIntervalMin = settings.syncInterval !== undefined ? settings.syncInterval : 15; 
                    const lastSync = settings.lastSync ? new Date(settings.lastSync).getTime() : 0;
                    const now = Date.now();
                    
                    if (now - lastSync < (syncIntervalMin * 60 * 1000)) continue;

                    // Timeout of 45 sec per account
                    await Promise.race([
                        (async () => {
                            // Update lastSync for this account
                            const accountIndex = integrations.accounts.findIndex(acc => acc.id === account.id);
                            if (accountIndex > -1) {
                                integrations.accounts[accountIndex].settings.lastSync = new Date().toISOString();
                                await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
                            }

                            // Fetch orders with status "processing" and "completed"
                            const ordersData = await makeWooCommerceRequest(
                                woo.wooUrl, 
                                woo.wooConsumerKey, 
                                woo.wooConsumerSecret, 
                                '/orders?status=processing,completed&per_page=50'
                            );
                            
                            if (!ordersData || !Array.isArray(ordersData) || ordersData.length === 0) return;

                            console.log(`[WooCommercePolling] Found ${ordersData.length} orders (processing/completed) for client ${clientId} (${account.nickname})`);

                            for (const order of ordersData) {
                                try {
                                    const orderId = order.id.toString();
                                    
                                    // Evitar importar órdenes creadas antes de la vinculación de la cuenta
                                    const orderDateStr = order.date_created_gmt ? order.date_created_gmt + 'Z' : order.date_created;
                                    const orderDate = new Date(orderDateStr);
                                    const connectionDate = new Date(account.connectedAt || 0);
                                    const buffer = 2 * 60 * 60 * 1000; // 2 horas de buffer
                                    if (orderDate.getTime() < (connectionDate.getTime() - buffer)) {
                                        continue;
                                    }

                                    const { rows: existing } = await db.query('SELECT id FROM packages WHERE "wooOrderId" = $1 OR "id" = $2', [orderId, orderId]);
                                    if (existing.length > 0) continue;

                                    const address = order.shipping || order.billing || {};
                                    const billing = order.billing || {};
                                    
                                    const city = (address.city || '').toLowerCase();
                                    const state = (address.state || '').toLowerCase();

                                    // Comuna reconocida y NO habilitada en el setup → el pedido no entra (antes solo se revisaba la
                                    // región y entraba cualquier comuna de la RM, también las que el setup tiene desactivadas). Si el
                                    // texto no identifica ninguna comuna ("Región Metropolitana", vacío...) se mantiene el criterio de
                                    // región de más abajo.
                                    const zone = checkOrderCommune([address.city, billing.city], validCommunes, { strict: false });
                                    if (!zone.allow) {
                                        console.log(`[WooCommercePolling] Skipping order ${order.number || orderId} - comuna "${zone.commune}" NO habilitada (${account.nickname}).`);
                                        continue;
                                    }
                                    
                                    const isRM = state.includes('metropolitana') || 
                                                 state.includes('santiago') || 
                                                 state.includes('rm') ||
                                                 state.includes('r.m.') ||
                                                 city.includes('santiago') ||
                                                 city.includes('metropolitana') ||
                                                 city.includes('rm') ||
                                                 validCommunes.includes(city);
                                    
                                    if (!isRM) continue;

                                    const nowImport = new Date();
                                    const newPackage = {
                                        id: `${clientIdentifier}-${uuidv4().split('-')[0]}`,
                                        recipientName: `${address.first_name || ''} ${address.last_name || ''}`.trim() || `${billing.first_name || ''} ${billing.last_name || ''}`.trim() || 'N/A',
                                        recipientPhone: billing.phone || 'N/A',
                                        recipientEmail: billing.email || '',
                                        status: 'PENDIENTE',
                                        shippingType: 'SAME_DAY',
                                        origin: 'Centro de Distribución',
                                        recipientAddress: `${address.address_1 || ''} ${address.address_2 || ''}`.trim() || billing.address_1 || 'N/A',
                                        recipientCommune: zone.commune || normalizeCommune(address.city || billing.city || 'N/A'),
                                        recipientCity: normalizeCity('Región Metropolitana'),
                                        notes: `Auto-Import WooCommerce Order: ${order.number || orderId}`,
                                        estimatedDelivery: nowImport,
                                        createdAt: nowImport,
                                        updatedAt: nowImport,
                                        creatorId: clientId,
                                        source: 'WOOCOMMERCE',
                                        wooOrderId: orderId,
                                        sourceAccountId: account.id,
                                        sourceAccountName: account.nickname
                                    };

                                    const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
                                    const values = Object.values(newPackage).map(v => v === undefined ? null : v);
                                    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

                                    await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders}) ON CONFLICT ("wooOrderId") DO NOTHING`, values);
                                    await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
                                        [newPackage.id, 'Creado', newPackage.origin, `Auto-importado vía WooCommerce (${account.nickname}).`, nowImport]);
                                    
                                    importedThisCycle++;
                                } catch (orderErr) {
                                    // Ignore individual order error
                                }
                            }
                        })(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_ACCOUNT')), 45000))
                    ]);
                } catch (apiErr) {
                    if (apiErr.message === 'TIMEOUT_ACCOUNT') {
                        console.error(`[WooCommercePolling] Polling timed out after 45s for account ${account.nickname} (${clientId})`);
                    } else {
                        console.error(`[WooCommercePolling] Error fetching WooCommerce orders for ${account.nickname}:`, apiErr.body || apiErr.message || apiErr);
                    }
                }
            }
        }
        setTimeout(() => triggerBackgroundGeocoding(), 2000);
    } catch (err) {
        console.error('[WooCommercePolling] Fatal error in auto-import cycle:', err);
    } finally {
        lastImportCount = importedThisCycle;
    }
}

let timeoutId = null;

function start(intervalMs = 5 * 60 * 1000, delayMs = 0) { 
    if (timeoutId !== null) return;
    currentIntervalMs = intervalMs;
    nextScheduledTime = Date.now() + delayMs;
    
    console.log(`[WooCommercePolling] Service starting (Interval: ${intervalMs/1000/60} min, Initial Delay: ${delayMs/1000}s)`);
    
    timeoutId = setTimeout(pollWooCommercePackages, delayMs);
}

function stop() {
    if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}

function getStatus() {
    // Dead Man's Switch: if polling for > 15 mins, force reset
    if (isPolling && pollingStartTime && (Date.now() - pollingStartTime > 15 * 60 * 1000)) {
        console.warn('[WooCommercePolling] Polling cycle took too long (>15m), triggering emergency reset.');
        isPolling = false;
        pollingStartTime = null;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(pollWooCommercePackages, currentIntervalMs);
        }
    }

    return {
        isPolling,
        pollingStartTime,
        lastPollTime,
        nextPollTime: nextScheduledTime,
        lastImportCount
    };
}

const triggerSync = async () => {
    await pollWooCommercePackages();
};

module.exports = { start, stop, pollWooCommercePackages, getStatus, triggerSync };
