import { api, ApiError } from './api';
import { offlineQueue, QueuedAction } from './offlineQueue';

/**
 * Drains the offline action queue against the real API, in the order actions were queued.
 * Called on 'online' events and periodically while the tab is open — mirrors driver-app's
 * api.syncPendingActions() (driver-app/src/services/api.ts). Returns the number of actions
 * that were successfully synced, so callers can refresh their local package lists.
 */
export async function processOfflineQueue(): Promise<{ synced: string[]; stillPending: number }> {
  if (!navigator.onLine) return { synced: [], stillPending: offlineQueue.getPendingCount() };

  const pending = offlineQueue.getPending();
  const synced: string[] = [];
  // Paquetes cuyo envío rechazó el servidor en este ciclo: sus acciones siguientes se saltan para conservar el orden.
  const rejectedPackages = new Set<string>();

  for (const action of pending) {
    if (rejectedPackages.has(action.pkgId)) continue;
    try {
      await syncAction(action);
      offlineQueue.remove(action.id);
      synced.push(action.pkgId);
    } catch (e) {
      if (e instanceof ApiError && e.status) {
        // El servidor SÍ respondió, pero rechazó esta acción (p. ej. Mercado Libre aún no confirma la entrega). Antes cualquier
        // error detenía todo el ciclo, así que un solo paquete bloqueado dejaba sin sincronizar para siempre TODO lo que había
        // detrás en la cola. Se deja esta acción para el próximo ciclo y se sigue con los demás paquetes.
        console.warn('[OfflineQueue] Server rejected a queued action, keeping it for the next cycle.', action.pkgId, e.message);
        rejectedPackages.add(action.pkgId);
        continue;
      }
      // Stop at the first network failure (likely connection dropped again mid-sync) rather than
      // burning through retries on every remaining item — the next 'online' event or poll
      // will pick up where this left off.
      console.warn('[OfflineQueue] Sync stopped, will retry later.', e);
      break;
    }
  }

  return { synced, stillPending: offlineQueue.getPendingCount() };
}

async function syncAction(action: QueuedAction) {
  switch (action.type) {
    case 'DELIVER':
      await api.confirmDelivery(action.pkgId, action.data);
      break;
    case 'PROBLEM':
      await api.markPackageAsProblem(action.pkgId, action.data.reason, action.data.photos);
      break;
    case 'RETURN':
      await api.confirmReturn(action.pkgId, action.data);
      break;
  }
}
