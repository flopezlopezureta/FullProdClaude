
import React, { useEffect, useRef, useState } from 'react';
import type { Package } from '../../types';
import { IconX, IconRoute, IconCheckCircle } from '../Icon';
import { optimizeRoute } from '../../services/routeOptimizer';
import { cityCoordinates } from '../../services/api';
import { MAP_TILE_URL, MAP_TILE_ATTRIBUTION } from '../../constants';

declare const L: any;

interface RouteOptimizerModalProps {
    packages: Package[];
    onClose: () => void;
    onApplyRoute: (sortedPackages: Package[]) => void;
    userLocation?: { lat: number, lng: number };
}

const RouteOptimizerModal: React.FC<RouteOptimizerModalProps> = ({ packages, onClose, onApplyRoute, userLocation }) => {
    const [optimizedPackages, setOptimizedPackages] = useState<Package[]>([]);
    const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);
    const mapRef = useRef<any>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const routingControlRef = useRef<any>(null);

    useEffect(() => {
        // Calculate initial optimized route on mount
        const sorted = optimizeRoute(packages, userLocation);
        setOptimizedPackages(sorted);
    }, [packages, userLocation]);

    // Initialize Map
    useEffect(() => {
        if (mapContainerRef.current && !mapRef.current) {
            mapRef.current = L.map(mapContainerRef.current).setView([-33.45, -70.67], 12);
            L.tileLayer(MAP_TILE_URL, {
                attribution: MAP_TILE_ATTRIBUTION
            }).addTo(mapRef.current);
        }
        return () => {
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
            }
        }
    }, []);

    // Draw Route on Map using OSRM (Real Streets)
    useEffect(() => {
        if (!mapRef.current || optimizedPackages.length === 0) return;

        // Remove existing control
        if (routingControlRef.current) {
            mapRef.current.removeControl(routingControlRef.current);
            routingControlRef.current = null;
        }

        const waypoints = [];

        // Add Start Location
        if (userLocation) {
            waypoints.push(L.latLng(userLocation.lat, userLocation.lng));
        }

        // Add Packages
        optimizedPackages.forEach((pkg) => {
            let lat = pkg.destLatitude;
            let lng = pkg.destLongitude;
             // Fallback visual logic if no coords or geocoding failed (0.000001)
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
                 lat = base[0]; 
                 lng = base[1];
            }

            if (lat && lng) {
                waypoints.push(L.latLng(lat, lng));
            }
        });

        if (waypoints.length < 2 && !userLocation) return; 

        try {
            routingControlRef.current = L.Routing.control({
                waypoints: waypoints,
                plan: L.Routing.plan(waypoints, {
                    createMarker: function(i: number, waypoint: any) {
                        const isStart = userLocation && i === 0;
                        
                        if (isStart) {
                             return L.marker(waypoint.latLng, {
                                draggable: false,
                                icon: L.divIcon({
                                    html: `<div style="background-color: #10b981; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.3);"></div>`,
                                    className: ''
                                })
                            }).bindPopup("<b>Punto de Partida</b>");
                        }
    
                        const pkgIndex = userLocation ? i - 1 : i;
                        const pkg = optimizedPackages[pkgIndex];
                        if (!pkg) return null; // Safety check
    
                        return L.marker(waypoint.latLng, {
                            draggable: false,
                            icon: L.divIcon({
                                className: 'custom-numbered-icon',
                                html: `<div style="background-color: #4f46e5; color: white; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">${pkgIndex + 1}</div>`,
                                iconSize: [24, 24],
                                iconAnchor: [12, 12]
                            })
                        }).bindPopup(`<b>#${pkgIndex + 1}: ${pkg.recipientAddress}</b><br>${pkg.recipientName}`);
                    }
                }),
                lineOptions: {
                    styles: [{ color: '#6366f1', weight: 5, opacity: 0.8 }]
                },
                show: false, // Hide instruction box
                addWaypoints: false,
                draggableWaypoints: false,
                fitSelectedRoutes: true,
                routeWhileDragging: false
            }).addTo(mapRef.current);
        } catch (e) {
            console.error("Routing error", e);
        }

    }, [optimizedPackages, userLocation]);

    const handleConfirm = () => {
        onApplyRoute(optimizedPackages);
    };

    // Drag and Drop Handlers
    const onDragStart = (index: number) => {
        setDraggedItemIndex(index);
    };

    const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault(); // Necessary for onDrop to fire
    };

    const onDrop = (index: number) => {
        if (draggedItemIndex === null || draggedItemIndex === index) return;

        const newItems = [...optimizedPackages];
        const draggedItem = newItems[draggedItemIndex];
        newItems.splice(draggedItemIndex, 1);
        newItems.splice(index, 0, draggedItem);

        setOptimizedPackages(newItems);
        setDraggedItemIndex(null);
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-60 z-50 flex justify-center items-center p-4" onClick={onClose}>
            <div className="bg-[var(--background-secondary)] rounded-xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
                <header className="flex items-center justify-between p-4 border-b border-[var(--border-primary)]">
                    <div className="flex items-center gap-2">
                        <div className="p-2 bg-indigo-100 rounded-full text-indigo-600">
                            <IconRoute className="w-6 h-6" />
                        </div>
                        <div>
                            <h3 className="text-lg font-bold text-[var(--text-primary)]">Ruta Optimizada</h3>
                            <p className="text-xs text-[var(--text-secondary)]">Arrastra y suelta para reordenar la ruta.</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-full text-[var(--text-muted)] hover:bg-[var(--background-hover)]"><IconX className="w-6 h-6" /></button>
                </header>

                <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                    {/* Map Section */}
                    <div className="w-full md:w-2/3 bg-slate-100 relative">
                        <div ref={mapContainerRef} className="h-full w-full z-0" />
                        <div className="absolute bottom-4 left-4 z-[400] bg-white/90 backdrop-blur p-3 rounded-lg shadow-md text-xs">
                            <div className="flex items-center gap-2 mb-1"><span className="w-3 h-3 bg-green-500 rounded-full"></span> Tu Ubicación</div>
                            <div className="flex items-center gap-2"><span className="w-3 h-3 bg-indigo-600 rounded-full"></span> Paradas</div>
                            <div className="flex items-center gap-2 mt-1 text-slate-500">Ruta calculada por calles (OSRM)</div>
                        </div>
                        {/* Hide the default routing container that sometimes persists */}
                        <style>{`
                            .leaflet-routing-container { display: none !important; }
                        `}</style>
                    </div>

                    {/* List Section */}
                    <div className="w-full md:w-1/3 border-l border-[var(--border-primary)] flex flex-col bg-[var(--background-secondary)]">
                        <div className="p-3 bg-[var(--background-muted)] border-b border-[var(--border-primary)]">
                            <h4 className="font-semibold text-sm text-[var(--text-secondary)]">Secuencia de Entrega</h4>
                        </div>
                        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
                            {optimizedPackages.map((pkg, index) => (
                                <div 
                                    key={pkg.id} 
                                    draggable
                                    onDragStart={() => onDragStart(index)}
                                    onDragOver={onDragOver}
                                    onDrop={() => onDrop(index)}
                                    className={`flex items-start p-3 bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-lg hover:bg-[var(--background-hover)] transition-colors group cursor-move ${draggedItemIndex === index ? 'opacity-50 bg-indigo-50' : ''}`}
                                >
                                    <div className="flex-shrink-0 w-6 h-6 bg-indigo-100 text-indigo-700 rounded-full flex items-center justify-center text-xs font-bold mt-0.5 group-hover:bg-indigo-600 group-hover:text-white transition-colors pointer-events-none">
                                        {index + 1}
                                    </div>
                                    <div className="ml-3 min-w-0 pointer-events-none">
                                        <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{pkg.recipientAddress}</p>
                                        <p className="text-xs text-[var(--text-secondary)] truncate">{pkg.recipientName}</p>
                                        <p className="text-[10px] text-[var(--text-muted)] font-mono">{pkg.recipientCommune}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <footer className="p-4 border-t border-[var(--border-primary)] bg-[var(--background-muted)] rounded-b-xl flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-[var(--text-secondary)] bg-[var(--background-secondary)] border border-[var(--border-secondary)] rounded-md hover:bg-[var(--background-hover)]">
                        Cancelar
                    </button>
                    <button onClick={handleConfirm} className="flex items-center gap-2 px-6 py-2 text-sm font-bold text-white bg-[var(--brand-primary)] rounded-md hover:bg-[var(--brand-secondary)] shadow-sm">
                        <IconCheckCircle className="w-5 h-5" />
                        Aplicar Orden a mi Lista
                    </button>
                </footer>
            </div>
        </div>
    );
};

export default RouteOptimizerModal;
