const db = require('../db');
const dm = require('./driverMetrics');

// Informe de rendimiento por conductor para un rango de días lógicos (ver driverMetrics.js).
// Mezcla dos fuentes a propósito:
//  - paquetes ASIGNADOS en el período (por assignedAt) para volumen, tasa de entrega e incidencias,
//    igual que el Centro de Control, y
//  - entregas por su hora REAL de entrega para ritmo (min por entrega, horas en ruta, horarios) y
//    para el cruce del cierre en la app vs el cierre detectado de Mercado Libre.

const TOP_COMMUNES = 8;
const TOP_REASONS = 6;
// Cierres que NO registró el conductor desde la app (red de seguridad del servidor / correcciones
// manuales): se cuentan aparte y no se usan para la hora promedio de cierre.
const SYSTEM_CLOSURE_NOTE_PREFIXES = ['Cierre completado por la red de seguridad', 'Cierre corregido'];

function eachDate(startDate, endDate) {
    const out = [];
    const d = new Date(`${startDate}T12:00:00Z`);
    const last = new Date(`${endDate}T12:00:00Z`);
    while (d <= last) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
    return out;
}

// Promedia horas del día: las de madrugada (antes del corte del día lógico) se suman a 24h para que
// 22:00 y 00:30 promedien 23:15 y no 11:15.
function avgTimeOfDay(dates, tz) {
    if (!dates.length) return null;
    const mins = dates.map(dt => {
        const m = dm.minutesOfDay(dt, tz);
        return m < dm.LOGICAL_DAY_CUTOFF_HOURS * 60 ? m + 1440 : m;
    });
    return dm.minutesToHM(dm.mean(mins) % 1440);
}

function normalizeReason(details) {
    let r = String(details || '').replace(/^\s*problema reportado:\s*/i, '').replace(/\s+/g, ' ').trim();
    if (!r) return 'Sin motivo registrado';
    if (/no entregado en mercado libre/i.test(r)) return 'No entregado (marcado en Mercado Libre)';
    r = r.charAt(0).toUpperCase() + r.slice(1);
    return r.length > 70 ? `${r.slice(0, 67)}…` : r;
}

async function fetchAssigned(start, end, tz, driverIds) {
    const params = [start, end, tz];
    let driverClause = '';
    if (driverIds) { params.push(driverIds); driverClause = 'AND p."driverId" = ANY($4::text[])'; }
    const { rows } = await db.query(
        `SELECT p."driverId", u.name AS "driverName", u.phone AS "driverPhone",
                TO_CHAR(timezone($3, p."assignedAt") - INTERVAL '${dm.LOGICAL_DAY_CUTOFF_HOURS} hours', 'YYYY-MM-DD') AS d,
                COUNT(*)::int AS assigned,
                COUNT(*) FILTER (WHERE p.status = 'ENTREGADO')::int AS delivered,
                COUNT(*) FILTER (WHERE p.status = 'PROBLEMA')::int AS "problemOpen",
                COUNT(*) FILTER (WHERE p.status = 'CANCELADO')::int AS cancelled,
                COUNT(*) FILTER (WHERE p.status IN ('DEVUELTO', 'REPROGRAMADO'))::int AS returned,
                COUNT(*) FILTER (WHERE p.status IN ('PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO'))::int AS pending,
                -- pg_column_size no descarga las fotos (solo mira el tamaño guardado): rápido incluso con base64 pesado
                COUNT(*) FILTER (WHERE p.status = 'ENTREGADO' AND pg_column_size(p."deliveryPhotosBase64") > 1000)::int AS "withPhoto",
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM tracking_events te WHERE te."packageId" = p.id AND UPPER(te.status) = 'PROBLEMA'))::int AS "hadProblem"
         FROM packages p
         JOIN users u ON u.id = p."driverId"
         WHERE u.role = 'DRIVER' AND u.name NOT ILIKE '%bodega%'
           AND p."assignedAt" >= $1::timestamptz AND p."assignedAt" < $2::timestamptz
           ${driverClause}
         GROUP BY p."driverId", u.name, u.phone, d`,
        params
    );
    return rows;
}

async function fetchReasons(start, end, driverIds) {
    const params = [start, end];
    let driverClause = '';
    if (driverIds) { params.push(driverIds); driverClause = 'AND p."driverId" = ANY($3::text[])'; }
    const { rows } = await db.query(
        `SELECT p."driverId", te.details, COUNT(*)::int AS n
         FROM packages p
         JOIN tracking_events te ON te."packageId" = p.id AND UPPER(te.status) = 'PROBLEMA'
         WHERE p."driverId" IS NOT NULL AND p."assignedAt" >= $1::timestamptz AND p."assignedAt" < $2::timestamptz
           ${driverClause}
         GROUP BY p."driverId", te.details`,
        params
    );
    return rows;
}

async function fetchClosures(startDate, endDate, driverIds) {
    const params = [startDate, endDate];
    let driverClause = '';
    if (driverIds) { params.push(driverIds); driverClause = 'AND dc."driverId" = ANY($3::text[])'; }
    const { rows } = await db.query(
        `SELECT dc."driverId", TO_CHAR(dc.date, 'YYYY-MM-DD') AS d, dc."closedAt", dc.notes
         FROM daily_closures dc
         WHERE dc.date >= $1::date AND dc.date <= $2::date ${driverClause}`,
        params
    );
    return rows;
}

const pct = (num, den, d = 1) => den > 0 ? dm.round(num / den * 100, d) : null;

function summarizeDriver(d, allDates, tz, hourFmt) {
    const byDay = dm.groupBy(d.deliveries, r => r.logicalDate);
    const analysis = {};
    Object.entries(byDay).forEach(([date, rows]) => { analysis[date] = dm.analyzeDay(rows); });

    const empty = { assigned: 0, delivered: 0, hadProblem: 0, problemOpen: 0, cancelled: 0, returned: 0, pending: 0, withPhoto: 0 };
    const dates = allDates.filter(dt => d.assigned.has(dt) || analysis[dt]);
    const daily = dates.map(date => {
        const a = d.assigned.get(date) || empty;
        const an = analysis[date] || null;
        return {
            date,
            assigned: a.assigned, delivered: a.delivered, hadProblem: a.hadProblem, cancelled: a.cancelled,
            returned: a.returned, pending: a.pending,
            deliveryRate: pct(a.delivered, a.assigned),
            deliveredCount: an ? an.deliveredCount : 0,
            firstActivity: an ? dm.fmtHM(an.firstAt, tz) : null,
            lastActivity: an ? dm.fmtHM(an.lastAt, tz) : null,
            hoursActive: an ? an.hoursActive : null,
            avgMinutesPerDelivery: an && an.paceReliable ? an.avgMinutesPerDelivery : null,
            paceReliable: an ? an.paceReliable : false,
            mlCount: an ? an.mlCount : 0,
            avgMlDelayMin: an ? an.avgMlDelayMin : null,
            lateShare: an ? an.lateShare : null,
            maxBurst: an ? an.maxBurst : 0,
            burstAt: an ? dm.fmtHM(an.burstAt, tz) : null,
            closureProfile: an ? an.closureProfile : 'NO_DATA'
        };
    });

    // --- Totales de volumen (paquetes asignados en el período)
    const sum = (k) => [...d.assigned.values()].reduce((s, r) => s + r[k], 0);
    const assigned = sum('assigned'), delivered = sum('delivered');
    const daysWorked = [...d.assigned.values()].filter(r => r.assigned > 0).length || daily.filter(x => x.deliveredCount > 0).length;
    const dayDeliveries = daily.filter(x => x.assigned > 0);
    const best = dayDeliveries.length ? dayDeliveries.reduce((a, b) => b.delivered > a.delivered ? b : a) : null;
    const worst = dayDeliveries.length ? dayDeliveries.reduce((a, b) => b.delivered < a.delivered ? b : a) : null;

    // --- Ritmo (solo días comparables: sin cierre masivo y con >=3 entregas)
    const reliable = Object.entries(analysis).filter(([, a]) => a.paceReliable);
    const reliableRows = d.deliveries.filter(r => analysis[r.logicalDate] && analysis[r.logicalDate].paceReliable);
    const spanSum = reliable.reduce((s, [, a]) => s + a.spanMinutes, 0);
    const gapCount = reliable.reduce((s, [, a]) => s + (a.deliveredCount - 1), 0);
    const hoursSum = reliable.reduce((s, [, a]) => s + a.hoursActive, 0);
    const reliableDeliveries = reliable.reduce((s, [, a]) => s + a.deliveredCount, 0);
    const byHour = Array.from({ length: 24 }, () => 0);
    reliableRows.forEach(r => { byHour[Number(hourFmt.format(r.appAt)) % 24] += 1; });

    // --- Cierre en la app vs Mercado Libre (todos los días con datos)
    const days = Object.values(analysis);
    const mlDeliveries = days.reduce((s, a) => s + a.mlCount, 0);
    const lateCount = days.reduce((s, a) => s + a.lateCount, 0);
    const delaySum = days.reduce((s, a) => s + (a.mlDelaySumMin || 0), 0);
    const profileDays = (p) => days.filter(a => a.closureProfile === p).length;
    const isSystem = (n) => SYSTEM_CLOSURE_NOTE_PREFIXES.some(p => String(n || '').startsWith(p));
    const appClosures = d.closures.filter(c => !isSystem(c.notes));

    // --- Comunas y origen
    const communeGroups = dm.groupBy(d.deliveries, r => r.communeKey);
    const byCommune = Object.values(communeGroups).map(list => {
        const names = dm.groupBy(list, r => r.commune);
        return { commune: Object.entries(names).sort((a, b) => b[1].length - a[1].length)[0][0], count: list.length };
    }).sort((a, b) => b.count - a.count).slice(0, TOP_COMMUNES);
    const mix = Object.entries(dm.groupBy(d.deliveries, r => r.source || 'OTRO')).map(([source, list]) => ({ source, count: list.length })).sort((a, b) => b.count - a.count);

    // --- Motivos de incidencia
    const reasonList = [...d.reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
    const problemReasons = reasonList.slice(0, TOP_REASONS);
    const otherReasons = reasonList.slice(TOP_REASONS).reduce((s, r) => s + r.count, 0);
    if (otherReasons > 0) problemReasons.push({ reason: 'Otros motivos', count: otherReasons });

    return {
        driverId: d.driverId, driverName: d.driverName, phone: d.phone,
        totals: {
            daysWorked, assigned, delivered,
            pending: sum('pending'), cancelled: sum('cancelled'), returned: sum('returned'),
            problemOpen: sum('problemOpen'),
            problemPackages: sum('hadProblem'),
            deliveryRate: pct(delivered, assigned),
            incidentRate: pct(sum('hadProblem'), assigned),
            photoRate: pct(sum('withPhoto'), delivered),
            avgDeliveriesPerDay: daysWorked ? dm.round(delivered / daysWorked, 1) : null,
            bestDay: best ? { date: best.date, delivered: best.delivered } : null,
            worstDay: worst ? { date: worst.date, delivered: worst.delivered } : null
        },
        pace: {
            reliableDays: reliable.length,
            avgMinutesPerDelivery: gapCount > 0 ? dm.round(spanSum / gapCount, 1) : null,
            avgHoursActive: reliable.length ? dm.round(hoursSum / reliable.length, 2) : null,
            avgStart: avgTimeOfDay(reliable.map(([, a]) => a.firstAt), tz),
            avgEnd: avgTimeOfDay(reliable.map(([, a]) => a.lastAt), tz),
            deliveriesPerActiveHour: hoursSum > 0 ? dm.round(reliableDeliveries / hoursSum, 1) : null
        },
        closure: {
            mlDeliveries,
            avgMlDelayMin: mlDeliveries ? dm.round(delaySum / mlDeliveries, 0) : null,
            lateShare: mlDeliveries ? dm.round(lateCount / mlDeliveries, 3) : null,
            lateCount,
            daysOnTime: profileDays('ON_TIME'), daysDelayed: profileDays('DELAYED'),
            daysEndOfDay: profileDays('END_OF_DAY'), daysNoData: profileDays('NO_DATA'),
            appClosureDays: appClosures.length,
            systemClosureDays: d.closures.length - appClosures.length,
            avgClosureTime: avgTimeOfDay(appClosures.map(c => new Date(c.closedAt)), tz)
        },
        mix, byCommune, byHour, problemReasons, daily
    };
}

async function buildPerformanceReport({ startDate, endDate, start, end, tz, driverIds }) {
    const filter = driverIds && driverIds.length ? driverIds : null;
    const [deliveries, assignedRows, reasonRows, closureRows] = await Promise.all([
        dm.fetchDeliveries(start, end, tz, filter),
        fetchAssigned(start, end, tz, filter),
        fetchReasons(start, end, filter),
        fetchClosures(startDate, endDate, filter)
    ]);

    const drivers = new Map();
    const ensure = (id, name, phone) => {
        if (!drivers.has(id)) drivers.set(id, { driverId: id, driverName: name, phone: phone || null, assigned: new Map(), deliveries: [], reasons: new Map(), closures: [] });
        return drivers.get(id);
    };
    assignedRows.forEach(r => ensure(r.driverId, r.driverName, r.driverPhone).assigned.set(r.d, r));
    deliveries.forEach(r => ensure(r.driverId, r.driverName, r.driverPhone).deliveries.push(r));
    reasonRows.forEach(r => {
        const d = drivers.get(r.driverId);
        if (!d) return;
        const key = normalizeReason(r.details);
        d.reasons.set(key, (d.reasons.get(key) || 0) + r.n);
    });
    closureRows.forEach(r => { const d = drivers.get(r.driverId); if (d) d.closures.push(r); });

    const allDates = eachDate(startDate, endDate);
    const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' });
    const list = [...drivers.values()]
        .map(d => summarizeDriver(d, allDates, tz, hourFmt))
        .sort((a, b) => a.driverName.localeCompare(b.driverName, 'es'));

    // --- Promedios de la flota (para comparar a cada conductor contra el resto)
    const tot = (fn) => list.reduce((s, d) => s + (fn(d) || 0), 0);
    const assigned = tot(d => d.totals.assigned), delivered = tot(d => d.totals.delivered);
    const mlDel = tot(d => d.closure.mlDeliveries);
    const paced = list.filter(d => d.pace.avgMinutesPerDelivery != null);
    const withClosure = list.filter(d => d.closure.mlDeliveries > 0);
    const fleet = {
        driversCount: list.length,
        totals: {
            assigned, delivered,
            pending: tot(d => d.totals.pending), cancelled: tot(d => d.totals.cancelled),
            returned: tot(d => d.totals.returned), problemPackages: tot(d => d.totals.problemPackages),
            mlDeliveries: mlDel
        },
        averages: {
            deliveryRate: pct(delivered, assigned),
            incidentRate: pct(tot(d => d.totals.problemPackages), assigned),
            photoRate: pct(list.reduce((s, d) => s + (d.totals.photoRate != null ? d.totals.photoRate / 100 * d.totals.delivered : 0), 0), delivered),
            avgDeliveriesPerDay: list.length ? dm.round(dm.mean(list.map(d => d.totals.avgDeliveriesPerDay || 0)), 1) : null,
            avgMinutesPerDelivery: paced.length ? dm.round(dm.mean(paced.map(d => d.pace.avgMinutesPerDelivery)), 1) : null,
            avgHoursActive: paced.length ? dm.round(dm.mean(paced.map(d => d.pace.avgHoursActive)), 2) : null,
            avgMlDelayMin: mlDel ? dm.round(list.reduce((s, d) => s + (d.closure.avgMlDelayMin || 0) * d.closure.mlDeliveries, 0) / mlDel, 0) : null,
            lateShare: mlDel ? dm.round(tot(d => d.closure.lateCount) / mlDel, 3) : null,
            driversWithClosureData: withClosure.length
        }
    };

    return {
        period: { startDate, endDate, days: allDates.length },
        generatedAt: new Date().toISOString(),
        meta: { lateCloseMinutes: dm.LATE_CLOSE_MINUTES, minMlForProfile: dm.MIN_ML_FOR_PROFILE, minDeliveriesForPace: dm.MIN_DELIVERIES_FOR_PACE },
        drivers: list,
        fleet
    };
}

module.exports = { buildPerformanceReport };
