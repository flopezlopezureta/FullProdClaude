import {
  Package,
  User,
  SystemSettings,
  DeliveryZone,
  Invoice,
  IntegrationSettings,
  MeliOrder,
  PickupRun,
  AssignmentEvent,
  DriverPermissions,
  OperatorPermissions,
  Notification
} from '../types';
import { PackageStatus, ShippingType, Role } from '../constants';

const API_URL = '/api';

export class ApiError extends Error {
  status: number;
  body: any;

  constructor(message: string, status: number, body?: any) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const getHeaders = () => {
    const token = localStorage.getItem('token');
    return {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    };
  };

  const headers: HeadersInit = {
    ...getHeaders(),
    ...options.headers,
  };

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type');
  const isJson = contentType && contentType.includes('application/json');

  if (!response.ok) {
    // Si el token no es válido o ha expirado (401), cerramos la sesión automáticamente
    if (response.status === 401) {
      const hasToken = !!localStorage.getItem('token');
      const isLoginRequest = endpoint.includes('/auth/login');
      
      if (!isLoginRequest && hasToken) {
        console.warn('[API] Sesión expirada o inválida (401). Limpiando token...');
        localStorage.removeItem('token');
        
        // Redirigimos forzadamente al login para romper cualquier bucle
        if (!window.location.pathname.includes('/login')) {
          window.location.href = '/login';
        }
      } else if (!isLoginRequest) {
        // Si no hay token y da 401, simplemente limpiamos por si acaso pero no recargamos
        localStorage.removeItem('token');
      }
    }

    let errorMessage = `Error ${response.status}: ${response.statusText}`;
    let errorBody = {};

    if (isJson) {
      try {
        errorBody = await response.json();
        errorMessage = (errorBody as any).message || errorMessage;
      } catch (e) {
        console.warn('[API] Could not parse error JSON body');
      }
    } else {
      const text = await response.text();
      console.warn(`[API] Received non-JSON error response (${response.status}):`, text.substring(0, 100));
      
      // Manejo específico para 404 cuando el servidor devuelve HTML (común en SPAs con fallbacks mal configurados)
      if (response.status === 404) {
        errorMessage = "El recurso solicitado no fue encontrado (404). Es posible que el paquete haya sido eliminado o reasignado.";
      }
    }

    throw new ApiError(errorMessage, response.status, errorBody);
  }

  if (response.status === 204) {
    return {} as T;
  }

  if (!isJson) {
    const text = await response.text();
    console.error(`[API] Expected JSON but received ${contentType}:`, text.substring(0, 100));
    throw new ApiError('El servidor devolvió un formato no válido (HTML)', response.status, { raw: text.substring(0, 200) });
  }

  try {
    return await response.json();
  } catch (e) {
    console.error('[API] Failed to parse success response as JSON');
    throw new ApiError('Error al procesar la respuesta del servidor', response.status);
  }
}

const get = <T>(endpoint: string) => request<T>(endpoint, { method: 'GET' });
const post = <T>(endpoint: string, body: any) => request<T>(endpoint, { method: 'POST', body: JSON.stringify(body) });
const put = <T>(endpoint: string, body: any) => request<T>(endpoint, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(endpoint: string) => request<T>(endpoint, { method: 'DELETE' });

// --- Types ---

export interface LoginCredentials {
  email?: string;
  password?: string;
}

export interface RegisterData {
  name: string;
  email: string;
  password?: string;
  role: Role;
  phone?: string;
  rut?: string;
  address?: string;
  pickupAddress?: string;
  storesInfo?: string;
}

export interface PackageCreationData {
  creatorId: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  recipientCommune: string;
  recipientCity: string;
  notes?: string;
  estimatedDelivery: Date;
  shippingType: ShippingType;
  origin: string;
  source: string;
  meliOrderId?: string;
  shopifyOrderId?: string;
  wooOrderId?: string;
  jumpsellerOrderId?: string;
  trackingId?: string;
  recipientEmail?: string;
}

export interface PackageUpdateData {
  recipientName?: string;
  recipientPhone?: string;
  recipientAddress?: string;
  recipientCommune?: string;
  recipientCity?: string;
  notes?: string;
  origin?: string;
  status?: PackageStatus;
  shippingType?: ShippingType;
  estimatedDelivery?: Date;
  destLatitude?: number;
  destLongitude?: number;
  recipientEmail?: string;
  creatorId?: string;
}

export interface UserCreationData extends RegisterData {
    personalRut?: string;
    billingName?: string;
    billingRut?: string;
    billingAddress?: string;
    billingCommune?: string;
    billingGiro?: string;
    pickupCost?: number;
    pricing?: any;
    driverPermissions?: DriverPermissions;
    operatorPermissions?: OperatorPermissions;
}

export interface UserUpdateData extends Partial<UserCreationData> {
    companyName?: string;
    companyRut?: string;
    companyAddress?: string;
    licenseType?: string;
    licenseExpiry?: string;
    backgroundCheckNotes?: string;
    vehicles?: any[];
    integrations?: any;
    driverPermissions?: DriverPermissions;
    operatorPermissions?: OperatorPermissions;
}

export interface DeliveryConfirmationData {
  receiverName: string;
  receiverId: string;
  photosBase64: string[];
}

export const cityCoordinates: { [key: string]: [number, number] } = {
    'Santiago': [-33.4489, -70.6693],
    'Arica': [-18.4783, -70.3126],
    'Iquique': [-20.2307, -70.1357],
    'Antofagasta': [-23.6509, -70.3975],
    'Calama': [-22.4542, -68.9292],
    'Copiapó': [-27.3667, -70.3333],
    'La Serena': [-29.9027, -71.2520],
    'Coquimbo': [-29.9533, -71.3436],
    'Valparaíso': [-33.0472, -71.6127],
    'Viña del Mar': [-33.0245, -71.5518],
    'Rancagua': [-34.1708, -70.7444],
    'Talca': [-35.4264, -71.6554],
    'Concepción': [-36.8201, -73.0444],
    'Talcahuano': [-36.7167, -73.1167],
    'Temuco': [-38.7359, -72.5904],
    'Valdivia': [-39.8142, -73.2459],
    'Puerto Montt': [-41.4689, -72.9411],
    'Coyhaique': [-45.5712, -72.0685],
    'Punta Arenas': [-53.1638, -70.9171],
    'Providencia': [-33.4314, -70.6093],
    'Las Condes': [-33.4116, -70.5807],
    'Vitacura': [-33.4000, -70.6000], // Approx
    'Lo Barnechea': [-33.3500, -70.5167], // Approx
    'Ñuñoa': [-33.4569, -70.6036],
    'La Reina': [-33.4400, -70.5300], // Approx
    'Macul': [-33.4862, -70.6030],
    'Peñalolén': [-33.4860, -70.5370],
    'La Florida': [-33.5230, -70.5970],
    'San Joaquín': [-33.4930, -70.6270],
    'La Granja': [-33.5350, -70.6190],
    'San Ramón': [-33.5420, -70.6440],
    'La Cisterna': [-33.5360, -70.6620],
    'El Bosque': [-33.5670, -70.6730],
    'San Miguel': [-33.4930, -70.6540],
    'Lo Espejo': [-33.5220, -70.6870],
    'Pedro Aguirre Cerda': [-33.4870, -70.6730],
    'Cerrillos': [-33.5040, -70.7150],
    'Maipú': [-33.5106, -70.7573],
    'Estación Central': [-33.4610, -70.6970],
    'Quinta Normal': [-33.4430, -70.6930],
    'Lo Prado': [-33.4440, -70.7250],
    'Cerro Navia': [-33.4240, -70.7300],
    'Renca': [-33.4050, -70.7290],
    'Independencia': [-33.4160, -70.6630],
    'Recoleta': [-33.4060, -70.6420],
    'Conchalí': [-33.3820, -70.6780],
    'Huechuraba': [-33.3740, -70.6370],
    'Quilicura': [-33.3550, -70.7280],
    'Pudahuel': [-33.4420, -70.7720],
    'La Pintana': [-33.5830, -70.6340],
    'San Bernardo': [-33.5930, -70.6990],
    'Puente Alto': [-33.6117, -70.5758],
    'Lampa': [-33.2830, -70.8670],
    'Colina': [-33.2030, -70.6760],
    'Padre Hurtado': [-33.5667, -70.8167],
};

export const parseDateString = (dateString: string): Date => {
    // Expecting YYYY-MM-DD
    const parts = dateString.split('-');
    if (parts.length === 3) {
        return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
    }
    return new Date(dateString);
};

export const getISODate = (date: Date): string => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

export const api = {
  // Auth
  login: (credentials: LoginCredentials) => post<{token: string, user: User}>('/auth/login', credentials),
  register: (data: RegisterData) => post<User>('/auth/register', data),
  getUserByToken: () => get<User>('/auth/me'),
  requestPasswordRecovery: (email: string) => post<{message: string}>('/auth/recover-password', { email }),
  getFleetStatus: (date?: string) => get<any[]>(`/users/fleet-status${date ? `?date=${date}` : ''}`),
  getAnalytics: (date?: string) => get<{ hourly: any[], ranking: any[] }>(`/users/analytics${date ? `?date=${date}` : ''}`),

  // Users
  getUsers: () => get<User[]>('/users'),
  createUser: (data: UserCreationData) => post<User>('/users', data),
  updateUser: (userId: string, data: UserUpdateData) => put<User>(`/users/${encodeURIComponent(userId)}`, data),
  deleteUser: (userId: string, password?: string) => request<void>(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE', body: JSON.stringify({ password }) }),
  deleteIntegration: (clientId: string, source: string, password?: string) => request<void>(`/integrations/${encodeURIComponent(clientId)}/${encodeURIComponent(source)}`, { method: 'DELETE', body: JSON.stringify({ password }) }),
  reintegrateUser: (userId: string) => post<User>(`/users/${encodeURIComponent(userId)}/reintegrate`, {}),
  approveUser: (userId: string) => post<User>(`/users/${encodeURIComponent(userId)}/approve`, {}),
  toggleUserStatus: (userId: string) => post<User>(`/users/${encodeURIComponent(userId)}/toggle-status`, {}),
  
  // Packages
  getPackages: (params: any) => {
      const searchParams = new URLSearchParams();
      Object.keys(params).forEach(key => {
          if (params[key] !== undefined && params[key] !== null && params[key] !== '') {
              searchParams.append(key, String(params[key]));
          }
      });
      return get<{ packages: Package[], total: number }>(`/packages?${searchParams.toString()}`);
  },
  getPackage: (pkgId: string) => get<Package>(`/packages/${encodeURIComponent(pkgId)}`),
  createPackage: (data: PackageCreationData) => post<Package>('/packages', data),
  createMultiplePackages: (packages: PackageCreationData[]) => post<{ 
      success: boolean, 
      importedCount: number, 
      errorCount: number, 
      errors: any[] 
  }>('/packages/batch', { packages }),
  updatePackage: (pkgId: string, data: PackageUpdateData) => put<Package>(`/packages/${encodeURIComponent(pkgId)}`, data),
  deletePackage: (pkgId: string, password?: string) => request<void>(`/packages/${encodeURIComponent(pkgId)}`, { method: 'DELETE', body: JSON.stringify({ password }) }),
  assignDriverToPackage: (pkgId: string, driverId: string | null, newDeliveryDate: Date) => post<Package>(`/packages/${encodeURIComponent(pkgId)}/assign-driver`, { driverId, newDeliveryDate }),
  batchAssignDriverToPackages: (packageIds: string[], driverId: string | null, newDeliveryDate: Date) => post<{message: string}>(`/packages/batch-assign-driver`, { packageIds, driverId, newDeliveryDate }),
  markPackageForReturn: (pkgId: string) => post<Package>(`/packages/${encodeURIComponent(pkgId)}/mark-for-return`, {}),
  confirmDelivery: (pkgId: string, data: DeliveryConfirmationData) => post<Package>(`/packages/${encodeURIComponent(pkgId)}/deliver`, data),
  markPackageAsProblem: (pkgId: string, reason: string, photos: string[]) => post<Package>(`/packages/${encodeURIComponent(pkgId)}/problem`, { reason, photosBase64: photos }),
  confirmReturn: (pkgId: string, data: DeliveryConfirmationData) => post<Package>(`/packages/${encodeURIComponent(pkgId)}/return`, data),
  markPackagesAsBilled: (packageIds: string[]) => post<void>('/packages/mark-billed', { packageIds }),
  scanPackageForDispatch: (packageId: string, driverId: string, flexCode?: string, flexLabelPhotoBase64?: string, forceReassign?: boolean) => post<{message: string, package: Package}>(`/packages/${encodeURIComponent(packageId)}/dispatch`, { driverId, flexCode, flexLabelPhotoBase64, forceReassign }),
  queryPackageSector: (searchId: string) => get<{ package: Package; sectorDetails: { comuna: string; sector: string; sectorLabel: string; geometry: any } | null }>(`/packages/query/${encodeURIComponent(searchId)}`),
  markPackageAsFlexed: (packageId: string, isFlexed: boolean, flexLabelPhotoBase64?: string) => post<Package>(`/packages/${encodeURIComponent(packageId)}/flex`, { isFlexed, flexLabelPhotoBase64 }),
  syncPackageWithMeli: (packageId: string) => post<Package & { noChange?: boolean; mlStatus?: string; mlSubstatus?: string }>(`/packages/${encodeURIComponent(packageId)}/sync-meli`, {}),
  syncAllMeliPackages: () => post<{ message: string; result: any }>('/packages/sync-meli-all', {}),
  markPackageAsPickedUp: (packageId: string, flexCode?: string) => post<Package>(`/packages/${encodeURIComponent(packageId)}/pickup`, { flexCode }),
  confirmBulkPickup: (clientId: string) => post<{count: number, message: string}>('/packages/bulk-pickup-client', { clientId }),
  scanPackageByAdmin: (packageId: string) => post<{message: string}>(`/packages/${encodeURIComponent(packageId)}/scan-admin`, {}),
  checkAlert: (packageId: string, checked: boolean) => post<Package>(`/packages/${encodeURIComponent(packageId)}/check-alert`, { checked }),
  bulkUpdatePackageStatus: (packageIds: string[], status: PackageStatus) => post<{message: string}>('/packages/bulk-update-status', { packageIds, status }),

  // Settings
  getSystemSettings: () => get<SystemSettings>('/settings/system'),
  updateSystemSettings: (data: Partial<SystemSettings>) => put<SystemSettings>('/settings/system', data),
  getLicenseStatus: () => get<{ activeCount: number; limit: number; exceeded: boolean }>('/settings/license-status'),
  getMeliPollingStatus: () => get<{ nextPollTime: number; isPolling: boolean; intervalMs: number; totalPackages?: number; processedPackages?: number; lastImportCount?: number }>('/settings/meli-polling-status'),
  getShopifyPollingStatus: () => get<{ nextPollTime: number; isPolling: boolean; intervalMs: number; lastImportCount?: number }>('/settings/shopify-polling-status'),
  getCommunes: () => get<any[]>('/settings/communes'),
  updateCommunes: (communes: { name: string, isActive: boolean }[]) => post<{ message: string }>('/settings/communes', { communes }),
  syncMeliPackages: () => post<{ message: string }>('/settings/sync-meli', {}),
  syncShopifyPackages: () => post<{ message: string }>('/settings/sync-shopify', {}),
  resetDatabase: (password: string) => post<{message: string}>('/settings/reset-database', { password }),
  resetPackages: (password: string) => post<{message: string}>('/settings/reset-packages', { password }),
  resetClients: (password: string) => post<{message: string}>('/settings/reset-clients', { password }),
  resetDrivers: (password: string) => post<{message: string}>('/settings/reset-drivers', { password }),
  resetZones: (password: string) => post<{message: string}>('/settings/reset-zones', { password }),
  resetInvoices: (password: string) => post<{message: string}>('/settings/reset-invoices', { password }),
  
  // Logs
  getSystemLogs: () => get<any[]>('/logs'),
  
  // Integrations
  getIntegrationSettings: () => get<IntegrationSettings>('/settings/integrations'),
  updateIntegrationSettings: (data: Partial<IntegrationSettings>) => put<IntegrationSettings>('/settings/integrations', data),
  testMeliConnection: (creds: { meliAppId: string, meliClientSecret: string }) => post<{message: string}>('/settings/test-meli', creds),
  testShopifyConnection: (creds: { shopifyShopUrl: string, shopifyAccessToken: string }) => post<{message: string, shopName?: string}>('/integrations/test/shopify', creds),
  testWooCommerceConnection: (creds: { wooUrl: string, wooConsumerKey: string, wooConsumerSecret: string }) => post<{message: string}>('/integrations/test/woocommerce', creds),
  testFalabellaConnection: (creds: { falabellaApiKey: string, falabellaSellerId: string }) => post<{message: string}>('/integrations/test/falabella', creds),
  testJumpsellerConnection: (creds: { jumpsellerLogin: string, jumpsellerToken: string }) => post<{message: string}>('/integrations/test/jumpseller', creds),
  testSmtpConnection: (creds: { smtpHost: string, smtpPort: string, smtpUser: string, smtpPassword: string }) => post<{message: string}>('/settings/test-smtp', creds),
  getGoogleAuthUrl: () => get<{url: string}>('/auth/google/url'),
  disconnectGoogleSmtp: () => post<{message: string}>('/settings/disconnect-google-smtp', {}),
  
  fetchMeliOrders: (clientId: string) => get<MeliOrder[]>(`/integrations/${clientId}/meli/orders`),
  importMeliOrders: (clientId: string, orderIds: string[]) => post<void>(`/integrations/${clientId}/meli/import`, { orderIds }),
  fetchShopifyOrders: (clientId: string) => get<any[]>(`/integrations/${clientId}/shopify/orders`),
  fetchWooCommerceOrders: (clientId: string) => get<any[]>(`/integrations/${clientId}/woocommerce/orders`),
  fetchFalabellaOrders: (clientId: string) => get<any[]>(`/integrations/${clientId}/falabella/orders`),
  fetchJumpsellerOrders: (clientId: string) => get<any[]>(`/integrations/${clientId}/jumpseller/orders`),
  importScannedMeliOrder: (clientId: string, scannedId: string, flexCode?: string) => post<{message: string, pkg: Package}>(`/integrations/import/meli-scanned`, { clientId, scannedId, flexCode }),
  checkMeliShipmentStatus: (shipmentId: string) => get<{status: string, substatus: string}>(`/integrations/status/${shipmentId}`),
  syncMeliPackage: (shipmentId: string) => post<Package>(`/integrations/sync-shipment/${shipmentId}`, {}),
  
  // New Accounts Management
  getIntegrationAccounts: () => get<any[]>('/integrations/accounts'),
  createIntegrationAccount: (data: { type: string, nickname?: string, credentials: any }) => post<any>('/integrations/accounts', data),
  updateIntegrationAccount: (accountId: string, data: any) => request<any>(`/integrations/accounts/${accountId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteIntegrationAccount: (accountId: string) => request<void>(`/integrations/accounts/${accountId}`, { method: 'DELETE' }),

  // Push Notifications
  savePushSubscription: (subscription: PushSubscription) => post<void>('/notifications/subscribe', subscription),
  deletePushSubscription: (subscription: PushSubscriptionJSON) => post<void>('/notifications/unsubscribe', subscription),

  // Notifications
  getNotifications: () => get<Notification[]>('/notifications'),
  markNotificationAsRead: (id: string) => request<void>(`/notifications/${id}/read`, { method: 'PATCH' }),
  deleteNotification: (id: string) => del<void>(`/notifications/${id}`),

  // Zones
  getDeliveryZones: () => get<DeliveryZone[]>('/zones'),
  createDeliveryZone: (data: Omit<DeliveryZone, 'id'>) => post<DeliveryZone>('/zones', data),
  updateDeliveryZone: (id: string, data: Omit<DeliveryZone, 'id'>) => put<DeliveryZone>(`/zones/${id}`, data),
  deleteDeliveryZone: (id: string) => del<void>(`/zones/${id}`),

  // Invoices & Billing
  createInvoice: (clientId: string, packageIds: string[], amount: number, pickupCount?: number, pickupCostTotal?: number) => post<Invoice>('/invoices', { clientId, packageIds, amount, pickupCount, pickupCostTotal }),

  // Geo
  updateDriverLocation: (driverId: string, latitude: number, longitude: number) => post<void>('/geo/update-location', { driverId, latitude, longitude }),
  getActiveDriversLocations: () => get<User[]>('/geo/active-drivers'),
  getRoutePolyline: (points: {lat: number, lng: number}[]) => post<[number, number][]>('/geo/route', { points }),

  // Pickups & Assignments (Legacy + New System)
  getAssignmentHistory: () => get<AssignmentEvent[]>('/assignments/history'),
  assignDriverToClient: (clientId: string, driverId: string | null) => post<AssignmentEvent>('/assignments/assign-client', { clientId, driverId }),
  reassignPickup: (eventId: string, newDriverId: string, reason: string) => post<AssignmentEvent>(`/assignments/${eventId}/reassign`, { newDriverId, reason }),
  updateAssignmentCost: (eventId: string, cost: number) => put<AssignmentEvent>(`/assignments/${eventId}/cost`, { cost }),
  dispatchPickupAssignment: (eventId: string) => post<AssignmentEvent>(`/assignments/${eventId}/dispatch`, {}),
  
  getPickupRuns: (params: { startDate: string, endDate: string }) => {
      const searchParams = new URLSearchParams(params);
      return get<PickupRun[]>(`/pickups?${searchParams.toString()}`);
  },
  // Fix: Add missing method to fetch today's pickup runs for a driver.
  getDriverPickupRun: () => get<PickupRun[]>('/pickups/driver/today'),
  createPickupRun: (data: any) => post<PickupRun>('/pickups', data),
  addAssignmentsToRun: (runId: string, assignments: any[]) => post<{message: string}>(`/pickups/runs/${runId}/assignments`, { assignments }),
  copyPickupRun: (runId: string, dates: string[], assignmentIds: string[]) => post<{message: string}>(`/pickups/runs/${runId}/copy`, { dates, assignmentIds }),
  reassignPickupRun: (runId: string, newDriverId: string) => put<PickupRun>(`/pickups/runs/${runId}/reassign`, { newDriverId }),
  updatePickupAssignment: (id: string, data: any) => put<void>(`/pickups/assignments/${id}`, data),
  deletePickupAssignment: (id: string) => del<void>(`/pickups/assignments/${id}`),
  deletePickupRun: (id: string) => del<void>(`/pickups/runs/${id}`),
  markPickupRunAsInformed: (id: string) => put<void>(`/pickups/runs/${id}/inform`, {}),
  updatePickupAssignmentStatus: (id: string, status: string, packagesPickedUp?: number) => put<void>(`/pickups/assignments/${id}/status`, { status, packagesPickedUp }),
  completeClientPickupAssignment: (clientId: string, packagesPickedUp: number) => post<any>('/assignments/complete', { clientId, packagesPickedUp }),
  
  // Colectas
  getAvailableColectas: () => get<any[]>('/pickups/colectas/available'),
  claimColecta: (clientId: string, shift: string) => post<any>('/pickups/colectas/claim', { clientId, shift }),

  // Reports
  getFlexDiscrepancies: () => get<any[]>('/packages/reports/flex-discrepancies'),
  getDriverFlexDiscrepancyDetails: (driverId: string) => get<any[]>(`/packages/reports/flex-discrepancies/${driverId}`),

  // Mercado Libre Tracking
  getMeliTracking: (packageId: string) => get<{ trackingId: string, shipmentStatus: string, source: string }>(`/integrations/meli-tracking/${packageId}`),
  getMeliLabelUrl: (packageId: string) => {
    const token = localStorage.getItem('token');
    return `/api/integrations/meli-label/${packageId}${token ? `?token=${token}` : ''}`;
  },
  bulkMarkAllProcessed: () => post<{message: string, updatedCount: number}>('/packages/sys/bulk-mark-processed', {}),
  forceCloseOldPackages: (days: number) => post<{message: string, updatedCount: number}>('/packages/sys/force-close-old', { days }),

  // GIS Sectors
  getGisSectors: (comuna?: string) => get<any[]>(`/gis/sectors${comuna ? `?comuna=${encodeURIComponent(comuna)}` : ''}`),
  getGisSectorComunas: () => get<{ comuna: string; count: number }[]>('/gis/sectors/comunas'),
  createGisSector: (data: { comuna: string; sector: string; geometry: any; color?: string }) => post<any>('/gis/sectors', data),
  updateGisSector: (id: string, data: { sector?: string; geometry?: any; color?: string }) => put<any>(`/gis/sectors/${id}`, data),
  deleteGisSector: (id: string) => del<void>(`/gis/sectors/${id}`),

  // Projection
  getPackageProjection: (date: string) => get<any[]>(`/packages/projection?date=${encodeURIComponent(date)}`),

  // Test WhatsApp
  testWhatsapp: (phone: string, apikey: string) => post<{message: string}>('/settings/test-whatsapp', { phone, apikey }),

  // Fleet Control Center (Multimodal)
  getFleetControlCenter: (date?: string) => get<{
    date: string;
    closures: any[];
    cadence: any[];
    chronometry: any[];
  }>(`/users/fleet-control-center${date ? `?date=${date}` : ''}`),
  notifyDriverClosure: (driverId: string) => post<{ message: string }>('/users/notify-driver-closure', { driverId }),
};