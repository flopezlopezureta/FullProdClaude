import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../services/api';
import { IconMap, IconChevronRight, IconChevronLeft, IconClock, IconUser, IconAlertTriangle, IconCheckCircle } from '../Icon';
import { MAP_TILE_URL, MAP_TILE_ATTRIBUTION, MAP_TILE_OPTIONS } from '../../constants';

declare const L: any;

interface SectorProjection {
  id: string;
  comuna: string;
  sector: string;
  geometry: any;
  color?: string;
  volume: number;
  clients: { [clientName: string]: number };
}

const ProjectionMap: React.FC = () => {
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const layerGroupRef = useRef<any>(null);

  const [dateOption, setDateOption] = useState<'tomorrow' | 'next_business' | 'today' | 'custom'>('tomorrow');
  const [customDate, setCustomDate] = useState<string>(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  });
  const [projections, setProjections] = useState<SectorProjection[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSector, setSelectedSector] = useState<SectorProjection | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Compute actual date string to send to backend
  const getSelectedDateString = () => {
    const today = new Date();
    if (dateOption === 'today') {
      return today.toISOString().split('T')[0];
    } else if (dateOption === 'tomorrow') {
      const tomorrow = new Date();
      tomorrow.setDate(today.getDate() + 1);
      return tomorrow.toISOString().split('T')[0];
    } else if (dateOption === 'next_business') {
      const nextBusiness = new Date();
      const day = today.getDay();
      let daysToAdd = 1;
      if (day === 5) daysToAdd = 3;      // Friday -> Monday
      else if (day === 6) daysToAdd = 2; // Saturday -> Monday
      nextBusiness.setDate(today.getDate() + daysToAdd);
      return nextBusiness.toISOString().split('T')[0];
    } else {
      return customDate;
    }
  };

  const selectedDate = getSelectedDateString();

  // Load projection data from backend
  const fetchProjections = async () => {
    setLoading(true);
    try {
      const data = await api.getPackageProjection(selectedDate);
      setProjections(data);
    } catch (err) {
      console.error('Error fetching package projection:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProjections();
  }, [dateOption, customDate]);

  // Initialize Leaflet Map
  useEffect(() => {
    if (mapContainerRef.current && !mapRef.current) {
      mapRef.current = L.map(mapContainerRef.current, {
        zoomControl: false
      }).setView([-33.4489, -70.6693], 11); // Center on Santiago

      L.tileLayer(MAP_TILE_URL, {
        attribution: MAP_TILE_ATTRIBUTION,
        ...MAP_TILE_OPTIONS
      }).addTo(mapRef.current);

      L.control.zoom({ position: 'topleft' }).addTo(mapRef.current);
      layerGroupRef.current = L.layerGroup().addTo(mapRef.current);
    }
  }, []);

  // Update Map polygons whenever projections change
  useEffect(() => {
    if (!mapRef.current || !layerGroupRef.current) return;

    // Clear previous layers
    layerGroupRef.current.clearLayers();

    const bounds: any[] = [];

    // Helper to get color based on volume
    const getLoadColor = (volume: number) => {
      if (volume > 40) return '#ef4444';      // Red (Critical load)
      if (volume >= 15) return '#f59e0b';     // Yellow/Orange (Moderate load)
      return '#22c55e';                       // Green (Low load)
    };

    projections.forEach(proj => {
      if (!proj.geometry) return;

      const color = getLoadColor(proj.volume);

      // Create Leaflet Polygon
      const polygon = L.geoJSON(proj.geometry, {
        style: {
          fillColor: color,
          weight: 2,
          opacity: 0.85,
          color: '#ffffff',
          fillOpacity: 0.45,
          dashArray: '3'
        }
      });

      // Prepare Popup Content
      const clientListHtml = Object.entries(proj.clients)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, val]) => `
          <div class="flex justify-between text-xs text-slate-600 my-0.5">
            <span class="font-medium">${name}</span>
            <span class="bg-slate-100 px-1.5 py-0.2 rounded font-bold">${val} paq.</span>
          </div>
        `).join('') || '<div class="text-xs text-slate-400">Sin clientes proyectados</div>';

      const popupContent = `
        <div class="p-2 font-sans min-w-[200px]">
          <h4 class="font-bold text-sm text-slate-800 border-b pb-1 mb-1.5">${proj.comuna}</h4>
          <p class="text-xs text-slate-500 mb-1">Sector: <span class="font-semibold text-slate-700">${proj.sector}</span></p>
          <div class="flex items-center gap-1.5 mb-2.5">
            <span class="text-xs text-slate-500">Volumen Proyectado:</span>
            <span class="text-xs font-bold px-2 py-0.5 rounded text-white" style="background-color: ${color}">
              ${proj.volume} paquetes
            </span>
          </div>
          <div class="mt-2">
            <p class="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1">Principales Clientes</p>
            ${clientListHtml}
          </div>
        </div>
      `;

      polygon.bindPopup(popupContent);

      // Mouse interactive behavior
      polygon.on('mouseover', function (e: any) {
        const layer = e.target;
        layer.setStyle({
          fillOpacity: 0.65,
          weight: 3
        });
      });

      polygon.on('mouseout', function (e: any) {
        const layer = e.target;
        layer.setStyle({
          fillOpacity: 0.45,
          weight: 2
        });
      });

      polygon.on('click', () => {
        setSelectedSector(proj);
      });

      layerGroupRef.current.addLayer(polygon);

      // Collect bounds to fit map
      try {
        const layerBounds = polygon.getBounds();
        if (layerBounds && layerBounds.isValid()) {
          bounds.push(layerBounds);
        }
      } catch (err) {}
    });

    // Fit map to show all rendered sectors
    if (bounds.length > 0) {
      const groupBounds = L.latLngBounds(bounds);
      if (groupBounds.isValid()) {
        mapRef.current.fitBounds(groupBounds, { padding: [40, 40] });
      }
    }
  }, [projections]);

  // Sort sectors by descending load
  const sortedSectors = [...projections].sort((a, b) => b.volume - a.volume);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
      
      {/* Upper Control Bar */}
      <div className="bg-slate-50 p-4 border-b border-slate-200 flex flex-col md:flex-row items-center justify-between gap-4 shrink-0 z-20">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl shadow-inner">
            <IconMap className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800">Proyección de Carga por Sectores</h2>
            <p className="text-xs text-slate-500">Planifica la flota y rutas según el volumen esperado</p>
          </div>
        </div>

        {/* Date Selector */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setDateOption('today')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 ${
              dateOption === 'today'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            Hoy
          </button>
          <button
            onClick={() => setDateOption('tomorrow')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 ${
              dateOption === 'tomorrow'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            Mañana
          </button>
          <button
            onClick={() => setDateOption('next_business')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold transition-all duration-200 ${
              dateOption === 'next_business'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            Siguiente Día Hábil
          </button>
          
          <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-2 py-1.5">
            <input
              type="date"
              value={customDate}
              onChange={(e) => {
                setCustomDate(e.target.value);
                setDateOption('custom');
              }}
              className="text-xs font-medium text-slate-700 outline-none border-none cursor-pointer bg-transparent"
            />
          </div>

          <button
            onClick={fetchProjections}
            className="p-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-500 transition-colors"
            title="Refrescar datos"
          >
            <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 11l3-3 3 3m-3-3v12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main Map + Sidebar Content Area */}
      <div className="flex-1 flex overflow-hidden relative">
        
        {/* Leaflet Map */}
        <div ref={mapContainerRef} className="flex-1 h-full z-10" />

        {/* Collapsable Right Sidebar */}
        <div
          className={`bg-white border-l border-slate-200 flex flex-col transition-all duration-300 z-20 ${
            isSidebarOpen ? 'w-80' : 'w-0'
          } overflow-hidden shrink-0 relative`}
        >
          {/* Header */}
          <div className="p-4 border-b border-slate-100 flex items-center justify-between shrink-0">
            <h3 className="font-bold text-slate-800 text-sm">Resumen de Carga</h3>
            <span className="text-xs bg-indigo-50 text-indigo-700 font-bold px-2 py-0.5 rounded-full">
              {projections.reduce((acc, curr) => acc + curr.volume, 0)} Paquetes Totales
            </span>
          </div>

          {/* Ranking list */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
            {sortedSectors.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-center text-slate-400">
                <IconMap className="w-10 h-10 mb-2 text-slate-300" />
                <p className="text-xs">No hay envíos proyectados para esta fecha.</p>
              </div>
            ) : (
              sortedSectors.map((proj, idx) => {
                const isCritical = proj.volume > 40;
                const isModerate = proj.volume >= 15 && proj.volume <= 40;
                const badgeColor = isCritical
                  ? 'bg-rose-50 text-rose-700 border-rose-100'
                  : isModerate
                  ? 'bg-amber-50 text-amber-700 border-amber-100'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-100';

                return (
                  <button
                    key={proj.id}
                    onClick={() => {
                      setSelectedSector(proj);
                      if (proj.geometry && mapRef.current) {
                        const layer = L.geoJSON(proj.geometry);
                        mapRef.current.fitBounds(layer.getBounds(), { padding: [50, 50] });
                      }
                    }}
                    className={`w-full text-left p-3 rounded-xl border transition-all duration-200 ${
                      selectedSector?.id === proj.id
                        ? 'border-indigo-500 bg-indigo-50/30 ring-1 ring-indigo-500'
                        : 'border-slate-150 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-slate-400 font-bold tracking-wider uppercase">#{idx + 1} Sector</p>
                        <p className="font-semibold text-slate-800 text-sm truncate">{proj.comuna}</p>
                        <p className="text-xs text-slate-500 truncate">{proj.sector}</p>
                      </div>
                      <span className={`text-xs font-bold px-2 py-1 rounded-lg border shrink-0 ${badgeColor}`}>
                        {proj.volume} paq.
                      </span>
                    </div>

                    {/* Show top clients inside sector if expanded/selected */}
                    {selectedSector?.id === proj.id && (
                      <div className="mt-3 pt-3 border-t border-slate-200/60 space-y-1.5 animate-fade-in">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Detalle de Clientes</p>
                        {Object.entries(proj.clients).length === 0 ? (
                          <p className="text-xs text-slate-400">Sin clientes</p>
                        ) : (
                          Object.entries(proj.clients)
                            .sort((a, b) => b[1] - a[1])
                            .map(([name, count]) => (
                              <div key={name} className="flex justify-between text-xs text-slate-600">
                                <span className="truncate pr-2">{name}</span>
                                <span className="font-semibold text-slate-800 shrink-0">{count} paq.</span>
                              </div>
                            ))
                        )}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Sidebar Toggle Tab Button */}
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-30 bg-white border border-slate-200 shadow-md p-1.5 rounded-l-xl hover:bg-slate-50 transition-colors text-slate-500"
        >
          {isSidebarOpen ? <IconChevronRight className="w-5 h-5" /> : <IconChevronLeft className="w-5 h-5" />}
        </button>

      </div>
    </div>
  );
};

export default ProjectionMap;
