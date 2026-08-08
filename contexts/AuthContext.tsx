import React, { createContext, useState, useEffect, ReactNode } from 'react';
import { Role, MessagingPlan, PickupMode, LabelFormat } from '../constants';
import type { User, SystemSettings } from '../types';
import { api, LoginCredentials, RegisterData } from '../services/api';

const VAPID_PUBLIC_KEY = 'BElz_7y329pI3y-nJv4vQ22f0yq2fJOVAHP3yqg2K42j2Q3hQ4w9w8jX7JU8y8F8cE8d7j_8H4Jz3VpXqGfA2Bc';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isInitialized: boolean;
  systemSettings: SystemSettings;
  login: (credentials: LoginCredentials) => Promise<User>;
  logout: () => void;
  register: (data: RegisterData) => Promise<User>;
  updateSystemSettings: (newSettings: Partial<SystemSettings>) => Promise<void>;
  refetchUser: () => Promise<void>;
  activeCommunes: string[];
  refetchCommunes: () => Promise<void>;
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  subscribeToPush: () => Promise<void>;
  unsubscribeFromPush: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const setNormalizedUser = (u: User | null) => {
    if (u) {
      const upperRole = String(u.role || '').toUpperCase();
      if (['ADMINISTRADOR', 'ADMIN_SISTEMAS', 'ADMIN'].includes(upperRole)) {
        u.role = Role.Admin;
      } else if (['CLIENTE', 'CLIENT'].includes(upperRole)) {
        u.role = Role.Client;
      } else if (['CHOFER', 'CONDUCTOR', 'DRIVER'].includes(upperRole)) {
        u.role = Role.Driver;
      }
    }
    setUser(u);
  };

  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));
  const [isInitialized, setIsInitialized] = useState<boolean>(false);
  const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
    companyName: 'Sistema de Seguimiento',
    isAppEnabled: true,
    requiredPhotos: 1,
    messagingPlan: MessagingPlan.None,
    pickupMode: PickupMode.Scan,
    meliFlexValidation: true,
    saveFlexLabelPhoto: false,
    meliAutoImport: false,
    shopifyAutoImport: false,
    woocommerceAutoImport: false,
    publicTrackingEnabled: true,
    isRutRequired: true,
    labelFormat: LabelFormat.CompactThermal,
    circuitExportEnabled: false,
    timeFormat: '12h',
    allowRedelivery: false,
    licenseLimit: 70,
    licenseOverageFee: 0.1,
    gisSectorsEnabled: true,
  };
  // A driver who loses connection right as the app (re)loads was falling back to these
  // hardcoded generic defaults (e.g. "1 photo required, RUT required") instead of the admin's
  // actual configuration — seed the initial state from the last successfully-fetched settings
  // (cached below whenever the fetch succeeds) so an offline reload keeps using real values.
  const getCachedSystemSettings = (): SystemSettings => {
    try {
      const raw = localStorage.getItem('cached_system_settings');
      if (raw) return { ...DEFAULT_SYSTEM_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      console.warn('[Auth] Failed to parse cached system settings', e);
    }
    return DEFAULT_SYSTEM_SETTINGS;
  };
  const [systemSettings, setSystemSettings] = useState<SystemSettings>(getCachedSystemSettings);
  const [activeCommunes, setActiveCommunes] = useState<string[]>([]);
  const [isPushSubscribed, setIsPushSubscribed] = useState(false);
  const [isPushLoading, setIsPushLoading] = useState(true);

  useEffect(() => {
    const initializeAuth = async () => {
      // If we literally just logged in (user and token set), we don't need to re-fetch yet.
      // This prevents a redundant call that, if it fails due to transient network issues, kicks the user out.
      if (user && token && isInitialized) {
        console.log("[Auth] Already have user session, skipping re-initialization re-fetch.");
        return;
      }

      console.log("[Auth] Initializing session...");
      try {
        // 1. Core Profile fetch (needs token)
        if (token) {
          try {
            const fetchedUser = await api.getUserByToken();
            setNormalizedUser(fetchedUser);
          } catch (userErr: any) {
            console.error("[Auth] Failed to fetch user profile:", userErr);
            // ONLY logout if the error is an authentication error (401 or 403)
            // or if the user is explicitly reported as not found/inactive.
            const statusCode = userErr.status;
            const errorMsg = String(userErr.message || "");
            
            if (statusCode === 401 || statusCode === 403 || errorMsg.includes("autorización denegada")) {
              console.warn("[Auth] Invalid session detected. Clearing credentials.");
              localStorage.removeItem('token');
              setToken(null);
              setNormalizedUser(null);
            }
          }
        }

        // 2. Systems Settings fetch (non-blocking for auth)
        try {
          const settings = await api.getSystemSettings();
          setSystemSettings(settings);
          try {
            localStorage.setItem('cached_system_settings', JSON.stringify(settings));
          } catch (cacheErr) {
            console.warn('[Auth] Failed to cache system settings', cacheErr);
          }
        } catch (settingsErr) {
          // Offline or request failed: keep whatever we already have in state (the cached
          // settings this component was seeded with), instead of silently reverting to the
          // generic hardcoded defaults — see getCachedSystemSettings above.
          console.error("[Auth] Failed to fetch system settings. Using last cached values.", settingsErr);
        }

        // 3. Active Communes fetch (Always fetch if possible, non-blocking)
        try {
          const communesData = await api.getCommunes();
          setActiveCommunes(communesData.filter(c => !!c && c.isActive).map(c => c.name));
        } catch (communesErr) {
          console.error("[Auth] Failed to fetch communes.", communesErr);
        }

      } catch (globalErr) {
        console.error("[Auth] Fatal initialization error:", globalErr);
      } finally {
        setIsInitialized(true);
      }
    };

    // Avoid running if we are already initialized and have a user (prevents logout loops)
    if (!isInitialized || (token && !user)) {
      initializeAuth();
    } else {
      setIsInitialized(true);
    }
  }, [token]);

  useEffect(() => {
    if (systemSettings.companyName) {
      document.title = systemSettings.companyName;
    }
  }, [systemSettings.companyName]);

  useEffect(() => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.ready.then(registration => {
            registration.pushManager.getSubscription().then(subscription => {
                setIsPushSubscribed(!!subscription);
                setIsPushLoading(false);
            });
        });
    } else {
        console.warn('Push notifications are not supported in this browser.');
        setIsPushLoading(false);
    }
  }, []);
  
   const refetchUser = async () => {
       if (token) {
            const fetchedUser = await api.getUserByToken();
            setNormalizedUser(fetchedUser);
       }
   };
 
   const refetchCommunes = async () => {
       try {
           const communesData = await api.getCommunes();
           setActiveCommunes(communesData.filter(c => c.isActive).map(c => c.name));
       } catch (err) {
           console.error("Failed to refetch communes", err);
       }
   };
 
   const login = async (credentials: LoginCredentials) => {
     try {
       console.log("[Auth] Attempting login for:", credentials.email);
       const { token: newToken, user: loggedInUser } = await api.login(credentials);
       
       console.log("[Auth] Login successful, setting state and storage...");
       localStorage.setItem('token', newToken);
       setToken(newToken);
       setNormalizedUser(loggedInUser);
       return loggedInUser;
     } catch (error) {
       console.error("[Auth] Login failed:", error);
       throw error;
     }
   };
 
   const logout = () => {
     console.log("[Auth] Logging out user...");
     console.trace("[Auth] Logout called from:");
     localStorage.removeItem('token');
     setToken(null);
     setNormalizedUser(null);
   };

  const register = async (data: RegisterData) => {
    const newUser = await api.register(data);
    return newUser;
  };

  const updateSystemSettings = async (newSettings: Partial<SystemSettings>) => {
    const updatedSettingsData = await api.updateSystemSettings(newSettings);
    setSystemSettings(prev => ({...prev, ...updatedSettingsData}));
  };

  const subscribeToPush = async () => {
    if (!('serviceWorker' in navigator && 'PushManager' in window)) return;
    
    setIsPushLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
         throw new Error('Notification permission not granted.');
      }
      const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource
      });
      await api.savePushSubscription(subscription);
      setIsPushSubscribed(true);
    } catch (error) {
      console.error('Error subscribing to push notifications', error);
    } finally {
      setIsPushLoading(false);
    }
  };

  const unsubscribeFromPush = async () => {
    if (!('serviceWorker' in navigator && 'PushManager' in window)) return;

    setIsPushLoading(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const subscriptionJson = subscription.toJSON();
        const successful = await subscription.unsubscribe();
        if (successful) {
          await api.deletePushSubscription(subscriptionJson);
          setIsPushSubscribed(false);
        }
      }
    } catch (error) {
      console.error('Error unsubscribing from push notifications', error);
    } finally {
      setIsPushLoading(false);
    }
  };

  return (
    <AuthContext.Provider value={{ 
        user, token, isInitialized, systemSettings, activeCommunes,
        login, logout, register, updateSystemSettings, refetchUser, refetchCommunes,
        isPushSubscribed, isPushLoading, subscribeToPush, unsubscribeFromPush 
    }}>
      {children}
    </AuthContext.Provider>
  );
};