/**
 * Prueba del «Rendimiento por Conductor» del panel: el filtro por fecha de CIERRE de GET /api/packages (dateType=closed, services/packageDateFilters.js).
 * El problema que corrige: para un administrador el servidor filtraba por fecha de CREACIÓN, así que el panel perdía las entregas de paquetes creados antes del
 * rango (hasta la mitad de las de un solo día) mientras el teléfono del conductor mostraba el número correcto.
 *   A. el rango de días de calendario (sin base)
 *   B. el SQL REAL contra un Postgres de verdad en memoria (PGlite): casos de borde y una simulación al azar donde el panel NUNCA pierde una entrega
 *   C. la ruta HTTP real: el panel pide por cierre; lo demás (otras pantallas, rama del conductor, clientes) no cambia
 *   D. guardas del código de la pantalla: solo el panel manda dateType=closed, el teléfono no
 * Los datos son inventados; no toca ninguna red ni la base real.
 *
 * Uso:   node tests/driverReportRange.test.js
 *        B necesita @electric-sql/pglite (no va en el proyecto, solo se usa para probar):
 *            npm i --no-save @electric-sql/pglite     o     PGLITE_DIR=<carpeta donde está instalado> node tests/driverReportRange.test.js
 *        Si no está, B se OMITE a viva voz (no cuenta como aprobada).
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/driverReportRange.test.js   (el código ANTERIOR debe FALLAR; Staging/Producción antes de subir)
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

let pdf = null;
try { pdf = require(path.join(ROOT, 'services/packageDateFilters.js')); } catch (e) { /* el código anterior no lo tiene: las pruebas fallan con un mensaje claro */ }
const need = () => { if (!pdf) throw new Error(`no existe services/packageDateFilters.js en ${ROOT}`); };

let PGlite = null;
try { PGlite = require(require.resolve('@electric-sql/pglite', { paths: [ROOT, process.env.PGLITE_DIR, __dirname].filter(Boolean) })).PGlite; } catch (e) { /* se omite B */ }

const tests = [];
const t = (name, fn, opts = {}) => tests.push({ name, fn, needsPg: !!opts.needsPg });
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// ═════════════ A. rango de días de calendario ═════════════
t('A1 el rango va de las 00:00 del primer día a las 00:00 del día siguiente al último (mes, año y bisiesto)', () => {
    need();
    assert.deepStrictEqual(pdf.calendarRange('2026-11-01', '2026-11-10'), { start: '2026-11-01 00:00:00', nextDayStart: '2026-11-11 00:00:00' });
    assert.deepStrictEqual(pdf.calendarRange('2026-11-09', '2026-11-09'), { start: '2026-11-09 00:00:00', nextDayStart: '2026-11-10 00:00:00' }, 'un solo día');
    assert.strictEqual(pdf.calendarRange('2026-10-01', '2026-10-31').nextDayStart, '2026-11-01 00:00:00', 'fin de mes');
    assert.strictEqual(pdf.calendarRange('2026-12-01', '2026-12-31').nextDayStart, '2027-01-01 00:00:00', 'fin de año');
    assert.strictEqual(pdf.calendarRange('2028-02-01', '2028-02-28').nextDayStart, '2028-02-29 00:00:00', 'año bisiesto: el 29 existe');
    assert.strictEqual(pdf.calendarRange('2028-02-01', '2028-02-29').nextDayStart, '2028-03-01 00:00:00');
    assert.strictEqual(pdf.calendarRange('2027-02-01', '2027-02-28').nextDayStart, '2027-03-01 00:00:00', 'año no bisiesto');
});
t('A2 un rango mal escrito falla claro (no se arma una consulta rara)', () => {
    need();
    for (const bad of ['', 'abc', '2026-11-1', '11/10/2026', null, undefined, '2026-11-10 02:00:00']) assert.throws(() => pdf.calendarRange(bad, '2026-11-10'), /Rango de fechas inválido/, String(bad));
    assert.throws(() => pdf.calendarRange('2026-11-01', 'hoy'), /Rango de fechas inválido/);
});
t('A3 la condición usa los estados de cierre y los dos parámetros pedidos', () => {
    need();
    assert.deepStrictEqual(pdf.CLOSING_EVENT_STATUSES, ['ENTREGADO', 'PROBLEMA', 'DEVUELTO']);
    const sql = norm(pdf.closedInRangeClause(7, 8));
    assert.match(sql, /p\.id IN \(SELECT "packageId" FROM tracking_events WHERE status IN \('ENTREGADO', 'PROBLEMA', 'DEVUELTO'\) AND timestamp >= \$7 AND timestamp < \$8\)/);
    assert.match(sql, /p\."updatedAt" >= \$7 AND p\."updatedAt" < \$8 AND NOT EXISTS \(SELECT 1 FROM tracking_events te WHERE te\."packageId" = p\.id AND te\.status IN \('ENTREGADO', 'PROBLEMA', 'DEVUELTO'\)\)/);
});

// ═════════════ B. el SQL real (PGlite) ═════════════
const SCHEMA = `
    CREATE TABLE packages (id TEXT PRIMARY KEY, "driverId" TEXT, status TEXT, "createdAt" TIMESTAMPTZ, "updatedAt" TIMESTAMPTZ, "assignedAt" TIMESTAMPTZ, "estimatedDelivery" TIMESTAMPTZ);
    CREATE TABLE tracking_events (id SERIAL PRIMARY KEY, "packageId" TEXT, status TEXT, "timestamp" TIMESTAMPTZ, details TEXT);`;
let pg;
const resetDb = async () => { await pg.exec('DELETE FROM tracking_events; DELETE FROM packages;'); };
const P = async (id, { driver = 'D1', status = 'ENTREGADO', created, updated, assigned = null, est = undefined, events = [] }) => {
    await pg.query(`INSERT INTO packages (id, "driverId", status, "createdAt", "updatedAt", "assignedAt", "estimatedDelivery") VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, driver, status, created, updated || created, assigned, est === undefined ? created : est]);
    for (const [st, ts] of events) await pg.query('INSERT INTO tracking_events ("packageId", status, "timestamp", details) VALUES ($1,$2,$3,$4)', [id, st, ts, 'x']);
};
const STATUSES = `('ENTREGADO','PROBLEMA','DEVUELTO')`;
// lo que el servidor devuelve al panel con dateType=closed
const serverClosed = async (driver, startDate, endDate) => {
    const { start, nextDayStart } = pdf.calendarRange(startDate, endDate);
    return (await pg.query(`SELECT p.id FROM packages p WHERE p.status IN ${STATUSES} AND p."driverId" = $1 AND ${pdf.closedInRangeClause(2, 3)} ORDER BY p.id`, [driver, start, nextDayStart])).rows.map((r) => r.id);
};
// el filtro que el servidor aplicaba ANTES a un administrador (rama final de buildPackageQuery: creado o entrega estimada dentro del rango LÓGICO, de 02:00 a 02:00)
const serverLegacyAdmin = async (driver, startDate, endDate) => {
    const start = `${startDate} 02:00:00`; const next = new Date(`${endDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); const end = `${next.toISOString().slice(0, 10)} 02:00:00`;
    return (await pg.query(`SELECT p.id FROM packages p WHERE p.status IN ${STATUSES} AND p."driverId" = $1 AND (p."createdAt" >= $2 AND p."createdAt" < $3 OR p."estimatedDelivery" >= $2 AND p."estimatedDelivery" < $3) ORDER BY p.id`, [driver, start, end])).rows.map((r) => r.id);
};

t('B1 casos de borde: se incluye lo cerrado en el rango aunque se haya creado antes; se excluye lo de fuera, lo de otro conductor y lo que solo se «tocó»', async () => {
    need(); await resetDb();
    const Z = '-03:00';   // noviembre: Santiago está en UTC-3
    await P('P01', { created: `2026-10-31T16:00:00${Z}`, events: [['EN_TRANSITO', `2026-11-02T18:09:00${Z}`], ['ENTREGADO', `2026-11-02T19:11:00${Z}`]] });          // el caso del problema
    await P('P02', { created: `2026-11-03T08:00:00${Z}`, events: [['ENTREGADO', `2026-11-03T12:00:00${Z}`]] });
    await P('P03', { created: `2026-10-30T09:00:00${Z}`, events: [['ENTREGADO', `2026-10-31T23:59:59${Z}`]] });                                                     // un segundo antes del rango
    await P('P04', { created: `2026-10-30T09:00:00${Z}`, events: [['ENTREGADO', `2026-11-01T00:00:00${Z}`]] });                                                     // justo a las 00:00: dentro
    await P('P05', { created: `2026-11-09T09:00:00${Z}`, events: [['ENTREGADO', `2026-11-10T23:59:59${Z}`]] });                                                     // último segundo del rango
    await P('P06', { created: `2026-11-09T09:00:00${Z}`, events: [['ENTREGADO', `2026-11-11T00:00:00${Z}`]] });                                                     // justo después: fuera
    await P('P07', { status: 'PROBLEMA', created: `2026-10-29T09:00:00${Z}`, events: [['PROBLEMA', `2026-11-05T10:00:00${Z}`]] });
    await P('P08', { status: 'DEVUELTO', created: `2026-10-29T09:00:00${Z}`, events: [['DEVUELTO', `2026-11-06T10:00:00${Z}`]] });
    await P('P09', { created: `2026-10-25T09:00:00${Z}`, updated: `2026-11-04T10:00:00${Z}`, events: [] });                                                          // sin evento de cierre: cuenta su actualización
    await P('P10', { created: `2026-10-25T09:00:00${Z}`, updated: `2026-10-26T10:00:00${Z}`, events: [] });                                                          // sin evento y actualizado antes: fuera
    await P('P11', { created: `2026-10-15T09:00:00${Z}`, updated: `2026-11-05T10:00:00${Z}`, events: [['ENTREGADO', `2026-10-20T10:00:00${Z}`]] });                // entregado en octubre y «tocado» en noviembre: fuera
    await P('P12', { driver: 'D2', created: `2026-11-02T09:00:00${Z}`, events: [['ENTREGADO', `2026-11-03T10:00:00${Z}`]] });                                        // otro conductor
    await P('P13', { created: `2026-10-28T09:00:00${Z}`, events: [['PROBLEMA', `2026-10-31T10:00:00${Z}`], ['ENTREGADO', `2026-11-02T10:00:00${Z}`]] });            // problema y luego entregado
    await P('P14', { created: `2026-11-02T09:00:00${Z}`, updated: `2026-11-12T09:00:00${Z}`, events: [['EN_TRANSITO', `2026-11-03T09:00:00${Z}`], ['CIERRE_OFICIAL_ML', `2026-11-03T09:30:00${Z}`], ['ENTREGADO', `2026-11-12T09:00:00${Z}`]] }); // eventos que no cierran en el rango
    assert.deepStrictEqual(await serverClosed('D1', '2026-11-01', '2026-11-10'), ['P01', 'P02', 'P04', 'P05', 'P07', 'P08', 'P09', 'P13']);
    assert.deepStrictEqual(await serverClosed('D2', '2026-11-01', '2026-11-10'), ['P12']);
    // el filtro de antes (por creación) perdía justo los creados antes del rango: P01, P04, P07, P08, P09, P13
    const old = await serverLegacyAdmin('D1', '2026-11-01', '2026-11-10');
    for (const id of ['P01', 'P04', 'P07', 'P08', 'P13']) assert.ok(!old.includes(id), `el filtro anterior no debía devolver ${id}`);
}, { needsPg: true });

t('B2 un solo día: se incluyen las entregas de paquetes creados el día anterior (lo que el panel perdía casi a la mitad)', async () => {
    need(); await resetDb(); const Z = '-03:00';
    await P('A1', { created: `2026-11-08T15:00:00${Z}`, events: [['ENTREGADO', `2026-11-09T11:00:00${Z}`]] });
    await P('A2', { created: `2026-11-08T22:30:00${Z}`, events: [['ENTREGADO', `2026-11-09T16:00:00${Z}`]] });
    await P('A3', { created: `2026-11-09T08:00:00${Z}`, events: [['ENTREGADO', `2026-11-09T17:00:00${Z}`]] });
    await P('A4', { created: `2026-11-09T08:00:00${Z}`, events: [['ENTREGADO', `2026-11-10T10:00:00${Z}`]] });
    assert.deepStrictEqual(await serverClosed('D1', '2026-11-09', '2026-11-09'), ['A1', 'A2', 'A3']);
    assert.deepStrictEqual(await serverLegacyAdmin('D1', '2026-11-09', '2026-11-09'), ['A3', 'A4'], 'el filtro anterior mostraba lo creado ese día, no lo entregado');
}, { needsPg: true });

t('B3 simulación al azar (400 paquetes, 4 conductores, 6 rangos): lo que la pantalla deja al final es exactamente lo entregado en el rango; el servidor nunca le oculta uno', async () => {
    need(); await resetDb();
    let s = 20261111; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const base = Date.parse('2026-10-20T03:00:00Z'); const H = 3600000;
    const model = [];
    for (let i = 0; i < 400; i++) {
        const created = base + Math.floor(rnd() * 24 * 24 * H);                       // del 20-oct al 13-nov
        const events = []; let tt = created;
        const n = Math.floor(rnd() * 5);
        for (let k = 0; k < n; k++) { tt += Math.floor(rnd() * 70 * H); events.push([pick(['EN_TRANSITO', 'Asignado', 'ENTREGADO', 'PROBLEMA', 'DEVUELTO', 'CIERRE_OFICIAL_ML', 'ENTREGADO']), tt]); }
        const closing = events.filter((e) => ['ENTREGADO', 'PROBLEMA', 'DEVUELTO'].includes(e[0]));
        const status = closing.length ? closing[closing.length - 1][0] : pick(['EN_TRANSITO', 'ENTREGADO', 'PROBLEMA']);   // sin eventos de cierre también hay paquetes viejos «entregados»
        const updated = (events.length ? tt : created) + (rnd() < 0.3 ? Math.floor(rnd() * 12 * 24 * H) : 0);              // a veces se «toca» días después
        model.push({ id: `R${String(i).padStart(3, '0')}`, driver: pick(['D1', 'D2', 'D3', 'D4']), created, events, closing, status, updated, est: rnd() < 0.5 ? created : null });
    }
    for (const m of model) await P(m.id, { driver: m.driver, status: m.status, created: new Date(m.created).toISOString(), updated: new Date(m.updated).toISOString(), est: m.est ? new Date(m.est).toISOString() : null, events: m.events.map(([st, ts]) => [st, new Date(ts).toISOString()]) });
    // lo que hace la pantalla con lo que recibe: fecha = último evento de cierre (o updatedAt si no hay), dentro de [00:00 del primer día, 23:59:59.999 del último] hora de Santiago (UTC-3 en este periodo)
    const dayMs = (d) => Date.parse(`${d}T03:00:00Z`);
    const screen = (m, d1, d2) => { const when = m.closing.length ? Math.max(...m.closing.map((e) => e[1])) : m.updated; return when >= dayMs(d1) && when <= dayMs(d2) + 24 * H - 1; };
    const ranges = [['2026-11-01', '2026-11-10'], ['2026-11-09', '2026-11-09'], ['2026-11-03', '2026-11-04'], ['2026-10-25', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-10-20', '2026-11-13']];
    let lostByOld = 0, delivered = 0;
    for (const [d1, d2] of ranges) for (const driver of ['D1', 'D2', 'D3', 'D4']) {
        const got = await serverClosed(driver, d1, d2);
        const truth = model.filter((m) => m.driver === driver && ['ENTREGADO', 'PROBLEMA', 'DEVUELTO'].includes(m.status) && screen(m, d1, d2)).map((m) => m.id).sort();
        const finalOnScreen = got.filter((id) => screen(model.find((m) => m.id === id), d1, d2)).sort();
        assert.deepStrictEqual(finalOnScreen, truth, `${driver} ${d1}→${d2}: el panel perdió o inventó entregas`);
        const old = new Set(await serverLegacyAdmin(driver, d1, d2));
        lostByOld += truth.filter((id) => !old.has(id)).length; delivered += truth.length;
    }
    assert.ok(delivered > 150, `la simulación debe tener entregas suficientes (${delivered})`);
    assert.ok(lostByOld > 15, `la simulación debe reproducir el problema original: el filtro anterior perdía ${lostByOld} de ${delivered}`);
}, { needsPg: true });

// ═════════════ C. la ruta HTTP real ═════════════
let CAP; const resetCap = () => { CAP = []; };
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let base = null, server = null;
const tokenFor = (id, role) => jwt.sign({ user: { id, role } }, process.env.JWT_SECRET);
const call = async (qs, token) => { const r = await fetch(`${base}/api/packages?${qs}`, { headers: { Authorization: 'Bearer ' + token } }); let body = null; try { body = await r.json(); } catch (e) { /* */ } return { status: r.status, body }; };
const countQuery = () => CAP.find((c) => /^SELECT COUNT\(\*\) FROM packages p/.test(c.sql));
const Q = 'limit=0&driverFilter=D1&startDate=2026-11-01&endDate=2026-11-10&statusFilter=ENTREGADO,PROBLEMA,DEVUELTO';

t('C1 el panel (ADMIN) con dateType=closed recibe los paquetes cerrados en el rango, por días de calendario', async () => {
    need(); resetCap();
    const r = await call(`${Q}&dateType=closed`, tokenFor('adm', 'ADMIN')); assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const c = countQuery(); assert.ok(c, 'no se hizo la consulta de conteo');
    assert.match(c.sql, /p\.id IN \(SELECT "packageId" FROM tracking_events WHERE status IN \('ENTREGADO', 'PROBLEMA', 'DEVUELTO'\) AND timestamp >= \$5 AND timestamp < \$6\)/);
    assert.match(c.sql, /p\."driverId" = \$4/); assert.match(c.sql, /p\.status IN \(\$1,\$2,\$3\)/);
    assert.deepStrictEqual(c.params, ['ENTREGADO', 'PROBLEMA', 'DEVUELTO', 'D1', '2026-11-01 00:00:00', '2026-11-11 00:00:00']);
    assert.ok(!/"estimatedDelivery"/.test(c.sql), 'no debe filtrar por entrega estimada');
});
t('C2 sin dateType el panel y las demás pantallas siguen como antes (por creación / entrega estimada, día lógico de 02:00 a 02:00)', async () => {
    resetCap();   // (esta prueba y las de «no cambia» pasan igual con el código anterior: eso es justo lo que demuestran)
    const r = await call(Q, tokenFor('adm', 'ADMIN')); assert.strictEqual(r.status, 200);
    const c = countQuery(); assert.ok(!/tracking_events/.test(c.sql), 'no debe mirar el seguimiento');
    assert.match(c.sql, /p\."createdAt" >= \$5 AND p\."createdAt" < \$6 OR p\."estimatedDelivery" >= \$5 AND p\."estimatedDelivery" < \$6/);
    assert.deepStrictEqual(c.params.slice(4), ['2026-11-01 02:00:00', '2026-11-11 02:00:00']);
});
t('C3 dateType=updated y dateType=egress no cambian', async () => {
    resetCap(); await call(`${Q}&dateType=updated`, tokenFor('adm', 'ADMIN')); let c = countQuery();
    assert.match(c.sql, /p\."updatedAt" >= \$5 AND p\."updatedAt" < \$6/); assert.deepStrictEqual(c.params.slice(4), ['2026-11-01 02:00:00', '2026-11-11 02:00:00']);
    resetCap(); await call(`${Q}&dateType=egress`, tokenFor('adm', 'ADMIN')); c = countQuery();
    assert.match(c.sql, /p\."assignedAt" >= \$5 AND p\."assignedAt" < \$6/); assert.deepStrictEqual(c.params.slice(4), ['2026-11-01 02:00:00', '2026-11-11 02:00:00']);
});
t('C4 el teléfono (DRIVER, rango, sin dateType) sigue con su filtro amplio del Historial', async () => {
    resetCap();
    const r = await call('limit=0&driverFilter=D1&startDate=2026-11-01&endDate=2026-11-10&statusFilter=ENTREGADO,PROBLEMA,DEVUELTO', tokenFor('D1', 'DRIVER')); assert.strictEqual(r.status, 200);
    const c = countQuery();
    assert.match(c.sql, /p\."createdAt" >= \$5 AND p\."createdAt" < \$6 OR p\."assignedAt" >= \$5 AND p\."assignedAt" < \$6 OR p\."updatedAt" >= \$5 AND p\."updatedAt" < \$6/);
    assert.match(c.sql, /p\.id IN \(SELECT "packageId" FROM tracking_events WHERE timestamp >= \$5 AND timestamp < \$6\)/);
    assert.match(c.sql, /p\.status NOT IN \('ENTREGADO', 'DEVUELTO', 'CANCELADO'\)/);
    assert.deepStrictEqual(c.params.slice(4), ['2026-11-01 02:00:00', '2026-11-11 02:00:00']);
});
t('C5 si se pide explícitamente, dateType=closed vale igual para cualquier rol (no hay una rama escondida según quién pregunta)', async () => {
    need(); resetCap();
    await call(`${Q}&dateType=closed`, tokenFor('D1', 'DRIVER')); const c = countQuery();
    assert.match(c.sql, /p\.id IN \(SELECT "packageId" FROM tracking_events WHERE status IN \('ENTREGADO', 'PROBLEMA', 'DEVUELTO'\)/);
    assert.deepStrictEqual(c.params.slice(4), ['2026-11-01 00:00:00', '2026-11-11 00:00:00']);
});
t('C6 un cliente con dateType=closed sigue viendo solo sus paquetes', async () => {
    need(); resetCap();
    await call(`${Q}&dateType=closed`, tokenFor('cli-1', 'CLIENT')); const c = countQuery();
    assert.match(c.sql, /"creatorId" = \$1/); assert.strictEqual(c.params[0], 'cli-1'); assert.match(c.sql, /tracking_events WHERE status IN/);
});
t('C7 dateType=closed con fechas mal escritas da error de servidor controlado (no una consulta extraña)', async () => {
    resetCap();
    const err0 = console.error; console.error = () => {};   // el servidor anota el error esperado
    let r; try { r = await call('limit=0&driverFilter=D1&startDate=hoy&endDate=ayer&statusFilter=ENTREGADO&dateType=closed', tokenFor('adm', 'ADMIN')); } finally { console.error = err0; }
    assert.strictEqual(r.status, 500); assert.ok(!countQuery(), 'no debe llegar a la base');
});

// ═════════════ D. guardas del código de la pantalla ═════════════
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
t('D1 solo el panel manda dateType=closed: la pantalla lo condiciona a no tener driverIdProp (el teléfono lo pasa)', () => {
    const page = read('components/admin/DriverPerformanceReportPage.tsx');
    const call = page.slice(page.indexOf('api.getPackages('), page.indexOf('api.getAssignmentHistory()'));
    assert.ok(call.includes('driverFilter: targetDriverId'), 'no se encontró la consulta de paquetes de la pantalla');
    assert.match(call, /\.\.\.\(driverIdProp \? \{\} : \{ dateType: 'closed' \}\)/, 'el panel debe pedir por fecha de cierre y el teléfono no');
    assert.ok(!/dateType:\s*'(created|egress|updated)'/.test(call));
});
t('D2 el teléfono sigue entrando con su id fijo (driverIdProp), así que no cambia', () => {
    const layout = read('components/driver/DriverMobileLayout.tsx');
    assert.match(layout, /case 'delivery-history': return <DriverPerformanceReportPage driverIdProp=\{user\?\.id\} \/>;/);
});

// ═════════════ ejecución ═════════════
(async () => {
    // la ruta real con una base falsa que solo anota lo que se le pide
    resetCap();
    stub('db.js', { query: async (text, params) => { CAP.push({ sql: norm(text), params }); return { rows: /^\s*SELECT COUNT\(\*\)/.test(text) ? [{ count: '0' }] : [], rowCount: 0 }; }, getClient: async () => { throw new Error('no se usa'); } });
    stub('services/notificationService.js', { notifyRecipient: () => Promise.resolve(), notifyRecipientsBulk: () => Promise.resolve(), notifyAdminPendingDelivery: () => Promise.resolve() });
    stub('services/meliPollingService.js', { optimizedJITDiscovery: async () => null, getValidMeliToken: async () => 'TOKEN-1' });
    stub('services/jumpsellerPollingService.js', {});
    stub('services/geocodingService.js', { geocodeAddress: async () => null, triggerBackgroundGeocoding: () => {} });
    stub('services/gisService.js', { getSectorForCoordinates: () => 'Sector de prueba', reloadSectors: async () => {} });
    stub('services/falabellaDirectService.js', { getOrderByLpn: async () => { throw new Error('no debe llamarse'); }, pushStatusUpdate: async () => {} });
    stub('services/driverEvents.js', { emitDriverEvent: () => {}, bus: new (require('events'))() });
    try {
        const app = express(); app.use(express.json()); app.use('/api/packages', require(path.join(ROOT, 'routes/packages.js')));
        server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); }); base = `http://127.0.0.1:${server.address().port}`;
    } catch (e) { console.error('No se pudo montar la ruta real:', e.message); }
    if (PGlite) { pg = new PGlite(); await pg.exec(SCHEMA); await pg.exec("SET timezone = 'America/Santiago'"); }

    const log = console.log; let ok = 0, skipped = 0; const fails = [];
    for (const { name, fn, needsPg } of tests) {
        if (needsPg && !PGlite) { skipped++; log('OMITIDA ' + name + '   (falta @electric-sql/pglite)'); continue; }
        const quiet = console.log; console.log = () => {};
        try { await fn(); ok++; console.log = quiet; log('OK    ' + name); }
        catch (e) { console.log = quiet; fails.push(name); log('FALLA ' + name + '\n      ' + String(e && e.message).split('\n').slice(0, 6).join('\n      ')); }
    }
    log(`\n${ok} de ${tests.length} pruebas OK` + (skipped ? ` · ${skipped} OMITIDAS (no cuentan como aprobadas: instala @electric-sql/pglite para correrlas)` : ''));
    if (server) server.close(); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(2); });
