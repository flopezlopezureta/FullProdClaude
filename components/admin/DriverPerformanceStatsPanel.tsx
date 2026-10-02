import React, { useState, useEffect, useMemo, useRef, useContext } from 'react';
import { api } from '../../services/api';
import { AuthContext } from '../../contexts/AuthContext';
import { getLocalDateString } from '../../utils/dateUtils';
import { IconChevronDown } from '../Icon';
import ChartCanvas from './ChartCanvas';
import type { PerformanceReport, DriverPerformance } from '../../utils/performanceTypes';
import { SOURCE_LABELS } from '../../utils/performanceTypes';
import {
  C, PROFILE_COLORS, dailyChartConfig, hourlyChartConfig, statusChartConfig, paceChartConfig,
  closureChartConfig, horizontalBarConfig, driversBarConfig,
} from '../../utils/performanceCharts';
import { downloadPerformancePdf, dmy, vs, TONE_COLOR, type Tone } from '../../utils/performanceReportPdf';
import { CLOSURE_PROFILE_LABELS, PROFILE_STYLES } from '../../utils/chronometryPoster';

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const firstOfMonth = (iso: string) => `${iso.slice(0, 8)}01`;

const n0 = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('es-CL'));
const n1 = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pctTxt = (v: number | null | undefined) => (v == null ? '—' : `${n1(v)}%`);
const share = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');

const Kpi: React.FC<{ label: string; value: React.ReactNode; sub?: { text: string; tone: Tone } | string }> = ({ label, value, sub }) => (
  <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-sm">
    <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">{label}</span>
    <div className="text-2xl font-black text-slate-900 leading-tight mt-0.5">{value}</div>
    {sub && (
      <div className="text-[11px] font-bold mt-0.5" style={{ color: typeof sub === 'string' ? '#64748b' : TONE_COLOR[sub.tone] }}>
        {typeof sub === 'string' ? sub : sub.text}
      </div>
    )}
  </div>
);

const Card: React.FC<{ title: string; children: React.ReactNode; className?: string }> = ({ title, children, className = '' }) => (
  <div className={`bg-white rounded-xl border border-slate-200 shadow-sm p-4 ${className}`}>
    <h4 className="text-[11px] font-black text-slate-700 uppercase tracking-wider mb-3">{title}</h4>
    {children}
  </div>
);

const StatLine: React.FC<{ label: string; value: React.ReactNode; tone?: Tone }> = ({ label, value, tone }) => (
  <div className="flex justify-between gap-3 py-1.5 border-b border-dashed border-slate-200 text-xs">
    <span className="text-slate-500 font-semibold">{label}</span>
    <b style={{ color: tone ? TONE_COLOR[tone] : '#0f172a' }} className="text-right">{value}</b>
  </div>
);

const ProfilePill: React.FC<{ profile: keyof typeof CLOSURE_PROFILE_LABELS }> = ({ profile }) => (
  <span className="inline-block px-2 py-0.5 text-[10px] font-black rounded-full whitespace-nowrap" style={{ background: PROFILE_STYLES[profile].bg, color: PROFILE_STYLES[profile].fg }}>
    {CLOSURE_PROFILE_LABELS[profile]}
  </span>
);

type Col = {
  key: string; label: string; align?: 'left' | 'center';
  get: (d: DriverPerformance) => number | string | null;
  render: (d: DriverPerformance, fleet: PerformanceReport['fleet']['averages']) => React.ReactNode;
};
const COLUMNS: Col[] = [
  { key: 'name', label: 'Conductor', align: 'left', get: d => d.driverName, render: d => <span className="font-bold uppercase whitespace-nowrap">{d.driverName}</span> },
  { key: 'days', label: 'Días', get: d => d.totals.daysWorked, render: d => d.totals.daysWorked },
  { key: 'assigned', label: 'Asignados', get: d => d.totals.assigned, render: d => n0(d.totals.assigned) },
  { key: 'delivered', label: 'Entregados', get: d => d.totals.delivered, render: d => <b>{n0(d.totals.delivered)}</b> },
  { key: 'rate', label: '% Efectividad', get: d => d.totals.deliveryRate, render: (d, f) => <b style={{ color: d.totals.deliveryRate != null && f.deliveryRate != null && d.totals.deliveryRate < f.deliveryRate - 1 ? '#b91c1c' : '#047857' }}>{pctTxt(d.totals.deliveryRate)}</b> },
  { key: 'incident', label: '% Incidencias', get: d => d.totals.incidentRate, render: d => pctTxt(d.totals.incidentRate) },
  { key: 'pace', label: 'Min / entrega', get: d => d.pace.avgMinutesPerDelivery, render: d => <b>{n1(d.pace.avgMinutesPerDelivery)}</b> },
  { key: 'hours', label: 'Horas / día', get: d => d.pace.avgHoursActive, render: d => n1(d.pace.avgHoursActive, 2) },
  { key: 'start', label: 'Inicio prom.', get: d => d.pace.avgStart, render: d => d.pace.avgStart || '—' },
  { key: 'end', label: 'Fin prom.', get: d => d.pace.avgEnd, render: d => d.pace.avgEnd || '—' },
  { key: 'ml', label: 'Entregas ML', get: d => d.closure.mlDeliveries, render: d => d.closure.mlDeliveries || '—' },
  { key: 'delay', label: 'Demora cierre', get: d => d.closure.avgMlDelayMin, render: d => (d.closure.avgMlDelayMin != null ? `${n0(d.closure.avgMlDelayMin)} min` : '—') },
  { key: 'late', label: '% Cierres tardíos', get: d => d.closure.lateShare, render: d => <span style={d.closure.lateShare != null && d.closure.lateShare >= 0.25 ? { color: '#b91c1c', fontWeight: 800 } : undefined}>{share(d.closure.lateShare)}</span> },
  { key: 'bulk', label: 'Días cierre al final', get: d => d.closure.daysEndOfDay, render: d => <span style={d.closure.daysEndOfDay ? { color: '#b91c1c', fontWeight: 800 } : undefined}>{d.closure.daysEndOfDay}</span> },
  { key: 'sys', label: 'Cierres conductor / sistema', get: d => d.closure.systemClosureDays, render: d => `${d.closure.appClosureDays} / ${d.closure.systemClosureDays}` },
];

export const DriverPerformanceStatsPanel: React.FC = () => {
  const auth = useContext(AuthContext);
  const tz = auth?.systemSettings?.timezone || 'America/Santiago';
  const today = getLocalDateString(new Date(), tz);

  const [startDate, setStartDate] = useState(firstOfMonth(today));
  const [endDate, setEndDate] = useState(today);
  const [roster, setRoster] = useState<{ id: string; name: string }[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]); // vacío = todos
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);

  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState('rate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [pdfProgress, setPdfProgress] = useState<{ done: number; total: number } | null>(null);
  const [includeSheets, setIncludeSheets] = useState(true);

  useEffect(() => {
    api.getUsers().then(users => {
      setRoster(users
        .filter((u: any) => String(u.role).toUpperCase() === 'DRIVER' && u.status !== 'ELIMINADO' && !/bodega/i.test(u.name))
        .map((u: any) => ({ id: u.id, name: u.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')));
    }).catch(() => setRoster([]));
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const generate = async () => {
    if (startDate > endDate) { setError('La fecha de inicio debe ser anterior o igual a la de término.'); return; }
    setIsLoading(true); setError(null); setDetailId(null);
    try {
      setReport(await api.getDriverPerformance(startDate, endDate, selectedIds));
    } catch (e: any) {
      setError(e?.message || 'No se pudo generar el informe.');
      setReport(null);
    } finally {
      setIsLoading(false);
    }
  };

  const setRange = (s: string, e: string) => { setStartDate(s); setEndDate(e); };
  const prevMonthFirst = firstOfMonth(addDays(firstOfMonth(today), -1));

  const detail = useMemo(() => {
    if (!report) return null;
    if (detailId) return report.drivers.find(d => d.driverId === detailId) || null;
    return report.drivers.length === 1 ? report.drivers[0] : null;
  }, [report, detailId]);

  const sortedDrivers = useMemo(() => {
    if (!report) return [];
    const col = COLUMNS.find(c => c.key === sortKey) || COLUMNS[0];
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...report.drivers].sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string' || typeof vb === 'string') return dir * String(va).localeCompare(String(vb), 'es');
      return dir * ((va as number) - (vb as number));
    });
  }, [report, sortKey, sortDir]);

  const onSort = (key: string) => {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' || key === 'pace' || key === 'incident' || key === 'delay' || key === 'late' || key === 'bulk' || key === 'sys' ? 'asc' : 'desc'); }
  };

  const runPdf = async (opts: Parameters<typeof downloadPerformancePdf>[0]) => {
    setPdfProgress({ done: 0, total: 1 });
    try {
      await downloadPerformancePdf({ ...opts, onProgress: (done, total) => setPdfProgress({ done, total }) });
    } catch (e: any) {
      alert(e?.message || 'No se pudo generar el PDF.');
    } finally {
      setPdfProgress(null);
    }
  };
  const generatedAt = () => new Date().toLocaleString('es-CL', { timeZone: tz });
  const downloadDriverPdf = (d: DriverPerformance) => report && runPdf({
    report, drivers: [d], comparative: false, includeDaily: true, generatedAt: generatedAt(),
    fileName: `Rendimiento_${slug(d.driverName)}_${report.period.startDate}_${report.period.endDate}.pdf`,
  });
  const downloadFleetPdf = () => report && runPdf({
    report, drivers: includeSheets ? sortedDrivers : [], comparative: true, includeDaily: false, generatedAt: generatedAt(),
    fileName: `Rendimiento_Conductores_${report.period.startDate}_${report.period.endDate}.pdf`,
  });

  const filteredRoster = roster.filter(r => r.name.toLowerCase().includes(search.trim().toLowerCase()));
  const toggleId = (id: string) => setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const driversLabel = selectedIds.length === 0 ? 'Todos los conductores'
    : selectedIds.length <= 2 ? roster.filter(r => selectedIds.includes(r.id)).map(r => r.name).join(', ')
    : `${selectedIds.length} conductores`;

  const fleetCharts = useMemo(() => {
    if (!report || report.drivers.length < 2) return null;
    const ds = report.drivers;
    const withVol = ds.filter(d => d.totals.assigned >= 5);
    const paced = ds.filter(d => d.pace.avgMinutesPerDelivery != null && d.pace.reliableDays >= 2);
    const closers = ds.filter(d => d.closure.mlDeliveries >= report.meta.minMlForProfile && d.closure.avgMlDelayMin != null);
    return {
      delivered: driversBarConfig(ds, d => d.totals.delivered, 'Entregados', C.indigo),
      rate: driversBarConfig(withVol, d => d.totals.deliveryRate, '% Efectividad', C.emerald, { min: 90, max: 100, suffix: '%' }),
      pace: driversBarConfig(paced, d => d.pace.avgMinutesPerDelivery, 'Min por entrega', C.sky, { order: 'asc' }),
      delay: driversBarConfig(closers, d => d.closure.avgMlDelayMin, 'Min de demora', C.amber),
    };
  }, [report]);

  const detailCharts = useMemo(() => {
    if (!detail || !report) return null;
    return {
      daily: dailyChartConfig(detail.daily),
      hourly: hourlyChartConfig(detail.byHour),
      status: statusChartConfig(detail.totals),
      pace: paceChartConfig(detail.daily, report.fleet.averages.avgMinutesPerDelivery),
      closure: closureChartConfig(detail.daily, report.meta.lateCloseMinutes),
      communes: horizontalBarConfig(detail.byCommune.map(x => ({ label: x.commune, value: x.count })), C.violet, 'Entregas'),
      reasons: horizontalBarConfig(detail.problemReasons.map(x => ({ label: x.reason, value: x.count })), C.red, 'Incidencias'),
    };
  }, [detail, report]);

  const f = report?.fleet.averages;
  const busy = pdfProgress !== null;

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <span className="block text-[10px] font-black text-slate-500 uppercase mb-1">Desde</span>
            <input type="date" value={startDate} max={endDate} onChange={e => setStartDate(e.target.value)} className="px-3 py-1.5 text-xs font-bold bg-slate-100 border border-slate-200 rounded-lg" />
          </div>
          <div>
            <span className="block text-[10px] font-black text-slate-500 uppercase mb-1">Hasta</span>
            <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} className="px-3 py-1.5 text-xs font-bold bg-slate-100 border border-slate-200 rounded-lg" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[
              { l: 'Últimos 7 días', s: addDays(today, -6), e: today },
              { l: 'Últimos 30 días', s: addDays(today, -29), e: today },
              { l: 'Este mes', s: firstOfMonth(today), e: today },
              { l: 'Mes pasado', s: prevMonthFirst, e: addDays(firstOfMonth(today), -1) },
            ].map(p => (
              <button key={p.l} type="button" onClick={() => setRange(p.s, p.e)}
                className={`px-3 py-1.5 text-[10px] font-black uppercase rounded-lg border ${startDate === p.s && endDate === p.e ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                {p.l}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="relative" ref={menuRef}>
            <span className="block text-[10px] font-black text-slate-500 uppercase mb-1">Conductores</span>
            <button type="button" onClick={() => setMenuOpen(o => !o)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-bold bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 min-w-[240px] justify-between">
              <span className="truncate max-w-[260px]">{driversLabel}</span>
              <IconChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
            </button>
            {menuOpen && (
              <div className="absolute z-30 mt-1 w-80 bg-white border border-slate-200 rounded-xl shadow-xl p-2">
                <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar conductor..."
                  className="w-full px-3 py-1.5 mb-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400" />
                <div className="flex items-center justify-between px-1 pb-1.5 text-[10px] font-black uppercase text-slate-500">
                  <button type="button" onClick={() => setSelectedIds([])} className="text-indigo-600 hover:underline">Todos los conductores</button>
                  <span>{selectedIds.length === 0 ? 'todos' : `${selectedIds.length} seleccionado${selectedIds.length === 1 ? '' : 's'}`}</span>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {filteredRoster.length === 0 ? <p className="px-2 py-3 text-xs text-slate-400 text-center">Sin resultados</p> : filteredRoster.map(r => (
                    <label key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs font-bold text-slate-800">
                      <input type="checkbox" checked={selectedIds.includes(r.id)} onChange={() => toggleId(r.id)} className="h-3.5 w-3.5 rounded" />
                      <span className="flex-1 truncate uppercase">{r.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button type="button" onClick={generate} disabled={isLoading}
            className="px-5 py-2 text-xs font-black text-white bg-indigo-600 rounded-lg shadow-sm hover:bg-indigo-700 disabled:opacity-50 uppercase tracking-wider">
            {isLoading ? 'Generando...' : 'Generar informe'}
          </button>
          <p className="text-[11px] text-slate-500 font-semibold max-w-md">
            Elige el período y uno o varios conductores (o déjalo en “Todos”). Se calcula con las entregas reales, su ritmo y el cierre en la app frente a Mercado Libre.
          </p>
        </div>
        {error && <p className="text-xs font-bold text-red-600">{error}</p>}
      </div>

      {!report && !isLoading && !error && (
        <div className="bg-white p-10 rounded-xl border border-dashed border-slate-300 text-center text-sm font-bold text-slate-400 uppercase">
          Selecciona el período y pulsa “Generar informe”
        </div>
      )}
      {isLoading && <div className="bg-white p-10 rounded-xl border border-slate-200 text-center text-sm font-bold text-slate-500">Calculando el rendimiento de los conductores…</div>}

      {report && !isLoading && report.drivers.length === 0 && (
        <div className="bg-white p-10 rounded-xl border border-slate-200 text-center text-sm font-bold text-slate-400 uppercase">No hay actividad de conductores en el período seleccionado</div>
      )}

      {/* ---------- Comparativa (varios conductores) ---------- */}
      {report && !isLoading && report.drivers.length > 1 && !detail && f && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider">Rendimiento de la flota · {dmy(report.period.startDate)} al {dmy(report.period.endDate)}</h3>
              <p className="text-[11px] font-bold text-slate-500">{report.drivers.length} conductores · {report.period.days} días</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 cursor-pointer">
                <input type="checkbox" checked={includeSheets} onChange={e => setIncludeSheets(e.target.checked)} className="h-3.5 w-3.5 rounded" />
                Incluir hoja de cada conductor
              </label>
              <button type="button" onClick={downloadFleetPdf} disabled={busy}
                className="px-4 py-2 text-xs font-black text-white bg-indigo-600 rounded-lg shadow-sm hover:bg-indigo-700 disabled:opacity-50 uppercase tracking-wider">
                {busy ? `PDF: hoja ${pdfProgress!.done} de ${pdfProgress!.total}…` : '⬇ Descargar PDF'}
              </button>
            </div>
          </div>
          {includeSheets && report.drivers.length > 12 && !busy && (
            <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Con hoja por conductor el PDF tiene unas {2 + report.drivers.length * 2 + Math.ceil(report.drivers.length / 24)} hojas y puede tardar uno o dos minutos en generarse. No cierres esta pestaña mientras avanza.
            </p>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Paquetes asignados" value={n0(report.fleet.totals.assigned)} sub={`${n0(report.fleet.totals.delivered)} entregados`} />
            <Kpi label="Efectividad de la flota" value={pctTxt(f.deliveryRate)} sub={`${n0(report.fleet.totals.pending)} pendientes · ${n0(report.fleet.totals.cancelled)} cancelados`} />
            <Kpi label="Incidencias" value={pctTxt(f.incidentRate)} sub={`${n0(report.fleet.totals.problemPackages)} paquetes con problema`} />
            <Kpi label="Entregas por día (prom.)" value={n1(f.avgDeliveriesPerDay)} sub="Por conductor" />
            <Kpi label="Min por entrega (prom.)" value={n1(f.avgMinutesPerDelivery)} sub={`${n1(f.avgHoursActive, 2)} hrs en ruta por día`} />
            <Kpi label="Demora de cierre en la app" value={f.avgMlDelayMin == null ? '—' : `${n0(f.avgMlDelayMin)} min`} sub={`Sobre ${n0(report.fleet.totals.mlDeliveries)} entregas de ML`} />
            <Kpi label="Cierres tardíos" value={share(f.lateShare)} sub={`Más de ${report.meta.lateCloseMinutes} min después de ML`} />
            <Kpi label="Foto de comprobante" value={pctTxt(f.photoRate)} sub="De las entregas" />
          </div>

          {fleetCharts && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card title="Entregados por conductor"><ChartCanvas config={fleetCharts.delivered} height={260} /></Card>
              <Card title="% de efectividad por conductor"><ChartCanvas config={fleetCharts.rate} height={260} /></Card>
              <Card title="Min por entrega por conductor (menos es mejor)"><ChartCanvas config={fleetCharts.pace} height={260} /></Card>
              <Card title="Demora de cierre en la app respecto a ML (min)"><ChartCanvas config={fleetCharts.delay} height={260} /></Card>
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto shadow-sm">
            <table className="w-full text-left">
              <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider">
                <tr>
                  {COLUMNS.map(col => (
                    <th key={col.key} onClick={() => onSort(col.key)} className={`px-3 py-3 cursor-pointer select-none hover:bg-slate-800 ${col.align === 'left' ? '' : 'text-center'}`}>
                      {col.label}{sortKey === col.key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                  <th className="px-3 py-3 text-center">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {sortedDrivers.map(d => (
                  <tr key={d.driverId} className="hover:bg-slate-50">
                    {COLUMNS.map(col => (
                      <td key={col.key} className={`px-3 py-2.5 ${col.align === 'left' ? '' : 'text-center'}`}>{col.render(d, f)}</td>
                    ))}
                    <td className="px-3 py-2.5 text-center whitespace-nowrap">
                      <button type="button" onClick={() => setDetailId(d.driverId)} className="px-2 py-1 text-[10px] font-black text-indigo-700 bg-indigo-50 rounded-md hover:bg-indigo-100 uppercase">Ver detalle</button>
                      <button type="button" onClick={() => downloadDriverPdf(d)} disabled={busy} className="ml-1 px-2 py-1 text-[10px] font-black text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200 disabled:opacity-50 uppercase">PDF</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] font-bold text-slate-400 px-1">
            Efectividad = entregados ÷ asignados. Min por entrega solo con días en que el conductor cerró sus entregas en el momento (se excluye el cierre masivo al final del día). Demora de cierre = minutos entre el cierre detectado de Mercado Libre y el cierre en la app (la hora de ML es la de detección del sistema: la demora real es igual o mayor). Haz clic en un encabezado para ordenar.
          </p>
        </div>
      )}

      {/* ---------- Detalle de un conductor ---------- */}
      {report && !isLoading && detail && detailCharts && f && (() => {
        const t = detail.totals, p = detail.pace, c = detail.closure;
        const mixTotal = detail.mix.reduce((s, m) => s + m.count, 0) || 1;
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {report.drivers.length > 1 && (
                  <button type="button" onClick={() => setDetailId(null)} className="text-[11px] font-black text-indigo-600 hover:underline uppercase mb-1">← Volver a la comparación</button>
                )}
                <h3 className="text-lg font-black text-slate-900 uppercase tracking-wide">{detail.driverName}</h3>
                <p className="text-[11px] font-bold text-slate-500">{dmy(report.period.startDate)} al {dmy(report.period.endDate)} · {t.daysWorked} días con actividad{detail.phone ? ` · ${detail.phone}` : ''}</p>
              </div>
              <button type="button" onClick={() => downloadDriverPdf(detail)} disabled={busy}
                className="px-4 py-2 text-xs font-black text-white bg-indigo-600 rounded-lg shadow-sm hover:bg-indigo-700 disabled:opacity-50 uppercase tracking-wider">
                {busy ? `PDF: hoja ${pdfProgress!.done} de ${pdfProgress!.total}…` : '⬇ Descargar PDF'}
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi label="Paquetes asignados" value={n0(t.assigned)} sub={`${t.daysWorked} días trabajados`} />
              <Kpi label="Entregados" value={n0(t.delivered)} sub={`${n1(t.avgDeliveriesPerDay)} por día · flota ${n1(f.avgDeliveriesPerDay)}`} />
              <Kpi label="Efectividad" value={pctTxt(t.deliveryRate)} sub={vs(t.deliveryRate, f.deliveryRate, { higherBetter: true, unit: '%' })} />
              <Kpi label="Incidencias" value={pctTxt(t.incidentRate)} sub={vs(t.incidentRate, f.incidentRate, { higherBetter: false, unit: '%' })} />
              <Kpi label="Min por entrega" value={n1(p.avgMinutesPerDelivery)} sub={vs(p.avgMinutesPerDelivery, f.avgMinutesPerDelivery, { higherBetter: false })} />
              <Kpi label="Horas en ruta / día" value={n1(p.avgHoursActive, 2)} sub={p.avgStart ? `Inicio ${p.avgStart} · Fin ${p.avgEnd}` : 'Sin días comparables'} />
              <Kpi label="Demora cierre en app" value={c.avgMlDelayMin == null ? '—' : `${n0(c.avgMlDelayMin)} min`} sub={vs(c.avgMlDelayMin, f.avgMlDelayMin, { higherBetter: false, unit: ' min', digits: 0 })} />
              <Kpi label="Cierres tardíos" value={share(c.lateShare)} sub={c.mlDeliveries ? `${c.lateCount} de ${c.mlDeliveries} entregas ML · flota ${share(f.lateShare)}` : 'Sin entregas de ML'} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card title="Entregas por día y % de efectividad" className="lg:col-span-2"><ChartCanvas config={detailCharts.daily} height={280} /></Card>
              <Card title="Entregas por hora del día"><ChartCanvas config={detailCharts.hourly} height={230} /></Card>
              <Card title="Estado de los paquetes asignados"><ChartCanvas config={detailCharts.status} height={230} /></Card>
              <Card title="Minutos por entrega por día"><ChartCanvas config={detailCharts.pace} height={230} /></Card>
              <Card title="Demora de cierre en la app respecto a ML, por día">
                <ChartCanvas config={detailCharts.closure} height={210} />
                <div className="flex flex-wrap gap-3 mt-2 text-[10px] font-bold text-slate-500">
                  {(['ON_TIME', 'DELAYED', 'END_OF_DAY', 'NO_DATA'] as const).map(k => (
                    <span key={k} className="inline-flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: PROFILE_COLORS[k] }} />{CLOSURE_PROFILE_LABELS[k]}</span>
                  ))}
                  <span className="inline-flex items-center gap-1"><span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: C.red }} />Límite de cierre tardío ({report.meta.lateCloseMinutes} min)</span>
                </div>
              </Card>
              <Card title="Comunas con más entregas"><ChartCanvas config={detailCharts.communes} height={Math.max(140, detail.byCommune.length * 28 + 30)} /></Card>
              <Card title="Motivos de incidencia">
                {detail.problemReasons.length ? <ChartCanvas config={detailCharts.reasons} height={Math.max(140, detail.problemReasons.length * 28 + 30)} />
                  : <p className="text-xs font-bold text-slate-400 py-6 text-center">Sin incidencias registradas en el período</p>}
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card title="Ritmo de entrega">
                <StatLine label="Hora promedio de inicio" value={p.avgStart || '—'} />
                <StatLine label="Hora promedio de término" value={p.avgEnd || '—'} />
                <StatLine label="Horas promedio en ruta" value={p.avgHoursActive != null ? `${n1(p.avgHoursActive, 2)} hrs` : '—'} />
                <StatLine label="Minutos por entrega (promedio)" value={n1(p.avgMinutesPerDelivery)} tone={vs(p.avgMinutesPerDelivery, f.avgMinutesPerDelivery, { higherBetter: false }).tone} />
                <StatLine label="Entregas por hora activa" value={n1(p.deliveriesPerActiveHour)} />
                <StatLine label="Días comparables" value={`${p.reliableDays} de ${t.daysWorked}`} />
                <StatLine label="Con foto de comprobante" value={pctTxt(t.photoRate)} tone={t.photoRate != null && t.photoRate < 95 ? 'bad' : undefined} />
                <StatLine label="Mejor día" value={t.bestDay ? `${dmy(t.bestDay.date)} · ${t.bestDay.delivered} entregas` : '—'} />
                <StatLine label="Día más bajo" value={t.worstDay ? `${dmy(t.worstDay.date)} · ${t.worstDay.delivered} entregas` : '—'} />
                <StatLine label="Origen de los paquetes" value={detail.mix.slice(0, 3).map(m => `${SOURCE_LABELS[m.source] || m.source} ${Math.round(m.count / mixTotal * 100)}%`).join(' · ') || '—'} />
              </Card>
              <Card title="Cierre en la app vs Mercado Libre">
                <StatLine label="Entregas con cierre en ML" value={n0(c.mlDeliveries)} />
                <StatLine label="Demora promedio de cierre" value={c.avgMlDelayMin != null ? `${n0(c.avgMlDelayMin)} min` : '—'} tone={vs(c.avgMlDelayMin, f.avgMlDelayMin, { higherBetter: false, digits: 0 }).tone} />
                <StatLine label={`Cierres tardíos (>${report.meta.lateCloseMinutes} min)`} value={c.mlDeliveries ? `${c.lateCount} (${share(c.lateShare)})` : '—'} tone={c.lateShare != null && c.lateShare >= 0.25 ? 'bad' : undefined} />
                <StatLine label="Días: al momento" value={c.daysOnTime} />
                <StatLine label="Días: con retraso" value={c.daysDelayed} tone={c.daysDelayed ? 'bad' : undefined} />
                <StatLine label="Días: cierra al final del día" value={c.daysEndOfDay} tone={c.daysEndOfDay ? 'bad' : undefined} />
                <StatLine label="Cierre diario hecho por el conductor" value={`${c.appClosureDays} de ${t.daysWorked} días`} />
                <StatLine label="Cierre completado por el sistema" value={c.systemClosureDays} tone={c.systemClosureDays ? 'bad' : undefined} />
                <StatLine label="Hora promedio de cierre diario" value={c.avgClosureTime || '—'} />
              </Card>
            </div>

            <Card title="Detalle diario">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider">
                    <tr>
                      {['Fecha', 'Asignados', 'Entregados', '% Efect.', 'Con problema', 'Primera', 'Última', 'Horas', 'Min / entrega', 'Entregas ML', 'Demora cierre', 'Cierres tardíos', 'Perfil de cierre'].map((h, i) => (
                        <th key={h} className={`px-3 py-2.5 ${i === 0 || i === 12 ? '' : 'text-center'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {detail.daily.map(x => (
                      <tr key={x.date} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-bold">{dmy(x.date)}</td>
                        <td className="px-3 py-2 text-center">{x.assigned}</td>
                        <td className="px-3 py-2 text-center font-bold">{x.delivered}</td>
                        <td className="px-3 py-2 text-center">{pctTxt(x.deliveryRate)}</td>
                        <td className="px-3 py-2 text-center" style={x.hadProblem ? { color: '#b91c1c', fontWeight: 800 } : undefined}>{x.hadProblem}</td>
                        <td className="px-3 py-2 text-center font-bold text-emerald-700">{x.firstActivity || '—'}</td>
                        <td className="px-3 py-2 text-center font-bold text-blue-700">{x.lastActivity || '—'}</td>
                        <td className="px-3 py-2 text-center">{x.hoursActive != null && x.deliveredCount > 1 ? n1(x.hoursActive, 2) : '—'}</td>
                        <td className="px-3 py-2 text-center font-bold">{x.avgMinutesPerDelivery != null ? n1(x.avgMinutesPerDelivery) : '—'}</td>
                        <td className="px-3 py-2 text-center">{x.mlCount || '—'}</td>
                        <td className="px-3 py-2 text-center">{x.mlCount && x.avgMlDelayMin != null ? `${x.avgMlDelayMin} min` : '—'}</td>
                        <td className="px-3 py-2 text-center">{x.lateShare != null ? share(x.lateShare) : '—'}</td>
                        <td className="px-3 py-2">
                          <ProfilePill profile={x.closureProfile} />
                          {x.closureProfile === 'END_OF_DAY' && x.maxBurst > 0 && <span className="ml-2 text-[10px] font-bold text-red-600">{x.maxBurst} cierres en 10 min · {x.burstAt}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        );
      })()}
    </div>
  );
};

export default DriverPerformanceStatsPanel;
