import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, LineChart, Line, Rectangle,
} from 'recharts';
import {
    IconRefresh, IconAlertTriangle, IconChevronLeft, IconChevronRight, IconCheckCircle, IconDownload, IconFileSpreadsheet,
    IconX, IconSearch, IconTarget, IconInfo, IconChevronDown, IconLoader,
} from '../Icon';
import {
    TARGET_PCT, CUTOFF_HOUR, LOW_VOLUME, METHOD_NOTES, mondayOf, addDays, weeksEndingAt, weekLabel, shortDate, fmtInt, fmtPct, fmtDelta, deltaPp,
    sellersForWeek, totalsForWeek, weeklyTrend, dailyForWeek, excludedForWeek, sortSellers, clip,
} from '../../utils/meliWeeklyReport';
import type { MeliWeeklyReport, GroupBy, SellerStats, Stats, SortKey } from '../../utils/meliWeeklyReport';
import { downloadMeliWeeklyExcel, downloadMeliWeeklyPdf } from '../../utils/meliWeeklyExports';

const WINDOW_WEEKS = 8;

// Colores: los del sistema de gráficos del informe (validados para daltonismo y contraste sobre fondo blanco). El rojo "crítico" solo
// significa "bajo la meta" y siempre va acompañado de ▼ y de la palabra; el verde, de ✓.
const C = {
    ink: '#0f172a', ink2: '#475569', muted: '#94a3b8', grid: '#e2e8f0', axis: '#cbd5e1',
    blue: '#2a78d6', orange: '#eb6834', red: '#d03b3b', redText: '#b91c1c', redBg: '#fef2f2', greenText: '#047857', target: '#334155',
};

type Tone = 'good' | 'bad' | 'neutral';
const TONE_TEXT: Record<Tone, string> = { good: C.greenText, bad: C.redText, neutral: C.ink2 };

/** Porcentaje con ▼ rojo si está bajo la meta o ✓ verde si no. `compact` lo deja como texto simple (para celdas). */
const PctBadge: React.FC<{ pct: number | null; below: boolean; lowVolume?: boolean }> = ({ pct, below, lowVolume }) => {
    if (pct == null) return <span className="text-slate-300">—</span>;
    const hint = `${below ? `Bajo la meta de ${TARGET_PCT}% · riesgo de multa` : `En meta (${TARGET_PCT}% o más)`}${lowVolume ? ` · pocos paquetes (menos de ${LOW_VOLUME}): un solo paquete cambia mucho el porcentaje` : ''}`;
    return below ? (
        <span title={hint} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-black tabular-nums" style={{ background: C.redBg, color: C.redText }}>
            <span aria-hidden="true" className="text-[9px]">▼</span>{fmtPct(pct)}<span className="sr-only"> bajo la meta</span>
        </span>
    ) : (
        <span title={hint} className="inline-flex items-center gap-1 font-bold tabular-nums" style={{ color: C.greenText }}>
            <span aria-hidden="true" className="text-[10px]">✓</span>{fmtPct(pct)}<span className="sr-only"> en meta</span>
        </span>
    );
};

const DeltaText: React.FC<{ delta: number | null; label?: string }> = ({ delta, label = 'vs semana anterior' }) => {
    if (delta == null) return <span className="text-slate-400">Sin semana anterior para comparar</span>;
    const tone: Tone = delta === 0 ? 'neutral' : delta > 0 ? 'good' : 'bad';
    return <span style={{ color: TONE_TEXT[tone] }}>{delta === 0 ? '＝' : delta > 0 ? '▲' : '▼'} {fmtDelta(delta)} {label}</span>;
};

const Kpi: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; chip?: { text: string; tone: Tone }; valueColor?: string }> = ({ label, value, sub, chip, valueColor }) => (
    <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col">
        <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
            <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider leading-tight">{label}</span>
            {chip && (
                <span className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black whitespace-nowrap" style={{ background: chip.tone === 'bad' ? C.redBg : '#ecfdf5', color: TONE_TEXT[chip.tone] }}>
                    <span aria-hidden="true">{chip.tone === 'bad' ? '▼' : '✓'}</span>{chip.text}
                </span>
            )}
        </div>
        <div className="text-[34px] leading-none font-black mt-2" style={{ color: valueColor || C.ink }}>{value}</div>
        {sub && <div className="text-[11px] font-bold text-slate-500 mt-2 space-y-0.5">{sub}</div>}
    </div>
);

const Card: React.FC<{ title: string; subtitle?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, subtitle, right, children, className = '' }) => (
    <div className={`bg-white rounded-xl border border-slate-200 shadow-sm ${className}`}>
        <div className="px-4 pt-4 flex items-start justify-between gap-3">
            <div>
                <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide">{title}</h3>
                {subtitle && <div className="text-[11px] text-slate-500 font-medium mt-0.5">{subtitle}</div>}
            </div>
            {right}
        </div>
        <div className="p-4 pt-3">{children}</div>
    </div>
);

const Legend: React.FC<{ items: { color: string; label: string; kind: 'box' | 'line' | 'target' }[] }> = ({ items }) => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold text-slate-600">
        {items.map(i => (
            <span key={i.label} className="inline-flex items-center gap-1.5">
                {i.kind === 'box' && <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: i.color }} />}
                {i.kind === 'line' && <span className="inline-block w-4 h-[3px] rounded" style={{ background: i.color }} />}
                {i.kind === 'target' && <span className="inline-block w-[2px] h-3" style={{ background: i.color }} />}
                {i.label}
            </span>
        ))}
    </div>
);

const SortTh: React.FC<{ k: SortKey; sort: { key: SortKey; dir: 'asc' | 'desc' }; onSort: (k: SortKey) => void; className?: string; rowSpan?: number; children: React.ReactNode }> = ({ k, sort, onSort, className = '', rowSpan, children }) => {
    const active = sort.key === k;
    return (
        <th rowSpan={rowSpan} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`px-2 py-2 text-[10px] font-black uppercase tracking-wide text-slate-200 bg-indigo-950 border-l border-indigo-900/60 ${className}`}>
            <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 rounded">
                {children}<span aria-hidden="true" className={`text-[9px] ${active ? 'text-white' : 'text-indigo-400/60'}`}>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
            </button>
        </th>
    );
};

const MeliWeeklyDeliveryReport: React.FC = () => {
    const [report, setReport] = useState<MeliWeeklyReport | null>(null);
    const [weekStart, setWeekStart] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [groupBy, setGroupBy] = useState<GroupBy>('client');
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'onTimePct', dir: 'asc' });
    const [openSeller, setOpenSeller] = useState<string | null>(null);
    const [busy, setBusy] = useState<null | 'excel' | 'pdf'>(null);
    const [pdfProgress, setPdfProgress] = useState('');
    const [exportError, setExportError] = useState<string | null>(null);

    // Trae una ventana de WINDOW_WEEKS semanas que termina en `endWeek` (null = la semana actual). Mientras carga se conserva lo que ya se veía.
    const load = useCallback(async (endWeek: string | null, refresh = false) => {
        setIsLoading(true);
        setError(null);
        try {
            const qs = new URLSearchParams({ weeks: String(WINDOW_WEEKS) });
            if (endWeek) qs.set('weekStart', endWeek);
            if (refresh) qs.set('refresh', '1');
            const response = await fetch(`/api/reports/meli-weekly-delivery?${qs.toString()}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(body?.message || `Error del servidor (${response.status}).`);
            const data = body as MeliWeeklyReport;
            setReport(data);
            setWeekStart(data.meta.weekStart);
        } catch (e: any) {
            console.error('Error cargando el informe de cumplimiento Meli:', e);
            setError(e?.message || 'No se pudo cargar el informe: falló la conexión con el servidor.');
        } finally {
            setIsLoading(false);
        }
    }, []);
    useEffect(() => { load(null); }, [load]);

    const meta = report?.meta ?? null;
    const currentWeek = meta ? mondayOf(meta.today) : null;
    const windowWeeks = useMemo(() => (meta ? weeksEndingAt(meta.weekStart, meta.weeks) : []), [meta]);
    const sel = weekStart && windowWeeks.includes(weekStart) ? weekStart : meta?.weekStart ?? null;
    const isCurrentWeek = !!sel && sel === currentWeek;
    const prevWeek = sel ? addDays(sel, -7) : null;

    const goToWeek = (w: string) => {
        if (!currentWeek) return;
        const target = w > currentWeek ? currentWeek : mondayOf(w);
        if (windowWeeks.includes(target)) setWeekStart(target);
        else load(target);              // fuera de la ventana cargada: se trae otra que termina en esa semana
    };

    const rows = report?.rows;
    const sellers = useMemo<SellerStats[]>(() => (rows && sel ? sellersForWeek(rows, sel, groupBy) : []), [rows, sel, groupBy]);
    const totals = useMemo<Stats | null>(() => (rows && sel ? totalsForWeek(rows, sel) : null), [rows, sel]);
    const prevTotals = useMemo<Stats | null>(() => {
        if (!rows || !prevWeek || !windowWeeks.includes(prevWeek)) return null;
        const t = totalsForWeek(rows, prevWeek);
        return t.total > 0 ? t : null;
    }, [rows, prevWeek, windowWeeks]);
    const trend = useMemo(() => (rows ? weeklyTrend(rows, windowWeeks) : []), [rows, windowWeeks]);
    const excluded = useMemo(() => (report && sel ? excludedForWeek(report.excluded, sel) : { cancelledBeforeAssignment: 0, deliveredOutside: 0 }), [report, sel]);

    const sorted = useMemo(() => sortSellers(sellers, sort.key, sort.dir), [sellers, sort]);
    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        return q ? sorted.filter(s => s.name.toLowerCase().includes(q) || (s.identifier || '').toLowerCase().includes(q) || s.accounts.some(a => a.toLowerCase().includes(q))) : sorted;
    }, [sorted, search]);
    const withData = useMemo(() => sellers.filter(s => s.total > 0), [sellers]);
    const atRiskCount = withData.filter(s => s.atRisk).length;

    const onSort = (key: SortKey) => setSort(prev => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : (key === 'onTimePct' || key === 'deliveredPct') ? 'asc' : 'desc' }));

    // Esc cierra la ficha del seller.
    useEffect(() => {
        if (!openSeller) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenSeller(null); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [openSeller]);

    const exportInput = () => ({
        weekStart: sel as string, isCurrentWeek, groupBy, sellers: sorted, totals: totals as Stats, prevTotals, trend, rows: rows || [], excluded, generatedAt: new Date(),
    });
    const doExcel = async () => {
        if (!sel || !totals || busy) return;
        setBusy('excel'); setExportError(null);
        try { await downloadMeliWeeklyExcel(exportInput()); }
        catch (e: any) { console.error(e); setExportError(`No se pudo generar el Excel: ${e?.message || 'error desconocido'}`); }
        finally { setBusy(null); }
    };
    const doPdf = async () => {
        if (!sel || !totals || busy) return;
        setBusy('pdf'); setExportError(null); setPdfProgress('');
        try { await downloadMeliWeeklyPdf(exportInput(), (done, total) => setPdfProgress(`${done}/${total}`)); }
        catch (e: any) { console.error(e); setExportError(`No se pudo generar el PDF: ${e?.message || 'error desconocido'}`); }
        finally { setBusy(null); setPdfProgress(''); }
    };

    // ---------- datos de los gráficos ----------
    const barData = useMemo(() => withData.map(s => ({ key: s.key, name: s.name, title: s.title, detail: s.detail, pct: s.onTimePct ?? 0, below: s.onTimeBelow, onTime: s.onTime, total: s.total, deliveredPct: s.deliveredPct }))
        .sort((a, b) => a.pct - b.pct || b.total - a.total), [withData]);
    // Eje de la tendencia: no parte de cero (es una línea), pero siempre incluye la meta, con marcas limpias (cada 5 o 10 puntos).
    const trendScale = useMemo(() => {
        const vals = trend.flatMap(t => [t.onTimePct, t.deliveredPct]).filter((v): v is number => v != null);
        const rawLo = Math.max(0, Math.min(...vals, TARGET_PCT) - 2);
        const step = 100 - rawLo > 35 ? 10 : 5;
        const lo = Math.floor(rawLo / step) * step;
        const ticks: number[] = [];
        for (let v = lo; v <= 100; v += step) ticks.push(v);
        return { domain: [lo, 100] as [number, number], ticks };
    }, [trend]);
    const barByName = useMemo(() => new Map(barData.map(d => [d.name, d])), [barData]);
    const lastTrendIdx = useMemo(() => { for (let i = trend.length - 1; i >= 0; i--) if (trend[i].total > 0) return i; return -1; }, [trend]);

    const openStats = openSeller ? sellers.find(s => s.key === openSeller) || null : null;

    // ---------- estados vacíos / error ----------
    if (!report && isLoading) {
        return <div className="bg-white p-10 rounded-xl border border-slate-200 text-center text-sm font-bold text-slate-500 flex items-center justify-center gap-2"><IconLoader className="w-4 h-4 animate-spin" />Calculando el cumplimiento de entregas de Mercado Libre…</div>;
    }
    if (!report) {
        return (
            <div className="bg-red-50 border-l-4 border-red-500 p-6 rounded-2xl flex items-center gap-4">
                <div className="p-3 bg-red-100 text-red-600 rounded-full"><IconAlertTriangle className="w-8 h-8" /></div>
                <div className="flex-1">
                    <h3 className="text-lg font-black text-red-900">No se pudo cargar el informe</h3>
                    <p className="text-sm text-red-700 font-medium">{error || 'Sin respuesta del servidor.'}</p>
                </div>
                <button onClick={() => load(null)} className="px-4 py-2 bg-red-600 text-white rounded-lg text-xs font-black hover:bg-red-700">Reintentar</button>
            </div>
        );
    }

    const t = totals!;
    const dOn = prevTotals ? deltaPp(t.onTimePct, prevTotals.onTimePct) : null;
    const dAll = prevTotals ? deltaPp(t.deliveredPct, prevTotals.deliveredPct) : null;
    const notDeliveredSameDay = t.cancelled + t.rescheduled + t.reassigned + t.noClose;
    const canGoNext = !!sel && !!currentWeek && sel < currentWeek;
    const barHeight = Math.max(170, barData.length * 30 + 64);

    return (
        <div className={`space-y-4 transition-opacity ${isLoading ? 'opacity-60' : ''}`} aria-busy={isLoading}>
            {/* ---------- Barra de control: una sola fila sobre todo lo que filtra ---------- */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-indigo-50 text-indigo-700"><IconTarget className="w-5 h-5" /></div>
                    <div>
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Cumplimiento Mercado Libre · meta {TARGET_PCT}% · corte {CUTOFF_HOUR}:00</div>
                        <div className="text-lg font-black text-slate-900 leading-tight">Semana {sel ? weekLabel(sel) : ''}
                            {isCurrentWeek && <span className="ml-2 align-middle text-[10px] font-black uppercase tracking-wide bg-amber-100 text-amber-800 rounded-full px-2 py-0.5 whitespace-nowrap inline-block">En curso · parcial</span>}
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center rounded-lg border border-slate-200 overflow-hidden">
                        <button type="button" aria-label="Semana anterior" onClick={() => sel && goToWeek(addDays(sel, -7))} className="px-2.5 py-2 hover:bg-slate-50 text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><IconChevronLeft className="w-4 h-4" /></button>
                        <input type="date" aria-label="Ir a la semana de esta fecha" value={sel ?? ''} max={meta?.today} onChange={e => e.target.value && goToWeek(e.target.value)} className="px-2 py-1.5 text-xs font-bold text-slate-700 border-x border-slate-200 bg-white" />
                        <button type="button" aria-label="Semana siguiente" disabled={!canGoNext} onClick={() => sel && goToWeek(addDays(sel, 7))} className="px-2.5 py-2 hover:bg-slate-50 text-slate-700 disabled:opacity-30 disabled:hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><IconChevronRight className="w-4 h-4" /></button>
                    </div>
                    <button type="button" disabled={isCurrentWeek} onClick={() => currentWeek && goToWeek(currentWeek)} className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-black text-slate-700 hover:bg-slate-50 disabled:opacity-40">Semana actual</button>
                    <div role="group" aria-label="Agrupar por" className="inline-flex rounded-lg bg-slate-100 p-0.5">
                        {([['client', 'Por cliente'], ['account', 'Por cuenta ML']] as [GroupBy, string][]).map(([k, label]) => (
                            <button key={k} type="button" aria-pressed={groupBy === k} onClick={() => setGroupBy(k)} className={`px-3 py-1.5 rounded-md text-xs font-black transition-colors ${groupBy === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>
                        ))}
                    </div>
                    <button type="button" onClick={doExcel} disabled={!!busy} className="px-3 py-2 rounded-lg border border-slate-200 text-xs font-black text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 disabled:opacity-50">
                        {busy === 'excel' ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconFileSpreadsheet className="w-4 h-4 text-emerald-700" />}Excel
                    </button>
                    <button type="button" onClick={doPdf} disabled={!!busy} className="px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-black hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50">
                        {busy === 'pdf' ? <IconLoader className="w-4 h-4 animate-spin" /> : <IconDownload className="w-4 h-4" />}PDF{busy === 'pdf' && pdfProgress ? ` ${pdfProgress}` : ''}
                    </button>
                    <button type="button" aria-label="Actualizar" title="Actualizar" onClick={() => load(sel, true)} disabled={isLoading} className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50"><IconRefresh className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} /></button>
                </div>
            </div>

            {(error || exportError) && (
                <div role="alert" className="bg-red-50 border border-red-200 text-red-800 text-xs font-bold rounded-lg px-4 py-2">{error || exportError}</div>
            )}

            {/* ---------- Estado general ---------- */}
            {withData.length === 0 ? (
                <div className="bg-slate-50 border border-slate-200 rounded-xl px-5 py-4 text-sm font-bold text-slate-600">No hay paquetes de Mercado Libre gestionados en esta semana{isCurrentWeek ? ' (todavía)' : ''}.</div>
            ) : atRiskCount > 0 ? (
                <div className="bg-red-50 border-l-4 border-red-500 px-5 py-4 rounded-xl flex items-center gap-4">
                    <div className="p-2.5 bg-red-100 text-red-600 rounded-full shrink-0"><IconAlertTriangle className="w-6 h-6" /></div>
                    <p className="text-sm text-red-900 font-medium"><span className="font-black text-red-700">{atRiskCount} de {withData.length} sellers</span> están bajo la meta de {TARGET_PCT}% de Mercado Libre y tienen riesgo de multa{isCurrentWeek ? ' (la semana aún no termina)' : ''}. Aparecen en rojo, con ▼, en la tabla y en los gráficos.</p>
                </div>
            ) : (
                <div className="bg-emerald-50 border-l-4 border-emerald-500 px-5 py-4 rounded-xl flex items-center gap-4">
                    <div className="p-2.5 bg-emerald-100 text-emerald-700 rounded-full shrink-0"><IconCheckCircle className="w-6 h-6" /></div>
                    <p className="text-sm text-emerald-900 font-medium"><span className="font-black text-emerald-800">Todos los sellers</span> están sobre la meta de {TARGET_PCT}% de Mercado Libre en esta semana.</p>
                </div>
            )}

            {/* ---------- Indicadores ---------- */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Kpi label="Paquetes de la semana" value={fmtInt(t.total)}
                    sub={<><div>{withData.length} {groupBy === 'account' ? 'cuentas' : 'sellers'} con paquetes</div>{t.inRouteToday > 0 && <div className="text-amber-700">{fmtInt(t.inRouteToday)} en ruta hoy, aún sin contar</div>}</>} />
                <Kpi label={`Entregados antes de las ${CUTOFF_HOUR}:00`} value={fmtPct(t.onTimePct)} valueColor={t.onTimeBelow ? C.redText : undefined}
                    chip={t.total > 0 ? { text: t.onTimeBelow ? 'Bajo la meta' : 'En meta', tone: t.onTimeBelow ? 'bad' : 'good' } : undefined}
                    sub={<><div>{fmtInt(t.onTime)} de {fmtInt(t.total)} paquetes</div><div><DeltaText delta={dOn} /></div></>} />
                <Kpi label="Total entregados" value={fmtPct(t.deliveredPct)} valueColor={t.deliveredBelow ? C.redText : undefined}
                    chip={t.total > 0 ? { text: t.deliveredBelow ? 'Bajo la meta' : 'En meta', tone: t.deliveredBelow ? 'bad' : 'good' } : undefined}
                    sub={<><div>{fmtInt(t.delivered)} de {fmtInt(t.total)} · incluye {fmtInt(t.lateSameDay)} después de las {CUTOFF_HOUR}:00</div><div><DeltaText delta={dAll} /></div></>} />
                <Kpi label="No entregados el mismo día" value={fmtInt(notDeliveredSameDay)}
                    sub={<><div>{fmtInt(t.cancelled)} cancelados · {fmtInt(t.rescheduled)} reprogramados</div><div>{fmtInt(t.reassigned)} reasignados a otro día{t.noClose > 0 ? ` · ${fmtInt(t.noClose)} sin cierre` : ''}</div></>} />
            </div>

            {/* ---------- Gráficos ---------- */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <Card title={`Entregados antes de las ${CUTOFF_HOUR}:00 por ${groupBy === 'account' ? 'cuenta' : 'seller'}`} subtitle="De menor a mayor cumplimiento · cada barra es el porcentaje de la semana"
                    right={<Legend items={[{ color: C.red, label: 'Bajo la meta', kind: 'box' }, { color: C.blue, label: 'En meta', kind: 'box' }, { color: C.target, label: `Meta ${TARGET_PCT}%`, kind: 'target' }]} />}>
                    {barData.length === 0 ? <div className="text-xs text-slate-400 font-bold py-10 text-center">Sin datos en la semana</div> : (
                        <div style={{ height: barHeight }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={barData} layout="vertical" margin={{ top: 22, right: 4, bottom: 8, left: 4 }} barCategoryGap={6}>
                                    <CartesianGrid horizontal={false} stroke={C.grid} />
                                    <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 10, fill: C.muted }} axisLine={{ stroke: C.axis }} tickLine={false} />
                                    {/* El nombre va en dos líneas: el cliente y, debajo, la cuenta de Mercado Libre (al agrupar por cuenta), cada una recortada por separado para no perder la cuenta. */}
                                    <YAxis type="category" dataKey="name" width={204} interval={0} axisLine={{ stroke: C.axis }} tickLine={false}
                                        tick={(p: any) => {
                                            const d = barByName.get(p.payload?.value);
                                            if (!d) return <g />;
                                            const x = Number(p.x) - 6, y = Number(p.y);
                                            return (
                                                <g>
                                                    <title>{d.name}</title>
                                                    <text x={x} y={d.detail ? y - 6 : y} textAnchor="end" dominantBaseline="central" fontSize={11} fontWeight={700} fill={C.ink2}>{clip(d.title, 33)}</text>
                                                    {d.detail && <text x={x} y={y + 7} textAnchor="end" dominantBaseline="central" fontSize={9.5} fill={C.muted}>{clip(d.detail, 38)}</text>}
                                                </g>
                                            );
                                        }} />
                                    {/* Los valores van en una columna a la derecha del gráfico (no en la punta de cada barra) para que la línea de la meta nunca los cruce. */}
                                    <YAxis yAxisId="valores" orientation="right" type="category" dataKey="name" width={78} interval={0} axisLine={false} tickLine={false}
                                        tick={(p: any) => {
                                            const d = barByName.get(p.payload?.value);
                                            if (!d) return <g />;
                                            return <text x={Number(p.x) + 8} y={Number(p.y)} dominantBaseline="central" fontSize={11} fontWeight={800} fill={d.below ? C.redText : C.ink}>{d.below ? '▼ ' : '✓ '}{fmtPct(d.pct)}</text>;
                                        }} />
                                    <Tooltip cursor={{ fill: 'rgba(148,163,184,0.12)' }} content={({ active, payload }: any) => {
                                        if (!active || !payload?.length) return null;
                                        const d = payload[0].payload;
                                        return (
                                            <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs">
                                                <div className="font-black text-slate-900 mb-1">{d.name}</div>
                                                <div className="flex items-center gap-2"><span className="inline-block w-3 h-[3px] rounded" style={{ background: d.below ? C.red : C.blue }} />
                                                    <b className="text-base" style={{ color: d.below ? C.redText : C.ink }}>{d.below ? '▼ ' : '✓ '}{fmtPct(d.pct)}</b><span className="text-slate-500">antes de las {CUTOFF_HOUR}:00</span></div>
                                                <div className="text-slate-500 mt-0.5">{fmtInt(d.onTime)} de {fmtInt(d.total)} paquetes · total entregados {fmtPct(d.deliveredPct)}</div>
                                            </div>
                                        );
                                    }} />
                                    <ReferenceLine x={TARGET_PCT} stroke={C.target} strokeWidth={1.5} ifOverflow="visible" label={{ value: `Meta ${TARGET_PCT}%`, position: 'top', fill: C.target, fontSize: 10, fontWeight: 800 }} />
                                    <Bar dataKey="pct" barSize={16} isAnimationActive={false} cursor="pointer" onClick={(d: any) => d?.key && setOpenSeller(d.key)}
                                        shape={(p: any) => <Rectangle {...p} fill={p.payload.below ? C.red : C.blue} radius={[0, 4, 4, 0]} />} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    )}
                </Card>

                <Card title={`Tendencia semanal · ${trend.length} semanas`} subtitle="Toda la operación; cada punto es una semana de lunes a domingo"
                    right={<Legend items={[{ color: C.blue, label: `Antes de las ${CUTOFF_HOUR}:00`, kind: 'line' }, { color: C.orange, label: 'Total entregados', kind: 'line' }, { color: C.target, label: `Meta ${TARGET_PCT}%`, kind: 'target' }]} />}>
                    {lastTrendIdx < 0 ? <div className="text-xs text-slate-400 font-bold py-10 text-center">Sin datos para la tendencia</div> : (
                        <div style={{ height: 330 }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={trend} margin={{ top: 22, right: 56, bottom: 8, left: 0 }}>
                                    <CartesianGrid vertical={false} stroke={C.grid} />
                                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: C.ink2 }} axisLine={{ stroke: C.axis }} tickLine={false} />
                                    <YAxis domain={trendScale.domain} ticks={trendScale.ticks} interval={0} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 10, fill: C.muted }} axisLine={{ stroke: C.axis }} tickLine={false} width={44} />
                                    <Tooltip cursor={{ stroke: C.axis }} content={({ active, payload }: any) => {
                                        if (!active || !payload?.length) return null;
                                        const d = payload[0].payload;
                                        return (
                                            <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs">
                                                <div className="font-black text-slate-900 mb-1">Semana {weekLabel(d.weekStart)}</div>
                                                <div className="flex items-center gap-2"><span className="inline-block w-3 h-[3px] rounded" style={{ background: C.blue }} /><b>{fmtPct(d.onTimePct)}</b><span className="text-slate-500">antes de las {CUTOFF_HOUR}:00 · {fmtInt(d.onTime)}</span></div>
                                                <div className="flex items-center gap-2"><span className="inline-block w-3 h-[3px] rounded" style={{ background: C.orange }} /><b>{fmtPct(d.deliveredPct)}</b><span className="text-slate-500">total entregados · {fmtInt(d.delivered)}</span></div>
                                                <div className="text-slate-500 mt-0.5">{fmtInt(d.total)} paquetes de la semana</div>
                                            </div>
                                        );
                                    }} />
                                    <ReferenceLine y={TARGET_PCT} stroke={C.target} strokeWidth={1.5} label={{ value: `Meta ${TARGET_PCT}%`, position: 'insideBottomLeft', fill: C.target, fontSize: 10, fontWeight: 800 }} />
                                    <Line type="linear" dataKey="deliveredPct" stroke={C.orange} strokeWidth={2} isAnimationActive={false}
                                        dot={{ r: 4, fill: C.orange, stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }}
                                        label={(p: any) => (p.index === lastTrendIdx && p.value != null ? <text key="o" x={Number(p.x) + 9} y={Number(p.y) + 14} fontSize={11} fontWeight={800} fill={C.ink}>{fmtPct(p.value)}</text> : <g key={`o${p.index}`} />)} />
                                    <Line type="linear" dataKey="onTimePct" stroke={C.blue} strokeWidth={2} isAnimationActive={false}
                                        dot={{ r: 4, fill: C.blue, stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }}
                                        label={(p: any) => (p.index === lastTrendIdx && p.value != null ? <text key="b" x={Number(p.x) + 9} y={Number(p.y) - 6} fontSize={11} fontWeight={800} fill={C.ink}>{fmtPct(p.value)}</text> : <g key={`b${p.index}`} />)} />
                                </LineChart>
                            </ResponsiveContainer>
                        </div>
                    )}
                </Card>
            </div>

            {/* ---------- Tabla por seller ---------- */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100">
                    <div>
                        <h3 className="text-sm font-black text-slate-900 uppercase tracking-wide">Detalle por {groupBy === 'account' ? 'cuenta de Mercado Libre' : 'cliente (seller)'}</h3>
                        <p className="text-[11px] text-slate-500 font-medium mt-0.5">Peor cumplimiento primero. Haz clic en una fila para ver el desglose por día y las últimas semanas. <span className="font-black" style={{ color: C.redText }}>▼ rojo</span> = bajo la meta de {TARGET_PCT}%.</p>
                    </div>
                    <label className="relative">
                        <span className="sr-only">Buscar seller</span>
                        <IconSearch className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar seller o cuenta…" className="pl-8 pr-3 py-2 text-xs font-bold text-slate-700 border border-slate-200 rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </label>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm border-collapse">
                        <caption className="sr-only">Cumplimiento de entregas de Mercado Libre por {groupBy === 'account' ? 'cuenta' : 'seller'}, semana {sel ? weekLabel(sel) : ''}</caption>
                        <thead>
                            <tr>
                                <SortTh k="name" sort={sort} onSort={onSort} rowSpan={2} className="text-left sticky left-0 z-10 min-w-[220px]">{groupBy === 'account' ? 'Cliente · Cuenta ML' : 'Seller'}</SortTh>
                                <SortTh k="total" sort={sort} onSort={onSort} rowSpan={2} className="text-center">Paquetes</SortTh>
                                <th colSpan={2} className="px-2 py-1.5 text-[10px] font-black uppercase tracking-wide text-white bg-slate-700 border-l border-slate-600 text-center">Entregados antes de las {CUTOFF_HOUR}:00</th>
                                <SortTh k="lateSameDay" sort={sort} onSort={onSort} rowSpan={2} className="text-center">Después de las {CUTOFF_HOUR}:00</SortTh>
                                <th colSpan={2} className="px-2 py-1.5 text-[10px] font-black uppercase tracking-wide text-white bg-slate-700 border-l border-slate-600 text-center">Total entregados</th>
                                <th colSpan={4} className="px-2 py-1.5 text-[10px] font-black uppercase tracking-wide text-white bg-slate-700 border-l border-slate-600 text-center">No entregados el mismo día</th>
                                <th rowSpan={2} className="px-2 py-2 text-[10px] font-black uppercase tracking-wide text-slate-200 bg-indigo-950 border-l border-indigo-900/60 text-center">Estado</th>
                            </tr>
                            <tr>
                                <th className="px-2 py-1.5 text-[10px] font-black uppercase text-slate-200 bg-indigo-950 border-l border-indigo-900/60 text-center">Paq.</th>
                                <SortTh k="onTimePct" sort={sort} onSort={onSort} className="text-center">%</SortTh>
                                <th className="px-2 py-1.5 text-[10px] font-black uppercase text-slate-200 bg-indigo-950 border-l border-indigo-900/60 text-center">Paq.</th>
                                <SortTh k="deliveredPct" sort={sort} onSort={onSort} className="text-center">%</SortTh>
                                <SortTh k="cancelled" sort={sort} onSort={onSort} className="text-center">Cancel.</SortTh>
                                <SortTh k="rescheduled" sort={sort} onSort={onSort} className="text-center">Reprog.</SortTh>
                                <SortTh k="reassigned" sort={sort} onSort={onSort} className="text-center">Reasig. otro día</SortTh>
                                <SortTh k="noClose" sort={sort} onSort={onSort} className="text-center">Sin cierre</SortTh>
                            </tr>
                        </thead>
                        <tbody>
                            {visible.length === 0 && (
                                <tr><td colSpan={13} className="px-6 py-10 text-center text-xs font-bold text-slate-400 uppercase">{search ? 'Ningún seller coincide con la búsqueda' : 'Sin paquetes gestionados en la semana'}</td></tr>
                            )}
                            {visible.map(s => (
                                <tr key={s.key} tabIndex={0} onClick={() => setOpenSeller(s.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenSeller(s.key); } }}
                                    className="group border-t border-slate-100 hover:bg-slate-50 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500">
                                    <td className="px-3 py-2.5 sticky left-0 bg-white group-hover:bg-slate-50 z-[1] min-w-[220px]">
                                        <div className="font-black text-slate-900 leading-tight">{s.title}</div>
                                        <div className="text-[10px] font-bold text-slate-400">{s.detail ? `${s.detail} · ` : ''}{s.identifier || '—'}{groupBy === 'client' && s.accounts.length > 1 ? ` · ${s.accounts.length} cuentas ML` : ''}{s.lowVolume ? ' · pocos paquetes' : ''}</div>
                                    </td>
                                    <td className="px-2 py-2.5 text-center font-bold text-slate-800 tabular-nums">{fmtInt(s.total)}</td>
                                    <td className="px-2 py-2.5 text-center text-slate-700 tabular-nums">{fmtInt(s.onTime)}</td>
                                    <td className="px-2 py-2.5 text-center text-[13px]"><PctBadge pct={s.onTimePct} below={s.onTimeBelow} lowVolume={s.lowVolume} /></td>
                                    <td className="px-2 py-2.5 text-center text-slate-700 tabular-nums">{fmtInt(s.lateSameDay)}</td>
                                    <td className="px-2 py-2.5 text-center text-slate-700 tabular-nums">{fmtInt(s.delivered)}</td>
                                    <td className="px-2 py-2.5 text-center text-[13px]"><PctBadge pct={s.deliveredPct} below={s.deliveredBelow} lowVolume={s.lowVolume} /></td>
                                    <td className={`px-2 py-2.5 text-center tabular-nums ${s.cancelled ? 'text-slate-800 font-bold' : 'text-slate-300'}`}>{fmtInt(s.cancelled)}</td>
                                    <td className={`px-2 py-2.5 text-center tabular-nums ${s.rescheduled ? 'text-slate-800 font-bold' : 'text-slate-300'}`}>{fmtInt(s.rescheduled)}</td>
                                    <td className={`px-2 py-2.5 text-center tabular-nums ${s.reassigned ? 'text-slate-800 font-bold' : 'text-slate-300'}`}>{fmtInt(s.reassigned)}</td>
                                    <td className={`px-2 py-2.5 text-center tabular-nums ${s.noClose ? 'text-amber-700 font-black' : 'text-slate-300'}`}>{fmtInt(s.noClose)}</td>
                                    <td className="px-2 py-2.5 text-center">
                                        {s.total === 0 ? <span className="text-[10px] font-bold text-slate-400">Sin paquetes</span>
                                            : s.atRisk ? <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black whitespace-nowrap" style={{ background: C.redBg, color: C.redText }}><span aria-hidden="true">▼</span>En riesgo</span>
                                                : <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black whitespace-nowrap bg-emerald-50" style={{ color: C.greenText }}><span aria-hidden="true">✓</span>En meta</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                        <tfoot>
                            <tr className="border-t-2 border-slate-300 bg-slate-100 font-black text-slate-900">
                                <td className="px-3 py-2.5 sticky left-0 bg-slate-100 z-[1]">TOTAL {search ? '(toda la operación)' : ''}</td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.total)}</td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.onTime)}</td>
                                <td className="px-2 py-2.5 text-center text-[13px]"><PctBadge pct={t.onTimePct} below={t.onTimeBelow} /></td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.lateSameDay)}</td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.delivered)}</td>
                                <td className="px-2 py-2.5 text-center text-[13px]"><PctBadge pct={t.deliveredPct} below={t.deliveredBelow} /></td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.cancelled)}</td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.rescheduled)}</td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.reassigned)}</td>
                                <td className="px-2 py-2.5 text-center tabular-nums">{fmtInt(t.noClose)}</td>
                                <td className="px-2 py-2.5" />
                            </tr>
                        </tfoot>
                    </table>
                </div>
                <div className="px-4 py-3 border-t border-slate-100 text-[11px] text-slate-500 font-medium flex flex-wrap gap-x-6 gap-y-1">
                    <span>No incluye {fmtInt(excluded.cancelledBeforeAssignment + excluded.deliveredOutside)} envíos que ningún conductor gestionó: {fmtInt(excluded.cancelledBeforeAssignment)} cancelados antes de asignarse y {fmtInt(excluded.deliveredOutside)} entregados por otros medios.</span>
                    {t.inRouteToday > 0 && <span>{fmtInt(t.inRouteToday)} paquetes de hoy siguen en ruta y no cuentan hasta que termine el día.</span>}
                    <span>Actualizado {new Date(report.meta.generatedAt).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
            </div>

            {/* ---------- Cómo se calcula ---------- */}
            <details className="bg-white rounded-xl border border-slate-200 shadow-sm group">
                <summary className="px-4 py-3 cursor-pointer list-none flex items-center justify-between text-sm font-black text-slate-900 uppercase tracking-wide">
                    <span className="inline-flex items-center gap-2"><IconInfo className="w-4 h-4 text-indigo-600" />Cómo se calcula este informe</span>
                    <IconChevronDown className="w-4 h-4 text-slate-400 group-open:rotate-180 transition-transform" />
                </summary>
                <ol className="px-6 pb-4 pt-1 space-y-2 list-decimal text-[12.5px] leading-relaxed text-slate-700">
                    {METHOD_NOTES.map((n, i) => <li key={i}>{n}</li>)}
                </ol>
            </details>

            {/* ---------- Ficha del seller ---------- */}
            {openStats && sel && (
                <SellerPanel stats={openStats} weekStart={sel} groupBy={groupBy} report={report} windowWeeks={windowWeeks} onClose={() => setOpenSeller(null)} />
            )}
        </div>
    );
};

// ---------------------------------------------------------------------------------------------------------------------------------
const SellerPanel: React.FC<{ stats: SellerStats; weekStart: string; groupBy: GroupBy; report: MeliWeeklyReport; windowWeeks: string[]; onClose: () => void }> = ({ stats, weekStart, groupBy, report, windowWeeks, onClose }) => {
    const days = useMemo(() => dailyForWeek(report.rows, weekStart, stats.key, groupBy), [report.rows, weekStart, stats.key, groupBy]);
    const history = useMemo(() => windowWeeks.map(w => ({ w, s: sellersForWeek(report.rows, w, groupBy).find(x => x.key === stats.key) || null })), [report.rows, windowWeeks, stats.key, groupBy]);
    return (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Detalle de ${stats.name}`}>
            <button type="button" aria-label="Cerrar detalle" onClick={onClose} className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] cursor-default" />
            <div className="relative w-full max-w-2xl bg-white h-full shadow-2xl flex flex-col">
                <div className="p-5 border-b border-slate-100 bg-slate-50 flex items-start justify-between gap-3">
                    <div>
                        <div className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Semana {weekLabel(weekStart)}</div>
                        <h3 className="text-xl font-black text-slate-900 leading-tight">{stats.title}</h3>
                        <div className="text-[11px] font-bold text-slate-500 mt-0.5">{stats.identifier || '—'} · {stats.accounts.join(', ')}</div>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Cerrar" className="p-2 rounded-full hover:bg-slate-200 text-slate-500"><IconX className="w-5 h-5" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-5 space-y-6">
                    <div className="grid grid-cols-3 gap-3">
                        <div className="p-3 rounded-xl border border-slate-200"><div className="text-[10px] font-black text-slate-500 uppercase">Paquetes</div><div className="text-2xl font-black text-slate-900">{fmtInt(stats.total)}</div>{stats.inRouteToday > 0 && <div className="text-[10px] font-bold text-amber-700">+{stats.inRouteToday} en ruta hoy</div>}</div>
                        <div className="p-3 rounded-xl border" style={{ borderColor: stats.onTimeBelow ? '#fecaca' : '#e2e8f0', background: stats.onTimeBelow ? C.redBg : '#fff' }}><div className="text-[10px] font-black text-slate-500 uppercase">Antes de las {CUTOFF_HOUR}:00</div><div className="text-2xl font-black" style={{ color: stats.onTimeBelow ? C.redText : C.ink }}>{fmtPct(stats.onTimePct)}</div><div className="text-[10px] font-bold text-slate-500">{fmtInt(stats.onTime)} de {fmtInt(stats.total)}</div></div>
                        <div className="p-3 rounded-xl border" style={{ borderColor: stats.deliveredBelow ? '#fecaca' : '#e2e8f0', background: stats.deliveredBelow ? C.redBg : '#fff' }}><div className="text-[10px] font-black text-slate-500 uppercase">Total entregados</div><div className="text-2xl font-black" style={{ color: stats.deliveredBelow ? C.redText : C.ink }}>{fmtPct(stats.deliveredPct)}</div><div className="text-[10px] font-bold text-slate-500">{fmtInt(stats.delivered)} de {fmtInt(stats.total)}</div></div>
                    </div>

                    <div>
                        <h4 className="text-xs font-black text-slate-900 uppercase tracking-wide mb-2">Por día de la semana</h4>
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                            <table className="min-w-full text-xs">
                                <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-500"><tr>
                                    <th className="px-2 py-2 text-left">Día</th><th className="px-2 py-2">Paq.</th><th className="px-2 py-2">Antes {CUTOFF_HOUR}:00</th><th className="px-2 py-2">%</th><th className="px-2 py-2">Después</th><th className="px-2 py-2">Entregados</th><th className="px-2 py-2">%</th><th className="px-2 py-2">Cancel.</th><th className="px-2 py-2">Reprog.</th><th className="px-2 py-2">Reasig.</th>
                                </tr></thead>
                                <tbody>
                                    {days.map(d => (
                                        <tr key={d.day} className="border-t border-slate-100 text-center tabular-nums">
                                            <td className="px-2 py-1.5 text-left font-bold text-slate-700 capitalize whitespace-nowrap">{d.label}</td>
                                            <td className="px-2 py-1.5">{d.total ? fmtInt(d.total) : <span className="text-slate-300">—</span>}</td>
                                            <td className="px-2 py-1.5">{d.total ? fmtInt(d.onTime) : ''}</td>
                                            <td className="px-2 py-1.5">{d.total ? <PctBadge pct={d.onTimePct} below={d.onTimeBelow} /> : ''}</td>
                                            <td className="px-2 py-1.5">{d.total ? fmtInt(d.lateSameDay) : ''}</td>
                                            <td className="px-2 py-1.5">{d.total ? fmtInt(d.delivered) : ''}</td>
                                            <td className="px-2 py-1.5">{d.total ? <PctBadge pct={d.deliveredPct} below={d.deliveredBelow} /> : ''}</td>
                                            <td className="px-2 py-1.5">{d.total ? fmtInt(d.cancelled) : ''}</td>
                                            <td className="px-2 py-1.5">{d.total ? fmtInt(d.rescheduled) : ''}</td>
                                            <td className="px-2 py-1.5">{d.total ? fmtInt(d.reassigned) : ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div>
                        <h4 className="text-xs font-black text-slate-900 uppercase tracking-wide mb-2">Últimas {history.length} semanas</h4>
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                            <table className="min-w-full text-xs">
                                <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-500"><tr>
                                    <th className="px-2 py-2 text-left">Semana</th><th className="px-2 py-2">Paquetes</th><th className="px-2 py-2">Antes {CUTOFF_HOUR}:00</th><th className="px-2 py-2">Total entregados</th>
                                </tr></thead>
                                <tbody>
                                    {history.map(({ w, s }) => (
                                        <tr key={w} className={`border-t border-slate-100 text-center tabular-nums ${w === weekStart ? 'bg-indigo-50/60' : ''}`}>
                                            <td className="px-2 py-1.5 text-left font-bold text-slate-700">{shortDate(w)} – {shortDate(addDays(w, 6))}</td>
                                            <td className="px-2 py-1.5">{s && s.total ? fmtInt(s.total) : <span className="text-slate-300">—</span>}</td>
                                            <td className="px-2 py-1.5">{s && s.total ? <PctBadge pct={s.onTimePct} below={s.onTimeBelow} /> : ''}</td>
                                            <td className="px-2 py-1.5">{s && s.total ? <PctBadge pct={s.deliveredPct} below={s.deliveredBelow} /> : ''}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <p className="text-[11px] text-slate-500 font-medium">Cancelados {fmtInt(stats.cancelled)} · reprogramados {fmtInt(stats.rescheduled)} · reasignados a otro día {fmtInt(stats.reassigned)} ({fmtInt(stats.reassignedDelivered)} ya entregados, {fmtInt(stats.reassignedOpen)} abiertos){stats.noClose ? ` · sin cierre ${fmtInt(stats.noClose)}` : ''}.</p>
                </div>
            </div>
        </div>
    );
};

export default MeliWeeklyDeliveryReport;
