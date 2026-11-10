#!/usr/bin/env node
'use strict';
/**
 * Registra la factura de REFERENCIA del Reporte de Cobro UF: una factura que ya se emitió ANTES de que existiera el botón «Facturar» (la de octubre 2026).
 * Con ella como punto de partida, el mes siguiente cobra lo suyo más los «rezagados» (envíos del mes de la referencia que se despacharon DESPUÉS de esa factura).
 *
 * Qué se anota como «cobrado en esa factura» (registro de envíos): los creados ese mes cuyo PRIMER despacho (EN_TRANSITO / En Tránsito / Asignado) fue hasta el corte
 * (la hora exacta en que se generó la factura) y hoy siguen cobrables, más los que ya estaban despachados al corte y se cancelaron DESPUÉS. Los que se despacharon
 * después del corte quedan fuera: son los rezagados. `assignedAt` no sirve (se sobrescribe al reasignar). Ajustes a mano: --exclude-ids / --include-ids.
 *
 * Siempre parte en SIMULACIÓN (no escribe nada; consultas de solo lectura) y muestra la conciliación contra lo facturado. Para escribir hay que agregar --apply
 * (crea las tablas de facturas si faltan, anota los envíos y guarda la factura, todo en una transacción).
 *
 * Uso (los números son de ejemplo; se copian de la factura emitida):
 *   node scripts/registerBaselineInvoice.js --year 2026 --month 10 --cutoff 2026-11-02T15:00:00Z --packages 1000 --created 1500 --without-process 500 \
 *        --uf 40000.00 --net 39867 --iva 7575 --gross 47442 [--doc 1234] [--invoiced-at 2026-11-02T15:00:00Z] [--apply]
 */
const billing = require('../services/billingInvoices');

const TZ = 'America/Santiago';
const DISPATCH_EVENTS = ['EN_TRANSITO', 'En Tránsito', 'Asignado', 'ASIGNADO'];

/** SELECT (columna id) de los envíos que la factura de referencia cobró. $2 inicio del mes, $3 fin del mes, $4 corte, $5 excluir (text[]), $6 incluir (text[]). */
const LEDGER_SELECT_SQL = `
    WITH bodega_user AS (SELECT id FROM users WHERE name = 'Bodega' OR name ILIKE '%bodega%' LIMIT 1),
    first_dispatch AS (
        SELECT e."packageId", MIN(e."timestamp") AS t
        FROM tracking_events e
        WHERE e.status IN (${DISPATCH_EVENTS.map((s) => `'${s}'`).join(', ')})
          AND e."packageId" IN (SELECT id FROM packages WHERE "createdAt" >= ($2::timestamp AT TIME ZONE '${TZ}') AND "createdAt" < ($3::timestamp AT TIME ZONE '${TZ}'))
        GROUP BY e."packageId"
    )
    SELECT p.id FROM packages p JOIN first_dispatch fd ON fd."packageId" = p.id
    WHERE p."createdAt" >= ($2::timestamp AT TIME ZONE '${TZ}') AND p."createdAt" < ($3::timestamp AT TIME ZONE '${TZ}')
      AND fd.t <= $4::timestamptz
      AND p.id <> ALL($5::text[])
      AND (
          NOT (p."driverId" = (SELECT id FROM bodega_user) OR p.status IN ('PENDIENTE', 'CANCELADO') OR p."driverId" IS NULL)
          OR (p.status = 'CANCELADO'
              AND NOT EXISTS (SELECT 1 FROM tracking_events c WHERE c."packageId" = p.id AND c.status IN ('Cancelado', 'CANCELADO') AND c."timestamp" <= $4::timestamptz)
              AND EXISTS (SELECT 1 FROM tracking_events c WHERE c."packageId" = p.id AND c.status IN ('Cancelado', 'CANCELADO') AND c."timestamp" > $4::timestamptz))
      )
    UNION
    SELECT id FROM packages WHERE id = ANY($6::text[])`;

const pad2 = (n) => String(n).padStart(2, '0');
// La consulta de arriba reserva $1 para el id de la factura; para leer (simulación) se corren los parámetros un lugar: $2→$1, $3→$2...
const readSql = (sql) => sql.replace(/\$(\d+)/g, (m, n) => `$${Number(n) - 1}`);
const LEDGER_READ_SQL = readSql(LEDGER_SELECT_SQL);

/** Simulación: cuántos envíos anotaría y cómo cuadra con lo facturado. Solo lectura. */
async function reconcile(q, { year, month, cutoff, excludeIds = [], includeIds = [], officialPackages }) {
    const start = `${year}-${pad2(month)}-01 00:00:00`;
    const nx = billing.nextMonthOf(year, month);
    const end = `${nx.year}-${pad2(nx.month)}-01 00:00:00`;
    const params = [start, end, cutoff, excludeIds, includeIds];
    const out = {};
    out.created = (await q(`SELECT COUNT(*)::int n FROM packages WHERE "createdAt" >= ($1::timestamp AT TIME ZONE '${TZ}') AND "createdAt" < ($2::timestamp AT TIME ZONE '${TZ}')`, [start, end]))[0].n;
    out.ledger = (await q(`SELECT COUNT(*)::int n FROM (${LEDGER_READ_SQL}) sel`, params))[0].n;
    out.billableNow = (await q(`WITH bodega_user AS (SELECT id FROM users WHERE name = 'Bodega' OR name ILIKE '%bodega%' LIMIT 1)
        SELECT COUNT(*)::int n FROM packages p WHERE p."createdAt" >= ($1::timestamp AT TIME ZONE '${TZ}') AND p."createdAt" < ($2::timestamp AT TIME ZONE '${TZ}')
          AND NOT (p."driverId" = (SELECT id FROM bodega_user) OR p.status IN ('PENDIENTE', 'CANCELADO') OR p."driverId" IS NULL)`, [start, end]))[0].n;
    out.ledgerAndBillableNow = (await q(`WITH bodega_user AS (SELECT id FROM users WHERE name = 'Bodega' OR name ILIKE '%bodega%' LIMIT 1)
        SELECT COUNT(*)::int n FROM packages p WHERE p.id IN (SELECT id FROM (${LEDGER_READ_SQL}) sel)
          AND NOT (p."driverId" = (SELECT id FROM bodega_user) OR p.status IN ('PENDIENTE', 'CANCELADO') OR p."driverId" IS NULL)`, params))[0].n;
    out.lateCarryOver = out.billableNow - out.ledgerAndBillableNow;   // cobrables hoy que la factura NO cobró: pasan a cobrarse en el mes siguiente
    out.cancelledAfterCutoffIncluded = out.ledger - out.ledgerAndBillableNow;
    out.officialPackages = officialPackages == null ? null : officialPackages;
    out.difference = officialPackages == null ? null : out.ledger - officialPackages;
    // envíos de la reconstrucción con otro despacho DESPUÉS del corte (puede que al corte estuvieran en bodega): se listan para revisarlos uno a uno
    out.redispatched = await q(`
        WITH ids AS (SELECT id FROM (${LEDGER_READ_SQL}) sel)
        SELECT e."packageId" AS id, COUNT(*)::int AS despachos_despues_del_corte
        FROM tracking_events e WHERE e."packageId" IN (SELECT id FROM ids) AND e.status IN (${DISPATCH_EVENTS.map((s) => `'${s}'`).join(', ')}) AND e."timestamp" > $3::timestamptz
        GROUP BY 1 ORDER BY 1 LIMIT 60`, params);
    return out;
}

const parseArgs = (argv) => {
    const a = {};
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const k = argv[i].slice(2);
        if (['apply', 'help'].includes(k)) a[k] = true; else a[k] = argv[++i];
    }
    return a;
};
const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);

async function main() {
    const a = parseArgs(process.argv.slice(2));
    const need = ['year', 'month', 'cutoff', 'packages', 'uf'];
    const missing = need.filter((k) => !a[k]);
    if (a.help || missing.length) {
        console.log('Faltan: ' + (missing.map((k) => '--' + k).join(' ') || '(nada)') + '\nVer el comentario al inicio de scripts/registerBaselineInvoice.js');
        process.exit(a.help ? 0 : 1);
    }
    const db = require('../db');
    const year = Number(a.year), month = Number(a.month), ufValue = Number(a.uf);
    const cutoff = new Date(a.cutoff).toISOString();
    const excludeIds = list(a['exclude-ids']), includeIds = list(a['include-ids']);
    const official = {
        packagesCount: Number(a.packages),
        totalCreated: a.created != null ? Number(a.created) : undefined,
        totalAssignedToBodega: a['without-process'] != null ? Number(a['without-process']) : undefined,
        netClp: a.net != null ? Number(a.net) : undefined, ivaClp: a.iva != null ? Number(a.iva) : undefined, grossClp: a.gross != null ? Number(a.gross) : undefined,
    };

    const ro = await db.getClient();
    try {
        await ro.query('BEGIN READ ONLY');
        const q = async (sql, p) => (await ro.query(sql, p)).rows;
        const r = await reconcile(q, { year, month, cutoff, excludeIds, includeIds, officialPackages: official.packagesCount });
        console.log(`\nSIMULACIÓN · factura de referencia ${billing.monthLabel(year, month)} · corte ${cutoff}`);
        console.log(`  envíos creados en el mes ................ ${r.created}`);
        console.log(`  cobrables hoy ........................... ${r.billableNow}`);
        console.log(`  se anotarían como cobrados en la factura  ${r.ledger}   (de ellos, hoy cobrables: ${r.ledgerAndBillableNow} · cancelados después del corte: ${r.cancelledAfterCutoffIncluded})`);
        console.log(`  facturado oficialmente .................. ${r.officialPackages}   → diferencia ${r.difference > 0 ? '+' : ''}${r.difference}`);
        console.log(`  REZAGADOS (cobrables hoy, no cobrados en esa factura; se cobran en ${billing.monthLabel(billing.nextMonthOf(year, month).year, billing.nextMonthOf(year, month).month)}): ${r.lateCarryOver}`);
        console.log(`  envíos anotados con otro despacho DESPUÉS del corte (revisar): ${r.redispatched.length}`);
        r.redispatched.forEach((x) => console.log(`     ${x.id}  (${x.despachos_despues_del_corte})`));
    } finally {
        try { await ro.query('ROLLBACK'); } catch (e) { /* solo lectura */ }
        ro.release();
    }
    if (!a.apply) { console.log('\nNo se escribió nada. Para registrar la factura de referencia agrega --apply.'); process.exit(0); }

    const client = await db.getClient();
    try {
        for (const statement of billing.BILLING_SCHEMA_SQL) await client.query(statement);   // idempotente
        const start = `${year}-${pad2(month)}-01 00:00:00`;
        const nx = billing.nextMonthOf(year, month);
        const end = `${nx.year}-${pad2(nx.month)}-01 00:00:00`;
        const res = await billing.registerBaselineInvoice(client, {
            year, month, ufValue, ufSource: a['uf-source'] || 'Factura emitida', invoicedAt: a['invoiced-at'] ? new Date(a['invoiced-at']) : new Date(cutoff), documentNumber: a.doc || null,
            notes: 'Factura de referencia registrada desde la emitida antes del botón «Facturar».', official,
            ledgerSelect: LEDGER_SELECT_SQL, ledgerParams: [start, end, cutoff, excludeIds, includeIds], userId: null, userName: 'Registro de referencia',
        });
        console.log('\nFactura de referencia REGISTRADA:', res);
    } finally {
        client.release();
    }
    process.exit(0);
}

module.exports = { LEDGER_SELECT_SQL, LEDGER_READ_SQL, readSql, reconcile };
if (require.main === module) main().catch((e) => { console.error('ERROR:', e.message); process.exit(2); });
