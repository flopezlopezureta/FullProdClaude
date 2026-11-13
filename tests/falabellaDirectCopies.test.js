/**
 * Prueba de las COPIAS DE SELLER CENTER de pedidos de Falabella Directo (services/falabellaDirectCopies.js + sus tres puntos de asignación y el cierre en routes/packages.js).
 *   A. reconocer un pedido de Directo en los ítems de Falabella (falaflex / direct) y armar los mensajes
 *   B. findDirectoCopies con una base y una API de Falabella FALSAS (qué se bloquea, qué se deja pasar, caché, demoras)
 *   C. la MISMA consulta SQL contra Postgres real (PGlite, en memoria)
 *   D. las rutas reales de asignación (/:id/assign-driver, /batch-assign-driver, /:id/dispatch) contra una base falsa: una copia de Directo no se asigna
 *   E. el cierre real (/:id/deliver): aviso en el historial si se cerró sin escanear, y la copia de Seller Center ya no intenta avisar a Envíame
 * No toca ninguna base ni API real; todos los datos son inventados. En D y E cada consulta se interpreta a mano: una consulta no prevista hace fallar la prueba.
 *
 * Uso:   node tests/falabellaDirectCopies.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/falabellaDirectCopies.test.js
 *        (otra copia = el código ANTERIOR, para comprobar que la prueba detecta el defecto, o el clon de Staging/Producción antes de subir)
 *        C necesita @electric-sql/pglite (no va en el proyecto): PGLITE_DIR=<carpeta donde está instalado>
 */
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

let PGlite = null;
try { PGlite = require(require.resolve('@electric-sql/pglite', { paths: [ROOT, process.env.PGLITE_DIR, __dirname].filter(Boolean) })).PGlite; } catch (e) { /* se omite C */ }

const tests = [];
const t = (name, fn, opts = {}) => tests.push({ name, fn, needsPg: !!opts.needsPg });
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const R = (rows) => ({ rows, rowCount: rows.length });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────── datos de prueba ─────────────
const ACC = (id = 'acc-1') => ({ id, type: 'FALABELLA', credentials: { falabellaApiKey: 'llave-de-prueba', falabellaSellerId: 'seller@prueba.cl' } });
const CLIENT = (over = {}) => ({ id: 'c1', integrations: { accounts: [ACC()] }, ...over });
const DIRECTO_ITEMS = (lpn = 'PKG0000TEST1', status = 'ready_to_ship') => [{ OrderItemId: '1', Status: status, ShipmentProvider: 'falaflex', ShippingProviderType: 'direct', TrackingCode: lpn }];
const NORMAL_ITEMS = (status = 'pending') => [{ OrderItemId: '2', Status: status, ShipmentProvider: 'home delivery corp', ShippingProviderType: 'clickandcollect', TrackingCode: '' }];
const wrap = (items) => ({ SuccessResponse: { Body: { OrderItems: { OrderItem: items } } } });
const mkPkg = (id, over = {}) => ({ id, status: 'PENDIENTE', driverId: null, source: 'FALABELLA', creatorId: 'c1', sourceAccountId: 'acc-1', falabellaOrderId: 'OID-' + id, falabellaTrackingId: 'NRO-' + id, falabellaDirectLpn: null, isReassigned: false, assignedAt: null, meliFlexCode: null, recipientAddress: 'Calle Falsa 123', deliveryReceiverName: null, deliveryReceiverId: null, deliveryPhotosBase64: null, updatedAt: new Date(), ...over });
const png = (n) => 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('foto-' + n + '-abcdefgh')]).toString('base64');

// ───────────── estado de la base y de Falabella FALSAS ─────────────
let S;
const reset = () => {
    S = { users: { c1: CLIENT(), 'drv-1': { id: 'drv-1', name: 'Conductor Uno', status: 'APROBADO' } }, packages: {}, events: [], logs: [], updates: [], tx: [], unknown: [], clients: 0,
          orders: {},            // falabellaOrderId -> ítems que devuelve Falabella (o una función que lanza / demora)
          apiCalls: [], httpCalls: [], settings: { requiredPhotos: 1 }, failWarnSelect: false };
    const dc = tryLoad('services/falabellaDirectCopies.js'); if (dc && dc._resetCache) dc._resetCache();
};
const tryLoad = (rel) => { try { return require(path.join(ROOT, rel)); } catch (e) { return null; } };
const need = () => { const m = tryLoad('services/falabellaDirectCopies.js'); assert.ok(m, 'no existe services/falabellaDirectCopies.js en ' + ROOT); return m; };
const pk = (id, over) => (S.packages[id] = mkPkg(id, over));
const evs = (id) => S.events.filter((e) => e.packageId === id).map((e) => e.status);

// La consulta que arma services/falabellaDirectCopies.js: se interpreta aplicando EXACTAMENTE sus condiciones (la SQL real se prueba en C).
function findRows(ids) {
    return Object.values(S.packages).filter((p) => ids.includes(p.id) && p.source === 'FALABELLA' && !p.falabellaDirectLpn && !['ENTREGADO', 'DEVUELTO', 'CANCELADO'].includes(p.status))
        .map((p) => ({ id: p.id, falabellaOrderId: p.falabellaOrderId, falabellaTrackingId: p.falabellaTrackingId, sourceAccountId: p.sourceAccountId, integrations: (S.users[p.creatorId] || {}).integrations }));
}
async function run(text, params = []) {
    const q = norm(text);
    if (/^SELECT status FROM users WHERE id = \$1$/.test(q)) { const u = S.users[params[0]]; return R(u ? [{ status: u.status || 'APROBADO' }] : [{ status: 'APROBADO' }]); }
    if (/^INSERT INTO system_logs/.test(q)) { S.logs.push({ action: params[2], details: params[3] }); return R([]); }
    if (/^INSERT INTO tracking_events \("packageId", status, location, details, timestamp\) VALUES \(\$1, \$2, \$3, \$4, \$5\)$/.test(q)) { S.events.push({ packageId: params[0], status: params[1], location: params[2], details: params[3] }); return R([]); }
    if (/^SELECT \* FROM tracking_events WHERE "packageId" = \$1 ORDER BY timestamp DESC$/.test(q)) return R(S.events.filter((e) => e.packageId === params[0]).reverse());
    if (/^SELECT 1 FROM tracking_events WHERE "packageId" = \$1 AND status = \$2 LIMIT 1$/.test(q)) { if (S.failWarnSelect) throw new Error('la base falló al revisar el aviso'); return R(S.events.filter((e) => e.packageId === params[0] && e.status === params[1]).slice(0, 1).map(() => ({ '?column?': 1 }))); }
    if (/^SELECT p\.id, p\."falabellaOrderId", p\."falabellaTrackingId", p\."sourceAccountId", u\.integrations FROM packages p JOIN users u ON u\.id = p\."creatorId" WHERE p\.id = ANY\(\$1::text\[\]\) AND p\.source = 'FALABELLA' AND p\."falabellaDirectLpn" IS NULL AND p\.status NOT IN \('ENTREGADO', 'DEVUELTO', 'CANCELADO'\)$/.test(q)) {
        if (S.failFind) throw new Error('la base falló al buscar copias'); return R(findRows(params[0]));
    }
    // — asignar a un conductor (una) —
    if (/^SELECT "driverId", status, "isReassigned", source FROM packages WHERE id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ driverId: p.driverId, status: p.status, isReassigned: p.isReassigned, source: p.source }] : []); }
    if (/^UPDATE packages SET "driverId" = \$1, "estimatedDelivery" = \$2, "updatedAt" = \$3, status = \$4, "assignedAt" = \$5, "isReassigned" = \$6 WHERE id = \$7 RETURNING \*$/.test(q)) {
        const p = S.packages[params[6]]; if (!p) return R([]); S.updates.push({ id: p.id, driverId: params[0], status: params[3] }); Object.assign(p, { driverId: params[0], status: params[3] }); return R([{ ...p }]);
    }
    if (/^SELECT name FROM users WHERE id = \$1$/.test(q)) { const u = S.users[params[0]]; return R(u && u.name ? [{ name: u.name }] : []); }
    // — despacho por escáner —
    if (/^SELECT id, status, "driverId", "meliFlexCode", source, "assignedAt" FROM packages WHERE id = \$1 OR /.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ id: p.id, status: p.status, driverId: p.driverId, meliFlexCode: p.meliFlexCode, source: p.source, assignedAt: p.assignedAt }] : []); }
    if (/^SELECT "saveFlexLabelPhoto" FROM system_settings WHERE id = 1$/.test(q)) return R([{ saveFlexLabelPhoto: false }]);
    if (/^UPDATE packages SET "driverId" = \$1, status = \$2, "updatedAt" = \$3, "meliFlexCode" = \$4, /.test(q)) {
        const p = S.packages[params[8]]; if (!p) return R([]); S.updates.push({ id: p.id, driverId: params[0], status: params[1] }); Object.assign(p, { driverId: params[0], status: params[1] }); return R([{ ...p }]);
    }
    // — «listo para despachar» y consulta del estado en Falabella (corren sin esperarse) —
    if (/^SELECT p\."sourceAccountId", p\."falabellaOrderId", u\.integrations FROM packages p JOIN users u ON p\."creatorId" = u\.id WHERE p\.id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ sourceAccountId: p.sourceAccountId, falabellaOrderId: p.falabellaOrderId, integrations: (S.users[p.creatorId] || {}).integrations }] : []); }
    if (/^SELECT p\."sourceAccountId", p\."falabellaOrderId", p\."falabellaTrackingId", p\."falabellaDirectLpn", u\.integrations FROM packages p JOIN users u ON p\."creatorId" = u\.id WHERE p\.id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ sourceAccountId: p.sourceAccountId, falabellaOrderId: p.falabellaOrderId, falabellaTrackingId: p.falabellaTrackingId, falabellaDirectLpn: p.falabellaDirectLpn, integrations: (S.users[p.creatorId] || {}).integrations }] : []); }
    if (/^SELECT falabella_api_key, falabella_seller_id FROM integration_settings WHERE id = 1$/.test(q)) return R([]);
    if (/^SELECT enviame_api_key, enviame_environment FROM integration_settings WHERE id = 1$/.test(q)) return R([]);
    if (/^INSERT INTO integration_sync_queue/.test(q)) return R([]);
    // — cierre —
    if (/^SELECT "requiredPhotos" FROM system_settings WHERE id = 1$/.test(q)) return R([{ requiredPhotos: S.settings.requiredPhotos }]);
    if (/^SELECT status, "deliveryReceiverName", "deliveryReceiverId" FROM packages WHERE id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ status: p.status, deliveryReceiverName: p.deliveryReceiverName, deliveryReceiverId: p.deliveryReceiverId }] : []); }
    if (/^SELECT "deliveryPhotosBase64" FROM packages WHERE id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ deliveryPhotosBase64: p.deliveryPhotosBase64 }] : []); }
    if (/^SELECT \* FROM packages WHERE id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ ...p }] : []); }
    if (/^SELECT source, "falabellaDirectLpn", "driverId" FROM packages WHERE id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ source: p.source, falabellaDirectLpn: p.falabellaDirectLpn, driverId: p.driverId }] : []); }
    if (/^SELECT "blockDeliveryOnMeliConfirmed" FROM system_settings WHERE id = 1$/.test(q)) return R([{ blockDeliveryOnMeliConfirmed: false }]);
    if (/^SELECT "meliFlexValidation" FROM system_settings WHERE id = 1$/.test(q)) return R([{ meliFlexValidation: false }]);
    if (/^UPDATE packages SET status = \$1, "deliveryReceiverName" = \$2, "deliveryReceiverId" = \$3, "deliveryPhotosBase64" = \$4, "meliDeliveredNeedsPhotos" = false, "updatedAt" = \$5 WHERE id = \$6 RETURNING \*$/.test(q)) {
        const p = S.packages[params[5]]; if (!p) return R([]); S.updates.push({ id: p.id, status: params[0] }); Object.assign(p, { status: params[0], deliveryReceiverName: params[1], deliveryReceiverId: params[2], deliveryPhotosBase64: params[3] }); return R([{ ...p }]);
    }
    if (/^SELECT "meliOrderId", "creatorId", "meliFlexCode", "sourceAccountId" FROM packages WHERE id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ meliOrderId: null, creatorId: p.creatorId, meliFlexCode: null, sourceAccountId: p.sourceAccountId }] : []); }
    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 220));
}
// Cliente de transacción (solo /batch-assign-driver)
async function getClient() {
    S.clients++;
    return {
        release() {},
        async query(text, params = []) {
            const q = norm(text);
            if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') { S.tx.push(q); return R([]); }
            if (/^SELECT id FROM packages WHERE id IN \(.*\) AND source = 'FALABELLA_DIRECTO'$/.test(q)) return R([]);
            if (/^SELECT name FROM users WHERE id = \$1$/.test(q)) { const u = S.users[params[0]]; return R(u && u.name ? [{ name: u.name }] : []); }
            if (/^SELECT id, "driverId", status FROM packages WHERE id IN \(.*\)$/.test(q)) return R(params.map((id) => S.packages[id]).filter(Boolean).map((p) => ({ id: p.id, driverId: p.driverId, status: p.status })));
            if (/^UPDATE packages SET "driverId" = \$1, "estimatedDelivery" = \$2, "updatedAt" = \$3, status = \$4, "assignedAt" = \$5, "isReassigned" = CASE/.test(q)) {
                const ids = params.slice(5); ids.forEach((id) => { const p = S.packages[id]; if (p) { S.updates.push({ id, driverId: params[0], status: params[3] }); Object.assign(p, { driverId: params[0], status: params[3] }); } }); return R([]);
            }
            if (/^INSERT INTO tracking_events \("packageId", status, location, details, timestamp\) VALUES /.test(q)) { for (let i = 0; i < params.length; i += 5) S.events.push({ packageId: params[i], status: params[i + 1], location: params[i + 2], details: params[i + 3] }); return R([]); }
            S.unknown.push('[tx] ' + q); throw new Error('Consulta no prevista en el cliente falso: ' + q.slice(0, 220));
        }
    };
}

// Falabella FALSA, en sus dos puertas: el servicio que usa el detector (stub) y la llamada https de la sincronización del cierre (se intercepta).
const fakeApi = async (apiKey, sellerId, orderId) => {
    S.apiCalls.push(orderId);
    const v = S.orders[orderId];
    if (typeof v === 'function') return v();
    if (v === undefined) throw new Error('Falabella: pedido desconocido ' + orderId);
    return wrap(v);
};
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const realApiModule = require(path.join(ROOT, 'services/falabellaSellerApiService.js'));
stub('services/falabellaSellerApiService.js', { ...realApiModule, getOrderItems: (...a) => fakeApi(...a) });
stub('db.js', { query: (t, p) => run(t, p), getClient });
stub('services/notificationService.js', { notifyRecipient: () => Promise.resolve(), notifyRecipientsBulk: () => Promise.resolve(), notifyAdminPendingDelivery: () => Promise.resolve() });
stub('services/meliPollingService.js', { optimizedJITDiscovery: async () => null, getValidMeliToken: async () => 'TOKEN-1' });
stub('services/jumpsellerPollingService.js', {});
stub('services/geocodingService.js', { geocodeAddress: async () => null, triggerBackgroundGeocoding: () => {} });
stub('services/gisService.js', { getSectorForCoordinates: () => 'Sector de prueba', reloadSectors: async () => {} });
stub('services/timeService.js', { getLogicalDate: async (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10), getSystemTimezone: async () => 'America/Santiago', getLogicalRange: async () => ({ start: new Date(0), end: new Date() }) });
stub('services/falabellaDirectService.js', { getOrderByLpn: async () => { throw new Error('no debe llamarse'); }, pushStatusUpdate: async () => {} });
stub('services/driverEvents.js', { emitDriverEvent: () => {}, bus: new EventEmitter() });

// La llamada https de syncDeliveryToFalabella / syncReadyToShipToFalabella (código en routes/packages.js) va a Falabella: se intercepta.
const https = require('https');
const realRequest = https.request;
https.request = function (options, cb) {
    if (options && options.hostname === 'sellercenter-api.falabella.com') {
        const qs = new URLSearchParams(String(options.path || '').replace(/^\/\?/, ''));
        const action = qs.get('Action'), orderId = qs.get('OrderId');
        S.httpCalls.push({ action, orderId });
        const req = new EventEmitter(); req.write = () => {};
        req.end = () => setImmediate(() => {
            const res = new EventEmitter(); res.statusCode = 200; cb(res);
            const items = S.orders[orderId]; const body = action === 'GetOrderItems' ? wrap(typeof items === 'function' ? [] : (items || [])) : { SuccessResponse: { Head: {} } };
            res.emit('data', JSON.stringify(body)); res.emit('end');
        });
        return req;
    }
    return realRequest.apply(this, arguments);
};

// ═════════════ A. reconocer un pedido de Directo ═════════════
t('A1 es de Directo solo si el ítem trae transportista «falaflex» Y tipo «direct» (sin importar mayúsculas ni espacios)', () => {
    const m = need();
    for (const it of [{ ShipmentProvider: 'falaflex', ShippingProviderType: 'direct' }, { ShipmentProvider: ' FalaFlex ', ShippingProviderType: 'DIRECT' }]) assert.strictEqual(m.isDirectoItem(it), true, JSON.stringify(it));
    for (const it of [{ ShipmentProvider: 'home delivery corp', ShippingProviderType: 'clickandcollect' }, { ShipmentProvider: 'home delivery corp', ShippingProviderType: 'regular' }, { ShipmentProvider: 'falaflex', ShippingProviderType: 'regular' },
        { ShipmentProvider: 'otro', ShippingProviderType: 'direct' }, { ShipmentProvider: 'falaflex' }, { ShippingProviderType: 'direct' }, {}, null, undefined]) assert.strictEqual(m.isDirectoItem(it), false, JSON.stringify(it));
});
t('A2 classifyItems entrega si es de Directo, su LPN (TrackingCode) y el estado que muestra Falabella', () => {
    const m = need();
    assert.deepStrictEqual(m.classifyItems(DIRECTO_ITEMS('PKG1', 'ready_to_ship')), { isDirecto: true, lpn: 'PKG1', falabellaStatus: 'ready_to_ship' });
    assert.deepStrictEqual(m.classifyItems(NORMAL_ITEMS('pending')), { isDirecto: false, lpn: null, falabellaStatus: 'pending' });
    const mixto = m.classifyItems([...NORMAL_ITEMS('pending'), ...DIRECTO_ITEMS('PKG2', 'ready_to_ship')]);
    assert.ok(mixto.isDirecto && mixto.lpn === 'PKG2' && mixto.falabellaStatus === 'pending, ready_to_ship', JSON.stringify(mixto));
    assert.deepStrictEqual(m.classifyItems([{ ShipmentProvider: 'falaflex', ShippingProviderType: 'direct', Status: 'ready_to_ship' }]), { isDirecto: true, lpn: null, falabellaStatus: 'ready_to_ship' }, 'sin TrackingCode: es de Directo, sin LPN');
    for (const vacio of [[], null, undefined, 'x', [null], [{}]]) { const c = m.classifyItems(vacio); assert.strictEqual(c.isDirecto, false); assert.strictEqual(c.lpn, null); }
});
t('A3 la cuenta de Falabella es la que importó el paquete; si no, la primera; sin cuenta, nada', () => {
    const m = need();
    const dos = { accounts: [{ id: 'a1', type: 'MERCADO_LIBRE' }, { id: 'a2', type: 'FALABELLA', credentials: { falabellaApiKey: 'K2' } }, { id: 'a3', type: 'FALABELLA', credentials: { falabellaApiKey: 'K3' } }] };
    assert.strictEqual(m.accountFor({ integrations: dos, sourceAccountId: 'a3' }).id, 'a3');
    assert.strictEqual(m.accountFor({ integrations: dos, sourceAccountId: 'zzz' }).id, 'a2');
    assert.strictEqual(m.accountFor({ integrations: JSON.stringify(dos), sourceAccountId: 'a3' }).id, 'a3', 'integraciones como texto');
    for (const sin of [{ integrations: null }, { integrations: {} }, { integrations: { accounts: [{ id: 'x', type: 'SHOPIFY' }] } }, { integrations: '{no es json' }]) assert.strictEqual(m.accountFor(sin), null, JSON.stringify(sin));
});
t('A4 los mensajes mandan a escanear la etiqueta y dicen cuál (número de pedido y LPN); el del lote cuenta y recorta; el aviso del cierre dice qué pasó', () => {
    const m = need();
    const uno = m.MESSAGES.one({ id: 'FACT-1', orderNumber: '3261517477', lpn: 'PKG00002OV6NT', falabellaStatus: 'ready_to_ship' });
    assert.ok(/3261517477/.test(uno) && /PKG00002OV6NT/.test(uno) && /Falabella Directo/.test(uno) && /escáner de Falabella Directo/.test(uno) && /no se asigna desde aquí/.test(uno), uno);
    assert.ok(/FACT-2/.test(m.MESSAGES.one({ id: 'FACT-2', orderNumber: null, lpn: null })), 'sin número de pedido usa el id');
    const lote = m.MESSAGES.batch(Array.from({ length: 10 }, (_, i) => ({ id: 'P' + i, orderNumber: 'N' + i, lpn: 'L' + i })));
    assert.ok(/hay 10 pedidos de Falabella Directo/.test(lote) && /No se asignó ningún paquete/.test(lote) && /N7 \(etiqueta L7\)/.test(lote) && !/N8/.test(lote) && /y 2 más/.test(lote), lote);
    assert.ok(/hay 1 pedido de Falabella Directo/.test(m.MESSAGES.batch([{ id: 'P1', orderNumber: 'N1', lpn: null }])));
    const aviso = m.closedWithoutScanDetails({ lpn: 'PKG9', falabellaStatus: 'ready_to_ship' });
    assert.ok(/PKG9/.test(aviso) && /sin escanear su etiqueta/.test(aviso) && /Falabella no recibió la entrega/.test(aviso) && /ready_to_ship/.test(aviso) && /Avisa a un administrador/.test(aviso), aviso);
    assert.ok(!/etiqueta undefined|null/.test(m.closedWithoutScanDetails({ lpn: null, falabellaStatus: null })));
});

// ═════════════ B. findDirectoCopies con base y API falsas ═════════════
const find = (ids, over) => need().findDirectoCopies((text, params) => run(text, params), ids, over);
t('B1 bloquea la copia de Directo (con su número de pedido, LPN y estado) y deja pasar la copia normal', async () => {
    reset(); pk('D1', { falabellaTrackingId: '3261517477' }); pk('N1');
    S.orders['OID-D1'] = DIRECTO_ITEMS('PKG00002OV6NT'); S.orders['OID-N1'] = NORMAL_ITEMS();
    const r = await find(['D1', 'N1']);
    assert.deepStrictEqual(r, { blocked: [{ id: 'D1', orderNumber: '3261517477', lpn: 'PKG00002OV6NT', falabellaStatus: 'ready_to_ship' }], unchecked: 0 });
});
t('B2 solo mira copias de Seller Center sin paquete Directo y sin cerrar: ni consulta a Falabella por las demás', async () => {
    reset();
    pk('MAN', { source: 'MANUAL' }); pk('ML', { source: 'MERCADO_LIBRE' }); pk('FD', { source: 'FALABELLA_DIRECTO', falabellaDirectLpn: 'PKGX' }); pk('CONLPN', { falabellaDirectLpn: 'PKGY' });
    pk('ENT', { status: 'ENTREGADO' }); pk('DEV', { status: 'DEVUELTO' }); pk('CAN', { status: 'CANCELADO' });
    for (const id of ['MAN', 'ML', 'FD', 'CONLPN', 'ENT', 'DEV', 'CAN']) S.orders['OID-' + id] = DIRECTO_ITEMS('PKG-' + id);
    const r = await find(['MAN', 'ML', 'FD', 'CONLPN', 'ENT', 'DEV', 'CAN', 'NOEXISTE']);
    assert.deepStrictEqual(r, { blocked: [], unchecked: 0 });
    assert.deepStrictEqual(S.apiCalls, [], 'no se llamó a Falabella por ninguno');
    assert.deepStrictEqual(await find([]), { blocked: [], unchecked: 0 }); assert.deepStrictEqual(await find(null), { blocked: [], unchecked: 0 });
});
t('B3 ante cualquier duda NO bloquea: error de Falabella, demora, sin llave, sin número de pedido o error de la base', async () => {
    const m = need();
    reset(); pk('E1'); S.orders['OID-E1'] = () => { throw new Error('HTTP 500'); };
    assert.deepStrictEqual(await find(['E1']), { blocked: [], unchecked: 1 }, 'error de Falabella');
    reset(); pk('T1'); S.orders['OID-T1'] = () => new Promise(() => {});
    const t0 = Date.now(); const lento = await find(['T1'], { timeoutMs: 80 }); assert.deepStrictEqual(lento, { blocked: [], unchecked: 1 }, 'demora'); assert.ok(Date.now() - t0 < 1500, 'no espera de más');
    reset(); pk('K1'); S.users.c1 = CLIENT({ integrations: { accounts: [{ id: 'acc-1', type: 'FALABELLA', credentials: {} }] } }); S.orders['OID-K1'] = DIRECTO_ITEMS();
    assert.deepStrictEqual(await find(['K1']), { blocked: [], unchecked: 1 }, 'sin llave'); assert.deepStrictEqual(S.apiCalls, []);
    reset(); pk('O1', { falabellaOrderId: null }); assert.deepStrictEqual(await find(['O1']), { blocked: [], unchecked: 1 }, 'sin número de pedido');
    reset(); pk('B1'); S.orders['OID-B1'] = DIRECTO_ITEMS(); S.failFind = true;
    assert.deepStrictEqual(await find(['B1']), { blocked: [], unchecked: 1 }, 'error de la base'); assert.deepStrictEqual(S.apiCalls, []);
    reset(); pk('R1'); S.orders['OID-R1'] = { SuccessResponse: 'respuesta rara' };   // Falabella responde algo inesperado
    S.orders['OID-R1'] = () => ({ SuccessResponse: { Body: {} } }); assert.deepStrictEqual(await find(['R1']), { blocked: [], unchecked: 0 }, 'sin ítems: no es de Directo, no se bloquea');
});
t('B4 la respuesta de Falabella se recuerda 10 minutos (una segunda asignación no vuelve a preguntar) y después vuelve a preguntar', async () => {
    const m = need(); reset(); pk('D1'); S.orders['OID-D1'] = DIRECTO_ITEMS();
    let now = 1_000_000; m._setClock(() => now);
    try {
        assert.strictEqual((await find(['D1'])).blocked.length, 1); assert.strictEqual(S.apiCalls.length, 1);
        now += 9 * 60 * 1000; assert.strictEqual((await find(['D1'])).blocked.length, 1); assert.strictEqual(S.apiCalls.length, 1, 'dentro de los 10 min no vuelve a preguntar');
        now += 2 * 60 * 1000; assert.strictEqual((await find(['D1'])).blocked.length, 1); assert.strictEqual(S.apiCalls.length, 2, 'pasados 10 min sí');
        S.orders['OID-D1'] = NORMAL_ITEMS(); now += 11 * 60 * 1000; assert.strictEqual((await find(['D1'])).blocked.length, 0, 'si Falabella cambió, se entera');
    } finally { m._setClock(null); }
});
t('B5 consulta como mucho 3 pedidos a la vez y, si se acaba el tiempo del lote, lo que falta se deja pasar', async () => {
    const m = need(); reset(); let live = 0, max = 0; const ids = [];
    for (let i = 0; i < 9; i++) { const id = 'L' + i; ids.push(id); pk(id); S.orders['OID-' + id] = async () => { live++; max = Math.max(max, live); await sleep(30); live--; return wrap(DIRECTO_ITEMS('PKG' + i)); }; }
    const r = await find(ids); assert.strictEqual(r.blocked.length, 9); assert.ok(max <= 3 && max >= 2, 'a la vez: ' + max);
    reset(); let now = 0; m._setClock(() => now); const ids2 = [];
    for (let i = 0; i < 6; i++) { const id = 'M' + i; ids2.push(id); pk(id); S.orders['OID-' + id] = async () => { now += 5000; return wrap(DIRECTO_ITEMS('PKG' + i)); }; }
    try { const r2 = await find(ids2, { budgetMs: 8000 }); assert.ok(r2.blocked.length >= 1 && r2.blocked.length < 6 && r2.unchecked > 0 && r2.unchecked === 6 - r2.blocked.length, JSON.stringify(r2)); } finally { m._setClock(null); }
});

// ═════════════ C. la misma consulta SQL contra Postgres real ═════════════
t('C1 la consulta real (PGlite) devuelve solo copias de Seller Center de Directo sin LPN y sin cerrar, con la cuenta de CADA cliente', async () => {
    const m = need(); reset();
    const pg = new PGlite();
    await pg.exec(`CREATE TABLE users (id text PRIMARY KEY, integrations jsonb);
        CREATE TABLE packages (id text PRIMARY KEY, source text, status text, "creatorId" text, "sourceAccountId" text, "falabellaOrderId" text, "falabellaTrackingId" text, "falabellaDirectLpn" text);`);
    await pg.query('INSERT INTO users VALUES ($1, $2), ($3, $4)', ['u1', JSON.stringify({ accounts: [ACC('a1')] }), 'u2', JSON.stringify({ accounts: [{ ...ACC('b1'), credentials: { falabellaApiKey: 'otra', falabellaSellerId: 'otro@prueba.cl' } }] })]);
    const ins = (id, o) => pg.query('INSERT INTO packages VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, o.source || 'FALABELLA', o.status || 'PENDIENTE', o.creator || 'u1', o.acc || 'a1', 'O-' + id, 'N-' + id, o.lpn || null]);
    await ins('P1', {}); await ins('P2', {}); await ins('P3', { status: 'ENTREGADO' }); await ins('P4', { lpn: 'PKGX' }); await ins('P5', { source: 'MANUAL' }); await ins('P6', { source: 'FALABELLA_DIRECTO' });
    await ins('P7', { status: 'CANCELADO' }); await ins('P8', { creator: 'u2', acc: 'b1' }); await ins('P9', { status: 'ASIGNADO' }); await ins('P10', { status: 'DEVUELTO' });
    const seen = [];
    const api = async (key, seller, orderId) => { seen.push([key, seller, orderId]); return wrap(orderId === 'O-P2' ? NORMAL_ITEMS() : DIRECTO_ITEMS('PKG-' + orderId)); };
    const r = await m.findDirectoCopies((text, params) => pg.query(text, params), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P-NO'], { getOrderItems: api });
    assert.deepStrictEqual(r.blocked.map((b) => b.id), ['P1', 'P8', 'P9']);
    assert.deepStrictEqual(r.blocked.map((b) => b.lpn), ['PKG-O-P1', 'PKG-O-P8', 'PKG-O-P9']);
    assert.strictEqual(r.unchecked, 0);
    assert.deepStrictEqual(seen.map((s) => s[2]).sort(), ['O-P1', 'O-P2', 'O-P8', 'O-P9'], 'solo se preguntó por las copias vivas de Seller Center');
    assert.deepStrictEqual(seen.find((s) => s[2] === 'O-P8').slice(0, 2), ['otra', 'otro@prueba.cl'], 'con la llave del cliente dueño del paquete');
}, { needsPg: true });

// ═════════════ D. las rutas reales ═════════════
let server, base;
const tok = (role = 'ADMIN', id = 'adm-1') => jwt.sign({ user: { id, role, name: id } }, process.env.JWT_SECRET, { expiresIn: '5m' });
async function call(method, p, body, role, id) {
    const r = await fetch(`${base}/api/packages${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok(role, id) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}
const DATE = '2026-11-14';
t('D1 asignar UNA copia de Directo a un conductor → 400, dice cuál etiqueta escanear, no cambia nada y queda registrado', async () => {
    const m = need(); reset(); pk('FACT-1', { falabellaTrackingId: '3261517477' }); S.orders['OID-FACT-1'] = DIRECTO_ITEMS('PKG00002OV6NT');
    const r = await call('POST', '/FACT-1/assign-driver', { driverId: 'drv-1', newDeliveryDate: DATE });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body)); assert.strictEqual(r.body.code, m.CODE);
    assert.ok(/3261517477/.test(r.body.message) && /PKG00002OV6NT/.test(r.body.message) && /escáner de Falabella Directo/.test(r.body.message), r.body.message);
    assert.deepStrictEqual(S.updates, [], 'no hubo ninguna actualización'); assert.strictEqual(S.packages['FACT-1'].driverId, null); assert.strictEqual(S.packages['FACT-1'].status, 'PENDIENTE'); assert.deepStrictEqual(evs('FACT-1'), []);
    assert.ok(S.logs.some((l) => l.action === 'ASSIGN_FALABELLA_DIRECTO_BLOCKED'), 'queda en el registro de acciones');
    assert.deepStrictEqual(S.unknown, []);
});
t('D2 asignar una copia NORMAL de Seller Center o un paquete de otro origen sigue funcionando; desasignar una copia de Directo también', async () => {
    reset(); pk('NOR-1'); S.orders['OID-NOR-1'] = NORMAL_ITEMS(); pk('MAN-1', { source: 'MANUAL' }); pk('DIR-1', { driverId: 'drv-1', status: 'ASIGNADO' }); S.orders['OID-DIR-1'] = DIRECTO_ITEMS();
    let r = await call('POST', '/NOR-1/assign-driver', { driverId: 'drv-1', newDeliveryDate: DATE }); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(S.packages['NOR-1'].driverId, 'drv-1');
    r = await call('POST', '/MAN-1/assign-driver', { driverId: 'drv-1', newDeliveryDate: DATE }); assert.strictEqual(r.status, 200); assert.ok(!S.apiCalls.includes('OID-MAN-1'), 'un paquete manual no consulta a Falabella');
    S.apiCalls.length = 0;
    r = await call('POST', '/DIR-1/assign-driver', { driverId: null, newDeliveryDate: DATE }); assert.strictEqual(r.status, 200, 'dejar disponible no es asignar'); assert.strictEqual(S.packages['DIR-1'].driverId, null); assert.deepStrictEqual(S.apiCalls, [], 'ni se consulta');
});
t('D3 si Falabella falla o demora, la asignación se hace igual (nunca se frena una operación por no poder consultar)', async () => {
    reset(); pk('E-1'); S.orders['OID-E-1'] = () => { throw new Error('HTTP 503'); };
    let r = await call('POST', '/E-1/assign-driver', { driverId: 'drv-1', newDeliveryDate: DATE }); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(S.packages['E-1'].driverId, 'drv-1');
    reset(); pk('E-2'); S.failFind = true; S.orders['OID-E-2'] = DIRECTO_ITEMS();
    r = await call('POST', '/E-2/assign-driver', { driverId: 'drv-1', newDeliveryDate: DATE }); assert.strictEqual(r.status, 200, 'si la base falla al buscar, también pasa'); assert.strictEqual(S.packages['E-2'].driverId, 'drv-1');
});
t('D4 un LOTE con una copia de Directo no asigna NADA (ni abre la transacción), dice cuáles quitar; un lote sin ellas se asigna entero', async () => {
    const m = need(); reset(); pk('B-1'); pk('B-2'); pk('B-3', { falabellaTrackingId: '3261000003' });
    S.orders['OID-B-1'] = NORMAL_ITEMS(); S.orders['OID-B-2'] = NORMAL_ITEMS(); S.orders['OID-B-3'] = DIRECTO_ITEMS('PKG-B3');
    let r = await call('POST', '/batch-assign-driver', { packageIds: ['B-1', 'B-2', 'B-3'], driverId: 'drv-1', newDeliveryDate: DATE });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body)); assert.strictEqual(r.body.code, m.CODE); assert.ok(/3261000003 \(etiqueta PKG-B3\)/.test(r.body.message) && /No se asignó ningún paquete/.test(r.body.message), r.body.message);
    assert.deepStrictEqual(r.body.blocked.map((b) => b.id), ['B-3']);
    assert.deepStrictEqual(S.updates, [], 'no se actualizó nada'); assert.strictEqual(S.clients, 0, 'ni siquiera se abrió una conexión de transacción'); assert.ok(S.logs.some((l) => l.action === 'BATCH_ASSIGN_FALABELLA_DIRECTO_BLOCKED'));
    r = await call('POST', '/batch-assign-driver', { packageIds: ['B-1', 'B-2'], driverId: 'drv-1', newDeliveryDate: DATE });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.assigned, 2); assert.deepStrictEqual(S.tx, ['BEGIN', 'COMMIT']); assert.ok(['B-1', 'B-2'].every((id) => S.packages[id].driverId === 'drv-1'));
    assert.deepStrictEqual(S.unknown, []);
});
t('D5 dejar un lote disponible (sin conductor) no consulta a Falabella ni se bloquea', async () => {
    reset(); pk('U-1', { driverId: 'drv-1', status: 'ASIGNADO' }); S.orders['OID-U-1'] = DIRECTO_ITEMS();
    const r = await call('POST', '/batch-assign-driver', { packageIds: ['U-1'], driverId: 'none', newDeliveryDate: DATE });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.deepStrictEqual(S.apiCalls, []); assert.strictEqual(S.packages['U-1'].driverId, null);
});
t('D6 despachar por escáner la copia de Directo → 400 con el mismo mensaje y no sale a ruta; una copia normal sí sale; un paquete de ML no consulta nada', async () => {
    const m = need(); reset(); pk('S-D', { falabellaTrackingId: '3261000009' }); pk('S-N'); pk('S-ML', { source: 'MERCADO_LIBRE' });
    S.orders['OID-S-D'] = DIRECTO_ITEMS('PKG-SD'); S.orders['OID-S-N'] = NORMAL_ITEMS();
    let r = await call('POST', '/S-D/dispatch', { driverId: 'drv-1' });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body)); assert.strictEqual(r.body.code, m.CODE); assert.ok(/3261000009/.test(r.body.message) && /PKG-SD/.test(r.body.message), r.body.message);
    assert.deepStrictEqual(S.updates, []); assert.strictEqual(S.packages['S-D'].status, 'PENDIENTE'); assert.ok(S.logs.some((l) => l.action === 'DISPATCH_FALABELLA_DIRECTO_BLOCKED'));
    r = await call('POST', '/S-N/dispatch', { driverId: 'drv-1' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(S.packages['S-N'].status, 'EN_TRANSITO');
    S.apiCalls.length = 0; r = await call('POST', '/S-ML/dispatch', { driverId: 'drv-1' }); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.deepStrictEqual(S.apiCalls, []);
});
t('D7 los demás rechazos de siempre no cambian (despachar uno ya entregado sigue diciendo lo mismo) y, sin sesión, nada pasa', async () => {
    reset(); pk('Z-1', { status: 'ENTREGADO', driverId: 'drv-1' }); S.orders['OID-Z-1'] = DIRECTO_ITEMS();
    const r = await call('POST', '/Z-1/dispatch', { driverId: 'drv-1' }); assert.strictEqual(r.status, 400); assert.ok(/ya se encuentra ENTREGADO/.test(r.body.message), r.body.message); assert.deepStrictEqual(S.apiCalls, []);
    const sinSesion = await fetch(`${base}/api/packages/Z-1/assign-driver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId: 'drv-1' }) }); assert.strictEqual(sinSesion.status, 401);
});

// ═════════════ E. el cierre real ═════════════
const closeBody = () => ({ receiverName: 'Maria Soto', receiverId: '', photosBase64: [png(1)] });
const closeAndWait = async (id) => { const r = await call('POST', `/${id}/deliver`, closeBody(), 'DRIVER', 'drv-1'); await sleep(450); return r; };
t('E1 cerrar la copia de un pedido de Directo deja el aviso en el historial (con su LPN y el estado en Falabella) y NO intenta avisar a Envíame', async () => {
    const m = need(); reset(); pk('FACT-7', { status: 'ASIGNADO', driverId: 'drv-1', falabellaTrackingId: '3261517477' }); S.orders['OID-FACT-7'] = DIRECTO_ITEMS('PKG00002OV6NT', 'ready_to_ship');
    const r = await closeAndWait('FACT-7'); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(S.packages['FACT-7'].status, 'ENTREGADO');
    const e = evs('FACT-7');
    assert.ok(e.includes('SYNC_FALABELLA_START') && e.includes('FALABELLA_ESTADO_CONSULTADO'), 'la consulta del estado en Falabella sigue: ' + e);
    assert.ok(!e.some((s) => /ENVIAME/.test(s)), 'sin eventos de Envíame: ' + e); assert.deepStrictEqual(S.httpCalls.map((c) => c.action), ['GetOrderItems']);
    const aviso = S.events.filter((x) => x.packageId === 'FACT-7' && x.status === m.CLOSED_WITHOUT_SCAN_EVENT); assert.strictEqual(aviso.length, 1, e.join(','));
    assert.ok(/PKG00002OV6NT/.test(aviso[0].details) && /sin escanear su etiqueta/.test(aviso[0].details) && /ready_to_ship/.test(aviso[0].details), aviso[0].details); assert.strictEqual(aviso[0].location, 'Falabella API');
});
t('E2 cerrar la copia de un pedido que NO es de Directo no deja aviso y tampoco avisa a Envíame', async () => {
    const m = need(); reset(); pk('NOR-7', { status: 'ASIGNADO', driverId: 'drv-1' }); S.orders['OID-NOR-7'] = NORMAL_ITEMS('ready_to_ship');
    const r = await closeAndWait('NOR-7'); assert.strictEqual(r.status, 200); const e = evs('NOR-7');
    assert.ok(e.includes('FALABELLA_ESTADO_CONSULTADO')); assert.ok(!e.includes(m.CLOSED_WITHOUT_SCAN_EVENT)); assert.ok(!e.some((s) => /ENVIAME/.test(s)), e.join(','));
});
t('E3 el aviso se guarda UNA sola vez aunque la sincronización se repita (la cola la reintenta)', async () => {
    const m = need(); reset(); pk('REP-1', { status: 'ASIGNADO', driverId: 'drv-1', falabellaTrackingId: '3261000001' }); S.orders['OID-REP-1'] = DIRECTO_ITEMS('PKG-REP');
    await closeAndWait('REP-1'); const packagesRoute = require(path.join(ROOT, 'routes/packages.js'));
    await packagesRoute.syncDeliveryToFalabella('REP-1', '3261000001'); await packagesRoute.syncDeliveryToFalabella('REP-1', '3261000001');
    assert.strictEqual(S.events.filter((x) => x.packageId === 'REP-1' && x.status === m.CLOSED_WITHOUT_SCAN_EVENT).length, 1);
    assert.ok(S.events.filter((x) => x.packageId === 'REP-1' && x.status === 'FALABELLA_ESTADO_CONSULTADO').length >= 3, 'la consulta del estado sí se repite como siempre');
});
t('E4 un paquete que SÍ tiene su paquete Directo vinculado (LPN) no recibe el aviso; si guardar el aviso falla, la sincronización no se da por fallida', async () => {
    const m = need(); reset(); pk('LPN-1', { status: 'ASIGNADO', driverId: 'drv-1', falabellaDirectLpn: 'PKG-YA', falabellaTrackingId: '3261000002' }); S.orders['OID-LPN-1'] = DIRECTO_ITEMS('PKG-YA');
    await closeAndWait('LPN-1'); assert.ok(!evs('LPN-1').includes(m.CLOSED_WITHOUT_SCAN_EVENT));
    reset(); pk('FALLA-1', { status: 'ASIGNADO', driverId: 'drv-1', falabellaTrackingId: '3261000003' }); S.orders['OID-FALLA-1'] = DIRECTO_ITEMS('PKG-F'); S.failWarnSelect = true;
    const r = await closeAndWait('FALLA-1'); assert.strictEqual(r.status, 200);
    await sleep(3400);   // la sincronización fallida se reintenta a los 3 s: si el aviso la hiciera fallar, aquí ya habría una segunda consulta a Falabella
    const e = evs('FALLA-1');
    assert.ok(e.includes('FALABELLA_ESTADO_CONSULTADO') && !e.includes('SYNC_FALABELLA_ERROR') && !e.includes(m.CLOSED_WITHOUT_SCAN_EVENT), e.join(',')); assert.strictEqual(S.httpCalls.filter((c) => c.action === 'GetOrderItems').length, 1, 'no se reintentó');
});
t('E5 un paquete de origen ENVIAME sigue avisando a Envíame al cerrarse (solo se quitó para las copias de Seller Center)', async () => {
    reset(); pk('ENV-1', { source: 'ENVIAME', status: 'ASIGNADO', driverId: 'drv-1' }); S.packages['ENV-1'].trackingId = 'TRK-ENV-1'; S.packages['ENV-1'].falabellaOrderId = null;
    const r = await call('POST', '/ENV-1/deliver', closeBody(), 'DRIVER', 'drv-1'); await sleep(250); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(evs('ENV-1').includes('SYNC_ENVIAME_START'), evs('ENV-1').join(','));
});

// ───────────── ejecución ─────────────
(async () => {
    try {
        const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/packages', require(path.join(ROOT, 'routes/packages.js')));
        server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); }); base = `http://127.0.0.1:${server.address().port}`;
    } catch (e) { console.error('No se pudo montar la ruta real:', e.stack); }
    const log = console.log; let ok = 0, skipped = 0; const fails = [];
    for (const { name, fn, needsPg } of tests) {
        if (needsPg && !PGlite) { skipped++; log('OMITIDA ' + name + '   (falta @electric-sql/pglite)'); continue; }
        const quiet = console.log, quietErr = console.error, quietWarn = console.warn; console.log = () => {}; console.error = () => {}; console.warn = () => {};
        try { await fn(); ok++; console.log = quiet; console.error = quietErr; console.warn = quietWarn; log('OK    ' + name); }
        catch (e) { console.log = quiet; console.error = quietErr; console.warn = quietWarn; fails.push(name); log('FALLA ' + name + '\n      ' + String(e && e.message).split('\n').slice(0, 6).join('\n      ')); }
    }
    log(`\n${ok} de ${tests.length} pruebas OK` + (skipped ? ` · ${skipped} OMITIDAS (no cuentan como aprobadas: instala @electric-sql/pglite para correrlas)` : ''));
    if (server) server.close(); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(2); });
