const db = require('../db');
const timeService = require('./timeService');

// Red de seguridad para el cierre diario de los conductores. El cierre normal lo dispara la app
// del conductor con una llamada al servidor justo después de su última entrega — pero esa llamada
// es "dispara y olvida" y no sobrevive si el conductor cierra/minimiza el teléfono en ese instante
// (comportamiento completamente normal, no un error del conductor). Si eso pasa, el conductor
// queda entregando el 100% pero sin registro de cierre, mostrando "Sin Pendientes" para siempre en
// el Centro de Control en vez de "Cerrado en App". Este proceso corre solo, sin depender de nada
// del lado del conductor, y completa el cierre que debió haberse registrado.
async function reconcileMissingClosures() {
    try {
        const { dateStr, start, nextDayStart } = await timeService.getLogicalTodayRange();

        const { rows } = await db.query(
            `SELECT u.id as "driverId", u.name as "driverName",
                COUNT(p.id) as total,
                COUNT(p.id) FILTER (WHERE p.status = 'ENTREGADO') as delivered,
                COUNT(p.id) FILTER (WHERE p.status IN ('PROBLEMA', 'REPROGRAMADO', 'CANCELADO', 'DEVUELTO')) as problems,
                COUNT(p.id) FILTER (WHERE p.status IN ('PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO')) as pending
             FROM users u
             JOIN packages p ON p."driverId" = u.id AND p."assignedAt" >= $1 AND p."assignedAt" < $2
             WHERE u.role IN ('DRIVER', 'CONDUCTOR', 'CHOFER')
               AND u.status != 'ELIMINADO'
               AND NOT EXISTS (
                   SELECT 1 FROM daily_closures dc WHERE dc."driverId" = u.id AND dc.date = $3
               )
             GROUP BY u.id, u.name
             HAVING COUNT(p.id) > 0
                AND COUNT(p.id) FILTER (WHERE p.status IN ('PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO')) = 0`,
            [start, nextDayStart, dateStr]
        );

        for (const row of rows) {
            // ON CONFLICT DO NOTHING (no DO UPDATE): este proceso solo debe rellenar un cierre
            // faltante, nunca pisar uno que ya haya quedado registrado por el camino normal entre
            // el SELECT y el INSERT.
            await db.query(
                `INSERT INTO daily_closures
                 ("driverId", "driverName", date, "totalPackages", "deliveredCount", "pendingCount", "problemCount", "cancelledCount", notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)
                 ON CONFLICT ("driverId", date) DO NOTHING`,
                [row.driverId, row.driverName, dateStr, row.total, row.delivered, row.pending, row.problems,
                 'Cierre completado por la red de seguridad del servidor: el conductor ya no tenía pendientes pero el cierre automático de la app nunca llegó a registrarse.']
            );
            console.log(`[ClosureSafetyNet] Cierre completado para ${row.driverName} (${dateStr}): ${row.delivered}/${row.total} entregados.`);
        }
    } catch (err) {
        console.error('[ClosureSafetyNet] Error reconciliando cierres faltantes:', err);
    }
}

function start(intervalMs) {
    reconcileMissingClosures();
    setInterval(reconcileMissingClosures, intervalMs);
}

module.exports = { start, reconcileMissingClosures };
