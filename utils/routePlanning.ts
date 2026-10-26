// Planificación de rutas para el Mapa en Vivo (se ejecuta en el navegador del administrador):
//  - qué paradas ya se hicieron (ruta realizada) y cuáles faltan, a partir de lo que entrega GET /api/geo/driver-route;
//  - orden sugerido de las paradas que faltan: vecino más cercano + mejora con 2-opt y Or-opt, minimizando el tiempo de manejo;
//  - trazado por calles y tiempos con OSRM (el mismo servicio que ya usan la app del conductor y las Rutas Inteligentes), con línea
//    recta como respaldo si el servicio no responde; y la hora estimada de llegada a cada parada.
// Todo lo que no es red es puro y determinista (sin azar), para poder probarlo con casos exactos.

export type LatLng = [number, number];                       // [lat, lng], como espera Leaflet

export interface RouteStop {
  id: string;
  status: string;
  source: string;
  flexCode: string | null;
  recipient: string;
  address: string;
  commune: string;
  assignedAt: string;
  lat: number | null;
  lng: number | null;
  approx: boolean;
  doneAt: string | null;                                     // primer registro de entrega (app o cierre oficial de Mercado Libre)
  attemptAt: string | null;                                  // último intento fallido del día
  attempts: number;
}

export interface DriverDayRoute {
  driver: { id: string; name: string; latitude: number | null; longitude: number | null; lastLocationUpdate: string | null };
  date: string;
  isToday: boolean;
  tz: string;
  stops: RouteStop[];
}

// ---------- clasificación de paradas (mismos 3 grupos de color que el resto del panel) ----------
const DIFFICULTY_STATUSES = ['PROBLEMA', 'REPROGRAMADO', 'CANCELADO', 'DEVUELTO'];
const OPEN_STATUSES = ['PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO'];

export type StopKind = 'done' | 'attempt' | 'open' | 'other';
/** done = entregada; attempt = visita fallida (problema/reagendada/cancelada con intento registrado); open = aún por entregar; other = sin visita. */
export const stopKind = (s: RouteStop): StopKind => {
  if (s.doneAt) return 'done';
  if (OPEN_STATUSES.includes(s.status)) return 'open';
  if (DIFFICULTY_STATUSES.includes(s.status)) return s.attemptAt ? 'attempt' : 'other';
  return 'other';
};

export const hasCoords = (s: { lat: number | null; lng: number | null }): s is { lat: number; lng: number } => s.lat != null && s.lng != null;

export interface Visit { stop: RouteStop & { lat: number; lng: number }; kind: 'done' | 'attempt'; at: number }

/** Paradas ya visitadas (entregadas o con intento fallido) con ubicación, en el orden real en que ocurrieron. */
export function visitsOf(stops: RouteStop[]): Visit[] {
  const out: Visit[] = [];
  for (const s of stops) {
    if (!hasCoords(s)) continue;
    const kind = stopKind(s);
    if (kind === 'done') out.push({ stop: s as Visit['stop'], kind, at: Date.parse(s.doneAt as string) });
    else if (kind === 'attempt') out.push({ stop: s as Visit['stop'], kind, at: Date.parse(s.attemptAt as string) });
  }
  return out.filter(v => Number.isFinite(v.at)).sort((a, b) => a.at - b.at || a.stop.id.localeCompare(b.stop.id));
}

/** Paradas aún por entregar y con ubicación (candidatas a la ruta sugerida). */
export const pendingOf = (stops: RouteStop[]): (RouteStop & { lat: number; lng: number })[] =>
  stops.filter(s => stopKind(s) === 'open' && hasCoords(s)) as (RouteStop & { lat: number; lng: number })[];

/** Paradas que no se pueden dibujar por no tener una ubicación válida (se informan aparte). */
export const withoutLocation = (stops: RouteStop[]): RouteStop[] => stops.filter(s => !hasCoords(s));

export interface VisitQuality { count: number; medianGapMin: number | null; shortShare: number; reliable: boolean }
/**
 * ¿Se puede confiar en el orden de la ruta realizada? Si muchas entregas consecutivas se cerraron con menos de 45 s de diferencia, el conductor
 * las cerró en bloque (o Mercado Libre las detectó juntas) y el orden entre ellas es una aproximación.
 */
export function visitQuality(visits: Visit[]): VisitQuality {
  if (visits.length < 3) return { count: visits.length, medianGapMin: null, shortShare: 0, reliable: true };
  const gaps: number[] = [];
  for (let i = 1; i < visits.length; i++) gaps.push((visits[i].at - visits[i - 1].at) / 1000);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const shortShare = gaps.filter(g => g < 45).length / gaps.length;
  return { count: visits.length, medianGapMin: Math.round((median / 60) * 10) / 10, shortShare, reliable: shortShare < 0.4 };
}

// ---------- geometría ----------
const R_EARTH_M = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
export const haversineM = (a: LatLng, b: LatLng): number => {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
};
/** Rumbo en grados (0 = norte, 90 = este) del punto a al punto b. */
export const bearingDeg = (a: LatLng, b: LatLng): number => {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};
export const pathLengthM = (pts: LatLng[]): number => { let m = 0; for (let i = 1; i < pts.length; i++) m += haversineM(pts[i - 1], pts[i]); return m; };

/** Puntos a lo largo de una línea cada `everyM` metros, con el rumbo del tramo (para dibujar flechas de dirección). */
export function pointsAlong(pts: LatLng[], everyM: number): { at: LatLng; bearing: number }[] {
  const out: { at: LatLng; bearing: number }[] = [];
  let carry = everyM / 2;                                   // la primera flecha a media distancia, no pegada al origen
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], seg = haversineM(a, b);
    if (seg === 0) continue;
    let d = carry;
    while (d <= seg) {
      const f = d / seg;
      out.push({ at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bearing: bearingDeg(a, b) });
      d += everyM;
    }
    carry = d - seg;
  }
  return out;
}

// ---------- optimizador ----------
export const DEFAULT_SPEED_MS = 30 / 3.6;                   // 30 km/h urbano, para estimar tiempos cuando no hay calles
export const CIRCUITY = 1.35;                               // la calle es ~35 % más larga que la línea recta en ciudad

/** Matriz de tiempos (segundos) estimada con línea recta × factor urbano: respaldo cuando OSRM no responde. */
export function haversineDurations(points: LatLng[]): number[][] {
  return points.map(a => points.map(b => (haversineM(a, b) * CIRCUITY) / DEFAULT_SPEED_MS));
}

export interface OptimizeInput {
  /** cost[i][j] = costo de ir del punto i al punto j (puede ser asimétrico, p. ej. por calles de un solo sentido). */
  cost: number[][];
  /** startCost[j] = costo de ir desde el origen hasta el punto j; si no hay origen, omitirlo (el recorrido empieza donde convenga). */
  startCost?: number[];
  /** Tope de tiempo de mejora, en ms (por defecto 500). */
  budgetMs?: number;
}

/** Costo total de un recorrido abierto: origen (opcional) → orden[0] → … → orden[n-1]. No vuelve al inicio. */
export function tourCost(order: number[], cost: number[][], startCost?: number[]): number {
  if (order.length === 0) return 0;
  let c = startCost ? startCost[order[0]] : 0;
  for (let k = 1; k < order.length; k++) c += cost[order[k - 1]][order[k]];
  return c;
}

/** Recorrido abierto de menor tiempo (heurístico): vecino más cercano y luego 2-opt + Or-opt hasta que ya no mejora o se acaba el tiempo. */
export function optimizeOrder({ cost, startCost, budgetMs = 500 }: OptimizeInput): number[] {
  const n = cost.length;
  if (n <= 1) return n === 1 ? [0] : [];
  const deadline = Date.now() + budgetMs;

  // 1) vecino más cercano. Sin origen se prueba cada punto como inicio y se queda con el mejor (el empate se resuelve por menor índice).
  const nearest = (first: number): number[] => {
    const order = [first], used = new Array<boolean>(n).fill(false);
    used[first] = true;
    for (let k = 1; k < n; k++) {
      const last = order[order.length - 1];
      let best = -1, bestC = Infinity;
      for (let j = 0; j < n; j++) if (!used[j] && cost[last][j] < bestC) { bestC = cost[last][j]; best = j; }
      order.push(best); used[best] = true;
    }
    return order;
  };
  let tour: number[];
  if (startCost) {
    let first = 0;
    for (let j = 1; j < n; j++) if (startCost[j] < startCost[first]) first = j;
    tour = nearest(first);
  } else {
    tour = nearest(0); let best = tourCost(tour, cost);
    for (let s = 1; s < n; s++) { const t = nearest(s), c = tourCost(t, cost); if (c < best - 1e-9) { best = c; tour = t; } }
  }

  // 2) mejora local. Cada candidato se evalúa completo (O(n)): correcto con costos asimétricos y suficiente para las ~50-150 paradas de un conductor.
  const EPS = 1e-6;
  let cur = tourCost(tour, cost, startCost);
  let improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;
    // 2-opt: invertir el tramo i..j
    for (let i = 0; i < n - 1 && !improved; i++) {
      for (let j = i + 1; j < n; j++) {
        const cand = [...tour.slice(0, i), ...tour.slice(i, j + 1).reverse(), ...tour.slice(j + 1)];
        const c = tourCost(cand, cost, startCost);
        if (c < cur - EPS) { tour = cand; cur = c; improved = true; break; }
      }
      if (Date.now() >= deadline) break;
    }
    if (improved) continue;
    // Or-opt: mover un tramo de 1 a 3 paradas a otra posición (también invertido)
    for (let len = 1; len <= 3 && !improved; len++) {
      for (let i = 0; i + len <= n && !improved; i++) {
        const seg = tour.slice(i, i + len), rest = [...tour.slice(0, i), ...tour.slice(i + len)];
        for (let p = 0; p <= rest.length; p++) {
          if (p === i) continue;                          // misma posición que ya tenía
          for (const s of len === 1 ? [seg] : [seg, [...seg].reverse()]) {
            const cand = [...rest.slice(0, p), ...s, ...rest.slice(p)];
            const c = tourCost(cand, cost, startCost);
            if (c < cur - EPS) { tour = cand; cur = c; improved = true; break; }
          }
          if (improved) break;
        }
        if (Date.now() >= deadline) break;
      }
    }
  }
  return tour;
}

// ---------- calles (OSRM) ----------
export const DEFAULT_OSRM_URL = 'https://router.project-osrm.org';
export interface RoutingOptions { baseUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number; minIntervalMs?: number; breakerMs?: number }

const cache = new Map<string, Promise<unknown | null>>();
let lastCallAt = 0;
let downUntil = 0;                                           // corte de circuito: mientras dure, no se vuelve a llamar al servicio
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Olvida la caché y el corte de circuito (para pruebas). */
export const resetOsrmState = () => { cache.clear(); lastCallAt = 0; downUntil = 0; };
/**
 * Pide una URL de OSRM con tiempo máximo, separación mínima entre llamadas (el servicio público pide no abusar) y caché por URL.
 * Reintenta una vez solo si el fallo fue rápido (error de red, 429 o 5xx); si se agotó el tiempo NO reintenta (ya esperó lo suficiente).
 * Si el servicio no responde, deja de intentarlo durante `breakerMs` (1 min): el administrador espera a lo más un tiempo máximo, no uno por consulta.
 */
async function osrmGet(url: string, o: RoutingOptions): Promise<any | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  if (Date.now() < downUntil) return null;
  const run = (async () => {
    const f = o.fetchFn || fetch;
    const timeoutMs = o.timeoutMs ?? 7000;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() < downUntil) return null;
      const wait = (o.minIntervalMs ?? 250) - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      const t0 = Date.now();
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      let retryable = true;
      try {
        const res = await f(url, ctrl ? { signal: ctrl.signal } : undefined);
        if (res.ok) { const body = await res.json(); return body && body.code === 'Ok' ? body : null; }
        retryable = res.status >= 500 || res.status === 429;
        if (!retryable) return null;                          // error del pedido (p. ej. 400): reintentar no sirve y el servicio sí funciona
      } catch { retryable = Date.now() - t0 < timeoutMs * 0.8; /* red caída rápido: se reintenta; tiempo agotado: no */ }
      finally { if (timer) clearTimeout(timer); }
      if (!retryable || attempt === 1) break;
      await sleep(600);
    }
    downUntil = Date.now() + (o.breakerMs ?? 60000);
    return null;
  })();
  cache.set(url, run);
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  const out = await run;
  if (out === null) cache.delete(url);                       // un fallo no se queda en la caché
  return out;
}
const coordsParam = (pts: LatLng[]) => pts.map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';');
const baseOf = (o: RoutingOptions) => (o.baseUrl || DEFAULT_OSRM_URL).replace(/\/$/, '');

/** Tiempos (s) y distancias (m) por calles entre todos los puntos; null si el servicio no responde o hay demasiados puntos (el público admite 100). */
export async function osrmTable(points: LatLng[], o: RoutingOptions = {}): Promise<{ durations: number[][]; distances: number[][] } | null> {
  if (points.length < 2 || points.length > 90) return null;
  const body = await osrmGet(`${baseOf(o)}/table/v1/driving/${coordsParam(points)}?annotations=duration,distance`, o);
  if (!body || !Array.isArray(body.durations) || !Array.isArray(body.distances)) return null;
  const ok = (m: unknown) => Array.isArray(m) && m.length === points.length && (m as unknown[][]).every(r => Array.isArray(r) && r.length === points.length && r.every(v => typeof v === 'number' && Number.isFinite(v)));
  return ok(body.durations) && ok(body.distances) ? { durations: body.durations, distances: body.distances } : null;
}

export interface Leg { distanceM: number; durationS: number }
export interface RoadRoute { geometry: LatLng[]; legs: Leg[]; distanceM: number; durationS: number; usesStreets: boolean }

const straightRoute = (pts: LatLng[]): RoadRoute => {
  const legs: Leg[] = [];
  for (let i = 1; i < pts.length; i++) { const d = haversineM(pts[i - 1], pts[i]) * CIRCUITY; legs.push({ distanceM: d, durationS: d / DEFAULT_SPEED_MS }); }
  return { geometry: pts, legs, distanceM: legs.reduce((a, l) => a + l.distanceM, 0), durationS: legs.reduce((a, l) => a + l.durationS, 0), usesStreets: false };
};

/** Trazado por calles pasando por los puntos en ese orden. Trozos de hasta 40 puntos (con 1 de traslape); si algún trozo falla, ese tramo va en línea recta. */
export async function osrmRoute(pts: LatLng[], o: RoutingOptions = {}): Promise<RoadRoute> {
  if (pts.length < 2) return { geometry: [...pts], legs: [], distanceM: 0, durationS: 0, usesStreets: pts.length > 0 };
  const CHUNK = 40;
  const geometry: LatLng[] = [], legs: Leg[] = [];
  let allStreets = true;
  for (let start = 0; start < pts.length - 1; start += CHUNK - 1) {
    const part = pts.slice(start, Math.min(pts.length, start + CHUNK));
    if (part.length < 2) break;
    const body = await osrmGet(`${baseOf(o)}/route/v1/driving/${coordsParam(part)}?overview=full&geometries=geojson&steps=false`, o);
    const r = body && Array.isArray(body.routes) ? body.routes[0] : null;
    const coords: [number, number][] | null = r && r.geometry && Array.isArray(r.geometry.coordinates) ? r.geometry.coordinates : null;
    if (r && coords && coords.length >= 2 && Array.isArray(r.legs) && r.legs.length === part.length - 1) {
      const line = coords.map(c => [c[1], c[0]] as LatLng);
      geometry.push(...(geometry.length ? line.slice(1) : line));
      for (const l of r.legs) legs.push({ distanceM: Number(l.distance) || 0, durationS: Number(l.duration) || 0 });
    } else {
      allStreets = false;
      const s = straightRoute(part);
      geometry.push(...(geometry.length ? s.geometry.slice(1) : s.geometry)); legs.push(...s.legs);
    }
  }
  return { geometry, legs, distanceM: legs.reduce((a, l) => a + l.distanceM, 0), durationS: legs.reduce((a, l) => a + l.durationS, 0), usesStreets: allStreets };
}

// ---------- ruta sugerida ----------
export interface PlannedRoute extends RoadRoute {
  order: (RouteStop & { lat: number; lng: number })[];        // paradas pendientes en el orden sugerido
  start: LatLng | null;
  startKind: 'driver' | 'lastStop' | 'free';
  /** distancia/tiempo de las paradas en el orden en que están hoy (para mostrar cuánto mejora el orden sugerido) */
  baselineDurationS: number | null;
}

/**
 * Orden sugerido de las paradas pendientes saliendo de `start` (posición del conductor o última parada hecha; sin origen, el recorrido
 * empieza por donde convenga) y su trazado por calles. `legs[k]` es el tramo hacia la parada k (el primero sale del origen).
 */
export async function planRemainingRoute(opts: { stops: (RouteStop & { lat: number; lng: number })[]; start: LatLng | null; startKind: PlannedRoute['startKind']; routing?: RoutingOptions }): Promise<PlannedRoute> {
  const { stops, start, startKind, routing = {} } = opts;
  if (stops.length === 0) return { order: [], start, startKind, geometry: start ? [start] : [], legs: [], distanceM: 0, durationS: 0, usesStreets: true, baselineDurationS: null };
  const pts: LatLng[] = stops.map(s => [s.lat, s.lng]);
  const all: LatLng[] = start ? [start, ...pts] : pts;
  const table = await osrmTable(all, routing);
  const dur = table ? table.durations : haversineDurations(all);
  const off = start ? 1 : 0;
  const cost = pts.map((_, i) => pts.map((__, j) => dur[i + off][j + off]));
  const startCost = start ? pts.map((_, j) => dur[0][j + 1]) : undefined;
  const idx = optimizeOrder({ cost, startCost });
  const baseline = tourCost(pts.map((_, i) => i), cost, startCost);
  const ordered = idx.map(i => stops[i]);
  const road = await osrmRoute(start ? [start, ...ordered.map(s => [s.lat, s.lng] as LatLng)] : ordered.map(s => [s.lat, s.lng] as LatLng), routing);
  // sin origen no hay tramo hacia la primera parada: se antepone uno vacío para que legs[k] siempre corresponda a la parada k
  const legs = start ? road.legs : [{ distanceM: 0, durationS: 0 }, ...road.legs];
  return { ...road, legs, order: ordered, start, startKind, usesStreets: road.usesStreets && !!table, baselineDurationS: baseline };
}

/** Trazado por calles de la ruta ya realizada (en el orden real de las visitas). */
export async function planDoneRoute(visits: Visit[], routing: RoutingOptions = {}): Promise<RoadRoute> {
  return osrmRoute(visits.map(v => [v.stop.lat, v.stop.lng] as LatLng), routing);
}

/** Hora estimada de llegada a cada parada: sale de `from`, maneja cada tramo y se detiene `serviceSeconds` en cada parada. */
export function etaTimes(legs: Leg[], from: Date, serviceSeconds: number): Date[] {
  const out: Date[] = [];
  let t = from.getTime();
  for (let k = 0; k < legs.length; k++) { t += legs[k].durationS * 1000; out.push(new Date(t)); t += serviceSeconds * 1000; }
  return out;
}

export const SERVICE_SECONDS = 180;                          // 3 min por parada (estimado)

/** Recorta un texto largo con "…" (para direcciones largas en listas angostas). */
export const clipText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text);

export const fmtKm = (m: number) => `${(m / 1000).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
export const fmtDuration = (s: number) => {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
};
export const fmtClock = (d: Date | number | string, tz = 'America/Santiago') =>
  new Date(d).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
