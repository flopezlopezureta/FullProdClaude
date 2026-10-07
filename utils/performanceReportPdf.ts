// PDF del informe de rendimiento de conductores (uno, varios o toda la flota), A4 horizontal.
// Por conductor: hoja de resumen (KPIs + gráficos), hoja de ritmo/cierre/zonas y, opcionalmente, el
// detalle diario. Para varios conductores antepone una comparativa de toda la flota.
import type { DriverPerformance, PerformanceReport, ClosureProfile } from './performanceTypes';
import { SOURCE_LABELS } from './performanceTypes';
import { renderPagesToPdf, esc } from './pdfPages';
import {
  C, PROFILE_COLORS, dailyChartConfig, hourlyChartConfig, statusChartConfig, paceChartConfig,
  closureChartConfig, horizontalBarConfig, driversBarConfig, chartToDataUrl, rateAxisMin,
} from './performanceCharts';
import { CLOSURE_PROFILE_LABELS, PROFILE_STYLES } from './chronometryPoster';

export type Tone = 'good' | 'bad' | 'neutral';
export const TONE_COLOR: Record<Tone, string> = { good: '#047857', bad: '#b91c1c', neutral: '#64748b' };
const FONT = "'Segoe UI',Roboto,Arial,sans-serif";

const n0 = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('es-CL'));
const n1 = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pctTxt = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${n1(v, d)}%`);
const share = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
export const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** Compara un valor contra el promedio de la flota (verde = mejor, rojo = peor). */
export function vs(value: number | null, fleet: number | null, o: { higherBetter?: boolean; unit?: string; digits?: number; neutral?: boolean }): { text: string; tone: Tone } {
  const unit = o.unit || '';
  const digits = o.digits ?? 1;
  if (fleet == null) return { text: 'Flota: sin dato', tone: 'neutral' };
  if (value == null) return { text: `Flota: ${n1(fleet, digits)}${unit}`, tone: 'neutral' };
  const diff = value - fleet;
  const better = o.higherBetter ? diff > 0 : diff < 0;
  const tone: Tone = o.neutral || Math.abs(diff) < 10 ** -digits ? 'neutral' : better ? 'good' : 'bad';
  return { text: `Flota ${n1(fleet, digits)}${unit} · ${diff > 0 ? '+' : ''}${n1(diff, digits)}${unit}`, tone };
}

const kpi = (label: string, value: string, sub?: { text: string; tone: Tone } | string) => `
  <div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 11px;background:#fff;min-height:68px;box-sizing:border-box">
    <div style="font-size:8.5px;font-weight:800;letter-spacing:.08em;color:#64748b;text-transform:uppercase">${esc(label)}</div>
    <div style="font-size:23px;font-weight:900;color:#0f172a;line-height:1.15;margin-top:2px">${value}</div>
    ${sub ? `<div style="font-size:9.5px;font-weight:700;margin-top:1px;color:${typeof sub === 'string' ? '#64748b' : TONE_COLOR[sub.tone]}">${esc(typeof sub === 'string' ? sub : sub.text)}</div>` : ''}
  </div>`;

const box = (title: string, inner: string, style = '') => `
  <div style="border:1px solid #e2e8f0;border-radius:10px;padding:9px 12px;background:#fff;box-sizing:border-box;${style}">
    <div style="font-size:10px;font-weight:800;letter-spacing:.06em;color:#334155;text-transform:uppercase;margin-bottom:5px">${esc(title)}</div>
    ${inner}
  </div>`;

const img = (url: string, w: number, h: number) => `<img src="${url}" style="display:block;width:${w}px;height:${h}px"/>`;

const statLine = (label: string, value: string, tone?: Tone) => `
  <div style="display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed #e2e8f0;padding:3px 0;font-size:11px">
    <span style="color:#64748b">${esc(label)}</span><b style="color:${tone ? TONE_COLOR[tone] : '#0f172a'};text-align:right">${value}</b>
  </div>`;

const band = (kicker: string, title: string, rightTop: string, rightBottom: string) => `
  <div style="background:linear-gradient(90deg,#0f172a,#1e1b4b);border-radius:12px;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;color:#fff">
    <div>
      <div style="font-size:10.5px;letter-spacing:.28em;color:#a5b4fc;font-weight:800">${esc(kicker)}</div>
      <div style="font-size:26px;font-weight:900;letter-spacing:.03em;margin-top:2px;text-transform:uppercase">${esc(title)}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:15px;font-weight:800">${esc(rightTop)}</div>
      <div style="font-size:11px;color:#c7d2fe;margin-top:3px">${esc(rightBottom)}</div>
    </div>
  </div>`;

const strip = (title: string, right: string) => `
  <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #1e293b;padding-bottom:5px">
    <div style="font-size:16px;font-weight:900;letter-spacing:.05em;color:#0f172a;text-transform:uppercase">${esc(title)}</div>
    <div style="font-size:11px;color:#475569">${esc(right)}</div>
  </div>`;

const pill = (profile: ClosureProfile) => {
  const s = PROFILE_STYLES[profile];
  return `<span style="display:inline-block;padding:0 9px;height:17px;line-height:17px;vertical-align:middle;border-radius:9px;background:${s.bg};color:${s.fg};font-size:9.5px;font-weight:800;white-space:nowrap">${esc(CLOSURE_PROFILE_LABELS[profile])}</span>`;
};

function shell(inner: string, title: string, pageNo: number, total: number, generatedAt: string) {
  return `
  <div style="width:1122px;height:793px;box-sizing:border-box;padding:22px 28px 12px;background:#fff;display:flex;flex-direction:column;font-family:${FONT};color:#0f172a;overflow:hidden">
    <div style="flex:1;min-height:0">${inner}</div>
    <div style="display:flex;justify-content:space-between;font-size:9.5px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:5px;margin-top:6px">
      <span>Full Envíos · ${esc(title)} · Generado el ${esc(generatedAt)}</span><span>Hoja ${pageNo} de ${total}</span>
    </div>
  </div>`;
}

const periodText = (r: PerformanceReport) => `${dmy(r.period.startDate)} al ${dmy(r.period.endDate)}`;

// ---------------------------------------------------------------------------------------------
// Hojas por conductor
// ---------------------------------------------------------------------------------------------

function driverSheetA(d: DriverPerformance, r: PerformanceReport): string {
  const f = r.fleet.averages;
  const t = d.totals;
  const sources = d.mix.slice(0, 3).map(m => `${SOURCE_LABELS[m.source] || m.source} ${Math.round(m.count / Math.max(d.mix.reduce((s, x) => s + x.count, 0), 1) * 100)}%`).join(' · ') || '—';
  const topCommune = d.byCommune[0];
  const totalCommune = d.byCommune.reduce((s, c) => s + c.count, 0) || 1;

  const kpis = [
    kpi('Paquetes asignados', n0(t.assigned), `${t.daysWorked} días trabajados`),
    kpi('Entregados', n0(t.delivered), `${n1(t.avgDeliveriesPerDay)} por día · flota ${n1(f.avgDeliveriesPerDay)}`),
    kpi('Efectividad', pctTxt(t.deliveryRate), vs(t.deliveryRate, f.deliveryRate, { higherBetter: true, unit: '%' })),
    kpi('Incidencias', pctTxt(t.incidentRate), vs(t.incidentRate, f.incidentRate, { higherBetter: false, unit: '%' })),
    kpi('Min por entrega', n1(d.pace.avgMinutesPerDelivery), vs(d.pace.avgMinutesPerDelivery, f.avgMinutesPerDelivery, { higherBetter: false })),
    kpi('Horas en ruta / día', n1(d.pace.avgHoursActive, 2), d.pace.avgStart ? `Inicio ${d.pace.avgStart} · Fin ${d.pace.avgEnd}` : 'Sin días comparables'),
    kpi('Demora cierre en app', d.closure.avgMlDelayMin == null ? '—' : `${n0(d.closure.avgMlDelayMin)} min`, vs(d.closure.avgMlDelayMin, f.avgMlDelayMin, { higherBetter: false, unit: ' min', digits: 0 })),
    kpi('Cierres tardíos', share(d.closure.lateShare), d.closure.mlDeliveries ? `${d.closure.lateCount} de ${d.closure.mlDeliveries} entregas ML · flota ${share(f.lateShare)}` : 'Sin entregas de ML'),
  ].join('');

  const highlights = box('Resumen del período', [
    statLine('Mejor día', t.bestDay ? `${dmy(t.bestDay.date)} · ${t.bestDay.delivered} entregas` : '—'),
    statLine('Día más bajo', t.worstDay ? `${dmy(t.worstDay.date)} · ${t.worstDay.delivered} entregas` : '—'),
    statLine('Origen de los paquetes', esc(sources)),
    statLine('Comuna principal', topCommune ? `${esc(topCommune.commune)} (${Math.round(topCommune.count / totalCommune * 100)}%)` : '—'),
    statLine('Con foto de comprobante', pctTxt(t.photoRate), t.photoRate != null && t.photoRate < 95 ? 'bad' : undefined),
    statLine('Pendientes / cancelados', `${t.pending} / ${t.cancelled}`),
  ].join(''));

  return `
    ${band('Informe de rendimiento · Conductor', d.driverName, periodText(r), `${t.daysWorked} días con actividad${d.phone ? ` · ${d.phone}` : ''}`)}
    <div style="display:flex;gap:14px;margin-top:12px">
      <div style="width:350px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${kpis}</div>
        <div style="margin-top:10px">${highlights}</div>
      </div>
      <div style="flex:1;min-width:0">
        ${box('Entregas por día y % de efectividad', img(chartToDataUrl(dailyChartConfig(d.daily), 690, 310), 690, 310))}
        <div style="display:flex;gap:12px;margin-top:10px">
          ${box('Entregas por hora del día', img(chartToDataUrl(hourlyChartConfig(d.byHour), 330, 228), 330, 228), 'flex:1')}
          ${box('Estado de los paquetes asignados', img(chartToDataUrl(statusChartConfig(t), 330, 228), 330, 228), 'flex:1')}
        </div>
      </div>
    </div>`;
}

function driverSheetB(d: DriverPerformance, r: PerformanceReport): string {
  const f = r.fleet.averages;
  const p = d.pace;
  const c = d.closure;
  const paceBox = box('Ritmo de entrega', [
    statLine('Hora promedio de inicio', p.avgStart || '—'),
    statLine('Hora promedio de término', p.avgEnd || '—'),
    statLine('Horas promedio en ruta', p.avgHoursActive != null ? `${n1(p.avgHoursActive, 2)} hrs` : '—'),
    statLine('Minutos por entrega (promedio)', p.avgMinutesPerDelivery != null ? n1(p.avgMinutesPerDelivery) : '—', vs(p.avgMinutesPerDelivery, f.avgMinutesPerDelivery, { higherBetter: false }).tone),
    statLine('Entregas por hora activa', n1(p.deliveriesPerActiveHour)),
    statLine('Días comparables', `${p.reliableDays} de ${d.totals.daysWorked}`),
  ].join(''), 'width:420px');
  const closureBox = box('Cierre en la app vs Mercado Libre', [
    statLine('Entregas con cierre en ML', n0(c.mlDeliveries)),
    statLine('Demora promedio de cierre', c.avgMlDelayMin != null ? `${n0(c.avgMlDelayMin)} min` : '—', vs(c.avgMlDelayMin, f.avgMlDelayMin, { higherBetter: false, digits: 0 }).tone),
    statLine(`Cierres tardíos (>${r.meta.lateCloseMinutes} min)`, c.mlDeliveries ? `${c.lateCount} (${share(c.lateShare)})` : '—', c.lateShare != null && c.lateShare >= 0.25 ? 'bad' : undefined),
    statLine('Días: al momento · con retraso · fin del día', `${c.daysOnTime} · ${c.daysDelayed} · <span style="color:${c.daysEndOfDay ? '#b91c1c' : '#0f172a'}">${c.daysEndOfDay}</span>`),
    statLine('Cierre diario hecho por el conductor', `${c.appClosureDays} de ${d.totals.daysWorked} días`),
    statLine('Completado por el sistema', n0(c.systemClosureDays), c.systemClosureDays > 0 ? 'bad' : undefined),
    statLine('Hora promedio de cierre diario', c.avgClosureTime || '—'),
  ].join(''), 'width:420px');

  const reasons = d.problemReasons.length
    ? img(chartToDataUrl(horizontalBarConfig(d.problemReasons.map(x => ({ label: x.reason, value: x.count })), C.red, 'Incidencias'), 500, 140), 500, 140)
    : `<div style="height:140px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px">Sin incidencias registradas en el período</div>`;
  const communes = d.byCommune.length
    ? img(chartToDataUrl(horizontalBarConfig(d.byCommune.map(x => ({ label: x.commune, value: x.count })), C.violet, 'Entregas'), 500, 140), 500, 140)
    : `<div style="height:140px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:12px">Sin entregas en el período</div>`;

  const legendDot = (color: string, text: string) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px"><span style="width:9px;height:9px;border-radius:2px;background:${color};display:inline-block"></span>${text}</span>`;
  const legendLimit = `<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:16px;border-top:2px dashed ${C.red};display:inline-block"></span>Límite de cierre tardío (${r.meta.lateCloseMinutes} min)</span>`;

  return `
    ${strip(`${d.driverName} · Ritmo, cierre y zonas`, periodText(r))}
    <div style="display:flex;gap:12px;margin-top:10px">
      ${box('Minutos por entrega por día', img(chartToDataUrl(paceChartConfig(d.daily, f.avgMinutesPerDelivery), 600, 172), 600, 172), 'flex:1')}
      ${paceBox}
    </div>
    <div style="display:flex;gap:12px;margin-top:10px">
      ${box('Demora de cierre en la app respecto a Mercado Libre, por día', `${img(chartToDataUrl(closureChartConfig(d.daily, r.meta.lateCloseMinutes), 600, 172), 600, 172)}
        <div style="font-size:9.5px;color:#475569;margin-top:2px">${legendDot(PROFILE_COLORS.ON_TIME, 'Cierra al momento')}${legendDot(PROFILE_COLORS.DELAYED, 'Con retraso')}${legendDot(PROFILE_COLORS.END_OF_DAY, 'Al final del día')}${legendDot(PROFILE_COLORS.NO_DATA, 'Sin datos suficientes')}${legendLimit}</div>`, 'flex:1')}
      ${closureBox}
    </div>
    <div style="display:flex;gap:12px;margin-top:10px">
      ${box('Comunas con más entregas', communes, 'flex:1')}
      ${box('Motivos de incidencia', reasons, 'flex:1')}
    </div>
    <div style="font-size:9px;color:#64748b;margin-top:6px;line-height:1.35">
      El ritmo solo considera días en que el conductor cerró sus entregas en el momento: se excluyen los días con cierre masivo al final de la jornada (la hora de la app no es la hora real de entrega) y los de menos de ${r.meta.minDeliveriesForPace} entregas.
      La hora de cierre de ML es la de detección del sistema, por lo que la demora real es igual o mayor a la indicada.
    </div>`;
}

const DAILY_ROWS_PER_PAGE = 22;

function driverDailyPages(d: DriverPerformance, r: PerformanceReport): { title: string; build: () => string }[] {
  const rows = d.daily;
  const chunks: DriverPerformance['daily'][] = [];
  for (let i = 0; i < Math.max(rows.length, 1); i += DAILY_ROWS_PER_PAGE) chunks.push(rows.slice(i, i + DAILY_ROWS_PER_PAGE));
  const th = (t: string, align = 'center') => `<th style="padding:0 5px;text-align:${align};font-size:9px;letter-spacing:.05em;text-transform:uppercase;font-weight:800;color:#fff">${t}</th>`;
  return chunks.map((chunk, idx) => ({
    title: `${d.driverName} · Detalle diario`,
    build: () => `
      ${strip(`${d.driverName} · Detalle diario${chunks.length > 1 ? ` (${idx + 1}/${chunks.length})` : ''}`, periodText(r))}
      <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:11px">
        <thead><tr style="background:#1e293b;height:34px">
          ${th('Fecha', 'left')}${th('Asignados')}${th('Entregados')}${th('% Efect.')}${th('Con<br>problema')}${th('Primera<br>entrega')}${th('Última<br>entrega')}${th('Horas<br>en ruta')}${th('Min por<br>entrega')}${th('Entregas<br>con ML')}${th('Demora<br>cierre app')}${th('Cierres<br>tardíos')}${th('Perfil de cierre', 'left')}
        </tr></thead>
        <tbody>
          ${chunk.map((x, k) => `
            <tr style="height:25px;background:${k % 2 ? '#f1f5f9' : '#fff'}">
              <td style="padding:0 6px;font-weight:800">${dmy(x.date)}</td>
              <td style="text-align:center">${x.assigned}</td>
              <td style="text-align:center;font-weight:800">${x.delivered}</td>
              <td style="text-align:center">${pctTxt(x.deliveryRate)}</td>
              <td style="text-align:center;${x.hadProblem ? 'color:#b91c1c;font-weight:800' : ''}">${x.hadProblem}</td>
              <td style="text-align:center;color:#047857;font-weight:700">${x.firstActivity || '—'}</td>
              <td style="text-align:center;color:#1d4ed8;font-weight:700">${x.lastActivity || '—'}</td>
              <td style="text-align:center">${x.hoursActive != null && x.deliveredCount > 1 ? n1(x.hoursActive, 2) : '—'}</td>
              <td style="text-align:center;font-weight:800">${x.avgMinutesPerDelivery != null ? n1(x.avgMinutesPerDelivery) : '—'}</td>
              <td style="text-align:center">${x.mlCount || '—'}</td>
              <td style="text-align:center">${x.mlCount && x.avgMlDelayMin != null ? `${x.avgMlDelayMin} min` : '—'}</td>
              <td style="text-align:center">${x.lateShare != null ? share(x.lateShare) : '—'}</td>
              <td style="padding:0 6px">${pill(x.closureProfile)}${x.closureProfile === 'END_OF_DAY' && x.maxBurst ? `<span style="font-size:8.5px;color:#991b1b;margin-left:5px">${x.maxBurst} cierres en 10 min · ${x.burstAt}</span>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>`,
  }));
}

// ---------------------------------------------------------------------------------------------
// Comparativa de la flota
// ---------------------------------------------------------------------------------------------

const topList = (title: string, items: { name: string; value: string; tone?: Tone }[], empty = 'Sin datos') => box(title,
  items.length
    ? items.map((it, i) => `<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;padding:2.5px 0;border-bottom:1px dashed #e2e8f0"><span><b style="color:#94a3b8;margin-right:5px">${i + 1}.</b>${esc(it.name)}</span><b style="color:${it.tone ? TONE_COLOR[it.tone] : '#0f172a'}">${it.value}</b></div>`).join('')
    : `<div style="font-size:11px;color:#94a3b8">${empty}</div>`, 'flex:1');

const noData = (h: number) => `<div style="height:${h}px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#94a3b8;text-align:center;padding:0 24px">Sin datos suficientes en el período para este gráfico</div>`;

/**
 * Páginas comparativas. `drivers` es el conjunto que se muestra (toda la flota, o la selección que se
 * eligió en pantalla); los promedios y totales de las tarjetas siguen siendo los de TODA la flota del
 * informe, y por eso se rotulan "flota" cuando el conjunto es una selección.
 */
function comparativePages(r: PerformanceReport, drivers: DriverPerformance[], selectionNote?: string): { title: string; build: () => string }[] {
  const f = r.fleet.averages;
  const ft = r.fleet.totals;
  const title = 'Comparativa de conductores';
  const isSubset = drivers.length !== r.drivers.length;
  const fl = (label: string) => (isSubset ? `${label} · flota` : label);
  const withDel = drivers.filter(d => d.totals.assigned >= 5);
  // En un informe de un solo día no existen "2 días comparables": con un mínimo fijo de 2 el gráfico de
  // ritmo salía vacío para cualquier período corto.
  const minPaceDays = Math.min(2, Math.max(1, r.period.days));

  const cover = () => `
    ${band(isSubset ? 'Informe comparativo · Selección' : 'Informe comparativo · Flota', 'Rendimiento de conductores', periodText(r), isSubset ? `${drivers.length} de ${r.drivers.length} conductores · ${r.period.days} día${r.period.days === 1 ? '' : 's'}` : `${drivers.length} conductor${drivers.length === 1 ? '' : 'es'} · ${r.period.days} día${r.period.days === 1 ? '' : 's'}`)}
    ${isSubset && selectionNote ? `<div style="margin-top:8px;padding:5px 12px;border-radius:8px;background:#eef2ff;border:1px solid #c7d2fe;font-size:11px;font-weight:800;color:#3730a3">Criterio de selección: ${esc(selectionNote)}</div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px">
      ${kpi(isSubset ? 'Conductores seleccionados' : 'Conductores', isSubset ? `${n0(drivers.length)} de ${n0(r.drivers.length)}` : n0(drivers.length), `${r.period.days} día${r.period.days === 1 ? '' : 's'} de período`)}
      ${kpi(fl('Paquetes asignados'), n0(ft.assigned), `${n0(ft.delivered)} entregados`)}
      ${kpi('Efectividad de la flota', pctTxt(f.deliveryRate), `${n0(ft.pending)} pendientes · ${n0(ft.cancelled)} cancelados`)}
      ${kpi(fl('Incidencias'), pctTxt(f.incidentRate), `${n0(ft.problemPackages)} paquetes con problema`)}
      ${kpi(fl('Min por entrega (prom.)'), n1(f.avgMinutesPerDelivery), `${n1(f.avgHoursActive, 2)} hrs en ruta por día`)}
      ${kpi(fl('Entregas por día (prom.)'), n1(f.avgDeliveriesPerDay), 'Por conductor')}
      ${kpi(fl('Demora cierre en app'), f.avgMlDelayMin == null ? '—' : `${n0(f.avgMlDelayMin)} min`, `Sobre ${n0(ft.mlDeliveries)} entregas de ML`)}
      ${kpi(fl('Cierres tardíos'), share(f.lateShare), `Más de ${r.meta.lateCloseMinutes} min después de ML`)}
    </div>
    <div style="display:flex;gap:12px;margin-top:12px">
      ${box('Entregados por conductor', drivers.length ? img(chartToDataUrl(driversBarConfig(drivers, d => d.totals.delivered, 'Entregados', C.indigo), 520, 330), 520, 330) : noData(330), 'flex:1')}
      ${box('% de efectividad por conductor', withDel.length ? img(chartToDataUrl(driversBarConfig(withDel, d => d.totals.deliveryRate, '% Efectividad', C.emerald, { min: rateAxisMin(withDel.map(d => d.totals.deliveryRate)), max: 100, suffix: '%' }), 520, 330), 520, 330) : noData(330), 'flex:1')}
    </div>`;

  const lists = () => {
    const paced = drivers.filter(d => d.pace.avgMinutesPerDelivery != null && d.pace.reliableDays >= minPaceDays);
    const closers = drivers.filter(d => d.closure.mlDeliveries >= r.meta.minMlForProfile && d.closure.avgMlDelayMin != null);
    const bulk = drivers.filter(d => d.closure.daysEndOfDay > 0).sort((a, b) => b.closure.daysEndOfDay - a.closure.daysEndOfDay);
    return `
      ${strip(title, `${periodText(r)} · destacados`)}
      <div style="display:flex;gap:12px;margin-top:10px">
        ${box('Min por entrega por conductor', paced.length ? img(chartToDataUrl(driversBarConfig(paced, d => d.pace.avgMinutesPerDelivery, 'Min por entrega', C.sky, { order: 'asc' }), 520, 300), 520, 300) : noData(300), 'flex:1')}
        ${box('Demora de cierre en la app (min)', closers.length ? img(chartToDataUrl(driversBarConfig(closers, d => d.closure.avgMlDelayMin, 'Min de demora', C.amber), 520, 300), 520, 300) : noData(300), 'flex:1')}
      </div>
      <div style="display:flex;gap:12px;margin-top:10px">
        ${topList('Mayor efectividad', [...withDel].sort((a, b) => (b.totals.deliveryRate ?? 0) - (a.totals.deliveryRate ?? 0) || b.totals.delivered - a.totals.delivered).slice(0, 5).map(d => ({ name: d.driverName, value: pctTxt(d.totals.deliveryRate), tone: 'good' as Tone })))}
        ${topList('Más rápidos (min por entrega)', [...paced].sort((a, b) => a.pace.avgMinutesPerDelivery! - b.pace.avgMinutesPerDelivery!).slice(0, 5).map(d => ({ name: d.driverName, value: n1(d.pace.avgMinutesPerDelivery), tone: 'good' as Tone })))}
        ${topList('Mayor demora de cierre en la app', [...closers].sort((a, b) => b.closure.avgMlDelayMin! - a.closure.avgMlDelayMin!).slice(0, 5).map(d => ({ name: d.driverName, value: `${n0(d.closure.avgMlDelayMin)} min`, tone: (d.closure.avgMlDelayMin! >= 30 ? 'bad' : 'neutral') as Tone })))}
        ${topList('Cierran al final del día', bulk.slice(0, 5).map(d => ({ name: d.driverName, value: `${d.closure.daysEndOfDay} día${d.closure.daysEndOfDay === 1 ? '' : 's'}`, tone: 'bad' as Tone })), 'Nadie en el período')}
      </div>`;
  };

  // Tabla de ranking de toda la flota
  const ROWS = 24;
  const sorted = [...drivers].sort((a, b) => (b.totals.deliveryRate ?? -1) - (a.totals.deliveryRate ?? -1) || b.totals.delivered - a.totals.delivered);
  const chunks: DriverPerformance[][] = [];
  for (let i = 0; i < sorted.length; i += ROWS) chunks.push(sorted.slice(i, i + ROWS));
  const th = (t: string, align = 'center') => `<th style="padding:0 4px;text-align:${align};font-size:8.5px;letter-spacing:.04em;text-transform:uppercase;font-weight:800;color:#fff">${t}</th>`;
  const tablePages = chunks.map((chunk, idx) => ({
    title,
    build: () => `
      ${strip(`${title} · Tabla de rendimiento${chunks.length > 1 ? ` (${idx + 1}/${chunks.length})` : ''}`, periodText(r))}
      <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:10px">
        <thead><tr style="background:#1e293b;height:36px">
          ${th('#')}${th('Conductor', 'left')}${th('Días')}${th('Asignados')}${th('Entregados')}${th('% Efect.')}${th('% Incid.')}${th('Min por<br>entrega')}${th('Horas<br>por día')}${th('Inicio<br>prom.')}${th('Fin<br>prom.')}${th('Entregas<br>ML')}${th('Demora<br>cierre')}${th('% Cierres<br>tardíos')}${th('Días cierre<br>al final')}${th('Cierres<br>conductor/sist.')}
        </tr></thead>
        <tbody>
          ${chunk.map((d, k) => `
            <tr style="height:24px;background:${k % 2 ? '#f1f5f9' : '#fff'}">
              <td style="text-align:center;color:#94a3b8;font-weight:700">${idx * ROWS + k + 1}</td>
              <td style="padding:0 5px;font-weight:800;text-transform:uppercase;white-space:nowrap">${esc(d.driverName)}</td>
              <td style="text-align:center">${d.totals.daysWorked}</td>
              <td style="text-align:center">${d.totals.assigned}</td>
              <td style="text-align:center;font-weight:800">${d.totals.delivered}</td>
              <td style="text-align:center;font-weight:800;color:${d.totals.deliveryRate != null && f.deliveryRate != null && d.totals.deliveryRate < f.deliveryRate - 1 ? '#b91c1c' : '#047857'}">${pctTxt(d.totals.deliveryRate)}</td>
              <td style="text-align:center">${pctTxt(d.totals.incidentRate)}</td>
              <td style="text-align:center;font-weight:800">${n1(d.pace.avgMinutesPerDelivery)}</td>
              <td style="text-align:center">${n1(d.pace.avgHoursActive, 2)}</td>
              <td style="text-align:center">${d.pace.avgStart || '—'}</td>
              <td style="text-align:center">${d.pace.avgEnd || '—'}</td>
              <td style="text-align:center">${d.closure.mlDeliveries || '—'}</td>
              <td style="text-align:center">${d.closure.avgMlDelayMin != null ? `${n0(d.closure.avgMlDelayMin)} min` : '—'}</td>
              <td style="text-align:center;${d.closure.lateShare != null && d.closure.lateShare >= 0.25 ? 'color:#b91c1c;font-weight:800' : ''}">${share(d.closure.lateShare)}</td>
              <td style="text-align:center;${d.closure.daysEndOfDay ? 'color:#b91c1c;font-weight:800' : ''}">${d.closure.daysEndOfDay}</td>
              <td style="text-align:center">${d.closure.appClosureDays} / ${d.closure.systemClosureDays}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${idx === chunks.length - 1 ? `
        <div style="margin-top:10px;padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:9px;line-height:1.4;color:#475569">
          <b style="color:#0f172a">Cómo leer esta tabla.</b> Efectividad = entregados ÷ asignados en el período. Incidencias = paquetes que tuvieron al menos un problema reportado. Min por entrega = minutos promedio entre entregas, solo en días en que el conductor cerró en el momento
          (se excluyen los días con cierre masivo al final de la jornada y los de menos de ${r.meta.minDeliveriesForPace} entregas). Demora de cierre = minutos entre el cierre detectado de Mercado Libre y el cierre en la app (la hora de ML es la de detección del sistema; la demora real es igual o mayor);
          cierre tardío = más de ${r.meta.lateCloseMinutes} min. Cierres conductor/sistema = cierres diarios registrados por el conductor desde la app vs completados automáticamente por el servidor.
        </div>` : ''}`,
  }));

  return [{ title, build: cover }, { title, build: lists }, ...tablePages];
}

// ---------------------------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------------------------

export interface PerformancePdfOptions {
  report: PerformanceReport;
  /** Conductores que llevan hoja individual (puede ser ninguno si solo se quiere la comparativa). */
  drivers: DriverPerformance[];
  /** Antepone la comparativa de todos los conductores del informe (varios conductores). */
  comparative: boolean;
  /** Si se indica, la comparativa muestra solo a estos conductores (la selección hecha en pantalla). */
  comparativeDrivers?: DriverPerformance[];
  /** Criterio de la selección, para rotularlo en la portada de la comparativa (ej. "Efectividad menor a 95%"). */
  selectionNote?: string;
  /** Agrega el detalle diario de cada conductor (recomendado para un solo conductor). */
  includeDaily: boolean;
  generatedAt: string;
  fileName: string;
  onProgress?: (done: number, total: number) => void;
}

export async function downloadPerformancePdf(opts: PerformancePdfOptions): Promise<void> {
  const { report, drivers } = opts;
  const plan: { title: string; build: () => string }[] = [];
  if (opts.comparative) plan.push(...comparativePages(report, opts.comparativeDrivers ?? report.drivers, opts.selectionNote));
  drivers.forEach(d => {
    plan.push({ title: `${d.driverName} · Rendimiento`, build: () => driverSheetA(d, report) });
    plan.push({ title: `${d.driverName} · Rendimiento`, build: () => driverSheetB(d, report) });
    if (opts.includeDaily) plan.push(...driverDailyPages(d, report));
  });
  const total = plan.length;
  const pages = plan.map((p, i) => () => shell(p.build(), p.title, i + 1, total, opts.generatedAt));
  // Documentos grandes: menos resolución por hoja para mantener el archivo en un tamaño razonable.
  const big = total > 12;
  await renderPagesToPdf(pages, { fileName: opts.fileName, scale: big ? 1.5 : 2, quality: big ? 0.85 : 0.92, onProgress: opts.onProgress });
}
