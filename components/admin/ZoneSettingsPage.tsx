import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../services/api';
import { DeliveryZone } from '../../types';
import { IconMapPin, IconPlus, IconPencil, IconTrash } from '../Icon';
import ZoneSettingsModal from '../modals/ZoneSettingsModal';
import ConfirmationModal from '../modals/ConfirmationModal';
import { communeGeoJsonData } from '../../services/communesGeo';
import { MAP_TILE_URL } from '../../constants';

declare const L: any;

const zoneColors = [
    'rgba(59, 130, 246, 0.5)', 'rgba(239, 68, 68, 0.5)', 'rgba(34, 197, 94, 0.5)', 
    'rgba(249, 115, 22, 0.5)', 'rgba(168, 85, 247, 0.5)', 'rgba(236, 72, 153, 0.5)',
    'rgba(20, 184, 166, 0.5)', 'rgba(245, 158, 11, 0.5)', 'rgba(107, 114, 128, 0.5)'
];

const ZoneSettingsPage: React.FC = () => {
    const [zones, setZones] = useState<DeliveryZone[]>([]);
    const [isDataLoading, setIsDataLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingZone, setEditingZone] = useState<DeliveryZone | null>(null);
    const [deletingZone, setDeletingZone] = useState<DeliveryZone | null>(null);
    const [selectedCommunesForModal, setSelectedCommunesForModal] = useState<string[]>([]);
    
    const mapRef = useRef<any>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const geoJsonLayersRef = useRef<any>({});
    const zoneLayersRef = useRef<any>(null);

    const fetchZones = async () => {
        setIsDataLoading(true);
        try {
            const data = await api.getDeliveryZones();
            setZones(data.sort((a, b) => a.name.localeCompare(b.name)));
        } catch (error) {
            console.error("Failed to fetch zones", error);
        } finally {
            setIsDataLoading(false);
        }
    };

    useEffect(() => {
        fetchZones();
    }, []);

    // Initialize map
    useEffect(() => {
        if (mapContainerRef.current && !mapRef.current) {
            mapRef.current = L.map(mapContainerRef.current, { center: [-33.45, -70.67], zoom: 9 });
            L.tileLayer(MAP_TILE_URL).addTo(mapRef.current);
            zoneLayersRef.current = L.layerGroup().addTo(mapRef.current);
            setTimeout(() => mapRef.current?.invalidateSize(), 100);
        }
        
        return () => {
             if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
            }
        }
    }, []);

    // Draw base commune layers
    useEffect(() => {
        if (!mapRef.current) return;
        
        const onCommuneClick = (communeName: string) => {
            if (!isModalOpen) return;
            setSelectedCommunesForModal(prev => {
                const newSelection = new Set(prev);
                if (newSelection.has(communeName)) {
                    newSelection.delete(communeName);
                } else {
                    newSelection.add(communeName);
                }
                return Array.from(newSelection);
            });
        };

        // Clear old layers before drawing new ones
        Object.values(geoJsonLayersRef.current).forEach((layer: any) => layer.remove());
        geoJsonLayersRef.current = {};

        L.geoJSON(communeGeoJsonData, {
            style: {
                color: 'var(--text-muted)',
                weight: 1,
                fillColor: 'var(--background-secondary)',
                fillOpacity: 0.2,
            },
            onEachFeature: (feature: any, layer: any) => {
                const communeName = feature.properties.NOM_COM;
                layer.bindTooltip(communeName);
                layer.on({
                    click: () => onCommuneClick(communeName),
                    mouseover: () => layer.setStyle({ weight: 2.5, color: 'var(--brand-primary)' }),
                    mouseout: () => geoJsonLayersRef.current[communeName]?.resetStyle(layer),
                });
                geoJsonLayersRef.current[communeName] = layer;
            }
        }).addTo(mapRef.current);

    }, [isModalOpen]);
    
    // Highlight selected communes when modal is open
    useEffect(() => {
        if (!mapRef.current || !isModalOpen) return;
        
        // Reset all styles first
        Object.values(geoJsonLayersRef.current).forEach((layer: any) => {
            layer.setStyle({ fillColor: 'var(--background-secondary)', fillOpacity: 0.2 });
        });
        
        selectedCommunesForModal.forEach(communeName => {
            const layer = geoJsonLayersRef.current[communeName];
            if (layer) {
                layer.setStyle({ fillColor: 'var(--brand-primary)', fillOpacity: 0.7 });
            }
        });
    }, [selectedCommunesForModal, isModalOpen]);
    
     // Draw existing zones on the map
    useEffect(() => {
        if (!mapRef.current || !zoneLayersRef.current) return;
        
        zoneLayersRef.current.clearLayers();
        
        zones.forEach((zone, index) => {
            const color = zoneColors[index % zoneColors.length];
            const zoneFeatures = communeGeoJsonData.features.filter((feature: any) => 
                zone.communes.includes(feature.properties.NOM_COM)
            );

            if (zoneFeatures.length > 0) {
                L.geoJSON({ type: "FeatureCollection", features: zoneFeatures }, {
                    style: {
                        color: 'transparent',
                        weight: 0,
                        fillColor: color,
                        fillOpacity: 0.5
                    }
                }).bindTooltip(zone.name).addTo(zoneLayersRef.current);
            }
        });
    }, [zones]);

    const handleSaveZone = async (data: Omit<DeliveryZone, 'id' | 'communes'>, id?: string) => {
        const communes = selectedCommunesForModal;
        const saveData = { ...data, communes };
        try {
            if (id) {
                // Fix: Remove 'id' from the second argument to match Omit<DeliveryZone, 'id'>.
                await api.updateDeliveryZone(id, saveData);
            } else {
                await api.createDeliveryZone(saveData);
            }
            fetchZones();
            closeModal();
        } catch (error) {
            console.error("Failed to save zone", error);
        }
    };

    const handleDeleteZone = async () => {
        if (!deletingZone) return;
        try {
            await api.deleteDeliveryZone(deletingZone.id);
            fetchZones();
            setDeletingZone(null);
        } catch (error) {
            console.error("Failed to delete zone", error);
        }
    };

    const openCreateModal = () => {
        setEditingZone(null);
        setSelectedCommunesForModal([]);
        setIsModalOpen(true);
    };

    const openEditModal = (zone: DeliveryZone) => {
        setEditingZone(zone);
        setSelectedCommunesForModal(zone.communes);
        setIsModalOpen(true);
    };
    
    const closeModal = () => {
        setEditingZone(null);
        setIsModalOpen(false);
        setSelectedCommunesForModal([]);
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
                 <div className="flex justify-between items-center mb-4">
                    <p className="text-[var(--text-secondary)]">Define zonas geográficas y asigna tarifas de envío para cada una.</p>
                    <button
                        onClick={openCreateModal}
                        className="inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-secondary)]"
                    >
                        <IconPlus className="w-5 h-5 mr-2 -ml-1"/>
                        Crear Zona
                    </button>
                </div>
                <div className="bg-[var(--background-secondary)] shadow-md rounded-lg max-h-[70vh] overflow-y-auto custom-scrollbar">
                    <div className="divide-y divide-[var(--border-primary)]">
                        {isDataLoading ? (
                            <p className="p-6 text-center text-[var(--text-muted)]">Cargando zonas...</p>
                        ) : zones.length === 0 ? (
                            <div className="p-12 text-center">
                                <IconMapPin className="mx-auto h-12 w-12 text-slate-400" />
                                <h3 className="mt-2 text-sm font-medium text-slate-900">No hay zonas configuradas</h3>
                                <p className="mt-1 text-sm text-slate-500">Crea tu primera zona para empezar.</p>
                            </div>
                        ) : (
                            zones.map(zone => (
                                <div key={zone.id} className="p-3">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <h3 className="font-bold text-lg text-[var(--text-primary)]">{zone.name}</h3>
                                            <p className="text-xs text-[var(--text-muted)] mt-1">Comunas: {zone.communes.slice(0, 3).join(', ')}{zone.communes.length > 3 ? ` y ${zone.communes.length-3} más...` : ''}</p>
                                        </div>
                                        <div className="flex items-center space-x-1">
                                            <button onClick={() => openEditModal(zone)} className="p-2 text-slate-500 hover:text-blue-600 hover:bg-blue-100 rounded-md"><IconPencil className="w-4 h-4" /></button>
                                            <button onClick={() => setDeletingZone(zone)} className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-100 rounded-md"><IconTrash className="w-4 h-4" /></button>
                                        </div>
                                    </div>
                                    <div className="flex justify-around text-center mt-2">
                                        <div><p className="text-xs text-slate-500">En el Día</p><p className="font-semibold">{zone.pricing.sameDay.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</p></div>
                                        <div><p className="text-xs text-slate-500">Express</p><p className="font-semibold">{zone.pricing.express.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</p></div>
                                        <div><p className="text-xs text-slate-500">Next Day</p><p className="font-semibold">{zone.pricing.nextDay.toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}</p></div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
            <div className="bg-[var(--background-secondary)] shadow-md rounded-lg p-2 h-[80vh]">
                <div ref={mapContainerRef} className="h-full w-full rounded-md" style={{ zIndex: 0 }} />
            </div>

            {isModalOpen && (
                <ZoneSettingsModal
                    zone={editingZone}
                    onClose={closeModal}
                    onSave={handleSaveZone}
                    selectedCommunes={selectedCommunesForModal}
                    onCommunesChange={setSelectedCommunesForModal}
                />
            )}
            {deletingZone && (
                <ConfirmationModal
                    title="Eliminar Zona"
                    message={`¿Estás seguro de que quieres eliminar la zona "${deletingZone.name}"?`}
                    confirmText="Eliminar Zona"
                    onClose={() => setDeletingZone(null)}
                    onConfirm={handleDeleteZone}
                />
            )}
        </div>
    );
};

export default ZoneSettingsPage;