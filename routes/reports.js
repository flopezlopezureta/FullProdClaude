const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');

/**
 * GET /api/reports/activity-audit
 * Detailed report of delivery activities, attempts, and status breakdown.
 */
router.get('/activity-audit', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN' && req.user.role !== 'FACTURACION') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }

    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'Se requieren fechas de inicio y fin.' });
    }

    try {
        // Query logic:
        // 1. Get package counts grouped by client and their final status
        // 2. Correlate with tracking_events to count "Attempts" (Problem events before success)
        
        const query = `
            WITH event_summary AS (
                SELECT 
                    "packageId",
                    COUNT(*) FILTER (WHERE status = 'ENTREGADO' AND timestamp >= $1 AND timestamp <= $2) as delivered_events,
                    COUNT(*) FILTER (WHERE status IN ('PROBLEMA', 'REPROGRAMADO') AND timestamp >= $1 AND timestamp <= $2) as problem_events,
                    COUNT(*) FILTER (WHERE status = 'DEVUELTO' AND timestamp >= $1 AND timestamp <= $2) as returned_events,
                    MAX(timestamp) FILTER (WHERE status = 'ENTREGADO') as last_delivery_date,
                    MAX(timestamp) FILTER (WHERE status IN ('PROBLEMA', 'REPROGRAMADO')) as last_problem_date
                FROM tracking_events
                GROUP BY "packageId"
            ),
            package_data AS (
                SELECT 
                    p.id,
                    p."creatorId",
                    p.status as current_status,
                    COALESCE(es.delivered_events, 0) as delivered_count,
                    COALESCE(es.problem_events, 0) as failed_attempts,
                    COALESCE(es.returned_events, 0) as returned_count,
                    es.last_delivery_date
                FROM packages p
                LEFT JOIN event_summary es ON p.id = es."packageId"
                WHERE 
                    (p."createdAt" >= $1 AND p."createdAt" <= $2)
                    OR (es.last_delivery_date >= $1 AND es.last_delivery_date <= $2)
                    OR (es.last_problem_date >= $1 AND es.last_problem_date <= $2)
            )
            SELECT 
                u.id as "clientId",
                u.name as "clientName",
                u."companyName",
                COUNT(pd.id) as "total",
                COUNT(pd.id) FILTER (WHERE pd.delivered_count > 0) as "successTotal",
                COUNT(pd.id) FILTER (WHERE pd.delivered_count > 0 AND pd.failed_attempts = 0) as "successFirstAttempt",
                COUNT(pd.id) FILTER (WHERE pd.delivered_count > 0 AND pd.failed_attempts = 1) as "successSecondAttempt",
                COUNT(pd.id) FILTER (WHERE pd.delivered_count > 0 AND pd.failed_attempts > 1) as "successMultipleAttempts",
                COUNT(pd.id) FILTER (WHERE pd.current_status IN ('PROBLEMA', 'REPROGRAMADO', 'CANCELADO') AND pd.delivered_count = 0) as "failedCurrently",
                COUNT(pd.id) FILTER (WHERE pd.current_status = 'DEVUELTO' OR (pd.returned_count > 0 AND pd.delivered_count = 0)) as "returnedTotal",
                COUNT(pd.id) FILTER (WHERE pd.current_status IN ('ASIGNADO', 'RETIRADO', 'EN_TRANSITO') AND pd.delivered_count = 0) as "inTransit",
                COUNT(pd.id) FILTER (WHERE pd.current_status NOT IN ('ENTREGADO', 'PROBLEMA', 'REPROGRAMADO', 'CANCELADO', 'DEVUELTO', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO') AND pd.delivered_count = 0) as "pending",
                COUNT(pd.id) FILTER (WHERE pd.delivered_count > 0 OR pd.current_status IN ('PROBLEMA', 'REPROGRAMADO', 'CANCELADO', 'DEVUELTO', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO')) as "dispatched"
            FROM package_data pd
            JOIN users u ON pd."creatorId" = u.id
            GROUP BY u.id, u.name, u."companyName"
            ORDER BY "successTotal" DESC;
        `;

        const result = await db.query(query, [startDate + ' 00:00:00', endDate + ' 23:59:59']);
        
        res.json(result.rows);
    } catch (err) {
        console.error('Error in activity-audit report:', err);
        res.status(500).json({ message: 'Error al generar el reporte de auditoría.' });
    }
});

/**
 * GET /api/reports/meli-confirmed-stuck
 * Paquetes que Mercado Libre ya reportó como entregados (meliDeliveredNeedsPhotos = true) pero que
 * siguen abiertos en el sistema — SIN límite de días a propósito (a diferencia de /driver/stale y
 * el bloqueo del conductor, que se mantienen acotados a 7 días por decisión explícita del usuario,
 * para no exponer de golpe a toda la flota). Este reporte es la única forma de encontrar casos
 * viejos (semanas o meses) que ya no le van a bloquear ni avisar a ningún conductor.
 */
router.get('/meli-confirmed-stuck', authMiddleware, async (req, res) => {
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ message: 'Acceso denegado.' });
    }
    try {
        const { rows } = await db.query(`
            SELECT
                p.id,
                p."recipientAddress",
                p."recipientCommune",
                p.status,
                p."assignedAt",
                p.source,
                d.name as "driverName",
                c.name as "clientName",
                EXTRACT(DAY FROM NOW() - p."assignedAt")::int as "daysPending"
            FROM packages p
            LEFT JOIN users d ON p."driverId" = d.id
            LEFT JOIN users c ON p."creatorId" = c.id
            WHERE p."meliDeliveredNeedsPhotos" = true
              AND p.status IN ('PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO')
            ORDER BY p."assignedAt" ASC
        `);
        res.json(rows);
    } catch (err) {
        console.error('Error in meli-confirmed-stuck report:', err);
        res.status(500).json({ message: 'Error al generar el reporte de pendientes confirmados por Mercado Libre.' });
    }
});

module.exports = router;
