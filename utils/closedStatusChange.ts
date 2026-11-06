/**
 * Cambio de estado de un paquete CERRADO (entregado, devuelto o cancelado), lado pantalla. Es la MISMA regla que usa el servidor (services/closedStatusChange.js): el servidor decide,
 * esto solo evita ofrecer lo que va a rechazar y escribe los textos antes de enviar. tests/closedStatusChange.test.js comprueba que ambos dan lo mismo.
 * Sin importaciones a propósito: así la prueba puede cargar este archivo suelto.
 */

export const CLOSED_STATUSES: readonly string[] = ['ENTREGADO', 'DEVUELTO', 'CANCELADO'];
export const TARGET_STATUSES: readonly string[] = ['RETIRADO', 'PROBLEMA', 'ENTREGADO', 'DEVUELTO', 'CANCELADO'];
export const REOPEN_STATUS = 'RETIRADO';
export const STATUS_LABELS: Readonly<Record<string, string>> = {
    RETIRADO: 'Disponible en bodega', PROBLEMA: 'Problema', ENTREGADO: 'Entregado', DEVUELTO: 'Devuelto', CANCELADO: 'Cancelado',
};
export const MIN_REASON_LETTERS = 5;
export const MAX_REASON_LENGTH = 300;

/** Una frase por estado elegible, para que quien autoriza sepa qué va a pasar. */
export const TARGET_HINTS: Readonly<Record<string, string>> = {
    RETIRADO: 'Reabre el paquete: queda en bodega, sin conductor, para asignarlo con «Asignar» o el despacho.',
    PROBLEMA: 'Lo deja como entrega con problema (conserva el conductor), para reasignarlo o devolverlo.',
    ENTREGADO: 'Lo da por entregado (conserva el conductor y los datos de la entrega que ya tenga).',
    DEVUELTO: 'Lo da por devuelto al remitente (conserva el conductor).',
    CANCELADO: 'Lo da por cancelado (conserva el conductor); solo se puede devolver a la bodega.',
};

export const isClosedStatus = (status: unknown): boolean => CLOSED_STATUSES.includes(String(status == null ? '' : status));
/** Estados a los que se puede pasar desde `status` (vacío si el paquete no está cerrado). */
export const allowedTargets = (status: unknown): string[] => (isClosedStatus(status) ? TARGET_STATUSES.filter((s) => s !== status) : []);
export const statusLabel = (status: string): string => STATUS_LABELS[status] || String(status || '');

/** Lo que impide cambiar este paquete aunque esté cerrado (texto para mostrar) o null. */
export function changeBlocker(pkg: { source?: string | null; billed?: boolean | null } | null | undefined): string | null {
    if (pkg && pkg.source === 'FALABELLA_DIRECTO') return 'Los paquetes de Falabella Directo informan cada estado a Falabella y no pueden quedar sin conductor: su estado no se puede cambiar desde aquí.';
    if (pkg && pkg.billed === true) return 'Este paquete ya está facturado, así que su estado no se puede cambiar sin rehacer la facturación.';
    return null;
}

/** Motivo del cambio: devuelve el texto de lo que falta o null si sirve. Misma regla que el servidor (letras de verdad y largo máximo). */
export function reasonProblem(reason: string): string | null {
    const text = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < MIN_REASON_LETTERS) return `Escribe el motivo del cambio (al menos ${MIN_REASON_LETTERS} letras): queda registrado en el historial del paquete.`;
    if (text.length > MAX_REASON_LENGTH) return `El motivo es demasiado largo (máximo ${MAX_REASON_LENGTH} caracteres).`;
    return null;
}
