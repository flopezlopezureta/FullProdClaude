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

// POST /api/falabella-direct/import-scanned
// Auxiliar (or super admin) scans a Falabella "Directo" label on intake. Fetches the real order
// from Falabella, creates the package locally, and reports IN_TRANSIT_001 back to Falabella.
router.post('/import-scanned', authMiddleware, requireFalabellaDirectAccess, async (req, res) => {
    const { rawCode, labelPhotoBase64 } = req.body;
    if (!rawCode) {
        return res.status(400).json({ message: 'Falta el código escaneado.' });
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

        const order = await falabellaDirectService.getOrderByLpn(lpn);

        const now = new Date();
        const newPackage = {
            id: `FALDIR-${uuidv4().split('-')[0]}`,
            recipientName: order?.recipient?.fullName || 'N/A',
            recipientPhone: extractRecipientPhone(order),
            status: 'PENDIENTE',
            shippingType: 'SAME_DAY',
            origin: 'Falabella Directo',
            recipientAddress: buildAddress(order?.shipTo) || 'N/A',
            recipientCommune: order?.shipTo?.municipalName || 'N/A',
            recipientCity: order?.shipTo?.cityName || 'N/A',
            notes: `Falabella Directo — Orden ${order?.orderNumber || lpn}`,
            createdAt: now,
            updatedAt: now,
            creatorId: req.user.id,
            source: 'FALABELLA_DIRECTO',
            falabellaDirectLpn: lpn,
            falabellaDirectOrderNumber: order?.orderNumber || null,
            falabellaDirectLastPushedStatus: 'IN_TRANSIT_001',
            falabellaDirectLastPushedAt: now,
            falabellaDirectLabelPhotoBase64: labelPhotoBase64 || null,
        };

        const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
        const values = Object.values(newPackage).map(v => v === undefined ? null : v);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
        await db.query(
            'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [newPackage.id, 'Creado', newPackage.origin, `Escaneado por ${req.user.id} — Falabella Directo LPN ${lpn}.`, now]
        );

        // Fire-and-forget: report intake to Falabella, with the same inline-retry-then-queue
        // pattern as the existing Falabella Seller Center/Envíame sync functions.
        pushStatusWithRetry(newPackage.id, lpn, 'IN_TRANSIT_001', 'Paquete recibido por Full Envíos.');

        res.status(201).json({ message: `Paquete Falabella Directo importado (LPN ${lpn}).`, pkg: newPackage });
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
