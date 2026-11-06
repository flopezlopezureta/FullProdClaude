/**
 * Prueba del CAMBIO DE ESTADO DE UN PAQUETE CERRADO (entregado, devuelto o cancelado), que solo hace un administrador reingresando su propia clave.
 *   A. reglas sueltas (services/closedStatusChange.js)          B. la ruta real POST /api/packages/:id/change-closed-status y las dos rutas que ya no la esquivan
 *   C. la regla de la pantalla (utils/closedStatusChange.ts) da lo mismo que la del servidor
 * Todo contra una base FALSA en memoria (cada consulta se interpreta a mano; una no prevista hace fallar la prueba). Nombres, claves y paquetes son inventados.
 *
 * Uso:   node tests/closedStatusChange.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/closedStatusChange.test.js
 *        (otra copia = el código ANTERIOR, para comprobar que la prueba detecta el defecto, o el clon de Staging/Producción antes de subir)
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
const bcrypt = load('bcryptjs');
const esbuild = load('esbuild');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';
const PASSWORD = 'Clave-Admin-De-Prueba-1';
const HASH = bcrypt.hashSync(PASSWORD, 4);

// ───────────── base falsa ─────────────
let S;
const reset = () => { S = { packages: {}, events: [], logs: [], users: {}, tx: [], unknown: [], raceOnce: false, putUpdates: 0 }; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const R = (rows) => ({ rows, rowCount: rows.length });
const mkPkg = (id, over = {}) => ({ id, status: 'CANCELADO', driverId: 'bodega-1', assignedAt: new Date('2026-11-05T17:23:20Z'), creatorId: 'c1', source: 'MERCADO_LIBRE', billed: false, isReassigned: true, recipientAddress: 'Calle Falsa 123', deliveryPhotosBase64: '["foto-pesada"]', flexLabelPhotoBase64: null, falabellaDirectLabelPhotoBase64: null, meliFlexCode: '48386908388', updatedAt: new Date('2026-11-05T17:00:00Z'), ...over });
const add = (id, over) => (S.packages[id] = mkPkg(id, over));
const mkUser = (id, over = {}) => (S.users[id] = { id, name: `Admin ${id}`, role: 'ADMIN', status: 'APROBADO', password: HASH, ...over });
const CLOSED = ['ENTREGADO', 'DEVUELTO', 'CANCELADO'];
async function run(text, params = []) {
    const q = norm(text); let m;
    if (/^INSERT INTO system_logs/.test(q)) { S.logs.push({ userId: params[0], action: params[2], details: params[3] }); return R([]); }
    if (q === 'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, $5)') { S.events.push({ packageId: params[0], status: params[1], location: params[2], details: params[3], timestamp: params[4] }); return R([]); }
    if (q === 'INSERT INTO tracking_events ("packageId", status, location, details, timestamp) VALUES ($1, $2, $3, $4, NOW())') { S.events.push({ packageId: params[0], status: params[1], location: params[2], details: params[3], timestamp: new Date() }); return R([]); }
    if (q === 'SELECT * FROM tracking_events WHERE "packageId" = $1 ORDER BY timestamp DESC') return R(S.events.filter(e => e.packageId === params[0]).reverse());
    if (q === 'SELECT password, name, status FROM users WHERE id = $1') { const u = S.users[params[0]]; return R(u ? [{ password: u.password, name: u.name, status: u.status }] : []); }
    if (q === 'SELECT name FROM users WHERE id = $1') { const u = S.users[params[0]]; return R(u ? [{ name: u.name }] : []); }
    if (q === 'SELECT id, status, source, billed, "driverId" FROM packages WHERE id = $1 FOR UPDATE') { const p = S.packages[params[0]]; return R(p ? [{ id: p.id, status: p.status, source: p.source, billed: p.billed, driverId: p.driverId }] : []); }
    if ((m = q.match(/^UPDATE packages SET status = \$1, "driverId" = NULL, "assignedAt" = NULL, "updatedAt" = \$2 WHERE id = \$3 AND status = \$4 RETURNING \*$/))) {
        const p = S.packages[params[2]]; if (S.raceOnce || !p || p.status !== params[3]) return R([]);
        Object.assign(p, { status: params[0], driverId: null, assignedAt: null, updatedAt: params[1] }); return R([{ ...p }]);
    }
    if (q === 'UPDATE packages SET status = $1, "updatedAt" = $2 WHERE id = $3 AND status = $4 RETURNING *') {
        const p = S.packages[params[2]]; if (S.raceOnce || !p || p.status !== params[3]) return R([]);
        Object.assign(p, { status: params[0], updatedAt: params[1] }); return R([{ ...p }]);
    }
    // ruta genérica de edición (PUT /:id)
    if (q === 'SELECT "recipientAddress", "recipientCommune", "recipientCity", status FROM packages WHERE id = $1') { const p = S.packages[params[0]]; return R(p ? [{ recipientAddress: p.recipientAddress, recipientCommune: 'X', recipientCity: 'Y', status: p.status }] : []); }
    if ((m = q.match(/^UPDATE packages SET (.+) WHERE id = \$(\d+)$/))) {
        const cols = m[1].split(',').map(c => c.trim().match(/^"([^"]+)" = \$\d+$/)[1]); const p = S.packages[params[params.length - 1]]; if (!p) return { rows: [], rowCount: 0 };
        cols.forEach((c, i) => { p[c] = params[i]; }); S.putUpdates++; return { rows: [], rowCount: 1 };
    }
    if (q === 'SELECT * FROM packages WHERE id = $1') { const p = S.packages[params[0]]; return R(p ? [{ ...p }] : []); }
    // actualización masiva de estado
    if ((m = q.match(/^UPDATE packages SET status = \$1, billed = \$2, "updatedAt" = NOW\(\)( , "assignedAt" = NOW\(\))? WHERE id IN \((.+)\) AND \(status NOT IN \('ENTREGADO', 'DEVUELTO', 'CANCELADO'\) OR status = \$1\) RETURNING id$/))) {
        const out = []; for (const id of params.slice(2)) { const p = S.packages[id]; if (p && (!CLOSED.includes(p.status) || p.status === params[0])) { Object.assign(p, { status: params[0], billed: params[1] }); out.push({ id }); } } return R(out);
    }
    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 220));
}
const makeClient = () => {
    let snap = null;
    return {
        async query(text, params) {
            const q = norm(text);
            if (q === 'BEGIN') { snap = JSON.parse(JSON.stringify({ packages: S.packages, events: S.events })); S.tx.push('BEGIN'); return R([]); }
            if (q === 'COMMIT') { snap = null; S.tx.push('COMMIT'); return R([]); }
            if (q === 'ROLLBACK') { if (snap) { S.packages = snap.packages; S.events = snap.events; } snap = null; S.tx.push('ROLLBACK'); return R([]); }
            return run(text, params);
        },
        release() { S.tx.push('RELEASE'); },
    };
};
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('db.js', { query: (t, p) => run(t, p), getClient: async () => makeClient() });
stub('services/notificationService.js', { notifyRecipient: () => Promise.resolve(), notifyRecipientsBulk: () => Promise.resolve(), notifyAdminPendingDelivery: () => Promise.resolve() });
stub('services/meliPollingService.js', { optimizedJITDiscovery: async () => null, getValidMeliToken: async () => 'TOKEN-1' });
stub('services/jumpsellerPollingService.js', {});
stub('services/geocodingService.js', { geocodeAddress: async () => null, triggerBackgroundGeocoding: () => {} });
stub('services/gisService.js', { getSectorForCoordinates: () => 'Sector de prueba', reloadSectors: async () => {} });
stub('services/timeService.js', { getLogicalDate: async (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10), getSystemTimezone: async () => 'America/Santiago', getLogicalRange: async () => ({ start: new Date(), nextDayStart: new Date() }) });
stub('services/falabellaDirectService.js', { getOrderByLpn: async () => { throw new Error('no debe llamarse'); }, pushStatusUpdate: async () => {} });
stub('services/driverEvents.js', { emitDriverEvent: () => {}, bus: new (require('events'))() });

const tests = []; const t = (name, fn) => tests.push([name, fn]);
// En el código anterior (HARNESS_ROOT) este módulo no existe: las pruebas que lo usan fallan por eso, que es justo lo que debe verse.
let rules = null; try { rules = require(path.join(ROOT, 'services/closedStatusChange.js')); } catch (e) { /* código anterior */ }
const need = () => assert.ok(rules, 'no existe services/closedStatusChange.js');

// ───────────── A. reglas sueltas ─────────────
t('A1 cerrado = entregado, devuelto o cancelado; desde uno cerrado se puede reabrir (disponible en bodega) o corregir a otro cierre, nunca «asignado» ni «en tránsito»', () => {
    need();
    for (const s of CLOSED) assert.ok(rules.isClosedStatus(s), s);
    for (const s of ['PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO', 'RETRASADO', 'PROBLEMA', 'PENDIENTE_DEVOLUCION', 'REPROGRAMADO', '', null, undefined]) { assert.ok(!rules.isClosedStatus(s), String(s)); assert.deepStrictEqual(rules.allowedTargets(s), [], String(s)); }
    for (const s of CLOSED) {
        const targets = rules.allowedTargets(s);
        assert.ok(targets.includes('RETIRADO') && !targets.includes(s), s);
        for (const bad of ['ASIGNADO', 'EN_TRANSITO', 'PENDIENTE', 'RETRASADO', 'REPROGRAMADO', 'PENDIENTE_DEVOLUCION']) assert.ok(!targets.includes(bad), `${s} → ${bad}`);
    }
    assert.deepStrictEqual(rules.allowedTargets('CANCELADO'), ['RETIRADO', 'PROBLEMA', 'ENTREGADO', 'DEVUELTO']);
});
t('A2 checkChange: solo cambia un cerrado, a un estado permitido, y no uno de Falabella Directo ni uno ya facturado (cada rechazo con su código)', () => {
    need();
    assert.deepStrictEqual(rules.checkChange({ status: 'CANCELADO', source: 'MERCADO_LIBRE', billed: false }, 'RETIRADO'), { ok: true });
    assert.deepStrictEqual(rules.checkChange({ status: 'ENTREGADO' }, 'PROBLEMA'), { ok: true });
    const code = (pkg, target) => rules.checkChange(pkg, target).code;
    assert.strictEqual(code({ status: 'EN_TRANSITO' }, 'RETIRADO'), 'NOT_CLOSED');
    assert.strictEqual(code({ status: 'PROBLEMA' }, 'RETIRADO'), 'NOT_CLOSED');
    assert.strictEqual(code({ status: 'CANCELADO' }, 'CANCELADO'), 'TARGET_NOT_ALLOWED');
    assert.strictEqual(code({ status: 'CANCELADO' }, 'EN_TRANSITO'), 'TARGET_NOT_ALLOWED');
    assert.strictEqual(code({ status: 'CANCELADO' }, 'ASIGNADO'), 'TARGET_NOT_ALLOWED');
    assert.strictEqual(code({ status: 'CANCELADO' }, 'cualquier cosa'), 'TARGET_NOT_ALLOWED');
    assert.strictEqual(code({ status: 'ENTREGADO', source: 'FALABELLA_DIRECTO' }, 'RETIRADO'), 'EXTERNAL_FLOW');
    assert.strictEqual(code({ status: 'ENTREGADO', billed: true }, 'RETIRADO'), 'BILLED');
    assert.strictEqual(rules.checkChange({ status: 'ENTREGADO', billed: true }, 'RETIRADO').httpStatus, 409);
    assert.strictEqual(rules.checkChange(null, 'RETIRADO').code, 'NOT_CLOSED');
});
t('A3 el motivo es obligatorio, con letras de verdad y no excesivo', () => {
    need();
    for (const bad of ['', '   ', null, undefined, 'ok', '....', '12345678', 'a b c d', '!!!!!!!!!!']) assert.strictEqual(rules.checkReason(bad).ok, false, JSON.stringify(bad));
    const good = rules.checkReason('   el conductor   lo canceló por error  ');
    assert.deepStrictEqual([good.ok, good.reason], [true, 'el conductor lo canceló por error']);
    assert.strictEqual(rules.checkReason('x'.repeat(rules.MAX_REASON_LENGTH + 1)).ok, false);
    assert.strictEqual(rules.checkReason('ñ'.repeat(rules.MIN_REASON_LETTERS)).ok, true, 'las letras con tilde o ñ cuentan');
});
t('A4 reabrir quita el conductor y la asignación; corregir a otro cierre los conserva', () => {
    need();
    assert.deepStrictEqual(rules.updateFor('RETIRADO'), { status: 'RETIRADO', clearsDriver: true });
    for (const s of ['PROBLEMA', 'ENTREGADO', 'DEVUELTO', 'CANCELADO']) assert.deepStrictEqual(rules.updateFor(s), { status: s, clearsDriver: false });
});
t('A5 el texto del historial dice quién autorizó con su clave, de qué a qué estado, el motivo y, al reabrir, que se quitó el conductor', () => {
    need();
    const d = rules.eventDetails({ from: 'CANCELADO', to: 'RETIRADO', adminName: 'Ana Admin', reason: 'lo canceló por error', clearedDriverName: 'Bodega' });
    for (const piece of ['Ana Admin', 'con su clave de administrador', 'Cancelado → Disponible en bodega', 'Motivo: lo canceló por error.', 'Se quitó el conductor (Bodega).', 'Queda disponible en bodega']) assert.ok(d.includes(piece), piece + ' :: ' + d);
    const other = rules.eventDetails({ from: 'ENTREGADO', to: 'PROBLEMA', adminName: 'Ana Admin', reason: 'se marcó sin entregar' });
    assert.ok(!/Se quitó el conductor|Queda disponible/.test(other), other);
});
t('A6 el límite de intentos bloquea tras 5 claves incorrectas, se levanta al pasar la ventana y se reinicia con una clave buena; cada administrador va aparte', () => {
    need();
    let now = 1_000_000; const lim = rules.createAttemptLimiter({ max: 5, windowMs: 900_000, now: () => now });
    for (let i = 0; i < 4; i++) { lim.fail('a'); assert.strictEqual(lim.check('a').locked, false, 'intento ' + (i + 1)); }
    lim.fail('a'); const lock = lim.check('a'); assert.strictEqual(lock.locked, true); assert.ok(lock.retryAfterSec > 0 && lock.retryAfterSec <= 900, String(lock.retryAfterSec));
    assert.strictEqual(lim.check('b').locked, false);
    now += 899_000; assert.strictEqual(lim.check('a').locked, true); now += 2_000; assert.strictEqual(lim.check('a').locked, false, 'pasada la ventana se levanta');
    for (let i = 0; i < 4; i++) lim.fail('c'); lim.reset('c'); lim.fail('c'); assert.strictEqual(lim.check('c').locked, false, 'reset tras una clave buena');
});
t('A7 los textos usan «tú» (no voseo) y piden la contraseña de administrador', () => {
    need();
    const all = Object.values(rules.MESSAGES).map(v => (typeof v === 'function' ? v(1) : v)).join(' ');
    assert.ok(!/\b(tenés|podés|ingresá|escribí|elegí|esperá|usá)\b/i.test(all), all);
    assert.ok(/contraseña de administrador/.test(rules.MESSAGES.needPassword) && /contraseña de administrador/.test(rules.MESSAGES.closedNeedsAuth));
});

// ───────────── B. rutas reales ─────────────
let call; let server;
const change = (id, body, role = 'ADMIN', uid = 'adm-1') => call('POST', `/packages/${id}/change-closed-status`, body, role, uid);
const good = (over = {}) => ({ status: 'RETIRADO', reason: 'el conductor lo canceló por error', adminPassword: PASSWORD, ...over });
const events = (id) => S.events.filter(e => e.packageId === id);
const logsOf = (action) => S.logs.filter(l => l.action === action);

t('B1 quien no es administrador no puede (403) aunque sepa una clave: el paquete no cambia', async () => {
    mkUser('drv-1', { role: 'DRIVER' }); mkUser('cli-1', { role: 'CLIENT' }); mkUser('op-1', { role: 'OPERADOR_SISTEMAS' }); add('P1');
    for (const [role, uid] of [['DRIVER', 'drv-1'], ['CLIENT', 'cli-1'], ['OPERADOR_SISTEMAS', 'op-1']]) {
        const r = await change('P1', good(), role, uid); assert.strictEqual(r.status, 403, role); assert.strictEqual(r.body.code, 'NOT_ADMIN');
    }
    assert.strictEqual(S.packages.P1.status, 'CANCELADO'); assert.strictEqual(S.events.length, 0); assert.strictEqual(logsOf('CHANGE_CLOSED_STATUS').length, 0);
});
t('B2 sin contraseña → 400; con contraseña incorrecta → 403 (nunca 401: eso cerraría su sesión), queda el intento en la auditoría y el paquete no cambia', async () => {
    mkUser('adm-2'); add('P2');
    const none = await change('P2', good({ adminPassword: '' }), 'ADMIN', 'adm-2'); assert.strictEqual(none.status, 400); assert.strictEqual(none.body.code, 'PASSWORD_REQUIRED');
    const wrong = await change('P2', good({ adminPassword: 'otra-clave' }), 'ADMIN', 'adm-2'); assert.strictEqual(wrong.status, 403, JSON.stringify(wrong.body)); assert.strictEqual(wrong.body.code, 'BAD_PASSWORD');
    assert.strictEqual(S.packages.P2.status, 'CANCELADO'); assert.strictEqual(S.events.length, 0); assert.strictEqual(logsOf('CHANGE_CLOSED_STATUS_DENIED').length, 1);
});
t('B3 un administrador SIEMPRE debe dar su clave: ser ADMIN no la reemplaza', async () => {
    mkUser('adm-3'); add('P3');
    const r = await change('P3', good({ adminPassword: 'x'.repeat(12) }), 'ADMIN', 'adm-3'); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'BAD_PASSWORD'); assert.strictEqual(S.packages.P3.status, 'CANCELADO');
});
t('B4 tras 5 claves incorrectas se bloquea (429 con Retry-After) y ya ni la clave buena sirve hasta que pase la ventana', async () => {
    mkUser('adm-4'); add('P4');
    for (let i = 0; i < 5; i++) assert.strictEqual((await change('P4', good({ adminPassword: 'mala-' + i }), 'ADMIN', 'adm-4')).status, 403, 'intento ' + (i + 1));
    const locked = await change('P4', good(), 'ADMIN', 'adm-4'); assert.strictEqual(locked.status, 429, JSON.stringify(locked.body)); assert.strictEqual(locked.body.code, 'LOCKED');
    assert.strictEqual(S.packages.P4.status, 'CANCELADO'); assert.strictEqual(S.events.length, 0);
    mkUser('adm-4b'); assert.strictEqual((await change('P4', good(), 'ADMIN', 'adm-4b')).status, 200, 'otro administrador no se ve afectado');
});
t('B5 un perfil de administrador ELIMINADO o deshabilitado no autoriza, aunque su sesión siga abierta y sepa la clave', async () => {
    mkUser('adm-5', { status: 'ELIMINADO' }); mkUser('adm-5b', { status: 'DESHABILITADO' }); add('P5');
    for (const uid of ['adm-5', 'adm-5b']) { const r = await change('P5', good(), 'ADMIN', uid); assert.strictEqual(r.status, 403, uid); assert.strictEqual(r.body.code, 'INACTIVE_ADMIN'); }
    assert.strictEqual(S.packages.P5.status, 'CANCELADO'); assert.strictEqual(S.events.length, 0);
});
t('B6 reabrir un CANCELADO: queda RETIRADO sin conductor ni asignación, con el evento (quién, motivo, conductor quitado), la auditoría y la respuesta sin fotos pesadas', async () => {
    mkUser('adm-6', { name: 'Ana Admin' }); mkUser('bodega-1', { name: 'Bodega', role: 'DRIVER' }); add('P6');
    const r = await change('P6', good(), 'ADMIN', 'adm-6'); assert.strictEqual(r.status, 200, JSON.stringify(r.body) + S.unknown.join('|'));
    const p = S.packages.P6; assert.deepStrictEqual([p.status, p.driverId, p.assignedAt, p.isReassigned, p.billed], ['RETIRADO', null, null, true, false]);
    assert.strictEqual(r.body.status, 'RETIRADO'); assert.strictEqual(r.body.deliveryPhotosBase64, null, 'no devuelve fotos pesadas'); assert.ok(Array.isArray(r.body.history) && r.body.history.length === 1);
    const ev = events('P6'); assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0].status, 'RETIRADO');
    for (const piece of ['Ana Admin', 'Cancelado → Disponible en bodega', 'el conductor lo canceló por error', 'Se quitó el conductor (Bodega)']) assert.ok(ev[0].details.includes(piece), piece + ' :: ' + ev[0].details);
    const log = logsOf('CHANGE_CLOSED_STATUS'); assert.strictEqual(log.length, 1); assert.ok(/"from":"CANCELADO"/.test(log[0].details) && /"to":"RETIRADO"/.test(log[0].details), log[0].details);
    assert.deepStrictEqual(S.tx, ['BEGIN', 'COMMIT', 'RELEASE']);
});
t('B7 corregir un cierre por otro (ENTREGADO → PROBLEMA, CANCELADO → ENTREGADO, DEVUELTO → CANCELADO) conserva el conductor y la asignación', async () => {
    mkUser('adm-7');
    for (const [from, to] of [['ENTREGADO', 'PROBLEMA'], ['CANCELADO', 'ENTREGADO'], ['DEVUELTO', 'CANCELADO']]) {
        add('P7', { status: from, driverId: 'drv-9' }); const r = await change('P7', good({ status: to }), 'ADMIN', 'adm-7'); assert.strictEqual(r.status, 200, `${from}→${to} ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual([S.packages.P7.status, S.packages.P7.driverId], [to, 'drv-9'], `${from}→${to}`); assert.ok(S.packages.P7.assignedAt instanceof Date || typeof S.packages.P7.assignedAt === 'string', 'conserva assignedAt');
    }
});
t('B8 un paquete que no está cerrado se rechaza (400 NOT_CLOSED); un estado no permitido o igual al actual también (400 TARGET_NOT_ALLOWED)', async () => {
    mkUser('adm-8'); add('P8a', { status: 'EN_TRANSITO' }); add('P8b', { status: 'PROBLEMA' }); add('P8c', { status: 'CANCELADO' });
    for (const id of ['P8a', 'P8b']) { const r = await change(id, good(), 'ADMIN', 'adm-8'); assert.strictEqual(r.status, 400, id); assert.strictEqual(r.body.code, 'NOT_CLOSED'); }
    for (const to of ['ASIGNADO', 'EN_TRANSITO', 'PENDIENTE', 'CANCELADO', 'NO_EXISTE']) { const r = await change('P8c', good({ status: to }), 'ADMIN', 'adm-8'); assert.strictEqual(r.status, 400, to); assert.strictEqual(r.body.code, 'TARGET_NOT_ALLOWED', to); }
    assert.strictEqual(S.events.length, 0);
});
t('B9 un paquete de Falabella Directo y uno ya facturado no se pueden cambiar (409) y no cambian', async () => {
    mkUser('adm-9'); add('P9a', { source: 'FALABELLA_DIRECTO', status: 'ENTREGADO' }); add('P9b', { billed: true, status: 'ENTREGADO' });
    assert.strictEqual((await change('P9a', good(), 'ADMIN', 'adm-9')).body.code, 'EXTERNAL_FLOW'); assert.strictEqual((await change('P9b', good(), 'ADMIN', 'adm-9')).body.code, 'BILLED');
    assert.deepStrictEqual([S.packages.P9a.status, S.packages.P9b.status], ['ENTREGADO', 'ENTREGADO']); assert.strictEqual(S.events.length, 0); assert.ok(S.tx.includes('ROLLBACK'));
});
t('B10 sin motivo, con un motivo vacío de letras o sin estado → 400 y la clave ni se mira (no se cuenta como intento)', async () => {
    mkUser('adm-10'); add('P10');
    for (const body of [good({ reason: '' }), good({ reason: '....' }), good({ reason: 'ok' }), good({ status: '' }), { reason: 'el conductor lo canceló', adminPassword: PASSWORD }]) assert.strictEqual((await change('P10', body, 'ADMIN', 'adm-10')).status, 400, JSON.stringify(body));
    for (let i = 0; i < 6; i++) await change('P10', good({ reason: 'x' }), 'ADMIN', 'adm-10');
    assert.strictEqual((await change('P10', good(), 'ADMIN', 'adm-10')).status, 200, 'los 400 por datos incompletos no bloquean al administrador');
});
t('B11 si el paquete cambia de estado justo mientras se procesa → 409 y no queda ni el cambio ni el evento (la transacción se revierte)', async () => {
    mkUser('adm-11'); add('P11'); S.raceOnce = true;
    const r = await change('P11', good(), 'ADMIN', 'adm-11'); assert.strictEqual(r.status, 409, JSON.stringify(r.body)); assert.strictEqual(r.body.code, 'CHANGED');
    assert.strictEqual(S.packages.P11.status, 'CANCELADO'); assert.strictEqual(S.events.length, 0); assert.deepStrictEqual(S.tx, ['BEGIN', 'ROLLBACK', 'RELEASE']);
});
t('B12 un paquete que no existe → 404', async () => {
    mkUser('adm-12'); const r = await change('NO-EXISTE', good(), 'ADMIN', 'adm-12'); assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'NOT_FOUND');
});
t('B13 la edición genérica (PUT) ya no cambia el estado de un paquete cerrado, pero sí deja pasar el mismo estado y los cambios de uno abierto', async () => {
    mkUser('adm-13'); add('P13a', { status: 'ENTREGADO' }); add('P13b', { status: 'EN_TRANSITO' });
    const blocked = await call('PUT', '/packages/P13a', { status: 'EN_TRANSITO' }, 'ADMIN', 'adm-13'); assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.body)); assert.strictEqual(blocked.body.code, 'CLOSED_REQUIRES_AUTH');
    assert.strictEqual(S.packages.P13a.status, 'ENTREGADO'); assert.strictEqual(S.putUpdates, 0);
    for (const role of ['CLIENT', 'DRIVER']) { const r = await call('PUT', '/packages/P13a', { status: 'RETIRADO' }, role, 'x-' + role); assert.strictEqual(r.status, 403, role); }
    const same = await call('PUT', '/packages/P13a', { status: 'ENTREGADO', notes: 'nota' }, 'ADMIN', 'adm-13'); assert.strictEqual(same.status, 200, JSON.stringify(same.body)); assert.strictEqual(S.packages.P13a.notes, 'nota');
    const open = await call('PUT', '/packages/P13b', { status: 'PROBLEMA' }, 'ADMIN', 'adm-13'); assert.strictEqual(open.status, 200, JSON.stringify(open.body)); assert.strictEqual(S.packages.P13b.status, 'PROBLEMA');
});
t('B14 «marcar como entregados» en masa no pasa un cerrado a OTRO estado, sí repite el mismo y cambia los abiertos; avisa cuántos dejó sin tocar', async () => {
    mkUser('adm-14'); add('Pa', { status: 'EN_TRANSITO' }); add('Pb', { status: 'CANCELADO' }); add('Pc', { status: 'ENTREGADO', billed: false }); add('Pd', { status: 'DEVUELTO' });
    const r = await call('POST', '/packages/bulk-update-status', { packageIds: ['Pa', 'Pb', 'Pc', 'Pd', 'NoExiste'], status: 'ENTREGADO' }, 'ADMIN', 'adm-14');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body) + S.unknown.join('|'));
    assert.deepStrictEqual([S.packages.Pa.status, S.packages.Pb.status, S.packages.Pc.status, S.packages.Pd.status], ['ENTREGADO', 'CANCELADO', 'ENTREGADO', 'DEVUELTO']);
    assert.strictEqual(S.packages.Pc.billed, true, 'repetir ENTREGADO sigue marcando como facturado');
    assert.deepStrictEqual([r.body.updated, r.body.skippedClosed], [2, 3]); assert.ok(/Cambiar estado/.test(r.body.message), r.body.message);
    assert.deepStrictEqual(S.events.map(e => e.packageId).sort(), ['Pa', 'Pc']);
});

t('B15 ningún rechazo de este endpoint es 401 (el cliente cierra la sesión ante un 401): clave mala, sin permiso, perfil inactivo y bloqueo usan otros códigos', async () => {
    mkUser('adm-15'); mkUser('drv-15', { role: 'DRIVER' }); mkUser('adm-15b', { status: 'ELIMINADO' }); add('P15');
    const answers = [await change('P15', good({ adminPassword: 'mala' }), 'ADMIN', 'adm-15'), await change('P15', good(), 'DRIVER', 'drv-15'), await change('P15', good(), 'ADMIN', 'adm-15b'), await change('P15', good({ reason: '' }), 'ADMIN', 'adm-15'), await change('NO-EXISTE', good(), 'ADMIN', 'adm-15')];
    for (const a of answers) assert.notStrictEqual(a.status, 401, JSON.stringify(a.body));
    for (let i = 0; i < 5; i++) await change('P15', good({ adminPassword: 'mala-' + i }), 'ADMIN', 'adm-15'); assert.strictEqual((await change('P15', good(), 'ADMIN', 'adm-15')).status, 429);
});

// ───────────── C. la pantalla da lo mismo ─────────────
t('C1 utils/closedStatusChange.ts da lo mismo que el servidor: estados, etiquetas, bloqueos y motivo', () => {
    need();
    const src = fs.readFileSync(path.join(ROOT, 'utils/closedStatusChange.ts'), 'utf8');
    const m = { exports: {} }; new Function('module', 'exports', esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code)(m, m.exports); const ui = m.exports;
    assert.deepStrictEqual([...ui.CLOSED_STATUSES], [...rules.CLOSED_STATUSES]); assert.deepStrictEqual([...ui.TARGET_STATUSES], [...rules.TARGET_STATUSES]);
    assert.deepStrictEqual(ui.STATUS_LABELS, rules.STATUS_LABELS); assert.strictEqual(ui.REOPEN_STATUS, rules.REOPEN_STATUS);
    assert.deepStrictEqual([ui.MIN_REASON_LETTERS, ui.MAX_REASON_LENGTH], [rules.MIN_REASON_LETTERS, rules.MAX_REASON_LENGTH]);
    for (const s of ['PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO', 'ENTREGADO', 'RETRASADO', 'PROBLEMA', 'PENDIENTE_DEVOLUCION', 'DEVUELTO', 'CANCELADO', 'REPROGRAMADO', '', null]) {
        assert.strictEqual(ui.isClosedStatus(s), rules.isClosedStatus(s), String(s)); assert.deepStrictEqual(ui.allowedTargets(s), rules.allowedTargets(s), String(s));
    }
    for (const pkg of [null, {}, { source: 'FALABELLA_DIRECTO' }, { billed: true }, { source: 'MERCADO_LIBRE', billed: false }, { source: 'FALABELLA_DIRECTO', billed: true }]) {
        const server = rules.changeBlocker(pkg); assert.strictEqual(ui.changeBlocker(pkg), server ? server.message : null, JSON.stringify(pkg));
    }
    for (const reason of ['', 'ok', '....', 'el conductor lo canceló por error', 'x'.repeat(301), '  ñandú  ', null]) {
        const server = rules.checkReason(reason); assert.strictEqual(ui.reasonProblem(reason), server.ok ? null : server.message, JSON.stringify(reason));
    }
    for (const s of rules.TARGET_STATUSES) assert.ok(ui.TARGET_HINTS[s], 'falta la frase de ' + s);
});

// ───────────── ejecutar ─────────────
(async () => {
    const packagesRouter = require(path.join(ROOT, 'routes/packages.js'));
    const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/packages', packagesRouter);
    const log = console.log; console.error = () => {}; console.warn = () => {};
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
        reset();
        console.log = () => {};
        try { await fn(); ok++; log('OK    ' + name); } catch (e) { fails.push(name); log('FALLA ' + name + '\n      ' + String(e.message).split('\n').slice(0, 3).join('\n      ') + (S.unknown.length ? '\n      consultas no previstas: ' + S.unknown.join(' | ') : '')); }
    }
    console.log = log;
    log(`\n${ok} de ${tests.length} pruebas OK`);
    server.close(); process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(2); });
