// Exportación del informe de cumplimiento de entregas de Mercado Libre: Excel con formato (rojo bajo la meta) y PDF A4 horizontal.
import { renderPagesToPdf, esc } from './pdfPages';
import {
  TARGET_PCT, CUTOFF_HOUR, METHOD_NOTES, fmtInt, fmtPct, fmtDelta, deltaPp, weekLabel, shortDate, dailyForWeek, isBelow, pctFloor, clip,
} from './meliWeeklyReport';
import type { SellerStats, Stats, MeliWeeklyRow, GroupBy, weeklyTrend } from './meliWeeklyReport';

export interface MeliExportInput {
  weekStart: string;
  isCurrentWeek: boolean;
  groupBy: GroupBy;
  sellers: SellerStats[];                       // tal como se ven en pantalla (filtrados y ordenados)
  totals: Stats;
  prevTotals: Stats | null;
  trend: ReturnType<typeof weeklyTrend>;
  rows: MeliWeeklyRow[];                        // para el detalle diario
  excluded: { cancelledBeforeAssignment: number; deliveredOutside: number };
  generatedAt: Date;
}

const stamp = (d: Date) => `${d.toLocaleDateString('es-CL')} ${d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}`;
const fileBase = (i: MeliExportInput) => `Cumplimiento_Meli_Semana_${i.weekStart}`;
const groupLabel = (by: GroupBy) => (by === 'account' ? 'cuenta de Mercado Libre' : 'cliente');

// Colores del informe (los mismos de la pantalla): rojo crítico para "bajo la meta" y verde para "en meta", siempre acompañados de ▼ / ✓.
const RED = '#d03b3b', RED_TEXT = '#b91c1c', RED_BG = '#fef2f2', GREEN_TEXT = '#047857', BLUE = '#2a78d6', ORANGE = '#eb6834';
const INK = '#0f172a', INK2 = '#475569', MUTED = '#94a3b8', GRID = '#e2e8f0';
const FONT = "'Segoe UI',Roboto,Arial,sans-serif";

// ============================================================================================
// EXCEL
// ============================================================================================
export async function buildMeliWeeklyWorkbook(input: MeliExportInput) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Full Envíos';
  wb.created = input.generatedAt;

  const HEADER_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1E1B4B' } };
  const GROUP_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF334155' } };
  const RED_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFEE2E2' } };
  const TOTAL_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFF1F5F9' } };
  const thin = { style: 'thin' as const, color: { argb: 'FFE2E8F0' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  // El porcentaje se escribe como fracción truncada a 1 decimal (igual que en pantalla) y se pinta de rojo por la razón exacta.
  const pctCell = (cell: import('exceljs').Cell, n: number, d: number) => {
    const p = pctFloor(n, d);
    cell.numFmt = '0.0%';
    cell.alignment = { horizontal: 'right' };
    if (p == null) { cell.value = '—'; cell.font = { color: { argb: 'FF94A3B8' } }; return; }
    cell.value = p / 100;
    if (isBelow(n, d)) { cell.fill = RED_FILL; cell.font = { bold: true, color: { argb: 'FFB91C1C' } }; }
    else { cell.font = { bold: true, color: { argb: 'FF047857' } }; }
  };
  const headerRow = (ws: import('exceljs').Worksheet, rowNo: number, labels: string[], fill = HEADER_FILL) => {
    const r = ws.getRow(rowNo);
    labels.forEach((l, i) => {
      const c = r.getCell(i + 1);
      c.value = l; c.fill = fill; c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      c.alignment = { horizontal: i === 0 ? 'left' : 'center', vertical: 'middle', wrapText: true }; c.border = border;
    });
    r.height = 30;
  };
  const sellerRow = (ws: import('exceljs').Worksheet, rowNo: number, name: string, ident: string, s: Stats, estado: string, bold = false) => {
    const r = ws.getRow(rowNo);
    const vals: (string | number)[] = [name, ident, s.total, s.onTime, 0, s.lateSameDay, s.delivered, 0, s.cancelled, s.rescheduled, s.reassigned, s.noClose, estado];
    vals.forEach((v, i) => {
      const c = r.getCell(i + 1);
      c.value = v; c.border = border;
      if (i >= 2 && typeof v === 'number') { c.numFmt = '#,##0'; c.alignment = { horizontal: 'right' }; }
      if (bold) { c.font = { bold: true }; c.fill = TOTAL_FILL; }
    });
    pctCell(r.getCell(5), s.onTime, s.total);
    pctCell(r.getCell(8), s.delivered, s.total);
    if (bold) { r.getCell(5).border = border; r.getCell(8).border = border; if (!isBelow(s.onTime, s.total)) r.getCell(5).fill = TOTAL_FILL; if (!isBelow(s.delivered, s.total)) r.getCell(8).fill = TOTAL_FILL; }
    const e = r.getCell(13);
    e.alignment = { horizontal: 'center' };
    e.font = { bold: true, color: { argb: s.total === 0 ? 'FF94A3B8' : s.atRisk ? 'FFB91C1C' : 'FF047857' } };
  };
  const estadoOf = (s: Stats) => (s.total === 0 ? 'Sin paquetes' : s.atRisk ? '▼ En riesgo' : '✓ En meta');

  // ---- Hoja 1: resumen de la semana por seller ----
  const ws = wb.addWorksheet('Resumen semanal', { views: [{ state: 'frozen', xSplit: 1, ySplit: 5 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const nameW = Math.min(60, Math.max(34, ...input.sellers.map(s => s.name.length + 2))); // el nombre completo debe caber (por cuenta ML son más largos)
  ws.columns = [{ width: nameW }, { width: 13 }, { width: 11 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 13 }, { width: 13 }, { width: 10 }, { width: 14 }];
  ws.mergeCells('A1:M1'); ws.getCell('A1').value = `Cumplimiento de entregas Mercado Libre · semana ${weekLabel(input.weekStart)}`; ws.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FF0F172A' } };
  ws.mergeCells('A2:M2'); ws.getCell('A2').value = `Meta de Mercado Libre: ${TARGET_PCT} % · Corte diario ${CUTOFF_HOUR}:00 · Por ${groupLabel(input.groupBy)} · ${input.isCurrentWeek ? 'Semana en curso (parcial) · ' : ''}Generado el ${stamp(input.generatedAt)}`; ws.getCell('A2').font = { size: 10, color: { argb: 'FF475569' } };
  ws.mergeCells('A3:M3'); ws.getCell('A3').value = `Rojo = porcentaje bajo la meta de ${TARGET_PCT} % (riesgo de multa). Los porcentajes se truncan a 1 decimal.`; ws.getCell('A3').font = { size: 10, italic: true, color: { argb: 'FFB91C1C' } };
  // fila 4: grupos; fila 5: columnas
  const groups: [string, string, string][] = [['A4', 'B4', 'Seller'], ['C4', 'C4', ''], ['D4', 'E4', 'Entregados antes de las 21:00'], ['F4', 'F4', 'Después de las 21:00'], ['G4', 'H4', 'Total entregados'], ['I4', 'L4', 'No entregados el mismo día'], ['M4', 'M4', '']];
  groups.forEach(([a, b, label]) => { if (a !== b) ws.mergeCells(`${a}:${b}`); const c = ws.getCell(a); c.value = label; c.fill = GROUP_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  ws.getRow(4).height = 20;
  headerRow(ws, 5, [input.groupBy === 'account' ? 'Cliente · Cuenta ML' : 'Cliente', 'Identificador', 'Paquetes', 'Paquetes', '%', 'Paquetes', 'Paquetes', '%', 'Cancelados', 'Reprogramados', 'Reasignados otro día', 'Sin cierre', 'Estado']);
  let rowNo = 6;
  input.sellers.forEach(s => { sellerRow(ws, rowNo++, s.name, s.identifier || '', s, estadoOf(s)); });
  sellerRow(ws, rowNo++, 'TOTAL', '', input.totals, estadoOf(input.totals), true);
  rowNo += 1;
  const notes: string[] = [
    `En ruta hoy (no cuentan hasta que termine el día): ${fmtInt(input.totals.inRouteToday)} paquetes.`,
    `No incluidos (nadie los gestionó): ${fmtInt(input.excluded.cancelledBeforeAssignment)} cancelados antes de asignarse a un conductor y ${fmtInt(input.excluded.deliveredOutside)} entregados por otros medios.`,
  ];
  notes.forEach(n => { ws.mergeCells(`A${rowNo}:M${rowNo}`); ws.getCell(`A${rowNo}`).value = n; ws.getCell(`A${rowNo}`).font = { size: 10, color: { argb: 'FF475569' } }; rowNo++; });
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + input.sellers.length, column: 13 } };

  // ---- Hoja 2: detalle diario por seller ----
  const wd = wb.addWorksheet('Detalle diario', { views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] });
  wd.columns = [{ width: nameW }, { width: 12 }, { width: 11 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 13 }, { width: 13 }, { width: 10 }];
  headerRow(wd, 1, ['Cliente', 'Día', 'Paquetes', 'Antes 21:00', '% antes 21:00', 'Después 21:00', 'Total entregados', '% entregados', 'Cancelados', 'Reprogramados', 'Reasignados otro día', 'Sin cierre']);
  let r2 = 2;
  for (const s of input.sellers) {
    for (const d of dailyForWeek(input.rows, input.weekStart, s.key, input.groupBy)) {
      if (d.total === 0 && d.inRouteToday === 0) continue;
      const r = wd.getRow(r2++);
      [s.name, d.label, d.total, d.onTime, 0, d.lateSameDay, d.delivered, 0, d.cancelled, d.rescheduled, d.reassigned, d.noClose].forEach((v, i) => {
        const c = r.getCell(i + 1); c.value = v as string | number; c.border = border;
        if (typeof v === 'number') { c.numFmt = '#,##0'; c.alignment = { horizontal: 'right' }; }
      });
      pctCell(r.getCell(5), d.onTime, d.total); pctCell(r.getCell(8), d.delivered, d.total);
    }
  }
  wd.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, r2 - 1), column: 12 } };

  // ---- Hoja 3: tendencia semanal ----
  const wt = wb.addWorksheet('Tendencia semanal', { views: [{ state: 'frozen', ySplit: 1 }] });
  wt.columns = [{ width: 20 }, { width: 11 }, { width: 12 }, { width: 11 }, { width: 14 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 13 }, { width: 10 }];
  headerRow(wt, 1, ['Semana', 'Paquetes', 'Antes 21:00', '% antes 21:00', 'Total entregados', '% entregados', 'Cancelados', 'Reprogramados', 'Reasignados otro día', 'Sin cierre']);
  input.trend.forEach((t, i) => {
    const r = wt.getRow(i + 2);
    [weekLabel(t.weekStart), t.total, t.onTime, 0, t.delivered, 0, t.cancelled, t.rescheduled, t.reassigned, t.noClose].forEach((v, k) => {
      const c = r.getCell(k + 1); c.value = v as string | number; c.border = border;
      if (typeof v === 'number') { c.numFmt = '#,##0'; c.alignment = { horizontal: 'right' }; }
    });
    pctCell(r.getCell(4), t.onTime, t.total); pctCell(r.getCell(6), t.delivered, t.total);
  });

  // ---- Hoja 4: cómo se calcula ----
  const wm = wb.addWorksheet('Cómo se calcula');
  wm.columns = [{ width: 140 }];
  wm.getCell('A1').value = 'Cómo se calcula este informe'; wm.getCell('A1').font = { bold: true, size: 14 };
  METHOD_NOTES.forEach((n, i) => { const c = wm.getCell(`A${i + 3}`); c.value = `${i + 1}. ${n}`; c.alignment = { wrapText: true, vertical: 'top' }; wm.getRow(i + 3).height = Math.max(18, Math.ceil(n.length / 135) * 16); });

  return wb;
}

export async function downloadMeliWeeklyExcel(input: MeliExportInput): Promise<void> {
  const wb = await buildMeliWeeklyWorkbook(input);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${fileBase(input)}.xlsx`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ============================================================================================
// PDF (A4 horizontal, hojas de 1122 x 793 px)
// ============================================================================================
const shell = (inner: string, pageNo: number, total: number, generatedAt: string, weekTxt: string) => `
  <div style="width:1122px;height:793px;box-sizing:border-box;padding:22px 28px 12px;background:#fff;display:flex;flex-direction:column;font-family:${FONT};color:${INK};overflow:hidden">
    <div style="flex:1;min-height:0">${inner}</div>
    <div style="display:flex;justify-content:space-between;font-size:9.5px;color:#64748b;border-top:1px solid ${GRID};padding-top:5px;margin-top:6px">
      <span>Full Envíos · Cumplimiento de entregas Mercado Libre · Semana ${esc(weekTxt)} · Generado el ${esc(generatedAt)}</span><span>Hoja ${pageNo} de ${total}</span>
    </div>
  </div>`;

const band = (kicker: string, title: string, rightTop: string, rightBottom: string) => `
  <div style="background:linear-gradient(90deg,#0f172a,#1e1b4b);border-radius:12px;padding:12px 20px;display:flex;justify-content:space-between;align-items:center;color:#fff">
    <div>
      <div style="font-size:10.5px;letter-spacing:.28em;color:#a5b4fc;font-weight:800">${esc(kicker)}</div>
      <div style="font-size:24px;font-weight:900;letter-spacing:.03em;margin-top:2px;text-transform:uppercase">${esc(title)}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:15px;font-weight:800">${esc(rightTop)}</div>
      <div style="font-size:11px;color:#c7d2fe;margin-top:3px">${esc(rightBottom)}</div>
    </div>
  </div>`;

const statusBanner = (atRisk: number, withData: number) => atRisk > 0
  ? `<div style="margin-top:10px;border:1px solid #fecaca;background:${RED_BG};border-left:5px solid ${RED};border-radius:8px;padding:8px 14px;font-size:12.5px;color:#7f1d1d"><b style="color:${RED_TEXT}">▼ ${atRisk} de ${withData} sellers</b> están bajo la meta de ${TARGET_PCT} % de Mercado Libre y tienen riesgo de multa. Se marcan en rojo en este informe.</div>`
  : `<div style="margin-top:10px;border:1px solid #bbf7d0;background:#f0fdf4;border-left:5px solid #16a34a;border-radius:8px;padding:8px 14px;font-size:12.5px;color:#14532d"><b style="color:${GREEN_TEXT}">✓ Todos los sellers</b> están sobre la meta de ${TARGET_PCT} % de Mercado Libre.</div>`;

type Tone = 'bad' | 'good' | 'neutral';
const TONE_COLOR: Record<Tone, string> = { bad: RED_TEXT, good: GREEN_TEXT, neutral: '#64748b' };
// Indicador: las líneas de apoyo van en gris; la variación lleva su propio color (según suba o baje), nunca el del porcentaje.
const kpi = (label: string, value: string, lines: string[], delta?: { text: string; tone: Tone }, chip?: { text: string; tone: Tone }, valueColor?: string) => `
  <div style="flex:1;border:1px solid ${GRID};border-radius:10px;padding:9px 12px;background:#fff;min-height:92px;box-sizing:border-box">
    <div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start">
      <div style="font-size:9px;font-weight:800;letter-spacing:.08em;color:#64748b;text-transform:uppercase">${esc(label)}</div>
      ${chip ? `<div style="font-size:8.5px;font-weight:900;white-space:nowrap;border-radius:9px;padding:1px 7px;background:${chip.tone === 'bad' ? RED_BG : '#ecfdf5'};color:${TONE_COLOR[chip.tone]}">${chip.tone === 'bad' ? '▼' : '✓'} ${esc(chip.text)}</div>` : ''}
    </div>
    <div style="font-size:28px;font-weight:900;color:${valueColor || INK};line-height:1.15;margin-top:2px">${value}</div>
    ${lines.map(l => `<div style="font-size:10px;font-weight:700;margin-top:2px;color:#64748b">${l}</div>`).join('')}
    ${delta ? `<div style="font-size:10px;font-weight:800;margin-top:2px;color:${TONE_COLOR[delta.tone]}">${delta.text}</div>` : ''}
  </div>`;

const pctHtml = (n: number, d: number) => {
  const p = pctFloor(n, d);
  if (p == null) return `<span style="color:${MUTED}">—</span>`;
  return isBelow(n, d)
    ? `<span style="display:inline-block;background:${RED_BG};color:${RED_TEXT};font-weight:900;border-radius:4px;padding:2px 6px">▼ ${esc(fmtPct(p))}</span>`
    : `<span style="color:${GREEN_TEXT};font-weight:800">✓ ${esc(fmtPct(p))}</span>`;
};

function trendSvg(trend: MeliExportInput['trend'], w: number, h: number): string {
  const pad = { l: 38, r: 70, t: 16, b: 26 };
  const vals = trend.flatMap(t => [t.onTimePct, t.deliveredPct]).filter((v): v is number => v != null);
  if (vals.length === 0) return `<div style="color:${MUTED};font-size:12px;padding:30px 0;text-align:center">Sin datos para la tendencia</div>`;
  const lo = Math.max(0, Math.floor((Math.min(...vals, TARGET_PCT) - 2) / 5) * 5), hi = 100;
  const x = (i: number) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, trend.length - 1);
  const y = (v: number) => pad.t + ((hi - v) * (h - pad.t - pad.b)) / (hi - lo);
  const step = hi - lo > 30 ? 10 : 5;
  let grid = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) grid += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}" stroke-width="1"/><text x="${pad.l - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="9.5" fill="${MUTED}">${v}%</text>`;
  const xl = trend.map((t, i) => `<text x="${x(i)}" y="${h - 8}" text-anchor="middle" font-size="9.5" fill="${INK2}">${esc(shortDate(t.weekStart))}</text>`).join('');
  const series = (key: 'onTimePct' | 'deliveredPct', color: string, dy: number) => {
    const pts = trend.map((t, i) => (t[key] == null ? null : { x: x(i), y: y(t[key] as number), v: t[key] as number })).filter((p): p is { x: number; y: number; v: number } => p != null);
    if (!pts.length) return '';
    const last = pts[pts.length - 1];
    return `<polyline points="${pts.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      + pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${color}" stroke="#fff" stroke-width="2"/>`).join('')
      + `<text x="${last.x + 9}" y="${last.y + dy}" font-size="11" font-weight="800" fill="${INK}">${esc(fmtPct(last.v))}</text>`;
  };
  const ty = y(TARGET_PCT);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;font-family:${FONT}">
    ${grid}${xl}
    <line x1="${pad.l}" x2="${w - pad.r}" y1="${ty}" y2="${ty}" stroke="#334155" stroke-width="1.5"/>
    <text x="${pad.l + 6}" y="${ty + 13}" font-size="10" font-weight="800" fill="#334155">Meta ${TARGET_PCT}%</text>
    ${series('deliveredPct', ORANGE, 14)}${series('onTimePct', BLUE, -6)}
  </svg>`;
}

const worstBars = (sellers: SellerStats[]) => {
  const list = sellers.filter(s => s.total > 0).sort((a, b) => (a.onTimePct ?? 101) - (b.onTimePct ?? 101) || b.total - a.total).slice(0, 10);
  if (!list.length) return `<div style="color:${MUTED};font-size:12px;padding:20px 0">Sin paquetes gestionados en la semana</div>`;
  const trackW = 190;
  // Los nombres se recortan aquí (clip) y nunca con overflow/text-overflow: el generador de PDF dibuja mal ese recorte y corta las letras por la mitad.
  return list.map(s => {
    const below = isBelow(s.onTime, s.total);
    return `<div style="display:flex;align-items:center;gap:8px;height:31px">
      <div style="width:215px;line-height:1.2">
        <div style="font-size:11px;font-weight:800;color:${INK};white-space:nowrap">${esc(clip(s.title, 32))}</div>
        ${s.detail ? `<div style="font-size:9px;font-weight:600;color:#64748b;white-space:nowrap">${esc(clip(s.detail, 40))}</div>` : ''}
      </div>
      <div style="position:relative;width:${trackW}px;height:12px;background:#f1f5f9;border-radius:0 4px 4px 0">
        <div style="position:absolute;left:0;top:0;height:12px;width:${Math.max(2, Math.round(trackW * (s.onTimePct ?? 0) / 100))}px;background:${below ? RED : BLUE};border-radius:0 4px 4px 0"></div>
        <div style="position:absolute;left:${Math.round(trackW * TARGET_PCT / 100)}px;top:-3px;height:18px;width:2px;background:#334155"></div>
      </div>
      <div style="width:62px;font-size:11px;font-weight:900;color:${below ? RED_TEXT : GREEN_TEXT};text-align:right">${below ? '▼ ' : '✓ '}${esc(fmtPct(s.onTimePct))}</div>
      <div style="font-size:9.5px;color:${MUTED}">${fmtInt(s.onTime)}/${fmtInt(s.total)}</div>
    </div>`;
  }).join('');
};

const tableHead = (by: GroupBy) => {
  const th = (t: string, extra = '', rowspan = 1) => `<th rowspan="${rowspan}" style="padding:5px 6px;font-size:9.5px;font-weight:800;color:#fff;background:#1e1b4b;border:1px solid #312e81;text-align:center;${extra}">${t}</th>`;
  const gh = (t: string, span: number) => `<th colspan="${span}" style="padding:4px 6px;font-size:9.5px;font-weight:800;color:#fff;background:#334155;border:1px solid #475569;text-align:center">${t}</th>`;
  return `<thead>
    <tr>${th(by === 'account' ? 'Cliente · Cuenta ML' : 'Seller', 'text-align:left;width:300px', 2)}${th('Paquetes', '', 2)}${gh(`Entregados antes de las ${CUTOFF_HOUR}:00`, 2)}${th(`Después de las ${CUTOFF_HOUR}:00`, '', 2)}${gh('Total entregados', 2)}${gh('No entregados el mismo día', 4)}${th('Estado', '', 2)}</tr>
    <tr>${th('Paq.')}${th('%')}${th('Paq.')}${th('%')}${th('Cancel.')}${th('Reprog.')}${th('Reasig. otro día')}${th('Sin cierre')}</tr>
  </thead>`;
};

// `stacked`: el cliente arriba y la cuenta ML (o el detalle) debajo, en dos líneas; si no, todo en una línea (cliente + identificador).
const tableRow = (name: string, ident: string | null, s: Stats, bold = false, stacked = false) => {
  const td = (v: string, extra = '') => `<td style="padding:3px 6px;font-size:10px;text-align:right;border:1px solid ${GRID};font-variant-numeric:tabular-nums;${bold ? 'font-weight:900;background:#f1f5f9;' : ''}${extra}">${v}</td>`;
  const estado = s.total === 0 ? `<span style="color:${MUTED}">Sin paquetes</span>` : s.atRisk ? `<span style="color:${RED_TEXT};font-weight:900">▼ En riesgo</span>` : `<span style="color:${GREEN_TEXT};font-weight:900">✓ En meta</span>`;
  return `<tr>
    <td style="padding:3px 6px;font-size:10px;font-weight:${bold ? 900 : 700};border:1px solid ${GRID};${bold ? 'background:#f1f5f9;' : ''}white-space:nowrap">${stacked
      ? `<div style="line-height:1.2">${esc(name)}</div>${ident ? `<div style="line-height:1.2;color:${MUTED};font-weight:600;font-size:9px">${esc(ident)}</div>` : ''}`
      : `${esc(name)}${ident ? ` <span style="color:${MUTED};font-weight:600;font-size:9px">${esc(ident)}</span>` : ''}`}</td>
    ${td(fmtInt(s.total))}${td(fmtInt(s.onTime))}${td(pctHtml(s.onTime, s.total))}${td(fmtInt(s.lateSameDay))}${td(fmtInt(s.delivered))}${td(pctHtml(s.delivered, s.total))}
    ${td(fmtInt(s.cancelled))}${td(fmtInt(s.rescheduled))}${td(fmtInt(s.reassigned))}${td(fmtInt(s.noClose))}${td(estado, 'text-align:center')}
  </tr>`;
};

/** Las hojas del PDF como HTML de tamaño fijo (1122 x 793 px): separadas de la descarga para poder revisarlas y probarlas. */
export function buildMeliWeeklyPdfPages(input: MeliExportInput): string[] {
  const generated = stamp(input.generatedAt);
  const wk = weekLabel(input.weekStart);
  const t = input.totals;
  const withData = input.sellers.filter(s => s.total > 0);
  const atRisk = withData.filter(s => s.atRisk).length;
  const dOn = input.prevTotals ? deltaPp(t.onTimePct, input.prevTotals.onTimePct) : null;
  const dAll = input.prevTotals ? deltaPp(t.deliveredPct, input.prevTotals.deliveredPct) : null;
  const deltaInfo = (d: number | null): { text: string; tone: Tone } => (d == null
    ? { text: 'Sin semana anterior para comparar', tone: 'neutral' }
    : { text: `${d === 0 ? '＝' : d > 0 ? '▲' : '▼'} ${esc(fmtDelta(d))} vs semana anterior`, tone: d === 0 ? 'neutral' : d > 0 ? 'good' : 'bad' });
  const notDelivered = t.cancelled + t.rescheduled + t.reassigned + t.noClose;

  const summary = `
    ${band('FULL ENVÍOS · INFORME OPERATIVO', 'Cumplimiento de entregas · Mercado Libre', `Semana ${wk}`, `Meta ${TARGET_PCT} % · Corte diario ${CUTOFF_HOUR}:00${input.isCurrentWeek ? ' · Semana en curso (parcial)' : ''}`)}
    ${statusBanner(atRisk, withData.length)}
    <div style="display:flex;gap:10px;margin-top:10px">
      ${kpi('Paquetes de la semana', esc(fmtInt(t.total)), [`${withData.length} sellers con paquetes`, ...(t.inRouteToday > 0 ? [`${fmtInt(t.inRouteToday)} en ruta hoy, aún no contados`] : [])])}
      ${kpi(`Entregados antes de las ${CUTOFF_HOUR}:00`, esc(fmtPct(t.onTimePct)), [`${fmtInt(t.onTime)} de ${fmtInt(t.total)} paquetes`], deltaInfo(dOn), t.total > 0 ? { text: t.onTimeBelow ? 'Bajo la meta' : 'En meta', tone: t.onTimeBelow ? 'bad' : 'good' } : undefined, t.onTimeBelow ? RED_TEXT : INK)}
      ${kpi('Total entregados', esc(fmtPct(t.deliveredPct)), [`${fmtInt(t.delivered)} de ${fmtInt(t.total)} · incluye ${fmtInt(t.lateSameDay)} después de las ${CUTOFF_HOUR}:00`], deltaInfo(dAll), t.total > 0 ? { text: t.deliveredBelow ? 'Bajo la meta' : 'En meta', tone: t.deliveredBelow ? 'bad' : 'good' } : undefined, t.deliveredBelow ? RED_TEXT : INK)}
      ${kpi('No entregados el mismo día', esc(fmtInt(notDelivered)), [`${fmtInt(t.cancelled)} cancelados · ${fmtInt(t.rescheduled)} reprogramados`, `${fmtInt(t.reassigned)} reasignados a otro día${t.noClose > 0 ? ` · ${fmtInt(t.noClose)} sin cierre` : ''}`])}
    </div>
    <div style="display:flex;gap:14px;margin-top:12px">
      <div style="flex:1;border:1px solid ${GRID};border-radius:10px;padding:10px 14px;box-sizing:border-box">
        <div style="font-size:10px;font-weight:800;letter-spacing:.06em;color:#334155;text-transform:uppercase;margin-bottom:2px">Menor cumplimiento antes de las ${CUTOFF_HOUR}:00 · 10 sellers</div>
        <div style="font-size:9.5px;color:${MUTED};margin-bottom:6px"><span style="display:inline-block;width:10px;height:10px;background:${RED};border-radius:2px;vertical-align:-1px"></span> Bajo la meta &nbsp; <span style="display:inline-block;width:10px;height:10px;background:${BLUE};border-radius:2px;vertical-align:-1px"></span> En meta &nbsp; <span style="display:inline-block;width:2px;height:11px;background:#334155;vertical-align:-2px"></span> Meta ${TARGET_PCT} %</div>
        ${worstBars(input.sellers)}
      </div>
      <div style="width:478px;border:1px solid ${GRID};border-radius:10px;padding:10px 14px;box-sizing:border-box">
        <div style="font-size:10px;font-weight:800;letter-spacing:.06em;color:#334155;text-transform:uppercase;margin-bottom:2px">Tendencia semanal · ${input.trend.length} semanas</div>
        <div style="font-size:9.5px;color:${INK2};margin-bottom:6px"><span style="display:inline-block;width:14px;height:3px;background:${BLUE};vertical-align:3px"></span> Antes de las ${CUTOFF_HOUR}:00 &nbsp; <span style="display:inline-block;width:14px;height:3px;background:${ORANGE};vertical-align:3px"></span> Total entregados</div>
        ${trendSvg(input.trend, 448, 330)}
        <div style="font-size:9.5px;color:${MUTED};margin-top:6px">No incluye ${fmtInt(input.excluded.cancelledBeforeAssignment + input.excluded.deliveredOutside)} envíos que ningún conductor gestionó (${fmtInt(input.excluded.cancelledBeforeAssignment)} cancelados antes de asignarse, ${fmtInt(input.excluded.deliveredOutside)} entregados por otros medios).</div>
      </div>
    </div>`;

  // Tabla: 20 filas por hoja; la última hoja lleva el TOTAL, la leyenda y cómo se calcula.
  const PER_PAGE = input.groupBy === 'account' ? 19 : 25;   // por cuenta ML cada fila ocupa dos líneas, así que caben menos por hoja
  const chunks: SellerStats[][] = [];
  for (let i = 0; i < input.sellers.length; i += PER_PAGE) chunks.push(input.sellers.slice(i, i + PER_PAGE));
  if (chunks.length === 0) chunks.push([]);
  const legend = `<div style="display:flex;gap:18px;align-items:center;margin-top:8px;font-size:10px;color:${INK2}">
      <span><b style="color:${RED_TEXT}">▼ rojo</b> = bajo la meta de ${TARGET_PCT} % (riesgo de multa)</span><span><b style="color:${GREEN_TEXT}">✓ verde</b> = en meta</span><span>Porcentajes truncados a 1 decimal</span></div>`;
  const tablePages = chunks.map((chunk, idx) => {
    const last = idx === chunks.length - 1;
    // Una sola línea por fila (alto fijo, la hoja cabe completa): cliente y, a su lado, la cuenta ML (o el identificador), cada uno recortado.
    const rows = chunk.map(s => tableRow(clip(s.title, 36), s.detail ? clip(s.detail, 36) : s.identifier, s, false, input.groupBy === 'account')).join('') + (last ? tableRow('TOTAL', null, t, true) : '');
    return `
      <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #1e293b;padding-bottom:5px">
        <div style="font-size:16px;font-weight:900;letter-spacing:.05em;color:${INK};text-transform:uppercase">Detalle por ${esc(groupLabel(input.groupBy))}</div>
        <div style="font-size:11px;color:${INK2}">Semana ${esc(wk)} · ${chunks.length > 1 ? `parte ${idx + 1} de ${chunks.length}` : `${input.sellers.length} sellers`}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;table-layout:auto">${tableHead(input.groupBy)}<tbody>${rows}</tbody></table>
      ${last ? legend : ''}`;
  });
  const method = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #1e293b;padding-bottom:5px">
      <div style="font-size:16px;font-weight:900;letter-spacing:.05em;color:${INK};text-transform:uppercase">Cómo se calcula este informe</div>
      <div style="font-size:11px;color:${INK2}">Semana ${esc(wk)}</div>
    </div>
    <ol style="margin:12px 0 0;padding-left:20px;font-size:11.5px;line-height:1.5;color:#1e293b">${METHOD_NOTES.map(n => `<li style="margin-bottom:7px">${esc(n)}</li>`).join('')}</ol>`;

  const bodies = [summary, ...tablePages, method];
  return bodies.map((b, i) => shell(b, i + 1, bodies.length, generated, wk));
}

export async function downloadMeliWeeklyPdf(input: MeliExportInput, onProgress?: (done: number, total: number) => void): Promise<void> {
  await renderPagesToPdf(buildMeliWeeklyPdfPages(input), { fileName: `${fileBase(input)}.pdf`, scale: 2, quality: 0.92, onProgress });
}
