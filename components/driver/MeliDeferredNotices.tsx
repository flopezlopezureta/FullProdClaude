import React, { useEffect } from 'react';
import { IconClock, IconX } from '../Icon';
import { MESSAGES } from '../../services/meliDeferredClose';

/**
 * Avisos del cierre diferido de Mercado Libre (ver services/meliDeferredClose.ts). Ninguno bloquea la pantalla ni pide nada:
 * solo cuentan que la entrega quedó guardada y que se enviará sola.
 */

/** Recuadro fijo mientras haya entregas guardadas esperando a que Mercado Libre las registre como cerradas. */
export const MeliWaitingBanner: React.FC<{ count: number }> = ({ count }) => {
  if (count <= 0) return null;
  return (
    // Compacto a propósito: se queda fijo arriba mientras el conductor sigue con las demás entregas, así que no puede quitarle media pantalla a la lista.
    <div role="status" aria-live="polite" className="mb-4 mx-4 p-3 bg-sky-50 border-2 border-sky-200 rounded-xl shadow-sm">
      <div className="flex items-start">
        <div className="p-1.5 bg-sky-100 rounded-lg text-sky-600 mr-3 shrink-0">
          <IconClock className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-sky-900">{MESSAGES.bannerTitle}</h3>
          <p className="text-sky-800 text-xs leading-snug mt-0.5">{MESSAGES.banner(count)}</p>
        </div>
      </div>
    </div>
  );
};

export interface MeliNotice {
  /** Cambia en cada aviso nuevo: reinicia el tiempo que se muestra aunque el texto sea el mismo. */
  id: number;
  text: string;
}

/** Aviso que aparece un momento justo después de confirmar una entrega que Mercado Libre aún no registra. Se cierra solo. */
export const MeliSavedToast: React.FC<{ notice: MeliNotice | null; onClose: () => void; durationMs?: number }> = ({ notice, onClose, durationMs = 12000 }) => {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(onClose, durationMs);
    return () => clearTimeout(timer);
  }, [notice?.id]);

  if (!notice) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-3 right-3 bottom-24 z-[60] mx-auto max-w-md flex items-start gap-3 rounded-xl border border-sky-300 bg-sky-50 p-3 text-sky-900 shadow-xl"
    >
      <IconClock className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
      <p className="flex-1 text-sm font-medium leading-snug">{notice.text}</p>
      <button type="button" onClick={onClose} aria-label="Cerrar aviso" className="shrink-0 rounded-full p-1 text-sky-700 hover:bg-sky-100">
        <IconX className="h-4 w-4" />
      </button>
    </div>
  );
};
