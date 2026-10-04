// Validación del RUT chileno para los formularios de la app (entrega, devolución, cierre administrativo).
//
// El módulo 11 por sí solo no basta: 00.000.000-0, 1-9 o 11.111.111-1 dan un dígito verificador
// correcto aunque nadie tenga ese RUT, y es justo lo que se escribe para saltarse el campo. Por eso,
// además del dígito verificador, se exige un número plausible: de 7 a 9 dígitos, sin ceros a la
// izquierda, desde 1.000.000 y que no sea un solo dígito repetido.
// La misma regla vive en el servidor (services/rutValidator.js): si se cambia aquí, cambiarla allá.

export type RutProblem = 'FORMAT' | 'IMPLAUSIBLE' | 'CHECK_DIGIT';

export const MIN_RUT_BODY = 1_000_000;

/** Deja solo dígitos y K: quita puntos, guion y espacios, y pasa la K a mayúscula. */
export const cleanRut = (raw: string): string => String(raw ?? '').replace(/[.\-\s]/g, '').toUpperCase();

/** Dígito verificador esperado (módulo 11) para la parte numérica de un RUT. */
export const rutCheckDigit = (body: string): string => {
  let suma = 0;
  let multiplo = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    suma += parseInt(body.charAt(i), 10) * multiplo;
    multiplo = multiplo < 7 ? multiplo + 1 : 2;
  }
  const esperado = 11 - (suma % 11);
  return esperado === 11 ? '0' : esperado === 10 ? 'K' : String(esperado);
};

/** Qué tiene de malo el RUT escrito, o null si es válido. */
export const rutProblem = (raw: string): RutProblem | null => {
  const limpio = cleanRut(raw);
  if (!/^\d+[\dK]$/.test(limpio)) return 'FORMAT';
  const body = limpio.slice(0, -1);
  const dv = limpio.slice(-1);
  if (body.length > 9) return 'FORMAT';
  if (body.length < 7 || body.startsWith('0') || Number(body) < MIN_RUT_BODY || /^(\d)\1+$/.test(body)) return 'IMPLAUSIBLE';
  return dv === rutCheckDigit(body) ? null : 'CHECK_DIGIT';
};

export const validateRut = (raw: string): boolean => rutProblem(raw) === null;

/** Mensaje para el conductor (o null si el RUT está bien). Un campo vacío no se considera error aquí. */
export const rutErrorMessage = (raw: string): string | null => {
  if (!String(raw ?? '').trim()) return null;
  switch (rutProblem(raw)) {
    case null: return null;
    case 'IMPLAUSIBLE': return 'Ese RUT no corresponde a una persona real. Pide a quien recibe su RUT verdadero.';
    case 'CHECK_DIGIT': return 'El RUT ingresado no es válido: revisa los números y el dígito verificador (el que va después del guion).';
    default: return 'El RUT ingresado no es válido. Debe llevar el número completo y el dígito verificador después del guion.';
  }
};

/** Da formato 12.345.678-K a lo que se va escribiendo. */
export const formatRut = (raw: string): string => {
  const rut = String(raw ?? '').replace(/[^0-9kK]/g, '');
  let result = '';
  let i = rut.length - 1;
  if (i >= 0) {
    result = '-' + rut[i];
    i--;
  }
  let count = 0;
  for (; i >= 0; i--) {
    result = rut[i] + result;
    count++;
    if (count === 3 && i > 0) {
      result = '.' + result;
      count = 0;
    }
  }
  return result.toUpperCase();
};
