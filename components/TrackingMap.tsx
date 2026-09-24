
import React, { useEffect, useRef } from 'react';
import { MAP_TILE_URL, MAP_TILE_ATTRIBUTION } from '../constants';

declare const L: any;

interface TrackingMapProps {
  destLat: number | null;
  destLng: number | null;
  driverLat?: number | null;
  driverLng?: number | null;
  status: string;
}

const TrackingMap: React.FC<TrackingMapProps> = ({ destLat, destLng, driverLat, driverLng, status }) => {
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markerGroupRef = useRef<any>(null);

  useEffect(() => {
    if (mapContainerRef.current && !mapRef.current) {
      mapRef.current = L.map(mapContainerRef.current).setView([-33.4489, -70.6693], 12);
      L.tileLayer(MAP_TILE_URL, {
        attribution: MAP_TILE_ATTRIBUTION
      }).addTo(mapRef.current);
      markerGroupRef.current = L.layerGroup().addTo(mapRef.current);
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !markerGroupRef.current) return;

    markerGroupRef.current.clearLayers();
    const bounds: [number, number][] = [];

    // Add destination marker
    if (destLat && destLng && destLat !== 0.000001) {
      const destIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div style="background-color: #ef4444; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 5px rgba(0,0,0,0.3);"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
      L.marker([destLat, destLng], { icon: destIcon }).addTo(markerGroupRef.current).bindPopup('Destino del Pedido');
      bounds.push([destLat, destLng]);
    }

    // Add driver marker if assigned or in transit
    const driverActive = status === 'EN_TRANSITO' || status === 'ASIGNADO';
    if (driverActive && driverLat && driverLng) {
      const driverIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `
          <div style="position: relative;">
            <div style="background-color: #3b82f6; width: 18px; height: 18px; border-radius: 50%; border: 3px solid white; box-shadow: 0 0 10px rgba(59, 130, 246, 0.6); position: relative; z-index: 2;"></div>
            <div style="position: absolute; top: 0; left: 0; width: 18px; height: 18px; background-color: #3b82f6; border-radius: 50%; animation: pulse 2s infinite; opacity: 0.6; z-index: 1;"></div>
          </div>
          <style>
            @keyframes pulse {
              0% { transform: scale(1); opacity: 0.6; }
              100% { transform: scale(2.5); opacity: 0; }
            }
          </style>
        `,
        iconSize: [18, 18],
        iconAnchor: [9, 9]
      });
      L.marker([driverLat, driverLng], { icon: driverIcon }).addTo(markerGroupRef.current).bindPopup('Ubicación del Repartidor (En Tiempo Real)');
      bounds.push([driverLat, driverLng]);
    }

    if (bounds.length > 0) {
      if (bounds.length === 1) {
        mapRef.current.setView(bounds[0], 15);
      } else {
        mapRef.current.fitBounds(bounds, { padding: [70, 70] });
      }
    }
  }, [destLat, destLng, driverLat, driverLng, status]);

  return (
    <div className="rounded-xl overflow-hidden border border-gray-200 shadow-lg">
      <div ref={mapContainerRef} className="h-[350px] w-full z-0" />
      <div className="bg-gray-50 p-3 text-xs text-gray-500 flex justify-around items-center border-t border-gray-200">
        <div className="flex items-center gap-2">
          <div className="w-3.5 h-3.5 rounded-full bg-red-500 border-2 border-white shadow-sm"></div>
          <span className="font-medium text-gray-700">Punto de Entrega</span>
        </div>
        {(status === 'EN_TRANSITO' || status === 'ASIGNADO') && (
          <div className="flex items-center gap-2">
            <div className="relative flex items-center justify-center">
              <div className="w-3.5 h-3.5 rounded-full bg-blue-500 border-2 border-white shadow-sm relative z-10"></div>
              <div className="absolute w-3.5 h-3.5 bg-blue-500 rounded-full animate-ping opacity-40"></div>
            </div>
            <span className="font-medium text-gray-700">Repartidor en Tiempo Real</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default TrackingMap;
