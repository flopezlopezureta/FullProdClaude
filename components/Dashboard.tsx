
import React, { useState, useEffect, useContext, useMemo, useRef, useCallback } from 'react';
import { getLocalDateString, getLogicalDateString } from '../utils/dateUtils';
import type { Package, User } from '../types';
import { PackageStatus, Role, UserStatus } from '../constants';
import { api, PackageCreationData, PackageUpdateData } from '../services/api';
import PackageList from './PackageList';
import PackageDetailModal from './PackageDetailModal';
import AssignDriverModal from './AssignDriverModal';
import CreatePackageModal from './modals/CreatePackageModal';
import EditPackageModal from './modals/EditPackageModal';
import { AuthContext } from '../contexts/AuthContext';
import PackageFilters from './admin/PackageFilters';
import ShippingLabelModal from './client/ShippingLabelModal';
import BatchShippingLabelModal from './client/BatchShippingLabelModal';
import { IconPrinter, IconTrash, IconChevronLeft, IconChevronRight, IconChevronDown, IconFileSpreadsheet, IconUserPlus, IconLoader, IconMercadoLibre, IconShopify, IconArchive, IconCheckCircle, IconRefresh, IconX, IconAlertTriangle } from './Icon';

// Sort direction icon inline components
const IconSortAsc = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9M3 12h5m10 4l-4-4m0 0l-4 4m4-4v12" />
  </svg>
);
const IconSortDesc = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h13M3 8h9M3 12h5m10-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);
import DeletePasswordModal from './admin/DeletePasswordModal';
import ImportPackagesModal from './client/ImportPackagesModal';
import BulkAssignDriverModal from './modals/BulkAssignDriverModal';
import ExportFormatModal from './modals/ExportFormatModal';
import QuickStatusModal from './modals/QuickStatusModal';
import { FleetControlCenter } from './FleetControlCenter';
import { exportToExcel, exportToCSV } from '../services/exportService';

// Fix: declare Chart.js if needed

const customCheckboxClass = "appearance-none h-4 w-4 border border-[var(--border-secondary)] rounded bg-[var(--background-secondary)] checked:bg-[var(--brand-primary)] checked:border-transparent focus:outline-none focus:ring-2 focus:ring-[var(--brand-secondary)] checked:bg-[url(\"data:image/svg+xml,%3csvg viewBox='0 0 16 16' fill='white' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z'/%3e%3c/svg%3e\")]";

const statusOptions: { label: string; value: string | null }[] = [
    { label: 'Todos', value: null },
    { label: 'Cerrados', value: 'closed' },
    { label: 'Pendiente', value: PackageStatus.Pending },
    { label: 'Asignado', value: PackageStatus.Assigned },
    { label: 'Retirado', value: PackageStatus.PickedUp },
    { label: 'En Tránsito', value: PackageStatus.InTransit },
    { label: 'Entregado', value: PackageStatus.Delivered },
    { label: 'Retrasado', value: PackageStatus.Delayed },
    { label: 'Problema', value: PackageStatus.Problem },
    { label: 'Pend. Devolución', value: PackageStatus.ReturnPending },
    { label: 'Devuelto', value: PackageStatus.Returned },
    { label: 'Cancelado', value: PackageStatus.Cancelled },
    { label: 'Reprogramado', value: PackageStatus.Rescheduled },
];


const Dashboard: React.FC = () => {
  const [packages, setPackages] = useState<Package[]>([]);
  const [totalPackages, setTotalPackages] = useState(0);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // Modal states
  const [selectedPackage, setSelectedPackage] = useState<Package | null>(null);

  const handleSelectPackageDetails = async (pkg: Package) => {
    setSelectedPackage(pkg);
    try {
      const fullPkg = await api.getPackage(pkg.id);
      setSelectedPackage(fullPkg);
    } catch (err) {
      console.error("Error fetching full package details:", err);
    }
  };

  const [assigningPackage, setAssigningPackage] = useState<Package | null>(null);
  const [editingPackage, setEditingPackage] = useState<Package | null>(null);
  const [isDeletePasswordModalOpen, setIsDeletePasswordModalOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isBulkAssignModalOpen, setIsBulkAssignModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isQuickStatusModalOpen, setIsQuickStatusModalOpen] = useState(false);
  const [printingPackages, setPrintingPackages] = useState<Package[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [isSyncingMeli, setIsSyncingMeli] = useState(false);
  const [isSyncingShopify, setIsSyncingShopify] = useState(false);
  const [pollingStatus, setPollingStatus] = useState<{ 
    nextPollTime: number; 
    isPolling: boolean; 
    intervalMs: number; 
    pollingStartTime?: number | null;
    totalPackages?: number;
    processedPackages?: number;
  } | null>(null);
  const [shopifyPollingStatus, setShopifyPollingStatus] = useState<{ 
    nextPollTime: number; 
    isPolling: boolean; 
    intervalMs: number; 
    pollingStartTime?: number | null;
  } | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [shopifyTimeLeft, setShopifyTimeLeft] = useState<number>(0);

  // Selection and Pagination states
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc'); // desc = más nuevo primero (default)
  const [isForcingClose, setIsForcingClose] = useState(false);
  const [criticalAlerts, setCriticalAlerts] = useState<Package[]>([]);
  const [showCriticalAlerts, setShowCriticalAlerts] = useState(() => {
      const saved = localStorage.getItem('criticalAlertsPanelOpen');
      if (saved === 'false') return false;
      return true; // Por defecto visible, a menos que el usuario lo haya cerrado explícitamente
  });
  const [lastAlertId, setLastAlertId] = useState(() => {
    return localStorage.getItem('lastCriticalAlertId') || '';
  });
  const [alertView, setAlertView] = useState<'today' | 'history'>('today');
  const [alertDate, setAlertDate] = useState<string>(getLocalDateString());

  const auth = useContext(AuthContext);
  const tz = auth?.systemSettings?.timezone || 'America/Santiago';

  // Filter and View states
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 400);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [flexFilter, setFlexFilter] = useState<'all' | 'flexed' | 'not_flexed'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'ml' | 'web'>('all');
  const [quickFilter, setQuickFilter] = useState<'all' | 'closed' | 'cancelled' | 'rescheduled'>('all');
  const [driverFilter, setDriverFilter] = useState<string>('');
  const [clientFilter, setClientFilter] = useState<string>('');
  const [communeFilter, setCommuneFilter] = useState<string>('');
  const [cityFilter, setCityFilter] = useState<string>('');
  const [startDate, setStartDate] = useState(getLogicalDateString(new Date(), tz));
  const [endDate, setEndDate] = useState(getLogicalDateString(new Date(), tz));
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'all_assigned' | 'first' | 'reassigned'>('all');
  const [dateType, setDateType] = useState<'created' | 'egress'>('created');
  const [isStatusDropdownOpen, setIsStatusDropdownOpen] = useState(false);
  

  const handleForceCloseOld = async () => {
    const cutoffDays = 30;
    if (!window.confirm(`¿Estás seguro de cerrar forzosamente todos los envíos con más de ${cutoffDays} días sin actualización? Esta acción no se puede deshacer.`)) return;
    setIsForcingClose(true);
    try {
        const res = await api.forceCloseOldPackages(cutoffDays);
        alert(`Cierre forzoso completado. ${res.updatedCount ?? 0} envíos cerrados.`);
        fetchData();
    } catch (err: any) {
        alert(err.message || 'Error al forzar el cierre de envíos antiguos.');
    } finally {
        setIsForcingClose(false);
    }
  };

  const handleBulkMarkDelivered = async () => {
      if (selectedPackages.size === 0) return;
      if (!window.confirm(`¿Estás seguro de marcar ${selectedPackages.size} paquetes como ENTREGADOS? Esto también los marcará como facturados.`)) return;
      
      try {
          const packageIds = Array.from(selectedPackages);
          await api.bulkUpdatePackageStatus(packageIds, PackageStatus.Delivered);
          alert('Paquetes actualizados con éxito.');
          setSelectedPackages(new Set());
          fetchData();
      } catch (err: any) {
          alert(err.message || 'Error al actualizar paquetes masivamente.');
      }
  };

  const statusDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchPollingStatus = async () => {
      if (auth?.user?.role !== Role.Admin && !(auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canManageIntegrations)) return;
      try {
        const [meliStatus, shopifyStatus] = await Promise.all([
            api.getMeliPollingStatus(),
            api.getShopifyPollingStatus()
        ]);
        setPollingStatus(meliStatus);
        setShopifyPollingStatus(shopifyStatus);
      } catch (err) {
        console.error('Error fetching polling status:', err);
      }
    };

    fetchPollingStatus();
    const interval = setInterval(fetchPollingStatus, 10000); // Check every 10s
    return () => clearInterval(interval);
  }, [auth?.user?.role]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (pollingStatus) {
        const remaining = Math.max(0, Math.ceil((pollingStatus.nextPollTime - Date.now()) / 1000));
        setTimeLeft(remaining);
      } else {
        setTimeLeft(0);
      }
      if (shopifyPollingStatus) {
        const remainingShopify = Math.max(0, Math.ceil((shopifyPollingStatus.nextPollTime - Date.now()) / 1000));
        setShopifyTimeLeft(remainingShopify);
      } else {
        setShopifyTimeLeft(0);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [pollingStatus, shopifyPollingStatus]);

  const fetchCriticalAlerts = useCallback(async () => {
    try {
      const tz = auth?.systemSettings?.timezone || 'America/Santiago';
      const targetDate = alertView === 'today' ? getLogicalDateString(new Date(), tz) : alertDate;
      const excludeChecked = alertView === 'today'; // Only hide checked alerts in 'Today' view
      
      const { packages: cancelled } = await api.getPackages({ 
        statusFilter: 'CANCELADO', 
        startDate: targetDate, 
        endDate: targetDate,
        dateType: 'updated',
        limit: 50, 
        excludeChecked 
      });
      const { packages: rescheduled } = await api.getPackages({ 
        statusFilter: 'REPROGRAMADO', 
        startDate: targetDate, 
        endDate: targetDate,
        dateType: 'updated',
        limit: 50, 
        excludeChecked 
      });
      const { packages: duplicates } = await api.getPackages({ 
        isDuplicate: 'true', 
        startDate: targetDate, 
        endDate: targetDate,
        dateType: 'updated',
        limit: 50, 
        excludeChecked 
      });
      const { packages: reassigned } = await api.getPackages({ 
        assignmentFilter: 'reassigned', 
        startDate: targetDate, 
        endDate: targetDate,
        dateType: 'updated',
        limit: 50, 
        excludeChecked 
      });
      
      const merged = [...cancelled, ...rescheduled, ...duplicates, ...reassigned].sort((a, b) => 
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      
      const uniqueMerged = merged.filter((pkg, index, self) => 
        self.findIndex(p => p.id === pkg.id) === index
      );

      setCriticalAlerts(uniqueMerged);
    } catch (err) {
      console.error('Error fetching critical alerts:', err);
    }
  }, [alertView, alertDate]);

  useEffect(() => {
    fetchCriticalAlerts();
    const interval = setInterval(fetchCriticalAlerts, 45000);
    return () => clearInterval(interval);
  }, [fetchCriticalAlerts]);

  // Logic to show alerts when NEW ones arrive
  useEffect(() => {
    if (criticalAlerts.length > 0) {
        const newestId = criticalAlerts[0].id;
        
        // Solo si la alerta más reciente es realmente nueva (diferente ID)
        if (newestId !== lastAlertId) {
            setShowCriticalAlerts(true);
            localStorage.setItem('criticalAlertsPanelOpen', 'true');
            
            setLastAlertId(newestId);
            localStorage.setItem('lastCriticalAlertId', newestId);
        }
    } else {
        // Fix: Do not auto-close on empty criticalAlerts because on mount it starts empty
        // The UI already hides the panel if criticalAlerts.length === 0
    }
  }, [criticalAlerts, lastAlertId]);

  const fetchUsers = useCallback(async () => {
    try {
        const allUsers = await api.getUsers();
        setUsers(Array.isArray(allUsers) ? allUsers : []);
    } catch (error) {
        console.error("Failed to fetch users", error);
    }
  }, []);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
        const params = {
            page: currentPage,
            limit: itemsPerPage,
            searchQuery: debouncedSearchQuery,
            statusFilter: statusFilter.length > 0 ? statusFilter.join(',') : null,
            driverFilter,
            clientFilter,
            communeFilter,
            cityFilter,
            startDate,
            endDate,
            flexFilter,
            quickFilter,
            sourceFilter,
            sortOrder,
            assignmentFilter: assignmentFilter !== 'all' ? assignmentFilter : null,
            dateType,
        };
        const packagesResult = await api.getPackages(params);
        
        const pkgs = packagesResult?.packages || [];
        const total = packagesResult?.total || 0;
        
        setPackages(Array.isArray(pkgs) ? pkgs : []);
        setTotalPackages(total);
    } catch (error: any) {
        console.error("Failed to fetch data", error);
        alert("Error al cargar los datos: " + (error.message || "Error desconocido"));
    } finally {
        setIsLoading(false);
    }
  }, [currentPage, itemsPerPage, debouncedSearchQuery, statusFilter, driverFilter, clientFilter, communeFilter, cityFilter, startDate, endDate, flexFilter, quickFilter, sourceFilter, sortOrder, assignmentFilter, dateType]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);
  
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
        if (statusDropdownRef.current && !statusDropdownRef.current.contains(event.target as Node)) {
            setIsStatusDropdownOpen(false);
        }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const resetFiltersForNewData = () => {
      setSearchQuery('');
      setStatusFilter([]);
      setFlexFilter('all');
      setSourceFilter('all');
      setQuickFilter('all');
      setDriverFilter('');
      setClientFilter('');
      setCommuneFilter('');
      setCityFilter('');
      setStartDate(getLocalDateString());
      setEndDate(getLocalDateString());
      setDateType('created');
      setCurrentPage(1);
  };

  const handleCreatePackage = async (data: Omit<PackageCreationData, 'origin'>, shouldClose = true) => {
    if (!auth?.user) {
      console.error("Cannot create package: user not authenticated.");
      return;
    }
    try {
        await api.createPackage({
          ...data,
          origin: 'Centro de Distribución', // Admins create from a central location
        });
        
        // No reset filters here if adding another to keep context
        if (shouldClose) {
            resetFiltersForNewData();
        }
        
        fetchData();
        
        if (shouldClose) {
            setIsCreateModalOpen(false);
        }
    } catch (error: any) {
        console.error("Failed to create package", error);
        alert("Error al crear el paquete: " + (error.message || "Error desconocido"));
        throw error; // Throw to let the modal know it failed
    }
  };

  const handleImportPackages = async (packagesToCreate: Omit<PackageCreationData, 'origin' | 'creatorId'>[], selectedClientId?: string) => {
      if (!selectedClientId) return;
      
      const client = users.find(u => u.id === selectedClientId);
      const origin = client?.pickupAddress || client?.address || 'Centro de Distribución';

      const fullPackagesData: PackageCreationData[] = packagesToCreate.map(p => ({
          ...p,
          origin,
          creatorId: selectedClientId,
      }));

      try {
          const result = await api.createMultiplePackages(fullPackagesData);
          resetFiltersForNewData();
          fetchData();
          // We don't close the modal here anymore, we let the modal handle the result
          return result;
      } catch (error) {
          console.error("Failed to import packages", error);
          throw error;
      }
  };

  const handleUpdatePackage = async (pkgId: string, data: PackageUpdateData) => {
    try {
      await api.updatePackage(pkgId, data);
      await fetchData(); // Refetch to see the changes
      setEditingPackage(null);
    } catch (error: any) {
      console.error("Failed to update package", error);
      alert("Error al actualizar el paquete: " + (error.message || "Error desconocido"));
    }
  };
  
  const handleAssignDriver = async (pkgId: string, driverId: string | null, newDeliveryDate: Date) => {
    try {
      await api.assignDriverToPackage(pkgId, driverId, newDeliveryDate);
      await fetchData(); // Refetch to see the changes
      setAssigningPackage(null);
    } catch (error: any) {
      console.error("Failed to assign driver", error);
      alert("Error al asignar conductor: " + (error.message || "Error desconocido"));
    }
  };

  const handleBulkAssignDriver = async (driverId: string | null, newDeliveryDate: Date) => {
    const idsToAssign: string[] = Array.from(selectedPackages);
    if (idsToAssign.length === 0) return;

    try {
        await api.batchAssignDriverToPackages(idsToAssign, driverId, newDeliveryDate);
        fetchData(); // Refetch data to show changes
        setSelectedPackages(new Set()); // Clear selection
        setIsBulkAssignModalOpen(false); // Close modal
    } catch (error: any) {
        console.error("Failed to bulk assign driver", error);
        alert("Ocurrió un error al asignar los paquetes: " + (error.message || "Error desconocido"));
    }
  };

  const handleMarkForReturn = async (pkg: Package) => {
    try {
        await api.markPackageForReturn(pkg.id);
        fetchData(); // Refetch to see the changes
    } catch (error) {
        console.error("Failed to mark package for return", error);
        alert("Error al marcar el paquete para devolución.");
    }
  };

  const handleRefreshAll = async () => {
    try {
        await Promise.all([
            fetchData(),
            fetchUsers(),
            fetchCriticalAlerts()
        ]);
    } catch (error: any) {
        console.error("Failed to refresh all data", error);
        alert("Error al refrescar los datos: " + (error.message || "Error desconocido"));
    }
  };

  const handleCheckAlert = async (pkgId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
        await api.checkAlert(pkgId, true);
        await fetchCriticalAlerts();
    } catch (error: any) {
        console.error("Failed to check alert", error);
        alert("Error al marcar alerta: " + (error.message || "Error desconocido"));
    }
  };

  const handleTriggerMeliSync = async () => {
    if (isSyncingMeli) return;
    setIsSyncingMeli(true);
    try {
      await api.syncMeliPackages();
      // Status will be updated via the interval polling
    } catch (error: any) {
      console.error("Failed to trigger ML sync", error);
      alert("Error al iniciar sincronización ML: " + (error.message || "Error desconocido"));
    } finally {
      setIsSyncingMeli(false);
    }
  };

  const handleTriggerShopifySync = async () => {
    if (isSyncingShopify) return;
    setIsSyncingShopify(true);
    try {
      await api.syncShopifyPackages();
      // Status will be updated via the interval polling
    } catch (error: any) {
      console.error("Failed to trigger Shopify sync", error);
      alert("Error al iniciar sincronización Shopify: " + (error.message || "Error desconocido"));
    } finally {
      setIsSyncingShopify(false);
    }
  };

  const drivers = users
    .filter(u => {
        // [REFAC v2.5.1] Lógica de filtrado unificada y robusta
        // Soporta roles sinónimos (ADMINISTRADOR, CHOFER), permisos explícitos y es insensible a mayúsculas
        const role = String(u.role || '').toUpperCase();
        const status = String(u.status || '').toUpperCase();
        
        const isAdmin = role === 'ADMIN' || role === 'ADMINISTRADOR';
        const isDriver = role === 'DRIVER' || role === 'CHOFER' || role === 'CONDUCTOR';
        const hasDeliveryPermission = u.driverPermissions?.canDeliver === true;
        
        return (isAdmin || isDriver || hasDeliveryPermission) && status === 'APROBADO';
    })
    .sort((a, b) => a.name.localeCompare(b.name));
    
  const clients = users
    .filter(u => u.role === Role.Client && u.status === UserStatus.Approved)
    .sort((a, b) => a.name.localeCompare(b.name));


  const uniqueCommunes = useMemo(() => {
    // 1. Obtener comunas de los paquetes actuales, normalizadas
    const packageCommunes = Array.isArray(packages) 
        ? packages.map(p => p.recipientCommune?.trim().toUpperCase()).filter(Boolean)
        : [];
    
    // 2. Combinar con la lista completa activa de la RM (solo configuradas)
    const list = auth?.activeCommunes || [];
    const combined = new Set([...list, ...packageCommunes]);
    
    // 3. Convertir a array y ordenar alfabéticamente
    return Array.from(combined).sort((a: string, b: string) => a.localeCompare(b));
  }, [packages, auth?.activeCommunes]);
  
  const uniqueCities = useMemo(() => {
    if (!Array.isArray(packages)) return [];
    const cities = new Set(packages.map(p => p.recipientCity).filter(Boolean));
    return Array.from(cities).sort((a: string, b: string) => a.localeCompare(b));
  }, [packages]);

    
  const handleExportData = async (format: 'excel' | 'csv' = 'csv') => {
    if (totalPackages === 0 || isExporting) return;
    
    const params = {
        searchQuery, 
        statusFilter: statusFilter.length > 0 ? statusFilter.join(',') : null, 
        driverFilter, 
        clientFilter, 
        communeFilter, 
        cityFilter, 
        startDate, 
        endDate,
        flexFilter,
        quickFilter,
        dateType,
        includeHistory: false
    };

    if (format === 'csv') {
        // Use streaming export for CSV to handle large datasets
        api.exportPackagesCSV(params);
        setIsExportModalOpen(false);
        return;
    }

    setIsExporting(true);
    try {
        const { packages: allFiltered } = await api.getPackages({
            ...params,
            limit: 0
        });

        let packagesToExport: Package[] = [];
        if (selectedPackages.size > 0) {
            packagesToExport = allFiltered.filter(p => selectedPackages.has(p.id));
        } else {
            packagesToExport = allFiltered;
        }

        if (packagesToExport.length === 0) {
            alert("No hay datos para exportar.");
            setIsExporting(false);
            return;
        }

        const dateStr = new Date().toISOString().split('T')[0];
        await exportToExcel(packagesToExport, `Reporte_Paquetes_${dateStr}.xlsx`, users, auth?.systemSettings?.timeFormat || '12h');
        setIsExportModalOpen(false);
    } catch(error) {
        console.error("Failed to export data", error);
        alert("Error al exportar los datos.");
    } finally {
        setIsExporting(false);
    }
  };


  useEffect(() => {
    setCurrentPage(1);
    setSelectedPackages(new Set());
  }, [searchQuery, statusFilter, driverFilter, communeFilter, cityFilter, clientFilter, itemsPerPage, startDate, endDate, flexFilter, quickFilter, dateType]);

  const handleSelectPackage = (pkg: Package) => {
    setSelectedPackages(prev => {
        const newSelection = new Set(prev);
        if (newSelection.has(pkg.id)) {
            newSelection.delete(pkg.id);
        } else {
            newSelection.add(pkg.id);
        }
        return newSelection;
    });
  };

  const isAllOnPageSelected = useMemo(() => {
    if (packages.length === 0) return false;
    return packages.every(p => selectedPackages.has(p.id));
  }, [packages, selectedPackages]);

  const handleSelectAllOnPageClick = () => {
    const pageIds = new Set(packages.map(p => p.id));
    if (isAllOnPageSelected) {
        setSelectedPackages(prev => {
            const newSelection = new Set(prev);
            pageIds.forEach(id => newSelection.delete(id));
            return newSelection;
        });
    } else {
        setSelectedPackages(prev => new Set([...prev, ...pageIds]));
    }
  };

  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) {
        const someSelectedOnPage = packages.some(p => selectedPackages.has(p.id));
        checkboxRef.current.indeterminate = someSelectedOnPage && !isAllOnPageSelected;
    }
  }, [selectedPackages, packages, isAllOnPageSelected]);

  const selectedPackageObjects = useMemo(() => {
    if (!Array.isArray(packages)) return [];
    return packages.filter(p => selectedPackages.has(p.id));
  }, [packages, selectedPackages]);

  const canDeleteSelected = useMemo(() => {
      if (selectedPackageObjects.length === 0) return false;
      return selectedPackageObjects.every(p => p.status === PackageStatus.Pending || p.status === PackageStatus.Assigned || p.status === PackageStatus.PickedUp);
  }, [selectedPackageObjects]);

  const handleDeleteSelected = async (enteredPassword?: string) => {
    if (!enteredPassword) {
        alert('Debes ingresar la contraseña para continuar.');
        return;
    }
    try {
      const idsToDelete = [...selectedPackages].filter(id => {
          const pkg = packages.find(p => p.id === id);
          return pkg && (pkg.status === PackageStatus.Pending || pkg.status === PackageStatus.Assigned || pkg.status === PackageStatus.PickedUp);
      });

      if (idsToDelete.length === 0) {
        setIsDeletePasswordModalOpen(false);
        return;
      }

      for (const id of idsToDelete) {
          await api.deletePackage(id, enteredPassword);
      }
      
      setSelectedPackages(new Set());
      setIsDeletePasswordModalOpen(false);
      await fetchData(); // Refetch data
    } catch (error: any) {
      console.error("Failed to delete selected packages", error);
      if (error.status === 401 || error.status === 403) {
          alert('Contraseña incorrecta.');
      } else {
          alert("Error al eliminar los paquetes: " + (error.message || "Error desconocido"));
      }
    }
  };

  const isDateFiltering = startDate !== '' || endDate !== '';

  return (
    <div>
      {/* --- CRITICAL ALERTS CENTER --- */}
      {showCriticalAlerts && (
        <div className="mb-6 overflow-hidden border border-red-200 rounded-xl bg-white shadow-xl animate-fade-in-up relative">
           {/* Close Button */}
           <button 
              onClick={() => {
                  setShowCriticalAlerts(false);
                  localStorage.setItem('criticalAlertsPanelOpen', 'false');
              }}
              className="absolute top-4 right-4 z-10 p-1.5 bg-white/10 hover:bg-white/20 text-white rounded-full transition-all backdrop-blur-sm sm:hidden"
              title="Cerrar avisos"
           >
              <IconX className="w-4 h-4" />
           </button>

           <div className="flex flex-col sm:flex-row items-center justify-between px-6 py-4 bg-gradient-to-r from-red-600 to-amber-600 gap-4">
              <div className="flex items-center gap-3">
                 <div className="flex items-center justify-center w-8 h-8 bg-white/20 rounded-lg backdrop-blur-md">
                    <IconRefresh className="w-5 h-5 text-white animate-spin-slow" />
                 </div>
                 <div className="flex flex-col">
                    <h2 className="text-sm font-black text-white uppercase tracking-[0.2em]">
                        {alertView === 'today' ? 'Centro de Alertas Críticas (Hoy)' : `Historial de Alertas (${new Date(alertDate + 'T12:00:00').toLocaleDateString()})`}
                    </h2>
                    <div className="flex items-center gap-2 mt-1">
                        <button 
                            onClick={() => setAlertView('today')}
                            className={`px-3 py-0.5 text-[9px] font-black rounded-full transition-all uppercase tracking-tighter ${alertView === 'today' ? 'bg-white text-red-600 shadow-sm' : 'bg-white/10 text-white/80 hover:bg-white/20'}`}
                        >
                            Hoy
                        </button>
                        <button 
                            onClick={() => setAlertView('history')}
                            className={`px-3 py-0.5 text-[9px] font-black rounded-full transition-all uppercase tracking-tighter ${alertView === 'history' ? 'bg-white text-red-600 shadow-sm' : 'bg-white/10 text-white/80 hover:bg-white/20'}`}
                        >
                            Anteriores
                        </button>
                    </div>
                 </div>
                 <span className="px-3 py-1 text-[10px] font-black text-red-600 bg-white rounded-full">
                    {criticalAlerts.length} EVENTOS
                 </span>
              </div>

              <div className="flex items-center gap-3 w-full sm:w-auto">
                 {alertView === 'history' && (
                    <input 
                        type="date"
                        value={alertDate}
                        onChange={(e) => setAlertDate(e.target.value)}
                        className="bg-white/20 border-none text-white text-[11px] font-black rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-white/50 outline-none backdrop-blur-sm placeholder-white/50"
                    />
                 )}
                 <button 
                    onClick={fetchCriticalAlerts}
                    className="p-2 text-white/80 hover:text-white hover:bg-white/10 rounded-lg transition-all"
                    title="Refrescar alertas"
                 >
                    <IconRefresh className="w-4 h-4" />
                 </button>
                 <button 
                    onClick={() => {
                        setShowCriticalAlerts(false);
                        localStorage.setItem('criticalAlertsPanelOpen', 'false');
                    }}
                    className="hidden sm:flex items-center justify-center p-2 text-white/80 hover:text-white hover:bg-white/20 rounded-lg transition-all bg-white/5 backdrop-blur-sm"
                    title="Ocultar Centro de Alertas"
                 >
                    <IconX className="w-4 h-4" />
                 </button>
              </div>
           </div>
           
            <div className="flex overflow-x-auto p-4 gap-4 scrollbar-hide bg-gray-50/50">
               {criticalAlerts.length === 0 && (
                   <div className="flex-1 flex flex-col items-center justify-center py-10 opacity-60">
                       <IconAlertTriangle className="w-12 h-12 text-gray-400 mb-3" />
                       <p className="text-sm font-bold text-gray-500 uppercase tracking-widest">No hay eventos para esta fecha</p>
                   </div>
               )}
               {criticalAlerts.map(pkg => (
                 <div 
                  key={pkg.id}
                  onClick={() => handleSelectPackageDetails(pkg)}
                  className={`flex-shrink-0 w-80 p-4 border rounded-xl shadow-sm cursor-pointer transition-all hover:shadow-md hover:scale-[1.02] ${
                    pkg.status === 'CANCELADO' 
                      ? 'bg-red-50/30 border-red-100 hover:border-red-300' 
                      : pkg.isDuplicate
                        ? 'bg-orange-50/30 border-orange-100 hover:border-orange-300'
                        : pkg.isReassigned
                          ? 'bg-purple-50/30 border-purple-100 hover:border-purple-300'
                          : 'bg-amber-50/30 border-amber-100 hover:border-amber-300'
                  }`}
                >
                   <div className="flex items-center justify-between mb-3">
                      <span className={`px-2.5 py-1 text-[9px] font-black rounded-lg uppercase tracking-wider ${
                        pkg.status === 'CANCELADO' 
                          ? 'bg-red-100 text-red-700' 
                          : pkg.isDuplicate
                            ? 'bg-orange-100 text-orange-700'
                            : pkg.isReassigned
                              ? 'bg-purple-100 text-purple-700'
                              : 'bg-amber-100 text-amber-700'
                      }`}>
                        {pkg.status === 'CANCELADO'
                           ? 'CANCELADO'
                           : pkg.isDuplicate
                             ? 'DUPLICADO'
                             : pkg.isReassigned
                               ? 'REASIGNADO'
                               : 'REPROGRAMADO'}
                      </span>
                      <span className="text-[10px] font-bold text-gray-400">
                        {new Date(
                          pkg.isDuplicate 
                            ? pkg.createdAt 
                            : pkg.isReassigned 
                              ? (pkg.assignedAt || pkg.updatedAt) 
                              : pkg.updatedAt
                        ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                   </div>
                   
                   <h3 className="text-sm font-bold text-gray-900 truncate mb-1">{pkg.recipientName}</h3>
                   
                   {/* Seller Info */}
                   <div className="flex items-center gap-1.5 mb-2.5 bg-blue-50 px-2 py-0.5 rounded border border-blue-100 w-fit">
                      <span className="text-[8px] font-black text-blue-400 uppercase tracking-tighter">Seller:</span>
                      <span className="text-[10px] font-black text-blue-800 uppercase truncate max-w-[150px]">
                         {(pkg as any).clientName || users.find(u => u.id === pkg.creatorId)?.name || 'Externo'}
                      </span>
                   </div>

                   <div className="flex items-center gap-2 mb-3">
                      <div className="w-4 h-4 rounded-full bg-gray-100 flex items-center justify-center">
                         <IconMercadoLibre className="w-2.5 h-2.5 text-gray-500" />
                      </div>
                      <p className="text-[11px] text-gray-500 font-medium truncate">
                        {pkg.recipientAddress}, <span className="font-bold text-gray-700">{pkg.recipientCommune}</span>
                      </p>
                   </div>
                   
                   <div className="flex items-center justify-between pt-3 border-t border-gray-50">
                      <div className="flex flex-col">
                         <span className="text-[8px] font-bold text-gray-400 uppercase tracking-tighter">Conductor</span>
                         <span className="text-[10px] font-black text-gray-700">
                            {users.find(u => u.id === pkg.driverId)?.name || 'Sin asignar'}
                         </span>
                      </div>
                       <div className="flex items-center gap-2">
                          <button 
                            onClick={(e) => handleCheckAlert(pkg.id, e)}
                            className="p-1.5 bg-green-100 text-green-700 rounded-lg hover:bg-green-200 transition-colors"
                            title="Marcar como revisado"
                          >
                            <IconCheckCircle className="w-3.5 h-3.5" />
                          </button>
                          <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-900 rounded-lg">
                             <span className="text-[9px] font-black text-white uppercase tracking-wider">Informar</span>
                             <div className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse"></div>
                          </div>
                       </div>
                   </div>
                </div>
              ))}
           </div>
        </div>
      )}

      <div className="bg-[var(--background-secondary)] shadow-md rounded-lg">
        <PackageFilters
            onOpenCreateModal={() => setIsCreateModalOpen(true)}
            onOpenImportModal={() => setIsImportModalOpen(true)}
            canCreate={auth?.user?.role === 'ADMIN' || (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canManagePackages)}
            canImport={auth?.user?.role === 'ADMIN' || (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canBulkActions)}
            onRefresh={handleRefreshAll}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            drivers={drivers}
            driverFilter={driverFilter}
            onDriverChange={setDriverFilter}
            communes={uniqueCommunes}
            communeFilter={communeFilter}
            onCommuneChange={setCommuneFilter}
            cities={uniqueCities}
            cityFilter={cityFilter}
            onCityChange={setCityFilter}
            startDate={startDate}
            onStartDateChange={setStartDate}
            endDate={endDate}
            onEndDateChange={setEndDate}
            flexFilter={flexFilter}
            onFlexFilterChange={setFlexFilter}
            sourceFilter={sourceFilter}
            onSourceFilterChange={setSourceFilter}
            quickFilter={quickFilter}
            onQuickFilterChange={setQuickFilter}
            isSyncing={isLoading}
            clients={clients}
            clientFilter={clientFilter}
            onClientChange={setClientFilter}
            onOpenQuickStatus={() => setIsQuickStatusModalOpen(true)}
            assignmentFilter={assignmentFilter}
            onAssignmentFilterChange={setAssignmentFilter}
            dateType={dateType}
            onDateTypeChange={setDateType}
            onToggleAlerts={() => {
                const newState = !showCriticalAlerts;
                setShowCriticalAlerts(newState);
                localStorage.setItem('criticalAlertsPanelOpen', String(newState));
            }}
            showAlerts={showCriticalAlerts}
            alertCount={criticalAlerts.length}
        />
      </div>

        <div className="flex flex-col gap-3 p-3 border-b border-[var(--border-primary)]">
            <div className="flex flex-wrap items-center justify-between w-full">
                <div className="flex items-center gap-4">
                    <>
                        <input
                            type="checkbox"
                            ref={checkboxRef}
                            className={customCheckboxClass}
                            checked={isAllOnPageSelected}
                            onChange={handleSelectAllOnPageClick}
                            disabled={packages.length === 0}
                        />
                        <div className="h-6 w-px bg-[var(--border-primary)]"></div>
                    </>
                    {auth?.user?.role === Role.Admin && pollingStatus && (
                        <div className="flex items-center gap-2">
                            <div 
                                title={pollingStatus.isPolling && pollingStatus.pollingStartTime ? `Iniciado hace ${Math.floor((Date.now() - pollingStatus.pollingStartTime)/1000)}s` : "Mercado Libre Status - Click para sincronizar ahora"}
                                className={`flex items-center gap-2 px-3 py-1 bg-white border ${auth?.systemSettings?.meliAutoImport ? 'border-blue-400 text-blue-700' : 'border-gray-300 text-gray-500'} rounded-full text-[10px] font-black shadow-sm cursor-pointer hover:bg-blue-50 transition-all uppercase tracking-tighter ${auth?.systemSettings?.meliAutoImport && pollingStatus.isPolling ? 'animate-pulse-glow-blue' : ''}`}
                                onClick={(e) => { e.stopPropagation(); handleTriggerMeliSync(); }}
                            >
                                <div className={`w-4 h-4 rounded-full flex items-center justify-center ${auth?.systemSettings?.meliAutoImport ? 'text-blue-600' : 'text-gray-400'}`}>
                                    <IconMercadoLibre className="w-full h-full" />
                                </div>
                                <span className="whitespace-nowrap">
                                    {auth?.systemSettings?.meliAutoImport 
                                        ? (pollingStatus.isPolling 
                                            ? (pollingStatus.totalPackages && pollingStatus.totalPackages > 0 
                                                ? `ML: ${pollingStatus.processedPackages}/${pollingStatus.totalPackages}` 
                                                : 'ML: Sincronizando...') 
                                            : `ML: ${timeLeft}s`) 
                                        : 'ML: Inactivo'}
                                </span>
                                {(pollingStatus.isPolling || isSyncingMeli) && <IconLoader className="w-3 h-3 animate-spin" />}
                                <div className={`ml-1 w-1.5 h-1.5 rounded-full ${auth?.systemSettings?.meliAutoImport ? 'bg-blue-400 animate-pulse' : 'bg-gray-300'}`}></div>
                            </div>

                            {/* Nuevo Cuadro Azul: Cantidad Importada en última consulta */}
                            {pollingStatus.lastImportCount !== undefined && (
                                <div 
                                    className="flex items-center justify-center min-w-[40px] h-[26px] px-2 bg-blue-600 text-white text-[10px] font-black rounded-lg shadow-md border border-blue-700 animate-fade-in"
                                    title="Cantidad de paquetes en la última importación"
                                >
                                    {pollingStatus.lastImportCount}
                                </div>
                            )}
                        </div>
                    )}

                    {auth?.user?.role === Role.Admin && pollingStatus && shopifyPollingStatus && (
                        <div className="h-6 w-px bg-[var(--border-primary)] opacity-30"></div>
                    )}

                    {/* Shopify Polling Status */}
                    {auth?.user?.role === Role.Admin && shopifyPollingStatus && (
                        <div 
                            title={shopifyPollingStatus.isPolling && shopifyPollingStatus.pollingStartTime ? `Iniciado hace ${Math.floor((Date.now() - shopifyPollingStatus.pollingStartTime)/1000)}s` : "Shopify Status - Click para sincronizar ahora"}
                            className={`flex items-center gap-2 px-3 py-1 bg-white border ${auth?.systemSettings?.shopifyAutoImport ? 'border-emerald-400 text-emerald-700' : 'border-gray-300 text-gray-500'} rounded-full text-[10px] font-black shadow-sm cursor-pointer hover:bg-emerald-50 transition-all uppercase tracking-tighter ${auth?.systemSettings?.shopifyAutoImport && shopifyPollingStatus.isPolling ? 'animate-pulse-glow-emerald' : ''}`}
                            onClick={(e) => { e.stopPropagation(); handleTriggerShopifySync(); }}
                        >
                            <IconShopify className={`w-4 h-4 ${auth?.systemSettings?.shopifyAutoImport ? 'text-emerald-600' : 'text-gray-400'}`} />
                            <span className="whitespace-nowrap">
                                {auth?.systemSettings?.shopifyAutoImport 
                                    ? (shopifyPollingStatus.isPolling ? 'Shopify: Sincronizando' : `Shopify: ${shopifyTimeLeft}s${shopifyPollingStatus.lastImportCount !== undefined ? ` - ${shopifyPollingStatus.lastImportCount}S` : ''}`) 
                                    : 'Shopify: Inactivo'}
                            </span>
                            {(shopifyPollingStatus.isPolling || isSyncingShopify) && <IconLoader className="w-3 h-3 animate-spin" />}
                             <div className={`ml-1 w-1.5 h-1.5 rounded-full ${auth?.systemSettings?.shopifyAutoImport ? 'bg-emerald-400 animate-pulse' : 'bg-gray-300'}`}></div>
                        </div>
                    )}
                    <>
                        <div className="h-6 w-px bg-[var(--border-primary)] opacity-50"></div>
                        <div className="flex items-center gap-2">
                            {selectedPackages.size > 0 && (
                                <span className="text-xs font-bold text-blue-600 mr-2 tracking-tight uppercase">{selectedPackages.size} seleccionados</span>
                            )}
                            <button 
                                onClick={() => setIsBulkAssignModalOpen(true)}
                                disabled={selectedPackages.size > 0 ? false : true}
                                title="Asignar Conductor" 
                                className={`p-2.5 rounded-lg transition-all ${selectedPackages.size > 0 ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-200 opacity-50 cursor-not-allowed'}`}
                            >
                                <IconUserPlus className={`w-6 h-6 ${selectedPackages.size > 0 ? 'text-white' : 'text-gray-500'}`} />
                            </button>
                            <button 
                                onClick={() => setPrintingPackages(selectedPackageObjects)} 
                                title="Imprimir Etiquetas" 
                                className={`p-2.5 rounded-lg transition-all ${selectedPackages.size > 0 ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-gray-200 opacity-50 cursor-not-allowed'}`}
                                disabled={selectedPackages.size > 0 ? false : true}>
                                <IconPrinter className={`w-6 h-6 ${selectedPackages.size > 0 ? 'text-white' : 'text-gray-500'}`} />
                            </button>
                            <button 
                                onClick={() => setIsDeletePasswordModalOpen(true)} 
                                disabled={!canDeleteSelected} 
                                title="Eliminar Seleccionados" 
                                className={`p-2.5 rounded-lg transition-all ${canDeleteSelected ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-200 opacity-50 cursor-not-allowed'}`}>
                                <IconTrash className={`w-6 h-6 ${canDeleteSelected ? 'text-white' : 'text-gray-500'}`} />
                            </button>
                            <button 
                                onClick={() => setIsExportModalOpen(true)} 
                                title={selectedPackages.size > 0 ? "Exportar Seleccionados" : "Exportar Vista"} 
                                className={`p-2.5 rounded-lg transition-all ${totalPackages > 0 && !isExporting ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-gray-200 opacity-50 cursor-not-allowed'} ${isExporting ? 'animate-pulse' : ''}`}
                                disabled={totalPackages === 0 || isExporting}>
                                {isExporting ? (
                                    <IconLoader className="w-6 h-6 text-white animate-spin" />
                                ) : (
                                    <IconFileSpreadsheet className={`w-6 h-6 ${totalPackages > 0 ? 'text-white' : 'text-gray-500'}`} />
                                )}
                            </button>

                            {/* Nueva acción masiva: Marcar como Entregado */}
                            {auth?.user?.role === Role.Admin && (
                                <button 
                                    onClick={handleBulkMarkDelivered}
                                    disabled={selectedPackages.size === 0}
                                    title="Entrega Masiva (Marcar Seleccionados)"
                                    className={`p-2.5 rounded-lg transition-all ${selectedPackages.size > 0 ? 'bg-cyan-600 hover:bg-cyan-700' : 'bg-gray-200 opacity-50 cursor-not-allowed'} shadow-sm border border-cyan-700/20`}
                                >
                                    <IconCheckCircle className={`w-6 h-6 ${selectedPackages.size > 0 ? 'text-white' : 'text-gray-400'}`} />
                                </button>
                            )}

                        </div>
                    </>
                </div>

                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <label className="text-[10px] font-black text-gray-500 uppercase tracking-widest whitespace-nowrap">Ver:</label>
                        <div className="relative w-44" ref={statusDropdownRef}>
                        <button
                            type="button"
                            onClick={() => setIsStatusDropdownOpen(prev => !prev)}
                            className="w-full border border-gray-300 rounded-lg py-1.5 pl-3 pr-8 text-xs font-bold text-left focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all bg-white shadow-sm"
                            aria-haspopup="listbox"
                            aria-expanded={isStatusDropdownOpen}
                        >
                            <span className="block truncate">
                                {statusFilter.length === 0 
                                    ? 'Todos los estados' 
                                    : statusFilter.length === 1 
                                        ? statusOptions.find(o => o.value === statusFilter[0])?.label 
                                        : `${statusFilter.length} estados`}
                            </span>
                            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                                <IconChevronDown className="w-5 h-5 text-[var(--text-muted)]" />
                            </span>
                        </button>
                        {isStatusDropdownOpen && (
                            <ul className="absolute z-20 mt-1 w-full bg-[var(--background-secondary)] shadow-xl rounded-md py-1 text-base ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm text-[var(--text-primary)] max-h-60 overflow-auto">
                                <li
                                    onClick={() => setStatusFilter([])}
                                    className={`cursor-pointer select-none relative py-2 pl-3 pr-4 hover:bg-[var(--background-hover)] transition-colors flex items-center gap-2 ${statusFilter.length === 0 ? 'bg-[var(--background-hover)] font-bold' : ''}`}
                                >
                                    <input 
                                        type="checkbox" 
                                        checked={statusFilter.length === 0} 
                                        readOnly 
                                        className={customCheckboxClass}
                                    />
                                    Todos
                                </li>
                                {statusOptions.filter(o => o.value !== null).map(({ label, value }) => (
                                    <li
                                        key={label}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setStatusFilter(prev => {
                                                if (prev.includes(value as PackageStatus)) {
                                                    return prev.filter(s => s !== value);
                                                } else {
                                                    return [...prev, value as PackageStatus];
                                                }
                                            });
                                        }}
                                        className={`cursor-pointer select-none relative py-2.5 pl-3 pr-4 transition-colors flex items-center gap-3 ${
                                            statusFilter.includes(value as PackageStatus) 
                                            ? 'bg-[var(--brand-muted)] text-[var(--brand-text)]' 
                                            : 'hover:bg-[var(--background-hover)] text-[var(--text-primary)]'
                                        }`}
                                    >
                                        <input 
                                            type="checkbox" 
                                            checked={statusFilter.includes(value as PackageStatus)} 
                                            readOnly 
                                            className={customCheckboxClass}
                                        />
                                        <span className="font-bold text-[11px] uppercase tracking-wider">
                                            {label}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>

            </div>

            </div>
        </div>

        {/* Separator / Decoration Line */}
        <div className="px-3">
             <div className="h-px w-full bg-gray-100"></div>
        </div>

        <div className="p-3 bg-gray-50 bg-opacity-30">
            <div className="flex flex-wrap items-center justify-between w-full gap-2">
                <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                        <label htmlFor="items-per-page-admin" className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Filas por página</label>
                        <select
                            id="items-per-page-admin"
                            value={itemsPerPage}
                            onChange={(e) => setItemsPerPage(Number(e.target.value))}
                            className="bg-white border border-gray-300 text-gray-900 rounded-md py-1 px-3 text-sm focus:ring-blue-500 focus:border-blue-500 shadow-sm"
                            aria-label="Filas por página"
                        >
                            <option value={10}>10</option>
                            <option value={25}>25</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                        </select>
                    </div>
                    
                    <div className="flex items-center gap-3">
                        <span className="text-sm text-gray-600 font-bold whitespace-nowrap">
                            {Math.min((currentPage - 1) * itemsPerPage + 1, totalPackages)}-{Math.min(currentPage * itemsPerPage, totalPackages)} de {totalPackages}
                        </span>
                        <div className="flex items-center bg-gray-100 rounded-md p-1 border border-gray-200">
                            <button onClick={() => setCurrentPage(prev => prev - 1)} disabled={currentPage === 1} className="p-1 hover:bg-white rounded disabled:opacity-30 transition-all" aria-label="Página anterior">
                                <IconChevronLeft className="w-4 h-4" />
                            </button>
                            <button onClick={() => setCurrentPage(prev => prev + 1)} disabled={currentPage * itemsPerPage >= totalPackages} className="p-1 hover:bg-white rounded disabled:opacity-30 transition-all" aria-label="Página siguiente">
                                <IconChevronRight className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    {/* Sort Order Toggle */}
                    <button
                        id="sort-order-toggle"
                        onClick={() => { setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc'); setCurrentPage(1); }}
                        title={sortOrder === 'desc' ? 'Mostrando más nuevos primero. Click para ver más antiguos primero.' : 'Mostrando más antiguos primero. Click para ver más nuevos primero.'}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider border shadow-sm transition-all ${
                            sortOrder === 'asc'
                                ? 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
                                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`}
                    >
                        {sortOrder === 'desc' ? (
                            <><IconSortDesc className="w-3.5 h-3.5" /> Más nuevos</>  
                        ) : (
                            <><IconSortAsc className="w-3.5 h-3.5" /> Más antiguos</>
                        )}
                    </button>

                </div>

                <div className="flex items-center">
                    <span className="text-[10px] font-black text-blue-700 uppercase tracking-[0.2em] bg-blue-50 px-4 py-2 rounded-lg border border-blue-100 shadow-sm">
                        TOTAL DE PAQUETES EN SISTEMA: {totalPackages}
                    </span>
                </div>
            </div>
        </div>

        <PackageList 
          packages={packages} 
          users={users}
          isLoading={isLoading}
          onSelectPackage={handleSelectPackageDetails}
          onAssignPackage={(auth?.user?.role === 'ADMIN' || (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canBulkActions)) ? setAssigningPackage : undefined}
          onEditPackage={(auth?.user?.role === 'ADMIN' || (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canManagePackages)) ? setEditingPackage : undefined}
          onDeletePackage={(pkg) => { 
            if (auth?.user?.role === 'ADMIN' || (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canDeletePackages)) {
                setSelectedPackages(new Set([pkg.id])); 
                setIsDeletePasswordModalOpen(true); 
            } else {
                alert("No tienes permiso para eliminar envíos.");
            }
          }}
          onPrintLabel={(pkg) => setPrintingPackages([pkg])}
          onMarkForReturn={(auth?.user?.role === 'ADMIN' || (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions?.canManagePackages)) ? handleMarkForReturn : undefined}
          isFiltering={searchQuery !== '' || statusFilter.length > 0 || driverFilter !== '' || communeFilter !== '' || cityFilter !== '' || startDate !== '' || endDate !== '' || flexFilter !== 'all' || quickFilter !== 'all'}
          isDateFiltering={isDateFiltering}
          selectedPackages={selectedPackages}
          onSelectionChange={handleSelectPackage}
        />

      {/* --- Modals --- */}
      {selectedPackage && (
        <PackageDetailModal 
            pkg={selectedPackage} 
            onClose={() => setSelectedPackage(null)} 
            creator={users.find(u => u.id === selectedPackage.creatorId)}
            companyName={auth?.systemSettings.companyName}
            onUpdatePackage={(updatedPkg) => {
                setPackages(prev => prev.map(p => p.id === updatedPkg.id ? updatedPkg : p));
                setSelectedPackage(updatedPkg);
            }}
        />
      )}
      {assigningPackage && (
        <AssignDriverModal
            pkg={assigningPackage}
            drivers={drivers}
            onClose={() => setAssigningPackage(null)}
            onAssign={handleAssignDriver}
        />
      )}
      {isBulkAssignModalOpen && (
        <BulkAssignDriverModal
            packageCount={selectedPackages.size}
            drivers={drivers}
            onClose={() => setIsBulkAssignModalOpen(false)}
            onAssign={handleBulkAssignDriver}
        />
      )}
      {isCreateModalOpen && (
        <CreatePackageModal
            onClose={() => setIsCreateModalOpen(false)}
            onCreate={handleCreatePackage}
            clients={clients}
        />
      )}
      {isImportModalOpen && (
        <ImportPackagesModal
            onClose={() => setIsImportModalOpen(false)}
            onImport={handleImportPackages}
            clients={clients}
        />
      )}
      {editingPackage && (
        <EditPackageModal
            pkg={editingPackage}
            users={users}
            onClose={() => setEditingPackage(null)}
            onUpdate={handleUpdatePackage}
        />
      )}
      {isDeletePasswordModalOpen && (
        <DeletePasswordModal
            onClose={() => setIsDeletePasswordModalOpen(false)}
            onConfirm={(pass) => handleDeleteSelected(pass)}
        />
      )}
      {isExportModalOpen && (
        <ExportFormatModal
            onClose={() => setIsExportModalOpen(false)}
            onSelect={handleExportData}
            isExporting={isExporting}
        />
      )}
      {isQuickStatusModalOpen && (
        <QuickStatusModal
            onClose={() => setIsQuickStatusModalOpen(false)}
            onViewDetails={(pkg) => {
                handleSelectPackageDetails(pkg);
                setIsQuickStatusModalOpen(false);
            }}
        />
      )}
      {printingPackages.length > 0 && auth?.user && (
          printingPackages.length === 1 ? (
              <ShippingLabelModal
                pkg={printingPackages[0]}
                creatorName={(() => {
                  const user = users.find(u => u.id === printingPackages[0].creatorId);
                  return user?.companyName || user?.name || 'Cliente Desconocido';
                })()}
                onClose={() => setPrintingPackages([])}
              />
          ) : (
              <BatchShippingLabelModal
                packages={printingPackages}
                creatorName={(() => {
                  const user = users.find(u => u.id === printingPackages[0].creatorId);
                  return user?.companyName || user?.name || 'Cliente Desconocido';
                })()}
                onClose={() => setPrintingPackages([])}
              />
          )
      )}

    </div>
  );
};

export default Dashboard;
