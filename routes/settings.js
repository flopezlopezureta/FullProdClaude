
const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const https = require('https');
const bcrypt = require('bcryptjs');
const { logAction } = require('../services/logger');
const meliPollingService = require('../services/meliPollingService');
const shopifyPollingService = require('../services/shopifyPollingService');
const woocommercePollingService = require('../services/woocommercePollingService');
const falabellaPollingService = require('../services/falabellaPollingService');
const { encrypt, decrypt } = require('../services/falabellaCrypto');

// Middleware to check for Admin role
const adminOnly = (req, res, next) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    next();
};

// Ensure system_settings table has fleetControlEnabled column
db.query('ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS "fleetControlEnabled" BOOLEAN DEFAULT TRUE')
  .catch(err => console.error('[DB] Auto-migration fleetControlEnabled notice:', err.message));

// Helper to verify admin password
async function verifyAdminPassword(userId, password) {
    const { rows } = await db.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) return false;
    return await bcrypt.compare(password, rows[0].password);
}






// GET /api/settings/license-status
router.get('/license-status', authMiddleware, async (req, res) => {
    try {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        
        const startMonthStr = `${year}-${String(month).padStart(2, '0')}-01 00:00:00`;
        let nextMonth = month + 1;
        let nextYear = year;
        if (nextMonth > 12) {
            nextMonth = 1;
            nextYear += 1;
        }
        const endMonthStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01 00:00:00`;

        const { rows: settings } = await db.query('SELECT "licenseLimit" FROM system_settings WHERE id = 1');
        const limit = settings.length > 0 ? settings[0].licenseLimit : 70;

        const { rows: nonDrivers } = await db.query(
            `SELECT COUNT(*)::int as count 
             FROM users 
             WHERE role NOT IN ('DRIVER', 'CONDUCTOR', 'CHOFER', 'CLIENT', 'CLIENTE') 
               AND status != 'ELIMINADO'
               AND email NOT IN ('admin', 'admin@admin.cl')`
        );
        const nonDriversCount = nonDrivers[0].count;

        const { rows: activeDrivers } = await db.query(
            `SELECT COUNT(DISTINCT u.id)::int as count
             FROM users u
             WHERE u.role IN ('DRIVER', 'CONDUCTOR', 'CHOFER')
               AND u.status != 'ELIMINADO'
               AND u.email NOT IN ('admin', 'admin@admin.cl')
               AND EXISTS (
                   SELECT 1 FROM packages p
                   WHERE p."driverId" = u.id
                     AND (
                         (p."assignedAt" >= $1 AND p."assignedAt" < $2)
                         OR (p."updatedAt" >= $1 AND p."updatedAt" < $2 AND p.status IN ('ENTREGADO', 'DEVUELTO', 'EN_RUTA', 'ASIGNADO'))
                     )
               )`,
            [startMonthStr, endMonthStr]
        );
        const driversCount = activeDrivers[0].count;

        const activeCount = nonDriversCount + driversCount;

        res.json({
            activeCount,
            limit,
            exceeded: activeCount > limit
        });
    } catch (err) {
        console.error('Error fetching license status:', err);
        res.status(500).json({ message: 'Error al obtener estado de licencias.' });
    }
});

// GET /api/settings/meli-polling-status
router.get('/meli-polling-status', authMiddleware, (req, res) => {
    res.json(meliPollingService.getStatus());
});



// GET /api/settings/shopify-polling-status
router.get('/shopify-polling-status', authMiddleware, (req, res) => {
    res.json(shopifyPollingService.getStatus());
});

// POST /api/settings/sync-meli
router.post('/sync-meli', authMiddleware, adminOnly, async (req, res) => {
    console.log('[ManualSync] Triggering Mercado Libre poll...');
    // We run it without awaiting to avoid blocking the response, but the service handles concurrency
    meliPollingService.pollMeliPackages();
    res.json({ message: 'Sincronización con Mercado Libre iniciada en segundo plano.' });
});

// POST /api/settings/sync-shopify
router.post('/sync-shopify', authMiddleware, adminOnly, async (req, res) => {
    console.log('[ManualSync] Triggering Shopify poll...');
    shopifyPollingService.pollShopifyPackages();
    res.json({ message: 'Sincronización con Shopify iniciada en segundo plano.' });
});

// GET /api/settings/woocommerce-polling-status
router.get('/woocommerce-polling-status', authMiddleware, (req, res) => {
    res.json(woocommercePollingService.getStatus());
});

// POST /api/settings/sync-woocommerce
router.post('/sync-woocommerce', authMiddleware, adminOnly, async (req, res) => {
    console.log('[ManualSync] Triggering WooCommerce poll...');
    woocommercePollingService.pollWooCommercePackages();
    res.json({ message: 'Sincronización con WooCommerce iniciada en segundo plano.' });
});

// GET /api/settings/falabella-polling-status
router.get('/falabella-polling-status', authMiddleware, (req, res) => {
    res.json(falabellaPollingService.getStatus());
});

// POST /api/settings/sync-falabella
router.post('/sync-falabella', authMiddleware, adminOnly, async (req, res) => {
    console.log('[ManualSync] Triggering Falabella poll...');
    falabellaPollingService.pollFalabellaPackages();
    res.json({ message: 'Sincronización con Falabella iniciada en segundo plano.' });
});

// GET /api/settings/system
router.get('/system', async (req, res) => {
    try {
        const { rows: settings } = await db.query('SELECT "companyName", "isAppEnabled", "requiredPhotos", "messagingPlan", "pickupMode", "meliFlexValidation", "saveFlexLabelPhoto", "meliAutoImport", "shopifyAutoImport", "woocommerceAutoImport", "falabellaAutoImport", "publicTrackingEnabled", "isRutRequired", "flexDiscrepancyReportEnabled", "labelFormat", "circuitExportEnabled", "timeFormat", "allowRedelivery", "timezone", "recipientNotificationsEnabled", "meliAutoPromptPhotos", "licenseLimit", "licenseOverageFee", "showPendingPaymentAlert", "multiSelectEnabled", "gisSectorsEnabled", "fleetControlEnabled", "pendingNotificationsEnabled", "adminWhatsappNumber", "adminCallmebotApiKey" FROM system_settings WHERE id = 1');
        const fallbackSettings = {
            companyName: 'FULL ENVIOS',
            isAppEnabled: true,
            requiredPhotos: 1,
            messagingPlan: 'NONE',
            pickupMode: 'SCAN',
            meliFlexValidation: true,
            saveFlexLabelPhoto: false,
            meliAutoImport: false,
            shopifyAutoImport: false,
            woocommerceAutoImport: false,
            falabellaAutoImport: false,
            publicTrackingEnabled: true,
            isRutRequired: true,
            flexDiscrepancyReportEnabled: true,
            labelFormat: 'compact_thermal',
            circuitExportEnabled: false,
            timeFormat: '12h',
            allowRedelivery: false,
            timezone: 'America/Santiago',
            recipientNotificationsEnabled: false,
            meliAutoPromptPhotos: false,
            licenseLimit: 70,
            licenseOverageFee: 0.1,
            showPendingPaymentAlert: false,
            multiSelectEnabled: true,
            gisSectorsEnabled: true,
            fleetControlEnabled: true,
            pendingNotificationsEnabled: false,
            adminWhatsappNumber: '',
            adminCallmebotApiKey: '',
        };
        if (settings.length === 0) {
            return res.json({ ...fallbackSettings, appEnv: process.env.APP_ENV || 'production' });
        }
        res.json({ ...fallbackSettings, ...settings[0], appEnv: process.env.APP_ENV || 'production' });
    } catch (err) {
        console.error("ERROR in /api/settings/system:", err);
        // Fail gracefully if DB not ready
        res.json({ companyName: 'FULL ENVIOS', isAppEnabled: true, requiredPhotos: 1, messagingPlan: 'NONE', pickupMode: 'SCAN', meliFlexValidation: true, labelFormat: 'compact_thermal', timeFormat: '12h', allowRedelivery: false, meliAutoPromptPhotos: false, licenseLimit: 70, licenseOverageFee: 0.1, multiSelectEnabled: true, fleetControlEnabled: true, pendingNotificationsEnabled: false, adminWhatsappNumber: '', adminCallmebotApiKey: '' });
    }
});

// PUT /api/settings/system
router.put('/system', authMiddleware, adminOnly, async (req, res) => {
    const { companyName, isAppEnabled, requiredPhotos, messagingPlan, pickupMode, meliFlexValidation, saveFlexLabelPhoto, meliAutoImport, shopifyAutoImport, woocommerceAutoImport, falabellaAutoImport, publicTrackingEnabled, isRutRequired, flexDiscrepancyReportEnabled, labelFormat, circuitExportEnabled, timeFormat, allowRedelivery, timezone, recipientNotificationsEnabled, meliAutoPromptPhotos, licenseLimit, licenseOverageFee, showPendingPaymentAlert, multiSelectEnabled, gisSectorsEnabled, fleetControlEnabled, pendingNotificationsEnabled, adminWhatsappNumber, adminCallmebotApiKey } = req.body;

    try {
        const { rows: currentSettingsRows } = await db.query('SELECT * FROM system_settings WHERE id = 1');

        if (currentSettingsRows.length > 0) {
            const currentSettings = currentSettingsRows[0];
            const updatedSettings = {
                companyName: companyName !== undefined ? companyName : currentSettings.companyName,
                isAppEnabled: isAppEnabled !== undefined ? isAppEnabled : currentSettings.isAppEnabled,
                requiredPhotos: requiredPhotos !== undefined ? requiredPhotos : currentSettings.requiredPhotos,
                messagingPlan: messagingPlan !== undefined ? messagingPlan : currentSettings.messagingPlan,
                pickupMode: pickupMode !== undefined ? pickupMode : currentSettings.pickupMode,
                meliFlexValidation: meliFlexValidation !== undefined ? meliFlexValidation : currentSettings.meliFlexValidation,
                saveFlexLabelPhoto: saveFlexLabelPhoto !== undefined ? saveFlexLabelPhoto : currentSettings.saveFlexLabelPhoto,
                meliAutoImport: meliAutoImport !== undefined ? meliAutoImport : currentSettings.meliAutoImport,
                shopifyAutoImport: shopifyAutoImport !== undefined ? shopifyAutoImport : currentSettings.shopifyAutoImport,
                woocommerceAutoImport: woocommerceAutoImport !== undefined ? woocommerceAutoImport : currentSettings.woocommerceAutoImport,
                falabellaAutoImport: falabellaAutoImport !== undefined ? falabellaAutoImport : currentSettings.falabellaAutoImport,
                publicTrackingEnabled: publicTrackingEnabled !== undefined ? publicTrackingEnabled : currentSettings.publicTrackingEnabled,
                isRutRequired: isRutRequired !== undefined ? isRutRequired : currentSettings.isRutRequired,
                flexDiscrepancyReportEnabled: flexDiscrepancyReportEnabled !== undefined ? flexDiscrepancyReportEnabled : currentSettings.flexDiscrepancyReportEnabled,
                labelFormat: labelFormat !== undefined ? labelFormat : currentSettings.labelFormat,
                circuitExportEnabled: circuitExportEnabled !== undefined ? circuitExportEnabled : currentSettings.circuitExportEnabled,
                timeFormat: timeFormat !== undefined ? timeFormat : currentSettings.timeFormat,
                allowRedelivery: allowRedelivery !== undefined ? allowRedelivery : currentSettings.allowRedelivery,
                timezone: timezone !== undefined ? timezone : currentSettings.timezone,
                recipientNotificationsEnabled: recipientNotificationsEnabled !== undefined ? recipientNotificationsEnabled : currentSettings.recipientNotificationsEnabled,
                meliAutoPromptPhotos: meliAutoPromptPhotos !== undefined ? meliAutoPromptPhotos : currentSettings.meliAutoPromptPhotos,
                licenseLimit: licenseLimit !== undefined ? licenseLimit : currentSettings.licenseLimit,
                licenseOverageFee: licenseOverageFee !== undefined ? licenseOverageFee : currentSettings.licenseOverageFee,
                showPendingPaymentAlert: showPendingPaymentAlert !== undefined ? showPendingPaymentAlert : currentSettings.showPendingPaymentAlert,
                multiSelectEnabled: multiSelectEnabled !== undefined ? multiSelectEnabled : currentSettings.multiSelectEnabled,
                gisSectorsEnabled: gisSectorsEnabled !== undefined ? gisSectorsEnabled : currentSettings.gisSectorsEnabled,
                fleetControlEnabled: fleetControlEnabled !== undefined ? fleetControlEnabled : currentSettings.fleetControlEnabled,
                pendingNotificationsEnabled: pendingNotificationsEnabled !== undefined ? pendingNotificationsEnabled : currentSettings.pendingNotificationsEnabled,
                adminWhatsappNumber: adminWhatsappNumber !== undefined ? adminWhatsappNumber : currentSettings.adminWhatsappNumber,
                adminCallmebotApiKey: adminCallmebotApiKey !== undefined ? adminCallmebotApiKey : currentSettings.adminCallmebotApiKey,
            };

            await db.query(
                'UPDATE system_settings SET "companyName" = $1, "isAppEnabled" = $2, "requiredPhotos" = $3, "messagingPlan" = $4, "pickupMode" = $5, "meliFlexValidation" = $6, "saveFlexLabelPhoto" = $7, "meliAutoImport" = $8, "shopifyAutoImport" = $9, "woocommerceAutoImport" = $10, "falabellaAutoImport" = $11, "publicTrackingEnabled" = $12, "isRutRequired" = $13, "flexDiscrepancyReportEnabled" = $14, "labelFormat" = $15, "circuitExportEnabled" = $16, "timeFormat" = $17, "allowRedelivery" = $18, "timezone" = $19, "recipientNotificationsEnabled" = $20, "meliAutoPromptPhotos" = $21, "licenseLimit" = $22, "licenseOverageFee" = $23, "showPendingPaymentAlert" = $24, "multiSelectEnabled" = $25, "gisSectorsEnabled" = $26, "fleetControlEnabled" = $27, "pendingNotificationsEnabled" = $28, "adminWhatsappNumber" = $29, "adminCallmebotApiKey" = $30 WHERE id = 1',
                [updatedSettings.companyName, updatedSettings.isAppEnabled, updatedSettings.requiredPhotos, updatedSettings.messagingPlan, updatedSettings.pickupMode, updatedSettings.meliFlexValidation, updatedSettings.saveFlexLabelPhoto, updatedSettings.meliAutoImport, updatedSettings.shopifyAutoImport, updatedSettings.woocommerceAutoImport, updatedSettings.falabellaAutoImport, updatedSettings.publicTrackingEnabled, updatedSettings.isRutRequired, updatedSettings.flexDiscrepancyReportEnabled, updatedSettings.labelFormat, updatedSettings.circuitExportEnabled, updatedSettings.timeFormat, updatedSettings.allowRedelivery, updatedSettings.timezone, updatedSettings.recipientNotificationsEnabled, updatedSettings.meliAutoPromptPhotos, updatedSettings.licenseLimit, updatedSettings.licenseOverageFee, updatedSettings.showPendingPaymentAlert, updatedSettings.multiSelectEnabled, updatedSettings.gisSectorsEnabled, updatedSettings.fleetControlEnabled, updatedSettings.pendingNotificationsEnabled, updatedSettings.adminWhatsappNumber, updatedSettings.adminCallmebotApiKey]
            );

            await logAction(req.user.id, req.user.name, 'UPDATE_SYSTEM_SETTINGS', { updatedSettings });

            res.json(updatedSettings);

        } else {
            const updatedSettings = {
                companyName: companyName !== undefined ? companyName : 'FULL ENVIOS',
                isAppEnabled: isAppEnabled !== undefined ? isAppEnabled : true,
                requiredPhotos: requiredPhotos !== undefined ? requiredPhotos : 1,
                messagingPlan: messagingPlan !== undefined ? messagingPlan : 'NONE',
                pickupMode: pickupMode !== undefined ? pickupMode : 'SCAN',
                meliFlexValidation: meliFlexValidation !== undefined ? meliFlexValidation : true,
                saveFlexLabelPhoto: saveFlexLabelPhoto !== undefined ? saveFlexLabelPhoto : false,
                meliAutoImport: meliAutoImport !== undefined ? meliAutoImport : false,
                shopifyAutoImport: shopifyAutoImport !== undefined ? shopifyAutoImport : false,
                woocommerceAutoImport: woocommerceAutoImport !== undefined ? woocommerceAutoImport : false,
                falabellaAutoImport: falabellaAutoImport !== undefined ? falabellaAutoImport : false,
                publicTrackingEnabled: publicTrackingEnabled !== undefined ? publicTrackingEnabled : true,
                isRutRequired: isRutRequired !== undefined ? isRutRequired : true,
                flexDiscrepancyReportEnabled: flexDiscrepancyReportEnabled !== undefined ? flexDiscrepancyReportEnabled : true,
                labelFormat: labelFormat !== undefined ? labelFormat : 'compact_thermal',
                circuitExportEnabled: circuitExportEnabled !== undefined ? circuitExportEnabled : false,
                timeFormat: timeFormat !== undefined ? timeFormat : '12h',
                allowRedelivery: allowRedelivery !== undefined ? allowRedelivery : false,
                timezone: timezone !== undefined ? timezone : 'America/Santiago',
                recipientNotificationsEnabled: recipientNotificationsEnabled !== undefined ? recipientNotificationsEnabled : false,
                meliAutoPromptPhotos: meliAutoPromptPhotos !== undefined ? meliAutoPromptPhotos : false,
                licenseLimit: licenseLimit !== undefined ? licenseLimit : 70,
                licenseOverageFee: licenseOverageFee !== undefined ? licenseOverageFee : 0.1,
                showPendingPaymentAlert: showPendingPaymentAlert !== undefined ? showPendingPaymentAlert : false,
                multiSelectEnabled: multiSelectEnabled !== undefined ? multiSelectEnabled : true,
                gisSectorsEnabled: gisSectorsEnabled !== undefined ? gisSectorsEnabled : true,
                fleetControlEnabled: fleetControlEnabled !== undefined ? fleetControlEnabled : true,
                pendingNotificationsEnabled: pendingNotificationsEnabled !== undefined ? pendingNotificationsEnabled : false,
                adminWhatsappNumber: adminWhatsappNumber !== undefined ? adminWhatsappNumber : '',
                adminCallmebotApiKey: adminCallmebotApiKey !== undefined ? adminCallmebotApiKey : '',
            };

            await db.query(
                'INSERT INTO system_settings (id, "companyName", "isAppEnabled", "requiredPhotos", "messagingPlan", "pickupMode", "meliFlexValidation", "saveFlexLabelPhoto", "meliAutoImport", "shopifyAutoImport", "woocommerceAutoImport", "falabellaAutoImport", "publicTrackingEnabled", "isRutRequired", "flexDiscrepancyReportEnabled", "labelFormat", "circuitExportEnabled", "timeFormat", "allowRedelivery", "timezone", "recipientNotificationsEnabled", "meliAutoPromptPhotos", "licenseLimit", "licenseOverageFee", "showPendingPaymentAlert", "multiSelectEnabled", "gisSectorsEnabled", "fleetControlEnabled", "pendingNotificationsEnabled", "adminWhatsappNumber", "adminCallmebotApiKey") VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)',
                [updatedSettings.companyName, updatedSettings.isAppEnabled, updatedSettings.requiredPhotos, updatedSettings.messagingPlan, updatedSettings.pickupMode, updatedSettings.meliFlexValidation, updatedSettings.saveFlexLabelPhoto, updatedSettings.meliAutoImport, updatedSettings.shopifyAutoImport, updatedSettings.woocommerceAutoImport, updatedSettings.falabellaAutoImport, updatedSettings.publicTrackingEnabled, updatedSettings.isRutRequired, updatedSettings.flexDiscrepancyReportEnabled, updatedSettings.labelFormat, updatedSettings.circuitExportEnabled, updatedSettings.timeFormat, updatedSettings.allowRedelivery, updatedSettings.timezone, updatedSettings.recipientNotificationsEnabled, updatedSettings.meliAutoPromptPhotos, updatedSettings.licenseLimit, updatedSettings.licenseOverageFee, updatedSettings.showPendingPaymentAlert, updatedSettings.multiSelectEnabled, updatedSettings.gisSectorsEnabled, updatedSettings.fleetControlEnabled, updatedSettings.pendingNotificationsEnabled, updatedSettings.adminWhatsappNumber, updatedSettings.adminCallmebotApiKey]
            );

            await logAction(req.user.id, req.user.name, 'CREATE_SYSTEM_SETTINGS', { updatedSettings });

            res.status(201).json(updatedSettings);
        }
    } catch (err) {
        console.error('Error updating system settings:', err);
        res.status(500).json({ message: 'Error al actualizar la configuración del sistema.' });
    }
});

// POST /api/settings/sync-meli
router.post('/sync-meli', authMiddleware, adminOnly, async (req, res) => {
    try {
        await meliPollingService.triggerSync();
        res.json({ message: 'Sincronización de Mercado Libre iniciada en segundo plano.' });
    } catch (err) {
        console.error('Error triggering ML sync:', err);
        res.status(500).json({ message: 'Error al iniciar sincronización de ML.' });
    }
});

// POST /api/settings/sync-shopify
router.post('/sync-shopify', authMiddleware, adminOnly, async (req, res) => {
    try {
        await shopifyPollingService.triggerSync();
        res.json({ message: 'Sincronización de Shopify iniciada en segundo plano.' });
    } catch (err) {
        console.error('Error triggering Shopify sync:', err);
        res.status(500).json({ message: 'Error al iniciar sincronización de Shopify.' });
    }
});

// POST /api/settings/reset-database
router.post('/reset-database', authMiddleware, adminOnly, async (req, res) => {
    const { password } = req.body;
    
    if (!(await verifyAdminPassword(req.user.id, password))) {
        return res.status(403).json({ message: 'Contraseña de administrador incorrecta.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE tracking_events, packages, assignment_events, pickup_assignments, pickup_runs RESTART IDENTITY CASCADE');
        await client.query(`UPDATE users SET "assignedDriverId" = NULL, "lastAssignmentTimestamp" = NULL, "invoices" = '[]'::jsonb`);
        await client.query("DELETE FROM users WHERE email != 'admin'");
        await client.query('COMMIT');

        await logAction(req.user.id, req.user.name, 'RESET_DATABASE', { details: 'Full database reset' });

        res.status(200).json({ message: 'Sistema limpio para producción.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error al limpiar la base de datos.' });
    } finally {
        client.release();
    }
});

// POST /api/settings/reset-packages
router.post('/reset-packages', authMiddleware, adminOnly, async (req, res) => {
    const { password } = req.body;
    if (!(await verifyAdminPassword(req.user.id, password))) {
        return res.status(403).json({ message: 'Contraseña de administrador incorrecta.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE tracking_events, packages RESTART IDENTITY CASCADE');
        await client.query('COMMIT');

        await logAction(req.user.id, req.user.name, 'RESET_PACKAGES', { details: 'All packages and tracking events deleted' });

        res.status(200).json({ message: 'Paquetes e historial eliminados con éxito.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar paquetes.' });
    } finally {
        client.release();
    }
});

// POST /api/settings/reset-clients
router.post('/reset-clients', authMiddleware, adminOnly, async (req, res) => {
    const { password } = req.body;
    if (!(await verifyAdminPassword(req.user.id, password))) {
        return res.status(403).json({ message: 'Contraseña de administrador incorrecta.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        // First remove assignments related to clients
        await client.query("DELETE FROM assignment_events WHERE \"clientId\" IN (SELECT id FROM users WHERE role = 'CLIENT')");
        await client.query("DELETE FROM pickup_assignments WHERE \"clientId\" IN (SELECT id FROM users WHERE role = 'CLIENT')");
        // Then delete clients
        await client.query("DELETE FROM users WHERE role = 'CLIENT'");
        await client.query('COMMIT');

        await logAction(req.user.id, req.user.name, 'RESET_CLIENTS', { details: 'All clients deleted' });

        res.status(200).json({ message: 'Clientes eliminados con éxito.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar clientes.' });
    } finally {
        client.release();
    }
});

// POST /api/settings/reset-drivers
router.post('/reset-drivers', authMiddleware, adminOnly, async (req, res) => {
    const { password } = req.body;
    if (!(await verifyAdminPassword(req.user.id, password))) {
        return res.status(403).json({ message: 'Contraseña de administrador incorrecta.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        // Unassign packages from drivers
        await client.query('UPDATE packages SET "driverId" = NULL');
        // Delete runs and assignments
        await client.query('TRUNCATE TABLE assignment_events, pickup_assignments, pickup_runs RESTART IDENTITY CASCADE');
        // Delete drivers
        await client.query("DELETE FROM users WHERE role = 'DRIVER'");
        await client.query('COMMIT');

        await logAction(req.user.id, req.user.name, 'RESET_DRIVERS', { details: 'All drivers deleted' });

        res.status(200).json({ message: 'Conductores y auxiliares eliminados con éxito.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar conductores.' });
    } finally {
        client.release();
    }
});

// POST /api/settings/reset-zones
router.post('/reset-zones', authMiddleware, adminOnly, async (req, res) => {
    const { password } = req.body;
    if (!(await verifyAdminPassword(req.user.id, password))) {
        return res.status(403).json({ message: 'Contraseña de administrador incorrecta.' });
    }

    try {
        await db.query('TRUNCATE TABLE delivery_zones RESTART IDENTITY CASCADE');
        
        await logAction(req.user.id, req.user.name, 'RESET_ZONES', { details: 'All delivery zones deleted' });

        res.status(200).json({ message: 'Zonas de entrega eliminadas con éxito.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al eliminar zonas.' });
    }
});

// POST /api/settings/reset-invoices
router.post('/reset-invoices', authMiddleware, adminOnly, async (req, res) => {
    const { password } = req.body;
    if (!(await verifyAdminPassword(req.user.id, password))) {
        return res.status(403).json({ message: 'Contraseña de administrador incorrecta.' });
    }

    try {
        await db.query("UPDATE users SET invoices = '[]'::jsonb, \"pickupCost\" = 0");
        await db.query("UPDATE packages SET billed = false");

        await logAction(req.user.id, req.user.name, 'RESET_INVOICES', { details: 'Billing history reset' });

        res.status(200).json({ message: 'Historial de facturación reiniciado con éxito.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al reiniciar facturación.' });
    }
});

// GET /api/settings/integrations
router.get('/integrations', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT meli_app_id, meli_client_secret, shopify_client_id, shopify_client_secret, shopify_shop_url, shopify_access_token, github_token, github_repo, github_owner, woo_url, woo_consumer_key, woo_consumer_secret, falabella_api_key, falabella_seller_id, falabella_direct_client_id, falabella_direct_client_secret, falabella_direct_environment, smtp_host, smtp_port, smtp_user, smtp_password, smtp_from, smtp_google_refresh_token, smtp_google_email, enviame_api_key, enviame_environment FROM integration_settings WHERE id = 1');
        if (rows.length === 0) return res.json({});
        res.json({ 
            meliAppId: rows[0].meli_app_id,
            meliClientSecret: rows[0].meli_client_secret,
            shopifyClientId: rows[0].shopify_client_id,
            shopifyClientSecret: rows[0].shopify_client_secret,
            shopifyShopUrl: rows[0].shopify_shop_url,
            shopifyAccessToken: rows[0].shopify_access_token,
            githubToken: rows[0].github_token,
            githubRepo: rows[0].github_repo,
            githubOwner: rows[0].github_owner,
            wooUrl: rows[0].woo_url,
            wooConsumerKey: rows[0].woo_consumer_key,
            wooConsumerSecret: rows[0].woo_consumer_secret,
            falabellaApiKey: rows[0].falabella_api_key ? '************************' : '',
            falabellaSellerId: rows[0].falabella_seller_id,
            falabellaDirectClientId: rows[0].falabella_direct_client_id || '',
            falabellaDirectClientSecret: rows[0].falabella_direct_client_secret ? '************************' : '',
            falabellaDirectEnvironment: rows[0].falabella_direct_environment || 'UAT',
            smtpFrom: rows[0].smtp_from,
            smtpGoogleEmail: rows[0].smtp_google_email,
            hasGoogleSmtp: !!rows[0].smtp_google_refresh_token,
            enviameApiKey: rows[0].enviame_api_key ? '************************' : '',
            enviameEnvironment: rows[0].enviame_environment || 'stage'
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al obtener configuración de integraciones.' });
    }
});

// PUT /api/settings/integrations
router.put('/integrations', authMiddleware, adminOnly, async (req, res) => {
    const { 
        meliAppId, meliClientSecret, 
        shopifyClientId, shopifyClientSecret,
        shopifyShopUrl, shopifyAccessToken, 
        githubToken, githubRepo, githubOwner,
        wooUrl, wooConsumerKey, wooConsumerSecret,
        falabellaApiKey, falabellaSellerId,
        falabellaDirectClientId, falabellaDirectClientSecret, falabellaDirectEnvironment,
        smtpHost, smtpPort, smtpUser, smtpPassword, smtpFrom,
        enviameApiKey, enviameEnvironment
    } = req.body;

    try {
        // Ensure the row exists
        await db.query(`INSERT INTO integration_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

        const updates = [];
        const values = [];
        let idx = 1;

        if (meliAppId !== undefined) {
            updates.push(`meli_app_id = $${idx++}`);
            values.push(meliAppId);
        }
        if (meliClientSecret !== undefined) {
            updates.push(`meli_client_secret = $${idx++}`);
            values.push(meliClientSecret);
        }
        if (shopifyClientId !== undefined) {
            updates.push(`shopify_client_id = $${idx++}`);
            values.push(shopifyClientId);
        }
        if (shopifyClientSecret !== undefined) {
            updates.push(`shopify_client_secret = $${idx++}`);
            values.push(shopifyClientSecret);
        }
        if (shopifyShopUrl !== undefined) {
            updates.push(`shopify_shop_url = $${idx++}`);
            values.push(shopifyShopUrl);
        }
        if (shopifyAccessToken !== undefined) {
            updates.push(`shopify_access_token = $${idx++}`);
            values.push(shopifyAccessToken);
        }
        if (githubToken !== undefined) {
            updates.push(`github_token = $${idx++}`);
            values.push(githubToken);
        }
        if (githubRepo !== undefined) {
            updates.push(`github_repo = $${idx++}`);
            values.push(githubRepo);
        }
        if (githubOwner !== undefined) {
            updates.push(`github_owner = $${idx++}`);
            values.push(githubOwner);
        }
        if (wooUrl !== undefined) {
            updates.push(`woo_url = $${idx++}`);
            values.push(wooUrl);
        }
        if (wooConsumerKey !== undefined) {
            updates.push(`woo_consumer_key = $${idx++}`);
            values.push(wooConsumerKey);
        }
        if (wooConsumerSecret !== undefined) {
            updates.push(`woo_consumer_secret = $${idx++}`);
            values.push(wooConsumerSecret);
        }
        if (falabellaApiKey !== undefined && falabellaApiKey !== '************************') {
            updates.push(`falabella_api_key = $${idx++}`);
            values.push(encrypt(falabellaApiKey));
        }
        if (falabellaSellerId !== undefined) {
            updates.push(`falabella_seller_id = $${idx++}`);
            values.push(falabellaSellerId);
        }
        if (falabellaDirectClientId !== undefined) {
            updates.push(`falabella_direct_client_id = $${idx++}`);
            values.push(falabellaDirectClientId);
        }
        if (falabellaDirectClientSecret !== undefined && falabellaDirectClientSecret !== '************************') {
            updates.push(`falabella_direct_client_secret = $${idx++}`);
            values.push(encrypt(falabellaDirectClientSecret));
        }
        if (falabellaDirectEnvironment !== undefined) {
            updates.push(`falabella_direct_environment = $${idx++}`);
            values.push(falabellaDirectEnvironment);
        }
        if (smtpHost !== undefined) {
            updates.push(`smtp_host = $${idx++}`);
            values.push(smtpHost);
        }
        if (smtpPort !== undefined) {
            updates.push(`smtp_port = $${idx++}`);
            values.push(smtpPort);
        }
        if (smtpUser !== undefined) {
            updates.push(`smtp_user = $${idx++}`);
            values.push(smtpUser);
        }
        if (smtpPassword !== undefined) {
            updates.push(`smtp_password = $${idx++}`);
            values.push(smtpPassword);
        }
        if (smtpFrom !== undefined) {
            updates.push(`smtp_from = $${idx++}`);
            values.push(smtpFrom);
        }
        if (enviameApiKey !== undefined && enviameApiKey !== '************************') {
            updates.push(`enviame_api_key = $${idx++}`);
            values.push(encrypt(enviameApiKey));
        }
        if (enviameEnvironment !== undefined) {
            updates.push(`enviame_environment = $${idx++}`);
            values.push(enviameEnvironment);
        }

        if (updates.length > 0) {
            const query = `UPDATE integration_settings SET ${updates.join(', ')} WHERE id = 1 RETURNING *`;
            const { rows } = await db.query(query, values);
            
            await logAction(req.user.id, req.user.name, 'UPDATE_INTEGRATIONS', { updatedFields: updates });

            const saved = rows[0];
            res.status(200).json({
                meliAppId: saved.meli_app_id,
                meliClientSecret: saved.meli_client_secret,
                shopifyClientId: saved.shopify_client_id,
                shopifyClientSecret: saved.shopify_client_secret,
                shopifyShopUrl: saved.shopify_shop_url,
                shopifyAccessToken: saved.shopify_access_token,
                githubToken: saved.github_token,
                githubRepo: saved.github_repo,
                githubOwner: saved.github_owner,
                wooUrl: saved.woo_url,
                wooConsumerKey: saved.woo_consumer_key,
                wooConsumerSecret: saved.woo_consumer_secret,
                falabellaApiKey: saved.falabella_api_key ? '************************' : '',
                falabellaSellerId: saved.falabella_seller_id,
                falabellaDirectClientId: saved.falabella_direct_client_id || '',
                falabellaDirectClientSecret: saved.falabella_direct_client_secret ? '************************' : '',
                falabellaDirectEnvironment: saved.falabella_direct_environment || 'UAT',
                smtpFrom: saved.smtp_from,
                smtpGoogleEmail: saved.smtp_google_email,
                hasGoogleSmtp: !!saved.smtp_google_refresh_token,
                enviameApiKey: saved.enviame_api_key ? '************************' : '',
                enviameEnvironment: saved.enviame_environment || 'stage'
            });
        } else {
            res.status(200).json({ message: "No se enviaron cambios." });
        }
    } catch (err) {
        console.error('Error in PUT /api/settings/integrations:', err);
        res.status(500).json({ message: 'Error al guardar la configuración de integraciones.' });
    }
});

// POST /api/settings/test-meli
router.post('/test-meli', authMiddleware, adminOnly, async (req, res) => {
    const { meliAppId, meliClientSecret } = req.body;

    if (!meliAppId || !meliClientSecret) {
        return res.status(400).json({ message: 'App ID y Client Secret son requeridos.' });
    }

    const postData = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: meliAppId,
        client_secret: meliClientSecret
    }).toString();

    const options = {
        hostname: 'api.mercadolibre.com',
        path: '/oauth/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': postData.length
        }
    };

    const reqApi = https.request(options, (resApi) => {
        let data = '';
        resApi.on('data', (chunk) => { data += chunk; });
        resApi.on('end', () => {
            try {
                const response = JSON.parse(data);
                if (resApi.statusCode === 200) {
                    return res.json({ message: 'Conexión exitosa con Mercado Libre.' });
                }
                if (response.error === 'invalid_client') {
                     return res.status(400).json({ message: 'Credenciales inválidas. Verifica el App ID y Secret.' });
                }
                return res.status(resApi.statusCode).json({ message: `Error de Mercado Libre: ${response.message || response.error}` });
            } catch (e) {
                return res.status(500).json({ message: 'Respuesta inválida de Mercado Libre.' });
            }
        });
    });

    reqApi.on('error', (e) => {
        console.error("Meli Connection Error:", e);
        return res.status(500).json({ message: `Error de red: ${e.message}` });
    });

    reqApi.write(postData);
    reqApi.end();
});

// POST /api/settings/test-falabella-direct
router.post('/test-falabella-direct', authMiddleware, adminOnly, async (req, res) => {
    const { falabellaDirectClientId, falabellaDirectClientSecret, falabellaDirectEnvironment } = req.body;
    if (!falabellaDirectClientId || !falabellaDirectClientSecret) {
        return res.status(400).json({ message: 'Client ID y Client Secret son requeridos.' });
    }
    try {
        const falabellaDirectService = require('../services/falabellaDirectService');
        const result = await falabellaDirectService.testConnection(falabellaDirectClientId, falabellaDirectClientSecret, falabellaDirectEnvironment || 'UAT');
        res.json({ message: `Conexión exitosa con Falabella Directo (token válido por ${result.expiresIn}s).` });
    } catch (err) {
        console.error('[Settings] Falabella Directo test connection failed:', err.message);
        res.status(400).json({ message: `No se pudo conectar: ${err.message}` });
    }
});

// POST /api/settings/test-smtp
router.post('/test-smtp', authMiddleware, adminOnly, async (req, res) => {
    const { smtpHost, smtpPort, smtpUser, smtpPassword } = req.body;
    try {
        // [NUEVO] Obtener configuración actual para soportar prueba OAuth2
        const { rows: current } = await db.query('SELECT smtp_host, smtp_port, smtp_user, smtp_password, smtp_google_refresh_token, smtp_google_email FROM integration_settings WHERE id = 1');
        const integration = current[0] || {};

        const transporterConfig = {
            host: smtpHost || integration.smtp_host,
            port: parseInt(smtpPort || integration.smtp_port) || 587,
            secure: parseInt(smtpPort || integration.smtp_port) === 465,
            auth: {
                user: smtpUser || integration.smtp_user,
                pass: smtpPassword || integration.smtp_password
            },
            connectTimeout: 10000
        };

        // Si estamos probando la conexión de Google (OAuth2)
        if (integration.smtp_google_refresh_token && (!smtpPassword || smtpPassword === '************************')) {
            transporterConfig.auth = {
                type: 'OAuth2',
                user: integration.smtp_google_email || transporterConfig.auth.user,
                clientId: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                refreshToken: integration.smtp_google_refresh_token
            };
            
            if (!transporterConfig.host || transporterConfig.host.includes('gmail')) {
                transporterConfig.host = 'smtp.gmail.com';
                transporterConfig.port = 465;
                transporterConfig.secure = true;
            }
        }

        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport(transporterConfig);

        // Verify connection configuration
        await transporter.verify();

        res.json({ message: 'Conexión SMTP exitosa. El servidor está configurado correctamente.' });
    } catch (err) {
        console.error('SMTP Test Error:', err);
        res.status(500).json({ 
            message: `Error al conectar con el servidor SMTP: ${err.message}`
        });
    }
});

// POST /api/settings/github-backup
router.post('/github-backup', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT github_token, github_repo, github_owner FROM integration_settings WHERE id = 1');
        if (rows.length === 0 || !rows[0].github_token || !rows[0].github_repo || !rows[0].github_owner) {
            return res.status(400).json({ message: 'Configuración de GitHub incompleta.' });
        }

        const { github_token, github_repo, github_owner } = rows[0];

        // 1. Get all data to backup
        const { rows: users } = await db.query('SELECT * FROM users');
        const { rows: packages } = await db.query('SELECT * FROM packages');
        const { rows: tracking } = await db.query('SELECT * FROM tracking_events');

        const backupData = {
            timestamp: new Date().toISOString(),
            users,
            packages,
            tracking
        };

        const content = Buffer.from(JSON.stringify(backupData, null, 2)).toString('base64');
        const fileName = `backups/backup-${new Date().toISOString().split('T')[0]}.json`;

        const pushToBranch = async (branch) => {
            const options = {
                hostname: 'api.github.com',
                path: `/repos/${github_owner}/${github_repo}/contents/${fileName}`,
                method: 'PUT',
                headers: {
                    'Authorization': `token ${github_token}`,
                    'User-Agent': 'Full-Envios-App',
                    'Content-Type': 'application/json'
                }
            };

            // Check if file exists to get SHA (optional, but good for updates)
            // For backups, we usually want new files, so we use a timestamped name.

            const body = JSON.stringify({
                message: `Backup auto-generado ${new Date().toISOString()}`,
                content: content,
                branch: branch
            });

            return new Promise((resolve, reject) => {
                const reqGh = https.request(options, (resGh) => {
                    let data = '';
                    resGh.on('data', (chunk) => { data += chunk; });
                    resGh.on('end', () => {
                        if (resGh.statusCode >= 200 && resGh.statusCode < 300) {
                            resolve(JSON.parse(data));
                        } else {
                            reject(new Error(`GitHub API Error (${branch}): ${resGh.statusCode} - ${data}`));
                        }
                    });
                });
                reqGh.on('error', (e) => reject(e));
                reqGh.write(body);
                reqGh.end();
            });
        };

        // Push to both branches as requested
        await Promise.all([
            pushToBranch('main'),
            pushToBranch('developer')
        ]);
        
        await logAction(req.user.id, req.user.name, 'GITHUB_BACKUP', { details: 'Backup pushed to GitHub' });

        res.json({ message: 'Respaldo enviado con éxito a GitHub (main y developer).' });

    } catch (err) {
        console.error('Error in GitHub backup:', err);
        res.status(500).json({ message: `Error al realizar el respaldo: ${err.message}` });
    }
});

// POST /api/settings/disconnect-google-smtp
router.post('/disconnect-google-smtp', authMiddleware, adminOnly, async (req, res) => {
    try {
        await db.query('UPDATE integration_settings SET smtp_google_refresh_token = NULL, smtp_google_email = NULL WHERE id = 1');
        await logAction(req.user.id, req.user.name, 'DISCONNECT_GOOGLE_SMTP', { details: 'Google SMTP disconnected' });
        res.json({ message: 'Cuenta de Google desconectada con éxito.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al desconectar Google SMTP.' });
    }
});

// GET /api/settings/communes - Public to allow initial load without token
router.get('/communes', async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM active_communes ORDER BY name ASC');
        res.json(rows);
    } catch (err) {
        console.error('Error fetching communes:', err);
        res.status(500).json({ message: 'Error al obtener las comunas.' });
    }
});

// POST /api/settings/communes
router.post('/communes', authMiddleware, adminOnly, async (req, res) => {
    const { communes } = req.body; // Expects array of { name: string, isActive: boolean }
    if (!communes || !Array.isArray(communes)) {
        return res.status(400).json({ message: 'Se esperaba un array de comunas.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        for (const commune of communes) {
            await client.query(
                'UPDATE active_communes SET "isActive" = $1 WHERE name = $2',
                [commune.isActive, commune.name.toUpperCase()]
            );
        }
        await client.query('COMMIT');
        
        await logAction(req.user.id, req.user.name, 'UPDATE_ACTIVE_COMMUNES', { count: communes.length });
        
        res.json({ message: 'Comunas actualizadas con éxito.' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error updating communes:', err);
        res.status(500).json({ message: 'Error al actualizar las comunas.' });
    } finally {
        client.release();
    }
});

// POST /api/settings/test-whatsapp
router.post('/test-whatsapp', authMiddleware, adminOnly, async (req, res) => {
    const { phone, apikey } = req.body;
    if (!phone || !apikey) {
        return res.status(400).json({ message: 'Se requiere el número de teléfono y el API Key.' });
    }

    const targetPhone = phone.replace(/\s+/g, '');
    const text = `🧪 *Prueba de FullEnvíos* 🧪\n¡Hola! Esta es una prueba de tu integración con CallMeBot WhatsApp para alertas de administrador. Si recibes esto, la configuración es correcta.`;
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(targetPhone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`;

    try {
        console.log(`[CallMeBot TEST] Sending test to ${targetPhone}...`);
        const response = await fetch(url);
        if (response.ok) {
            return res.json({ message: 'Mensaje de prueba enviado con éxito. Revisa tu WhatsApp.' });
        } else {
            const errText = await response.text();
            console.error(`[CallMeBot TEST Error] Status: ${response.status}, Response: ${errText}`);
            return res.status(400).json({ message: `Error del bot: ${errText || 'Respuesta no válida del servidor de CallMeBot.'}` });
        }
    } catch (err) {
        console.error('[CallMeBot TEST Connection Error]:', err.message);
        return res.status(500).json({ message: `Error de conexión: ${err.message}` });
    }
});

module.exports = router;
