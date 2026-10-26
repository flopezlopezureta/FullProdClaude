import React from 'react';
import { IconX, IconRefresh, IconLoader, IconAlertTriangle, IconCheck, IconClock, IconRoute } from '../Icon';
import {
  fmtKm, fmtDuration, fmtClock, clipText, stopKind,
} from '../../utils/routePlanning';
import type { DriverDayRoute, RouteStop, Visit, VisitQuality, RoadRoute, PlannedRoute } from '../../utils/routePlanning';

export type RouteMode = 'both' | 'done' | 'plan' | 'off';

const MODES: { id: RouteMode; label: string; hint: string }[] = [
  { id: 'both', label: 'Ambas', hint: 'Ruta realizada y ruta sugerida' },
  { id: 'done', label: 'Realizada', hint: 'Solo lo que el conductor ya visitó, en el orden real' },
  { id: 'plan', label: 'Sugerida', hint: 'Solo el orden optimizado de lo que le falta' },
  { id: 'off', label: 'Sin ruta', hint: 'Solo los pines de las entregas' },
];

interface Props {
  driverName: string;
  isOnline: boolean;
  lastUpdate: Date | null;
  tz: string;
  date: string;
  today: string;
  onDateChange: (d: string) => void;
  mode: RouteMode;
  onModeChange: (m: RouteMode) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  data: DriverDayRoute | null;
  visits: Visit[];
  quality: VisitQuality;
  doneRoad: RoadRoute | null;
  plan: PlannedRoute | null;
  planning: boolean;
  onReplan: () => void;
  etas: Date[];
  without: RouteStop[];
  focusId: string | null;
  onFocusStop: (id: string) => void;
  onClose: () => void;
}

const Dot: React.FC<{ n: number | string; color: string; dashed?: boolean }> = ({ n, color, dashed }) => (
  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-black text-white flex-shrink-0" style={{ background: color, border: `2px ${dashed ? 'dashed' : 'solid'} rgba(255,255,255,.85)` }}>{n}</span>
);

const DriverRoutePanel: React.FC<Props> = (p) => {
  const { data, visits, plan } = p;
  const doneCount = visits.filter(v => v.kind === 'done').length;
  const attemptCount = visits.filter(v => v.kind === 'attempt').length;
  const pendingTotal = data ? data.stops.filter(s => stopKind(s) === 'open').length : 0;
  const first = visits[0]?.at, last = visits[visits.length - 1]?.at;
  const spanMin = first != null && last != null ? Math.max(0, Math.round((last - first) / 60000)) : null;
  const perStop = spanMin != null && visits.length > 1 ? Math.round((spanMin / (visits.length - 1)) * 10) / 10 : null;
  const canPlan = p.today === p.date;
  const showDone = p.mode === 'both' || p.mode === 'done';
  const showPlan = (p.mode === 'both' || p.mode === 'plan') && canPlan;
  const planEnd = plan && p.etas.length ? p.etas[p.etas.length - 1] : null;
  const nextStopId = plan?.order[0]?.id;

  return (
    <div className="flex flex-col min-h-0 flex-grow border-t border-[var(--border-primary)]">
      <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-2 flex-shrink-0">
        <div className="min-w-0">
          <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1"><IconRoute className="w-3.5 h-3.5" />Ruta del conductor</div>
          <div className="font-black text-[var(--text-primary)] truncate" title={p.driverName}>{p.driverName}</div>
          <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${p.isOnline ? 'bg-green-500' : 'bg-slate-400'}`} />
            {p.isOnline ? 'En línea' : `Sin señal${p.lastUpdate ? ` · últ. ${fmtClock(p.lastUpdate, p.tz)}` : ''}`}
          </div>
        </div>
        <button onClick={p.onClose} aria-label="Cerrar la ruta" className="p-1.5 rounded-full hover:bg-[var(--background-hover)] text-[var(--text-muted)]"><IconX className="w-4 h-4" /></button>
      </div>

      <div className="px-4 pb-2 flex items-center gap-2 flex-shrink-0">
        <label className="sr-only" htmlFor="route-date">Día de la ruta</label>
        <input id="route-date" type="date" value={p.date} max={p.today} onChange={e => e.target.value && p.onDateChange(e.target.value)}
          className="px-2 py-1.5 text-xs font-bold bg-[var(--background-primary)] border border-[var(--border-secondary)] rounded-lg text-[var(--text-primary)]" />
        {p.date !== p.today && <button onClick={() => p.onDateChange(p.today)} className="text-[11px] font-bold text-blue-500 hover:text-blue-400">Volver a hoy</button>}
      </div>

      <div role="group" aria-label="Qué ruta mostrar" className="mx-4 mb-2 grid grid-cols-4 gap-0.5 p-0.5 rounded-lg bg-[var(--background-primary)] border border-[var(--border-primary)] flex-shrink-0">
        {MODES.map(m => (
          <button key={m.id} title={m.hint} aria-pressed={p.mode === m.id} onClick={() => p.onModeChange(m.id)}
            className={`py-1.5 rounded-md text-[11px] font-black transition-colors ${p.mode === m.id ? 'bg-blue-600 text-white shadow' : 'text-[var(--text-secondary)] hover:bg-[var(--background-hover)]'}`}>{m.label}</button>
        ))}
      </div>

      <div className="overflow-y-auto custom-scrollbar flex-grow min-h-0 px-4 pb-3 space-y-3">
        {p.loading && !data && <div className="py-6 text-center text-xs font-bold text-[var(--text-muted)] flex items-center justify-center gap-2"><IconLoader className="w-4 h-4 animate-spin" />Cargando la ruta…</div>}
        {p.error && (
          <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-500 font-bold flex items-start gap-2">
            <IconAlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /><div className="flex-grow">{p.error}<button onClick={p.onRetry} className="block mt-1 underline">Reintentar</button></div>
          </div>
        )}

        {data && (
          <>
            {data.stops.length === 0 ? (
              <div className="py-6 text-center text-xs font-bold text-[var(--text-muted)]">Este conductor no tuvo paradas asignadas {p.date === p.today ? 'hoy' : 'ese día'}.</div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-lg bg-green-500/10 border border-green-500/30 py-1.5"><div className="text-lg font-black text-green-500 leading-none">{doneCount}</div><div className="text-[10px] font-bold text-[var(--text-muted)] mt-0.5">entregadas</div></div>
                  <div className="rounded-lg bg-red-500/10 border border-red-500/30 py-1.5"><div className="text-lg font-black text-red-500 leading-none">{attemptCount}</div><div className="text-[10px] font-bold text-[var(--text-muted)] mt-0.5">con problema</div></div>
                  <div className="rounded-lg bg-blue-500/10 border border-blue-500/30 py-1.5"><div className="text-lg font-black text-blue-500 leading-none">{pendingTotal}</div><div className="text-[10px] font-bold text-[var(--text-muted)] mt-0.5">pendientes</div></div>
                </div>

                {showDone && visits.length > 0 && (
                  <div className="rounded-lg border border-[var(--border-primary)] p-2.5 text-[11px] space-y-1">
                    <div className="font-black text-green-500 flex items-center gap-1.5"><span className="inline-block w-5 h-[3px] bg-green-500 rounded" />Ruta realizada</div>
                    <div className="text-[var(--text-secondary)]">
                      {fmtClock(first, p.tz)} → {fmtClock(last, p.tz)}{spanMin != null && ` · ${fmtDuration(spanMin * 60)}`}
                      {p.doneRoad && ` · ${fmtKm(p.doneRoad.distanceM)}${p.doneRoad.usesStreets ? '' : ' (aprox.)'}`}
                      {perStop != null && ` · ${perStop.toLocaleString('es-CL')} min por parada`}
                    </div>
                    {!p.quality.reliable && (
                      <div className="text-amber-500 font-bold flex items-start gap-1"><IconAlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />Muchas entregas se cerraron casi al mismo tiempo: el orden entre ellas es aproximado.</div>
                    )}
                  </div>
                )}

                {showPlan && (
                  <div className="rounded-lg border border-[var(--border-primary)] p-2.5 text-[11px] space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-black text-blue-500 flex items-center gap-1.5"><span className="inline-block w-5 h-0 border-t-[3px] border-dashed border-blue-500" />Ruta sugerida</div>
                      <button onClick={p.onReplan} disabled={p.planning} title="Volver a calcular desde la posición actual del conductor"
                        className="flex items-center gap-1 text-[10px] font-black text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50">
                        {p.planning ? <IconLoader className="w-3 h-3 animate-spin" /> : <IconRefresh className="w-3 h-3" />}Recalcular
                      </button>
                    </div>
                    {p.planning && !plan && <div className="text-[var(--text-muted)] font-bold">Calculando el mejor orden…</div>}
                    {plan && plan.order.length > 0 && (
                      <div className="text-[var(--text-secondary)]">
                        {plan.order.length} paradas · {fmtKm(plan.distanceM)}{plan.usesStreets ? '' : ' (aprox.)'} · {fmtDuration(plan.durationS)} manejando
                        {planEnd && <> · fin estimado <b className="text-[var(--text-primary)]">{fmtClock(planEnd, p.tz)}</b></>}
                      </div>
                    )}
                    {plan && plan.order.length === 0 && <div className="text-[var(--text-muted)] font-bold">{pendingTotal === 0 ? 'No le quedan paradas pendientes.' : 'Las paradas pendientes no tienen ubicación válida.'}</div>}
                    {plan && plan.order.length > 0 && (
                      <div className="text-[var(--text-muted)]">
                        Sale {plan.startKind === 'driver' ? 'de su posición actual' : plan.startKind === 'lastStop' ? 'de su última parada (sin señal GPS reciente)' : 'de la parada más conveniente (sin posición conocida)'}. Tiempos estimados con 3 min por parada.
                      </div>
                    )}
                    {plan && !plan.usesStreets && plan.order.length > 0 && (
                      <div className="text-amber-500 font-bold flex items-start gap-1"><IconAlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" />No se pudo consultar el servicio de calles: la línea y los tiempos son aproximados.</div>
                    )}
                  </div>
                )}
                {p.mode !== 'off' && !canPlan && (p.mode === 'plan') && <div className="text-[11px] text-[var(--text-muted)] font-bold">La ruta sugerida solo se calcula para hoy.</div>}

                {showDone && visits.length > 0 && (
                  <section aria-label="Paradas realizadas">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] mb-1">Realizadas ({visits.length})</h4>
                    <ol className="space-y-0.5">
                      {visits.map((v, i) => (
                        <li key={v.stop.id}>
                          <button onClick={() => p.onFocusStop(v.stop.id)} className={`w-full text-left flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[var(--background-hover)] ${p.focusId === v.stop.id ? 'bg-[var(--background-hover)]' : ''}`}>
                            <Dot n={i + 1} color={v.kind === 'done' ? '#16a34a' : '#dc2626'} dashed={v.stop.approx} />
                            <span className="min-w-0 flex-grow">
                              <span className="block text-[11px] font-bold text-[var(--text-primary)] truncate">{clipText(v.stop.address || 'Sin dirección', 46)}</span>
                              <span className="block text-[10px] text-[var(--text-muted)] truncate">{v.stop.commune}{v.kind === 'attempt' ? ' · no se pudo entregar' : ''}{v.stop.approx ? ' · ubicación aprox.' : ''}</span>
                            </span>
                            <span className="text-[10px] font-black text-[var(--text-secondary)] flex-shrink-0 flex items-center gap-0.5">{v.kind === 'done' ? <IconCheck className="w-3 h-3 text-green-500" /> : <IconAlertTriangle className="w-3 h-3 text-red-500" />}{fmtClock(v.at, p.tz)}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

                {showPlan && plan && plan.order.length > 0 && (
                  <section aria-label="Paradas pendientes en el orden sugerido">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-[var(--text-muted)] mb-1">Pendientes · orden sugerido ({plan.order.length})</h4>
                    <ol className="space-y-0.5">
                      {plan.order.map((s, i) => (
                        <li key={s.id}>
                          <button onClick={() => p.onFocusStop(s.id)} className={`w-full text-left flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[var(--background-hover)] ${p.focusId === s.id ? 'bg-[var(--background-hover)]' : ''}`}>
                            <Dot n={visits.length + i + 1} color="#2563eb" dashed={s.approx} />
                            <span className="min-w-0 flex-grow">
                              <span className="block text-[11px] font-bold text-[var(--text-primary)] truncate">{clipText(s.address || 'Sin dirección', 46)}</span>
                              <span className="block text-[10px] text-[var(--text-muted)] truncate">{s.commune}{s.id === nextStopId ? ' · siguiente' : ''}{s.approx ? ' · ubicación aprox.' : ''}{s.attempts > 0 ? ' · ya tuvo un intento' : ''}</span>
                            </span>
                            {p.etas[i] && <span className="text-[10px] font-black text-blue-500 flex-shrink-0 flex items-center gap-0.5"><IconClock className="w-3 h-3" />{fmtClock(p.etas[i], p.tz)}</span>}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </section>
                )}

                {p.without.length > 0 && (
                  <section aria-label="Paradas sin ubicación">
                    <h4 className="text-[10px] font-black uppercase tracking-wider text-amber-500 mb-1">Sin ubicación válida ({p.without.length})</h4>
                    <p className="text-[10px] text-[var(--text-muted)] mb-1">No se pueden dibujar ni ordenar: revisa su dirección.</p>
                    <ul className="space-y-0.5">
                      {p.without.map(s => <li key={s.id} className="text-[11px] text-[var(--text-secondary)] truncate px-1.5">• {clipText(s.address || s.id, 50)} <span className="text-[var(--text-muted)]">({stopKind(s) === 'done' ? 'entregada' : stopKind(s) === 'open' ? 'pendiente' : s.status.toLowerCase().replace(/_/g, ' ')})</span></li>)}
                    </ul>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default DriverRoutePanel;
