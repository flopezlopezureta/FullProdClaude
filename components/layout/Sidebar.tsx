
import React, { useContext, useState, useEffect } from 'react';
import { AuthContext } from '../../contexts/AuthContext';
import { api } from '../../services/api';
import { IconPackage, IconUsers, IconUser, IconLogOut, IconLayoutDashboard, IconX, IconChevronDown, IconTruck, IconUserCheck, IconSettings, IconQrcode, IconFileText, IconMapPin, IconChartBar, IconBarChart, IconPieChart, IconTarget, IconClock, IconFileInvoice, IconPlugConnected, IconDownload, IconMap, IconAlertTriangle, IconFileUpload, IconWifi, IconSearch } from '../Icon';
import { Role, DEFAULT_OPERATOR_PERMISSIONS } from '../../constants';

interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

// Aviso de "Nuevo" junto al item del menu, la primera vez que un admin lo ve: parpadea 3 veces y
// desaparece para siempre (por navegador). Subir la version del key si se quiere volver a avisar.
const MELI_STUCK_NEW_BADGE_KEY = 'meliStuckReport_seenNewBadge_v2';
const MELI_STUCK_BLINK_TOGGLES = 6; // 3 parpadeos = 6 cambios de visible/invisible
const MELI_STUCK_BLINK_INTERVAL_MS = 300;

const getRoleInSpanish = (role?: Role): string => {
    if (!role) return '';
    const normalizedRole = String(role).toUpperCase();
    switch (normalizedRole) {
        case Role.Admin:
        case 'ADMINISTRADOR': return 'Administrador';
        case Role.OperadorSistemas: return 'Operador de Sistemas';
        case Role.Driver:
        case 'CHOFER':
        case 'CONDUCTOR': return 'Conductor';
        case Role.Client:
        case 'CLIENTE': return 'Cliente';
        case Role.Facturacion: return 'Facturación';
        case Role.Retiros: return 'Retiros';
        case Role.Auxiliar: return 'Auxiliar';
        default: return role;
    }
}

const Sidebar: React.FC<SidebarProps> = ({ activeView, onNavigate, isOpen, onClose }) => {
  const { user, logout, systemSettings } = useContext(AuthContext)!;
  const isSuperUser = user?.email === 'admin' || user?.email === 'admin@admin.cl';
  const isOp = user?.role === Role.OperadorSistemas;

  // Use defaults if permissions are missing (backward compatibility)
  const permissions = user?.operatorPermissions || (isOp ? DEFAULT_OPERATOR_PERMISSIONS : null);

  const [openMenus, setOpenMenus] = useState<Set<string>>(() => {
    const menus = new Set<string>();
    if (activeView.startsWith('users-')) menus.add('users');
    if (['assign-pickups', 'pickup-report'].includes(activeView)) menus.add('pickups');
    if (['settings', 'integrations'].includes(activeView)) menus.add('configuration');
    if (['delivery-analytics', 'late-deliveries', 'activity-audit', 'fleet-control'].includes(activeView)) menus.add('reports');
    if (['geolocate', 'zone-settings', 'live-map', 'sector-editor', 'projection-map'].includes(activeView)) menus.add('logistics');
    return menus;
  });

  const [hoveredMenu, setHoveredMenu] = useState<string | null>(null);

  const [showMeliStuckNewBadge, setShowMeliStuckNewBadge] = useState(() => {
    try {
      return localStorage.getItem(MELI_STUCK_NEW_BADGE_KEY) !== 'true';
    } catch {
      return false;
    }
  });
  const [meliStuckBadgeVisible, setMeliStuckBadgeVisible] = useState(true);

  useEffect(() => {
    if (!showMeliStuckNewBadge) return;
    let toggles = 0;
    const interval = setInterval(() => {
      setMeliStuckBadgeVisible(v => !v);
      toggles++;
      if (toggles >= MELI_STUCK_BLINK_TOGGLES) {
        clearInterval(interval);
        setShowMeliStuckNewBadge(false);
        try { localStorage.setItem(MELI_STUCK_NEW_BADGE_KEY, 'true'); } catch {}
      }
    }, MELI_STUCK_BLINK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const [usersList, setUsersList] = useState<any[]>([]);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        if (user && ['ADMIN', 'ADMIN_SISTEMAS', 'ADMINISTRADOR'].includes(user.role)) {
          const list = await api.getUsers();
          setUsersList(list);
        }
      } catch (err) {
        console.error("Failed to fetch users in sidebar", err);
      }
    };
    fetchUsers();
  }, [user, activeView]);

  const getSubItemCount = (id: string): number => {
    if (!usersList || usersList.length === 0) return 0;
    const isSuperUserEmail = (email?: string) => email === 'admin' || email === 'admin@admin.cl';
    const currentUserIsSuper = isSuperUserEmail(user?.email);
    // Mirror the same filter logic as UserManagement: non-super admins don't see the superuser
    const activeUsers = usersList.filter((u: any) => {
      if (u.status === 'ELIMINADO') return false;
      if (isSuperUserEmail(u.email) && !currentUserIsSuper) return false;
      return true;
    });
    switch (id) {
      case 'users-clients':
        return activeUsers.filter((u: any) => ['CLIENT', 'CLIENTE'].includes(String(u.role || '').toUpperCase())).length;
      case 'users-drivers':
        return activeUsers.filter((u: any) => ['DRIVER', 'CONDUCTOR', 'CHOFER'].includes(String(u.role || '').toUpperCase())).length;
      case 'users-auxiliares':
        return activeUsers.filter((u: any) => ['AUXILIAR', 'AUX'].includes(String(u.role || '').toUpperCase())).length;
      case 'users-retiros':
        return activeUsers.filter((u: any) => String(u.role || '').toUpperCase() === 'RETIROS').length;
      case 'users-facturacion':
        return activeUsers.filter((u: any) => String(u.role || '').toUpperCase() === 'FACTURACION').length;
      case 'users-admins':
        // ADMIN_SISTEMAS is treated as an admin role throughout the system
        return activeUsers.filter((u: any) => ['ADMIN', 'ADMINISTRADOR', 'ADMIN_SISTEMAS'].includes(String(u.role || '').toUpperCase())).length;
      case 'users-operadores':
        // Only pure OPERADOR_SISTEMAS appear in the Operadores list (ADMIN_SISTEMAS are counted as admins)
        return activeUsers.filter((u: any) => String(u.role || '').toUpperCase() === 'OPERADOR_SISTEMAS').length;
      default:
        return 0;
    }
  };

  const toggleMenu = (id: string) => {
    setOpenMenus(prev => {
      const newMenus = new Set(prev);
      if (newMenus.has(id)) {
        newMenus.delete(id);
      } else {
        newMenus.add(id);
      }
      return newMenus;
    });
  };

  const adminNavItems = [
    { id: 'packages', label: 'Gestión de Paquetes', icon: <IconLayoutDashboard className="h-6 w-6" /> },
    { 
      id: 'reports',
      label: 'Informes Operativos',
      icon: <IconBarChart className="h-6 w-6 text-indigo-600" />,
      subItems: [
        ...((isSuperUser || systemSettings?.fleetControlEnabled !== false) ? [{ id: 'fleet-control', label: 'Control de Flotas & Cierres', icon: <IconTruck className="h-5 w-5 text-indigo-600" /> }] : []),
        { id: 'delivery-analytics', label: 'Análisis Logístico (BI)', icon: <IconBarChart className="h-5 w-5" /> },
        { id: 'activity-audit', label: 'Auditoría de Actividad', icon: <IconFileText className="h-5 w-5 text-amber-600" /> },
        { id: 'late-deliveries', label: 'Auditoría Nocturna (>21h)', icon: <IconClock className="h-5 w-5 text-red-500" /> },
        { id: 'meli-confirmed-stuck', label: 'Pendientes Confirmados Meli', icon: <IconAlertTriangle className="h-5 w-5 text-amber-600" /> },
      ]
    },
    { id: 'driver-performance', label: 'Reporte Conductores', icon: <IconChartBar className="h-6 w-6" /> },
    ...(systemSettings.flexDiscrepancyReportEnabled ? [{ id: 'flex-discrepancies', label: 'Discrepancias de Carga', icon: <IconAlertTriangle className="h-6 w-6 text-red-500" /> }] : []),
    { 
      id: 'logistics',
      label: 'Logística y Mapas',
      icon: <IconMap className="h-6 w-6" />,
      subItems: [
        { id: 'live-map', label: 'Mapa en Vivo', icon: <IconMapPin className="h-5 w-5" /> },
        { id: 'zone-settings', label: 'Gestión de Zonas', icon: <IconMapPin className="h-5 w-5" /> },
        ...(systemSettings?.gisSectorsEnabled ? [{ id: 'sector-editor', label: 'Sectores GIS', icon: <IconMap className="h-5 w-5 text-violet-600" /> }] : []),
        { id: 'geolocate', label: 'Geolocalizar', icon: <IconMap className="h-5 w-5" /> },
        ...(isSuperUser ? [{ id: 'projection-map', label: 'Proyección de Paquetes', icon: <IconChartBar className="h-5 w-5 text-indigo-500" /> }] : []),
      ]
    },
    { id: 'import-orders', label: 'Importar Envíos', icon: <IconDownload className="h-6 w-6" /> },
    { 
      id: 'pickups',
      label: 'Retiros',
      icon: <IconUserCheck className="h-6 w-6" />,
      subItems: [
        { id: 'assign-pickups', label: 'Gestión de Retiros', icon: <IconPackage className="h-5 w-5" /> },
        { id: 'pickup-report', label: 'Reporte de Retiros', icon: <IconChartBar className="h-5 w-5" /> }
      ]
    },
    { 
      id: 'users', 
      label: 'Gestión de Usuarios', 
      icon: <IconUsers className="h-6 w-6" />,
      subItems: [
        { id: 'users-clients', label: 'Clientes', icon: <IconUser className="h-5 w-5" /> },
        { id: 'users-drivers', label: 'Conductores', icon: <IconTruck className="h-5 w-5" /> },
        { id: 'users-auxiliares', label: 'Auxiliares', icon: <IconUser className="h-5 w-5" /> },
        { id: 'users-retiros', label: 'Retiros', icon: <IconUserCheck className="h-5 w-5" /> },
        { id: 'users-facturacion', label: 'Facturación', icon: <IconFileInvoice className="h-5 w-5" /> },
        { id: 'users-admins', label: 'Administradores', icon: <IconUserCheck className="h-5 w-5" /> },
        { id: 'users-operadores', label: 'Operadores Sist.', icon: <IconUserCheck className="h-5 w-5" /> }
      ]
    },
    { id: 'global-billing', label: 'Facturación Masiva', icon: <IconFileInvoice className="h-6 w-6" /> },
    { id: 'billing-summary', label: 'Resumen Operativo de Cobro', icon: <IconChartBar className="h-6 w-6 text-emerald-600" /> },
    { id: 'billing-report', label: 'Informe por Cliente', icon: <IconFileText className="h-6 w-6" /> },
    ...(user?.email === 'admin' ? [{ id: 'superadmin-billing', label: 'Reporte Cobro UF (Superadmin)', icon: <IconFileInvoice className="h-6 w-6 text-rose-600 font-bold" /> }] : []),
    {
      id: 'configuration',
      label: 'Configuración',
      icon: <IconSettings className="h-6 w-6" />,
      subItems: [
        { id: 'settings', label: 'Sistema', icon: <IconSettings className="h-5 w-5" /> },
        { id: 'integrations', label: 'Integraciones', icon: <IconPlugConnected className="h-5 w-5" /> },
        ...(isSuperUser ? [
            { id: 'system-logs', label: 'Logs del Sistema', icon: <IconFileText className="h-5 w-5" /> },
            { id: 'falabella-direct-labels', label: 'Etiquetas Falabella Directo (UAT)', icon: <IconQrcode className="h-5 w-5" /> }
        ] : [])
      ]
    },
    ...(isSuperUser ? [{
      id: 'tools',
      label: 'Herramientas',
      icon: <IconWifi className="h-6 w-6" />,
      subItems: [
            { id: 'app-updates', label: 'Actualizaciones de la App', icon: <IconFileUpload className="h-5 w-5" /> },
            { id: 'cloudflare-diagnostics', label: 'Diagnóstico Cloudflare', icon: <IconWifi className="h-5 w-5" /> },
            { id: 'network-traffic', label: 'Tráfico de Red', icon: <IconBarChart className="h-5 w-5" /> },
            { id: 'emergency-lookups', label: 'Búsquedas de Emergencia Meli', icon: <IconSearch className="h-5 w-5" /> }
      ]
    }] : [])
  ].filter(item => !('subItems' in item) || (item as any).subItems.length > 0);

  const operadorSistemasNavItems = [
    { id: 'packages', label: 'Gestión de Paquetes', icon: <IconLayoutDashboard className="h-6 w-6" />, permission: 'canManagePackages' },
    { 
      id: 'reports',
      label: 'Informes Operativos',
      icon: <IconBarChart className="h-6 w-6 text-indigo-600" />,
      permission: 'canViewReports',
      subItems: [
        { id: 'delivery-analytics', label: 'Análisis Logístico (BI)', icon: <IconBarChart className="h-5 w-5" /> },
        { id: 'activity-audit', label: 'Auditoría de Actividad', icon: <IconFileText className="h-5 w-5 text-amber-600" /> },
        { id: 'late-deliveries', label: 'Auditoría Nocturna (>21h)', icon: <IconClock className="h-5 w-5 text-red-500" /> },
      ]
    },
    { id: 'driver-performance', label: 'Reporte Conductores', icon: <IconChartBar className="h-6 w-6" />, permission: 'canViewReports' },
    ...(systemSettings.flexDiscrepancyReportEnabled ? [{ id: 'flex-discrepancies', label: 'Discrepancias de Carga', icon: <IconAlertTriangle className="h-6 w-6 text-red-500" />, permission: 'canManagePackages' }] : []),
    { 
      id: 'logistics',
      label: 'Logística y Mapas',
      icon: <IconMap className="h-6 w-6" />,
      subItems: [
        ...(permissions?.canManageDrivers ? [{ id: 'live-map', label: 'Mapa en Vivo', icon: <IconMapPin className="h-5 w-5" /> }] : []),
        ...(permissions?.canManageZones ? [{ id: 'zone-settings', label: 'Gestión de Zonas', icon: <IconMapPin className="h-5 w-5" /> }] : []),
        ...(permissions?.canManagePackages ? [{ id: 'geolocate', label: 'Geolocalizar', icon: <IconMap className="h-5 w-5" /> }] : []),
      ]
    },
    { id: 'import-orders', label: 'Importar Envíos', icon: <IconDownload className="h-6 w-6" />, permission: 'canManagePackages' },
    { 
      id: 'pickups',
      label: 'Retiros',
      icon: <IconUserCheck className="h-6 w-6" />,
      permission: 'canBulkActions',
      subItems: [
        { id: 'assign-pickups', label: 'Gestión de Retiros', icon: <IconPackage className="h-5 w-5" /> },
        { id: 'pickup-report', label: 'Reporte de Retiros', icon: <IconChartBar className="h-5 w-5" /> }
      ]
    },
    { 
      id: 'users', 
      label: 'Gestión de Usuarios', 
      icon: <IconUsers className="h-6 w-6" />,
      subItems: [
        ...(permissions?.canManageClients ? [{ id: 'users-clients', label: 'Clientes', icon: <IconUser className="h-5 w-5" /> }] : []),
        ...(permissions?.canManageDrivers ? [{ id: 'users-drivers', label: 'Conductores', icon: <IconTruck className="h-5 w-5" /> }] : []),
        ...(permissions?.canManageDrivers ? [{ id: 'users-auxiliares', label: 'Auxiliares', icon: <IconUser className="h-5 w-5" /> }] : []),
        ...(permissions?.canBulkActions ? [{ id: 'users-retiros', label: 'Retiros', icon: <IconUserCheck className="h-5 w-5" /> }] : []),
        ...(permissions?.canViewReports ? [{ id: 'users-facturacion', label: 'Facturación', icon: <IconFileInvoice className="h-5 w-5" /> }] : []),
      ]
    },
    { id: 'global-billing', label: 'Facturación Masiva', icon: <IconFileInvoice className="h-6 w-6" />, permission: 'canViewReports' },
    { id: 'billing-report', label: 'Informe por Cliente', icon: <IconFileText className="h-6 w-6" />, permission: 'canViewReports' },
    {
      id: 'configuration',
      label: 'Configuración',
      icon: <IconSettings className="h-6 w-6" />,
      permission: 'canManageSettings',
      subItems: [
        { id: 'settings', label: 'Sistema', icon: <IconSettings className="h-5 w-5" /> },
        ...(permissions?.canManageIntegrations ? [{ id: 'integrations', label: 'Integraciones', icon: <IconPlugConnected className="h-5 w-5" /> }] : []),
      ]
    }
  ].filter(item => {
    if ((item as any).permission && permissions) {
        return (permissions as any)[(item as any).permission];
    }
    if ('subItems' in item) {
        return (item.subItems as any[]).length > 0;
    }
    return true;
  });
  const clientNavItems = [
    { id: 'my-creations', label: 'Mis Paquetes Creados', icon: <IconPackage className="h-6 w-6" /> },
    { id: 'my-performance', label: 'Rendimiento de Envíos', icon: <IconChartBar className="h-6 w-6" /> },
    { id: 'settings', label: 'Configuración', icon: <IconSettings className="h-6 w-6" /> },
  ];

  const facturacionNavItems = [
    { id: 'global-billing', label: 'Facturación Masiva', icon: <IconFileInvoice className="h-6 w-6" /> },
    { id: 'billing-report', label: 'Informe por Cliente', icon: <IconFileText className="h-6 w-6" /> },
  ];

  const retirosNavItems: any[] = [
      { id: 'assign-pickups', label: 'Gestión de Retiros', icon: <IconUserCheck className="h-6 w-6" /> },
      { id: 'pickup-report', label: 'Reporte de Retiros', icon: <IconChartBar className="h-6 w-6" /> },
  ];

  const auxiliarNavItems = [
    { id: 'scan-dispatch', label: 'Despachar Paquetes', icon: <IconQrcode className="h-6 w-6" /> },
  ];

  const filteredAdminNavItems = adminNavItems.filter(item => {
    if (isSuperUser) return true;
    
    // Non-superuser Admin: Only allowed sections
    const allowedIds = [
      'packages', 
      'reports',
      'driver-performance',
      'flex-discrepancies',
      'geolocate', 
      'import-orders', 
      'pickups', 
      'users',
      'logistics', 
      'global-billing',
      'billing-summary',
      'billing-report',
      'superadmin-billing',
      'activity-audit',
      'late-deliveries',
      'configuration'
    ];
    return allowedIds.includes(item.id);
  });

  const userRole = String(user?.role || '').toUpperCase();
  let navItems;
  switch (userRole) {
      case 'ADMIN':
      case 'ADMINISTRADOR':
      case 'ADMIN_SISTEMAS':
          navItems = filteredAdminNavItems;
          break;
      case 'OPERADOR_SISTEMAS':
          navItems = operadorSistemasNavItems;
          break;
      case 'CLIENT':
      case 'CLIENTE':
          navItems = clientNavItems;
          break;
      case 'FACTURACION':
          navItems = facturacionNavItems;
          break;
      case 'RETIROS':
          navItems = retirosNavItems;
          break;
      case 'AUXILIAR':
          navItems = auxiliarNavItems;
          break;
      default:
          navItems = [];
  }

  return (
    <aside className={`w-64 flex-shrink-0 bg-[var(--background-secondary)] flex flex-col border-r border-[var(--border-primary)] transform transition-transform duration-300 ease-in-out fixed inset-y-0 left-0 z-50 lg:static lg:translate-x-0 ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="h-16 flex items-center justify-between px-6 border-b border-[var(--border-primary)]">
        <div className="flex items-center space-x-3 min-w-0">
            <img src="/logo.png" alt="Logo" className="h-10 w-auto flex-shrink-0 drop-shadow-sm" />
            <h1 className="text-xl font-bold text-[var(--text-primary)] truncate">
              {systemSettings.companyName}
            </h1>
        </div>
        <button 
            onClick={onClose} 
            className="lg:hidden p-2 -mr-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--background-hover)] rounded-md"
            aria-label="Cerrar menú"
        >
            <IconX className="w-6 h-6" />
        </button>
      </div>

      <nav className="flex-1 px-4 py-4 space-y-1 custom-scrollbar overflow-y-auto lg:overflow-y-visible">
        {navItems.map(item => (
          'subItems' in item ? (
            <div 
              key={item.id} 
              className="relative"
              onMouseEnter={() => {
                if (window.innerWidth >= 1024) {
                  setHoveredMenu(item.id);
                }
              }}
              onMouseLeave={() => {
                if (window.innerWidth >= 1024) {
                  setHoveredMenu(null);
                }
              }}
            >
              <button
                onClick={() => {
                  if (window.innerWidth < 1024) {
                    toggleMenu(item.id);
                  }
                }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  (item.subItems as any[])?.some(sub => sub.id === activeView) || openMenus.has(item.id)
                    ? 'bg-[var(--background-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--background-hover)] hover:text-[var(--text-primary)]'
                }`}
              >
                <div className="flex items-center space-x-3">
                  {item.icon}
                  <span>{item.label}</span>
                </div>
                <IconChevronDown className={`w-5 h-5 transform transition-transform duration-200 lg:-rotate-90 ${openMenus.has(item.id) ? 'rotate-180' : ''}`} />
              </button>
              
              {/* Mobile Accordion */}
              {openMenus.has(item.id) && (
                <div className="pl-6 pt-1 mt-1 space-y-1 lg:hidden">
                  {(item.subItems as any[]).map(subItem => {
                    const count = getSubItemCount(subItem.id);
                    return (
                      <button
                        key={subItem.id}
                        onClick={() => onNavigate(subItem.id)}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                          activeView === subItem.id
                            ? 'bg-[var(--brand-muted)] text-[var(--brand-text)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--background-hover)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        <div className="flex items-center space-x-3">
                          {subItem.icon}
                          <span>{subItem.label}</span>
                        </div>
                        {count > 0 && (
                          <span className="ml-auto flex-shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-black bg-[var(--brand-primary)] text-white">
                            {count}
                          </span>
                        )}
                        {subItem.id === 'meli-confirmed-stuck' && showMeliStuckNewBadge && meliStuckBadgeVisible && (
                          <span className="ml-auto flex-shrink-0 px-2 py-0.5 text-[9px] font-black uppercase bg-indigo-600 text-white rounded-full">
                            Nuevo
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Desktop Flyout */}
              {hoveredMenu === item.id && (
                <div className="hidden lg:block lg:absolute lg:left-full lg:top-0 lg:pl-2 lg:w-60 lg:z-50 lg:max-h-[85vh] animate-fade-in-up">
                  <div className="lg:bg-[var(--background-secondary)] lg:border lg:border-[var(--border-primary)] lg:rounded-lg lg:shadow-lg lg:p-2 lg:space-y-1 lg:max-h-[85vh] lg:overflow-y-auto custom-scrollbar">
                    {(item.subItems as any[]).map(subItem => {
                      const count = getSubItemCount(subItem.id);
                      return (
                        <button
                          key={subItem.id}
                          onClick={() => {
                            onNavigate(subItem.id);
                            setHoveredMenu(null);
                          }}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                            activeView === subItem.id
                              ? 'bg-[var(--brand-muted)] text-[var(--brand-text)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--background-hover)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          <div className="flex items-center space-x-3">
                            {subItem.icon}
                            <span>{subItem.label}</span>
                          </div>
                          {count > 0 && (
                            <span className="ml-auto flex-shrink-0 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-black bg-[var(--brand-primary)] text-white">
                              {count}
                            </span>
                          )}
                          {subItem.id === 'meli-confirmed-stuck' && showMeliStuckNewBadge && meliStuckBadgeVisible && (
                            <span className="ml-auto flex-shrink-0 px-2 py-0.5 text-[9px] font-black uppercase bg-indigo-600 text-white rounded-full">
                              Nuevo
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                activeView === item.id
                  ? 'bg-[var(--brand-muted)] text-[var(--brand-text)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--background-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          )
        ))}
        
        {/* Direct Access Shortcut for Admin */}
        {/* {user?.role === 'ADMIN' && (
            <button
                onClick={() => setIsScannerTestOpen(true)}
                className="w-full flex items-center space-x-3 px-3 py-2.5 rounded-lg text-sm font-bold text-yellow-600 hover:bg-yellow-50 transition-colors mt-4 border border-yellow-200 border-dashed"
            >
                <IconQrcode className="h-6 w-6" />
                <span>PRUEBA DE LECTOR</span>
            </button>
        )} */}
      </nav>

      <div className="px-4 py-4 border-t border-[var(--border-primary)] space-y-4">
        <div className="flex items-center space-x-3 p-3 bg-[var(--background-muted)] rounded-md">
            <div className="flex-shrink-0">
                <IconUser className="h-8 w-8 p-1.5 bg-[var(--background-secondary)] text-[var(--text-secondary)] rounded-full" />
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{user?.name}</p>
                <p className="text-xs text-[var(--text-muted)] truncate">{getRoleInSpanish(user?.role)}</p>
            </div>
            <button
                onClick={logout}
                className="p-2 text-[var(--text-muted)] hover:text-red-600 hover:bg-red-100 rounded-md transition-colors"
                aria-label="Cerrar sesión"
            >
                <IconLogOut className="h-5 w-5" />
            </button>
        </div>
        <div className="text-center">
            <p className="text-[10px] text-[var(--text-muted)] font-mono">v{(import.meta as any).env.VITE_APP_VERSION}</p>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
