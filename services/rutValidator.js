// Validación del RUT chileno en el servidor. Misma regla que utils/rut.ts (la que usan los formularios
// de la app): módulo 11 + número plausible. El módulo 11 solo deja pasar 00.000.000-0, 1-9 o
// 11.111.111-1 (dan un dígito verificador correcto aunque nadie tenga ese RUT), así que además se
// exige: de 7 a 9 dígitos, sin ceros a la izquierda, desde 1.000.000 y que no sea un solo dígito repetido.
// Si se cambia una de las dos copias, cambiar la otra.

const MIN_RUT_BODY = 1000000;

const cleanRut = (raw) => String(raw == null ? '' : raw).replace(/[.\-\s]/g, '').toUpperCase();

function rutCheckDigit(body) {
    let suma = 0;
    let multiplo = 2;
    for (let i = body.length - 1; i >= 0; i--) {
        suma += parseInt(body.charAt(i), 10) * multiplo;
        multiplo = multiplo < 7 ? multiplo + 1 : 2;
    }
    const esperado = 11 - (suma % 11);
    return esperado === 11 ? '0' : esperado === 10 ? 'K' : String(esperado);
}

/** 'FORMAT' | 'IMPLAUSIBLE' | 'CHECK_DIGIT', o null si el RUT es válido. */
function rutProblem(raw) {
    const limpio = cleanRut(raw);
    if (!/^\d+[\dK]$/.test(limpio)) return 'FORMAT';
    const body = limpio.slice(0, -1);
    const dv = limpio.slice(-1);
    if (body.length > 9) return 'FORMAT';
    if (body.length < 7 || body.startsWith('0') || Number(body) < MIN_RUT_BODY || /^(\d)\1+$/.test(body)) return 'IMPLAUSIBLE';
    return dv === rutCheckDigit(body) ? null : 'CHECK_DIGIT';
}

const isValidRut = (raw) => rutProblem(raw) === null;

module.exports = { cleanRut, rutCheckDigit, rutProblem, isValidRut };
