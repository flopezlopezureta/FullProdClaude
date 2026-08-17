import React, { useContext, useEffect } from 'react';
import { AuthContext, AuthProvider } from './contexts/AuthContext';
import AuthPage from './pages/AuthPage';
import TrackingPage from './pages/TrackingPage';
import DashboardLayout from './components/layout/DashboardLayout';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import ErrorBoundary from './components/ErrorBoundary';
import LandingPage from './pages/LandingPage';

const AppContent: React.FC = () => {
  const auth = useContext(AuthContext);

  useEffect(() => {
    // Aggressively unregister any service workers to prevent caching issues.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(function(registrations) {
        for(let registration of registrations) {
          registration.unregister()
            .then(unregistered => {
              if (unregistered) console.log('Service Worker unregistered successfully.');
            });
        }
      }).catch(function(err) {
        console.log('Service Worker unregistration failed: ', err);
      });
    }
    // Unregistering the SW does NOT clear what it already precached — those responses stay in
    // Cache Storage indefinitely and keep getting served on normal reloads, which is exactly the
    // "shows an old version, only a full browser cache clear fixes it, then it goes stale again
    // on the next reload" symptom. Purge every Workbox cache explicitly so a reload always hits
    // the network for a genuinely fresh index.html/bundle.
    if ('caches' in window) {
      caches.keys().then(keys => {
        keys.forEach(key => { if (key.startsWith('workbox-')) caches.delete(key); });
      }).catch(err => console.log('Cache cleanup failed: ', err));
    }
  }, []); // Run only once on component mount

  useEffect(() => {
    if (auth?.systemSettings.companyName) {
      document.title = `${auth.systemSettings.companyName} - Sistema de Seguimiento`;
    }
  }, [auth?.systemSettings.companyName]);

  if (!auth || !auth.isInitialized) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
          <div className="text-xl font-bold text-slate-400 tracking-tight uppercase">Full Envios</div>
        </div>
      </div>
    );
  }

  const isTrackingRoute = window.location.pathname.startsWith('/track');
  if (isTrackingRoute) {
    return <TrackingPage />;
  }

  if (!auth.user) {
    return <AuthPage />;
  }

  const isDev = auth.systemSettings.appEnv === 'development';

  return (
    <>
      {isDev && (
        <div className="bg-yellow-500 text-white text-center py-1 text-xs font-bold uppercase tracking-widest sticky top-0 z-[9999] shadow-sm animate-pulse">
          ⚠️ Ambiente de Desarrollo - Las pruebas no afectan a Producción ⚠️
        </div>
      )}
      <DashboardLayout />
    </>
  );
};

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ThemeProvider>
          <ToastProvider>
            <AppContent />
          </ToastProvider>
        </ThemeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
};

export default App;