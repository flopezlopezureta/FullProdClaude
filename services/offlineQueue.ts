/**
 * Offline action queue for the driver web app. Mirrors driver-app/src/services/OfflineManager.ts'
 * queueAction/getPendingActions/removeActionFromQueue pattern (React Native/AsyncStorage), adapted
 * to localStorage since the web app has no equivalent today. Drivers who lose connection mid-delivery
 * previously had no way to submit at all; this lets the confirm/problem/return actions be saved
 * locally and retried automatically once the connection comes back, instead of just failing.
 *
 * También guarda las entregas que Mercado Libre aún no registra como cerradas (acción DELIVER con `meta.waitingMeli`): se reintentan
 * solas en segundo plano (ver meliDeferredClose.ts y offlineQueueProcessor.ts).
 */

import type { QueuedMeta } from './meliDeferredClose';

const QUEUE_KEY = 'offline_action_queue';

export type QueuedActionType = 'DELIVER' | 'PROBLEM' | 'RETURN';

export interface QueuedAction {
  id: string;
  type: QueuedActionType;
  pkgId: string;
  data: any;
  timestamp: number;
  /** Solo en las entregas que esperan a Mercado Libre (ver meliDeferredClose.ts). Las demás acciones no lo llevan. */
  meta?: QueuedMeta;
}

const waiting = (a: QueuedAction): boolean => a.type === 'DELIVER' && !!(a.meta && a.meta.waitingMeli);

function readQueue(): QueuedAction[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('[OfflineQueue] Failed to read queue', e);
    return [];
  }
}

function writeQueue(queue: QueuedAction[], notify = true) {
  // Deliberately NOT try/catch-swallowed here anymore. It used to be: a quota failure
  // (a delivery with 1-2+ base64-encoded photos can be a few MB, and localStorage's total
  // per-origin limit — usually 5-10MB — is shared with everything else the app caches) was
  // logged to the console and otherwise ignored, so callers had no way to know the save
  // hadn't actually happened. enqueue() still returned normally, the delivery modal closed
  // as if it succeeded, and its own draft (the only other local copy of the photos) got
  // cleared right after — silently losing the entire delivery, photos included, with no
  // error ever shown to the driver. Letting this throw lets callers catch it and keep the
  // draft intact instead.
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  // Same-tab components (e.g. the pending-count banner in DriverDashboard.tsx) don't get
  // notified by the browser's native 'storage' event, which only fires in OTHER tabs — this
  // custom event is how any mounted component finds out the queue changed in this tab.
  // `notify = false` es para ajustes que no cambian nada visible (contadores de reintento): las pantallas no tienen por qué volver a pedir sus datos.
  if (notify) window.dispatchEvent(new Event('offline-queue-changed'));
}

export const offlineQueue = {
  isOnline: (): boolean => navigator.onLine,

  // Throws if the write fails (see writeQueue) — callers must handle this explicitly rather
  // than assuming the action was safely queued.
  // Una entrega que queda esperando a Mercado Libre (`meta.waitingMeli`) reemplaza a cualquier otra entrega guardada del mismo paquete:
  // si el conductor vuelve a confirmar mientras tanto, no se duplica.
  enqueue: (type: QueuedActionType, pkgId: string, data: any, meta?: QueuedMeta): QueuedAction => {
    let queue = readQueue();
    if (type === 'DELIVER' && meta && meta.waitingMeli) {
      queue = queue.filter(a => !(a.type === 'DELIVER' && a.pkgId === pkgId));
    }
    const action: QueuedAction = {
      id: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      pkgId,
      data,
      timestamp: Date.now(),
      ...(meta ? { meta } : {}),
    };
    queue.push(action);
    writeQueue(queue);
    return action;
  },

  getPending: (): QueuedAction[] => readQueue(),

  /** Todas las acciones guardadas (las que esperan a Mercado Libre incluidas). */
  getPendingCount: (): number => readQueue().length,

  /** Las guardadas por falta de conexión (sin las que solo esperan a Mercado Libre): lo que cuenta el aviso «Sin conexión». */
  getOfflineCount: (): number => readQueue().filter(a => !waiting(a)).length,

  /** Entregas guardadas que esperan a que Mercado Libre las registre como cerradas. */
  getWaitingMeli: (): QueuedAction[] => readQueue().filter(waiting),

  getWaitingMeliCount: (): number => readQueue().filter(waiting).length,

  /** Paquetes (sin repetir) con una entrega guardada esperando a Mercado Libre. */
  getWaitingMeliPackageIds: (): string[] => Array.from(new Set(readQueue().filter(waiting).map(a => a.pkgId))),

  /** Paquetes (sin repetir) con cualquier entrega guardada, por falta de conexión o por esperar a Mercado Libre. */
  getQueuedDeliveryPackageIds: (): string[] => Array.from(new Set(readQueue().filter(a => a.type === 'DELIVER').map(a => a.pkgId))),

  remove: (actionId: string) => {
    const queue = readQueue().filter(a => a.id !== actionId);
    writeQueue(queue);
  },

  /** Saca las acciones de un paquete (opcionalmente solo de un tipo): p. ej. si el conductor reporta un problema, la entrega que esperaba ya no corresponde. */
  removeForPackage: (pkgId: string, type?: QueuedActionType) => {
    const queue = readQueue();
    const kept = queue.filter(a => !(a.pkgId === pkgId && (!type || a.type === type)));
    if (kept.length !== queue.length) writeQueue(kept);
  },

  /**
   * Cambia solo los datos de control de una acción (espera de Mercado Libre, reintentos). `notify` avisa a las pantallas (úsalo cuando cambia lo que se
   * ve: una entrega pasa a «esperando a Mercado Libre»); sin él es un ajuste silencioso. Es de mejor esfuerzo: si no se puede escribir (almacenamiento lleno)
   * no se interrumpe nada, solo se reintenta en el próximo ciclo.
   */
  setMeta: (actionId: string, meta: QueuedMeta | undefined, notify = false) => {
    try {
      const queue = readQueue();
      const i = queue.findIndex(a => a.id === actionId);
      if (i < 0) return;
      queue[i] = { ...queue[i], meta };
      writeQueue(queue, notify);
    } catch (e) {
      console.warn('[OfflineQueue] No se pudo actualizar el estado de una acción guardada.', e);
    }
  },

  hasPendingForPackage: (pkgId: string): boolean =>
    readQueue().some(a => a.pkgId === pkgId),
};
