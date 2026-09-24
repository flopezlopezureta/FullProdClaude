// ZoningScanner — Consulta GIS acumulativa. Sin asignación.
// Cada paquete escaneado se agrega al mapa y a la lista.
// Todos los paquetes de una misma sesión se muestran simultáneamente en el mapa.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../../services/api';
import { MAP_TILE_URL } from '../../constants';
import jsQR from 'jsqr';

declare const L: any;

// ---- Colores por sector (cíclicos) -----------------------------------------
const SECTOR_COLORS = [
  { fill: '#818cf8', border: '#4f46e5' }, // indigo
  { fill: '#34d399', border: '#059669' }, // emerald
  { fill: '#f472b6', border: '#db2777' }, // pink
  { fill: '#fbbf24', border: '#d97706' }, // amber
  { fill: '#60a5fa', border: '#2563eb' }, // blue
  { fill: '#a78bfa', border: '#7c3aed' }, // violet
  { fill: '#f87171', border: '#dc2626' }, // red
  { fill: '#2dd4bf', border: '#0d9488' }, // teal
];

// ---- Types ------------------------------------------------------------------
interface ScannedItem {
  id: string;         // internal scan ID (timestamp+code)
  rawCode: string;
  pkg: any;
  sectorDetails: {
    comuna: string;
    sector: string;
    sectorLabel: string;
    geometry?: any;
  } | null;
  colorIdx: number;   // index into SECTOR_COLORS
  error?: string;
}

interface ZoningScannerProps {
  onBack: () => void;
}

// ---- Component --------------------------------------------------------------
const ZoningScanner: React.FC<ZoningScannerProps> = ({ onBack }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const scanLock = useRef(false);
  const scannedCodesRef = useRef<Set<string>>(new Set()); // avoid duplicate scans

  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<any[]>([]); // leaflet layers per scanned item

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [scannedItems, setScannedItems] = useState<ScannedItem[]>([]);
  const [colorCounter, setColorCounter] = useState(0);
  const [lastStatusMsg, setLastStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ---- Camera ---------------------------------------------------------------
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } } })
      .then(s => {
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.play();
        }
      })
      .catch(() => setCameraError('Sin acceso a cámara. Usa ingreso manual.'));
    return () => {
      stream?.getTracks().forEach(t => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ---- QR scan loop ---------------------------------------------------------
  useEffect(() => {
    if (cameraError) return;
    const tick = () => {
      if (videoRef.current && canvasRef.current && videoRef.current.readyState === 4) {
        const v = videoRef.current;
        const c = canvasRef.current;
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.drawImage(v, 0, 0);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (code?.data && !scanLock.current) handleScan(code.data);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [cameraError]);

  // ---- Map init -------------------------------------------------------------
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;
    try {
      mapRef.current = L.map(mapContainerRef.current, { zoomControl: true, attributionControl: false })
        .setView([-33.4489, -70.6693], 11);
      L.tileLayer(MAP_TILE_URL).addTo(mapRef.current);
    } catch {}
  }, []);

  // ---- Core scan handler ----------------------------------------------------
  const handleScan = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code || scanLock.current) return;

    // Avoid re-scanning the same code in this session
    if (scannedCodesRef.current.has(code)) {
      setLastStatusMsg({ text: `⚠️ Ya escaneado: ${code.slice(0, 30)}`, ok: false });
      return;
    }

    scanLock.current = true;
    setIsLoading(true);
    setLastStatusMsg(null);

    try {
      const res = await api.queryPackageSector(code);
      const pkg = res.package;
      const sectorDetails = res.sectorDetails;

      scannedCodesRef.current.add(code);

      const colorIdx = colorCounter % SECTOR_COLORS.length;
      setColorCounter(prev => prev + 1);

      const item: ScannedItem = {
        id: `${Date.now()}-${code}`,
        rawCode: code,
        pkg,
        sectorDetails,
        colorIdx,
      };

      setScannedItems(prev => [item, ...prev]);
      addToMap(item);
      setLastStatusMsg({ text: `✅ ${pkg.id} → ${sectorDetails?.sectorLabel || pkg.recipientCommune || 'Sin zona'}`, ok: true });
    } catch (err: any) {
      setLastStatusMsg({ text: `❌ No encontrado: ${code.slice(0, 30)}`, ok: false });
    } finally {
      setIsLoading(false);
      // Short lock to avoid double-reading the same QR frame
      setTimeout(() => { scanLock.current = false; }, 1500);
    }
  }, [colorCounter]);

  // ---- Draw item on map (cumulative) ----------------------------------------
  const addToMap = useCallback((item: ScannedItem) => {
    if (!mapRef.current) return;
    const color = SECTOR_COLORS[item.colorIdx];
    const bounds: any[] = [];

    // Sector polygon
    if (item.sectorDetails?.geometry) {
      try {
        const layer = L.geoJSON(
          { type: 'Feature', geometry: item.sectorDetails.geometry, properties: {} },
          { style: { color: color.border, weight: 2, fillColor: color.fill, fillOpacity: 0.22 } }
        ).addTo(mapRef.current);
        layersRef.current.push(layer);
        try { const b = layer.getBounds(); if (b.isValid()) bounds.push(b); } catch {}
      } catch {}
    }

    // Package coordinate marker
    const lat = parseFloat(item.pkg?.destLatitude);
    const lon = parseFloat(item.pkg?.destLongitude);
    if (!isNaN(lat) && !isNaN(lon) && lat !== 0.000001) {
      const marker = L.circleMarker([lat, lon], {
        radius: 9,
        fillColor: color.border,
        color: '#fff',
        weight: 2,
        fillOpacity: 1,
      })
        .bindPopup(
          `<div style="font-size:12px;line-height:1.4">
             <b>${item.pkg?.id}</b><br>
             ${item.pkg?.recipientName || ''}<br>
             ${item.pkg?.recipientAddress || ''}<br>
             <span style="font-weight:700;color:${color.border}">${item.sectorDetails?.sectorLabel || item.pkg?.recipientCommune || ''}</span>
           </div>`
        )
        .addTo(mapRef.current);
      layersRef.current.push(marker);
      bounds.push(L.latLngBounds([[lat, lon], [lat, lon]]));
    }

    // Fit map to show all accumulated layers
    try {
      const allBounds = layersRef.current.reduce<any>((acc, layer) => {
        try {
          if (layer.getBounds) {
            const b = layer.getBounds();
            if (b.isValid()) return acc ? acc.extend(b) : b;
          }
          if (layer.getLatLng) {
            const p = layer.getLatLng();
            return acc ? acc.extend(p) : L.latLngBounds([p, p]);
          }
        } catch {}
        return acc;
      }, null);
      if (allBounds && allBounds.isValid()) {
        mapRef.current.fitBounds(allBounds, { padding: [30, 30], maxZoom: 14 });
      }
    } catch {}
  }, []);

  // ---- Remove single item ---------------------------------------------------
  const removeItem = useCallback((item: ScannedItem) => {
    // We can't easily track which layers belong to which item without a registry,
    // so we clear all and re-draw the remaining items
    layersRef.current.forEach(l => { try { mapRef.current?.removeLayer(l); } catch {} });
    layersRef.current = [];

    setScannedItems(prev => {
      const remaining = prev.filter(i => i.id !== item.id);
      // Re-add all remaining to map
      scannedCodesRef.current.delete(item.rawCode);
      setTimeout(() => remaining.forEach(i => addToMap(i)), 0);
      return remaining;
    });
  }, [addToMap]);

  // ---- Clear all ------------------------------------------------------------
  const clearAll = useCallback(() => {
    layersRef.current.forEach(l => { try { mapRef.current?.removeLayer(l); } catch {} });
    layersRef.current = [];
    scannedCodesRef.current.clear();
    setScannedItems([]);
    setColorCounter(0);
    setLastStatusMsg(null);
  }, []);

  // ---- Manual submit --------------------------------------------------------
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualCode.trim()) {
      handleScan(manualCode.trim());
      setManualCode('');
      setShowManual(false);
    }
  };

  // ---- Render ---------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background-primary)' }}>

      {/* ---- Header ---- */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', background: '#4f46e5', color: '#fff', flexShrink: 0,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 22, lineHeight: 1 }}>✕</button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Consulta de Zona</div>
          <div style={{ fontSize: 10, color: '#c7d2fe' }}>Sin asignación · {scannedItems.length} escaneado{scannedItems.length !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {scannedItems.length > 0 && (
            <button
              onClick={clearAll}
              style={{ background: '#dc2626', border: 'none', color: '#fff', borderRadius: 8, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
            >
              Limpiar
            </button>
          )}
          <button
            onClick={() => setShowManual(m => !m)}
            style={{ background: '#6366f1', border: 'none', color: '#fff', borderRadius: 8, padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
          >
            Manual
          </button>
        </div>
      </div>

      {/* ---- Manual input ---- */}
      {showManual && (
        <form onSubmit={handleManualSubmit} style={{ display: 'flex', gap: 6, padding: '8px 12px', background: '#3730a3', flexShrink: 0 }}>
          <input
            type="text"
            value={manualCode}
            onChange={e => setManualCode(e.target.value)}
            placeholder="ID, Meli, Shopify, Tracking…"
            autoFocus
            style={{ flex: 1, padding: '7px 10px', borderRadius: 8, border: 'none', fontSize: 13, outline: 'none' }}
          />
          <button type="submit" style={{ background: '#fbbf24', border: 'none', color: '#1e1b4b', borderRadius: 8, padding: '7px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            Buscar
          </button>
        </form>
      )}

      {/* ---- Camera viewfinder ---- */}
      <div style={{ position: 'relative', background: '#000', height: 160, flexShrink: 0 }}>
        {cameraError ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#fff', gap: 8, padding: 16 }}>
            <span style={{ fontSize: 28 }}>📷</span>
            <span style={{ fontSize: 12, color: '#d1d5db', textAlign: 'center' }}>{cameraError}</span>
            <button onClick={() => setShowManual(true)} style={{ background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, padding: '6px 14px', cursor: 'pointer', fontSize: 12 }}>
              Ingreso Manual
            </button>
          </div>
        ) : (
          <>
            <video ref={videoRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} playsInline muted />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {/* Targeting box */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
              <div style={{ width: 150, height: 90, border: '2px solid #fbbf24', borderRadius: 8, position: 'relative' }}>
                {[['top','left'],['top','right'],['bottom','left'],['bottom','right']].map(([v,h]) => (
                  <div key={v+h} style={{
                    position: 'absolute', [v]: -1, [h]: -1,
                    width: 14, height: 14,
                    borderTop: v === 'top' ? '4px solid #fbbf24' : 'none',
                    borderBottom: v === 'bottom' ? '4px solid #fbbf24' : 'none',
                    borderLeft: h === 'left' ? '4px solid #fbbf24' : 'none',
                    borderRight: h === 'right' ? '4px solid #fbbf24' : 'none',
                    borderRadius: v === 'top' && h === 'left' ? '3px 0 0 0' : v === 'top' && h === 'right' ? '0 3px 0 0' : v === 'bottom' && h === 'left' ? '0 0 0 3px' : '0 0 3px 0',
                  }} />
                ))}
              </div>
            </div>
            {isLoading && (
              <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 20, animation: 'spin 1s linear infinite' }}>⏳</div>
            )}
          </>
        )}
      </div>

      {/* ---- Status bar ---- */}
      {lastStatusMsg && (
        <div style={{
          padding: '5px 12px', fontSize: 12, fontWeight: 600, flexShrink: 0,
          background: lastStatusMsg.ok ? '#d1fae5' : '#fee2e2',
          color: lastStatusMsg.ok ? '#065f46' : '#991b1b',
          borderBottom: `1px solid ${lastStatusMsg.ok ? '#6ee7b7' : '#fca5a5'}`,
        }}>
          {lastStatusMsg.text}
        </div>
      )}

      {/* ---- Map (flex-1) ---- */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />
        {scannedItems.length === 0 && (
          <div style={{
            position: 'absolute', bottom: 10, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: 20, padding: '4px 14px',
            fontSize: 11, pointerEvents: 'none', whiteSpace: 'nowrap',
          }}>
            Escanea paquetes para ver sectores
          </div>
        )}
      </div>

      {/* ---- Scanned items list ---- */}
      {scannedItems.length > 0 && (
        <div style={{
          flexShrink: 0, maxHeight: 210, overflowY: 'auto',
          borderTop: '1px solid var(--border-primary)',
          background: 'var(--background-secondary)',
        }}>
          {/* Legend header */}
          <div style={{ padding: '5px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-secondary)' }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {scannedItems.length} paquete{scannedItems.length !== 1 ? 's' : ''} en mapa
            </span>
          </div>

          {scannedItems.map(item => {
            const color = SECTOR_COLORS[item.colorIdx];
            return (
              <div
                key={item.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 12px',
                  borderBottom: '1px solid var(--border-secondary)',
                }}
              >
                {/* Color dot */}
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: color.border, flexShrink: 0 }} />

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.pkg?.id}
                    {item.pkg?.meliOrderId && <span style={{ fontWeight: 400, fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>ML</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.sectorDetails?.sectorLabel || item.pkg?.recipientCommune || 'Sin zona'}
                    {item.sectorDetails?.sector && item.sectorDetails.sector !== item.sectorDetails.sectorLabel &&
                      <span style={{ marginLeft: 4, color: 'var(--text-muted)', fontSize: 10 }}>· {item.sectorDetails.sector}</span>
                    }
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.pkg?.recipientAddress}
                    {(!item.pkg?.destLatitude || parseFloat(item.pkg.destLatitude) === 0.000001) && (
                      <span style={{ color: '#f59e0b', fontWeight: 'bold', marginLeft: 6 }}>⚠️ Ubicación no encontrada</span>
                    )}
                  </div>
                </div>

                {/* Remove button */}
                <button
                  onClick={() => removeItem(item)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)', flexShrink: 0, lineHeight: 1 }}
                  title="Quitar del mapa"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ZoningScanner;
