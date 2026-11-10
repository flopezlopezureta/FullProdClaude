/**
 * Prueba de la FACTURACIÓN del «Reporte Mensual de Cobro UF» (services/billingInvoices.js y las rutas de routes/billing.js).
 *   A. matemática, fechas de Santiago y reglas sueltas (sin base)
 *   B. el SQL REAL contra un Postgres de verdad en memoria (PGlite): el modo en vivo da lo mismo que el reporte de siempre, la factura de referencia, los rezagados
 *      de meses anteriores, facturar, congelar, anular, y una simulación al azar donde cada envío se factura una sola vez
 *   C. las rutas HTTP reales (permisos, validaciones, flujo completo con registro en el historial)
 * Los nombres, patentes y montos son inventados; no toca ninguna red ni la base real.
 *
 * Uso:   node tests/billingInvoices.test.js
 *        B y C necesitan @electric-sql/pglite (no va en el proyecto, solo se usa para probar):
 *            npm i --no-save @electric-sql/pglite     o     PGLITE_DIR=<carpeta donde está instalado> node tests/billingInvoices.test.js
 *        Si no está, B y C se OMITEN a viva voz (no cuentan como aprobadas).
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/billingInvoices.test.js   (el código ANTERIOR debe FALLAR; Staging/Producción antes de subir)
 */
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';
require('https').get = () => { throw new Error('la prueba intentó salir a internet (mindicador.cl)'); };

let bi = null;
try { bi = require(path.join(ROOT, 'services/billingInvoices.js')); } catch (e) { /* el código anterior no lo tiene: las pruebas fallan con un mensaje claro */ }
const need = (what) => { if (!bi) throw new Error(`no existe ${what || 'services/billingInvoices.js'} en ${ROOT}`); };

let PGlite = null;
try { PGlite = require(require.resolve('@electric-sql/pglite', { paths: [ROOT, process.env.PGLITE_DIR, __dirname].filter(Boolean) })).PGlite; } catch (e) { /* se omiten B y C */ }

const tests = [];
const t = (name, fn, opts = {}) => tests.push({ name, fn, needsPg: !!opts.needsPg });

// ═════════════ A. reglas puras ═════════════
t('A1 los montos dan lo mismo que la fórmula que siempre usó el reporte, para muchas combinaciones de envíos y UF', () => {
    need(); assert.strictEqual(bi.RATE_PER_PACKAGE_UF, 0.00099667);
    const legacy = (packages, uf) => { const costUf = packages * 0.00099667; const clp = uf ? costUf * uf : null; return { costUf: parseFloat(costUf.toFixed(8)), net: clp ? Math.round(clp) : null, iva: clp ? Math.round(clp * 0.19) : null, gross: clp ? Math.round(clp * 1.19) : null }; };
    let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 500; i++) { const n = Math.floor(rnd() * 60000), uf = Math.round((30000 + rnd() * 15000) * 100) / 100; assert.deepStrictEqual(bi.computeAmounts(n, uf), legacy(n, uf), `${n} envíos · UF ${uf}`); }
    const a = bi.computeAmounts(10000, 40000); assert.deepStrictEqual([a.costUf, a.net, a.iva, a.gross], [9.9667, 398668, 75747, 474415]);
});
t('A2 sin envíos o sin UF no hay monto en pesos (igual que el reporte de siempre)', () => {
    need(); const z = bi.computeAmounts(0, 41000); assert.deepStrictEqual([z.costUf, z.net, z.iva, z.gross], [0, null, null, null]);
    const n = bi.computeAmounts(10, null); assert.deepStrictEqual([n.net, n.iva, n.gross], [null, null, null]); assert.strictEqual(n.costUf, 0.0099667);
});
t('A3 un mes termina a la medianoche de Santiago (verano UTC-3 e invierno UTC-4)', () => {
    need();
    assert.strictEqual(bi.isMonthClosed(2026, 10, new Date('2026-11-01T02:59:59Z')), false, '31-oct 23:59:59 en Santiago aún es octubre');
    assert.strictEqual(bi.isMonthClosed(2026, 10, new Date('2026-11-01T03:00:00Z')), true, '01-nov 00:00:00 en Santiago ya cerró octubre');
    assert.strictEqual(bi.isMonthClosed(2026, 6, new Date('2026-07-01T03:59:59Z')), false, 'en invierno la medianoche es a las 04:00 UTC');
    assert.strictEqual(bi.isMonthClosed(2026, 6, new Date('2026-07-01T04:00:00Z')), true);
    assert.strictEqual(bi.isMonthClosed(2026, 12, new Date('2027-01-01T03:00:00Z')), true, 'diciembre cierra el 1 de enero del año siguiente');
    assert.strictEqual(bi.isMonthClosed(2026, 11, new Date('2026-11-10T16:00:00Z')), false, 'noviembre sigue abierto el 10-nov');
});
t('A4 el modo del mes según las facturas vigentes: facturado / arrastre (el mes que sigue) / en vivo (cualquier otro)', () => {
    need(); const active = [{ id: 'a', periodYear: 2026, periodMonth: 10 }];
    assert.deepStrictEqual([bi.resolveMode(active, 2026, 10).mode, bi.resolveMode(active, 2026, 11).mode, bi.resolveMode(active, 2026, 12).mode, bi.resolveMode(active, 2026, 9).mode], ['INVOICED', 'CARRYOVER', 'LIVE', 'LIVE']);
    assert.strictEqual(bi.resolveMode([], 2026, 11).mode, 'LIVE'); assert.strictEqual(bi.resolveMode([], 2026, 11).hasAnchor, false);
    const two = [{ id: 'b', periodYear: 2026, periodMonth: 11 }, { id: 'a', periodYear: 2026, periodMonth: 10 }];   // desordenadas
    assert.deepStrictEqual(bi.resolveMode(two, 2026, 12), { mode: 'CARRYOVER', invoiceId: null, first: { year: 2026, month: 10 }, last: { year: 2026, month: 11 }, next: { year: 2026, month: 12 }, hasAnchor: true });
    assert.strictEqual(bi.resolveMode([{ id: 'x', periodYear: 2026, periodMonth: 12 }], 2027, 1).mode, 'CARRYOVER', 'después de diciembre sigue enero del año siguiente');
});
t('A5 la pantalla sabe cuándo se puede facturar y por qué no', () => {
    need(); const active = [{ id: 'a', periodYear: 2026, periodMonth: 10 }]; const d = (y, m, over = {}) => bi.describeBilling({ ctx: bi.resolveMode(active, y, m), year: y, month: m, isGlobal: true, now: new Date('2026-12-05T15:00:00Z'), invoice: null, ...over });
    assert.strictEqual(d(2026, 11).canInvoice, true);
    assert.strictEqual(d(2026, 11, { now: new Date('2026-11-10T15:00:00Z') }).canInvoice, false); assert.match(d(2026, 11, { now: new Date('2026-11-10T15:00:00Z') }).cannotInvoiceReason, /01-12-2026/);
    assert.match(d(2026, 12).cannotInvoiceReason, /Antes hay que facturar noviembre 2026/);
    assert.match(d(2026, 9).cannotInvoiceReason, /anterior a las facturas registradas/);
    assert.strictEqual(d(2026, 11, { isGlobal: false }).canInvoice, false); assert.match(d(2026, 11, { isGlobal: false }).cannotInvoiceReason, /Go Delivery Interno/);
    const none = bi.describeBilling({ ctx: bi.resolveMode([], 2026, 11), year: 2026, month: 11, isGlobal: true, now: new Date('2026-12-05T15:00:00Z'), invoice: null });
    assert.strictEqual(none.canInvoice, false); assert.match(none.cannotInvoiceReason, /factura de referencia/);
    const inv = bi.describeBilling({ ctx: bi.resolveMode(active, 2026, 10), year: 2026, month: 10, isGlobal: true, now: new Date('2026-12-05T15:00:00Z'), invoice: null });
    assert.deepStrictEqual([inv.mode, inv.canInvoice, inv.canVoid], ['INVOICED', false, true]);
    const two = [{ id: 'a', periodYear: 2026, periodMonth: 10 }, { id: 'b', periodYear: 2026, periodMonth: 11 }];
    assert.strictEqual(bi.describeBilling({ ctx: bi.resolveMode(two, 2026, 10), year: 2026, month: 10, isGlobal: true, now: new Date('2026-12-05T15:00:00Z'), invoice: null }).canVoid, false, 'solo la última se puede anular');
});
t('A6 el resumen suma los días y los rezagados con la misma matemática de siempre', () => {
    need();
    const rows = [{ date_str: '2026-11-01', total_created: '10', assigned_to_bodega: '4', total_reassigned: '1', net_dispatched: '6' }, { date: new Date('2026-11-02T00:00:00Z'), total_created: 20, assigned_to_bodega: 5, total_reassigned: 0, net_dispatched: 15 }];
    const f = bi.computeFigures({ rows, carryOverRows: [{ ym: '2026-10', n: 3, reassigned: 1 }, { ym: '2026-09', n: 2, reassigned: 0 }], ufValue: 40000, rate: 0.00099667 });
    assert.deepStrictEqual([f.summary.totalCreated, f.summary.totalAssignedToBodega, f.summary.totalPackages, f.summary.packagesOfMonth, f.summary.packagesCarryOver, f.summary.totalReassigned], [30, 9, 26, 21, 5, 2]);
    assert.deepStrictEqual(f.dailyDetails.map(d => d.date), ['2026-11-01', '2026-11-02']);
    assert.deepStrictEqual(f.carryOver.byMonth, [{ year: 2026, month: 10, label: 'octubre 2026', count: 3 }, { year: 2026, month: 9, label: 'septiembre 2026', count: 2 }]);
    assert.strictEqual(f.summary.totalCostClpNet, Math.round(26 * 0.00099667 * 40000)); assert.strictEqual(f.carryOver.costClp, Math.round(5 * 0.00099667 * 40000));
    const none = bi.computeFigures({ rows: [], carryOverRows: [], ufValue: 40000, rate: 0.00099667 }); assert.strictEqual(none.summary.totalPackages, 0); assert.strictEqual(none.carryOver.count, 0);
});
t('A7 facturar valida los datos ANTES de tocar la base', async () => {
    need(); const boom = { query: async () => { throw new Error('no debía consultar la base'); } };
    const bad = (input, re) => assert.rejects(() => bi.createInvoice(boom, input, {}), (e) => e.status === 400 && re.test(e.message));
    await bad({ year: 2026, month: 13, ufValue: 40000 }, /Mes inválido/); await bad({ year: 1999, month: 1, ufValue: 40000 }, /Año inválido/);
    await bad({ year: 2026, month: 11, ufValue: 0 }, /UF/); await bad({ year: 2026, month: 11, ufValue: 'abc' }, /UF/); await bad({ year: 2026, month: 11, ufValue: 40000, expectedPackages: 'x' }, /esperados/);
});
t('A8 el total combinado suma despachos y licencias', () => {
    need(); const c = bi.combineTotals({ totalCostClpNet: 100, totalCostClpIva: 19, totalCostClpGross: 119 }, { costClpNet: 10, costClpIva: 2, costClpGross: 12 });
    assert.deepStrictEqual(c, { net: 110, iva: 21, gross: 131 }); assert.deepStrictEqual(bi.combineTotals({ totalCostClpNet: null, totalCostClpIva: null, totalCostClpGross: null }, null), { net: 0, iva: 0, gross: 0 });
});

// ═════════════ base real en memoria ═════════════
let pg = null; let db = null;
const SCHEMA = `
    CREATE TABLE users (id text PRIMARY KEY, name text, "companyName" text, email text, role text, status text);
    CREATE TABLE system_settings (id int PRIMARY KEY, "licenseLimit" int, "licenseOverageFee" numeric);
    CREATE TABLE tracking_events (id serial PRIMARY KEY, "packageId" text, status text, location text, details text, "timestamp" timestamptz);
    CREATE TABLE system_logs (id serial PRIMARY KEY, "userId" text, "userName" text, action text NOT NULL, details text, timestamp timestamptz DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE packages (id text PRIMARY KEY, "createdAt" timestamptz, "updatedAt" timestamptz, "assignedAt" timestamptz, status text, "driverId" text, "creatorId" text,
        "isReassigned" boolean DEFAULT false, "meliOrderId" text, "shopifyOrderId" text, "wooOrderId" text, "jumpsellerOrderId" text, "trackingId" text,
        "recipientName" text, "recipientPhone" text, "recipientAddress" text, "recipientCommune" text);`;
const makeDb = (p) => {
    const conv = (rows) => rows.map((r) => { const o = {}; for (const k of Object.keys(r)) o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]; return o; });
    const query = async (text, params = []) => { const r = await p.query(text, params); return { rows: conv(r.rows), rowCount: r.affectedRows || r.rows.length }; };
    return { query, getClient: async () => ({ query, release() {} }) };
};
const GO = () => bi.GO_DELIVERY_CLIENT_ID;
async function resetDb(withBilling = true) {
    await pg.exec('TRUNCATE packages, users, system_settings, system_logs, tracking_events');
    if (withBilling) await pg.exec('TRUNCATE billing_invoices, billing_invoice_packages');
    await pg.exec(`INSERT INTO users VALUES ('bodega','Bodega','','bodega@t.test','DRIVER','APROBADO'),('d1','Conductor Uno','','d1@t.test','DRIVER','APROBADO'),('d2','Conductor Dos','','d2@t.test','DRIVER','APROBADO'),
        ('c1','Cliente Uno','Empresa Uno','c1@t.test','CLIENT','APROBADO'),('c2','Cliente Dos','Empresa Dos','c2@t.test','CLIENT','APROBADO'),
        ('${GO()}','Go Delivery Interno','Go Delivery','go@t.test','CLIENT','APROBADO'),('adm','Administrador Principal','','admin','ADMIN','APROBADO'),('adm2','Otro Administrador','','otro@t.test','ADMIN','APROBADO');
        INSERT INTO system_settings VALUES (1, 70, 0.1);`);
}
let seq = 0;
async function P({ created, driver = 'd1', status = 'ENTREGADO', creator = 'c1', reassigned = false }) {
    const id = `P${String(++seq).padStart(5, '0')}`;
    await db.query(`INSERT INTO packages (id, "createdAt", "updatedAt", "assignedAt", status, "driverId", "creatorId", "isReassigned", "recipientName", "recipientAddress", "recipientCommune")
        VALUES ($1, ($2::timestamp AT TIME ZONE 'America/Santiago'), ($2::timestamp AT TIME ZONE 'America/Santiago'), CASE WHEN $3::text IS NULL THEN NULL ELSE ($2::timestamp AT TIME ZONE 'America/Santiago') END, $4, $3, $5, $6, 'Persona de Prueba', 'Calle de Prueba 1', 'SANTIAGO')`,
        [id, created, driver, status, creator, reassigned]);
    return id;
}
const setState = (id, { driver, status }) => db.query('UPDATE packages SET "driverId" = $2, status = $3 WHERE id = $1', [id, driver, status]);
const dispatch = (id) => setState(id, { driver: 'd1', status: 'EN_TRANSITO' });
const NOW_NOV = new Date('2026-11-10T16:00:00Z'), NOW_DEC1 = new Date('2026-12-01T03:00:00Z'), NOW_DEC5 = new Date('2026-12-05T16:00:00Z');
const UF = 40000;
const report = (clientId, y, m, now = NOW_NOV, ufValue = UF) => bi.buildMonthlyReport(db, { clientId, year: y, month: m, ufValue, getUfValue: async () => { throw new Error('no debía consultar la UF'); }, now });

/** Octubre (ya facturado antes del botón) y noviembre/diciembre con sus rezagados. */
async function fixture() {
    const F = {};
    F.E = [await P({ created: '2026-10-01 09:00:00', creator: 'c1' }), await P({ created: '2026-10-15 10:00:00', creator: 'c1' }), await P({ created: '2026-10-31 23:59:59', creator: 'c2' }),
        await P({ created: '2026-10-20 08:00:00', creator: 'c2', reassigned: true }), await P({ created: '2026-10-31 12:00:00', creator: 'c1' }), await P({ created: '2026-10-10 09:00:00', creator: 'c2' })];
    F.L = [await P({ created: '2026-10-30 10:00:00', creator: 'c1' }), await P({ created: '2026-10-31 15:00:00', creator: 'c2' }), await P({ created: '2026-10-29 10:00:00', creator: 'c1' })];   // despachados DESPUÉS de la factura de octubre
    F.X = [await P({ created: '2026-10-12 10:00:00', driver: 'bodega', status: 'ASIGNADO' }), await P({ created: '2026-10-13 10:00:00', driver: 'bodega', status: 'ASIGNADO', creator: 'c2' }),
        await P({ created: '2026-10-14 10:00:00', driver: null, status: 'PENDIENTE' }), await P({ created: '2026-10-16 10:00:00', driver: 'd1', status: 'CANCELADO', creator: 'c2' }), await P({ created: '2026-10-17 10:00:00', driver: null, status: 'EN_TRANSITO' })];
    F.N = [await P({ created: '2026-11-01 00:00:00', creator: 'c1' }), await P({ created: '2026-11-02 10:00:00', creator: 'c1' }), await P({ created: '2026-11-03 10:00:00', creator: 'c2' }), await P({ created: '2026-11-30 23:59:59', creator: 'c2' }),
        await P({ created: '2026-11-04 10:00:00', driver: 'bodega', status: 'ASIGNADO' }), await P({ created: '2026-11-05 10:00:00', driver: null, status: 'PENDIENTE', creator: 'c2' })];
    F.D = [await P({ created: '2026-12-03 10:00:00', creator: 'c1' }), await P({ created: '2026-12-04 10:00:00', creator: 'c2' })];
    F.S1 = await P({ created: '2026-09-30 10:00:00' });   // septiembre: anterior a la primera factura registrada, no es rezagado
    return F;
}
async function registerOct(F, official = {}) {
    const client = await db.getClient();
    return bi.registerBaselineInvoice(client, { year: 2026, month: 10, ufValue: UF, ufSource: 'Factura emitida', invoicedAt: new Date('2026-11-02T17:23:26Z'), documentNumber: 'F-1', notes: 'referencia de prueba',
        official: { packagesCount: 6, totalCreated: 14, totalAssignedToBodega: 8, ...official }, ledgerSelect: 'SELECT id FROM packages WHERE id = ANY($2::text[])', ledgerParams: [F.E], userId: 'adm', userName: 'Administrador Principal' });
}
const create = async (y, m, now, over = {}) => bi.createInvoice(await db.getClient(), { year: y, month: m, ufValue: UF, ...over }, { userId: 'adm', userName: 'Administrador Principal', now });
const ledgerOf = async (invoiceId) => (await db.query('SELECT "packageId" FROM billing_invoice_packages WHERE "invoiceId" = $1 ORDER BY "packageId"', [invoiceId])).rows.map(r => r.packageId);
const invoiceRow = async (y, m) => (await db.query(`SELECT * FROM billing_invoices WHERE "periodYear" = $1 AND "periodMonth" = $2 AND status = 'ACTIVE'`, [y, m])).rows[0];
const withDb = (fn) => async () => { need(); await resetDb(); seq = 0; return fn(); };

// ═════════════ B. SQL real ═════════════
// El reporte ORIGINAL (antes de esta función), copiado tal cual, para comprobar que sin facturas el resultado no cambió ni en un envío.
const LEGACY_BODEGA = `WITH bodega_user AS (SELECT id FROM users WHERE name = 'Bodega' OR name ILIKE '%bodega%' LIMIT 1)`;
const legacyDailySql = (isGlobal) => `${LEGACY_BODEGA}
    SELECT DATE(p."createdAt" AT TIME ZONE 'America/Santiago') as date, COUNT(*) as total_created,
        COUNT(*) FILTER (WHERE p."driverId" = (SELECT id FROM bodega_user) OR p.status IN ('PENDIENTE', 'CANCELADO') OR p."driverId" IS NULL) as assigned_to_bodega,
        COUNT(*) FILTER (WHERE p."isReassigned" = true) as total_reassigned,
        COUNT(*) - COUNT(*) FILTER (WHERE p."driverId" = (SELECT id FROM bodega_user) OR p.status IN ('PENDIENTE', 'CANCELADO') OR p."driverId" IS NULL) as net_dispatched
    FROM packages p WHERE ${isGlobal ? '' : 'p."creatorId" = $3 AND '}p."createdAt" >= ($1::timestamp AT TIME ZONE 'America/Santiago') AND p."createdAt" < ($2::timestamp AT TIME ZONE 'America/Santiago')
    GROUP BY DATE(p."createdAt" AT TIME ZONE 'America/Santiago') ORDER BY date ASC`;
const legacyDetailSql = (isGlobal) => `${LEGACY_BODEGA}
    SELECT p.id, COALESCE(p."meliOrderId", p."shopifyOrderId", p."wooOrderId", p."jumpsellerOrderId", p.id) as "orderId", p."trackingId", p."recipientName", p."recipientPhone", p."recipientAddress", p."recipientCommune", p.status,
        TO_CHAR(p."createdAt" AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS') as "createdAt", TO_CHAR(p."updatedAt" AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS') as "updatedAt",
        TO_CHAR(p."assignedAt" AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD HH24:MI:SS') as "assignedAt", p."driverId", u.name as "driverName", p."isReassigned", TO_CHAR(p."createdAt" AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') as "date",
        CASE WHEN p."driverId" = (SELECT id FROM bodega_user) OR p.status IN ('PENDIENTE', 'CANCELADO') OR p."driverId" IS NULL THEN false ELSE true END as "isCharged",
        CASE WHEN p."driverId" = (SELECT id FROM bodega_user) THEN 'En Bodega' WHEN p.status = 'PENDIENTE' THEN 'Pendiente' WHEN p.status = 'CANCELADO' THEN 'Cancelado' WHEN p."driverId" IS NULL THEN 'Sin Conductor Asignado' ELSE '' END as "exclusionReason"
    FROM packages p LEFT JOIN users u ON p."driverId" = u.id WHERE ${isGlobal ? '' : 'p."creatorId" = $3 AND '}p."createdAt" >= ($1::timestamp AT TIME ZONE 'America/Santiago') AND p."createdAt" < ($2::timestamp AT TIME ZONE 'America/Santiago')
    ORDER BY p."createdAt" ASC`;
async function legacyReport(clientId, y, m, ufValue) {
    const isGlobal = clientId === GO(); const start = `${y}-${String(m).padStart(2, '0')}-01 00:00:00`; const ny = m === 12 ? y + 1 : y; const nm = m === 12 ? 1 : m + 1; const end = `${ny}-${String(nm).padStart(2, '0')}-01 00:00:00`;
    const params = isGlobal ? [start, end] : [start, end, clientId];
    const { rows } = await db.query(legacyDailySql(isGlobal), params);
    const rate = 0.00099667; let totalPackages = 0, totalCreated = 0, totalAssignedToBodega = 0, totalReassigned = 0; const dailyDetails = [];
    rows.forEach((row) => {
        const count = parseInt(row.net_dispatched, 10), created = parseInt(row.total_created, 10), bodega = parseInt(row.assigned_to_bodega, 10), reassigned = parseInt(row.total_reassigned || 0, 10);
        totalPackages += count; totalCreated += created; totalAssignedToBodega += bodega; totalReassigned += reassigned;
        const costUf = count * rate; const costClp = ufValue ? costUf * ufValue : null;
        dailyDetails.push({ date: row.date.toISOString().split('T')[0], totalCreated: created, assignedToBodega: bodega, reassignedCount: reassigned, packagesCount: count, costUf: parseFloat(costUf.toFixed(8)), costClp: costClp ? Math.round(costClp) : null });
    });
    const totalCostUf = totalPackages * rate; const totalCostClp = ufValue ? totalCostUf * ufValue : null;
    const summary = { totalCreated, totalAssignedToBodega, totalReassigned, totalPackages, ratePerPackageUf: rate, totalCostUf: parseFloat(totalCostUf.toFixed(8)), totalCostClpNet: totalCostClp ? Math.round(totalCostClp) : null, ivaRate: 0.19,
        totalCostClpIva: totalCostClp ? Math.round(totalCostClp * 0.19) : null, totalCostClpGross: totalCostClp ? Math.round(totalCostClp * 1.19) : null };
    const { rows: packagesDetail } = await db.query(legacyDetailSql(isGlobal), params);
    return { summary, dailyDetails, packagesDetail };
}
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const SUMMARY_KEYS = ['totalCreated', 'totalAssignedToBodega', 'totalReassigned', 'totalPackages', 'ratePerPackageUf', 'totalCostUf', 'totalCostClpNet', 'ivaRate', 'totalCostClpIva', 'totalCostClpGross'];

t('B1 sin facturas el reporte da EXACTAMENTE lo mismo que el de siempre (global y por cliente, tres meses)', withDb(async () => {
    await fixture();
    for (const [y, m] of [[2026, 10], [2026, 11], [2026, 12]]) for (const cid of [GO(), 'c1', 'c2']) {
        const now = await report(cid, y, m); const old = await legacyReport(cid, y, m, UF);
        assert.deepStrictEqual(pick(now.summary, SUMMARY_KEYS), old.summary, `resumen ${cid} ${y}-${m}`); assert.deepStrictEqual(now.dailyDetails, old.dailyDetails, `tabla diaria ${cid} ${y}-${m}`);
        assert.deepStrictEqual(now.packagesDetail, old.packagesDetail, `detalle ${cid} ${y}-${m}`); assert.strictEqual(now.billing.mode, 'LIVE'); assert.strictEqual(now.carryOver.count, 0);
        assert.deepStrictEqual([now.uf.value, now.uf.source], [UF, 'Manual']);
    }
    const o = await legacyReport(GO(), 2026, 10, UF); assert.strictEqual(o.summary.totalCreated, 14); assert.strictEqual(o.summary.totalPackages, 9, 'octubre en vivo: 6 antes + 3 rezagados ya despachados');
}), { needsPg: true });

t('B2 la factura de referencia (octubre) queda registrada con su detalle y mueve la cadena', withDb(async () => {
    const F = await fixture(); const r = await registerOct(F);
    assert.deepStrictEqual([r.reconstructedPackages, r.officialPackages], [6, 6]);
    const row = await invoiceRow(2026, 10); assert.strictEqual(row.source, 'BASELINE'); assert.strictEqual(row.status, 'ACTIVE'); assert.strictEqual(row.documentNumber, 'F-1');
    assert.deepStrictEqual(await ledgerOf(row.id), [...F.E].sort());
    assert.deepStrictEqual([Number(row.ufValue), row.packagesCount, row.dispatchNetClp, row.dispatchIvaClp, row.dispatchGrossClp, row.totalGrossClp], [UF, 6, 239, 45, 285, 285]);
    const modes = []; for (const m of [9, 10, 11, 12]) modes.push((await report(GO(), 2026, m)).billing.mode); assert.deepStrictEqual(modes, ['LIVE', 'INVOICED', 'CARRYOVER', 'LIVE']);
    await assert.rejects(() => registerOct(F), (e) => e.status === 409, 'no se registra dos veces el mismo mes');
}), { needsPg: true });

t('B3 octubre ya facturado se muestra CONGELADO aunque después cambien envíos, la UF pedida o las licencias', withDb(async () => {
    const F = await fixture(); await registerOct(F);
    const before = await report(GO(), 2026, 10, NOW_NOV, UF);
    await setState(F.E[0], { driver: 'bodega', status: 'ASIGNADO' }); await setState(F.E[1], { driver: 'd1', status: 'CANCELADO' }); await dispatch(F.X[0]); await pg.query(`UPDATE system_settings SET "licenseLimit" = 1`);
    const after = await report(GO(), 2026, 10, NOW_NOV, 99999);   // aunque pidan otra UF
    assert.deepStrictEqual(after.summary, before.summary); assert.deepStrictEqual(after.dailyDetails, before.dailyDetails); assert.deepStrictEqual(after.licenseBilling, before.licenseBilling); assert.deepStrictEqual(after.uf, before.uf);
    assert.strictEqual(after.uf.value, UF); assert.match(after.uf.source, /Factura registrada/); assert.strictEqual(after.billing.invoice.documentNumber, 'F-1'); assert.strictEqual(after.billing.canVoid, true);
    assert.strictEqual(after.summary.totalPackages, 6); assert.strictEqual(after.summary.totalCostClpGross, 285);
    assert.deepStrictEqual(after.dailyDetails.reduce((a, d) => a + d.packagesCount, 0), 6); assert.strictEqual(after.dailyDetails.find(d => d.date === '2026-10-31').totalCreated, 3, 'el del 31-oct 23:59:59 es de octubre');
}), { needsPg: true });

t('B4 noviembre cobra lo suyo MÁS los rezagados de octubre; septiembre no entra (es anterior a la primera factura)', withDb(async () => {
    const F = await fixture(); await registerOct(F); const r = await report(GO(), 2026, 11);
    assert.strictEqual(r.billing.mode, 'CARRYOVER'); assert.strictEqual(r.billing.canInvoice, false, 'noviembre aún no termina el 10-nov');
    assert.deepStrictEqual(pick(r.summary, ['totalCreated', 'totalAssignedToBodega', 'packagesOfMonth', 'packagesCarryOver', 'totalPackages']), { totalCreated: 6, totalAssignedToBodega: 2, packagesOfMonth: 4, packagesCarryOver: 3, totalPackages: 7 });
    assert.deepStrictEqual(r.carryOver.byMonth, [{ year: 2026, month: 10, label: 'octubre 2026', count: 3 }]); assert.strictEqual(r.carryOver.count, 3);
    assert.strictEqual(r.summary.totalCostClpNet, Math.round(7 * 0.00099667 * UF)); assert.ok(r.carryOver.costClp > 0);
    const co = r.packagesDetail.filter(p => p.carryOver); assert.deepStrictEqual(co.map(p => p.id).sort(), [...F.L].sort()); assert.ok(co.every(p => p.isCharged === true));
    assert.ok(!r.packagesDetail.some(p => p.id === F.S1), 'septiembre no es rezagado'); assert.strictEqual(r.packagesDetail.length, 6 + 3);
    assert.strictEqual(r.dailyDetails.find(d => d.date === '2026-11-01').totalCreated, 1, 'el de las 00:00:00 del 1-nov es de noviembre'); assert.strictEqual(r.dailyDetails.reduce((a, d) => a + d.packagesCount, 0), 4);
}), { needsPg: true });

t('B5 por cliente los rezagados suman lo mismo que el global', withDb(async () => {
    const F = await fixture(); await registerOct(F); const g = await report(GO(), 2026, 11); const a = await report('c1', 2026, 11); const b = await report('c2', 2026, 11);
    assert.deepStrictEqual([a.carryOver.count, b.carryOver.count, a.summary.totalPackages, b.summary.totalPackages], [2, 1, 4, 3]);
    assert.strictEqual(a.carryOver.count + b.carryOver.count, g.carryOver.count); assert.strictEqual(a.summary.totalPackages + b.summary.totalPackages, g.summary.totalPackages);
    assert.strictEqual(a.billing.canInvoice, false); assert.match(a.billing.cannotInvoiceReason, /Go Delivery Interno/);
    const oct = await report('c1', 2026, 10); assert.strictEqual(oct.billing.mode, 'INVOICED'); assert.deepStrictEqual([oct.summary.totalPackages, oct.carryOver.count], [3, 0], 'la vista por cliente de un mes facturado sale del registro de envíos');
    const oct2 = await report('c2', 2026, 10); assert.strictEqual(oct.summary.totalPackages + oct2.summary.totalPackages, 6);
}), { needsPg: true });

t('B6 facturar noviembre: anota los 7 envíos, guarda los valores y queda congelado aunque luego cambien', withDb(async () => {
    const F = await fixture(); await registerOct(F);
    const before = await report(GO(), 2026, 11, NOW_DEC1); assert.strictEqual(before.billing.canInvoice, true); assert.strictEqual(before.summary.totalPackages, 7);
    const inv = await create(2026, 11, NOW_DEC1, { expectedPackages: 7, expectedGrossClp: before.summary.totalCostClpGross, documentNumber: ' F-2 ', notes: 'prueba' });
    assert.deepStrictEqual([inv.year, inv.month, inv.status, inv.source, inv.packagesCount, inv.packagesOfMonth, inv.packagesCarryOver, inv.documentNumber, inv.invoicedByName], [2026, 11, 'ACTIVE', 'BUTTON', 7, 4, 3, 'F-2', 'Administrador Principal']);
    assert.deepStrictEqual([inv.dispatchNetClp, inv.dispatchIvaClp, inv.dispatchGrossClp, inv.totalGrossClp], [before.summary.totalCostClpNet, before.summary.totalCostClpIva, before.summary.totalCostClpGross, before.summary.totalCostClpGross]);
    assert.deepStrictEqual(await ledgerOf(inv.id), [...F.L, F.N[0], F.N[1], F.N[2], F.N[3]].sort());
    await setState(F.N[0], { driver: 'bodega', status: 'ASIGNADO' }); await dispatch(F.N[4]);   // cambian DESPUÉS de facturar
    const frozen = await report(GO(), 2026, 11, NOW_DEC5);
    assert.strictEqual(frozen.billing.mode, 'INVOICED'); assert.deepStrictEqual(frozen.summary, before.summary); assert.deepStrictEqual(frozen.dailyDetails, before.dailyDetails); assert.deepStrictEqual(frozen.carryOver, before.carryOver);
    const detail = frozen.packagesDetail; assert.strictEqual(detail.filter(p => p.isCharged).length, 7); assert.strictEqual(detail.filter(p => p.carryOver).length, 3);
    assert.strictEqual(detail.find(p => p.id === F.N[4]).exclusionReason, 'Despachado después de facturar'); assert.strictEqual(detail.find(p => p.id === F.N[5]).exclusionReason, 'Pendiente');
    assert.strictEqual((await db.query(`SELECT COUNT(*)::int n FROM system_logs`)).rows[0].n, 0, 'el servicio no escribe el historial; lo hace la ruta');
}), { needsPg: true });

t('B7 facturar tiene resguardos: mes sin terminar, ya facturado, saltarse un mes, sin factura de referencia y números que cambiaron', withDb(async () => {
    const F = await fixture();
    await assert.rejects(() => create(2026, 11, NOW_DEC1), (e) => e.status === 409 && /referencia/.test(e.message), 'sin factura de referencia no se encadena nada');
    await registerOct(F);
    await assert.rejects(() => create(2026, 11, NOW_NOV), (e) => e.status === 409 && /aún no termina/.test(e.message) && /01-12-2026/.test(e.message));
    await assert.rejects(() => create(2026, 12, new Date('2027-01-05T15:00:00Z')), (e) => e.status === 409 && /Antes hay que facturar noviembre 2026/.test(e.message), 'no se puede saltar noviembre');
    await assert.rejects(() => create(2026, 10, NOW_DEC5), (e) => e.status === 409 && /ya está facturado/.test(e.message));
    await assert.rejects(() => create(2026, 9, NOW_DEC5), (e) => e.status === 409 && /anterior/.test(e.message));
    await assert.rejects(() => create(2026, 11, NOW_DEC1, { expectedPackages: 6 }), (e) => e.status === 409 && /cambiaron/.test(e.message) && e.extra.fresh.packages === 7);
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM billing_invoices WHERE source = $1', ['BUTTON'])).rows[0].n, 0, 'el rechazo no deja ninguna factura');
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM billing_invoice_packages')).rows[0].n, 6, 'ni envíos marcados: solo los 6 de octubre');
    await assert.rejects(() => create(2026, 11, NOW_DEC1, { expectedGrossClp: 1 }), (e) => e.status === 409);
    const ok = await create(2026, 11, NOW_DEC1); assert.strictEqual(ok.packagesCount, 7);
    await assert.rejects(() => create(2026, 11, NOW_DEC5), (e) => e.status === 409 && /ya está facturado/.test(e.message));
}), { needsPg: true });

t('B8 cada envío se factura UNA vez: diciembre cobra lo suyo y lo de noviembre que se despachó después, no lo ya facturado', withDb(async () => {
    const F = await fixture(); await registerOct(F); const nov = await create(2026, 11, NOW_DEC1);
    await dispatch(F.N[4]); await setState(F.N[0], { driver: 'bodega', status: 'ASIGNADO' }); await dispatch(F.X[0]);   // N5 (de noviembre) y X1 (de octubre) se despachan en diciembre; N1 ya facturado vuelve a bodega
    const dec = await report(GO(), 2026, 12, NOW_DEC5); assert.strictEqual(dec.billing.mode, 'CARRYOVER');
    assert.deepStrictEqual(dec.carryOver.byMonth.map(b => [b.year, b.month, b.count]), [[2026, 10, 1], [2026, 11, 1]]);
    assert.deepStrictEqual(pick(dec.summary, ['totalCreated', 'packagesOfMonth', 'packagesCarryOver', 'totalPackages']), { totalCreated: 2, packagesOfMonth: 2, packagesCarryOver: 2, totalPackages: 4 });
    assert.deepStrictEqual(dec.packagesDetail.filter(p => p.carryOver).map(p => p.id).sort(), [F.N[4], F.X[0]].sort());
    await dispatch(F.N[0]);   // N1 vuelve a salir: ya se facturó en noviembre, no se cobra otra vez
    assert.strictEqual((await report(GO(), 2026, 12, NOW_DEC5)).carryOver.count, 2);
    const decInv = await create(2026, 12, new Date('2027-01-02T12:00:00Z')); assert.strictEqual(decInv.packagesCount, 4);
    const all = (await db.query('SELECT "packageId", COUNT(*)::int n FROM billing_invoice_packages GROUP BY 1 HAVING COUNT(*) > 1')).rows; assert.strictEqual(all.length, 0, 'ningún envío en dos facturas');
    assert.deepStrictEqual((await ledgerOf(nov.id)).includes(F.N[4]), false);
}), { needsPg: true });

t('B9 anular: solo la última, con motivo; los envíos quedan libres y se vuelve a facturar lo mismo', withDb(async () => {
    const F = await fixture(); const oct = await registerOct(F); const nov = await create(2026, 11, NOW_DEC1);
    const voidAs = async (id, reason = 'me equivoqué en la UF') => bi.voidInvoice(await db.getClient(), id, { reason, userId: 'adm', userName: 'Administrador Principal' });
    await assert.rejects(() => voidAs(oct.id), (e) => e.status === 409 && /última factura registrada \(noviembre 2026\)/.test(e.message), 'octubre no se puede anular mientras noviembre esté vigente');
    await assert.rejects(() => voidAs(nov.id, 'no'), (e) => e.status === 400); await assert.rejects(() => voidAs('no-existe'), (e) => e.status === 404);
    const res = await voidAs(nov.id); assert.deepStrictEqual([res.status, res.releasedPackages], ['VOIDED', 7]); assert.strictEqual((await ledgerOf(nov.id)).length, 0);
    const row = (await db.query('SELECT status, "voidReason", "voidedByName" FROM billing_invoices WHERE id = $1', [nov.id])).rows[0]; assert.deepStrictEqual([row.status, row.voidReason, row.voidedByName], ['VOIDED', 'me equivoqué en la UF', 'Administrador Principal']);
    await assert.rejects(() => voidAs(nov.id), (e) => e.status === 409 && /ya estaba anulada/.test(e.message));
    const back = await report(GO(), 2026, 11, NOW_DEC1); assert.strictEqual(back.billing.mode, 'CARRYOVER'); assert.strictEqual(back.summary.totalPackages, 7);
    const again = await create(2026, 11, NOW_DEC1, { ufValue: 41000 }); assert.deepStrictEqual([again.packagesCount, again.ufValue], [7, 41000]); assert.notStrictEqual(again.id, nov.id);
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM billing_invoices WHERE "periodMonth" = 11')).rows[0].n, 2, 'la anulada queda en el historial');
    const list = await bi.listInvoices(db); assert.deepStrictEqual(list.map(i => [i.month, i.status]), [[11, 'ACTIVE'], [11, 'VOIDED'], [10, 'ACTIVE']]);
}), { needsPg: true });

t('B10 las licencias en exceso quedan dentro de la factura y congeladas', withDb(async () => {
    const F = await fixture(); await registerOct(F); await pg.query(`UPDATE system_settings SET "licenseLimit" = 1`);
    const live = await report(GO(), 2026, 11, NOW_DEC1); assert.ok(live.licenseBilling.excess > 0 && live.licenseBilling.costClpNet > 0);
    const inv = await create(2026, 11, NOW_DEC1, { expectedPackages: 7, expectedGrossClp: live.summary.totalCostClpGross + live.licenseBilling.costClpGross });
    assert.strictEqual(inv.totalGrossClp, live.summary.totalCostClpGross + live.licenseBilling.costClpGross); assert.strictEqual(inv.licenseGrossClp, live.licenseBilling.costClpGross); assert.strictEqual(inv.dispatchGrossClp, live.summary.totalCostClpGross);
    await pg.query(`UPDATE system_settings SET "licenseLimit" = 70`); const frozen = await report(GO(), 2026, 11, NOW_DEC5); assert.deepStrictEqual(frozen.licenseBilling, live.licenseBilling);
}), { needsPg: true });

t('B11 el detalle de un mes facturado marca cobrados, rezagados y el motivo de los no cobrados', withDb(async () => {
    const F = await fixture(); await registerOct(F); const oct = await report(GO(), 2026, 10, NOW_NOV); const d = Object.fromEntries(oct.packagesDetail.map(p => [p.id, p]));
    assert.ok(F.E.every(id => d[id].isCharged)); assert.ok(F.L.every(id => d[id].isCharged === false && d[id].exclusionReason === 'Despachado después de facturar'), 'los rezagados de octubre figuran NO cobrados en octubre');
    assert.deepStrictEqual([d[F.X[0]].exclusionReason, d[F.X[2]].exclusionReason, d[F.X[3]].exclusionReason, d[F.X[4]].exclusionReason], ['En Bodega', 'Pendiente', 'Cancelado', 'Sin Conductor Asignado']);
    assert.strictEqual(oct.packagesDetail.length, 14); assert.ok(!oct.packagesDetail.some(p => p.carryOver));
}), { needsPg: true });

t('B12 sin las tablas nuevas el reporte sigue funcionando como siempre', async () => {
    need(); await resetDb(); seq = 0; await fixture(); await pg.exec('DROP TABLE billing_invoice_packages; DROP TABLE billing_invoices;');
    try { const r = await report(GO(), 2026, 10); assert.strictEqual(r.billing.mode, 'LIVE'); assert.strictEqual(r.summary.totalPackages, 9); assert.strictEqual(r.billing.hasAnchor, false); assert.deepStrictEqual(await bi.listActiveInvoices(db), []); }
    finally { for (const s of bi.BILLING_SCHEMA_SQL) await pg.exec(s); }
}, { needsPg: true });

t('B13 simulación: con envíos al azar, cancelaciones, devoluciones a bodega y redespachos, cada envío se factura una sola vez y ninguno se pierde', async () => {
    need(); await resetDb(); seq = 0;
    let s = 20261110; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); const DAY = 86400000;
    const base = Date.parse('2026-09-20T12:00:00Z'); const N = 420; const model = [];
    for (let i = 0; i < N; i++) {
        const createdMs = base + Math.floor(rnd() * 125 * DAY); const kind = rnd(); let dispatchMs = null, cancelMs = null, bodegaMs = null, redispatchMs = null;
        if (kind < 0.60) dispatchMs = createdMs + Math.floor(rnd() * 6 * DAY); else if (kind < 0.85) dispatchMs = createdMs + Math.floor((5 + rnd() * 35) * DAY);
        if (dispatchMs && rnd() < 0.10) cancelMs = dispatchMs + Math.floor((1 + rnd() * 10) * DAY);
        else if (dispatchMs && rnd() < 0.10) { bodegaMs = dispatchMs + Math.floor((1 + rnd() * 5) * DAY); redispatchMs = bodegaMs + Math.floor((1 + rnd() * 10) * DAY); }
        model.push({ i, createdMs, dispatchMs, cancelMs, bodegaMs, redispatchMs, creator: rnd() < 0.5 ? 'c1' : 'c2' });
    }
    const ids = [];
    for (const m of model) {
        const id = `S${String(m.i).padStart(4, '0')}`; ids.push(id);
        await db.query(`INSERT INTO packages (id, "createdAt", "updatedAt", status, "driverId", "creatorId", "isReassigned", "recipientName") VALUES ($1, $2, $2, 'PENDIENTE', NULL, $3, false, 'x')`, [id, new Date(m.createdMs).toISOString(), m.creator]);
    }
    const billableAt = (m, T) => !!m.dispatchMs && m.dispatchMs <= T && !(m.cancelMs && m.cancelMs <= T) && !(m.bodegaMs && m.bodegaMs <= T && T < m.redispatchMs);
    const applyState = async (T) => {
        for (const m of model) {
            const id = ids[m.i]; const b = billableAt(m, T);
            const st = b ? { driver: 'd1', status: 'EN_TRANSITO' } : (m.cancelMs && m.cancelMs <= T ? { driver: 'd1', status: 'CANCELADO' } : (m.dispatchMs && m.dispatchMs <= T ? { driver: 'bodega', status: 'ASIGNADO' } : { driver: null, status: 'PENDIENTE' }));
            await db.query('UPDATE packages SET "driverId" = $2, status = $3 WHERE id = $1', [id, st.driver, st.status]);
        }
    };
    const santiagoMs = (y, mo) => Date.parse(`${y}-${String(mo).padStart(2, '0')}-01T03:00:00Z`);   // 00:00 de Santiago en verano (UTC-3); sirve de borde para elegir el instante de cada factura
    const inMonth = (ms, y, mo) => { const a = Date.parse(new Date(santiagoMs(y, mo)).toISOString()); const nx = mo === 12 ? santiagoMs(y + 1, 1) : santiagoMs(y, mo + 1); return ms >= a && ms < nx; };
    // la factura de referencia (septiembre) y tres facturas más, cada una a una hora al azar después del cierre de su mes
    const invoiceAt = (y, mo) => (mo === 12 ? santiagoMs(y + 1, 1) : santiagoMs(y, mo + 1)) + Math.floor((1 + rnd() * 40) * 3600000);
    const schedule = [[2026, 9], [2026, 10], [2026, 11], [2026, 12]].map(([y, mo]) => ({ y, mo, T: invoiceAt(y, mo) }));
    const epochMs = santiagoMs(2026, 9); const expectedSets = []; const seen = new Set();
    for (let k = 0; k < schedule.length; k++) {
        const { y, mo, T } = schedule[k]; await applyState(T);
        const endMs = mo === 12 ? santiagoMs(y + 1, 1) : santiagoMs(y, mo + 1);
        const expected = model.filter(m => m.createdMs >= epochMs && m.createdMs < endMs && billableAt(m, T) && !seen.has(m.i)).map(m => ids[m.i]).sort();
        if (k === 0) {
            const client = await db.getClient();
            await bi.registerBaselineInvoice(client, { year: y, month: mo, ufValue: UF, ufSource: 'Factura emitida', invoicedAt: new Date(T), official: { packagesCount: expected.length }, ledgerSelect: 'SELECT id FROM packages WHERE id = ANY($2::text[])', ledgerParams: [expected], userId: 'adm', userName: 'Admin' });
        } else {
            const inv = await create(y, mo, new Date(T)); assert.strictEqual(inv.packagesCount, expected.length, `factura ${y}-${mo}`);
            assert.deepStrictEqual(await ledgerOf(inv.id), expected, `envíos de la factura ${y}-${mo}`);
        }
        expected.forEach(id => { const i = ids.indexOf(id); assert.ok(!seen.has(i), 'un envío en dos facturas'); seen.add(i); }); expectedSets.push(expected);
        assert.ok(expected.length > 0, `la factura ${y}-${mo} no debería quedar vacía`);
    }
    // el mes de rezagados de cada factura y la suma por mes de creación cuadran con el registro
    const total = (await db.query('SELECT COUNT(*)::int n FROM billing_invoice_packages')).rows[0].n; assert.strictEqual(total, expectedSets.reduce((a, e) => a + e.length, 0)); assert.strictEqual(total, seen.size);
    assert.ok(expectedSets.slice(1).some((e, k) => e.some(id => !inMonth(model[ids.indexOf(id)].createdMs, schedule[k + 1].y, schedule[k + 1].mo))), 'la simulación debe incluir rezagados de meses anteriores');
    // «no se pierde ninguno»: lo que estaba despachado en la última factura y se creó antes de su fin, ya fue facturado
    const lastT = schedule[3].T; const lost = model.filter(m => m.createdMs >= epochMs && m.createdMs < santiagoMs(2027, 1) && billableAt(m, lastT) && !seen.has(m.i)); assert.strictEqual(lost.length, 0, 'envíos cobrables que ninguna factura cobró');
    const before = model.filter(m => m.createdMs < epochMs && seen.has(m.i)); assert.strictEqual(before.length, 0, 'nada anterior a la primera factura entra');
    const rep = await report(GO(), 2026, 11, new Date(schedule[3].T)); assert.strictEqual(rep.billing.mode, 'INVOICED'); assert.strictEqual(rep.summary.totalPackages, expectedSets[2].length);
}, { needsPg: true });

t('B14 la factura de referencia manda con los montos OFICIALES aunque la reconstrucción por envío difiera, y si algo falla no queda nada a medias', withDb(async () => {
    const F = await fixture();
    await assert.rejects(async () => bi.registerBaselineInvoice(await db.getClient(), { year: 2026, month: 10, ufValue: UF, official: { packagesCount: 6 }, ledgerSelect: 'SELECT id FROM tabla_que_no_existe', userId: 'adm', userName: 'A' }), /tabla_que_no_existe/);
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM billing_invoices')).rows[0].n, 0); assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM billing_invoice_packages')).rows[0].n, 0);
    const r = await registerOct(F, { packagesCount: 7, totalCreated: 15, totalAssignedToBodega: 8, netClp: 123456, ivaClp: 23457, grossClp: 146913 });
    assert.deepStrictEqual([r.reconstructedPackages, r.officialPackages], [6, 7]);
    const rep = await report(GO(), 2026, 10, NOW_NOV, 1);
    assert.deepStrictEqual(pick(rep.summary, ['totalCreated', 'totalAssignedToBodega', 'totalPackages', 'totalCostClpNet', 'totalCostClpIva', 'totalCostClpGross']), { totalCreated: 15, totalAssignedToBodega: 8, totalPackages: 7, totalCostClpNet: 123456, totalCostClpIva: 23457, totalCostClpGross: 146913 });
    const row = await invoiceRow(2026, 10); assert.strictEqual(row.snapshot.reconstructedPackages, 6); assert.deepStrictEqual([row.dispatchNetClp, row.totalGrossClp], [123456, 146913]);
    assert.strictEqual(rep.dailyDetails.reduce((a, d) => a + d.packagesCount, 0), 6, 'la tabla diaria es la reconstrucción por envío');
}), { needsPg: true });

t('B15 un mes sin envíos por facturar no genera factura', withDb(async () => {
    const F = await fixture(); await registerOct(F);
    for (const id of [...F.L]) await setState(id, { driver: 'bodega', status: 'ASIGNADO' });   // ya no hay rezagados
    for (const id of F.N) await setState(id, { driver: null, status: 'PENDIENTE' });
    await assert.rejects(() => create(2026, 11, NOW_DEC1), (e) => e.status === 409 && /No hay envíos por facturar/.test(e.message));
    assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM billing_invoices')).rows[0].n, 1); assert.strictEqual((await db.query('SELECT COUNT(*)::int n FROM billing_invoice_packages')).rows[0].n, 6);
}), { needsPg: true });

t('B16 el script de la factura de referencia reconstruye lo cobrado con los eventos: hasta el corte, cancelados después incluidos, rezagados fuera', withDb(async () => {
    const script = require(path.join(ROOT, 'scripts/registerBaselineInvoice.js'));
    const CUT = '2026-11-02T17:23:26Z'; const ev = (id, status, at) => db.query('INSERT INTO tracking_events ("packageId", status, "timestamp") VALUES ($1, $2, $3)', [id, status, at]);
    const p1 = await P({ created: '2026-10-05 10:00:00' }); await ev(p1, 'Creado', '2026-10-05T13:00:00Z'); await ev(p1, 'EN_TRANSITO', '2026-10-06T13:00:00Z'); await ev(p1, 'ENTREGADO', '2026-10-07T13:00:00Z');   // cobrado al corte
    const p2 = await P({ created: '2026-10-30 10:00:00' }); await ev(p2, 'Creado', '2026-10-30T13:00:00Z'); await ev(p2, 'EN_TRANSITO', '2026-11-02T18:41:33Z');   // rezagado: 1er despacho DESPUÉS del corte
    const p3 = await P({ created: '2026-10-10 10:00:00', driver: 'd1', status: 'CANCELADO' }); await ev(p3, 'EN_TRANSITO', '2026-10-11T13:00:00Z'); await ev(p3, 'Cancelado', '2026-11-03T13:00:00Z');   // cancelado DESPUÉS del corte: estaba cobrado
    const p4 = await P({ created: '2026-10-12 10:00:00', driver: 'd1', status: 'CANCELADO' }); await ev(p4, 'EN_TRANSITO', '2026-10-13T13:00:00Z'); await ev(p4, 'Cancelado', '2026-10-20T13:00:00Z');   // cancelado ANTES del corte: no se cobró
    const p5 = await P({ created: '2026-10-14 10:00:00', driver: null, status: 'PENDIENTE' }); await ev(p5, 'EN_TRANSITO', '2026-10-15T13:00:00Z');   // devuelto a bodega: hoy no cobrable
    const p6 = await P({ created: '2026-10-16 10:00:00' }); await ev(p6, 'EN_TRANSITO', '2026-10-17T13:00:00Z'); await ev(p6, 'Asignado', '2026-11-03T13:00:00Z');   // otro despacho después del corte: a revisar
    const p7 = await P({ created: '2026-10-18 10:00:00' });   // cobrable hoy pero sin eventos de despacho: rezagado
    const p8 = await P({ created: '2026-11-05 10:00:00' }); await ev(p8, 'EN_TRANSITO', '2026-11-06T13:00:00Z');   // de noviembre
    const q = async (sql, p) => (await db.query(sql, p)).rows;
    const r = await script.reconcile(q, { year: 2026, month: 10, cutoff: CUT, officialPackages: 3 });
    assert.deepStrictEqual([r.created, r.ledger, r.billableNow, r.ledgerAndBillableNow, r.lateCarryOver, r.cancelledAfterCutoffIncluded, r.difference], [7, 3, 4, 2, 2, 1, 0]);
    assert.deepStrictEqual(r.redispatched.map(x => x.id), [p6]);
    const ledgerIds = async (over = {}) => (await q(`SELECT id FROM (${script.LEDGER_READ_SQL}) sel ORDER BY id`, ['2026-10-01 00:00:00', '2026-11-01 00:00:00', CUT, over.exclude || [], over.include || []])).map(x => x.id);
    assert.deepStrictEqual(await ledgerIds(), [p1, p3, p6].sort()); assert.deepStrictEqual(await ledgerIds({ exclude: [p1] }), [p3, p6].sort(), '--exclude-ids saca envíos'); assert.deepStrictEqual(await ledgerIds({ include: [p5] }), [p1, p3, p5, p6].sort(), '--include-ids agrega envíos');
    const res = await bi.registerBaselineInvoice(await db.getClient(), { year: 2026, month: 10, ufValue: UF, invoicedAt: new Date(CUT), official: { packagesCount: 3 }, ledgerSelect: script.LEDGER_SELECT_SQL, ledgerParams: ['2026-10-01 00:00:00', '2026-11-01 00:00:00', CUT, [], []], userId: null, userName: 'Registro de referencia' });
    assert.strictEqual(res.reconstructedPackages, 3);
    const nov = await report(GO(), 2026, 11); assert.strictEqual(nov.billing.mode, 'CARRYOVER'); assert.deepStrictEqual(nov.packagesDetail.filter(p => p.carryOver).map(p => p.id).sort(), [p2, p7].sort(), 'los rezagados de octubre pasan a noviembre');
    assert.strictEqual(nov.packagesDetail.some(p => [p1, p3, p6].includes(p.id) && p.carryOver), false, 'lo ya cobrado no se cobra otra vez');
    assert.ok(p4 && p8);
}), { needsPg: true });

// ═════════════ C. rutas HTTP ═════════════
let server = null, base = '';
const tokenFor = (id, role = 'ADMIN') => jwt.sign({ user: { id, role } }, process.env.JWT_SECRET);
const call = async (method, url, token, body) => { const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await res.json(); } catch (e) { /* sin cuerpo */ } return { status: res.status, body: json }; };
const ADM = () => tokenFor('adm'), ADM2 = () => tokenFor('adm2'), CLI = () => tokenFor('c1', 'CLIENT');

t('C1 solo el Administrador Principal entra: sin token 401, otro administrador o un cliente 403', async () => {
    need(); await resetDb(); seq = 0;
    for (const [m, u, b] of [['GET', '/api/billing/invoices'], ['POST', '/api/billing/invoices', { year: 2026, month: 9, ufValue: UF }], ['POST', '/api/billing/invoices/x/void', { reason: 'una razón' }], ['GET', `/api/billing/superadmin-monthly-report?clientId=${GO()}&year=2026&month=10&ufValue=${UF}`]]) {
        assert.strictEqual((await call(m, u, null, b)).status, 401, `${m} ${u} sin token`); assert.strictEqual((await call(m, u, ADM2(), b)).status, 403, `${m} ${u} otro admin`); assert.strictEqual((await call(m, u, CLI(), b)).status, 403, `${m} ${u} cliente`);
    }
}, { needsPg: true });

t('C2 el reporte por HTTP trae el bloque de facturación y valida los parámetros', async () => {
    need(); await resetDb(); seq = 0; await fixture();
    assert.strictEqual((await call('GET', '/api/billing/superadmin-monthly-report?year=2026&month=10', ADM())).status, 400);
    const r = await call('GET', `/api/billing/superadmin-monthly-report?clientId=${GO()}&year=2026&month=10&ufValue=${UF}`, ADM()); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.billing.mode, 'LIVE'); assert.strictEqual(r.body.billing.hasAnchor, false); assert.strictEqual(r.body.summary.totalCreated, 14); assert.ok(Array.isArray(r.body.dailyDetails) && Array.isArray(r.body.packagesDetail)); assert.ok(r.body.licenseBilling && r.body.client.name === 'Go Delivery Interno');
}, { needsPg: true });

t('C3 flujo completo por HTTP: referencia → facturar → listado → no se repite → anular → historial', async () => {
    need(); await resetDb(); seq = 0;
    // meses ya cerrados de verdad (ago-oct 2026) para no depender del reloj: ago = referencia; sep y oct se facturan con el botón
    const E = [await P({ created: '2026-08-10 10:00:00' }), await P({ created: '2026-08-11 10:00:00', creator: 'c2' })]; const late = await P({ created: '2026-08-31 22:00:00' });
    const sep = [await P({ created: '2026-09-02 10:00:00' }), await P({ created: '2026-09-03 10:00:00', creator: 'c2' }), await P({ created: '2026-09-04 10:00:00', driver: null, status: 'PENDIENTE' })]; await P({ created: '2026-10-02 10:00:00' });
    await setState(late, { driver: null, status: 'PENDIENTE' });
    await bi.registerBaselineInvoice(await db.getClient(), { year: 2026, month: 8, ufValue: UF, ufSource: 'Factura emitida', official: { packagesCount: 2 }, ledgerSelect: 'SELECT id FROM packages WHERE id = ANY($2::text[])', ledgerParams: [E], userId: 'adm', userName: 'Administrador Principal' });
    await dispatch(late);   // se despacha después de la factura de agosto
    const rep = await call('GET', `/api/billing/superadmin-monthly-report?clientId=${GO()}&year=2026&month=9&ufValue=${UF}`, ADM()); assert.strictEqual(rep.body.billing.mode, 'CARRYOVER'); assert.strictEqual(rep.body.billing.canInvoice, true); assert.strictEqual(rep.body.summary.totalPackages, 3);
    assert.strictEqual((await call('POST', '/api/billing/invoices', ADM(), { year: 2026, month: 9, ufValue: UF, expectedPackages: 99 })).status, 409);
    const created = await call('POST', '/api/billing/invoices', ADM(), { year: 2026, month: 9, ufValue: UF, expectedPackages: 3, expectedGrossClp: rep.body.summary.totalCostClpGross, documentNumber: 'F-77', notes: 'septiembre' });
    assert.strictEqual(created.status, 201); assert.deepStrictEqual([created.body.packagesCount, created.body.packagesCarryOver, created.body.documentNumber, created.body.invoicedByName], [3, 1, 'F-77', 'Administrador Principal']); assert.strictEqual(created.body.snapshot, undefined, 'el detalle pesado no sale en la respuesta');
    assert.strictEqual((await call('POST', '/api/billing/invoices', ADM(), { year: 2026, month: 9, ufValue: UF })).status, 409);
    assert.strictEqual((await call('POST', '/api/billing/invoices', ADM(), { year: 2026, month: 11, ufValue: UF })).status, 409, 'no se salta octubre');
    assert.strictEqual((await call('POST', '/api/billing/invoices', ADM(), { year: 2026, month: 13, ufValue: UF })).status, 400);
    const oct = await call('POST', '/api/billing/invoices', ADM(), { year: 2026, month: 10, ufValue: UF }); assert.strictEqual(oct.status, 201); assert.strictEqual(oct.body.packagesCount, 1);
    const list = await call('GET', '/api/billing/invoices', ADM()); assert.deepStrictEqual(list.body.map(i => [i.month, i.status, i.packagesCount]), [[10, 'ACTIVE', 1], [9, 'ACTIVE', 3], [8, 'ACTIVE', 2]]);
    const frozen = await call('GET', `/api/billing/superadmin-monthly-report?clientId=${GO()}&year=2026&month=9&ufValue=1`, ADM()); assert.strictEqual(frozen.body.billing.mode, 'INVOICED'); assert.strictEqual(frozen.body.uf.value, UF); assert.strictEqual(frozen.body.summary.totalPackages, 3);
    assert.strictEqual((await call('POST', `/api/billing/invoices/${created.body.id}/void`, ADM(), { reason: 'una razón válida' })).status, 409, 'septiembre no es la última');
    assert.strictEqual((await call('POST', `/api/billing/invoices/${oct.body.id}/void`, ADM(), { reason: 'x' })).status, 400);
    const v = await call('POST', `/api/billing/invoices/${oct.body.id}/void`, ADM(), { reason: 'prueba de anulación' }); assert.strictEqual(v.status, 200); assert.deepStrictEqual([v.body.status, v.body.releasedPackages], ['VOIDED', 1]);
    const list2 = await call('GET', '/api/billing/invoices', ADM()); assert.deepStrictEqual(list2.body.map(i => [i.month, i.status]), [[10, 'VOIDED'], [9, 'ACTIVE'], [8, 'ACTIVE']]);
    const logs = (await db.query('SELECT action, "userName", details FROM system_logs ORDER BY id')).rows; assert.deepStrictEqual(logs.map(l => l.action), ['BILLING_INVOICE_CREATED', 'BILLING_INVOICE_CREATED', 'BILLING_INVOICE_VOIDED']);
    assert.ok(logs.every(l => l.userName === 'Administrador Principal')); assert.match(logs[0].details, /2026-09/); assert.match(logs[2].details, /prueba de anulación/);
}, { needsPg: true });

t('C4 el mes en curso no se puede facturar por HTTP aunque sea el que sigue', async () => {
    need(); await resetDb(); seq = 0; const now = new Date(); const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 }; const p1 = await P({ created: `${prev.y}-${String(prev.m).padStart(2, '0')}-10 10:00:00` }); await P({ created: `${y}-${String(m).padStart(2, '0')}-02 10:00:00` });
    await bi.registerBaselineInvoice(await db.getClient(), { year: prev.y, month: prev.m, ufValue: UF, official: { packagesCount: 1 }, ledgerSelect: 'SELECT id FROM packages WHERE id = $2', ledgerParams: [p1], userId: 'adm', userName: 'A' });
    const r = await call('POST', '/api/billing/invoices', ADM(), { year: y, month: m, ufValue: UF }); assert.strictEqual(r.status, 409); assert.match(r.body.message, /aún no termina/);
}, { needsPg: true });

// ═════════════ ejecución ═════════════
(async () => {
    if (PGlite) {
        pg = new PGlite(); await pg.exec(SCHEMA); if (bi) for (const s of bi.BILLING_SCHEMA_SQL) await pg.exec(s); db = makeDb(pg);
        const dbPath = require.resolve(path.join(ROOT, 'db.js')); require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
        if (bi) {
            const app = express(); app.use(express.json()); app.use('/api/billing', require(path.join(ROOT, 'routes/billing.js')));
            server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); }); base = `http://127.0.0.1:${server.address().port}`;
        }
    }
    const log = console.log; let ok = 0, skipped = 0; const fails = [];
    for (const { name, fn, needsPg } of tests) {
        if (needsPg && !PGlite) { skipped++; log('OMITIDA ' + name + '   (falta @electric-sql/pglite)'); continue; }
        console.log = () => {};
        try { await fn(); ok++; console.log = log; log('OK    ' + name); }
        catch (e) { console.log = log; fails.push(name); log('FALLA ' + name + '\n      ' + String(e && e.message).split('\n').slice(0, 6).join('\n      ')); }
    }
    console.log = log;
    log(`\n${ok} de ${tests.length} pruebas OK` + (skipped ? ` · ${skipped} OMITIDAS (no cuentan como aprobadas: instala @electric-sql/pglite para correrlas)` : ''));
    if (server) server.close(); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(2); });
