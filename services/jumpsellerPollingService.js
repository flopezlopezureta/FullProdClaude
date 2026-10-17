const db = require('../db');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { normalizeCommune, normalizeCity, checkOrderCommune } = require('../utils/normUtil');
const { triggerBackgroundGeocoding } = require('./geocodingService');

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

        // Set 15s timeout
        req.setTimeout(15000, () => {
           req.destroy();
           reject(new Error('Jumpseller API request timed out after 15s'));
        });

        req.on('error', (e) => reject(e));
        if (postData) req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
        req.end();
    });
};
const ensureMultiAccountStructure = (integrations) => {
    if (!integrations) integrations = { accounts: [] };
    if (!integrations.accounts) {
        const accounts = [];
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
    }
    return integrations;
};

let isPolling = false;
let pollingStartTime = null;
let lastPollTime = Date.now();
let currentIntervalMs = 5 * 60 * 1000;
let nextScheduledTime = lastPollTime + currentIntervalMs;

async function pollJumpsellerPackages() {
    if (isPolling) {
        console.log('[JumpsellerPolling] Already polling, skipping...');
        return;
    }
    isPolling = true;
    pollingStartTime = Date.now();
    lastPollTime = Date.now();
    console.log('[JumpsellerPolling] Starting poll cycle...');
    try {
        // 0. Check if auto-import is enabled (global setting)
        let autoImportEnabled = false;
        try {
            const { rows: settingsRows } = await db.query('SELECT "jumpsellerAutoImport" FROM system_settings WHERE id = 1');
            autoImportEnabled = settingsRows.length > 0 && settingsRows[0].jumpsellerAutoImport;
        } catch (settingsErr) {
            console.warn('[JumpsellerPolling] Could not fetch jumpsellerAutoImport from DB. Defaulting to true.');
            autoImportEnabled = true; 
        }

        if (autoImportEnabled) {
            await autoImportJumpsellerPackages();
        }

    } catch (err) {
        console.error('[JumpsellerPolling] Fatal error in poll cycle:', err);
    } finally {
        isPolling = false;
        pollingStartTime = null;
        nextScheduledTime = Date.now() + currentIntervalMs;
        if (timeoutId !== null) {
            timeoutId = setTimeout(pollJumpsellerPackages, currentIntervalMs);
        }
    }
}

let lastImportCount = 0;

async function autoImportJumpsellerPackages() {
    console.log('[JumpsellerPolling] Starting auto-import cycle...');
    let importedThisCycle = 0;
    try {
        // Comunas habilitadas en el setup (una vez por ciclo). Vacío = el setup no tiene comunas activas: se aceptan todas las conocidas.
        const { rows: activeRows } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
        const validCommunes = activeRows.map(r => normalizeCommune(r.name).toLowerCase());

        // 1. Get all users with Jumpseller integration (old or new format)
        const { rows: users } = await db.query(`
            SELECT id, integrations, "clientIdentifier", address, "pickupAddress" 
            FROM users 
            WHERE role = 'CLIENT' 
            AND (integrations->'jumpseller' IS NOT NULL OR integrations->'accounts' IS NOT NULL)
        `);
        
        for (const user of users) {
            const clientId = user.id;
            const clientIdentifier = user.clientIdentifier || 'CLI';
            
            let integrations = ensureMultiAccountStructure(user.integrations);
            const jumpsellerAccounts = integrations.accounts.filter(acc => acc.type === 'JUMPSELLER');

            if (jumpsellerAccounts.length === 0) continue;

            for (const account of jumpsellerAccounts) {
                try {
                    const jumpseller = account.credentials;
                    const settings = account.settings || {};

                    if (!jumpseller.login || !jumpseller.token) continue;
                    if (settings.autoImport === false) continue;

                    const syncIntervalMin = settings.syncInterval !== undefined ? settings.syncInterval : 2; 
                    const lastSync = settings.lastSync ? new Date(settings.lastSync).getTime() : 0;
                    const now = Date.now();
                    
                    if (now - lastSync < (syncIntervalMin * 60 * 1000)) continue;

                    await Promise.race([
                        (async () => {
                            const accountIndex = integrations.accounts.findIndex(acc => acc.id === account.id);
                            if (accountIndex > -1) {
                                integrations.accounts[accountIndex].settings.lastSync = new Date().toISOString();
                                await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
                            }

                            const orders = await makeJumpsellerRequest(jumpseller.login, jumpseller.token, '/orders.json?status=all&limit=50');
                            
                            if (!orders || orders.length === 0) return;

                            console.log(`[JumpsellerPolling] Found ${orders.length} orders for client ${clientId}`);

                            for (const o of orders) {
                                try {
                                    const order = o.order;
                                    if (!order) continue;
                                    if (order.status !== 'Paid' && order.status !== 'Ready') continue;

                                    const orderId = order.id.toString();
                                    const { rows: existing } = await db.query('SELECT id FROM packages WHERE "jumpsellerOrderId" = $1', [orderId]);
                                    if (existing.length > 0) continue;

                                    const shipping = order.shipping_address || {};
                                    const municipality = (shipping.municipality || '').toLowerCase();
                                    const city = (shipping.city || '').toLowerCase();

                                    // Comuna reconocida y NO habilitada en el setup → el pedido no entra. La lista fija de más abajo
                                    // incluía TODAS las comunas de la RM, también las que el setup tiene desactivadas. Si el texto no
                                    // identifica ninguna comuna se mantiene el criterio anterior.
                                    const zone = checkOrderCommune([shipping.municipality, shipping.city], validCommunes, { strict: false });
                                    if (!zone.allow) {
                                        console.log(`[JumpsellerPolling] Skipping order ${order.id} - comuna "${zone.commune}" NO habilitada (${account.nickname}).`);
                                        continue;
                                    }
                                    
                                    const isRM = municipality.includes('metropolitana') || 
                                                 municipality.includes('santiago') || 
                                                 municipality.includes('rm') ||
                                                 municipality.includes('r.m.') ||
                                                 city.includes('metropolitana') ||
                                                 city.includes('santiago') ||
                                                 city.includes('rm') ||
                                                 [
                                                    'santiago', 'cerrillos', 'cerro navia', 'conchali', 'el bosque', 'estacion central', 
                                                    'huechuraba', 'independencia', 'la cisterna', 'la florida', 'la granja', 'la pintana', 
                                                    'la reina', 'las condes', 'lo barnechea', 'lo espejo', 'lo prado', 'macul', 'maipu', 
                                                    'ñuñoa', 'pedro aguirre cerda', 'peñalolen', 'providencia', 'pudahuel', 'quilicura', 
                                                    'quinta normal', 'recoleta', 'renca', 'san joaquin', 'san miguel', 'san ramon', 
                                                    'vitacura', 'puente alto', 'pirque', 'san jose de maipo', 'colina', 'lampa', 'tiltil', 
                                                    'san bernardo', 'buin', 'calera de tango', 'paine', 'melipilla', 'alhue', 'curacavi', 
                                                    'maria pinto', 'san pedro', 'talagante', 'el monte', 'isla de maipo', 'padre hurtado', 'peñaflor'
                                                 ].includes(municipality);
                                    
                                    if (!isRM && municipality !== '' && city !== '') continue;

                                    const importNow = new Date();
                                    const origin = user.pickupAddress || user.address || 'Centro de Distribución';
                                    const customer = order.customer || {};

                                    const newPackage = {
                                        id: `${clientIdentifier}-${uuidv4().split('-')[0]}`,
                                        recipientName: shipping.fullname || customer.fullname || 'N/A',
                                        recipientPhone: shipping.phone || customer.phone || 'N/A',
                                        recipientEmail: customer.email || '',
                                        status: 'PENDIENTE',
                                        shippingType: 'SAME_DAY',
                                        origin: origin,
                                        recipientAddress: shipping.address || 'N/A',
                                        recipientCommune: zone.commune || normalizeCommune(shipping.municipality || 'N/A'),
                                        recipientCity: normalizeCity(shipping.city || 'Santiago'),
                                        notes: `Auto-Import Jumpseller Order: ${order.id}`,
                                        estimatedDelivery: importNow,
                                        createdAt: importNow,
                                        updatedAt: importNow,
                                        creatorId: clientId,
                                        source: 'JUMPSELLER',
                                        jumpsellerOrderId: orderId,
                                        sourceAccountId: account.id,
                                        sourceAccountName: account.nickname
                                    };

                                    const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
                                    const vals = Object.values(newPackage);
                                    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');

                                    await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders}) ON CONFLICT ("jumpsellerOrderId") DO NOTHING`, vals);
                                    await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
                                        [newPackage.id, 'Creado', origin, `Auto-importado vía Jumpseller (${account.nickname}).`, importNow]);
                                    
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
                        console.error(`[JumpsellerPolling] Polling timed out after 45s for account ${account.nickname} (${clientId})`);
                    } else {
                        console.error(`[JumpsellerPolling] Error fetching orders for account ${account.nickname}:`, apiErr.body || apiErr.message || apiErr);
                    }
                }
            }
        }
        setTimeout(() => triggerBackgroundGeocoding(), 2000);
    } catch (err) {
        console.error('[JumpsellerPolling] Fatal error in auto-import cycle:', err);
    } finally {
        lastImportCount = importedThisCycle;
    }
}

let timeoutId = null;

function start(intervalMs = 10 * 60 * 1000, delayMs = 0) { 
    if (timeoutId !== null) return;
    currentIntervalMs = intervalMs;
    nextScheduledTime = Date.now() + delayMs;
    
    console.log(`[JumpsellerPolling] Service starting (Interval: ${intervalMs/1000/60} min, Initial Delay: ${delayMs/1000}s)`);
    
    timeoutId = setTimeout(pollJumpsellerPackages, delayMs);
}

function stop() {
    if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}

function getStatus() {
    if (isPolling && pollingStartTime && (Date.now() - pollingStartTime > 15 * 60 * 1000)) {
        console.warn('[JumpsellerPolling] Polling cycle took too long (>15m), force reset.');
        isPolling = false;
        pollingStartTime = null;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(pollJumpsellerPackages, currentIntervalMs);
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

module.exports = { start, stop, pollJumpsellerPackages, getStatus, makeJumpsellerRequest };
