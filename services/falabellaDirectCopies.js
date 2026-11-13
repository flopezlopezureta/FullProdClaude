'use strict';
/**
 * Copias de Seller Center de pedidos de Falabella Directo.
 *
 * Un pedido de Falabella Directo (en Seller Center se ve con transportista «falaflex» y tipo «direct»; el código de la etiqueta, el LPN, viaja en el TrackingCode
 * del ítem) solo le informa a Falabella cada paso de la entrega cuando su etiqueta se escanea en el escáner de Falabella Directo: ese escaneo crea el paquete
 * FALDIR-, lo asigna y envía los estados. Si en cambio se asigna y se cierra la copia que trae la importación de Seller Center, Falabella nunca se entera y
 * sigue mostrando el pedido como «listo para despachar».
 *
 * Este módulo reconoce esas copias (con una consulta de solo lectura a Seller Center) para:
 *   - rechazar su asignación (una, varias o por escáner) con un mensaje que manda a escanear la etiqueta, y
 *   - dejar un aviso en el historial si una copia ya asignada se cierra de todos modos.
 *
 * Diseño: ante cualquier duda NO se bloquea. Sin credenciales, sin número de pedido, con un error o una demora de Falabella, o con un error de la base,
 * la copia se trata como un paquete normal; nunca se frena una operación por no poder consultar.
 */
const { getOrderItems, unwrapFalabellaList } = require('./falabellaSellerApiService');

const CODE = 'FALABELLA_DIRECTO_SCAN_REQUIRED';
const CLOSED_WITHOUT_SCAN_EVENT = 'FALABELLA_DIRECTO_SIN_ESCANEO';
const LOOKUP_TIMEOUT_MS = 6000;   // por pedido
const TOTAL_BUDGET_MS = 12000;    // para todo un lote: lo que no alcanza a consultarse se deja pasar
const CACHE_MS = 10 * 60 * 1000;
const MAX_PARALLEL = 3;
const SCAN_ADVICE = 'Escanea su etiqueta con el escáner de Falabella Directo: así Falabella recibe cada paso de la entrega.';

const cache = new Map(); // id de paquete -> { at, info }
let clock = () => Date.now();

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// ¿Este ítem de Seller Center es de Falabella Directo?
function isDirectoItem(item) {
    return !!item && norm(item.ShipmentProvider) === 'falaflex' && norm(item.ShippingProviderType) === 'direct';
}

// De los ítems de GetOrderItems: si el pedido es de Directo, su LPN y el estado que Falabella muestra.
function classifyItems(items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const directo = list.filter(isDirectoItem);
    const withCode = directo.find((i) => i.TrackingCode);
    const statuses = [...new Set(list.map((i) => i.Status).filter(Boolean))];
    return {
        isDirecto: directo.length > 0,
        lpn: withCode ? String(withCode.TrackingCode) : null,
        falabellaStatus: statuses.length > 0 ? statuses.join(', ') : null
    };
}

// La cuenta de Falabella de quien creó el paquete: la que lo importó o, si no, la primera.
function accountFor(row) {
    let integrations = row.integrations;
    if (typeof integrations === 'string') { try { integrations = JSON.parse(integrations); } catch (e) { integrations = null; } }
    const accounts = (integrations && integrations.accounts) || [];
    return accounts.find((a) => a.id === row.sourceAccountId && a.type === 'FALABELLA') || accounts.find((a) => a.type === 'FALABELLA') || null;
}

async function lookup(row, deps) {
    const account = accountFor(row);
    const creds = account && account.credentials;
    if (!creds || !creds.falabellaApiKey || !creds.falabellaSellerId || !row.falabellaOrderId) return null;

    const cached = cache.get(row.id);
    if (cached && clock() - cached.at < CACHE_MS) return cached.info;

    let timer;
    try {
        const response = await Promise.race([
            deps.getOrderItems(creds.falabellaApiKey, creds.falabellaSellerId, row.falabellaOrderId),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('demora')), deps.timeoutMs); })
        ]);
        const info = classifyItems(deps.unwrap(response, 'OrderItems', 'OrderItem'));
        cache.set(row.id, { at: clock(), info });
        return info;
    } catch (e) {
        return null; // sin respuesta fiable: no se bloquea
    } finally {
        clearTimeout(timer);
    }
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/**
 * De estos paquetes, ¿cuáles son copias de Seller Center de un pedido de Falabella Directo (sin su paquete FALDIR)?
 * `query(text, params)` es el de la base. Devuelve { blocked: [{ id, orderNumber, lpn, falabellaStatus }], unchecked: n }.
 * `unchecked` cuenta las copias que no se pudieron consultar (se tratan como normales).
 */
async function findDirectoCopies(query, packageIds, overrides = {}) {
    const deps = { getOrderItems, unwrap: unwrapFalabellaList, timeoutMs: LOOKUP_TIMEOUT_MS, budgetMs: TOTAL_BUDGET_MS, ...overrides };
    const ids = [...new Set((packageIds || []).filter(Boolean))];
    if (ids.length === 0) return { blocked: [], unchecked: 0 };

    let rows;
    try {
        ({ rows } = await query(
            `SELECT p.id, p."falabellaOrderId", p."falabellaTrackingId", p."sourceAccountId", u.integrations
               FROM packages p JOIN users u ON u.id = p."creatorId"
              WHERE p.id = ANY($1::text[]) AND p.source = 'FALABELLA' AND p."falabellaDirectLpn" IS NULL
                AND p.status NOT IN ('ENTREGADO', 'DEVUELTO', 'CANCELADO')`,
            [ids]
        ));
    } catch (e) {
        return { blocked: [], unchecked: ids.length };
    }

    const deadline = clock() + deps.budgetMs;
    let unchecked = 0;
    const blocked = [];
    await mapLimit(rows, MAX_PARALLEL, async (row) => {
        if (clock() > deadline) { unchecked++; return; }
        const info = await lookup(row, deps);
        if (!info) { unchecked++; return; }
        if (info.isDirecto) blocked.push({ id: row.id, orderNumber: row.falabellaTrackingId || row.falabellaOrderId || null, lpn: info.lpn, falabellaStatus: info.falabellaStatus });
    });
    blocked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { blocked, unchecked };
}

const label = (b) => `${b.orderNumber ? 'nº ' + b.orderNumber : b.id}${b.lpn ? ' (etiqueta ' + b.lpn + ')' : ''}`;

const MESSAGES = {
    // Una sola copia (asignar a un conductor o escanearla en el despacho).
    one: (b) => `El pedido ${label(b)} es de Falabella Directo y no se asigna desde aquí. ${SCAN_ADVICE}`,
    // Un lote: no se asigna nada hasta quitar esas copias de la selección.
    batch: (blocked) => {
        const shown = blocked.slice(0, 8).map(label).join(', ');
        const more = blocked.length > 8 ? ` y ${blocked.length - 8} más` : '';
        return `No se asignó ningún paquete: ${blocked.length === 1 ? 'hay 1 pedido' : 'hay ' + blocked.length + ' pedidos'} de Falabella Directo en la selección (${shown}${more}). Quítalos de la selección y vuelve a asignar. ${SCAN_ADVICE}`;
    }
};

// Texto del aviso que queda en el historial cuando una copia ya asignada se cierra sin haber escaneado su etiqueta.
function closedWithoutScanDetails({ lpn, falabellaStatus }) {
    return `Este pedido es de Falabella Directo${lpn ? ' (etiqueta ' + lpn + ')' : ''} y se cerró sin escanear su etiqueta: Falabella no recibió la entrega${falabellaStatus ? ' y lo sigue mostrando como ' + falabellaStatus : ''}. Avisa a un administrador.`;
}

module.exports = {
    CODE,
    CLOSED_WITHOUT_SCAN_EVENT,
    MESSAGES,
    isDirectoItem,
    classifyItems,
    accountFor,
    findDirectoCopies,
    closedWithoutScanDetails,
    _setClock: (fn) => { clock = fn || (() => Date.now()); },
    _resetCache: () => cache.clear()
};
