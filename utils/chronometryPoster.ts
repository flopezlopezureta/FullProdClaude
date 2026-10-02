// PDF "para el mural" de la pestaña Cronometría de Jornada del Centro de Control.
// Usa html2pdf (ya cargado por CDN en index.html, igual que en DeliveryHistoryPage) — no agrega
// dependencias. Cada hoja es un div de tamaño fijo A4 horizontal con su propio encabezado.
import type { ClosureProfile } from './performanceTypes';
export type { ClosureProfile };

declare const html2pdf: any;

export const CLOSURE_PROFILE_LABELS: Record<ClosureProfile, string> = {
  ON_TIME: 'Cierra al momento',
  DELAYED: 'Cierra con retraso',
  END_OF_DAY: 'Cierra al final del día',
  NO_DATA: 'Sin datos ML suficientes',
};

// Mismos umbrales de color que la pestaña "Cadencia & Tiempos" (min por entrega).
export const paceColor = (min: number | null | undefined): string =>
  min == null ? '#94a3b8' : min > 30 ? '#dc2626' : min > 18 ? '#d97706' : '#059669';

export const PROFILE_STYLES: Record<ClosureProfile, { bg: string; fg: string }> = {
  ON_TIME: { bg: '#d1fae5', fg: '#065f46' },
  DELAYED: { bg: '#fef3c7', fg: '#92400e' },
  END_OF_DAY: { bg: '#fee2e2', fg: '#991b1b' },
  NO_DATA: { bg: '#e2e8f0', fg: '#475569' },
};

export interface PosterRow {
  position: number | null;
  driverName: string;
  firstActivity: string | null;
  lastActivity: string | null;
  totalHoursActive: number | null;
  deliveredCount: number;
  avgMinutesPerDelivery: number | null;
  paceReliable: boolean;
  mlCount: number;
  avgMlDelayMin: number | null;
  lateShare: number | null;
  closureProfile: ClosureProfile;
  burstNote?: string;
}

export interface PosterOptions {
  dateLabel: string;
  communesLabel: string;
  sortLabel: string;
  rows: PosterRow[];
  hasRanking: boolean;
  medals: boolean;
  generatedAt: string;
  fileName: string;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Medidas que html2pdf usa internamente para A4 horizontal (floor(297mm y 210mm a 96dpi)). Cada hoja
// mide exactamente una página, así que NO se fuerzan saltos con `pagebreak.after`: cuando un bloque
// termina justo en el borde de página, html2pdf agrega una hoja completa de relleno (duplicaba las hojas).
const PAGE_W = 1122;
const PAGE_H = 793;
const ROW_H = 30;
const FIRST_PAGE_ROWS = 17;
const OTHER_PAGE_ROWS = 20;
const LAST_PAGE_ROOM_FOR_LEGEND = 14; // filas máximas en la última hoja para que quepa la leyenda

const medalColor = (pos: number) => (pos === 1 ? '#f59e0b' : pos === 2 ? '#94a3b8' : pos === 3 ? '#b45309' : '#1e293b');

function buildRow(r: PosterRow, idx: number, opts: PosterOptions): string {
  const zebra = idx % 2 === 0 ? '#ffffff' : '#f1f5f9';
  const prof = PROFILE_STYLES[r.closureProfile];
  const pace = r.avgMinutesPerDelivery != null && r.paceReliable
    ? `<span style="font-weight:800;color:${paceColor(r.avgMinutesPerDelivery)}">${r.avgMinutesPerDelivery.toFixed(1)}</span>`
    : `<span style="color:#94a3b8;font-weight:700">—</span>`;
  const posBadge = opts.hasRanking
    ? `<td style="width:46px;text-align:center">${r.position != null
        ? `<span style="display:inline-block;width:24px;height:24px;line-height:24px;border-radius:12px;background:${opts.medals ? medalColor(r.position) : '#1e293b'};color:#fff;font-size:12px;font-weight:800">${r.position}</span>`
        : `<span style="color:#94a3b8">·</span>`}</td>`
    : '';
  const delay = r.mlCount > 0 && r.avgMlDelayMin != null
    ? `<b>${r.avgMlDelayMin}</b> min`
    : `<span style="color:#94a3b8">—</span>`;
  const late = r.lateShare != null ? `${Math.round(r.lateShare * 100)}%` : `<span style="color:#94a3b8">—</span>`;
  return `
    <tr style="background:${zebra};height:${ROW_H}px">
      ${posBadge}
      <td style="padding:0 10px;font-weight:800;font-size:13px;text-transform:uppercase;color:#0f172a;white-space:nowrap">${esc(r.driverName)}</td>
      <td style="text-align:center;font-weight:700;color:#047857">${esc(r.firstActivity || '--:--')}</td>
      <td style="text-align:center;font-weight:700;color:#1d4ed8">${esc(r.lastActivity || '--:--')}</td>
      <td style="text-align:center;font-weight:800;color:#0f172a">${r.totalHoursActive != null ? r.totalHoursActive.toFixed(2) : '--'}</td>
      <td style="text-align:center;font-weight:800;color:#0f172a">${r.deliveredCount}</td>
      <td style="text-align:center;font-size:15px">${pace}</td>
      <td style="text-align:center;color:#334155">${r.mlCount || '<span style="color:#94a3b8">—</span>'}</td>
      <td style="text-align:center;color:#0f172a">${delay}</td>
      <td style="text-align:center;color:#0f172a">${late}</td>
      <td style="padding:0 8px">
        <span style="display:inline-block;padding:3px 9px;border-radius:10px;background:${prof.bg};color:${prof.fg};font-size:10.5px;font-weight:800;white-space:nowrap">${esc(CLOSURE_PROFILE_LABELS[r.closureProfile])}</span>
        ${r.burstNote ? `<div style="font-size:9px;color:#991b1b;margin-top:1px">${esc(r.burstNote)}</div>` : ''}
      </td>
    </tr>`;
}

function buildTableHead(opts: PosterOptions): string {
  const th = (t: string, align = 'center') =>
    `<th style="padding:0 6px;text-align:${align};font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:800;color:#fff">${t}</th>`;
  return `
    <thead><tr style="background:#1e293b;height:36px">
      ${opts.hasRanking ? th('#') : ''}
      ${th('Conductor', 'left')}
      ${th('Primera<br>entrega')}${th('Última<br>entrega')}${th('Horas<br>en ruta')}${th('Entregas')}
      ${th('Min por<br>entrega')}${th('Entregas<br>con ML')}${th('Demora cierre<br>app vs ML')}${th('Cierres<br>tardíos')}
      ${th('Perfil de cierre en la app', 'left')}
    </tr></thead>`;
}

function buildLegend(): string {
  const item = (title: string, text: string) =>
    `<div style="flex:1;min-width:0"><div style="font-weight:800;color:#0f172a;font-size:10.5px;margin-bottom:2px">${title}</div><div>${text}</div></div>`;
  return `
    <div style="margin-top:12px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:9.5px;line-height:1.35;color:#475569;display:flex;gap:16px">
      ${item('Min por entrega', 'Minutos promedio entre una entrega y la siguiente: (última − primera entrega) ÷ (entregas − 1). Se mide con la hora real en que el conductor cierra cada entrega en la app.')}
      ${item('Demora de cierre en la app', 'Minutos que pasan desde que Mercado Libre registra la entrega hasta que el conductor la cierra en la app. La hora de ML es la de detección del sistema, por lo que la demora real es igual o mayor. Cierre tardío = más de 30 min.')}
      ${item('Cierra al final del día', 'Al menos la mitad de sus entregas de ML se cerró en la app después de terminar la ruta y con más de 30 min de demora. Sin hora real de entrega, su tiempo por entrega no se compara en el ranking.')}
    </div>`;
}

function buildPages(opts: PosterOptions): string[] {
  const rows = opts.rows;
  const chunks: PosterRow[][] = [];
  let i = 0;
  chunks.push(rows.slice(i, i + FIRST_PAGE_ROWS)); i += FIRST_PAGE_ROWS;
  while (i < rows.length) { chunks.push(rows.slice(i, i + OTHER_PAGE_ROWS)); i += OTHER_PAGE_ROWS; }
  const lastChunkTooFull = chunks[chunks.length - 1].length > LAST_PAGE_ROOM_FOR_LEGEND;
  if (lastChunkTooFull) chunks.push([]); // la leyenda va sola en una hoja extra
  const total = chunks.length;

  return chunks.map((chunk, pageIdx) => {
    const isFirst = pageIdx === 0;
    const isLast = pageIdx === total - 1;
    const header = isFirst
      ? `<div style="background:linear-gradient(90deg,#0f172a,#1e1b4b);border-radius:12px;padding:14px 22px;display:flex;justify-content:space-between;align-items:center;color:#fff">
           <div>
             <div style="font-size:11px;letter-spacing:.3em;color:#a5b4fc;font-weight:800">FULL ENVÍOS · CONTROL DE FLOTA</div>
             <div style="font-size:28px;font-weight:900;letter-spacing:.04em;margin-top:2px">CRONOMETRÍA DE JORNADA</div>
           </div>
           <div style="text-align:right">
             <div style="font-size:17px;font-weight:800">${esc(opts.dateLabel)}</div>
             <div style="font-size:11px;color:#c7d2fe;margin-top:3px">${esc(opts.communesLabel)} · ${esc(opts.sortLabel)}</div>
           </div>
         </div>`
      : `<div style="display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid #1e293b;padding-bottom:6px">
           <div style="font-size:16px;font-weight:900;letter-spacing:.06em;color:#0f172a">CRONOMETRÍA DE JORNADA</div>
           <div style="font-size:11px;color:#475569">${esc(opts.dateLabel)} · ${esc(opts.communesLabel)} · ${esc(opts.sortLabel)}</div>
         </div>`;
    const table = chunk.length
      ? `<table style="width:100%;border-collapse:collapse;margin-top:${isFirst ? 12 : 10}px;font-size:12px">${buildTableHead(opts)}<tbody>${chunk.map((r, k) => buildRow(r, k, opts)).join('')}</tbody></table>`
      : '';
    return `
      <div class="poster-page" style="width:${PAGE_W}px;height:${PAGE_H}px;box-sizing:border-box;padding:24px 28px 14px;background:#fff;display:flex;flex-direction:column;font-family:'Segoe UI',Roboto,Arial,sans-serif;overflow:hidden">
        ${header}
        <div style="flex:1">${table}${isLast ? buildLegend() : ''}</div>
        <div style="display:flex;justify-content:space-between;font-size:9.5px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:5px">
          <span>Full Envíos · Generado el ${esc(opts.generatedAt)}</span>
          <span>Hoja ${pageIdx + 1} de ${total}</span>
        </div>
      </div>`;
  });
}

/** Devuelve el HTML (para pruebas / vista previa) y descarga el PDF. */
export async function downloadChronometryPoster(opts: PosterOptions): Promise<void> {
  if (typeof html2pdf === 'undefined') {
    throw new Error('El generador de PDF no está disponible (no cargó html2pdf). Recarga la página e inténtalo de nuevo.');
  }
  const pages = buildPages(opts);
  const wrapper = document.createElement('div');
  // El wrapper (que NO se clona) es el que se saca de pantalla; el contenedor interno queda limpio.
  wrapper.style.cssText = `position:fixed;left:-20000px;top:0;width:${PAGE_W}px;pointer-events:none`;
  const container = document.createElement('div');
  container.style.cssText = `width:${PAGE_W}px;background:#fff`;
  container.innerHTML = pages.join('');
  wrapper.appendChild(container);
  document.body.appendChild(wrapper);
  try {
    await html2pdf().set({
      margin: 0,
      filename: opts.fileName,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff', windowWidth: PAGE_W },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
      pagebreak: { mode: ['css'] },
    }).from(container).save();
  } finally {
    wrapper.remove();
  }
}
