import { api, ApiError, isCloseDataRejected, isMeliNotConfirmed, isUnreadableResponse } from './api';
import { offlineQueue, QueuedAction } from './offlineQueue';
import {
  LIGHT_CHECK_BATCH,
  MESSAGES,
  isDue,
  isExpired,
  isFinalRejection,
  isWaitingMeli,
  registerAttempt,
  startWaiting,
} from './meliDeferredClose';

export interface QueueRunResult {
  /** Paquetes cuya acción se envió bien en este ciclo. */
  synced: string[];
  /** Acciones que siguen guardadas (las que esperan a Mercado Libre incluidas). */
  stillPending: number;
  /** De ellas, las entregas que esperan a que Mercado Libre las registre como cerradas. */
  waiting: number;
  /** Cierres que el servidor rechazó para siempre (o que vencieron): salen de la cola y hay que avisar al conductor, porque el paquete sigue abierto en su lista. */
  discarded: { pkgId: string; message: string }[];
}

export interface QueueRunOptions {
  /**
   * Reintenta ya las entregas que esperan a Mercado Libre, sin aguardar su turno (cierre de jornada, aviso de que ML cerró un envío, el conductor vuelve a la app).
   * No repite un intento de hace segundos (ver FORCE_MIN_GAP_MS).
   */
  force?: boolean;
}

/** Nombre del evento de ventana con los cierres que salieron de la cola sin enviarse (detail: { items: [{ pkgId, message }] }). */
export const QUEUE_DISCARDED_EVENT = 'offline-queue-discarded';

/**
 * Drains the offline action queue against the real API, in the order actions were queued.
 * Called on 'online' events and periodically while the tab is open — mirrors driver-app's
 * api.syncPendingActions() (driver-app/src/services/api.ts). Returns the number of actions
 * that were successfully synced, so callers can refresh their local package lists.
 *
 * Entregas que esperan a Mercado Libre: no se reenvían en cada ciclo con todas sus fotos. Cuando les toca (ver meliDeferredClose.ts) se hace una consulta liviana
 * (sin fotos) a /packages/meli-ready y solo las que ML ya muestra como entregadas se envían; las demás espacian su próximo intento.
 *
 * `discarded` lists the closures the server refused for good (receiver name or photos not acceptable) or that waited too long: they leave the queue
 * and the caller must tell the driver, because the package is still open in their list. Quien las recibe por el evento QUEUE_DISCARDED_EVENT las avisa una sola vez,
 * llame a quien llame a este procesador (el ciclo periódico, el cierre de jornada…).
 *
 * Un solo ciclo a la vez: si ya hay uno en marcha, quien llama recibe el mismo resultado (o, con `force`, espera a que termine y hace el suyo).
 */
let running: Promise<QueueRunResult> | null = null;

export function processOfflineQueue(options: QueueRunOptions = {}): Promise<QueueRunResult> {
  if (running) {
    if (!options.force) return running;
    return running.catch(() => undefined).then(() => processOfflineQueue(options));
  }
  const run: Promise<QueueRunResult> = runCycle(!!options.force).finally(() => { if (running === run) running = null; });
  running = run;
  return run;
}

async function runCycle(force: boolean): Promise<QueueRunResult> {
  const synced: string[] = [];
  const discarded: { pkgId: string; message: string }[] = [];
  const result = (): QueueRunResult => ({
    synced,
    discarded,
    stillPending: offlineQueue.getPendingCount(),
    waiting: offlineQueue.getWaitingMeliCount(),
  });
  const announceDiscarded = () => {
    if (discarded.length > 0 && typeof window !== 'undefined') {
      try { window.dispatchEvent(new CustomEvent(QUEUE_DISCARDED_EVENT, { detail: { items: discarded.slice() } })); } catch { /* sin pantalla: nadie a quien avisar */ }
    }
  };

  if (!navigator.onLine) return result();

  try {
    // 1. Las entregas que llevan demasiado esperando a Mercado Libre se sueltan: el paquete sigue abierto en la lista del conductor.
    for (const action of offlineQueue.getPending()) {
      if (isWaitingMeli(action) && isExpired(action, Date.now())) {
        offlineQueue.remove(action.id);
        discarded.push({ pkgId: action.pkgId, message: MESSAGES.expired });
      }
    }

    // 2. Las que esperan a Mercado Libre y ya toca reintentar: una consulta liviana dice cuáles ML ya muestra como entregadas.
    const sendNow = new Set<string>(); // ids de acciones en espera que se reenvían en este ciclo
    const due = offlineQueue.getPending().filter(a => isWaitingMeli(a) && isDue(a, Date.now(), force));
    if (due.length > 0) {
      let notReady: Set<string> | null = new Set<string>();
      try {
        const pkgIds = Array.from(new Set(due.map(a => a.pkgId)));
        for (let i = 0; i < pkgIds.length; i += LIGHT_CHECK_BATCH) {
          const { pending } = await api.checkMeliReady(pkgIds.slice(i, i + LIGHT_CHECK_BATCH));
          (Array.isArray(pending) ? pending : []).forEach(id => notReady!.add(id));
        }
      } catch (e) {
        notReady = null; // no se pudo preguntar
        // El servidor respondió con un error: cuenta como intento (se espacia el siguiente). Sin red no se cuenta: se reintenta en el próximo ciclo.
        if (e instanceof ApiError && e.status) due.forEach(a => offlineQueue.setMeta(a.id, registerAttempt(a.meta, Date.now())));
      }
      for (const action of due) {
        if (notReady === null) {
          if (force) sendNow.add(action.id); // al cerrar la jornada se intenta igual, sin saber si ML ya la muestra
        } else if (notReady.has(action.pkgId)) {
          offlineQueue.setMeta(action.id, registerAttempt(action.meta, Date.now()));
        } else {
          sendNow.add(action.id);
        }
      }
    }

    // 3. Se envían, en el orden en que se guardaron, las acciones pendientes (menos las entregas que siguen esperando su turno).
    // Paquetes cuyo envío rechazó el servidor en este ciclo: sus acciones siguientes se saltan para conservar el orden.
    const rejectedPackages = new Set<string>();
    for (const action of offlineQueue.getPending()) {
      if (rejectedPackages.has(action.pkgId)) continue;
      if (isWaitingMeli(action) && !sendNow.has(action.id)) continue;
      try {
        await syncAction(action);
        offlineQueue.remove(action.id);
        synced.push(action.pkgId);
      } catch (e) {
        if (e instanceof ApiError && e.status) {
          rejectedPackages.add(action.pkgId);
          // El servidor rechazó los DATOS del cierre (nombre de quien recibe inservible o fotos repetidas): volver a mandar lo mismo nunca va a resultar y la cola
          // quedaría reintentándolo para siempre. Se saca de la cola y se avisa; el paquete sigue abierto en la lista del conductor para cerrarlo de nuevo.
          if (isCloseDataRejected(e)) {
            const stillQueued = offlineQueue.getPending().some(a => a.id === action.id); // otro ciclo pudo haberlo sacado ya
            offlineQueue.remove(action.id);
            if (stillQueued) discarded.push({ pkgId: action.pkgId, message: e.message });
            continue;
          }
          // Mercado Libre aún no muestra la entrega como cerrada: queda esperando (si ya esperaba, se espacia el próximo intento). Antes se reenviaba entera,
          // con todas sus fotos, en cada ciclo de 30 s.
          if (action.type === 'DELIVER' && isMeliNotConfirmed(e)) {
            const alreadyWaiting = isWaitingMeli(action);
            offlineQueue.setMeta(action.id, alreadyWaiting ? registerAttempt(action.meta, Date.now()) : startWaiting(Date.now()), !alreadyWaiting);
            continue;
          }
          if (isWaitingMeli(action)) {
            // El servidor respondió OK pero la respuesta no llegó completa: el cierre pudo quedar guardado. Se deja tal cual para el próximo ciclo, donde el servidor
            // lo reconoce como un cierre repetido y responde OK sin reprocesar nada.
            if (isUnreadableResponse(e)) continue;
            if (isFinalRejection(e.status)) {
              // Reenviarla nunca va a resultar (el paquete ya no existe, cambió lo que exige el cierre…): se saca y se avisa.
              const stillQueued = offlineQueue.getPending().some(a => a.id === action.id);
              offlineQueue.remove(action.id);
              if (stillQueued) discarded.push({ pkgId: action.pkgId, message: e.message });
            } else {
              offlineQueue.setMeta(action.id, registerAttempt(action.meta, Date.now()));
            }
            continue;
          }
          // El servidor SÍ respondió, pero rechazó esta acción. Antes cualquier error detenía todo el ciclo, así que un solo paquete bloqueado dejaba sin
          // sincronizar para siempre TODO lo que había detrás en la cola. Se deja esta acción para el próximo ciclo y se sigue con los demás paquetes.
          console.warn('[OfflineQueue] Server rejected a queued action, keeping it for the next cycle.', action.pkgId, e.message);
          continue;
        }
        // Stop at the first network failure (likely connection dropped again mid-sync) rather than
        // burning through retries on every remaining item — the next 'online' event or poll
        // will pick up where this left off.
        console.warn('[OfflineQueue] Sync stopped, will retry later.', e);
        break;
      }
    }
  } finally {
    announceDiscarded();
  }

  return result();
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
