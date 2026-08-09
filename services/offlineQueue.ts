/**
 * Offline action queue for the driver web app. Mirrors driver-app/src/services/OfflineManager.ts'
 * queueAction/getPendingActions/removeActionFromQueue pattern (React Native/AsyncStorage), adapted
 * to localStorage since the web app has no equivalent today. Drivers who lose connection mid-delivery
 * previously had no way to submit at all; this lets the confirm/problem/return actions be saved
 * locally and retried automatically once the connection comes back, instead of just failing.
 */

const QUEUE_KEY = 'offline_action_queue';

export type QueuedActionType = 'DELIVER' | 'PROBLEM' | 'RETURN';

export interface QueuedAction {
  id: string;
  type: QueuedActionType;
  pkgId: string;
  data: any;
  timestamp: number;
}

function readQueue(): QueuedAction[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('[OfflineQueue] Failed to read queue', e);
    return [];
  }
}

function writeQueue(queue: QueuedAction[]) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.error('[OfflineQueue] Failed to persist queue (storage full?)', e);
  }
  // Same-tab components (e.g. the pending-count banner in DriverDashboard.tsx) don't get
  // notified by the browser's native 'storage' event, which only fires in OTHER tabs — this
  // custom event is how any mounted component finds out the queue changed in this tab.
  window.dispatchEvent(new Event('offline-queue-changed'));
}

export const offlineQueue = {
  isOnline: (): boolean => navigator.onLine,

  enqueue: (type: QueuedActionType, pkgId: string, data: any): QueuedAction => {
    const queue = readQueue();
    const action: QueuedAction = {
      id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      pkgId,
      data,
      timestamp: Date.now(),
    };
    queue.push(action);
    writeQueue(queue);
    return action;
  },

  getPending: (): QueuedAction[] => readQueue(),

  getPendingCount: (): number => readQueue().length,

  remove: (actionId: string) => {
    const queue = readQueue().filter(a => a.id !== actionId);
    writeQueue(queue);
  },

  hasPendingForPackage: (pkgId: string): boolean =>
    readQueue().some(a => a.pkgId === pkgId),
};
