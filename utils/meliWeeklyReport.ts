// Lógica pura del informe de cumplimiento de entregas de Mercado Libre: suma por semana (lunes a domingo) y por seller los conteos diarios
// que entrega GET /api/reports/meli-weekly-delivery, calcula los porcentajes y decide qué queda "bajo la meta". Sin React ni red, para
// poder probarla con casos exactos.

export const TARGET_PCT = 97;          // meta de Mercado Libre: bajo este porcentaje hay riesgo de multa
export const CUTOFF_HOUR = 21;         // las entregas "a tiempo" son las hechas antes de las 21:00
export const LOW_VOLUME = 10;          // con menos paquetes, el porcentaje de la semana varía mucho por un solo paquete

export interface MeliWeeklyRow {
  day: string;                         // día de gestión (YYYY-MM-DD, día lógico con corte a las 02:00)
  clientId: string | null;
  clientName: string;
  clientIdentifier: string | null;
  accountId: string;
  accountName: string;
  total: number;                       // paquetes gestionados ese día (sin los "en ruta hoy")
  onTime: number;                      // entregados el mismo día antes de las 21:00
  lateSameDay: number;                 // entregados el mismo día desde las 21:00
  cancelled: number;
  rescheduled: number;
  reassignedDelivered: number;         // pasaron a otra jornada y se entregaron
  reassignedOpen: number;              // pasaron a otra jornada y siguen abiertos
  noClose: number;                     // sin entrega ni incidencia registrada
  inRouteToday: number;                // gestionados hoy y aún abiertos (no cuentan como fallo)
  delivered: number;                   // entregados en total (cualquier hora o día)
}

export interface MeliWeeklyExcluded { day: string; clientId: string | null; cancelledBeforeAssignment: number; deliveredOutside: number }

export interface MeliWeeklyMeta {
  tz: string; cutoffHour: number; targetPct: number; weekStart: string; weeks: number;
  fromDay: string; toDay: string; today: string; generatedAt: string;
}

export interface MeliWeeklyReport { meta: MeliWeeklyMeta; rows: MeliWeeklyRow[]; excluded: MeliWeeklyExcluded[] }

export type GroupBy = 'client' | 'account';

export interface Counts {
  total: number; onTime: number; lateSameDay: number; cancelled: number; rescheduled: number;
  reassigned: number; reassignedDelivered: number; reassignedOpen: number; noClose: number; inRouteToday: number; delivered: number;
}

export interface Stats extends Counts {
  onTimePct: number | null;            // truncado a 1 decimal (nunca se redondea hacia arriba)
  deliveredPct: number | null;
  onTimeBelow: boolean;                // bajo la meta, con la razón exacta (no con el valor ya truncado)
  deliveredBelow: boolean;
  atRisk: boolean;                     // alguno de los dos porcentajes bajo la meta
  lowVolume: boolean;
}

/**
 * `name` es el nombre completo ("Cliente · Cuenta" al agrupar por cuenta); `title` y `detail` son sus dos partes para mostrarlas en dos líneas.
 * `clientId` / `accountId` / `accountName` identifican al seller ante el servidor (el detalle por paquete los pide); la cuenta solo viene al agrupar por cuenta.
 */
export interface SellerStats extends Stats {
  key: string; name: string; title: string; detail: string | null; identifier: string | null; accounts: string[];
  clientId: string | null; accountId: string | null; accountName: string | null;
}

/** Recorta un texto largo con "…" (para donde no cabe: en el PDF no se puede confiar en el recorte automático del navegador). */
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text);

/** Cómo se calcula el informe: se muestra en pantalla ("Cómo se calcula"), en el Excel y en el PDF, siempre el mismo texto. */
export const METHOD_NOTES: string[] = [
  'Base de cálculo: envíos de Mercado Libre gestionados por la operación (con conductor asignado o despachado a ruta). Cada paquete se cuenta una sola vez, en su día de gestión: el día en que salió a ruta por primera vez (si nunca salió a ruta, el de su primer movimiento). La semana va de lunes a domingo y el día lógico termina a las 02:00.',
  'Antes de las 21:00: entregados el mismo día de su gestión, antes de las 21:00. Después de las 21:00: entregados ese mismo día, desde las 21:00.',
  'Total entregados: todos los paquetes de la semana que se entregaron, a cualquier hora y también en días posteriores (incluye los entregados después de las 21:00 y los que pasaron a otra jornada).',
  'No entregados el mismo día: Cancelados (estado cancelado); Reprogramados (el cliente pidió reagendar); Reasignados otro día (no se entregaron el día de su gestión y pasaron a otra jornada, estén ya entregados o aún abiertos). Cada paquete cuenta en una sola de estas categorías, en ese orden de prioridad.',
  'Sin cierre: gestionados en un día anterior, sin entrega ni incidencia registrada. Los gestionados hoy que siguen abiertos (en ruta) no se cuentan hasta que termine el día.',
  'Hora de entrega: el primer registro entre el cierre en la app y el cierre oficial detectado en Mercado Libre. Este último es la hora en que el sistema lo detectó (revisa cada pocos minutos), por lo que puede llegar unos minutos tarde.',
  'No incluye los envíos de las cuentas conectadas que ningún conductor gestionó (cancelados antes de asignarse o entregados por otros medios): se informan aparte.',
  `Los porcentajes se truncan a 1 decimal (96,96 % se muestra como 96,9 %), así lo que se ve coincide siempre con lo que se marca. En rojo: porcentaje bajo la meta de ${TARGET_PCT} %.`,
];

// ---------- fechas (todo en YYYY-MM-DD, sin horas: el servidor ya entrega días lógicos) ----------
const parse = (iso: string) => new Date(`${iso}T12:00:00Z`);
export const addDays = (iso: string, n: number): string => { const d = parse(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const mondayOf = (iso: string): string => addDays(iso, -((parse(iso).getUTCDay() + 6) % 7));
export const weekDays = (weekStart: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
export const weeksEndingAt = (lastWeekStart: string, n: number): string[] => Array.from({ length: n }, (_, i) => addDays(lastWeekStart, -7 * (n - 1 - i)));

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DAYS_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
export const dayLabel = (iso: string) => `${DAYS_SHORT[parse(iso).getUTCDay()]} ${Number(iso.slice(8, 10))}`;
export const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
export const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
/** "12 – 18 oct 2026" (o "28 sep – 4 oct 2026" cuando la semana cruza de mes). */
export const weekLabel = (weekStart: string): string => {
  const end = addDays(weekStart, 6);
  const sameMonth = weekStart.slice(0, 7) === end.slice(0, 7);
  return sameMonth
    ? `${Number(weekStart.slice(8, 10))} – ${Number(end.slice(8, 10))} ${MONTHS[Number(end.slice(5, 7)) - 1]} ${end.slice(0, 4)}`
    : `${shortDate(weekStart)} – ${shortDate(end)} ${end.slice(0, 4)}`;
};

// ---------- porcentajes ----------
/** Porcentaje truncado a 1 decimal con aritmética entera exacta (96,96 % → 96,9 %, jamás 97,0 %): lo que se ve y lo que se marca siempre coinciden. */
export const pctFloor = (n: number, d: number): number | null => (d > 0 ? Math.floor((n * 1000) / d) / 10 : null);
/** ¿La razón n/d está estrictamente por debajo de la meta? Comparación exacta con enteros (97,0 % justo NO está bajo la meta). */
export const isBelow = (n: number, d: number, target: number = TARGET_PCT): boolean => d > 0 && n * 100 < target * d;
export const fmtInt = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('es-CL'));
export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${v.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
/** Variación en puntos porcentuales respecto a otra semana ("+1,2 pp"); null si falta alguno de los dos. */
export const deltaPp = (curr: number | null, prev: number | null): number | null => (curr == null || prev == null ? null : Math.round((curr - prev) * 10) / 10);
export const fmtDelta = (v: number | null) => (v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pp`);

// ---------- conteos ----------
export const emptyCounts = (): Counts => ({ total: 0, onTime: 0, lateSameDay: 0, cancelled: 0, rescheduled: 0, reassigned: 0, reassignedDelivered: 0, reassignedOpen: 0, noClose: 0, inRouteToday: 0, delivered: 0 });
export const addRow = (c: Counts, r: MeliWeeklyRow): Counts => {
  c.total += r.total; c.onTime += r.onTime; c.lateSameDay += r.lateSameDay; c.cancelled += r.cancelled; c.rescheduled += r.rescheduled;
  c.reassignedDelivered += r.reassignedDelivered; c.reassignedOpen += r.reassignedOpen; c.reassigned += r.reassignedDelivered + r.reassignedOpen;
  c.noClose += r.noClose; c.inRouteToday += r.inRouteToday; c.delivered += r.delivered;
  return c;
};
export const addCounts = (a: Counts, b: Counts): Counts => ({
  total: a.total + b.total, onTime: a.onTime + b.onTime, lateSameDay: a.lateSameDay + b.lateSameDay, cancelled: a.cancelled + b.cancelled,
  rescheduled: a.rescheduled + b.rescheduled, reassigned: a.reassigned + b.reassigned, reassignedDelivered: a.reassignedDelivered + b.reassignedDelivered,
  reassignedOpen: a.reassignedOpen + b.reassignedOpen, noClose: a.noClose + b.noClose, inRouteToday: a.inRouteToday + b.inRouteToday, delivered: a.delivered + b.delivered,
});

export const toStats = (c: Counts, target: number = TARGET_PCT): Stats => {
  const onTimeBelow = isBelow(c.onTime, c.total, target);
  const deliveredBelow = isBelow(c.delivered, c.total, target);
  return { ...c, onTimePct: pctFloor(c.onTime, c.total), deliveredPct: pctFloor(c.delivered, c.total), onTimeBelow, deliveredBelow, atRisk: onTimeBelow || deliveredBelow, lowVolume: c.total > 0 && c.total < LOW_VOLUME };
};

const sellerKey = (r: MeliWeeklyRow, by: GroupBy) => (by === 'account' ? `${r.clientId ?? ''}|${r.accountId}|${r.accountName}` : (r.clientId ?? `sin-cliente:${r.clientName}`));
const sellerName = (r: MeliWeeklyRow, by: GroupBy) => (by === 'account' ? `${r.clientName} · ${r.accountName}` : r.clientName);

/** Suma las filas de UNA semana por seller (cliente, o cuenta de Mercado Libre). Solo incluye sellers con paquetes gestionados en la semana. */
export function sellersForWeek(rows: MeliWeeklyRow[], weekStart: string, by: GroupBy = 'client', target: number = TARGET_PCT): SellerStats[] {
  const end = addDays(weekStart, 6);
  const map = new Map<string, { name: string; title: string; detail: string | null; identifier: string | null; clientId: string | null; accountId: string | null; accountName: string | null; accounts: Set<string>; counts: Counts }>();
  for (const r of rows) {
    if (r.day < weekStart || r.day > end) continue;
    const k = sellerKey(r, by);
    if (!map.has(k)) map.set(k, { name: sellerName(r, by), title: r.clientName, detail: by === 'account' ? r.accountName : null, identifier: r.clientIdentifier, clientId: r.clientId, accountId: by === 'account' ? r.accountId : null, accountName: by === 'account' ? r.accountName : null, accounts: new Set(), counts: emptyCounts() });
    const m = map.get(k)!;
    m.accounts.add(r.accountName);
    addRow(m.counts, r);
  }
  return [...map.entries()]
    .filter(([, m]) => m.counts.total > 0 || m.counts.inRouteToday > 0)
    .map(([key, m]) => ({ key, name: m.name, title: m.title, detail: m.detail, identifier: m.identifier, clientId: m.clientId, accountId: m.accountId, accountName: m.accountName, accounts: [...m.accounts].sort(), ...toStats(m.counts, target) }));
}

/** Total de todos los sellers de una semana. */
export const totalsForWeek = (rows: MeliWeeklyRow[], weekStart: string, target: number = TARGET_PCT): Stats => {
  const end = addDays(weekStart, 6);
  const c = emptyCounts();
  for (const r of rows) if (r.day >= weekStart && r.day <= end) addRow(c, r);
  return toStats(c, target);
};

/** Una fila por semana (para la tendencia), de la más antigua a la más reciente. */
export const weeklyTrend = (rows: MeliWeeklyRow[], weekStarts: string[], target: number = TARGET_PCT) =>
  weekStarts.map(w => ({ weekStart: w, label: shortDate(w), ...totalsForWeek(rows, w, target) }));

/** Desglose por día (lunes a domingo) de un seller (o de todos si `key` es null) en una semana. */
export function dailyForWeek(rows: MeliWeeklyRow[], weekStart: string, key: string | null, by: GroupBy = 'client', target: number = TARGET_PCT) {
  return weekDays(weekStart).map(day => {
    const c = emptyCounts();
    for (const r of rows) if (r.day === day && (key == null || sellerKey(r, by) === key)) addRow(c, r);
    return { day, label: dayLabel(day), ...toStats(c, target) };
  });
}

/** Envíos que la operación NO gestionó (no entran a los porcentajes): cancelados antes de asignarse y entregados por otros medios. */
export const excludedForWeek = (excluded: MeliWeeklyExcluded[], weekStart: string) => {
  const end = addDays(weekStart, 6);
  return excluded.reduce((a, e) => (e.day >= weekStart && e.day <= end ? { cancelledBeforeAssignment: a.cancelledBeforeAssignment + e.cancelledBeforeAssignment, deliveredOutside: a.deliveredOutside + e.deliveredOutside } : a), { cancelledBeforeAssignment: 0, deliveredOutside: 0 });
};

export type SortKey = 'name' | 'total' | 'onTimePct' | 'lateSameDay' | 'deliveredPct' | 'cancelled' | 'rescheduled' | 'reassigned' | 'noClose';
/** Orden de la tabla: por defecto el peor primero (menor % antes de las 21:00); los sellers sin porcentaje van al final. */
export function sortSellers(list: SellerStats[], key: SortKey, dir: 'asc' | 'desc'): SellerStats[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    if (key === 'name') return sign * a.name.localeCompare(b.name, 'es');
    const av = a[key] as number | null, bv = b[key] as number | null;
    if (av == null && bv == null) return a.name.localeCompare(b.name, 'es');
    if (av == null) return 1;
    if (bv == null) return -1;
    return av === bv ? b.total - a.total || a.name.localeCompare(b.name, 'es') : sign * (av - bv);
  });
}

// ---------- detalle por paquete (qué paquetes causaron el retraso y qué conductor los tenía) ----------
// Lo entrega GET /api/reports/meli-weekly-delivery/detail con la MISMA clasificación que los conteos de arriba: la suma por categoría
// coincide con las columnas Después / Cancel. / Reprog. / Reasig. de la tabla por día.

export type DelayOutcome = 'LATE_SAME_DAY' | 'CANCELLED' | 'RESCHEDULED' | 'REASSIGNED_DELIVERED' | 'REASSIGNED_OPEN' | 'NO_CLOSE';
/** Las categorías como las ve el usuario en la tabla por día (los dos tipos de "reasignado" se muestran juntos, igual que la columna Reasig.). */
export type DelayGroup = 'late' | 'cancelled' | 'rescheduled' | 'reassigned' | 'noClose';
export const GROUP_ORDER: DelayGroup[] = ['late', 'cancelled', 'rescheduled', 'reassigned', 'noClose'];
export const OUTCOME_GROUP: Record<DelayOutcome, DelayGroup> = {
  LATE_SAME_DAY: 'late', CANCELLED: 'cancelled', RESCHEDULED: 'rescheduled', REASSIGNED_DELIVERED: 'reassigned', REASSIGNED_OPEN: 'reassigned', NO_CLOSE: 'noClose',
};
export const GROUP_LABEL: Record<DelayGroup, string> = {
  late: `Entregado después de las ${CUTOFF_HOUR}:00`, cancelled: 'Cancelado', rescheduled: 'Reprogramado', reassigned: 'Reasignado a otro día', noClose: 'Sin cierre registrado',
};
/** Versión corta para las pastillas de filtro. */
export const GROUP_SHORT: Record<DelayGroup, string> = { late: `Después de las ${CUTOFF_HOUR}:00`, cancelled: 'Cancelados', rescheduled: 'Reprogramados', reassigned: 'Reasignados', noClose: 'Sin cierre' };

export type StoryKind = 'dispatch' | 'assign' | 'reassign' | 'unassign' | 'delivered_app' | 'delivered_ml' | 'cancelled' | 'rescheduled' | 'problem';
export interface DelayStoryStep { at: string; kind: StoryKind; who: string | null; from: string | null; text: string | null }

export interface DelayItem {
  id: string;                          // código interno del paquete (se busca en la lista de paquetes)
  meliOrderId: string | null;          // id del envío en Mercado Libre
  meliFlexCode: string | null;
  commune: string | null;
  clientId: string | null; accountId: string; accountName: string;
  day: string;                         // día de gestión (YYYY-MM-DD)
  outcome: DelayOutcome;
  status: string;                      // estado actual del paquete
  deliveredAt: string | null;          // primer registro de entrega (ISO)
  deliveredDay: string | null;
  deliveredVia: 'app' | 'ml' | null;   // de dónde sale esa hora: cierre en la app o entrega detectada en Mercado Libre
  lateMinutes: number | null;          // solo "después de las 21:00": minutos pasados de la hora de corte
  driver: string | null;               // conductor responsable
  driverBasis: 'holder' | 'before' | 'after' | 'current' | null;   // holder = lo tenía asignado en el momento clave; el resto es aproximado
  driverSince: string | null;          // desde cuándo lo tenía
  finalDriver: string | null;          // quien lo tiene/entregó al final, si es otro
  drivers: string[];                   // todos por los que pasó, en orden
  reason: string | null;               // motivo de la cancelación o del "reagendar"
  story: DelayStoryStep[];
}
export interface DelayDetailMeta { tz: string; cutoffHour: number; weekStart: string; fromDay: string; toDay: string; today: string; generatedAt: string }
export interface DelayDetail { meta: DelayDetailMeta; items: DelayItem[] }

export interface DelayFilter { day: string | null; group: DelayGroup | null; driver: string | null }
export const NO_FILTER: DelayFilter = { day: null, group: null, driver: null };
export const isFiltered = (f: DelayFilter): boolean => !!(f.day || f.group || f.driver);
export const NO_DRIVER = 'Sin conductor registrado';
export const driverOf = (i: DelayItem): string => i.driver || NO_DRIVER;

/** Aplica el filtro; `ignore` deja fuera una de las condiciones (para saber cuántos habría con otra pastilla elegida). */
export const filterDelay = (items: DelayItem[], f: DelayFilter, ignore?: keyof DelayFilter): DelayItem[] =>
  items.filter(i => (ignore === 'day' || !f.day || i.day === f.day)
    && (ignore === 'group' || !f.group || OUTCOME_GROUP[i.outcome] === f.group)
    && (ignore === 'driver' || !f.driver || driverOf(i) === f.driver));

/** Cuántos paquetes hay en cada categoría respetando el día y el conductor elegidos. */
export const groupCounts = (items: DelayItem[], f: DelayFilter): Record<DelayGroup, number> => {
  const c: Record<DelayGroup, number> = { late: 0, cancelled: 0, rescheduled: 0, reassigned: 0, noClose: 0 };
  for (const i of filterDelay(items, f, 'group')) c[OUTCOME_GROUP[i.outcome]]++;
  return c;
};
/** Cuántos paquetes tiene cada conductor respetando el día y la categoría elegidos; el que más tiene, primero. */
export const driverCounts = (items: DelayItem[], f: DelayFilter): { name: string; count: number }[] => {
  const m = new Map<string, number>();
  for (const i of filterDelay(items, f, 'driver')) m.set(driverOf(i), (m.get(driverOf(i)) || 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
};

// Horas en la zona horaria del sistema (el servidor la entrega en meta.tz). Los formateadores se reutilizan: crear uno por celda es lento.
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const fmt = (key: string, make: () => Intl.DateTimeFormat) => { let f = fmtCache.get(key); if (!f) { f = make(); fmtCache.set(key, f); } return f; };
export const fmtClock = (iso: string | null, tz: string): string =>
  (iso ? fmt(`c|${tz}`, () => new Intl.DateTimeFormat('es-CL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).format(new Date(iso)) : '—');
/** Fecha local (YYYY-MM-DD) de un instante. Es el día del calendario, no el día lógico de gestión. */
export const localDate = (iso: string, tz: string): string =>
  fmt(`d|${tz}`, () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })).format(new Date(iso));
/** "mar 27 14:16". */
export const fmtDayClock = (iso: string | null, tz: string): string => (iso ? `${dayLabel(localDate(iso, tz))} ${fmtClock(iso, tz)}` : '—');
/** Minutos de atraso en palabras: 18 → "18 min", 74 → "1 h 14 min", 120 → "2 h". */
export const fmtLate = (min: number): string => (min < 60 ? `${min} min` : min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60} min`);
/** "PADRE HURTADO" → "Padre Hurtado". */
export const titleCase = (s: string | null): string => (s ? s.toLowerCase().replace(/(^|[\s'-])([a-záéíóúñü])/g, (_m, a, b) => a + b.toUpperCase()) : '—');
const STATUS_LABEL: Record<string, string> = {
  EN_TRANSITO: 'En tránsito', ASIGNADO: 'Asignado', PENDIENTE: 'Pendiente', RETIRADO: 'Disponible, sin conductor', PROBLEMA: 'Con problema',
  REPROGRAMADO: 'Reprogramado', ENTREGADO: 'Entregado', CANCELADO: 'Cancelado', DEVUELTO: 'Devuelto',
};
export const statusLabel = (s: string): string => STATUS_LABEL[s] || (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '—');
