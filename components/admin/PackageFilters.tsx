
import React from 'react';
import { User } from '../../types';
import { IconSearch, IconPackage, IconCalendar, IconFileSpreadsheet, IconRefresh, IconAlertTriangle } from '../Icon';

interface PackageFiltersProps {
  onOpenCreateModal: () => void;
  onOpenImportModal: () => void;
  onRefresh: () => void;
  canCreate?: boolean;
  canImport?: boolean;
  isSyncing?: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  drivers: User[];
  driverFilter: string;
  onDriverChange: (driverId: string) => void;
  communes: string[];
  communeFilter: string;
  onCommuneChange: (commune: string) => void;
  cities: string[];
  cityFilter: string;
  onCityChange: (city: string) => void;
  startDate: string;
  onStartDateChange: (date: string) => void;
  endDate: string;
  onEndDateChange: (date: string) => void;
  flexFilter: 'all' | 'flexed' | 'not_flexed';
  onFlexFilterChange: (filter: 'all' | 'flexed' | 'not_flexed') => void;
  sourceFilter: 'all' | 'ml' | 'web' | 'falabella_seller' | 'falabella_directo';
  onSourceFilterChange: (filter: 'all' | 'ml' | 'web' | 'falabella_seller' | 'falabella_directo') => void;
  quickFilter: 'all' | 'closed' | 'cancelled' | 'rescheduled';
  onQuickFilterChange: (filter: 'all' | 'closed' | 'cancelled' | 'rescheduled') => void;
  clients: User[];
  clientFilter: string;
  onClientChange: (clientId: string) => void;
  onOpenQuickStatus: () => void;
  assignmentFilter: 'all' | 'all_assigned' | 'first' | 'reassigned';
  onAssignmentFilterChange: (filter: 'all' | 'all_assigned' | 'first' | 'reassigned') => void;
  dateType: 'created' | 'egress';
  onDateTypeChange: (type: 'created' | 'egress') => void;
  onToggleAlerts?: () => void;
  showAlerts?: boolean;
  alertCount?: number;
}

const PackageFilters: React.FC<PackageFiltersProps> = ({
  onOpenCreateModal,
  onOpenImportModal,
  onRefresh,
  canCreate = true,
  canImport = true,
  isSyncing = false,
  searchQuery,
  onSearchChange,
  drivers,
  driverFilter,
  onDriverChange,
  communes,
  communeFilter,
  onCommuneChange,
  cities,
  cityFilter,
  onCityChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  flexFilter,
  onFlexFilterChange,
  sourceFilter,
  onSourceFilterChange,
  quickFilter,
  onQuickFilterChange,
  clients,
  clientFilter,
  onClientChange,
  onOpenQuickStatus,
  assignmentFilter,
  onAssignmentFilterChange,
  dateType,
  onDateTypeChange,
  onToggleAlerts,
  showAlerts,
  alertCount = 0,
}) => {
  const [isClientSearchOpen, setIsClientSearchOpen] = React.useState(false);
  const [clientSearchTerm, setClientSearchTerm] = React.useState('');
  const clientRef = React.useRef<HTMLDivElement>(null);
  
  const [isCommuneSearchOpen, setIsCommuneSearchOpen] = React.useState(false);
  const [communeSearchTerm, setCommuneSearchTerm] = React.useState('');
  const communeRef = React.useRef<HTMLDivElement>(null);

  const [isDriverSearchOpen, setIsDriverSearchOpen] = React.useState(false);
  const [driverSearchTerm, setDriverSearchTerm] = React.useState('');
  const driverRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
        if (clientRef.current && !clientRef.current.contains(event.target as Node)) {
            setIsClientSearchOpen(false);
        }
        if (communeRef.current && !communeRef.current.contains(event.target as Node)) {
            setIsCommuneSearchOpen(false);
        }
        if (driverRef.current && !driverRef.current.contains(event.target as Node)) {
            setIsDriverSearchOpen(false);
        }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredClients = clients.filter(c => c.name.toLowerCase().includes(clientSearchTerm.toLowerCase()));
  const selectedClient = clients.find(c => c.id === clientFilter);
  
  const filteredCommunes = communes.filter(c => c.toLowerCase().includes(communeSearchTerm.toLowerCase()));

  const filteredDrivers = drivers.filter(d => d.name.toLowerCase().includes(driverSearchTerm.toLowerCase()));
  const selectedDriver = drivers.find(d => d.id === driverFilter);

  const selectClasses = "block w-full pl-3 pr-10 py-2 border border-[var(--border-secondary)] rounded-md leading-5 bg-[var(--background-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] focus:border-[var(--brand-primary)] sm:text-sm";
  
  return (
    <div className="p-4 sm:px-6 border-b border-[var(--border-primary)]">
      <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-end">
        <div className="relative flex-grow sm:flex-grow-0 sm:w-64 min-w-[200px]">
          <input
            type="text"
            placeholder="Buscar por ID, destinatario, dirección o FLEX..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="block w-full pl-10 pr-3 py-2 border border-[var(--border-secondary)] rounded-md leading-5 bg-[var(--background-secondary)] placeholder-[var(--text-muted)] focus:outline-none focus:placeholder-[var(--text-secondary)] focus:ring-1 focus:ring-[var(--brand-primary)] focus:border-[var(--brand-primary)] sm:text-sm"
          />
           <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <IconSearch className="h-5 w-5 text-[var(--text-muted)]" />
          </div>
        </div>
        <div className="flex-shrink-0">
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Desde</label>
            <div className="relative">
                <div className="flex items-center justify-between w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm bg-white text-left cursor-pointer text-xs font-bold">
                    <span className={startDate ? "text-gray-900" : "text-gray-400"}>
                        {startDate ? new Date(startDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'DD/MM/AAAA'}
                    </span>
                    <IconCalendar className="h-4 w-4 text-gray-400" />
                </div>
                <input 
                    type="date" 
                    value={startDate} 
                    onChange={e => onStartDateChange(e.target.value)} 
                    className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer"
                    aria-label="Seleccionar fecha de inicio"
                />
            </div>
        </div>
        <div className="flex-shrink-0">
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Hasta</label>
            <div className="relative">
                <div className="flex items-center justify-between w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm bg-white text-left cursor-pointer text-xs font-bold">
                    <span className={endDate ? "text-gray-900" : "text-gray-400"}>
                        {endDate ? new Date(endDate.replace(/-/g, '/')).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' }) : 'DD/MM/AAAA'}
                    </span>
                    <IconCalendar className="h-4 w-4 text-gray-400" />
                </div>
                <input 
                    type="date" 
                    value={endDate} 
                    onChange={e => onEndDateChange(e.target.value)} 
                    className="absolute top-0 left-0 w-full h-full opacity-0 cursor-pointer"
                    aria-label="Seleccionar fecha de fin"
                />
            </div>
        </div>
        <div className="flex-shrink-0 relative" ref={driverRef}>
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Buscador Conductor</label>
            <div 
                className={`${selectClasses} font-bold text-xs !py-1.5 cursor-pointer flex justify-between items-center bg-white`}
                onClick={() => setIsDriverSearchOpen(!isDriverSearchOpen)}
            >
                <span className="truncate max-w-[150px]">
                    {selectedDriver ? selectedDriver.name.toUpperCase() : 'TODOS LOS CONDUCTORES'}
                </span>
                <span className="text-gray-400 ml-2 text-[10px]">▼</span>
            </div>
            
            {isDriverSearchOpen && (
                <div className="absolute z-50 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-2xl">
                    <div className="p-2 border-b border-gray-100 bg-gray-50 rounded-t-md">
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Escribe para buscar..."
                                className="w-full pl-8 pr-2 py-1.5 text-xs font-bold border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-inner"
                                value={driverSearchTerm}
                                onChange={(e) => setDriverSearchTerm(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                autoFocus
                            />
                            <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none">
                                <IconSearch className="w-4 h-4 text-gray-400" />
                            </div>
                        </div>
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                        <div 
                            className={`px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors ${!driverFilter ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700'}`}
                            onClick={() => { onDriverChange(''); setIsDriverSearchOpen(false); setDriverSearchTerm(''); }}
                        >
                            TODOS LOS CONDUCTORES
                        </div>
                        {filteredDrivers.map(driver => (
                            <div 
                                key={driver.id}
                                className={`px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors ${driverFilter === driver.id ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700 border-t border-gray-50'}`}
                                onClick={() => { onDriverChange(driver.id); setIsDriverSearchOpen(false); setDriverSearchTerm(''); }}
                            >
                                {driver.name.toUpperCase()}
                            </div>
                        ))}
                        {filteredDrivers.length === 0 && (
                            <div className="px-3 py-4 text-xs font-bold text-gray-400 text-center">No se encontraron conductores</div>
                        )}
                    </div>
                </div>
            )}
        </div>
        <div className="flex-shrink-0 relative" ref={clientRef}>
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Buscador Cliente</label>
            <div 
                className={`${selectClasses} font-bold text-xs !py-1.5 cursor-pointer flex justify-between items-center bg-white`}
                onClick={() => setIsClientSearchOpen(!isClientSearchOpen)}
            >
                <span className="truncate max-w-[150px]">
                    {selectedClient ? selectedClient.name.toUpperCase() : 'TODOS LOS CLIENTES'}
                </span>
                <span className="text-gray-400 ml-2 text-[10px]">▼</span>
            </div>
            
            {isClientSearchOpen && (
                <div className="absolute z-50 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-2xl">
                    <div className="p-2 border-b border-gray-100 bg-gray-50 rounded-t-md">
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Escribe para buscar..."
                                className="w-full pl-8 pr-2 py-1.5 text-xs font-bold border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-inner"
                                value={clientSearchTerm}
                                onChange={(e) => setClientSearchTerm(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                autoFocus
                            />
                            <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none">
                                <IconSearch className="w-4 h-4 text-gray-400" />
                            </div>
                        </div>
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                        <div 
                            className={`px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors ${!clientFilter ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700'}`}
                            onClick={() => { onClientChange(''); setIsClientSearchOpen(false); setClientSearchTerm(''); }}
                        >
                            TODOS LOS CLIENTES
                        </div>
                        {filteredClients.map(client => (
                            <div 
                                key={client.id}
                                className={`px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors ${clientFilter === client.id ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700 border-t border-gray-50'}`}
                                onClick={() => { onClientChange(client.id); setIsClientSearchOpen(false); setClientSearchTerm(''); }}
                            >
                                {client.name.toUpperCase()}
                            </div>
                        ))}
                        {filteredClients.length === 0 && (
                            <div className="px-3 py-4 text-xs font-bold text-gray-400 text-center">No se encontraron clientes</div>
                        )}
                    </div>
                </div>
            )}
        </div>
        <div className="flex-shrink-0 w-32">
          <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Origen</label>
          <select id="source-filter" value={sourceFilter} onChange={(e) => onSourceFilterChange(e.target.value as any)} className={`${selectClasses} font-bold text-xs !py-1.5`} aria-label="Filtrar por origen">
            <option value="all">TODOS</option>
            <option value="ml">MERCADO LIBRE</option>
            <option value="web">WEB / MANUAL</option>
            <option value="falabella_seller">FALABELLA SELLER CENTER</option>
            <option value="falabella_directo">FALABELLA DIRECTO</option>
          </select>
        </div>
        <div className="flex-shrink-0 w-32">
          <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Flex</label>
          <select id="flex-filter" value={flexFilter} onChange={(e) => onFlexFilterChange(e.target.value as any)} className={`${selectClasses} font-bold text-xs !py-1.5`} aria-label="Filtrar por Flex">
            <option value="all">TODOS</option>
            <option value="flexed">FLEXEADOS</option>
            <option value="not_flexed">NO FLEXEADOS</option>
          </select>
        </div>
        <div className="flex-shrink-0 w-40">
          <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Filtro Rápido</label>
          <select id="quick-filter" value={quickFilter} onChange={(e) => onQuickFilterChange(e.target.value as any)} className={`${selectClasses} font-bold text-xs !py-1.5`} aria-label="Filtro rápido">
            <option value="all">TODOS</option>
            <option value="closed">CERRADOS</option>
            <option value="cancelled">CANCELADOS</option>
            <option value="rescheduled">REPROGRAMADOS</option>
          </select>
        </div>
        <div className="flex-shrink-0">
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Región</label>
          <select id="city-filter" value={cityFilter} onChange={(e) => onCityChange(e.target.value)} className={`${selectClasses} font-bold text-xs !py-1.5`} aria-label="Filtrar por ciudad">
            <option value="">TODAS LAS REGIONES</option>
            {!cities.includes('Región Metropolitana') && <option value="Región Metropolitana">REGIÓN METROPOLITANA</option>}
            {!cities.includes('Metropolitana') && <option value="Metropolitana">METROPOLITANA</option>}
            {!cities.includes('Santiago') && <option value="Santiago">SANTIAGO</option>}
            {cities.map(city => {
              if (['Región Metropolitana', 'Metropolitana', 'Santiago'].includes(city)) return null;
              return <option key={city} value={city}>{city.toUpperCase()}</option>;
            })}
          </select>
        </div>
        <div className="flex-shrink-0 relative" ref={communeRef}>
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Buscador Comuna</label>
            <div 
                className={`${selectClasses} font-bold text-xs !py-1.5 cursor-pointer flex justify-between items-center bg-white`}
                onClick={() => setIsCommuneSearchOpen(!isCommuneSearchOpen)}
            >
                <span className="truncate max-w-[150px]">
                    {communeFilter ? communeFilter.toUpperCase() : 'TODAS LAS COMUNAS'}
                </span>
                <span className="text-gray-400 ml-2 text-[10px]">▼</span>
            </div>
            
            {isCommuneSearchOpen && (
                <div className="absolute z-50 mt-1 w-64 bg-white border border-gray-200 rounded-md shadow-2xl right-0 sm:right-auto">
                    <div className="p-2 border-b border-gray-100 bg-gray-50 rounded-t-md">
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Escribe para buscar..."
                                className="w-full pl-8 pr-2 py-1.5 text-xs font-bold border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-inner"
                                value={communeSearchTerm}
                                onChange={(e) => setCommuneSearchTerm(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                autoFocus
                            />
                            <div className="absolute inset-y-0 left-0 flex items-center pl-2 pointer-events-none">
                                <IconSearch className="w-4 h-4 text-gray-400" />
                            </div>
                        </div>
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                        <div 
                            className={`px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors ${!communeFilter ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700'}`}
                            onClick={() => { onCommuneChange(''); setIsCommuneSearchOpen(false); setCommuneSearchTerm(''); }}
                        >
                            TODAS LAS COMUNAS
                        </div>
                        {filteredCommunes.map(commune => (
                            <div 
                                key={commune}
                                className={`px-3 py-2.5 text-xs font-bold cursor-pointer transition-colors ${communeFilter === commune ? 'bg-blue-100 text-blue-800' : 'hover:bg-gray-100 text-gray-700 border-t border-gray-50'}`}
                                onClick={() => { onCommuneChange(commune); setIsCommuneSearchOpen(false); setCommuneSearchTerm(''); }}
                            >
                                {commune.toUpperCase()}
                            </div>
                        ))}
                        {filteredCommunes.length === 0 && (
                            <div className="px-3 py-4 text-xs font-bold text-gray-400 text-center">No se encontraron comunas</div>
                        )}
                    </div>
                </div>
            )}
        </div>
        <div className="flex-shrink-0 w-44">
          <select 
            id="assignment-filter" 
            value={assignmentFilter} 
            onChange={(e) => onAssignmentFilterChange(e.target.value as any)} 
            className={`${selectClasses} font-bold text-xs !py-1.5`} 
            aria-label="Filtrar por tipo de asignación"
          >
            <option value="all">MOSTRAR TODO (CON PENDIENTES)</option>
            <option value="all_assigned">TODOS LOS ASIGNADOS</option>
            <option value="first">PRIMERA ASIGNACIÓN</option>
            <option value="reassigned">SOLO REASIGNADOS</option>
          </select>
        </div>

        {/* --- NEW DATE TYPE FILTER --- */}
        <div className="flex-shrink-0">
            <label className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em] mb-1 block">Filtro por Fecha</label>
            <div className="flex bg-white border border-gray-200 rounded-lg p-0.5 shadow-sm h-[38px] items-center">
                <button
                    onClick={() => onDateTypeChange('created')}
                    className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-tighter rounded-md transition-all h-full ${dateType === 'created' ? 'bg-[#007bff] text-white shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                >
                    Creación
                </button>
                <button
                    onClick={() => onDateTypeChange('egress')}
                    className={`px-3 py-1.5 text-[10px] font-black uppercase tracking-tighter rounded-md transition-all h-full ${dateType === 'egress' ? 'bg-[#007bff] text-white shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                >
                    Egreso
                </button>
            </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
            <button
                onClick={onRefresh}
                disabled={isSyncing}
                className={`flex-shrink-0 inline-flex items-center justify-center p-2.5 border border-blue-200 text-blue-600 bg-white rounded-lg hover:bg-blue-50 transition-all shadow-sm ${isSyncing ? 'animate-pulse' : ''}`}
                title="Refrescar Datos"
            >
                <IconRefresh className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
            </button>
            {onToggleAlerts && (
                <button
                    onClick={onToggleAlerts}
                    className={`flex-shrink-0 inline-flex items-center justify-center p-2.5 border rounded-lg transition-all shadow-sm relative ${showAlerts ? 'bg-red-600 border-red-700 text-white' : 'bg-white border-red-200 text-red-600 hover:bg-red-50'}`}
                    title={showAlerts ? "Ocultar Alertas" : "Ver Alertas Críticas"}
                >
                    <IconAlertTriangle className={`w-5 h-5 ${showAlerts ? '' : 'animate-pulse'}`} />
                    {alertCount > 0 && !showAlerts && (
                        <span className="absolute -top-1.5 -right-1.5 bg-red-600 text-white text-[9px] font-black min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center border border-white shadow-sm animate-bounce">
                            {alertCount}
                        </span>
                    )}
                </button>
            )}
            <button
                onClick={onOpenQuickStatus}
                className="flex-shrink-0 inline-flex items-center justify-center px-5 py-2.5 border border-blue-600 text-sm font-black rounded-lg shadow-sm text-white bg-blue-600 hover:bg-blue-700 hover:shadow-md transition-all uppercase tracking-wider"
            >
                <IconSearch className="w-5 h-5 mr-3 -ml-1"/>
                Consultar ID Flex
            </button>
            {canImport && (
            <button
                onClick={onOpenImportModal}
                className="flex-shrink-0 inline-flex items-center justify-center px-5 py-2.5 border border-gray-300 text-sm font-bold rounded-lg shadow-sm text-gray-700 bg-white hover:bg-gray-50 hover:border-gray-400 transition-all uppercase tracking-tight"
            >
                <IconFileSpreadsheet className="w-5 h-5 mr-3 -ml-1 text-emerald-600"/>
                Importar Excel
            </button>
            )}
            {canCreate && (
            <button
                onClick={onOpenCreateModal}
                className="flex-shrink-0 inline-flex items-center justify-center px-5 py-2.5 border-2 border-transparent text-sm font-black rounded-lg shadow-sm text-white bg-[#005fb8] hover:bg-[#004a8f] hover:shadow-lg focus:outline-none transition-all uppercase tracking-widest"
            >
                <IconPackage className="w-5 h-5 mr-3 -ml-1"/>
                Crear Paquete
            </button>
            )}
        </div>
      </div>
    </div>
  );
};

export default PackageFilters;
