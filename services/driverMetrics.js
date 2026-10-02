const db = require('../db');

// El "día lógico" de la operación parte a las 02:00 (igual que services/timeService.js): un
// conductor que termina pasada la medianoche sigue contando para el día en que salió a ruta.
const LOGICAL_DAY_CUTOFF_HOURS = 2;

// --- Umbrales de los indicadores. Calibrados con datos reales de septiembre/octubre 2026: el
// conductor típico tiene demora de cierre ~0 min y 0% de cierres post-ruta; el grupo que cierra
// todo al final de la noche tiene 100% post-ruta, demora promedio >100 min y ráfagas de 11-17
// cierres en 10 minutos.
const LATE_CLOSE_MINUTES = 30;         // cierre en la app >30 min después del cierre de ML = tardío
const MIN_ML_FOR_PROFILE = 5;          // mínimo de entregas con cierre ML para clasificar el perfil
const MIN_DELIVERIES_FOR_PACE = 3;     // mínimo de entregas para calcular min/entrega
const DELAYED_SHARE = 0.25;            // >=25% de cierres tardíos => "con retraso"
const END_OF_DAY_SHARE = 0.5;          // >=50% post-ruta y >=50% tardíos => "cierra al final del día"
const BURST_WINDOW_MINUTES = 10;
const BURST_MIN_DELIVERIES = 8;        // regla de ráfaga (solo si no hay evidencia suficiente de ML)
const BURST_SHARE = 0.6;
const IDLE_GAP_MINUTES = 45;           // parada larga entre entregas

const round = (n, d = 0) => (n == null || Number.isNaN(n)) ? null : Math.round(n * 10 ** d) / 10 ** d;
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

/** "HH:MM" en la zona horaria del sistema (formato 24h). */
function fmtHM(date, tz) {
    if (!date) return null;
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Minutos desde medianoche (hora local del sistema) — para promediar horas de inicio/fin. */
function minutesOfDay(date, tz) {
    const [h, m] = fmtHM(date, tz).split(':').map(Number);
    return h * 60 + m;
}

function minutesToHM(mins) {
    if (mins == null) return null;
    const total = Math.round(mins);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Clave sin acentos/mayúsculas para agrupar variantes ("Maipú" / "MAIPU"). */
const communeKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

/**
 * Entregas (estado ENTREGADO) cuya hora REAL de entrega cae en [start, end).
 *
 * La hora real es el evento ENTREGADO de tracking_events, NO packages."updatedAt": otros procesos
 * del sistema (sincronización con Mercado Libre, etc.) vuelven a "tocar" el paquete minutos
 * después de entregado, y eso inflaba la hora de última entrega entre 7 y 27 minutos (medido el
 * 2026-10-01). Si un paquete no tuviera evento (no ocurrió en 14 días de datos), cae en updatedAt.
 *
 * Candidatos: updatedAt siempre es >= la hora de entrega, así que basta con updatedAt >= start.
 * El tope de +3 días acota la consulta para días antiguos (un paquete entregado en la ventana y
 * vuelto a tocar más de 3 días después es extremadamente raro).
 */
async function fetchDeliveries(start, end, tz, driverIds) {
    const hasDriverFilter = Array.isArray(driverIds) && driverIds.length > 0;
    const { rows } = await db.query(
        `WITH cand AS (
            SELECT p.id, p."driverId", p."recipientCommune", p.source, p."updatedAt",
                (SELECT MAX(te.timestamp) FROM tracking_events te WHERE te."packageId" = p.id AND te.status = 'ENTREGADO') AS ev_at,
                (SELECT MIN(te.timestamp) FROM tracking_events te WHERE te."packageId" = p.id AND te.status = 'CIERRE_OFICIAL_ML') AS ml_at
            FROM packages p
            WHERE p.status = 'ENTREGADO'
              AND p."driverId" IS NOT NULL
              AND p."updatedAt" >= $1::timestamptz
              AND p."updatedAt" < ($2::timestamptz + INTERVAL '3 days')
              ${hasDriverFilter ? 'AND p."driverId" = ANY($4::text[])' : ''}
        )
        SELECT c.id AS "packageId", c."driverId", u.name AS "driverName", u.phone AS "driverPhone",
               TRIM(c."recipientCommune") AS "communeRaw", c.source,
               COALESCE(c.ev_at, c."updatedAt") AS "appAt", c.ml_at AS "mlAt",
               TO_CHAR(timezone($3, COALESCE(c.ev_at, c."updatedAt")) - INTERVAL '${LOGICAL_DAY_CUTOFF_HOURS} hours', 'YYYY-MM-DD') AS "logicalDate"
        FROM cand c
        JOIN users u ON u.id = c."driverId"
        WHERE u.role = 'DRIVER'
          AND COALESCE(c.ev_at, c."updatedAt") >= $1::timestamptz
          AND COALESCE(c.ev_at, c."updatedAt") < $2::timestamptz
        ORDER BY u.name, "appAt"`,
        hasDriverFilter ? [start, end, tz, driverIds] : [start, end, tz]
    );
    // Normaliza la comuna (mayúsculas con acentos) en JS: no depende del locale de la base.
    rows.forEach(r => {
        r.appAt = new Date(r.appAt);
        r.mlAt = r.mlAt ? new Date(r.mlAt) : null;
        r.commune = (r.communeRaw || '').toUpperCase() || 'SIN COMUNA';
        r.communeKey = communeKey(r.commune);
    });
    return rows;
}

/** Clasifica cómo cierra en la app un conductor un día (ver umbrales arriba). */
function classifyClosure({ mlCount, lateShare, postRouteShare, deliveredCount, maxBurst }) {
    if (mlCount >= MIN_ML_FOR_PROFILE) {
        if (postRouteShare >= END_OF_DAY_SHARE && lateShare >= END_OF_DAY_SHARE) return 'END_OF_DAY';
        if (lateShare >= DELAYED_SHARE) return 'DELAYED';
        return 'ON_TIME';
    }
    // Sin evidencia suficiente de ML: solo se marca si el patrón de ráfaga es evidente.
    if (deliveredCount >= BURST_MIN_DELIVERIES && maxBurst / deliveredCount >= BURST_SHARE) return 'END_OF_DAY';
    return 'NO_DATA';
}

/**
 * Analiza las entregas de UN conductor en UN día lógico (rows ya filtradas, cualquier orden).
 * Devuelve ritmo (primera/última/horas/min por entrega, brechas) y cierre en app vs Mercado Libre.
 */
function analyzeDay(rows) {
    const n = rows.length;
    const times = rows.map(r => +r.appAt).sort((a, b) => a - b);
    const firstAt = n ? new Date(times[0]) : null;
    const lastAt = n ? new Date(times[n - 1]) : null;
    const spanMin = n > 1 ? (times[n - 1] - times[0]) / 60000 : 0;

    const gaps = [];
    for (let i = 1; i < n; i++) gaps.push((times[i] - times[i - 1]) / 60000);

    // Ráfaga: la mayor cantidad de cierres en la app dentro de una ventana de 10 minutos.
    let maxBurst = 0, burstAt = null;
    for (let i = 0, j = 0; i < n; i++) {
        while (times[i] - times[j] > BURST_WINDOW_MINUTES * 60000) j++;
        if (i - j + 1 > maxBurst) { maxBurst = i - j + 1; burstAt = new Date(times[j]); }
    }

    // Cierre en la app vs cierre detectado de Mercado Libre. La hora de ML es la de DETECCIÓN
    // (el sistema revisa ML cada pocos minutos), siempre >= al cierre real en ML, así que la
    // demora medida es un mínimo garantizado: si dice 40 min, la real es 40 o más.
    const mlRows = rows.filter(r => r.mlAt);
    const delays = mlRows.map(r => Math.max((r.appAt - r.mlAt) / 60000, 0));
    const lastMl = mlRows.length ? Math.max(...mlRows.map(r => +r.mlAt)) : null;
    const mlCount = mlRows.length;
    const lateCount = delays.filter(d => d > LATE_CLOSE_MINUTES).length;
    const lateShare = mlCount ? lateCount / mlCount : null;
    const postRouteShare = mlCount ? mlRows.filter(r => +r.appAt > lastMl).length / mlCount : null;

    const closureProfile = classifyClosure({ mlCount, lateShare, postRouteShare, deliveredCount: n, maxBurst });

    return {
        deliveredCount: n,
        firstAt, lastAt,
        spanMinutes: spanMin,
        hoursActive: n > 1 ? round(spanMin / 60, 2) : 0,
        avgMinutesPerDelivery: gaps.length ? round(spanMin / gaps.length, 1) : null,
        // Con cierre masivo la hora de la app no refleja cuándo entregó: no se compara en rankings.
        paceReliable: n >= MIN_DELIVERIES_FOR_PACE && closureProfile !== 'END_OF_DAY',
        gaps: { avg: gaps.length ? round(mean(gaps), 1) : null, max: gaps.length ? round(Math.max(...gaps)) : null, idleCount: gaps.filter(g => g > IDLE_GAP_MINUTES).length },
        mlCount,
        avgMlDelayMin: mlCount ? round(mean(delays), 0) : null,
        maxMlDelayMin: mlCount ? round(Math.max(...delays), 0) : null,
        mlDelaySumMin: delays.reduce((a, b) => a + b, 0), // para promediar bien un período completo
        lateCount,
        lateShare: lateShare == null ? null : round(lateShare, 2),
        postRouteShare: postRouteShare == null ? null : round(postRouteShare, 2),
        maxBurst, burstAt,
        closureProfile
    };
}

const groupBy = (arr, keyFn) => arr.reduce((acc, x) => { (acc[keyFn(x)] = acc[keyFn(x)] || []).push(x); return acc; }, {});

/**
 * Vistas del Centro de Control para UN día lógico a partir de las entregas reales:
 *  - chronometry (pestaña 3): ritmo + cierre vs ML por conductor, con filtro opcional de comunas
 *    (el filtro acota el RITMO; el comportamiento de cierre se evalúa siempre con la jornada completa)
 *  - cadence (pestaña 2): tiempos entre entregas
 *  - communes: comunas con entregas ese día (sin filtrar, para poblar el selector)
 */
function buildFleetDayViews(deliveries, { tz, communes = [] }) {
    const wanted = new Set(communes.map(communeKey));
    const byDriver = groupBy(deliveries, r => r.driverId);

    const chronometry = [];
    const cadence = [];
    Object.values(byDriver).forEach(all => {
        const full = analyzeDay(all);
        const paceRows = wanted.size ? all.filter(r => wanted.has(r.communeKey)) : all;
        if (paceRows.length === 0) return;
        const pace = wanted.size ? analyzeDay(paceRows) : full;

        chronometry.push({
            driverId: all[0].driverId,
            driverName: all[0].driverName,
            firstActivity: fmtHM(pace.firstAt, tz),
            lastActivity: fmtHM(pace.lastAt, tz),
            totalHoursActive: pace.hoursActive,
            deliveredCount: paceRows.length,
            totalDeliveredDay: all.length,
            avgMinutesPerDelivery: pace.avgMinutesPerDelivery,
            // En un filtro por comuna también se exige el mínimo de entregas dentro de esa comuna.
            paceReliable: pace.deliveredCount >= MIN_DELIVERIES_FOR_PACE && full.closureProfile !== 'END_OF_DAY',
            mlCount: full.mlCount,
            avgMlDelayMin: full.avgMlDelayMin,
            maxMlDelayMin: full.maxMlDelayMin,
            lateShare: full.lateShare,
            postRouteShare: full.postRouteShare,
            closureProfile: full.closureProfile,
            maxBurst: full.maxBurst,
            burstAt: fmtHM(full.burstAt, tz),
            lastClosureInApp: fmtHM(full.lastAt, tz)
        });

        if (full.deliveredCount >= 2) {
            cadence.push({
                driverId: all[0].driverId,
                driverName: all[0].driverName,
                deliveredCount: full.deliveredCount,
                avgMinutesBetweenDeliveries: full.gaps.avg,
                maxMinutesGap: full.gaps.max,
                idleAlertsCount: full.gaps.idleCount,
                // Quien cierra todas sus entregas juntas al final del día no tiene hora real de
                // entrega: sus "brechas" son artificialmente cortas y no deben leerse como ritmo.
                closureProfile: full.closureProfile
            });
        }
    });

    chronometry.sort((a, b) => (a.firstActivity || '99:99').localeCompare(b.firstActivity || '99:99'));
    cadence.sort((a, b) => a.avgMinutesBetweenDeliveries - b.avgMinutesBetweenDeliveries);

    // Comunas del día: se agrupan variantes con/sin acento y se muestra la forma más frecuente.
    const communeGroups = groupBy(deliveries, r => r.communeKey);
    const communeList = Object.values(communeGroups).map(list => {
        const names = groupBy(list, r => r.commune);
        const display = Object.entries(names).sort((a, b) => b[1].length - a[1].length)[0][0];
        return { commune: display, count: list.length };
    }).sort((a, b) => a.commune.localeCompare(b.commune, 'es'));

    return { chronometry, cadence, communes: communeList };
}

module.exports = {
    LOGICAL_DAY_CUTOFF_HOURS, LATE_CLOSE_MINUTES, MIN_ML_FOR_PROFILE, MIN_DELIVERIES_FOR_PACE,
    round, mean, groupBy, fmtHM, minutesOfDay, minutesToHM, communeKey,
    fetchDeliveries, analyzeDay, classifyClosure, buildFleetDayViews
};
