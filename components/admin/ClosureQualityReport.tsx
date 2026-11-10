import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../services/api';
import { AuthContext } from '../../contexts/AuthContext';
import { getLogicalDateString } from '../../utils/dateUtils';
import { IconAlertTriangle, IconCamera, IconCheckCircle, IconChevronDown, IconChevronUp, IconCopy, IconFileSpreadsheet, IconInfo, IconLoader, IconPrinter, IconRefresh, IconSearch, IconX } from '../Icon';
import {
    KIND_HELP, KIND_LABEL, NAME_PROBLEM_LABEL, addDaysIso, closureReviewCsv, daysInRange, hasFindings, pctText, sortDrivers,
} from '../../utils/closureReviewTypes';
import type { ClosureCase, ClosureCaseKind, ClosureDriverCases, ClosureDriverRow, ClosureReviewReport, DriverSortKey } from '../../utils/closureReviewTypes';

// Informe «Calidad de cierres» (operadores y administradores): qué conductores cierran las entregas con un nombre de quien recibe sin sentido o con fotos repetidas.
// Los números los arma el servidor (services/closureReview.js) con las huellas de las fotos que procesa en segundo plano; aquí solo se muestran, se ordenan y se exportan.
//
// Colores: la app tiene sus propios temas (data-theme: claro, oscuro, midnight…) y NO sigue el modo oscuro del sistema, pero las variantes «dark:» de Tailwind sí lo siguen
// (no hay darkMode configurado). Por eso aquí no se usa ninguna «dark:»: el texto neutro sale de las variables del tema y todo lo que lleva color propio (avisos, etiquetas,
// cifras destacadas) trae su fondo Y su texto, así se lee igual en cualquier tema.

const MAX_DAYS = 31;
const PRESETS = [{ id: '7', days: 7, label: 'Últimos 7 días' }, { id: '14', days: 14, label: 'Últimos 14 días' }, { id: '30', days: 30, label: 'Últimos 30 días' }] as const;

// etiquetas y cifras con color propio: fondo claro + texto oscuro, legibles sobre cualquier tema
const TONE = {
    red: 'bg-red-100 text-red-900 border-red-300',
    orange: 'bg-orange-100 text-orange-900 border-orange-300',
    amber: 'bg-amber-100 text-amber-900 border-amber-300',
    purple: 'bg-purple-100 text-purple-900 border-purple-300',
    slate: 'bg-slate-100 text-slate-800 border-slate-300',
} as const;

const KIND_TONE: Record<ClosureCaseKind, string> = {
    NAME: TONE.amber, SAME_FILE: TONE.red, SAME_IMAGE: TONE.red, SIMILAR: TONE.orange, REUSED: TONE.purple,
};

const fmtInt = (n: number) => n.toLocaleString('es-CL');

const downloadText = (filename: string, text: string) => {
    const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};

const KPI_BAR = { neutral: 'border-t-[var(--border-secondary)]', bad: 'border-t-red-500', warn: 'border-t-amber-500' } as const;
const Kpi: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: keyof typeof KPI_BAR }> = ({ label, value, sub, tone = 'neutral' }) => (
    <div className={`rounded-xl border border-t-4 border-[var(--border-primary)] ${KPI_BAR[tone]} bg-[var(--background-secondary)] p-4 shadow-sm`}>
        <p className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] leading-tight">{label}</p>
        <p className="mt-2 text-3xl font-black leading-none tabular-nums text-[var(--text-primary)]">{value}</p>
        {sub && <p className="mt-2 text-[11px] font-medium text-[var(--text-muted)] leading-snug">{sub}</p>}
    </div>
);

const Chip: React.FC<{ tone: string; title?: string; children: React.ReactNode }> = ({ tone, title, children }) => (
    <span title={title} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${tone}`}>{children}</span>
);

/** Una cifra que superó su umbral: va en una etiqueta con color propio para que destaque en cualquier tema. */
const Flagged: React.FC<{ on: boolean; tone: string; children: React.ReactNode }> = ({ on, tone, children }) =>
    on ? <span className={`inline-block min-w-[1.75rem] rounded-md border px-1.5 py-0.5 text-center font-black ${tone}`}>{children}</span> : <span>{children}</span>;

/** Aviso con color propio (fondo y texto juntos). */
const Notice: React.FC<{ tone: 'red' | 'amber'; role?: 'alert' | 'status'; className?: string; children: React.ReactNode }> = ({ tone, role, className = '', children }) => (
    <div role={role} className={`rounded-xl border p-3 text-sm ${tone === 'red' ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-300 bg-amber-50 text-amber-900'} ${className}`}>{children}</div>
);

const SortTh: React.FC<{ k: DriverSortKey; sort: { key: DriverSortKey; dir: 'asc' | 'desc' }; onSort: (k: DriverSortKey) => void; align?: 'left' | 'right'; title?: string; children: React.ReactNode }> = ({ k, sort, onSort, align = 'right', title, children }) => {
    const active = sort.key === k;
    return (
        <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} title={title}
            className={`px-3 py-2 text-[10px] font-black uppercase tracking-wide text-[var(--text-muted)] ${align === 'right' ? 'text-right' : 'text-left'}`}>
            <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 rounded hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
                {children}<span aria-hidden="true" className={`text-[9px] ${active ? 'text-[var(--text-primary)]' : 'opacity-40'}`}>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
            </button>
        </th>
    );
};

/** Fotos de un paquete, cargadas al abrirlas (cada una pesa decenas o cientos de KB). */
const PackagePhotos: React.FC<{ packageId: string; caption: string; onZoom: (src: string) => void }> = ({ packageId, caption, onZoom }) => {
    const [photos, setPhotos] = useState<string[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        setPhotos(null); setError(null);
        api.getPackage(packageId)
            .then((pkg: any) => { if (alive) setPhotos(((pkg && (pkg.photos || pkg.deliveryPhotosBase64)) || []).filter((p: unknown) => typeof p === 'string')); })
            .catch((e: any) => { if (alive) setError(e?.message || 'No se pudieron cargar las fotos.'); });
        return () => { alive = false; };
    }, [packageId]);
    return (
        <div className="min-w-0">
            <p className="mb-1 text-[11px] font-bold text-[var(--text-secondary)]">{caption}</p>
            {error ? <Notice tone="red" role="alert" className="!p-2 text-xs">{error}</Notice>
                : photos === null ? <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]"><IconLoader className="h-4 w-4 animate-spin" /> Cargando fotos…</p>
                : photos.length === 0 ? <p className="text-xs text-[var(--text-muted)]">Este cierre no tiene fotos guardadas.</p>
                : (
                    <div className="flex flex-wrap gap-2">
                        {photos.map((src, i) => (
                            <button key={i} type="button" onClick={() => onZoom(src)} title="Ampliar foto" className="group relative overflow-hidden rounded-lg border border-[var(--border-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
                                <img src={src} alt={`Foto ${i + 1} de ${packageId}`} className="h-36 w-auto max-w-[260px] object-cover" loading="lazy" />
                                <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[10px] font-bold text-white">{i + 1}</span>
                            </button>
                        ))}
                    </div>
                )}
        </div>
    );
};

const CaseRow: React.FC<{ c: ClosureCase; tz: string; thresholds: ClosureDriverCases['thresholds']; onZoom: (src: string) => void }> = ({ c, tz, thresholds, onZoom }) => {
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const when = useMemo(() => new Intl.DateTimeFormat('es-CL', { timeZone: tz, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(c.closedAt)), [c.closedAt, tz]);
    const copy = () => { try { navigator.clipboard?.writeText(c.packageId); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* sin portapapeles */ } };
    const hasPhotoFinding = c.kinds.some(k => k !== 'NAME');
    const badName = c.kinds.includes('NAME');
    const receiver = c.receiverName.trim() ? `«${c.receiverName.trim()}»` : '(sin nombre)';
    return (
        <li className="rounded-lg border border-[var(--border-primary)] bg-[var(--background-primary)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-bold text-[var(--text-primary)]">{c.packageId}</span>
                        <button type="button" onClick={copy} title="Copiar el código del paquete" className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
                            {copied ? <IconCheckCircle className="h-3.5 w-3.5 text-green-600" /> : <IconCopy className="h-3.5 w-3.5" />}
                            <span className="sr-only">{copied ? 'Copiado' : 'Copiar código'}</span>
                        </button>
                        <span className="text-xs text-[var(--text-muted)] tabular-nums">{when}</span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                        Recibió: {badName ? <span className={`rounded border px-1.5 py-0.5 font-bold ${TONE.amber}`}>{receiver}</span> : <strong>{receiver}</strong>}
                        {(c.address || c.commune) && <span className="text-[var(--text-muted)]"> · {[c.address, c.commune].filter(Boolean).join(', ')}</span>}
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    {c.kinds.map(k => (
                        <Chip key={k} tone={KIND_TONE[k]} title={KIND_HELP[k]}>
                            {KIND_LABEL[k]}{(k === 'SAME_IMAGE' || k === 'SIMILAR') && c.minBits !== null ? ` · ${c.minBits} de 63 bits` : ''}
                        </Chip>
                    ))}
                    {hasPhotoFinding && (
                        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                            className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-secondary)] bg-[var(--background-secondary)] px-2.5 py-1 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--background-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
                            <IconCamera className="h-3.5 w-3.5" /> {open ? 'Ocultar fotos' : 'Ver fotos'} {open ? <IconChevronUp className="h-3 w-3" /> : <IconChevronDown className="h-3 w-3" />}
                        </button>
                    )}
                </div>
            </div>
            {open && (
                <div className="mt-3 space-y-3 border-t border-[var(--border-primary)] pt-3">
                    <PackagePhotos packageId={c.packageId} caption={`Este cierre (${c.photoCount} ${c.photoCount === 1 ? 'foto' : 'fotos'})`} onZoom={onZoom} />
                    {c.kinds.includes('SIMILAR') && <p className="text-[11px] text-[var(--text-muted)]">«Muy parecidas» es evidencia débil (hasta {thresholds.similarBits} de 63 bits de diferencia): compara las fotos a simple vista antes de sacar conclusiones.</p>}
                    {c.reusedWith.length > 0 && (
                        <div className="space-y-3">
                            <p className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-bold ${TONE.purple}`}>El mismo archivo de foto también está en {c.reusedWith.length === 1 ? 'este otro cierre' : 'estos otros cierres'} del conductor, en otra dirección:</p>
                            {c.reusedWith.map(o => (
                                <PackagePhotos key={o.packageId} packageId={o.packageId} caption={`${o.packageId} · ${[o.address, o.commune].filter(Boolean).join(', ') || 'sin dirección'}`} onZoom={onZoom} />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </li>
    );
};

const FILTER_KINDS: { id: 'ALL' | ClosureCaseKind; label: string }[] = [
    { id: 'ALL', label: 'Todos' }, { id: 'NAME', label: 'Nombre' }, { id: 'SAME_FILE', label: 'Mismo archivo' }, { id: 'SAME_IMAGE', label: 'Misma imagen' }, { id: 'SIMILAR', label: 'Muy parecidas' }, { id: 'REUSED', label: 'Reutilizada' },
];

const DriverDetail: React.FC<{ driver: ClosureDriverRow; startDate: string; endDate: string; tz: string; onClose: () => void }> = ({ driver, startDate, endDate, tz, onClose }) => {
    const [data, setData] = useState<ClosureDriverCases | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [kind, setKind] = useState<'ALL' | ClosureCaseKind>('ALL');
    const [zoom, setZoom] = useState<string | null>(null);
    const closeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        let alive = true;
        setData(null); setError(null);
        api.getClosureQualityCases(startDate, endDate, driver.driverId)
            .then(r => { if (alive) setData(r); })
            .catch((e: any) => { if (alive) setError(e?.message || 'No se pudieron cargar los cierres del conductor.'); });
        return () => { alive = false; };
    }, [driver.driverId, startDate, endDate]);

    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (zoom) setZoom(null); else onClose(); } };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose, zoom]);

    const counts = useMemo(() => {
        const c: Record<string, number> = { ALL: data?.cases.length ?? 0 };
        for (const k of data?.cases ?? []) for (const x of k.kinds) c[x] = (c[x] || 0) + 1;
        return c;
    }, [data]);
    const shown = useMemo(() => (data?.cases ?? []).filter(c => kind === 'ALL' || c.kinds.includes(kind)), [data, kind]);

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-3 sm:p-6 print:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div role="dialog" aria-modal="true" aria-label={`Cierres con hallazgos de ${driver.name}`} className="my-auto w-full max-w-4xl rounded-2xl border border-[var(--border-primary)] bg-[var(--background-secondary)] shadow-2xl">
                <div className="flex items-start justify-between gap-3 border-b border-[var(--border-primary)] p-4 sm:p-5">
                    <div className="min-w-0">
                        <h3 className="truncate text-lg font-black text-[var(--text-primary)]">{driver.name}</h3>
                        <p className="mt-0.5 text-xs text-[var(--text-muted)]">{startDate} a {endDate} · {fmtInt(driver.closures)} cierres · {driver.nameBad} con nombre sin sentido ({pctText(driver.nameBad, driver.closures)}) · {driver.sameImage} con la misma imagen · {driver.similar} muy parecidas · {driver.reused} con foto reutilizada</p>
                        {driver.pending > 0 && <Notice tone="amber" className="mt-2 !p-2 text-[11px] font-medium">Faltan por procesar las fotos de {driver.pending} {driver.pending === 1 ? 'cierre' : 'cierres'} de este conductor: los números de fotos pueden subir.</Notice>}
                    </div>
                    <button ref={closeRef} type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--background-hover)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
                        <IconX className="h-5 w-5" /><span className="sr-only">Cerrar</span>
                    </button>
                </div>
                <div className="space-y-3 p-4 sm:p-5">
                    {error ? <Notice tone="red" role="alert">{error}</Notice>
                        : !data ? <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]"><IconLoader className="h-4 w-4 animate-spin" /> Cargando cierres…</p>
                        : (
                            <>
                                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por tipo de hallazgo">
                                    {FILTER_KINDS.filter(f => f.id === 'ALL' || counts[f.id]).map(f => (
                                        <button key={f.id} type="button" aria-pressed={kind === f.id} onClick={() => setKind(f.id)}
                                            className={`rounded-full border px-3 py-1 text-xs font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] ${kind === f.id ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white' : 'border-[var(--border-secondary)] bg-[var(--background-primary)] text-[var(--text-secondary)] hover:bg-[var(--background-hover)]'}`}>
                                            {f.label} <span className="tabular-nums opacity-80">({counts[f.id] || 0})</span>
                                        </button>
                                    ))}
                                </div>
                                {data.cases.length === 0 ? <p className="text-sm text-[var(--text-muted)]">Este conductor no tiene hallazgos en el período.</p> : (
                                    <ul className="space-y-2">
                                        {shown.map(c => <CaseRow key={c.packageId} c={c} tz={tz} thresholds={data.thresholds} onZoom={setZoom} />)}
                                    </ul>
                                )}
                                {data.truncated && <p className="text-xs text-[var(--text-muted)]">Se muestran los {data.cases.length} más recientes de {fmtInt(data.totalCases)} cierres con hallazgos.</p>}
                            </>
                        )}
                </div>
            </div>
            {zoom && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4" onClick={() => setZoom(null)} role="presentation">
                    <img src={zoom} alt="Foto ampliada" className="max-h-[92vh] max-w-[96vw] rounded-lg object-contain" />
                    <button type="button" onClick={() => setZoom(null)} className="absolute right-4 top-4 rounded-full bg-white/90 p-2 text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"><IconX className="h-5 w-5" /><span className="sr-only">Cerrar foto</span></button>
                </div>
            )}
        </div>
    );
};

const ClosureQualityReport: React.FC = () => {
    const auth = useContext(AuthContext);
    const tz = auth?.systemSettings?.timezone || 'America/Santiago';
    const today = useMemo(() => getLogicalDateString(new Date(), tz), [tz]);

    const [preset, setPreset] = useState<string>('14');
    const [startDate, setStartDate] = useState(() => addDaysIso(today, -13));
    const [endDate, setEndDate] = useState(today);
    const [report, setReport] = useState<ClosureReviewReport | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');
    const [onlyFindings, setOnlyFindings] = useState(true);
    const [sort, setSort] = useState<{ key: DriverSortKey; dir: 'asc' | 'desc' }>({ key: 'score', dir: 'desc' });
    const [openDriverId, setOpenDriverId] = useState<string | null>(null);

    const rangeError = useMemo(() => {
        const n = daysInRange(startDate, endDate);
        if (!(n >= 1)) return 'La fecha de inicio debe ser anterior o igual a la de término.';
        if (n > MAX_DAYS) return `El período máximo es de ${MAX_DAYS} días.`;
        return null;
    }, [startDate, endDate]);

    const load = useCallback(async (refresh = false) => {
        if (rangeError) return;
        setIsLoading(true);
        setError(null);
        try {
            setReport(await api.getClosureQuality(startDate, endDate, refresh));
        } catch (e: any) {
            console.error('Error cargando el informe de calidad de cierres:', e);
            setError(e?.message || 'No se pudo cargar el informe: falló la conexión con el servidor.');
        } finally {
            setIsLoading(false);
        }
    }, [startDate, endDate, rangeError]);
    useEffect(() => { load(false); }, [load]);

    const choosePreset = (id: string, days: number) => { setPreset(id); setStartDate(addDaysIso(today, -(days - 1))); setEndDate(today); };
    const onSort = (key: DriverSortKey) => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

    const rows = useMemo(() => {
        if (!report) return [];
        const q = search.trim().toLowerCase();
        return sortDrivers(report.drivers, sort.key, sort.dir)
            .filter(d => (!onlyFindings || hasFindings(d)) && (!q || d.name.toLowerCase().includes(q)));
    }, [report, search, onlyFindings, sort]);

    const openDriver = useMemo(() => report?.drivers.find(d => d.driverId === openDriverId) || null, [report, openDriverId]);
    const coverage = report?.coverage;
    const coveragePct = coverage && coverage.withPhotos > 0 ? Math.min(100, Math.floor((100 * coverage.scanned) / coverage.withPhotos)) : 100;

    return (
        <div className="space-y-5">
            <header className="print:block">
                <h2 className="text-xl font-black text-[var(--text-primary)]">Calidad de cierres</h2>
                <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">Conductores que cierran entregas con un nombre de quien recibe sin sentido («.», una letra…) o con fotos de evidencia repetidas. Solo cuenta lo que cierra el conductor en la app (no los cierres automáticos de Mercado Libre).</p>
                {report && <p className="mt-1 hidden text-xs text-[var(--text-muted)] print:block">Período {report.startDate} a {report.endDate} · generado {new Intl.DateTimeFormat('es-CL', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(report.generatedAt))}</p>}
            </header>

            <section aria-label="Período y filtros" className="print:hidden rounded-xl border border-[var(--border-primary)] bg-[var(--background-secondary)] p-3 sm:p-4">
                <div className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Períodos rápidos">
                        {PRESETS.map(p => (
                            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => choosePreset(p.id, p.days)}
                                className={`rounded-lg border px-3 py-1.5 text-xs font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] ${preset === p.id ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white' : 'border-[var(--border-secondary)] bg-[var(--background-primary)] text-[var(--text-secondary)] hover:bg-[var(--background-hover)]'}`}>
                                {p.label}
                            </button>
                        ))}
                    </div>
                    <label className="text-xs font-bold text-[var(--text-secondary)]">Desde
                        <input type="date" value={startDate} max={endDate} onChange={e => { setPreset('custom'); setStartDate(e.target.value); }} className="mt-1 block rounded-lg border border-[var(--border-secondary)] bg-[var(--background-primary)] px-2 py-1.5 text-sm text-[var(--text-primary)]" />
                    </label>
                    <label className="text-xs font-bold text-[var(--text-secondary)]">Hasta
                        <input type="date" value={endDate} min={startDate} onChange={e => { setPreset('custom'); setEndDate(e.target.value); }} className="mt-1 block rounded-lg border border-[var(--border-secondary)] bg-[var(--background-primary)] px-2 py-1.5 text-sm text-[var(--text-primary)]" />
                    </label>
                    <label className="min-w-[180px] flex-1 text-xs font-bold text-[var(--text-secondary)]">Buscar conductor
                        <span className="relative mt-1 block">
                            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Nombre…" className="w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--background-primary)] py-1.5 pl-8 pr-2 text-sm text-[var(--text-primary)]" />
                        </span>
                    </label>
                    <label className="flex items-center gap-2 pb-2 text-xs font-bold text-[var(--text-secondary)]">
                        <input type="checkbox" checked={onlyFindings} onChange={e => setOnlyFindings(e.target.checked)} className="h-4 w-4 rounded" /> Solo con hallazgos
                    </label>
                    <div className="ml-auto flex flex-wrap gap-2">
                        <button type="button" onClick={() => load(true)} disabled={isLoading || !!rangeError} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-secondary)] bg-[var(--background-primary)] px-3 py-1.5 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--background-hover)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
                            <IconRefresh className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> Actualizar
                        </button>
                        <button type="button" disabled={!report} onClick={() => report && downloadText(`Calidad_de_cierres_${report.startDate}_${report.endDate}.csv`, closureReviewCsv(report, sortDrivers(report.drivers, 'score', 'desc')))} className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-400">
                            <IconFileSpreadsheet className="h-4 w-4" /> Exportar CSV
                        </button>
                        <button type="button" disabled={!report} onClick={() => window.print()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-secondary)] bg-[var(--background-primary)] px-3 py-1.5 text-xs font-bold text-[var(--text-secondary)] hover:bg-[var(--background-hover)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
                            <IconPrinter className="h-4 w-4" /> Imprimir / PDF
                        </button>
                    </div>
                </div>
                {rangeError && <p role="alert" className="mt-2 inline-block rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs font-bold text-red-900">{rangeError}</p>}
            </section>

            {error && (
                <Notice tone="red" role="alert" className="flex items-start gap-2">
                    <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> <span>{error}</span>
                </Notice>
            )}

            {!report && isLoading && <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]"><IconLoader className="h-4 w-4 animate-spin" /> Calculando el informe…</p>}

            {report && (
                <>
                    {coverage && coverage.pending > 0 && (
                        <Notice tone="amber" role="status" className="print:hidden">
                            <div className="flex items-center gap-2 font-bold"><IconInfo className="h-4 w-4 shrink-0" /> Las fotos aún se están procesando: {fmtInt(coverage.scanned)} de {fmtInt(coverage.withPhotos)} cierres con fotos ({coveragePct} %).</div>
                            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-amber-200"><div className="h-full rounded-full bg-amber-600" style={{ width: `${coveragePct}%` }} /></div>
                            <p className="mt-1.5 text-xs">El servidor las revisa en segundo plano, de las más recientes a las más antiguas. Los nombres ya están completos; las cifras de fotos van a subir. Pulsa «Actualizar» en unos minutos.</p>
                        </Notice>
                    )}

                    <section aria-label="Resumen del período" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                        <Kpi label="Cierres de conductores" value={fmtInt(report.totals.closures)} sub={`${report.totals.drivers} conductores`} />
                        <Kpi label="Nombre sin sentido" value={fmtInt(report.totals.nameBad)} tone={report.totals.nameBad > 0 ? 'warn' : 'neutral'} sub={`${report.totals.nameBadPct} % de los cierres · ${report.totals.flaggedName} conductores en la lista`} />
                        <Kpi label="Misma imagen" value={fmtInt(report.totals.sameImage)} tone={report.totals.sameImage > 0 ? 'bad' : 'neutral'} sub={`${fmtInt(report.totals.identical)} con el mismo archivo · de ${fmtInt(report.totals.reviewed)} cierres con 2+ fotos`} />
                        <Kpi label="Fotos muy parecidas" value={fmtInt(report.totals.similar)} tone={report.totals.similar > 0 ? 'warn' : 'neutral'} sub="La misma toma dos veces (evidencia más débil)" />
                        <Kpi label="Foto reutilizada" value={fmtInt(report.totals.reused)} tone={report.totals.reused > 0 ? 'bad' : 'neutral'} sub="El mismo archivo en otra dirección" />
                        <Kpi label="Conductores a revisar" value={fmtInt(report.drivers.filter(hasFindings).length)} sub={report.both.length > 0 ? `En las dos listas: ${report.both.join(', ')}` : 'Ninguno está en las dos listas'} />
                    </section>

                    <section aria-label="Conductores" className="overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--background-secondary)]">
                        <div className="overflow-x-auto">
                            <table className="min-w-full text-sm text-[var(--text-primary)]">
                                <thead className="border-b border-[var(--border-primary)] bg-[var(--background-muted)]">
                                    <tr>
                                        <SortTh k="name" sort={sort} onSort={onSort} align="left">Conductor</SortTh>
                                        <SortTh k="closures" sort={sort} onSort={onSort}>Cierres</SortTh>
                                        <SortTh k="nameBad" sort={sort} onSort={onSort} title="Cierres con un nombre de quien recibe sin sentido">Nombre sin sentido</SortTh>
                                        <SortTh k="reviewed" sort={sort} onSort={onSort} title="Cierres con 2 o más fotos ya procesadas (se comparan entre sí)">Con 2+ fotos</SortTh>
                                        <SortTh k="sameImage" sort={sort} onSort={onSort} title="Dos fotos del mismo cierre son la misma imagen (mismo archivo o recomprimida)">Misma imagen</SortTh>
                                        <SortTh k="similar" sort={sort} onSort={onSort} title="Dos fotos del mismo cierre casi iguales">Muy parecidas</SortTh>
                                        <SortTh k="reused" sort={sort} onSort={onSort} title="Foto ya usada por el conductor en otra dirección">Reutilizada</SortTh>
                                        <th scope="col" className="px-3 py-2 text-left text-[10px] font-black uppercase tracking-wide text-[var(--text-muted)]">Lista</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--border-primary)]">
                                    {rows.length === 0 && (
                                        <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">{report.drivers.length === 0 ? 'No hay cierres de conductores en el período.' : onlyFindings ? 'Ningún conductor tiene hallazgos con estos filtros.' : 'Ningún conductor coincide con la búsqueda.'}</td></tr>
                                    )}
                                    {rows.map(d => (
                                        <tr key={d.driverId} className="hover:bg-[var(--background-hover)]">
                                            <td className="px-3 py-2">
                                                <button type="button" onClick={() => setOpenDriverId(d.driverId)} className="text-left font-bold text-[var(--brand-primary)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] rounded print:text-[var(--text-primary)]">{d.name}</button>
                                                {d.status && d.status !== 'APROBADO' && <span className="ml-2 text-[10px] font-bold uppercase text-[var(--text-muted)]">{d.status === 'ELIMINADO' ? 'ya no está' : d.status.toLowerCase()}</span>}
                                                {d.pending > 0 && <span className="ml-2 rounded border border-amber-300 bg-amber-100 px-1 text-[10px] font-bold text-amber-900" title="Fotos aún sin procesar">{d.pending} por procesar</span>}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums">{fmtInt(d.closures)}</td>
                                            <td className="px-3 py-2 text-right tabular-nums" title={`Vacío ${d.nameBreakdown.empty} · ${NAME_PROBLEM_LABEL.signs} ${d.nameBreakdown.signs} · ${NAME_PROBLEM_LABEL.short} ${d.nameBreakdown.short} · ${NAME_PROBLEM_LABEL.filler} ${d.nameBreakdown.filler}`}>
                                                <Flagged on={d.flags.name} tone={TONE.amber}>{d.nameBad}</Flagged> <span className="text-xs text-[var(--text-muted)]">({pctText(d.nameBad, d.closures)})</span>
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums text-[var(--text-secondary)]">{fmtInt(d.reviewed)}</td>
                                            <td className="px-3 py-2 text-right tabular-nums" title={`${d.identical} con el mismo archivo · ${d.recompressed} recomprimidas`}><Flagged on={d.sameImage >= report.thresholds.photoSame} tone={TONE.red}>{d.sameImage}</Flagged></td>
                                            <td className="px-3 py-2 text-right tabular-nums"><Flagged on={d.similar >= report.thresholds.photoSimilar} tone={TONE.orange}>{d.similar}</Flagged></td>
                                            <td className="px-3 py-2 text-right tabular-nums"><Flagged on={d.reused >= report.thresholds.photoReuse} tone={TONE.purple}>{d.reused}</Flagged></td>
                                            <td className="px-3 py-2">
                                                <div className="flex flex-wrap gap-1">
                                                    {d.flags.name && <Chip tone={TONE.amber} title={`${report.thresholds.nameMinCount}+ cierres y ${report.thresholds.namePercent} % o más de los suyos con nombre sin sentido`}>Nombre</Chip>}
                                                    {d.flags.photos === 'MAIN' && <Chip tone={TONE.red} title="Supera el umbral de fotos repetidas">Fotos</Chip>}
                                                    {d.flags.photos === 'MINOR' && <Chip tone={TONE.slate} title="Casos aislados de fotos repetidas, bajo el umbral">Fotos · aislados</Chip>}
                                                    {!hasFindings(d) && <span className="text-xs text-[var(--text-muted)]">—</span>}
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <details className="print:hidden rounded-xl border border-[var(--border-primary)] bg-[var(--background-secondary)] p-4 text-sm text-[var(--text-secondary)]">
                        <summary className="cursor-pointer font-bold text-[var(--text-primary)]">Cómo se calcula y cómo leerlo</summary>
                        <ul className="mt-3 list-disc space-y-1.5 pl-5">
                            <li><strong>Qué cuenta:</strong> entregas cerradas por un conductor en la app; los «Cierre automático (verificado en Mercado Libre)» no cuentan. La fecha es la del cierre.</li>
                            <li><strong>Nombre sin sentido:</strong> {KIND_HELP.NAME} Es la misma regla que el formulario del conductor.</li>
                            <li><strong>Misma imagen:</strong> {KIND_HELP.SAME_FILE} También cuenta la misma foto recomprimida (diferencia de hasta {report.thresholds.sameBits} de 63 bits en su huella visual).</li>
                            <li><strong>Muy parecidas:</strong> {KIND_HELP.SIMILAR} Hasta {report.thresholds.similarBits} de 63 bits. Dos fotos tomadas en la misma puerta pueden parecerse sin ser trampa: abre «Ver fotos» y compáralas.</li>
                            <li><strong>Foto reutilizada:</strong> {KIND_HELP.REUSED} Varios paquetes de la misma parada (mismo edificio, distinto depto) no cuentan.</li>
                            <li><strong>Lista:</strong> «Nombre» = {report.thresholds.nameMinCount}+ cierres y {report.thresholds.namePercent} % o más de los suyos. «Fotos» = {report.thresholds.photoSame}+ con la misma imagen, o {report.thresholds.photoSimilar}+ muy parecidas, o {report.thresholds.photoReuse}+ reutilizadas. «Fotos · aislados» = algún caso, pero bajo esos umbrales.</li>
                            <li><strong>Fotos:</strong> el servidor guarda solo las huellas, no copias de las fotos. Se comparan las fotos de cada cierre entre sí; los cierres con una sola foto solo cuentan para «reutilizada».</li>
                        </ul>
                    </details>
                </>
            )}

            {openDriver && <DriverDetail driver={openDriver} startDate={startDate} endDate={endDate} tz={tz} onClose={() => setOpenDriverId(null)} />}
        </div>
    );
};

export default ClosureQualityReport;
