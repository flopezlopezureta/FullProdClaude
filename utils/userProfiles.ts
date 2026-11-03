import type { User } from '../types';

/**
 * Una persona puede tener un perfil por rol (por ejemplo administrador y conductor). Las listas "de conductores" incluyen a los administradores y a quien tenga
 * permiso de entregar para poder asignarles paquetes, y por eso quien tiene los dos perfiles salía dos veces. Aquí se decide quién queda en cada lista.
 */

const ROLE_ALIASES: Record<string, string> = { ADMINISTRADOR: 'ADMIN', CHOFER: 'DRIVER', CONDUCTOR: 'DRIVER', CLIENTE: 'CLIENT' };
export const canonicalRole = (role?: string | null): string => { const r = String(role ?? '').trim().toUpperCase(); return ROLE_ALIASES[r] || r; };

/** Nombre comparable entre perfiles: sin tildes, sin mayúsculas y con los espacios normalizados (igual que en el servidor). */
export const personKey = (name?: string | null): string =>
  String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

type ProfileLike = Pick<User, 'name' | 'role' | 'status'>;
const isDeleted = (status?: string | null) => String(status ?? '').trim().toUpperCase() === 'ELIMINADO';

/**
 * Quita de la lista los perfiles de otro rol cuando esa misma persona (mismo nombre) ya tiene un perfil del rol de la lista: en la lista de conductores se queda
 * el perfil de conductor y no su perfil de administrador. Si no tiene perfil de ese rol, su otro perfil sigue apareciendo (por ejemplo un administrador que entrega).
 * Un perfil eliminado no cuenta para ocultar a los demás. Perfiles distintos del mismo rol nunca se ocultan entre sí.
 */
export function dropProfilesShadowedByRole<T extends ProfileLike>(profiles: T[], listRole: string): T[] {
  const wanted = canonicalRole(listRole);
  const peopleWithThatRole = new Set(
    profiles.filter(p => canonicalRole(p.role) === wanted && !isDeleted(p.status)).map(p => personKey(p.name)).filter(Boolean)
  );
  return profiles.filter(p => canonicalRole(p.role) === wanted || !peopleWithThatRole.has(personKey(p.name)));
}

/** A quién se le pueden asignar paquetes: conductores, administradores y quien tenga permiso de entregar, aprobados, y cada persona una sola vez. */
export function buildAssignableDrivers(users: User[], opts: { approvedStatuses?: string[] } = {}): User[] {
  const approved = (opts.approvedStatuses ?? ['APROBADO']).map(s => s.toUpperCase());
  const candidates = users.filter(u => {
    const role = canonicalRole(u.role);
    const isAssignable = role === 'ADMIN' || role === 'DRIVER' || u.driverPermissions?.canDeliver === true;
    return isAssignable && approved.includes(String(u.status ?? '').toUpperCase());
  });
  return dropProfilesShadowedByRole(candidates, 'DRIVER').sort((a, b) => a.name.localeCompare(b.name));
}
