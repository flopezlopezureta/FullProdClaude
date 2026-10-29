/**
 * Reglas compartidas por todas las vías que traen pedidos de Shopify: el sondeo automático (shopifyPollingService), la lista de importación
 * manual (GET /api/integrations/:clientId/shopify/orders) y la creación en lote (POST /api/packages/batch).
 *
 * Por qué existe: la protección contra duplicados vivía solo en el sondeo. Un cliente que ingresa sus pedidos a mano usando el número del pedido
 * como código del paquete ("2812" o "#2812", como hacen Donenic y Acuario) los volvía a recibir por la importación manual del panel, que no la tenía
 * (pasó con el #2812 de Donenic el 28-oct). Y cuando Shopify rechazaba la consulta, la lista manual respondía vacía con HTTP 200 sin decir por qué.
 *
 * Sin base de datos propia ni dependencias: las funciones reciben `run(text, params)` (db.query o client.query) para poder probarse sueltas.
 */

/** Códigos con los que un cliente suele ingresar a mano un pedido: el número ("2812"), "#2812" o el nombre del pedido. */
const manualCodesFor = (orderNumber, orderName) =>
    [...new Set([orderNumber, orderNumber ? `#${orderNumber}` : null, orderName].filter(Boolean).map(String))];

/**
 * Número y nombre de un pedido a partir de los datos de la importación: `shopifyOrderNumber` si viene, y si no, el texto de las notas
 * ("Shopify Order: #2812 (tienda)"). Las pantallas que no mandan el número (versiones guardadas en el teléfono o el navegador) siguen quedando cubiertas.
 */
function orderRefFromImport({ shopifyOrderNumber, notes } = {}) {
    const fromNotes = /Shopify Order:\s*(\S+)/i.exec(String(notes == null ? '' : notes));
    const orderName = fromNotes ? fromNotes[1] : null;
    const rawNumber = shopifyOrderNumber != null && String(shopifyOrderNumber).trim() !== '' ? String(shopifyOrderNumber).trim() : (orderName ? orderName.replace(/^#/, '') : null);
    return { orderNumber: rawNumber ? rawNumber.replace(/^#/, '') : null, orderName };
}

// Misma consulta, con los mismos parámetros y en el mismo orden, que usaba el sondeo.
const EXISTING_ORDER_SQL = 'SELECT id, "shopifyOrderId", "creatorId", status FROM packages WHERE "shopifyOrderId" = $1 OR "id" = $2 OR ("creatorId" = $3 AND "id" = ANY($4::text[]))';

/** ¿Ya existe un paquete para este pedido? IMPORTED = ya se importó (ID de Shopify); MANUAL = el cliente lo ingresó a mano con el número como código. */
async function findExistingForOrder(run, { shopifyOrderId, clientId, orderNumber, orderName }) {
    const orderId = String(shopifyOrderId);
    const { rows } = await run(EXISTING_ORDER_SQL, [orderId, orderId, clientId, manualCodesFor(orderNumber, orderName)]);
    if (!rows || rows.length === 0) return null;
    const imported = rows.find(r => String(r.shopifyOrderId) === orderId || String(r.id) === orderId);
    const row = imported || rows[0];
    return { id: row.id, status: row.status || null, kind: imported ? 'IMPORTED' : 'MANUAL' };
}

/**
 * Lo mismo para una lista de pedidos de una sola vez (la lista de importación): devuelve un Map orderId → { id, status, kind } solo con los que ya existen.
 * `orders`: [{ shopifyOrderId, orderNumber, orderName }].
 */
async function findExistingForOrders(run, { clientId, orders }) {
    const found = new Map();
    if (!orders || orders.length === 0) return found;
    const ids = orders.map(o => String(o.shopifyOrderId));
    const codes = [...new Set(orders.flatMap(o => manualCodesFor(o.orderNumber, o.orderName)))];
    const { rows } = await run(
        'SELECT id, "shopifyOrderId", "creatorId", status FROM packages WHERE "shopifyOrderId" = ANY($1::text[]) OR "id" = ANY($1::text[]) OR ("creatorId" = $2 AND "id" = ANY($3::text[]))',
        [ids, clientId, codes]
    );
    for (const o of orders) {
        const orderId = String(o.shopifyOrderId);
        const imported = rows.find(r => String(r.shopifyOrderId) === orderId || String(r.id) === orderId);
        if (imported) { found.set(orderId, { id: imported.id, status: imported.status || null, kind: 'IMPORTED' }); continue; }
        const mine = new Set(manualCodesFor(o.orderNumber, o.orderName));
        const manual = rows.find(r => String(r.creatorId) === String(clientId) && mine.has(String(r.id)));
        if (manual) found.set(orderId, { id: manual.id, status: manual.status || null, kind: 'MANUAL' });
    }
    return found;
}

/** Texto para el operador cuando un pedido no se importa porque ya existe. */
function duplicateMessage(existing, orderName, orderNumber) {
    const label = orderName || (orderNumber ? `#${orderNumber}` : 'de Shopify');
    const estado = existing.status ? `, ${existing.status}` : '';
    return existing.kind === 'MANUAL'
        ? `El pedido ${label} ya existe como paquete ingresado a mano (${existing.id}${estado}). No se importó para no duplicarlo.`
        : `El pedido ${label} ya fue importado antes (paquete ${existing.id}${estado}). No se importó de nuevo.`;
}

const clip = (s, n = 220) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
const errorsText = (body) => {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    if (Array.isArray(body)) return body.map(e => (e && typeof e === 'object' ? (e.message || JSON.stringify(e)) : String(e))).join('; ');
    if (typeof body === 'object') return body.errors ? errorsText(body.errors) : JSON.stringify(body);
    return String(body);
};

/**
 * Convierte lo que rechaza makeShopifyGraphQLRequest en un texto que el operador entienda. Esa función rechaza con un Error (falta la URL o el
 * token, falla de red) o con un objeto simple { statusCode, body } SIN `message`: por eso la lista manual registraba "undefined" y no se sabía nada.
 * Nunca devuelve un código HTTP para reenviar: un 401 de Shopify no debe confundirse con una sesión vencida de Full Envíos (la pantalla cierra la
 * sesión ante cualquier 401).
 * Devuelve { message: texto para el operador, detail: detalle técnico corto para soporte }.
 */
function describeShopifyError(err) {
    if (err && typeof err === 'object' && err.statusCode === undefined && err.body === undefined) {
        const m = err.message || String(err);
        return { message: clip(m), detail: clip(m) };
    }
    if (!err || typeof err !== 'object') return { message: 'Error desconocido al consultar Shopify.', detail: clip(err) };

    const status = Number(err.statusCode) || null;
    const raw = err.isRaw ? '' : errorsText(err.body);
    const codes = Array.isArray(err.body) ? err.body.map(e => e && e.extensions && e.extensions.code).filter(Boolean) : [];
    const detail = clip(`HTTP ${status || '?'}${raw ? ': ' + raw : ''}`);

    if (codes.includes('ACCESS_DENIED')) return { message: 'Shopify no entregó los datos: la app no tiene permiso para leer alguno de los campos pedidos. Avisa a soporte.', detail };
    if (codes.includes('THROTTLED') || status === 429) return { message: 'Shopify está limitando las consultas. Espera un minuto e inténtalo de nuevo.', detail };
    if (status === 401) return { message: 'Shopify rechazó las credenciales de la tienda (token inválido, vencido o revocado). Hay que volver a conectar la tienda en Integraciones.', detail };
    if (status === 402 || status === 403) return { message: 'Shopify no autoriza el acceso a esta tienda (tienda suspendida o app sin permisos).', detail };
    if (status === 404) return { message: 'Shopify no encontró la tienda. Revisa la URL de la tienda en Integraciones.', detail };
    if (status && status >= 500) return { message: `Shopify no está respondiendo bien en este momento (error ${status}). Inténtalo de nuevo en unos minutos.`, detail };
    if (err.isRaw) return { message: `Shopify respondió algo inesperado (HTTP ${status || '?'}).`, detail };
    return { message: 'Shopify rechazó la consulta de pedidos.', detail };
}

module.exports = { manualCodesFor, orderRefFromImport, findExistingForOrder, findExistingForOrders, duplicateMessage, describeShopifyError };
