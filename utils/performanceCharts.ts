// Configuraciones de Chart.js (v3, cargado por CDN en index.html) para el informe de rendimiento.
// Las mismas configuraciones se dibujan en pantalla y, fuera de pantalla, como imagen para el PDF.
import type { ClosureProfile, DriverPerformance } from './performanceTypes';

declare const Chart: any;

export const C = {
  indigo: '#4f46e5', indigoLight: '#c7d2fe', emerald: '#059669', amber: '#d97706', red: '#dc2626',
  slate: '#64748b', sky: '#0284c7', violet: '#7c3aed', grid: '#e2e8f0',
};

export const PROFILE_COLORS: Record<ClosureProfile, string> = {
  ON_TIME: '#059669', DELAYED: '#d97706', END_OF_DAY: '#dc2626', NO_DATA: '#94a3b8',
};

const fmtDay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const tick = { font: { size: 10 } };
const legendBottom = { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } };

const baseOptions = (extra: any = {}) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  ...extra,
});

const yScale = (title?: string, extra: any = {}) => ({
  beginAtZero: true, grid: { color: C.grid }, ticks: { ...tick, precision: 0 },
  title: title ? { display: true, text: title, font: { size: 10 } } : undefined, ...extra,
});

export function dailyChartConfig(daily: DriverPerformance['daily']) {
  const days = daily.filter(d => d.assigned > 0 || d.deliveredCount > 0);
  const rates = days.map(d => d.deliveryRate);
  const valid = rates.filter((r): r is number => r != null);
  const minRate = valid.length ? Math.min(...valid) : 100;
  return {
    type: 'bar',
    data: {
      labels: days.map(d => fmtDay(d.date)),
      datasets: [
        { type: 'bar', label: 'Asignados', data: days.map(d => d.assigned), backgroundColor: C.indigoLight, borderRadius: 3, order: 3 },
        { type: 'bar', label: 'Entregados', data: days.map(d => d.delivered), backgroundColor: C.indigo, borderRadius: 3, order: 2 },
        { type: 'line', label: '% Efectividad', data: rates, yAxisID: 'y1', borderColor: C.emerald, backgroundColor: C.emerald, pointRadius: 3, tension: 0.25, order: 1 },
      ],
    },
    options: baseOptions({
      plugins: { legend: legendBottom },
      scales: {
        x: { grid: { display: false }, ticks: { ...tick, maxRotation: 60 } },
        y: yScale('Paquetes'),
        y1: { position: 'right', min: Math.min(80, Math.floor(minRate / 5) * 5), max: 100, grid: { drawOnChartArea: false }, ticks: { ...tick, callback: (v: number) => `${v}%` } },
      },
    }),
  };
}

export function hourlyChartConfig(byHour: number[]) {
  const nz = byHour.map((v, i) => (v > 0 ? i : -1)).filter(i => i >= 0);
  const from = nz.length ? Math.max(Math.min(...nz) - 1, 0) : 8;
  const to = nz.length ? Math.min(Math.max(...nz) + 1, 23) : 22;
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return {
    type: 'bar',
    data: { labels: hours.map(h => `${String(h).padStart(2, '0')}h`), datasets: [{ label: 'Entregas', data: hours.map(h => byHour[h]), backgroundColor: C.sky, borderRadius: 3 }] },
    options: baseOptions({
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, ticks: tick }, y: yScale() },
    }),
  };
}

export function statusChartConfig(t: DriverPerformance['totals']) {
  const items = [
    { label: 'Entregados', v: t.delivered, c: C.emerald },
    { label: 'En ruta / pendientes', v: t.pending, c: C.amber },
    { label: 'Con problema abierto', v: t.problemOpen, c: C.red },
    { label: 'Cancelados', v: t.cancelled, c: C.slate },
    { label: 'Devueltos / reprogramados', v: t.returned, c: C.violet },
  ].filter(i => i.v > 0);
  const data = items.length ? items : [{ label: 'Sin datos', v: 1, c: '#e2e8f0' }];
  return {
    type: 'doughnut',
    data: { labels: data.map(i => (items.length ? `${i.label} (${i.v})` : i.label)), datasets: [{ data: data.map(i => i.v), backgroundColor: data.map(i => i.c), borderWidth: 1 }] },
    options: baseOptions({ cutout: '58%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 } } } } }),
  };
}

export function paceChartConfig(daily: DriverPerformance['daily'], fleetAvg: number | null) {
  const days = daily.filter(d => d.deliveredCount > 0);
  const datasets: any[] = [
    { label: 'Min por entrega', data: days.map(d => d.avgMinutesPerDelivery), borderColor: C.indigo, backgroundColor: C.indigo, pointRadius: 3, tension: 0.2, spanGaps: false },
  ];
  if (fleetAvg != null) {
    datasets.push({ label: `Promedio de la flota (${fleetAvg})`, data: days.map(() => fleetAvg), borderColor: C.slate, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 });
  }
  return {
    type: 'line',
    data: { labels: days.map(d => fmtDay(d.date)), datasets },
    options: baseOptions({
      plugins: { legend: legendBottom },
      scales: { x: { grid: { display: false }, ticks: { ...tick, maxRotation: 60 } }, y: yScale('Minutos') },
    }),
  };
}

export function closureChartConfig(daily: DriverPerformance['daily'], lateMinutes: number) {
  const days = daily.filter(d => d.mlCount > 0);
  return {
    type: 'bar',
    data: {
      labels: days.map(d => fmtDay(d.date)),
      datasets: [
        { type: 'bar', label: 'Demora promedio de cierre en la app (min)', data: days.map(d => d.avgMlDelayMin), backgroundColor: days.map(d => PROFILE_COLORS[d.closureProfile]), borderRadius: 3 },
        { type: 'line', label: `Límite de cierre tardío (${lateMinutes} min)`, data: days.map(() => lateMinutes), borderColor: C.red, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.2 },
      ],
    },
    options: baseOptions({
      // Sin leyenda propia: el color de cada barra depende del perfil del día y lo explica una leyenda
      // aparte (la de Chart.js mostraría solo el color de la primera barra).
      plugins: { legend: { display: false } },
      scales: { x: { grid: { display: false }, ticks: { ...tick, maxRotation: 60 } }, y: yScale('Minutos') },
    }),
  };
}

export function horizontalBarConfig(items: { label: string; value: number }[], color: string, label: string) {
  return {
    type: 'bar',
    data: { labels: items.map(i => (i.label.length > 34 ? `${i.label.slice(0, 33)}…` : i.label)), datasets: [{ label, data: items.map(i => i.value), backgroundColor: color, borderRadius: 3 }] },
    options: baseOptions({
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: yScale(), y: { grid: { display: false }, ticks: tick } },
    }),
  };
}

/** Barras por conductor ordenadas (para la comparación de toda la flota). */
export function driversBarConfig(
  drivers: DriverPerformance[],
  getter: (d: DriverPerformance) => number | null,
  label: string,
  color: string,
  opts: { min?: number; max?: number; suffix?: string; order?: 'desc' | 'asc' } = {}
) {
  const rows = drivers
    .map(d => ({ name: d.driverName, v: getter(d) }))
    .filter((r): r is { name: string; v: number } => r.v != null)
    .sort((a, b) => (opts.order === 'asc' ? a.v - b.v : b.v - a.v));
  return {
    type: 'bar',
    data: {
      labels: rows.map(r => (r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name)),
      datasets: [{ label, data: rows.map(r => r.v), backgroundColor: color, borderRadius: 2 }],
    },
    options: baseOptions({
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 8 }, maxRotation: 90, minRotation: 60, autoSkip: false } },
        y: yScale(label, { min: opts.min, max: opts.max, ticks: { ...tick, callback: (v: number) => `${v}${opts.suffix || ''}` } }),
      },
    }),
  };
}

const WHITE_BG = {
  id: 'whiteBackground',
  beforeDraw: (chart: any) => {
    const { ctx, width, height } = chart;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  },
};

/** Dibuja un gráfico fuera de pantalla y lo devuelve como imagen PNG (2x) para incrustarlo en el PDF. */
export function chartToDataUrl(config: any, width: number, height: number): string {
  if (typeof Chart === 'undefined') throw new Error('Chart.js no está disponible (no cargó). Recarga la página e inténtalo de nuevo.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const chart = new Chart(canvas.getContext('2d'), {
    ...config,
    options: { ...config.options, responsive: false, maintainAspectRatio: false, animation: false, devicePixelRatio: 2 },
    plugins: [WHITE_BG],
  });
  const url = canvas.toDataURL('image/png');
  chart.destroy();
  return url;
}
