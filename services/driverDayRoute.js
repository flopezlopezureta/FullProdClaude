/**
 * Datos para dibujar en el Mapa en Vivo el recorrido de UN conductor en UN día.
 *
 * El sistema no guarda el rastro GPS del conductor (solo su última posición), así que la "ruta realizada" se reconstruye con lo que sí
 * queda registrado: cada parada del día, con la hora real en que se visitó:
 *  - Paradas del día = paquetes del conductor cuyo despacho (assignedAt) cae en ese día lógico (corte 02:00, hora Chile), igual que el
 *    resto del mapa y del Centro de Control.
 *  - Hora de entrega (doneAt) = el primer registro entre el cierre en la app (ENTREGADO) y el cierre oficial detectado en Mercado Libre
 *    (CIERRE_OFICIAL_ML); sirve también cuando el conductor entregó pero nunca cerró en la app. Si es posterior al fin de ese día, se
 *    ignora (ese día la parada no se entregó).
 *  - Visita fallida (attemptAt) = el último evento PROBLEMA de ese día.
 *  - Coordenadas: solo las válidas (dentro de Chile y no el valor "centinela" 0.000001 de las que no se pudieron geocodificar); si no,
 *    lat/lng van nulos y la parada se informa aparte. `approx` marca las ubicaciones aproximadas.
 * El orden y las líneas (por calles, optimizada) se resuelven en el navegador: aquí solo se entregan los hechos. Solo lectura.
 */

const isIsoDate = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const STOPS_SQL = `
WITH rng AS (
    SELECT ($2::date::timestamp + interval '2 hours') AT TIME ZONE $3::text AS t0,
           (($2::date + 1)::timestamp + interval '2 hours') AT TIME ZONE $3::text AS t1
)
SELECT p.id,
       p.status,
       p.source,
       p."meliFlexCode" AS "flexCode",
       p."recipientName" AS recipient,
       p."recipientAddress" AS address,
       p."recipientCommune" AS commune,
       p."assignedAt",
       CASE WHEN v.ok THEN p."destLatitude" END AS lat,
       CASE WHEN v.ok THEN p."destLongitude" END AS lng,
       COALESCE(p."destIsApproximate", false) AS approx,
       CASE WHEN ev.done_at < rng.t1 THEN ev.done_at END AS "doneAt",
       ev.attempt_at AS "attemptAt",
       ev.attempts
FROM packages p
CROSS JOIN rng
CROSS JOIN LATERAL (
    SELECT (p."destLatitude" IS NOT NULL AND p."destLongitude" IS NOT NULL
            AND p."destLatitude" NOT IN (0, 0.000001) AND p."destLongitude" <> 0
            AND p."destLatitude" BETWEEN -56 AND -17 AND p."destLongitude" BETWEEN -76 AND -66) AS ok
) v
LEFT JOIN LATERAL (
    SELECT LEAST(min(e.timestamp) FILTER (WHERE e.status = 'ENTREGADO'), min(e.timestamp) FILTER (WHERE e.status = 'CIERRE_OFICIAL_ML')) AS done_at,
           max(e.timestamp) FILTER (WHERE e.status = 'PROBLEMA' AND e.timestamp >= rng.t0 AND e.timestamp < rng.t1) AS attempt_at,
           (count(*) FILTER (WHERE e.status = 'PROBLEMA' AND e.timestamp >= rng.t0 AND e.timestamp < rng.t1))::int AS attempts
    FROM tracking_events e
    WHERE e."packageId" = p.id
) ev ON true
WHERE p."driverId" = $1 AND p."assignedAt" >= rng.t0 AND p."assignedAt" < rng.t1
ORDER BY p."assignedAt", p.id`;

const DRIVER_SQL = `SELECT id, name, latitude, longitude, "lastLocationUpdate" FROM users WHERE id = $1 AND role = 'DRIVER'`;

/**
 * @param {{query: (text: string, params?: any[]) => Promise<{rows: any[]}>, driverId: string, date: string, tz: string, today: string}} opts
 * @returns {Promise<null | {driver: object, date: string, isToday: boolean, tz: string, stops: object[]}>} null si el conductor no existe
 */
async function buildDriverDayRoute({ query, driverId, date, tz, today }) {
    if (typeof driverId !== 'string' || !driverId || driverId.length > 100) throw new Error('driverId inválido.');
    if (!isIsoDate(date)) throw new Error('Fecha inválida.');
    const [driverRes, stopsRes] = await Promise.all([query(DRIVER_SQL, [driverId]), query(STOPS_SQL, [driverId, date, tz])]);
    if (driverRes.rows.length === 0) return null;
    return { driver: driverRes.rows[0], date, isToday: date === today, tz, stops: stopsRes.rows };
}

module.exports = { buildDriverDayRoute, isIsoDate };
