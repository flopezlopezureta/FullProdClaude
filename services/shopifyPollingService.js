const db = require('../db');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { normalizeCommune, normalizeCity } = require('../utils/normUtil');
const { triggerBackgroundGeocoding } = require('./geocodingService');
const { decrypt } = require('./falabellaCrypto');

// --- SHOPIFY API HELPERS ---
const makeShopifyRequest = (shopUrl, accessToken, path, method = 'GET', postData = null) => {
    return new Promise((resolve, reject) => {
        if (!shopUrl) return reject(new Error('La URL de la tienda es requerida.'));
        if (!accessToken) return reject(new Error('El Access Token de Shopify es requerido.'));

        // Extract only the hostname
        let hostname = shopUrl.trim().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

        // Basic validation and correction
        if (hostname && !hostname.includes('.')) {
            hostname += '.myshopify.com';
        } else if (hostname && hostname.endsWith('.shopify.com')) {
            hostname = hostname.replace('.shopify.com', '.myshopify.com');
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
           reject(new Error('Shopify API request timed out after 15s'));
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

async function pollShopifyPackages() {
    if (isPolling) {
        console.log('[ShopifyPolling] Already polling, skipping...');
        return;
    }
    isPolling = true;
    pollingStartTime = Date.now();
    lastPollTime = Date.now();
    console.log('[ShopifyPolling] Starting poll cycle...');
    try {
        // 0. Check if auto-import is enabled (similar to Meli)
        let autoImportEnabled = false;
        try {
            const { rows: settingsRows } = await db.query('SELECT "shopifyAutoImport" FROM system_settings WHERE id = 1');
            autoImportEnabled = settingsRows.length > 0 && settingsRows[0].shopifyAutoImport;
        } catch (settingsErr) {
            // If column doesn't exist yet, we can't decide, but based on user request "hazlo", we assume true for now if missing
            console.warn('[ShopifyPolling] Could not fetch shopifyAutoImport from DB. Defaulting to true for active customers.');
            autoImportEnabled = true; 
        }

        // We'll proceed if enabled
        if (autoImportEnabled) {
            // Fetch active communes once per cycle
            const { rows: activeRows } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
            const activeCommunes = activeRows.map(r => normalizeCommune(r.name).toLowerCase());
            
            await autoImportShopifyPackages(activeCommunes);
        }

    } catch (err) {
        console.error('[ShopifyPolling] Fatal error in poll cycle:', err);
    } finally {
        isPolling = false;
        pollingStartTime = null;
        nextScheduledTime = Date.now() + currentIntervalMs;
        if (timeoutId !== null) {
            timeoutId = setTimeout(pollShopifyPackages, currentIntervalMs);
        }
    }
}

const ensureMultiAccountStructure = (integrations) => {
    if (!integrations) integrations = { accounts: [] };
    if (!integrations.accounts) {
        const accounts = [];
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
        integrations.accounts = accounts;
    }
    return integrations;
};

async function autoImportShopifyPackages(activeCommunes = []) {
    console.log('[ShopifyPolling] Starting auto-import cycle...');
    
    // Fallback RM list if none configured
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
        // 1. Get all users with Shopify integration (new or old format)
        const { rows: users } = await db.query(`
            SELECT id, integrations, "clientIdentifier" 
            FROM users 
            WHERE role = 'CLIENT' 
            AND (integrations->'shopify' IS NOT NULL OR integrations->'accounts' IS NOT NULL)
        `);
        
        for (const user of users) {
            const clientId = user.id;
            const clientIdentifier = user.clientIdentifier || 'CLI';
            
            let integrations = ensureMultiAccountStructure(user.integrations);
            const shopifyAccounts = integrations.accounts.filter(acc => acc.type === 'SHOPIFY');

            if (shopifyAccounts.length === 0) continue;

            for (const account of shopifyAccounts) {
                try {
                    const shopify = account.credentials;
                    const settings = account.settings || {};

                    if (!shopify.shopUrl || !shopify.accessToken) continue;
                    // Same safe decrypt() as routes/integrations.js — a no-op on tokens saved
                    // before encryption was added, so nothing breaks for existing connections.
                    shopify.accessToken = decrypt(shopify.accessToken);
                    if (settings.autoImport !== true) continue;

                    const syncIntervalMin = settings.syncInterval !== undefined ? settings.syncInterval : 2; 
                    const lastSync = settings.lastSync ? new Date(settings.lastSync).getTime() : 0;
                    const now = Date.now();
                    
                    if (now - lastSync < (syncIntervalMin * 60 * 1000)) continue;

                    // [ESTABILIDAD] Timeout de 45 seg por cuenta
                    await Promise.race([
                        (async () => {
                            // Update lastSync for this account
                            const accountIndex = integrations.accounts.findIndex(acc => acc.id === account.id);
                            if (accountIndex > -1) {
                                integrations.accounts[accountIndex].settings.lastSync = new Date().toISOString();
                                await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
                            }

                            // 2. Fetch recent paid orders
                            const ordersData = await makeShopifyRequest(shopify.shopUrl, shopify.accessToken, '/orders.json?status=open&financial_status=paid&limit=50');
                            
                            if (!ordersData.orders || ordersData.orders.length === 0) return;

                            console.log(`[ShopifyPolling] Found ${ordersData.orders.length} paid orders for client ${clientId} (${account.nickname})`);

                            for (const order of ordersData.orders) {
                                try {
                                    const orderId = order.id.toString();
                                    const orderNumber = order.order_number ? order.order_number.toString() : (order.name || orderId);
                                    const { rows: existing } = await db.query('SELECT id FROM packages WHERE "shopifyOrderId" = $1 OR "id" = $2', [orderId, orderId]);
                                    if (existing.length > 0) continue;

                                    const address = order.shipping_address || order.billing_address || {};
                                    const province = (address.province || '').toLowerCase();
                                    const city = (address.city || '').toLowerCase();
                                    
                                    const isRM = province.includes('metropolitana') || 
                                                 province.includes('santiago') || 
                                                 province.includes('rm') ||
                                                 province.includes('r.m.') ||
                                                 city.includes('santiago') ||
                                                 city.includes('metropolitana') ||
                                                 city.includes('rm') ||
                                                 validCommunes.includes(city);
                                    
                                    if (!isRM) continue;

                                    const nowImport = new Date();
                                    const newPackage = {
                                        id: `${clientIdentifier}-${uuidv4().split('-')[0]}`,
                                        recipientName: `${address.first_name || ''} ${address.last_name || ''}`.trim() || 'N/A',
                                        recipientPhone: address.phone || 'N/A',
                                        recipientEmail: order.email || '',
                                        status: 'PENDIENTE',
                                        shippingType: 'SAME_DAY',
                                        origin: 'Centro de Distribución',
                                        recipientAddress: `${address.address1 || ''} ${address.address2 || ''}`.trim() || 'N/A',
                                        recipientCommune: normalizeCommune(address.city || 'N/A'),
                                        recipientCity: normalizeCity('Región Metropolitana'),
                                        notes: `Auto-Import Shopify Order: ${order.name || orderId}`,
                                        estimatedDelivery: nowImport,
                                        createdAt: nowImport,
                                        updatedAt: nowImport,
                                        creatorId: clientId,
                                        source: 'SHOPIFY',
                                        shopifyOrderId: orderId,
                                        shopifyOrderNumber: orderNumber,
                                        sourceAccountId: account.id,
                                        sourceAccountName: account.nickname
                                    };

                                    const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
                                    const values = Object.values(newPackage).map(v => v === undefined ? null : v);
                                    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

                                    await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders}) ON CONFLICT ("shopifyOrderId") DO NOTHING`, values);
                                    await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
                                        [newPackage.id, 'Creado', newPackage.origin, `Auto-importado vía Shopify (${account.nickname}).`, nowImport]);
                                    
                                    importedThisCycle++;
                                } catch (orderErr) {
                                    // Ignorar error individual
                                }
                            }
                        })(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_ACCOUNT')), 45000))
                    ]);
                } catch (apiErr) {
                    if (apiErr.message === 'TIMEOUT_ACCOUNT') {
                        console.error(`[ShopifyPolling] Polling timed out after 45s for account ${account.nickname} (${clientId})`);
                    } else {
                        console.error(`[ShopifyPolling] Error fetching orders for ${account.nickname}:`, apiErr.body || apiErr.message || apiErr);
                    }
                }
            }
        }
        setTimeout(() => triggerBackgroundGeocoding(), 2000);
    } catch (err) {
        console.error('[ShopifyPolling] Fatal error in auto-import cycle:', err);
    } finally {
        lastImportCount = importedThisCycle;
    }
}

let timeoutId = null;

function start(intervalMs = 5 * 60 * 1000, delayMs = 0) { 
    if (timeoutId !== null) return;
    currentIntervalMs = intervalMs;
    nextScheduledTime = Date.now() + delayMs;
    
    console.log(`[ShopifyPolling] Service starting (Interval: ${intervalMs/1000/60} min, Initial Delay: ${delayMs/1000}s)`);
    
    // Initial delay then start the recursive timeout chain
    timeoutId = setTimeout(pollShopifyPackages, delayMs);
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
        console.warn('[ShopifyPolling] Polling cycle took too long (>15m), triggering emergency reset.');
        isPolling = false;
        pollingStartTime = null;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(pollShopifyPackages, currentIntervalMs);
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
    await pollShopifyPackages();
};

module.exports = { start, stop, pollShopifyPackages, getStatus, triggerSync };
