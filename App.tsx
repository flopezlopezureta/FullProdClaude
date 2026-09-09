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
    // Reverted 2026-08-13: removing this (to let the offline-shell Service Worker actually stay
    // registered) caused a worse regression on fresh/cleared installs inside the Android WebView
    // wrapper specifically — sometimes nothing rendered at all behind the permission dialogs,
    // reproducible even with normal connectivity and a fully cleared app. Restored to the known-
    // stable behavior (always loads, just doesn't support a zero-connectivity cold start) until
    // the SW/WebView interaction can be diagnosed properly on a real device, not blind.
    // Captured BEFORE unregistering: tells us whether THIS specific page load is currently being
    // intercepted by an already-active Service Worker instance. unregister() only stops a SW from
    // controlling FUTURE navigations — a page it already controls keeps having its fetches (API
    // calls included, not just the app shell) routed through it until that page is fully reloaded.
    const wasControlledBySW = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

    const unregisterSW = ('serviceWorker' in navigator)
      ? navigator.serviceWorker.getRegistrations()
          .then(registrations => Promise.all(registrations.map(r => r.unregister())))
          .then(() => console.log('Service Worker unregistered successfully.'))
          .catch(err => console.log('Service Worker unregistration failed: ', err))
      : Promise.resolve();

    // Unregistering the SW does NOT clear what it already precached — those responses stay in
    // Cache Storage indefinitely and keep getting served on normal reloads, which is exactly the
    // "shows an old version, only a full browser cache clear fixes it, then it goes stale again
    // on the next reload" symptom. Purge every Workbox cache explicitly so a reload always hits
    // the network for a genuinely fresh index.html/bundle.
    const purgeCaches = ('caches' in window)
      ? caches.keys()
          .then(keys => Promise.all(keys.filter(k => k.startsWith('workbox-')).map(k => caches.delete(k))))
          .catch(err => console.log('Cache cleanup failed: ', err))
      : Promise.resolve();

    // Real bug found 2026-09-09: a tab left open across days kept sending API calls (e.g. Centro
    // de Control's date-filtered fetch) through the stale SW long after this cleanup ran and
    // logged success — because THIS page was already SW-controlled, cleanup alone doesn't help
    // until a fresh, uncontrolled load happens. Force that one reload automatically instead of
    // requiring the user to know to close and reopen the tab. Guarded via sessionStorage so a
    // genuine failure elsewhere can't turn this into a reload loop.
    Promise.all([unregisterSW, purgeCaches]).then(() => {
      if (wasControlledBySW && !sessionStorage.getItem('sw_cleanup_reloaded')) {
        sessionStorage.setItem('sw_cleanup_reloaded', 'true');
        window.location.reload();
      }
    });
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