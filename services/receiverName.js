// Control del NOMBRE DE QUIEN RECIBE al cerrar una entrega, en el servidor. Misma regla que utils/receiverName.ts (la que usa el formulario del conductor).
//
// El campo es obligatorio, pero en los cierres de 14 días casi 14 de cada 100 traían un nombre de 0 o 1 letra (un «.», una «m»…), sobre todo de unos pocos conductores,
// así que no decía nada de quién recibió. Esta regla frena lo evidentemente vacío sin estorbar a quien sí anota algo: un nombre de pila solo («Juan») sirve, y también
// quién fue («Conserje», «Portería», «Titular», «Vecino»), que es lo que más se escribe cuando la persona no da su nombre.
// Si se cambia una de las dos copias, cambiar la otra (tests/deliveryChecks.test.js compara las dos).

const MIN_RECEIVER_LETTERS = 3;

// Textos de relleno (ya sin tildes, mayúsculas ni espacios): teclazos, pruebas, «no hay nombre» y palabras sueltas que no son un nombre.
const PLACEHOLDERS = new Set([
    'asd', 'asdf', 'asdfg', 'asdfgh', 'sdf', 'sdfg', 'qwe', 'qwer', 'qwert', 'qwerty', 'zxc', 'zxcv', 'wasd', 'xyz', 'abc', 'abcd', 'abcde',
    'test', 'prueba', 'pruebas',
    'nose', 'nosabe', 'noindica', 'nodice', 'nodio', 'sinnombre', 'sindato', 'sindatos', 'ninguno', 'ninguna', 'nadie', 'nada', 'anonimo', 'anonima', 'desconocido', 'desconocida',
    'por', 'con', 'sin', 'que', 'del', 'los', 'las', 'una', 'uno',
]);

const cleanName = (raw) => String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
const lettersIn = (text) => (text.match(/\p{L}/gu) || []).length;
/** «Á.b-C» → «abc»: minúsculas, sin tildes y solo letras. */
const foldName = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}]/gu, '');

/** 'EMPTY' | 'NO_LETTERS' | 'TOO_SHORT' | 'INITIALS_ONLY' | 'REPEATED' | 'PLACEHOLDER', o null si el nombre sirve. */
function receiverNameProblem(raw) {
    const name = cleanName(raw);
    if (!name) return 'EMPTY';
    const letters = lettersIn(name);
    if (letters === 0) return 'NO_LETTERS';
    if (letters < MIN_RECEIVER_LETTERS) return 'TOO_SHORT';
    // «A B C», «J P M»: solo iniciales sueltas
    if (Math.max(...name.split(' ').map(lettersIn)) < 2) return 'INITIALS_ONLY';
    const folded = foldName(name);
    // una misma letra («aaa», «xxxx») o una sílaba que se repite («jajaja», «lalala»)
    if (/^(\p{L}{1,3})\1{2,}$/u.test(folded)) return 'REPEATED';
    if (PLACEHOLDERS.has(folded)) return 'PLACEHOLDER';
    return null;
}

/** Mensaje para el conductor, o null si el nombre sirve. */
function receiverNameMessage(problem) {
    switch (problem) {
        case null:
        case undefined: return null;
        case 'EMPTY': return 'Escribe el nombre de quien recibe.';
        case 'REPEATED':
        case 'PLACEHOLDER': return 'Ese no parece un nombre real. Escribe el nombre de quien recibe o, si no quiso darlo, quién fue: Conserje, Vecino o Familiar.';
        default: return 'Escribe el nombre de quien recibe (al menos 3 letras). Si no quiso darlo, escribe quién fue: Conserje, Vecino o Familiar.';
    }
}

// Código que devuelve POST /packages/:id/deliver (HTTP 400) cuando el nombre de quien recibe no sirve.
const INVALID_RECEIVER_NAME = 'INVALID_RECEIVER_NAME';

module.exports = { MIN_RECEIVER_LETTERS, INVALID_RECEIVER_NAME, receiverNameProblem, receiverNameMessage };
