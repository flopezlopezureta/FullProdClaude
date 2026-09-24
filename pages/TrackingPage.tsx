import React, { useState, useEffect, useRef } from 'react';
import { MAP_TILE_URL } from '../constants';

declare const L: any;

interface TrackingHistory {
  status: string;
  location: string;
  details: string;
  timestamp: string;
}

interface Package {
  id: string;
  status: string;
  recipientName: string;
  recipientAddress: string;
  recipientCommune: string;
  recipientCity: string;
  estimatedDelivery: string;
  updatedAt: string;
  history: TrackingHistory[];
  destLatitude?: number | null;
  destLongitude?: number | null;
  driverLatitude?: number | null;
  driverLongitude?: number | null;
  driverLastUpdate?: string | null;
}

const STATUS_LABELS: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  PENDIENTE:   { label: 'Pendiente',     color: '#b45309', bg: '#fef3c7', icon: '⏳' },
  RETIRADO:    { label: 'En Bodega',     color: '#1d4ed8', bg: '#dbeafe', icon: '📦' },
  ASIGNADO:    { label: 'En Camino',     color: '#6d28d9', bg: '#ede9fe', icon: '🚚' },
  EN_TRANSITO: { label: 'En Tránsito',   color: '#6d28d9', bg: '#ede9fe', icon: '🚚' },
  ENTREGADO:   { label: 'Entregado',     color: '#065f46', bg: '#d1fae5', icon: '✅' },
  DEVUELTO:    { label: 'Devuelto',      color: '#374151', bg: '#f3f4f6', icon: '↩️' },
  PROBLEMA:    { label: 'Con Problema',  color: '#991b1b', bg: '#fee2e2', icon: '⚠️' },
};

// ── Map component (inline to avoid re-mount issues) ──────────────────────────
const LiveMap: React.FC<{
  destLat: number | null;
  destLng: number | null;
  driverLat?: number | null;
  driverLng?: number | null;
  status: string;
}> = ({ destLat, destLng, driverLat, driverLng, status }) => {
  const mapRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<any>(null);

  useEffect(() => {
    if (containerRef.current && !mapRef.current) {
      mapRef.current = L.map(containerRef.current, { zoomControl: true, attributionControl: false })
        .setView([-33.4489, -70.6693], 12);
      L.tileLayer(MAP_TILE_URL).addTo(mapRef.current);
      groupRef.current = L.layerGroup().addTo(mapRef.current);
    }
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current || !groupRef.current) return;
    groupRef.current.clearLayers();
    const bounds: [number, number][] = [];

    if (destLat && destLng && destLat !== 0.000001) {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:16px;height:16px;background:#ef4444;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.35);"></div>`,
        iconSize: [16, 16], iconAnchor: [8, 8],
      });
      L.marker([destLat, destLng], { icon }).addTo(groupRef.current).bindPopup('📍 Punto de entrega');
      bounds.push([destLat, destLng]);
    }

    const active = status === 'EN_TRANSITO' || status === 'ASIGNADO';
    if (active && driverLat && driverLng) {
      const icon = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:22px;height:22px;">
          <div style="position:absolute;inset:0;background:#3b82f6;border-radius:50%;opacity:.35;animation:ripple 1.5s infinite;"></div>
          <div style="position:absolute;inset:3px;background:#3b82f6;border-radius:50%;border:2px solid white;box-shadow:0 2px 8px rgba(59,130,246,.7);"></div>
          <style>@keyframes ripple{0%{transform:scale(1);opacity:.35}100%{transform:scale(2.4);opacity:0}}</style>
        </div>`,
        iconSize: [22, 22], iconAnchor: [11, 11],
      });
      L.marker([driverLat, driverLng], { icon }).addTo(groupRef.current).bindPopup('🚚 Repartidor en tiempo real');
      bounds.push([driverLat, driverLng]);
    }

    if (bounds.length === 1) mapRef.current.setView(bounds[0], 15);
    else if (bounds.length > 1) mapRef.current.fitBounds(bounds, { padding: [60, 60] });
  }, [destLat, destLng, driverLat, driverLng, status]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%', minHeight: '420px' }} />;
};

// ── Main TrackingPage ─────────────────────────────────────────────────────────
const TrackingPage: React.FC = () => {
  const [inputId, setInputId] = useState('');
  const [pkg, setPkg] = useState<Package | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDirectLink, setIsDirectLink] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchPackage = async (id: string) => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/packages/public/track/${id}`);
      if (res.status === 403) { const d = await res.json(); throw new Error(d.message); }
      if (!res.ok) throw new Error('No se encontró el código de seguimiento.');
      setPkg(await res.json());
      setLastUpdate(new Date());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // Auto-load if tracking ID is in URL
  useEffect(() => {
    const match = window.location.pathname.match(/\/(?:track|tracking)\/(.+)/);
    if (match?.[1]) {
      setIsDirectLink(true);
      setInputId(match[1]);
      fetchPackage(match[1]);
    }
  }, []);

  // Poll every 30 s when driver is active
  useEffect(() => {
    if (!pkg || (pkg.status !== 'EN_TRANSITO' && pkg.status !== 'ASIGNADO')) return;
    const t = setInterval(() => fetchPackage(pkg.id), 30000);
    return () => clearInterval(t);
  }, [pkg?.status, pkg?.id]);

  const st = pkg ? (STATUS_LABELS[pkg.status] ?? { label: pkg.status, color: '#374151', bg: '#f3f4f6', icon: '📦' }) : null;
  const hasCoords = pkg && (pkg.destLatitude || pkg.driverLatitude);
  const isActive = pkg && (pkg.status === 'EN_TRANSITO' || pkg.status === 'ASIGNADO');

  // ── SEARCH SCREEN (no direct link) ────────────────────────────────────────
  if (!isDirectLink && !pkg) {
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg,#1e1b4b 0%,#312e81 50%,#4338ca 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
        <div style={{ background: 'white', borderRadius: '24px', padding: '48px 40px', maxWidth: '420px', width: '100%', boxShadow: '0 25px 60px rgba(0,0,0,.35)', textAlign: 'center' }}>
          <div style={{ fontSize: '52px', marginBottom: '16px' }}>📦</div>
          <h1 style={{ margin: '0 0 8px', fontSize: '26px', fontWeight: 800, color: '#1e1b4b' }}>Seguimiento en Tiempo Real</h1>
          <p style={{ margin: '0 0 32px', color: '#6b7280', fontSize: '15px' }}>Ingresa tu código para ver la ubicación de tu pedido.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <input
              value={inputId}
              onChange={e => setInputId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchPackage(inputId)}
              placeholder="Ej: ABC-12345"
              style={{ padding: '14px 16px', borderRadius: '12px', border: '2px solid #e5e7eb', fontSize: '16px', outline: 'none', textAlign: 'center', letterSpacing: '1px', transition: 'border .2s' }}
              onFocus={e => (e.target.style.borderColor = '#4338ca')}
              onBlur={e => (e.target.style.borderColor = '#e5e7eb')}
            />
            <button
              onClick={() => fetchPackage(inputId)}
              disabled={loading || !inputId.trim()}
              style={{ padding: '14px', borderRadius: '12px', background: loading ? '#a5b4fc' : '#4338ca', color: 'white', border: 'none', fontSize: '16px', fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer', transition: 'background .2s' }}
            >
              {loading ? 'Buscando…' : '🔍 Consultar'}
            </button>
          </div>

          {error && (
            <div style={{ marginTop: '20px', padding: '12px 16px', background: '#fee2e2', borderRadius: '10px', color: '#991b1b', fontSize: '14px' }}>
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── LOADING ───────────────────────────────────────────────────────────────
  if (loading && !pkg) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '20px', fontFamily: 'system-ui' }}>
        <div style={{ width: '48px', height: '48px', border: '4px solid #4338ca', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <p style={{ color: '#94a3b8', fontSize: '15px' }}>Buscando tu pedido…</p>
      </div>
    );
  }

  // ── ERROR (direct link) ───────────────────────────────────────────────────
  if (error && !pkg) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', fontFamily: 'system-ui' }}>
        <div style={{ background: '#1e293b', borderRadius: '20px', padding: '40px', maxWidth: '380px', textAlign: 'center', color: 'white' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>❌</div>
          <h2 style={{ margin: '0 0 8px', fontSize: '20px' }}>No encontrado</h2>
          <p style={{ color: '#94a3b8', margin: '0 0 24px', fontSize: '14px' }}>{error}</p>
          <button onClick={() => { setIsDirectLink(false); setError(''); }} style={{ padding: '12px 24px', background: '#4338ca', color: 'white', border: 'none', borderRadius: '10px', fontWeight: 700, cursor: 'pointer' }}>Intentar de nuevo</button>
        </div>
      </div>
    );
  }

  // ── FULL TRACKING VIEW ────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', fontFamily: "'Segoe UI', system-ui, sans-serif", display: 'flex', flexDirection: 'column' }}>

      {/* Top bar */}
      <div style={{ background: '#1e293b', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px', borderBottom: '1px solid #334155' }}>
        <span style={{ fontSize: '24px' }}>📦</span>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }}>Seguimiento en Tiempo Real</div>
          {pkg && <div style={{ color: 'white', fontSize: '13px', fontWeight: 600, marginTop: '2px', letterSpacing: '.5px' }}>{pkg.id}</div>}
        </div>
        {isActive && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#064e3b', borderRadius: '20px', padding: '6px 12px' }}>
            <div style={{ width: '8px', height: '8px', background: '#34d399', borderRadius: '50%', animation: 'pulse 2s infinite' }} />
            <span style={{ color: '#34d399', fontSize: '11px', fontWeight: 700 }}>EN VIVO</span>
          </div>
        )}
      </div>

      {/* Status card */}
      {pkg && st && (
        <div style={{ margin: '16px 16px 0', background: '#1e293b', borderRadius: '16px', padding: '16px 20px', border: `1px solid ${st.color}40`, display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ fontSize: '32px' }}>{st.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.8px' }}>Estado del pedido</div>
            <div style={{ color: 'white', fontSize: '18px', fontWeight: 800, marginTop: '2px' }}>{st.label}</div>
            <div style={{ color: '#64748b', fontSize: '12px', marginTop: '2px' }}>{pkg.recipientName} · {pkg.recipientCommune}, {pkg.recipientCity}</div>
          </div>
          {lastUpdate && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ color: '#64748b', fontSize: '10px' }}>Actualizado</div>
              <div style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 600 }}>{lastUpdate.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          )}
        </div>
      )}

      {/* Map */}
      <div style={{ flex: 1, margin: '12px 16px 16px', borderRadius: '16px', overflow: 'hidden', minHeight: '420px', boxShadow: '0 8px 32px rgba(0,0,0,.4)' }}>
        {pkg && hasCoords ? (
          <LiveMap
            destLat={pkg.destLatitude ?? null}
            destLng={pkg.destLongitude ?? null}
            driverLat={pkg.driverLatitude}
            driverLng={pkg.driverLongitude}
            status={pkg.status}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', minHeight: '420px', background: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
            <span style={{ fontSize: '48px' }}>🗺️</span>
            <p style={{ color: '#64748b', fontSize: '14px', margin: 0 }}>Ubicación no disponible aún</p>
          </div>
        )}
      </div>

      {/* Legend */}
      {pkg && (pkg.destLatitude || pkg.driverLatitude) && (
        <div style={{ margin: '-8px 16px 16px', background: '#1e293b', borderRadius: '12px', padding: '12px 16px', display: 'flex', gap: '20px', justifyContent: 'center', flexWrap: 'wrap' }}>
          {pkg.destLatitude && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', background: '#ef4444', borderRadius: '50%', border: '2px solid white' }} />
              <span style={{ color: '#94a3b8', fontSize: '12px' }}>Punto de entrega</span>
            </div>
          )}
          {isActive && pkg.driverLatitude && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '12px', height: '12px', background: '#3b82f6', borderRadius: '50%', border: '2px solid white' }} />
              <span style={{ color: '#94a3b8', fontSize: '12px' }}>Repartidor en tiempo real</span>
            </div>
          )}
        </div>
      )}

      {/* Info note */}
      {pkg && isActive && (
        <div style={{ margin: '0 16px 24px', background: '#172554', border: '1px solid #1d4ed8', borderRadius: '12px', padding: '12px 16px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
          <span style={{ fontSize: '16px', flexShrink: 0 }}>ℹ️</span>
          <p style={{ color: '#93c5fd', fontSize: '12px', margin: 0, lineHeight: 1.6 }}>
            Tu pedido está en camino. El conductor tiene varios envíos en su ruta, el mapa se actualiza automáticamente cada 30 segundos. ¡Esté atento, pronto llegará!
          </p>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>
    </div>
  );
};

export default TrackingPage;
