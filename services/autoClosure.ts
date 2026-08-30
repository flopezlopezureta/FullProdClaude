import { api } from './api';

// In-memory guard so re-renders don't re-submit the same closure repeatedly within one
// session — mirrors driver-app/src/services/autoClosure.ts, the native app's equivalent.
let autoClosedToday: string | null = null;

export async function tryAutoCloseRoute(): Promise<{ closed: boolean }> {
  try {
    const today = new Date().toISOString().split('T')[0];
    if (autoClosedToday === today) return { closed: false };

    const summary = await api.getClosureSummary();
    const pending = Number(summary?.pending || 0);
    const total = Number(summary?.total || 0);

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
