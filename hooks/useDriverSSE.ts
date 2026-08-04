import { useEffect, useRef } from 'react';

/**
 * Listens for real-time "delivery closed in Mercado Libre" signals for the
 * logged-in driver and triggers an immediate refetch via onDeliveryClosed.
 *
 * This is purely a latency optimization on top of the existing 15s polling
 * loop in DriverDashboard: if the stream never connects, errors, or drops,
 * nothing here throws or blocks the UI - polling keeps working exactly as
 * before. The hook doesn't decide what to show; it only asks the caller to
 * refetch sooner.
 */
export function useDriverSSE(enabled: boolean, onDeliveryClosed: () => void) {
  const callbackRef = useRef(onDeliveryClosed);
  callbackRef.current = onDeliveryClosed;

  useEffect(() => {
    if (!enabled) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    let es: EventSource | null = null;
    try {
      es = new EventSource(`/api/drivers/events?token=${encodeURIComponent(token)}`);

      es.addEventListener('MELI_DELIVERY_CLOSED', () => {
        try {
          callbackRef.current();
        } catch (err) {
          console.error('[useDriverSSE] refetch callback failed:', err);
        }
      });

      es.onerror = () => {
        // EventSource retries automatically on its own; this just prevents
        // an unhandled error from surfacing anywhere.
      };
    } catch (err) {
      console.error('[useDriverSSE] Failed to open SSE connection:', err);
    }

    return () => {
      es?.close();
    };
  }, [enabled]);
}
