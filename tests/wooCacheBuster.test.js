/**
 * Prueba del importador de WooCommerce frente a una tienda que guarda en CACHÉ la respuesta de su API por URL (caso real de noviembre 2026: una tienda con LiteSpeed Cache entregaba
 * siempre el listado viejo para la URL exacta del importador y no entraba ningún pedido nuevo durante días).
 *   A. utils/wooCacheBuster.js
 *   B. el importador automático (services/woocommercePollingService.js) contra una tienda FALSA con caché por URL: antes veía solo el listado viejo; ahora ve los pedidos al día
 *   C. la lista que ve el operador al importar a mano (GET /api/integrations/:clientId/woocommerce/orders) con la misma tienda falsa
 * No toca ninguna red ni base real: la tienda y la base son falsas, y los nombres y datos de los pedidos son inventados.
 *
 * Uso:   node tests/wooCacheBuster.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/wooCacheBuster.test.js   (el código ANTERIOR debe FALLAR en B y C; Staging/Producción antes de subir)
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { EventEmitter } = require('events');
const nodeHttps = require('https');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

// ───────────── tienda falsa con caché por URL ─────────────
const STORE_HOST = 'tienda-de-prueba.test';
let live = [];              // pedidos de la tienda AHORA
const cache = new Map();    // «ruta + consulta» → listado guardado (como LiteSpeed: sirve ese listado hasta que alguien lo borre)
let storeCalls = [];        // rutas pedidas a la tienda
const order = (id, status, city, over = {}) => ({ id, number: String(id), status, date_created_gmt: `2026-11-0${id % 7 + 1}T15:00:00`, date_created: `2026-11-0${id % 7 + 1}T12:00:00`,
    shipping: { first_name: 'Cliente', last_name: `de Prueba ${id}`, city, state: 'RM', address_1: `Calle de Prueba ${id}`, address_2: '' }, billing: { first_name: 'Cliente', last_name: `de Prueba ${id}`, phone: '+56911111111', email: `p${id}@prueba.test`, city, state: 'RM' }, ...over });
const applyQuery = (search) => {
    const q = new URLSearchParams(search); const statuses = (q.get('status') || '').split(',').filter(Boolean); const per = Number(q.get('per_page') || 10);
    return live.filter(o => !statuses.length || statuses.includes(o.status)).sort((a, b) => b.id - a.id).slice(0, per).map(o => JSON.parse(JSON.stringify(o)));
};
nodeHttps.request = (options, cb) => {
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {}; req.write = () => {};
    req.end = () => {
        const key = options.path; storeCalls.push(key);
        if (!/^\/wp-json\/wc\/v3\/orders/.test(key)) { return setImmediate(() => respond(404, { code: 'no_route' })); }
        if (!cache.has(key)) cache.set(key, applyQuery(key.split('?')[1] || ''));   // la primera vez que se pide una URL se guarda lo que había
        setImmediate(() => respond(200, cache.get(key)));
    };
    const respond = (status, body) => { const res = new EventEmitter(); res.statusCode = status; cb(res); res.emit('data', JSON.stringify(body)); res.emit('end'); };
    return req;
};
const OLD_PATHS = ['/wp-json/wc/v3/orders?status=processing,completed&per_page=50', '/wp-json/wc/v3/orders?status=processing,completed'];   // las URL EXACTAS de antes
const primeStale = (stale) => { for (const p of OLD_PATHS) cache.set(p, JSON.parse(JSON.stringify(stale))); };

// ───────────── base falsa ─────────────
let S;
const reset = () => {
    live = []; cache.clear(); storeCalls = [];
    S = { users: [], packages: [], inserts: [], events: [], updates: 0, unknown: [] };
};
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const R = (rows) => ({ rows, rowCount: rows.length });
const accountOf = (over = {}) => ({ id: 'woocommerce-1', type: 'WOOCOMMERCE', status: 'CONNECTED', nickname: 'Tienda de prueba', credentials: { wooUrl: `https://${STORE_HOST}/`, wooConsumerKey: 'ck_prueba', wooConsumerSecret: 'cs_prueba' },
    settings: { autoImport: true, syncInterval: 5, lastSync: '2020-01-01T00:00:00.000Z' }, connectedAt: '2026-01-01T00:00:00.000Z', ...over });
async function run(text, params = []) {
    const q = norm(text);
    if (/^SELECT "woocommerceAutoImport" FROM system_settings WHERE id = 1$/.test(q)) return R([{ woocommerceAutoImport: true }]);
    if (/^SELECT name FROM active_communes WHERE "isActive" = true$/.test(q)) return R(['SANTIAGO', 'PROVIDENCIA', 'ÑUÑOA', 'MACUL'].map(name => ({ name })));
    if (/^SELECT id, integrations, "clientIdentifier" FROM users WHERE role = 'CLIENT'/.test(q)) return R(S.users.map(u => ({ id: u.id, integrations: JSON.parse(JSON.stringify(u.integrations)), clientIdentifier: u.clientIdentifier })));
    if (/^UPDATE users SET integrations = \$1 WHERE id = \$2$/.test(q)) { S.updates++; const u = S.users.find(x => x.id === params[1]); if (u) u.integrations = JSON.parse(params[0]); return R([]); }
    if (/^SELECT id FROM packages WHERE "wooOrderId" = \$1 OR "id" = \$2$/.test(q)) return R(S.packages.filter(p => p.wooOrderId === params[0] || p.id === params[1]).map(p => ({ id: p.id })));
    if (/^INSERT INTO packages \(/.test(q)) {
        const cols = q.match(/^INSERT INTO packages \((.*?)\) VALUES/)[1].split(',').map(c => c.trim().replace(/"/g, '')); const row = {}; cols.forEach((c, i) => { row[c] = params[i]; });
        S.inserts.push(row); S.packages.push(row); return R([]);
    }
    if (/^INSERT INTO tracking_events/.test(q)) { S.events.push(params[0]); return R([]); }
    if (/^SELECT integrations FROM users WHERE id = \$1$/.test(q)) { const u = S.users.find(x => x.id === params[0]); return R(u ? [{ integrations: JSON.parse(JSON.stringify(u.integrations)) }] : []); }
    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 200));
}
// un módulo que no existe en esa copia del código (Staging/Producción pueden no tenerlo) simplemente no se reemplaza
const stub = (rel, exports) => { let p; try { p = require.resolve(path.join(ROOT, rel)); } catch (e) { return; } require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('db.js', { query: (t, p) => run(t, p), getClient: async () => { throw new Error('no se usa'); } });
stub('services/geocodingService.js', { geocodeAddress: async () => null, triggerBackgroundGeocoding: () => {} });
stub('services/meliPollingService.js', {});
stub('services/shopifyOrders.js', {});

const tests = []; const t = (name, fn) => tests.push([name, fn]);
const tryLoad = (rel) => { try { return require(path.join(ROOT, rel)); } catch (e) { return null; } };
const buster = tryLoad('utils/wooCacheBuster.js');
const poller = tryLoad('services/woocommercePollingService.js');
const addUser = (account = accountOf()) => S.users.push({ id: 'user-tienda', clientIdentifier: 'TIENDA', integrations: { accounts: [account] } });
const existing = (id) => ({ id: `TIENDA-${id}`, wooOrderId: String(id), source: 'WOOCOMMERCE' });
const importedIds = () => S.inserts.map(r => r.wooOrderId).sort();

// ───────────── A. utilidad ─────────────
t('A1 withCacheBuster agrega «_=» con «?» o «&» según haya consulta, solo en GET, y cambia con la hora', () => {
    assert.ok(buster, 'no existe utils/wooCacheBuster.js');
    assert.strictEqual(buster.withCacheBuster('/orders?status=processing,completed&per_page=50', 'GET', 111), '/orders?status=processing,completed&per_page=50&_=111');
    assert.strictEqual(buster.withCacheBuster('/system_status', 'GET', 5), '/system_status?_=5');
    assert.strictEqual(buster.withCacheBuster('/orders/5', 'PUT', 5), '/orders/5'); assert.strictEqual(buster.withCacheBuster('/orders', 'post', 5), '/orders');
    assert.notStrictEqual(buster.withCacheBuster('/orders', 'GET', 1), buster.withCacheBuster('/orders', 'GET', 2));
    assert.ok(/_=\d{13}$/.test(buster.withCacheBuster('/orders')), 'sin hora dada usa la actual en milisegundos');
});

// ───────────── B. importador automático ─────────────
const stalePlusNew = () => {
    const old = [order(12714, 'completed', 'Santiago'), order(12715, 'completed', 'Santiago'), order(12716, 'completed', 'Santiago')];
    live = [...old]; primeStale(applyQuery('status=processing,completed&per_page=50'));   // la tienda guarda el listado de hoy…
    live.push(order(12717, 'completed', 'Santiago'), order(12718, 'completed', 'Providencia'));   // …y llegan pedidos nuevos que la copia guardada no tiene
};
t('B1 con la tienda sirviendo el listado VIEJO para la URL de siempre, el importador ve y crea los pedidos nuevos', async () => {
    stalePlusNew(); addUser(); S.packages.push(existing(12714), existing(12715), existing(12716));
    await poller.triggerSync();
    assert.deepStrictEqual(importedIds(), ['12717', '12718'], 'inserts: ' + importedIds().join(','));
    const row = S.inserts.find(r => r.wooOrderId === '12718');
    assert.strictEqual(row.source, 'WOOCOMMERCE'); assert.strictEqual(row.status, 'PENDIENTE'); assert.strictEqual(row.recipientCommune, 'PROVIDENCIA'); assert.strictEqual(row.creatorId, 'user-tienda');
    assert.strictEqual(row.notes, 'Auto-Import WooCommerce Order: 12718'); assert.deepStrictEqual(S.events.sort(), [row.id, S.inserts.find(r => r.wooOrderId === '12717').id].sort());
});
t('B2 la consulta del importador lleva un parámetro «_» nuevo en cada ciclo (la URL nunca se repite)', async () => {
    stalePlusNew(); addUser();
    await poller.triggerSync();
    S.users[0].integrations.accounts[0].settings.lastSync = '2020-01-01T00:00:00.000Z';   // otro ciclo: ya pasó el intervalo
    await new Promise(r => setTimeout(r, 5)); await poller.triggerSync();
    const asked = storeCalls.filter(p => /\/orders\?status=processing,completed&per_page=50/.test(p));
    assert.strictEqual(asked.length, 2, 'dos ciclos, dos consultas: ' + asked.join(' | '));
    for (const p of asked) assert.ok(/^\/wp-json\/wc\/v3\/orders\?status=processing,completed&per_page=50&_=\d{13}$/.test(p), p);
    assert.notStrictEqual(asked[0], asked[1]);
    assert.ok(!OLD_PATHS.some(p => asked.includes(p)), 'no pidió la URL exacta que la tienda tiene guardada');
});
t('B3 lo demás sigue igual: fuera de la RM no entra, un pedido «on-hold» no entra, uno ya existente no se duplica, y la comuna deshabilitada no entra', async () => {
    live = [order(12720, 'completed', 'Coquimbo', { shipping: { first_name: 'Cli', last_name: 'Norte', city: 'Coquimbo', state: 'CL_167', address_1: 'Calle 1', address_2: '' } }),
        order(12721, 'on-hold', 'Santiago'), order(12722, 'processing', 'Santiago'), order(12723, 'completed', 'Santiago'), order(12724, 'cancelled', 'Santiago')];
    addUser(); S.packages.push(existing(12723));
    await poller.triggerSync();
    assert.deepStrictEqual(importedIds(), ['12722'], 'solo el «processing» de Santiago: ' + importedIds().join(','));
});
t('B4 sin caché en la tienda (como siempre) el resultado es el mismo: se importan los pedidos nuevos una sola vez', async () => {
    live = [order(12730, 'completed', 'Santiago'), order(12731, 'processing', 'Macul')]; addUser();
    await poller.triggerSync();
    S.users[0].integrations.accounts[0].settings.lastSync = '2020-01-01T00:00:00.000Z'; await poller.triggerSync();   // segundo ciclo: ya existen
    assert.deepStrictEqual(importedIds(), ['12730', '12731']);
});

// ───────────── C. lista del operador (importar a mano) ─────────────
let server; let base;
const tokenFor = (id, role) => jwt.sign({ user: { id, role } }, process.env.JWT_SECRET);
t('C1 la lista que ve el operador para importar a mano también trae los pedidos al día aunque la tienda guarde la URL de siempre', async () => {
    const router = tryLoad('routes/integrations.js'); assert.ok(router, 'no cargó routes/integrations.js');
    stalePlusNew(); addUser();
    const res = await fetch(`${base}/api/integrations/user-tienda/woocommerce/orders`, { headers: { Authorization: 'Bearer ' + tokenFor('adm', 'ADMIN') } });
    assert.strictEqual(res.status, 200); const body = await res.json();
    assert.deepStrictEqual(body.map(o => o.id).sort(), ['12714', '12715', '12716', '12717', '12718'], 'ids: ' + body.map(o => o.id).join(','));
    assert.ok(storeCalls.some(p => /^\/wp-json\/wc\/v3\/orders\?status=processing,completed&_=\d{13}$/.test(p)), 'consulta con parámetro nuevo: ' + storeCalls.join(' | '));
});
t('C2 un cliente que no es el dueño ni administrador no puede pedir la lista (permiso intacto)', async () => {
    addUser();
    const res = await fetch(`${base}/api/integrations/user-tienda/woocommerce/orders`, { headers: { Authorization: 'Bearer ' + tokenFor('otro-cliente', 'CLIENT') } });
    assert.strictEqual(res.status, 403); assert.strictEqual(storeCalls.length, 0);
});

// ───────────── ejecución ─────────────
(async () => {
    const app = express(); app.use(express.json());
    const integ = tryLoad('routes/integrations.js'); if (integ) app.use('/api/integrations', integ);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    const log = console.log; let ok = 0; const fails = [];
    for (const [name, fn] of tests) {
        reset(); console.log = () => {};
        try { await fn(); ok++; console.log = log; log('OK    ' + name); }
        catch (e) { console.log = log; fails.push(name); log('FALLA ' + name + '\n      ' + String(e.message).split('\n').slice(0, 3).join('\n      ') + (S.unknown.length ? '\n      consultas no previstas: ' + S.unknown.join(' | ') : '')); }
    }
    console.log = log;
    log(`\n${ok} de ${tests.length} pruebas OK`);
    server.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(2); });
