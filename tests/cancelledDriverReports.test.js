/**
 * Prueba de los CANCELADOS que pone un CONDUCTOR en paquetes de Mercado Libre («Cliente canceló el pedido») mientras Mercado Libre sigue mostrando el envío vivo.
 *   A. qué estado deja cada motivo de problema, según el origen (services/cancelledPackages.js → problemTargetStatus)
 *   B. qué estados de un envío de ML cuentan como «sigue vivo»
 *   C. la regla de reabrir (reviveIfOpenInMeli) con una base falsa que interpreta la condición como lo hace la consulta real
 *   D. la ruta real POST /api/packages/:id/problem contra una base falsa en memoria
 * No toca ninguna base de datos real; todos los datos son inventados. En D cada consulta se interpreta a mano: una consulta no prevista hace fallar la prueba.
 * La condición SQL en sí se comprueba aparte contra Postgres real (tablas temporales, siempre revertidas), no aquí.
 *
 * Uso:   node tests/cancelledDriverReports.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/cancelledDriverReports.test.js
 *        (otra copia = el código ANTERIOR, para comprobar que la prueba detecta el defecto, o el clon de Staging/Producción antes de subir)
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

// ───────────── base falsa (solo lo que usa /problem) ─────────────
let S;
const reset = () => { S = { packages: {}, events: [], notified: [], admin: [], unknown: [] }; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const R = (rows) => ({ rows, rowCount: rows.length });
const add = (id, over = {}) => (S.packages[id] = { id, status: 'EN_TRANSITO', source: 'MERCADO_LIBRE', driverId: 'drv-1', recipientAddress: 'Calle Falsa 123', deliveryPhotosBase64: null, updatedAt: null, ...over });
async function run(text, params = []) {
    const q = norm(text);
    if (/^SELECT source, "driverId" FROM packages WHERE id = \$1$/.test(q)) { const p = S.packages[params[0]]; return R(p ? [{ source: p.source, driverId: p.driverId }] : []); }
    if (/^UPDATE packages SET status = \$1, "deliveryPhotosBase64" = \$2, "updatedAt" = \$3 WHERE id = \$4 RETURNING \*$/.test(q)) {
        const p = S.packages[params[3]]; if (!p) return R([]);
        Object.assign(p, { status: params[0], deliveryPhotosBase64: params[1], updatedAt: params[2] }); return R([{ ...p }]);
    }
    if (/^INSERT INTO tracking_events \("packageId", status, location, details, timestamp\) VALUES \(\$1, \$2, \$3, \$4, \$5\)$/.test(q)) { S.events.push({ packageId: params[0], status: params[1], details: params[3] }); return R([]); }
    if (/^SELECT \* FROM tracking_events WHERE "packageId" = \$1 ORDER BY timestamp DESC$/.test(q)) return R(S.events.filter(e => e.packageId === params[0]).reverse());
    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 200));
}
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('db.js', { query: (t, p) => run(t, p), getClient: async () => { throw new Error('no se usa'); } });
stub('services/notificationService.js', { notifyRecipient: (id, st) => { S.notified.push([id, st]); return Promise.resolve(); }, notifyRecipientsBulk: () => Promise.resolve(), notifyAdminPendingDelivery: (id, st, reason) => { S.admin.push([id, st, reason]); return Promise.resolve(); } });
stub('services/meliPollingService.js', { optimizedJITDiscovery: async () => null, getValidMeliToken: async () => 'TOKEN-1' });
stub('services/jumpsellerPollingService.js', {});
stub('services/geocodingService.js', { geocodeAddress: async () => null, triggerBackgroundGeocoding: () => {} });
stub('services/gisService.js', { getSectorForCoordinates: () => 'Sector de prueba', reloadSectors: async () => {} });
stub('services/timeService.js', { getLogicalDate: async (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10), getSystemTimezone: async () => 'America/Santiago', getLogicalRange: async () => ({ start: new Date(), end: new Date() }), getLogicalTodayRange: async () => ({ start: new Date(), nextDayStart: new Date() }) });
stub('services/falabellaDirectService.js', { getOrderByLpn: async () => { throw new Error('no debe llamarse'); }, pushStatusUpdate: async () => {} });
stub('services/driverEvents.js', { emitDriverEvent: () => {}, bus: new (require('events'))() });

const tests = []; const t = (name, fn) => tests.push([name, fn]);
const cancelled = (() => { try { return require(path.join(ROOT, 'services/cancelledPackages.js')); } catch (e) { return null; } })();
const need = (fn) => assert.ok(cancelled && typeof cancelled[fn] === 'function', 'no existe services/cancelledPackages.js → ' + fn);
const png = (n) => 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('foto-' + n + '-abcdefgh')]).toString('base64');

// ───────────── A. estado que deja cada motivo ─────────────
const CANCEL_REASONS = ['Cliente canceló el pedido', 'CLIENTE CANCELÓ EL PEDIDO', 'Pedido cancelado por mercado libre', 'Cancelado ', 'cancelo', 'El comprador quiso cancelar'];
const RESCHEDULE_REASONS = ['Cliente solicita reagendar entrega', 'Pidio reagendar', 'Reajendado'.replace('Reajendado', 'reagendar para mañana'), 'Reprogramar entrega', 'Cliente pide reprogramar', 'canceló y quiere reprogramar'];
const OTHER_REASONS = ['Destinatario ausente en domicilio', 'Dirección de entrega incorrecta o incompleta', 'Entrega rechazada por el destinatario', 'Acceso denegado o zona peligrosa', 'Nadie en el domicilio', 'Otro motivo', ''];
t('A1 en Mercado Libre, un motivo con «cancel» ya NO cancela el paquete: queda PROBLEMA (abierto, reasignable); Mercado Libre decide la cancelación', () => {
    need('problemTargetStatus');
    for (const r of CANCEL_REASONS) assert.strictEqual(cancelled.problemTargetStatus(r, 'MERCADO_LIBRE'), 'PROBLEMA', r);
});
t('A2 en los demás orígenes (manual, tiendas, Falabella…) un motivo con «cancel» sigue dejando CANCELADO: no hay otra fuente de verdad', () => {
    need('problemTargetStatus');
    for (const src of ['MANUAL', 'SHOPIFY', 'FALABELLA', 'FALABELLA_DIRECTO', 'JUMPSELLER', 'WOOCOMMERCE', null, undefined]) for (const r of CANCEL_REASONS) assert.strictEqual(cancelled.problemTargetStatus(r, src), 'CANCELADO', `${src} · ${r}`);
});
t('A3 reagendar / reprogramar siempre da REPROGRAMADO (en cualquier origen, y primero que «cancel» si el texto trae las dos cosas)', () => {
    need('problemTargetStatus');
    for (const src of ['MERCADO_LIBRE', 'MANUAL', null]) for (const r of RESCHEDULE_REASONS) assert.strictEqual(cancelled.problemTargetStatus(r, src), 'REPROGRAMADO', `${src} · ${r}`);
});
t('A4 cualquier otro motivo da PROBLEMA, también como antes', () => {
    need('problemTargetStatus');
    for (const src of ['MERCADO_LIBRE', 'MANUAL', null]) for (const r of OTHER_REASONS) assert.strictEqual(cancelled.problemTargetStatus(r, src), 'PROBLEMA', `${src} · ${JSON.stringify(r)}`);
});
t('A5 un motivo que no es texto falla, igual que antes (la ruta lo informa como error en vez de crear un problema «undefined»)', () => {
    need('problemTargetStatus');
    for (const bad of [undefined, null, 5, {}]) assert.throws(() => cancelled.problemTargetStatus(bad, 'MERCADO_LIBRE'), TypeError, String(bad));
});

// ───────────── B. cuándo un envío de ML «sigue vivo» ─────────────
t('B1 sigue vivo: pendiente, preparando, listo para enviar y en camino; no lo está lo entregado, cancelado, no entregado/devuelto ni lo desconocido', () => {
    need('isOpenInMeli');
    for (const s of ['pending', 'handling', 'ready_to_ship', 'shipped']) assert.strictEqual(cancelled.isOpenInMeli(s), true, s);
    for (const s of ['delivered', 'cancelled', 'not_delivered', 'returned', 'not_found', 'to_be_agreed', '', null, undefined, 'SHIPPED', 5]) assert.strictEqual(cancelled.isOpenInMeli(s), false, String(s));
    assert.deepStrictEqual(cancelled.ML_OPEN_STATUSES, ['pending', 'handling', 'ready_to_ship', 'shipped']);
});

// ───────────── C. reabrir ─────────────
// Interpreta en JS la misma condición que DRIVER_CANCEL_CANDIDATE_SQL (la SQL real se prueba contra Postgres aparte) y la sentencia atómica «reabrir + evento».
const DAY = 24 * 3600 * 1000;
function fakeRun(state) {
    const calls = [];
    const run = async (text, params) => {
        const q = norm(text); calls.push({ q, params });
        if (/^WITH reopened AS \( UPDATE packages SET status = 'PROBLEMA', "updatedAt" = \$1 WHERE id = \$2 AND \(packages\.status = 'CANCELADO'/.test(q)) {
            const p = state.packages[params[1]]; if (!p) return R([]);
            const evs = state.events.filter(e => e.packageId === p.id);
            const ok = p.status === 'CANCELADO' && p.source === 'MERCADO_LIBRE' && !p.billed && (params[0].getTime() - new Date(p.updatedAt).getTime()) <= 14 * DAY
                && evs.some(e => e.status === 'PROBLEMA' && /cancel/i.test(e.details))
                && !evs.some(e => ['Cancelado', 'CANCELADO'].includes(e.status) || (e.status === 'COMENTARIO' && /^Reabierto:/.test(e.details)));
            if (!ok) return R([]);
            p.status = 'PROBLEMA'; p.updatedAt = params[0]; state.events.push({ packageId: p.id, status: 'COMENTARIO', location: 'Sistema', details: params[2] }); return R([{ ...p }]);
        }
        throw new Error('Consulta no prevista: ' + q.slice(0, 160));
    };
    return { run, calls };
}
const cancelledByDriver = (id, over = {}) => ({ id, status: 'CANCELADO', source: 'MERCADO_LIBRE', billed: false, updatedAt: new Date(Date.now() - 2 * DAY), ...over });
const state = (pkgs, events) => ({ packages: Object.fromEntries(pkgs.map(p => [p.id, p])), events: events || pkgs.flatMap(p => [{ packageId: p.id, status: 'PROBLEMA', details: 'Problema reportado: Cliente canceló el pedido' }]) });
t('C1 un CANCELADO puesto por un conductor cuyo envío ML sigue en camino se reabre como PROBLEMA, con su evento interno, en una sola sentencia', async () => {
    need('reviveIfOpenInMeli');
    const st = state([cancelledByDriver('P1')]); const { run, calls } = fakeRun(st);
    const row = await cancelled.reviveIfOpenInMeli(run, 'P1', { status: 'shipped', substatus: 'out_for_delivery' });
    assert.ok(row && row.status === 'PROBLEMA'); assert.strictEqual(st.packages.P1.status, 'PROBLEMA');
    assert.strictEqual(calls.length, 1, 'una sola sentencia (cambio de estado + evento juntos)');
    const ev = st.events.filter(e => e.status === 'COMENTARIO'); assert.strictEqual(ev.length, 1);
    assert.ok(/^Reabierto: /.test(ev[0].details) && /shipped\/out_for_delivery/.test(ev[0].details) && /no lo canceló/.test(ev[0].details), ev[0].details);
    assert.ok(/INSERT INTO tracking_events/.test(calls[0].q) && /'COMENTARIO'/.test(calls[0].q), 'el evento es interno (COMENTARIO), no se publica al comprador');
});
t('C2 cada estado vivo de ML reabre; los demás (entregado, cancelado, devuelto, desconocido) no tocan ni preguntan nada a la base', async () => {
    need('reviveIfOpenInMeli');
    for (const s of ['pending', 'handling', 'ready_to_ship', 'shipped']) { const st = state([cancelledByDriver('P1')]); assert.ok(await cancelled.reviveIfOpenInMeli(fakeRun(st).run, 'P1', { status: s }), s); }
    for (const ml of [{ status: 'delivered' }, { status: 'cancelled' }, { status: 'not_delivered', substatus: 'returned' }, { status: 'not_found' }, {}, null, undefined]) {
        const st = state([cancelledByDriver('P1')]); const { run, calls } = fakeRun(st);
        assert.strictEqual(await cancelled.reviveIfOpenInMeli(run, 'P1', ml), null, JSON.stringify(ml)); assert.strictEqual(calls.length, 0, 'ni siquiera consulta la base'); assert.strictEqual(st.packages.P1.status, 'CANCELADO');
    }
});
t('C3 NO reabre lo que no puso un conductor: cancelado por Mercado Libre (evento «Cancelado»), por el administrador (sin reporte del conductor), facturado, de otro origen o muy antiguo', async () => {
    need('reviveIfOpenInMeli');
    const casos = [
        ['ML lo canceló', state([cancelledByDriver('P1')], [{ packageId: 'P1', status: 'PROBLEMA', details: 'Problema reportado: Cliente canceló el pedido' }, { packageId: 'P1', status: 'Cancelado', details: 'El envío ha sido CANCELADO en Mercado Libre.' }])],
        ['el administrador lo canceló (no hay reporte del conductor)', state([cancelledByDriver('P1')], [{ packageId: 'P1', status: 'Creado', details: 'Auto-importado vía integración ML.' }])],
        ['el conductor reportó otra cosa', state([cancelledByDriver('P1')], [{ packageId: 'P1', status: 'PROBLEMA', details: 'Problema reportado: Destinatario ausente en domicilio' }])],
        ['facturado', state([cancelledByDriver('P1', { billed: true })])],
        ['no es de Mercado Libre', state([cancelledByDriver('P1', { source: 'MANUAL' })])],
        ['lleva más de 14 días', state([cancelledByDriver('P1', { updatedAt: new Date(Date.now() - 15 * DAY) })])],
        ['ya no está CANCELADO', state([cancelledByDriver('P1', { status: 'ENTREGADO' })])],
        ['no existe', state([])],
    ];
    for (const [por, st] of casos) { const before = JSON.stringify(st.packages); assert.strictEqual(await cancelled.reviveIfOpenInMeli(fakeRun(st).run, 'P1', { status: 'shipped' }), null, por); assert.strictEqual(JSON.stringify(st.packages), before, por + ': no se modifica'); assert.ok(!st.events.some(e => e.status === 'COMENTARIO'), por + ': sin evento'); }
});
t('C4 se reabre a lo más UNA vez: si el equipo lo vuelve a cancelar, no se deshace solo en bucle', async () => {
    need('reviveIfOpenInMeli');
    const st = state([cancelledByDriver('P1')]); const { run } = fakeRun(st);
    assert.ok(await cancelled.reviveIfOpenInMeli(run, 'P1', { status: 'shipped' }));
    st.packages.P1.status = 'CANCELADO';                      // el equipo (o un conductor) lo cancela de nuevo
    assert.strictEqual(await cancelled.reviveIfOpenInMeli(run, 'P1', { status: 'shipped' }), null);
    assert.strictEqual(st.packages.P1.status, 'CANCELADO');
});
t('C5 la condición SQL que usa el sondeo y la sentencia de reabrir es la MISMA, y exige todo lo anterior', () => {
    need('reviveIfOpenInMeli');
    const sql = cancelled.DRIVER_CANCEL_CANDIDATE_SQL;
    for (const frag of ["packages.status = 'CANCELADO'", "packages.source = 'MERCADO_LIBRE'", 'packages.billed IS NOT TRUE', `packages."updatedAt" >= now() - interval '14 days'`,
        `d.status = 'PROBLEMA' AND d.details ILIKE '%cancel%'`, `c.status IN ('Cancelado', 'CANCELADO')`, `c.status = 'COMENTARIO' AND c.details LIKE 'Reabierto:%'`, 'EXISTS', 'NOT EXISTS']) assert.ok(sql.includes(frag), 'falta: ' + frag);
    assert.ok(!/[;]|--/.test(sql), 'solo literales fijos');
});

// ───────────── D. la ruta real /problem ─────────────
let call; let server;
const report = (id, reason, extra = {}) => call('POST', `/packages/${id}/problem`, { reason, photosBase64: [png(1)], ...extra }, 'DRIVER', 'drv-1');
t('D1 un conductor reporta «Cliente canceló el pedido» en un paquete de Mercado Libre → queda PROBLEMA, con el motivo en el historial; no se cancela', async () => {
    add('ML-1');
    const r = await report('ML-1', 'Cliente canceló el pedido');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(S.packages['ML-1'].status, 'PROBLEMA'); assert.strictEqual(r.body.status, 'PROBLEMA');
    assert.deepStrictEqual(S.events.map(e => [e.status, e.details]), [['PROBLEMA', 'Problema reportado: Cliente canceló el pedido']]);
    assert.deepStrictEqual(S.notified, [['ML-1', 'PROBLEMA']]); assert.deepStrictEqual(S.admin, [['ML-1', 'PROBLEMA', 'Cliente canceló el pedido']]);
});
t('D2 el mismo reporte en un paquete manual o de una tienda sigue dejando CANCELADO', async () => {
    for (const src of ['MANUAL', 'SHOPIFY', 'FALABELLA']) { add('P-' + src, { source: src }); const r = await report('P-' + src, 'Cliente canceló el pedido'); assert.strictEqual(r.status, 200); assert.strictEqual(S.packages['P-' + src].status, 'CANCELADO', src); }
});
t('D3 «Cliente solicita reagendar entrega» sigue dando REPROGRAMADO, y el resto de motivos PROBLEMA, también en Mercado Libre', async () => {
    add('ML-1'); add('ML-2'); add('ML-3');
    assert.strictEqual((await report('ML-1', 'Cliente solicita reagendar entrega')).status, 200); assert.strictEqual(S.packages['ML-1'].status, 'REPROGRAMADO');
    assert.strictEqual((await report('ML-2', 'Destinatario ausente en domicilio')).status, 200); assert.strictEqual(S.packages['ML-2'].status, 'PROBLEMA');
    assert.strictEqual((await report('ML-3', 'Dirección de entrega incorrecta o incompleta')).status, 200); assert.strictEqual(S.packages['ML-3'].status, 'PROBLEMA');
});
t('D4 un paquete que no existe da 404 y uno sin motivo da error (como antes): no se crea ningún evento', async () => {
    assert.strictEqual((await report('NO-EXISTE', 'Cliente canceló el pedido')).status, 404);
    add('ML-1'); const r = await call('POST', '/packages/ML-1/problem', { photosBase64: [png(1)] }, 'DRIVER', 'drv-1');
    assert.strictEqual(r.status, 500); assert.strictEqual(S.packages['ML-1'].status, 'EN_TRANSITO'); assert.strictEqual(S.events.length, 0);
});
t('D5 fotos que no son imágenes se siguen rechazando (400) sin tocar el paquete', async () => {
    add('ML-1'); const r = await report('ML-1', 'Cliente canceló el pedido', { photosBase64: ['data:image/png;base64,AAAA'] });
    assert.strictEqual(r.status, 400); assert.strictEqual(S.packages['ML-1'].status, 'EN_TRANSITO');
});

// ───────────── ejecutar ─────────────
(async () => {
    const packagesRouter = require(path.join(ROOT, 'routes/packages.js'));
    const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/packages', packagesRouter);
    const log = console.log; const origErr = console.error;
    server = app.listen(0, '127.0.0.1'); await new Promise(r => server.on('listening', r));
    const port = server.address().port;
    const tok = (role, id) => jwt.sign({ user: { id, role, name: id } }, process.env.JWT_SECRET, { expiresIn: '5m' });
    call = async (method, p, body, role = 'ADMIN', id = 'adm-1') => {
        const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok(role, id) }, body: body ? JSON.stringify(body) : undefined });
        let json = null; try { json = await r.json(); } catch (e) { /* sin cuerpo */ }
        return { status: r.status, body: json };
    };
    let ok = 0; const fails = [];
    for (const [name, fn] of tests) {
        reset(); console.error = () => {}; console.warn = () => {};
        try { await fn(); ok++; log('OK    ' + name); } catch (e) { fails.push(name); log('FALLA ' + name + '\n      ' + String(e.message).split('\n').slice(0, 3).join('\n      ') + (S.unknown.length ? '\n      consultas no previstas: ' + S.unknown.join(' | ') : '')); }
        finally { console.error = origErr; }
    }
    log(`\n${ok} de ${tests.length} pruebas OK`);
    server.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(2); });
