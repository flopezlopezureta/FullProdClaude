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
const CHAIN = `
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
           OR (te.status = 'EN_TRANSITO' AND (te.details LIKE 'Paquete despachado%' OR te.details LIKE 'Paquete re-asignado%')))
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

module.exports = { buildMeliWeeklyDeliveryReport, mondayOf, addDays, isIsoDate, CUTOFF_HOUR, TARGET_PCT, MAX_WEEKS, DEFAULT_WEEKS };
