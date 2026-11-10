// Informe «Calidad de cierres»: tipos de la respuesta de GET /api/reports/closure-quality (calculada en services/closureReview.js) y utilidades de la pantalla
// (orden, fechas, CSV). Sin React ni red, para poder probarlo solo (tests/closureReview.test.js).

export interface ClosureThresholds {
  sameBits: number;      // ≤ estos bits entre huellas = la misma imagen aunque el archivo sea otro
  similarBits: number;   // ≤ estos bits = muy parecidas
  nameMinCount: number;  // nombre sin sentido: al menos tantos cierres…
  namePercent: number;   // …y este % de los suyos
  photoSame: number;     // fotos: tantos cierres con la misma imagen, o…
  photoSimilar: number;  // …tantos con fotos muy parecidas, o…
  photoReuse: number;    // …tantos con una foto reutilizada en otra dirección
}

export type ClosureCaseKind = 'NAME' | 'SAME_FILE' | 'SAME_IMAGE' | 'SIMILAR' | 'REUSED';

export interface ClosureDriverRow {
  driverId: string;
  name: string;
  status: string | null;
  closures: number;
  nameBad: number;
  nameBadPct: number;
  nameBreakdown: { empty: number; signs: number; short: number; filler: number };
  withPhotos: number;   // cierres con fotos guardadas
  scanned: number;      // de esos, los que ya tienen huellas
  pending: number;      // los que aún se están procesando
  reviewed: number;     // cierres con 2 o más fotos ya procesadas (se comparan entre sí)
  identical: number;    // dos fotos con los mismos bytes
  recompressed: number; // la misma imagen recomprimida
  sameImage: number;    // identical + recompressed
  similar: number;      // tomas casi iguales
  reused: number;       // foto ya usada por el mismo conductor en otra dirección
  flags: { name: boolean; photos: 'MAIN' | 'MINOR' | null };
  score: number;
}

export interface ClosureReviewReport {
  startDate: string;
  endDate: string;
  generatedAt: string;
  thresholds: ClosureThresholds;
  drivers: ClosureDriverRow[];
  totals: {
    drivers: number; closures: number; nameBad: number; nameBadPct: number; reviewed: number;
    sameImage: number; identical: number; similar: number; reused: number; flaggedName: number; flaggedPhotos: number;
  };
  coverage: { closures: number; withPhotos: number; scanned: number; pending: number };
  both: string[];
}

export interface ClosureCase {
  packageId: string;
  closedAt: string;
  receiverName: string;
  address: string;
  commune: string;
  photoCount: number;
  kinds: ClosureCaseKind[];
  minBits: number | null;
  reusedWith: { packageId: string; closedAt: string; address: string; commune: string }[];
}

export interface ClosureDriverCases {
  startDate: string;
  endDate: string;
  thresholds: ClosureThresholds;
  driver: ClosureDriverRow;
  cases: ClosureCase[];
  truncated: boolean;
  totalCases: number;
}

export const KIND_LABEL: Record<ClosureCaseKind, string> = {
  NAME: 'Nombre sin sentido',
  SAME_FILE: 'Mismo archivo',
  SAME_IMAGE: 'Misma imagen',
  SIMILAR: 'Muy parecidas',
  REUSED: 'Foto reutilizada',
};

export const KIND_HELP: Record<ClosureCaseKind, string> = {
  NAME: 'El nombre de quien recibe no dice quién recibió: un punto, una letra, relleno («aaa», «por»…).',
  SAME_FILE: 'Dos fotos del mismo cierre son exactamente el mismo archivo.',
  SAME_IMAGE: 'Dos fotos del mismo cierre son la misma imagen, aunque el archivo sea otro (recomprimida).',
  SIMILAR: 'Dos fotos del mismo cierre son casi iguales (la misma toma dos veces). Evidencia más débil: conviene mirarlas.',
  REUSED: 'El mismo archivo de foto ya lo usó este conductor en otra dirección.',
};

export const NAME_PROBLEM_LABEL = { empty: 'Vacío', signs: 'Solo signos (. ..)', short: 'Una o dos letras', filler: 'Relleno (aaa, por…)' } as const;

export type DriverSortKey = 'name' | 'closures' | 'nameBad' | 'nameBadPct' | 'reviewed' | 'sameImage' | 'similar' | 'reused' | 'score';

/** Conductores ordenados por una columna. `dir`: 'desc' = de mayor a menor. Desempata por gravedad y nombre. */
export function sortDrivers(drivers: ClosureDriverRow[], key: DriverSortKey, dir: 'asc' | 'desc'): ClosureDriverRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...drivers].sort((a, b) => {
    const primary = key === 'name' ? a.name.localeCompare(b.name, 'es') : (a[key] as number) - (b[key] as number);
    if (primary !== 0) return sign * primary;
    return (b.score - a.score) || a.name.localeCompare(b.name, 'es');
  });
}

/** ¿El conductor entra en alguna de las listas del informe? */
export const hasFindings = (d: ClosureDriverRow): boolean => d.flags.name || d.flags.photos !== null;

export const pctText = (part: number, whole: number): string => (whole > 0 ? `${Math.round((100 * part) / whole)} %` : '—');

/** YYYY-MM-DD + n días (calendario, sin zona horaria). */
export function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Cantidad de días entre dos fechas YYYY-MM-DD, ambas incluidas. */
export const daysInRange = (startIso: string, endIso: string): number =>
  Math.round((new Date(`${endIso}T12:00:00Z`).getTime() - new Date(`${startIso}T12:00:00Z`).getTime()) / 86400000) + 1;

/** CSV con todos los conductores (separador «;» para que Excel en español lo abra en columnas). El archivo que se descarga lleva además la marca BOM al inicio. */
export function closureReviewCsv(report: ClosureReviewReport, rows: ClosureDriverRow[] = report.drivers): string {
  const header = ['Conductor', `Cierres (${report.startDate} a ${report.endDate})`, 'Nombre sin sentido', '% de sus cierres', 'Solo signos (. ..)', 'Una o dos letras', 'Nombre vacío', 'Relleno (aaa, por…)',
    'Cierres con fotos', 'Fotos ya procesadas', 'Entregas con 2+ fotos revisadas', 'Misma imagen (archivo idéntico o recomprimida)', 'De ellas, mismo archivo', 'Fotos muy parecidas', 'Misma foto usada en otra dirección', 'Lista'];
  const list = (d: ClosureDriverRow) => [d.flags.name ? 'Nombre' : '', d.flags.photos === 'MAIN' ? 'Fotos' : d.flags.photos === 'MINOR' ? 'Fotos (casos aislados)' : ''].filter(Boolean).join(' + ');
  const body = rows.map(d => [d.name, d.closures, d.nameBad, d.nameBadPct, d.nameBreakdown.signs, d.nameBreakdown.short, d.nameBreakdown.empty, d.nameBreakdown.filler,
    d.withPhotos, d.scanned, d.reviewed, d.sameImage, d.identical, d.similar, d.reused, list(d)]);
  return [header, ...body].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}
