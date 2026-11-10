// Huella de las fotos de evidencia de un cierre, calculada en el servidor para el informe «Calidad de cierres».
//
// De cada foto se guardan dos cosas:
//   · sha  — SHA-256 (32 primeros caracteres hex) de los BYTES de la imagen: dos fotos con la misma «sha» son el mismo archivo, aunque venga con otro encabezado «data:image/…».
//   · hash — huella visual de 63 bits (16 caracteres hex): la foto se reduce a 32×32 grises, se queda con sus 8×8 frecuencias más bajas y cada bit dice si esa frecuencia
//            está sobre la mediana. Es la MISMA fórmula de utils/photoSimilarity.ts (la que usa el formulario del conductor); aquí cambia solo cómo se llega a los 32×32
//            grises: el teléfono usa el lienzo del navegador y el servidor decodifica el JPEG con «jpeg-js» y promedia por bloques. Todas las huellas del informe se sacan
//            aquí, así que se comparan siempre entre sí con el mismo método.
//
// Decodificar un JPEG de 1–2 megapíxeles en JavaScript puro tarda cientos de milisegundos: se hace en un hilo aparte (photoPrintWorker.js) para no frenar la atención de
// la app. Si «jpeg-js» no está instalado, o la foto no es JPEG o no se puede leer, la huella visual queda vacía y el informe sigue funcionando con la huella exacta.
// Si se cambia la fórmula, cambiar también utils/photoSimilarity.ts (tests/closureReview.test.js compara las dos).

const crypto = require('crypto');
const path = require('path');

let jpeg = null;
try { jpeg = require('jpeg-js'); } catch (e) { jpeg = null; }

const FINGERPRINT_SIZE = 32;
const LOW_FREQUENCIES = 8;

/** Hasta cuántos bits (de 63) pueden diferir dos huellas para ser «la misma imagen» aunque el archivo sea otro (recomprimida). */
const SAME_IMAGE_BITS = 2;
/** Hasta cuántos bits para ser «muy parecidas» (la toma de siempre del formulario del conductor: utils/photoSimilarity.ts MAX_SIMILAR_BITS). */
const SIMILAR_BITS = 8;

// Límites al decodificar (la foto la mandó un teléfono, pero nunca se confía en una imagen sin límites).
const MAX_MEGAPIXELS = 30;
const MAX_MEMORY_MB = 256;
const HASH_TIMEOUT_MS = 20000;

// COSINES[u][x] = cos((2x + 1)·u·π / 2N): la base de la transformada de coseno
const COSINES = Array.from({ length: LOW_FREQUENCIES }, (_, u) =>
    Array.from({ length: FINGERPRINT_SIZE }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * FINGERPRINT_SIZE))));

/** Huella (16 caracteres hex) de una imagen ya reducida a 32×32 grises (por filas). Copia exacta de fingerprintFromGray de utils/photoSimilarity.ts. */
function fingerprintFromGray(gray) {
    const N = FINGERPRINT_SIZE;
    const K = LOW_FREQUENCIES;
    // transformada de coseno de las K×K frecuencias más bajas (primero por filas, luego por columnas)
    const rows = new Float64Array(N * K);
    for (let y = 0; y < N; y++) {
        for (let v = 0; v < K; v++) {
            let sum = 0;
            for (let x = 0; x < N; x++) sum += gray[y * N + x] * COSINES[v][x];
            rows[y * K + v] = sum;
        }
    }
    const coefficients = [];
    for (let u = 0; u < K; u++) {
        for (let v = 0; v < K; v++) {
            let sum = 0;
            for (let y = 0; y < N; y++) sum += rows[y * K + v] * COSINES[u][y];
            // redondeado para que el ruido de decimales de una imagen lisa no cambie la huella; la frecuencia (0,0) —el brillo medio— no cuenta
            if (u + v > 0) coefficients.push(Math.round(sum * 100) / 100);
        }
    }
    const median = [...coefficients].sort((a, b) => a - b)[coefficients.length >> 1];
    let hex = '';
    let nibble = 0; // el primer bit queda en 0: son 63 bits en 16 caracteres hex
    for (let i = 0; i < coefficients.length; i++) {
        nibble = (nibble << 1) | (coefficients[i] > median ? 1 : 0);
        if ((i + 2) % 4 === 0) { hex += nibble.toString(16); nibble = 0; }
    }
    return hex;
}

const BITS_SET = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** En cuántos bits difieren dos huellas (0 = idénticas). Copia exacta de bitDistance de utils/photoSimilarity.ts. */
function bitDistance(a, b) {
    let n = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) n += BITS_SET[(parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16)) & 15];
    return n;
}

/**
 * Reduce una imagen RGBA a FINGERPRINT_SIZE × FINGERPRINT_SIZE grises (por filas): cada píxel de origen cae en una sola casilla de destino y cada casilla es el promedio
 * de sus píxeles (reducción «por área»). Gris = 0,299 R + 0,587 G + 0,114 B, igual que el teléfono.
 */
function grayThumbnail(rgba, width, height) {
    const N = FINGERPRINT_SIZE;
    const sum = new Float64Array(N * N);
    const count = new Uint32Array(N * N);
    const xCell = new Uint8Array(width);
    for (let x = 0; x < width; x++) xCell[x] = Math.min(N - 1, Math.floor((x * N) / width));
    for (let y = 0; y < height; y++) {
        const rowStart = Math.min(N - 1, Math.floor((y * N) / height)) * N;
        let p = y * width * 4;
        for (let x = 0; x < width; x++, p += 4) {
            const cell = rowStart + xCell[x];
            sum[cell] += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
            count[cell]++;
        }
    }
    const gray = new Float64Array(N * N);
    for (let i = 0; i < gray.length; i++) gray[i] = count[i] ? sum[i] / count[i] : 0;
    return gray;
}

const isJpeg = (bytes) => bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;

/** Huella visual de los bytes de un JPEG, o null si no es JPEG, no se puede leer o falta «jpeg-js». Síncrona: el trabajo pesado va por computeHash (hilo aparte). */
function hashOfJpeg(bytes) {
    if (!jpeg || !isJpeg(bytes)) return null;
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: MAX_MEMORY_MB });
    if (!image || !image.width || !image.height) return null;
    return fingerprintFromGray(grayThumbnail(image.data, image.width, image.height));
}

// ───────────── hilo aparte ─────────────
let worker = null;
let nextId = 0;
const waiting = new Map();   // id → { resolve, timer }

const settleAll = () => {
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.resolve(null); }
    waiting.clear();
};

function startWorker() {
    const { Worker } = require('worker_threads');
    const w = new Worker(path.join(__dirname, 'photoPrintWorker.js'));
    w.on('message', (msg) => {
        const entry = waiting.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        waiting.delete(msg.id);
        entry.resolve(typeof msg.hash === 'string' && msg.hash ? msg.hash : null);
    });
    const dropped = () => { if (worker === w) { worker = null; settleAll(); } };
    w.on('error', (err) => { console.error('[PhotoPrints] El hilo de huellas falló:', err && err.message ? err.message : err); dropped(); });
    w.on('exit', dropped);
    w.unref();   // un hilo ocioso no debe impedir que el proceso termine
    return w;
}

/** Huella visual de los bytes de una foto, calculada en un hilo aparte. Nunca lanza error: null si no se pudo (no es JPEG, ilegible, tardó demasiado). */
function computeHash(bytes) {
    if (!jpeg || !isJpeg(bytes)) return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            if (!worker) worker = startWorker();
            const id = ++nextId;
            const timer = setTimeout(() => {
                waiting.delete(id);
                resolve(null);
                // un hilo atascado en una imagen rara se descarta; el siguiente trabajo levanta otro
                if (worker) { const stuck = worker; worker = null; stuck.terminate().catch(() => {}); settleAll(); }
            }, HASH_TIMEOUT_MS);
            waiting.set(id, { resolve, timer });
            const copy = new Uint8Array(bytes.length);
            copy.set(bytes);
            worker.postMessage({ id, bytes: copy.buffer }, [copy.buffer]);
        } catch (err) {
            console.error('[PhotoPrints] No se pudo enviar la foto al hilo de huellas:', err && err.message ? err.message : err);
            resolve(null);
        }
    });
}

/** Apaga el hilo (para los procesos de prueba y el cierre ordenado del servidor). */
function shutdown() {
    const w = worker;
    worker = null;
    settleAll();
    return w ? w.terminate().catch(() => {}) : Promise.resolve();
}

// ───────────── fotos de un cierre ─────────────
/** Bytes de una foto «data:image/jpeg;base64,…» (lo que viene después de la coma). */
function bytesOfPhoto(dataUri) {
    const text = typeof dataUri === 'string' ? dataUri : '';
    const comma = text.indexOf(',');
    return Buffer.from(comma === -1 ? text : text.slice(comma + 1), 'base64');
}

/** SHA-256 de los bytes, 32 primeros caracteres hex; '' si la foto no trae contenido (una foto vacía nunca cuenta como «la misma»). */
function shaOfBytes(bytes) {
    return bytes.length ? crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32) : '';
}

/** La columna deliveryPhotosBase64 (JSONB) como lista de fotos: viene como arreglo, o como texto JSON (a veces codificado dos veces). */
function asPhotoList(value) {
    let x = value;
    for (let i = 0; i < 2 && typeof x === 'string'; i++) {
        try { x = JSON.parse(x); } catch (e) { return []; }
    }
    return Array.isArray(x) ? x.filter(p => typeof p === 'string') : [];
}

/**
 * Huellas de las fotos de un cierre, en el orden de las fotos: { shas, hashes } con '' donde no hay huella.
 * La huella visual solo se pide cuando `withHash` (sirve para comparar las fotos de UNA entrega entre sí, así que no hace falta con una sola foto).
 */
async function printsOfPhotos(photos, { withHash = true, hashOf = computeHash } = {}) {
    const shas = [];
    const hashes = [];
    for (const dataUri of photos) {
        const bytes = bytesOfPhoto(dataUri);
        shas.push(shaOfBytes(bytes));
        hashes.push(withHash && bytes.length ? ((await hashOf(bytes)) || '') : '');
    }
    return { shas, hashes };
}

module.exports = {
    FINGERPRINT_SIZE, LOW_FREQUENCIES, SAME_IMAGE_BITS, SIMILAR_BITS,
    fingerprintFromGray, bitDistance, grayThumbnail, hashOfJpeg, computeHash, shutdown,
    bytesOfPhoto, shaOfBytes, asPhotoList, printsOfPhotos, isJpeg,
};
