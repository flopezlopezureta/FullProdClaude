/**
 * Cambio de estado de un paquete CERRADO (entregado, devuelto o cancelado).
 *
 * Un paquete cerrado es el resultado final de la entrega: no se edita, no se reasigna y la bodega no lo vuelve a despachar. A veces el cierre está mal hecho (un conductor
 * lo canceló por error, se marcó entregado sin entregarse…). Esa corrección la hace solo un ADMINISTRADOR, reingresando SU PROPIA clave en ese momento (igual que «Ver
 * contraseña»), con un motivo escrito. Queda en el historial del paquete y en la auditoría, y NO se avisa al comprador ni a las integraciones: es una corrección interna.
 *
 * Qué estados se pueden elegir desde un cerrado:
 *   RETIRADO   «disponible en bodega»: reabre el paquete sin conductor, igual que «desasignar»; después se asigna con las herramientas de siempre.
 *   PROBLEMA, ENTREGADO, DEVUELTO, CANCELADO: corrige un cierre por otro (conserva el conductor).
 * No se ofrece ASIGNADO / EN_TRANSITO a propósito: eso exige elegir conductor y avisar al comprador, y ya lo hacen «Asignar» y el despacho.
 *
 * No se permite (se explica por qué): paquetes de Falabella Directo (cada estado se informa a Falabella y no pueden quedar sin conductor) y paquetes ya facturados.
 *
 * Sin base de datos ni dependencias: solo reglas y textos, para poder probarlas sueltas.
 */

const CLOSED_STATUSES = Object.freeze(['ENTREGADO', 'DEVUELTO', 'CANCELADO']);
const TARGET_STATUSES = Object.freeze(['RETIRADO', 'PROBLEMA', 'ENTREGADO', 'DEVUELTO', 'CANCELADO']);
const REOPEN_STATUS = 'RETIRADO';
const STATUS_LABELS = Object.freeze({
    RETIRADO: 'Disponible en bodega', PROBLEMA: 'Problema', ENTREGADO: 'Entregado', DEVUELTO: 'Devuelto', CANCELADO: 'Cancelado',
});
const MIN_REASON_LETTERS = 5;
const MAX_REASON_LENGTH = 300;

const CODES = Object.freeze({
    NOT_ADMIN: 'NOT_ADMIN', BAD_REQUEST: 'BAD_REQUEST', PASSWORD_REQUIRED: 'PASSWORD_REQUIRED', BAD_PASSWORD: 'BAD_PASSWORD', LOCKED: 'LOCKED',
    INACTIVE_ADMIN: 'INACTIVE_ADMIN', NOT_FOUND: 'NOT_FOUND', NOT_CLOSED: 'NOT_CLOSED', TARGET_NOT_ALLOWED: 'TARGET_NOT_ALLOWED', EXTERNAL_FLOW: 'EXTERNAL_FLOW',
    BILLED: 'BILLED', CHANGED: 'CHANGED', CLOSED_REQUIRES_AUTH: 'CLOSED_REQUIRES_AUTH',
});

const isClosedStatus = (status) => CLOSED_STATUSES.includes(String(status == null ? '' : status));
/** Estados a los que se puede pasar desde `status` (vacío si el paquete no está cerrado). */
const allowedTargets = (status) => (isClosedStatus(status) ? TARGET_STATUSES.filter((s) => s !== status) : []);
const statusLabel = (status) => STATUS_LABELS[status] || String(status || '');

const MESSAGES = {
    notAdmin: 'Solo un administrador puede cambiar el estado de un paquete cerrado.',
    needTarget: 'Elige el nuevo estado del paquete.',
    reasonShort: `Escribe el motivo del cambio (al menos ${MIN_REASON_LETTERS} letras): queda registrado en el historial del paquete.`,
    reasonLong: `El motivo es demasiado largo (máximo ${MAX_REASON_LENGTH} caracteres).`,
    needPassword: 'Ingresa tu contraseña de administrador para autorizar el cambio.',
    badPassword: 'Contraseña de administrador incorrecta.',
    locked: (minutes) => `Demasiados intentos con la contraseña incorrecta. Espera ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'} e inténtalo de nuevo.`,
    inactiveAdmin: 'Tu perfil de administrador no está activo, así que no puedes autorizar este cambio.',
    notFound: 'Paquete no encontrado.',
    notClosed: (status) => `Este paquete no está cerrado (está ${statusLabel(status).toLowerCase() || status}): para cambiarlo usa Editar o Asignar.`,
    targetNotAllowed: 'Ese estado no se puede elegir para un paquete cerrado.',
    externalFlow: 'Los paquetes de Falabella Directo informan cada estado a Falabella y no pueden quedar sin conductor: su estado no se puede cambiar desde aquí.',
    billed: 'Este paquete ya está facturado, así que su estado no se puede cambiar sin rehacer la facturación.',
    changed: 'El paquete cambió de estado mientras se procesaba. Actualiza la lista e inténtalo de nuevo.',
    // La ruta genérica de edición no cambia el estado de un paquete cerrado: eso pasa solo por la vía autorizada.
    closedNeedsAuth: 'Este paquete está cerrado. Para cambiar su estado usa «Cambiar estado» con tu contraseña de administrador.',
};

/** Motivo del cambio: obligatorio, con letras de verdad y no excesivo. Devuelve { ok, reason } (reason ya limpio) o { ok: false, code, message }. */
function checkReason(reason) {
    const text = String(reason == null ? '' : reason).replace(/\s+/g, ' ').trim();
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < MIN_REASON_LETTERS) return { ok: false, code: CODES.BAD_REQUEST, message: MESSAGES.reasonShort };
    if (text.length > MAX_REASON_LENGTH) return { ok: false, code: CODES.BAD_REQUEST, message: MESSAGES.reasonLong };
    return { ok: true, reason: text };
}

/** Lo que impide cambiar este paquete aunque esté cerrado (o null). Lo usa también la pantalla para avisar antes de pedir la clave. */
function changeBlocker(pkg) {
    if (pkg && pkg.source === 'FALABELLA_DIRECTO') return { code: CODES.EXTERNAL_FLOW, message: MESSAGES.externalFlow };
    if (pkg && pkg.billed === true) return { code: CODES.BILLED, message: MESSAGES.billed };
    return null;
}

/** ¿Se puede pasar `pkg` (estado actual) a `target`? → { ok: true } o { ok: false, httpStatus, code, message }. */
function checkChange(pkg, target) {
    if (!pkg || !isClosedStatus(pkg.status)) return { ok: false, httpStatus: 400, code: CODES.NOT_CLOSED, message: MESSAGES.notClosed(pkg && pkg.status) };
    if (!allowedTargets(pkg.status).includes(target)) return { ok: false, httpStatus: 400, code: CODES.TARGET_NOT_ALLOWED, message: MESSAGES.targetNotAllowed };
    const blocker = changeBlocker(pkg);
    if (blocker) return { ok: false, httpStatus: 409, code: blocker.code, message: blocker.message };
    return { ok: true };
}

/** Qué cambia en el paquete: el estado y, solo al reabrirlo (disponible en bodega), también se quita el conductor y la fecha de asignación. */
const updateFor = (target) => (target === REOPEN_STATUS ? { status: target, clearsDriver: true } : { status: target, clearsDriver: false });

/** Texto del evento del historial (interno: el seguimiento público muestra solo una frase fija por estado, nunca este detalle). */
function eventDetails({ from, to, adminName, reason, clearedDriverName }) {
    const parts = [`Cambio de estado autorizado por ${adminName || 'un administrador'} con su clave de administrador: ${statusLabel(from)} → ${statusLabel(to)}. Motivo: ${reason}.`];
    if (clearedDriverName) parts.push(`Se quitó el conductor (${clearedDriverName}).`);
    if (to === REOPEN_STATUS) parts.push('Queda disponible en bodega para asignarlo.');
    return parts.join(' ');
}

/**
 * Límite de intentos con clave incorrecta, por administrador: tras `max` fallos dentro de la ventana se bloquea hasta que la ventana (contada desde el primer fallo) termina.
 * En memoria (un solo servidor) y con reloj inyectable para poder probarlo.
 */
function createAttemptLimiter({ max = 5, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    const hits = new Map();
    return {
        check(key) {
            const h = hits.get(key);
            if (!h) return { locked: false };
            if (now() - h.first >= windowMs) { hits.delete(key); return { locked: false }; }
            return h.count >= max ? { locked: true, retryAfterSec: Math.max(1, Math.ceil((h.first + windowMs - now()) / 1000)) } : { locked: false };
        },
        fail(key) {
            const t = now(); const h = hits.get(key);
            if (!h || t - h.first >= windowMs) hits.set(key, { count: 1, first: t }); else h.count += 1;
        },
        reset(key) { hits.delete(key); },
        clear() { hits.clear(); },
    };
}

module.exports = {
    CLOSED_STATUSES, TARGET_STATUSES, REOPEN_STATUS, STATUS_LABELS, MIN_REASON_LETTERS, MAX_REASON_LENGTH, CODES, MESSAGES,
    isClosedStatus, allowedTargets, statusLabel, checkReason, changeBlocker, checkChange, updateFor, eventDetails, createAttemptLimiter,
};
