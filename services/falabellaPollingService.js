const db = require('../db');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { normalizeCommune, normalizeCity } = require('../utils/normUtil');
const { decrypt, buildFalabellaSignature } = require('./falabellaCrypto');
const { geocodeAddress } = require('./geocodingService');
const gisService = require('./gisService');

// --- FALABELLA API HELPER (self-contained, independent of routes/integrations.js) ---
const makeFalabellaRequest = (apiKey, sellerId, action, extraParams = null) => {
    return new Promise((resolve, reject) => {
        if (!apiKey || !sellerId) return reject(new Error('Credenciales de Falabella incompletas.'));

        const decryptedApiKey = apiKey.includes(':') ? decrypt(apiKey) : apiKey;
        const baseParams = {
            Action: action,
            Timestamp: new Date().toISOString(),
            UserID: sellerId,
            Version: '1.0',
            Format: 'JSON',
            ...extraParams
        };
        const signature = buildFalabellaSignature(baseParams, decryptedApiKey);
        const queryString = Object.keys(baseParams).sort()
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(baseParams[key])}`)
            .join('&') + `&Signature=${encodeURIComponent(signature)}`;

        const req = https.request({
            hostname: 'sellercenter-api.falabella.com',
            path: `/?${queryString}`,
            method: 'GET',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => { chunks.push(chunk); });
            res.on('end', () => {
                // Concatenate raw Buffers before decoding — string-concatenating chunks
                // corrupts multi-byte characters (Ñ, á, é...) split across a chunk
                // boundary, same bug fixed in meliPollingService.js/routes/integrations.js.
                const data = Buffer.concat(chunks).toString('utf8');
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        if (parsed.ErrorResponse) reject({ statusCode: res.statusCode, body: parsed, isFalabellaError: true });
                        else resolve(parsed);
                    } else {
                        reject({ statusCode: res.statusCode, body: parsed });
                    }
                } catch (e) {
                    reject({ statusCode: res.statusCode, body: data, isRaw: true });
                }
            });
        });
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Falabella API request timed out after 15s')); });
        req.on('error', (e) => reject(e));
        req.end();
    });
};

const decodeHtmlEntities = (str) => {
    if (!str) return '';
    return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
};

// Small local copy of the same bounded-concurrency helper used in meliPollingService.js —
// duplicated for independence rather than imported, same rationale as the API helper above.
async function runWithLimit(concurrency, items, fn) {
    const results = [];
    const executing = new Set();
    for (const item of items) {
        const p = Promise.resolve().then(() => fn(item));
        results.push(p);
        executing.add(p);
        const clean = () => executing.delete(p);
        p.then(clean).catch(clean);
        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }
    return Promise.all(results);
}

let isPolling = false;
let pollingStartTime = null;
let currentIntervalMs = 5 * 60 * 1000;
let nextScheduledTime = Date.now() + currentIntervalMs;
let lastImportCount = 0;
let timeoutId = null;

async function autoImportFalabellaPackages(activeCommunes = []) {
    console.log('[FalabellaPolling] Starting auto-import cycle...');
    let importedThisCycle = 0;
    try {
        const { rows: users } = await db.query(
            "SELECT id, integrations, \"clientIdentifier\" FROM users WHERE role = 'CLIENT' AND integrations->'accounts' IS NOT NULL"
        );

        // Clients run concurrently (bounded) since each owns an independent DB row/token —
        // see meliPollingService.js's autoImportMeliPackages for the full rationale (a
        // sequential loop meant total cycle time scaled linearly with client count). The
        // whole per-client body is wrapped in its own try/catch so one client's unhandled
        // error can never block clients queued behind it in the same batch.
        await runWithLimit(10, users, async (user) => {
          try {
            const clientId = user.id;
            const integrations = user.integrations || {};
            const falabellaAccounts = (integrations.accounts || []).filter(acc => acc.type === 'FALABELLA');
            if (falabellaAccounts.length === 0) return;

            for (const account of falabellaAccounts) {
                try {
                    await Promise.race([
                        (async () => {
                            const settings = account.settings || {};
                            if (settings.autoImport !== true) return;

                            const syncIntervalMin = settings.syncInterval !== undefined ? settings.syncInterval : 5;
                            const lastAttempt = settings.lastAttemptAt
                                ? new Date(settings.lastAttemptAt).getTime()
                                : (settings.lastSync ? new Date(settings.lastSync).getTime() : 0);
                            if (Date.now() - lastAttempt < (syncIntervalMin * 60 * 1000)) return;

                            const accountIndex = integrations.accounts.findIndex(acc => acc.id === account.id);
                            const markAttempt = async () => {
                                if (accountIndex > -1) {
                                    integrations.accounts[accountIndex].settings.lastAttemptAt = new Date().toISOString();
                                    await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
                                }
                            };

                            const { falabellaApiKey, falabellaSellerId } = account.credentials || {};
                            if (!falabellaApiKey || !falabellaSellerId) { await markAttempt(); return; }

                            if (accountIndex > -1) {
                                integrations.accounts[accountIndex].settings.lastSync = new Date().toISOString();
                                integrations.accounts[accountIndex].settings.lastAttemptAt = new Date().toISOString();
                                await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
                            }

                            const fetchByStatus = async (status) => {
                                const response = await makeFalabellaRequest(falabellaApiKey, falabellaSellerId, 'GetOrders', {
                                    CreatedAfter: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
                                    Status: status
                                });
                                const ordersRaw = response?.SuccessResponse?.Body?.Orders;
                                if (!ordersRaw) return [];
                                if (Array.isArray(ordersRaw)) return ordersRaw.map(item => item.Order).filter(Boolean);
                                if (ordersRaw.Order) return Array.isArray(ordersRaw.Order) ? ordersRaw.Order : [ordersRaw.Order];
                                return [];
                            };

                            const [pendingOrders, readyOrders] = await Promise.all([
                                fetchByStatus('pending'),
                                fetchByStatus('ready_to_ship')
                            ]);
                            const combinedOrders = [...pendingOrders, ...readyOrders];

                            let importedThisAccount = 0;
                            for (const order of combinedOrders) {
                                try {
                                    const falabellaOrderId = order.OrderId ? order.OrderId.toString() : null;
                                    if (!falabellaOrderId) continue;

                                    const { rows: existing } = await db.query(
                                        'SELECT id FROM packages WHERE "falabellaOrderId" = $1', [falabellaOrderId]
                                    );
                                    if (existing.length > 0) continue;

                                    const rawCommune = order.AddressShipping?.Ward || order.AddressBilling?.Ward || 'N/A';
                                    const recipientCommune = normalizeCommune(decodeHtmlEntities(rawCommune));

                                    if (activeCommunes.length > 0 && !activeCommunes.includes(recipientCommune.toLowerCase())) {
                                        console.log(`[FalabellaPolling] Skipping order ${falabellaOrderId} - Commune "${rawCommune}" is INACTIVE or outside active zones.`);
                                        continue;
                                    }

                                    const rawFirstName = order.CustomerFirstName || '';
                                    const rawLastName = order.CustomerLastName || '';
                                    const fullName = decodeHtmlEntities(`${rawFirstName} ${rawLastName}`.trim()) || 'N/A';
                                    const address1 = order.AddressBilling?.Address1 || '';
                                    const address2 = order.AddressBilling?.Address2 || '';
                                    const recipientAddress = decodeHtmlEntities([address1, address2].filter(Boolean).join(', ').trim()) || 'N/A';

                                    let lat, lng, destIsApproximate = false;
                                    try {
                                        const coords = await geocodeAddress(recipientAddress, recipientCommune, 'Región Metropolitana');
                                        if (coords && coords.lat !== null) { lat = coords.lat; lng = coords.lng; }
                                    } catch (geoErr) {
                                        console.error(`[FalabellaPolling] Geocoding failed for order ${falabellaOrderId}:`, geoErr.message);
                                    }
                                    if (lat === undefined) {
                                        const centroid = gisService.getComunaCentroid(recipientCommune);
                                        lat = centroid?.lat ?? 0.000001;
                                        lng = centroid?.lng ?? 0.000001;
                                        destIsApproximate = true;
                                    }

                                    const now = new Date();
                                    const newPackage = {
                                        id: `${user.clientIdentifier || 'CLI'}-${uuidv4().split('-')[0]}`,
                                        recipientName: fullName,
                                        recipientPhone: order.AddressShipping?.Phone || order.AddressBilling?.Phone || order.CustomerPhone || 'N/A',
                                        status: 'PENDIENTE',
                                        shippingType: 'SAME_DAY',
                                        origin: 'Centro de Distribución',
                                        recipientAddress,
                                        recipientCommune,
                                        recipientCity: normalizeCity('Región Metropolitana'),
                                        notes: decodeHtmlEntities(order.Remarks || order.Notes || `Falabella Order: ${order.OrderNumber || order.OrderId}`),
                                        estimatedDelivery: now,
                                        createdAt: now,
                                        updatedAt: now,
                                        creatorId: clientId,
                                        source: 'FALABELLA',
                                        falabellaOrderId,
                                        falabellaTrackingId: order.OrderNumber ? order.OrderNumber.toString() : falabellaOrderId,
                                        sourceAccountId: account.id,
                                        destLatitude: lat,
                                        destLongitude: lng,
                                        destIsApproximate
                                    };

                                    const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
                                    const values = Object.values(newPackage).map(v => v === undefined ? null : v);
                                    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
                                    // No unique constraint on falabellaOrderId to ON CONFLICT against
                                    // (matches the existing manual-import route's approach) — the
                                    // pre-check above (SELECT ... WHERE "falabellaOrderId" = $1) is
                                    // what keeps this idempotent instead.
                                    await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
                                    await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                                        [newPackage.id, 'Creado', newPackage.origin, 'Auto-importado desde Falabella.', now]);

                                    importedThisAccount++;
                                    importedThisCycle++;
                                    console.log(`[FalabellaPolling] Auto-imported order ${falabellaOrderId} for client ${clientId} (Account: ${account.nickname})`);
                                } catch (orderErr) {
                                    console.error(`[FalabellaPolling] Error importing order for client ${clientId}:`, orderErr.message || orderErr);
                                }
                            }

                            if (combinedOrders.length > 0 || importedThisAccount > 0) {
                                console.log(`[FalabellaPolling] Cycle summary for client ${clientId} (${account.nickname}): fetched=${combinedOrders.length}, imported=${importedThisAccount}`);
                            }
                        })(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_ACCOUNT')), 45000))
                    ]);
                } catch (accErr) {
                    if (accErr.message === 'TIMEOUT_ACCOUNT') {
                        console.error(`[FalabellaPolling] Polling timed out after 45s for account ${account.nickname} (${clientId})`);
                    } else {
                        console.error(`[FalabellaPolling] Error auto-importing for account ${account.nickname}:`, accErr.message);
                    }
                }
            }
          } catch (userErr) {
              console.error(`[FalabellaPolling] Unhandled error processing client ${user.id}:`, userErr.message || userErr);
          }
        });
    } catch (err) {
        console.error('[FalabellaPolling] Fatal error in auto-import cycle:', err);
    } finally {
        lastImportCount = importedThisCycle;
    }
}

async function pollFalabellaPackages() {
    if (isPolling) {
        console.log('[FalabellaPolling] Already polling, skipping...');
        return;
    }
    isPolling = true;
    pollingStartTime = Date.now();
    console.log('[FalabellaPolling] Starting poll cycle...');
    try {
        let autoImportEnabled = false;
        try {
            const { rows: settingsRows } = await db.query('SELECT "falabellaAutoImport" FROM system_settings WHERE id = 1');
            if (settingsRows.length > 0) autoImportEnabled = settingsRows[0].falabellaAutoImport;
        } catch (settingsErr) {
            console.warn('[FalabellaPolling] Could not fetch settings from DB or column missing. Defaulting to disabled.', settingsErr.message);
        }

        if (autoImportEnabled) {
            const { rows: activeRows } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
            const activeCommunes = activeRows.map(r => normalizeCommune(r.name).toLowerCase());
            await autoImportFalabellaPackages(activeCommunes);
        }
    } catch (err) {
        console.error('[FalabellaPolling] Fatal error in poll cycle:', err);
    } finally {
        // Fixed-cadence rescheduling from when THIS cycle started, not currentIntervalMs
        // after it finished — see meliPollingService.js's pollMeliPackages for why an
        // overrun must not compound into ever-growing delay on the next cycle.
        const elapsed = Date.now() - pollingStartTime;
        const delay = Math.max(0, currentIntervalMs - elapsed);
        if (elapsed > currentIntervalMs) {
            console.warn(`[FalabellaPolling] Cycle took ${Math.round(elapsed / 1000)}s, longer than the ${Math.round(currentIntervalMs / 1000)}s interval — starting next cycle immediately.`);
        }
        isPolling = false;
        pollingStartTime = null;
        nextScheduledTime = Date.now() + delay;
        if (timeoutId !== null) {
            timeoutId = setTimeout(pollFalabellaPackages, delay);
        }
    }
}

function start(intervalMs = 5 * 60 * 1000, delayMs = 0) {
    if (timeoutId !== null) return;
    currentIntervalMs = intervalMs;
    nextScheduledTime = Date.now() + delayMs;
    console.log(`[FalabellaPolling] Service starting (Interval: ${intervalMs / 1000 / 60} min, Initial Delay: ${delayMs / 1000}s)`);
    timeoutId = setTimeout(pollFalabellaPackages, delayMs);
}

function stop() {
    if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
}

function getStatus() {
    if (isPolling && pollingStartTime && (Date.now() - pollingStartTime > 15 * 60 * 1000)) {
        console.warn('[FalabellaPolling] Polling cycle took too long (>15m), triggering emergency reset.');
        isPolling = false;
        pollingStartTime = null;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(pollFalabellaPackages, currentIntervalMs);
        }
    }
    return {
        nextPollTime: nextScheduledTime,
        isPolling,
        pollingStartTime,
        intervalMs: currentIntervalMs,
        lastImportCount
    };
}

const triggerSync = async () => {
    await pollFalabellaPackages();
};

module.exports = {
    start,
    stop,
    getStatus,
    pollFalabellaPackages,
    autoImportFalabellaPackages,
    triggerSync
};
