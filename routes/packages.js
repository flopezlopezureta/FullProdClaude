const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const { normalizeCommune, normalizeCity } = require('../utils/normUtil');
const authMiddleware = require('../middleware/auth');
const timeService = require('../services/timeService');
const https = require('https');
const NotificationService = require('../services/notificationService');
const { logAction } = require('../services/logger');
const meliPollingService = require('../services/meliPollingService');
const jumpsellerPollingService = require('../services/jumpsellerPollingService');
const { geocodeAddress, triggerBackgroundGeocoding } = require('../services/geocodingService');
const gisService = require('../services/gisService');

// [EMERGENCIA] Ruta para normalizar todas las comunas y ciudades del historial
router.get('/sys/normalize-all', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ message: 'No autorizado.' });
    try {
        console.log('[Maintenance] Starting system-wide commune normalization...');
        
        // Postgres SQL to normalize: Trim, Upper, and remove common accents (preserving Ñ)
        const query = `
            UPDATE packages 
            SET 
                "recipientCommune" = UPPER(TRIM(TRANSLATE("recipientCommune", 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU'))),
                "recipientCity" = UPPER(TRIM(TRANSLATE("recipientCity", 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')))
            WHERE "recipientCommune" IS NOT NULL OR "recipientCity" IS NOT NULL;
        `;
        
        const result = await db.query(query);
        console.log(`[Maintenance] Normalization complete. Rows affected: ${result.rowCount}`);
        
        res.json({ 
            message: 'Normalización completada con éxito.', 
            rowsAffected: result.rowCount 
        });
    } catch (err) {
        console.error('[Maintenance] Normalization error:', err);
        res.status(500).json({ message: 'Error durante la normalización: ' + err.message });
    }
});


// [EMERGENCIA] Ruta para arreglar los egresos de hoy retroactivamente
router.get('/fix-egress-today', async (req, res) => {
    try {
        const today = await timeService.getLogicalDate();
        const query = `
            UPDATE packages 
            SET "assignedAt" = "updatedAt" 
            WHERE "driverId" IS NOT NULL 
            AND "assignedAt" IS NULL 
            AND "updatedAt"::text LIKE $1
        `;
        const result = await db.query(query, [today + '%']);
        res.json({ 
            success: true,
            message: `✅ Se han reparado ${result.rowCount} paquetes para el filtro de EGRESO.`, 
            date: today 
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Helper to get tracking history for a package
async function getHistory(packageId) {
    const { rows: history } = await db.query(
        'SELECT * FROM tracking_events WHERE "packageId" = $1 ORDER BY timestamp DESC',
        [packageId]
    );
    return history;
}

// Geocoding logic moved to services/geocodingService.js

// Middleware to authorize dispatch actions
const dispatchAllowed = (req, res, next) => {
    const allowedRoles = ['ADMIN', 'DRIVER', 'AUXILIAR'];
    if (allowedRoles.includes(req.user.role)) {
        return next();
    }
    return res.status(403).json({ message: 'No tiene permiso para despachar paquetes.' });
};


// Helper function to build the package query base on request parameters
async function buildPackageQuery(req) {
    const {
        statusFilter,
        driverFilter,
        clientFilter,
        communeFilter,
        cityFilter,
        flexFilter,
        quickFilter,
        sourceFilter,
        isAssigned,
        accountId,
        assignmentFilter, // 'all', 'first', 'reassigned'
        excludeChecked, // 'true' or 'false'
        dateType = 'created', // 'created' or 'egress'
    } = req.query;

    let { startDate, endDate } = req.query;

    // [SEGURIDAD] Si es un conductor y no especificó fechas, forzamos que vea solo HOY para evitar descuadres
    if (req.user.role === 'DRIVER' && !startDate && !endDate) {
        const todayStr = await timeService.getLogicalDate();
        startDate = todayStr;
        endDate = todayStr;
    }

    const rawSearch = req.query.searchQuery || req.query.search || '';
    const searchQuery = rawSearch.toString().trim() || null;

    let whereClauses = [];
    let queryParams = [];
    let paramIndex = 1;

    if (req.user.role === 'CLIENT') {
        whereClauses.push(`"creatorId" = $${paramIndex++}`);
        queryParams.push(req.user.id);
    }

    if (searchQuery) {
        whereClauses.push(`(p."recipientName" ILIKE $${paramIndex} 
            OR p."recipientAddress" ILIKE $${paramIndex} 
            OR p."recipientCity" ILIKE $${paramIndex} 
            OR p."recipientCommune" ILIKE $${paramIndex} 
            OR p.id ILIKE $${paramIndex} 
            OR p."meliOrderId" ILIKE $${paramIndex} 
            OR p."shopifyOrderId" ILIKE $${paramIndex} 
            OR p."wooOrderId" ILIKE $${paramIndex} 
            OR p."jumpsellerOrderId" ILIKE $${paramIndex} 
            OR p."trackingId" ILIKE $${paramIndex} 
            OR p."recipientPhone" ILIKE $${paramIndex}
            OR p."recipientEmail" ILIKE $${paramIndex}
            OR p."meliFlexCode" ILIKE $${paramIndex} 
            OR p.notes ILIKE $${paramIndex}
            OR u.name ILIKE $${paramIndex})`);
        queryParams.push(`%${searchQuery}%`);
        paramIndex++;
    }

    if (statusFilter) {
        let statuses = Array.isArray(statusFilter) ? statusFilter : statusFilter.split(',');
        if (statuses.includes('closed')) {
            statuses = statuses.filter(s => s !== 'closed');
            if (!statuses.includes('ENTREGADO')) statuses.push('ENTREGADO');
            if (!statuses.includes('DEVUELTO')) statuses.push('DEVUELTO');
            if (!statuses.includes('PROBLEMA')) statuses.push('PROBLEMA');
            if (!statuses.includes('REPROGRAMADO')) statuses.push('REPROGRAMADO');
        }
        if (statuses.length > 0) {
            const placeholders = statuses.map((_, i) => `$${paramIndex + i}`).join(',');
            whereClauses.push(`p.status IN (${placeholders})`);
            queryParams.push(...statuses);
            paramIndex += statuses.length;
        }
    }

    if (driverFilter) {
        whereClauses.push(`p."driverId" = $${paramIndex++}`);
        queryParams.push(driverFilter);
    }
    
    if (clientFilter) {
        whereClauses.push(`p."creatorId" = $${paramIndex++}`);
        queryParams.push(clientFilter);
    }

    if (communeFilter) {
        whereClauses.push(`p."recipientCommune" = $${paramIndex++}`);
        queryParams.push(communeFilter);
    }

    if (cityFilter) {
        whereClauses.push(`p."recipientCity" = $${paramIndex++}`);
        queryParams.push(cityFilter);
    }

    const isHistoricalSearch = searchQuery && searchQuery.length >= 3;
    
    if (startDate && endDate && !isHistoricalSearch) {
        const { start, nextDayStart } = await timeService.getLogicalRange(startDate, endDate);
        
        if (dateType === 'egress') {
            whereClauses.push(`p."assignedAt" >= $${paramIndex} AND p."assignedAt" < $${paramIndex + 1}`);
        } else if (dateType === 'updated') {
            if (assignmentFilter === 'reassigned') {
                whereClauses.push(`p."assignedAt" >= $${paramIndex} AND p."assignedAt" < $${paramIndex + 1}`);
            } else if (req.query.isDuplicate === 'true') {
                whereClauses.push(`p."createdAt" >= $${paramIndex} AND p."createdAt" < $${paramIndex + 1}`);
            } else {
                whereClauses.push(`p."updatedAt" >= $${paramIndex} AND p."updatedAt" < $${paramIndex + 1}`);
            }
        } else if (driverFilter && req.user.role === 'DRIVER') {
            // [v2.6.5] Separar lógica: El Dashboard (hoy) usa filtro estricto, el Historial (rango de fechas) usa el filtro laxo original.
            if (startDate === endDate) {
                // Dashboard del conductor (Vista del Día):
                // Muestra ÚNICA Y EXCLUSIVAMENTE los paquetes programados o asignados para la jornada de HOY.
                // Los paquetes pendientes de días anteriores no asignados a la jornada de hoy no se incluyen.
                whereClauses.push(`(
                    p."estimatedDelivery" >= $${paramIndex} AND p."estimatedDelivery" < $${paramIndex + 1}
                    OR p."assignedAt" >= $${paramIndex} AND p."assignedAt" < $${paramIndex + 1}
                )`);
            } else {
                // Historial de Entregas: Comportamiento exacto de ayer + Búsqueda en historial interno
                whereClauses.push(`(
                    (
                        p."createdAt" >= $${paramIndex} AND p."createdAt" < $${paramIndex + 1} OR 
                        p."assignedAt" >= $${paramIndex} AND p."assignedAt" < $${paramIndex + 1} OR
                        p."updatedAt" >= $${paramIndex} AND p."updatedAt" < $${paramIndex + 1} OR
                        p."estimatedDelivery" >= $${paramIndex} AND p."estimatedDelivery" < $${paramIndex + 1} OR
                        p.id IN (SELECT "packageId" FROM tracking_events WHERE timestamp >= $${paramIndex} AND timestamp < $${paramIndex + 1})
                    ) OR (
                        p.status NOT IN ('ENTREGADO', 'DEVUELTO', 'CANCELADO')
                    )
                )`);
            }
        } else {
            whereClauses.push(`(
                p."createdAt" >= $${paramIndex} AND p."createdAt" < $${paramIndex + 1} OR 
                p."estimatedDelivery" >= $${paramIndex} AND p."estimatedDelivery" < $${paramIndex + 1}
            )`);
        }
        queryParams.push(start, nextDayStart);
        paramIndex += 2;
    } else if (!isHistoricalSearch) {
        if (startDate) {
            const { start } = await timeService.getLogicalRange(startDate, startDate);
            if (dateType === 'egress') {
                whereClauses.push(`p."assignedAt" >= $${paramIndex}`);
            } else if (dateType === 'updated') {
                if (assignmentFilter === 'reassigned') {
                    whereClauses.push(`p."assignedAt" >= $${paramIndex}`);
                } else if (req.query.isDuplicate === 'true') {
                    whereClauses.push(`p."createdAt" >= $${paramIndex}`);
                } else {
                    whereClauses.push(`p."updatedAt" >= $${paramIndex}`);
                }
            } else {
                whereClauses.push(`(
                    p."createdAt" >= $${paramIndex} OR 
                    p."updatedAt" >= $${paramIndex} OR 
                    p."estimatedDelivery" >= $${paramIndex}
                )`);
            }
            queryParams.push(start);
            paramIndex++;
        }

        if (endDate) {
            const { nextDayStart } = await timeService.getLogicalRange(endDate, endDate);
            if (dateType === 'egress') {
                whereClauses.push(`p."assignedAt" < $${paramIndex}`);
            } else if (dateType === 'updated') {
                if (assignmentFilter === 'reassigned') {
                    whereClauses.push(`p."assignedAt" < $${paramIndex}`);
                } else if (req.query.isDuplicate === 'true') {
                    whereClauses.push(`p."createdAt" < $${paramIndex}`);
                } else {
                    whereClauses.push(`p."updatedAt" < $${paramIndex}`);
                }
            } else {
                whereClauses.push(`(
                    p."createdAt" < $${paramIndex} OR 
                    p."updatedAt" < $${paramIndex} OR 
                    p."estimatedDelivery" < $${paramIndex}
                )`);
            }
            queryParams.push(nextDayStart);
            paramIndex++;
        }
    }

    if (flexFilter) {
        if (flexFilter === 'flexed') {
            whereClauses.push(`p."isFlexed" = true`);
        } else if (flexFilter === 'not_flexed') {
            whereClauses.push(`(p."isFlexed" IS NULL OR p."isFlexed" = false)`);
        }
    }

    if (sourceFilter) {
        if (sourceFilter === 'ml') {
            whereClauses.push(`p.source = 'MERCADO_LIBRE'`);
        } else if (sourceFilter === 'web') {
            whereClauses.push(`p.source != 'MERCADO_LIBRE'`);
        }
    }

    if (quickFilter) {
        if (quickFilter === 'closed') {
            whereClauses.push(`p.status IN ('ENTREGADO', 'DEVUELTO', 'PROBLEMA', 'REPROGRAMADO')`);
        } else if (quickFilter === 'cancelled') {
            whereClauses.push(`p.status = 'CANCELADO'`);
        } else if (quickFilter === 'rescheduled') {
            whereClauses.push(`p.status = 'REPROGRAMADO'`);
        }
    }

    if (isAssigned === 'true') {
        whereClauses.push(`p."driverId" IS NOT NULL`);
    } else if (isAssigned === 'false') {
        whereClauses.push(`p."driverId" IS NULL`);
    }
    
    if (accountId) {
        whereClauses.push(`p."sourceAccountId" = $${paramIndex++}`);
        queryParams.push(accountId);
    }
    
    if (assignmentFilter === 'first') {
        whereClauses.push(`p."driverId" IS NOT NULL AND (p."isReassigned" IS NULL OR p."isReassigned" = false)`);
    } else if (assignmentFilter === 'reassigned') {
        whereClauses.push(`p."driverId" IS NOT NULL AND p."isReassigned" = true`);
    } else if (assignmentFilter === 'all_assigned') {
        whereClauses.push(`p."driverId" IS NOT NULL`);
    }
    
    if (excludeChecked === 'true') {
        whereClauses.push(`(p."alertChecked" IS NULL OR p."alertChecked" = false)`);
    }

    if (req.query.isDuplicate === 'true') {
        whereClauses.push(`p."isDuplicate" = true`);
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    return { whereString, queryParams, paramIndex };
}

// GET /api/packages/export/csv - Streaming CSV export for large datasets
router.get('/export/csv', authMiddleware, async (req, res) => {
    try {
        const { sortOrder = 'desc' } = req.query;
        const { whereString, queryParams } = await buildPackageQuery(req);

        const orderDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';
        const query = `
            SELECT p.*, u.name as "clientName", d.name as "driverName"
            FROM packages p 
            LEFT JOIN users u ON p."creatorId" = u.id 
            LEFT JOIN users d ON p."driverId" = d.id
            ${whereString} 
            ORDER BY p."updatedAt" ${orderDirection}, p.id DESC
        `;

        // Set headers for file download
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=reporte_paquetes.csv');

        // Write BOM for Excel
        res.write('\uFEFF');

        // Write header
        const headers = [
            'ID Paquete', 'Pedido', 'Cliente', 'ID Cliente', 'Fecha Creacion', 
            'Estado', 'Destinatario', 'Direccion', 'Comuna', 'Ciudad', 
            'Tipo Envio', 'Fecha de Egreso', 'Conductor', 'Bultos'
        ];
        res.write(headers.join(',') + '\n');

        const escapeCSV = (val) => {
            if (val === null || val === undefined) return '""';
            const str = String(val).replace(/"/g, '""');
            return `"${str}"`;
        };

        // We use a pool client to query to be safe, though simple db.query might work
        // For very large results, we could use pg-query-stream, but let's try standard query with loop
        const { rows: packages } = await db.query(query, queryParams);

        for (const pkg of packages) {
            const row = [
                pkg.id,
                pkg.meliOrderId || pkg.shopifyOrderId || pkg.wooOrderId || pkg.jumpsellerOrderId || pkg.id,
                pkg.clientName || 'N/A',
                pkg.creatorId || 'N/A',
                new Date(pkg.createdAt).toLocaleString('es-CL'),
                (pkg.status || '').replace('_', ' '),
                pkg.recipientName,
                pkg.recipientAddress,
                pkg.recipientCommune,
                pkg.recipientCity,
                pkg.shippingType,
                pkg.assignedAt ? new Date(pkg.assignedAt).toLocaleString('es-CL') : 'Pendiente',
                pkg.driverName || 'No asignado',
                1 // Bultos
            ].map(escapeCSV).join(',');
            res.write(row + '\n');
        }

        res.end();
    } catch (err) {
        console.error("Error in GET /api/packages/export/csv:", err);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Error al exportar los paquetes.' });
        }
    }
});

// GET /api/packages - with server-side pagination and filtering
router.get('/', authMiddleware, async (req, res) => {
    try {
        const {
            page = 1,
            limit = 25,
            sortOrder = 'desc',
            includeHistory = 'true', // 'true' or 'false'
            excludePhotos = 'true', // Default to true to optimize memory/speed
        } = req.query;

        const { whereString, queryParams, paramIndex: initialParamIndex } = await buildPackageQuery(req);
        let paramIndex = initialParamIndex;

        const offset = (page - 1) * limit;

        // Query for total count
        const countQuery = `
            SELECT COUNT(*) 
            FROM packages p
            LEFT JOIN users u ON p."creatorId" = u.id
            ${whereString}
        `;
        const { rows: countRows } = await db.query(countQuery, queryParams);
        const total = parseInt(countRows[0].count, 10);
        
        const orderDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';
        const limitClause = limit > 0 ? `LIMIT $${paramIndex++} OFFSET $${paramIndex++}` : '';
        
        const selectFields = excludePhotos === 'true'
            ? `p.id, p."recipientName", p."recipientPhone", p.status, p."shippingType", p.origin, p.destination, p."recipientAddress", p."recipientCommune", p."recipientCity", p.notes, p."estimatedDelivery", p."createdAt", p."updatedAt", p."assignedAt", p."driverId", p."creatorId", p."destLatitude", p."destLongitude", p."deliveryReceiverName", p."deliveryReceiverId", p.billed, p.source, p."meliOrderId", p."wooOrderId", p."shopifyOrderId", p."jumpsellerOrderId", p."trackingId", p."meliFlexCode", p."isFlexed", p."flexedAt", p."recipientRut", p."recipientEmail", p."sourceAccountId", p."sourceAccountName", p."alertChecked", p."shopifyOrderNumber", p."meliSellerId", p."isReassigned", p."isDuplicate", p."falabellaOrderId", p."falabellaTrackingId", NULL as "flexLabelPhotoBase64", NULL as "deliveryPhotosBase64", u.name as "clientName"`
            : `p.*, u.name as "clientName"`;

        const packageQuery = `
            SELECT ${selectFields}
            FROM packages p 
            LEFT JOIN users u ON p."creatorId" = u.id 
            ${whereString} 
            ORDER BY p."updatedAt" ${orderDirection}, p.id DESC
            ${limitClause}
        `;
        
        const finalQueryParams = [...queryParams];
        if (limit > 0) {
            finalQueryParams.push(limit, offset);
        }

        const { rows: packages } = await db.query(packageQuery, finalQueryParams);

        // Get history only if requested
        const packageIds = packages.map(p => p.id);
        let eventsByPackageId = {};
        if (includeHistory !== 'false' && packageIds.length > 0) {
            const placeholders = packageIds.map((_, i) => `$${i + 1}`).join(',');
            const { rows: allEvents } = await db.query(`SELECT "packageId", status, timestamp, location, details FROM tracking_events WHERE "packageId" IN (${placeholders}) ORDER BY timestamp DESC`, packageIds);
            
            eventsByPackageId = allEvents.reduce((acc, event) => {
                if (!acc[event.packageId]) acc[event.packageId] = [];
                acc[event.packageId].push(event);
                return acc;
            }, {});
        }

        const packagesWithHistory = packages.map(pkg => ({
            ...pkg,
            history: eventsByPackageId[pkg.id] || []
        }));
        
        res.json({ packages: packagesWithHistory, total });

    } catch (err) {
        console.error("Error in GET /api/packages:", err);
        res.status(500).json({ message: 'Error al obtener los paquetes.' });
    }
});

// GET /api/packages/:id - Get details of a single package including history and photos
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        let { id } = req.params;
        if (id && id.startsWith('SCA00-')) {
            id = id.replace('SCA00-', '');
        }
        const { rows } = await db.query(
            `SELECT p.*, u.name as "clientName" 
             FROM packages p 
             LEFT JOIN users u ON p."creatorId" = u.id 
             WHERE p.id = $1 OR p."meliOrderId" = $1 OR p."meliFlexCode" = $1 OR p."trackingId" = $1`, 
            [id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        const pkg = rows[0];
        pkg.history = await getHistory(id);
        
        // Map deliveryPhotosBase64 JSONB to photos array
        if (pkg.deliveryPhotosBase64) {
            try {
                pkg.photos = typeof pkg.deliveryPhotosBase64 === 'string'
                    ? JSON.parse(pkg.deliveryPhotosBase64)
                    : pkg.deliveryPhotosBase64;
            } catch (e) {
                pkg.photos = [];
            }
        } else {
            pkg.photos = [];
        }
        
        res.json(pkg);
    } catch (err) {
        console.error('Error in GET /api/packages/:id:', err);
        res.status(500).json({ message: 'Error al obtener detalles del paquete.' });
    }
});

function isMeliCode(code) {
    if (!code) return false;
    let clean = code.trim();
    if (clean.startsWith('{')) {
        try {
            const parsed = JSON.parse(clean);
            if (parsed.id) clean = String(parsed.id).trim();
        } catch (e) {}
    }
    // Check if numeric (starts with 4 or 2, and is 10-12 digits long) or starts with ML
    return /^[42]\d{9,11}$/.test(clean) || /^ML/i.test(clean);
}

router.get('/query/:searchId', authMiddleware, async (req, res) => {
    try {
        let { searchId } = req.params;
        if (searchId && searchId.startsWith('SCA00-')) {
            searchId = searchId.replace('SCA00-', '');
        }
        
        // Búsqueda extendida por ID, ML, Shopify, Tracking ID, etc.
        let { rows } = await db.query(
            `SELECT p.*, u.name as "clientName" 
             FROM packages p 
             LEFT JOIN users u ON p."creatorId" = u.id 
             WHERE p.id = $1 
                OR p."meliOrderId" = $1 
                OR p."shopifyOrderId" = $1 
                OR p."wooOrderId" = $1 
                OR p."jumpsellerOrderId" = $1 
                OR p."trackingId" = $1 
                OR p."meliFlexCode" = $1`, 
            [searchId]
        );
        
        // [NUEVO] IMPORTACIÓN JIT PARA CONSULTAS: si no existe localmente y parece un código de ML, buscar en Mercado Libre
        if (rows.length === 0 && isMeliCode(searchId)) {
            console.log(`[Query] Package ${searchId} NOT found in DB. Starting JIT Discovery...`);
            const { rows: meliUsers } = await db.query("SELECT id, name FROM users WHERE integrations->'meli' IS NOT NULL");
            if (meliUsers.length > 0) {
                const results = await Promise.all(meliUsers.map(async (u) => {
                    try {
                        const importedId = await meliPollingService.importSpecificMeliPackage(u.id, searchId, true);
                        return importedId ? { importedId, user: u } : null;
                    } catch (err) {
                        return null;
                    }
                }));

                const success = results.find(r => r !== null);
                if (success) {
                    console.log(`[Query] SUCCESS! Shipment ${searchId} found and linked as ${success.importedId}.`);
                    const reCheck = await db.query(
                        `SELECT p.*, u.name as "clientName" 
                         FROM packages p 
                         LEFT JOIN users u ON p."creatorId" = u.id 
                         WHERE p.id = $1`,
                        [success.importedId]
                    );
                    rows = reCheck.rows;
                }
            }
        }

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Paquete no encontrado para consulta.' });
        }
        
        const pkg = rows[0];
        pkg.history = await getHistory(pkg.id);
        
        // Remove heavy photo fields
        delete pkg.flexLabelPhotoBase64;
        delete pkg.deliveryPhotosBase64;
        
        // Calcular información GIS y geometría del sector
        let sectorDetails = null;
        if (pkg.destLatitude && pkg.destLongitude) {
            sectorDetails = gisService.getSectorDetailsForCoordinates(pkg.destLatitude, pkg.destLongitude);
        }
        
        res.json({
            package: pkg,
            sectorDetails
        });
    } catch (err) {
        console.error('Error in GET /api/packages/query/:searchId:', err);
        res.status(500).json({ message: 'Error al consultar sector del paquete.' });
    }
});





// Helper to add a tracking event
async function addTrackingEvent(packageId, status, location, details) {
    await db.query(
        'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
        [packageId, status, location, details, new Date()]
    );
}

// GET /api/packages/reports/flex-discrepancies
router.get('/reports/flex-discrepancies', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Solo los administradores pueden ver este reporte.' });
    }
    try {
        const query = `
            SELECT 
                u.id as "driverId",
                u.name as "driverName",
                COUNT(p.id) as "totalAssigned",
                COUNT(p.id) FILTER (WHERE p."isFlexed" = true) as "totalFlexed",
                COUNT(p.id) FILTER (WHERE (p."isFlexed" = false OR p."isFlexed" IS NULL)) as "totalUnflexed"
            FROM packages p
            JOIN users u ON p."driverId" = u.id
            WHERE p."driverId" IS NOT NULL
              AND DATE(p."estimatedDelivery") = current_date
              AND (p.source = 'MERCADO_LIBRE' OR p."meliFlexCode" IS NOT NULL OR p."meliOrderId" IS NOT NULL)
            GROUP BY u.id, u.name
            ORDER BY "totalUnflexed" DESC
        `;
        const { rows } = await db.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Error in /api/packages/reports/flex-discrepancies:', err);
        res.status(500).json({ message: 'Error al generar el reporte de discrepancias.' });
    }
});

// GET /api/packages/reports/flex-discrepancies/:driverId
router.get('/reports/flex-discrepancies/:driverId', authMiddleware, async (req, res) => {
    try {
        const { driverId } = req.params;
        const query = `
            SELECT 
                p.id,
                p."recipientName",
                p."recipientAddress",
                p."recipientCommune",
                p.status,
                p."isFlexed",
                p."meliOrderId",
                p."trackingId"
            FROM packages p
            WHERE p."driverId" = $1
              AND DATE(p."estimatedDelivery") = current_date
              AND (p."isFlexed" = false OR p."isFlexed" IS NULL)
              AND (p.source = 'MERCADO_LIBRE' OR p."meliFlexCode" IS NOT NULL OR p."meliOrderId" IS NOT NULL)
            ORDER BY p.id ASC
        `;
        const { rows } = await db.query(query, [driverId]);
        res.json(rows);
    } catch (err) {
        console.error('Error in /api/packages/reports/flex-discrepancies/:driverId:', err);
        res.status(500).json({ message: 'Error al obtener los detalles de las discrepancias.' });
    }
});
router.post('/', authMiddleware, async (req, res) => {
    const { creatorId, recipientName, recipientPhone, recipientEmail, recipientAddress, recipientCommune, recipientCity, notes, estimatedDelivery, shippingType, origin, source, meliOrderId, shopifyOrderId, shopifyOrderNumber, wooOrderId, jumpsellerOrderId, trackingId, falabellaOrderId, falabellaTrackingId } = req.body;
    
    // Validation
    const requiredFields = {
        creatorId: 'ID del cliente creador',
        recipientName: 'Nombre del destinatario',
        recipientPhone: 'Teléfono del destinatario',
        recipientAddress: 'Dirección del destinatario',
        recipientCommune: 'Comuna del destinatario',
        recipientCity: 'Ciudad del destinatario',
        estimatedDelivery: 'Fecha de entrega estimada',
        shippingType: 'Tipo de envío',
        origin: 'Origen del paquete'
    };

    const missingFields = [];
    for (const [field, label] of Object.entries(requiredFields)) {
        if (!req.body[field]) {
            missingFields.push(label);
        }
    }

    if (missingFields.length > 0) {
        return res.status(400).json({ 
            message: `Faltan datos obligatorios o están incompletos: ${missingFields.join(', ')}.` 
        });
    }

    // [VALIDACION] Comunas Activas
    const { rows: activeCommunes } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
    const activeCommuneNames = activeCommunes.map(c => normalizeCommune(c.name));
    
    const normalizedRecipientCommune = normalizeCommune(recipientCommune);
    if (activeCommuneNames.length > 0 && !activeCommuneNames.includes(normalizedRecipientCommune)) {
        return res.status(400).json({ 
            message: `La comuna "${recipientCommune}" no está habilitada para repartos actualmente.` 
        });
    }

    try {
        const { rows: creatorRows } = await db.query('SELECT "clientIdentifier" FROM users WHERE id = $1', [creatorId]);
        if (creatorRows.length === 0) {
            return res.status(404).json({ message: 'Cliente creador no encontrado.' });
        }

        // Geocoding is now handled in the background for speed (similar to batch route)
        const coords = { lat: null, lng: null };

        const now = new Date();
        const packageId = trackingId || `${creatorRows[0].clientIdentifier}-${uuidv4().split('-')[0]}`;
        
        const newPackage = {
            id: packageId,
            recipientName,
            recipientPhone,
            status: 'PENDIENTE',
            shippingType,
            origin,
            destination: recipientAddress, // legacy, can be removed later
            recipientAddress,
            recipientCommune: normalizeCommune(recipientCommune),
            recipientCity: normalizeCity(recipientCity),
            notes,
            estimatedDelivery: new Date(estimatedDelivery),
            createdAt: now,
            updatedAt: now,
            creatorId,
            source,
            meliOrderId,
            shopifyOrderId,
            shopifyOrderNumber,
            wooOrderId,
            jumpsellerOrderId,
            trackingId,
            recipientEmail,
            destLatitude: coords.lat,
            destLongitude: coords.lng,
            falabellaOrderId,
            falabellaTrackingId
        };

        const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
        const values = Object.values(newPackage);
        const placeholders = values.map((_, i) => `$${i+1}`).join(', ');

        await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
        await addTrackingEvent(newPackage.id, 'Creado', origin, 'Paquete creado.');
        
        await logAction(req.user.id, req.user.name, 'CREATE_PACKAGE', { packageId: newPackage.id, recipientName });

        newPackage.history = await getHistory(newPackage.id);
        
        // Trigger background geocoding without awaiting it
        setTimeout(() => {
            triggerBackgroundGeocoding().catch(err => console.error('[PostProcess] Geocoding trigger failed:', err));
        }, 1000);

        res.status(201).json(newPackage);
    } catch (err) {
        console.error('Error in POST /api/packages:', err);
        
        // Handle specific database errors
        if (err.code === '23505') {
            return res.status(400).json({ 
                message: 'Ya existe un paquete con este ID o código de seguimiento.' 
            });
        }
        
        if (err.code === '23502') {
            return res.status(400).json({ 
                message: `Faltan datos obligatorios en la base de datos: ${err.column}.` 
            });
        }

        res.status(500).json({ 
            message: 'Error al crear el paquete. Por favor, verifica que todos los datos sean correctos e intenta nuevamente.' 
        });
    }
});

// POST /api/packages/batch
router.post('/batch', authMiddleware, async (req, res) => {
    const { packages } = req.body;
    if (!packages || !Array.isArray(packages)) {
        return res.status(400).json({ message: "Se esperaba un array de paquetes." });
    }

    const results = [];
    const errors = [];

    // Pre-fetch active communes for batch validation
    const { rows: activeCommunes } = await db.query('SELECT name FROM active_communes WHERE "isActive" = true');
    const activeCommuneNames = activeCommunes.map(c => normalizeCommune(c.name));

    try {
        for (let i = 0; i < packages.length; i++) {
            const pkgData = packages[i];
            try {
                const { 
                    creatorId, 
                    recipientName, 
                    recipientPhone, 
                    recipientEmail,
                    recipientAddress, 
                    recipientCommune, 
                    recipientCity, 
                    notes, 
                    estimatedDelivery, 
                    shippingType, 
                    origin, 
                    source, 
                    meliOrderId, 
                    shopifyOrderId, 
                    shopifyOrderNumber,
                    wooOrderId, 
                    jumpsellerOrderId,
                    trackingId,
                    falabellaOrderId,
                    falabellaTrackingId,
                    sourceAccountId,
                    sourceAccountName
                } = pkgData;
                
                // Validate required fields for each package
                const requiredFields = {
                    creatorId: 'ID del cliente creador',
                    recipientName: 'Nombre del destinatario',
                    recipientPhone: 'Teléfono del destinatario',
                    recipientAddress: 'Dirección del destinatario',
                    recipientCommune: 'Comuna del destinatario',
                    recipientCity: 'Ciudad del destinatario',
                    estimatedDelivery: 'Fecha de entrega estimada',
                    shippingType: 'Tipo de envío',
                    origin: 'Origen del paquete'
                };

                const missingFields = [];
                for (const [field, label] of Object.entries(requiredFields)) {
                    if (!pkgData[field] || (typeof pkgData[field] === 'string' && pkgData[field].trim() === '')) {
                        missingFields.push(label);
                    }
                }

                if (missingFields.length > 0) {
                    errors.push({
                        index: i,
                        recipientName: recipientName || 'Desconocido',
                        error: `Faltan datos obligatorios: ${missingFields.join(', ')}`
                    });
                    continue;
                }

                // [VALIDACION] Comunas Activas
                const normalizedRecipientCommune = normalizeCommune(recipientCommune);
                if (activeCommuneNames.length > 0 && !activeCommuneNames.includes(normalizedRecipientCommune)) {
                    errors.push({
                        index: i,
                        recipientName: recipientName || 'Desconocido',
                        error: `La comuna "${recipientCommune}" no está habilitada para repartos actualmente.`
                    });
                    continue;
                }

                // [VALIDACION] Prevenir duplicados de Falabella
                if (source === 'FALABELLA' && falabellaOrderId) {
                    const { rows: existingFalabella } = await db.query(
                        'SELECT id FROM packages WHERE "falabellaOrderId" = $1',
                        [falabellaOrderId]
                    );
                    if (existingFalabella.length > 0) {
                        errors.push({
                            index: i,
                            recipientName: recipientName || 'Desconocido',
                            error: `El pedido de Falabella #${falabellaOrderId} ya ha sido importado previamente.`
                        });
                        continue;
                    }
                }

                const { rows: creatorRows } = await db.query('SELECT "clientIdentifier" FROM users WHERE id = $1', [creatorId]);
                if (creatorRows.length === 0) {
                    errors.push({ 
                        index: i, 
                        recipientName: recipientName || 'Desconocido',
                        error: `Cliente creador no encontrado.` 
                    });
                    continue;
                }
                
                // Geocoding is now handled in the background for speed
                const coords = { lat: null, lng: null };

                const now = new Date();
                const cleanTrackingId = trackingId ? String(trackingId).trim() : null;
                const packageId = cleanTrackingId || `${creatorRows[0].clientIdentifier}-${uuidv4().split('-')[0]}`;

                const newPackage = {
                    id: packageId,
                    recipientName, 
                    recipientPhone, 
                    status: 'PENDIENTE', 
                    shippingType, 
                    origin, 
                    destination: recipientAddress, 
                    recipientAddress, 
                    recipientCommune: normalizeCommune(recipientCommune), 
                    recipientCity: normalizeCity(recipientCity), 
                    notes, 
                    estimatedDelivery: new Date(estimatedDelivery), 
                    createdAt: now, 
                    updatedAt: now, 
                    creatorId, 
                    source, 
                    meliOrderId, 
                    shopifyOrderId, 
                    shopifyOrderNumber,
                    wooOrderId, 
                    jumpsellerOrderId,
                    trackingId: cleanTrackingId,
                    recipientEmail,
                    destLatitude: coords.lat,
                    destLongitude: coords.lng,
                    falabellaOrderId,
                    falabellaTrackingId,
                    sourceAccountId,
                    sourceAccountName
                };
                
                const columns = Object.keys(newPackage).map(k => `"${k}"`).join(', ');
                const values = Object.values(newPackage);
                const placeholders = values.map((_, i) => `$${i+1}`).join(', ');

                await db.query(`INSERT INTO packages (${columns}) VALUES (${placeholders})`, values);
                await addTrackingEvent(newPackage.id, 'Creado', origin, 'Paquete creado.');
                
                results.push(newPackage);
            } catch (err) {
                console.error(`Error creating package at index ${i}:`, err);
                
                let errorMessage = err.message;
                if (err.code === '23505') {
                    errorMessage = 'Ya existe un paquete con este ID o código de seguimiento.';
                } else if (err.code === '23502') {
                    errorMessage = `Faltan datos obligatorios en la base de datos: ${err.column}.`;
                }

                errors.push({ 
                    index: i, 
                    recipientName: pkgData.recipientName || 'Desconocido',
                    error: errorMessage
                });
            }
        }
        
        // Trigger background geocoding without awaiting it
        setTimeout(() => {
            triggerBackgroundGeocoding();
        }, 1000);

        res.status(201).json({ 
            success: true, 
            importedCount: results.length, 
            errorCount: errors.length,
            errors: errors
        });

    } catch (err) {
        console.error('Error in POST /api/packages/batch:', err);
        res.status(500).json({ message: 'Error del servidor al crear los paquetes en lote.' });
    }
});

// POST /api/packages/batch-assign-driver
router.post('/batch-assign-driver', authMiddleware, async (req, res) => {
    const { packageIds, driverId, newDeliveryDate } = req.body;
    if (!packageIds || !Array.isArray(packageIds) || packageIds.length === 0 || !newDeliveryDate) {
        return res.status(400).json({ message: 'IDs de paquetes y fecha son requeridos.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        let driverName = 'Disponible';
        const isUnassigning = !driverId || driverId === 'none';

        if (!isUnassigning) {
            const { rows: driverRows } = await client.query('SELECT name FROM users WHERE id = $1', [driverId]);
            if (driverRows.length === 0) {
                throw new Error('Conductor no encontrado.');
            }
            driverName = driverRows[0].name;
        }
        
        const placeholders = packageIds.map((_, i) => `$${i + 6}`).join(', ');

        // Force status to ASIGNADO only if driverId is provided, otherwise RETIRADO (Available)
        const targetStatus = isUnassigning ? 'RETIRADO' : 'ASIGNADO';
        const finalDriverId = isUnassigning ? null : driverId;

        const updateQuery = `
            UPDATE packages 
            SET "driverId" = $1, 
                "estimatedDelivery" = $2, 
                "updatedAt" = $3, 
                status = $4, 
                "assignedAt" = $5,
                "isReassigned" = CASE 
                    WHEN $1::text IS NULL THEN false 
                    ELSE COALESCE("isReassigned", false) OR ("driverId" IS NOT NULL AND "driverId" != $1::text) 
                END
            WHERE id IN (${placeholders})
        `;
        
        // Fetch current states before update to detect reassignments
        const searchPlaceholders = packageIds.map((_, i) => `$${i + 1}`).join(', ');
        const { rows: currentStates } = await client.query(`SELECT id, "driverId" FROM packages WHERE id IN (${searchPlaceholders})`, packageIds);
        
        await client.query(updateQuery, [finalDriverId, newDeliveryDate, new Date(), targetStatus, finalDriverId ? new Date() : null, ...packageIds]);

        // Create tracking events for all updated packages using a single bulk insert
        const eventValues = [];
        const eventParams = [];
        const timestamp = new Date();

        packageIds.forEach((packageId, index) => {
            const pkgBefore = currentStates.find(p => p.id === packageId);
            const isActuallyReassigning = !isUnassigning && pkgBefore?.driverId && pkgBefore?.driverId !== driverId;
            
            const eventStatus = isUnassigning ? 'Creado' : (isActuallyReassigning ? 'Reasignado' : 'Asignado');
            const details = isUnassigning 
                ? 'Paquete puesto en disponibilidad (desasignado).' 
                : (isActuallyReassigning 
                    ? `Reasignado al conductor ${driverName}. Fecha de reasignación actualizada.` 
                    : `Asignado a conductor ${driverName}. Estado actualizado a Asignado.`);

            const offset = index * 5;
            eventValues.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
            eventParams.push(packageId, eventStatus, 'Centro de Distribución', details, timestamp);
        });

        if (eventValues.length > 0) {
            await client.query(
                `INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ${eventValues.join(', ')}`,
                eventParams
            );
        }

        await client.query('COMMIT');
        
        // Notify recipients asynchronously in bulk (optimized to prevent DB slamming and connection leaks)
        setImmediate(() => {
            NotificationService.notifyRecipientsBulk(packageIds, targetStatus);
        });
        
        res.status(200).json({ message: `${packageIds.length} paquetes asignados correctamente.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error in POST /api/packages/batch-assign-driver:', err);
        res.status(500).json({ message: 'Error del servidor al asignar los paquetes: ' + (err.message || String(err)) });
    } finally {
        client.release();
    }
});

// PUT /api/packages/:id
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body };
        updateData.updatedAt = new Date();

        // [NUEVO] Actualizar la fecha de egreso si el paquete se asigna o despacha manualmente
        if (updateData.status === 'EN_TRANSITO' || updateData.status === 'ASIGNADO') {
            updateData.assignedAt = new Date();
        } else if (updateData.driverId && updateData.driverId !== 'none' && !updateData.assignedAt) {
            updateData.assignedAt = new Date();
        }

        // Security: Only admins can change the package creator (seller)
        if (updateData.creatorId && req.user.role !== 'ADMIN') {
            delete updateData.creatorId;
        }

        // Fetch current data to compare and for geocoding
        const { rows: currentPkgRows } = await db.query('SELECT "recipientAddress", "recipientCommune", "recipientCity" FROM packages WHERE id = $1', [id]);
        if (currentPkgRows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        const currentPkg = currentPkgRows[0];

        if (updateData.recipientCommune) {
            updateData.recipientCommune = normalizeCommune(updateData.recipientCommune);
        }
        if (updateData.recipientCity) {
            updateData.recipientCity = normalizeCity(updateData.recipientCity);
        }

        // Check if address changed to add a tracking event
        const newAddr = updateData.recipientAddress !== undefined ? updateData.recipientAddress : currentPkg.recipientAddress;
        const newComm = updateData.recipientCommune !== undefined ? updateData.recipientCommune : currentPkg.recipientCommune;
        const newCity = updateData.recipientCity !== undefined ? updateData.recipientCity : currentPkg.recipientCity;

        const addressChanged = 
            (updateData.recipientAddress !== undefined && updateData.recipientAddress !== currentPkg.recipientAddress) ||
            (updateData.recipientCommune !== undefined && updateData.recipientCommune !== currentPkg.recipientCommune) ||
            (updateData.recipientCity !== undefined && updateData.recipientCity !== currentPkg.recipientCity);

        if (addressChanged) {
            const oldFullAddr = `${currentPkg.recipientAddress}, ${currentPkg.recipientCommune}, ${currentPkg.recipientCity}`;
            const newFullAddr = `${newAddr}, ${newComm}, ${newCity}`;
            await addTrackingEvent(id, 'Dirección Actualizada', newComm, `Dirección cambiada de "${oldFullAddr}" a "${newFullAddr}".`);
            
            // Geocode the new address
            const coords = await geocodeAddress(newAddr, newComm, newCity);
            if (coords.lat && coords.lng) {
                updateData.destLatitude = coords.lat;
                updateData.destLongitude = coords.lng;
            }
        }

        const fields = Object.keys(updateData);
        const values = Object.values(updateData);
        const setClause = fields.map((field, i) => `"${field}" = $${i + 1}`).join(', ');
        
        const result = await db.query(`UPDATE packages SET ${setClause} WHERE id = $${fields.length + 1}`, [...values, id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        
        await logAction(req.user.id, req.user.name, 'UPDATE_PACKAGE', { packageId: id, updatedFields: fields });

        const { rows } = await db.query('SELECT * FROM packages WHERE id = $1', [id]);
        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);
        res.json(updatedPackage);

    } catch (err) {
        console.error('Error in PUT /api/packages/:id:', err);
        res.status(500).json({ message: 'Error al actualizar el paquete.' });
    }
});

// DELETE /api/packages/:id
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ message: 'La contraseña es requerida para eliminar paquetes.' });
        }

        // 1. Check against master key
        const masterKey = 'adminborrar';
        let isAuthorized = (password === masterKey);

        // 2. Check against user's own password if not master key
        if (!isAuthorized) {
            const { rows: userRows } = await db.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
            if (userRows.length > 0) {
                const bcrypt = require('bcryptjs');
                isAuthorized = await bcrypt.compare(password, userRows[0].password);
            }
        }

        // 3. Admin bypass (optional, but let's keep it strict as requested unless they are admin)
        if (req.user.role === 'ADMIN') {
            isAuthorized = true;
        }

        if (!isAuthorized) {
            return res.status(403).json({ message: 'Contraseña incorrecta.' });
        }

        await db.query('DELETE FROM tracking_events WHERE "packageId" = $1', [id]);
        const result = await db.query('DELETE FROM packages WHERE id = $1', [id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });

        await logAction(req.user.id, req.user.name, 'DELETE_PACKAGE', { packageId: id });

        res.status(204).send();
    } catch (err) {
        console.error('Error in DELETE /api/packages/:id:', err);
        res.status(500).json({ message: 'Error al eliminar el paquete.' });
    }
});

// POST /api/packages/:id/assign-driver
router.post('/:id/assign-driver', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { driverId, newDeliveryDate } = req.body;
    try {
        // [MOD] Reassignment logic: check current state
        const { rows: currentPkgRows } = await db.query('SELECT "driverId", status, "isReassigned" FROM packages WHERE id = $1', [id]);
        if (currentPkgRows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        
        const oldDriverId = currentPkgRows[0].driverId;
        const isReassigning = driverId && oldDriverId && driverId !== oldDriverId;
        const isUnassigning = !driverId || driverId === 'none';

        // Force status to ASIGNADO only if driverId is provided, otherwise RETIRADO (Available)
        const targetStatus = driverId ? 'ASIGNADO' : 'RETIRADO';
        const { rows } = await db.query(
            'UPDATE packages SET "driverId" = $1, "estimatedDelivery" = $2, "updatedAt" = $3, status = $4, "assignedAt" = $5, "isReassigned" = $6 WHERE id = $7 RETURNING *',
            [driverId, newDeliveryDate, new Date(), targetStatus, driverId ? new Date() : null, isReassigning ? true : (isUnassigning ? false : (currentPkgRows[0].isReassigned || false)), id]
        );
        
        const driverName = !isUnassigning ? (await db.query('SELECT name FROM users WHERE id = $1', [driverId])).rows[0]?.name : 'Nadie';
        
        let statusForEvent = isUnassigning ? 'Creado' : 'Asignado';
        let detailsForEvent = isUnassigning ? 'Paquete puesto en disponibilidad (desasignado).' : `Asignado a conductor ${driverName}. Estado actualizado a Asignado.`;
        
        if (isReassigning) {
            statusForEvent = 'Reasignado';
            detailsForEvent = `Reasignado al conductor ${driverName}. Fecha de reasignación actualizada.`;
        }

        await addTrackingEvent(id, statusForEvent, 'Centro de Distribución', detailsForEvent);
        
        NotificationService.notifyRecipient(id, targetStatus);
        
        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);
        res.json(updatedPackage);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al asignar conductor.' });
    }
});

// POST /api/packages/:id/dispatch
router.post('/:id/dispatch', authMiddleware, dispatchAllowed, async (req, res) => {
    let { id } = req.params;
    if (id && id.startsWith('SCA00-')) {
        id = id.replace('SCA00-', '');
    }
    const { driverId, flexCode, flexLabelPhotoBase64 } = req.body;
    try {
        // [NUEVO] Búsqueda extendida: Intentar encontrar por ID interno, ID de Mercado Libre, Shopify, Woo o Tracking ID
        let { rows: pkgRows } = await db.query(
            'SELECT id, status, "driverId", "meliFlexCode", source, "assignedAt" FROM packages WHERE id = $1 OR "meliOrderId" = $1 OR "shopifyOrderId" = $1 OR "wooOrderId" = $1 OR "jumpsellerOrderId" = $1 OR "trackingId" = $1 OR "meliFlexCode" = $1', 
            [id]
        );
        
        // [NUEVO] IMPORTACIÓN BAJO DEMANDA (Just-In-Time) - ALTAMENTE OPTIMIZADA (Unificado)
        if (pkgRows.length === 0 && isMeliCode(id)) {
            console.log(`[Dispatch] Package ${id} NOT found in DB. Starting Unified JIT Discovery...`);
            const importedId = await meliPollingService.optimizedJITDiscovery(id);
            if (importedId) {
                console.log(`[Dispatch] SUCCESS! Shipment ${id} discovered and imported as ${importedId}.`);
                const { rows: reCheck } = await db.query('SELECT id, status, "driverId", "meliFlexCode", source FROM packages WHERE id = $1', [importedId]);
                pkgRows = reCheck;
            }
        }

        if (pkgRows.length === 0) {
            console.warn(`[Dispatch] JIT Discovery failed for ID ${id}. Returning 404.`);
            return res.status(404).json({ message: `Paquete ${id} no encontrado. Asegúrate de que pertenezca a un cliente con integración activa.` });
        }
        const currentPkg = pkgRows[0];
        const realId = currentPkg.id; // Use the internal ID for updates
        
        if (['ENTREGADO', 'DEVUELTO'].includes(currentPkg.status)) {
            return res.status(400).json({ message: `Paquete ya se encuentra ${currentPkg.status}.` });
        }

        // Check duplicate and reassignment
        const { forceReassign } = req.body;
        if (['EN_TRANSITO', 'ASIGNADO'].includes(currentPkg.status)) {
            if (currentPkg.driverId === driverId) {
                // Check if it was assigned on a different logical date
                let isSameDay = false;
                if (currentPkg.assignedAt) {
                    const assignedDateStr = await timeService.getLogicalDate(currentPkg.assignedAt);
                    const todayStr = await timeService.getLogicalDate();
                    if (assignedDateStr === todayStr) {
                        isSameDay = true;
                    }
                }
                
                if (isSameDay) {
                    // Duplicate scan (same driver, same day)
                    const now = new Date();
                    await db.query(
                        'UPDATE packages SET "isDuplicate" = true, "alertChecked" = false, "updatedAt" = $1 WHERE id = $2',
                        [now, realId]
                    );
                    await addTrackingEvent(realId, 'ALERTA_DUPLICADO', 'Centro de Distribución', 'Alerta: Paquete escaneado como duplicado.');
                    await logAction(req.user.id, req.user.name, 'DISPATCH_DUPLICATE_ALERT', { packageId: realId, driverId });
                    return res.status(400).json({ 
                        message: '¡PAQUETE DUPLICADO! Este paquete ya fue escaneado para este conductor. Por favor, sepáralo del despacho.' 
                    });
                } else {
                    console.log(`[Dispatch] Package ${realId} was assigned on a different day (${currentPkg.assignedAt}). Treating as re-egress.`);
                }
            } else if (currentPkg.driverId) {
                // Reassignment (different driver)
                if (forceReassign !== true) {
                    const { rows: oldDriverRows } = await db.query('SELECT name FROM users WHERE id = $1', [currentPkg.driverId]);
                    const oldDriverName = oldDriverRows[0]?.name || 'desconocido';
                    return res.status(409).json({
                        code: 'REASSIGN_PROMPT',
                        message: `Este paquete ya está asignado al conductor ${oldDriverName}. ¿Deseas reasignarlo al nuevo conductor?`,
                        oldDriverName
                    });
                }
            }
        }

        // If a flexCode is explicitly provided in the body, use it.
        // Otherwise, if scanned ID is different from internal ID and we don't have a flex code, save it.
        let flexCodeToSave = flexCode || currentPkg.meliFlexCode;

        // [NUEVO] Si flexCodeToSave es un JSON (etiqueta oficial), extraer solo el ID
        if (flexCodeToSave && flexCodeToSave.startsWith('{')) {
            try {
                const parsed = JSON.parse(flexCodeToSave);
                if (parsed.id) flexCodeToSave = String(parsed.id);
            } catch (e) {
                // Fallback si no es un JSON válido
            }
        }

        if (!flexCode && id !== realId && !currentPkg.meliFlexCode) {
            flexCodeToSave = id;
        }

        const { rows: driverRows } = await db.query('SELECT name FROM users WHERE id = $1', [driverId]);
        if (driverRows.length === 0) return res.status(404).json({ message: 'Conductor no encontrado.' });
        const driverName = driverRows[0].name;

        let details = `Paquete despachado por ${driverName}.`;
        if (currentPkg.driverId && currentPkg.driverId !== driverId) {
            const { rows: oldDriverRows } = await db.query('SELECT name FROM users WHERE id = $1', [currentPkg.driverId]);
            const oldDriverName = oldDriverRows[0]?.name || 'desconocido';
            details = `Paquete re-asignado de ${oldDriverName} a ${driverName}.`;
        }

        // If flexCode provided, add it to notes as requested
        let notesUpdate = '';
        if (flexCode) {
            notesUpdate = `\n[Cod. Escaneado: ${flexCode}]`;
        }

        const isFlexed = currentPkg.source === 'MERCADO_LIBRE';
        const now = new Date();

        // Check if saveFlexLabelPhoto is enabled in system settings
        const { rows: settingsRows } = await db.query('SELECT "saveFlexLabelPhoto" FROM system_settings WHERE id = 1');
        const saveFlexLabelPhoto = settingsRows.length > 0 ? settingsRows[0].saveFlexLabelPhoto : false;

        const isReassignedVal = (currentPkg.driverId && currentPkg.driverId !== driverId) ? true : (currentPkg.isReassigned || false);

        const { rows } = await db.query(
            'UPDATE packages SET "driverId" = $1, status = $2, "updatedAt" = $3, "meliFlexCode" = $4, "flexLabelPhotoBase64" = $5, "isFlexed" = $6, "flexedAt" = CASE WHEN $6 = true AND "flexedAt" IS NULL THEN $3 ELSE "flexedAt" END, notes = COALESCE(notes, \'\') || $7, "assignedAt" = $3, "isReassigned" = $8, "alertChecked" = false, "isDuplicate" = false WHERE id = $9 RETURNING *',
            [driverId, 'EN_TRANSITO', now, flexCodeToSave, saveFlexLabelPhoto ? flexLabelPhotoBase64 : null, isFlexed, notesUpdate, isReassignedVal, realId]
        );

        await addTrackingEvent(realId, 'EN_TRANSITO', 'Centro de Distribución', details + (flexCode ? ` (QR: ${flexCode})` : ''));
        
        await logAction(req.user.id, req.user.name, 'DISPATCH_PACKAGE', { packageId: realId, driverId });

        const updatedPkg = rows[0];
        
        // Remove heavy photo fields from the scan response to save bandwidth
        if (updatedPkg) {
            delete updatedPkg.flexLabelPhotoBase64;
            delete updatedPkg.deliveryPhotosBase64;
            
            if (updatedPkg.destLatitude && updatedPkg.destLongitude) {
                updatedPkg.sectorName = gisService.getSectorForCoordinates(updatedPkg.destLatitude, updatedPkg.destLongitude);
            }
        }

        updatedPkg.history = await getHistory(realId);
        
        // Notify recipient
        NotificationService.notifyRecipient(realId, 'EN_TRANSITO');

        res.json({ 
            message: `Paquete ${realId} asignado a ${driverName} y en tránsito.`,
            package: updatedPkg
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al despachar paquete.' });
    }
});

// POST /api/packages/:id/flex
router.post('/:id/flex', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { isFlexed, flexLabelPhotoBase64 } = req.body;
    try {
        // Check current status before flex
        const checkResult = await db.query('SELECT status FROM packages WHERE id = $1', [id]);
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ message: 'Paquete no encontrado.' });
        }
        
        const currentStatus = checkResult.rows[0].status;
        if (currentStatus === 'ENTREGADO' || currentStatus === 'DEVUELTO') {
            return res.status(400).json({ 
                message: `No se puede marcar como Flex un paquete que ya está ${currentStatus}.` 
            });
        }

        const { rows } = await db.query(
            `UPDATE packages SET "isFlexed" = $1, "flexedAt" = $2, "updatedAt" = $3, "flexLabelPhotoBase64" = $4${isFlexed ? ", status = 'EN_TRANSITO', \"assignedAt\" = $3" : ""} WHERE id = $5 RETURNING *`,
            [isFlexed, isFlexed ? new Date() : null, new Date(), flexLabelPhotoBase64 || null, id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        
        const statusText = isFlexed ? 'Flexeado' : 'No Flexeado';
        const details = flexLabelPhotoBase64 ? `Paquete marcado como ${statusText} con respaldo de etiqueta.` : `Paquete marcado como ${statusText}.`;
        await addTrackingEvent(id, statusText, 'Centro de Distribución', details);
        
        await logAction(req.user.id, req.user.name, 'FLEX_PACKAGE', { packageId: id, isFlexed });

        if (isFlexed) {
            // REQ: Exact moment to send the tracking URL to the client
            const NotificationService = require('../services/notificationService');
            NotificationService.notifyRecipient(id, 'EN_TRANSITO');
        }

        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);
        res.json(updatedPackage);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar estado Flex.' });
    }
});

// POST /api/packages/sync-meli-all
router.post('/sync-meli-all', authMiddleware, async (req, res) => {
    try {
        const result = await meliPollingService.pollMeliPackages();
        res.json({ message: 'Sincronización masiva completada.', result });
    } catch (err) {
        console.error('Error in POST /api/packages/sync-meli-all:', err);
        res.status(500).json({ message: err.message || 'Error al actualizar paquetes.' });
    }
});

// [LEGACY/DEBUG] GET /api/packages/sys/status
router.get('/sys/status', authMiddleware, async (req, res) => {
    try {
        const meliStatus = meliPollingService.getStatus ? meliPollingService.getStatus() : { status: 'unknown' };
        res.json({ 
            success: true, 
            serverTime: new Date(),
            services: {
                meli: meliStatus
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/packages/:id/sync-meli
router.post('/:id/sync-meli', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await meliPollingService.syncPackage(id);
        res.json(result);
    } catch (err) {
        console.error('Error in POST /api/packages/:id/sync-meli:', err);
        res.status(500).json({ message: err.message || 'Error al sincronizar con Mercado Libre.' });
    }
});

// --- MELI API HELPERS (to be used in /deliver endpoint) ---
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
        req.on('error', (e) => reject(e));
        if (postData) req.write(postData);
        req.end();
    });
};
const makeMeliGetRequest = (path, accessToken) => makeMeliRequest({
    hostname: 'api.mercadolibre.com', path, method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}` }
});
const makeMeliPostRequest = (path, postData) => makeMeliRequest({
    hostname: 'api.mercadolibre.com', path, method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
}, postData);
// --- END MELI HELPERS ---

// --- FALABELLA SYNC LOGIC ---
const { decrypt, buildFalabellaSignature } = require('../services/falabellaCrypto');

async function syncDeliveryToFalabella(packageId, trackingId, attempts = 1) {
    const MAX_ATTEMPTS = 3;
    const DELAY_MULTIPLIER = 3000;
    
    if (attempts === 1) {
        try {
            await db.query(
                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [packageId, 'SYNC_FALABELLA_START', 'Falabella API', `Iniciando sincronización de entrega con Falabella Seller Center.`, new Date()]
            );
        } catch (e) { console.error(`[FalabellaSync] Start logging failed:`, e); }
    }
    
    try {
        let apiKey = null;
        let sellerId = null;

        // 1. Intentar obtener credenciales de la cuenta específica del usuario (Multi-Account)
        const { rows: pkgRows } = await db.query(
            'SELECT p."sourceAccountId", p."falabellaOrderId", p."falabellaTrackingId", u.integrations FROM packages p JOIN users u ON p."creatorId" = u.id WHERE p.id = $1',
            [packageId]
        );

        let falabellaOrderId = null;
        if (pkgRows.length > 0) {
            falabellaOrderId = pkgRows[0].falabellaOrderId;
            if (pkgRows[0].integrations) {
                const integrations = typeof pkgRows[0].integrations === 'string' ? JSON.parse(pkgRows[0].integrations) : pkgRows[0].integrations;
                const accounts = integrations.accounts || [];
                const falabellaAccount = accounts.find(acc => acc.id === pkgRows[0].sourceAccountId && acc.type === 'FALABELLA') 
                                         || accounts.find(acc => acc.type === 'FALABELLA');

                if (falabellaAccount && falabellaAccount.credentials) {
                    apiKey = falabellaAccount.credentials.falabellaApiKey;
                    sellerId = falabellaAccount.credentials.falabellaSellerId;
                }
            }
        }

        // 2. Fallback a la configuración global legacy si no se encontró en el usuario
        if (!apiKey || !sellerId) {
            const { rows: settingsRows } = await db.query(
                'SELECT falabella_api_key, falabella_seller_id FROM integration_settings WHERE id = 1'
            );
            if (settingsRows.length > 0 && settingsRows[0].falabella_api_key) {
                apiKey = decrypt(settingsRows[0].falabella_api_key);
                sellerId = settingsRows[0].falabella_seller_id;
            }
        }

        if (!apiKey || !sellerId) {
            throw new Error("Credenciales de Falabella no configuradas.");
        }

        if (!falabellaOrderId) {
            throw new Error("ID de orden de Falabella no encontrado en el paquete.");
        }

        // Helper local para realizar llamadas firmadas a Falabella
        const makeFalabellaApiCall = async (action, extraParams = null) => {
            const timestamp = new Date().toISOString();
            const params = {
                Action: action,
                Timestamp: timestamp,
                UserID: sellerId,
                Version: '1.0',
                Format: 'JSON',
                ...extraParams
            };
            const signature = buildFalabellaSignature(params, apiKey);
            params.Signature = signature;
            
            const queryString = Object.entries(params)
                .map(([key, val]) => `${encodeURIComponent(key)}=${encodeURIComponent(val)}`)
                .join('&');

            const https = require('https');
            return new Promise((resolve, reject) => {
                const options = {
                    hostname: 'sellercenter-api.falabella.com',
                    path: `/?${queryString}`,
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    }
                };
                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (e) {
                                resolve(data);
                            }
                        } else {
                            reject(new Error(`Falabella API returned HTTP ${res.statusCode}: ${data}`));
                        }
                    });
                });
                req.on('error', reject);
                req.end();
            });
        };

        // 3. Obtener los OrderItemIds asociados a la orden
        console.log(`[FalabellaSync] Fetching items for Falabella order ID: ${falabellaOrderId}`);
        const itemsResponse = await makeFalabellaApiCall('GetOrderItems', { OrderId: falabellaOrderId });
        
        const orderItemsRaw = itemsResponse?.SuccessResponse?.Body?.OrderItems;
        let orderItemIds = [];
        if (orderItemsRaw) {
            let items = [];
            if (Array.isArray(orderItemsRaw)) {
                items = orderItemsRaw;
            } else if (orderItemsRaw.OrderItem) {
                items = Array.isArray(orderItemsRaw.OrderItem) ? orderItemsRaw.OrderItem : [orderItemsRaw.OrderItem];
            }
            orderItemIds = items.map(item => item.OrderItemId).filter(Boolean);
        }

        if (orderItemIds.length === 0) {
            throw new Error(`No se encontraron ítems válidos (OrderItemIds) para la orden Falabella ID ${falabellaOrderId}`);
        }

        console.log(`[FalabellaSync] Found item IDs to update:`, orderItemIds);

        // 4. Intentar marcar la orden como 'shipped' (enviada) primero, por si acaso (algunos Seller Center restringen saltarse este paso)
        try {
            await makeFalabellaApiCall('SetStatusToShipped', {
                OrderItemIds: JSON.stringify(orderItemIds)
            });
            console.log(`[FalabellaSync] Items marked as shipped in Falabella.`);
        } catch (shippedErr) {
            console.warn(`[FalabellaSync] Transition to 'shipped' failed (might already be shipped): ${shippedErr.message}`);
        }

        // 5. Marcar la orden como 'delivered' (entregada)
        await makeFalabellaApiCall('SetStatusToDelivered', {
            OrderItemIds: JSON.stringify(orderItemIds)
        });
        
        await db.query(
            'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [packageId, 'SYNC_FALABELLA_OK', 'Falabella API', `Pedido sincronizado y cerrado exitosamente en Falabella (Items: ${orderItemIds.join(', ')}).`, new Date()]
        );
        console.log(`[FalabellaSync] Package ${packageId} synced successfully (delivered) with Falabella.`);
        
    } catch (error) {
        console.error(`[FalabellaSync] Fallo en intento ${attempts}/${MAX_ATTEMPTS} para paquete ${packageId}:`, error.message);
        
        if (attempts < MAX_ATTEMPTS) {
            const nextDelay = attempts * DELAY_MULTIPLIER;
            setTimeout(() => syncDeliveryToFalabella(packageId, trackingId, attempts + 1), nextDelay);
        } else {
            // Save in retry queue
            await db.query(
                'INSERT INTO integration_sync_queue ("packageId", integration, action, payload, error, "nextAttemptAt") ' +
                'VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL \'15 minutes\')',
                [packageId, 'FALABELLA', 'DELIVERY_CONFIRM', JSON.stringify({ trackingId }), error.message]
            );
            await db.query(
                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [packageId, 'SYNC_FALABELLA_ERROR', 'Falabella API', `Error al sincronizar: ${error.message}. Guardado en cola.`, new Date()]
            );
        }
    }
}
// --- END FALABELLA SYNC LOGIC ---

// --- ENVIAME SYNC LOGIC ---
async function syncDeliveryToEnviame(packageId, trackingId, attempts = 1) {
    const MAX_ATTEMPTS = 3;
    const DELAY_MULTIPLIER = 3000;

    if (attempts === 1) {
        try {
            await db.query(
                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [packageId, 'SYNC_ENVIAME_START', 'Envíame API', `Iniciando sincronización de entrega con Envíame.`, new Date()]
            );
        } catch (e) { console.error(`[EnviameSync] Start logging failed:`, e); }
    }

    try {
        const { rows: settingsRows } = await db.query(
            'SELECT enviame_api_key, enviame_environment FROM integration_settings WHERE id = 1'
        );

        if (settingsRows.length === 0 || !settingsRows[0].enviame_api_key) {
            throw new Error("Credenciales de Envíame no configuradas.");
        }

        const apiKey = decrypt(settingsRows[0].enviame_api_key);
        const environment = settingsRows[0].enviame_environment || 'stage';
        const baseUrl = environment === 'production' ? 'https://api.enviame.io' : 'https://stage.api.enviame.io';

        const https = require('https');
        await new Promise((resolve, reject) => {
            const payload = JSON.stringify({
                status_change: {
                    status: 6,
                    comment: "Entregado por Full Envíos"
                }
            });

            const urlObj = new URL(`${baseUrl}/v3/deliveries/${trackingId}/status`);
            
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`Envíame API returned HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(payload);
            req.end();
        });

        await db.query(
            'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
            [packageId, 'SYNC_ENVIAME_OK', 'Envíame API', `Entrega sincronizada exitosamente con Envíame.`, new Date()]
        );
        console.log(`[EnviameSync] Package ${packageId} synced successfully with Envíame.`);

    } catch (error) {
        console.error(`[EnviameSync] Fallo en intento ${attempts}/${MAX_ATTEMPTS} para paquete ${packageId}:`, error.message);
        
        if (attempts < MAX_ATTEMPTS) {
            const nextDelay = attempts * DELAY_MULTIPLIER;
            setTimeout(() => syncDeliveryToEnviame(packageId, trackingId, attempts + 1), nextDelay);
        } else {
            await db.query(
                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [packageId, 'SYNC_ENVIAME_ERROR', 'Envíame API', `Error al sincronizar: ${error.message}.`, new Date()]
            );
        }
    }
}
// --- END ENVIAME SYNC LOGIC ---

// POST /api/packages/:id/deliver
router.post('/:id/deliver', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { receiverName, receiverId, photosBase64 } = req.body;
    try {
        const { rows: settingsRows } = await db.query('SELECT "meliFlexValidation" FROM system_settings WHERE id = 1');
        const meliFlexValidation = settingsRows.length > 0 ? settingsRows[0].meliFlexValidation : true;

        // --- NEW MELI VALIDATION (STRICT & UNIFIED) ---
        if (meliFlexValidation) {
            try {
                const { rows: pkgRows } = await db.query('SELECT "meliFlexCode", "creatorId", "source", "sourceAccountId" FROM packages WHERE id = $1', [id]);
                if (pkgRows.length > 0 && pkgRows[0].meliFlexCode && pkgRows[0].source === 'MERCADO_LIBRE') {
                    const { meliFlexCode, creatorId, sourceAccountId } = pkgRows[0];

                    const accessToken = await meliPollingService.getValidMeliToken(creatorId, sourceAccountId);
                    
                    if (!accessToken) {
                        console.warn(`[Deliver] Could not obtain ML token for shipment ${meliFlexCode}. Allowing bypass.`);
                    } else {
                        let shippingDetails = null;
                        const maxAttempts = 3;
                        const delayMs = 3000;
                        
                        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                            try {
                                shippingDetails = await makeMeliGetRequest(`/shipments/${meliFlexCode}`, accessToken);
                                if (shippingDetails && shippingDetails.status === 'delivered') {
                                    break; // Success!
                                }
                            } catch (meliError) {
                                console.warn(`[Deliver] Meli status verification failed on attempt ${attempt} for shipment ${meliFlexCode}. Bypassing check to avoid blocking driver.`, meliError.body || meliError.message);
                                shippingDetails = { status: 'delivered' }; // Bypass on API error
                                break;
                            }
                            
                            if (attempt < maxAttempts) {
                                console.log(`[Deliver] Shipment ${meliFlexCode} status is ${shippingDetails?.status}. Retrying in ${delayMs/1000}s (Attempt ${attempt}/${maxAttempts})...`);
                                await new Promise(resolve => setTimeout(resolve, delayMs));
                            }
                        }
                        
                        if (shippingDetails && shippingDetails.status !== 'delivered') {
                            return res.status(400).json({ message: 'No se logro cerrar la entrega en la app de Mercado Libre Flex. Por favor intentelo en unos segundos mas y luego confirma nuevamente aquí.' });
                        }
                    }
                }
            } catch (validationError) {
                console.error('[Deliver] Fatal error in Meli validation block:', validationError);
                // We don't return 500 here to avoid blocking the whole delivery process
            }
        }
        // --- END MELI VALIDATION ---

        const { rows } = await db.query(
            'UPDATE packages SET status = $1, "deliveryReceiverName" = $2, "deliveryReceiverId" = $3, "deliveryPhotosBase64" = $4, "meliDeliveredNeedsPhotos" = false, "updatedAt" = $5 WHERE id = $6 RETURNING *',
            ['ENTREGADO', receiverName, receiverId, JSON.stringify(photosBase64), new Date(), id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });

        const now = new Date();
        await addTrackingEvent(id, 'ENTREGADO', rows[0].recipientAddress, `Entregado a ${receiverName}.`);
        
        // --- NUEVO: Capturar Cierre Oficial de ML ---
        let meliDeliveredAt = null;
        try {
            const { rows: pkgFullRows } = await db.query('SELECT "meliOrderId", "creatorId", "meliFlexCode", "sourceAccountId" FROM packages WHERE id = $1', [id]);
            if (pkgFullRows.length > 0 && (pkgFullRows[0].meliOrderId || pkgFullRows[0].meliFlexCode)) {
                const { meliOrderId, creatorId, meliFlexCode, sourceAccountId } = pkgFullRows[0];
                const shipmentId = meliFlexCode || meliOrderId;
                const accessToken = await meliPollingService.getValidMeliToken(creatorId, sourceAccountId);
                
                if (accessToken) {
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
                        meliDeliveredAt = new Date(meliTimeStr);
                        await db.query(
                            'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                            [id, 'CIERRE_OFICIAL_ML', 'Mercado Libre API', `Hora real capturada de ${source}: ${meliTimeStr}`, meliDeliveredAt]
                        );
                    }
                }
            }
        } catch (e) { console.warn('[Deliver] ML Hour fetch failed', e); }
        // --- FIN CAPTURA ML ---
        
        await logAction(req.user.id, req.user.name, 'DELIVER_PACKAGE', { packageId: id, receiverName });

        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);

        // --- NEW JUMPSELLER NOTIFICATION ---
        if (updatedPackage.jumpsellerOrderId) {
            try {
                const { rows: clientRows } = await db.query('SELECT integrations FROM users WHERE id = $1', [updatedPackage.creatorId]);
                const jumpseller = clientRows[0]?.integrations?.jumpseller;
                if (jumpseller && jumpseller.login && jumpseller.token) {
                    await jumpsellerPollingService.makeJumpsellerRequest(jumpseller.login, jumpseller.token, `/orders/${updatedPackage.jumpsellerOrderId}.json`, 'PUT', {
                        order: { status: 'Delivered' }
                    });
                    console.log(`[Deliver] Jumpseller order ${updatedPackage.jumpsellerOrderId} updated to Delivered.`);
                }
            } catch (jError) {
                console.error(`[Deliver] Failed to update Jumpseller order ${updatedPackage.jumpsellerOrderId}`);
            }
        }
        // --- NEW FALABELLA NOTIFICATION ---
        if (updatedPackage.source === 'FALABELLA' && updatedPackage.falabellaTrackingId) {
            syncDeliveryToFalabella(updatedPackage.id, updatedPackage.falabellaTrackingId)
                .catch(err => console.error(`[Deliver] Falabella sync trigger error:`, err));
            syncDeliveryToEnviame(updatedPackage.id, updatedPackage.falabellaTrackingId)
                .catch(err => console.error(`[Deliver] Envíame sync trigger error for Falabella order:`, err));
        }
        // --- END FALABELLA NOTIFICATION ---

        // --- NEW ENVIAME NOTIFICATION ---
        if (updatedPackage.source === 'ENVIAME' && updatedPackage.trackingId) {
            syncDeliveryToEnviame(updatedPackage.id, updatedPackage.trackingId)
                .catch(err => console.error(`[Deliver] Envíame sync trigger error:`, err));
        }
        // --- END ENVIAME NOTIFICATION ---

        // Notify recipient
        NotificationService.notifyRecipient(id, 'ENTREGADO');

        res.json(updatedPackage);

    } catch(err) {
        console.error(`[Deliver] Fatal error confirming delivery for package ${id}:`, err);
        res.status(500).json({ message: `Error al confirmar la entrega: ${err.message || 'Error desconocido'}` });
    }
});

// POST /api/packages/:id/problem
router.post('/:id/problem', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { reason, photosBase64 } = req.body;
    try {
        const isReschedule = reason.toLowerCase().includes('reagendar') || reason.toLowerCase().includes('reprogramar');
        const targetStatus = isReschedule ? 'REPROGRAMADO' : 'PROBLEMA';

        const { rows } = await db.query(
            'UPDATE packages SET status = $1, "deliveryPhotosBase64" = $2, "updatedAt" = $3 WHERE id = $4 RETURNING *',
            [targetStatus, JSON.stringify(photosBase64), new Date(), id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        await addTrackingEvent(id, 'PROBLEMA', rows[0].recipientAddress, `Problema reportado: ${reason}`);
        
        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);

        // Notify recipient
        NotificationService.notifyRecipient(id, targetStatus);

        // Notify administrator
        NotificationService.notifyAdminPendingDelivery(id, targetStatus, reason);

        res.json(updatedPackage);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al reportar el problema.' });
    }
});

// POST /api/packages/:id/pickup
router.post('/:id/pickup', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { flexCode } = req.body;
    const driverId = req.user.id;
    try {
         const { rows } = await db.query(
            'UPDATE packages SET status = $1, "driverId" = $2, "updatedAt" = $3, "meliFlexCode" = $4, "assignedAt" = $3 WHERE id = $5 RETURNING *',
            ['RETIRADO', driverId, new Date(), flexCode || null, id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        
        const driverName = (await db.query('SELECT name FROM users WHERE id = $1', [driverId])).rows[0]?.name;
        await addTrackingEvent(id, 'RETIRADO', rows[0].origin, `Retirado por conductor ${driverName}.`);
        
        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);

        // Notify recipient
        NotificationService.notifyRecipient(id, 'RETIRO');

        res.json(updatedPackage);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al marcar como retirado.' });
    }
});

// POST /api/packages/bulk-pickup-client
router.post('/bulk-pickup-client', authMiddleware, async (req, res) => {
    const { clientId } = req.body;
    const driverId = req.user.id;
    
    if (!clientId) {
        return res.status(400).json({ message: 'Client ID is required.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        
        // Get the driver's name for the event log
        const { rows: driverRows } = await client.query('SELECT name FROM users WHERE id = $1', [driverId]);
        const driverName = driverRows.length > 0 ? driverRows[0].name : 'Conductor';

        // Find all pending packages for this client
        const { rows: pendingPackages } = await client.query(
            'SELECT id, origin FROM packages WHERE "creatorId" = $1 AND status = $2',
            [clientId, 'PENDIENTE']
        );
        
        if (pendingPackages.length === 0) {
             await client.query('ROLLBACK');
             return res.status(200).json({ count: 0, message: 'No hay paquetes pendientes para retirar.' });
        }

        const packageIds = pendingPackages.map(p => p.id);

        // Update all pending packages to RETIRADO
        const placeholders = packageIds.map((_, i) => `$${i + 4}`).join(', ');
        const now = new Date();
        await client.query(
            `UPDATE packages SET status = $1, "driverId" = $2, "updatedAt" = $3, "assignedAt" = $3 WHERE id IN (${placeholders})`,
            ['RETIRADO', driverId, now, ...packageIds]
        );

        // Log events for each package
        const location = pendingPackages[0].origin || 'Tienda Cliente';
        const details = `Retiro masivo confirmado por conductor ${driverName}.`;
        
        const eventPromises = packageIds.map(pkgId => {
             // Notify recipient
             NotificationService.notifyRecipient(pkgId, 'RETIRO');

             return client.query(
                'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)',
                [pkgId, 'RETIRADO', location, details, new Date()]
            );
        });
        
        await Promise.all(eventPromises);

        // Update pickup_assignments table (New System)
        const today = await timeService.getLogicalDate();
        await client.query(
            `UPDATE pickup_assignments 
             SET status = 'RETIRADO', "packagesPickedUp" = $1, "updatedAt" = $2
             WHERE "clientId" = $3 AND status = 'ASIGNADO' 
             AND "runId" IN (SELECT id FROM pickup_runs WHERE "driverId" = $4 AND date = $5)`,
            [packageIds.length, new Date(), clientId, driverId, today]
        );


        await client.query('COMMIT');
        res.status(200).json({ count: packageIds.length, message: `Se retiraron ${packageIds.length} paquetes exitosamente.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ message: 'Error al procesar el retiro masivo.' });
    } finally {
        client.release();
    }
});

// POST /api/packages/:id/mark-for-return
router.post('/:id/mark-for-return', authMiddleware, async (req, res) => {
    const { id } = req.params;
    try {
        const { rows } = await db.query(
            'UPDATE packages SET status = $1, "updatedAt" = $2 WHERE id = $3 RETURNING *',
            ['PENDIENTE_DEVOLUCION', new Date(), id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        await addTrackingEvent(id, 'PENDIENTE_DEVOLUCION', 'Centro de Distribución', 'Devolución solicitada por administrador.');
        
        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);
        res.json(updatedPackage);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al marcar para devolución.' });
    }
});

// POST /api/packages/:id/return
router.post('/:id/return', authMiddleware, async (req, res) => {
    const { id } = req.params;
    const { receiverName, receiverId, photosBase64 } = req.body;
    try {
        const { rows } = await db.query(
            'UPDATE packages SET status = $1, "deliveryReceiverName" = $2, "deliveryReceiverId" = $3, "deliveryPhotosBase64" = $4, "updatedAt" = $5 WHERE id = $6 RETURNING *',
            ['DEVUELTO', receiverName, receiverId, JSON.stringify(photosBase64), new Date(), id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });

        await addTrackingEvent(id, 'DEVUELTO', rows[0].origin, `Devuelto a remitente. Recibido por ${receiverName}.`);
        
        const updatedPackage = rows[0];
        updatedPackage.history = await getHistory(id);

        // Notify recipient
        NotificationService.notifyRecipient(id, 'DEVOLUCION');

        res.json(updatedPackage);

    } catch(err) {
        console.error(err);
        res.status(500).json({ message: 'Error al confirmar la devolución.' });
    }
});

// POST /api/packages/:id/scan-admin
router.post('/:id/scan-admin', authMiddleware, async (req, res) => {
    let { id } = req.params;
    if (id && id.startsWith('SCA00-')) {
        id = id.replace('SCA00-', '');
    }
    try {
        const { rows: pkgRows } = await db.query(
            'SELECT id, status, "meliFlexCode" FROM packages WHERE id = $1 OR "meliOrderId" = $1 OR "shopifyOrderId" = $1 OR "wooOrderId" = $1 OR "trackingId" = $1 OR "meliFlexCode" = $1', 
            [id]
        );
        
        if (pkgRows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        
        const currentPkg = pkgRows[0];
        const realId = currentPkg.id;
        
        let flexCodeToSave = currentPkg.meliFlexCode;
        if (id !== realId && !currentPkg.meliFlexCode) {
            flexCodeToSave = id;
            await db.query('UPDATE packages SET "meliFlexCode" = $1 WHERE id = $2', [flexCodeToSave, realId]);
        }
        
        res.json({ message: `Paquete ${realId} escaneado correctamente.`, package: { ...currentPkg, meliFlexCode: flexCodeToSave } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al escanear paquete por admin.' });
    }
});

// POST /api/packages/mark-billed
router.post('/mark-billed', authMiddleware, async (req, res) => {
    const { packageIds } = req.body;
    if (!packageIds || !Array.isArray(packageIds)) {
        return res.status(400).json({ message: 'Se requiere un array de IDs de paquetes.' });
    }
    try {
        const placeholders = packageIds.map((_, i) => `$${i + 1}`).join(', ');
        if (packageIds.length > 0) {
            await db.query(`UPDATE packages SET billed = true WHERE id IN (${placeholders})`, packageIds);
        }
        res.status(204).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al marcar los paquetes como facturados.' });
    }
});

// GET /api/packages/public/track/:id
router.get('/public/track/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // Check if public tracking is enabled
        const { rows: settings } = await db.query('SELECT "publicTrackingEnabled" FROM system_settings WHERE id = 1');
        const isEnabled = settings.length > 0 ? settings[0].publicTrackingEnabled : true;

        if (!isEnabled) {
            return res.status(403).json({ message: 'El seguimiento público está desactivado por el administrador.' });
        }

        const { rows } = await db.query(
            `SELECT p.id, p.status, p."recipientName", p."recipientAddress", p."recipientCommune", p."recipientCity", 
                    p."estimatedDelivery", p."updatedAt", p."meliOrderId", p."trackingId", p."destLatitude", p."destLongitude",
                    u.latitude AS "driverLatitude", u.longitude AS "driverLongitude", u."lastLocationUpdate" AS "driverLastUpdate"
             FROM packages p
             LEFT JOIN users u ON p."driverId" = u.id
             WHERE p.id = $1 OR p."meliOrderId" = $1 OR p."shopifyOrderId" = $1 OR p."wooOrderId" = $1 OR p."trackingId" = $1 OR p."meliFlexCode" = $1`,
            [id]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        
        const pkg = rows[0];

        // Only share driver location if package is in transit or assigned
        const sharableStatuses = ['EN_TRANSITO', 'ASIGNADO'];
        if (!sharableStatuses.includes(pkg.status)) {
            delete pkg.driverLatitude;
            delete pkg.driverLongitude;
            delete pkg.driverLastUpdate;
        }

        pkg.history = await getHistory(pkg.id);
        res.json(pkg);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al consultar el seguimiento.' });
    }
});

// POST /api/packages/sys/bulk-mark-processed - Super Admin only reset
router.post('/sys/bulk-mark-processed', authMiddleware, async (req, res) => {
    // Only 'admin' account can perform this global reset
    if (req.user.email !== 'admin' && req.user.email !== 'admin@selcom.cl') {
        return res.status(403).json({ message: 'Solo el Super Administrador puede fijar un punto de inicio.' });
    }

    try {
        const query = `
            UPDATE packages 
            SET status = 'ENTREGADO', 
                billed = true, 
                "driverId" = NULL,
                "updatedAt" = NOW() 
            WHERE (status != 'ENTREGADO' AND status != 'CANCELADO' AND status != 'DEVUELTO') OR billed = false
        `;
        const result = await db.query(query);
        
        // Log action if logAction helper is available, otherwise console
        try {
            await db.query('INSERT INTO audit_logs (userId, userName, action, details) VALUES ($1, $2, $3, $4)', 
                [req.user.id, req.user.name, 'SYS_BULK_RESET', JSON.stringify({ count: result.rowCount })]);
        } catch (e) { console.warn('Audit log failed', e); }
        
        res.json({ 
            message: 'Punto de inicio establecido correctamente.', 
            updatedCount: result.rowCount 
        });
    } catch (err) {
        console.error('Error in /api/packages/sys/bulk-mark-processed:', err);
        res.status(500).json({ message: 'Error al establecer el punto de inicio.' });
    }
});

// POST /api/packages/sys/force-close-old - Admin only
router.post('/sys/force-close-old', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Solo el Administrador puede forzar el cierre de envíos.' });
    }

    const days = parseInt(req.body.days) || 30;

    try {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const result = await db.query(`
            UPDATE packages
            SET status = 'CANCELADO',
                billed = true,
                "updatedAt" = NOW()
            WHERE status NOT IN ('ENTREGADO', 'DEVUELTO', 'CANCELADO')
            AND "updatedAt" < $1
        `, [cutoffDate.toISOString()]);

        try {
            await db.query('INSERT INTO audit_logs ("userId", "userName", action, details) VALUES ($1, $2, $3, $4)',
                [req.user.id, req.user.name, 'FORCE_CLOSE_OLD', JSON.stringify({ days, count: result.rowCount, cutoffDate })]);
        } catch (e) { console.warn('Audit log failed', e); }

        res.json({
            message: `Cierre forzoso completado. ${result.rowCount} envíos cerrados.`,
            updatedCount: result.rowCount
        });
    } catch (err) {
        console.error('Error in /api/packages/sys/force-close-old:', err);
        res.status(500).json({ message: 'Error al forzar el cierre de envíos.' });
    }
});

// POST /api/packages/bulk-update-status
router.post('/bulk-update-status', authMiddleware, async (req, res) => {
    const { packageIds, status } = req.body;
    if (!packageIds || !Array.isArray(packageIds) || !status) {
        return res.status(400).json({ message: 'Se requiere un array de IDs y el nuevo estado.' });
    }

    try {
        const billed = status === 'ENTREGADO' || status === 'CANCELADO' || status === 'DEVUELTO';
        const placeholders = packageIds.map((_, i) => `$${i + 3}`).join(', ');
        
        let assignedAtClause = '';
        if (status === 'ASIGNADO' || status === 'EN_TRANSITO') {
            assignedAtClause = ', "assignedAt" = NOW()';
        }

        await db.query(`
            UPDATE packages 
            SET status = $1, 
                billed = $2, 
                "updatedAt" = NOW() 
                ${assignedAtClause}
            WHERE id IN (${placeholders})
        `, [status, billed, ...packageIds]);

        // Add tracking events
        for (const pkgId of packageIds) {
            await db.query('INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, NOW())', 
                [pkgId, status, 'Operaciones', `Estado actualizado masivamente por el administrador a ${status}.`]);
        }

        res.json({ message: `Se actualizaron ${packageIds.length} paquetes a ${status}.` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al actualizar paquetes masivamente.' });
    }
});

// POST /api/packages/:id/check-alert
router.post('/:id/check-alert', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { checked } = req.body; // true or false
        
        const result = await db.query(
            'UPDATE packages SET "alertChecked" = $1, "alertCheckedAt" = $2 WHERE id = $3 RETURNING *',
            [checked, checked ? new Date() : null, id]
        );
        
        if (result.rowCount === 0) return res.status(404).json({ message: 'Paquete no encontrado.' });
        
        await logAction(req.user.id, req.user.name, 'CHECK_ALERT', { packageId: id, checked });
        
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error al marcar alerta como revisada.' });
    }
});

/**
 * GET /api/packages/analytics/delivery-hours
 * Returns delivery counts grouped by hour for a given date range.
 */
router.get('/analytics/delivery-hours', authMiddleware, async (req, res) => {
    try {
        const targetDate = req.query.date || await timeService.getLogicalDate();
        const { start, nextDayStart } = await timeService.getLogicalTodayRange();
        const tz = await timeService.getSystemTimezone();
        
        const query = `
            SELECT 
                EXTRACT(HOUR FROM (timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3)) as hour,
                COUNT(*) as count
            FROM tracking_events
            WHERE status = 'ENTREGADO'
            AND timestamp >= $1::timestamp 
            AND timestamp < $2::timestamp
            GROUP BY hour
            ORDER BY hour ASC;
        `;

        const result = await db.query(query, [start, nextDayStart, tz]);
        
        const hourlyData = Array.from({ length: 24 }, (_, i) => ({
            hour: i,
            count: 0
        }));
        result.rows.forEach(row => {
            const h = parseInt(row.hour);
            if (h >= 0 && h < 24) {
                hourlyData[h].count = parseInt(row.count);
            }
        });

        res.json(hourlyData);
    } catch (err) {
        console.error('Error fetching delivery analytics:', err);
        res.status(500).json({ message: 'Error al obtener estadísticas.' });
    }
});

/**
 * GET /api/packages/analytics/late-deliveries
 * Returns detailed analysis of deliveries after 21:00, correlated with driver workload.
 */
router.get('/analytics/late-deliveries', authMiddleware, async (req, res) => {
    try {
        const targetDate = req.query.date || await timeService.getLogicalDate();
        const { start, nextDayStart } = await timeService.getLogicalRange(targetDate, targetDate);
        const tz = await timeService.getSystemTimezone();
        
        // Define late threshold (21:00 of the logical day start)
        const query = `
            SELECT 
                p.id,
                u.name as driver_name,
                c.name as seller_name,
                p."recipientCommune",
                p."driverId",
                (te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3)::date as delivery_day,
                (CASE 
                    WHEN EXTRACT(HOUR FROM (te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3)) < 2 
                    THEN EXTRACT(HOUR FROM (te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3)) + 24
                    ELSE EXTRACT(HOUR FROM (te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3))
                END + EXTRACT(MINUTE FROM (te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3))/60.0) as delivery_hour,
                (SELECT COUNT(*) FROM packages WHERE "driverId" = p."driverId" AND "assignedAt" >= $1 AND "assignedAt" < $2) as total_packages_day
            FROM tracking_events te
            JOIN packages p ON te."packageId" = p.id
            JOIN users u ON p."driverId" = u.id
            LEFT JOIN users c ON p."creatorId" = c.id
            WHERE te.status = 'ENTREGADO'
            AND te.timestamp >= ($1 + INTERVAL '19 hours') 
            AND te.timestamp < $2
            ORDER BY te.timestamp DESC;
        `;

        const result = await db.query(query, [start, nextDayStart, tz]);
        const rows = result.rows;

        const driverStatsResult = await db.query(`
            SELECT 
                "driverId",
                (te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3)::date as day,
                COUNT(*) as total_day,
                MIN(CASE WHEN EXTRACT(HOUR FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3) < 2 THEN EXTRACT(HOUR FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3) + 24 ELSE EXTRACT(HOUR FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3) END + EXTRACT(MINUTE FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3)/60.0) as first_h,
                MAX(CASE WHEN EXTRACT(HOUR FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3) < 2 THEN EXTRACT(HOUR FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3) + 24 ELSE EXTRACT(HOUR FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3) END + EXTRACT(MINUTE FROM te.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $3)/60.0) as last_h
            FROM tracking_events te
            JOIN packages p ON te."packageId" = p.id
            WHERE te.status = 'ENTREGADO'
            AND te.timestamp >= $1 AND te.timestamp < $2
            GROUP BY "driverId", day
        `, [start, nextDayStart, tz]);
        const driverStats = driverStatsResult.rows;

        const enrichedData = rows.map(row => {
            const rowDate = row.delivery_day ? new Date(row.delivery_day).toISOString().split('T')[0] : '';
            
            const stats = driverStats.find(s => {
                const sDate = s.day ? new Date(s.day).toISOString().split('T')[0] : '';
                return s.driverId === row.driverId && sDate === rowDate;
            });
            
            return {
                id: row.id,
                driver_name: row.driver_name,
                seller_name: row.seller_name || 'Sin Seller',
                recipientCommune: normalizeCommune(row.recipientCommune),
                delivery_day: rowDate,
                delivery_hour: row.delivery_hour,
                total_packages_day: stats ? parseInt(stats.total_day) : 0,
                first_delivery_hour: stats ? stats.first_h : row.delivery_hour,
                last_delivery_hour: stats ? stats.last_h : row.delivery_hour
            };
        });

        res.json(enrichedData);
    } catch (err) {
        console.error('Error fetching late delivery analytics:', err);
        res.status(500).json({ error: err.message });
    }
});

// [DEBUG] Temporary endpoint to check why packages from previous dates appear in alerts
router.get('/sys/debug-reassigned', async (req, res) => {
    try {
        const { rows } = await db.query(`
            SELECT id, "recipientName", status, "driverId", "assignedAt", "createdAt", "updatedAt", "isReassigned", "alertChecked"
            FROM packages 
            WHERE ("alertChecked" IS NULL OR "alertChecked" = false)
              AND (status IN ('CANCELADO', 'REPROGRAMADO') OR "isDuplicate" = true OR "isReassigned" = true)
            ORDER BY "updatedAt" DESC LIMIT 30
        `);
        
        const enriched = [];
        for (const pkg of rows) {
            const events = await db.query('SELECT timestamp, status, details FROM tracking_events WHERE "packageId" = $1 ORDER BY timestamp DESC', [pkg.id]);
            enriched.push({
                package: pkg,
                events: events.rows
            });
        }
        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sys/db-size', async (req, res) => {
    try {
        const sizeRes = await db.query("SELECT pg_size_pretty(pg_database_size('fullenvios')) as size");
        const countRes = await db.query("SELECT COUNT(*) as count FROM packages");
        const eventsRes = await db.query("SELECT COUNT(*) as count FROM tracking_events");
        res.json({
            databaseSize: sizeRes.rows[0].size,
            totalPackages: countRes.rows[0].count,
            totalEvents: eventsRes.rows[0].count
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
