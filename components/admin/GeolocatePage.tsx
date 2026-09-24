
import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Package } from '../../types';
import { PackageStatus, MAP_TILE_URL, MAP_TILE_ATTRIBUTION } from '../../constants';
import { api, cityCoordinates } from '../../services/api';
import { IconMap, IconRoute, IconLoader, IconMapPin, IconClock, IconSearch } from '../Icon';
import { optimizeMultiDriverRoute } from '../../services/routeOptimizer';

declare const L: any;

const ROUTE_COLORS = [
    '#2563eb', // Blue
    '#dc2626', // Red
    '#16a34a', // Green
    '#d97706', // Orange
    '#9333ea', // Purple
    '#0891b2', // Cyan
    '#db2777', // Pink
    '#4f46e5', // Indigo
    '#ca8a04', // Yellow
    '#0d9488', // Teal
];

const GeolocatePage: React.FC = () => {
    const [packages, setPackages] = useState<Package[]>([]);
    const [driverCount, setDriverCount] = useState(3);
    const [endTime, setEndTime] = useState('21:00');
    const [optimizedRoutes, setOptimizedRoutes] = useState<Package[][]>([]);
    const [isOptimizing, setIsOptimizing] = useState(false);
    const [startCommune, setStartCommune] = useState('Santiago');
    const [customStartLocation, setCustomStartLocation] = useState<{ lat: number, lng: number } | null>(null);
    const [manualSearchQuery, setManualSearchQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    
    // New Filters
    const [dateMode, setDateMode] = useState<'today' | 'all'>('today');
    const [deliveredMode, setDeliveredMode] = useState<'hide' | 'show'>('hide');
    
    const [isGeocoding, setIsGeocoding] = useState(false);
    const [geocodingProgress, setGeocodingProgress] = useState(0);
    const [totalToGeocode, setTotalToGeocode] = useState(0);

    const mapRef = useRef<any>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const layerGroupRef = useRef<any>(null);
    const clusterGroupRef = useRef<any>(null);

    // Derive start location: Use custom dragged location if available, otherwise fallback to commune center
    const startLocation = useMemo(() => {
        if (customStartLocation) return customStartLocation;
        const coords = cityCoordinates[startCommune] || [-33.4489, -70.6693];
        return { lat: coords[0], lng: coords[1] };
    }, [startCommune, customStartLocation]);

    const fetchPackages = async () => {
        try {
            let fetchedPackages: Package[] = [];
            const today = new Date();
            const todayStr = today.toISOString().split('T')[0];

            // Fetch pending and active packages
            const statusFilter = [
                PackageStatus.Pending, 
                PackageStatus.Assigned, 
                PackageStatus.PickedUp, 
                PackageStatus.InTransit,
                PackageStatus.Delayed,
                PackageStatus.Problem
            ].join(',');

            if (dateMode === 'today') {
                const { packages: active } = await api.getPackages({ limit: 0, includeHistory: false, statusFilter, startDate: todayStr, endDate: todayStr });
                fetchedPackages = active;
            } else {
                const { packages: active } = await api.getPackages({ limit: 0, includeHistory: false, statusFilter });
                fetchedPackages = active;
            }

            if (deliveredMode === 'show') {
                 const { packages: extra } = await api.getPackages({ 
                    limit: 0, 
                    includeHistory: false,
                    statusFilter: [PackageStatus.Delivered, PackageStatus.Returned, PackageStatus.Cancelled, PackageStatus.Rescheduled].join(','), 
                    startDate: todayStr, 
                    endDate: todayStr 
                 });
                 fetchedPackages = [...fetchedPackages, ...extra];
            }
            
            setPackages(fetchedPackages);
            // Keep optimized routes if they exist, but they might be stale. 
            // For now, we clear them to force re-optimization if data changes significantly.
            // setOptimizedRoutes([]); 
        } catch (error) {
            console.error("Failed to fetch packages", error);
        }
    };

    useEffect(() => {
        fetchPackages();
    }, [dateMode, deliveredMode]);

    useEffect(() => {
        if (mapContainerRef.current && !mapRef.current) {
            mapRef.current = L.map(mapContainerRef.current).setView([-33.4489, -70.6693], 11);
            L.tileLayer(MAP_TILE_URL, {
                attribution: MAP_TILE_ATTRIBUTION
            }).addTo(mapRef.current);
            layerGroupRef.current = L.layerGroup().addTo(mapRef.current);
            clusterGroupRef.current = L.markerClusterGroup({
                showCoverageOnHover: false,
                spiderfyOnMaxZoom: true,
                maxClusterRadius: 40
            }).addTo(mapRef.current);
        }
        return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
    }, []);

    // Helper to draw the real street path using OSRM
    const drawRoutePath = async (routePackages: Package[], color: string) => {
        if (routePackages.length === 0) return;
        
        const points = [{ ...startLocation }];
        routePackages.forEach(pkg => {
            if (pkg.destLatitude && pkg.destLongitude) {
                points.push({ lat: pkg.destLatitude, lng: pkg.destLongitude });
            }
        });

        const geometry = await api.getRoutePolyline(points);
        
        if (geometry && geometry.length > 0) {
            const polyline = L.polyline(geometry, { color, weight: 4, opacity: 0.8 });
            layerGroupRef.current.addLayer(polyline);
        }
    };
    
    const handlePackageDragEnd = async (pkg: Package, newLat: number, newLng: number) => {
        // 1. Update local state immediately for responsiveness
        setPackages(prev => prev.map(p => p.id === pkg.id ? { ...p, destLatitude: newLat, destLongitude: newLng } : p));
        
        // 2. Update backend
        try {
            await api.updatePackage(pkg.id, { destLatitude: newLat, destLongitude: newLng });
            console.log(`Updated location for ${pkg.id}`);
        } catch (error) {
            console.error("Failed to update package location", error);
            alert("Error al guardar la nueva ubicación del paquete.");
        }
    };

    const handleStartLocationDragEnd = (newLat: number, newLng: number) => {
        setCustomStartLocation({ lat: newLat, lng: newLng });
    };

    useEffect(() => {
        if (!mapRef.current || !layerGroupRef.current) return;

        layerGroupRef.current.clearLayers();
        const bounds: [number, number][] = [];

        // --- Draw Start Point (Bodega) ---
        const warehouseIcon = L.divIcon({
            className: 'custom-marker-warehouse',
            html: `<div style="background-color: #0f172a; color: white; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 4px 6px rgba(0,0,0,0.4); cursor: grab;"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4 8 4v14"/><path d="M10 9a3 3 0 0 1 6 0v6h-6v-6"/><path d="M9 21v-6a3 3 0 0 1 6 0v6"/></svg></div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 32]
        });
        
        const startMarker = L.marker([startLocation.lat, startLocation.lng], { 
            icon: warehouseIcon,
            draggable: true, // Enable dragging for warehouse
            zIndexOffset: 1000 
        })
        .bindPopup(`<b>Centro de Distribución</b><br/>Arrastra para ajustar ubicación.`);
        
        startMarker.on('dragend', (e: any) => {
            const { lat, lng } = e.target.getLatLng();
            handleStartLocationDragEnd(lat, lng);
        });
        
        clusterGroupRef.current.clearLayers();
        layerGroupRef.current.clearLayers();
        layerGroupRef.current.addLayer(startMarker); // Add back the start marker

        const createIcon = (color: string, number?: number, isApprox: boolean = false) => {
             const border = isApprox ? '2px dashed #ff9800' : '2px solid white';
             const shadow = isApprox ? '0 0 8px rgba(255, 152, 0, 0.6)' : '0 2px 4px rgba(0,0,0,0.3)';
             return L.divIcon({
                className: 'custom-marker',
                html: `<div style="background-color: ${color}; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; border: ${border}; box-shadow: ${shadow}; font-size: 12px; cursor: grab;">${number || ''}</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12]
            });
        };

        const renderMarker = (pkg: Package, color: string, number?: number) => {
            let lat = pkg.destLatitude;
            let lng = pkg.destLongitude;
            let isApprox = false;

            // Fallback if no precise coords or geocoding failed (0.000001)
            if (!lat || !lng || lat === 0.000001) {
                let base = null;
                if (pkg.recipientCommune && cityCoordinates[pkg.recipientCommune]) {
                    base = cityCoordinates[pkg.recipientCommune];
                } else if (pkg.recipientCommune && cityCoordinates[pkg.recipientCommune.toUpperCase()]) {
                    base = cityCoordinates[pkg.recipientCommune.toUpperCase()];
                }
                if (!base && pkg.recipientCity && cityCoordinates[pkg.recipientCity]) {
                    base = cityCoordinates[pkg.recipientCity];
                }
                if (!base) {
                    base = [-33.4489, -70.6693]; // Santiago default
                }
                const offset = (Math.random() - 0.5) * 0.02; 
                lat = base[0] + offset;
                lng = base[1] + offset;
                isApprox = true;
            }

            if (!lat || !lng) return;

            const marker = L.marker([lat, lng], { 
                icon: createIcon(color, number, isApprox),
                draggable: true 
            });

            // HOVER TOOLTIP (PREMIUM UI)
            marker.bindTooltip(`
                <div style="padding: 4px; font-family: Inter, sans-serif;">
                    <div style="font-weight: 800; color: #1e293b; font-size: 11px;">${pkg.recipientName}</div>
                    <div style="color: #64748b; font-size: 10px;">${pkg.recipientAddress}</div>
                    ${isApprox ? '<div style="color: #f59e0b; font-size: 9px; font-weight: bold; margin-top: 2px;">⚠️ UBICACIÓN APROXIMADA</div>' : ''}
                </div>
            `, {
                direction: 'top',
                offset: [0, -12],
                opacity: 0.9
            });

            marker.bindPopup(`
                <div style="min-width: 180px; font-family: Inter, sans-serif; padding: 2px;">
                    <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px; margin-bottom: 8px;">
                        <span style="font-weight: 800; color: #2563eb; font-size: 12px;">ID: ${pkg.id.slice(-6)}</span>
                        <span style="font-size: 10px; color: #94a3b8; font-weight: 600;">${pkg.status}</span>
                    </div>
                    <div style="margin-bottom: 4px;"><span style="color: #94a3b8; font-size: 10px;">Para:</span> <b style="color: #1e293b; font-size: 12px;">${pkg.recipientName}</b></div>
                    <div style="margin-bottom: 12px;"><span style="color: #94a3b8; font-size: 10px;">Dir:</span> <span style="color: #64748b; font-size: 11px;">${pkg.recipientAddress}, ${pkg.recipientCommune}</span></div>
                    ${isApprox ? '<div style="background: #fffbeb; color: #92400e; padding: 6px; border-radius: 4px; font-size: 10px; margin-bottom: 10px; border: 1px solid #fef3c7;">⚠️ El sistema no pudo encontrar la dirección exacta. Se muestra una ubicación estimada en la ciudad.</div>' : ''}
                </div>
            `);

            marker.on('dragend', (e: any) => {
                const { lat, lng } = e.target.getLatLng();
                handlePackageDragEnd(pkg, lat, lng);
            });

            clusterGroupRef.current.addLayer(marker);
        };

        // Filter packages to render based on deliveredMode
        const filteredPackages = deliveredMode === 'show' 
            ? packages 
            : packages.filter(p => ![PackageStatus.Delivered, PackageStatus.Returned, PackageStatus.Cancelled, PackageStatus.Rescheduled].includes(p.status as PackageStatus));

        if (optimizedRoutes.length > 0) {
            optimizedRoutes.forEach((route, routeIndex) => {
                const color = ROUTE_COLORS[routeIndex % ROUTE_COLORS.length];
                drawRoutePath(route, color); // Draw lines
                route.forEach((pkg, pkgIndex) => {
                    renderMarker(pkg, color, pkgIndex + 1);
                });
            });
            // Draw other packages (like delivered or problems) that are NOT in optimized routes
            const optimizedIds = new Set(optimizedRoutes.flat().map(p => p.id));
            filteredPackages.filter(p => !optimizedIds.has(p.id)).forEach(pkg => {
                let color = '#94a3b8'; // Default grey
                if (pkg.status === PackageStatus.Delivered) color = '#3b82f6';
                else if (pkg.status === PackageStatus.Problem) color = '#f59e0b';
                else if (pkg.status === PackageStatus.Cancelled) color = '#ef4444';
                
                renderMarker(pkg, color, undefined);
            });
        } else {
             filteredPackages.forEach(pkg => {
                let color = '#dc2626'; // Red for Pending
                if (pkg.status === PackageStatus.Delivered) color = '#3b82f6';
                else if (pkg.status === PackageStatus.Assigned) color = '#10b981';
                else if (pkg.status === PackageStatus.InTransit) color = '#8b5cf6';
                else if (pkg.status === PackageStatus.Problem) color = '#f59e0b';
                else if (pkg.status === PackageStatus.Cancelled || pkg.status === PackageStatus.Returned) color = '#94a3b8';
                
                renderMarker(pkg, color);
            });
        }

        // Only fit bounds if we haven't customized the start location recently (to avoid jumping)
        // For now, we fit bounds on initial load or massive changes
        if (bounds.length > 0 && !customStartLocation) {
            bounds.push([startLocation.lat, startLocation.lng]);
            // Debounce fitBounds slightly
            // mapRef.current.fitBounds(bounds, { padding: [50, 50] }); 
        } else if (!customStartLocation) {
             mapRef.current.setView([startLocation.lat, startLocation.lng], 12);
        }

    }, [packages, optimizedRoutes, startLocation, customStartLocation]); // Re-render when these change

    const handleOptimize = () => {
        const pendingPackages = packages.filter(p => p.status === PackageStatus.Pending);
        if (pendingPackages.length === 0) return;
        setIsOptimizing(true);
        // Small delay to allow UI to update
        setTimeout(() => {
            const routes = optimizeMultiDriverRoute(pendingPackages, driverCount, startLocation, endTime);
            setOptimizedRoutes(routes);
            setIsOptimizing(false);
        }, 500);
    };
    
    const handleAutoGeolocate = async () => {
        const unmappedPackages = packages.filter(p => !p.destLatitude || !p.destLongitude);
        if (unmappedPackages.length === 0) return;
        setIsGeocoding(true);
        setTotalToGeocode(unmappedPackages.length);
        setGeocodingProgress(0);
        
        // Process sequentially to avoid rate limits
        for (let i = 0; i < unmappedPackages.length; i++) {
            const pkg = unmappedPackages[i];
            try {
                // Triggering an update with address info forces backend to try re-geocoding
                await api.updatePackage(pkg.id, { 
                    recipientAddress: pkg.recipientAddress, 
                    recipientCommune: pkg.recipientCommune, 
                    recipientCity: pkg.recipientCity 
                });
                setGeocodingProgress(i + 1);
                // Small delay
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                console.warn(`Failed to geolocate ${pkg.id}`, e);
            }
        }
        setIsGeocoding(false);
        fetchPackages(); // Refresh data to get new coords
    };

    const handleManualSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!manualSearchQuery.trim()) return;
        setIsSearching(true);
        
        try {
            // Use nominatim search directly for map centering
            const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(manualSearchQuery + ', Chile')}`);
            const data = await response.json();
            if (data && data.length > 0) {
                const { lat, lon } = data[0];
                if (mapRef.current) {
                    mapRef.current.setView([lat, lon], 16);
                    // Optional: Add a temporary marker to show result
                    L.popup()
                        .setLatLng([lat, lon])
                        .setContent(`<b>Resultado:</b><br>${data[0].display_name}`)
                        .openOn(mapRef.current);
                }
            } else {
                alert("Dirección no encontrada.");
            }
        } catch (error) {
            console.error("Search failed", error);
        } finally {
            setIsSearching(false);
        }
    };

    const unmappedCount = packages.filter(p => !p.destLatitude || !p.destLongitude).length;
    const totalOptimized = optimizedRoutes.reduce((sum, r) => sum + r.length, 0);
    const unassignedCount = packages.length - totalOptimized;

    return (
        <div className="flex flex-col h-[calc(100vh-4rem)]">
            <div className="bg-[var(--background-secondary)] shadow-sm p-3 flex flex-col gap-3 border-b border-[var(--border-primary)] z-10">
                {/* Top Bar: Title and Actions */}
                <div className="flex flex-wrap justify-between items-center gap-3">
                    <div className="flex items-center gap-2">
                        <IconMap className="w-6 h-6 text-[var(--brand-primary)]" />
                        <div>
                            <h1 className="text-lg font-bold text-[var(--text-primary)]">Rutas Inteligentes</h1>
                            <p className="text-xs text-[var(--text-muted)]">
                                {packages.length} pendientes 
                                {optimizedRoutes.length > 0 && <span className="text-green-600 ml-1 font-bold">({totalOptimized} asignados)</span>}
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 flex-wrap">
                        <select 
                            value={dateMode} 
                            onChange={(e) => setDateMode(e.target.value as 'today' | 'all')}
                            className="bg-white border border-[var(--border-secondary)] text-xs font-bold px-2 py-1.5 rounded-lg focus:outline-none"
                        >
                            <option value="today">Solo de Hoy</option>
                            <option value="all">Atrasados + Hoy</option>
                        </select>
                        <select 
                            value={deliveredMode} 
                            onChange={(e) => setDeliveredMode(e.target.value as 'hide' | 'show')}
                            className="bg-white border border-[var(--border-secondary)] text-xs font-bold px-2 py-1.5 rounded-lg focus:outline-none"
                        >
                            <option value="hide">Ocultar Entregados</option>
                            <option value="show">Mostrar Entregados</option>
                        </select>

                        {unmappedCount > 0 && !isGeocoding && (
                            <button onClick={handleAutoGeolocate} className="flex items-center gap-2 px-3 py-1.5 bg-orange-100 text-orange-700 rounded text-xs font-bold border border-orange-300">
                                <IconMapPin className="w-3 h-3"/> Geolocalizar Faltantes ({unmappedCount})
                            </button>
                        )}
                        {isGeocoding && <span className="text-xs text-orange-600 font-mono">Procesando {geocodingProgress}/{totalToGeocode}...</span>}

                        <div className="flex items-center gap-2 bg-[var(--background-muted)] px-3 py-1.5 rounded-lg border border-[var(--border-secondary)]">
                            <div className="flex flex-col">
                                <span className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Choferes</span>
                                <input type="number" min="1" max="10" value={driverCount} onChange={(e) => setDriverCount(Math.max(1, parseInt(e.target.value) || 1))} className="w-12 bg-transparent font-bold text-sm focus:outline-none text-center" />
                            </div>
                            <div className="w-px h-6 bg-gray-300 mx-2"></div>
                            <div className="flex flex-col">
                                <span className="text-[10px] text-[var(--text-muted)] uppercase font-bold">Hora Fin</span>
                                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="bg-transparent font-bold text-sm focus:outline-none" />
                            </div>
                        </div>

                        <button 
                            onClick={handleOptimize}
                            disabled={packages.length === 0 || isOptimizing}
                            className="flex items-center gap-2 px-4 py-2 bg-[var(--brand-primary)] text-white rounded-md text-sm font-bold shadow-md hover:bg-[var(--brand-secondary)] transition-colors"
                        >
                            {isOptimizing ? <IconLoader className="w-4 h-4 animate-spin"/> : <IconRoute className="w-4 h-4"/>}
                            CALCULAR
                        </button>
                    </div>
                </div>
                
                {/* Secondary Bar: Location Tools */}
                <div className="flex flex-wrap items-center gap-3 text-sm bg-[var(--background-muted)] p-2 rounded-md border border-[var(--border-secondary)]">
                     <div className="flex items-center gap-2 border-r border-gray-300 pr-3 mr-1">
                        <span className="text-xs font-bold text-[var(--text-secondary)] uppercase">Bodega Base:</span>
                        <select value={startCommune} onChange={(e) => { setStartCommune(e.target.value); setCustomStartLocation(null); }} className="bg-transparent font-semibold text-[var(--text-primary)] focus:outline-none">
                            <option value="Santiago">Santiago</option>
                            <option value="Providencia">Providencia</option>
                            <option value="Lampa">Lampa</option>
                            <option value="Maipú">Maipú</option>
                            <option value="Puente Alto">Puente Alto</option>
                        </select>
                         {customStartLocation && <span className="text-[10px] text-blue-600 bg-blue-100 px-1 rounded">(Ajustada)</span>}
                    </div>
                    
                    <form onSubmit={handleManualSearch} className="flex-1 flex items-center gap-2">
                         <IconSearch className="w-4 h-4 text-[var(--text-muted)]"/>
                         <input 
                            type="text" 
                            value={manualSearchQuery}
                            onChange={e => setManualSearchQuery(e.target.value)}
                            placeholder="Buscar dirección para ubicar en mapa..."
                            className="flex-1 bg-transparent border-none focus:ring-0 text-sm"
                         />
                         <button type="submit" disabled={!manualSearchQuery || isSearching} className="text-xs font-bold text-[var(--brand-primary)] hover:underline disabled:opacity-50">
                            {isSearching ? 'Buscando...' : 'IR'}
                         </button>
                    </form>
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 relative">
                    <div ref={mapContainerRef} className="h-full w-full" style={{zIndex: 1}} />
                    <div className="absolute bottom-4 left-4 z-[400] bg-white/90 backdrop-blur p-2 rounded shadow text-xs pointer-events-none">
                        <p className="font-bold text-slate-700">Tips de Ajuste:</p>
                        <ul className="list-disc pl-4 space-y-0.5 text-slate-600">
                            <li>Arrastra la <b>Bodega</b> (negro) para fijar inicio.</li>
                            <li>Arrastra los <b>Paquetes</b> (colores) para corregir dirección.</li>
                            <li>Usa el buscador arriba para encontrar calles.</li>
                        </ul>
                    </div>
                </div>
                
                {/* Route Summary Panel */}
                {optimizedRoutes.length > 0 && (
                <div className="w-72 bg-[var(--background-secondary)] border-l border-[var(--border-primary)] flex flex-col overflow-y-auto custom-scrollbar z-20 shadow-xl">
                    <div className="p-3 bg-[var(--background-muted)] border-b font-bold text-sm text-[var(--text-primary)]">
                        Planificación ({totalOptimized} paq.)
                    </div>
                    <div className="p-3 space-y-3">
                        {optimizedRoutes.map((route, i) => {
                            const estimatedMin = route.length * 15; // rough estimate: travel + 10m stop
                            const finishTime = new Date();
                            finishTime.setMinutes(finishTime.getMinutes() + estimatedMin);
                            
                            return (
                            <div key={i} className="border rounded-lg overflow-hidden shadow-sm">
                                <div className="p-2 flex justify-between items-center text-white" style={{ backgroundColor: ROUTE_COLORS[i % ROUTE_COLORS.length] }}>
                                    <span className="font-bold text-sm">Chofer {i + 1}</span>
                                    <span className="text-xs bg-white/20 px-1.5 rounded">{route.length} paq</span>
                                </div>
                                <div className="p-2 bg-[var(--background-secondary)]">
                                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] mb-1">
                                        <IconClock className="w-3 h-3"/>
                                        <span>Termina aprox: <b>{finishTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</b></span>
                                    </div>
                                    <div className="max-h-32 overflow-y-auto text-xs space-y-1 border-t pt-1 mt-1">
                                        {route.map((p, idx) => (
                                            <div key={p.id} className="truncate flex gap-1 text-[var(--text-secondary)]">
                                                <span className="font-mono opacity-50">{idx+1}.</span>
                                                {p.recipientAddress}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )})}
                         {unassignedCount > 0 && (
                            <div className="p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                                <b>{unassignedCount} paquetes sin asignar</b> por horario.
                            </div>
                        )}
                    </div>
                </div>
                )}
            </div>
        </div>
    );
};

export default GeolocatePage;
