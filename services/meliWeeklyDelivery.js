/**
 * Informe semanal de cumplimiento de entregas de Mercado Libre, por seller (cliente).
 *
 * Mercado Libre evalúa cada semana qué porcentaje de los envíos se entrega a tiempo y sanciona bajo cierto umbral (97 %).
 * Este servicio arma, por DÍA de gestión y por seller, los conteos que el frontend suma por semana (lunes a domingo):
 *
 *  - Universo: paquetes de Mercado Libre GESTIONADOS por la operación (con conductor asignado o despachado alguna vez). Los envíos de las
 *    cuentas conectadas que Mercado Libre cierra sin que ningún conductor los haya tocado, y los cancelados antes de asignarse, no son
 *    responsabilidad de la operación: no entran al cálculo y se informan aparte (`excluded`).
 *  - Día de gestión (d0): día lógico (corte 02:00, igual que el resto del sistema) del primer despacho del paquete a ruta ("Paquete
 *    despachado por…"); si nunca se despachó, el de su primer movimiento operativo. Si se entregó antes de despacharse, el de la entrega.
 *  - Hora de entrega: el primer registro de entrega entre el cierre en la app (evento ENTREGADO) y el cierre oficial detectado en
 *    Mercado Libre (CIERRE_OFICIAL_ML). Es la mejor aproximación a lo que ve Mercado Libre; el segundo es la hora en que NUESTRO sondeo
 *    lo detectó, así que puede llegar unos minutos tarde.
 *  - Resultado de cada paquete (excluyentes, en este orden):
 *      ON_TIME               entregado el mismo día de gestión antes de las 21:00
 *      LATE_SAME_DAY         entregado el mismo día de gestión desde las 21:00
 *      CANCELLED             cancelado (estado CANCELADO)
 *      RESCHEDULED           reprogramado (estado REPROGRAMADO o un problema "reagendar/reprogramar" en su historial)
 *      REASSIGNED_DELIVERED  no se entregó el día de gestión y se entregó otro día (pasó a otra jornada)
 *      REASSIGNED_OPEN       no se entregó, fue asignado de nuevo en un día posterior y sigue abierto
 *      IN_ROUTE_TODAY        gestionado hoy y aún abierto: se informa pero NO cuenta como fallo (la jornada no termina)
 *      NO_CLOSE              gestionado en un día anterior, sin entrega ni incidencia registrada
 *  - Los porcentajes y el rojo bajo 97 % los calcula el frontend (utils/meliWeeklyReport.ts) con estos conteos.
 *
 * Solo LEE (SELECT). `query` se inyecta para poder probarlo contra una conexión de solo lectura.
 */

const CUTOFF_HOUR = 21;
const TARGET_PCT = 97;
const MAX_WEEKS = 12;
const DEFAULT_WEEKS = 8;

const isIsoDate = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // rechaza 2026-13-01 y 2026-02-31
};
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Lunes de la semana de una fecha YYYY-MM-DD (semana lunes a domingo).
const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));

// Parámetros: $1 zona horaria, $2 primer día lógico, $3 último día lógico (inclusive), $4 día lógico de hoy, $5 hora de corte.
// `candFilter` (opcional) agrega una condición al CTE `cand` (que paquetes se consideran) sin duplicar la cadena: el detalle por paquete la usa
// para mirar solo un cliente. Sin filtro el texto es el de siempre.
const buildChain = (candFilter = '') => `
WITH bounds AS (
    SELECT ($2::date::timestamp + interval '2 hours') AT TIME ZONE $1::text AS t_from,
           (($3::date + 1)::timestamp + interval '2 hours') AT TIME ZONE $1::text AS t_to
),
cand AS (
    SELECT DISTINCT te."packageId" AS pid
    FROM tracking_events te
    JOIN packages p ON p.id = te."packageId" AND p.source = 'MERCADO_LIBRE'
    CROSS JOIN bounds b
    WHERE te.timestamp >= b.t_from AND te.timestamp < b.t_to
      AND (te.status IN ('ENTREGADO', 'CIERRE_OFICIAL_ML', 'PROBLEMA', 'Cancelado', 'Asignado', 'Reasignado')
           OR (te.status = 'EN_TRANSITO' AND (te.details LIKE 'Paquete despachado%' OR te.details LIKE 'Paquete re-asignado%')))${candFilter}
),
ev AS (
    SELECT te."packageId" AS pid, te.status, te.timestamp,
           ((te.timestamp AT TIME ZONE $1::text) - interval '2 hours')::date AS ld,
           (te.status = 'EN_TRANSITO' AND te.details LIKE 'Paquete despachado%') AS is_disp,
           ((te.status = 'EN_TRANSITO' AND te.details LIKE 'Paquete re-asignado%') OR te.status = 'Reasignado') AS is_reasig,
           (te.status = 'Asignado') AS is_asig,
           (te.status = 'PROBLEMA' AND (te.details ILIKE '%reagendar%' OR te.details ILIKE '%reprogramar%')) AS is_resched,
           (te.status = 'ENTREGADO') AS is_app_del,
           (te.status = 'CIERRE_OFICIAL_ML') AS is_ml_del
    FROM tracking_events te
    JOIN cand ON cand.pid = te."packageId"
),
pk AS (
    SELECT ev.pid,
           min(ev.ld) FILTER (WHERE ev.is_disp) AS d_disp,
           min(ev.ld) FILTER (WHERE ev.is_disp OR ev.is_reasig OR ev.is_asig OR ev.is_app_del OR ev.is_ml_del
                                    OR ev.status IN ('PROBLEMA', 'Cancelado')) AS d_any,
           max(ev.ld) FILTER (WHERE ev.is_disp OR ev.is_reasig OR ev.is_asig) AS d_last_assign,
           min(ev.timestamp) FILTER (WHERE ev.is_app_del) AS t_app,
           min(ev.timestamp) FILTER (WHERE ev.is_ml_del) AS t_ml,
           bool_or(ev.is_resched) AS ev_resched,
           bool_or(ev.is_disp OR ev.is_reasig OR ev.is_asig) AS ev_handled
    FROM ev
    GROUP BY ev.pid
),
cls AS (
    SELECT pk.*, p.status AS st, p."driverId" AS drv, p."creatorId" AS cid,
           COALESCE(NULLIF(p."sourceAccountId", ''), NULLIF(p."meliSellerId", ''), '') AS acc_id,
           COALESCE(NULLIF(p."sourceAccountName", ''), 'Mercado Libre (Principal)') AS acc_name,
           LEAST(pk.t_app, pk.t_ml) AS t_del,
           ((LEAST(pk.t_app, pk.t_ml) AT TIME ZONE $1::text) - interval '2 hours')::date AS ld_del,
           (p."driverId" IS NOT NULL OR pk.ev_handled OR pk.t_app IS NOT NULL) AS handled
    FROM pk
    JOIN packages p ON p.id = pk.pid
),
res AS (
    SELECT c.*, LEAST(COALESCE(c.d_disp, c.d_any), c.ld_del) AS d0
    FROM cls c
),
out AS (
    SELECT r.*,
           CASE
               WHEN r.t_del IS NOT NULL AND r.ld_del <= r.d0 THEN
                   CASE WHEN (r.t_del AT TIME ZONE $1::text) < (r.ld_del::timestamp + make_interval(hours => $5::int))
                        THEN 'ON_TIME' ELSE 'LATE_SAME_DAY' END
               WHEN r.st = 'CANCELADO' THEN 'CANCELLED'
               WHEN r.st = 'REPROGRAMADO' OR r.ev_resched THEN 'RESCHEDULED'
               WHEN r.t_del IS NOT NULL THEN 'REASSIGNED_DELIVERED'
               WHEN r.d_last_assign > r.d0 THEN 'REASSIGNED_OPEN'
               WHEN r.d0 >= $4::date THEN 'IN_ROUTE_TODAY'
               ELSE 'NO_CLOSE'
           END AS outcome
    FROM res r
)`;
const CHAIN = buildChain();

const ROWS_SQL = `${CHAIN}
SELECT o.d0::text AS day,
       o.cid AS "clientId",
       COALESCE(u.name, 'Sin cliente') AS "clientName",
       u."clientIdentifier" AS "clientIdentifier",
       o.acc_id AS "accountId",
       o.acc_name AS "accountName",
       count(*) FILTER (WHERE o.outcome <> 'IN_ROUTE_TODAY')::int AS total,
       count(*) FILTER (WHERE o.outcome = 'ON_TIME')::int AS "onTime",
       count(*) FILTER (WHERE o.outcome = 'LATE_SAME_DAY')::int AS "lateSameDay",
       count(*) FILTER (WHERE o.outcome = 'CANCELLED')::int AS cancelled,
       count(*) FILTER (WHERE o.outcome = 'RESCHEDULED')::int AS rescheduled,
       count(*) FILTER (WHERE o.outcome = 'REASSIGNED_DELIVERED')::int AS "reassignedDelivered",
       count(*) FILTER (WHERE o.outcome = 'REASSIGNED_OPEN')::int AS "reassignedOpen",
       count(*) FILTER (WHERE o.outcome = 'NO_CLOSE')::int AS "noClose",
       count(*) FILTER (WHERE o.outcome = 'IN_ROUTE_TODAY')::int AS "inRouteToday",
       count(*) FILTER (WHERE o.t_del IS NOT NULL)::int AS delivered
FROM out o
LEFT JOIN users u ON u.id = o.cid
WHERE o.handled AND o.d0 BETWEEN $2::date AND $3::date
GROUP BY o.d0, o.cid, u.name, u."clientIdentifier", o.acc_id, o.acc_name
ORDER BY o.d0, u.name`;

// Envíos que NO son responsabilidad de la operación (nadie los gestionó): se informan para transparencia, no entran a los %.
const EXCLUDED_SQL = `${CHAIN}
SELECT COALESCE(LEAST(o.d_any, o.ld_del), o.d_any)::text AS day,
       o.cid AS "clientId",
       count(*) FILTER (WHERE o.st = 'CANCELADO' AND o.t_del IS NULL)::int AS "cancelledBeforeAssignment",
       count(*) FILTER (WHERE o.t_del IS NOT NULL)::int AS "deliveredOutside"
FROM out o
WHERE NOT o.handled AND COALESCE(LEAST(o.d_any, o.ld_del), o.d_any) BETWEEN $2::date AND $3::date
GROUP BY 1, 2
ORDER BY 1`;

/**
 * @param {{query: (text: string, params?: any[]) => Promise<{rows: any[]}>, tz: string, weekStart: string, weeks?: number, today: string, cutoffHour?: number}} opts
 *   weekStart: cualquier fecha YYYY-MM-DD de la ÚLTIMA semana pedida (se normaliza a su lunes); today: día lógico de hoy.
 */
async function buildMeliWeeklyDeliveryReport({ query, tz, weekStart, weeks = DEFAULT_WEEKS, today, cutoffHour = CUTOFF_HOUR }) {
    if (!isIsoDate(weekStart) || !isIsoDate(today)) throw new Error('Fechas inválidas.');
    const nWeeks = Math.min(Math.max(parseInt(weeks, 10) || DEFAULT_WEEKS, 1), MAX_WEEKS);
    const lastMonday = mondayOf(weekStart) > mondayOf(today) ? mondayOf(today) : mondayOf(weekStart);
    const fromDay = addDays(lastMonday, -7 * (nWeeks - 1));
    const toDay = addDays(lastMonday, 6);
    const params = [tz, fromDay, toDay, today, cutoffHour];

    const [rowsRes, excludedRes] = await Promise.all([query(ROWS_SQL, params), query(EXCLUDED_SQL, params)]);
    return {
        meta: { tz, cutoffHour, targetPct: TARGET_PCT, weekStart: lastMonday, weeks: nWeeks, fromDay, toDay, today, generatedAt: new Date().toISOString() },
        rows: rowsRes.rows,
        excluded: excludedRes.rows,
    };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// DETALLE POR PAQUETE: qué paquetes de un seller NO se entregaron antes de las 21:00 de su día de gestión y qué conductor los tenía.
//
// Usa la MISMA cadena de clasificación (CHAIN) que los conteos de arriba, así cada paquete cae exactamente en la categoría que suma la tabla
// (Después de las 21:00, Cancelados, Reprogramados, Reasignados, Sin cierre) y los números del detalle tienen que cuadrar con los del resumen.
//
// El conductor sale del historial del paquete (tracking_events), que guarda su nombre en el texto de cada movimiento:
//   "Paquete despachado por X."            · "Paquete re-asignado de X a Y."
//   "Asignado a conductor X. …"           · "Reasignado al conductor X. …"          · "Paquete puesto en disponibilidad (desasignado)."
// El conductor "responsable" es quien tenía el paquete en el momento que explica el resultado: al entregarlo (después de las 21:00), al
// cancelarse, al pedirse reagendar, o al terminar el día de gestión (reasignados y sin cierre: el que no lo entregó ese día).
// Solo LEE.
// ---------------------------------------------------------------------------------------------------------------------------------

const DETAIL_SQL = `${buildChain('\n      AND ($9::boolean OR p."creatorId" IS NOT DISTINCT FROM $6::text)')}
SELECT o.pid AS id,
       o.d0::text AS day,
       o.outcome,
       o.t_del AS "deliveredAt", o.t_app AS "appAt", o.t_ml AS "mlAt", o.ld_del::text AS "deliveredDay",
       CASE WHEN o.outcome = 'LATE_SAME_DAY'
            THEN round(EXTRACT(EPOCH FROM (o.t_del - ((o.ld_del::timestamp + make_interval(hours => $5::int)) AT TIME ZONE $1::text))) / 60)::int
       END AS "lateMinutes",
       o.st AS status,
       o.cid AS "clientId", o.acc_id AS "accountId", o.acc_name AS "accountName",
       p."meliOrderId" AS "meliOrderId", p."meliFlexCode" AS "meliFlexCode", p."recipientCommune" AS commune,
       du.name AS "currentDriverName",
       (((o.d0 + 1)::timestamp + interval '2 hours') AT TIME ZONE $1::text) AS "dayEnd"
FROM out o
JOIN packages p ON p.id = o.pid
LEFT JOIN users du ON du.id = o.drv
WHERE o.handled AND o.d0 BETWEEN $2::date AND $3::date
  AND o.outcome NOT IN ('ON_TIME', 'IN_ROUTE_TODAY')
  AND ($9::boolean OR o.cid IS NOT DISTINCT FROM $6::text)
  AND ($7::text IS NULL OR (o.acc_id = $7::text AND o.acc_name = $8::text))
ORDER BY o.d0, o.outcome, p.id`;

// Solo los movimientos que importan para saber quién tenía el paquete y qué le pasó (entrega, cancelación, incidencias).
const DETAIL_EVENTS_SQL = `
SELECT te."packageId" AS pid, te.status, te.details, te.timestamp
FROM tracking_events te
WHERE te."packageId" = ANY($1::text[])
  AND (te.status IN ('Asignado', 'Reasignado', 'PROBLEMA', 'Cancelado', 'ENTREGADO', 'CIERRE_OFICIAL_ML')
       OR (te.status = 'EN_TRANSITO' AND (te.details LIKE 'Paquete despachado%' OR te.details LIKE 'Paquete re-asignado%'))
       OR (te.status = 'Creado' AND te.details LIKE '%desasignado%'))
ORDER BY te."packageId", te.timestamp, te.id`;

// Orden en que se muestran las categorías de un mismo día.
const DETAIL_OUTCOME_ORDER = { LATE_SAME_DAY: 1, CANCELLED: 2, RESCHEDULED: 3, REASSIGNED_DELIVERED: 4, REASSIGNED_OPEN: 5, NO_CLOSE: 6 };

const cleanName = (s) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return !t || /^(desconocido|nadie)$/i.test(t) ? null : t;
};
const shorten = (s, max = 160) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : (t || null);
};

/** Interpreta un movimiento del historial: ¿cambió quién tiene el paquete? → { kind, from, to } o null si no es una asignación. */
function parseAssignment(status, details) {
    const d = String(details || '');
    let m;
    if (status === 'EN_TRANSITO') {
        if ((m = /^Paquete despachado por ([\s\S]+?)\.(?: \(QR:[\s\S]*)?$/.exec(d))) return { kind: 'dispatch', from: null, to: cleanName(m[1]) };
        if ((m = /^Paquete re-asignado de ([\s\S]+?) a ([\s\S]+?)\.(?: \(QR:[\s\S]*)?$/.exec(d))) return { kind: 'reassign', from: cleanName(m[1]), to: cleanName(m[2]) };
    } else if (status === 'Asignado') {
        if ((m = /^Asignado a conductor ([\s\S]+?)\. Estado actualizado/.exec(d))) return { kind: 'assign', from: null, to: cleanName(m[1]) };
    } else if (status === 'Reasignado') {
        if ((m = /^Reasignado al conductor ([\s\S]+?)\. Fecha de reasignaci/.exec(d))) return { kind: 'reassign', from: null, to: cleanName(m[1]) };
    } else if (status === 'Creado') {
        if (/desasignado/i.test(d)) return { kind: 'unassign', from: null, to: null };
    }
    return null;
}

// Nombres: el historial los guarda como texto ("PEDRO G." en un movimiento, "Pedro G." en la ficha del usuario). Se comparan sin mayúsculas ni
// tildes y se muestran con la grafía de la ficha del usuario; si solo hay una grafía TODA en mayúsculas, se pasa a "Nombre Apellido".
const nameKey = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const properCase = (n) => (n && n === n.toUpperCase() && n !== n.toLowerCase() ? n.toLowerCase().replace(/(^|[\s'-])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase()) : n);
const TRANSIENT_MS = 2 * 60 * 1000;     // un conductor que tuvo el paquete menos de esto (p. ej. un traspaso por una cuenta de administrador) no se considera responsable

/**
 * Quién es el conductor responsable de un paquete, por quiénes pasó y la historia resumida.
 * @param {{outcome: string, dayEnd: Date|string, deliveredAt: Date|string|null, currentDriverName: string|null}} item
 * @param {{status: string, details: string, timestamp: Date|string}[]} events movimientos del paquete (cualquier orden)
 * @returns {{driver: string|null, driverBasis: 'holder'|'before'|'after'|'current'|null, driverSince: string|null, finalDriver: string|null,
 *            drivers: string[], reason: string|null, story: {at: string, kind: string, who: string|null, from: string|null, text: string|null}[]}}
 *   driverBasis: 'holder' = lo tenía asignado en el momento clave; 'before' = nadie lo tenía entonces, se muestra el último conductor que lo tuvo antes;
 *   'after' = nadie lo tenía ni antes, se muestra al primero que se le asignó después (p. ej. el administrador asignó al conductor tras la entrega);
 *   'current' = sin historial legible, el conductor que figura hoy.
 */
function attributeDrivers(item, events) {
    const canon = new Map();
    if (item.currentDriverName) canon.set(nameKey(item.currentDriverName), item.currentDriverName);
    const nm = (n) => { if (!n) return null; const k = nameKey(n); if (!canon.has(k)) canon.set(k, properCase(n)); return canon.get(k); };

    const sorted = [...(events || [])].map(e => ({ ...e, at: new Date(e.timestamp) })).sort((a, b) => a.at - b.at);
    const timeline = [], story = [];
    let cancelAt = null, cancelReason = null, reschedAt = null, reschedReason = null, problems = 0;
    for (const e of sorted) {
        const a = parseAssignment(e.status, e.details);
        if (a) {
            const step = { at: e.at, kind: a.kind, from: nm(a.from), to: nm(a.to) };
            timeline.push(step);
            story.push({ at: e.at.toISOString(), kind: a.kind, who: step.to, from: step.from, text: null });
        } else if (e.status === 'Cancelado') {
            if (!cancelAt) { cancelAt = e.at; cancelReason = shorten(e.details); story.push({ at: e.at.toISOString(), kind: 'cancelled', who: null, from: null, text: 'Cancelado en Mercado Libre' }); }
        } else if (e.status === 'PROBLEMA') {
            const isResched = /reagendar|reprogramar/i.test(e.details || '');
            if (isResched && !reschedAt) { reschedAt = e.at; reschedReason = shorten(e.details); }
            if (problems++ < 4) story.push({ at: e.at.toISOString(), kind: isResched ? 'rescheduled' : 'problem', who: null, from: null, text: shorten(e.details, 90) });
        } else if (e.status === 'ENTREGADO') {
            story.push({ at: e.at.toISOString(), kind: 'delivered_app', who: null, from: null, text: 'Entregado (cierre en la app)' });
        } else if (e.status === 'CIERRE_OFICIAL_ML') {
            story.push({ at: e.at.toISOString(), kind: 'delivered_ml', who: null, from: null, text: 'Entrega detectada en Mercado Libre' });
        }
    }

    // Quién tenía el paquete en el instante t: el último movimiento de asignación hasta ese instante. Antes del primer movimiento solo se conoce
    // al conductor anterior si ese movimiento fue una re-asignación ("de X a Y").
    const holderAt = (t) => {
        let name = null, since = null;
        const first = timeline[0];
        if (first && first.kind === 'reassign' && first.from) name = first.from;
        for (const e of timeline) {
            if (e.at.getTime() > t.getTime()) break;
            name = e.to; since = e.at;
        }
        return name ? { name, since } : null;
    };
    // Último conductor que de verdad tuvo el paquete (más que un traspaso de segundos) antes de t.
    const lastBefore = (t) => {
        for (let i = timeline.length - 1; i >= 0; i--) {
            const e = timeline[i];
            if (e.at.getTime() > t.getTime() || !e.to) continue;
            const next = timeline[i + 1];
            if (next && next.at.getTime() - e.at.getTime() < TRANSIENT_MS) continue;
            return { name: e.to, since: e.at };
        }
        const first = timeline[0];
        return first && first.kind === 'reassign' && first.from ? { name: first.from, since: null } : null;
    };
    const firstAfter = (t) => { const e = timeline.find(x => x.at.getTime() > t.getTime() && x.to); return e ? { name: e.to, since: e.at } : null; };

    // Momento que explica el resultado: la entrega (tarde), la cancelación, el pedido de reagendar, o el cierre del día de gestión.
    const refTime = item.outcome === 'LATE_SAME_DAY' && item.deliveredAt ? new Date(item.deliveredAt)
        : item.outcome === 'CANCELLED' && cancelAt ? cancelAt
        : item.outcome === 'RESCHEDULED' && reschedAt ? reschedAt
        : new Date(item.dayEnd);

    let pick = holderAt(refTime), basis = 'holder';
    if (!pick) { pick = lastBefore(refTime); basis = 'before'; }
    if (!pick) { pick = firstAfter(refTime); basis = 'after'; }
    // Una cancelación de Mercado Libre suele llegar ANTES de que un conductor despache el paquete: ahí manda quien lo tuvo al cerrar el día de gestión.
    if (item.outcome === 'CANCELLED' && (!pick || basis !== 'holder')) {
        const atClose = holderAt(new Date(item.dayEnd));
        if (atClose) { pick = atClose; basis = 'holder'; }
    }
    if (!pick && item.currentDriverName) { pick = { name: item.currentDriverName, since: null }; basis = 'current'; }

    const drivers = [];
    const push = (n) => { if (n && nameKey(drivers[drivers.length - 1]) !== nameKey(n)) drivers.push(n); };
    if (timeline[0] && timeline[0].kind === 'reassign') push(timeline[0].from);
    for (const e of timeline) push(e.to);
    push(nm(item.currentDriverName));

    const driver = pick ? pick.name : null;
    const current = nm(item.currentDriverName);
    return {
        driver,
        driverBasis: driver ? basis : null,
        driverSince: pick && pick.since ? pick.since.toISOString() : null,
        finalDriver: current && nameKey(current) !== nameKey(driver) ? current : null,
        drivers,
        reason: item.outcome === 'RESCHEDULED' ? reschedReason : item.outcome === 'CANCELLED' ? cancelReason : null,
        story: story.slice(0, 16),
    };
}

/**
 * @param {{query: (text: string, params?: any[]) => Promise<{rows: any[]}>, tz: string, weekStart: string, today: string,
 *          clientId?: string|null, accountId?: string|null, accountName?: string|null, cutoffHour?: number}} opts
 *   clientId: undefined = todos los clientes (para pruebas); null o '' = paquetes sin cliente.
 *   accountId + accountName: si vienen, solo esa cuenta de Mercado Libre (la vista "por cuenta"); si no, todas las del cliente.
 */
async function buildMeliWeeklyDelayDetail({ query, tz, weekStart, today, clientId, accountId = null, accountName = null, cutoffHour = CUTOFF_HOUR }) {
    if (!isIsoDate(weekStart) || !isIsoDate(today)) throw new Error('Fechas inválidas.');
    const monday = mondayOf(weekStart) > mondayOf(today) ? mondayOf(today) : mondayOf(weekStart);
    const sunday = addDays(monday, 6);
    const allClients = clientId === undefined;
    const params = [tz, monday, sunday, today, cutoffHour, allClients ? null : (clientId || null), accountId, accountName, allClients];

    const { rows } = await query(DETAIL_SQL, params);
    const meta = { tz, cutoffHour, weekStart: monday, fromDay: monday, toDay: sunday, today, generatedAt: new Date().toISOString() };
    if (!rows.length) return { meta, items: [] };

    const byPkg = new Map();
    const ids = rows.map(r => r.id);
    for (let i = 0; i < ids.length; i += 2000) {
        const { rows: evs } = await query(DETAIL_EVENTS_SQL, [ids.slice(i, i + 2000)]);
        for (const e of evs) { if (!byPkg.has(e.pid)) byPkg.set(e.pid, []); byPkg.get(e.pid).push(e); }
    }

    const iso = (v) => (v ? new Date(v).toISOString() : null);
    const items = rows.map(r => {
        const who = attributeDrivers(r, byPkg.get(r.id) || []);
        const via = r.appAt && (!r.mlAt || new Date(r.appAt) <= new Date(r.mlAt)) ? 'app' : (r.mlAt ? 'ml' : null);
        return {
            id: r.id, meliOrderId: r.meliOrderId || null, meliFlexCode: r.meliFlexCode || null, commune: r.commune || null,
            clientId: r.clientId, accountId: r.accountId, accountName: r.accountName,
            day: r.day, outcome: r.outcome, status: r.status,
            deliveredAt: iso(r.deliveredAt), deliveredDay: r.deliveredDay || null, deliveredVia: r.deliveredAt ? via : null, lateMinutes: r.lateMinutes,
            ...who,
        };
    }).sort((a, b) => a.day.localeCompare(b.day) || (DETAIL_OUTCOME_ORDER[a.outcome] || 9) - (DETAIL_OUTCOME_ORDER[b.outcome] || 9) || String(a.deliveredAt || '').localeCompare(String(b.deliveredAt || '')) || a.id.localeCompare(b.id));
    return { meta, items };
}

module.exports = { buildMeliWeeklyDeliveryReport, buildMeliWeeklyDelayDetail, parseAssignment, attributeDrivers, mondayOf, addDays, isIsoDate, CUTOFF_HOUR, TARGET_PCT, MAX_WEEKS, DEFAULT_WEEKS };
