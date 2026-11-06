import { api } from './api';
import { offlineQueue } from './offlineQueue';
import { processOfflineQueue } from './offlineQueueProcessor';

// In-memory guard so re-renders don't re-submit the same closure repeatedly within one
// session — mirrors driver-app/src/services/autoClosure.ts, the native app's equivalent.
let autoClosedToday: string | null = null;

export async function tryAutoCloseRoute(): Promise<{ closed: boolean }> {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (autoClosedToday === today) return { closed: false };

    let summary = await api.getClosureSummary();
    let pending = Number(summary?.pending || 0);
    let total = Number(summary?.total || 0);

    // Al cerrar la jornada: si lo único que falta son entregas guardadas que esperan a Mercado Libre, se intentan en este momento
    // (sin aguardar su turno de reintento silencioso) antes de dar el día por incompleto. Si ML todavía no las confirma, siguen
    // guardadas y se envían solas apenas lo haga — el cierre del día no se fuerza ni se omite.
    if (pending > 0 && offlineQueue.getWaitingMeliPackageIds().length >= pending) {
      const { synced } = await processOfflineQueue({ force: true });
      if (synced.length > 0) {
        summary = await api.getClosureSummary();
        pending = Number(summary?.pending || 0);
        total = Number(summary?.total || 0);
      }
    }

    if (pending === 0 && total > 0) {
      await api.submitClosure({
        ...summary,
        notes: 'Cierre automático: todos los paquetes del día fueron gestionados (entregados o reprogramados).'
      });
      autoClosedToday = today;
      return { closed: true };
    }
    return { closed: false };
  } catch (error) {
    console.error('Error al verificar cierre automático', error);
    return { closed: false };
  }
}
