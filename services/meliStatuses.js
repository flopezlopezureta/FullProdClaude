/**
 * Estado de los envíos en Mercado Libre (lo que devuelve GET /shipments/{id}: `status` y `substatus`) y cómo se agrupa en el filtro "Estado ML" del panel
 * de paquetes.
 *
 * Por qué existe: el sistema solo sabía el estado PROPIO del paquete (pendiente, en tránsito, entregado…), y de los envíos ML "pendientes" una buena parte ya
 * figuraba entregada en Mercado Libre (de los pendientes creados hace 2 días, prácticamente todos). Para exigir a los conductores que entreguen lo que de verdad
 * falta —sin perjudicar a los sellers— hay que ver el estado de ML. El sondeo lo guarda en packages."meliStatus"/"meliSubstatus"/"meliStatusCheckedAt".
 *
 * Sin base de datos ni dependencias: solo reglas, para poder probarlas sueltas.
 */

// Estados terminales en ML: una vez ahí, el envío no cambia más y se deja de consultar.
const TERMINAL = ['delivered', 'cancelled', 'not_found'];

// Grupos del filtro. `statuses` va a SQL como literales fijos (nunca texto que venga del navegador).
const GROUPS = {
    // Todo lo que Mercado Libre aún NO da por entregado ni cancelado: lo que hay que mover.
    pending: ['pending', 'handling', 'ready_to_ship', 'shipped'],
    // Aún sin salir a reparto: la etiqueta se imprime, se prepara o espera retiro.
    ready: ['pending', 'handling', 'ready_to_ship'],
    // En manos de un conductor (en camino, incluidos los reprogramados o con comprador ausente).
    shipped: ['shipped'],
    delivered: ['delivered'],
    not_delivered: ['not_delivered'],
    cancelled: ['cancelled'],
};

const isGroup = (value) => typeof value === 'string' && (Object.prototype.hasOwnProperty.call(GROUPS, value) || value === 'unknown');

/**
 * Condición SQL para el filtro `meliStatusFilter`, o null si no trae ningún valor permitido (se ignora, no se intenta interpretar).
 * Acepta un grupo ("shipped") o varios a la vez separados por coma ("ready,shipped,not_delivered", o repetidos en la URL): se juntan con O, así que el panel
 * puede mostrar varios estados de Mercado Libre juntos. Cada valor desconocido se descarta; la condición sale solo de constantes de este archivo.
 * "unknown" = paquetes de Mercado Libre que todavía no se han consultado.
 */
function filterClause(value) {
    const tokens = (Array.isArray(value) ? value : String(value == null ? '' : value).split(',')).map(t => (typeof t === 'string' ? t.trim() : t)).filter(isGroup);
    if (tokens.length === 0) return null;
    const statuses = [...new Set(tokens.filter(t => t !== 'unknown').flatMap(t => GROUPS[t]))];
    const parts = [];
    if (statuses.length > 0) parts.push(`p."meliStatus" IN (${statuses.map(s => `'${s}'`).join(', ')})`);
    if (tokens.includes('unknown')) parts.push(`(p.source = 'MERCADO_LIBRE' AND p."meliStatus" IS NULL)`);
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

// Cada cuántos minutos conviene volver a preguntarle a ML por un envío según su último estado: los que van en camino cambian rápido (se entregan), los que
// esperan retiro casi no se mueven. Se usa solo en el sondeo frecuente de los envíos recientes.
const RECHECK_MINUTES = { shipped: 4, not_delivered: 10, default: 15 };
const recheckMinutes = (status) => (status && RECHECK_MINUTES[status]) || RECHECK_MINUTES.default;

// Qué tan atrás se mira en el sondeo frecuente: los envíos creados o asignados hace pocos días (lo viejo lo cubre el sondeo general, más lento).
const RECENT_DAYS_CREATED = 3;
const RECENT_DAYS_ASSIGNED = 2;

module.exports = { TERMINAL, GROUPS, isGroup, filterClause, RECHECK_MINUTES, recheckMinutes, RECENT_DAYS_CREATED, RECENT_DAYS_ASSIGNED };
