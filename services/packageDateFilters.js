'use strict';
/**
 * Filtro de fecha «por cierre» de GET /api/packages (parámetro dateType=closed).
 *
 * Por qué existe: para un administrador, el filtro de fechas de GET /api/packages mira cuándo se CREÓ el paquete (o su entrega estimada), no cuándo se entregó.
 * El «Rendimiento por Conductor» del panel pide «las entregas de este conductor entre el 1 y el 10» y así se perdían las entregas de paquetes creados antes del
 * rango (p. ej. creados el viernes y entregados el lunes): hasta la mitad de las entregas de un solo día. El teléfono del conductor, en cambio, entra por una rama
 * propia que sí mira asignación, actualización y eventos, y por eso mostraba el número correcto.
 *
 * dateType=closed devuelve los paquetes que se CERRARON (evento ENTREGADO, PROBLEMA o DEVUELTO en el seguimiento) dentro del rango de DÍAS DE CALENDARIO, que es
 * como los cuenta después la propia pantalla (de las 00:00 del primer día a las 23:59:59.999 del último, en la zona horaria de la sesión de la base). Es un
 * conjunto igual o mayor al que la pantalla deja al final: ella vuelve a filtrar por la fecha exacta del último evento de cierre.
 */

// Los estados de seguimiento que cierran un paquete: son los mismos con los que la pantalla fecha una entrega.
const CLOSING_EVENT_STATUSES = ['ENTREGADO', 'PROBLEMA', 'DEVUELTO'];

/** De las 00:00 de startDate a las 00:00 del día siguiente a endDate (YYYY-MM-DD); texto listo para comparar con columnas timestamptz en la zona de la sesión. */
function calendarRange(startDateStr, endDateStr) {
    const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
    if (!isDay(startDateStr) || !isDay(endDateStr)) throw new Error(`Rango de fechas inválido: ${startDateStr} → ${endDateStr}`);
    const next = new Date(`${endDateStr}T12:00:00Z`);   // al mediodía UTC la suma de un día cae siempre en el día de calendario siguiente
    next.setUTCDate(next.getUTCDate() + 1);
    return { start: `${startDateStr} 00:00:00`, nextDayStart: `${next.toISOString().slice(0, 10)} 00:00:00` };
}

/**
 * Condición SQL (alias p = packages) para «cerrado dentro de [$a, $b)»: tiene un evento de cierre en el rango; y si nunca tuvo ninguno (paquetes antiguos o
 * importados sin historial), cuenta su última actualización, igual que la pantalla. `a` y `b` son los números de los parámetros ($a, $b).
 */
function closedInRangeClause(a, b) {
    const list = CLOSING_EVENT_STATUSES.map((s) => `'${s}'`).join(', ');
    return `(
                    p.id IN (SELECT "packageId" FROM tracking_events WHERE status IN (${list}) AND timestamp >= $${a} AND timestamp < $${b})
                    OR (p."updatedAt" >= $${a} AND p."updatedAt" < $${b}
                        AND NOT EXISTS (SELECT 1 FROM tracking_events te WHERE te."packageId" = p.id AND te.status IN (${list})))
                )`;
}

module.exports = { CLOSING_EVENT_STATUSES, calendarRange, closedInRangeClause };
