const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const falabellaDirectService = require('../services/falabellaDirectService');

const isSuperUser = (email) => email === 'admin' || email === 'admin@admin.cl';

// Backend gate: role-level only (AUXILIAR/ADMIN), matching this codebase's existing convention
// where granular driverPermissions flags (canDispatch/canAuxiliar/etc.) are enforced only on the
// frontend today, not re-checked server-side. Kept intentionally simple rather than introducing
// a new, inconsistent stricter pattern just for this one route.
function requireFalabellaDirectAccess(req, res, next) {
    if (isSuperUser(req.user?.email) || req.user?.role === 'AUXILIAR' || req.user?.role === 'ADMIN') {
        return next();
    }
    return res.status(403).json({ message: 'No tienes permiso para usar Falabella Directo.' });
}

// Falabella's status POST requires the description-carrying record about the *creation* of the
// order (statuses[]) as a marker of "we found it and are now handling it"; extract the LPN either
// from the scanned URL's trailing path segment, or fall back to treating the raw scan as the LPN
// itself (covers a plain-text LPN barcode as well as the documented QR JSON payload).
function extractLpn(rawCode) {
    let payload;
    try {
        payload = JSON.parse(rawCode);
    } catch (e) {
        // Not JSON — treat the raw scanned text as the LPN directly.
        return { lpn: rawCode.trim(), sellerId: null };
    }
    if (payload && typeof payload.url === 'string') {
        const segments = payload.url.split('/').filter(Boolean);
        const lpn = segments[segments.length - 1];
        return { lpn, sellerId: payload.sellerId || null };
    }
    if (payload && payload.lpn) {
        return { lpn: payload.lpn, sellerId: payload.sellerId || null };
    }
    throw new Error('No se pudo extraer el LPN del código escaneado.');
}

function extractRecipientPhone(order) {
    const contacts = order?.recipient?.contacts || [];
    const phoneContact = contacts.find(c => c.type === 'PHONE_NUMBER' || c.type === 'CELLPHONE');
    return phoneContact?.value || null;
}

function buildAddress(shipTo) {
    return [shipTo?.addressLine1, shipTo?.addressLine2, shipTo?.addressLine3]
        .filter(Boolean)
        .join(', ');
}

// Duplicated locally (rather than importing from routes/packages.js) to keep this integration
// independent, matching this codebase's existing convention for per-integration helpers.
async function getDriverLocation(driverId) {
    if (!driverId) return { latitude: 0, longitude: 0 };
    try {
        const { rows } = await db.query('SELECT latitude, longitude FROM users WHERE id = $1', [driverId]);
        if (rows.length > 0 && rows[0].latitude != null && rows[0].longitude != null) {
            return { latitude: rows[0].latitude, longitude: rows[0].longitude };
        }
    } catch (e) { console.error('[FalabellaDirect] Error fetching driver location:', e); }
    return { latitude: 0, longitude: 0 };
}

// POST /api/falabella-direct/import-scanned
// Auxiliar (or super admin) scans a Falabella "Directo" label at the moment of assigning it to a
// driver — this mirrors the warehouse's real physical process, where receiving and assigning are
// the same single action, not two separate steps. Fetches the real order from Falabella, creates
// the package already assigned to the chosen driver, and reports OUT_FOR_DELIVERY_001 directly
// (skipping the separate IN_TRANSIT_001 intake-only stage entirely).
router.post('/import-scanned', authMiddleware, requireFalabellaDirectAccess, async (req, res) => {
    const { rawCode, labelPhotoBase64, driverId } = req.body;
    if (!rawCode) {
        return res.status(400).json({ message: 'Falta el código escaneado.' });
    }
    if (!driverId) {
        return res.status(400).json({ message: 'Falta seleccionar el conductor.' });
    }

    let lpn;
    try {
        ({ lpn } = extractLpn(rawCode));
    } catch (e) {
        return res.status(400).json({ message: e.message });
    }

    try {
        // Idempotent re-scan: if this LPN was already imported, just return it instead of erroring.
        const { rows: existing } = await db.query('SELECT * FROM packages WHERE "falabellaDirectLpn" = $1', [lpn]);
        if (existing.length > 0) {
            return res.status(200).json({ message: `El paquete con LPN ${lpn} ya había sido escaneado.`, pkg: existing[0], alreadyImported: true });
        }

        const { rows: driverRows } = await db.query('SELECT id, name FROM users WHERE id = $1', [driverId]);
        const driver = driverRows[0];
        if (!driver) {
            return res.status(400).json({ message: 'Conductor no encontrado.' });
        }

        const order = await falabellaDirectService.getOrderByLpn(lpn);

        const now = new Date();
        const newPackage = {
            id: `FALDIR-${uuidv4().split('-')[0]}`,
            recipientName: order?.recipient?.fullName || 'N/A',
            recipientPhone: extractRecipientPhone(order),
            status: 'EN_TRANSITO',
            shippingType: 'SAME_DAY',
            origin: 'Falabella Directo',
            recipientAddress: buildAddress(order?.shipTo) || 'N/A',
            recipientCommune: order?.shipTo?.municipalName || 'N/A',
            recipientCity: order?.shipTo?.cityName || 'N/A',
            notes: `Falabella Directo — Orden ${order?.orderNumber || lpn}`,
            createdAt: now,
            updatedAt: now,
            assignedAt: now,
            driverId: driver.id,
            creatorId: req.user.id,
            source: 'FALABELLA_DIRECTO',
            falabellaDirectLpn: lpn,
            falabellaDirectOrderNumber: order?.orderNumber || null,
            falabellaDirectLastPushedStatus: 'OUT_FOR_DELIVERY_001',
            falabellaDirectLastPushedAt: now,
            falabellaDirectLabelPhotoBase64: labelPhotoBase64 || null,
        };

        const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
        const values = Object.values(newPackage).map(v => v === undefined ? null : v);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
        await db.query(
            'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [newPackage.id, 'EN_TRANSITO', 'Centro de Distribución', `Escaneado y asignado a ${driver.name} por ${req.user.name || req.user.id} — Falabella Directo LPN ${lpn}.`, now]
        );

        // Fire-and-forget: report to Falabella that the driver now has it, with the same
        // inline-retry-then-queue pattern as the existing Falabella Seller Center/Envíame sync functions.
        getDriverLocation(driver.id).then(({ latitude, longitude }) =>
            pushStatusWithRetry(newPackage.id, lpn, 'OUT_FOR_DELIVERY_001', `Recibido por el conductor ${driver.name}, en reparto.`, { latitude, longitude })
        ).catch(err => console.error('[FalabellaDirect] Error fetching driver location for status push:', err));

        res.status(201).json({ message: `Paquete Falabella Directo importado y asignado a ${driver.name} (LPN ${lpn}).`, pkg: newPackage });
    } catch (error) {
        console.error('[FalabellaDirect] Error importing scanned label:', error);
        res.status(500).json({ message: error.message || 'Error al importar el paquete escaneado.' });
    }
});

// Shared retry-then-queue helper for all Falabella Directo status pushes (intake, dispatch,
// delivery, problem, return) — mirrors the exact shape of syncDeliveryToFalabella/syncDeliveryToEnviame
// in routes/packages.js (3 attempts, linear backoff, then integration_sync_queue fallback).
async function pushStatusWithRetry(packageId, lpn, statusCode, description, extra = {}, attempts = 1) {
    const MAX_ATTEMPTS = 3;
    const DELAY_MULTIPLIER = 3000;
    try {
        await falabellaDirectService.pushStatusUpdate(lpn, statusCode, description, extra);
        await db.query('UPDATE packages SET "falabellaDirectLastPushedStatus" = $1, "falabellaDirectLastPushedAt" = NOW() WHERE id = $2', [statusCode, packageId]);
        console.log(`[FalabellaDirect] Status ${statusCode} pushed successfully for package ${packageId} (lpn=${lpn}).`);
    } catch (error) {
        console.error(`[FalabellaDirect] Fallo en intento ${attempts}/${MAX_ATTEMPTS} para paquete ${packageId} (statusCode=${statusCode}):`, error.message);
        if (attempts < MAX_ATTEMPTS) {
            const nextDelay = attempts * DELAY_MULTIPLIER;
            setTimeout(() => pushStatusWithRetry(packageId, lpn, statusCode, description, extra, attempts + 1), nextDelay);
        } else {
            await db.query(
                'INSERT INTO integration_sync_queue ("packageId", integration, action, payload, error, "nextAttemptAt") ' +
                'VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL \'15 minutes\')',
                [packageId, 'FALABELLA_DIRECTO', statusCode, JSON.stringify({ lpn, statusCode, description, extra }), error.message]
            );
        }
    }
}

module.exports = router;
module.exports.pushStatusWithRetry = pushStatusWithRetry;
module.exports.isSuperUser = isSuperUser;
