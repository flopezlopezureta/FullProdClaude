/**
 * Cierre diferido de Mercado Libre: reglas y textos, sin red ni pantalla (para poder probarlos sueltos).
 *
 * Con «Validación Flex de Mercado Libre» activa, el servidor solo acepta el cierre de una entrega si ML ya la muestra como entregada.
 * Si el conductor confirma unos segundos antes de que ML lo registre, la entrega NO se pierde ni se le pide esperar con la pantalla
 * ocupada: queda guardada en el teléfono (con su nombre y sus fotos), el conductor sigue con las demás entregas y la app la envía
 * sola, en silencio, apenas Mercado Libre la confirma. Al cerrar la jornada, si todavía queda alguna, se intenta en ese momento.
 *
 * Este archivo no importa nada a propósito: la cola (offlineQueue.ts), el procesador (offlineQueueProcessor.ts) y las pantallas
 * lo usan, y la prueba lo carga solo.
 */

/** Datos de control que lleva una acción guardada mientras espera a Mercado Libre. */
export interface QueuedMeta {
  /** El servidor respondió «Mercado Libre aún no confirma»: el cierre queda guardado y se reintenta solo. */
  waitingMeli?: boolean;
  /** Desde cuándo espera (ms desde 1970). */
  since?: number;
  /** Reintentos ya hechos (0 recién guardada). */
  attempts?: number;
  /** Último intento (ms). */
  lastAttemptAt?: number;
  /** No se reintenta antes de esto (ms), salvo al cerrar la jornada o cuando Mercado Libre avisa. */
  nextAttemptAt?: number;
}

export interface WaitableAction {
  type: string;
  pkgId: string;
  timestamp: number;
  meta?: QueuedMeta;
}

/** Espera entre reintentos silenciosos: el primero a los 45 s, luego 1,5 min, 2 min, 3 min y, de ahí en adelante, cada 5 min. */
export const RETRY_STEPS_MS: readonly number[] = [45_000, 90_000, 120_000, 180_000, 300_000];
/** Una entrega que Mercado Libre no confirma en 24 horas se suelta (el paquete sigue abierto en la lista del conductor). */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
/** Aunque se pida reintentar «ya» (cierre de jornada, aviso de ML, volver a la app), no se repite un intento de hace menos de esto. */
export const FORCE_MIN_GAP_MS = 15_000;
/** Paquetes por consulta liviana a /packages/meli-ready (tope del servidor). */
export const LIGHT_CHECK_BATCH = 25;

/** Espera (ms) antes del próximo intento, según los reintentos ya hechos. */
export const retryDelayMs = (attempts: number): number => {
  const i = Math.min(Math.max(0, Math.floor(Number(attempts) || 0)), RETRY_STEPS_MS.length - 1);
  return RETRY_STEPS_MS[i];
};

/** ¿Es una entrega guardada que espera a Mercado Libre? */
export const isWaitingMeli = (action: WaitableAction | null | undefined): boolean =>
  !!action && action.type === 'DELIVER' && !!(action.meta && action.meta.waitingMeli);

/** Datos de control de una entrega que ACABA de quedar esperando (el primer envío ya se intentó). */
export const startWaiting = (now: number): QueuedMeta => ({
  waitingMeli: true,
  since: now,
  attempts: 0,
  lastAttemptAt: now,
  nextAttemptAt: now + retryDelayMs(0),
});

/** Datos de control después de un reintento en el que Mercado Libre (o el servidor) aún no la deja pasar: se espacia el siguiente. */
export const registerAttempt = (meta: QueuedMeta | undefined, now: number): QueuedMeta => {
  const attempts = (meta && Number.isFinite(meta.attempts) ? Number(meta.attempts) : 0) + 1;
  return {
    ...(meta || {}),
    waitingMeli: true,
    since: meta && meta.since != null ? meta.since : now,
    attempts,
    lastAttemptAt: now,
    nextAttemptAt: now + retryDelayMs(attempts),
  };
};

/** ¿Toca reintentar ahora? `force` = cierre de jornada, aviso de ML o vuelta a la app: se salta la espera, pero no repite un intento reciente. */
export const isDue = (action: WaitableAction, now: number, force: boolean): boolean => {
  const meta = action.meta || {};
  if (force) return !(meta.lastAttemptAt != null && now - meta.lastAttemptAt < FORCE_MIN_GAP_MS);
  return now >= (meta.nextAttemptAt != null ? meta.nextAttemptAt : 0);
};

/** ¿Lleva demasiado esperando a Mercado Libre? */
export const isExpired = (action: WaitableAction, now: number): boolean => {
  const since = action.meta && action.meta.since != null ? action.meta.since : action.timestamp;
  return now - since >= GIVE_UP_AFTER_MS;
};

/**
 * Una entrega en espera que el servidor rechaza con uno de estos códigos no se va a arreglar sola reenviándola (el paquete ya no existe,
 * cambió el número de fotos que pide el cierre…): se saca de la cola y se avisa. 403, 429 y los 5xx sí se reintentan.
 */
export const isFinalRejection = (status: number): boolean => [400, 404, 409, 410, 422].includes(status);

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const MESSAGES = {
  /** Aviso que ve el conductor justo al confirmar, cuando Mercado Libre aún no registra el cierre. */
  saved: (saved: number, closedNow = 0): string => {
    if (closedNow > 0) {
      return `${closedNow} ${plural(closedNow, 'entrega cerrada', 'entregas cerradas')}. ${saved} ${plural(saved, 'quedó guardada', 'quedaron guardadas')}: Mercado Libre aún no registra ${plural(saved, 'su cierre', 'sus cierres')}; ${plural(saved, 'se enviará sola', 'se enviarán solas')} en unos minutos, apenas lo confirme. Puedes seguir con las demás entregas.`;
    }
    return `${plural(saved, 'Entrega guardada.', `${saved} entregas guardadas.`)} Mercado Libre aún no registra el cierre: ${plural(saved, 'se enviará sola', 'se enviarán solas')} en unos minutos, apenas lo confirme. Puedes seguir con las demás entregas.`;
  },
  bannerTitle: 'Esperando a Mercado Libre',
  /** Texto fijo del recuadro que queda en la pantalla mientras haya entregas guardadas. */
  banner: (n: number): string =>
    `Tienes ${n} ${plural(n, 'entrega guardada', 'entregas guardadas')} con sus fotos. ` +
    `${plural(n, 'Se enviará sola', 'Se enviarán solas')} apenas Mercado Libre ${plural(n, 'la confirme', 'las confirme')}; puedes seguir con las demás. ` +
    `Si aún no ${plural(n, 'la cerraste', 'las cerraste')} en Mercado Libre Flex, ${plural(n, 'ciérrala', 'ciérralas')} ahora.`,
  alreadySaved: 'Esta entrega ya está guardada: se enviará sola apenas Mercado Libre la confirme. Puedes seguir con las demás.',
  expired: 'Mercado Libre no confirmó el cierre en 24 horas, así que no se pudo enviar. Ciérralo primero en la app Mercado Libre Flex.',
  /** Si el teléfono no tiene espacio para guardar la entrega: se deja la pantalla abierta, con sus fotos, para reintentar. */
  storageFull: 'Mercado Libre aún no registra el cierre de esta entrega y el teléfono no tiene espacio para guardarla. Libera espacio (borra fotos o apps que no uses) y vuelve a presionar «Confirmar Entrega» en unos minutos.',
  discardedTitle: (n: number): string => `No se pudo enviar ${plural(n, 'esta entrega guardada', 'estas entregas guardadas')}:`,
  discardedFooter: 'El paquete sigue en tu lista: ciérralo de nuevo con los datos correctos.',
};
