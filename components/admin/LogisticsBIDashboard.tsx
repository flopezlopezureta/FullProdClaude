import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../services/api';
import { 
  IconRefresh, 
  IconTrendingUp, 
  IconClock, 
  IconAward, 
  IconCalendar,
  IconChevronDown,
  IconChevronUp,
  IconZap,
  IconCheckCircle,
  IconAlertTriangle,
  IconLoader,
  IconUser,
  IconBarChart,
  IconTruck
} from '../Icon';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Legend, Cell
} from 'recharts';
import OperationalTimer from '../OperationalTimer';

interface FleetDriverStatus {
  driver_id: number;
  driver_name: string;
  total_packages: number;
  delivered_packages: number;
  problem_packages: number;
  pending_packages: number;
  is_completed: boolean;
  last_update: string;
}

interface AnalyticsData {
  hourly_flow: Array<{ hour: string; count: number }>;
  driver_efficiency: Array<{ 
    name: string; 
    delivered: number; 
    avg_minutes: number;
    efficiency_score: number;
  }>;
  summary: {
    total_delivered: number;
    avg_delivery_time: number;
    top_driver: string;
    efficiency_trend: string;
  };
}

const LogisticsBIDashboard: React.FC = () => {
  const [systemTimezone, setSystemTimezone] = useState<string>('America/Santiago');
  
  const getTodayWithTimezone = (tz: string) => {
    try {
      // Use Intl.DateTimeFormat for a more reliable ISO-like format
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return formatter.format(new Date());
    } catch (e) {
      // Fallback
      return new Date().toISOString().split('T')[0];
    }
  };
  
  const [selectedDate, setSelectedDate] = useState<string>(getTodayWithTimezone('America/Santiago'));
  const [isAutoDate, setIsAutoDate] = useState(true);
  const [fleet, setFleet] = useState<FleetDriverStatus[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // Fetch system settings to get timezone
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await api.getSystemSettings();
        if (settings.timezone) {
          setSystemTimezone(settings.timezone);
          const today = getTodayWithTimezone(settings.timezone);
          setSelectedDate(today);
        }
      } catch (error) {
        console.error("Error fetching system timezone:", error);
      }
    };
    fetchSettings();
  }, []);

  // Fetch system settings to get timezone
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await api.getSystemSettings();
        if (settings.timezone) {
          setSystemTimezone(settings.timezone);
          setSelectedDate(getTodayWithTimezone(settings.timezone));
        }
      } catch (error) {
        console.error("Error fetching system timezone:", error);
      }
    };
    fetchSettings();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch Fleet Status first (Priority)
      try {
        const fleetData = await api.getFleetStatus(selectedDate);
        setFleet(fleetData);
      } catch (err) {
        console.error("Error fetching fleet status:", err);
      }

      // Then fetch Analytics (Secondary)
      try {
        const analyticsData = await api.getAnalytics(selectedDate);
        setAnalytics(analyticsData);
      } catch (err) {
        console.error("Error fetching analytics:", err);
      }
      
      setLastRefresh(new Date());
    } catch (error) {
      console.error("Critical error fetching BI data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 30s
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [selectedDate, systemTimezone]);

  const stats = useMemo(() => {
    const inRoute = fleet.filter(d => !d.is_completed).length;
    const finished = fleet.filter(d => d.is_completed).length;
    const totalPending = fleet.reduce((sum, d) => sum + Number(d.pending_packages || 0), 0);
    return { inRoute, finished, totalPending };
  }, [fleet]);

  const [progressSortDirection, setProgressSortDirection] = useState<'desc' | 'asc'>('desc');

  const sortedFleet = useMemo(() => {
    const getProgress = (d: FleetDriverStatus) => (d.delivered_packages / d.total_packages) * 100 || 0;
    return [...fleet].sort((a, b) => {
      const diff = getProgress(a) - getProgress(b);
      return progressSortDirection === 'desc' ? -diff : diff;
    });
  }, [fleet, progressSortDirection]);

  return (
    <div className="space-y-6 pb-12">
      {/* Control Header - Clean White */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-indigo-50 rounded-2xl">
            <IconBarChart className="w-6 h-6 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-xl font-black text-slate-800 tracking-tight">Análisis Logístico BI</h2>
            <div className="flex items-center gap-2">
               <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
               <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Inteligencia en Vivo</p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative group">
            <IconCalendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
            <input 
              type="date" 
              value={selectedDate}
              onChange={(e) => {
                setSelectedDate(e.target.value);
                setIsAutoDate(false);
              }}
              className="pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-slate-700 focus:ring-4 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
            />
          </div>
          <button 
            onClick={fetchData}
            className="p-3 bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 rounded-xl transition-all shadow-sm group"
            title="Refrescar datos"
          >
            <IconRefresh className={`w-5 h-5 text-slate-500 group-hover:text-indigo-600 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Operational Pulse & Clock */}
      <OperationalTimer />

      {/* Real-time Fleet Monitor Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Fleet Summary Cards */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4">
               <span className="px-3 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-black rounded-full border border-emerald-100">LIVE</span>
            </div>
            
            <h3 className="font-black text-slate-800 mb-6 text-lg tracking-tight">Estado de Flota</h3>
            
            <div className="space-y-4">
              <div className="group flex items-center justify-between p-4 bg-slate-50 hover:bg-blue-50 rounded-2xl transition-all border border-transparent hover:border-blue-100">
                <div className="flex items-center gap-4">
                  <div className="p-2 bg-blue-100 rounded-lg group-hover:scale-110 transition-transform">
                    <IconTruck className="w-5 h-5 text-blue-600" />
                  </div>
                  <span className="text-sm font-bold text-slate-600">Conductores en Ruta</span>
                </div>
                <span className="text-2xl font-black text-blue-700">{stats.inRoute}</span>
              </div>
              
              <div className="group flex items-center justify-between p-4 bg-slate-50 hover:bg-emerald-50 rounded-2xl transition-all border border-transparent hover:border-emerald-100">
                <div className="flex items-center gap-4">
                  <div className="p-2 bg-emerald-100 rounded-lg group-hover:scale-110 transition-transform">
                    <IconCheckCircle className="w-5 h-5 text-emerald-600" />
                  </div>
                  <span className="text-sm font-bold text-slate-600">Rutas Finalizadas</span>
                </div>
                <span className="text-2xl font-black text-emerald-700">{stats.finished}</span>
              </div>

              <div className="group flex items-center justify-between p-4 bg-slate-50 hover:bg-amber-50 rounded-2xl transition-all border border-transparent hover:border-amber-100">
                <div className="flex items-center gap-4">
                  <div className="p-2 bg-amber-100 rounded-lg group-hover:scale-110 transition-transform">
                    <IconAlertTriangle className="w-5 h-5 text-amber-600" />
                  </div>
                  <span className="text-sm font-bold text-slate-600">Paquetes por Entregar</span>
                </div>
                <span className="text-2xl font-black text-amber-700">{stats.totalPending}</span>
              </div>
            </div>
          </div>

          {/* Efficiency Pulse - Vibrant but cleaner */}
          <div className="bg-gradient-to-br from-indigo-500 to-indigo-700 p-8 rounded-3xl text-white shadow-xl shadow-indigo-100 relative overflow-hidden group">
            <div className="relative z-10">
              <div className="flex items-center justify-between mb-8">
                <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-md">
                   <IconZap className="w-8 h-8 text-yellow-300 animate-pulse" />
                </div>
                <div className="text-right">
                  <p className="text-[10px] opacity-70 uppercase font-black tracking-widest">Pulso Operativo</p>
                  <p className="text-2xl font-black">94% RITMO</p>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between text-xs font-bold">
                  <span className="opacity-80">Eficiencia de Entrega</span>
                  <span className="text-yellow-300">ÓPTIMO</span>
                </div>
                <div className="h-3 bg-white/20 rounded-full overflow-hidden p-0.5 border border-white/10">
                  <div className="h-full bg-gradient-to-r from-yellow-300 to-yellow-500 rounded-full shadow-sm transition-all duration-1000" style={{ width: '94%' }}></div>
                </div>
              </div>
            </div>
            {/* Decoration */}
            <div className="absolute -right-12 -bottom-12 w-48 h-48 bg-white/10 rounded-full blur-3xl group-hover:scale-125 transition-transform duration-700"></div>
          </div>
        </div>

        {/* Driver Detail List - Clean White Table */}
        <div className="lg:col-span-2 bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden flex flex-col">
          <div className="p-6 border-b border-slate-50 flex items-center justify-between bg-slate-50/30">
            <h3 className="font-black text-slate-800 text-lg tracking-tight">Monitor de Flota Detallado</h3>
            <div className="flex gap-4">
               <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-sm shadow-blue-200"></div> 
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">En Ruta</span>
               </div>
               <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-200"></div> 
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-tighter">Finalizado</span>
               </div>
            </div>
          </div>
          <div className="flex-1 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase font-black tracking-[0.1em] text-slate-400 bg-slate-50/50">
                  <th className="px-8 py-5">Conductor</th>
                  <th className="px-8 py-5">
                    <button
                      onClick={() => setProgressSortDirection(prev => prev === 'desc' ? 'asc' : 'desc')}
                      className="flex items-center gap-1.5 hover:text-indigo-600 transition-colors group uppercase tracking-[0.1em]"
                      title={progressSortDirection === 'desc' ? 'Ordenar de menor a mayor' : 'Ordenar de mayor a menor'}
                    >
                      Progreso de Ruta
                      {progressSortDirection === 'desc' ? (
                        <IconChevronDown className="w-3.5 h-3.5 text-indigo-400 group-hover:text-indigo-600" />
                      ) : (
                        <IconChevronUp className="w-3.5 h-3.5 text-indigo-400 group-hover:text-indigo-600" />
                      )}
                    </button>
                  </th>
                  <th className="px-8 py-5 text-center">Entregados</th>
                  <th className="px-8 py-5 text-center">Problemas</th>
                  <th className="px-8 py-5 text-center">Pendientes</th>
                  <th className="px-8 py-5 text-right">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {sortedFleet.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-8 py-20 text-center">
                      <div className="flex flex-col items-center gap-3">
                         <IconLoader className="w-8 h-8 text-slate-200 animate-spin" />
                         <p className="text-slate-400 font-bold">No hay actividad registrada para esta fecha</p>
                      </div>
                    </td>
                  </tr>
                ) : sortedFleet.map((driver) => {
                  const progress = (driver.delivered_packages / driver.total_packages) * 100 || 0;
                  return (
                    <tr key={driver.driver_id} className="hover:bg-slate-50/80 transition-all group">
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-2xl bg-slate-100 flex items-center justify-center group-hover:bg-white transition-colors border border-transparent group-hover:border-slate-200">
                            <IconUser className="w-5 h-5 text-slate-500" />
                          </div>
                          <span className="text-sm font-black text-slate-700">{driver.driver_name}</span>
                        </div>
                      </td>
                      <td className="px-8 py-5">
                        <div className="w-full max-w-[160px]">
                          <div className="flex justify-between text-[10px] font-black mb-1.5">
                            <span className={driver.is_completed ? 'text-emerald-600' : 'text-blue-600'}>{Math.round(progress)}%</span>
                            <span className="text-slate-400">{driver.total_packages} PQTS</span>
                          </div>
                          <div className="h-2 bg-slate-100 rounded-full overflow-hidden p-0.5 border border-slate-200/50">
                            <div 
                              className={`h-full rounded-full transition-all duration-1000 ${driver.is_completed ? 'bg-emerald-500 shadow-sm shadow-emerald-200' : 'bg-blue-500 shadow-sm shadow-blue-200'}`} 
                              style={{ width: `${progress}%` }}
                            ></div>
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-5 text-center">
                        <span className="text-sm font-black text-slate-800">{driver.delivered_packages}</span>
                      </td>
                      <td className="px-8 py-5 text-center">
                        <span className={`text-sm font-black ${driver.problem_packages > 0 ? 'text-red-500' : 'text-slate-300'}`}>
                          {driver.problem_packages}
                        </span>
                      </td>
                      <td className="px-8 py-5 text-center">
                        <span className={`text-sm font-black ${driver.pending_packages > 0 ? 'text-amber-500' : 'text-slate-300'}`}>
                          {driver.pending_packages}
                        </span>
                      </td>
                      <td className="px-8 py-5 text-right">
                        {driver.is_completed ? (
                          <span className="px-3 py-1.5 bg-emerald-50 text-emerald-700 text-[10px] font-black rounded-xl border border-emerald-100">FINALIZADO</span>
                        ) : (
                          <span className="px-3 py-1.5 bg-blue-50 text-blue-700 text-[10px] font-black rounded-xl border border-blue-100">EN RUTA</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Advanced Analytics Section - Light Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hourly Flow Chart */}
        <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="font-black text-slate-800 text-xl tracking-tight">Flujo de Entregas</h3>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Paquetes por Hora</p>
            </div>
            <div className="p-3 bg-indigo-50 rounded-2xl">
              <IconTrendingUp className="w-6 h-6 text-indigo-600" />
            </div>
          </div>
          
          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analytics?.hourly_flow || []}>
                <defs>
                  <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.15}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                  dataKey="hour" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 700 }} 
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 700 }} 
                />
                <Tooltip 
                  contentStyle={{ 
                    borderRadius: '16px', 
                    border: 'none', 
                    boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1)',
                    fontSize: '12px',
                    fontWeight: 'bold',
                    padding: '12px'
                  }} 
                />
                <Area 
                  type="monotone" 
                  dataKey="count" 
                  stroke="#6366f1" 
                  strokeWidth={4}
                  fillOpacity={1} 
                  fill="url(#colorCount)" 
                  name="Paquetes"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Driver Efficiency Ranking */}
        <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h3 className="font-black text-slate-800 text-xl tracking-tight">Ranking de Eficiencia</h3>
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mt-1">Tiempo entre entregas</p>
            </div>
            <div className="p-3 bg-amber-50 rounded-2xl">
              <IconAward className="w-6 h-6 text-amber-600" />
            </div>
          </div>

          <div className="h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics?.driver_efficiency || []} layout="vertical" barSize={32}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                <XAxis type="number" hide />
                <YAxis 
                  dataKey="name" 
                  type="category" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{ fontSize: 10, fill: '#475569', fontWeight: 'bold' }} 
                  width={100}
                />
                <Tooltip 
                   cursor={{ fill: '#f8fafc' }}
                   contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontWeight: 'bold' }}
                />
                <Bar dataKey="efficiency_score" radius={[0, 8, 8, 0]} name="Eficiencia">
                  {(analytics?.driver_efficiency || []).map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={index === 0 ? '#10b981' : '#818cf8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          
          <div className="mt-8 grid grid-cols-2 gap-6">
             <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <p className="text-[10px] text-slate-400 uppercase font-black tracking-widest mb-1">Top Conductor</p>
                <p className="text-base font-black text-emerald-600 truncate">{analytics?.summary?.top_driver || '-'}</p>
             </div>
             <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                <p className="text-[10px] text-slate-400 uppercase font-black tracking-widest mb-1">Media Global</p>
                <p className="text-base font-black text-indigo-600">{analytics?.summary?.avg_delivery_time || 0} min/pqt</p>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LogisticsBIDashboard;
