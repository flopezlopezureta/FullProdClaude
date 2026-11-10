'use strict';
/**
 * Facturación del «Reporte Mensual de Cobro UF» (solo el administrador principal).
 *
 * Problema que resuelve: el reporte se recalculaba en vivo con los envíos CREADOS en el mes que HOY están despachados. Un envío creado el 30-oct y despachado el 02-nov
 * no estaba en la factura de octubre (ya emitida) y tampoco entraba en noviembre (se creó en octubre): quedaba sin cobrar. Además, los totales de un mes ya facturado
 * cambiaban solos al reabrirlo.
 *
 * Regla nueva (cada envío se factura UNA sola vez):
 *   · «Facturar» guarda la factura del mes (montos, UF, tabla diaria, licencias) y anota en billing_invoice_packages cada envío cobrado en ella.
 *   · El mes siguiente cobra lo creado en ese mes que esté despachado MÁS los «rezagados»: envíos de meses anteriores ya despachados que ninguna factura cobró.
 *   · Un mes facturado se muestra congelado, tal como se facturó.
 *   · Solo se factura el mes que sigue a la última factura registrada y solo cuando ya terminó (hora de Santiago): así la cadena no tiene huecos ni dobles cobros.
 *   · La primera factura (la de referencia: octubre 2026, emitida antes de que existiera el botón) se registra con registerBaselineInvoice().
 *
 * Definición de «cobrado» (igual que siempre): el envío tiene conductor, el conductor no es «Bodega» y el estado no es PENDIENTE ni CANCELADO.
 */
const crypto = require('crypto');

const GO_DELIVERY_CLIENT_ID = 'user-ebe23460-0205-4e30-80b4-6d1ea42085b7';   // «Go Delivery Interno» = toda la plataforma
const RATE_PER_PACKAGE_UF = 0.00099667;
const TZ = 'America/Santiago';
const LOCK_KEY = 7340119;   // pg_advisory_xact_lock: serializa crear/anular facturas
const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const BILLING_SCHEMA_SQL = [
    `CREATE TABLE IF NOT EXISTS billing_invoices (
        id TEXT PRIMARY KEY,
        "clientId" TEXT NOT NULL,
        "periodYear" INTEGER NOT NULL,
        "periodMonth" INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        source TEXT NOT NULL DEFAULT 'BUTTON',
        "invoicedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "invoicedBy" TEXT,
        "invoicedByName" TEXT,
        "documentNumber" TEXT,
        notes TEXT,
        "ufValue" NUMERIC(14,4) NOT NULL,
        "ufDate" TEXT,
        "ufSource" TEXT,
        "ratePerPackageUf" NUMERIC(14,8) NOT NULL,
        "packagesCount" INTEGER NOT NULL,
        "packagesOfMonth" INTEGER NOT NULL DEFAULT 0,
        "packagesCarryOver" INTEGER NOT NULL DEFAULT 0,
        "dispatchNetClp" INTEGER,
        "dispatchIvaClp" INTEGER,
        "dispatchGrossClp" INTEGER,
        "licenseNetClp" INTEGER NOT NULL DEFAULT 0,
        "licenseIvaClp" INTEGER NOT NULL DEFAULT 0,
        "licenseGrossClp" INTEGER NOT NULL DEFAULT 0,
        "totalNetClp" INTEGER,
        "totalIvaClp" INTEGER,
        "totalGrossClp" INTEGER,
        snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        "voidedAt" TIMESTAMPTZ,
        "voidedBy" TEXT,
        "voidedByName" TEXT,
        "voidReason" TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_invoices_active_period ON billing_invoices ("clientId", "periodYear", "periodMonth") WHERE status = 'ACTIVE'`,
    // Un envío solo puede estar en UNA factura vigente (la clave primaria lo garantiza). Anular una factura borra sus filas y los envíos vuelven a quedar sin facturar.
    `CREATE TABLE IF NOT EXISTS billing_invoice_packages (
        "packageId" TEXT PRIMARY KEY,
        "invoiceId" TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_billing_invoice_packages_invoice ON billing_invoice_packages ("invoiceId")`,
];

class BillingError extends Error {
    constructor(status, message, extra) { super(message); this.name = 'BillingError'; this.status = status; this.extra = extra || null; }
}

// ───────────── fechas (todo en hora de Santiago) ─────────────
const pad2 = (n) => String(n).padStart(2, '0');
const monthKey = (y, m) => y * 12 + (m - 1);
const monthStartStr = (y, m) => `${y}-${pad2(m)}-01 00:00:00`;
const nextMonthOf = (y, m) => (m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 });
const monthLabel = (y, m) => `${MONTH_NAMES[m - 1]} ${y}`;
const firstDayLabel = (y, m) => `01-${pad2(m)}-${y}`;

function santiagoDateStr(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
/** ¿Ya pasó el último instante del mes (medianoche del día 1 del mes siguiente, hora de Santiago)? */
function isMonthClosed(year, month, now = new Date()) {
    const n = nextMonthOf(year, month);
    return santiagoDateStr(now) >= `${n.year}-${pad2(n.month)}-01`;
}

// ───────────── montos (idénticos a los que siempre calculó el reporte) ─────────────
function computeAmounts(packages, ufValue, rate = RATE_PER_PACKAGE_UF) {
    const costUf = packages * rate;
    const clp = ufValue ? costUf * ufValue : null;
    return {
        costUf: parseFloat(costUf.toFixed(8)),
        net: clp ? Math.round(clp) : null,
        iva: clp ? Math.round(clp * 0.19) : null,
        gross: clp ? Math.round(clp * 1.19) : null,
    };
}

// ───────────── SQL común ─────────────
const BODEGA_CTE = `bodega_user AS (SELECT id FROM users WHERE name = 'Bodega' OR name ILIKE '%bodega%' LIMIT 1)`;
const EXCLUDED_SQL = `(p."driverId" = (SELECT id FROM bodega_user) OR p.status IN ('PENDIENTE', 'CANCELADO') OR p."driverId" IS NULL)`;
const TSZ = (n) => `($${n}::timestamp AT TIME ZONE '${TZ}')`;
const CREATOR_SQL = (n) => `($${n}::text IS NULL OR p."creatorId" = $${n}::text)`;
const NOT_INVOICED_SQL = `NOT EXISTS (SELECT 1 FROM billing_invoice_packages l WHERE l."packageId" = p.id)`;

const DETAIL_SELECT = `
    p.id,
    COALESCE(p."meliOrderId", p."shopifyOrderId", p."wooOrderId", p."jumpsellerOrderId", p.id) as "orderId",
    p."trackingId",
    p."recipientName",
    p."recipientPhone",
    p."recipientAddress",
    p."recipientCommune",
    p.status,
    TO_CHAR(p."createdAt" AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI:SS') as "createdAt",
    TO_CHAR(p."updatedAt" AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI:SS') as "updatedAt",
    TO_CHAR(p."assignedAt" AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI:SS') as "assignedAt",
    p."driverId",
    u.name as "driverName",
    p."isReassigned",
    TO_CHAR(p."createdAt" AT TIME ZONE '${TZ}', 'YYYY-MM-DD') as "date"`;

// Modo EN VIVO / ARRASTRE: los creados en el mes, cobrados si hoy están despachados (la consulta de siempre).
const dailyLiveSql = () => `
    WITH ${BODEGA_CTE}
    SELECT DATE(p."createdAt" AT TIME ZONE '${TZ}') as date,
        COUNT(*) as total_created,
        COUNT(*) FILTER (WHERE ${EXCLUDED_SQL}) as assigned_to_bodega,
        COUNT(*) FILTER (WHERE p."isReassigned" = true) as total_reassigned,
        COUNT(*) - COUNT(*) FILTER (WHERE ${EXCLUDED_SQL}) as net_dispatched
    FROM packages p
    WHERE p."createdAt" >= ${TSZ(1)} AND p."createdAt" < ${TSZ(2)} AND ${CREATOR_SQL(3)}
    GROUP BY DATE(p."createdAt" AT TIME ZONE '${TZ}')
    ORDER BY date ASC`;

// Modo FACTURADO: cobrados = los que están en el registro de esa factura.
const dailyInvoicedSql = () => `
    SELECT TO_CHAR(DATE(p."createdAt" AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') as date_str,
        COUNT(*) as total_created,
        COUNT(*) FILTER (WHERE l."packageId" IS NULL) as assigned_to_bodega,
        COUNT(*) FILTER (WHERE p."isReassigned" = true) as total_reassigned,
        COUNT(*) FILTER (WHERE l."packageId" IS NOT NULL) as net_dispatched
    FROM packages p
    LEFT JOIN billing_invoice_packages l ON l."packageId" = p.id AND l."invoiceId" = $4
    WHERE p."createdAt" >= ${TSZ(1)} AND p."createdAt" < ${TSZ(2)} AND ${CREATOR_SQL(3)}
    GROUP BY 1
    ORDER BY 1`;

// Rezagados vivos: de meses anteriores (desde la primera factura registrada), hoy despachados y sin factura.
const carryOverLiveSql = () => `
    WITH ${BODEGA_CTE}
    SELECT TO_CHAR(DATE_TRUNC('month', p."createdAt" AT TIME ZONE '${TZ}'), 'YYYY-MM') as ym,
        COUNT(*)::int as n,
        (COUNT(*) FILTER (WHERE p."isReassigned" = true))::int as reassigned
    FROM packages p
    WHERE p."createdAt" >= ${TSZ(1)} AND p."createdAt" < ${TSZ(2)}
      AND NOT ${EXCLUDED_SQL}
      AND ${NOT_INVOICED_SQL}
      AND ${CREATOR_SQL(3)}
    GROUP BY 1 ORDER BY 1`;

// Rezagados de una factura ya emitida: sus envíos creados antes del mes facturado.
const carryOverInvoicedSql = () => `
    SELECT TO_CHAR(DATE_TRUNC('month', p."createdAt" AT TIME ZONE '${TZ}'), 'YYYY-MM') as ym,
        COUNT(*)::int as n,
        (COUNT(*) FILTER (WHERE p."isReassigned" = true))::int as reassigned
    FROM billing_invoice_packages l
    JOIN packages p ON p.id = l."packageId"
    WHERE l."invoiceId" = $1 AND p."createdAt" < ${TSZ(2)} AND ${CREATOR_SQL(3)}
    GROUP BY 1 ORDER BY 1`;

const detailLiveSql = () => `
    WITH ${BODEGA_CTE}
    SELECT ${DETAIL_SELECT},
        CASE WHEN ${EXCLUDED_SQL} THEN false ELSE true END as "isCharged",
        CASE
            WHEN p."driverId" = (SELECT id FROM bodega_user) THEN 'En Bodega'
            WHEN p.status = 'PENDIENTE' THEN 'Pendiente'
            WHEN p.status = 'CANCELADO' THEN 'Cancelado'
            WHEN p."driverId" IS NULL THEN 'Sin Conductor Asignado'
            ELSE ''
        END as "exclusionReason"
    FROM packages p
    LEFT JOIN users u ON p."driverId" = u.id
    WHERE p."createdAt" >= ${TSZ(1)} AND p."createdAt" < ${TSZ(2)} AND ${CREATOR_SQL(3)}
    ORDER BY p."createdAt" ASC`;

const detailInvoicedSql = () => `
    WITH ${BODEGA_CTE}
    SELECT ${DETAIL_SELECT},
        (l."packageId" IS NOT NULL) as "isCharged",
        CASE
            WHEN l."packageId" IS NOT NULL THEN ''
            WHEN p."driverId" = (SELECT id FROM bodega_user) THEN 'En Bodega'
            WHEN p.status = 'PENDIENTE' THEN 'Pendiente'
            WHEN p.status = 'CANCELADO' THEN 'Cancelado'
            WHEN p."driverId" IS NULL THEN 'Sin Conductor Asignado'
            ELSE 'Despachado después de facturar'
        END as "exclusionReason"
    FROM packages p
    LEFT JOIN users u ON p."driverId" = u.id
    LEFT JOIN billing_invoice_packages l ON l."packageId" = p.id AND l."invoiceId" = $4
    WHERE p."createdAt" >= ${TSZ(1)} AND p."createdAt" < ${TSZ(2)} AND ${CREATOR_SQL(3)}
    ORDER BY p."createdAt" ASC`;

const detailCarryOverLiveSql = () => `
    WITH ${BODEGA_CTE}
    SELECT ${DETAIL_SELECT}, true as "isCharged", '' as "exclusionReason"
    FROM packages p
    LEFT JOIN users u ON p."driverId" = u.id
    WHERE p."createdAt" >= ${TSZ(1)} AND p."createdAt" < ${TSZ(2)}
      AND NOT ${EXCLUDED_SQL}
      AND ${NOT_INVOICED_SQL}
      AND ${CREATOR_SQL(3)}
    ORDER BY p."createdAt" ASC`;

const detailCarryOverInvoicedSql = () => `
    SELECT ${DETAIL_SELECT}, true as "isCharged", '' as "exclusionReason"
    FROM billing_invoice_packages l
    JOIN packages p ON p.id = l."packageId"
    LEFT JOIN users u ON p."driverId" = u.id
    WHERE l."invoiceId" = $1 AND p."createdAt" < ${TSZ(2)} AND ${CREATOR_SQL(3)}
    ORDER BY p."createdAt" ASC`;

// Todo lo cobrable que ninguna factura ha cobrado, creado desde el inicio del registro hasta el fin del mes que se factura.
const ledgerInsertEligibleSql = () => `
    WITH ${BODEGA_CTE}
    INSERT INTO billing_invoice_packages ("packageId", "invoiceId")
    SELECT p.id, $1::text FROM packages p
    WHERE p."createdAt" >= ${TSZ(2)} AND p."createdAt" < ${TSZ(3)}
      AND NOT ${EXCLUDED_SQL}
      AND ${NOT_INVOICED_SQL}
    ON CONFLICT ("packageId") DO NOTHING`;

// ───────────── utilidades puras ─────────────
const dateKey = (row) => {
    if (row.date_str) return row.date_str;
    if (row.date instanceof Date) return row.date.toISOString().split('T')[0];
    return String(row.date).slice(0, 10);
};
const toInt = (v) => parseInt(v == null ? 0 : v, 10);
const toNum = (v) => (v == null ? null : Number(v));

function buildCarryOver(rows, ufValue, rate) {
    const byMonth = (rows || []).map((r) => {
        const [y, m] = String(r.ym).split('-').map(Number);
        return { year: y, month: m, label: monthLabel(y, m), count: toInt(r.n) };
    });
    const count = byMonth.reduce((a, r) => a + r.count, 0);
    const reassigned = (rows || []).reduce((a, r) => a + toInt(r.reassigned), 0);
    const costUf = count * rate;
    const costClp = ufValue ? costUf * ufValue : null;
    return { count, reassigned, costUf: parseFloat(costUf.toFixed(8)), costClp: costClp ? Math.round(costClp) : null, byMonth };
}

/** Resumen y tabla diaria a partir de las filas ya consultadas (misma matemática del reporte de siempre + los rezagados). */
function computeFigures({ rows, carryOverRows, ufValue, rate }) {
    let totalPackages = 0, totalCreated = 0, totalAssignedToBodega = 0, totalReassigned = 0;
    const dailyDetails = [];
    rows.forEach((row) => {
        const count = toInt(row.net_dispatched);
        const created = toInt(row.total_created);
        const bodega = toInt(row.assigned_to_bodega);
        const reassigned = toInt(row.total_reassigned);
        totalPackages += count; totalCreated += created; totalAssignedToBodega += bodega; totalReassigned += reassigned;
        const costUf = count * rate;
        const costClp = ufValue ? costUf * ufValue : null;
        dailyDetails.push({
            date: dateKey(row),
            totalCreated: created,
            assignedToBodega: bodega,
            reassignedCount: reassigned,
            packagesCount: count,
            costUf: parseFloat(costUf.toFixed(8)),
            costClp: costClp ? Math.round(costClp) : null,
        });
    });
    const carryOver = buildCarryOver(carryOverRows, ufValue, rate);
    const packagesOfMonth = totalPackages;
    totalPackages += carryOver.count;
    totalReassigned += carryOver.reassigned;
    const a = computeAmounts(totalPackages, ufValue, rate);
    return {
        dailyDetails,
        carryOver,
        summary: {
            totalCreated,
            totalAssignedToBodega,
            totalReassigned,
            totalPackages,
            packagesOfMonth,
            packagesCarryOver: carryOver.count,
            ratePerPackageUf: rate,
            totalCostUf: a.costUf,
            totalCostClpNet: a.net,
            ivaRate: 0.19,
            totalCostClpIva: a.iva,
            totalCostClpGross: a.gross,
        },
    };
}

/** Totales combinados (despachos + licencias) tal como los muestra y factura la pantalla. */
function combineTotals(summary, license) {
    const lic = license || {};
    return {
        net: (summary.totalCostClpNet || 0) + (lic.costClpNet || 0),
        iva: (summary.totalCostClpIva || 0) + (lic.costClpIva || 0),
        gross: (summary.totalCostClpGross || 0) + (lic.costClpGross || 0),
    };
}

/**
 * Modo del mes pedido según las facturas vigentes.
 *   INVOICED  → ya facturado (se muestra congelado)
 *   CARRYOVER → es el mes que sigue a la última factura: cobra lo del mes + los rezagados
 *   LIVE      → cualquier otro mes: cálculo en vivo de siempre (sin rezagados)
 */
function resolveMode(active, year, month) {
    const list = (active || []).map((i) => ({ id: i.id, year: toInt(i.periodYear), month: toInt(i.periodMonth) })).sort((a, b) => monthKey(a.year, a.month) - monthKey(b.year, b.month));
    const first = list.length ? { year: list[0].year, month: list[0].month } : null;
    const last = list.length ? { year: list[list.length - 1].year, month: list[list.length - 1].month } : null;
    const next = last ? nextMonthOf(last.year, last.month) : null;
    const found = list.find((i) => i.year === year && i.month === month);
    let mode = 'LIVE';
    if (found) mode = 'INVOICED';
    else if (next && monthKey(next.year, next.month) === monthKey(year, month)) mode = 'CARRYOVER';
    return { mode, invoiceId: found ? found.id : null, first, last, next, hasAnchor: list.length > 0 };
}

/** Estado de facturación que usa la pantalla para mostrar (o no) el botón «Facturar». */
function describeBilling({ ctx, year, month, isGlobal, now, invoice }) {
    const closed = isMonthClosed(year, month, now);
    const out = {
        mode: ctx.mode, isGlobalScope: !!isGlobal, hasAnchor: ctx.hasAnchor, monthClosed: closed,
        firstInvoiced: ctx.first, lastInvoiced: ctx.last, nextToInvoice: ctx.next,
        canInvoice: false, cannotInvoiceReason: null, canVoid: false,
        invoice: invoice ? publicInvoice(invoice) : null,
    };
    if (ctx.mode === 'INVOICED') {
        out.cannotInvoiceReason = 'Este mes ya está facturado.';
        out.canVoid = !!isGlobal && !!ctx.last && monthKey(ctx.last.year, ctx.last.month) === monthKey(year, month);
        return out;
    }
    if (!isGlobal) { out.cannotInvoiceReason = 'La factura se emite desde la vista «Go Delivery Interno» (toda la plataforma).'; return out; }
    if (!ctx.hasAnchor) { out.cannotInvoiceReason = 'Aún no hay una factura de referencia registrada en el sistema.'; return out; }
    if (ctx.mode === 'LIVE') {
        out.cannotInvoiceReason = monthKey(year, month) < monthKey(ctx.first.year, ctx.first.month)
            ? 'Este mes es anterior a las facturas registradas en el sistema (cálculo en vivo).'
            : `Antes hay que facturar ${monthLabel(ctx.next.year, ctx.next.month)}.`;
        return out;
    }
    if (!closed) {
        const n = nextMonthOf(year, month);
        out.cannotInvoiceReason = `El mes aún no termina: se podrá facturar desde el ${firstDayLabel(n.year, n.month)}.`;
        return out;
    }
    out.canInvoice = true;
    return out;
}

function publicInvoice(row, { withSnapshot = false } = {}) {
    if (!row) return null;
    const out = {
        id: row.id,
        clientId: row.clientId,
        year: toInt(row.periodYear),
        month: toInt(row.periodMonth),
        status: row.status,
        source: row.source,
        invoicedAt: row.invoicedAt instanceof Date ? row.invoicedAt.toISOString() : row.invoicedAt,
        invoicedBy: row.invoicedBy,
        invoicedByName: row.invoicedByName,
        documentNumber: row.documentNumber,
        notes: row.notes,
        ufValue: toNum(row.ufValue),
        ufDate: row.ufDate,
        ufSource: row.ufSource,
        ratePerPackageUf: toNum(row.ratePerPackageUf),
        packagesCount: toInt(row.packagesCount),
        packagesOfMonth: toInt(row.packagesOfMonth),
        packagesCarryOver: toInt(row.packagesCarryOver),
        dispatchNetClp: toNum(row.dispatchNetClp),
        dispatchIvaClp: toNum(row.dispatchIvaClp),
        dispatchGrossClp: toNum(row.dispatchGrossClp),
        licenseNetClp: toNum(row.licenseNetClp),
        licenseIvaClp: toNum(row.licenseIvaClp),
        licenseGrossClp: toNum(row.licenseGrossClp),
        totalNetClp: toNum(row.totalNetClp),
        totalIvaClp: toNum(row.totalIvaClp),
        totalGrossClp: toNum(row.totalGrossClp),
        voidedAt: row.voidedAt instanceof Date ? row.voidedAt.toISOString() : row.voidedAt,
        voidedByName: row.voidedByName,
        voidReason: row.voidReason,
    };
    if (withSnapshot) out.snapshot = row.snapshot;
    return out;
}

// ───────────── consultas ─────────────
async function listActiveInvoices(db) {
    try {
        const { rows } = await db.query(
            `SELECT id, "periodYear", "periodMonth" FROM billing_invoices WHERE "clientId" = $1 AND status = 'ACTIVE' ORDER BY "periodYear", "periodMonth"`,
            [GO_DELIVERY_CLIENT_ID]
        );
        return rows;
    } catch (err) {
        if (err && err.code === '42P01') return [];   // las tablas aún no existen: el reporte sigue funcionando como siempre
        throw err;
    }
}

async function getInvoice(db, id) {
    const { rows } = await db.query('SELECT * FROM billing_invoices WHERE id = $1', [id]);
    return rows[0] || null;
}

async function listInvoices(db) {
    const { rows } = await db.query(
        `SELECT id, "clientId", "periodYear", "periodMonth", status, source, "invoicedAt", "invoicedBy", "invoicedByName", "documentNumber", notes, "ufValue", "ufDate", "ufSource",
                "ratePerPackageUf", "packagesCount", "packagesOfMonth", "packagesCarryOver", "dispatchNetClp", "dispatchIvaClp", "dispatchGrossClp", "licenseNetClp", "licenseIvaClp",
                "licenseGrossClp", "totalNetClp", "totalIvaClp", "totalGrossClp", "voidedAt", "voidedByName", "voidReason"
         FROM billing_invoices WHERE "clientId" = $1 ORDER BY "periodYear" DESC, "periodMonth" DESC, "invoicedAt" DESC`,
        [GO_DELIVERY_CLIENT_ID]
    );
    return rows.map((r) => publicInvoice(r));
}

/** Cobro por licencias en exceso del mes (misma lógica que tenía la ruta). */
async function computeLicenseBilling(db, { startMonthStr, endMonthStr, ufValue }) {
    const { rows: settingsRows } = await db.query('SELECT "licenseLimit", "licenseOverageFee" FROM system_settings WHERE id = 1');
    const limit = settingsRows.length > 0 ? settingsRows[0].licenseLimit : 70;
    const overageFee = settingsRows.length > 0 ? parseFloat(settingsRows[0].licenseOverageFee || 0.1) : 0.1;

    const { rows: nonDriversRes } = await db.query(
        `SELECT role, COUNT(*)::int as count
         FROM users
         WHERE role NOT IN ('DRIVER', 'CONDUCTOR', 'CHOFER')
           AND status != 'ELIMINADO'
           AND email NOT IN ('admin', 'admin@admin.cl')
         GROUP BY role`
    );
    let nonDriversCount = 0;
    const rolesSummary = { ADMIN: 0, CLIENT: 0, DRIVER: 0, AUXILIAR: 0, OTHER: 0 };
    nonDriversRes.forEach((r) => {
        const role = String(r.role || '').toUpperCase();
        if (!['CLIENT', 'CLIENTE'].includes(role)) nonDriversCount += r.count;   // los clientes no cuentan para el total de licencias
        if (['ADMIN', 'ADMIN_SISTEMAS', 'ADMINISTRADOR'].includes(role)) rolesSummary.ADMIN += r.count;
        else if (['CLIENT', 'CLIENTE'].includes(role)) rolesSummary.CLIENT += r.count;
        else if (['AUXILIAR', 'AUX'].includes(role)) rolesSummary.AUXILIAR += r.count;
        else rolesSummary.OTHER += r.count;
    });

    const { rows: activeDriversRes } = await db.query(
        `SELECT COUNT(DISTINCT u.id)::int as count
         FROM users u
         WHERE u.role IN ('DRIVER', 'CONDUCTOR', 'CHOFER')
           AND u.status != 'ELIMINADO'
           AND u.email NOT IN ('admin', 'admin@admin.cl')
           AND EXISTS (
               SELECT 1 FROM packages p
               WHERE p."driverId" = u.id
                 AND (
                     (p."assignedAt" >= $1 AND p."assignedAt" < $2)
                     OR (p."updatedAt" >= $1 AND p."updatedAt" < $2 AND p.status IN ('ENTREGADO', 'DEVUELTO', 'EN_RUTA', 'ASIGNADO'))
                 )
           )`,
        [startMonthStr, endMonthStr]
    );
    const driversCount = activeDriversRes[0].count;
    rolesSummary.DRIVER = driversCount;

    const totalActiveCount = nonDriversCount + driversCount;
    const excessCount = Math.max(0, totalActiveCount - limit);
    const licenseCostUf = excessCount * overageFee;
    const licenseCostClpNet = ufValue ? Math.round(licenseCostUf * ufValue) : 0;
    return {
        limit,
        active: totalActiveCount,
        excess: excessCount,
        overageFee,
        costUf: licenseCostUf,
        costClpNet: licenseCostClpNet,
        costClpIva: Math.round(licenseCostClpNet * 0.19),
        costClpGross: Math.round(licenseCostClpNet * 1.19),
        rolesSummary,
    };
}

/**
 * Arma la respuesta completa del reporte de un mes (la que consume la pantalla).
 * Sin facturas registradas se comporta exactamente como antes.
 */
async function buildMonthlyReport(db, { clientId, year, month, ufValue, getUfValue, now = new Date() }) {
    year = parseInt(year, 10);
    month = parseInt(month, 10);
    const startMonthStr = monthStartStr(year, month);
    const nx = nextMonthOf(year, month);
    const endMonthStr = monthStartStr(nx.year, nx.month);
    const isGlobal = clientId === GO_DELIVERY_CLIENT_ID;
    const creator = isGlobal ? null : clientId;

    const active = await listActiveInvoices(db);
    const ctx = resolveMode(active, year, month);
    const invoice = ctx.mode === 'INVOICED' ? await getInvoice(db, ctx.invoiceId) : null;

    const { rows: clientRows } = await db.query('SELECT name, "companyName", email FROM users WHERE id = $1', [clientId]);
    const client = { id: clientId, name: clientRows.length > 0 ? clientRows[0].name : 'Cliente desconocido', companyName: clientRows.length > 0 ? clientRows[0].companyName : '' };
    const billing = describeBilling({ ctx, year, month, isGlobal, now, invoice });

    // Mes ya facturado → se muestra congelado.
    if (invoice) {
        const rate = toNum(invoice.ratePerPackageUf);
        const invUf = toNum(invoice.ufValue);
        const snap = invoice.snapshot || {};
        const uf = { date: invoice.ufDate || `${nx.year}-${pad2(nx.month)}-01`, value: invUf, source: `Factura registrada (${invoice.ufSource || 'UF guardada'})` };
        const base = { client, period: { year, month }, uf, billing };
        const detailParams = [startMonthStr, endMonthStr, creator];

        let figures;
        if (isGlobal && snap.summary && snap.dailyDetails) {
            figures = { summary: snap.summary, dailyDetails: snap.dailyDetails, carryOver: snap.carryOver || buildCarryOver([], invUf, rate) };   // la factura tal como se emitió
        } else {
            const { rows } = await db.query(dailyInvoicedSql(), [...detailParams, invoice.id]);
            const { rows: coRows } = await db.query(carryOverInvoicedSql(), [invoice.id, startMonthStr, creator]);
            figures = computeFigures({ rows, carryOverRows: coRows, ufValue: invUf, rate });
        }
        const { rows: detailRows } = await db.query(detailInvoicedSql(), [...detailParams, invoice.id]);
        const { rows: coDetail } = await db.query(detailCarryOverInvoicedSql(), [invoice.id, startMonthStr, creator]);
        coDetail.forEach((r) => { r.carryOver = true; });
        const license = snap.licenseBilling || (await computeLicenseBilling(db, { startMonthStr, endMonthStr, ufValue: invUf }));
        return { ...base, summary: figures.summary, dailyDetails: figures.dailyDetails, carryOver: figures.carryOver, packagesDetail: detailRows.concat(coDetail), licenseBilling: license };
    }

    // UF del 1º del mes siguiente (a mano o desde mindicador.cl)
    let finalUfValue = ufValue ? parseFloat(ufValue) : null;
    let ufSource = 'Manual';
    if (!finalUfValue) {
        finalUfValue = await getUfValue(`01-${pad2(nx.month)}-${nx.year}`);
        ufSource = 'API (mindicador.cl)';
    }

    const { rows } = await db.query(dailyLiveSql(), [startMonthStr, endMonthStr, creator]);
    let carryOverRows = [];
    let carryDetail = [];
    if (ctx.mode === 'CARRYOVER') {
        const epochStr = monthStartStr(ctx.first.year, ctx.first.month);
        carryOverRows = (await db.query(carryOverLiveSql(), [epochStr, startMonthStr, creator])).rows;
        carryDetail = (await db.query(detailCarryOverLiveSql(), [epochStr, startMonthStr, creator])).rows;
        carryDetail.forEach((r) => { r.carryOver = true; });
    }
    const figures = computeFigures({ rows, carryOverRows, ufValue: finalUfValue, rate: RATE_PER_PACKAGE_UF });
    const { rows: detailRows } = await db.query(detailLiveSql(), [startMonthStr, endMonthStr, creator]);
    const licenseBilling = await computeLicenseBilling(db, { startMonthStr, endMonthStr, ufValue: finalUfValue });

    return {
        client,
        period: { year, month },
        uf: { date: `${nx.year}-${pad2(nx.month)}-01`, value: finalUfValue, source: ufSource },
        billing,
        summary: figures.summary,
        carryOver: figures.carryOver,
        dailyDetails: figures.dailyDetails,
        packagesDetail: detailRows.concat(carryDetail),
        licenseBilling,
    };
}

// ───────────── facturar / anular ─────────────
function validateInvoiceInput(input) {
    const year = Number(input.year), month = Number(input.month), ufValue = Number(input.ufValue);
    if (!Number.isInteger(year) || year < 2024 || year > 2100) throw new BillingError(400, 'Año inválido.');
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new BillingError(400, 'Mes inválido.');
    if (!Number.isFinite(ufValue) || ufValue <= 0) throw new BillingError(400, 'Falta el valor de la UF del 1º del mes siguiente.');
    const documentNumber = input.documentNumber == null ? null : String(input.documentNumber).trim().slice(0, 60) || null;
    const notes = input.notes == null ? null : String(input.notes).trim().slice(0, 500) || null;
    const exp = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    const expectedPackages = exp(input.expectedPackages), expectedGrossClp = exp(input.expectedGrossClp);
    if ((expectedPackages !== null && !Number.isFinite(expectedPackages)) || (expectedGrossClp !== null && !Number.isFinite(expectedGrossClp))) throw new BillingError(400, 'Los valores esperados no son válidos.');
    return { year, month, ufValue, documentNumber, notes, expectedPackages, expectedGrossClp, ufSource: input.ufSource ? String(input.ufSource).slice(0, 80) : 'Manual' };
}

async function insertInvoiceRow(client, { id, year, month, source, invoicedAt, userId, userName, documentNumber, notes, ufValue, ufDate, ufSource, rate, summary, license, snapshot }) {
    const total = combineTotals(summary, license);
    await client.query(
        `INSERT INTO billing_invoices (id, "clientId", "periodYear", "periodMonth", status, source, "invoicedAt", "invoicedBy", "invoicedByName", "documentNumber", notes,
            "ufValue", "ufDate", "ufSource", "ratePerPackageUf", "packagesCount", "packagesOfMonth", "packagesCarryOver",
            "dispatchNetClp", "dispatchIvaClp", "dispatchGrossClp", "licenseNetClp", "licenseIvaClp", "licenseGrossClp", "totalNetClp", "totalIvaClp", "totalGrossClp", snapshot)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5, COALESCE($6::timestamptz, CURRENT_TIMESTAMP), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb)`,
        [id, GO_DELIVERY_CLIENT_ID, year, month, source, invoicedAt || null, userId || null, userName || null, documentNumber || null, notes || null,
            ufValue, ufDate || null, ufSource || null, rate, summary.totalPackages, summary.packagesOfMonth || 0, summary.packagesCarryOver || 0,
            summary.totalCostClpNet || 0, summary.totalCostClpIva || 0, summary.totalCostClpGross || 0, license.costClpNet || 0, license.costClpIva || 0, license.costClpGross || 0,
            total.net, total.iva, total.gross, JSON.stringify(snapshot)]
    );
    return total;
}

/** Figuras de una factura recién anotada: se leen del registro de envíos (lo que quedó guardado) y no de una consulta aparte. */
async function ledgerFigures(client, { invoiceId, startMonthStr, endMonthStr, ufValue, rate }) {
    const { rows } = await client.query(dailyInvoicedSql(), [startMonthStr, endMonthStr, null, invoiceId]);
    const { rows: coRows } = await client.query(carryOverInvoicedSql(), [invoiceId, startMonthStr, null]);
    return computeFigures({ rows, carryOverRows: coRows, ufValue, rate });
}

/**
 * Factura el mes pedido (el que sigue a la última factura registrada y que ya terminó). Todo en una transacción:
 * anota los envíos cobrados, guarda los montos y compara con lo que vio la persona en pantalla.
 */
async function createInvoice(client, rawInput, { userId, userName, now = new Date() } = {}) {
    const input = validateInvoiceInput(rawInput);
    const { year, month, ufValue } = input;
    const startMonthStr = monthStartStr(year, month);
    const nx = nextMonthOf(year, month);
    const endMonthStr = monthStartStr(nx.year, nx.month);
    await client.query('BEGIN');
    try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const active = await listActiveInvoices(client);
        const ctx = resolveMode(active, year, month);
        if (ctx.mode === 'INVOICED') throw new BillingError(409, `${monthLabel(year, month)} ya está facturado.`);
        if (!ctx.hasAnchor) throw new BillingError(409, 'Aún no hay una factura de referencia registrada en el sistema; no se puede encadenar una factura nueva.');
        if (ctx.mode !== 'CARRYOVER') {
            throw new BillingError(409, monthKey(year, month) < monthKey(ctx.first.year, ctx.first.month)
                ? `${monthLabel(year, month)} es anterior a las facturas registradas en el sistema.`
                : `Antes hay que facturar ${monthLabel(ctx.next.year, ctx.next.month)}.`);
        }
        if (!isMonthClosed(year, month, now)) throw new BillingError(409, `${monthLabel(year, month)} aún no termina: se puede facturar desde el ${firstDayLabel(nx.year, nx.month)}.`);

        const invoiceId = `inv-${crypto.randomUUID()}`;
        const epochStr = monthStartStr(ctx.first.year, ctx.first.month);
        await client.query(ledgerInsertEligibleSql(), [invoiceId, epochStr, endMonthStr]);
        const figures = await ledgerFigures(client, { invoiceId, startMonthStr, endMonthStr, ufValue, rate: RATE_PER_PACKAGE_UF });
        if (figures.summary.totalPackages <= 0) throw new BillingError(409, `No hay envíos por facturar en ${monthLabel(year, month)}.`);
        const license = await computeLicenseBilling(client, { startMonthStr, endMonthStr, ufValue });
        const total = combineTotals(figures.summary, license);

        if ((input.expectedPackages !== null && input.expectedPackages !== figures.summary.totalPackages) || (input.expectedGrossClp !== null && input.expectedGrossClp !== total.gross)) {
            throw new BillingError(409, 'Los números cambiaron mientras confirmabas (se despacharon o cambiaron envíos). Revisa los valores nuevos y vuelve a confirmar.',
                { fresh: { packages: figures.summary.totalPackages, grossClp: total.gross } });
        }
        await insertInvoiceRow(client, {
            id: invoiceId, year, month, source: 'BUTTON', userId, userName, documentNumber: input.documentNumber, notes: input.notes,
            ufValue, ufDate: `${nx.year}-${pad2(nx.month)}-01`, ufSource: input.ufSource, rate: RATE_PER_PACKAGE_UF, summary: figures.summary, license,
            snapshot: { summary: figures.summary, dailyDetails: figures.dailyDetails, carryOver: figures.carryOver, licenseBilling: license },
        });
        await client.query('COMMIT');
        const { rows } = await client.query('SELECT * FROM billing_invoices WHERE id = $1', [invoiceId]);
        return publicInvoice(rows[0]);
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* la conexión ya cerró la transacción */ }
        if (err && err.code === '23505') throw new BillingError(409, `${monthLabel(year, month)} ya está facturado.`);
        throw err;
    }
}

/** Anula la ÚLTIMA factura registrada: sus envíos vuelven a quedar sin facturar (y se cobrarán en la siguiente). */
async function voidInvoice(client, invoiceId, { reason, userId, userName } = {}) {
    const why = String(reason || '').trim();
    if (why.length < 5) throw new BillingError(400, 'Escribe el motivo de la anulación (mínimo 5 letras).');
    await client.query('BEGIN');
    try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const { rows } = await client.query('SELECT id, "periodYear", "periodMonth", status FROM billing_invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
        if (!rows.length) throw new BillingError(404, 'Factura no encontrada.');
        const inv = rows[0];
        if (inv.status !== 'ACTIVE') throw new BillingError(409, 'Esa factura ya estaba anulada.');
        const active = await listActiveInvoices(client);
        const ctx = resolveMode(active, toInt(inv.periodYear), toInt(inv.periodMonth));
        if (!ctx.last || monthKey(ctx.last.year, ctx.last.month) !== monthKey(toInt(inv.periodYear), toInt(inv.periodMonth))) {
            throw new BillingError(409, `Solo se puede anular la última factura registrada (${ctx.last ? monthLabel(ctx.last.year, ctx.last.month) : '—'}).`);
        }
        const del = await client.query('DELETE FROM billing_invoice_packages WHERE "invoiceId" = $1', [invoiceId]);
        await client.query(
            `UPDATE billing_invoices SET status = 'VOIDED', "voidedAt" = CURRENT_TIMESTAMP, "voidedBy" = $2, "voidedByName" = $3, "voidReason" = $4 WHERE id = $1`,
            [invoiceId, userId || null, userName || null, why]
        );
        await client.query('COMMIT');
        return { id: invoiceId, status: 'VOIDED', releasedPackages: del.rowCount == null ? null : del.rowCount };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* idem */ }
        throw err;
    }
}

/**
 * Registra una factura YA EMITIDA antes de que existiera el botón (la de referencia). Los montos oficiales son los de la factura real
 * (`official`: lo que se imprimió) y el registro de envíos sale de `ledgerSelect`: un SELECT que devuelve la columna `id` de los envíos que esa factura cobró
 * (sus parámetros empiezan en $2: $1 queda reservado para el id de la factura).
 */
async function registerBaselineInvoice(client, { year, month, ufValue, ufDate, ufSource, invoicedAt, documentNumber, notes, official, ledgerSelect, ledgerParams = [], userId, userName }) {
    const startMonthStr = monthStartStr(year, month);
    const nx = nextMonthOf(year, month);
    const endMonthStr = monthStartStr(nx.year, nx.month);
    await client.query('BEGIN');
    try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
        const active = await listActiveInvoices(client);
        if (active.some((i) => toInt(i.periodYear) === year && toInt(i.periodMonth) === month)) throw new BillingError(409, `${monthLabel(year, month)} ya tiene una factura vigente.`);
        const invoiceId = `inv-${crypto.randomUUID()}`;
        await client.query(`INSERT INTO billing_invoice_packages ("packageId", "invoiceId") SELECT sel.id, $1::text FROM (${ledgerSelect}) sel ON CONFLICT ("packageId") DO NOTHING`, [invoiceId, ...ledgerParams]);
        const figures = await ledgerFigures(client, { invoiceId, startMonthStr, endMonthStr, ufValue, rate: RATE_PER_PACKAGE_UF });
        const license = official.licenseBilling || { limit: null, active: null, excess: 0, overageFee: null, costUf: 0, costClpNet: 0, costClpIva: 0, costClpGross: 0, rolesSummary: null };
        // Lo oficial manda (es lo que se facturó); el detalle por envío es la reconstrucción.
        const amounts = computeAmounts(official.packagesCount, ufValue, RATE_PER_PACKAGE_UF);
        const summary = {
            ...figures.summary,
            totalCreated: official.totalCreated != null ? official.totalCreated : figures.summary.totalCreated,
            totalAssignedToBodega: official.totalAssignedToBodega != null ? official.totalAssignedToBodega : figures.summary.totalAssignedToBodega,
            totalPackages: official.packagesCount,
            packagesOfMonth: official.packagesCount,
            packagesCarryOver: 0,
            totalCostUf: amounts.costUf,
            totalCostClpNet: official.netClp != null ? official.netClp : amounts.net,
            totalCostClpIva: official.ivaClp != null ? official.ivaClp : amounts.iva,
            totalCostClpGross: official.grossClp != null ? official.grossClp : amounts.gross,
        };
        await insertInvoiceRow(client, {
            id: invoiceId, year, month, source: 'BASELINE', invoicedAt, userId, userName, documentNumber, notes, ufValue, ufDate: ufDate || `${nx.year}-${pad2(nx.month)}-01`, ufSource,
            rate: RATE_PER_PACKAGE_UF, summary, license,
            snapshot: { summary, dailyDetails: figures.dailyDetails, carryOver: figures.carryOver, licenseBilling: license, reconstructedPackages: figures.summary.totalPackages },
        });
        await client.query('COMMIT');
        return { id: invoiceId, reconstructedPackages: figures.summary.totalPackages, officialPackages: official.packagesCount };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* idem */ }
        throw err;
    }
}

module.exports = {
    GO_DELIVERY_CLIENT_ID, RATE_PER_PACKAGE_UF, TZ, BILLING_SCHEMA_SQL, BillingError,
    monthKey, monthStartStr, nextMonthOf, monthLabel, isMonthClosed, santiagoDateStr,
    computeAmounts, computeFigures, combineTotals, buildCarryOver, resolveMode, describeBilling, publicInvoice,
    listActiveInvoices, getInvoice, listInvoices, computeLicenseBilling, buildMonthlyReport,
    createInvoice, voidInvoice, registerBaselineInvoice,
    _sql: { dailyLiveSql, dailyInvoicedSql, carryOverLiveSql, carryOverInvoicedSql, detailLiveSql, detailInvoicedSql, ledgerInsertEligibleSql },
};
