import React, { useState, useEffect, useContext, useMemo, useRef } from 'react';
import { api } from '../services/api';
import { AuthContext } from '../contexts/AuthContext';
import { getLocalDateString } from '../utils/dateUtils';
import type { Package } from '../types';
import PackageDetailModal from './PackageDetailModal';
import {
  IconRefresh, IconUser, IconCheckCircle, IconAlertTriangle,
  IconClock, IconAward, IconChevronDown, IconChevronUp, IconBell, IconX
} from './Icon';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import {
  downloadChronometryPoster, CLOSURE_PROFILE_LABELS, PROFILE_STYLES, paceColor,
  type ClosureProfile, type PosterRow
} from '../utils/chronometryPoster';
import DriverPerformanceStatsPanel from './admin/DriverPerformanceStatsPanel';

const CLOSURE_STATUS_STYLES: { [key: string]: string } = {
  ENTREGADO: 'bg-emerald-100 text-emerald-700',
  DEVUELTO: 'bg-orange-100 text-orange-700',
  PROBLEMA: 'bg-red-100 text-red-700',
  REPROGRAMADO: 'bg-red-100 text-red-700',
  CANCELADO: 'bg-red-100 text-red-700',
};
const defaultStatusStyle = 'bg-amber-100 text-amber-700';
const OPEN_STATUSES = ['PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO'];
const DIFFICULTY_STATUSES = ['PROBLEMA', 'REPROGRAMADO', 'CANCELADO', 'DEVUELTO'];
// Orden de revisión: primero lo que sigue abierto, después cualquier dificultad de entrega
// (problema/reagendado/cancelado/devuelto), y al final lo ya entregado sin inconvenientes.
const getSortPriority = (status: string) => {
  if (OPEN_STATUSES.includes(status)) return 0;
  if (DIFFICULTY_STATUSES.includes(status)) return 1;
  return 2;
};

type ControlViewMode = 'CLOSURES' | 'CADENCE' | 'CHRONOMETRY' | 'SLA' | 'PERFORMANCE';

// Orden de la pestaña Cronometría. "Tiempo por entrega" = minutos promedio entre una entrega y la
// siguiente; "demora de cierre" = minutos entre el cierre detectado de Mercado Libre y el cierre
// en la app (ver services/driverMetrics.js).
type ChronoSort = 'START' | 'BEST_PACE' | 'WORST_PACE' | 'WORST_CLOSE' | 'BEST_CLOSE';
const CHRONO_SORT_LABELS: Record<ChronoSort, string> = {
  START: 'Hora de inicio (orden original)',
  BEST_PACE: 'Mejor tiempo por entrega',
  WORST_PACE: 'Peor tiempo por entrega',
  WORST_CLOSE: 'Mayor demora de cierre en la app (vs ML)',
  BEST_CLOSE: 'Menor demora de cierre en la app (vs ML)',
};
const MIN_ML_FOR_CLOSE_RANKING = 5;

export const FleetControlCenter: React.FC = () => {
  const auth = useContext(AuthContext);
  const tz = auth?.systemSettings?.timezone || 'America/Santiago';
  // El informe de rendimiento evalúa conductores uno a uno: solo para administradores (el backend también lo exige).
  const isAdmin = String(auth?.user?.role || '').toUpperCase() === 'ADMIN';

  const [selectedDate, setSelectedDate] = useState<string>(getLocalDateString());
  const [viewMode, setViewMode] = useState<ControlViewMode>('CLOSURES');
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);
  const [data, setData] = useState<{
    date: string;
    closures: any[];
    cadence: any[];
    chronometry: any[];
    chronometryCommunes: { commune: string; count: number }[];
  }>({ date: '', closures: [], cadence: [], chronometry: [], chronometryCommunes: [] });
  const [chronoSort, setChronoSort] = useState<ChronoSort>('START');
  const [selectedCommunes, setSelectedCommunes] = useState<string[]>([]);
  const [isCommuneMenuOpen, setIsCommuneMenuOpen] = useState(false);
  const [communeSearch, setCommuneSearch] = useState('');
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const communeMenuRef = useRef<HTMLDivElement>(null);
  const [notifyingDriverId, setNotifyingDriverId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [selectedDriverId, setSelectedDriverId] = useState<string>('ALL');

  const [driverDetail, setDriverDetail] = useState<{ driverId: string; driverName: string; packages: Package[] } | null>(null);
  const [isLoadingDriverDetail, setIsLoadingDriverDetail] = useState(false);
  const [selectedPackageDetail, setSelectedPackageDetail] = useState<Package | null>(null);

  // Trae TODAS las entregas del conductor para el día seleccionado (sin filtrar por estado, a
  // propósito - el pedido fue explícito: mostrar incluso las que quedaron pendientes, no solo las
  // cerradas). Reutiliza el mismo endpoint general de paquetes con los mismos filtros de fecha
  // (assignedAt) que ya usa el resto de esta pantalla, para que la lista coincida con los números
  // de la tabla de auditoría.
  const openDriverDetail = async (driverId: string, driverName: string) => {
    setIsLoadingDriverDetail(true);
    setDriverDetail({ driverId, driverName, packages: [] });
    try {
      const res = await api.getPackages({
        driverFilter: driverId,
        startDate: selectedDate,
        endDate: selectedDate,
        // Sin esto, buildPackageQuery (routes/packages.js) filtra por createdAt/estimatedDelivery
        // en vez de assignedAt cuando quien pregunta es un admin (ese filtro por assignedAt solo
        // se activa solo cuando el propio conductor pide su dia) - un paquete reasignado HOY pero
        // creado dias antes (assignedAt actualizado, createdAt no) quedaba invisible aqui aunque
        // la tabla de auditoria (que si usa assignedAt) lo contara bien. Confirmado con el caso
        // real de Anais Faundez / KANI-4b67-7814bed2.
        dateType: 'egress',
        limit: 0,
        includeHistory: 'false'
      });
      // Pendientes primero, despues cualquier dificultad de entrega (problema/reagendado/
      // cancelado/devuelto), y al final lo entregado sin inconvenientes - es justo lo que se pide
      // revisar con más urgencia al abrir esto.
      const sortedPackages = [...(res.packages || [])].sort((a, b) => {
        return getSortPriority(a.status as string) - getSortPriority(b.status as string);
      });
      setDriverDetail({ driverId, driverName, packages: sortedPackages });
    } catch (err) {
      console.error('Error fetching driver day detail:', err);
      alert('No se pudieron cargar las entregas de este conductor.');
      setDriverDetail(null);
    } finally {
      setIsLoadingDriverDetail(false);
    }
  };

  const openPackageDetail = async (pkgId: string) => {
    try {
      const fullPackage = await api.getPackage(pkgId);
      setSelectedPackageDetail(fullPackage);
    } catch (err: any) {
      alert(err.message || 'No se pudo cargar el detalle de este paquete.');
    }
  };

  const fetchData = async (targetDate?: string) => {
    const dateToFetch = targetDate || selectedDate;
    try {
      setIsLoading(true);
      // El filtro de comunas solo acota el ritmo de la pestaña Cronometría; las otras vistas lo ignoran.
      const res = await api.getFleetControlCenter(dateToFetch, selectedCommunes);
      setData(res);
    } catch (err) {
      console.error('Error fetching fleet control center:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData(selectedDate);
    const interval = setInterval(() => fetchData(selectedDate), 20000); // Refresh every 20s
    return () => clearInterval(interval);
  }, [selectedDate, selectedCommunes.join('|')]);

  // Cierra el selector de comunas al hacer clic fuera.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (communeMenuRef.current && !communeMenuRef.current.contains(e.target as Node)) setIsCommuneMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const handleNotifyClosure = async (driverId: string, driverName: string) => {
    try {
      setNotifyingDriverId(driverId);
      const res = await api.notifyDriverClosure(driverId);
      setToastMessage(res.message || `Notificación enviada a ${driverName}`);
      setTimeout(() => setToastMessage(null), 4000);
    } catch (err: any) {
      alert(err.message || 'Error al enviar notificación');
    } finally {
      setNotifyingDriverId(null);
    }
  };

  const filteredClosures = selectedDriverId === 'ALL' ? data.closures : data.closures.filter((c: any) => c.driverId === selectedDriverId);
  const filteredCadence = selectedDriverId === 'ALL' ? data.cadence : data.cadence.filter((c: any) => c.driverId === selectedDriverId);
  const filteredChronometry = selectedDriverId === 'ALL' ? data.chronometry : data.chronometry.filter((c: any) => c.driverId === selectedDriverId);

  const totalDrivers = filteredClosures.length;
  const closedInAppCount = filteredClosures.filter(c => c.hasClosedInApp).length;
  const pendingClosureCount = filteredClosures.filter(c => !c.hasClosedInApp && c.totalPackages > 0).length;

  // Ordena la cronometría y asigna posición solo a quienes son comparables: para "tiempo por
  // entrega" se excluye a quien cierra todo junto al final del día (su hora en la app no es la hora
  // real de entrega: saldría como el más rápido) y a quien tiene muy pocas entregas.
  const sortedChronometry = useMemo(() => {
    const rows = filteredChronometry.map((c: any) => ({ ...c, position: null as number | null }));
    if (chronoSort === 'START') return rows;
    const isPace = chronoSort === 'BEST_PACE' || chronoSort === 'WORST_PACE';
    const eligible = (c: any) => isPace
      ? c.paceReliable && c.avgMinutesPerDelivery != null
      : c.mlCount >= MIN_ML_FOR_CLOSE_RANKING && c.avgMlDelayMin != null;
    const ranked = rows.filter(eligible);
    const rest = rows.filter((c: any) => !eligible(c));
    ranked.sort((a: any, b: any) => {
      if (isPace) {
        return chronoSort === 'BEST_PACE'
          ? a.avgMinutesPerDelivery - b.avgMinutesPerDelivery
          : b.avgMinutesPerDelivery - a.avgMinutesPerDelivery;
      }
      const dir = chronoSort === 'WORST_CLOSE' ? -1 : 1;
      return dir * (a.avgMlDelayMin - b.avgMlDelayMin) || dir * ((a.lateShare ?? 0) - (b.lateShare ?? 0)) || b.mlCount - a.mlCount;
    });
    ranked.forEach((c: any, i: number) => { c.position = i + 1; });
    return [...ranked, ...rest];
  }, [filteredChronometry, chronoSort]);

  const hasRanking = chronoSort !== 'START';
  const communesLabel = selectedCommunes.length === 0 ? 'Todas las comunas' : selectedCommunes.join(', ');

  const handleDownloadChronoPdf = async () => {
    setIsGeneratingPdf(true);
    try {
      const rows: PosterRow[] = sortedChronometry.map((c: any) => ({
        position: c.position,
        driverName: c.driverName,
        firstActivity: c.firstActivity,
        lastActivity: c.lastActivity,
        totalHoursActive: c.totalHoursActive != null ? Number(c.totalHoursActive) : null,
        deliveredCount: c.deliveredCount,
        avgMinutesPerDelivery: c.avgMinutesPerDelivery != null ? Number(c.avgMinutesPerDelivery) : null,
        paceReliable: !!c.paceReliable,
        mlCount: c.mlCount,
        avgMlDelayMin: c.avgMlDelayMin,
        lateShare: c.lateShare,
        closureProfile: c.closureProfile as ClosureProfile,
        burstNote: c.closureProfile === 'END_OF_DAY' && c.maxBurst ? `${c.maxBurst} cierres en 10 min hacia las ${c.burstAt}` : undefined,
      }));
      const longDate = new Date(`${selectedDate}T12:00:00`).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const dateLabel = longDate.charAt(0).toUpperCase() + longDate.slice(1);
      const communeSlug = selectedCommunes.length ? `_${selectedCommunes.join('-').replace(/\s+/g, '').slice(0, 40)}` : '';
      await downloadChronometryPoster({
        dateLabel,
        communesLabel,
        sortLabel: `Orden: ${CHRONO_SORT_LABELS[chronoSort]}`,
        rows,
        hasRanking,
        medals: chronoSort === 'BEST_PACE',
        generatedAt: new Date().toLocaleString('es-CL', { timeZone: tz }),
        fileName: `Cronometria_Jornada_${selectedDate}${communeSlug}.pdf`,
      });
    } catch (err: any) {
      alert(err?.message || 'No se pudo generar el PDF.');
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const filteredCommuneOptions = data.chronometryCommunes.filter(o => o.commune.toLowerCase().includes(communeSearch.trim().toLowerCase()));
  const toggleCommune = (name: string) =>
    setSelectedCommunes(prev => prev.includes(name) ? prev.filter(x => x !== name) : [...prev, name]);

  return (
    <div className="mb-6 overflow-hidden bg-white border border-slate-200 rounded-2xl shadow-sm transition-all hover:shadow-md">
      {/* Header Bar */}
      <div 
        className="flex items-center justify-between px-6 py-4 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white cursor-pointer select-none"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-11 h-11 bg-white/10 rounded-xl backdrop-blur-md border border-white/10 shadow-inner">
            <IconAward className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-black uppercase tracking-[0.2em]">Centro de Control & Auditoría de Flotas</h2>
              <span className="px-2 py-0.5 text-[9px] font-black bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 rounded-full">STAGING LIVE</span>
            </div>
            <p className="text-[10px] font-bold text-slate-400 uppercase mt-0.5">
              Monitoreo Multimodal en Tiempo Real | Fullenvios2 Staging Suite
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={(e) => { e.stopPropagation(); fetchData(); }}
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-all"
            title="Refrescar datos de control"
          >
            <IconRefresh className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          {isExpanded ? <IconChevronUp className="w-5 h-5 text-slate-400" /> : <IconChevronDown className="w-5 h-5 text-slate-400" />}
        </div>
      </div>

      {toastMessage && (
        <div className="bg-emerald-600 text-white text-xs font-bold px-6 py-2 flex items-center justify-between animate-fadeIn">
          <span>✅ {toastMessage}</span>
          <button onClick={() => setToastMessage(null)} className="text-white/80 hover:text-white">✕</button>
        </div>
      )}

      {isExpanded && (
        <div className="p-6 bg-slate-50/50">
          
          {/* Modal Navigation Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-6 bg-white p-1.5 rounded-xl border border-slate-200 shadow-sm">
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => setViewMode('CLOSURES')}
                className={`px-4 py-2 text-xs font-black rounded-lg transition-all uppercase tracking-wider ${
                  viewMode === 'CLOSURES'
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                📋 1. Auditoría de Cierres ({pendingClosureCount} sin cerrar)
              </button>
              <button
                onClick={() => setViewMode('CADENCE')}
                className={`px-4 py-2 text-xs font-black rounded-lg transition-all uppercase tracking-wider ${
                  viewMode === 'CADENCE'
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                ⏱️ 2. Cadencia & Tiempos
              </button>
              <button
                onClick={() => setViewMode('CHRONOMETRY')}
                className={`px-4 py-2 text-xs font-black rounded-lg transition-all uppercase tracking-wider ${
                  viewMode === 'CHRONOMETRY'
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                🕒 3. Cronometría de Jornada
              </button>
              <button
                onClick={() => setViewMode('SLA')}
                className={`px-4 py-2 text-xs font-black rounded-lg transition-all uppercase tracking-wider ${
                  viewMode === 'SLA'
                    ? 'bg-slate-900 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                📊 4. SLA & Rendimiento
              </button>
              {isAdmin && (
                <button
                  onClick={() => setViewMode('PERFORMANCE')}
                  className={`px-4 py-2 text-xs font-black rounded-lg transition-all uppercase tracking-wider ${
                    viewMode === 'PERFORMANCE'
                      ? 'bg-slate-900 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  📈 5. Informe de Rendimiento
                </button>
              )}
            </div>

            {viewMode !== 'PERFORMANCE' && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                <span className="text-[10px] font-black text-slate-500 uppercase">📅 Fecha:</span>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="bg-transparent text-xs font-bold text-slate-900 border-none outline-none focus:ring-0 cursor-pointer"
                />
              </div>

              <div className="flex items-center gap-1.5 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                <span className="text-[10px] font-black text-slate-500 uppercase">👤 Chofer:</span>
                <select
                  value={selectedDriverId}
                  onChange={(e) => setSelectedDriverId(e.target.value)}
                  className="bg-transparent text-xs font-bold text-slate-900 border-none outline-none focus:ring-0 cursor-pointer max-w-[150px] truncate"
                >
                  <option value="ALL">Todos los Conductores</option>
                  {data.closures.map(d => (
                    <option key={d.driverId} value={d.driverId}>{d.driverName}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-lg text-[10px] font-black text-slate-600 uppercase">
                <span>Conductores Activos: {totalDrivers}</span>
                <span>•</span>
                <span className="text-emerald-700">Cerraron: {closedInAppCount}</span>
              </div>
            </div>
            )}
          </div>

          {/* VISTA 5: INFORME DE RENDIMIENTO POR CONDUCTOR (solo administradores) */}
          {viewMode === 'PERFORMANCE' && isAdmin && <DriverPerformanceStatsPanel />}

          {/* VISTA 1: AUDITORÍA DE CIERRES */}
          {viewMode === 'CLOSURES' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="p-3 bg-emerald-100 text-emerald-700 rounded-xl">
                    <IconCheckCircle className="w-6 h-6" />
                  </div>
                  <div>
                    <span className="text-[10px] font-black text-slate-400 uppercase">Cierres Correctos en App</span>
                    <h3 className="text-xl font-black text-slate-900">{closedInAppCount} / {totalDrivers}</h3>
                  </div>
                </div>

                <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="p-3 bg-amber-100 text-amber-700 rounded-xl">
                    <IconAlertTriangle className="w-6 h-6" />
                  </div>
                  <div>
                    <span className="text-[10px] font-black text-slate-400 uppercase">Pendientes de Cierre Hoy</span>
                    <h3 className="text-xl font-black text-amber-600">{pendingClosureCount} choferes</h3>
                  </div>
                </div>

                <div className="p-4 bg-white rounded-xl border border-slate-200 shadow-sm flex items-center gap-4">
                  <div className="p-3 bg-indigo-100 text-indigo-700 rounded-xl">
                    <IconBell className="w-6 h-6" />
                  </div>
                  <div>
                    <span className="text-[10px] font-black text-slate-400 uppercase">Acción Preventiva</span>
                    <p className="text-[11px] font-bold text-slate-600">Alerta Push directa disponible por chofer</p>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                <table className="w-full text-left">
                  <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider">
                    <tr>
                      <th className="px-5 py-3">Conductor</th>
                      <th className="px-5 py-3 text-center">Estado Cierre</th>
                      <th className="px-5 py-3 text-center">Hora Cierre</th>
                      <th className="px-5 py-3 text-center">Asignados / Entregados</th>
                      <th className="px-5 py-3 text-center">Historico 30 días</th>
                      <th className="px-5 py-3 text-right">Acción Auditor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredClosures.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-5 py-8 text-center text-slate-400 font-bold uppercase">
                          No hay actividad de conductores registrada para el día de hoy
                        </td>
                      </tr>
                    ) : (
                      filteredClosures.map((driver) => {
                        const isClosed = driver.hasClosedInApp;
                        const hasPending = driver.pending > 0;
                        const isPending = !isClosed && hasPending;
                        return (
                          <tr
                            key={driver.driverId}
                            onClick={() => openDriverDetail(driver.driverId, driver.driverName)}
                            className="hover:bg-slate-50 transition-colors cursor-pointer"
                            title="Ver todas las entregas del día de este conductor"
                          >
                            <td className="px-5 py-3 font-bold text-slate-900">
                              <div className="flex flex-col">
                                <span className="uppercase">{driver.driverName}</span>
                                <span className="text-[10px] text-slate-400 font-normal">{driver.driverPhone || 'Sin tel.'}</span>
                              </div>
                            </td>
                            <td className="px-5 py-3 text-center">
                              {isClosed ? (
                                <span className="px-2.5 py-1 text-[10px] font-black bg-emerald-100 text-emerald-800 rounded-md uppercase">
                                  ✓ Cerrado en App
                                </span>
                              ) : isPending ? (
                                <span className="px-2.5 py-1 text-[10px] font-black bg-amber-100 text-amber-800 rounded-md uppercase animate-pulse">
                                  ⚠️ Cierre Pendiente
                                </span>
                              ) : (
                                <span className="px-2.5 py-1 text-[10px] font-black bg-slate-100 text-slate-600 rounded-md uppercase">
                                  {driver.totalPackages > 0 ? 'Sin Pendientes' : 'Sin Entregas'}
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-center font-bold text-slate-700">
                              {driver.closureTimestamp
                                ? new Date(driver.closureTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                : '—'}
                            </td>
                            <td className="px-5 py-3 text-center">
                              <span className="font-black text-slate-900">{driver.delivered}</span>
                              <span className="text-slate-400 font-normal"> / {driver.totalPackages}</span>
                              {driver.pending > 0 && (
                                <span className="ml-2 text-[10px] font-bold text-amber-600">({driver.pending} pend)</span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-center font-bold text-slate-600">
                              {driver.closuresLast30Days} cierres
                            </td>
                            <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                              {!isClosed && (
                                <button
                                  onClick={() => handleNotifyClosure(driver.driverId, driver.driverName)}
                                  disabled={notifyingDriverId === driver.driverId || !hasPending}
                                  title={!hasPending ? 'Sin entregas pendientes: no hay nada que recordarle al conductor' : undefined}
                                  className={`px-3 py-1.5 text-[10px] font-black rounded-lg shadow-sm transition-all flex items-center gap-1.5 ml-auto ${
                                    hasPending
                                      ? 'bg-amber-500 hover:bg-amber-600 text-white'
                                      : 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none'
                                  }`}
                                >
                                  <IconBell className="w-3.5 h-3.5" />
                                  {notifyingDriverId === driver.driverId ? 'Enviando...' : 'Recordar Cierre'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VISTA 2: CADENCIA & TIEMPOS ENTRE ENTREGAS */}
          {viewMode === 'CADENCE' && (
            <div className="space-y-6">
              <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                <h3 className="text-xs font-black text-slate-800 uppercase tracking-wider mb-4">
                  ⏱️ Tiempo Promedio entre Entregas (Minutos por Paquete)
                </h3>
                <div className="h-[260px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={filteredCadence}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="driverName" tick={{ fontSize: 10, fontWeight: 'bold' }} />
                      <YAxis tick={{ fontSize: 10, fontWeight: 'bold' }} unit=" min" />
                      <Tooltip 
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
                      />
                      <Bar dataKey="avgMinutesBetweenDeliveries" name="Minutos Promedio" radius={[6, 6, 0, 0]}>
                        {filteredCadence.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={entry.closureProfile === 'END_OF_DAY' ? '#94a3b8' : entry.avgMinutesBetweenDeliveries > 30 ? '#ef4444' : entry.avgMinutesBetweenDeliveries > 18 ? '#f59e0b' : '#10b981'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                <table className="w-full text-left">
                  <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider">
                    <tr>
                      <th className="px-5 py-3">Conductor</th>
                      <th className="px-5 py-3 text-center">Entregas Realizadas</th>
                      <th className="px-5 py-3 text-center">Tiempo Prom. entre Entregas</th>
                      <th className="px-5 py-3 text-center">Brecha Máxima Inactiva</th>
                      <th className="px-5 py-3 text-right">Alerta Paradas &gt; 45 min</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredCadence.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-center text-slate-400 font-bold uppercase">
                          No hay suficientes entregas secuenciales hoy para calcular la cadencia
                        </td>
                      </tr>
                    ) : (
                      filteredCadence.map((c) => (
                        <tr key={c.driverId} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-3 font-bold text-slate-900 uppercase">{c.driverName}</td>
                          <td className="px-5 py-3 text-center font-bold text-slate-700">{c.deliveredCount} entregas</td>
                          <td className={`px-5 py-3 text-center font-black ${c.closureProfile === 'END_OF_DAY' ? 'text-slate-400' : 'text-indigo-700'}`}>
                            {c.avgMinutesBetweenDeliveries} min/paquete
                          </td>
                          <td className="px-5 py-3 text-center font-bold text-slate-600">{c.maxMinutesGap} min</td>
                          <td className="px-5 py-3 text-right">
                            {c.closureProfile === 'END_OF_DAY' ? (
                              <span
                                className="px-2.5 py-1 text-[10px] font-black bg-slate-100 text-slate-600 rounded-md uppercase"
                                title="Cerró todas sus entregas juntas al final del día: la hora de la app no es la hora real de entrega, así que este ritmo no es comparable."
                              >
                                ⚠ Cierre masivo · ritmo no medible
                              </span>
                            ) : c.idleAlertsCount > 0 ? (
                              <span className="px-2.5 py-1 text-[10px] font-black bg-red-100 text-red-700 rounded-md uppercase">
                                🚨 {c.idleAlertsCount} paradas largas
                              </span>
                            ) : (
                              <span className="px-2.5 py-1 text-[10px] font-bold bg-emerald-50 text-emerald-700 rounded-md uppercase">
                                ✓ Ritmo Fluido
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VISTA 3: CRONOMETRÍA DE JORNADA */}
          {viewMode === 'CHRONOMETRY' && (
            <div className="space-y-4">
              {/* Controles: orden, comunas y descarga del PDF para el mural */}
              <div className="flex flex-wrap items-center gap-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex items-center gap-1.5 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200">
                  <span className="text-[10px] font-black text-slate-500 uppercase">↕ Ordenar:</span>
                  <select
                    value={chronoSort}
                    onChange={(e) => setChronoSort(e.target.value as ChronoSort)}
                    className="bg-transparent text-xs font-bold text-slate-900 border-none outline-none focus:ring-0 cursor-pointer"
                  >
                    {(Object.keys(CHRONO_SORT_LABELS) as ChronoSort[]).map(k => (
                      <option key={k} value={k}>{CHRONO_SORT_LABELS[k]}</option>
                    ))}
                  </select>
                </div>

                <div className="relative" ref={communeMenuRef}>
                  <button
                    type="button"
                    onClick={() => setIsCommuneMenuOpen(o => !o)}
                    className="flex items-center gap-1.5 bg-slate-100 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-900 hover:bg-slate-200 max-w-[320px]"
                  >
                    <span className="text-[10px] font-black text-slate-500 uppercase">📍 Comunas:</span>
                    <span className="truncate">
                      {selectedCommunes.length === 0 ? 'Todas' : selectedCommunes.length <= 2 ? selectedCommunes.join(', ') : `${selectedCommunes.length} seleccionadas`}
                    </span>
                    <IconChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                  </button>
                  {isCommuneMenuOpen && (
                    <div className="absolute z-30 mt-1 w-72 bg-white border border-slate-200 rounded-xl shadow-xl p-2">
                      <input
                        type="text"
                        value={communeSearch}
                        onChange={(e) => setCommuneSearch(e.target.value)}
                        placeholder="Buscar comuna..."
                        className="w-full px-3 py-1.5 mb-2 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                      <div className="flex items-center justify-between px-1 pb-1.5 text-[10px] font-black uppercase text-slate-500">
                        <button type="button" onClick={() => setSelectedCommunes([])} className="text-indigo-600 hover:underline">Todas las comunas</button>
                        <span>{selectedCommunes.length} seleccionada{selectedCommunes.length === 1 ? '' : 's'}</span>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        {filteredCommuneOptions.length === 0 ? (
                          <p className="px-2 py-3 text-xs text-slate-400 text-center">Sin comunas con entregas ese día</p>
                        ) : filteredCommuneOptions.map(o => (
                          <label key={o.commune} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs font-bold text-slate-800">
                            <input
                              type="checkbox"
                              checked={selectedCommunes.includes(o.commune)}
                              onChange={() => toggleCommune(o.commune)}
                              className="h-3.5 w-3.5 rounded"
                            />
                            <span className="flex-1 truncate">{o.commune}</span>
                            <span className="text-[10px] font-black text-slate-400">{o.count}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleDownloadChronoPdf}
                  disabled={isGeneratingPdf || sortedChronometry.length === 0}
                  title="Descarga en PDF lo que ves en pantalla (orden, comunas y conductor seleccionados)"
                  className="ml-auto flex items-center gap-2 px-4 py-2 text-xs font-black text-white bg-indigo-600 rounded-lg shadow-sm hover:bg-indigo-700 disabled:opacity-50 uppercase tracking-wider"
                >
                  {isGeneratingPdf ? 'Generando PDF...' : '⬇ Descargar PDF'}
                </button>
              </div>

              {(hasRanking || selectedCommunes.length > 0) && (
                <p className="text-[11px] font-bold text-slate-500 px-1">
                  {selectedCommunes.length > 0 && <>El filtro por comuna acota el ritmo de entrega (primera/última entrega, horas, entregas y min por entrega a esas comunas); el cierre vs Mercado Libre se evalúa con toda la jornada del conductor. </>}
                  {hasRanking && <>Solo reciben posición quienes son comparables: con al menos 3 entregas{chronoSort.endsWith('CLOSE') ? ' con cierre en Mercado Libre (mín. 5)' : ' y que cierran sus entregas en el momento (quien cierra todo junto al final del día no tiene hora real de entrega)'}.</>}
                </p>
              )}

              <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto shadow-sm">
                <table className="w-full text-left">
                  <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider">
                    <tr>
                      {hasRanking && <th className="px-3 py-3 text-center">#</th>}
                      <th className="px-4 py-3">Conductor</th>
                      <th className="px-3 py-3 text-center">Primera entrega</th>
                      <th className="px-3 py-3 text-center">Última entrega</th>
                      <th className="px-3 py-3 text-center">Horas en ruta</th>
                      <th className="px-3 py-3 text-center">Entregas</th>
                      <th className="px-3 py-3 text-center" title="Minutos promedio entre una entrega y la siguiente">Min / entrega</th>
                      <th className="px-3 py-3 text-center" title="Entregas con cierre detectado en Mercado Libre">Entregas ML</th>
                      <th className="px-3 py-3 text-center" title="Minutos entre el cierre detectado de ML y el cierre en la app (mínimo garantizado)">Demora cierre app</th>
                      <th className="px-3 py-3 text-center" title="Entregas cerradas en la app más de 30 min después de ML">Cierres tardíos</th>
                      <th className="px-4 py-3">Perfil de cierre</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {sortedChronometry.length === 0 ? (
                      <tr>
                        <td colSpan={hasRanking ? 11 : 10} className="px-5 py-6 text-center text-slate-400 font-bold uppercase">
                          No hay registros de jornada para el día seleccionado
                        </td>
                      </tr>
                    ) : (
                      sortedChronometry.map((chrono: any) => {
                        // firstActivity/lastActivity llegan ya formateadas "HH:MM" (zona horaria del sistema) desde el backend.
                        const first = chrono.firstActivity || '--:--';
                        const last = chrono.lastActivity || '--:--';
                        const hours = chrono.totalHoursActive != null ? `${chrono.totalHoursActive} hrs` : '--';
                        const profile = chrono.closureProfile as ClosureProfile;
                        const ps = PROFILE_STYLES[profile];
                        const paceOk = chrono.paceReliable && chrono.avgMinutesPerDelivery != null;
                        return (
                          <tr key={chrono.driverId} className="hover:bg-slate-50 transition-colors">
                            {hasRanking && (
                              <td className="px-3 py-3 text-center">
                                {chrono.position != null ? (
                                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-black text-white ${
                                    chronoSort === 'BEST_PACE' && chrono.position === 1 ? 'bg-amber-500'
                                    : chronoSort === 'BEST_PACE' && chrono.position === 2 ? 'bg-slate-400'
                                    : chronoSort === 'BEST_PACE' && chrono.position === 3 ? 'bg-amber-700'
                                    : 'bg-slate-800'
                                  }`}>{chrono.position}</span>
                                ) : <span className="text-slate-300">·</span>}
                              </td>
                            )}
                            <td className="px-4 py-3 font-bold text-slate-900 uppercase whitespace-nowrap">{chrono.driverName}</td>
                            <td className="px-3 py-3 text-center font-bold text-emerald-700">{first}</td>
                            <td className="px-3 py-3 text-center font-bold text-blue-700">{last}</td>
                            <td className="px-3 py-3 text-center font-black text-slate-800">{hours}</td>
                            <td className="px-3 py-3 text-center font-black text-slate-900">
                              {chrono.deliveredCount}
                              {chrono.totalDeliveredDay !== chrono.deliveredCount && (
                                <span className="block text-[9px] font-bold text-slate-400">de {chrono.totalDeliveredDay} del día</span>
                              )}
                            </td>
                            <td
                              className="px-3 py-3 text-center font-black"
                              style={{ color: paceOk ? paceColor(Number(chrono.avgMinutesPerDelivery)) : '#94a3b8' }}
                              title={paceOk ? undefined : 'No comparable: muy pocas entregas, o cerró todas sus entregas juntas al final del día (la hora de la app no es la hora real de entrega)'}
                            >
                              {paceOk ? Number(chrono.avgMinutesPerDelivery).toFixed(1) : '—'}
                            </td>
                            <td className="px-3 py-3 text-center font-bold text-slate-600">{chrono.mlCount || '—'}</td>
                            <td className="px-3 py-3 text-center font-bold text-slate-800">
                              {chrono.mlCount > 0 && chrono.avgMlDelayMin != null ? `${chrono.avgMlDelayMin} min` : '—'}
                              {chrono.maxMlDelayMin > 30 && <span className="block text-[9px] font-bold text-red-500">máx. {chrono.maxMlDelayMin} min</span>}
                            </td>
                            <td className="px-3 py-3 text-center font-bold text-slate-800">
                              {chrono.lateShare != null ? `${Math.round(chrono.lateShare * 100)}%` : '—'}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className="inline-block px-2.5 py-1 text-[10px] font-black rounded-full whitespace-nowrap"
                                style={{ background: ps.bg, color: ps.fg }}
                                title={profile === 'END_OF_DAY' && chrono.maxBurst ? `${chrono.maxBurst} cierres en la app en 10 min, hacia las ${chrono.burstAt}` : undefined}
                              >
                                {CLOSURE_PROFILE_LABELS[profile]}
                              </span>
                              {profile === 'END_OF_DAY' && chrono.maxBurst > 0 && (
                                <span className="block text-[9px] font-bold text-red-600 mt-0.5">{chrono.maxBurst} cierres en 10 min · {chrono.burstAt}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] font-bold text-slate-400 px-1">
                Min / entrega = minutos promedio entre una entrega y la siguiente, con la hora real en que el conductor cierra cada entrega en la app. Demora de cierre = minutos entre el cierre detectado de Mercado Libre y el cierre en la app; la hora de ML es la de detección del sistema, por lo que la demora real es igual o mayor.
              </p>
            </div>
          )}

          {/* VISTA 4: SLA Y RENDIMIENTO */}
          {viewMode === 'SLA' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredClosures.map((d) => {
                const total = d.totalPackages || 1;
                const effRate = Math.round((d.delivered / total) * 100);
                return (
                  <div key={d.driverId} className="p-4 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col justify-between">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-black text-slate-900 uppercase">{d.driverName}</span>
                      <span className={`px-2 py-0.5 text-[9px] font-black rounded-md uppercase ${
                        effRate >= 90 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                      }`}>
                        SLA: {effRate}% Efectividad
                      </span>
                    </div>

                    <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden mb-3">
                      <div className="bg-indigo-600 h-full transition-all duration-500" style={{ width: `${effRate}%` }}></div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-center text-[10px] font-bold">
                      <div className="p-2 bg-slate-50 rounded-lg">
                        <span className="text-slate-400 block uppercase">Asignados</span>
                        <span className="text-slate-900 font-black text-xs">{d.totalPackages}</span>
                      </div>
                      <div className="p-2 bg-emerald-50 rounded-lg">
                        <span className="text-emerald-600 block uppercase">Entregados</span>
                        <span className="text-emerald-900 font-black text-xs">{d.delivered}</span>
                      </div>
                      <div className="p-2 bg-amber-50 rounded-lg">
                        <span className="text-amber-600 block uppercase">Fallidos/Pend</span>
                        <span className="text-amber-900 font-black text-xs">{d.pending + d.failed}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        </div>
      )}

      {driverDetail && (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-60 flex items-center justify-center p-4" onClick={() => setDriverDetail(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h3 className="text-sm font-black text-slate-900 uppercase">{driverDetail.driverName}</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase">Entregas del {new Date(selectedDate + 'T00:00:00').toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' })}</p>
              </div>
              <button onClick={() => setDriverDetail(null)} className="p-2 rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <IconX className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-y-auto custom-scrollbar flex-1">
              {isLoadingDriverDetail ? (
                <p className="px-6 py-10 text-center text-slate-400 text-sm font-bold uppercase">Cargando...</p>
              ) : driverDetail.packages.length === 0 ? (
                <p className="px-6 py-10 text-center text-slate-400 text-sm font-bold uppercase">Este conductor no tiene entregas asignadas ese día.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-2 font-black text-slate-400 uppercase">ID</th>
                      <th className="px-4 py-2 font-black text-slate-400 uppercase">Cliente</th>
                      <th className="px-4 py-2 font-black text-slate-400 uppercase">Dirección</th>
                      <th className="px-4 py-2 text-center font-black text-slate-400 uppercase">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {driverDetail.packages.map(pkg => (
                      <tr key={pkg.id} onClick={() => openPackageDetail(pkg.id)} className="hover:bg-slate-50 cursor-pointer transition-colors">
                        <td className="px-4 py-2.5 font-bold text-slate-900">{pkg.id}</td>
                        <td className="px-4 py-2.5 text-slate-600">{(pkg as any).clientName || '—'}</td>
                        <td className="px-4 py-2.5 text-slate-600">{pkg.recipientAddress}, {pkg.recipientCommune}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`px-2 py-1 rounded-md text-[10px] font-black uppercase ${CLOSURE_STATUS_STYLES[pkg.status as string] || defaultStatusStyle}`}>
                            {pkg.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedPackageDetail && (
        <PackageDetailModal pkg={selectedPackageDetail} onClose={() => setSelectedPackageDetail(null)} />
      )}
    </div>
  );
};
