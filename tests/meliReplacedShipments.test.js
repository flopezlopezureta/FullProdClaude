/**
 * Prueba de los ENVÍOS DE REEMPLAZO de Mercado Libre: ML cancela un envío y crea OTRO para la misma orden; el envío nuevo debe importarse como paquete APARTE
 * (antes la orden se daba por importada por el paquete viejo —CANCELADO— y, al escanear la etiqueta nueva, el escáner devolvía el viejo y bloqueaba un envío abierto).
 *   A. la regla pura (services/cancelledPackages.js → classifyExistingForShipment)
 *   B. el camino del ESCÁNER (importSpecificMeliPackage) con base falsa y Mercado Libre simulado
 *   C. el camino del IMPORTADOR AUTOMÁTICO (autoImportMeliPackages), igual
 * La base falsa hace cumplir el índice ÚNICO sobre meliOrderId (como la real): un segundo paquete con la misma orden falla; por eso el reemplazo entra con la orden vacía.
 * No toca ninguna base real ni llama a Mercado Libre; todos los datos son inventados.
 *
 * Uso:   node tests/meliReplacedShipments.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/meliReplacedShipments.test.js
 */
const path = require('path');
const assert = require('assert');
const EventEmitter = require('events');
const https = require('https');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

// ───────────── base falsa en memoria ─────────────
let S;
const reset = () => { S = { packages: [], events: [], mlCalls: [], inserts: 0, afterInsert: null, unknown: [], users: [{ id: 'client-1', clientIdentifier: 'TEST-0001', integrations: integrationsFor() }] }; };
const integrationsFor = () => ({ accounts: [{ id: 'acc-1', type: 'MERCADO_LIBRE', nickname: 'Cuenta de prueba', credentials: { accessToken: 'tok', refreshToken: 'ref', userId: '999', expiresAt: Date.now() + 3 * 3600 * 1000 }, settings: { autoImport: true, syncInterval: 0 } }] });
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const R = (rows) => ({ rows, rowCount: rows.length });
const pkg = (id, o = {}) => ({ id, status: 'PENDIENTE', source: 'MERCADO_LIBRE', meliOrderId: null, meliFlexCode: null, createdAt: new Date('2026-11-04T10:00:00Z'), ...o });
async function run(text, params = []) {
    const q = norm(text); let m;
    if (/^SELECT integrations FROM users WHERE id = \$1$/.test(q)) { const u = S.users.find(x => x.id === params[0]); return R(u ? [{ integrations: JSON.parse(JSON.stringify(u.integrations)) }] : []); }
    if (/^SELECT "clientIdentifier" FROM users WHERE id = \$1$/.test(q)) { const u = S.users.find(x => x.id === params[0]); return R(u ? [{ clientIdentifier: u.clientIdentifier }] : []); }
    if (/FROM users\s+WHERE role = 'CLIENT'/.test(q)) return R(S.users.map(u => ({ id: u.id, integrations: JSON.parse(JSON.stringify(u.integrations)), clientIdentifier: u.clientIdentifier })));
    if (/^UPDATE users SET integrations/.test(q)) return R([]);
    // dedupe de ambos importadores: el escáner compara ($1 = envío, $2 = orden) y el automático ($1 = orden, $2 = envío)
    if ((m = /^SELECT id, status, "meliFlexCode" FROM packages WHERE "meliFlexCode" = \$1 OR "meliOrderId" = \$2 OR "id" = \$1$/.exec(q))) return R(S.packages.filter(p => p.meliFlexCode === params[0] || p.meliOrderId === params[1] || p.id === params[0]).map(p => ({ id: p.id, status: p.status, meliFlexCode: p.meliFlexCode })));
    if (/^SELECT id, status, "meliFlexCode" FROM packages WHERE "meliOrderId" = \$1 OR "meliFlexCode" = \$2 OR "id" = \$2$/.test(q)) return R(S.packages.filter(p => p.meliOrderId === params[0] || p.meliFlexCode === params[1] || p.id === params[1]).map(p => ({ id: p.id, status: p.status, meliFlexCode: p.meliFlexCode })));
    // las consultas del importador ANTERIOR (sin estado ni código de envío), para poder correr esta prueba contra el código viejo y ver qué cambia de verdad
    if (/^SELECT id FROM packages WHERE "meliFlexCode" = \$1 OR "meliOrderId" = \$2 OR "id" = \$1$/.test(q)) return R(S.packages.filter(p => p.meliFlexCode === params[0] || p.meliOrderId === params[1] || p.id === params[0]).map(p => ({ id: p.id })));
    if (/^SELECT id, status FROM packages WHERE "meliOrderId" = \$1 OR "meliFlexCode" = \$2 OR "id" = \$2$/.test(q)) return R(S.packages.filter(p => p.meliOrderId === params[0] || p.meliFlexCode === params[1] || p.id === params[1]).map(p => ({ id: p.id, status: p.status })));
    if ((m = /^INSERT INTO packages \((.+?)\) VALUES/.exec(q))) {
        const cols = m[1].split(',').map(c => c.trim().replace(/"/g, '')); const row = {}; cols.forEach((c, i) => { row[c] = params[i]; });
        if (row.meliOrderId != null && S.packages.some(p => p.meliOrderId === row.meliOrderId)) { if (/ON CONFLICT \("meliOrderId"\) DO NOTHING/.test(q)) return R([]); const e = new Error('duplicate key value violates unique constraint "uq_meliorderid"'); e.code = '23505'; throw e; }
        S.packages.push(row); S.inserts++; if (S.afterInsert) S.afterInsert(row); return R([]);
    }
    if (/^INSERT INTO tracking_events \("packageId", status, location, details, timestamp\) VALUES \(\$1, \$2, \$3, \$4, \$5\)$/.test(q)) { S.events.push({ packageId: params[0], status: params[1], details: params[3] }); return R([]); }
    if (/^SELECT id FROM packages WHERE "meliFlexCode" = \$1 ORDER BY "createdAt" ASC, id ASC$/.test(q)) return R(S.packages.filter(p => p.meliFlexCode === params[0]).sort((a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) || (a.id < b.id ? -1 : 1)).map(p => ({ id: p.id })));
    if (/^DELETE FROM tracking_events WHERE "packageId" = \$1$/.test(q)) { S.events = S.events.filter(e => e.packageId !== params[0]); return R([]); }
    if (/^DELETE FROM packages WHERE id = \$1$/.test(q)) { S.packages = S.packages.filter(p => p.id !== params[0]); return R([]); }
    if (/FROM system_settings/.test(q)) return R([{}]);
    if (/^SELECT /.test(q)) { S.unknown.push(q); return R([]); }
    S.unknown.push(q); return R([]);
}
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] }; };
stub('db.js', { query: run, pool: { query: run }, getClient: async () => { throw new Error('no se usa'); } });
stub('services/geocodingService.js', { geocodeAddress: async () => ({ lat: null, lng: null }), triggerBackgroundGeocoding: () => {} });
stub('services/gisService.js', { getComunaCentroid: () => null, getSectorForCoordinates: () => 'Sector', reloadSectors: async () => {} });
stub('services/driverEvents.js', { emitDriverEvent: () => {} });

// ───────────── Mercado Libre simulado ─────────────
let ML = {};   // ML.shipments[id] = {...}; ML.orders = [{ id, shippingId }]
const shipment = (id, orderId, over = {}) => ({ id: Number(id), status: 'shipped', logistic_type: 'fulfillment', order_id: Number(orderId), tracking_id: 'TRK' + id, sender_id: 999,
    receiver_address: { receiver_name: 'Comprador Inventado', receiver_phone: '911112222', address_line: 'Calle Falsa 123', city: { name: 'Ñuñoa' }, state: { name: 'Región Metropolitana' }, federal_id: null }, ...over });
https.request = (options, cb) => {
    const req = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => {}; req.write = () => {};
    req.end = () => setImmediate(() => {
        S.mlCalls.push(options.path); let body = { message: 'no simulado: ' + options.path }; let status = 404; let m;
        if ((m = /^\/orders\/search\?.*offset=(\d+)/.exec(options.path))) { const off = Number(m[1]); const list = off === 0 ? ML.orders : []; body = { results: list.map(o => ({ id: Number(o.id), seller: { id: 999 }, shipping: { id: Number(o.shippingId) }, buyer: { nickname: 'comprador' } })), paging: { total: ML.orders.length } }; status = 200; }
        else if ((m = /^\/shipments\/(\d+)/.exec(options.path))) { const s = ML.shipments[m[1]]; if (s) { body = s; status = 200; } }
        else if (/^\/orders\/\d+/.test(options.path)) { body = { buyer: { phone: { number: '911112222' } } }; status = 200; }
        const res = new EventEmitter(); res.statusCode = status; cb(res); res.emit('data', Buffer.from(JSON.stringify(body))); res.emit('end');
    });
    return req;
};

const tests = []; const t = (name, fn) => tests.push([name, fn]);
const tryLoad = (rel) => { try { return require(path.join(ROOT, rel)); } catch (e) { return null; } };
const quiet = async (fn) => { const l = console.log, w = console.warn, e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; console.error = e; } };
let cancelled, poller;

const OLD = pkg('KANI-old', { status: 'CANCELADO', meliOrderId: '2000019340444334', meliFlexCode: '48429130428', driverId: 'bodega' });
const NEW_SHIP = '48443533501', ORDER = '2000019340444334';

// ───────────── A. regla pura ─────────────
t('A1 sin nada previo, o solo paquetes CANCELADOS con OTRO envío, el envío es nuevo (reemplazo); en cualquier otro caso ya está importado', () => {
    const f = cancelled.classifyExistingForShipment;
    assert.deepStrictEqual(f([], '48443533501'), { duplicate: false, replaces: [] });
    assert.deepStrictEqual(f(null, '48443533501'), { duplicate: false, replaces: [] });
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: '48429130428' }], '48443533501'), { duplicate: false, replaces: ['A'] });
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: '1' }, { id: 'B', status: 'CANCELADO', meliFlexCode: '2' }], '3'), { duplicate: false, replaces: ['A', 'B'] }, 'varios viejos cancelados');
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: '48443533501' }], '48443533501'), { duplicate: true, id: 'A' }, 'es el MISMO envío (lo canceló un conductor): no es reemplazo');
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: '1' }, { id: 'N', status: 'PENDIENTE', meliFlexCode: '3' }], '3'), { duplicate: true, id: 'N' }, 'prefiere el paquete de ESE envío aunque el viejo salga primero');
    assert.deepStrictEqual(f([{ id: 'N', status: 'PENDIENTE', meliFlexCode: '3' }, { id: 'A', status: 'CANCELADO', meliFlexCode: '1' }], '3'), { duplicate: true, id: 'N' });
});
t('A2 ante la duda no se crean paquetes de más: el viejo sigue abierto, no tiene código de envío, o hay uno abierto entre los cancelados', () => {
    const f = cancelled.classifyExistingForShipment;
    assert.deepStrictEqual(f([{ id: 'A', status: 'PENDIENTE', meliFlexCode: '1' }], '3'), { duplicate: true, id: 'A' });
    assert.deepStrictEqual(f([{ id: 'A', status: 'EN_TRANSITO', meliFlexCode: '1' }], '3'), { duplicate: true, id: 'A' });
    assert.deepStrictEqual(f([{ id: 'A', status: 'ENTREGADO', meliFlexCode: '1' }], '3'), { duplicate: true, id: 'A' }, 'un entregado no se reemplaza');
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: null }], '3'), { duplicate: true, id: 'A' });
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: '' }], '3'), { duplicate: true, id: 'A' });
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: '1' }, { id: 'B', status: 'PROBLEMA', meliFlexCode: '2' }], '3'), { duplicate: true, id: 'A' });
});
t('A3 el envío puede llegar como número y el id interno del paquete también cuenta como «ese envío»', () => {
    const f = cancelled.classifyExistingForShipment;
    assert.deepStrictEqual(f([{ id: 'A', status: 'CANCELADO', meliFlexCode: '48443533501' }], 48443533501), { duplicate: true, id: 'A' });
    assert.deepStrictEqual(f([{ id: '48443533501', status: 'PENDIENTE', meliFlexCode: null }], 48443533501), { duplicate: true, id: '48443533501' });
});

// ───────────── B. escáner (importSpecificMeliPackage) ─────────────
const scan = (shipId, orderId) => quiet(() => poller.importSpecificMeliPackage('client-1', String(shipId), true, 'acc-1'));
t('B1 al escanear la etiqueta del envío NUEVO se importa como paquete aparte (sin orden, con su envío), con su historial, y el viejo queda cancelado con una nota', async () => {
    S.packages.push({ ...OLD }); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) };
    const id = await scan(NEW_SHIP);
    assert.ok(id && id !== 'KANI-old', 'devolvió ' + id); assert.strictEqual(S.packages.length, 2);
    const nuevo = S.packages.find(p => p.id === id);
    assert.strictEqual(nuevo.meliOrderId, null, 'la orden queda en el paquete viejo (la base no admite repetirla)'); assert.strictEqual(nuevo.meliFlexCode, NEW_SHIP); assert.strictEqual(nuevo.status, 'PENDIENTE'); assert.strictEqual(nuevo.source, 'MERCADO_LIBRE');
    assert.ok(/reemplazo/.test(nuevo.notes) && nuevo.notes.includes(ORDER), nuevo.notes); assert.strictEqual(nuevo.creatorId, 'client-1'); assert.strictEqual(nuevo.sourceAccountId, 'acc-1');
    const creado = S.events.find(e => e.packageId === id && e.status === 'Creado'); assert.ok(creado && /reemplazo/i.test(creado.details), JSON.stringify(creado));
    const nota = S.events.find(e => e.packageId === 'KANI-old' && e.status === 'COMENTARIO'); assert.ok(nota && nota.details.includes(id) && nota.details.includes(NEW_SHIP), JSON.stringify(nota));
    assert.strictEqual(S.packages.find(p => p.id === 'KANI-old').status, 'CANCELADO', 'el viejo sigue cancelado');
    assert.strictEqual(S.packages.find(p => p.id === 'KANI-old').meliOrderId, ORDER, 'y conserva la orden');
});
t('B2 escanear otra vez la misma etiqueta nueva devuelve el paquete nuevo y no crea otro (ni toca el viejo)', async () => {
    S.packages.push({ ...OLD }); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) };
    const first = await scan(NEW_SHIP); const again = await scan(NEW_SHIP);
    assert.strictEqual(again, first); assert.strictEqual(S.packages.length, 2); assert.strictEqual(S.events.filter(e => e.packageId === 'KANI-old').length, 1, 'una sola nota en el viejo');
});
t('B3 una orden sin paquetes se importa como siempre: con su número de orden y sin notas de reemplazo', async () => {
    ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) };
    const id = await scan(NEW_SHIP); const p = S.packages.find(x => x.id === id);
    assert.strictEqual(p.meliOrderId, ORDER); assert.ok(!/reemplazo/.test(p.notes)); assert.deepStrictEqual(S.events.map(e => e.status), ['Creado']); assert.ok(!/reemplazo/i.test(S.events[0].details));
});
t('B4 NO es reemplazo cuando el paquete viejo sigue abierto, es el mismo envío cancelado por un conductor, o no tiene código de envío: se devuelve el que ya existe', async () => {
    const casos = [
        ['el viejo sigue abierto', pkg('OLD', { status: 'PENDIENTE', meliOrderId: ORDER, meliFlexCode: '48429130428' })],
        ['mismo envío cancelado por un conductor', pkg('OLD', { status: 'CANCELADO', meliOrderId: ORDER, meliFlexCode: NEW_SHIP })],
        ['el viejo no tiene código de envío', pkg('OLD', { status: 'CANCELADO', meliOrderId: ORDER, meliFlexCode: null })],
    ];
    for (const [que, viejo] of casos) { reset(); S.packages.push({ ...viejo }); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) }; const id = await scan(NEW_SHIP); assert.strictEqual(id, 'OLD', que); assert.strictEqual(S.packages.length, 1, que + ': sin paquetes nuevos'); assert.strictEqual(S.inserts, 0, que); }
});
t('B5 si otra importación del MISMO envío se adelanta (la base ya no lo impide por la orden), se queda la más antigua y la nuestra se retira con su historial', async () => {
    S.packages.push({ ...OLD }); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) };
    S.afterInsert = (row) => { S.afterInsert = null; S.packages.push(pkg('GANADOR', { meliFlexCode: NEW_SHIP, createdAt: new Date('2000-01-01') })); };   // aparece justo después de nuestro INSERT, con fecha anterior
    const id = await scan(NEW_SHIP);
    assert.strictEqual(id, 'GANADOR'); assert.strictEqual(S.packages.filter(p => p.meliFlexCode === NEW_SHIP).length, 1);
    assert.ok(!S.packages.some(p => p.notes && /reemplazo/.test(p.notes)), 'el nuestro se retiró'); assert.ok(!S.events.some(e => e.status === 'Creado'), 'y también su historial');
});
t('B6 la base falsa hace cumplir el índice único de la orden: un segundo paquete CON la misma orden falla (por eso el reemplazo va sin orden)', async () => {
    S.packages.push(pkg('X', { meliOrderId: ORDER }));
    await assert.rejects(() => run('INSERT INTO packages ("id", "meliOrderId") VALUES ($1, $2)', ['Y', ORDER]), /uq_meliorderid/);
    await run('INSERT INTO packages ("id", "meliOrderId") VALUES ($1, $2)', ['Z', null]); await run('INSERT INTO packages ("id", "meliOrderId") VALUES ($1, $2)', ['W', null]);
    assert.strictEqual(S.packages.filter(p => p.meliOrderId === null).length, 2 + 0, 'varios con orden vacía sí caben');
});

// ───────────── C. importador automático (autoImportMeliPackages) ─────────────
const VALID = () => [require(path.join(ROOT, 'utils/normUtil.js')).normalizeCommune('Ñuñoa').toLowerCase()];
const cycle = () => quiet(() => poller.autoImportMeliPackages(VALID()));
t('C1 el ciclo importa el envío NUEVO de una orden cuyo paquete viejo está cancelado con otro envío: paquete aparte, sin orden, con su historial', async () => {
    S.packages.push({ ...OLD }); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) }; ML.orders = [{ id: ORDER, shippingId: NEW_SHIP }];
    await cycle();
    assert.strictEqual(S.packages.length, 2, JSON.stringify(S.packages.map(p => p.id))); const nuevo = S.packages.find(p => p.id !== 'KANI-old');
    assert.strictEqual(nuevo.meliOrderId, null); assert.strictEqual(nuevo.meliFlexCode, NEW_SHIP); assert.strictEqual(nuevo.status, 'PENDIENTE'); assert.ok(/reemplazo/.test(nuevo.notes), nuevo.notes);
    assert.ok(/reemplazo/i.test(S.events.find(e => e.packageId === nuevo.id && e.status === 'Creado').details)); assert.ok(S.events.some(e => e.packageId === 'KANI-old' && e.status === 'COMENTARIO' && e.details.includes(nuevo.id)));
});
t('C2 el ciclo siguiente no vuelve a importarlo (ya hay un paquete de ese envío) ni consulta de nuevo los detalles del envío', async () => {
    S.packages.push({ ...OLD }); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) }; ML.orders = [{ id: ORDER, shippingId: NEW_SHIP }];
    await cycle(); S.mlCalls.length = 0; const antes = S.packages.length;
    await cycle(); assert.strictEqual(S.packages.length, antes); assert.ok(!S.mlCalls.some(c => c.startsWith('/shipments/')), 'sin consultas de envío: ' + S.mlCalls.join(','));
});
t('C3 una orden cuyo paquete cancelado tiene el MISMO envío (cancelado por un conductor) se salta como siempre, sin llamar a ML por los detalles', async () => {
    S.packages.push(pkg('OLD', { status: 'CANCELADO', meliOrderId: ORDER, meliFlexCode: NEW_SHIP })); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) }; ML.orders = [{ id: ORDER, shippingId: NEW_SHIP }];
    await cycle(); assert.strictEqual(S.packages.length, 1); assert.ok(!S.mlCalls.some(c => c.startsWith('/shipments/')), S.mlCalls.join(','));
});
t('C4 si el envío de reemplazo ya está entregado o cancelado en ML no se importa', async () => {
    for (const st of ['delivered', 'cancelled']) { reset(); S.packages.push({ ...OLD }); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER, { status: st }) }; ML.orders = [{ id: ORDER, shippingId: NEW_SHIP }]; await cycle(); assert.strictEqual(S.packages.length, 1, st); }
});
t('C5 una orden nueva (sin paquetes) se importa igual que antes: con su número de orden', async () => {
    ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) }; ML.orders = [{ id: ORDER, shippingId: NEW_SHIP }];
    await cycle(); assert.strictEqual(S.packages.length, 1); assert.strictEqual(S.packages[0].meliOrderId, ORDER); assert.ok(!/reemplazo/.test(S.packages[0].notes)); assert.deepStrictEqual(S.events.map(e => e.status), ['Creado']);
});
t('C6 una orden con el paquete viejo todavía abierto (ML ya reemplazó el envío pero aún no sabemos que lo canceló) no crea un paquete de más', async () => {
    S.packages.push(pkg('OLD', { status: 'PENDIENTE', meliOrderId: ORDER, meliFlexCode: '48429130428' })); ML.shipments = { [NEW_SHIP]: shipment(NEW_SHIP, ORDER) }; ML.orders = [{ id: ORDER, shippingId: NEW_SHIP }];
    await cycle(); assert.strictEqual(S.packages.length, 1);
});

// ───────────── ejecutar ─────────────
(async () => {
    cancelled = tryLoad('services/cancelledPackages.js'); const log = console.log;
    if (!cancelled || typeof cancelled.classifyExistingForShipment !== 'function') { log('FALLA no existe classifyExistingForShipment en este código: las pruebas A, B y C no pueden correr'); process.exit(1); }
    poller = require(path.join(ROOT, 'services/meliPollingService.js'));
    let ok = 0; const fails = [];
    for (const [name, fn] of tests) {
        reset(); ML = { shipments: {}, orders: [] };
        try { await fn(); ok++; log('OK    ' + name); } catch (e) { fails.push(name); log('FALLA ' + name + '\n      ' + String(e.stack || e.message).split('\n').slice(0, 5).join('\n      ') + (S.unknown.length ? '\n      consultas no previstas: ' + S.unknown.slice(0, 3).join(' | ') : '')); }
    }
    log(`\n${ok} de ${tests.length} pruebas OK`);
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(2); });
