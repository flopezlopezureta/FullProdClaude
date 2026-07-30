import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import { API_URL, STORAGE_KEYS } from '../constants';
import { OfflineManager } from './OfflineManager';

// Instancia inicial sin baseURL (se configurará dinámicamente)
const apiInstance = axios.create({
  headers: {
    'Content-Type': 'application/json',
  },
});

// Función para actualizar la URL base dinámicamente
export const setApiBaseUrl = (url: string) => {
  apiInstance.defaults.baseURL = url.endsWith('/api') ? url : `${url}/api`;
};

// Interceptor para añadir el token a todas las peticiones
apiInstance.interceptors.request.use(async (config) => {
  const token = await SecureStore.getItemAsync(STORAGE_KEYS.TOKEN);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const api = {
  // Auth
  login: async (credentials: any) => {
    const response = await apiInstance.post('/auth/login', credentials);
    if (response.data.token) {
      await SecureStore.setItemAsync(STORAGE_KEYS.TOKEN, response.data.token);
      await SecureStore.setItemAsync(STORAGE_KEYS.USER, JSON.stringify(response.data.user));
    }
    return response.data;
  },

  logout: async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEYS.TOKEN);
    await SecureStore.deleteItemAsync(STORAGE_KEYS.USER);
  },

  getCurrentUser: async () => {
    const response = await apiInstance.get('/auth/me');
    return response.data;
  },

  // Packages (Conductor) con Cache Offline
  getDriverPackages: async (driverId: string, startDate?: string, endDate?: string) => {
    try {
      const isOnline = await OfflineManager.isConnected();
      if (!isOnline) {
        console.log('Modo Offline: Cargando paquetes desde cache');
        return await OfflineManager.getPackagesFromCache();
      }

      let url = `/packages?driverFilter=${driverId}&limit=0`;
      if (startDate) url += `&startDate=${startDate}`;
      if (endDate) url += `&endDate=${endDate}`;
      
      const response = await apiInstance.get(url);
      
      // Guardamos en cache para la próxima vez
      if (response.data.packages) {
        await OfflineManager.savePackagesToCache(response.data.packages);
      }
      
      return response.data.packages;
    } catch (error) {
      console.log('Error de red: Intentando cargar desde cache');
      return await OfflineManager.getPackagesFromCache();
    }
  },

  // Paquetes del día para la pantalla de Entregas (solo activos de hoy)
  // Usa /mobile/entregas que filtra por estimatedDelivery=hoy + estados activos
  getMobileEntregas: async () => {
    try {
      const isOnline = await OfflineManager.isConnected();
      if (!isOnline) {
        console.log('Modo Offline: Cargando entregas desde cache');
        return await OfflineManager.getPackagesFromCache();
      }
      const response = await apiInstance.get('/entregas');
      if (response.data) {
        await OfflineManager.savePackagesToCache(response.data);
      }
      return response.data;
    } catch (error) {
      console.log('Error de red: Intentando cargar desde cache');
      return await OfflineManager.getPackagesFromCache();
    }
  },

  confirmDelivery: async (pkgId: string, data: any) => {
    try {
      const isOnline = await OfflineManager.isConnected();
      if (!isOnline) {
        await OfflineManager.queueAction('DELIVER', { pkgId, data });
        return { message: 'Entrega guardada localmente. Se sincronizará al recuperar internet.', offline: true };
      }
      const response = await apiInstance.post(`/packages/${pkgId}/deliver`, data);
      return response.data;
    } catch (error) {
      await OfflineManager.queueAction('DELIVER', { pkgId, data });
      return { message: 'Error de red. Entrega guardada localmente.', offline: true };
    }
  },

  markAsProblem: async (pkgId: string, reason: string, photos: string[]) => {
    try {
      const isOnline = await OfflineManager.isConnected();
      if (!isOnline) {
        await OfflineManager.queueAction('PROBLEM', { pkgId, reason, photos });
        return { message: 'Problema guardado localmente.', offline: true };
      }
      const response = await apiInstance.post(`/packages/${pkgId}/problem`, { reason, photosBase64: photos });
      return response.data;
    } catch (error) {
      await OfflineManager.queueAction('PROBLEM', { pkgId, reason, photos });
      return { message: 'Error de red. Guardado localmente.', offline: true };
    }
  },

  syncLocation: async (driverId: string, latitude: number, longitude: number) => {
    const isOnline = await OfflineManager.isConnected();
    if (!isOnline) return null; // Skip location sync if offline
    return apiInstance.post('/geo/update-location', { driverId, latitude, longitude });
  },

  // Cierres de Jornada
  getClosureSummary: async () => {
    const response = await apiInstance.get('/closures/summary');
    return response.data;
  },

  submitClosure: async (closureData: any) => {
    const response = await apiInstance.post('/closures', closureData);
    return response.data;
  },

  // Sincronización de Cola Offline
  syncPendingActions: async () => {
    const isOnline = await OfflineManager.isConnected();
    if (!isOnline) return 0;

    const pending = await OfflineManager.getPendingActions();
    if (pending.length === 0) return 0;

    let successCount = 0;
    for (const action of pending) {
      try {
        if (action.type === 'DELIVER') {
          await apiInstance.post(`/packages/${action.data.pkgId}/deliver`, action.data.data);
        } else if (action.type === 'PROBLEM') {
          await apiInstance.post(`/packages/${action.data.pkgId}/problem`, { 
            reason: action.data.reason, 
            photosBase64: action.data.photos 
          });
        }
        await OfflineManager.removeActionFromQueue(action.id);
        successCount++;
      } catch (e) {
        console.error('Error syncing action', action.id, e);
      }
    }
    return successCount;
  },

  // Obtener todos los usuarios (para mapear creadores)
  getUsers: async () => {
    const response = await apiInstance.get('/users');
    return response.data;
  },

  // Obtener datos del cliente (para retiros)
  getClients: async () => {
    const response = await apiInstance.get('/users');
    return response.data.filter((u: any) => u.role === 'CLIENT');
  },

  scanPackageForDispatch: async (packageId: string, driverId: string, flexCode?: string, flexLabelPhotoBase64?: string, forceReassign?: boolean) => {
    const response = await apiInstance.post(`/packages/${packageId}/dispatch`, { 
        driverId, 
        flexCode, 
        flexLabelPhotoBase64,
        forceReassign
    });
    return response.data;
  },

  // Mercado Libre Tools
  markPackageAsFlexed: async (packageId: string, isFlexed: boolean, flexLabelPhotoBase64?: string) => {
    const response = await apiInstance.post(`/packages/${packageId}/flex`, { isFlexed, flexLabelPhotoBase64 });
    return response.data;
  },

  syncPackageWithMeli: async (packageId: string) => {
    const response = await apiInstance.post(`/packages/${packageId}/sync-meli`);
    return response.data;
  },

  // Retiros
  getDriverPickups: async () => {
    const response = await apiInstance.get('/pickups/driver/today');
    return response.data;
  },

  updatePickupStatus: async (assignmentId: string, status: string, packagesPickedUp: number) => {
    const response = await apiInstance.put(`/pickups/assignments/${assignmentId}/status`, { status, packagesPickedUp });
    return response.data;
  },

  markPackageAsPickedUp: async (packageId: string, flexCode?: string) => {
    const response = await apiInstance.post(`/packages/${packageId}/pickup`, { flexCode });
    return response.data;
  },

  updatePackage: async (pkgId: string, data: any) => {
    const response = await apiInstance.put(`/packages/${pkgId}`, data);
    return response.data;
  },

  getPackageDetails: async (pkgId: string) => {
    const response = await apiInstance.get(`/packages/${pkgId}`);
    return response.data;
  },

  getSystemSettings: async () => {
    const response = await apiInstance.get('/settings/system');
    return response.data;
  }
};
