// Fotos REPETIDAS en el cierre de una entrega (formulario del conductor).
//
// Quien cierra desde su casa cumplía la exigencia de «2 fotos» mandando la MISMA foto dos veces (la misma de la galería, o dos tomas casi iguales). Aquí se detecta en el
// teléfono, antes de enviar: de cada foto se saca una huella visual de 63 bits (tipo pHash: la foto se reduce a 32×32 grises, se queda con sus 8×8 frecuencias más bajas
// —la forma general de la imagen— y cada bit dice si esa frecuencia está sobre la mediana) y dos fotos cuyas huellas difieren en MAX_SIMILAR_BITS bits o menos cuentan
// como la misma foto.
// La huella no cambia por el tamaño ni por la compresión (la misma foto sacada con la cámara de la app y recomprimida desde la galería queda a ≤6 bits) y tolera un cambio
// de luz o contraste y un pequeño movimiento de cámara. Con 400 entregas reales: dos fotos de entregas distintas nunca estuvieron a menos de 10 bits (la mediana es 32)
// y dentro de una misma entrega hubo 18 con 8 bits o menos.
// El servidor, que no decodifica imágenes, solo rechaza la foto idéntica byte a byte (services/deliveryPhotos.js).

export const FINGERPRINT_SIZE = 32;
const LOW_FREQUENCIES = 8;

/** Bits (de 63) en que pueden diferir dos huellas para considerar que es la misma foto. */
export const MAX_SIMILAR_BITS = 8;

// COSINES[u][x] = cos((2x + 1)·u·π / 2N): la base de la transformada de coseno
const COSINES: number[][] = Array.from({ length: LOW_FREQUENCIES }, (_, u) =>
  Array.from({ length: FINGERPRINT_SIZE }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * FINGERPRINT_SIZE))));

/** Huella (16 caracteres hex) de una imagen ya reducida a FINGERPRINT_SIZE × FINGERPRINT_SIZE grises (por filas). */
export const fingerprintFromGray = (gray: ArrayLike<number>): string => {
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
  const coefficients: number[] = [];
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
};

const BITS_SET = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** En cuántos bits difieren dos huellas (0 = idénticas). */
export const bitDistance = (a: string, b: string): number => {
  let n = 0;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) n += BITS_SET[(parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16)) & 15];
  return n;
};

/**
 * Para cada foto de la lista, el índice de la foto ANTERIOR que repite, o null si es distinta de todas las anteriores.
 * Una foto sin huella (null: no se pudo leer) nunca se marca: ante la duda se deja pasar, el servidor sigue exigiendo imágenes válidas.
 */
export const repeatedPhotoIndexes = (fingerprints: (string | null)[], maxBits: number = MAX_SIMILAR_BITS): (number | null)[] =>
  fingerprints.map((print, i) => {
    if (!print) return null;
    for (let j = 0; j < i; j++) {
      const other = fingerprints[j];
      if (other && bitDistance(print, other) <= maxBits) return j;
    }
    return null;
  });

const loadImage = (dataUri: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Imagen ilegible'));
  img.src = dataUri;
});

// Reduce a la mitad una y otra vez (cada paso promedia 2×2 píxeles) hasta quedar cerca del tamaño final: de un solo salto de 1200 px a 32 px el navegador salta
// píxeles y la huella sale ruidosa.
const shrink = (img: HTMLImageElement, size: number): HTMLCanvasElement => {
  let source: CanvasImageSource = img;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  while (w / 2 >= size && h / 2 >= size) {
    const nextW = Math.floor(w / 2);
    const nextH = Math.floor(h / 2);
    const step = document.createElement('canvas');
    step.width = nextW;
    step.height = nextH;
    step.getContext('2d')!.drawImage(source, 0, 0, nextW, nextH);
    source = step;
    w = nextW;
    h = nextH;
  }
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  out.getContext('2d', { willReadFrequently: true })!.drawImage(source, 0, 0, size, size);
  return out;
};

// Si una foto tarda más que esto en leerse, se deja sin huella (no se compara) en vez de dejar bloqueado el botón de confirmar.
const FINGERPRINT_TIMEOUT_MS = 5000;

const computeFingerprint = async (dataUri: string): Promise<string | null> => {
  try {
    const img = await loadImage(dataUri);
    const small = shrink(img, FINGERPRINT_SIZE);
    const { data } = small.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, FINGERPRINT_SIZE, FINGERPRINT_SIZE);
    const gray = new Float64Array(FINGERPRINT_SIZE * FINGERPRINT_SIZE);
    for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    return fingerprintFromGray(gray);
  } catch (err) {
    console.warn('[Fotos] No se pudo sacar la huella de una foto; no se compara.', err);
    return null;
  }
};

/** Huella de una foto (data URI), o null si el navegador no pudo leerla a tiempo. Nunca lanza error. */
export const photoFingerprint = (dataUri: string, timeoutMs: number = FINGERPRINT_TIMEOUT_MS): Promise<string | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  return Promise.race([computeFingerprint(dataUri), timeout]).finally(() => clearTimeout(timer));
};
