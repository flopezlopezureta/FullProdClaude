/**
 * Prueba de la COMUNA de los pedidos de WooCommerce (services/wooCommune.js) y de su uso en el importador automático y en la lista del importador manual.
 *   A. utils/normUtil.js: la función nueva (resolveKnownCommuneDetailed) y que resolveKnownCommune siga igual
 *   B. la decisión por pedido (resolveWooCommune): estado de la tienda, ciudad mal escrita, tienda sin lista de estados, comunas deshabilitadas, falsos positivos («Rengo» → «Renca»)
 *   C. la lista de estados de la tienda (getStateMap): se pide una vez cada 12 horas y, si la tienda no la entrega, se sigue con la ciudad
 *   D. el importador automático contra una tienda FALSA que entrega la lista de estados
 *   E. la lista que ve el operador para importar a mano (GET /api/integrations/:clientId/woocommerce/orders)
 * No toca ninguna red ni base real: la tienda y la base son falsas y todos los nombres y direcciones son inventados.
 *
 * Uso:   node tests/wooCommune.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/wooCommune.test.js   (el código ANTERIOR debe FALLAR en B, D y E; Staging/Producción antes de subir)
 */
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');
const nodeHttps = require('https');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

// ───────────── tienda falsa ─────────────
// La tienda pide la comuna en una lista: el «estado» del pedido es un código (CL_441) y GET /data/countries/CL lo traduce al nombre.
const STATES = [['CL_441', 'Vitacura'], ['CL_381', 'San Bernardo'], ['CL_157', 'Colina'], ['CL_287', 'Ñuñoa'], ['CL_408', 'Santiago'], ['CL_235', 'Las Condes'], ['CL_261', 'Macul'],
    ['CL_103', 'Alto del Carmen'], ['CL_167', 'Coquimbo'], ['CL_150', 'Lampa'], ['CL_300', 'Rengo'], ['CL_313', 'Peñalolén'], ['CL_139', 'Providencia'], ['CL-RM', 'Región Metropolitana de Santiago']]
    .map(([code, name]) => ({ code, name }));
const STORE_HOST = 'tienda-de-prueba.test';
let live = []; let storeCalls = []; let statesAvailable = true;
const order = (id, status, city, state, over = {}) => ({ id, number: String(id), status, date_created_gmt: `2026-11-0${id % 7 + 1}T15:00:00`, date_created: `2026-11-0${id % 7 + 1}T12:00:00`,
    shipping: { first_name: 'Cliente', last_name: `de Prueba ${id}`, city, state, country: 'CL', address_1: `Calle de Prueba ${id}`, address_2: '' },
    billing: { first_name: 'Cliente', last_name: `de Prueba ${id}`, phone: '+56911111111', email: `p${id}@prueba.test`, city, state, country: 'CL' }, ...over });
nodeHttps.request = (options, cb) => {
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {}; req.write = () => {};
    const respond = (status, body) => { const res = new EventEmitter(); res.statusCode = status; cb(res); res.emit('data', JSON.stringify(body)); res.emit('end'); };
    req.end = () => {
        const key = options.path; storeCalls.push(key);
        if (/^\/wp-json\/wc\/v3\/data\/countries\/CL/.test(key)) return setImmediate(() => (statesAvailable ? respond(200, { code: 'CL', name: 'Chile', states: STATES }) : respond(404, { code: 'rest_no_route' })));
        if (!/^\/wp-json\/wc\/v3\/orders/.test(key)) return setImmediate(() => respond(404, { code: 'no_route' }));
        const q = new URLSearchParams(key.split('?')[1] || ''); const statuses = (q.get('status') || '').split(',').filter(Boolean); const per = Number(q.get('per_page') || 10);
        setImmediate(() => respond(200, live.filter(o => !statuses.length || statuses.includes(o.status)).sort((a, b) => b.id - a.id).slice(0, per).map(o => JSON.parse(JSON.stringify(o)))));
    };
    return req;
};

// ───────────── base falsa ─────────────
let S;
const ACTIVE = ['SANTIAGO', 'VITACURA', 'SAN BERNARDO', 'COLINA', 'ÑUÑOA', 'LAS CONDES', 'MACUL', 'PROVIDENCIA', 'PEÑALOLÉN', 'RENCA'];   // LAMPA no está habilitada
const reset = () => { live = []; storeCalls = []; statesAvailable = true; S = { users: [], packages: [], inserts: [], unknown: [] }; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const R = (rows) => ({ rows, rowCount: rows.length });
const accountOf = () => ({ id: 'woocommerce-1', type: 'WOOCOMMERCE', status: 'CONNECTED', nickname: 'Tienda de prueba', credentials: { wooUrl: `https://${STORE_HOST}/`, wooConsumerKey: 'ck_prueba', wooConsumerSecret: 'cs_prueba' },
    settings: { autoImport: true, syncInterval: 5, lastSync: '2020-01-01T00:00:00.000Z' }, connectedAt: '2026-01-01T00:00:00.000Z' });
async function run(text, params = []) {
    const q = norm(text);
    if (/^SELECT "woocommerceAutoImport" FROM system_settings WHERE id = 1$/.test(q)) return R([{ woocommerceAutoImport: true }]);
    if (/^SELECT name FROM active_communes WHERE "isActive" = true$/.test(q)) return R(ACTIVE.map(name => ({ name })));
    if (/^SELECT id, integrations, "clientIdentifier" FROM users WHERE role = 'CLIENT'/.test(q)) return R(S.users.map(u => ({ id: u.id, integrations: JSON.parse(JSON.stringify(u.integrations)), clientIdentifier: u.clientIdentifier })));
    if (/^UPDATE users SET integrations = \$1 WHERE id = \$2$/.test(q)) { const u = S.users.find(x => x.id === params[1]); if (u) u.integrations = JSON.parse(params[0]); return R([]); }
    if (/^SELECT id FROM packages WHERE "wooOrderId" = \$1 OR "id" = \$2$/.test(q)) return R(S.packages.filter(p => p.wooOrderId === params[0] || p.id === params[1]).map(p => ({ id: p.id })));
    if (/^INSERT INTO packages \(/.test(q)) { const cols = q.match(/^INSERT INTO packages \((.*?)\) VALUES/)[1].split(',').map(c => c.trim().replace(/"/g, '')); const row = {}; cols.forEach((c, i) => { row[c] = params[i]; }); S.inserts.push(row); S.packages.push(row); return R([]); }
    if (/^INSERT INTO tracking_events/.test(q)) return R([]);
    if (/^SELECT integrations FROM users WHERE id = \$1$/.test(q)) { const u = S.users.find(x => x.id === params[0]); return R(u ? [{ integrations: JSON.parse(JSON.stringify(u.integrations)) }] : []); }
    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 200));
}
const stub = (rel, exports) => { let p; try { p = require.resolve(path.join(ROOT, rel)); } catch (e) { return; } require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('db.js', { query: (t, p) => run(t, p), getClient: async () => { throw new Error('no se usa'); } });
stub('services/geocodingService.js', { geocodeAddress: async () => null, triggerBackgroundGeocoding: () => {} });
stub('services/meliPollingService.js', {});
stub('services/shopifyOrders.js', {});

const tests = []; const t = (name, fn) => tests.push([name, fn]);
const tryLoad = (rel) => { try { return require(path.join(ROOT, rel)); } catch (e) { return null; } };
const norms = tryLoad('utils/normUtil.js');
const wc = tryLoad('services/wooCommune.js');
const poller = tryLoad('services/woocommercePollingService.js');
const need = (mod, rel) => assert.ok(mod, 'no existe ' + rel);
const stateMap = () => wc.buildStateMap(STATES);
const valid = (list = ACTIVE) => list.map(c => norms.normalizeCommune(c).toLowerCase());
const resolve = (o, extra = {}) => wc.resolveWooCommune(o, { stateMap: stateMap(), validCommunes: valid(), ...extra });
const addUser = () => S.users.push({ id: 'user-tienda', clientIdentifier: 'TIENDA', integrations: { accounts: [accountOf()] } });
const importedBy = () => Object.fromEntries(S.inserts.map(r => [r.wooOrderId, r.recipientCommune]));

// ───────────── A. normUtil ─────────────
t('A1 resolveKnownCommuneDetailed distingue lo exacto de un error de tipeo y dice a cuántas correcciones está', () => {
    need(norms && norms.resolveKnownCommuneDetailed, 'resolveKnownCommuneDetailed en utils/normUtil.js');
    const d = norms.resolveKnownCommuneDetailed;
    for (const text of ['Santiago', 'San Tiago', 'Macul', 'Qta Normal', 'Ñuñoa, Santiago', 'Stgo', 'peñalolen']) assert.strictEqual(d(text).fuzzy, false, text);
    assert.deepStrictEqual([d('Santiagi').commune, d('Santiagi').fuzzy, d('Santiagi').distance], ['SANTIAGO', true, 1]);
    assert.deepStrictEqual([d('Providensia').commune, d('Providensia').fuzzy, d('Providensia').distance], ['PROVIDENCIA', true, 1]);
    assert.deepStrictEqual([d('Rengo').commune, d('Rengo').fuzzy, d('Rengo').distance], ['RENCA', true, 2], '«Rengo» es otra ciudad: queda a 2 correcciones de «Renca»');
    assert.strictEqual(d('Coquimbo').commune, null); assert.strictEqual(d('').commune, null); assert.strictEqual(d('N/A').commune, null);
});
t('A2 resolveKnownCommune no cambió para los demás importadores (Shopify, Jumpseller)', () => {
    need(norms, 'utils/normUtil.js'); const r = norms.resolveKnownCommune;
    assert.strictEqual(r('Santiagi'), 'SANTIAGO'); assert.strictEqual(r('Rengo'), 'RENCA'); assert.strictEqual(r('Qta Normal'), 'QUINTA NORMAL'); assert.strictEqual(r('Ñuñoa, Santiago'), 'ÑUÑOA');
    assert.strictEqual(r('San Tiago'), 'SANTIAGO'); assert.strictEqual(r('Coquimbo'), null); assert.strictEqual(r('Región Metropolitana'), null); assert.strictEqual(r(''), null); assert.strictEqual(r(null), null);
});

// ───────────── B. decisión por pedido ─────────────
t('B1 el ESTADO de la tienda manda: ciudad «Santiago» pero estado Vitacura → VITACURA (antes quedaba SANTIAGO)', () => {
    need(wc, 'services/wooCommune.js');
    const r = resolve(order(1, 'completed', 'Santiago', 'CL_441'));
    assert.deepStrictEqual([r.commune, r.source, r.isRM, r.allow, r.reason], ['VITACURA', 'state', true, true, 'ok']);
    assert.strictEqual(r.stateName, 'Vitacura');
});
t('B2 la ciudad mal escrita ya no importa si el estado es una comuna de la RM: «San Tiago» → SAN BERNARDO, «Condominio La Siembra» → COLINA, «8679» → PEÑALOLÉN', () => {
    need(wc, 'services/wooCommune.js');
    assert.strictEqual(resolve(order(2, 'completed', 'San Tiago', 'CL_381')).commune, 'SAN BERNARDO');
    assert.strictEqual(resolve(order(3, 'completed', 'Condominio La Siembra', 'CL_157')).commune, 'COLINA');
    const r = resolve(order(4, 'completed', '8679', 'CL_313')); assert.deepStrictEqual([r.commune, r.allow], ['PEÑALOLÉN', true]);
});
t('B3 una tienda SIN lista de estados sigue funcionando con la ciudad: error de tipeo de una letra sí, de dos no (falso positivo «Rengo» → «Renca»)', () => {
    need(wc, 'services/wooCommune.js'); const sin = { stateMap: null };
    const typo = resolve(order(5, 'completed', 'Santiagi', 'CL_381'), sin); assert.deepStrictEqual([typo.commune, typo.source, typo.allow], ['SANTIAGO', 'city', true]);
    assert.strictEqual(resolve(order(6, 'completed', 'Providensia', ''), sin).commune, 'PROVIDENCIA');
    const rengo = resolve(order(7, 'completed', 'Rengo', 'CL_300'), sin); assert.deepStrictEqual([rengo.commune, rengo.allow, rengo.reason], [null, false, 'not_rm']);
    const unknown = resolve(order(8, 'completed', 'Condominio La Siembra', 'CL_157'), sin); assert.deepStrictEqual([unknown.commune, unknown.allow, unknown.reason], [null, false, 'not_rm'], 'sin la lista no se puede saber: se salta como antes');
});
t('B4 si el estado dice que el pedido es de otra parte, una ciudad «parecida» por tipeo no lo trae a la RM; una comuna escrita EXACTA sí cuenta', () => {
    need(wc, 'services/wooCommune.js');
    const rengo = resolve(order(9, 'completed', 'Rengo', 'CL_300')); assert.deepStrictEqual([rengo.commune, rengo.allow, rengo.reason], [null, false, 'not_rm']);
    const typoAfuera = resolve(order(10, 'completed', 'Santiagi', 'CL_167')); assert.strictEqual(typoAfuera.allow, false, 'estado Coquimbo + ciudad con tipeo: no');
    const macul = resolve(order(11, 'completed', 'Macul', 'CL_103')); assert.deepStrictEqual([macul.commune, macul.source, macul.allow], ['MACUL', 'city', true], 'el cliente escribió Macul; el estado «Alto del Carmen» es un error de la lista');
    assert.strictEqual(resolve(order(12, 'completed', 'Coquimbo', 'CL_167')).allow, false);
});
t('B5 comuna deshabilitada en el setup: se salta con motivo «inactive» (también cuando la ciudad escrita decía Santiago)', () => {
    need(wc, 'services/wooCommune.js');
    const r = resolve(order(13, 'completed', 'Santiago', 'CL_150')); assert.deepStrictEqual([r.commune, r.isRM, r.allow, r.reason], ['LAMPA', true, false, 'inactive']);
    assert.strictEqual(resolve(order(14, 'completed', 'Santiago', 'CL_150'), { validCommunes: [] }).allow, true, 'setup sin comunas activas = todas habilitadas');
});
t('B6 las reglas de región de siempre se mantienen cuando no se identifica ninguna comuna', () => {
    need(wc, 'services/wooCommune.js');
    const generica = resolve(order(15, 'completed', 'Santiago de Chile', ''), { stateMap: null }); assert.deepStrictEqual([generica.commune, generica.isRM, generica.allow], [null, true, true]);
    const region = resolve(order(16, 'completed', 'Ciudad cualquiera', 'CL-RM')); assert.deepStrictEqual([region.commune, region.isRM, region.allow], [null, true, true], 'estado «Región Metropolitana de Santiago» según la lista');
    assert.strictEqual(wc.communeForPackage(generica, order(15, 'completed', 'Santiago de Chile', '')), 'SANTIAGO DE CHILE', 'sin comuna se guarda la ciudad normalizada, como antes');
    const sinNada = resolve({ id: 17, shipping: {}, billing: {} }); assert.deepStrictEqual([sinNada.allow, sinNada.reason], [false, 'not_rm']);
});
t('B7 usa los datos de facturación cuando el envío viene vacío, y no falla con pedidos incompletos', () => {
    need(wc, 'services/wooCommune.js');
    const r = resolve({ id: 18, shipping: { city: '', state: '' }, billing: { city: 'Santiago', state: 'CL_235' } }); assert.deepStrictEqual([r.commune, r.allow], ['LAS CONDES', true]);
    for (const bad of [null, undefined, {}, { shipping: null, billing: null }]) assert.doesNotThrow(() => resolve(bad));
});
t('B8 contra los pedidos reales de la tienda (casos del 1-oct al 9-nov): coincide con la comuna que puso el operador a mano', () => {
    need(wc, 'services/wooCommune.js');
    // (ciudad escrita, estado, comuna que escribió el operador)
    for (const [city, state, operator] of [['Santiago', 'CL_287', 'ÑUÑOA'], ['Santiago', 'CL_235', 'LAS CONDES'], ['Santiago', 'CL_441', 'VITACURA'], ['Condominio La Siembra', 'CL_157', 'COLINA'], ['Santiago', 'CL_408', 'SANTIAGO']])
        assert.strictEqual(resolve(order(20, 'completed', city, state)).commune, operator, `${city}/${state}`);
});

// ───────────── C. lista de estados ─────────────
t('C1 getStateMap pide la lista una vez cada 12 horas, la comparte entre pedidos y usa la vieja si la tienda deja de entregarla', async () => {
    need(wc, 'services/wooCommune.js'); wc._stateMaps.clear();
    let calls = 0; const ok = async () => { calls++; return { states: STATES }; };
    const m1 = await wc.getStateMap(ok, 'tienda-1', 'CL', 1000); const m2 = await wc.getStateMap(ok, 'tienda-1', 'CL', 1000 + 11 * 3600 * 1000);
    assert.strictEqual(calls, 1); assert.strictEqual(m1, m2); assert.strictEqual(m1.get('CL_441'), 'Vitacura');
    const fail = async () => { throw new Error('caída'); };
    const m3 = await wc.getStateMap(fail, 'tienda-1', 'CL', 1000 + 13 * 3600 * 1000); assert.strictEqual(m3, m1, 'vencida pero sirve si la tienda no responde');
    assert.strictEqual(await wc.getStateMap(fail, 'tienda-nueva', 'CL', 5), null, 'sin lista previa: null (se sigue con la ciudad)');
    assert.strictEqual(await wc.getStateMap(async () => ({ states: [] }), 'tienda-vacia', 'CL', 5), null);
    assert.strictEqual(await wc.getStateMap(async () => { throw { statusCode: 404, body: {} }; }, 'tienda-sin-ruta', 'CL', 5), null);
});

// ───────────── D. importador automático ─────────────
t('D1 el importador toma los pedidos con la ciudad mal escrita y guarda la comuna REAL; no toma comunas deshabilitadas ni de otras regiones', async () => {
    need(poller, 'services/woocommercePollingService.js'); (wc || { _stateMaps: new Map() })._stateMaps.clear();
    live = [order(12801, 'completed', 'Santiago', 'CL_441'), order(12802, 'completed', 'San Tiago', 'CL_381'), order(12803, 'completed', 'Condominio La Siembra', 'CL_157'),
        order(12804, 'completed', 'Santiago', 'CL_150'), order(12805, 'completed', 'Coquimbo', 'CL_167'), order(12806, 'completed', 'Rengo', 'CL_300'),
        order(12807, 'processing', 'Macul', 'CL_103'), order(12808, 'completed', 'Santiago', 'CL_408'), order(12809, 'on-hold', 'Santiago', 'CL_441')];
    addUser(); await poller.triggerSync();
    assert.deepStrictEqual(importedBy(), { 12801: 'VITACURA', 12802: 'SAN BERNARDO', 12803: 'COLINA', 12807: 'MACUL', 12808: 'SANTIAGO' });
    const row = S.inserts.find(r => r.wooOrderId === '12802'); assert.strictEqual(row.recipientCity, 'REGIÓN METROPOLITANA'); assert.strictEqual(row.status, 'PENDIENTE'); assert.strictEqual(row.source, 'WOOCOMMERCE');
    assert.strictEqual(row.notes, 'Auto-Import WooCommerce Order: 12802');
});
t('D2 la lista de estados se pide UNA vez aunque haya varios ciclos y pedidos; la consulta lleva el parámetro anti-caché', async () => {
    need(poller, 'services/woocommercePollingService.js'); wc._stateMaps.clear();
    live = [order(12811, 'completed', 'Santiago', 'CL_441')]; addUser();
    await poller.triggerSync(); S.users[0].integrations.accounts[0].settings.lastSync = '2020-01-01T00:00:00.000Z'; live.push(order(12812, 'completed', 'Santiago', 'CL_235')); await poller.triggerSync();
    const stateCalls = storeCalls.filter(p => /data\/countries\/CL/.test(p)); assert.strictEqual(stateCalls.length, 1, stateCalls.join(' | '));
    assert.ok(/countries\/CL\?_=\d{13}$/.test(stateCalls[0]), stateCalls[0]);
    assert.deepStrictEqual(importedBy(), { 12811: 'VITACURA', 12812: 'LAS CONDES' });
});
t('D3 si la tienda no entrega la lista de estados, el importador sigue con la ciudad: acepta el error de tipeo de una letra y sigue saltando «Rengo»', async () => {
    need(poller, 'services/woocommercePollingService.js'); wc._stateMaps.clear(); statesAvailable = false;
    live = [order(12821, 'completed', 'Santiago', 'CL_441'), order(12822, 'completed', 'Santiagi', 'CL_381'), order(12823, 'completed', 'Providensia', 'CL_139'), order(12824, 'completed', 'Rengo', 'CL_300'), order(12825, 'completed', 'Condominio La Siembra', 'CL_157')];
    addUser(); await poller.triggerSync();
    assert.deepStrictEqual(importedBy(), { 12821: 'SANTIAGO', 12822: 'SANTIAGO', 12823: 'PROVIDENCIA' }, 'importó: ' + JSON.stringify(importedBy()));
});

t('D4 un pedido anterior a la conexión de la cuenta no se importa (regla de siempre), uno posterior sí', async () => {
    need(poller, 'services/woocommercePollingService.js'); wc._stateMaps.clear();
    addUser(); S.users[0].integrations.accounts[0].connectedAt = '2026-11-05T00:00:00.000Z';
    live = [order(12841, 'completed', 'Santiago', 'CL_441', { date_created_gmt: '2026-11-01T10:00:00', date_created: '2026-11-01T07:00:00' }), order(12842, 'completed', 'Santiago', 'CL_441', { date_created_gmt: '2026-11-06T10:00:00', date_created: '2026-11-06T07:00:00' })];
    await poller.triggerSync();
    assert.deepStrictEqual(importedBy(), { 12842: 'VITACURA' });
});

// ───────────── E. lista del operador ─────────────
let server; let base;
const tokenFor = (id, role) => jwt.sign({ user: { id, role } }, process.env.JWT_SECRET);
t('E1 la lista del importador manual muestra la comuna real y una ciudad legible, no el código «CL_xxx» ni «SANTIAGO» para todos', async () => {
    need(wc, 'services/wooCommune.js'); wc._stateMaps.clear();
    live = [order(12831, 'completed', 'Santiago', 'CL_441'), order(12832, 'completed', 'San Tiago', 'CL_381'), order(12833, 'completed', 'Coquimbo', 'CL_167'), order(12834, 'completed', 'Santiago', 'CL_287')]; addUser();
    const res = await fetch(`${base}/api/integrations/user-tienda/woocommerce/orders`, { headers: { Authorization: 'Bearer ' + tokenFor('adm', 'ADMIN') } });
    assert.strictEqual(res.status, 200); const body = await res.json(); const by = Object.fromEntries(body.map(o => [o.id, o]));
    assert.deepStrictEqual([by[12831].commune, by[12831].city], ['VITACURA', 'REGIÓN METROPOLITANA']);
    assert.deepStrictEqual([by[12832].commune, by[12832].city], ['SAN BERNARDO', 'REGIÓN METROPOLITANA']);
    assert.deepStrictEqual([by[12833].commune, by[12833].city], ['COQUIMBO', 'Coquimbo'], 'fuera de la RM se muestra la comuna según la lista de la tienda');
    assert.strictEqual(by[12834].commune, 'ÑUÑOA'); assert.ok(body.every(o => !/^CL_/.test(o.city)), 'ningún código en la ciudad');
});

// ───────────── ejecución ─────────────
(async () => {
    const app = express(); app.use(express.json());
    const router = tryLoad('routes/integrations.js'); if (router) app.use('/api/integrations', router);
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
