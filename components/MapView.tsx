
import React, { useEffect, useRef } from 'react';
import { PackageStatus, MAP_TILE_URL, MAP_TILE_ATTRIBUTION } from '../constants';
import type { Package } from '../types';
import { cityCoordinates } from '../services/api';

// Declare Leaflet in the global scope to avoid TypeScript errors
declare const L: any;

interface MapViewProps {
  packages: Package[];
}

const statusColors: { [key in PackageStatus]: string } = {
  [PackageStatus.Pending]: '#64748b', // slate-500
  [PackageStatus.PickedUp]: '#a855f7', // purple-500
  [PackageStatus.InTransit]: '#3b82f6', // blue-500
  [PackageStatus.Delivered]: '#22c55e', // green-500
  [PackageStatus.Delayed]: '#f59e0b', // yellow-500
  [PackageStatus.Problem]: '#ef4444', // red-500
  [PackageStatus.ReturnPending]: '#d97706', // amber-600
  [PackageStatus.Returned]: '#374151', // gray-700
  [PackageStatus.Cancelled]: '#94a3b8', // slate-400
  [PackageStatus.Rescheduled]: '#fb923c', // orange-400
};


const MapView: React.FC<MapViewProps> = ({ packages }) => {
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const layerGroupRef = useRef<any>(null);

  // Initialize map
  useEffect(() => {
    if (mapContainerRef.current && !mapRef.current) {
        mapRef.current = L.map(mapContainerRef.current).setView([-33.4489, -70.6693], 5); // Center on Chile
        L.tileLayer(MAP_TILE_URL, {
            attribution: MAP_TILE_ATTRIBUTION
        }).addTo(mapRef.current);
        layerGroupRef.current = L.layerGroup().addTo(mapRef.current);
    }
  }, []);

  // Update markers and routes when packages change
  useEffect(() => {
    if (!mapRef.current || !layerGroupRef.current) return;

    // Clear previous layers
    layerGroupRef.current.clearLayers();

    const bounds: [number, number][] = [];

    packages.forEach(pkg => {
        const originCoords = cityCoordinates[pkg.origin];
        const destCoords = cityCoordinates[pkg.recipientCity];

        if (originCoords && destCoords) {
            // Add to bounds for auto-zooming
            bounds.push(originCoords);
            bounds.push(destCoords);

            // Create markers
            const originMarker = L.marker(originCoords).bindPopup(`<b>Origen: ${pkg.id}</b><br/>${pkg.origin}`);
            const destMarker = L.marker(destCoords).bindPopup(`<b>Destino: ${pkg.id}</b><br/>${pkg.recipientName}<br/>Status: ${pkg.status}`);
            
            // Create route line
            const routeLine = L.polyline([originCoords, destCoords], {
                color: statusColors[pkg.status] || '#64748b',
                weight: 3,
                opacity: 0.7,
            });

            // Add to layer group
            layerGroupRef.current.addLayer(originMarker);
            layerGroupRef.current.addLayer(destMarker);
            layerGroupRef.current.addLayer(routeLine);
        }
    });
    
    // Fit map to show all markers
    if (bounds.length > 0) {
        mapRef.current.fitBounds(bounds, { padding: [50, 50] });
    } else {
        // If no packages have coordinates, reset to default view
        mapRef.current.setView([-33.4489, -70.6693], 5);
    }

  }, [packages]);

  return <div ref={mapContainerRef} className="h-[600px] w-full z-0" />;
};

export default MapView;
