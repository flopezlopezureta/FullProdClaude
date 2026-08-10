// Driver Mobile Layout - Finalized Fix for Icon Resolution
import React, { useState, useEffect, useContext, useMemo, useCallback } from 'react';
import { AuthContext } from '../../contexts/AuthContext';
import { IconHistory, IconLogOut, IconUser, IconUsers, IconBell, IconBellOff, IconArrowUturnLeft, IconTruck, IconChevronLeft, IconChecklist, IconArchive, IconPlus, IconCube, IconX, IconCheck, IconZap, IconMapPin } from '../Icon';
import DriverDashboard from './DriverDashboard';
import ScanDispatchPage from './ScanDispatchPage';
import DeliveryHistoryPage from './DeliveryHistoryPage'; // Keeping it just in case, though unused
import { DriverPerformanceReportPage } from '../admin/DriverPerformanceReportPage';
import ReturnsDashboard from './ReturnsDashboard';
import ScanPickupPage from './ScanPickupPage';
import ColectaPage from './ColectaPage';
import MeliFlexTestScanner from './MeliFlexTestScanner';
import DispatchScanner from '../auxiliar/DispatchScanner';
import FalabellaDirectScanner from '../auxiliar/FalabellaDirectScanner';
import ZoningScanner from './ZoningScanner';
import { DriverPermissions, Notification } from '../../types';
import { api } from '../../services/api';
import { offlineQueue } from '../../services/offlineQueue';
import { processOfflineQueue } from '../../services/offlineQueueProcessor';

type DriverView = 'my-packages' | 'scan-dispatch' | 'scan-dispatch-auxiliar' | 'falabella-direct-scan' | 'scan-pickups' | 'colectas' | 'returns' | 'delivery-history' | 'meli-flex-test' | 'zona';

const menuItems: { id: DriverView; label: string; subtitle?: string; icon: React.ReactNode; color: string, permission?: keyof DriverPermissions }[] = [
    { id: 'my-packages', label: '1. Entregas', subtitle: 'RUTA DE HOY', icon: <IconTruck />, color: 'bg-blue-600', permission: 'canDeliver' },
    { id: 'scan-pickups', label: '2. Retiros', subtitle: 'CLIENTES ASIG.', icon: <IconArchive />, color: 'bg-purple-600', permission: 'canPickup' },
    { id: 'colectas', label: '3. Colecta', subtitle: 'INGRESAR BULTOS', icon: <IconPlus />, color: 'bg-indigo-600', permission: 'canColecta' },
    { id: 'scan-dispatch', label: '4. Mi Despacho', subtitle: 'CARGA PROPIA', icon: <IconChecklist />, color: 'bg-teal-600', permission: 'canDispatch' },
    { id: 'scan-dispatch-auxiliar', label: '4. Auxiliar', subtitle: 'DESPACHAR OTROS', icon: <IconUsers />, color: 'bg-emerald-600', permission: 'canAuxiliar' },
    { id: 'returns', label: '5. Devoluciones', subtitle: 'LOGÍSTICA INVERSA', icon: <IconArrowUturnLeft />, color: 'bg-orange-500', permission: 'canReturn' },
    { id: 'delivery-history', label: '6. Historial', subtitle: 'MIS ENTREGAS', icon: <IconHistory />, color: 'bg-slate-600', permission: 'canViewHistory' },
    { id: 'zona', label: '7. Zonificación', subtitle: 'CONSULTAR SECTOR', icon: <IconMapPin />, color: 'bg-violet-600', permission: 'canZoning' },
    { id: 'meli-flex-test', label: 'Test ML Flex', subtitle: 'PRUEBA LECTURA', icon: <IconZap />, color: 'bg-yellow-500' },
    { id: 'falabella-direct-scan', label: 'Falabella Directo', subtitle: 'RECEPCIÓN', icon: <IconCube />, color: 'bg-rose-600', permission: 'canFalabellaDirect' },
];

const DriverMobileLayout: React.FC = () => {
    const { user, logout, isPushSubscribed, isPushLoading, subscribeToPush, unsubscribeFromPush, systemSettings } = useContext(AuthContext)!;
    const [activeView, setActiveView] = useState<DriverView | 'menu'>('menu');
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [showNotifications, setShowNotifications] = useState(false);
    
    const fetchNotifications = useCallback(async () => {
        try {
            const data = await api.getNotifications();
            setNotifications(data);
        } catch (error) {
            console.error("Error fetching notifications:", error);
        }
    }, []);

    useEffect(() => {
        fetchNotifications();
        const interval = setInterval(fetchNotifications, 60000); // Poll every minute
        return () => clearInterval(interval);
    }, [fetchNotifications]);

    const unreadCount = useMemo(() => notifications.filter(n => !n.read).length, [notifications]);

    const handleMarkAsRead = async (id: string) => {
        try {
            await api.markNotificationAsRead(id);
            setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
        } catch (error) {
            console.error("Error marking notification as read:", error);
        }
    };

    const handleDeleteNotification = async (id: string) => {
        try {
            await api.deleteNotification(id);
            setNotifications(prev => prev.filter(n => n.id !== id));
        } catch (error) {
            console.error("Error deleting notification:", error);
        }
    };
    
    // Automatic background location tracking
    useEffect(() => {
        if (!user) return;

        const sendLocation = () => {
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const { latitude, longitude } = position.coords;
                    try {
                        await api.updateDriverLocation(user.id, latitude, longitude);
                        console.log('Location updated successfully');
                    } catch (error) {
                        console.error("Failed to send location", error);
                    }
                },
                (error) => {
                    console.error("Geolocation error", error);
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
            );
        };

        // Send location immediately on component mount (if user is available)
        sendLocation(); 

        // Set up interval to send location every 30 seconds
        const intervalId = setInterval(sendLocation, 30000);

        // Clean up interval on component unmount
        return () => clearInterval(intervalId);

    }, [user]); // Rerun effect if user object changes

    // Offline queue: drain any deliveries/problems/returns saved locally while disconnected.
    // Lives here (not in DriverDashboard.tsx) because this layout is the one component that
    // stays mounted across every driver tab — a delivery queued while offline on "Entregas"
    // must still sync even if the driver has since switched to "Devoluciones" or any other tab.
    useEffect(() => {
        if (!user) return;

        const syncQueue = async () => {
            if (offlineQueue.getPendingCount() === 0) return;
            await processOfflineQueue();
            // Individual dashboards listen for 'offline-queue-changed' (dispatched by
            // offlineQueue itself on every enqueue/remove) to refresh their own package lists
            // and pending-count banners — no direct coupling needed from here.
        };

        syncQueue();
        window.addEventListener('online', syncQueue);
        const intervalId = setInterval(syncQueue, 30000);

        return () => {
            window.removeEventListener('online', syncQueue);
            clearInterval(intervalId);
        };
    }, [user]);

    const driverPermissions = useMemo(() => {
        return user?.driverPermissions || {
            canDeliver: true,
            canPickup: true,
            canDispatch: true,
            canReturn: true,
            canViewHistory: true,
            canBulkPickup: false,
            canColecta: false,
            canAuxiliar: false,
        };
    }, [user]);

    const availableMenuItems = useMemo(() => {
        return menuItems.filter(item => {
            if (item.id === 'meli-flex-test') {
                // Only Fabian Lopez and Ignacio Lopez can see this test option
                const allowedEmails = ['flopez.cl@gmail.com', 'flopez@selcom.cl', 'ilopez@selcom.cl', 'conductor@conductor.cl'];
                return allowedEmails.includes(user?.email || '');
            }
            if (item.id === 'colectas' && systemSettings.pickupMode !== 'COLECTA') {
                return false;
            }
            if (item.id === 'zona' && !systemSettings?.gisSectorsEnabled) {
                return false;
            }
            return item.permission ? driverPermissions[item.permission] : true;
        });
    }, [driverPermissions, systemSettings.pickupMode, systemSettings?.gisSectorsEnabled, user?.email]);

    const handleSubscriptionToggle = () => {
        if (isPushSubscribed) {
            unsubscribeFromPush();
        } else {
            subscribeToPush();
        }
    };

    const activeViewLabel = useMemo(() => {
        if (activeView === 'menu') return 'Menú Principal';
        return menuItems.find(item => item.id === activeView)?.label || 'Conductor';
    }, [activeView]);

    const renderContent = () => {
        switch (activeView) {
            case 'my-packages': return <DriverDashboard />;
            case 'scan-pickups': return <ScanPickupPage />;
            case 'colectas': return <ColectaPage />;
            case 'scan-dispatch': return <ScanDispatchPage />;
            case 'scan-dispatch-auxiliar': return <DispatchScanner />;
            case 'falabella-direct-scan': return <FalabellaDirectScanner />;
            case 'returns': return <ReturnsDashboard />;
            case 'delivery-history': return <DriverPerformanceReportPage driverIdProp={user?.id} />;
            case 'meli-flex-test': return <MeliFlexTestScanner onBack={() => setActiveView('menu')} />;
            case 'zona': return <ZoningScanner onBack={() => setActiveView('menu')} />;
            default: return null;
        }
    };

    return (
        <div className="flex flex-col h-screen bg-[var(--background-primary)]">
            <header className="bg-[var(--background-secondary)] shadow-sm flex items-center justify-between h-16 px-4 flex-shrink-0 z-10 border-b border-[var(--border-primary)] relative">
                {activeView === 'menu' ? (
                     <>
                        <div className="flex items-center space-x-2">
                            <IconUser className="h-8 w-8 p-1.5 bg-[var(--background-muted)] text-[var(--text-secondary)] rounded-full" />
                            <div>
                                <p className="font-bold text-[var(--text-primary)] truncate text-sm">{user?.name}</p>
                                <p className="text-xs text-[var(--text-muted)]">Conductor</p>
                            </div>
                        </div>
                        <div className="flex items-center space-x-1">
                            <button
                                onClick={() => setShowNotifications(!showNotifications)}
                                className="p-2 text-[var(--text-muted)] hover:bg-[var(--background-hover)] rounded-md transition-colors relative"
                                aria-label="Notificaciones"
                            >
                                <IconBell className={`h-5 w-5 ${unreadCount > 0 ? 'text-blue-600' : ''}`} />
                                {unreadCount > 0 && (
                                    <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
                                        {unreadCount}
                                    </span>
                                )}
                            </button>
                             <button
                                onClick={handleSubscriptionToggle}
                                disabled={isPushLoading}
                                className="p-2 text-[var(--text-muted)] hover:bg-[var(--background-hover)] rounded-md transition-colors disabled:opacity-50"
                                aria-label={isPushSubscribed ? "Desactivar notificaciones" : "Activar notificaciones"}
                            >
                                {isPushSubscribed ? <IconBell className="h-5 w-5 text-green-500" /> : <IconBellOff className="h-5 w-5" />}
                            </button>
                            <button
                                onClick={logout}
                                className="p-2 text-[var(--text-muted)] hover:text-red-600 hover:bg-red-100 rounded-md transition-colors"
                                aria-label="Cerrar sesión"
                            >
                                <IconLogOut className="h-5 w-5" />
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <button onClick={() => setActiveView('menu')} className="p-2 -ml-2 text-[var(--text-muted)] hover:bg-[var(--background-hover)] rounded-full">
                            <IconChevronLeft className="w-6 h-6" />
                        </button>
                        <h1 className="text-lg font-bold text-[var(--text-primary)] absolute left-1/2 -translate-x-1/2">{activeViewLabel}</h1>
                        <button
                            onClick={logout}
                            className="p-2 text-[var(--text-muted)] hover:text-red-600 hover:bg-red-100 rounded-md transition-colors"
                            aria-label="Cerrar sesión"
                        >
                            <IconLogOut className="h-5 w-5" />
                        </button>
                    </>
                )}
            </header>

            {showNotifications && (
                <div className="fixed inset-0 z-50 flex flex-col bg-white">
                    <header className="flex items-center justify-between h-16 px-4 border-b">
                        <h2 className="text-lg font-bold">Notificaciones</h2>
                        <button onClick={() => setShowNotifications(false)} className="p-2">
                            <IconX className="w-6 h-6" />
                        </button>
                    </header>
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        {notifications.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-gray-400">
                                <IconBellOff className="w-12 h-12 mb-2 opacity-20" />
                                <p>No tienes notificaciones</p>
                            </div>
                        ) : (
                            notifications.map(n => (
                                <div key={n.id} className={`p-4 rounded-xl border ${n.read ? 'bg-gray-50 border-gray-100' : 'bg-blue-50 border-blue-100'}`}>
                                    <div className="flex justify-between items-start mb-1">
                                        <h3 className={`font-bold ${n.read ? 'text-gray-700' : 'text-blue-900'}`}>{n.title}</h3>
                                        <div className="flex space-x-2">
                                            {!n.read && (
                                                <button onClick={() => handleMarkAsRead(n.id)} className="text-blue-600 p-1">
                                                    <IconCheck className="w-4 h-4" />
                                                </button>
                                            )}
                                            <button onClick={() => handleDeleteNotification(n.id)} className="text-red-400 p-1">
                                                <IconX className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-sm text-gray-600 mb-2">{n.message}</p>
                                    <span className="text-[10px] text-gray-400 uppercase font-bold">
                                        {new Date(n.createdAt).toLocaleString()}
                                    </span>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            <main className={`flex-1 bg-gray-50 flex flex-col ${
                ['zona', 'meli-flex-test'].includes(activeView) ? 'overflow-hidden' : 'overflow-y-auto no-scrollbar'
            }`}>
                {activeView === 'menu' ? (
                    <div className="p-4">
                        <div className="mb-6 rounded-3xl bg-gradient-to-r from-blue-700 to-indigo-600 p-6 text-white shadow-lg relative overflow-hidden">
                            <div className="relative z-10">
                                <p className="text-xs font-medium opacity-80 mb-1">EMPRESA</p>
                                <h2 className="text-2xl font-bold tracking-tight">{systemSettings.companyName}</h2>
                            </div>
                            <IconCube className="absolute -right-4 -bottom-4 w-32 h-32 text-white opacity-10 rotate-12" />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            {availableMenuItems.map(item => (
                                <button 
                                    key={item.id} 
                                    onClick={() => setActiveView(item.id)} 
                                    className="flex flex-col items-start justify-between p-4 bg-white rounded-2xl shadow-sm border border-gray-100 aspect-[4/3] transition-all duration-200 hover:shadow-md active:scale-95"
                                >
                                    <div className={`w-12 h-12 rounded-xl ${item.color} flex items-center justify-center shadow-sm mb-2`}>
                                        {React.cloneElement(item.icon as React.ReactElement, { className: "w-6 h-6 text-white" })}
                                    </div>
                                    <div className="text-left w-full">
                                        <span className="block font-bold text-gray-800 text-base truncate">{item.label}</span>
                                        {item.subtitle && (
                                            <span className="block text-[10px] font-bold text-gray-400 uppercase tracking-wide mt-0.5 truncate">{item.subtitle}</span>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    ['zona', 'meli-flex-test'].includes(activeView) ? (
                        renderContent()
                    ) : (
                        <div className="p-4">
                            {renderContent()}
                        </div>
                    )
                )}
            </main>
        </div>
    );
};

export default DriverMobileLayout;
