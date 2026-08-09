import { api } from './api';
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

  for (const action of pending) {
    try {
      await syncAction(action);
      offlineQueue.remove(action.id);
      synced.push(action.pkgId);
    } catch (e) {
      // Stop at the first failure (likely connection dropped again mid-sync) rather than
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
