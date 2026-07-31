import React, { useState, useEffect, useContext } from 'react';
import { api } from '../services/api';
import { AuthContext } from '../contexts/AuthContext';
import { getLocalDateString } from '../utils/dateUtils';
import { 
  IconRefresh, IconUser, IconCheckCircle, IconAlertTriangle, 
  IconClock, IconAward, IconChevronDown, IconChevronUp, IconBell
} from './Icon';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell 
} from 'recharts';

type ControlViewMode = 'CLOSURES' | 'CADENCE' | 'CHRONOMETRY' | 'SLA';

export const FleetControlCenter: React.FC = () => {
  const auth = useContext(AuthContext);
  const tz = auth?.systemSettings?.timezone || 'America/Santiago';

  const [selectedDate, setSelectedDate] = useState<string>(getLocalDateString());
  const [viewMode, setViewMode] = useState<ControlViewMode>('CLOSURES');
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);
  const [data, setData] = useState<{
    date: string;
    closures: any[];
    cadence: any[];
    chronometry: any[];
  }>({ date: '', closures: [], cadence: [], chronometry: [] });
  const [notifyingDriverId, setNotifyingDriverId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const fetchData = async (targetDate?: string) => {
    const dateToFetch = targetDate || selectedDate;
    try {
      setIsLoading(true);
      const res = await api.getFleetControlCenter(dateToFetch);
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
  }, [selectedDate]);

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

  const totalDrivers = data.closures.length;
  const closedInAppCount = data.closures.filter(c => c.hasClosedInApp).length;
  const pendingClosureCount = data.closures.filter(c => !c.hasClosedInApp && c.totalPackages > 0).length;

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
            </div>

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

              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-lg text-[10px] font-black text-slate-600 uppercase">
                <span>Conductores Activos: {totalDrivers}</span>
                <span>•</span>
                <span className="text-emerald-700">Cerraron: {closedInAppCount}</span>
              </div>
            </div>
          </div>

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
                    {data.closures.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-5 py-8 text-center text-slate-400 font-bold uppercase">
                          No hay actividad de conductores registrada para el día de hoy
                        </td>
                      </tr>
                    ) : (
                      data.closures.map((driver) => {
                        const isClosed = driver.hasClosedInApp;
                        const isPending = !isClosed && driver.pending > 0;
                        return (
                          <tr key={driver.driverId} className="hover:bg-slate-50 transition-colors">
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
                                  Sin Entregas
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
                            <td className="px-5 py-3 text-right">
                              {!isClosed && (
                                <button
                                  onClick={() => handleNotifyClosure(driver.driverId, driver.driverName)}
                                  disabled={notifyingDriverId === driver.driverId}
                                  className="px-3 py-1.5 text-[10px] font-black bg-amber-500 hover:bg-amber-600 text-white rounded-lg shadow-sm transition-all flex items-center gap-1.5 ml-auto"
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
                    <BarChart data={data.cadence}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="driverName" tick={{ fontSize: 10, fontWeight: 'bold' }} />
                      <YAxis tick={{ fontSize: 10, fontWeight: 'bold' }} unit=" min" />
                      <Tooltip 
                        contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }}
                      />
                      <Bar dataKey="avgMinutesBetweenDeliveries" name="Minutos Promedio" radius={[6, 6, 0, 0]}>
                        {data.cadence.map((entry, index) => (
                          <Cell 
                            key={`cell-${index}`} 
                            fill={entry.avgMinutesBetweenDeliveries > 30 ? '#ef4444' : entry.avgMinutesBetweenDeliveries > 18 ? '#f59e0b' : '#10b981'} 
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
                    {data.cadence.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-center text-slate-400 font-bold uppercase">
                          No hay suficientes entregas secuenciales hoy para calcular la cadencia
                        </td>
                      </tr>
                    ) : (
                      data.cadence.map((c) => (
                        <tr key={c.driverId} className="hover:bg-slate-50 transition-colors">
                          <td className="px-5 py-3 font-bold text-slate-900 uppercase">{c.driverName}</td>
                          <td className="px-5 py-3 text-center font-bold text-slate-700">{c.deliveredCount} entregas</td>
                          <td className="px-5 py-3 text-center font-black text-indigo-700">{c.avgMinutesBetweenDeliveries} min/paquete</td>
                          <td className="px-5 py-3 text-center font-bold text-slate-600">{c.maxMinutesGap} min</td>
                          <td className="px-5 py-3 text-right">
                            {c.idleAlertsCount > 0 ? (
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
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                <table className="w-full text-left">
                  <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-wider">
                    <tr>
                      <th className="px-5 py-3">Conductor</th>
                      <th className="px-5 py-3 text-center">Hora Primera Entrega (Inicio)</th>
                      <th className="px-5 py-3 text-center">Hora Última Entrega (Fin)</th>
                      <th className="px-5 py-3 text-center">Horas en Ruta Activa</th>
                      <th className="px-5 py-3 text-right">Entregas Totales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {data.chronometry.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-center text-slate-400 font-bold uppercase">
                          No hay registros de jornada para el día seleccionado
                        </td>
                      </tr>
                    ) : (
                      data.chronometry.map((chrono) => {
                        const first = chrono.firstActivity ? new Date(chrono.firstActivity).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
                        const last = chrono.lastActivity ? new Date(chrono.lastActivity).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
                        return (
                          <tr key={chrono.driverId} className="hover:bg-slate-50 transition-colors">
                            <td className="px-5 py-3 font-bold text-slate-900 uppercase">{chrono.driverName}</td>
                            <td className="px-5 py-3 text-center font-bold text-emerald-700">{first}</td>
                            <td className="px-5 py-3 text-center font-bold text-blue-700">{last}</td>
                            <td className="px-5 py-3 text-center font-black text-slate-800">{chrono.totalHoursActive} hrs</td>
                            <td className="px-5 py-3 text-right font-black text-slate-900">{chrono.deliveredCount} entregas</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VISTA 4: SLA Y RENDIMIENTO */}
          {viewMode === 'SLA' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.closures.map((d) => {
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
    </div>
  );
};
