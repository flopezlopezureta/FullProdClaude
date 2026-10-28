import React, { useEffect, useMemo, useState } from 'react';
import { IconAlertTriangle, IconCheckCircle, IconChevronDown, IconLoader } from '../Icon';
import {
    CUTOFF_HOUR, GROUP_ORDER, GROUP_LABEL, GROUP_SHORT, OUTCOME_GROUP, NO_FILTER, isFiltered, filterDelay, groupCounts, driverCounts, driverOf,
    dayLabel, fmtInt, fmtClock, fmtDayClock, fmtLate, localDate, titleCase, statusLabel,
} from '../../utils/meliWeeklyReport';
import type { SellerStats, GroupBy, DelayDetail, DelayItem, DelayFilter, DelayGroup, DelayStoryStep } from '../../utils/meliWeeklyReport';

// Colores por categoría. Nunca van solos: cada pastilla lleva su nombre. El rojo queda reservado, como en el resto del informe, para "bajo la meta".
const GROUP_STYLE: Record<DelayGroup, { bg: string; fg: string }> = {
    late: { bg: '#fffbeb', fg: '#92400e' }, cancelled: { bg: '#f1f5f9', fg: '#475569' }, rescheduled: { bg: '#eef2ff', fg: '#3730a3' },
    reassigned: { bg: '#fff7ed', fg: '#9a3412' }, noClose: { bg: '#fdf4ff', fg: '#86198f' },
};

const BASIS_HINT: Record<string, string> = {
    before: 'Nadie lo tenía asignado en ese momento: se muestra el último conductor que lo tuvo antes.',
    after: 'Nadie lo tenía asignado en ese momento ni antes: se muestra a quien se le asignó después (por ejemplo, un administrador asignó al conductor tras la entrega).',
    current: 'No hay historial de asignación legible: se muestra el conductor que figura hoy en el paquete.',
};

const GroupBadge: React.FC<{ group: DelayGroup }> = ({ group }) => (
    <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-black leading-tight" style={{ background: GROUP_STYLE[group].bg, color: GROUP_STYLE[group].fg }}>{GROUP_LABEL[group]}</span>
);

const Chip: React.FC<{ active: boolean; onClick: () => void; title?: string; children: React.ReactNode }> = ({ active, onClick, title, children }) => (
    <button type="button" aria-pressed={active} title={title} onClick={onClick}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${active ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}>
        {children}
    </button>
);

/** Qué le pasó al paquete, en una línea. */
const whatHappened = (it: DelayItem, tz: string): string => {
    const sameDay = (iso: string) => localDate(iso, tz) === it.day;
    switch (it.outcome) {
        case 'LATE_SAME_DAY':
            return `Entregado ${it.deliveredAt && !sameDay(it.deliveredAt) ? fmtDayClock(it.deliveredAt, tz) : `a las ${fmtClock(it.deliveredAt, tz)}`}${it.lateMinutes != null ? ` · ${fmtLate(it.lateMinutes)} después de las ${CUTOFF_HOUR}:00` : ''} · ${it.deliveredVia === 'ml' ? 'detectado en Mercado Libre' : 'cierre en la app'}`;
        case 'CANCELLED': return 'Cancelado en Mercado Libre';
        case 'RESCHEDULED': return `El cliente pidió reagendar${it.reason ? `: ${it.reason}` : ''}`;
        case 'REASSIGNED_DELIVERED': return `No se entregó ese día · entregado ${fmtDayClock(it.deliveredAt, tz)}`;
        case 'REASSIGNED_OPEN': return `No se entregó ese día · sigue abierto (${statusLabel(it.status)})`;
        default: return `Sin entrega ni incidencia registrada · estado ${statusLabel(it.status)}`;
    }
};

const FINAL_LABEL: Record<string, string> = { REASSIGNED_DELIVERED: 'Lo entregó', REASSIGNED_OPEN: 'Ahora lo tiene' };

const storyText = (s: DelayStoryStep): string => {
    switch (s.kind) {
        case 'dispatch': return s.who ? `Salió a ruta con ${s.who}` : 'Despachado a ruta';
        case 'assign': return s.who ? `Asignado a ${s.who}` : 'Asignado';
        case 'reassign': return s.who ? (s.from ? `Re-asignado de ${s.from} a ${s.who}` : `Re-asignado a ${s.who}`) : 'Re-asignado';
        case 'unassign': return 'Quedó sin conductor (desasignado)';
        case 'rescheduled': return `Reagendar: ${s.text || ''}`.trim();
        case 'problem': return `Problema: ${s.text || ''}`.trim();
        default: return s.text || '';
    }
};

interface Props {
    stats: SellerStats; weekStart: string; groupBy: GroupBy;
    filter: DelayFilter; onFilter: (f: DelayFilter) => void;
    sectionRef: React.RefObject<HTMLElement>; headingRef: React.RefObject<HTMLHeadingElement>;
}
type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: DelayDetail };

/** Paquetes que no se entregaron antes de las 21:00 de su día de gestión, con el conductor que los tenía. Se pide al servidor al abrir la ficha del seller. */
const MeliDelayDetail: React.FC<Props> = ({ stats, weekStart, groupBy, filter, onFilter, sectionRef, headingRef }) => {
    const [state, setState] = useState<LoadState>({ status: 'loading' });
    const [tick, setTick] = useState(0);
    const [open, setOpen] = useState<Set<string>>(new Set());

    useEffect(() => {
        const ac = new AbortController();
        setState({ status: 'loading' }); setOpen(new Set());
        const qs = new URLSearchParams({ weekStart, clientId: stats.clientId ?? '' });
        if (groupBy === 'account') { qs.set('accountId', stats.accountId ?? ''); qs.set('accountName', stats.accountName ?? ''); }
        fetch(`/api/reports/meli-weekly-delivery/detail?${qs.toString()}`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }, signal: ac.signal })
            .then(async r => {
                const body = await r.json().catch(() => null);
                if (!r.ok) throw new Error(body?.message || `Error del servidor (${r.status}).`);
                return body as DelayDetail;
            })
            .then(data => { if (!ac.signal.aborted) setState({ status: 'ready', data }); })
            .catch((e: any) => {
                if (ac.signal.aborted) return;
                console.error('Error cargando el detalle de paquetes fuera de plazo:', e);
                setState({ status: 'error', message: e?.message || 'No se pudo cargar el detalle: falló la conexión con el servidor.' });
            });
        return () => ac.abort();
    }, [weekStart, stats.key, groupBy, tick]); // eslint-disable-line react-hooks/exhaustive-deps

    const items = state.status === 'ready' ? state.data.items : [];
    const tz = state.status === 'ready' ? state.data.meta.tz : 'America/Santiago';
    const visible = useMemo(() => filterDelay(items, filter), [items, filter]);
    const groups = useMemo(() => groupCounts(items, filter), [items, filter]);
    const drivers = useMemo(() => driverCounts(items, filter), [items, filter]);
    const baseCount = useMemo(() => filterDelay(items, filter, 'group').length, [items, filter]);
    const expected = stats.total - stats.onTime;
    const multiAccount = groupBy === 'client' && stats.accounts.length > 1;

    const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    return (
        <section ref={sectionRef} aria-labelledby="meli-delay-title" className="scroll-mt-2">
            <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                    <h4 id="meli-delay-title" ref={headingRef} tabIndex={-1} className="text-xs font-black text-slate-900 uppercase tracking-wide focus:outline-none">
                        Paquetes fuera de plazo{state.status === 'ready' ? ` · ${fmtInt(items.length)}` : ''}
                    </h4>
                    <p className="text-[11px] text-slate-500 font-medium mt-0.5">Los que no se entregaron antes de las {CUTOFF_HOUR}:00 del día en que salieron a ruta, y el conductor que los tenía.</p>
                </div>
                {isFiltered(filter) && (
                    <button type="button" onClick={() => onFilter(NO_FILTER)} className="shrink-0 text-[11px] font-black text-indigo-700 hover:text-indigo-900 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded">Quitar filtros</button>
                )}
            </div>

            {state.status === 'loading' && (
                <div role="status" aria-live="polite" className="border border-slate-200 rounded-lg p-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs font-bold text-slate-500"><IconLoader className="w-4 h-4 animate-spin" />Buscando los paquetes y sus conductores…</div>
                    {[0, 1, 2].map(i => <div key={i} className="h-8 rounded bg-slate-100 animate-pulse" />)}
                </div>
            )}

            {state.status === 'error' && (
                <div role="alert" className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center gap-3">
                    <IconAlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
                    <p className="flex-1 text-xs font-bold text-red-800">{state.message}</p>
                    <button type="button" onClick={() => setTick(t => t + 1)} className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-[11px] font-black hover:bg-red-700">Reintentar</button>
                </div>
            )}

            {state.status === 'ready' && items.length === 0 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 flex items-center gap-3">
                    <IconCheckCircle className="w-5 h-5 text-emerald-700 shrink-0" />
                    <p className="text-xs font-bold text-emerald-900">{stats.total > 0 ? `Los ${fmtInt(stats.total)} paquetes de esta semana se entregaron antes de las ${CUTOFF_HOUR}:00.` : 'No hay paquetes gestionados en esta semana.'}</p>
                </div>
            )}

            {state.status === 'ready' && items.length > 0 && (
                <>
                    {items.length !== expected && (
                        <div role="status" className="mb-2 bg-amber-50 border border-amber-200 text-amber-900 text-[11px] font-bold rounded-lg px-3 py-2">
                            El detalle trae {fmtInt(items.length)} paquetes y el resumen {fmtInt(expected)}: los datos cambiaron desde que se cargó el informe. Cierra esta ficha y pulsa «Actualizar» para verlos al día.
                        </div>
                    )}

                    <div role="group" aria-label="Filtrar por categoría" className="flex flex-wrap gap-1.5 mb-2">
                        <Chip active={!filter.group} onClick={() => onFilter({ ...filter, group: null })}>Todos <span className="tabular-nums">{fmtInt(baseCount)}</span></Chip>
                        {GROUP_ORDER.filter(g => groups[g] > 0 || filter.group === g).map(g => (
                            <Chip key={g} active={filter.group === g} onClick={() => onFilter({ ...filter, group: filter.group === g ? null : g })}>
                                {GROUP_SHORT[g]} <span className="tabular-nums">{fmtInt(groups[g])}</span>
                            </Chip>
                        ))}
                        {filter.day && <Chip active onClick={() => onFilter({ ...filter, day: null })} title="Quitar el filtro de día">Día: <span className="capitalize">{dayLabel(filter.day)}</span> <span aria-hidden="true">✕</span><span className="sr-only"> quitar</span></Chip>}
                    </div>
                    <div role="group" aria-label="Filtrar por conductor" className="flex flex-wrap items-center gap-1.5 mb-3">
                        <span className="text-[10px] font-black uppercase text-slate-500 mr-0.5">Conductor</span>
                        {drivers.map(d => (
                            <Chip key={d.name} active={filter.driver === d.name} onClick={() => onFilter({ ...filter, driver: filter.driver === d.name ? null : d.name })}>
                                {d.name} <span className="tabular-nums">{fmtInt(d.count)}</span>
                            </Chip>
                        ))}
                        {filter.driver && !drivers.some(d => d.name === filter.driver) && <Chip active onClick={() => onFilter({ ...filter, driver: null })}>{filter.driver} <span className="tabular-nums">0</span></Chip>}
                    </div>

                    {visible.length === 0 ? (
                        <div className="border border-slate-200 rounded-lg px-4 py-3 text-xs font-bold text-slate-500">Ningún paquete cumple estos filtros. <button type="button" onClick={() => onFilter(NO_FILTER)} className="text-indigo-700 underline underline-offset-2">Quitar filtros</button></div>
                    ) : (
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                            <table className="min-w-full text-xs max-sm:block">
                                <caption className="sr-only">Paquetes de la semana que no se entregaron antes de las {CUTOFF_HOUR}:00, con su conductor</caption>
                                <thead className="bg-slate-50 text-[10px] font-black uppercase text-slate-500 max-sm:hidden"><tr>
                                    <th scope="col" className="px-2 py-2 text-left">Día</th><th scope="col" className="px-2 py-2 text-left">Paquete</th><th scope="col" className="px-2 py-2 text-left">Qué pasó</th><th scope="col" className="px-2 py-2 text-left">Conductor</th><th scope="col" className="px-2 py-2"><span className="sr-only">Historia</span></th>
                                </tr></thead>
                                <tbody className="max-sm:block">
                                    {visible.map(it => {
                                        const group = OUTCOME_GROUP[it.outcome];
                                        const isOpen = open.has(it.id);
                                        const approx = it.driver && it.driverBasis && it.driverBasis !== 'holder';
                                        const since = it.driverSince ? (localDate(it.driverSince, tz) === it.day ? fmtClock(it.driverSince, tz) : fmtDayClock(it.driverSince, tz)) : null;
                                        return (
                                            <React.Fragment key={it.id}>
                                                <tr className="border-t border-slate-100 align-top max-sm:block max-sm:px-3 max-sm:py-2.5">
                                                    <td className="px-2 py-2 text-left font-bold text-slate-700 capitalize whitespace-nowrap max-sm:inline-block max-sm:p-0 max-sm:mr-3 max-sm:align-top">{dayLabel(it.day)}</td>
                                                    <td className="px-2 py-2 text-left max-sm:inline-block max-sm:p-0 max-sm:align-top">
                                                        <div className="font-mono text-[11px] font-bold text-slate-800 whitespace-nowrap" title={`Código interno ${it.id}`}>{it.meliOrderId || it.id}</div>
                                                        <div className="text-[10px] text-slate-500">{titleCase(it.commune)}{multiAccount ? ` · ${it.accountName}` : ''}</div>
                                                    </td>
                                                    <td className="px-2 py-2 text-left min-w-[11rem] max-sm:block max-sm:p-0 max-sm:min-w-0 max-sm:mt-2">
                                                        <GroupBadge group={group} />
                                                        <div className="text-[11px] text-slate-700 mt-1 break-words" title={it.reason || undefined}>{whatHappened(it, tz)}</div>
                                                    </td>
                                                    <td className="px-2 py-2 text-left min-w-[8rem] max-sm:block max-sm:p-0 max-sm:min-w-0 max-sm:mt-2">
                                                        <div className="font-black text-slate-900 break-words">
                                                            {driverOf(it)}
                                                            {approx && <span tabIndex={0} role="img" aria-label="Conductor aproximado" title={BASIS_HINT[it.driverBasis as string]} className="ml-1 text-slate-400 cursor-help">≈</span>}
                                                        </div>
                                                        {since && <div className="text-[10px] text-slate-500">lo tenía desde las {since}</div>}
                                                        {it.finalDriver && <div className="text-[10px] text-slate-500">{FINAL_LABEL[it.outcome] || 'Después'}: <span className="font-bold text-slate-700">{it.finalDriver}</span></div>}
                                                    </td>
                                                    <td className="px-2 py-2 text-right whitespace-nowrap max-sm:block max-sm:p-0 max-sm:text-left max-sm:mt-1">
                                                        <button type="button" aria-expanded={isOpen} aria-controls={`story-${it.id}`} onClick={() => toggle(it.id)}
                                                            className="inline-flex items-center gap-1 text-[11px] font-black text-indigo-700 hover:text-indigo-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded px-1">
                                                            Historia<IconChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                                                        </button>
                                                    </td>
                                                </tr>
                                                {isOpen && (
                                                    <tr id={`story-${it.id}`} className="bg-slate-50 max-sm:block">
                                                        <td colSpan={5} className="px-4 py-3 max-sm:block">
                                                            {it.story.length === 0 ? <p className="text-[11px] text-slate-500">Sin movimientos registrados.</p> : (
                                                                <ol className="space-y-1">
                                                                    {it.story.map((s, i) => (
                                                                        <li key={i} className="flex gap-3 text-[11px]">
                                                                            <span className="w-24 shrink-0 font-bold tabular-nums text-slate-500 whitespace-nowrap">{fmtDayClock(s.at, tz)}</span>
                                                                            <span className="text-slate-800 break-words">{storyText(s)}</span>
                                                                        </li>
                                                                    ))}
                                                                </ol>
                                                            )}
                                                            {it.drivers.length > 1 && <p className="text-[11px] text-slate-500 mt-2">Pasó por: <span className="font-bold text-slate-700">{it.drivers.join(' → ')}</span></p>}
                                                            <p className="text-[10px] text-slate-400 mt-1">Código interno: <span className="font-mono">{it.id}</span> (se puede buscar en la lista de paquetes).</p>
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <p className="text-[10px] text-slate-400 font-medium mt-2">
                        Cada paquete aparece en su día de gestión (el día que salió a ruta por primera vez). El conductor es quien lo tenía en el momento que explica el resultado: al entregarlo, al cancelarse, al pedirse reagendar o al terminar ese día. «≈» indica que no había nadie asignado en ese momento y se estimó.
                    </p>
                </>
            )}
        </section>
    );
};

export default MeliDelayDetail;
