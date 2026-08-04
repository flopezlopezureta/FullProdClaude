const db = require('../db');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { normalizeCommune, normalizeCity } = require('../utils/normUtil');
const { triggerBackgroundGeocoding, geocodeAddress } = require('./geocodingService');
const { emitDriverEvent } = require('./driverEvents');

// --- MELI API HELPERS (Duplicated from integrations.js for independence) ---
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
           reject(new Error('Meli API request timed out after 15s'));
        });

        req.on('error', (e) => reject(e));
        if (postData) req.write(postData);
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

const ensureMultiAccountStructure = (integrations) => {
    if (!integrations) integrations = { accounts: [] };
    if (!integrations.accounts) {
        const accounts = [];
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
        // ... (can add others if needed, but Meli is priority here)
        integrations.accounts = accounts;
    }
    return integrations;
};

async function getValidMeliToken(clientId, accountId = null) {
    const { rows: userRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [clientId]);
    if (userRows.length === 0) return null;
    
    let integrations = userRows[0].integrations || {};
    let meliIntegration = null;
    let accountIndex = -1;

    // Si tenemos accountId, buscamos esa cuenta específica
    if (accountId) {
        if (!integrations.accounts) integrations = ensureMultiAccountStructure(integrations);
        accountIndex = integrations.accounts.findIndex(acc => acc.id === accountId);
        
        // [FIX] Fallback si el ID no coincide debido a la generación dinámica de UUIDs en memoria
        if (accountIndex === -1) {
            accountIndex = integrations.accounts.findIndex(acc => acc.type === 'MERCADO_LIBRE');
        }
        
        if (accountIndex === -1) return null;
        meliIntegration = integrations.accounts[accountIndex].credentials;
    } else {
        // Fallback a la estructura antigua o a la primera cuenta de ML encontrada
        meliIntegration = integrations.meli;
        if (!meliIntegration && integrations.accounts) {
            accountIndex = integrations.accounts.findIndex(acc => acc.type === 'MERCADO_LIBRE');
            if (accountIndex > -1) {
                meliIntegration = integrations.accounts[accountIndex].credentials;
                accountId = integrations.accounts[accountIndex].id;
            }
        } else if (meliIntegration && !integrations.accounts) {
            // Migrar sobre la marcha si es necesario
            integrations = ensureMultiAccountStructure(integrations);
            accountIndex = integrations.accounts.findIndex(acc => acc.type === 'MERCADO_LIBRE');
            accountId = integrations.accounts[accountIndex].id;
        }
    }

    if (!meliIntegration) return null;

    if (Date.now() >= meliIntegration.expiresAt) {
        try {
            const { rows: settingsRows } = await db.query('SELECT meli_app_id, meli_client_secret FROM integration_settings WHERE id = 1');
            if (settingsRows.length === 0) return null;
            
            const { meli_app_id, meli_client_secret } = settingsRows[0];
            const refreshData = new URLSearchParams({
                grant_type: 'refresh_token', 
                client_id: meli_app_id, 
                client_secret: meli_client_secret, 
                refresh_token: meliIntegration.refreshToken,
            }).toString();
            
            const refreshed = await makeMeliPostRequest('/oauth/token', refreshData);
            meliIntegration = {
                ...meliIntegration,
                accessToken: refreshed.access_token,
                refreshToken: refreshed.refresh_token,
                expiresAt: Date.now() + (refreshed.expires_in * 1000),
            };

            // Guardar el token actualizado
            if (accountId && accountIndex > -1) {
                integrations.accounts[accountIndex].credentials = meliIntegration;
            } else {
                integrations.meli = meliIntegration;
            }
            
            await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
        } catch (err) {
            console.error(`Error refreshing ML token for client ${clientId}:`, err);
            return null;
        }
    }
    return meliIntegration.accessToken;
}

let isPolling = false;
let pollingStartTime = null;
let lastPollTime = Date.now();
let currentIntervalMs = 5 * 60 * 1000;
let nextScheduledTime = lastPollTime + currentIntervalMs;
let totalPackagesCount = 0;
let processedPackagesCount = 0;
let lastImportCount = 0;

// Helper function for limited concurrency
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

async function pollMeliPackages() {
    if (isPolling) {
        console.log('[MeliPolling] Already polling, skipping...');
        return;
    }
    isPolling = true;
    pollingStartTime = Date.now();
    lastPollTime = Date.now();
    processedPackagesCount = 0;
    totalPackagesCount = 0;
    console.log('[MeliPolling] Starting poll cycle...');
    try {
        // 0. Check if auto-import and auto-prompt are enabled
        let autoImportEnabled = false;
        let meliAutoPromptPhotos = false;
        try {
            const { rows: settingsRows } = await db.query('SELECT "meliAutoImport", "meliAutoPromptPhotos" FROM system_settings WHERE id = 1');
            if (settingsRows.length > 0) {
                autoImportEnabled = settingsRows[0].meliAutoImport;
                meliAutoPromptPhotos = settingsRows[0].meliAutoPromptPhotos;
            }
        } catch (settingsErr) {
            console.warn('[MeliPolling] Could not fetch settings from DB or column missing. Defaulting...', settingsErr.message);
            autoImportEnabled = true; // Safety default
        }

        if (autoImportEnabled) {
            // Fetch active communes once per cycle
            const { rows: activeRows } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
            const activeCommunes = activeRows.map(r => normalizeCommune(r.name).toLowerCase());
            
            await autoImportMeliPackages(activeCommunes);
        }

        // [NUEVO] Limpieza automática de registros fuera de zona (Santiago/RM)
        await cleanupOutOfZonePackages();

        // 1. Get all active Mercado Libre packages that are not finished
        const { rows: packages } = await db.query(`
            SELECT id, "meliOrderId", "meliFlexCode", "driverId", status, "creatorId", "sourceAccountId" 
            FROM packages 
            WHERE source = 'MERCADO_LIBRE' 
            AND status NOT IN ('ENTREGADO', 'DEVUELTO', 'CANCELADO')
            AND ("meliOrderId" IS NOT NULL OR "meliFlexCode" IS NOT NULL)
        `);

        if (packages.length === 0) {
            console.log('[MeliPolling] No active ML packages to poll status.');
        } else {
            totalPackagesCount = packages.length;
            console.log(`[MeliPolling] Polling status for ${totalPackagesCount} packages...`);

            // Use limited concurrency (e.g., 5 at a time) to avoid hitting ML rate limits or hanging
            await runWithLimit(5, packages, async (pkg) => {
                try {
                    const accessToken = await getValidMeliToken(pkg.creatorId, pkg.sourceAccountId);
                    if (!accessToken) {
                        processedPackagesCount++;
                        return;
                    }

                    const shipmentId = pkg.meliFlexCode || pkg.meliOrderId;
                    if (!shipmentId) {
                        processedPackagesCount++;
                        return;
                    }

                    // Check status in Mercado Libre
                    const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
                    
                    const mlStatus = shipment.status;
                    const mlSubstatus = shipment.substatus;
                    const now = new Date();
                    
                    let newStatus = null;
                    let eventDetails = '';
                    let eventStatus = '';

                    if (mlStatus === 'delivered') {
                        const { rows: existingML } = await db.query(
                            'SELECT id FROM tracking_events WHERE "packageId" = $1 AND status = \'CIERRE_OFICIAL_ML\'',
                            [pkg.id]
                        );
                        if (existingML.length === 0) {
                            let meliTime = now;
                            if (shipment.status_history && Array.isArray(shipment.status_history)) {
                                const deliveredEvent = shipment.status_history.find(h => h.status === 'delivered');
                                if (deliveredEvent && deliveredEvent.date) meliTime = new Date(deliveredEvent.date);
                            }
                            await db.query(
                                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                                [pkg.id, 'CIERRE_OFICIAL_ML', 'Mercado Libre API (Auto-Capture)', `Entrega detectada en Meli: ${meliTime.toISOString()}`, meliTime]
                            );
                        }
                        if (meliAutoPromptPhotos && pkg.status !== 'ENTREGADO') {
                            await db.query(
                                'UPDATE packages SET "meliDeliveredNeedsPhotos" = true, "updatedAt" = $1 WHERE id = $2',
                                [now, pkg.id]
                            );
                            emitDriverEvent(pkg.driverId, {
                                packageId: pkg.id,
                                trackingId: pkg.meliOrderId || pkg.meliFlexCode || null,
                                type: 'MELI_DELIVERY_CLOSED'
                            });
                        }
                    } else if (mlStatus === 'shipped' && !['EN_TRANSITO', 'EN_RUTA', 'PROBLEMA', 'REPROGRAMADO', 'ENTREGADO', 'DEVUELTO', 'CANCELADO'].includes(pkg.status)) {
                        newStatus = 'EN_TRANSITO';
                        eventStatus = 'En Tránsito';
                        eventDetails = 'El envío ha sido marcado como SHIPPED (En Camino) por Mercado Libre.';
                    } else if (mlStatus === 'cancelled' && pkg.status !== 'CANCELADO') {
                        newStatus = 'CANCELADO';
                        eventStatus = 'Cancelado';
                        eventDetails = 'El envío ha sido CANCELADO en Mercado Libre.';
                    } else if ((mlStatus === 'rescheduled' || mlSubstatus === 'rescheduled' || mlSubstatus === 'reprogrammed') && pkg.status !== 'REPROGRAMADO') {
                        newStatus = 'REPROGRAMADO';
                        eventStatus = 'Reprogramado';
                        eventDetails = 'El envío ha sido REPROGRAMADO por el cliente (vía Mercado Libre).';
                    } else if (mlStatus === 'not_delivered' && pkg.status !== 'PROBLEMA') {
                        newStatus = 'PROBLEMA';
                        eventStatus = 'Problema';
                        eventDetails = 'El envío ha sido marcado como NO ENTREGADO en Mercado Libre.';
                    }

                    const trackingId = shipment.tracking_id ? String(shipment.tracking_id) : null;
                    
                    if (newStatus || trackingId) {
                        const now = new Date();
                        const isFlexed = mlStatus === 'shipped' || mlStatus === 'delivered';
                        
                        await db.query(
                            'UPDATE packages SET status = COALESCE($1, status), "trackingId" = COALESCE($2, "trackingId"), "updatedAt" = $3, "isFlexed" = $4, "flexedAt" = CASE WHEN $4 = true AND "flexedAt" IS NULL THEN $3 ELSE "flexedAt" END WHERE id = $5', 
                            [newStatus, trackingId, now, isFlexed, pkg.id]
                        );
                        
                        if (newStatus) {
                            await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
                                [pkg.id, eventStatus, 'Mercado Libre', eventDetails, now]);
                            
                            if (pkg.driverId) {
                                const notificationId = `notif-${uuidv4()}`;
                                await db.query(`
                                    INSERT INTO notifications (id, "userId", title, message, type, "relatedId")
                                    VALUES ($1, $2, $3, $4, $5, $6)
                                `, [notificationId, pkg.driverId, `Envío ${eventStatus}`, `El paquete ${pkg.id} ha sido actualizado a ${eventStatus} por Mercado Libre.`, `PACKAGE_${newStatus}`, pkg.id]);
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[MeliPolling] Error polling shipment for package ${pkg.id}:`, err.message || err);
                } finally {
                    processedPackagesCount++;
                }
            });

            // [NUEVO] Sincronización Retroactiva de Horas de Entrega para el Dashboard
            console.log('[MeliPolling] Starting retroactive ML delivery hour sync...');
            const { rows: deliveredMissingML } = await db.query(`
                SELECT p.id, p."meliOrderId", p."meliFlexCode", p."creatorId", p."sourceAccountId"
                FROM packages p
                LEFT JOIN tracking_events te ON p.id = te."packageId" AND te.status = 'CIERRE_OFICIAL_ML'
                WHERE p.status = 'ENTREGADO' 
                AND p.source = 'MERCADO_LIBRE'
                AND p."updatedAt"::date >= current_date - interval '1 day'
                AND te.id IS NULL
                LIMIT 20
            `);

            for (const pkg of deliveredMissingML) {
                try {
                    const accessToken = await getValidMeliToken(pkg.creatorId, pkg.sourceAccountId);
                    if (accessToken) {
                        const shipmentId = pkg.meliFlexCode || pkg.meliOrderId;
                        const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
                        
                        let meliTimeStr = null;
                        let source = '';

                        // Prioridad 0: Campo oficial de entrega final (más preciso para Flex)
                        if (shipment.status === 'delivered' && shipment.date_delivered) {
                            meliTimeStr = shipment.date_delivered;
                            source = 'shipment.date_delivered';
                        }

                        // Prioridad 1: Historial de estados (el más reciente de tipo 'delivered')
                        if (!meliTimeStr && shipment.status_history && Array.isArray(shipment.status_history)) {
                            const deliveredEvent = shipment.status_history
                                .filter(h => h.status === 'delivered')
                                .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
                            if (deliveredEvent) {
                                meliTimeStr = deliveredEvent.date;
                                source = 'status_history.delivered';
                            }
                        }

                        // Prioridad 2: Fallback campo directo de entrega
                        if (!meliTimeStr && shipment.status === 'delivered' && shipment.delivered_date) {
                            meliTimeStr = shipment.delivered_date;
                            source = 'shipment.delivered_date';
                        }

                        if (meliTimeStr) {
                            const mDate = new Date(meliTimeStr);
                            await db.query(
                                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                                [pkg.id, 'CIERRE_OFICIAL_ML', 'Mercado Libre API (Auto-Sync)', `Hora real capturada de ${source}: ${meliTimeStr}`, mDate]
                            );
                            console.log(`[MeliPolling] Retroactively synced ML hour for ${pkg.id} from ${source}: ${meliTimeStr}`);
                        }
                    }
                } catch (e) {
                    // Silently fail for background task
                }
            }
        }
        
        // [NUEVO] Paso de Auto-Fix para paquetes sin tracking_id en las últimas 48 horas
        console.log('[MeliPolling] Checking for packages missing tracking_id (SCA)...');
        const { rows: missingTracking } = await db.query(`
            SELECT id, "meliFlexCode", "meliOrderId", "creatorId" 
            FROM packages 
            WHERE source = 'MERCADO_LIBRE' 
            AND "trackingId" IS NULL 
            AND "createdAt" > NOW() - INTERVAL '48 hours'
            LIMIT 50
        `);

        for (const pkg of missingTracking) {
            try {
                const accessToken = await getValidMeliToken(pkg.creatorId);
                if (accessToken) {
                    const shipmentId = pkg.meliFlexCode || pkg.meliOrderId;
                    const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
                    if (shipment.tracking_id) {
                        await db.query('UPDATE packages SET "trackingId" = $1 WHERE id = $2', [String(shipment.tracking_id), pkg.id]);
                        console.log(`[MeliPolling] Auto-fixed trackingId for ${pkg.id}: ${shipment.tracking_id}`);
                    }
                }
            } catch (err) {
                // Silently fail for background auto-fix
            }
        }

    } catch (err) {
        console.error('[MeliPolling] Fatal error in poll cycle:', err);
    } finally {
        isPolling = false;
        pollingStartTime = null;
        totalPackagesCount = 0;
        processedPackagesCount = 0;
        nextScheduledTime = Date.now() + currentIntervalMs;
        // Schedule next poll using setTimeout for better reliability
        if (timeoutId !== null) {
            timeoutId = setTimeout(pollMeliPackages, currentIntervalMs);
        }
    }
}

// [NUEVO] Función para asegurar el tracking_id inmediatamente después de importar
async function syncTrackingId(packageId) {
    try {
        const { rows } = await db.query('SELECT id, "meliFlexCode", "meliOrderId", "creatorId", "trackingId" FROM packages WHERE id = $1', [packageId]);
        if (rows.length === 0 || rows[0].trackingId) return;
        
        const pkg = rows[0];
        const accessToken = await getValidMeliToken(pkg.creatorId);
        if (!accessToken) return;

        const shipmentId = pkg.meliFlexCode || pkg.meliOrderId;
        const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
        if (shipment.tracking_id) {
            await db.query('UPDATE packages SET "trackingId" = $1 WHERE id = $2', [String(shipment.tracking_id), packageId]);
            console.log(`[MeliPolling] Immediate sync for ${packageId}: trackingId=${shipment.tracking_id}`);
        }
    } catch (err) {
        console.warn(`[MeliPolling] Could not sync trackingId immediately for ${packageId}:`, err.message);
    }
}

async function syncPackage(packageId) {
    console.log(`[MeliPolling] Manually syncing package ${packageId}...`);
    try {
        const { rows } = await db.query(`
            SELECT * 
            FROM packages 
            WHERE id = $1
        `, [packageId]);

        if (rows.length === 0) throw new Error('Paquete no encontrado.');
        const pkg = rows[0];

        if (pkg.source !== 'MERCADO_LIBRE') {
            throw new Error('El paquete no es de Mercado Libre.');
        }

        const shipmentId = pkg.meliFlexCode || pkg.meliOrderId;
        if (!shipmentId) {
            throw new Error('El paquete no tiene un ID de Mercado Libre (Order ID o Flex Code) asociado.');
        }

        const accessToken = await getValidMeliToken(pkg.creatorId);
        if (!accessToken) {
            throw new Error('No se pudo obtener el token de Mercado Libre para el cliente propietario de este paquete. Asegúrate de que la integración esté activa.');
        }

        console.log(`[MeliPolling] Requesting ML shipment ${shipmentId} for package ${packageId}...`);
        const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
        
        const mlStatus = shipment.status;
        const mlSubstatus = shipment.substatus;
        
        console.log(`[MeliPolling] ML Status for ${shipmentId}: ${mlStatus} (${mlSubstatus || 'no substatus'})`);

        let newStatus = null;
        let eventDetails = '';
        let eventStatus = '';

        /* 
        // [DESACTIVADO] No cerramos automáticamente para forzar que el conductor suba fotos
        if (mlStatus === 'delivered' && pkg.status !== 'ENTREGADO') {
            newStatus = 'ENTREGADO';
            eventStatus = 'Entregado';
            eventDetails = 'Sincronización manual: El envío figura como ENTREGADO en Mercado Libre.';
        } else 
        */
        if (mlStatus === 'cancelled' && pkg.status !== 'CANCELADO') {
            newStatus = 'CANCELADO';
            eventStatus = 'Cancelado';
            eventDetails = 'Sincronización manual: El envío figura como CANCELADO en Mercado Libre.';
        } else if ((mlStatus === 'rescheduled' || mlSubstatus === 'rescheduled' || mlSubstatus === 'reprogrammed') && pkg.status !== 'REPROGRAMADO') {
            newStatus = 'REPROGRAMADO';
            eventStatus = 'Reprogramado';
            eventDetails = 'Sincronización manual: El envío figura como REPROGRAMADO por el cliente en Mercado Libre.';
        } else if (mlStatus === 'not_delivered' && pkg.status !== 'PROBLEMA') {
            newStatus = 'PROBLEMA';
            eventStatus = 'Problema';
            eventDetails = 'Sincronización manual: El envío figura como NO ENTREGADO en Mercado Libre.';
        }

        const trackingId = shipment.tracking_id ? String(shipment.tracking_id) : null;

        if (newStatus || trackingId) {
            const now = new Date();
            await db.query('UPDATE packages SET status = COALESCE($1, status), "trackingId" = COALESCE($2, "trackingId"), "updatedAt" = $3 WHERE id = $4', [newStatus, trackingId, now, pkg.id]);
            await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
                [pkg.id, eventStatus, 'Mercado Libre (Sync)', eventDetails, now]);
            
            const { rows: updatedRows } = await db.query('SELECT * FROM packages WHERE id = $1', [pkg.id]);
            const { rows: history } = await db.query('SELECT * FROM tracking_events WHERE "packageId" = $1 ORDER BY timestamp DESC', [pkg.id]);
            return { ...updatedRows[0], history };
        }

        const { rows: history } = await db.query('SELECT * FROM tracking_events WHERE "packageId" = $1 ORDER BY timestamp DESC', [pkg.id]);
        return { ...pkg, history, noChange: true, mlStatus, mlSubstatus };

    } catch (err) {
        console.error(`[MeliPolling] Error syncing package ${packageId}:`, err.body || err);
        if (err.statusCode === 404) {
            throw new Error(`El ID de envío ${packageId} no fue encontrado en Mercado Libre. Verifica que el ID sea correcto.`);
        }
        if (err.statusCode === 401 || err.statusCode === 403) {
            throw new Error('Error de autenticación con Mercado Libre. Por favor, reconecta la cuenta del cliente.');
        }
        throw new Error(err.message || 'Error desconocido al sincronizar con Mercado Libre.');
    }
}

async function autoImportMeliPackages(activeCommunes = []) {
    console.log('[MeliPolling] Starting auto-import cycle...');
    
    // Fallback if no active communes configured (sanity check)
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
        // 1. Get all customers with ML integrations (new or old format)
        const { rows: users } = await db.query(`
            SELECT id, integrations, "clientIdentifier" 
            FROM users 
            WHERE role = 'CLIENT' 
            AND (integrations->'meli' IS NOT NULL OR integrations->'accounts' IS NOT NULL)
        `);
        
        for (const user of users) {
            const clientId = user.id;
            const clientIdentifier = user.clientIdentifier || 'CLI';
            
            // Asegurar estructura multi-cuenta
            let integrations = ensureMultiAccountStructure(user.integrations);
            const meliAccounts = integrations.accounts.filter(acc => acc.type === 'MERCADO_LIBRE');

            if (meliAccounts.length === 0) continue;

            for (const account of meliAccounts) {
                try {
                    // [ESTABILIDAD] Usamos un timeout de 45 segundos por cuenta para evitar bloqueos
                    await Promise.race([
                        (async () => {
                            const meliIntegration = account.credentials;
                            const settings = account.settings || {};

                            // Ignorar si el auto-import está apagado para esta cuenta
                            if (settings.autoImport !== true) return;

                            // --- CHECK INTERVAL PER ACCOUNT ---
                            // [MEJORADO] Reducimos el intervalo por defecto a 2 minutos para una importación más ágil
                            const syncIntervalMin = settings.syncInterval !== undefined ? settings.syncInterval : 2;
                            const lastSync = settings.lastSync ? new Date(settings.lastSync).getTime() : 0;
                            const nowTime = Date.now();
                            
                            if (nowTime - lastSync < (syncIntervalMin * 60 * 1000)) return;

                            // Obtener token (refresca si es necesario)
                            const accessToken = await getValidMeliToken(clientId, account.id);
                            if (!accessToken) return;

                            // Actualizar lastSync para esta cuenta específica
                            const accountIndex = integrations.accounts.findIndex(acc => acc.id === account.id);
                            if (accountIndex > -1) {
                                integrations.accounts[accountIndex].settings.lastSync = new Date().toISOString();
                                await db.query('UPDATE users SET integrations = $1 WHERE id = $2', [JSON.stringify(integrations), clientId]);
                            }

                            // 2. Fetch recent orders for this seller
                            const ordersData = await makeMeliGetRequest(`/orders/search?seller=${meliIntegration.userId}&order.status=paid&sort=date_desc&limit=100`, accessToken);
                            
                            if (!ordersData.results || ordersData.results.length === 0) {
                                console.log(`[MeliPolling] No recent paid orders for client ${clientId} (Account: ${account.nickname})`);
                                return;
                            }

                            console.log(`[MeliPolling] Found ${ordersData.results.length} recent paid orders for client ${clientId} (${account.nickname}). Processing...`);

                            for (const order of ordersData.results) {
                                try {
                                    const orderId = order.id.toString();
                                    const shipmentId = order.shipping?.id;
                                    const sellerId = order.seller?.id?.toString();
                                    const integrationUserId = meliIntegration.userId?.toString();

                                    // Safety Check: Ensure the seller ID matches the user's integration
                                    if (sellerId && integrationUserId && sellerId !== integrationUserId) {
                                        console.warn(`[MeliPolling] Skipping order ${orderId} - Seller ID mismatch (${sellerId} vs ${integrationUserId})`);
                                        continue;
                                    }

                                    if (!shipmentId) {
                                        console.log(`[MeliPolling] Skipping order ${orderId} - No shipment ID`);
                                        continue;
                                    }

                                    // 3. Check if already imported
                                    const { rows: existing } = await db.query('SELECT id, status FROM packages WHERE "meliOrderId" = $1 OR "meliFlexCode" = $2 OR "id" = $2', [orderId, shipmentId.toString()]);
                                    if (existing.length > 0) {
                                        continue;
                                    }

                                    console.log(`[MeliPolling] Order ${orderId} is NEW. Fetching shipment details...`);

                                    // 4. Get Shipment Details to check address
                                    const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
                                    
                                    if (shipment.status === 'delivered' || shipment.status === 'cancelled') continue;

                                    // 4.5 Deep Search for Phone Number
                                    let recipientPhone = 'N/A';
                                    try {
                                        const fullOrder = await makeMeliGetRequest(`/orders/${orderId}`, accessToken);
                                        const phoneCandidates = [
                                            shipment.receiver_address?.receiver_phone,
                                            shipment.receiver_address?.phone,
                                            fullOrder.buyer?.phone?.number,
                                            fullOrder.buyer?.mobile?.number,
                                            fullOrder.buyer?.billing_info?.phone,
                                            fullOrder.shipping?.receiver_address?.receiver_phone,
                                            fullOrder.shipping?.receiver_address?.phone,
                                            fullOrder.buyer?.phone?.area_code ? `${fullOrder.buyer.phone.area_code}${fullOrder.buyer.phone.number}` : null
                                        ];
                                        
                                        for (const candidate of phoneCandidates) {
                                            if (candidate && typeof candidate === 'string') {
                                                const cleanCandidate = candidate.trim();
                                                // Avoid masked numbers (X, *, or too short)
                                                if (cleanCandidate.length > 5 && 
                                                    !cleanCandidate.includes('*') && 
                                                    !cleanCandidate.toUpperCase().includes('X') &&
                                                    !cleanCandidate.includes('0000000')) {
                                                    recipientPhone = cleanCandidate;
                                                    break;
                                                }
                                            }
                                        }
                                    } catch (phoneErr) {
                                        console.warn(`[MeliPolling] Phone search failed for order ${orderId}:`, phoneErr.message);
                                        recipientPhone = shipment.receiver_address?.receiver_phone || 'N/A';
                                    }
                                    
                                    // 5. Region & Active Commune Check
                                    const stateName = shipment.receiver_address?.state?.name || '';
                                    const communeName = shipment.receiver_address?.city?.name || '';
                                    const lowerCommune = normalizeCommune(communeName);
                                    
                                    if (!validCommunes.includes(lowerCommune)) {
                                        console.log(`[MeliPolling] Skipping order ${orderId} - Commune "${communeName}" is INACTIVE or outside active zones.`);
                                        continue; 
                                    }
                                    
                                    // Normalize region name
                                    shipment.receiver_address.state.name = 'Región Metropolitana';

                                    // 6. Import Package
                                    const now = new Date();
                                    const newPackage = {
                                        id: `${clientIdentifier}-${uuidv4().split('-')[0]}`,
                                        recipientName: shipment.receiver_address?.receiver_name || order.buyer?.nickname || 'N/A',
                                        recipientPhone: recipientPhone,
                                        status: 'PENDIENTE',
                                        shippingType: 'SAME_DAY',
                                        origin: 'Centro de Distribución',
                                        recipientAddress: shipment.receiver_address?.address_line || 'N/A',
                                        recipientCommune: normalizeCommune(shipment.receiver_address?.city?.name || 'N/A'),
                                        recipientCity: normalizeCity(stateName),
                                        notes: `Auto-Import ML Order: ${orderId}`,
                                        estimatedDelivery: now,
                                        createdAt: now,
                                        updatedAt: now,
                                        creatorId: clientId,
                                        source: 'MERCADO_LIBRE',
                                        meliOrderId: orderId.toString(),
                                        meliFlexCode: shipmentId.toString(),
                                        meliSellerId: meliIntegration.userId?.toString(),
                                        sourceAccountId: account.id,
                                        sourceAccountName: account.nickname,
                                        trackingId: shipment.tracking_id ? String(shipment.tracking_id) : null,
                                        recipientRut: shipment.receiver_address?.federal_id || null
                                    };

                                    const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
                                    const values = Object.values(newPackage).map(v => v === undefined ? null : v);
                                    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

                                    await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders}) ON CONFLICT ("meliOrderId") DO NOTHING`, values);
                                    await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
                                        [newPackage.id, 'Creado', newPackage.origin, 'Auto-importado vía integración ML.', now]);
                                    
                                    importedThisCycle++;
                                    console.log(`[MeliPolling] Auto-imported order ${orderId} for client ${clientId} (Account: ${account.nickname})`);
                                    
                                    if (!newPackage.trackingId) {
                                        syncTrackingId(newPackage.id); 
                                    }
                                } catch (orderErr) {
                                    console.error(`[MeliPolling] Error processing order ${order.id}:`, orderErr.message);
                                }
                            }
                        })(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_ACCOUNT')), 45000))
                    ]);
                } catch (accErr) {
                    if (accErr.message === 'TIMEOUT_ACCOUNT') {
                        console.error(`[MeliPolling] Polling timed out after 45s for account ${account.nickname} (${clientId})`);
                    } else {
                        console.error(`[MeliPolling] Error auto-importing for account ${account.nickname}:`, accErr.message);
                    }
                }
            }
        }
        
        // Trigger background geocoding
        setTimeout(() => triggerBackgroundGeocoding(), 2000);
    } catch (err) {
        console.error('[MeliPolling] Fatal error in auto-import cycle:', err);
    } finally {
        lastImportCount = importedThisCycle;
    }
}

async function cleanupOutOfZonePackages() {
    try {
        // Fetch active communes for cleanup
        const { rows: activeRows } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
        const activeCommunes = activeRows.map(r => normalizeCommune(r.name).toLowerCase());
        
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

        const queryFind = `
            SELECT id, "recipientCity", "recipientCommune", source FROM packages 
            WHERE 
               "driverId" IS NULL AND (
                   -- Bloque 1: Ciudades explícitamente fuera de zona
                   LOWER("recipientCity") LIKE '%puerto montt%' OR 
                   LOWER("recipientCity") LIKE '%loncoche%' OR 
                   LOWER("recipientCommune") LIKE '%puerto montt%' OR 
                   LOWER("recipientCommune") LIKE '%loncoche%' OR
                   
                   -- Bloque 2: Paquetes de Mercado Libre que NO pertenecen a las comunas ACTIVAS
                    (
                      source = 'MERCADO_LIBRE' AND 
                      NOT (LOWER("recipientCommune") = ANY($1))
                    )
                )
        `;
        const { rows: toDelete } = await db.query(queryFind, [validCommunes]);
        
        if (toDelete.length > 0) {
            const ids = toDelete.map(r => r.id);
            console.log(`[MeliPolling] Cleanup: Deleting ${ids.length} out-of-zone packages...`);
            // Log sample of deleted packages for debugging
            toDelete.slice(0, 5).forEach(p => {
                console.log(`[MeliPolling] Cleanup details: ID=${p.id}, City=${p.recipientCity}, Commune=${p.recipientCommune}, Source=${p.source}`);
            });

            await db.query('DELETE FROM tracking_events WHERE "packageId" = ANY($1)', [ids]);
            await db.query('DELETE FROM packages WHERE id = ANY($1)', [ids]);
        }
    } catch (err) {
        console.error('[MeliPolling] Error during automatic cleanup:', err);
    }
}

async function cleanupDuplicates() {
    console.log('[MeliPolling] Starting cleanup of duplicate packages...');
    try {
        // Find duplicate meliFlexCode
        const { rows: duplicates } = await db.query(`
            SELECT "meliFlexCode", array_agg(id ORDER BY "createdAt" ASC) as ids
            FROM packages 
            WHERE "meliFlexCode" IS NOT NULL 
            GROUP BY "meliFlexCode" 
            HAVING count(*) > 1
        `);

        if (duplicates.length === 0) {
            console.log('[MeliPolling] No duplicates found.');
            return;
        }

        for (const row of duplicates) {
            const [keepId, ...deleteIds] = row.ids;
            console.log(`[MeliPolling] Cleaning up ${deleteIds.length} duplicates for Flex Code ${row.meliFlexCode}. Keeping ID ${keepId}`);
            
            // Delete tracking events first
            await db.query('DELETE FROM tracking_events WHERE "packageId" = ANY($1)', [deleteIds]);
            // Delete packages
            await db.query('DELETE FROM packages WHERE id = ANY($1)', [deleteIds]);
        }
        console.log(`[MeliPolling] Cleanup complete. Removed duplicates for ${duplicates.length} Flex codes.`);
    } catch (err) {
        console.error('[MeliPolling] Error during cleanup:', err);
    }
}


// [NUEVO] Función para importar un paquete específico en tiempo real (Just-In-Time)
async function importSpecificMeliPackage(clientId, shipmentId, skipRegionFilter = false) {
    // [NUEVO] Si shipmentId es un JSON (etiqueta oficial), extraer solo el ID
    if (shipmentId && typeof shipmentId === 'string' && shipmentId.startsWith('{')) {
        try {
            const parsed = JSON.parse(shipmentId);
            if (parsed.id) shipmentId = String(parsed.id);
        } catch (e) {}
    }

    console.log(`[MeliPolling] Attempting just-in-time import for Shipment ID ${shipmentId} (Client: ${clientId}, SkipRegionFilter: ${skipRegionFilter})`);
    try {
        const accessToken = await getValidMeliToken(clientId);
        if (!accessToken) throw new Error('Token ML no disponible');

        // 1. Fetch Shipment Details
        const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
        const orderId = shipment.order_id?.toString();

        if (!orderId) {
            console.error(`[MeliPolling] Shipment ${shipmentId} has no associated Order ID.`);
            return null;
        }

        // 2. Double-check if already in DB (to avoid race conditions)
        const { rows: existing } = await db.query('SELECT id FROM packages WHERE "meliFlexCode" = $1 OR "meliOrderId" = $2 OR "id" = $1', [shipmentId.toString(), orderId]);
        if (existing.length > 0) return existing[0].id;

        // 3. Region Filter (Santiago/RM) - Only check if skipRegionFilter is false
        if (!skipRegionFilter) {
            let stateName = shipment.receiver_address?.state?.name || 'Santiago';
            const lowerState = stateName.toLowerCase();
            const isRM = lowerState.includes('metropolitana') || 
                         lowerState.includes('santiago') || 
                         lowerState === 'rm' ||
                         lowerState.includes('r.m.');
            
            if (!isRM) {
                console.warn(`[MeliPolling] Just-in-time skipped: Shipment ${shipmentId} is in ${stateName} (Outside RM)`);
                return null;
            }
        }

        // 4. Create Package Data
        const { rows: userRows } = await db.query('SELECT "clientIdentifier" FROM users WHERE id = $1', [clientId]);
        const clientIdentifier = userRows[0]?.clientIdentifier || 'CLI';
        const now = new Date();

        // [NUEVO] Geocodificación instantánea para JIT: obtener coordenadas inmediatamente
        let lat = 0.000001;
        let lng = 0.000001;
        try {
            const recipientAddress = shipment.receiver_address?.address_line || 'N/A';
            const recipientCommune = normalizeCommune(shipment.receiver_address?.city?.name || 'N/A');
            const coords = await geocodeAddress(recipientAddress, recipientCommune, 'Región Metropolitana');
            if (coords && coords.lat !== null) {
                lat = coords.lat;
                lng = coords.lng;
            }
        } catch (geoErr) {
            console.error(`[MeliPolling] Immediate JIT geocoding failed for shipment ${shipmentId}:`, geoErr.message);
        }

        const newPackage = {
            id: `${clientIdentifier}-${uuidv4().split('-')[0]}`,
            recipientName: shipment.receiver_address?.receiver_name || 'N/A',
            recipientPhone: shipment.receiver_address?.receiver_phone || 'N/A',
            recipientEmail: shipment.buyer?.email || null,
            status: 'PENDIENTE',
            shippingType: 'SAME_DAY',
            origin: 'Centro de Distribución',
            recipientAddress: shipment.receiver_address?.address_line || 'N/A',
            recipientCommune: normalizeCommune(shipment.receiver_address?.city?.name || 'N/A'),
            recipientCity: normalizeCity('Región Metropolitana'),
            notes: `Just-In-Time Import ML: ${shipmentId}`,
            estimatedDelivery: now,
            createdAt: now,
            updatedAt: now,
            creatorId: clientId,
            source: 'MERCADO_LIBRE',
            meliOrderId: orderId,
            meliFlexCode: shipmentId.toString(),
            trackingId: shipment.tracking_id ? String(shipment.tracking_id) : null,
            recipientRut: shipment.receiver_address?.federal_id || null,
            destLatitude: lat,
            destLongitude: lng
        };

        const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
        const values = Object.values(newPackage).map(v => v === undefined ? null : v);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
        await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)', 
            [newPackage.id, 'Creado', newPackage.origin, 'Importado bajo demanda (escaneado).', now]);

        console.log(`[MeliPolling] Successfully imported package ${newPackage.id} for shipment ${shipmentId}`);
        return newPackage.id;

    } catch (err) {
        console.error(`[MeliPolling] Just-in-time import error for ${shipmentId}:`, err.message);
        return null;
    }
}

// [NUEVO] Optimizado: Buscar y asociar el envío con un único llamado API usando cualquier token válido
async function optimizedJITDiscovery(shipmentId) {
    let senderId = null;
    if (shipmentId && typeof shipmentId === 'string' && shipmentId.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(shipmentId.trim());
            if (parsed.sender_id) senderId = String(parsed.sender_id);
            else if (parsed.senderId) senderId = String(parsed.senderId);
            else if (parsed.seller_id) senderId = String(parsed.seller_id);
            
            if (parsed.id) shipmentId = String(parsed.id);
        } catch (e) {}
    }

    console.log(`[MeliPolling] JIT: Starting optimized discovery for Shipment ID: ${shipmentId}, Sender ID: ${senderId}`);
    try {
        // 1. Get all active ML integrations
        const { rows: users } = await db.query(
            "SELECT id, integrations FROM users WHERE role = 'CLIENT' AND (integrations->'meli' IS NOT NULL OR integrations->'accounts' IS NOT NULL)"
        );
        if (users.length === 0) {
            console.warn(`[MeliPolling] JIT: No users with ML integrations found in DB.`);
            return null;
        }

        // If we extracted a senderId from the scan, find the matching user directly
        let matchingUser = null;
        if (senderId) {
            for (const u of users) {
                let uIntegrations = u.integrations || {};
                if (uIntegrations.meli && String(uIntegrations.meli.userId) === senderId) {
                    matchingUser = u;
                    break;
                }
                if (uIntegrations.accounts) {
                    const acc = uIntegrations.accounts.find(a => a.type === 'MERCADO_LIBRE' && String(a.credentials?.userId) === senderId);
                    if (acc) {
                        matchingUser = u;
                        break;
                    }
                }
            }
        }

        // If we found a matching user directly, import it!
        if (matchingUser) {
            console.log(`[MeliPolling] JIT: Direct match for client ${matchingUser.id} (ML User: ${senderId}). Performing import...`);
            return await importSpecificMeliPackage(matchingUser.id, shipmentId, true);
        }

        // Fallback: If no senderId or no direct match, query Mercado Libre shipments by trying each user's token (parallel scan)
        console.log(`[MeliPolling] JIT: No direct match. Initiating parallel scan fallback across active users...`);
        const results = await Promise.all(users.map(async (u) => {
            try {
                const importedId = await importSpecificMeliPackage(u.id, shipmentId, true);
                return importedId ? { importedId, user: u } : null;
            } catch (err) {
                return null;
            }
        }));

        const success = results.find(r => r !== null);
        if (success) {
            console.log(`[MeliPolling] JIT: Parallel scan succeeded. Imported as ${success.importedId} for client ${success.user.id}`);
            return success.importedId;
        }

        console.warn(`[MeliPolling] JIT: Shipment ${shipmentId} could not be imported for any active client integration.`);
        return null;

    } catch (err) {
        console.error(`[MeliPolling] JIT: Fatal error in optimizedJITDiscovery for ${shipmentId}:`, err.message || err);
        return null;
    }
}

let timeoutId = null;

function start(intervalMs = 5 * 60 * 1000, delayMs = 0) { // Default 5 minutes
    if (timeoutId !== null) return;
    currentIntervalMs = intervalMs;
    nextScheduledTime = Date.now() + delayMs;
    
    // Run cleanup once on start
    cleanupDuplicates();
    
    console.log(`[MeliPolling] Service starting (Interval: ${intervalMs/1000/60} min, Initial Delay: ${delayMs/1000}s)`);
    
    // Initial delay then start the recursive timeout chain
    timeoutId = setTimeout(pollMeliPackages, delayMs);
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
        console.warn('[MeliPolling] Polling cycle took too long (>15m), triggering emergency reset.');
        isPolling = false;
        pollingStartTime = null;
        // Ensure service continues
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(pollMeliPackages, currentIntervalMs);
        }
    }

    return {
        nextPollTime: nextScheduledTime,
        isPolling,
        pollingStartTime,
        intervalMs: currentIntervalMs,
        totalPackages: totalPackagesCount,
        processedPackages: processedPackagesCount,
        lastImportCount
    };
}

const triggerSync = async () => {
    await pollMeliPackages();
};

const lastDriverSyncs = new Map();

// Fast, on-demand sync for a single driver's own pending ML packages, used when
// the driver's browser tab regains focus (e.g. coming back from checking Meli's
// own app) so a closed shipment shows up in seconds instead of waiting for the
// next 5-min background poll cycle.
async function syncDriverPendingPackages(driverId) {
    if (!driverId) return [];

    // Anti-Spam / Rate-limiting: Previene que la sincronización se dispare
    // varias veces si el conductor cambia rápido de pestañas. (30 segundos de cooldown)
    const nowMs = Date.now();
    const lastSync = lastDriverSyncs.get(driverId);
    if (lastSync && (nowMs - lastSync < 30000)) {
        return [];
    }
    lastDriverSyncs.set(driverId, nowMs);

    console.log(`[MeliPolling] Fast sync requested for driver ${driverId}`);

    // Check if auto-prompt is enabled
    let meliAutoPromptPhotos = false;
    try {
        const { rows: settingsRows } = await db.query('SELECT "meliAutoPromptPhotos" FROM system_settings WHERE id = 1');
        if (settingsRows.length > 0) {
            meliAutoPromptPhotos = settingsRows[0].meliAutoPromptPhotos;
        }
    } catch (e) {
        console.warn('[MeliPolling] Failed to read meliAutoPromptPhotos in fast sync, defaulting to false.');
    }

    if (!meliAutoPromptPhotos) return []; // If feature is disabled, don't waste API calls

    const { rows: packages } = await db.query(`
        SELECT id, "meliOrderId", "meliFlexCode", "creatorId", "sourceAccountId", status
        FROM packages
        WHERE source = 'MERCADO_LIBRE'
        AND status NOT IN ('ENTREGADO', 'DEVUELTO', 'CANCELADO', 'PROBLEMA', 'REPROGRAMADO')
        AND ("meliOrderId" IS NOT NULL OR "meliFlexCode" IS NOT NULL)
        AND "driverId" = $1
    `, [driverId]);

    if (packages.length === 0) return [];

    console.log(`[MeliPolling] Driver ${driverId} has ${packages.length} pending ML packages. Checking status...`);
    const newlyDelivered = [];

    // Optimizamos el caché de tokens para no sobrecargar la base de datos con peticiones iguales
    const tokenCache = new Map();
    const getTokenCached = async (creatorId, sourceAccountId) => {
        const key = `${creatorId}_${sourceAccountId || 'default'}`;
        if (tokenCache.has(key)) return tokenCache.get(key);
        const token = await getValidMeliToken(creatorId, sourceAccountId);
        tokenCache.set(key, token);
        return token;
    };

    // We can do this in parallel but with small limit (3) to guarantee no connection starvation
    await runWithLimit(3, packages, async (pkg) => {
        try {
            const accessToken = await getTokenCached(pkg.creatorId, pkg.sourceAccountId);
            if (!accessToken) return;

            const shipmentId = pkg.meliFlexCode || pkg.meliOrderId;
            if (!shipmentId) return;

            const shipment = await makeMeliGetRequest(`/shipments/${shipmentId}`, accessToken);
            const mlStatus = shipment.status;

            if (mlStatus === 'delivered' && pkg.status !== 'ENTREGADO') {
                const now = new Date();

                // Add event if it doesn't exist
                const { rows: existingML } = await db.query(
                    'SELECT id FROM tracking_events WHERE "packageId" = $1 AND status = \'CIERRE_OFICIAL_ML\'',
                    [pkg.id]
                );
                if (existingML.length === 0) {
                    let meliTime = now;
                    if (shipment.status_history && Array.isArray(shipment.status_history)) {
                        const deliveredEvent = shipment.status_history.find(h => h.status === 'delivered');
                        if (deliveredEvent && deliveredEvent.date) meliTime = new Date(deliveredEvent.date);
                    }
                    await db.query(
                        'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                        [pkg.id, 'CIERRE_OFICIAL_ML', 'Mercado Libre API (Fast-Sync)', `Entrega detectada en Meli: ${meliTime.toISOString()}`, meliTime]
                    );
                }

                // Set the flag
                await db.query(
                    'UPDATE packages SET "meliDeliveredNeedsPhotos" = true, "updatedAt" = $1 WHERE id = $2',
                    [now, pkg.id]
                );
                emitDriverEvent(driverId, {
                    packageId: pkg.id,
                    trackingId: pkg.meliOrderId || pkg.meliFlexCode || null,
                    type: 'MELI_DELIVERY_CLOSED'
                });

                newlyDelivered.push(pkg.id);
            }
        } catch (err) {
            console.error(`[MeliPolling] Fast sync failed for package ${pkg.id}:`, err.message || err);
        }
    });

    return newlyDelivered;
}

module.exports = {
    start,
    stop,
    getStatus,
    pollMeliPackages,
    syncPackage,
    getValidMeliToken,
    autoImportMeliPackages,
    syncTrackingId,
    importSpecificMeliPackage,
    optimizedJITDiscovery,
    triggerSync,
    syncDriverPendingPackages
};
