// SectorEditorPage.tsx — Editor visual de sectores GIS por comuna
// Usa Leaflet.draw para dibujar polígonos, los guarda en el backend.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../../services/api';
import SearchableSelect from '../SearchableSelect';
import { IconTrash, IconPencil, IconMapPin, IconCheckCircle, IconAlertTriangle, IconLoader, IconMap } from '../Icon';
import { MAP_TILE_URL } from '../../constants';

declare const L: any;

// ── Comunas de la RM (lista estática para el dropdown) ────────────────────────
const COMUNAS_RM = [
  'Alhué','Buin','Calera de Tango','Cerrillos','Cerro Navia','Colina',
  'Conchalí','Curacaví','El Bosque','El Monte','Estación Central',
  'Huechuraba','Independencia','Isla de Maipo','La Cisterna','La Florida',
  'La Granja','La Pintana','La Reina','Lampa','Las Condes','Lo Barnechea',
  'Lo Espejo','Lo Prado','Macul','Maipú','María Pinto','Melipilla',
  'Padre Hurtado','Paine','Pedro Aguirre Cerda','Peñaflor','Peñalolén',
  'Pirque','Providencia','Pudahuel','Puente Alto','Quilicura','Quinta Normal',
  'Recoleta','Renca','San Bernardo','San Joaquín','San José de Maipo',
  'San Miguel','San Pedro','San Ramón','Santiago','Talagante','Tiltil',
  'Vitacura','Ñuñoa',
].sort();

const SECTOR_COLORS = [
  '#4f46e5','#059669','#db2777','#d97706','#2563eb',
  '#7c3aed','#dc2626','#0d9488','#b45309','#0891b2',
];

interface Sector {
  id: string;
  comuna: string;
  sector: string;
  geometry: any;
  color?: string;
  createdAt?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────
const SectorEditorPage: React.FC = () => {
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const drawControlRef = useRef<any>(null);
  const drawnLayersRef = useRef<any>(null);    // FeatureGroup for drawn items
  const comunaLayerRef = useRef<any>(null);    // Layer for selected commune boundary
  const sectorLayersRef = useRef<any[]>([]);   // Painted saved sectors

  const [selectedComuna, setSelectedComuna] = useState('');
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameColor, setRenameColor] = useState('');

  // Geometry editing state
  const [editingGeometryId, setEditingGeometryId] = useState<string | null>(null);
  const editLayerRef = useRef<any>(null);

  // Selected color for new sector
  const [selectedColor, setSelectedColor] = useState('#4f46e5');

  const [showAllGlobal, setShowAllGlobal] = useState(false);

  // Pending polygon waiting for name input
  const pendingLayerRef = useRef<any>(null);
  const [showNameDialog, setShowNameDialog] = useState(false);
  const [newSectorName, setNewSectorName] = useState('');

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Map init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;
    mapRef.current = L.map(mapContainerRef.current, {
      center: [-33.45, -70.67],
      zoom: 10,
      zoomControl: true,
      attributionControl: false,
    });
    L.tileLayer(MAP_TILE_URL).addTo(mapRef.current);

    // FeatureGroup where drawn polygons land
    drawnLayersRef.current = new L.FeatureGroup().addTo(mapRef.current);

    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  // ── Load sectors for selected commune (or all if fetchAll is true) ──
  const loadSectors = useCallback(async (comuna: string, fetchAll = false) => {
    if (!comuna && !fetchAll) return;
    setIsLoading(true);
    try {
      const data = await api.getGisSectors(fetchAll ? undefined : comuna);
      setSectors(data);
    } catch {
      showToast('Error al cargar sectores', false);
    } finally {
      setIsLoading(false);
    }
  }, [showToast]);

  // ── Load commune boundary from backend ─────────────────────────────────────
  const loadComunaBoundary = useCallback(async (comuna: string) => {
    if (!mapRef.current) return;

    // Remove old boundary
    if (comunaLayerRef.current) {
      mapRef.current.removeLayer(comunaLayerRef.current);
      comunaLayerRef.current = null;
    }

    if (!comuna) return;

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/gis/comunas/${encodeURIComponent(comuna)}/geometry`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const feature = await res.json();

      comunaLayerRef.current = L.geoJSON(feature, {
        style: {
          color: '#6366f1',
          weight: 2.5,
          fillColor: '#e0e7ff',
          fillOpacity: 0.15,
          dashArray: '6 4',
        },
      }).addTo(mapRef.current);

      try { mapRef.current.fitBounds(comunaLayerRef.current.getBounds(), { padding: [30, 30] }); } catch {}
    } catch {}
  }, []);

  // ── Paint saved sectors on map ─────────────────────────────────────────────
  const paintSectors = useCallback((sectorList: Sector[], activeEditId?: string | null) => {
    if (!mapRef.current) return;
    // Remove old sector layers
    sectorLayersRef.current.forEach(l => { try { mapRef.current.removeLayer(l); } catch {} });
    sectorLayersRef.current = [];

    sectorList.forEach((s, i) => {
      if (!s.geometry) return;

      // If we are editing another sector's geometry, paint this one as a static light gray background layer
      if (activeEditId) {
        if (s.id === activeEditId) return; // Skip the active editing layer since it's drawn interactively
        try {
          const layer = L.geoJSON(
            { type: 'Feature', geometry: s.geometry, properties: {} },
            {
              style: { color: '#9ca3af', weight: 1, fillColor: '#9ca3af', fillOpacity: 0.1 },
            }
          )
            .bindTooltip(`<b>${s.sector}</b>`, { permanent: false })
            .addTo(mapRef.current);
          sectorLayersRef.current.push(layer);
        } catch {}
        return;
      }

      const color = s.color || SECTOR_COLORS[i % SECTOR_COLORS.length];
      try {
        const layer = L.geoJSON(
          { type: 'Feature', geometry: s.geometry, properties: {} },
          {
            style: { color, weight: 2, fillColor: color, fillOpacity: 0.3 },
          }
        )
          .bindTooltip(`<b>${s.sector}</b><br/><span style="font-size:10px">${s.comuna}</span>`, { permanent: false })
          .addTo(mapRef.current);
        sectorLayersRef.current.push(layer);
      } catch {}
    });
    
    // Auto fit bounds if showing global sectors
    if (sectorList.length > 0 && !activeEditId) {
        try {
            const group = new L.FeatureGroup(sectorLayersRef.current);
            mapRef.current.fitBounds(group.getBounds(), { padding: [30, 30] });
        } catch {}
    }
  }, []);

  // Re-paint whenever sectors or active editing geometry changes
  useEffect(() => { paintSectors(sectors, editingGeometryId); }, [sectors, editingGeometryId, paintSectors]);

  // When commune changes: load boundary + sectors
  useEffect(() => {
    if (!selectedComuna) {
        if (!showAllGlobal) setSectors([]);
        return;
    }
    setShowAllGlobal(false);
    loadComunaBoundary(selectedComuna);
    loadSectors(selectedComuna);
    // Clear pending drawings
    if (drawnLayersRef.current) drawnLayersRef.current.clearLayers();
    stopDrawing();
  }, [selectedComuna]);

  const handleToggleGlobal = async () => {
    const next = !showAllGlobal;
    setShowAllGlobal(next);
    if (next) {
        setSelectedComuna('');
        if (comunaLayerRef.current && mapRef.current) {
            mapRef.current.removeLayer(comunaLayerRef.current);
            comunaLayerRef.current = null;
        }
        await loadSectors('', true);
    } else {
        setSectors([]);
    }
  };

  // ── Draw control ───────────────────────────────────────────────────────────
  const startDrawing = useCallback(() => {
    if (!mapRef.current || !drawnLayersRef.current) return;
    setIsDrawing(true);

    // Remove old control if any
    if (drawControlRef.current) {
      mapRef.current.removeControl(drawControlRef.current);
      drawControlRef.current = null;
    }

    const drawControl = new L.Control.Draw({
      draw: {
        polygon: {
          allowIntersection: false,
          shapeOptions: { color: '#4f46e5', fillColor: '#818cf8', fillOpacity: 0.3 },
        },
        polyline: false,
        rectangle: false,
        circle: false,
        circlemarker: false,
        marker: false,
      },
      edit: { featureGroup: drawnLayersRef.current, remove: false },
    });

    mapRef.current.addControl(drawControl);
    drawControlRef.current = drawControl;

    // Trigger draw:polygon immediately
    new L.Draw.Polygon(mapRef.current, drawControl.options.draw.polygon).enable();

    // Listen for draw:created
    mapRef.current.off('draw:created');
    mapRef.current.on('draw:created', (e: any) => {
      const layer = e.layer;
      drawnLayersRef.current.addLayer(layer);
      pendingLayerRef.current = layer;
      setShowNameDialog(true);
      setNewSectorName('');
      stopDrawing();
    });

    mapRef.current.off('draw:drawstop');
    mapRef.current.on('draw:drawstop', () => {
      setIsDrawing(false);
    });
  }, []);

  const stopDrawing = useCallback(() => {
    setIsDrawing(false);
    if (drawControlRef.current && mapRef.current) {
      try { mapRef.current.removeControl(drawControlRef.current); } catch {}
      drawControlRef.current = null;
    }
  }, []);

  // ── Save new sector ────────────────────────────────────────────────────────
  const handleSaveSector = async () => {
    if (!newSectorName.trim() || !pendingLayerRef.current || !selectedComuna) return;

    const geojson = pendingLayerRef.current.toGeoJSON();
    const geometry = geojson.geometry;

    setIsLoading(true);
    try {
      await api.createGisSector({
        comuna: selectedComuna,
        sector: newSectorName.trim(),
        geometry,
        color: selectedColor,
      });
      setShowNameDialog(false);
      setNewSectorName('');
      setSelectedColor('#4f46e5');
      pendingLayerRef.current = null;
      drawnLayersRef.current?.clearLayers();
      await loadSectors(selectedComuna);
      showToast(`✅ Sector "${newSectorName.trim()}" guardado`);
    } catch (e: any) {
      showToast(e.message || 'Error al guardar', false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelDraw = () => {
    setShowNameDialog(false);
    setNewSectorName('');
    setSelectedColor('#4f46e5');
    pendingLayerRef.current = null;
    drawnLayersRef.current?.clearLayers();
  };

  // ── Delete sector ──────────────────────────────────────────────────────────
  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`¿Eliminar el sector "${name}"?`)) return;
    setIsLoading(true);
    try {
      await api.deleteGisSector(id);
      await loadSectors(selectedComuna, showAllGlobal);
      showToast(`Sector "${name}" eliminado`);
    } catch {
      showToast('Error al eliminar', false);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Rename / Update sector ──────────────────────────────────────────────────
  const handleRename = async (id: string) => {
    if (!renameValue.trim()) return;
    setIsLoading(true);
    try {
      await api.updateGisSector(id, { sector: renameValue.trim(), color: renameColor });
      setRenamingId(null);
      setRenameValue('');
      setRenameColor('');
      await loadSectors(selectedComuna, showAllGlobal);
      showToast('Sector actualizado');
    } catch {
      showToast('Error al actualizar el sector', false);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Geometry Editing Handlers ──────────────────────────────────────────────
  const handleStartEditGeometry = (s: Sector) => {
    if (!mapRef.current) return;
    
    stopDrawing();
    setEditingGeometryId(s.id);
    
    // Create Leaflet layer for interactive polygon editing
    const color = s.color || '#fbbf24';
    let layer: any;
    
    try {
      // 1. Try to instantiate a native L.Polygon / L.MultiPolygon for clean Leaflet.draw integration
      const latlngs = L.GeoJSON.coordsToLatLngs(s.geometry.coordinates, s.geometry.type === 'MultiPolygon' ? 2 : 1);
      layer = s.geometry.type === 'MultiPolygon'
        ? L.multiPolygon(latlngs, { color: '#f59e0b', weight: 3, fillColor: color, fillOpacity: 0.4 })
        : L.polygon(latlngs, { color: '#f59e0b', weight: 3, fillColor: color, fillOpacity: 0.4 });
    } catch (err) {
      console.warn("Failed to instantiate native L.Polygon, falling back to L.geoJSON:", err);
      // Fallback: use L.geoJSON and extract the first child layer
      const geojsonGroup = L.geoJSON(
        { type: 'Feature', geometry: s.geometry, properties: {} },
        {
          style: { color: '#f59e0b', weight: 3, fillColor: color, fillOpacity: 0.4 }
        }
      );
      layer = geojsonGroup.getLayers()[0];
    }
    
    // Add the layer to the map before enabling editing
    layer.addTo(mapRef.current);
    
    // Enable editing robustly with standard prototype property or direct L.Edit.Poly instantiation
    if (layer.editing && typeof layer.editing.enable === 'function') {
      layer.editing.enable();
    } else if (L.Edit && L.Edit.Poly) {
      try {
        const editHandler = new L.Edit.Poly(layer, {});
        editHandler.enable();
        layer.editing = editHandler;
      } catch (e) {
        console.error("Failed to enable L.Edit.Poly explicitly:", e);
      }
    } else {
      console.error("Leaflet.draw editing handlers not found.");
    }
    
    editLayerRef.current = layer;
    
    try {
      mapRef.current.fitBounds(layer.getBounds(), { padding: [50, 50] });
    } catch {}
  };

  const handleSaveGeometry = async () => {
    if (!editingGeometryId || !editLayerRef.current) return;
    
    const geojson = editLayerRef.current.toGeoJSON();
    const geometry = geojson.geometry;
    
    setIsLoading(true);
    try {
      await api.updateGisSector(editingGeometryId, { geometry });
      
      if (editLayerRef.current) {
        if (editLayerRef.current.editing && typeof editLayerRef.current.editing.disable === 'function') {
          editLayerRef.current.editing.disable();
        }
        mapRef.current.removeLayer(editLayerRef.current);
        editLayerRef.current = null;
      }
      setEditingGeometryId(null);
      await loadSectors(selectedComuna, showAllGlobal);
      showToast('🗺️ Trazado del sector actualizado con éxito');
    } catch (e: any) {
      showToast(e.message || 'Error al actualizar trazado', false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelEditGeometry = () => {
    if (editLayerRef.current && mapRef.current) {
      try {
        if (editLayerRef.current.editing && typeof editLayerRef.current.editing.disable === 'function') {
          editLayerRef.current.editing.disable();
        }
        mapRef.current.removeLayer(editLayerRef.current);
      } catch {}
      editLayerRef.current = null;
    }
    setEditingGeometryId(null);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 180px)', minHeight: 500 }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          background: toast.ok ? '#d1fae5' : '#fee2e2',
          color: toast.ok ? '#065f46' : '#991b1b',
          border: `1px solid ${toast.ok ? '#6ee7b7' : '#fca5a5'}`,
          borderRadius: 12, padding: '10px 18px', fontWeight: 600, fontSize: 13,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
        }}>
          {toast.msg}
        </div>
      )}

      {/* ── Left Panel ── */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Commune selector */}
        <div style={{ background: 'var(--background-secondary)', borderRadius: 12, padding: 16, border: '1px solid var(--border-primary)' }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
            Seleccionar Comuna
          </label>
          <SearchableSelect
            items={COMUNAS_RM.map(c => ({ id: c, name: c }))}
            selectedId={selectedComuna}
            onSelect={setSelectedComuna}
            placeholder="— elige una comuna —"
            searchPlaceholder="Buscar comuna..."
            showNoneOption={false}
          />
        </div>

        {/* Global view button */}
        <button
            onClick={handleToggleGlobal}
            style={{
              padding: '10px 0', borderRadius: 10, border: showAllGlobal ? 'none' : '1px solid var(--border-primary)',
              cursor: 'pointer', fontWeight: 700, fontSize: 13,
              background: showAllGlobal ? '#10b981' : 'var(--background-secondary)',
              color: showAllGlobal ? '#fff' : 'var(--text-primary)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.2s',
            }}
        >
            <IconMap style={{ width: 16, height: 16 }} />
            {showAllGlobal ? '🌍 Ocultar Vista Global' : '🌍 Ver Todos los Sectores (Global)'}
        </button>

        {/* Draw button */}
        {selectedComuna && (
          <button
            onClick={isDrawing ? stopDrawing : startDrawing}
            disabled={isLoading || showNameDialog || !!editingGeometryId}
            style={{
              padding: '10px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              fontWeight: 700, fontSize: 14,
              background: isDrawing ? '#ef4444' : '#4f46e5',
              color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'background 0.2s',
              opacity: (isLoading || showNameDialog || !!editingGeometryId) ? 0.5 : 1,
            }}
          >
            {isDrawing ? '⏹ Cancelar dibujo' : '✏️ Dibujar nuevo sector'}
          </button>
        )}

        {/* Geometry Editing Dialog */}
        {editingGeometryId && (
          <div style={{ background: '#fef3c7', border: '2px solid #f59e0b', borderRadius: 12, padding: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#b45309', marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <span>🗺️ Editando trazado:</span>
              <strong style={{ textDecoration: 'underline' }}>
                {sectors.find(s => s.id === editingGeometryId)?.sector}
              </strong>
            </p>
            <p style={{ fontSize: 11, color: '#b45309', marginBottom: 12 }}>
              Arrastra los puntos del mapa para modificar el polígono.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleSaveGeometry}
                disabled={isLoading}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: '#d97706', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
              >
                {isLoading ? '...' : 'Guardar'}
              </button>
              <button
                onClick={handleCancelEditGeometry}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1.5px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Name dialog */}
        {showNameDialog && (
          <div style={{ background: '#fffbeb', border: '2px solid #fbbf24', borderRadius: 12, padding: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>
              📍 Nombre del sector dibujado:
            </p>
            <input
              type="text"
              value={newSectorName}
              onChange={e => setNewSectorName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSaveSector()}
              placeholder="Ej: Norte, El Golf, Sur Oriente…"
              autoFocus
              style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1.5px solid #fbbf24', fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
            />
            {/* Color picker for creation */}
            <div style={{ marginTop: 10 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>🎨 Elegir color del sector:</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {SECTOR_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setSelectedColor(c)}
                    style={{
                      width: 22, height: 22, borderRadius: '50%', background: c, border: selectedColor === c ? '2.5px solid #000' : '1px solid #ccc',
                      cursor: 'pointer', padding: 0, transition: 'transform 0.1s',
                      transform: selectedColor === c ? 'scale(1.15)' : 'none',
                    }}
                  />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button
                onClick={handleSaveSector}
                disabled={!newSectorName.trim() || isLoading}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: '#4f46e5', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
              >
                {isLoading ? '...' : 'Guardar'}
              </button>
              <button
                onClick={handleCancelDraw}
                style={{ flex: 1, padding: '8px 0', borderRadius: 8, border: '1.5px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Sector list */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {isLoading && !sectors.length && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Cargando…</div>
          )}
          {!selectedComuna && !showAllGlobal && (
            <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)', fontSize: 13 }}>
              <IconMapPin style={{ width: 32, height: 32, margin: '0 auto 8px', display: 'block', opacity: 0.4 }} />
              Selecciona una comuna para ver y gestionar sus sectores
            </div>
          )}
          {(selectedComuna || showAllGlobal) && !isLoading && sectors.length === 0 && !showNameDialog && (
            <div style={{ background: 'var(--background-secondary)', borderRadius: 10, padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              Sin sectores {showAllGlobal ? 'registrados en el sistema' : <span>para <strong>{selectedComuna}</strong></span>}.<br />Usa "Dibujar nuevo sector" para comenzar.
            </div>
          )}
          {sectors.map((s, i) => {
            const color = s.color || SECTOR_COLORS[i % SECTOR_COLORS.length];
            return (
              <div key={s.id} style={{
                background: 'var(--background-secondary)', borderRadius: 10,
                border: '1px solid var(--border-primary)', padding: '10px 12px',
              }}>
                {renamingId === s.id ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="text"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleRename(s.id)}
                        autoFocus
                        style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1.5px solid #4f46e5', fontSize: 12 }}
                      />
                      <button onClick={() => handleRename(s.id)} style={{ background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>✓</button>
                      <button onClick={() => setRenamingId(null)} style={{ background: '#e5e7eb', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>✕</button>
                    </div>
                    {/* Color picker for renaming */}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                      {SECTOR_COLORS.map(c => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setRenameColor(c)}
                          style={{
                            width: 18, height: 18, borderRadius: '50%', background: c, border: renameColor === c ? '2.5px solid #000' : '1px solid #ccc',
                            cursor: 'pointer', padding: 0,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 12, height: 12, borderRadius: '50%', background: color, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.sector}
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.comuna}</div>
                    </div>
                    <button
                      onClick={() => { setRenamingId(s.id); setRenameValue(s.sector); setRenameColor(s.color || color); }}
                      disabled={isDrawing || showNameDialog || !!editingGeometryId}
                      title="Editar nombre y color"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-muted)', opacity: (isDrawing || showNameDialog || !!editingGeometryId) ? 0.3 : 1 }}
                    >
                      <IconPencil style={{ width: 14, height: 14 }} />
                    </button>
                    <button
                      onClick={() => handleStartEditGeometry(s)}
                      disabled={isDrawing || showNameDialog || !!editingGeometryId}
                      title="Editar trazado (mapa)"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--brand-primary)', opacity: (isDrawing || showNameDialog || !!editingGeometryId) ? 0.3 : 1 }}
                    >
                      <IconMap style={{ width: 14, height: 14 }} />
                    </button>
                    <button
                      onClick={() => handleDelete(s.id, s.sector)}
                      disabled={isDrawing || showNameDialog || !!editingGeometryId}
                      title="Eliminar"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#ef4444', opacity: (isDrawing || showNameDialog || !!editingGeometryId) ? 0.3 : 1 }}
                    >
                      <IconTrash style={{ width: 14, height: 14 }} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Sector count badge */}
        {(selectedComuna || showAllGlobal) && sectors.length > 0 && (
          <div style={{ background: '#ede9fe', borderRadius: 8, padding: '6px 12px', textAlign: 'center', fontSize: 12, fontWeight: 700, color: '#5b21b6' }}>
            {showAllGlobal ? 'Todos los sectores' : selectedComuna}: {sectors.length} sector{sectors.length !== 1 ? 'es' : ''} definido{sectors.length !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* ── Map Panel ── */}
      <div style={{ flex: 1, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border-primary)', position: 'relative' }}>
        <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

        {/* Instructions overlay */}
        {isDrawing && (
          <div style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(79,70,229,0.92)', color: '#fff', borderRadius: 20, padding: '8px 18px',
            fontSize: 12, fontWeight: 600, pointerEvents: 'none', zIndex: 999, whiteSpace: 'nowrap',
          }}>
            ✏️ Haz clic en el mapa para trazar el sector · Doble clic para cerrar
          </div>
        )}
        {!selectedComuna && !showAllGlobal && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(4px)',
            fontSize: 14, color: 'var(--text-muted)', flexDirection: 'column', gap: 8,
          }}>
            <IconMapPin style={{ width: 36, height: 36, opacity: 0.4 }} />
            <span>Selecciona una comuna para comenzar</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default SectorEditorPage;
