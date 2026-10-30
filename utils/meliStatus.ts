/**
 * Estado del envío en Mercado Libre, para mostrarlo en el panel de paquetes (filtro "Estado ML" e insignia de cada fila).
 * Los grupos del filtro DEBEN coincidir con services/meliStatuses.js (GROUPS) del servidor.
 */

// Estados que se pueden elegir en el filtro (se pueden elegir VARIOS a la vez). Sin ninguno elegido se muestran todos.
export type MeliStatusKey = 'ready' | 'shipped' | 'not_delivered' | 'delivered' | 'cancelled' | 'unknown';

// Opciones del selector, en el orden en que se leen: primero lo que hay que mover, después lo que ya terminó.
export const MELI_STATUS_OPTIONS: { value: MeliStatusKey; label: string }[] = [
  { value: 'ready', label: 'LISTO PARA ENVIAR' },
  { value: 'shipped', label: 'EN CAMINO' },
  { value: 'not_delivered', label: 'NO ENTREGADO' },
  { value: 'delivered', label: 'ENTREGADO EN ML' },
  { value: 'cancelled', label: 'CANCELADO EN ML' },
  { value: 'unknown', label: 'SIN CONSULTAR' },
];

// Atajo: lo que Mercado Libre aún no da por entregado ni cancelado y se puede mover (listo para enviar + en camino).
export const MELI_PENDING_PRESET: MeliStatusKey[] = ['ready', 'shipped'];

/** Lo que dice el botón del selector: TODOS, PENDIENTES EN ML (si son exactamente listo + en camino), el nombre del único elegido, o "N ESTADOS". */
export const meliFilterSummary = (value: MeliStatusKey[]): string => {
  const set = new Set(value);
  if (set.size === 0) return 'TODOS';
  if (set.size === MELI_PENDING_PRESET.length && MELI_PENDING_PRESET.every(k => set.has(k))) return 'PENDIENTES EN ML';
  if (set.size === 1) return MELI_STATUS_OPTIONS.find(o => o.value === value[0])?.label || String(value[0]);
  return `${set.size} ESTADOS`;
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  handling: 'En preparación',
  ready_to_ship: 'Listo para enviar',
  shipped: 'En camino',
  delivered: 'Entregado',
  not_delivered: 'No entregado',
  cancelled: 'Cancelado',
  not_found: 'No encontrado en ML',
};

// Subestados que se han visto en los envíos reales (y los habituales de ML). Los que no estén aquí se muestran tal cual, para no ocultar información.
const SUBSTATUS_LABELS: Record<string, string> = {
  ready_to_print: 'Etiqueta por imprimir',
  printed: 'Etiqueta impresa',
  ready_to_pack: 'Por embalar',
  in_packing_list: 'En lista de empaque',
  in_warehouse: 'En bodega',
  ready_for_pickup: 'Listo para retiro',
  buffered: 'En espera',
  manufacturing: 'En fabricación',
  shipment_paid: 'Envío pagado',
  out_for_delivery: 'En reparto',
  buyer_rescheduled: 'Reprogramado por el comprador',
  rescheduled_by_meli: 'Reprogramado por Mercado Libre',
  not_visited: 'No visitado',
  receiver_absent: 'Comprador ausente',
  refused_delivery: 'Entrega rechazada',
  returning_to_warehouse: 'Volviendo a bodega',
  returning_to_sender: 'Devolviéndose al vendedor',
  address_mismatch: 'Dirección distinta',
  pack_splitted: 'Paquete dividido',
  unfulfillable: 'No se puede cumplir',
};

export type MeliStatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

/** Color de la insignia según cómo está el envío en ML: lo que falta entregar llama la atención, lo terminado queda tenue. */
export const meliStatusTone = (status?: string | null): MeliStatusTone => {
  switch (status) {
    case 'delivered': return 'success';
    case 'shipped': return 'warning';
    case 'not_delivered': return 'danger';
    case 'pending': case 'handling': case 'ready_to_ship': return 'info';
    default: return 'neutral'; // cancelled, not_found, desconocidos
  }
};

export const meliStatusLabel = (status?: string | null): string => (status ? (STATUS_LABELS[status] || status) : 'Sin consultar');

export const meliSubstatusLabel = (substatus?: string | null): string | null => (substatus ? (SUBSTATUS_LABELS[substatus] || substatus) : null);

/** "hace 4 min", "hace 2 h"… para la hora de la última consulta a ML. */
export const meliCheckedAgo = (iso?: string | null, now: number = Date.now()): string | null => {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'hace instantes';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
};
