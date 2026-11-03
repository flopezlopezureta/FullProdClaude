/**
 * Perfiles repetidos: detecta si el perfil que se va a crear (o al que se le cambia el nombre, el rol, el correo o el RUT) ya existe.
 *
 * Una misma persona puede tener un perfil por rol a propósito (por ejemplo administrador y conductor): eso solo se AVISA y quien crea decide.
 * Lo que se BLOQUEA es lo que llena las listas de repetidos: el mismo nombre en el mismo rol (da igual mayúsculas, tildes o espacios), el mismo RUT personal
 * en el mismo rol del personal y un correo que ya usa otro perfil. Los clientes sí comparten RUT (varias sucursales del mismo dueño), así que para ellos el RUT no cuenta.
 * Un perfil ELIMINADO no estorba, pero se avisa que existe para que se pueda reintegrar en vez de crear otro.
 *
 * Sin base de datos ni dependencias: solo reglas, para poder probarlas sueltas.
 */

// Roles equivalentes que existen en datos antiguos.
const ROLE_ALIASES = { ADMINISTRADOR: 'ADMIN', ADMIN_SISTEMAS: 'ADMIN', CHOFER: 'DRIVER', CONDUCTOR: 'DRIVER', CLIENTE: 'CLIENT' };
const ROLE_LABELS = {
    ADMIN: 'Administrador', DRIVER: 'Conductor', CLIENT: 'Cliente', AUXILIAR: 'Auxiliar', RETIROS: 'Retiros',
    FACTURACION: 'Facturación', OPERADOR_SISTEMAS: 'Operador de sistemas',
};
const STATUS_LABELS = { APROBADO: 'aprobado', PENDIENTE: 'pendiente de aprobación', DESHABILITADO: 'deshabilitado', ELIMINADO: 'eliminado' };

const canonicalRole = (role) => { const r = String(role == null ? '' : role).trim().toUpperCase(); return ROLE_ALIASES[r] || r; };
// Nombre comparable entre perfiles: sin tildes, sin mayúsculas y con los espacios normalizados.
const personKey = (name) => String(name == null ? '' : name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const rutKey = (rut) => String(rut == null ? '' : rut).replace(/[^0-9kK]/g, '').toLowerCase();
const emailKey = (email) => String(email == null ? '' : email).trim().toLowerCase();
const isDeleted = (status) => String(status == null ? '' : status).trim().toUpperCase() === 'ELIMINADO';
const isStaffRole = (role) => canonicalRole(role) !== 'CLIENT';
const roleLabel = (role) => ROLE_LABELS[canonicalRole(role)] || String(role || 'sin rol');
const statusLabel = (status) => STATUS_LABELS[String(status || '').trim().toUpperCase()] || String(status || 'sin estado').toLowerCase();
// El RUT personal del personal está en personalRut; `rut` es el del cliente (o el que algunos perfiles antiguos traen).
const staffRutKey = (u) => rutKey(u && (u.personalRut || u.rut));

const profileOf = (u) => ({ id: u.id, name: u.name, role: u.role, status: u.status });

/**
 * @param {{ name?: string, role?: string, email?: string, personalRut?: string, rut?: string }} candidate el perfil que se quiere crear o dejar así
 * @param {Array<{ id: string, name?: string, role?: string, status?: string, email?: string, personalRut?: string, rut?: string }>} existing los perfiles que ya hay
 * @param {{ excludeId?: string | null }} [opts] excludeId: el propio perfil cuando se está editando
 * @returns {{ blocking: object[], warnings: object[] }} cada conflicto: { type, profile: { id, name, role, status }, matchedBy: string[], message }
 */
function findProfileConflicts(candidate, existing, { excludeId = null } = {}) {
    const blocking = [];
    const warnings = [];
    const role = canonicalRole(candidate && candidate.role);
    const nameKey = personKey(candidate && candidate.name);
    const email = emailKey(candidate && candidate.email);
    const rut = isStaffRole(role) ? staffRutKey(candidate) : '';
    const add = (list, type, u, matchedBy) => { const c = { type, profile: profileOf(u), matchedBy }; c.message = describeConflict(c); list.push(c); };

    for (const u of Array.isArray(existing) ? existing : []) {
        if (!u || (excludeId && u.id === excludeId)) continue;
        const otherRole = canonicalRole(u.role);
        const sameName = nameKey !== '' && personKey(u.name) === nameKey;
        const sameRut = rut !== '' && isStaffRole(otherRole) && staffRutKey(u) === rut;
        const matchedBy = [sameName && 'nombre', sameRut && 'RUT'].filter(Boolean);

        // El correo es único en toda la tabla (incluidos los eliminados): se avisa antes de que lo rechace la base.
        if (email !== '' && emailKey(u.email) === email) { add(blocking, 'EMAIL', u, ['correo']); continue; }
        if (matchedBy.length === 0) continue;

        if (isDeleted(u.status)) {
            if (otherRole === role) add(warnings, 'DELETED_SAME_ROLE', u, matchedBy);
        } else if (otherRole === role) {
            add(blocking, sameName ? 'SAME_ROLE_NAME' : 'SAME_ROLE_RUT', u, matchedBy);
        } else if (isStaffRole(role) && isStaffRole(otherRole)) {
            add(warnings, 'OTHER_ROLE', u, matchedBy);
        }
    }
    return { blocking, warnings };
}

function describeConflict(conflict) {
    const p = conflict.profile;
    const who = `«${p.name}»`;
    switch (conflict.type) {
        case 'EMAIL': return `El correo electrónico ya está en uso por ${who} (${roleLabel(p.role)}, ${statusLabel(p.status)}).`;
        case 'SAME_ROLE_NAME': return `Ya existe un perfil de ${roleLabel(p.role)} llamado ${who} (${statusLabel(p.status)}). Revisa la lista en vez de crear otro.`;
        case 'SAME_ROLE_RUT': return `Ya existe un perfil de ${roleLabel(p.role)} con ese RUT: ${who} (${statusLabel(p.status)}).`;
        case 'OTHER_ROLE': return `${who} ya tiene un perfil de ${roleLabel(p.role)} (${statusLabel(p.status)}), con el mismo ${conflict.matchedBy.join(' y ')}. Una persona puede tener un perfil por rol.`;
        case 'DELETED_SAME_ROLE': return `Existe un perfil de ${roleLabel(p.role)} eliminado, ${who}, con el mismo ${conflict.matchedBy.join(' y ')}. Puedes reintegrarlo desde la lista (mostrando los eliminados) en vez de crear otro.`;
        default: return `Ya existe un perfil parecido: ${who}.`;
    }
}

module.exports = { canonicalRole, personKey, rutKey, emailKey, staffRutKey, isDeleted, isStaffRole, roleLabel, statusLabel, findProfileConflicts, describeConflict };
