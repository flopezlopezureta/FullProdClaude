/**
 * Prueba del CIERRE DIFERIDO DE MERCADO LIBRE: la entrega que ML aún no registra como cerrada queda guardada en el teléfono (con su nombre y sus fotos),
 * el conductor sigue con las demás y la app la envía sola, en silencio, apenas Mercado Libre la confirma.
 *   A. reglas sueltas (services/meliDeferredClose.ts): esperas entre reintentos, vencimiento, textos
 *   B. la cola guardada en el teléfono (services/offlineQueue.ts) sobre un localStorage falso
 *   C. el procesador (services/offlineQueueProcessor.ts) con una API falsa y un reloj controlado
 *   D. el cierre automático de la jornada (services/autoClosure.ts) fuerza el envío de lo que espera a ML
 * No toca red ni base de datos; paquetes, nombres y fotos son inventados.
 *
 * Uso:   node tests/meliDeferredClose.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/meliDeferredClose.test.js
 *        (otra copia = el clon de Staging/Producción antes de subir)
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const esbuild = load('esbuild');

// Se compila UNA vez; cada prueba evalúa su propia copia del código (estado de módulo limpio: el cerrojo de «un ciclo a la vez», el «ya cerré hoy»…).
let BUNDLE;
async function compile() {
    const entry = [
        `export * as rules from './services/meliDeferredClose.ts';`,
        `export { offlineQueue } from './services/offlineQueue.ts';`,
        `export { processOfflineQueue, QUEUE_DISCARDED_EVENT } from './services/offlineQueueProcessor.ts';`,
        `export { tryAutoCloseRoute } from './services/autoClosure.ts';`,
        `export { api, ApiError } from './services/api.ts';`,
    ].join('\n');
    const out = await esbuild.build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' });
    BUNDLE = out.outputFiles[0].text;
}
const instantiate = () => { const m = { exports: {} }; new Function('module', 'exports', 'require', BUNDLE)(m, m.exports, require); return m.exports; };

// ───────────── entorno falso del teléfono ─────────────
const T0 = Date.UTC(2026, 10, 5, 15, 0, 0);          // reloj de las pruebas
const clock = { t: T0 };
const realNow = Date.now;
const SEG = 1000; const MIN = 60 * SEG; const HORA = 60 * MIN;

function makeEnv() {
    const store = new Map(); const events = [];
    const env = { store, events, full: false, nav: { onLine: true }, count: (type) => events.filter(e => e.type === type).length, clearEvents: () => { events.length = 0; } };
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { if (env.full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    };
    const win = { dispatchEvent: (e) => { events.push(e); return true; }, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', { value: env.nav, configurable: true, writable: true });
    return env;
}

/** Un teléfono nuevo: código recién cargado, reloj en T0, cola vacía, API falsa que anota cada llamada. */
function setup() {
    clock.t = T0; Date.now = () => clock.t;
    const env = makeEnv();
    const m = instantiate();
    const calls = { ready: [], deliver: [], problem: [], returns: [], summary: 0, closure: [] };
    const script = {
        ready: async () => ({ ready: true, pending: [] }),      // por omisión ML ya muestra todo como entregado
        deliver: async () => ({}),
        summaries: [],                                          // respuestas sucesivas de getClosureSummary
    };
    m.api.checkMeliReady = async (ids) => { calls.ready.push(ids.slice()); return script.ready(ids); };
    m.api.confirmDelivery = async (pkgId, data) => { calls.deliver.push({ pkgId, data }); return script.deliver(pkgId, data); };
    m.api.markPackageAsProblem = async (pkgId) => { calls.problem.push(pkgId); return {}; };
    m.api.confirmReturn = async (pkgId) => { calls.returns.push(pkgId); return {}; };
    m.api.getClosureSummary = async () => { calls.summary++; const s = script.summaries.length > 1 ? script.summaries.shift() : script.summaries[0]; return { ...s }; };
    m.api.submitClosure = async (body) => { calls.closure.push(body); return {}; };
    const s = { m, env, calls, script, q: m.offlineQueue, rules: m.rules, at: (ms) => { clock.t = T0 + ms; }, err: (status, body, msg) => new m.ApiError(msg || 'error de prueba', status, body) };
    // Entrega guardada que espera a ML, creada `atMs` después de T0 (el reloj queda ahí).
    s.waiting = (pkgId, atMs = 0) => { clock.t = T0 + atMs; return s.q.enqueue('DELIVER', pkgId, DATA(pkgId), m.rules.startWaiting(clock.t)); };
    s.item = (id) => s.q.getPending().find(a => a.id === id);
    return s;
}
const DATA = (pkgId) => ({ receiverName: 'Juan Pérez', receiverId: '12.345.678-5', photosBase64: ['data:image/jpeg;base64,AAA' + pkgId, 'data:image/jpeg;base64,BBB' + pkgId] });
const QUIET = (fn) => async () => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { await fn(); } finally { console.warn = w; console.error = e; Date.now = realNow; } };

const tests = []; const t = (name, fn) => tests.push([name, QUIET(fn)]);

// ───────────── A. reglas sueltas ─────────────
t('A1 la espera entre reintentos: 45 s, 1,5 min, 2 min, 3 min y de ahí en adelante cada 5 min', () => {
    const { rules } = setup().m;
    assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 99].map(rules.retryDelayMs), [45 * SEG, 90 * SEG, 120 * SEG, 180 * SEG, 300 * SEG, 300 * SEG, 300 * SEG, 300 * SEG]);
    for (const raro of [-3, NaN, undefined, null, 'x']) assert.strictEqual(rules.retryDelayMs(raro), 45 * SEG, String(raro));
});
t('A2 una entrega recién guardada empieza a esperar y cada intento espacia más el siguiente sin mover «desde cuándo espera»', () => {
    const { rules } = setup().m;
    assert.deepStrictEqual(rules.startWaiting(T0), { waitingMeli: true, since: T0, attempts: 0, lastAttemptAt: T0, nextAttemptAt: T0 + 45 * SEG });
    let meta = rules.startWaiting(T0); let now = T0; const gaps = [];
    for (let i = 0; i < 7; i++) { now = meta.nextAttemptAt; meta = rules.registerAttempt(meta, now); gaps.push(meta.nextAttemptAt - now); }
    assert.deepStrictEqual(gaps, [90 * SEG, 120 * SEG, 180 * SEG, 300 * SEG, 300 * SEG, 300 * SEG, 300 * SEG]);
    assert.strictEqual(meta.since, T0); assert.strictEqual(meta.attempts, 7); assert.strictEqual(meta.waitingMeli, true);
    const sinMeta = rules.registerAttempt(undefined, T0 + 5);
    assert.strictEqual(sinMeta.attempts, 1); assert.strictEqual(sinMeta.since, T0 + 5); assert.strictEqual(sinMeta.nextAttemptAt, T0 + 5 + 90 * SEG);
});
t('A3 solo una ENTREGA marcada como en espera cuenta como esperando a Mercado Libre', () => {
    const { rules } = setup().m; const meta = { waitingMeli: true };
    assert.strictEqual(rules.isWaitingMeli({ type: 'DELIVER', pkgId: 'P', timestamp: 1, meta }), true);
    assert.strictEqual(rules.isWaitingMeli({ type: 'DELIVER', pkgId: 'P', timestamp: 1 }), false);
    assert.strictEqual(rules.isWaitingMeli({ type: 'DELIVER', pkgId: 'P', timestamp: 1, meta: {} }), false);
    assert.strictEqual(rules.isWaitingMeli({ type: 'PROBLEM', pkgId: 'P', timestamp: 1, meta }), false);
    assert.strictEqual(rules.isWaitingMeli({ type: 'RETURN', pkgId: 'P', timestamp: 1, meta }), false);
    assert.strictEqual(rules.isWaitingMeli(null), false); assert.strictEqual(rules.isWaitingMeli(undefined), false);
});
t('A4 toca reintentar justo cuando llega su hora (no antes) y sin datos de control toca de inmediato', () => {
    const { rules } = setup().m; const a = { type: 'DELIVER', pkgId: 'P', timestamp: T0, meta: rules.startWaiting(T0) };
    assert.strictEqual(rules.isDue(a, T0 + 45 * SEG - 1, false), false);
    assert.strictEqual(rules.isDue(a, T0 + 45 * SEG, false), true);
    assert.strictEqual(rules.isDue({ type: 'DELIVER', pkgId: 'P', timestamp: T0 }, T0, false), true);
});
t('A5 «reintentar ya» se salta la espera pero no repite un intento de hace menos de 15 s', () => {
    const { rules } = setup().m; const a = { type: 'DELIVER', pkgId: 'P', timestamp: T0, meta: rules.startWaiting(T0) };   // último intento: T0, próximo: T0 + 45 s
    assert.strictEqual(rules.isDue(a, T0 + 10 * SEG, true), false, 'a los 10 s');
    assert.strictEqual(rules.isDue(a, T0 + 15 * SEG - 1, true), false, 'a los 14,999 s');
    assert.strictEqual(rules.isDue(a, T0 + 15 * SEG, true), true, 'a los 15 s, aunque su turno normal sea a los 45 s');
    assert.strictEqual(rules.isDue({ type: 'DELIVER', pkgId: 'P', timestamp: T0, meta: { waitingMeli: true } }, T0, true), true, 'sin intento previo');
});
t('A6 a las 24 horas esperando a Mercado Libre se suelta (cuenta desde que empezó a esperar; si no consta, desde que se guardó)', () => {
    const { rules } = setup().m;
    const a = { type: 'DELIVER', pkgId: 'P', timestamp: T0 - 99 * HORA, meta: { waitingMeli: true, since: T0 } };
    assert.strictEqual(rules.isExpired(a, T0 + 24 * HORA - 1), false);
    assert.strictEqual(rules.isExpired(a, T0 + 24 * HORA), true);
    const sinDesde = { type: 'DELIVER', pkgId: 'P', timestamp: T0, meta: { waitingMeli: true } };
    assert.strictEqual(rules.isExpired(sinDesde, T0 + 24 * HORA - 1), false); assert.strictEqual(rules.isExpired(sinDesde, T0 + 24 * HORA), true);
});
t('A7 el servidor rechaza para siempre con 400/404/409/410/422; 401, 403, 408, 429 y los 5xx se reintentan', () => {
    const { rules } = setup().m;
    for (const s of [400, 404, 409, 410, 422]) assert.strictEqual(rules.isFinalRejection(s), true, String(s));
    for (const s of [0, 200, 401, 403, 408, 429, 500, 502, 503, 504]) assert.strictEqual(rules.isFinalRejection(s), false, String(s));
});
t('A8 los textos: ya no piden esperar 60 segundos, dicen que se envía sola y que puede seguir, en singular y plural, con tuteo', () => {
    const { MESSAGES: M } = setup().m.rules;
    const uno = M.saved(1), varias = M.saved(3), mixto = M.saved(1, 2);
    assert.ok(/^Entrega guardada\./.test(uno) && /se enviará sola/.test(uno) && /Puedes seguir con las demás entregas/.test(uno), uno);
    assert.ok(/^3 entregas guardadas\./.test(varias) && /se enviarán solas/.test(varias), varias);
    assert.ok(/2 entregas cerradas/.test(mixto) && /1 quedó guardada/.test(mixto) && /sus? cierres?/.test(mixto), mixto);
    assert.ok(/Tienes 1 entrega guardada/.test(M.banner(1)) && /Se enviará sola/.test(M.banner(1)));
    assert.ok(/Tienes 4 entregas guardadas/.test(M.banner(4)) && /Se enviarán solas/.test(M.banner(4)) && /ciérralas/.test(M.banner(4)));
    assert.ok(/24 horas/.test(M.expired)); assert.ok(/Libera espacio/.test(M.storageFull));
    const todos = [uno, varias, mixto, M.banner(1), M.banner(4), M.bannerTitle, M.alreadySaved, M.expired, M.storageFull, M.discardedTitle(1), M.discardedTitle(2), M.discardedFooter].join('\n');
    assert.ok(!/60 segundos|60 s\b|espera(?:r)? un minuto/i.test(todos), 'no debe quedar el texto de la espera de 60 s');
    assert.ok(!/\b(tenés|podés|querés|sos|vos|hacé|cerrá|esperá|presioná|confirmá|fijate|mirá)\b/i.test(todos), 'tuteo, no voseo');
});

// ───────────── B. la cola del teléfono ─────────────
t('B1 los contadores separan lo guardado por falta de conexión de lo que solo espera a Mercado Libre', () => {
    const s = setup();
    s.q.enqueue('DELIVER', 'PK-1', DATA('PK-1'));                         // guardada sin conexión
    s.q.enqueue('PROBLEM', 'PK-2', { reason: 'x', photos: [] });
    s.waiting('PK-3'); s.waiting('PK-4');
    assert.strictEqual(s.q.getPendingCount(), 4); assert.strictEqual(s.q.getOfflineCount(), 2); assert.strictEqual(s.q.getWaitingMeliCount(), 2);
    assert.deepStrictEqual(s.q.getWaitingMeliPackageIds(), ['PK-3', 'PK-4']);
    assert.deepStrictEqual(s.q.getQueuedDeliveryPackageIds(), ['PK-1', 'PK-3', 'PK-4'], 'las entregas guardadas de cualquier tipo, no el problema');
    assert.strictEqual(s.q.hasPendingForPackage('PK-2'), true); assert.strictEqual(s.q.hasPendingForPackage('PK-9'), false);
});
t('B2 una entrega en espera reemplaza a la entrega guardada del MISMO paquete (no se duplica) y deja intactas las demás acciones', () => {
    const s = setup();
    s.q.enqueue('DELIVER', 'PK-1', DATA('PK-1')); s.q.enqueue('PROBLEM', 'PK-1', { reason: 'x', photos: [] }); s.q.enqueue('DELIVER', 'PK-2', DATA('PK-2'));
    s.waiting('PK-1');
    assert.deepStrictEqual(s.q.getPending().map(a => a.type + ':' + a.pkgId), ['PROBLEM:PK-1', 'DELIVER:PK-2', 'DELIVER:PK-1']);
    s.waiting('PK-1', 5 * SEG);
    assert.strictEqual(s.q.getPending().filter(a => a.type === 'DELIVER' && a.pkgId === 'PK-1').length, 1, 'confirmar dos veces no deja dos entregas');
    s.q.enqueue('DELIVER', 'PK-2', DATA('PK-2'));
    assert.strictEqual(s.q.getPending().filter(a => a.pkgId === 'PK-2').length, 2, 'una entrega normal sin conexión se guarda como siempre');
});
t('B3 removeForPackage saca solo lo pedido y avisa a las pantallas solo si sacó algo', () => {
    const s = setup();
    s.q.enqueue('DELIVER', 'PK-1', DATA('PK-1')); s.q.enqueue('PROBLEM', 'PK-1', {}); s.q.enqueue('DELIVER', 'PK-2', DATA('PK-2'));
    s.env.clearEvents();
    s.q.removeForPackage('PK-9'); assert.strictEqual(s.env.count('offline-queue-changed'), 0, 'nada que sacar, nada que avisar');
    s.q.removeForPackage('PK-1', 'DELIVER');
    assert.deepStrictEqual(s.q.getPending().map(a => a.type + ':' + a.pkgId), ['PROBLEM:PK-1', 'DELIVER:PK-2']); assert.strictEqual(s.env.count('offline-queue-changed'), 1);
    s.q.removeForPackage('PK-1');
    assert.deepStrictEqual(s.q.getPending().map(a => a.type + ':' + a.pkgId), ['DELIVER:PK-2']);
});
t('B4 setMeta es silencioso por omisión, avisa si se le pide, ignora ids desconocidos y no rompe si el teléfono no tiene espacio', () => {
    const s = setup(); const a = s.waiting('PK-1'); s.env.clearEvents();
    s.q.setMeta(a.id, { ...a.meta, attempts: 1 });
    assert.strictEqual(s.item(a.id).meta.attempts, 1); assert.strictEqual(s.env.count('offline-queue-changed'), 0, 'un contador de reintentos no repinta nada');
    s.q.setMeta(a.id, { ...a.meta, attempts: 2 }, true); assert.strictEqual(s.env.count('offline-queue-changed'), 1);
    s.env.clearEvents(); s.q.setMeta('no-existe', {}); assert.strictEqual(s.env.count('offline-queue-changed'), 0);
    s.env.full = true; assert.doesNotThrow(() => s.q.setMeta(a.id, { ...a.meta, attempts: 3 }, true)); s.env.full = false;
    assert.strictEqual(s.item(a.id).meta.attempts, 2, 'lo anterior queda intacto');
});
t('B5 si el teléfono no tiene espacio, guardar la entrega falla en voz alta (la pantalla conserva las fotos) y no deja la cola a medias', () => {
    const s = setup(); s.waiting('PK-1'); s.env.full = true;
    assert.throws(() => s.q.enqueue('DELIVER', 'PK-2', DATA('PK-2'), s.rules.startWaiting(T0)), /quota/i);
    s.env.full = false; assert.deepStrictEqual(s.q.getPending().map(a => a.pkgId), ['PK-1']);
});

// ───────────── C. el procesador ─────────────
t('C1 una entrega que ML aún no confirma queda esperando (las pantallas se enteran una vez) y no se reenvía en el ciclo siguiente', async () => {
    const s = setup(); const a = s.q.enqueue('DELIVER', 'PK-1', DATA('PK-1'));   // guardada sin conexión, aún sin marcar
    s.script.deliver = async () => { throw s.err(400, { code: 'MELI_NOT_CONFIRMED' }, 'Mercado Libre aún no confirma.'); };
    s.env.clearEvents();
    const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(r.synced, []); assert.deepStrictEqual(r.discarded, []); assert.strictEqual(r.stillPending, 1); assert.strictEqual(r.waiting, 1);
    assert.deepStrictEqual(s.item(a.id).meta, { waitingMeli: true, since: T0, attempts: 0, lastAttemptAt: T0, nextAttemptAt: T0 + 45 * SEG });
    assert.strictEqual(s.env.count('offline-queue-changed'), 1, 'la pantalla pasa a «esperando a Mercado Libre» una sola vez');
    s.at(10 * SEG); await s.m.processOfflineQueue();
    assert.strictEqual(s.calls.deliver.length, 1, 'no se reenvía con todas sus fotos en cada ciclo de 30 s'); assert.strictEqual(s.calls.ready.length, 0);
});
t('C2 al tocarle: una consulta liviana (sin fotos); si ML aún no la muestra, no se envía nada, se espacia el próximo intento y no se repinta nada', async () => {
    const s = setup(); const a = s.waiting('PK-1');
    s.script.ready = async (ids) => ({ ready: false, pending: ids.slice() });
    s.env.clearEvents();
    s.at(44 * SEG + 999); await s.m.processOfflineQueue(); assert.strictEqual(s.calls.ready.length, 0, 'todavía no toca');
    s.at(45 * SEG); const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(s.calls.ready, [['PK-1']]); assert.strictEqual(s.calls.deliver.length, 0, 'sin ML no se manda el cierre');
    assert.deepStrictEqual(s.item(a.id).meta, { waitingMeli: true, since: T0, attempts: 1, lastAttemptAt: T0 + 45 * SEG, nextAttemptAt: T0 + 45 * SEG + 90 * SEG });
    assert.strictEqual(r.waiting, 1); assert.strictEqual(r.stillPending, 1); assert.deepStrictEqual(r.synced, []);
    assert.strictEqual(s.env.count('offline-queue-changed'), 0, 'en silencio: el conductor no ve nada');
    s.at(45 * SEG + 90 * SEG - 1); await s.m.processOfflineQueue(); assert.strictEqual(s.calls.ready.length, 1);
    s.at(45 * SEG + 90 * SEG); await s.m.processOfflineQueue(); assert.strictEqual(s.calls.ready.length, 2);
    assert.strictEqual(s.item(a.id).meta.attempts, 2); assert.strictEqual(s.item(a.id).meta.nextAttemptAt, T0 + 45 * SEG + 90 * SEG + 120 * SEG);
});
t('C3 cuando ML ya la muestra cerrada se envía el cierre completo (nombre, RUT y fotos tal como se guardaron), sale de la cola y no avisa nada', async () => {
    const s = setup(); s.waiting('PK-1'); s.env.clearEvents();
    s.at(45 * SEG); const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(s.calls.ready, [['PK-1']]);
    assert.deepStrictEqual(s.calls.deliver, [{ pkgId: 'PK-1', data: DATA('PK-1') }]);
    assert.deepStrictEqual(r.synced, ['PK-1']); assert.strictEqual(r.stillPending, 0); assert.strictEqual(r.waiting, 0); assert.deepStrictEqual(r.discarded, []);
    assert.strictEqual(s.q.getPendingCount(), 0); assert.strictEqual(s.env.count('offline-queue-discarded'), 0, 'sin alertas: fue un cierre normal');
});
t('C4 la consulta liviana va por lotes de 25 paquetes y se envían todas las listas', async () => {
    const s = setup(); const ids = Array.from({ length: 30 }, (_, i) => 'PK-' + (i + 1)); ids.forEach(id => s.waiting(id));
    s.at(45 * SEG); const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(s.calls.ready.map(l => l.length), [25, 5]); assert.deepStrictEqual(s.calls.ready.flat(), ids);
    assert.deepStrictEqual(s.calls.deliver.map(d => d.pkgId), ids, 'en el orden en que se guardaron'); assert.strictEqual(r.synced.length, 30); assert.strictEqual(s.q.getPendingCount(), 0);
});
t('C5 con varias esperando, se envían solo las que ML ya muestra y a las demás se les espacia el intento', async () => {
    const s = setup(); const a1 = s.waiting('PK-1'); const a2 = s.waiting('PK-2'); const a3 = s.waiting('PK-3');
    s.script.ready = async () => ({ ready: false, pending: ['PK-2'] });
    s.at(45 * SEG); const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(s.calls.deliver.map(d => d.pkgId), ['PK-1', 'PK-3']); assert.deepStrictEqual(r.synced, ['PK-1', 'PK-3']);
    assert.strictEqual(s.item(a1.id), undefined); assert.strictEqual(s.item(a3.id), undefined);
    assert.strictEqual(s.item(a2.id).meta.attempts, 1); assert.strictEqual(r.waiting, 1);
});
t('C6 si la consulta liviana no tiene red no cuenta como intento y se reintenta en el próximo ciclo; al cerrar la jornada se envía igual', async () => {
    const s = setup(); const a = s.waiting('PK-1');
    s.script.ready = async () => { throw new TypeError('Failed to fetch'); };
    s.at(45 * SEG); await s.m.processOfflineQueue();
    assert.strictEqual(s.calls.deliver.length, 0); assert.deepStrictEqual(s.item(a.id).meta, s.rules.startWaiting(T0), 'sin cambios');
    s.at(60 * SEG); const r = await s.m.processOfflineQueue({ force: true });
    assert.deepStrictEqual(s.calls.deliver.map(d => d.pkgId), ['PK-1'], 'con «ya» se intenta el cierre aunque no se pudo preguntar'); assert.deepStrictEqual(r.synced, ['PK-1']);
});
t('C7 si la consulta liviana recibe un error del servidor sí cuenta como intento (se espacia) y no se envía nada', async () => {
    const s = setup(); const a = s.waiting('PK-1');
    s.script.ready = async () => { throw s.err(500, {}, 'Error interno'); };
    s.at(45 * SEG); await s.m.processOfflineQueue();
    assert.strictEqual(s.calls.deliver.length, 0); assert.strictEqual(s.item(a.id).meta.attempts, 1); assert.strictEqual(s.item(a.id).meta.nextAttemptAt, T0 + 45 * SEG + 90 * SEG);
});
t('C8 «reintentar ya» (cierre de jornada, aviso de ML, volver a la app) se adelanta a su turno, pero no repite un intento de hace menos de 15 s', async () => {
    const s = setup(); s.waiting('PK-1');
    s.at(10 * SEG); await s.m.processOfflineQueue({ force: true });
    assert.strictEqual(s.calls.ready.length, 0, 'a los 10 s: demasiado pronto, no se martilla a ML');
    s.at(20 * SEG); const r = await s.m.processOfflineQueue({ force: true });
    assert.deepStrictEqual(s.calls.ready, [['PK-1']], 'a los 20 s, mucho antes de sus 45 s'); assert.deepStrictEqual(r.synced, ['PK-1']);
});
t('C9 pasadas 24 horas sin que ML confirme, la entrega se suelta, se avisa una vez con un evento y lo demás sigue su curso', async () => {
    const s = setup(); const vieja = s.waiting('PK-1'); const nueva = s.waiting('PK-2', 24 * HORA - 30 * SEG);
    s.script.ready = async (ids) => ({ ready: false, pending: ids.slice() });
    s.env.clearEvents(); s.at(24 * HORA); const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(r.discarded, [{ pkgId: 'PK-1', message: s.rules.MESSAGES.expired }]);
    assert.strictEqual(s.item(vieja.id), undefined); assert.ok(s.item(nueva.id), 'la que lleva 30 s esperando sigue guardada');
    assert.strictEqual(s.calls.deliver.length, 0);
    const ev = s.env.events.filter(e => e.type === 'offline-queue-discarded'); assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual(ev[0].detail.items, [{ pkgId: 'PK-1', message: s.rules.MESSAGES.expired }]);
});
const REJECTIONS = [
    ['404: el paquete ya no existe', (s) => s.err(404, { message: 'Paquete no encontrado' }, 'Paquete no encontrado'), 'suelta'],
    ['409: ya no corresponde', (s) => s.err(409, {}, 'Conflicto'), 'suelta'],
    ['410', (s) => s.err(410, {}, 'Ya no existe'), 'suelta'],
    ['422', (s) => s.err(422, {}, 'No procesable'), 'suelta'],
    ['400 con otro motivo', (s) => s.err(400, { code: 'OTRO' }, 'Solicitud inválida'), 'suelta'],
    ['400: nombre de quien recibe inservible', (s) => s.err(400, { code: 'INVALID_RECEIVER_NAME' }, 'Ese no parece un nombre real.'), 'suelta'],
    ['400: fotos repetidas', (s) => s.err(400, { code: 'DUPLICATE_PHOTOS' }, 'Las fotos son la misma imagen.'), 'suelta'],
    ['403', (s) => s.err(403, {}, 'Sin permiso'), 'reintenta'],
    ['429', (s) => s.err(429, {}, 'Demasiadas solicitudes'), 'reintenta'],
    ['500', (s) => s.err(500, {}, 'Error interno'), 'reintenta'],
    ['503', (s) => s.err(503, {}, 'No disponible'), 'reintenta'],
    ['ML otra vez sin confirmar (la consulta decía lista y al enviar no)', (s) => s.err(400, { code: 'MELI_NOT_CONFIRMED' }, 'Mercado Libre aún no confirma.'), 'reintenta'],
    ['respuesta que no llegó completa: el cierre pudo quedar guardado', (s) => s.err(200, { unreadable: true }, 'Respuesta ilegible'), 'intacta'],
];
for (const [name, mk, what] of REJECTIONS) {
    t('C10 el servidor responde ' + name + ' → ' + { suelta: 'se saca de la cola y se avisa con su mensaje', reintenta: 'queda guardada y se espacia el intento, en silencio', intacta: 'queda tal cual para confirmarse en el próximo ciclo' }[what], async () => {
        const s = setup(); const a = s.waiting('PK-1'); const antes = s.item(a.id).meta;
        const e = mk(s); s.script.deliver = async () => { throw e; };
        s.env.clearEvents(); s.at(45 * SEG); const r = await s.m.processOfflineQueue();
        assert.strictEqual(s.calls.deliver.length, 1, 'se intentó el cierre una vez');
        if (what === 'suelta') {
            assert.strictEqual(s.q.getPendingCount(), 0); assert.deepStrictEqual(r.discarded, [{ pkgId: 'PK-1', message: e.message }]);
            assert.strictEqual(s.env.count('offline-queue-discarded'), 1);
        } else {
            assert.deepStrictEqual(r.discarded, []); assert.strictEqual(s.env.count('offline-queue-discarded'), 0); assert.strictEqual(s.env.count('offline-queue-changed'), 0, 'en silencio');
            if (what === 'reintenta') { assert.strictEqual(s.item(a.id).meta.attempts, 1); assert.strictEqual(s.item(a.id).meta.nextAttemptAt, T0 + 45 * SEG + 90 * SEG); assert.strictEqual(r.waiting, 1); }
            else assert.deepStrictEqual(s.item(a.id).meta, antes);
        }
    });
}
t('C11 un corte de red al enviar el cierre no descarta nada ni cuenta intento: queda igual para el próximo ciclo', async () => {
    const s = setup(); const a = s.waiting('PK-1'); const antes = s.item(a.id).meta;
    s.script.deliver = async () => { throw new TypeError('Failed to fetch'); };
    s.at(45 * SEG); const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(r.discarded, []); assert.deepStrictEqual(s.item(a.id).meta, antes); assert.strictEqual(r.stillPending, 1);
});
t('C12 sin conexión no hace nada: ni consultas, ni envíos, ni cambios en la cola', async () => {
    const s = setup(); const a = s.waiting('PK-1'); s.env.nav.onLine = false;
    s.at(10 * HORA); const r = await s.m.processOfflineQueue({ force: true });
    assert.strictEqual(s.calls.ready.length + s.calls.deliver.length, 0); assert.strictEqual(r.stillPending, 1); assert.strictEqual(r.waiting, 1); assert.ok(s.item(a.id));
});
t('C13 un ciclo a la vez: quien llama mientras hay uno en marcha recibe el mismo; con «ya» espera a que termine y hace el suyo', async () => {
    const s = setup(); s.q.enqueue('DELIVER', 'PK-1', DATA('PK-1'));
    let soltar; s.script.deliver = () => new Promise(res => { soltar = res; });
    const p1 = s.m.processOfflineQueue(); const p2 = s.m.processOfflineQueue(); const p3 = s.m.processOfflineQueue({ force: true });
    assert.strictEqual(p1, p2, 'el segundo comparte el ciclo en marcha'); assert.notStrictEqual(p1, p3);
    await new Promise(r => setImmediate(r)); soltar({});
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.deepStrictEqual(r1.synced, ['PK-1']); assert.strictEqual(r1, r2); assert.deepStrictEqual(r3.synced, [], 'el ciclo de «ya» encontró la cola vacía');
    assert.strictEqual(s.calls.deliver.length, 1, 'el cierre se mandó una sola vez');
    const p4 = await s.m.processOfflineQueue(); assert.deepStrictEqual(p4.synced, [], 'y el cerrojo se soltó');
});
t('C14 si una acción de un paquete es rechazada, las siguientes de ese mismo paquete esperan al próximo ciclo (se conserva el orden) y los demás paquetes siguen', async () => {
    const s = setup(); s.q.enqueue('DELIVER', 'PK-1', DATA('PK-1')); s.q.enqueue('PROBLEM', 'PK-1', { reason: 'x', photos: [] }); s.q.enqueue('DELIVER', 'PK-2', DATA('PK-2'));
    s.script.deliver = async (pkgId) => { if (pkgId === 'PK-1') throw s.err(500, {}, 'Error interno'); return {}; };
    const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(s.calls.problem, [], 'el problema de PK-1 no se adelanta a su entrega'); assert.deepStrictEqual(r.synced, ['PK-2']);
    assert.deepStrictEqual(s.q.getPending().map(a => a.type + ':' + a.pkgId), ['DELIVER:PK-1', 'PROBLEM:PK-1']);
});
t('C15 lo guardado por falta de conexión (devolución, problema) se sigue enviando como siempre', async () => {
    const s = setup(); s.q.enqueue('RETURN', 'PK-1', { receiverName: 'x' }); s.q.enqueue('PROBLEM', 'PK-2', { reason: 'Ausente', photos: [] });
    const r = await s.m.processOfflineQueue();
    assert.deepStrictEqual(s.calls.returns, ['PK-1']); assert.deepStrictEqual(s.calls.problem, ['PK-2']); assert.deepStrictEqual(r.synced, ['PK-1', 'PK-2']); assert.strictEqual(s.q.getPendingCount(), 0);
});

// ───────────── D. cierre automático de la jornada ─────────────
t('D1 al cerrar la jornada, si lo único que falta son entregas en espera se intentan al momento y, si salen, el día se cierra solo', async () => {
    const s = setup(); s.waiting('PK-1', -60 * SEG); s.at(0);
    s.script.summaries = [{ pending: 1, total: 5, delivered: 4 }, { pending: 0, total: 5, delivered: 5 }];
    const r = await s.m.tryAutoCloseRoute();
    assert.deepStrictEqual(r, { closed: true }); assert.deepStrictEqual(s.calls.ready, [['PK-1']]); assert.deepStrictEqual(s.calls.deliver.map(d => d.pkgId), ['PK-1']);
    assert.strictEqual(s.calls.summary, 2, 'se vuelve a leer el resumen después de enviar'); assert.strictEqual(s.calls.closure.length, 1);
    assert.strictEqual(s.calls.closure[0].pending, 0); assert.ok(/Cierre automático/.test(s.calls.closure[0].notes));
});
t('D2 si ML todavía no las confirma, el día no se cierra, nada se pierde y siguen guardadas', async () => {
    const s = setup(); const a = s.waiting('PK-1', -60 * SEG); s.at(0);
    s.script.summaries = [{ pending: 1, total: 5 }]; s.script.ready = async (ids) => ({ ready: false, pending: ids.slice() });
    const r = await s.m.tryAutoCloseRoute();
    assert.deepStrictEqual(r, { closed: false }); assert.strictEqual(s.calls.closure.length, 0); assert.strictEqual(s.calls.deliver.length, 0); assert.ok(s.item(a.id));
});
t('D3 si falta algo más que las entregas en espera no se fuerza nada (y no hay botón ni atajo para cerrar igual)', async () => {
    const s = setup(); s.waiting('PK-1', -60 * SEG); s.at(0);
    s.script.summaries = [{ pending: 2, total: 5 }];
    const r = await s.m.tryAutoCloseRoute();
    assert.deepStrictEqual(r, { closed: false }); assert.strictEqual(s.calls.ready.length + s.calls.deliver.length, 0); assert.strictEqual(s.calls.closure.length, 0);
});
t('D4 con todo gestionado el día se cierra como siempre, sin tocar la cola', async () => {
    const s = setup(); s.script.summaries = [{ pending: 0, total: 3 }];
    const r = await s.m.tryAutoCloseRoute();
    assert.deepStrictEqual(r, { closed: true }); assert.strictEqual(s.calls.ready.length + s.calls.deliver.length, 0); assert.strictEqual(s.calls.summary, 1);
});
t('D5 con pendientes y la cola vacía no se fuerza nada', async () => {
    const s = setup(); s.script.summaries = [{ pending: 3, total: 5 }];
    const r = await s.m.tryAutoCloseRoute();
    assert.deepStrictEqual(r, { closed: false }); assert.strictEqual(s.calls.ready.length, 0); assert.strictEqual(s.calls.closure.length, 0);
});

// ───────────── ejecutar ─────────────
(async () => {
    const log = console.log; let ok = 0; const fails = [];
    try { await compile(); } catch (e) { log('FALLA no compila con este código: ' + String(e.message).split('\n').slice(0, 4).join('\n      ')); process.exit(1); }
    for (const [name, fn] of tests) {
        try { await fn(); ok++; log('OK    ' + name); } catch (e) { fails.push(name); log('FALLA ' + name + '\n      ' + String(e.message).split('\n').slice(0, 6).join('\n      ')); }
    }
    log(`\n${ok} de ${tests.length} pruebas OK`);
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(2); });
