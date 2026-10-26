
import React, { useEffect, useRef, useState, useMemo, useCallback, useContext } from 'react';
import { getLocalDateString, getLogicalDateString } from '../../utils/dateUtils';
import { AuthContext } from '../../contexts/AuthContext';
import { User, Package } from '../../types';
import { PackageStatus, MAP_TILE_URL, MAP_TILE_ATTRIBUTION } from '../../constants';
import { api } from '../../services/api';
import { IconRefresh, IconLoader, IconMapPin, IconBattery, IconWifi, IconCopy, IconPower, IconX, IconSearch } from '../Icon';
import DriverRoutePanel from './DriverRoutePanel';
import type { RouteMode } from './DriverRoutePanel';
import {
    visitsOf, pendingOf, withoutLocation, visitQuality, planRemainingRoute, planDoneRoute, etaTimes, pointsAlong, stopKind, fmtClock, SERVICE_SECONDS,
} from '../../utils/routePlanning';
import type { DriverDayRoute, PlannedRoute, RoadRoute, RouteStop, LatLng } from '../../utils/routePlanning';

declare const L: any;

// Misma convención de 3 grupos usada en FleetControlCenter.tsx: entregado / con
// dificultad (problema, reagendado, cancelado, devuelto) / abierto (todo lo demás
// que aún no se resuelve). Se reutiliza aquí para que el mapa hable el mismo idioma
// de colores que el resto del panel de administración.
const DIFFICULTY_STATUSES = ['PROBLEMA', 'REPROGRAMADO', 'CANCELADO', 'DEVUELTO'];
const OPEN_STATUSES = ['PENDIENTE', 'ASIGNADO', 'RETIRADO', 'EN_TRANSITO'];

const STATUS_COLORS = {
    delivered: '#16a34a', // verde
    problem: '#dc2626',   // rojo
    pending: '#2563eb',   // azul
    other: '#6b7280',     // gris - estados marginales (retrasado, pend. devolucion)
};

function getPackageColorKey(status: string): keyof typeof STATUS_COLORS {
    if (status === PackageStatus.Delivered) return 'delivered';
    if (DIFFICULTY_STATUSES.includes(status)) return 'problem';
    if (OPEN_STATUSES.includes(status)) return 'pending';
    return 'other';
}

function formatTimeAgo(date: Date | null): string {
    if (!date) return 'Nunca';
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return `hace segundos`;

    let interval = seconds / 31536000;
    if (interval > 1) return `hace ${Math.floor(interval)} años`;
    interval = seconds / 2592000;
    if (interval > 1) return `hace ${Math.floor(interval)} meses`;
    interval = seconds / 86400;
    if (interval > 1) return `hace ${Math.floor(interval)} días`;
    interval = seconds / 3600;
    if (interval > 1) return `hace ${Math.floor(interval)} horas`;
    interval = seconds / 60;
    return `hace ${Math.floor(interval)} minutos`;
}

// Los datos de clientes llegan de afuera: se escapan antes de ponerlos dentro del HTML de un popup.
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ROUTE_COLORS = { done: '#16a34a', attempt: '#dc2626', plan: '#2563eb' };
const GPS_FRESH_MS = 15 * 60 * 1000;   // una posición más vieja que esto ya no sirve como punto de partida de la ruta sugerida

const LiveMap: React.FC = () => {
    const auth = useContext(AuthContext);
    const tz = auth?.systemSettings?.timezone || 'America/Santiago';
    const todayLogical = getLogicalDateString(new Date(), tz);
    const mapRef = useRef<any>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const markersLayerRef = useRef<any>(null);
    const packageClusterRef = useRef<any>(null);
    const routeLayerRef = useRef<any>(null);
    const stopMarkersRef = useRef<Record<string, any>>({});
    const lastRouteFitRef = useRef<string>('');
    const [activeDrivers, setActiveDrivers] = useState<User[]>([]);
    const [packages, setPackages] = useState<Package[]>([]);
    const [allUsers, setAllUsers] = useState<User[]>([]);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);
    const [selectedDriverId, setSelectedDriverId] = useState<string | null>(null);
    const [driverSearch, setDriverSearch] = useState('');
    const lastFitDriverIdRef = useRef<string | null | undefined>(undefined);

    // --- Ruta del conductor seleccionado (realizada + sugerida) ---
    const [routeMode, setRouteMode] = useState<RouteMode>('both');
    const [routeDate, setRouteDate] = useState<string>(todayLogical);
    const [routeData, setRouteData] = useState<DriverDayRoute | null>(null);
    const [routeLoading, setRouteLoading] = useState(false);
    const [routeError, setRouteError] = useState<string | null>(null);
    const [doneRoad, setDoneRoad] = useState<RoadRoute | null>(null);
    const [planState, setPlanState] = useState<{ plan: PlannedRoute; at: Date } | null>(null);
    const [planning, setPlanning] = useState(false);
    const [replanTick, setReplanTick] = useState(0);
    const [focusId, setFocusId] = useState<string | null>(null);
    const routeReqRef = useRef(0);
    const doneReqRef = useRef(0);
    const planReqRef = useRef(0);

    const fetchData = useCallback(async () => {
        try {
            const today = getLocalDateString();
            const [fetchedActiveDrivers, packagesResponse, allUsersData] = await Promise.all([
                api.getActiveDriversLocations(),
                // dateType: 'egress' -> filtra por assignedAt (lo despachado HOY), igual que el
                // Centro de Control. Sin esto, un paquete reasignado hoy pero creado ayer no
                // aparece, y uno creado hoy para mañana sí aparece de más.
                api.getPackages({ limit: 0, includeHistory: false, startDate: today, isAssigned: 'true', dateType: 'egress' }),
                api.getUsers()
            ]);
            setActiveDrivers(fetchedActiveDrivers);
            setPackages(packagesResponse.packages);
            setAllUsers(allUsersData);
        } catch (error) {
            console.error("Failed to fetch map data", error);
        }
    }, []);

    const handleRefresh = useCallback(async () => {
        if (isRefreshing) return;
        setIsRefreshing(true);
        await fetchData();
        setTimeout(() => setIsRefreshing(false), 500); // Small delay for better UX
    }, [fetchData, isRefreshing]);

    useEffect(() => {
        if (mapContainerRef.current && !mapRef.current) {
            mapRef.current = L.map(mapContainerRef.current).setView([-33.45, -70.67], 11);
            L.tileLayer(MAP_TILE_URL, {
                attribution: MAP_TILE_ATTRIBUTION
            }).addTo(mapRef.current);
            // Agrupados igual que los paquetes: con muchos conductores cerca uno de otro (p.ej.
            // saliendo de la misma bodega), sus íconos y etiquetas de nombre se superponen y
            // vuelven el mapa ilegible - el mismo problema que ya se había resuelto para los
            // paquetes, pero que nunca se aplicó a la capa de conductores.
            markersLayerRef.current = L.markerClusterGroup({
                maxClusterRadius: 50,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
            }).addTo(mapRef.current);
            packageClusterRef.current = L.markerClusterGroup({
                maxClusterRadius: 60,
                spiderfyOnMaxZoom: true,
                showCoverageOnHover: false,
            }).addTo(mapRef.current);
            routeLayerRef.current = L.layerGroup().addTo(mapRef.current);
            setTimeout(() => mapRef.current?.invalidateSize(), 100);
        }

        handleRefresh(); // Initial fetch with loading state
        const intervalId = setInterval(fetchData, 15000);

        return () => {
            clearInterval(intervalId);
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
                routeLayerRef.current = null;
            }
        };
    }, [fetchData]);

    const allApprovedDrivers = useMemo(() =>
        allUsers.filter(u => u.role === 'DRIVER' && u.status === 'APROBADO')
                .sort((a,b) => a.name.localeCompare(b.name)),
    [allUsers]);

    const driverStatuses = useMemo(() => {
        const activeDriverIds = new Set(activeDrivers.map(d => d.id));
        return allApprovedDrivers.map(driver => {
            const isActive = activeDriverIds.has(driver.id);
            const activeDriverData = isActive ? activeDrivers.find(d => d.id === driver.id) : null;

            const driverPackages = packages.filter(p => p.driverId === driver.id);
            const total = driverPackages.length;
            const delivered = driverPackages.filter(p => p.status === PackageStatus.Delivered).length;
            const problems = driverPackages.filter(p => DIFFICULTY_STATUSES.includes(p.status)).length;
            const pending = driverPackages.filter(p => OPEN_STATUSES.includes(p.status)).length;

            return {
                ...driver,
                isOnline: isActive,
                latitude: activeDriverData?.latitude ?? driver.latitude,
                longitude: activeDriverData?.longitude ?? driver.longitude,
                lastUpdate: activeDriverData?.lastLocationUpdate ? new Date(activeDriverData.lastLocationUpdate) : (driver.lastLocationUpdate ? new Date(driver.lastLocationUpdate) : null),
                deliveredCount: delivered,
                pendingCount: pending,
                problemsCount: problems,
                totalCount: total
            };
        });
    }, [allApprovedDrivers, activeDrivers, packages]);
    const driverStatusesRef = useRef(driverStatuses);
    driverStatusesRef.current = driverStatuses;

    const filteredDriverStatuses = useMemo(() => {
        const q = driverSearch.trim().toLowerCase();
        if (!q) return driverStatuses;
        return driverStatuses.filter(d => d.name.toLowerCase().includes(q));
    }, [driverStatuses, driverSearch]);

    const selectedStatus = useMemo(() => driverStatuses.find(d => d.id === selectedDriverId) || null, [driverStatuses, selectedDriverId]);
    // Con un conductor elegido, la lista se reduce a su fila para dejar sitio a su ruta; al buscar por nombre vuelven todos los que coinciden.
    const visibleDriverRows = useMemo(
        () => (selectedDriverId && !driverSearch.trim() ? filteredDriverStatuses.filter(d => d.id === selectedDriverId) : filteredDriverStatuses),
        [filteredDriverStatuses, selectedDriverId, driverSearch],
    );
    const [legendOpen, setLegendOpen] = useState(true);

    // ---------- datos de la ruta del conductor seleccionado ----------
    const loadRoute = useCallback(async (driverId: string, date: string, silent: boolean) => {
        const mine = ++routeReqRef.current;
        if (!silent) { setRouteLoading(true); setRouteError(null); }
        try {
            const data = await api.getDriverRoute(driverId, date);
            if (routeReqRef.current !== mine) return;          // el admin ya cambió de conductor o de día
            setRouteData(data);
            setRouteError(null);
        } catch (e: any) {
            if (routeReqRef.current !== mine) return;
            if (!silent) setRouteError(e?.message || 'No se pudo cargar la ruta del conductor.');
        } finally {
            if (routeReqRef.current === mine && !silent) setRouteLoading(false);
        }
    }, []);

    useEffect(() => {
        // Al cambiar de conductor o de día se parte limpio: no se muestra la ruta del anterior mientras carga la nueva.
        setRouteData(null); setDoneRoad(null); setPlanState(null); setRouteError(null); setFocusId(null);
        lastRouteFitRef.current = '';
        if (!selectedDriverId) { routeReqRef.current++; return; }
        loadRoute(selectedDriverId, routeDate, false);
        const timer = routeDate === todayLogical ? setInterval(() => loadRoute(selectedDriverId, routeDate, true), 30000) : null;
        return () => { if (timer) clearInterval(timer); routeReqRef.current++; };
    }, [selectedDriverId, routeDate]); // eslint-disable-line react-hooks/exhaustive-deps

    const visits = useMemo(() => (routeData ? visitsOf(routeData.stops) : []), [routeData]);
    const pending = useMemo(() => (routeData ? pendingOf(routeData.stops) : []), [routeData]);
    const quality = useMemo(() => visitQuality(visits), [visits]);
    const without = useMemo<RouteStop[]>(() => (routeData ? withoutLocation(routeData.stops.filter(s => ['done', 'attempt', 'open'].includes(stopKind(s)))) : []), [routeData]);
    const visitsKey = visits.map(v => v.stop.id).join(',');
    const pendingKey = pending.map(s => s.id).join(',');
    const wantDone = routeMode === 'both' || routeMode === 'done';
    const wantPlan = (routeMode === 'both' || routeMode === 'plan') && !!routeData?.isToday;

    // Trazado por calles de la ruta realizada (se recalcula solo si cambian las paradas visitadas).
    useEffect(() => {
        const mine = ++doneReqRef.current;
        if (!wantDone || visits.length < 2) { setDoneRoad(null); return; }
        planDoneRoute(visits).then(r => { if (doneReqRef.current === mine) setDoneRoad(r); }).catch(() => { if (doneReqRef.current === mine) setDoneRoad(null); });
    }, [visitsKey, wantDone]); // eslint-disable-line react-hooks/exhaustive-deps

    // Ruta sugerida: se recalcula cuando cambia el conjunto de paradas pendientes (p. ej. tras una entrega) o con "Recalcular". NO en cada
    // movimiento del conductor, para no saturar el servicio de calles; sale de su posición del momento del cálculo.
    useEffect(() => {
        const mine = ++planReqRef.current;
        if (!wantPlan || !selectedDriverId) { setPlanState(null); setPlanning(false); return; }
        const drv = driverStatusesRef.current.find(d => d.id === selectedDriverId);
        const fresh = !!drv && drv.latitude != null && drv.longitude != null && !!drv.lastUpdate && Date.now() - drv.lastUpdate.getTime() < GPS_FRESH_MS;
        const lastVisit = visits[visits.length - 1];
        let start: LatLng | null = null;
        let startKind: PlannedRoute['startKind'] = 'free';
        if (fresh) { start = [drv!.latitude as number, drv!.longitude as number]; startKind = 'driver'; }
        else if (lastVisit) { start = [lastVisit.stop.lat, lastVisit.stop.lng]; startKind = 'lastStop'; }
        setPlanning(true);
        planRemainingRoute({ stops: pending, start, startKind })
            .then(plan => { if (planReqRef.current === mine) setPlanState({ plan, at: new Date() }); })
            .catch(err => { console.error('No se pudo calcular la ruta sugerida', err); })
            .finally(() => { if (planReqRef.current === mine) setPlanning(false); });
    }, [pendingKey, wantPlan, replanTick, selectedDriverId]); // eslint-disable-line react-hooks/exhaustive-deps

    const etas = useMemo(() => (planState && routeData?.isToday ? etaTimes(planState.plan.legs, planState.at, SERVICE_SECONDS) : []), [planState, routeData?.isToday]);
    const routeActive = !!selectedDriverId && routeMode !== 'off' && !!routeData && !routeError;

    // ---------- dibujo de la ruta en el mapa ----------
    useEffect(() => {
        const map = mapRef.current;
        const group = routeLayerRef.current;
        if (!map || !group) return;
        group.clearLayers();
        stopMarkersRef.current = {};
        if (!routeActive || !routeData) return;

        const bounds: LatLng[] = [];
        const addLine = (pts: LatLng[], color: string, dashed: boolean) => {
            if (pts.length < 2) return;
            L.polyline(pts, { color: '#ffffff', weight: 8, opacity: 0.85, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
            L.polyline(pts, { color, weight: 4, opacity: 0.95, dashArray: dashed ? '9 9' : undefined, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(group);
            pointsAlong(pts, 650).forEach(a => {
                L.marker(a.at, {
                    icon: L.divIcon({ html: `<div class="rt-arrow" style="transform:rotate(${a.bearing.toFixed(0)}deg);border-bottom-color:${color}"></div>`, className: 'rt-arrow-wrap', iconSize: [10, 10], iconAnchor: [5, 5] }),
                    interactive: false, keyboard: false,
                }).addTo(group);
            });
            pts.forEach(p => bounds.push(p));
        };
        const addStop = (n: number, color: string, stop: RouteStop & { lat: number; lng: number }, popup: string, isNext = false) => {
            const marker = L.marker([stop.lat, stop.lng], {
                icon: L.divIcon({ html: `<div class="rt-pin${stop.approx ? ' approx' : ''}${isNext ? ' next' : ''}" style="background:${color}">${n}</div>`, className: '', iconSize: [26, 26], iconAnchor: [13, 13] }),
                zIndexOffset: isNext ? 1000 : 0,
            }).bindPopup(popup, { maxWidth: 260 }).addTo(group);
            stopMarkersRef.current[stop.id] = marker;
            bounds.push([stop.lat, stop.lng]);
        };
        const stopInfo = (s: RouteStop) => `
            <div style="font-size:12px;margin-top:3px">${esc(s.address || 'Sin dirección')}</div>
            <div style="font-size:11px;color:#6b7280">${esc(s.commune)}${s.approx ? ' · ubicación aproximada' : ''}</div>
            <div style="font-size:11px;margin-top:3px">${esc(s.recipient || '')}</div>
            <div style="font-size:10px;color:#6b7280">Paquete ${esc(s.id)}${s.flexCode ? ` · FLEX ${esc(s.flexCode)}` : ''}</div>`;

        if (wantDone) {
            if (doneRoad && doneRoad.geometry.length > 1) addLine(doneRoad.geometry, ROUTE_COLORS.done, false);
            else if (visits.length > 1) addLine(visits.map(v => [v.stop.lat, v.stop.lng] as LatLng), ROUTE_COLORS.done, false);   // mientras llega el trazado por calles
            visits.forEach((v, i) => addStop(i + 1, v.kind === 'done' ? ROUTE_COLORS.done : ROUTE_COLORS.attempt, v.stop,
                `<div><b>#${i + 1} · ${v.kind === 'done' ? 'Entregada' : 'No se pudo entregar'}</b>${stopInfo(v.stop)}<div style="font-size:11px;margin-top:3px">Hora real: <b>${fmtClock(v.at, tz)}</b></div></div>`));
        }
        if (wantPlan && planState) {
            const { plan } = planState;
            if (plan.geometry.length > 1) addLine(plan.geometry, ROUTE_COLORS.plan, true);
            plan.order.forEach((s, i) => addStop(visits.length + i + 1, ROUTE_COLORS.plan, s,
                `<div><b>#${visits.length + i + 1} · Pendiente${i === 0 ? ' (siguiente)' : ''}</b>${stopInfo(s)}${etas[i] ? `<div style="font-size:11px;margin-top:3px">Llegada estimada: <b>${fmtClock(etas[i], tz)}</b></div>` : ''}</div>`, i === 0));
        }

        // Encuadra la ruta una vez por conductor/día/modo (no en cada refresco, o el mapa se movería solo mientras el admin lo mira).
        const key = `${selectedDriverId}|${routeData.date}|${routeMode}`;
        if (lastRouteFitRef.current !== key && bounds.length > 0) {
            lastRouteFitRef.current = key;
            const drv = driverStatusesRef.current.find(d => d.id === selectedDriverId);
            if (drv?.latitude != null && drv?.longitude != null && drv.isOnline) bounds.push([drv.latitude, drv.longitude]);
            try { map.fitBounds(L.latLngBounds(bounds), { padding: [50, 50], maxZoom: 15 }); } catch (err) { console.error('No se pudo encuadrar la ruta', err); }
        }

        // Las flechas de dirección estorban con el mapa muy alejado: solo se ven desde el zoom 13.
        const container = map.getContainer();
        const applyZoom = () => container.classList.toggle('rt-hide-arrows', map.getZoom() < 13);
        applyZoom();
        map.on('zoomend', applyZoom);
        return () => { map.off('zoomend', applyZoom); };
    }, [routeActive, routeData, visits, doneRoad, planState, etas, wantDone, wantPlan, routeMode, selectedDriverId, tz]);

    const handleFocusStop = useCallback((id: string) => {
        setFocusId(id);
        const marker = stopMarkersRef.current[id];
        if (marker && mapRef.current) {
            mapRef.current.setView(marker.getLatLng(), Math.max(mapRef.current.getZoom(), 16), { animate: true });
            marker.openPopup();
        }
    }, []);

    // ---------- conductores y pines ----------
    useEffect(() => {
        if (!mapRef.current || !markersLayerRef.current || !packageClusterRef.current) return;

        markersLayerRef.current.clearLayers();
        packageClusterRef.current.clearLayers();

        const driverIcon = L.divIcon({
            html: `<div class="p-1 bg-[var(--background-secondary)] rounded-full shadow-lg"><div class="w-8 h-8 bg-[var(--brand-primary)] text-white rounded-full flex items-center justify-center"><svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg></div></div>`,
            className: '', iconSize: [40, 40], iconAnchor: [20, 40]
        });

        const packageIcons: { [key in keyof typeof STATUS_COLORS]: any } = {} as any;
        (Object.keys(STATUS_COLORS) as Array<keyof typeof STATUS_COLORS>).forEach(key => {
            packageIcons[key] = L.divIcon({
                html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="${STATUS_COLORS[key]}" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,0.5));"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`,
                className: '', iconSize: [28, 28], iconAnchor: [14, 28]
            });
        });

        activeDrivers.forEach(driver => {
            if (driver.latitude && driver.longitude) {
                const position: [number, number] = [driver.latitude, driver.longitude];
                const marker = L.marker(position, { icon: driverIcon })
                    .bindPopup(`<b>${esc(driver.name)}</b><br>${esc(driver.email)}`)
                    .bindTooltip(`<b>${esc(driver.name)}</b>`, {
                        permanent: true, direction: 'top', offset: [0, -40], className: 'driver-name-tooltip'
                    });
                markersLayerRef.current.addLayer(marker);
            }
        });

        // Solo se dibujan los paquetes del conductor seleccionado - con todos los
        // conductores a la vez, el mapa se llena de cientos de puntos superpuestos
        // e ilegibles (el problema original que motivo este cambio). Cuando la ruta
        // del conductor está visible, sus paradas numeradas reemplazan a estos pines.
        const visiblePackages = selectedDriverId && !routeActive
            ? packages.filter(p => p.driverId === selectedDriverId && p.destLatitude && p.destLongitude)
            : [];

        visiblePackages.forEach(pkg => {
            const position: [number, number] = [pkg.destLatitude!, pkg.destLongitude!];
            const assignedDriver = allUsers.find(u => u.id === pkg.driverId);
            const colorKey = getPackageColorKey(pkg.status as string);
            const statusLabel = (pkg.status || '').replace(/_/g, ' ');
            const labelColorClass = colorKey === 'delivered' ? 'text-green-600' : colorKey === 'problem' ? 'text-red-600' : colorKey === 'pending' ? 'text-blue-600' : 'text-gray-500';

            const popupContent = `
                <div class="p-1">
                    <b class="text-sm">Paquete: ${esc(pkg.id)}</b><br>
                    ${pkg.meliFlexCode ? `<span class="text-[10px] bg-yellow-100 text-yellow-800 px-1 rounded font-bold">FLEX: ${esc(pkg.meliFlexCode)}</span><br>` : ''}
                    <span class="text-xs font-bold ${labelColorClass}">Estado: ${esc(statusLabel)}</span><br>
                    <span class="text-xs">Dest: ${esc(pkg.recipientName)}</span><br>
                    <span class="text-xs">Dir: ${esc(pkg.recipientAddress)}</span><br>
                    <span class="text-xs">Conductor: ${esc(assignedDriver?.name || 'No asignado')}</span><br>
                    <span class="text-[10px] text-gray-500">Act: ${formatTimeAgo(new Date(pkg.updatedAt))}</span>
                </div>
            `;

            const marker = L.marker(position, {
                icon: packageIcons[colorKey]
            }).bindPopup(popupContent);
            packageClusterRef.current.addLayer(marker);
        });

        // Encuadra el mapa a los paquetes del conductor recien seleccionado, una sola vez por
        // seleccion (no en cada refresco de 15s, o el mapa se re-centraria solo mientras el
        // admin intenta mirarlo). Con la ruta visible, el encuadre lo hace el dibujo de la ruta.
        if (selectedDriverId !== lastFitDriverIdRef.current) {
            lastFitDriverIdRef.current = selectedDriverId;
            if (selectedDriverId && !routeActive) {
                try {
                    const bounds = packageClusterRef.current.getBounds();
                    const selDriver = activeDrivers.find(d => d.id === selectedDriverId);
                    if (selDriver?.latitude && selDriver?.longitude) {
                        bounds.extend([selDriver.latitude, selDriver.longitude]);
                    }
                    if (bounds.isValid && bounds.isValid()) {
                        mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
                    }
                } catch (err) {
                    console.error('[LiveMap] Error al encuadrar el mapa:', err);
                }
            }
        }

    }, [activeDrivers, packages, allUsers, selectedDriverId, routeActive]);

    const handleDriverClick = (driver: typeof driverStatuses[0]) => {
        setRouteDate(todayLogical);
        setSelectedDriverId(prev => prev === driver.id ? null : driver.id);
        if (driver.isOnline && driver.latitude && driver.longitude && mapRef.current) {
            mapRef.current.setView([driver.latitude, driver.longitude], 14, { animate: true });
        }
    };

    const handleCopyInstructions = () => {
        const instructions = `
        Un conductor aparece 'Offline' si no podemos recibir su ubicación. Pídele que revise lo siguiente en su teléfono (es muy importante seguir todos los pasos):

        1.  📍 *GPS / Ubicación:* Asegurarse de que los servicios de ubicación estén *ACTIVADOS*.

        2.  🔐 *Permisos de la App:* Ir a Ajustes -> Aplicaciones -> (Nombre de la App) -> Permisos y verificar que la *UBICACIÓN* esté permitida ("Permitir siempre" o "Mientras se usa").

        3.  🔋 *Ahorro de Batería:* Ir a Ajustes -> Batería -> Optimización de batería y *EXCLUIR* nuestra app para que no se cierre en segundo plano.

        4.  🔌 *IMPORTANTE - App sin Uso:* En la misma pantalla de información de la app, buscar una opción llamada "Pausar actividad si no se usa" o "Quitar permisos si la app no se usa" y *DESACTIVARLA*.

        5.  📶 *Conexión a Internet:* Verificar que tenga una conexión de datos móviles o Wi-Fi estable.
        `;
        navigator.clipboard.writeText(instructions.trim()).then(() => {
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        }).catch(err => {
            console.error('Failed to copy text: ', err);
        });
    };

    return (
        <>
            <style>{`
                .driver-name-tooltip { background-color: var(--background-secondary); color: var(--text-primary); border: 1px solid var(--border-secondary); padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); white-space: nowrap; }
                .driver-name-tooltip.leaflet-tooltip-top:before { border-top-color: var(--border-secondary); }
                .rt-pin { width: 26px; height: 26px; border-radius: 50%; color: #fff; font: 800 11px/22px system-ui, -apple-system, 'Segoe UI', sans-serif; text-align: center; border: 2px solid #fff; box-shadow: 0 1px 5px rgba(0,0,0,.5); box-sizing: border-box; }
                .rt-pin.approx { border-style: dashed; }
                .rt-pin.next { box-shadow: 0 0 0 4px rgba(37,99,235,.38), 0 1px 5px rgba(0,0,0,.5); }
                .rt-arrow { width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 10px solid #16a34a; filter: drop-shadow(0 0 1px #fff); }
                .rt-hide-arrows .rt-arrow-wrap { display: none; }
            `}</style>
            <div className="flex flex-col md:flex-row gap-4" style={{ height: '75vh' }}>
                <div className="flex-grow bg-[var(--background-secondary)] shadow-md rounded-lg p-4 h-full relative">
                    <div ref={mapContainerRef} className="h-full w-full rounded-md" style={{ zIndex: 0 }} />

                    {!selectedDriverId && (
                        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-[var(--background-secondary)] px-4 py-2 rounded-lg shadow-lg border border-[var(--border-primary)] z-[1000] text-sm font-semibold text-[var(--text-secondary)]">
                            Selecciona un conductor para ver su ruta del día
                        </div>
                    )}

                    {/* Map Legend */}
                    <div className="absolute bottom-8 left-8 bg-[var(--background-secondary)] p-3 rounded-lg shadow-lg border border-[var(--border-primary)] z-[1000] text-xs">
                        <button type="button" onClick={() => setLegendOpen(o => !o)} aria-expanded={legendOpen} title={legendOpen ? 'Ocultar la leyenda' : 'Mostrar la leyenda'}
                            className={`w-full flex items-center justify-between gap-6 font-bold text-left ${legendOpen ? 'mb-2 border-b border-[var(--border-primary)] pb-1' : ''}`}>
                            <span>Leyenda</span><span aria-hidden="true" className="text-[var(--text-muted)]">{legendOpen ? '–' : '+'}</span>
                        </button>
                        <div className={`space-y-2 ${legendOpen ? '' : 'hidden'}`}>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full border border-white" style={{ backgroundColor: STATUS_COLORS.delivered }}></div>
                                <span>Entregado</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full border border-white" style={{ backgroundColor: STATUS_COLORS.pending }}></div>
                                <span>Pendiente / En Ruta</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full border border-white" style={{ backgroundColor: STATUS_COLORS.problem }}></div>
                                <span>Problema / Reagendado / Cancelado</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-4 bg-[var(--brand-primary)] rounded-full flex items-center justify-center">
                                    <div className="w-2 h-2 bg-white rounded-full"></div>
                                </div>
                                <span>Conductor</span>
                            </div>
                            {routeActive && (
                                <>
                                    <div className="pt-1 mt-1 border-t border-[var(--border-primary)] flex items-center gap-2"><span className="inline-block w-5 h-[4px] rounded" style={{ background: ROUTE_COLORS.done }}></span><span>Ruta realizada (orden real)</span></div>
                                    <div className="flex items-center gap-2"><span className="inline-block w-5 h-0 border-t-[4px] border-dashed" style={{ borderColor: ROUTE_COLORS.plan }}></span><span>Ruta sugerida (lo pendiente)</span></div>
                                    <div className="text-[10px] text-[var(--text-muted)] max-w-[190px]">El número es el orden de la parada en el día. Borde punteado: ubicación aproximada.</div>
                                </>
                            )}
                        </div>
                    </div>
                </div>

                <div className="w-full md:w-80 lg:w-96 flex-shrink-0 bg-[var(--background-secondary)] shadow-md rounded-lg flex flex-col h-full min-h-0">
                    <div className="flex items-center justify-between p-4 border-b border-[var(--border-primary)] flex-shrink-0">
                        <h3 className="text-lg font-bold text-[var(--text-primary)]">
                            Estado de Conductores
                        </h3>
                        <button
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                            title="Refrescar estado"
                            className="p-2 rounded-full hover:bg-[var(--background-hover)] transition-colors disabled:opacity-50 disabled:cursor-wait"
                        >
                            {isRefreshing ? (
                                <IconLoader className="w-5 h-5 animate-spin" />
                            ) : (
                                <IconRefresh className="w-5 h-5" />
                            )}
                        </button>
                    </div>
                    <div className="p-3 border-b border-[var(--border-primary)] flex-shrink-0 space-y-2">
                        <div className="relative">
                            <IconSearch className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                            <input
                                type="text"
                                value={driverSearch}
                                onChange={(e) => setDriverSearch(e.target.value)}
                                placeholder="Buscar conductor..."
                                className="w-full pl-8 pr-8 py-2 text-sm bg-[var(--background-primary)] border border-[var(--border-secondary)] rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                            />
                            {driverSearch && (
                                <button
                                    onClick={() => setDriverSearch('')}
                                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                    aria-label="Limpiar búsqueda"
                                >
                                    <IconX className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                        {selectedDriverId && (
                            <button
                                onClick={() => setSelectedDriverId(null)}
                                className="w-full text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center justify-center gap-1 py-1"
                            >
                                <IconX className="w-3.5 h-3.5" /> Ver todos los conductores
                            </button>
                        )}
                    </div>
                    <div className={`overflow-y-auto custom-scrollbar ${selectedDriverId ? 'flex-shrink-0 max-h-[30%]' : 'flex-grow'}`}>
                        {visibleDriverRows.length === 0 && <p className="p-4 text-sm text-[var(--text-muted)]">Ningún conductor coincide con la búsqueda.</p>}
                        {visibleDriverRows.map(driver => (
                            <button
                                key={driver.id}
                                onClick={() => handleDriverClick(driver)}
                                title={driver.isOnline ? undefined : 'Sin ubicación en vivo - igual puedes ver sus entregas del día'}
                                className={`w-full text-left p-3 flex items-center gap-3 border-b border-[var(--border-primary)] hover:bg-[var(--background-hover)] transition-colors ${selectedDriverId === driver.id ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''}`}
                            >
                                <span className={`w-3 h-3 rounded-full flex-shrink-0 ${driver.isOnline ? 'bg-green-500 animate-pulse' : 'bg-slate-400'}`}></span>
                                <div className="flex-grow min-w-0">
                                    <div className="flex justify-between items-start gap-2">
                                        <p className="font-semibold text-sm truncate text-[var(--text-primary)]">{driver.name}</p>
                                        <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px] font-black">
                                            <span title="Entregados" className="flex items-center gap-0.5 text-green-700">
                                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.delivered }}></span>{driver.deliveredCount}
                                            </span>
                                            <span title="Pendientes" className="flex items-center gap-0.5 text-blue-700">
                                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.pending }}></span>{driver.pendingCount}
                                            </span>
                                            <span title="Con problema / reagendado / cancelado" className="flex items-center gap-0.5 text-red-700">
                                                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STATUS_COLORS.problem }}></span>{driver.problemsCount}
                                            </span>
                                        </div>
                                    </div>
                                    <p className="text-xs text-[var(--text-muted)]">
                                        Últ. act: {formatTimeAgo(driver.lastUpdate)}
                                    </p>
                                </div>
                            </button>
                        ))}
                    </div>
                    {selectedDriverId && selectedStatus ? (
                        <DriverRoutePanel
                            driverName={selectedStatus.name}
                            isOnline={selectedStatus.isOnline}
                            lastUpdate={selectedStatus.lastUpdate}
                            tz={tz}
                            date={routeDate}
                            today={todayLogical}
                            onDateChange={setRouteDate}
                            mode={routeMode}
                            onModeChange={setRouteMode}
                            loading={routeLoading}
                            error={routeError}
                            onRetry={() => loadRoute(selectedDriverId, routeDate, false)}
                            data={routeData}
                            visits={visits}
                            quality={quality}
                            doneRoad={doneRoad}
                            plan={planState ? planState.plan : null}
                            planning={planning}
                            onReplan={() => setReplanTick(t => t + 1)}
                            etas={etas}
                            without={without}
                            focusId={focusId}
                            onFocusStop={handleFocusStop}
                            onClose={() => setSelectedDriverId(null)}
                        />
                    ) : (
                     <div className="p-4 border-t border-[var(--border-primary)] bg-[var(--background-muted)] rounded-b-lg">
                        <h4 className="text-sm font-bold text-[var(--text-primary)] mb-2">Guía de Solución Rápida</h4>
                        <ul className="space-y-2.5 text-xs text-[var(--text-secondary)]">
                            <li className="flex items-start gap-2"><IconMapPin className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500"/> <strong>GPS / Ubicación:</strong> Asegurarse de que esté ACTIVADO.</li>
                            <li className="flex items-start gap-2"><IconMapPin className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-500"/> <strong>Permisos:</strong> Permitir la ubicación "Siempre" o "Mientras se usa la app".</li>
                            <li className="flex items-start gap-2"><IconBattery className="w-4 h-4 mt-0.5 flex-shrink-0 text-orange-500"/> <strong>Batería:</strong> Quitar la app de las optimizaciones de batería.</li>
                            <li className="flex items-start gap-2"><IconPower className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-500"/> <strong className="text-red-600">App sin Uso (Importante):</strong> DESACTIVAR "Pausar actividad si no se usa".</li>
                            <li className="flex items-start gap-2"><IconWifi className="w-4 h-4 mt-0.5 flex-shrink-0 text-green-500"/> <strong>Internet:</strong> Verificar conexión de datos o Wi-Fi.</li>
                        </ul>
                         <button
                            onClick={handleCopyInstructions}
                            className={`w-full mt-3 px-3 py-2 text-xs font-semibold rounded-md flex items-center justify-center gap-2 transition-colors ${copySuccess ? 'bg-green-600 text-white' : 'bg-[var(--background-secondary)] text-[var(--text-secondary)] hover:bg-[var(--background-hover)] border border-[var(--border-secondary)]'}`}
                         >
                             <IconCopy className="w-4 h-4"/>
                             {copySuccess ? '¡Copiado!' : 'Copiar Instrucciones'}
                         </button>
                    </div>
                    )}
                </div>
            </div>
        </>
    );
};

export default LiveMap;
