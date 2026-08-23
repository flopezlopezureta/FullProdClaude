const db = require('../db');

// Cuánto tiempo se conservan los datos personales del comprador (nombre, teléfono, correo,
// dirección) después de que un paquete queda en un estado final. El registro del paquete en sí
// (id, estado, fechas, precio) NO se borra — se necesita para reportes y facturación con el
// cliente — solo se anonimizan los datos personales del comprador final.
const RETENTION_MONTHS = 6;

async function anonymizeOldDeliveredPackages() {
    try {
        const { rows } = await db.query(
            `UPDATE packages
             SET "recipientName" = 'Comprador eliminado (retención)',
                 "recipientPhone" = NULL,
                 "recipientEmail" = NULL,
                 "recipientAddress" = 'Eliminado por política de retención'
             WHERE status IN ('ENTREGADO', 'DEVUELTO')
               AND "updatedAt" < NOW() - INTERVAL '${RETENTION_MONTHS} months'
               AND "recipientAddress" IS DISTINCT FROM 'Eliminado por política de retención'
             RETURNING id`
        );
        if (rows.length > 0) {
            console.log(`[DataRetention] Anonimizados ${rows.length} paquete(s) entregados/devueltos hace más de ${RETENTION_MONTHS} meses.`);
        }
    } catch (err) {
        console.error('[DataRetention] Error al anonimizar paquetes antiguos:', err);
    }
}

function start(intervalMs) {
    anonymizeOldDeliveredPackages();
    setInterval(anonymizeOldDeliveredPackages, intervalMs);
}

module.exports = { start, anonymizeOldDeliveredPackages };
