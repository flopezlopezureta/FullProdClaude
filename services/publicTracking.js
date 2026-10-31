/**
 * Seguimiento PÚBLICO (GET /api/packages/public/track/:id): qué puede ver quien tenga un código de envío, SIN iniciar sesión.
 *
 * El enlace de seguimiento llega al comprador por WhatsApp/correo y lo abre cualquiera, así que esta respuesta se arma desde una
 * LISTA PERMITIDA de campos: lo que no se nombra aquí no sale, aunque mañana alguien agregue columnas a la consulta.
 *   - Nombre del comprador: solo iniciales ("M. J. P."). Dirección: no sale (la pantalla no la muestra). Comuna y ciudad sí.
 *   - Coordenadas del punto de entrega: redondeadas a ~100 m. El mapa necesita el punto para mostrar al repartidor acercándose,
 *     pero no la puerta exacta de la casa.
 *   - Posición del conductor: solo mientras el paquete va en camino (EN_TRANSITO / ASIGNADO), igual que antes. Nunca su nombre.
 *   - Historial: solo estado + hora + una frase fija por estado. Los textos libres de los eventos (`details`, `location`) traen
 *     nombres de conductores y de quien recibió, direcciones completas (el evento ENTREGADO guarda la dirección en `location`),
 *     comentarios internos y datos de integraciones; por eso NO se leen de la base en este camino y los eventos internos
 *     (COMENTARIO, SYNC_*, CIERRE_OFICIAL_ML, ALERTA_DUPLICADO, ...) no se publican.
 */

const COORD_DECIMALS = 3; // 0,001° ≈ 110 m de norte a sur y ≈ 90 m de oriente a poniente en Santiago
const MAX_KEY_LENGTH = 100;
const SHARE_DRIVER_LOCATION_STATUSES = ['EN_TRANSITO', 'ASIGNADO'];

// Solo los eventos con sentido para el comprador, con una frase fija (nunca el texto guardado en el evento).
const PUBLIC_EVENT_LABELS = Object.freeze({
    CREADO: 'Pedido registrado',
    PENDIENTE: 'Pedido pendiente',
    RETIRADO: 'Recibido en bodega',
    ASIGNADO: 'Asignado a un repartidor',
    EN_TRANSITO: 'En camino a la dirección de entrega',
    REPROGRAMADO: 'Entrega reprogramada',
    ENTREGADO: 'Entregado',
    PROBLEMA: 'Hubo un problema con la entrega',
    CANCELADO: 'Pedido cancelado',
    PENDIENTE_DEVOLUCION: 'Devolución en proceso',
    DEVUELTO: 'Devuelto al remitente',
    DIRECCION_ACTUALIZADA: 'Dirección actualizada',
});
// Distintos textos que usa el sistema para el mismo hecho ("Reasignado" es una asignación más para el comprador).
const PUBLIC_EVENT_ALIASES = Object.freeze({ REASIGNADO: 'ASIGNADO' });

// 'En Tránsito' / 'EN_TRANSITO' / 'Dirección Actualizada' → 'EN_TRANSITO' / 'DIRECCION_ACTUALIZADA'
const normalizeEventStatus = (raw) => {
    const code = String(raw ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return PUBLIC_EVENT_ALIASES[code] || code;
};

// "María José Pérez" → "M. J. P." (máximo 4 iniciales). Sin nombre utilizable → null.
const maskRecipientName = (name) => {
    if (typeof name !== 'string') return null;
    const initials = name.trim().split(/\s+/).map((word) => {
        const first = Array.from(word).find((ch) => /[\p{L}\p{N}]/u.test(ch));
        return first ? `${first.toLocaleUpperCase('es-CL')}.` : null;
    }).filter(Boolean).slice(0, 4);
    return initials.length ? initials.join(' ') : null;
};

// Redondea a COORD_DECIMALS decimales. Valor ausente, no numérico o ~0 (el marcador 0.000001 que dejó la geocodificación fallida:
// la app opera en Chile, ninguna coordenada real redondea a 0) → null, es decir "sin punto en el mapa".
const roundCoordinate = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const factor = 10 ** COORD_DECIMALS;
    const rounded = Math.round(n * factor) / factor;
    return rounded === 0 ? null : rounded;
};

// `events` = filas { status, timestamp } (solo esas dos columnas). Devuelve el historial público, el más reciente primero:
// solo eventos permitidos, con su frase fija; "Pedido registrado" una sola vez (el sistema también usa 'Creado' al desasignar);
// y sin repetir seguidos el mismo hecho (el paquete se escanea varias veces: 'En Tránsito' + 'EN_TRANSITO'), conservando la hora
// en que empezó.
const buildPublicHistory = (events) => {
    const ascending = [...(events || [])].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const kept = [];
    let created = false;
    for (const event of ascending) {
        const code = normalizeEventStatus(event.status);
        if (!Object.prototype.hasOwnProperty.call(PUBLIC_EVENT_LABELS, code)) continue;
        if (code === 'CREADO') {
            if (created) continue;
            created = true;
        }
        if (kept.length && kept[kept.length - 1].status === code) continue;
        kept.push({ status: code, details: PUBLIC_EVENT_LABELS[code], timestamp: event.timestamp });
    }
    return kept.reverse();
};

// `row` = una fila de la consulta pública (ver routes/packages.js). Solo se copian los campos permitidos, uno por uno.
const buildPublicTrackingView = (row, events) => {
    const lat = roundCoordinate(row.destLatitude);
    const lng = roundCoordinate(row.destLongitude);
    const hasPoint = lat !== null && lng !== null; // medio punto no sirve en el mapa
    const view = {
        id: row.id,
        status: row.status,
        recipientName: maskRecipientName(row.recipientName),
        recipientCommune: row.recipientCommune ?? null,
        recipientCity: row.recipientCity ?? null,
        estimatedDelivery: row.estimatedDelivery ?? null,
        updatedAt: row.updatedAt ?? null,
        destLatitude: hasPoint ? lat : null,
        destLongitude: hasPoint ? lng : null,
        history: buildPublicHistory(events),
    };
    if (SHARE_DRIVER_LOCATION_STATUSES.includes(row.status)) {
        view.driverLatitude = row.driverLatitude ?? null;
        view.driverLongitude = row.driverLongitude ?? null;
        view.driverLastUpdate = row.driverLastUpdate ?? null;
    }
    return view;
};

// Un código vacío o absurdamente largo no puede ser un código real: se responde como "no existe" sin consultar la base.
const isPlausibleTrackingKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH;

module.exports = {
    buildPublicTrackingView,
    buildPublicHistory,
    maskRecipientName,
    roundCoordinate,
    normalizeEventStatus,
    isPlausibleTrackingKey,
    PUBLIC_EVENT_LABELS,
    COORD_DECIMALS,
    MAX_KEY_LENGTH,
};
