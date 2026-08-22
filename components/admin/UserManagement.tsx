
import React, { useState, useEffect, useContext } from 'react';
import { Role, UserStatus, PackageSource } from '../../constants';
import type { User, DriverPermissions, OperatorPermissions } from '../../types';
import { api, UserCreationData, UserUpdateData, PackageCreationData } from '../../services/api';
import { IconUserCheck, IconPencil, IconTrash, IconUserPlus, IconHistory, IconUserOff, IconDollarSign, IconFileInvoice, IconMercadoLibre, IconWoocommerce, IconShopify, IconFalabella, IconJumpseller, IconQrcode, IconTruck, IconArrowUturnLeft, IconChecklist, IconPackage, IconSearch, IconCopy, IconCheck, IconUsers, IconDownload, IconMapPin, IconCamera, IconEye } from '../Icon';
import * as XLSX from 'xlsx';
import CreateUserModal from '../modals/CreateUserModal';
import EditUserModal from '../modals/EditUserModal';
import ConfirmationModal from '../modals/ConfirmationModal';
import DoubleKeyConfirmationModal from '../modals/DoubleKeyConfirmationModal';
import DriverHistoryModal from './DriverHistoryModal';
import { AuthContext } from '../../contexts/AuthContext';
import DriverRatesModal from '../modals/DriverRatesModal';
import ClientInvoiceHistoryModal from '../modals/ClientInvoiceHistoryModal';
import ExternalImportModal from '../modals/ExternalImportModal';
import RevealPasswordModal from '../modals/RevealPasswordModal';


interface UserManagementProps {
  roleFilter: Role;
}

const statusStyles: { [key in UserStatus]: { badge: string; text: string; } } = {
    [UserStatus.Approved]: { 
      badge: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300', 
      text: 'Activo', 
    },
    [UserStatus.Disabled]: { 
      badge: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300', 
      text: 'Suspendido', 
    },
    [UserStatus.Deleted]: { 
      badge: 'bg-gray-100 text-gray-700 dark:bg-gray-900/50 dark:text-gray-300', 
      text: 'Eliminado', 
    },
    [UserStatus.Pending]: { 
      badge: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-300', 
      text: 'Pendiente', 
    },
  };

const UserManagement: React.FC<UserManagementProps> = ({ roleFilter }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [totalActiveCount, setTotalActiveCount] = useState(0);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [deletingIntegration, setDeletingIntegration] = useState<{ user: User, source: PackageSource } | null>(null);
  const [reintegratingUser, setReintegratingUser] = useState<User | null>(null);
  const [viewingHistoryUser, setViewingHistoryUser] = useState<User | null>(null);
  const [editingDriverRates, setEditingDriverRates] = useState<User | null>(null);
  const [viewingInvoicesClient, setViewingInvoicesClient] = useState<User | null>(null);
  const [revealingPasswordUser, setRevealingPasswordUser] = useState<User | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [copiedUserId, setCopiedUserId] = useState<string | null>(null);
  const [importingClient, setImportingClient] = useState<User | null>(null);
  const [importingSource, setImportingSource] = useState<PackageSource | null>(null);
  const [sortBy, setSortBy] = useState<'name' | 'newest' | 'oldest' | 'packages'>('name');
  const auth = useContext(AuthContext);

  const hasIntegration = (user: User, source: PackageSource) => {
    const legacyMap: Record<string, string> = {
      [PackageSource.MercadoLibre]: 'meli',
      [PackageSource.Shopify]: 'shopify',
      [PackageSource.WooCommerce]: 'woocommerce',
      [PackageSource.Falabella]: 'falabella',
      [PackageSource.Jumpseller]: 'jumpseller'
    };
    const legacyKey = legacyMap[source];
    const hasLegacy = legacyKey ? (user.integrations as any)?.[legacyKey] : false;
    const hasAccount = user.integrations?.accounts && Array.isArray(user.integrations.accounts) && user.integrations.accounts.some((acc: any) => acc.type === source);
    return !!(hasLegacy || hasAccount);
  };

  const fetchUsers = async () => {
    const canAccess = () => {
        if (auth?.user?.role === Role.Admin) return true;
        if (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions) {
            const perms = auth.user.operatorPermissions;
            if (roleFilter === Role.Driver || roleFilter === Role.Auxiliar || roleFilter === Role.Retiros) return perms.canManageDrivers;
            if (roleFilter === Role.Client || roleFilter === Role.Facturacion) return perms.canManageClients;
            if (roleFilter === Role.OperadorSistemas) return perms.canManageSettings;
        }
        return false;
    };

    if (!canAccess()) {
        setIsLoading(false);
        setUsers([]);
        return;
    }

    setIsLoading(true);
    try {
      const allUsers = await api.getUsers();
      
      // Calculate total active licenses (not status === 'ELIMINADO'), excluding the superuser account and clients
      const isSuperUserEmailFn = (email?: string) => email === 'admin' || email === 'admin@admin.cl';
      const isClientRoleFn = (role?: string) => role === 'CLIENT' || role === 'CLIENTE';
      const activeCount = allUsers.filter(u => u.status !== UserStatus.Deleted && !isSuperUserEmailFn(u.email) && !isClientRoleFn(String(u.role || '').toUpperCase())).length;
      setTotalActiveCount(activeCount);

      const isSuperUserEmail = (email?: string) => email === 'admin' || email === 'admin@admin.cl';
      const currentUserIsSuper = isSuperUserEmail(auth?.user?.email);

      const filteredUsers = allUsers.filter(u => {
        // [SEGURIDAD] Un administrador regular no puede ver ni gestionar al superusuario
        if (isSuperUserEmail(u.email) && !currentUserIsSuper) return false;

        if (roleFilter === Role.Driver) {
          // Si estamos filtrando conductores, mostrar Conductores Y Administradores (para asignaciones)
          return u.role === Role.Driver || u.role === Role.Admin;
        }
        if (roleFilter === Role.Admin) {
          // ADMIN_SISTEMAS se trata como Administrador en todo el sistema
          return u.role === Role.Admin || String(u.role || '').toUpperCase() === 'ADMIN_SISTEMAS' || String(u.role || '').toUpperCase() === 'ADMINISTRADOR';
        }
        return u.role === roleFilter;
      });
      
      filteredUsers.sort((a, b) => {
        if (a.status === UserStatus.Pending && b.status !== UserStatus.Pending) return -1;
        if (a.status !== UserStatus.Pending && b.status === UserStatus.Pending) return 1;
        return a.name.localeCompare(b.name);
      });
      setUsers(filteredUsers);
    } catch (error: any) {
      console.error("Failed to fetch users", error);
      alert("Error al cargar los usuarios: " + (error.message || "Error desconocido"));
    } finally {
      setIsLoading(false);
    }
  };

  const [licenseStatus, setLicenseStatus] = useState<{ activeCount: number, limit: number, exceeded: boolean } | null>(null);

  useEffect(() => {
    setSearchTerm('');
    fetchUsers();
  }, [roleFilter]);

  useEffect(() => {
    const fetchLicenseStatus = async () => {
      try {
        const status = await api.getLicenseStatus();
        setLicenseStatus(status);
      } catch (err) {
        console.error('Failed to fetch license status', err);
      }
    };
    fetchLicenseStatus();
  }, [users]);
  
  const handleApproveUser = async (userId: string) => {
    try {
        const updatedUser = await api.approveUser(userId);
        setUsers(users.map(u => u.id === userId ? updatedUser : u));
    } catch (error: any) {
        console.error("Failed to approve user:", error);
        alert("Error al aprobar el usuario: " + (error.message || "Error desconocido"));
    }
  };
  
  const handleToggleStatus = async (user: User) => {
    try {
        const updatedUser = await api.toggleUserStatus(user.id);
        setUsers(users.map(u => u.id === user.id ? updatedUser : u));
    } catch (error: any) {
        console.error("Failed to toggle user status:", error);
        alert("Error al cambiar el estado del usuario: " + (error.message || "Error desconocido"));
    }
  };

  const handleCreateUser = async (data: UserCreationData) => {
    try {
        const newUser = await api.createUser(data);
        if (newUser.role === roleFilter) {
            setUsers(prev => [...prev, newUser]);
        }
        setIsCreateModalOpen(false);
    } catch (error: any) {
        console.error("Failed to create user:", error);
        throw error; // Re-throw so the modal can catch it and display the message
    }
  };

  const handleUpdateUser = async (userId: string, data: UserUpdateData) => {
    try {
        const updatedUser = await api.updateUser(userId, data);
        setUsers(prev => prev.map(u => u.id === userId ? updatedUser : u));
        setEditingUser(null);
        setEditingDriverRates(null);
    } catch (error: any) {
        console.error("Failed to update user:", error);
        throw error; // Re-throw so the modal can catch it and display the message
    }
  };

  const handleDeleteUser = async (userId: string, password?: string) => {
    await api.deleteUser(userId, password);
    setUsers(prev => prev.filter(u => u.id !== userId));
    setDeletingUser(null);
    fetchUsers(); // Refresh to show soft deleted state if needed
  };

  const handleDeleteIntegration = async (userId: string, source: PackageSource, password?: string) => {
    const sourceMap: Record<string, string> = {
        [PackageSource.MercadoLibre]: 'meli',
        [PackageSource.Shopify]: 'shopify',
        [PackageSource.WooCommerce]: 'woocommerce',
        [PackageSource.Falabella]: 'falabella',
        [PackageSource.Jumpseller]: 'jumpseller'
    };
    const integrationKey = sourceMap[source];
    if (!integrationKey) return;

    await api.deleteIntegration(userId, integrationKey, password);
    setUsers(prev => prev.map(u => {
        if (u.id === userId && u.integrations) {
            const newIntegrations = { ...u.integrations } as any;
            delete newIntegrations[integrationKey];
            return { ...u, integrations: newIntegrations };
        }
        return u;
    }));
    setDeletingIntegration(null);
  };

  const handleReintegrateUser = async (userId: string) => {
    try {
        await api.reintegrateUser(userId);
        fetchUsers();
        setReintegratingUser(null);
        alert("Usuario reintegrado con éxito. Su historial de envíos ha sido borrado.");
    } catch (error: any) {
        alert("Error al reintegrar: " + error.message);
    }
  };

  const handleOpenImportModal = (client: User, source: PackageSource) => {
    setImportingClient(client);
    setImportingSource(source);
  };
  
  const handleCloseImportModal = () => {
    setImportingClient(null);
    setImportingSource(null);
  };

  const handleImportPackages = async (packagesToCreate: Omit<PackageCreationData, 'creatorId' | 'origin'>[]) => {
    if (!importingClient) return;

    const fullPackagesData: PackageCreationData[] = packagesToCreate.map(p => ({
        ...p,
        creatorId: importingClient.id,
        origin: importingClient.pickupAddress || importingClient.name,
    }));

    try {
        const result = await api.createMultiplePackages(fullPackagesData);
        handleCloseImportModal();
        if (result && result.errorCount > 0) {
            const errMsgs = result.errors.map((e: any) => `${e.recipientName}: ${e.error}`).join('\n');
            alert(`Se importaron ${result.importedCount} paquetes.\n\nErrores (${result.errorCount}):\n${errMsgs}`);
        } else {
            alert(`${fullPackagesData.length} paquetes importados con éxito.`);
        }
    } catch (error: any) {
        console.error("Failed to import packages:", error);
        alert("Error al importar: " + (error.message || JSON.stringify(error)));
    }
  };
  
  const handleTogglePermission = async (user: User, permission: keyof DriverPermissions) => {
    const currentPermissions = user.driverPermissions || {
        canDeliver: true,
        canPickup: true,
        canDispatch: true,
        canReturn: true,
        canViewHistory: true,
        canBulkPickup: false,
        canColecta: false,
        canAuxiliar: false,
        canZoning: false,
        meliAutoPromptPhotos: false,
    };

    const newPermissions = {
        ...currentPermissions,
        [permission]: !currentPermissions[permission],
    };

    try {
        await api.updateUser(user.id, { driverPermissions: newPermissions });
        fetchUsers(); // Refetch to ensure consistency
    } catch (error) {
        console.error("Failed to update driver permission", error);
        alert("Error al actualizar el permiso.");
    }
  };


  const handleCopyRegistrationLink = (user: User) => {
    const registrationUrl = `${window.location.origin}/?mode=register&email=${encodeURIComponent(user.email)}`;
    navigator.clipboard.writeText(registrationUrl);
    setCopiedUserId(user.id);
    setTimeout(() => setCopiedUserId(null), 2000);
  };

  const handleExportToExcel = () => {
    const dataToExport = filteredUsers.map(user => ({
      'Nombre': user.name,
      'Email': user.email,
      'RUT': user.rut || 'N/A',
      'Teléfono': user.phone || 'N/A',
      'Rol': user.role,
      'Estado': statusStyles[user.status].text,
      'Paquetes Totales': user.packageCount || 0,
      'Fecha Registro': user.createdAt ? new Date(user.createdAt).toLocaleDateString('es-CL') : 'N/A',
      'Dirección': user.pickupAddress || 'N/A',
      'Comuna': user.commune || 'N/A'
    }));

    const ws = XLSX.utils.json_to_sheet(dataToExport);
const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Usuarios");
    XLSX.writeFile(wb, `Reporte_Usuarios_${roleFilter}_${new Date().toLocaleDateString('es-CL').replace(/\//g, '-')}.xlsx`);
  };

  const filteredUsers = users.filter(u => {
    const role = String(u.role || '').toUpperCase();
    const searchTermLower = searchTerm.toLowerCase();
    
    // 1. Filtro por Rol (Tab seleccionada)
    let matchesRole = false;
    switch (roleFilter) {
      case Role.Admin:
        matchesRole = role === 'ADMIN' || role === 'ADMINISTRADOR' || role === 'ADMIN_SISTEMAS';
        break;
      case Role.Driver:
        matchesRole = role === 'DRIVER' || role === 'CHOFER' || role === 'CONDUCTOR' || u.driverPermissions?.canDeliver === true;
        break;
      case Role.Client:
        matchesRole = role === 'CLIENT' || role === 'CLIENTE';
        break;
      case Role.Auxiliar:
        matchesRole = role === 'AUXILIAR' || u.driverPermissions?.canDispatch === true;
        break;
      case Role.Retiros:
        matchesRole = role === 'RETIROS' || u.driverPermissions?.canPickup === true;
        break;
      case Role.Facturacion:
        matchesRole = role === 'FACTURACION';
        break;
      case Role.OperadorSistemas:
        matchesRole = role === 'OPERADOR_SISTEMAS';
        break;
      default:
        matchesRole = u.role === roleFilter;
    }

    if (!matchesRole) return false;

    // 2. Filtro por búsqueda
    const matchesSearch = 
      u.name.toLowerCase().includes(searchTermLower) ||
      u.email.toLowerCase().includes(searchTermLower) ||
      (u.phone && u.phone.includes(searchTermLower)) ||
      (u.rut && u.rut.toLowerCase().includes(searchTermLower));
    
    // CASO ESPECIAL PARA PRUEBAS: Si el nombre contiene FABIÁN o FABIAN, incluir siempre
    const isTestUser = u.name.toUpperCase().includes('FABIN') || u.name.toUpperCase().includes('FABIAN');
    
    if (showDeleted) return matchesSearch;
    return (matchesSearch && u.status !== UserStatus.Deleted) || isTestUser;
  }).sort((a, b) => {
    // Always keep Pending status at the top
    if (a.status === UserStatus.Pending && b.status !== UserStatus.Pending) return -1;
    if (a.status !== UserStatus.Pending && b.status === UserStatus.Pending) return 1;

    // Then apply the selected sort
    if (sortBy === 'name') {
        return a.name.localeCompare(b.name);
    } else if (sortBy === 'newest') {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateB - dateA;
    } else if (sortBy === 'oldest') {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return dateA - dateB;
    } else if (sortBy === 'packages') {
        return (b.packageCount || 0) - (a.packageCount || 0);
    }
    return 0;
  });

  const limit = licenseStatus?.limit ?? (auth?.systemSettings?.licenseLimit || 70);
  const totalActiveCountVal = licenseStatus?.activeCount ?? totalActiveCount;
  const isLicenseExceeded = licenseStatus?.exceeded ?? (totalActiveCountVal > limit);

  return (
    <div className="container mx-auto">
      {isLicenseExceeded && (
        <div className="bg-[var(--background-secondary)] border-l-4 border-red-600 shadow-sm rounded-r-lg p-4 mb-6 flex items-center gap-3 border border-y-[var(--border-primary)] border-r-[var(--border-primary)]">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            ⚠️ <strong className="font-black" style={{ color: '#dc2626' }}>ALERTA DE LICENCIAS EXCEDIDAS:</strong> Se ha superado el límite contratado de <strong>{limit}</strong> licencias ocupadas. Uso actual del sistema: <strong>{totalActiveCountVal}</strong>.
          </span>
        </div>
      )}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div className="relative flex-1 w-full max-w-md">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <IconSearch className="h-5 w-5 text-[var(--text-muted)]" />
          </div>
          <input
            type="text"
            placeholder="Buscar por nombre, email, RUT o teléfono..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="block w-full pl-10 pr-3 py-2 border border-[var(--border-primary)] rounded-md leading-5 bg-[var(--background-secondary)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] focus:border-[var(--brand-primary)] sm:text-sm transition-colors"
          />
        </div>
        <div className="flex items-center gap-2 flex-1 w-full sm:w-auto">
            <span className="text-sm text-[var(--text-muted)] whitespace-nowrap">Ordenar por:</span>
            <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="block w-full sm:w-48 pl-3 pr-10 py-2 border border-[var(--border-primary)] rounded-md leading-5 bg-[var(--background-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary)] focus:border-[var(--brand-primary)] sm:text-sm transition-colors"
            >
                <option value="newest">Más nuevos</option>
                <option value="oldest">Más antiguos</option>
                <option value="name">Nombre</option>
                <option value="packages">Más paquetes</option>
            </select>
        </div>
        {/* License counter badge in toolbar */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--border-primary)] bg-[var(--background-secondary)] shadow-sm" title={`Licencias usadas: ${totalActiveCountVal} / ${limit}`}>
          <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-black text-white ${isLicenseExceeded ? 'bg-red-600' : 'bg-[var(--brand-primary)]'}`}>
            {totalActiveCountVal}
          </span>
          <span className="text-xs font-semibold text-[var(--text-secondary)] hidden sm:inline whitespace-nowrap">
            / {limit} lic.
          </span>
        </div>
        <div className="flex items-center gap-4 w-full sm:w-auto">
          <label className="flex items-center gap-2 text-sm text-[var(--text-muted)] cursor-pointer">
            <input 
              type="checkbox" 
              checked={showDeleted} 
              onChange={(e) => setShowDeleted(e.target.checked)}
              className="rounded border-[var(--border-primary)] text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            />
            Mostrar eliminados
          </label>
          <button
            onClick={handleExportToExcel}
            className="inline-flex items-center justify-center px-4 py-2 border border-emerald-600 text-sm font-medium rounded-md shadow-sm text-emerald-700 bg-emerald-50 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-emerald-500 whitespace-nowrap"
            title="Descargar lista actual en formato Excel"
          >
            <IconDownload className="w-5 h-5 mr-2 -ml-1"/>
            Exportar
          </button>
          {((auth?.user?.role === Role.Admin) || 
            (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions && (
              ((roleFilter === Role.Driver || roleFilter === Role.Auxiliar || roleFilter === Role.Retiros) && auth.user.operatorPermissions.canManageDrivers) ||
              ((roleFilter === Role.Client || roleFilter === Role.Facturacion) && auth.user.operatorPermissions.canManageClients) ||
              ((roleFilter === Role.OperadorSistemas) && auth.user.operatorPermissions.canManageSettings)
            ))
          ) && (
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-secondary)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--brand-secondary)] whitespace-nowrap"
          >
            <IconUserPlus className="w-5 h-5 mr-2 -ml-1"/>
            Crear Usuario
          </button>
          )}
        </div>
      </div>
      <div className="bg-[var(--background-secondary)] shadow-md rounded-lg">
        <div className="divide-y divide-[var(--border-primary)]">
          {isLoading ? (
            <p className="p-6 text-center text-[var(--text-muted)]">Cargando usuarios...</p>
          ) : filteredUsers.length === 0 ? (
             <p className="p-6 text-center text-[var(--text-muted)]">
               {searchTerm ? 'No se encontraron usuarios que coincidan con la búsqueda.' : `No se encontraron usuarios con el rol de ${roleFilter}.`}
             </p>
          ) : filteredUsers.map((user, index) => {
            const hasNoCustomPricing = user.role === Role.Client &&
              (!user.pricing || (user.pricing.sameDay === 0 && user.pricing.express === 0 && user.pricing.nextDay === 0)) &&
              (!user.pickupCost || user.pickupCost === 0);
            
            return (
            <div key={user.id} className="p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-black bg-[var(--brand-primary)] text-white flex-shrink-0" title={`Usuario #${index + 1}`}>
                      {index + 1}
                    </span>
                    <p className={`font-semibold ${hasNoCustomPricing ? 'text-red-600' : 'text-[var(--text-primary)]'}`}>{user.name}</p>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusStyles[user.status].badge}`}>
                        {statusStyles[user.status].text}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800 border-2 border-emerald-300 shadow-sm uppercase tracking-tighter">
                        <IconPackage className="w-4 h-4" />
                        {user.packageCount || 0} paquetes
                    </span>
                    {hasIntegration(user, PackageSource.MercadoLibre) && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-bold bg-yellow-100 text-yellow-800 border border-yellow-300 shadow-sm">
                            <IconMercadoLibre className="w-4 h-4" />
                            <span>ML</span>
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletingIntegration({ user, source: PackageSource.MercadoLibre });
                                }}
                                className="ml-1 p-1 text-red-600 hover:bg-red-200 rounded-md transition-all"
                                title="Eliminar conexión con Mercado Libre"
                            >
                                <IconTrash className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                    {hasIntegration(user, PackageSource.Shopify) && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-bold bg-green-100 text-green-800 border border-green-300 shadow-sm">
                            <IconShopify className="w-4 h-4" />
                            <span>Shopify</span>
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletingIntegration({ user, source: PackageSource.Shopify });
                                }}
                                className="ml-1 p-1 text-red-600 hover:bg-red-200 rounded-md transition-all"
                                title="Eliminar conexión con Shopify"
                            >
                                <IconTrash className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                    {hasIntegration(user, PackageSource.WooCommerce) && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-bold bg-purple-100 text-purple-800 border border-purple-300 shadow-sm">
                            <IconWoocommerce className="w-4 h-4" />
                            <span>Woo</span>
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletingIntegration({ user, source: PackageSource.WooCommerce });
                                }}
                                className="ml-1 p-1 text-red-600 hover:bg-red-200 rounded-md transition-all"
                                title="Eliminar conexión con WooCommerce"
                            >
                                <IconTrash className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                    {hasIntegration(user, PackageSource.Falabella) && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-bold bg-orange-100 text-orange-800 border border-orange-300 shadow-sm">
                            <IconFalabella className="w-4 h-4" />
                            <span>Falabella</span>
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletingIntegration({ user, source: PackageSource.Falabella });
                                }}
                                className="ml-1 p-1 text-red-600 hover:bg-red-200 rounded-md transition-all"
                                title="Eliminar conexión con Falabella"
                            >
                                <IconTrash className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                    {hasIntegration(user, PackageSource.Jumpseller) && (
                        <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-bold bg-sky-100 text-sky-800 border border-sky-300 shadow-sm">
                            <IconJumpseller className="w-4 h-4" />
                            <span>Jumpseller</span>
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDeletingIntegration({ user, source: PackageSource.Jumpseller });
                                }}
                                className="ml-1 p-1 text-red-600 hover:bg-red-200 rounded-md transition-all"
                                title="Eliminar conexión con Jumpseller"
                            >
                                <IconTrash className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <p className="text-sm text-[var(--text-muted)]">{user.email}</p>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${
                        user.status === UserStatus.Approved ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                        user.status === UserStatus.Pending ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 animate-pulse' :
                        'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                    }`}>
                        {user.status === UserStatus.Approved ? 'Aprobado' : 
                         user.status === UserStatus.Pending ? 'Pendiente' : 
                         user.status === UserStatus.Disabled ? 'Deshabilitado' : 
                         user.status === UserStatus.Deleted ? 'Eliminado' : user.status}
                    </span>
                </div>
                {user.plainPassword && auth?.user?.role === Role.Admin && user.email !== 'admin' && user.email !== 'admin@admin.cl' && (
                    <p className="text-sm font-mono text-[var(--brand-primary)] mt-1">
                        Contraseña: {user.plainPassword}
                    </p>
                )}
                {(roleFilter === Role.Driver || roleFilter === Role.Auxiliar) && (
                    (() => {
                        const permissions = user.driverPermissions || { canDeliver: true, canPickup: true, canDispatch: true, canReturn: true, canViewHistory: true, canBulkPickup: false, canColecta: false, canAuxiliar: false, canZoning: false, meliAutoPromptPhotos: false };
                        const permissionItems: { key: keyof DriverPermissions, label: string, icon: React.ReactNode }[] = [
                            { key: 'canDeliver', label: 'Entregar', icon: <IconTruck className="w-4 h-4"/> },
                            { key: 'canPickup', label: 'Retirar', icon: <IconQrcode className="w-4 h-4"/> },
                            { key: 'canColecta', label: 'Colecta', icon: <IconTruck className="w-4 h-4"/> },
                            { key: 'canBulkPickup', label: 'Retiro Masivo', icon: <IconChecklist className="w-4 h-4"/> },
                            { key: 'canDispatch', label: 'Despachar', icon: <IconPackage className="w-4 h-4"/> },
                            { key: 'canReturn', label: 'Devoluciones', icon: <IconArrowUturnLeft className="w-4 h-4"/> },
                            { key: 'canAuxiliar', label: 'Auxiliar', icon: <IconUsers className="w-4 h-4"/> },
                            { key: 'canViewHistory', label: 'Historial', icon: <IconHistory className="w-4 h-4"/> },
                            ...(auth?.systemSettings?.gisSectorsEnabled ? [{ key: 'canZoning' as keyof DriverPermissions, label: 'Zonificación', icon: <IconMapPin className="w-4 h-4"/> }] : []),
                            ...(auth?.systemSettings?.meliAutoPromptPhotos ? [{ key: 'meliAutoPromptPhotos' as keyof DriverPermissions, label: 'Auto-abrir Confirmar Entrega', icon: <IconCamera className="w-4 h-4"/> }] : []),
                        ];
                        return (
                            <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
                                <span className="text-xs font-semibold text-[var(--text-muted)] mb-2 block">Permisos de Módulo:</span>
                                <div className="flex items-center gap-2 flex-wrap">
                                    {permissionItems.map(item => (
                                        <button 
                                            key={item.key}
                                            onClick={() => handleTogglePermission(user, item.key)}
                                            title={item.label}
                                            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${permissions[item.key] ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}`}
                                        >
                                            {item.icon}
                                            <span>{item.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )
                    })()
                )}
                {roleFilter === Role.OperadorSistemas && (
                    (() => {
                        const permissions = user.operatorPermissions || { canManageDrivers: true, canManageClients: true, canManagePackages: true, canDeletePackages: false, canManageZones: false, canManageSettings: false, canManageIntegrations: false, canViewReports: true, canBulkActions: true };
                        const permissionItems: { key: keyof OperatorPermissions, label: string, icon: React.ReactNode }[] = [
                            { key: 'canManageDrivers', label: 'Conductores', icon: <IconUsers className="w-4 h-4"/> },
                            { key: 'canManageClients', label: 'Clientes', icon: <IconUsers className="w-4 h-4"/> },
                            { key: 'canManagePackages', label: 'Envíos', icon: <IconPackage className="w-4 h-4"/> },
                            { key: 'canDeletePackages', label: 'Eliminar', icon: <IconTrash className="w-4 h-4"/> },
                            { key: 'canManageZones', label: 'Zonas', icon: <IconTruck className="w-4 h-4"/> },
                            { key: 'canManageSettings', label: 'Ajustes', icon: <IconChecklist className="w-4 h-4"/> },
                            { key: 'canManageIntegrations', label: 'Integraciones', icon: <IconMercadoLibre className="w-4 h-4"/> },
                            { key: 'canViewReports', label: 'Reportes', icon: <IconHistory className="w-4 h-4"/> },
                            { key: 'canBulkActions', label: 'Masivo', icon: <IconChecklist className="w-4 h-4"/> },
                        ];
                        return (
                            <div className="mt-3 pt-3 border-t border-[var(--border-primary)]">
                                <span className="text-xs font-semibold text-[var(--text-muted)] mb-2 block">Permisos de Operador:</span>
                                <div className="flex items-center gap-2 flex-wrap">
                                    {permissionItems.map(item => (
                                        <div 
                                            key={item.key}
                                            title={item.label}
                                            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full ${permissions[item.key] ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'}`}
                                        >
                                            {item.icon}
                                            <span>{item.label}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )
                    })()
                )}
              </div>
              
              {roleFilter === Role.Client && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2 text-sm text-center sm:text-left">
                      <div>
                          <p className="text-xs text-[var(--text-muted)]">En el Día</p>
                          <p className="font-semibold text-[var(--text-primary)]">
                              {(user.pricing?.sameDay || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}
                          </p>
                      </div>
                      <div>
                          <p className="text-xs text-[var(--text-muted)]">Express</p>
                          <p className="font-semibold text-[var(--text-primary)]">
                              {(user.pricing?.express || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}
                          </p>
                      </div>
                      <div>
                          <p className="text-xs text-[var(--text-muted)]">Next Day</p>
                          <p className="font-semibold text-[var(--text-primary)]">
                              {(user.pricing?.nextDay || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}
                          </p>
                      </div>
                      <div>
                          <p className="text-xs text-[var(--text-muted)]">Retiro</p>
                          <p className="font-semibold text-[var(--text-primary)]">
                              {(user.pickupCost || 0).toLocaleString('es-CL', { style: 'currency', currency: 'CLP' })}
                          </p>
                      </div>
                  </div>
              )}

              <div className="flex items-center space-x-2 flex-shrink-0">
                {user.status === UserStatus.Pending && (
                  <button 
                    onClick={() => handleApproveUser(user.id)}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-[var(--brand-primary)] rounded-md hover:bg-[var(--brand-secondary)] transition-colors"
                  >
                    Aprobar
                  </button>
                )}
                {roleFilter === Role.Client && (
                    <>
                    {hasIntegration(user, PackageSource.MercadoLibre) && 
                        <button onClick={() => handleOpenImportModal(user, PackageSource.MercadoLibre)} className="p-2 text-[var(--text-muted)] hover:text-yellow-600 hover:bg-yellow-100 rounded-md transition-colors" title="Importar de Mercado Libre"><IconMercadoLibre className="w-5 h-5" /></button>}
                    {hasIntegration(user, PackageSource.Shopify) && 
                        <button onClick={() => handleOpenImportModal(user, PackageSource.Shopify)} className="p-2 text-[var(--text-muted)] hover:text-green-600 hover:bg-green-100 rounded-md transition-colors" title="Importar de Shopify"><IconShopify className="w-5 h-5" /></button>}
                    {hasIntegration(user, PackageSource.WooCommerce) && 
                        <button onClick={() => handleOpenImportModal(user, PackageSource.WooCommerce)} className="p-2 text-[var(--text-muted)] hover:text-purple-600 hover:bg-purple-100 rounded-md transition-colors" title="Importar de WooCommerce"><IconWoocommerce className="w-5 h-5" /></button>}
                    {hasIntegration(user, PackageSource.Falabella) && 
                        <button onClick={() => handleOpenImportModal(user, PackageSource.Falabella)} className="p-2 text-[var(--text-muted)] hover:text-orange-600 hover:bg-orange-100 rounded-md transition-colors" title="Importar de Falabella"><IconFalabella className="w-5 h-5" /></button>}
                    {hasIntegration(user, PackageSource.Jumpseller) && 
                        <button onClick={() => handleOpenImportModal(user, PackageSource.Jumpseller)} className="p-2 text-[var(--text-muted)] hover:text-sky-600 hover:bg-sky-100 rounded-md transition-colors" title="Importar de Jumpseller"><IconJumpseller className="w-5 h-5" /></button>}
                    {auth?.user?.email === 'admin' && (
                        <button
                            onClick={async () => {
                                if (!window.confirm(`¿Entrar al portal de ${user.name} como este cliente?`)) return;
                                try {
                                    const response = await api.impersonateUser(user.id);
                                    localStorage.setItem('token', response.token);
                                    window.location.href = '/'; // Refresh to load as client
                                } catch (err: any) {
                                    alert("No se pudo entrar al portal: " + err.message);
                                }
                            }}
                            className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors border border-blue-200"
                            title="Entrar al Portal del Cliente"
                        >
                            <IconTruck className="w-5 h-5" />
                        </button>
                    )}
                    <button onClick={() => setViewingInvoicesClient(user)} className="p-2 text-[var(--text-muted)] hover:text-indigo-600 hover:bg-indigo-100 rounded-md transition-colors" title="Historial de Facturas"><IconFileInvoice className="w-5 h-5" /></button>
                    </>
                )}
                {user.role === 'DRIVER' && (
                    <>
                     {auth?.user?.email === 'admin' && (
                        <button
                            onClick={async () => {
                                if (!window.confirm(`¿Entrar al portal de ${user.name} como este conductor?`)) return;
                                try {
                                    const response = await api.impersonateUser(user.id);
                                    localStorage.setItem('token', response.token);
                                    window.location.href = '/'; // Refresh to load as driver
                                } catch (err: any) {
                                    alert("No se pudo entrar al portal: " + err.message);
                                }
                            }}
                            className="p-2 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors border border-blue-200"
                            title="Entrar al Portal del Conductor"
                        >
                            <IconTruck className="w-5 h-5" />
                        </button>
                     )}
                     {auth?.user?.role === Role.Admin && (
                        <button onClick={() => setRevealingPasswordUser(user)} className="p-2 text-[var(--text-muted)] hover:text-blue-600 hover:bg-blue-100 rounded-md transition-colors" title="Ver contraseña"><IconEye className="w-5 h-5" /></button>
                     )}
                     <button onClick={() => setEditingDriverRates(user)} className="p-2 text-[var(--text-muted)] hover:text-green-600 hover:bg-green-100 rounded-md transition-colors" title="Definir tarifas de pago"><IconDollarSign className="w-5 h-5" /></button>
                     <button onClick={() => setViewingHistoryUser(user)} className="p-2 text-[var(--text-muted)] hover:text-green-600 hover:bg-green-100 rounded-md transition-colors" title="Ver historial"><IconHistory className="w-5 h-5" /></button>
                    </>
                )}
                 {user.email !== 'admin@admin.cl' && user.status !== UserStatus.Pending && user.status !== UserStatus.Deleted && (
                    <button 
                        onClick={() => handleToggleStatus(user)}
                        className="p-2 text-[var(--text-muted)] hover:text-yellow-600 hover:bg-yellow-100 rounded-md transition-colors"
                        title={user.status === UserStatus.Approved ? "Deshabilitar usuario" : "Habilitar usuario"}
                    >
                        {user.status === UserStatus.Approved ? <IconUserOff className="w-5 h-5" /> : <IconUserCheck className="w-5 h-5" />}
                    </button>
                )}
                {user.status === UserStatus.Deleted && (
                    <div className="flex items-center space-x-2">
                        <button 
                            onClick={() => setReintegratingUser(user)}
                            className="p-2 text-[var(--text-muted)] hover:text-green-600 hover:bg-green-100 rounded-md transition-colors"
                            title="Reintegrar usuario"
                        >
                            <IconArrowUturnLeft className="w-5 h-5" />
                        </button>
                        <button
                            onClick={() => handleCopyRegistrationLink(user)}
                            className={`p-2 rounded-md transition-all ${copiedUserId === user.id ? 'text-green-500 bg-green-50' : 'text-[var(--text-muted)] hover:text-blue-600 hover:bg-blue-100'}`}
                            title="Copiar Link de Reintegración"
                        >
                            {copiedUserId === user.id ? <IconCheck className="w-5 h-5" /> : <IconCopy className="w-5 h-5" />}
                        </button>
                    </div>
                )}
                {((auth?.user?.role === Role.Admin) || 
                  (auth?.user?.role === Role.OperadorSistemas && auth?.user?.operatorPermissions && (
                    ((user.role === Role.Driver || user.role === Role.Auxiliar || user.role === Role.Retiros) && auth.user.operatorPermissions.canManageDrivers) ||
                    ((user.role === Role.Client || user.role === Role.Facturacion) && auth.user.operatorPermissions.canManageClients) ||
                    ((user.role === Role.OperadorSistemas) && auth.user.operatorPermissions.canManageSettings)
                  ))
                ) && (
                <button 
                    onClick={() => setEditingUser(user)}
                    className="p-2 text-[var(--text-muted)] hover:text-[var(--brand-primary)] hover:bg-[var(--brand-muted)] rounded-md transition-colors"
                    title="Editar usuario"
                >
                    <IconPencil className="w-5 h-5" />
                </button>
                )}
                {user.email !== 'admin@admin.cl' && auth?.user?.role === Role.Admin && (
                    <button 
                        onClick={() => setDeletingUser(user)}
                        className="p-2 text-[var(--text-muted)] hover:text-red-600 hover:bg-red-100 rounded-md transition-colors"
                        title="Eliminar usuario"
                    >
                        <IconTrash className="w-5 h-5" />
                    </button>
                )}
              </div>
            </div>
            )
          })}
        </div>
      </div>
      
      {/* --- Modals --- */}
      {isCreateModalOpen && (
        <CreateUserModal 
          onClose={() => setIsCreateModalOpen(false)}
          onCreate={handleCreateUser}
          defaultRole={roleFilter}
        />
      )}
      {editingUser && (
        <EditUserModal 
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onUpdate={handleUpdateUser}
          currentUserRole={auth?.user?.role}
          isSuperUser={auth?.user?.email === 'admin' || auth?.user?.email === 'admin@admin.cl'}
        />
      )}
      {deletingUser && (
        <DoubleKeyConfirmationModal 
          title="Eliminar Usuario"
          message={`¿Estás seguro de que quieres eliminar a ${deletingUser.name}? Esta acción es IRREVERSIBLE. El usuario será marcado como ELIMINADO, sus integraciones serán borradas y no podrá volver a ingresar hasta ser reintegrado.`}
          confirmText="Eliminar Usuario"
          onClose={() => setDeletingUser(null)}
          onConfirm={(password) => handleDeleteUser(deletingUser.id, password)}
          requiredPhrase="BORRAR USUARIO"
        />
      )}
      {deletingIntegration && (
        <DoubleKeyConfirmationModal 
          title="Eliminar Integración"
          message={`¿Estás seguro de que quieres eliminar la integración de ${deletingIntegration.source} para ${deletingIntegration.user.name}? Esta acción es IRREVERSIBLE. Se perderá la conexión con la tienda externa y no se podrán sincronizar más pedidos.`}
          confirmText="Eliminar Integración"
          onClose={() => setDeletingIntegration(null)}
          onConfirm={(password) => handleDeleteIntegration(deletingIntegration.user.id, deletingIntegration.source, password)}
          requiredPhrase="BORRAR INTEGRACION"
        />
      )}
      {reintegratingUser && (
        <ConfirmationModal 
          title="Reintegrar Usuario"
          message={`¿Estás seguro de que quieres reintegrar a ${reintegratingUser.name}? El usuario volverá a estar activo, pero su historial de envíos empezará de cero.`}
          confirmText="Reintegrar"
          onClose={() => setReintegratingUser(null)}
          onConfirm={() => handleReintegrateUser(reintegratingUser.id)}
        />
      )}
      {viewingHistoryUser && (
        <DriverHistoryModal
            user={viewingHistoryUser}
            onClose={() => setViewingHistoryUser(null)}
        />
      )}
      {editingDriverRates && (
        <DriverRatesModal 
          driver={editingDriverRates}
          onClose={() => setEditingDriverRates(null)}
          onSave={handleUpdateUser}
        />
      )}
      {viewingInvoicesClient && (
        <ClientInvoiceHistoryModal
            client={viewingInvoicesClient}
            onClose={() => setViewingInvoicesClient(null)}
        />
      )}
      {revealingPasswordUser && (
        <RevealPasswordModal
            userId={revealingPasswordUser.id}
            userName={revealingPasswordUser.name}
            onClose={() => setRevealingPasswordUser(null)}
        />
      )}
      {importingClient && importingSource && (
        <ExternalImportModal
            client={importingClient}
            source={importingSource}
            onClose={handleCloseImportModal}
            onImport={handleImportPackages}
        />
      )}
    </div>
  );
};

export default UserManagement;
