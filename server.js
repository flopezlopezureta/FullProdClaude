


require('dotenv').config();
process.env.TZ = 'America/Santiago';

// --- Environment Variable Startup Validation ---
const REQUIRED_DB_ENV = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missingDbEnv = REQUIRED_DB_ENV.filter(key => !process.env[key]);
if (missingDbEnv.length > 0) {
  console.error(`\n❌ [CRITICAL STARTUP ERROR] Missing essential database environment variables: ${missingDbEnv.join(', ')}`);
  console.error('Verify that your .env file or hosting provider (Coolify/Render) has these variables correctly configured.');
  if (process.env.NODE_ENV === 'production') {
    console.error('Forced shutdown: Database environment variables are required in production.\n');
    process.exit(1);
  }
}

if (!process.env.JWT_SECRET) {
  console.warn('\n⚠️ [WARNING] JWT_SECRET environment variable is missing.');
  console.warn('Using an emergency fallback secret. PLEASE set a unique JWT_SECRET in production settings!\n');
  process.env.JWT_SECRET = 'emergency_fallback_secure_secret_key_2026_please_change_in_production';
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Trust proxy is required for correct protocol detection (http vs https) behind a load balancer
app.set('trust proxy', 1);

// --- Middlewares ---
// Aggressively disable caching for all responses to solve stale asset issues.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Allow larger payloads for photo uploads

// [DEBUG] Log all API requests to help diagnose 404/HTML issues
app.use('/api', (req, res, next) => {
  console.log(`[API Request] ${req.method} ${req.originalUrl}`);
  next();
});

// Feeds the super-admin "Tráfico de Red" report — records timing/status per request so
// intermittent connectivity can be traced to a specific IP (e.g. a client's own congested
// wifi) instead of being blamed on the app. Behind two chained proxies (Cloudflare Tunnel,
// then coolify-proxy), `req.ip` with `trust proxy: 1` only unwinds one hop and ends up
// resolving to coolify-proxy's own internal Docker IP, not the real visitor — same class of
// issue as the http/https detection bug found earlier. Cloudflare always sets CF-Connecting-IP
// to the true original client IP regardless of how many internal hops follow, so prefer that.
app.use((req, res, next) => {
  const start = Date.now();
  // This middleware runs before any route's authMiddleware, so req.user isn't populated yet —
  // decode the token independently (read-only, never blocks the request on a bad/missing token)
  // just to attribute the request to a logged-in admin/driver in the traffic report.
  let userId = null;
  try {
    const authHeader = req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || null);
    if (token) {
      const decoded = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
      userId = decoded?.user?.id || null;
    }
  } catch (e) { /* not logged in, expired token, etc. — leave userId null */ }
  res.on('finish', () => {
    try {
      require('./services/networkMetrics').recordRequest({
        ip: req.headers['cf-connecting-ip'] || req.ip,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - start,
        userId,
      });
    } catch (e) { /* diagnostics must never break the real request */ }
  });
  next();
});

const PORT = process.env.PORT || 3000;

async function startServer() {
    // 0. Initialize System Settings
    try {
        const { rows } = await db.query('SELECT timezone FROM system_settings WHERE id = 1');
        if (rows.length > 0 && rows[0].timezone) {
            process.env.SYSTEM_TZ = rows[0].timezone;
            process.env.TZ = rows[0].timezone;
            console.log(`[System] Timezone initialized to: ${rows[0].timezone}`);
        }
    } catch (err) {
        console.warn('[System] Could not load timezone settings from DB, using default.');
    }

    // --- API Routes ---
    // Helper to avoid startup crashes if a route file is missing in deploy.
    function tryRequireRoute(modulePath) {
      try {
        return require(modulePath);
      } catch (err) {
        console.warn(`[WARN] Route module not found: ${modulePath}. Skipping.`, err && err.code ? err.code : err && err.message ? err.message : err);
        return null;
      }
    }
    // Define API routes first to ensure they are not overridden by the static file server or SPA fallback.
    app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', message: 'Backend is running - V3 (Fix Egress Active)' });
    });

    // Diagnostic endpoint to verify which code version is deployed
    app.get('/api/version', (req, res) => {
      const pkg = require('./package.json');
      res.json({ version: pkg.version, comment: pkg.versionComment, repo: 'Fullenvios2 / CLIENTE2' });
    });

    // [EMERGENCIA] Ruta directa para arreglar los egresos de hoy
    app.get('/api/fix-egress-today', async (req, res) => {
        try {
            const db = require('./db');
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
            const query = `
                UPDATE packages 
                SET "assignedAt" = "updatedAt" 
                WHERE "driverId" IS NOT NULL 
                AND "assignedAt" IS NULL 
                AND "updatedAt"::text LIKE $1
            `;
            const result = await db.query(query, [today + '%']);
            res.json({ success: true, message: `✅ Reparados ${result.rowCount} paquetes.`, date: today });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // [DIAGNÓSTICO] Auditoría de Integridad del Sistema
    app.get('/api/admin/audit-integrity', async (req, res) => {
        try {
            const results = {
                timestamp: new Date().toISOString(),
                users: { 
                    total: 0, 
                    inconsistent: [],
                    nonStandardStatus: []
                },
                integrations: { 
                    legacyFormat: 0,
                    orphanedConnections: 0 
                },
                packages: { 
                    orphaned: 0, 
                    duplicates: [] 
                }
            };

            // 1. Roles/Status no estándar
            const rolesRes = await db.query(`
                SELECT id, name, role, status FROM users 
                WHERE role NOT IN ('ADMIN', 'CLIENT', 'DRIVER', 'OPERADOR_SISTEMAS', 'FACTURACION', 'RETIROS', 'AUXILIAR')
            `);
            results.users.inconsistent = rolesRes.rows;

            const statusRes = await db.query(`
                SELECT id, name, status FROM users 
                WHERE status NOT IN ('APROBADO', 'PENDIENTE', 'DESHABILITADO', 'ELIMINADO')
            `);
            results.users.nonStandardStatus = statusRes.rows;

            // 2. Integraciones legadas (sin el campo 'accounts')
            const legacyRes = await db.query(`
                SELECT COUNT(*)::int FROM users 
                WHERE integrations IS NOT NULL 
                  AND (integrations->'accounts') IS NULL
                  AND (integrations::text != '{}')
            `);
            results.integrations.legacyFormat = legacyRes.rows[0].count;

            // 3. Paquetes huérfanos (asignados a conductores inexistentes)
            const orphanedPkgRes = await db.query(`
                SELECT COUNT(*)::int FROM packages p
                LEFT JOIN users u ON p."driverId" = u.id
                WHERE p."driverId" IS NOT NULL AND u.id IS NULL
            `);
            results.packages.orphaned = orphanedPkgRes.rows[0].count;

            // 4. Duplicados de Mercado Libre / Shopify
            const dupRes = await db.query(`
                SELECT 'MELI' as type, "meliOrderId" as order_id, COUNT(*) 
                FROM packages WHERE "meliOrderId" IS NOT NULL 
                GROUP BY "meliOrderId" HAVING COUNT(*) > 1
                UNION ALL
                SELECT 'SHOPIFY' as type, "shopifyOrderId" as order_id, COUNT(*) 
                FROM packages WHERE "shopifyOrderId" IS NOT NULL 
                GROUP BY "shopifyOrderId" HAVING COUNT(*) > 1
            `);
            results.packages.duplicates = dupRes.rows;

            res.json(results);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // [EMERGENCIA] Limpieza de precisión para el arreglo de egresos
    app.get('/api/clean-egress-fix', async (req, res) => {
        try {
            const db = require('./db');
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
            // Buscamos paquetes que tengan assignedAt hoy pero que fueron creados ANTES de hoy
            const query = `
                UPDATE packages 
                SET "assignedAt" = NULL 
                WHERE "assignedAt"::text LIKE $1 
                AND "createdAt"::text NOT LIKE $1
            `;
            const result = await db.query(query, [today + '%']);
            res.json({ success: true, message: `🧹 Limpieza completada. Se han revertido ${result.rowCount} paquetes que eran de días anteriores.`, date: today });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Critical routes: use direct require so startup fails visibly if there are errors
    // --- Core Routes (Mandatory) ---
    app.use('/api/auth', require('./routes/auth.js'));
    app.use('/api/users', require('./routes/users.js'));
    app.use('/api/packages', require('./routes/packages.js'));
    app.use('/api/settings', require('./routes/settings.js'));
    app.use('/api/zones', require('./routes/zones.js'));
    
    // --- Optional/Integration Routes ---
    const invoicesRoute = tryRequireRoute('./routes/invoices.js'); if (invoicesRoute) app.use('/api/invoices', invoicesRoute);
    const billingRoute = tryRequireRoute('./routes/billing.js'); if (billingRoute) app.use('/api/billing', billingRoute);
    const integrationsRoute = tryRequireRoute('./routes/integrations.js'); if (integrationsRoute) app.use('/api/integrations', integrationsRoute);
    const geoRoute = tryRequireRoute('./routes/geo.js'); if (geoRoute) app.use('/api/geo', geoRoute);
    const logsRoute = tryRequireRoute('./routes/logs.js'); if (logsRoute) app.use('/api/logs', logsRoute);
    const pickupsRoute = tryRequireRoute('./routes/pickups.js'); if (pickupsRoute) app.use('/api/pickups', pickupsRoute);
    const assignmentsRoute = tryRequireRoute('./routes/assignments.js'); if (assignmentsRoute) app.use('/api/assignments', assignmentsRoute);
    const mobileRoute = tryRequireRoute('./routes/mobile.js'); if (mobileRoute) app.use('/api', mobileRoute);
    const debugRoute = tryRequireRoute('./routes/debug.js'); if (debugRoute) app.use('/api/debug', debugRoute);
    const networkMetricsRoute = tryRequireRoute('./routes/networkMetrics.js'); if (networkMetricsRoute) app.use('/api/network-metrics', networkMetricsRoute);
    const appUpdatesRoute = tryRequireRoute('./routes/appUpdates.js'); if (appUpdatesRoute) app.use('/api/app-updates', appUpdatesRoute);
    const falabellaDirectRoute = tryRequireRoute('./routes/falabellaDirect.js'); if (falabellaDirectRoute) app.use('/api/falabella-direct', falabellaDirectRoute);
    const googleAuthRoute = tryRequireRoute('./routes/googleAuth.js'); if (googleAuthRoute) app.use('/api/auth/google', googleAuthRoute);
    const notificationsRoute = tryRequireRoute('./routes/notifications.js'); if (notificationsRoute) app.use('/api/notifications', notificationsRoute);
    const reportsRoute = tryRequireRoute('./routes/reports.js'); if (reportsRoute) app.use('/api/reports', reportsRoute);
    const gisSectorRoute = tryRequireRoute('./routes/gis.js'); if (gisSectorRoute) app.use('/api/gis', gisSectorRoute);

    // API Catch-all: prevent falling back to HTML for missing /api routes
    app.all('/api/*', (req, res) => {
        res.status(404).json({ error: 'API Endpoint not found', path: req.path });
    });


    // --- Frontend Serving & SPA Fallback ---
    if (process.env.NODE_ENV !== 'production') {
        const { createServer: createViteServer } = require('vite');
        const vite = await createViteServer({
            server: { middlewareMode: true },
            appType: 'spa',
        });
        app.use(vite.middlewares);
    } else {
        const distPath = path.join(__dirname, 'dist');
        // Serve static files from the 'dist' directory (Vite's build output).
        app.use(express.static(distPath));

        // The SPA fallback (catch-all) MUST be the last route.
        // It handles all GET requests that didn't match an API route or a static file.
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    app.listen(PORT, '0.0.0.0', async () => {
      console.log(`Server is running on port ${PORT}`);
      try {
        await initializeDatabase();
        // await importUsersFromFile(); // Disabled to prevent deleted users from reappearing
        await ensureAdminUser();
        await seedDatabase();

        // Load GIS custom sectors from DB
        try {
            const gisService = require('./services/gisService');
            if (typeof gisService.reloadSectors === 'function') {
                await gisService.reloadSectors();
            }
        } catch (e) {
            console.error('[System] Error reloading sectors on startup:', e);
        }
        
        // Start background services with coordinated offsets to prevent overlap
        // Default interval is 5 minutes (300,000ms)
        const POLL_INTERVAL = 5 * 60 * 1000;
        
        const meliPollingService = tryRequireRoute('./services/meliPollingService.js');
        if (meliPollingService && typeof meliPollingService.start === 'function') {
            // Start Meli immediately
            meliPollingService.start(POLL_INTERVAL, 0);
            console.log('Background Service: Mercado Libre Polling scheduled (0s delay).');
        }
    
        const shopifyPollingService = tryRequireRoute('./services/shopifyPollingService.js');
        if (shopifyPollingService && typeof shopifyPollingService.start === 'function') {
            // Offset Shopify by 2.5 minutes (half the interval)
            const shopifyDelay = POLL_INTERVAL / 2;
            shopifyPollingService.start(POLL_INTERVAL, shopifyDelay);
            console.log(`Background Service: Shopify Polling scheduled (${shopifyDelay/1000}s delay).`);
        }

        const jumpsellerPollingService = tryRequireRoute('./services/jumpsellerPollingService.js');
        if (jumpsellerPollingService && typeof jumpsellerPollingService.start === 'function') {
            // Offset Jumpseller by 3.5 minutes
            const jumpsellerDelay = (POLL_INTERVAL / 2) + (60 * 1000);
            jumpsellerPollingService.start(POLL_INTERVAL, jumpsellerDelay);
            console.log(`Background Service: Jumpseller Polling scheduled (${jumpsellerDelay/1000}s delay).`);
        }

        const woocommercePollingService = tryRequireRoute('./services/woocommercePollingService.js');
        if (woocommercePollingService && typeof woocommercePollingService.start === 'function') {
            // Offset WooCommerce by 4 minutes
            const wooDelay = (POLL_INTERVAL / 2) + (90 * 1000);
            woocommercePollingService.start(POLL_INTERVAL, wooDelay);
            console.log(`Background Service: WooCommerce Polling scheduled (${wooDelay/1000}s delay).`);
        }

        // Drains integration_sync_queue (Falabella Seller Center, Envíame, Falabella Directo
        // retries that exhausted their inline attempts) — previously write-only, nothing ever
        // processed it after the first 3 failed attempts.
        const falabellaDirectService = tryRequireRoute('./services/falabellaDirectService.js');
        if (falabellaDirectService && typeof falabellaDirectService.processIntegrationSyncQueue === 'function') {
            const QUEUE_INTERVAL = 5 * 60 * 1000;
            setInterval(() => {
                falabellaDirectService.processIntegrationSyncQueue().catch(err => {
                    console.error('[IntegrationSyncQueue] Error processing queue:', err);
                });
            }, QUEUE_INTERVAL);
            console.log('Background Service: Integration Sync Queue processor scheduled (5min interval).');
        }

        // Rolls the in-memory network-metrics ring buffer into the persisted daily history table
        // and purges anything past the 3-day retention window.
        require('./services/networkMetrics').start(10 * 60 * 1000);
        console.log('Background Service: Network Traffic daily rollup scheduled (10min interval).');

      } catch (initErr) {
        console.error('Failed to initialize database during startup:', initErr);
      }
    });
}

startServer();

async function initializeDatabase() {
    console.log('Initializing database schema...');
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                phone TEXT,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                status TEXT NOT NULL,
                "assignedDriverId" TEXT,
                "lastAssignmentTimestamp" TIMESTAMPTZ,
                rut TEXT,
                address TEXT,
                "pickupAddress" TEXT,
                "storesInfo" TEXT,
                pricing JSONB,
                "clientIdentifier" TEXT,
                "pickupCost" INTEGER,
                "billingName" TEXT,
                "billingRut" TEXT,
                "billingAddress" TEXT,
                "billingCommune" TEXT,
                "billingGiro" TEXT,
                invoices JSONB,
                "personalRut" TEXT,
                "hasCompany" BOOLEAN,
                "companyName" TEXT,
                "companyRut" TEXT,
                "companyAddress" TEXT,
                "licenseExpiry" TEXT,
                "licenseType" TEXT,
                "backgroundCheckNotes" TEXT,
                vehicles JSONB,
                "driverPermissions" JSONB,
                "operatorPermissions" JSONB,
                latitude REAL,
                longitude REAL,
                "lastLocationUpdate" TIMESTAMPTZ,
                integrations JSONB,
                "plainPassword" TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Table "users" is ready.');

        // --- USERS: ensure critical columns exist in older schemas ---
        const ensureUserColumns = async () => {
            const userCols = [
                'assignedDriverId TEXT',
                'lastAssignmentTimestamp TIMESTAMPTZ',
                'pickupAddress TEXT',
                'phone TEXT',
                'pricing JSONB',
                'clientIdentifier TEXT',
                'pickupCost INTEGER',
                'billingName TEXT',
                'billingRut TEXT',
                'billingAddress TEXT',
                'billingCommune TEXT',
                'billingGiro TEXT',
                'personalRut TEXT',
                'plainPassword TEXT',
                'rut TEXT',
                'address TEXT',
                'storesInfo TEXT',
                'logoBase64 TEXT',
                'invoices JSONB',
                'hasCompany BOOLEAN',
                'companyName TEXT',
                'companyRut TEXT',
                'companyAddress TEXT',
                'licenseExpiry TEXT',
                'licenseType TEXT',
                'backgroundCheckNotes TEXT',
                'vehicles JSONB',
                'driverPermissions JSONB',
                'operatorPermissions JSONB',
                'latitude REAL',
                'longitude REAL',
                'lastLocationUpdate TIMESTAMPTZ',
                'integrations JSONB',
                'createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP'
            ];
            for (const spec of userCols) {
                const col = spec.split(' ')[0];
                try {
                    await db.query(`ALTER TABLE users ADD COLUMN "${col}" ${spec.split(' ').slice(1).join(' ')}`);
                    console.log(`MIGRATION APPLIED: Column "${col}" added to "users".`);
                } catch (err) {
                    if (err.code !== '42701') { console.error(`Error during users migration (${col}):`, err); }
                }
            }
        };
        await ensureUserColumns();

        await db.query(`
            CREATE TABLE IF NOT EXISTS packages (
                id TEXT PRIMARY KEY,
                "recipientName" TEXT NOT NULL,
                "recipientPhone" TEXT NOT NULL,
                status TEXT NOT NULL,
                "shippingType" TEXT NOT NULL,
                origin TEXT,
                destination TEXT,
                "recipientAddress" TEXT,
                "recipientCommune" TEXT,
                "recipientCity" TEXT,
                notes TEXT,
                "estimatedDelivery" TIMESTAMPTZ,
                "createdAt" TIMESTAMPTZ,
                "updatedAt" TIMESTAMPTZ,
                "driverId" TEXT,
                "creatorId" TEXT,
                "deliveryReceiverName" TEXT,
                "deliveryReceiverId" TEXT,
                "deliveryPhotosBase64" JSONB,
                billed BOOLEAN DEFAULT false,
                source TEXT,
                "meliOrderId" TEXT,
                "wooOrderId" TEXT,
                "shopifyOrderId" TEXT,
                "jumpsellerOrderId" TEXT,
                "trackingId" TEXT,
                "recipientRut" TEXT,
                "isFlexed" BOOLEAN DEFAULT false,
                "flexedAt" TIMESTAMPTZ,
                "meliDeliveredNeedsPhotos" BOOLEAN DEFAULT false
            );
        `);
        console.log('Table "packages" is ready.');

        // --- PACKAGES: ensure critical columns exist in older schemas ---
        const ensurePackageColumns = async () => {
            const pkgCols = [
                'createdAt TIMESTAMPTZ',
                'updatedAt TIMESTAMPTZ',
                'driverId TEXT',
                'creatorId TEXT',
                'deliveryPhotosBase64 JSONB',
                'billed BOOLEAN DEFAULT false',
                'source TEXT',
                'shopifyOrderId TEXT',
                'wooOrderId TEXT',
                'jumpsellerOrderId TEXT',
                'meliOrderId TEXT',
                'meliSellerId TEXT',
                'meliFlexCode TEXT',
                'trackingId TEXT',
                'recipientEmail TEXT',
                'isFlexed BOOLEAN DEFAULT false',
                'flexedAt TIMESTAMPTZ',
                'destLatitude REAL',
                'destLongitude REAL',
                'destIsApproximate BOOLEAN DEFAULT false',
                'flexLabelPhotoBase64 TEXT',
                'recipientRut TEXT',
                'assignedAt TIMESTAMPTZ',
                'isReassigned BOOLEAN DEFAULT false',
                'sourceAccountId TEXT',
                'sourceAccountName TEXT',
                'alertChecked BOOLEAN DEFAULT false',
                'shopifyOrderNumber TEXT',
                'isDuplicate BOOLEAN DEFAULT false',
                'falabellaOrderId TEXT',
                'falabellaTrackingId TEXT',
                'falabellaDirectLpn TEXT',
                'falabellaDirectOrderNumber TEXT',
                'falabellaDirectLastPushedStatus TEXT',
                'falabellaDirectLastPushedAt TIMESTAMPTZ',
                'falabellaDirectLabelPhotoBase64 TEXT'
            ];
            for (const spec of pkgCols) {
                const col = spec.split(' ')[0];
                try {
                    // EMERGENCY RENAMES: If column exists in lowercase (due to previous bad migration), rename it to camelCase
                    const lowerCol = col.toLowerCase();
                    if (lowerCol !== col) {
                        try {
                            await db.query(`ALTER TABLE packages RENAME COLUMN "${lowerCol}" TO "${col}"`);
                            console.log(`MIGRATION FIXED: Renamed "${lowerCol}" to "${col}" in "packages".`);
                        } catch (e) { /* ignore if column doesn't exist in lowercase */ }
                    }

                    await db.query(`ALTER TABLE packages ADD COLUMN "${col}" ${spec.split(' ').slice(1).join(' ')}`);
                    console.log(`MIGRATION APPLIED: Column "${col}" added to "packages".`);
                } catch (err) {
                    if (err.code !== '42701') { console.error(`Error during packages migration (${col}):`, err); }
                }
            }
        };
        await ensurePackageColumns();

        // --- PREVENT DUPLICATES: Cleanup and Unique Constraints ---
        const ensureUniqueIndexes = async () => {
            const indexConfigs = [
                { col: 'meliOrderId', label: 'Mercado Libre' },
                { col: 'shopifyOrderId', label: 'Shopify' },
                { col: 'jumpsellerOrderId', label: 'Jumpseller' },
                { col: 'wooOrderId', label: 'WooCommerce' }
            ];

            for (const { col, label } of indexConfigs) {
                try {
                    // 1. Cleanup duplicates (keep the latest one)
                    await db.query(`
                        DELETE FROM packages 
                        WHERE id IN (
                            SELECT id FROM (
                                SELECT id, ROW_NUMBER() OVER (PARTITION BY "${col}" ORDER BY "createdAt" DESC) as row_num
                                FROM packages
                                WHERE "${col}" IS NOT NULL
                            ) t WHERE row_num > 1
                        )
                    `);

                    // 2. Add Unique Constraint
                    const constraintName = `uq_${col.toLowerCase()}`;
                    await db.query(`ALTER TABLE packages ADD CONSTRAINT ${constraintName} UNIQUE ("${col}")`);
                    
                    console.log(`STABILITY: Unique constraint for ${label} orders is active.`);
                } catch (err) {
                    // Ignore if constraint already exists
                    if (err.code !== '42710') {
                        console.error(`Error ensuring uniqueness for ${label}:`, err.message);
                    }
                }
            }
        };
        await ensureUniqueIndexes();

        await db.query(`
            CREATE TABLE IF NOT EXISTS tracking_events (
                id SERIAL PRIMARY KEY,
                "packageId" TEXT NOT NULL,
                status TEXT,
                location TEXT,
                details TEXT,
                timestamp TIMESTAMPTZ NOT NULL
            );
        `);
        console.log('Table "tracking_events" is ready.');

        await db.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                id INTEGER PRIMARY KEY,
                "companyName" TEXT,
                "isAppEnabled" BOOLEAN DEFAULT true,
                "requiredPhotos" INTEGER DEFAULT 1,
                "messagingPlan" TEXT DEFAULT 'NONE',
                "pickupMode" TEXT DEFAULT 'SCAN',
                "meliFlexValidation" BOOLEAN DEFAULT true,
                "recipientNotificationsEnabled" BOOLEAN DEFAULT false,
                "saveFlexLabelPhoto" BOOLEAN DEFAULT false,
                "meliAutoImport" BOOLEAN DEFAULT false,
                "shopifyAutoImport" BOOLEAN DEFAULT false,
                "jumpsellerAutoImport" BOOLEAN DEFAULT false,
                "publicTrackingEnabled" BOOLEAN DEFAULT true,
                "isRutRequired" BOOLEAN DEFAULT true,
                "flexDiscrepancyReportEnabled" BOOLEAN DEFAULT true,
                "circuitExportEnabled" BOOLEAN DEFAULT false,
                "meliAutoPromptPhotos" BOOLEAN DEFAULT false,
                "showPendingPaymentAlert" BOOLEAN DEFAULT false,
                "timezone" TEXT DEFAULT 'America/Santiago',
                "licenseLimit" INTEGER DEFAULT 70,
                "licenseOverageFee" NUMERIC DEFAULT 0.1
            );
        `);
        
        // --- MIGRATION SCRIPT ---
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "isAppEnabled" BOOLEAN DEFAULT true');
            console.log('MIGRATION APPLIED: Column "isAppEnabled" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (isAppEnabled):', err); }
        }
         try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "requiredPhotos" INTEGER DEFAULT 1');
            console.log('MIGRATION APPLIED: Column "requiredPhotos" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (requiredPhotos):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "messagingPlan" TEXT DEFAULT \'NONE\'');
            console.log('MIGRATION APPLIED: Column "messagingPlan" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (messagingPlan):', err); }
        }
        try {
            await db.query('ALTER TABLE packages ADD COLUMN "createdAt" TIMESTAMPTZ');
            console.log('MIGRATION APPLIED: Column "createdAt" was added to "packages".');
        } catch (err) {
             if (err.code !== '42701') { console.error('Error during packages migration (createdAt):', err); }
        }

        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "pickupMode" TEXT DEFAULT \'SCAN\'');
            console.log('MIGRATION APPLIED: Column "pickupMode" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (pickupMode):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "publicTrackingEnabled" BOOLEAN DEFAULT true');
            console.log('MIGRATION APPLIED: Column "publicTrackingEnabled" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (publicTrackingEnabled):', err); }
        }

        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "meliFlexValidation" BOOLEAN DEFAULT true');
            console.log('MIGRATION APPLIED: Column "meliFlexValidation" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (meliFlexValidation):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "meliAutoImport" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "meliAutoImport" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (meliAutoImport):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "recipientNotificationsEnabled" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "recipientNotificationsEnabled" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (recipientNotificationsEnabled):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "labelFormat" TEXT DEFAULT \'compact_thermal\'');
            console.log('MIGRATION APPLIED: Column "labelFormat" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (labelFormat):', err); }
        }
        // Drop old columns if they exist. Using IF EXISTS is safer.
        const dropOldPlanColumns = async () => {
            try { await db.query('ALTER TABLE system_settings DROP COLUMN IF EXISTS "planType"'); } catch(e){}
            try { await db.query('ALTER TABLE system_settings DROP COLUMN IF EXISTS "planPackageLimit"'); } catch(e){}
            try { await db.query('ALTER TABLE system_settings DROP COLUMN IF EXISTS "planOverageFee"'); } catch(e){}
            try { await db.query('ALTER TABLE system_settings DROP COLUMN IF EXISTS "planLimits"'); } catch(e){}
            console.log('MIGRATION APPLIED: Old plan-related columns were dropped.');
        };
        await dropOldPlanColumns();
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "saveFlexLabelPhoto" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "saveFlexLabelPhoto" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (saveFlexLabelPhoto):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "meliAutoImport" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "meliAutoImport" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (meliAutoImport):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "isRutRequired" BOOLEAN DEFAULT true');
            console.log('MIGRATION APPLIED: Column "isRutRequired" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (isRutRequired):', err); }
        }
        try {
            await db.query('ALTER TABLE notifications ALTER COLUMN "userId" DROP NOT NULL');
            console.log('MIGRATION APPLIED: Column "userId" in "notifications" is now nullable.');
        } catch (err) {
            console.error('Error during notifications migration (userId nullable):', err);
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "circuitExportEnabled" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "circuitExportEnabled" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (circuitExportEnabled):', err); }
        }

        // --- ACTIVE COMMUNES: New table for managing where we deliver ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS active_communes (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                region TEXT DEFAULT 'Metropolitana',
                "isActive" BOOLEAN DEFAULT true,
                "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Table "active_communes" is ready.');

        // Initial Seed for Communes
        const { rows: existingCommunes } = await db.query('SELECT COUNT(*) FROM active_communes');
        if (parseInt(existingCommunes[0].count) === 0) {
            console.log('Seeding initial active communes...');
            const RM_COMMUNES = [
                "SANTIAGO", "LAS CONDES", "VITACURA", "LO BARNECHEA", "PROVIDENCIA", "ÑUÑOA", "LA REINA", 
                "MACUL", "PEÑALOLÉN", "LA FLORIDA", "SAN JOAQUÍN", "LA GRANJA", "SAN RAMÓN", "LA CISTERNA", 
                "EL BOSQUE", "SAN MIGUEL", "LO ESPEJO", "PEDRO AGUIRRE CERDA", "CERRILLOS", "MAIPÚ", 
                "ESTACIÓN CENTRAL", "QUINTA NORMAL", "LO PRADO", "CERRO NAVIA", "RENCA", "INDEPENDENCIA", 
                "RECOLETA", "CONCHALÍ", "HUECHURABA", "QUILICURA", "PUDAHUEL", "LA PINTANA", "SAN BERNARDO", 
                "PUENTE ALTO", "LAMPA", "COLINA", "BUIN", "PAINE", "PEÑAFLOR", "TALAGANTE", "MELIPILLA", 
                "CURACAVÍ", "PIRQUE", "SAN JOSÉ DE MAIPO", "CALERA DE TANGO", "PADRE HURTADO", "EL MONTE", 
                "ISLA DE MAIPO", "MARÍA PINTO", "SAN PEDRO", "ALHUÉ"
            ];
            for (const name of RM_COMMUNES) {
                await db.query('INSERT INTO active_communes (name, region, "isActive") VALUES ($1, $2, $3)', [name, 'Metropolitana', true]);
            }
        }
        
        // --- DEDUPLICATE ACTIVE COMMUNES (e.g. PEÑALOLÉN vs PEÑALOLEN) ---
        try {
            const { normalizeCommune } = require('./utils/normUtil');
            const { rows: dbCommunes } = await db.query('SELECT id, name, "isActive" FROM active_communes');
            
            const RM_COMMUNES = [
                "SANTIAGO", "LAS CONDES", "VITACURA", "LO BARNECHEA", "PROVIDENCIA", "ÑUÑOA", "LA REINA", 
                "MACUL", "PEÑALOLÉN", "LA FLORIDA", "SAN JOAQUÍN", "LA GRANJA", "SAN RAMÓN", "LA CISTERNA", 
                "EL BOSQUE", "SAN MIGUEL", "LO ESPEJO", "PEDRO AGUIRRE CERDA", "CERRILLOS", "MAIPÚ", 
                "ESTACIÓN CENTRAL", "QUINTA NORMAL", "LO PRADO", "CERRO NAVIA", "RENCA", "INDEPENDENCIA", 
                "RECOLETA", "CONCHALÍ", "HUECHURABA", "QUILICURA", "PUDAHUEL", "LA PINTANA", "SAN BERNARDO", 
                "PUENTE ALTO", "LAMPA", "COLINA", "BUIN", "PAINE", "PEÑAFLOR", "TALAGANTE", "MELIPILLA", 
                "CURACAVÍ", "PIRQUE", "SAN JOSÉ DE MAIPO", "CALERA DE TANGO", "PADRE HURTADO", "EL MONTE", 
                "ISLA DE MAIPO", "MARÍA PINTO", "SAN PEDRO", "ALHUÉ"
            ];

            const groups = {};
            for (const c of dbCommunes) {
                const norm = normalizeCommune(c.name);
                if (!groups[norm]) {
                    groups[norm] = [];
                }
                groups[norm].push(c);
            }

            for (const [normName, list] of Object.entries(groups)) {
                if (list.length > 1) {
                    let bestName = list[0].name;
                    const canonicalMatch = RM_COMMUNES.find(rm => normalizeCommune(rm) === normName);
                    if (canonicalMatch) {
                        bestName = canonicalMatch;
                    }
                    const anyActive = list.some(c => c.isActive);
                    const existingRow = list.find(c => c.name === bestName);
                    if (existingRow) {
                        await db.query('UPDATE active_communes SET "isActive" = $1 WHERE id = $2', [anyActive, existingRow.id]);
                        const toDelete = list.filter(c => c.id !== existingRow.id).map(c => c.id);
                        await db.query('DELETE FROM active_communes WHERE id = ANY($1)', [toDelete]);
                    } else {
                        const first = list[0];
                        await db.query('UPDATE active_communes SET name = $1, "isActive" = $2 WHERE id = $3', [bestName, anyActive, first.id]);
                        const toDelete = list.slice(1).map(c => c.id);
                        if (toDelete.length > 0) {
                            await db.query('DELETE FROM active_communes WHERE id = ANY($1)', [toDelete]);
                        }
                    }
                }
            }
            console.log('✓ active_communes table deduplicated successfully.');
        } catch (dedupErr) {
            console.error('Error deduplicating active_communes:', dedupErr);
        }

        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "shopifyAutoImport" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "shopifyAutoImport" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (shopifyAutoImport):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "jumpsellerAutoImport" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "jumpsellerAutoImport" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (jumpsellerAutoImport):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "timeFormat" TEXT DEFAULT \'12h\'');
            console.log('MIGRATION APPLIED: Column "timeFormat" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (timeFormat):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "allowRedelivery" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "allowRedelivery" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (allowRedelivery):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "timezone" TEXT DEFAULT \'America/Santiago\'');
            console.log('MIGRATION APPLIED: Column "timezone" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (timezone):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "woocommerceAutoImport" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "woocommerceAutoImport" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (woocommerceAutoImport):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "licenseLimit" INTEGER DEFAULT 70');
            console.log('MIGRATION APPLIED: Column "licenseLimit" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (licenseLimit):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "licenseOverageFee" NUMERIC DEFAULT 0.1');
            console.log('MIGRATION APPLIED: Column "licenseOverageFee" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (licenseOverageFee):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "meliAutoPromptPhotos" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "meliAutoPromptPhotos" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (meliAutoPromptPhotos):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "showPendingPaymentAlert" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "showPendingPaymentAlert" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (showPendingPaymentAlert):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "multiSelectEnabled" BOOLEAN DEFAULT true');
            console.log('MIGRATION APPLIED: Column "multiSelectEnabled" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (multiSelectEnabled):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "gisSectorsEnabled" BOOLEAN DEFAULT true');
            console.log('MIGRATION APPLIED: Column "gisSectorsEnabled" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (gisSectorsEnabled):', err); }
        }
        try {
            await db.query('ALTER TABLE packages ADD COLUMN "meliDeliveredNeedsPhotos" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "meliDeliveredNeedsPhotos" was added to "packages".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during packages migration (meliDeliveredNeedsPhotos):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "pendingNotificationsEnabled" BOOLEAN DEFAULT false');
            console.log('MIGRATION APPLIED: Column "pendingNotificationsEnabled" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (pendingNotificationsEnabled):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "adminWhatsappNumber" TEXT DEFAULT \'\'');
            console.log('MIGRATION APPLIED: Column "adminWhatsappNumber" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (adminWhatsappNumber):', err); }
        }
        try {
            await db.query('ALTER TABLE system_settings ADD COLUMN "adminCallmebotApiKey" TEXT DEFAULT \'\'');
            console.log('MIGRATION APPLIED: Column "adminCallmebotApiKey" was added to "system_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during settings migration (adminCallmebotApiKey):', err); }
        }
        // --- END MIGRATION SCRIPT ---

        console.log('Table "system_settings" is ready.');
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS delivery_zones (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                communes JSONB,
                pricing JSONB
            );
        `);
        console.log('Table "delivery_zones" is ready.');

        await db.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                "userId" TEXT,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                type TEXT NOT NULL,
                read BOOLEAN DEFAULT false,
                "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                "relatedId" TEXT
            );
        `);
        console.log('Table "notifications" is ready.');

        // --- NEW PICKUP TABLES ---
        await db.query(`
            INSERT INTO system_settings (id, "companyName", "isAppEnabled", "requiredPhotos", "messagingPlan", "pickupMode", "meliFlexValidation", "saveFlexLabelPhoto", "meliAutoImport", "shopifyAutoImport", "woocommerceAutoImport", "publicTrackingEnabled", "isRutRequired", "flexDiscrepancyReportEnabled", "circuitExportEnabled", "timezone", "licenseLimit", "licenseOverageFee", "meliAutoPromptPhotos", "showPendingPaymentAlert", "multiSelectEnabled", "gisSectorsEnabled")
            VALUES (1, 'FULL ENVIOS', TRUE, 1, 'NONE', 'SCAN', TRUE, FALSE, FALSE, FALSE, FALSE, TRUE, TRUE, TRUE, FALSE, 'America/Santiago', 70, 0.1, FALSE, FALSE, TRUE, TRUE)
            ON CONFLICT (id) DO NOTHING;
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS assignment_events (
                id TEXT PRIMARY KEY,
                "clientId" TEXT NOT NULL,
                "clientName" TEXT NOT NULL,
                "driverId" TEXT,
                "driverName" TEXT,
                "assignedAt" TIMESTAMPTZ NOT NULL,
                "completedAt" TIMESTAMPTZ,
                status TEXT NOT NULL,
                "pickupCost" INTEGER,
                "packagesPickedUp" INTEGER
            );
        `);
        console.log('Table "assignment_events" is ready.');


        await db.query(`
            CREATE TABLE IF NOT EXISTS pickup_runs (
                id TEXT PRIMARY KEY,
                "driverId" TEXT NOT NULL,
                date DATE NOT NULL,
                shift TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Table "pickup_runs" is ready.');

        await db.query(`
            CREATE TABLE IF NOT EXISTS pickup_assignments (
                id TEXT PRIMARY KEY,
                "runId" TEXT NOT NULL REFERENCES pickup_runs(id) ON DELETE CASCADE,
                "clientId" TEXT NOT NULL,
                status TEXT NOT NULL,
                cost INTEGER NOT NULL,
                "packagesToPickup" INTEGER NOT NULL,
                "packagesPickedUp" INTEGER,
                notes TEXT,
                "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Table "pickup_assignments" is ready.');

        // --- NEW INTEGRATIONS TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS integration_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                meli_app_id TEXT,
                meli_client_secret TEXT,
                shopify_shop_url TEXT,
                shopify_access_token TEXT,
                github_token TEXT,
                github_repo TEXT,
                github_owner TEXT,
                whatsapp_api_key TEXT,
                whatsapp_phone_number TEXT,
                woo_url TEXT,
                woo_consumer_key TEXT,
                woo_consumer_secret TEXT,
                falabella_api_key TEXT,
                falabella_seller_id TEXT,
                shopify_webhook_secret TEXT,
                jumpseller_login TEXT,
                jumpseller_token TEXT,
                enviame_api_key TEXT,
                enviame_environment TEXT
            );
        `);
        console.log('Table "integration_settings" is ready.');

        // --- NEW INTEGRATION SYNC QUEUE TABLE ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS integration_sync_queue (
                id SERIAL PRIMARY KEY,
                "packageId" TEXT NOT NULL,
                integration TEXT NOT NULL,
                action TEXT NOT NULL,
                payload JSONB,
                error TEXT,
                attempts INTEGER DEFAULT 1,
                "nextAttemptAt" TIMESTAMPTZ,
                "createdAt" TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('Table "integration_sync_queue" is ready.');

        // --- NETWORK TRAFFIC DAILY HISTORY ---
        // Persisted, per-day aggregate of the in-memory network-metrics ring buffer (which resets
        // on every deploy and only holds the last MAX_RECORDS requests). services/networkMetrics.js
        // flushes into this table periodically; a separate purge job enforces the 3-day retention
        // the user asked for — this is deliberately NOT a raw per-request log (that would grow
        // unbounded), just daily totals per IP.
        await db.query(`
            CREATE TABLE IF NOT EXISTS network_traffic_daily (
                date DATE NOT NULL,
                ip TEXT NOT NULL,
                "requestCount" INTEGER NOT NULL DEFAULT 0,
                "totalMs" BIGINT NOT NULL DEFAULT 0,
                "maxMs" INTEGER NOT NULL DEFAULT 0,
                "errorCount" INTEGER NOT NULL DEFAULT 0,
                "userIds" TEXT[] NOT NULL DEFAULT '{}',
                "firstSeen" TIMESTAMPTZ,
                "lastSeen" TIMESTAMPTZ,
                PRIMARY KEY (date, ip)
            );
        `);
        console.log('Table "network_traffic_daily" is ready.');

        // --- MIGRATIONS: Add Shopify fields ---
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN shopify_client_id TEXT');
            console.log('MIGRATION APPLIED: Column "shopify_client_id" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (shopify_client_id):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN shopify_client_secret TEXT');
            console.log('MIGRATION APPLIED: Column "shopify_client_secret" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (shopify_client_secret):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN shopify_shop_url TEXT');
            console.log('MIGRATION APPLIED: Column "shopify_shop_url" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (shopify_shop_url):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN shopify_access_token TEXT');
            console.log('MIGRATION APPLIED: Column "shopify_access_token" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (shopify_access_token):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN shopify_webhook_secret TEXT');
            console.log('MIGRATION APPLIED: Column "shopify_webhook_secret" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (shopify_webhook_secret):', err); }
        }

        // --- SMTP MIGRATIONS ---
        const smtpCols = [
            'smtp_host TEXT',
            'smtp_port TEXT',
            'smtp_user TEXT',
            'smtp_password TEXT',
            'smtp_from TEXT',
            'smtp_google_refresh_token TEXT',
            'smtp_google_email TEXT'
        ];
        for (const spec of smtpCols) {
            const col = spec.split(' ')[0];
            try {
                await db.query(`ALTER TABLE integration_settings ADD COLUMN "${col}" ${spec.split(' ').slice(1).join(' ')}`);
                console.log(`MIGRATION APPLIED: Column "${col}" added to "integration_settings".`);
            } catch (err) {
                if (err.code !== '42701') { console.error(`Error during integration_settings migration (${col}):`, err); }
            }
        }

        // --- MIGRATIONS: Add GitHub fields ---
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN github_token TEXT');
            console.log('MIGRATION APPLIED: Column "github_token" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (github_token):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN github_repo TEXT');
            console.log('MIGRATION APPLIED: Column "github_repo" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (github_repo):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN github_owner TEXT');
            console.log('MIGRATION APPLIED: Column "github_owner" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (github_owner):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN whatsapp_api_key TEXT');
            console.log('MIGRATION APPLIED: Column "whatsapp_api_key" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (whatsapp_api_key):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN whatsapp_phone_number TEXT');
            console.log('MIGRATION APPLIED: Column "whatsapp_phone_number" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (whatsapp_phone_number):', err); }
        }

        // --- MIGRATIONS: Add WooCommerce fields ---
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN woo_url TEXT');
            console.log('MIGRATION APPLIED: Column "woo_url" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (woo_url):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN woo_consumer_key TEXT');
            console.log('MIGRATION APPLIED: Column "woo_consumer_key" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (woo_consumer_key):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN woo_consumer_secret TEXT');
            console.log('MIGRATION APPLIED: Column "woo_consumer_secret" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (woo_consumer_secret):', err); }
        }

        // --- MIGRATIONS: Add Falabella fields ---
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN falabella_api_key TEXT');
            console.log('MIGRATION APPLIED: Column "falabella_api_key" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (falabella_api_key):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN falabella_seller_id TEXT');
            console.log('MIGRATION APPLIED: Column "falabella_seller_id" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (falabella_seller_id):', err); }
        }

        // --- MIGRATIONS: Add Jumpseller fields ---
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN jumpseller_login TEXT');
            console.log('MIGRATION APPLIED: Column "jumpseller_login" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (jumpseller_login):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN jumpseller_token TEXT');
            console.log('MIGRATION APPLIED: Column "jumpseller_token" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (jumpseller_token):', err); }
        }

        // --- MIGRATIONS: Add Envíame fields ---
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN enviame_api_key TEXT');
            console.log('MIGRATION APPLIED: Column "enviame_api_key" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (enviame_api_key):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN enviame_environment TEXT');
            console.log('MIGRATION APPLIED: Column "enviame_environment" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (enviame_environment):', err); }
        }

        // --- MIGRATIONS: Add Falabella Directo (Courier API) fields ---
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN falabella_direct_client_id TEXT');
            console.log('MIGRATION APPLIED: Column "falabella_direct_client_id" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (falabella_direct_client_id):', err); }
        }
        try {
            await db.query('ALTER TABLE integration_settings ADD COLUMN falabella_direct_client_secret TEXT');
            console.log('MIGRATION APPLIED: Column "falabella_direct_client_secret" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (falabella_direct_client_secret):', err); }
        }
        try {
            await db.query("ALTER TABLE integration_settings ADD COLUMN falabella_direct_environment TEXT DEFAULT 'UAT'");
            console.log('MIGRATION APPLIED: Column "falabella_direct_environment" added to "integration_settings".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during integration_settings migration (falabella_direct_environment):', err); }
        }

        // --- MIGRATIONS: Add missing package fields ---
        try {
            await db.query('ALTER TABLE packages ADD COLUMN "shopifyOrderId" TEXT');
            console.log('MIGRATION APPLIED: Column "shopifyOrderId" added to "packages".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during packages migration (shopifyOrderId):', err); }
        }

        try {
            await db.query('ALTER TABLE packages ADD COLUMN "shopifyOrderNumber" TEXT');
            console.log('MIGRATION APPLIED: Column "shopifyOrderNumber" added to "packages".');
            // Populate with Order ID if number is missing for existing rows
            await db.query('UPDATE packages SET "shopifyOrderNumber" = "shopifyOrderId" WHERE "shopifyOrderNumber" IS NULL AND "shopifyOrderId" IS NOT NULL');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during packages migration (shopifyOrderNumber):', err); }
        }


        // --- MIGRATIONS: Add informed fields to pickup tables ---
        try {
            await db.query('ALTER TABLE pickup_runs ADD COLUMN informed BOOLEAN DEFAULT FALSE');
            console.log('MIGRATION APPLIED: Column "informed" added to "pickup_runs".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during pickup_runs migration (informed):', err); }
        }
        try {
            await db.query('ALTER TABLE pickup_runs ADD COLUMN "informedAt" TIMESTAMPTZ');
            console.log('MIGRATION APPLIED: Column "informedAt" added to "pickup_runs".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during pickup_runs migration (informedAt):', err); }
        }
        try {
            await db.query('ALTER TABLE pickup_assignments ADD COLUMN informed BOOLEAN DEFAULT FALSE');
            console.log('MIGRATION APPLIED: Column "informed" added to "pickup_assignments".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during pickup_assignments migration (informed):', err); }
        }
        try {
            await db.query('ALTER TABLE pickup_assignments ADD COLUMN "informedAt" TIMESTAMPTZ');
            console.log('MIGRATION APPLIED: Column "informedAt" added to "pickup_assignments".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during pickup_assignments migration (informedAt):', err); }
        }
        try {
            await db.query('ALTER TABLE pickup_runs ADD COLUMN shift TEXT');
            console.log('MIGRATION APPLIED: Column "shift" added to "pickup_runs".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during pickup_runs migration (shift):', err); }
        }
        try {
            await db.query('ALTER TABLE pickup_assignments ADD COLUMN "packagesPickedUp" INTEGER');
            console.log('MIGRATION APPLIED: Column "packagesPickedUp" added to "pickup_assignments".');
        } catch (err) {
            if (err.code !== '42701') { console.error('Error during pickup_assignments migration (packagesPickedUp):', err); }
        }

        try {
            await db.query('ALTER TABLE system_logs ADD COLUMN "userId" TEXT');
        } catch(e) {}

        await db.query(`
            CREATE TABLE IF NOT EXISTS system_logs (
                id SERIAL PRIMARY KEY,
                "userId" TEXT,
                "userName" TEXT,
                action TEXT NOT NULL,
                details TEXT,
                timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Table "system_logs" is ready.');
        
        await db.query(`
            CREATE TABLE IF NOT EXISTS daily_closures (
                id SERIAL PRIMARY KEY,
                "driverId" TEXT NOT NULL,
                "driverName" TEXT,
                date DATE NOT NULL,
                "totalPackages" INTEGER DEFAULT 0,
                "deliveredCount" INTEGER DEFAULT 0,
                "pendingCount" INTEGER DEFAULT 0,
                "problemCount" INTEGER DEFAULT 0,
                "cancelledCount" INTEGER DEFAULT 0,
                "closedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                notes TEXT,
                UNIQUE("driverId", date)
            );
        `);
        console.log('Table "daily_closures" is ready.');

        // --- INDEXES FOR PERFORMANCE OPTIMIZATION ---
        console.log('Ensuring database indexes exist...');
        try {
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_driverid ON packages("driverId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_meli_order ON packages("meliOrderId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_meli_flex ON packages("meliFlexCode")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_tracking ON packages("trackingId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_shopify_order ON packages("shopifyOrderId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_jumpseller_order ON packages("jumpsellerOrderId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_woo_order ON packages("wooOrderId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_status ON packages(status)');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_createdat ON packages("createdAt")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_updatedat ON packages("updatedAt")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_estimateddelivery ON packages("estimatedDelivery")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_assignedat ON packages("assignedAt")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_creatorid ON packages("creatorId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_packages_commune ON packages("recipientCommune")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_tracking_events_packageid ON tracking_events("packageId")');
            await db.query('CREATE INDEX IF NOT EXISTS idx_notifications_userid ON notifications("userId")');
            console.log('Database indexes checked and created successfully.');
        } catch (idxErr) {
            console.error('Warning: Failed to ensure database indexes:', idxErr.message);
        }

        // --- TRIGGER MIGRATIONS FOR PACKAGE DATES BETWEEN 00:00 AND 02:00 ---
        try {
            console.log('Ensuring package date adjustment triggers exist...');
            
            // 1. Create or replace the functions
            await db.query(`
                CREATE OR REPLACE FUNCTION adjust_package_timestamps()
                RETURNS TRIGGER AS $$
                DECLARE
                    santiago_hour INTEGER;
                BEGIN
                    IF NEW."createdAt" IS NULL THEN
                        NEW."createdAt" := CURRENT_TIMESTAMP;
                    END IF;
                    IF NEW."updatedAt" IS NULL THEN
                        NEW."updatedAt" := NEW."createdAt";
                    END IF;
                    
                    santiago_hour := EXTRACT(HOUR FROM (NEW."createdAt" AT TIME ZONE 'America/Santiago'));
                    
                    IF santiago_hour < 2 THEN
                        NEW."createdAt" := NEW."createdAt" - INTERVAL '1 day';
                        NEW."updatedAt" := NEW."updatedAt" - INTERVAL '1 day';
                    END IF;
                    
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;
            `);

            await db.query(`
                CREATE OR REPLACE FUNCTION adjust_event_timestamps()
                RETURNS TRIGGER AS $$
                DECLARE
                    santiago_hour INTEGER;
                BEGIN
                    IF NEW.status = 'Creado' THEN
                        IF NEW.timestamp IS NULL THEN
                            NEW.timestamp := CURRENT_TIMESTAMP;
                        END IF;
                        
                        santiago_hour := EXTRACT(HOUR FROM (NEW.timestamp AT TIME ZONE 'America/Santiago'));
                        
                        IF santiago_hour < 2 THEN
                            NEW.timestamp := NEW.timestamp - INTERVAL '1 day';
                        END IF;
                    END IF;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql;
            `);

            // 2. Drop and recreate triggers
            await db.query('DROP TRIGGER IF EXISTS trg_adjust_package_timestamps ON packages');
            await db.query(`
                CREATE TRIGGER trg_adjust_package_timestamps
                BEFORE INSERT ON packages
                FOR EACH ROW
                EXECUTE FUNCTION adjust_package_timestamps()
            `);

            await db.query('DROP TRIGGER IF EXISTS trg_adjust_event_timestamps ON tracking_events');
            await db.query(`
                CREATE TRIGGER trg_adjust_event_timestamps
                BEFORE INSERT ON tracking_events
                FOR EACH ROW
                EXECUTE FUNCTION adjust_event_timestamps()
            `);

            console.log('Package date adjustment triggers set up successfully.');
        } catch (trgErr) {
            console.error('Warning: Failed to set up package date adjustment triggers:', trgErr.message);
        }

        // --- GIS SECTORS: Table for custom GIS sectors ---
        await db.query(`
            CREATE TABLE IF NOT EXISTS gis_sectors (
                id TEXT PRIMARY KEY,
                comuna TEXT NOT NULL,
                sector TEXT NOT NULL,
                geometry JSONB NOT NULL,
                "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                "updatedAt" TIMESTAMPTZ
            );
        `);
        try {
            await db.query('ALTER TABLE gis_sectors ADD COLUMN IF NOT EXISTS color TEXT');
        } catch (err) {
            console.error('Error during gis_sectors migration (color):', err);
        }
        console.log('Table "gis_sectors" is ready.');

        console.log('Database schema initialization complete.');
    } catch (err) {
        console.error('FATAL: Could not initialize database schema.', err);
    }
}

async function ensureAdminUser() {
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash('Dan15223.,.,', salt);

        // Look specifically for the user with email 'admin'
        const { rows } = await db.query("SELECT * FROM users WHERE email = 'admin'");

        if (rows.length > 0) {
            // User 'admin' exists, update its password and ensure role/status are correct
            const adminToUpdate = rows[0];
            console.log(`Admin user 'admin' found. Updating credentials...`);
            await db.query('UPDATE users SET password = $1, role = $2, status = $3 WHERE id = $4', [hashedPassword, 'ADMIN', 'APROBADO', adminToUpdate.id]);
            console.log('Admin user credentials updated.');
        } else {
            // User 'admin' does not exist, create it
            console.log("Default 'admin' user not found. Creating one...");
            const adminUser = {
                id: `user-admin-${uuidv4()}`,
                name: 'Administrador Principal',
                email: 'admin',
                password: hashedPassword,
                role: 'ADMIN',
                status: 'APROBADO',
                phone: '123456789'
            };
            const columns = Object.keys(adminUser).map(k => `"${k}"`).join(', ');
            const values = Object.values(adminUser);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
            await db.query(`INSERT INTO users (${columns}) VALUES (${placeholders})`, values);
            console.log('Default admin user created with username: admin');
        }
    } catch (err) {
        if (err.message && err.message.includes("La base de datos no está configurada")) {
             console.warn('DB not configured. Skipping admin user seed.');
        } else {
             console.error('Error ensuring admin user exists:', err);
        }
    }
}

// PRODUCTION MODE: Data seeding disabled
async function seedDatabase() {
    // In production or after a "Reset Database", we want a clean slate.
    // We return immediately to prevent creating mock data.
    console.log('Data seeding disabled for production/clean mode.');
    return;
}

async function importUsersFromFile() {
    const fs = require('fs');
    const filePath = path.join(__dirname, 'users_data.txt');
    if (!fs.existsSync(filePath)) return;

    console.log('Detectado archivo de datos de usuarios. Iniciando importación...');
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split('\n').filter(l => l.trim() !== '' && l !== '\\.');

        const columns = [
            'id', 'name', 'email', 'phone', 'password', 'role', 'status', 
            'assignedDriverId', 'lastAssignmentTimestamp', 'rut', 'address', 
            'pickupAddress', 'storesInfo', 'pricing', 'clientIdentifier', 
            'pickupCost', 'billingName', 'billingRut', 'billingAddress', 
            'billingCommune', 'billingGiro', 'invoices', 'personalRut', 
            'hasCompany', 'companyName', 'companyRut', 'companyAddress', 
            'licenseExpiry', 'licenseType', 'backgroundCheckNotes', 'vehicles', 
            'driverPermissions', 'latitude', 'longitude', 'lastLocationUpdate', 
            'integrations'
        ];

        for (const line of lines) {
            const fields = line.split('\t');
            const values = fields.slice(0, 36).map(f => {
                const val = f.trim();
                if (val === '\\N' || val === '') return null;
                if (val === 't') return true;
                if (val === 'f') return false;
                return val;
            });

            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
            const query = `INSERT INTO users (${columns.map(c => `"${c}"`).join(', ')}) 
                           VALUES (${placeholders}) 
                           ON CONFLICT (id) DO UPDATE SET 
                           ${columns.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')}`;
            await db.query(query, values);
        }
        console.log(`✅ Importación de ${lines.length} usuarios completada.`);
        // Opcional: borrar el archivo después de importar para no repetir
        // fs.unlinkSync(filePath); 
    } catch (err) {
        console.error('Error durante la importación de usuarios:', err);
    }
}

