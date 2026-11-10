/**
 * Prueba del informe «CALIDAD DE CIERRES» (nombre de quien recibe sin sentido y fotos de evidencia repetidas, por conductor).
 *   A. huella de las fotos del servidor (services/photoPrints.js): misma fórmula que utils/photoSimilarity.ts, JPEG real ida y vuelta, hilo aparte, archivos raros
 *   B. análisis por conductor (services/closureReview.js): nombres, mismo archivo, misma imagen, muy parecidas, foto reutilizada en otra dirección, umbrales y orden
 *   C. lo que habla con la base (fetchClosures, scanBatch, purgeOldPrints) contra una base FALSA en memoria
 *   D. las rutas reales GET /api/reports/closure-quality y /cases: quién puede verlas, fechas, caché
 *   E. utilidades de la pantalla (utils/closureReviewTypes.ts): orden, fechas, CSV
 *   F. que todo esté conectado (tabla, proceso de fondo, menú, pantalla)
 * No toca ninguna base de datos real: todos los nombres, direcciones y fotos de aquí son inventados. Cada consulta de la base falsa se interpreta a mano: una no prevista hace fallar la prueba.
 *
 * Uso:   node tests/closureReview.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/closureReview.test.js   (el clon de Staging/Producción antes de subir)
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
const jwt = load('jsonwebtoken');
const esbuild = load('esbuild');
const jpegJs = load('jpeg-js');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

// ───────────── base falsa ─────────────
let S;
const reset = () => { S = { users: {}, rows: [], rowQueries: [], candidates: [], photosById: {}, inserted: [], purged: [], unknown: [] }; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const R = (rows, rowCount) => ({ rows, rowCount: rowCount === undefined ? rows.length : rowCount });
async function run(text, params = []) {
    const q = norm(text);
    if (/^SELECT status, "operatorPermissions" FROM users WHERE id = \$1$/.test(q)) { const u = S.users[params[0]]; return R(u ? [{ status: u.status, operatorPermissions: u.operatorPermissions }] : []); }
    if (/^WITH cand AS MATERIALIZED \(/.test(q) && /closure_photo_prints/.test(q)) { S.rowQueries.push(params); return R(S.rows.map(r => ({ ...r }))); }
    if (/^SELECT p\.id FROM packages p LEFT JOIN closure_photo_prints f/.test(q)) { S.candidateParams = params; return R(S.candidates.slice(0, params[1]).map(id => ({ id }))); }
    if (/^SELECT "deliveryPhotosBase64" AS photos FROM packages WHERE id = \$1$/.test(q)) return R(S.photosById[params[0]] === undefined ? [] : [{ photos: S.photosById[params[0]] }]);
    if (/^INSERT INTO closure_photo_prints \("packageId", "photoCount", shas, hashes\) VALUES \(\$1, \$2, \$3, \$4\) ON CONFLICT \("packageId"\) DO NOTHING$/.test(q)) { S.inserted.push({ id: params[0], photoCount: params[1], shas: params[2], hashes: params[3] }); return R([], 1); }
    if (/^DELETE FROM closure_photo_prints WHERE "scannedAt" < NOW\(\) - make_interval\(days => \$1::int\)$/.test(q)) { S.purged.push(params[0]); return R([], 7); }
    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 200));
}
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
stub('db.js', { query: (t, p) => run(t, p), getClient: async () => { throw new Error('no se usa'); } });
stub('services/timeService.js', {
    getSystemTimezone: async () => 'America/Santiago', getLogicalDate: async () => '2026-11-09',
    getLogicalRange: async (a, b) => ({ start: `${a} 02:00:00`, nextDayStart: `${new Date(new Date(b + 'T12:00:00Z').getTime() + 86400000).toISOString().slice(0, 10)} 02:00:00` }),
});

const tests = []; const t = (name, fn) => tests.push([name, fn]);
const tryLoad = (rel) => { try { return require(path.join(ROOT, rel)); } catch (e) { return null; } };
const prints = tryLoad('services/photoPrints.js');
const review = tryLoad('services/closureReview.js');
const need = (mod, rel) => assert.ok(mod, 'no existe ' + rel);
const tsModule = (rel) => { const code = esbuild.transformSync(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { loader: 'ts', format: 'cjs' }).code; const m = { exports: {} }; new Function('module', 'exports', 'require', code)(m, m.exports, require); return m.exports; };

// ───────────── datos de prueba ─────────────
// imagen sintética con «objetos» (manchas) en posiciones y brillos propios, como foto de ancho w y alto h
const scene = (seed) => {
    let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const blobs = Array.from({ length: 8 }, () => ({ x: rnd(), y: rnd(), r: 0.05 + rnd() * 0.22, v: (rnd() - 0.5) * 230, tint: rnd() }));
    return (u, v) => blobs.reduce((acc, b) => acc + b.v * Math.exp(-(((u - b.x) ** 2 + (v - b.y) ** 2) / (2 * b.r * b.r))), 120);
};
const rgbaOf = (seed, w, h) => {
    const f = scene(seed); const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const g = Math.max(0, Math.min(255, f(x / w, y / h))); const p = (y * w + x) * 4;
        data[p] = g; data[p + 1] = g * 0.93; data[p + 2] = g * 0.85; data[p + 3] = 255;
    }
    return { data, width: w, height: h };
};
const jpegOf = (seed, w = 640, h = 480, quality = 90) => jpegJs.encode(rgbaOf(seed, w, h), quality).data;
const recompress = (bytes, quality) => { const img = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true }); return jpegJs.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, quality).data; };
const uri = (bytes, mime = 'image/jpeg') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const ZEROS = '0000000000000000';
// huella a una distancia exacta (en bits) de otra: se invierten los primeros `bits` bits (en los 15 últimos caracteres hex; el primero tiene solo 3 bits)
const hashAt = (bits) => { let hex = ''; let left = bits; for (let i = 0; i < 16; i++) { const take = Math.min(left, 4); hex += ((1 << take) - 1).toString(16); left -= take; } return hex.split('').reverse().join(''); };

let seq = 0;
const mk = (driverId, over = {}) => ({
    id: over.id || `PKG-${++seq}`, driverId, driverName: over.driverName || `Conductor ${driverId}`, driverStatus: 'APROBADO', receiverName: 'Juan Pérez',
    address: `Calle ${seq} 100`, commune: 'Maipú', closedAt: new Date(Date.UTC(2026, 10, 5, 15, seq % 59)), hasPhotos: true, photoCount: 2,
    shas: [`s${seq}a`, `s${seq}b`], hashes: [ZEROS.slice(0, 15) + '1', 'ffffffffffffffff'], ...over,
});

// ───────────── A. huella de las fotos ─────────────
t('A1 fingerprintFromGray y bitDistance del servidor dan EXACTAMENTE lo mismo que utils/photoSimilarity.ts (200 imágenes sintéticas)', () => {
    need(prints, 'services/photoPrints.js'); const web = tsModule('utils/photoSimilarity.ts');
    for (let i = 0; i < 200; i++) {
        const f = scene(1000 + i * 13);
        const gray = Float64Array.from({ length: 1024 }, (_, k) => f((k % 32) / 32, Math.floor(k / 32) / 32));
        const a = prints.fingerprintFromGray(gray); const b = web.fingerprintFromGray(gray);
        assert.strictEqual(a, b, `imagen ${i}`); assert.strictEqual(a.length, 16);
    }
    for (const [x, y] of [['0000000000000000', 'ffffffffffffffff'], ['0123456789abcdef', 'fedcba9876543210'], ['f000000000000000', '0000000000000000'], ['abc', 'abcdef']]) assert.strictEqual(prints.bitDistance(x, y), web.bitDistance(x, y));
});
t('A2 un JPEG real: la misma foto recomprimida (calidad 90 → 45) queda a pocos bits y otra foto queda lejos', () => {
    need(prints, 'services/photoPrints.js');
    const original = jpegOf(7); const lower = recompress(original, 45);
    const a = prints.hashOfJpeg(original); const b = prints.hashOfJpeg(lower);
    assert.ok(/^[0-9a-f]{16}$/.test(a), 'huella con 16 caracteres hex: ' + a);
    assert.ok(prints.bitDistance(a, b) <= 3, 'recomprimida a ' + prints.bitDistance(a, b) + ' bits');
    assert.ok(prints.bitDistance(a, prints.hashOfJpeg(jpegOf(8))) >= 10, 'otra foto a ' + prints.bitDistance(a, prints.hashOfJpeg(jpegOf(8))) + ' bits');
});
t('A3 la misma foto en otro tamaño (640×480 y 320×240) queda dentro del umbral de «muy parecidas»', () => {
    need(prints, 'services/photoPrints.js');
    const big = prints.hashOfJpeg(jpegOf(21, 640, 480)); const small = prints.hashOfJpeg(jpegOf(21, 320, 240));
    assert.ok(prints.bitDistance(big, small) <= prints.SIMILAR_BITS, 'a ' + prints.bitDistance(big, small) + ' bits');
});
t('A4 40 fotos distintas: ningún par queda a menos de 10 bits y la mediana está lejos', () => {
    need(prints, 'services/photoPrints.js');
    const hs = Array.from({ length: 40 }, (_, i) => prints.hashOfJpeg(jpegOf(500 + i * 31, 320, 240)));
    const d = []; for (let i = 0; i < hs.length; i++) for (let j = 0; j < i; j++) d.push(prints.bitDistance(hs[i], hs[j]));
    d.sort((x, y) => x - y);
    assert.ok(d[0] >= 10, 'el par más cercano está a ' + d[0] + ' bits'); assert.ok(d[d.length >> 1] >= 20, 'mediana ' + d[d.length >> 1]);
});
t('A5 lo que no es un JPEG legible da null y no lanza error (PNG, texto, JPEG cortado, vacío)', async () => {
    need(prints, 'services/photoPrints.js');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('xxxxxxxx')]);
    const cut = jpegOf(3).subarray(0, 300);
    const junk = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('esto no es una foto de verdad, solo basura')]);
    for (const bytes of [png, Buffer.from('hola'), cut, junk, Buffer.alloc(0)]) assert.strictEqual(await prints.computeHash(bytes), null);
});
t('A6 el hilo aparte da la misma huella que el cálculo directo, y sigue funcionando después de un archivo ilegible', async () => {
    need(prints, 'services/photoPrints.js');
    const a = jpegOf(41); const b = jpegOf(42);
    assert.strictEqual(await prints.computeHash(a), prints.hashOfJpeg(a));
    assert.strictEqual(await prints.computeHash(Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('basura')])), null);
    assert.strictEqual(await prints.computeHash(b), prints.hashOfJpeg(b));
    const many = await Promise.all([a, b, a, b].map(x => prints.computeHash(x)));   // varias a la vez
    assert.deepStrictEqual(many, [prints.hashOfJpeg(a), prints.hashOfJpeg(b), prints.hashOfJpeg(a), prints.hashOfJpeg(b)]);
});
t('A7 printsOfPhotos: misma sha aunque cambie el encabezado data:, foto vacía sin sha, y solo pide la huella visual cuando se pide', async () => {
    need(prints, 'services/photoPrints.js');
    const bytes = jpegOf(5, 64, 48); let calls = 0; const fake = async () => { calls++; return 'abcdef0123456789'; };
    const one = await prints.printsOfPhotos([uri(bytes), uri(bytes, 'image/png'), 'data:,'], { withHash: true, hashOf: fake });
    assert.strictEqual(one.shas[0], one.shas[1]); assert.strictEqual(one.shas[0].length, 32); assert.strictEqual(one.shas[2], '');
    assert.deepStrictEqual(one.hashes, ['abcdef0123456789', 'abcdef0123456789', '']); assert.strictEqual(calls, 2);
    calls = 0; const none = await prints.printsOfPhotos([uri(bytes), uri(bytes)], { withHash: false, hashOf: fake });
    assert.strictEqual(calls, 0); assert.deepStrictEqual(none.hashes, ['', '']);
    const failing = await prints.printsOfPhotos([uri(bytes)], { withHash: true, hashOf: async () => null });
    assert.deepStrictEqual(failing.hashes, ['']);
});
t('A8 asPhotoList entiende un arreglo, un texto JSON, un texto codificado dos veces y lo que no sirve', () => {
    need(prints, 'services/photoPrints.js');
    assert.deepStrictEqual(prints.asPhotoList(['a', 'b']), ['a', 'b']);
    assert.deepStrictEqual(prints.asPhotoList(JSON.stringify(['a', 'b'])), ['a', 'b']);
    assert.deepStrictEqual(prints.asPhotoList(JSON.stringify(JSON.stringify(['a']))), ['a']);
    assert.deepStrictEqual(prints.asPhotoList(['a', 5, null, 'c']), ['a', 'c']);
    for (const bad of [null, undefined, '', 'no es json', 42, {}]) assert.deepStrictEqual(prints.asPhotoList(bad), []);
});

// ───────────── B. análisis por conductor ─────────────
const stats = (list) => review.buildReport(list).drivers[0];
t('B1 nombre sin sentido: cuenta cada motivo y entra en la lista con 3+ cierres Y 10 % o más', () => {
    need(review, 'services/closureReview.js');
    const names = ['.', '..', 'm', 'ab', '', 'aaa', 'por', 'Juan Pérez', 'Conserje', 'María'];
    const d = stats(names.map(n => mk('d1', { receiverName: n, hasPhotos: false, shas: null, hashes: null })));
    assert.strictEqual(d.closures, 10); assert.strictEqual(d.nameBad, 7);
    assert.deepStrictEqual(d.nameBreakdown, { empty: 1, signs: 2, short: 2, filler: 2 });
    assert.strictEqual(d.nameBadPct, 70); assert.strictEqual(d.flags.name, true);
    const few = stats([mk('d2', { receiverName: '.' }), mk('d2', { receiverName: '.' }), ...Array.from({ length: 30 }, () => mk('d2'))]);
    assert.strictEqual(few.nameBad, 2); assert.strictEqual(few.flags.name, false, 'solo 2 casos: bajo el mínimo de 3');
    const lowPct = stats([...Array.from({ length: 4 }, () => mk('d3', { receiverName: '.' })), ...Array.from({ length: 60 }, () => mk('d3'))]);
    assert.strictEqual(lowPct.nameBad, 4); assert.strictEqual(lowPct.flags.name, false, '4 de 64 = 6 %: bajo el 10 %');
});
t('B2 el mismo archivo dos veces en un cierre = «mismo archivo»; dos fotos distintas no', () => {
    need(review, 'services/closureReview.js');
    const d = stats([mk('d1', { shas: ['x1', 'x1'], hashes: ['', ''] }), mk('d1', { shas: ['y1', 'y2'], hashes: ['', ''] })]);
    assert.strictEqual(d.identical, 1); assert.strictEqual(d.sameImage, 1); assert.strictEqual(d.reviewed, 2); assert.strictEqual(d.similar, 0);
});
t('B3 según los bits de diferencia: ≤2 misma imagen, 3 a 8 muy parecidas, más no se marca, sin huellas no se puede decir', () => {
    need(review, 'services/closureReview.js');
    const base = ZEROS; const withDist = (bits) => mk('d1', { shas: ['u' + bits + seq, 'v' + bits + seq], hashes: [base, hashAt(bits)] });
    const d = stats([withDist(0), withDist(2), withDist(3), withDist(8), withDist(9), withDist(30), mk('d1', { shas: ['p1', 'p2'], hashes: ['', ''] }), mk('d1', { shas: ['q1', 'q2'], hashes: [base, ''] })]);
    assert.strictEqual(d.recompressed, 2, '0 y 2 bits'); assert.strictEqual(d.similar, 2, '3 y 8 bits'); assert.strictEqual(d.identical, 0); assert.strictEqual(d.reviewed, 8);
    assert.strictEqual(hashAt(5).length, 16); assert.strictEqual(require(path.join(ROOT, 'services/photoPrints.js')).bitDistance(ZEROS, hashAt(5)), 5);
});
t('B4 una foto usada en OTRA dirección cuenta como reutilizada (incluso con una sola foto); en la misma parada no', () => {
    need(review, 'services/closureReview.js');
    const a = mk('d1', { id: 'A', address: 'Av. Los Leones 1234, Depto 56', commune: 'Providencia', shas: ['same1', 'a2'], hashes: ['', ''] });
    const b = mk('d1', { id: 'B', address: 'Calle Otra 55', commune: 'Providencia', shas: ['same1'], photoCount: 1, hashes: [''] });
    const c = mk('d1', { id: 'C', address: 'av los leones 1234 depto 77', commune: 'PROVIDENCIA', shas: ['same1', 'c2'], hashes: ['', ''] });
    const d = stats([a, b, c]);
    assert.strictEqual(d.reused, 3, 'A y C frente a B, y B frente a A y C');
    const sameStop = stats([a, c]);   // A y C son el mismo edificio
    assert.strictEqual(sameStop.reused, 0);
    const cases = review.buildDriverCases([a, b, c], 'd1').cases;
    assert.deepStrictEqual(cases.find(x => x.packageId === 'B').reusedWith.map(x => x.packageId).sort(), ['A', 'C']);
    assert.deepStrictEqual(cases.find(x => x.packageId === 'A').reusedWith.map(x => x.packageId), ['B']);
});
t('B5 la reutilización solo mira al MISMO conductor (otro conductor con la misma foto no cuenta aquí)', () => {
    need(review, 'services/closureReview.js');
    const r = review.buildReport([mk('d1', { shas: ['z', 'z1'] }), mk('d2', { shas: ['z', 'z2'] })]);
    assert.strictEqual(r.totals.reused, 0);
});
t('B6 fotos sin procesar: se cuentan como pendientes, no como revisadas ni como hallazgo; sin fotos no es pendiente', () => {
    need(review, 'services/closureReview.js');
    const d = stats([mk('d1', { shas: null, hashes: null }), mk('d1', { shas: null, hashes: null }), mk('d1', { hasPhotos: false, shas: null, hashes: null, photoCount: 0 }), mk('d1')]);
    assert.strictEqual(d.closures, 4); assert.strictEqual(d.withPhotos, 3); assert.strictEqual(d.pending, 2); assert.strictEqual(d.scanned, 1); assert.strictEqual(d.reviewed, 1);
    const r = review.buildReport([mk('d1', { shas: null, hashes: null }), mk('d1')]);
    assert.deepStrictEqual(r.coverage, { closures: 2, withPhotos: 2, scanned: 1, pending: 1 });
    // una fila de huellas de un cierre que ya no tiene fotos (borradas después) no infla «procesados»: nunca pasa del 100 % de «con fotos»
    const odd = review.buildReport([mk('d1', { hasPhotos: false, photoCount: 0, shas: [], hashes: [] }), mk('d1')]);
    assert.deepStrictEqual(odd.coverage, { closures: 2, withPhotos: 1, scanned: 1, pending: 0 });
    assert.ok(odd.coverage.scanned <= odd.coverage.withPhotos);
});
t('B7 una foto vacía (sha vacía) no cuenta como «mismo archivo» ni como reutilizada', () => {
    need(review, 'services/closureReview.js');
    const d = stats([mk('d1', { shas: ['', ''], hashes: ['', ''] }), mk('d1', { shas: ['', 'k'], hashes: ['', ''], address: 'Otra 1' })]);
    assert.strictEqual(d.identical, 0); assert.strictEqual(d.reused, 0);
});
t('B8 listas: «Fotos» con 3 misma imagen, o 5 muy parecidas, o 3 reutilizadas; casos sueltos quedan como «aislados»; «en las dos listas»', () => {
    need(review, 'services/closureReview.js');
    const same = (n, id) => Array.from({ length: n }, () => mk(id, { shas: ['q' + (++seq), 'q' + seq] }));
    const sim = (n, id) => Array.from({ length: n }, () => mk(id, { shas: ['m' + (++seq), 'n' + seq], hashes: [ZEROS, hashAt(5)] }));
    const r = review.buildReport([
        ...same(3, 'main1'), ...same(2, 'minor1'), ...sim(5, 'main2'), ...sim(4, 'minor2'), ...Array.from({ length: 5 }, () => mk('clean')),
        ...same(3, 'both'), ...Array.from({ length: 9 }, () => mk('both', { receiverName: '.' })), ...Array.from({ length: 3 }, () => mk('both')),
    ]);
    const by = Object.fromEntries(r.drivers.map(d => [d.driverId, d.flags]));
    assert.strictEqual(by.main1.photos, 'MAIN'); assert.strictEqual(by.minor1.photos, 'MINOR'); assert.strictEqual(by.main2.photos, 'MAIN'); assert.strictEqual(by.minor2.photos, 'MINOR');
    assert.strictEqual(by.clean.photos, null); assert.strictEqual(by.clean.name, false);
    assert.strictEqual(by.both.name, true); assert.strictEqual(by.both.photos, 'MAIN');
    assert.deepStrictEqual(r.both, ['Conductor both']);
    assert.strictEqual(r.totals.flaggedName, 1); assert.strictEqual(r.totals.flaggedPhotos, 3);
});
t('B9 el orden por gravedad: la misma imagen pesa el triple; empata por cierres y nombre', () => {
    need(review, 'services/closureReview.js');
    const r = review.buildReport([
        mk('nombres', { receiverName: '.' }), mk('nombres', { receiverName: '.' }),                           // score 2
        mk('misma', { shas: ['k', 'k'] }),                                                                    // score 3
        mk('parecida', { shas: ['p1', 'p2'], hashes: [ZEROS, hashAt(4)] }), mk('parecida', { shas: ['p3', 'p4'], hashes: [ZEROS, hashAt(4)] }),  // score 2
        mk('limpio'),
    ]);
    assert.deepStrictEqual(r.drivers.map(d => d.driverId), ['misma', 'nombres', 'parecida', 'limpio']);
    assert.deepStrictEqual(r.drivers.map(d => d.score), [3, 2, 2, 0]);
});
t('B10 buildDriverCases: del más reciente al más antiguo, con tipos y bits; conductor sin cierres = null; tope de casos', () => {
    need(review, 'services/closureReview.js');
    const rows = [mk('d1', { id: 'viejo', receiverName: '.', closedAt: new Date('2026-11-01T15:00:00Z') }), mk('d1', { id: 'nuevo', receiverName: '.', shas: ['w', 'w'], closedAt: new Date('2026-11-06T15:00:00Z') }),
        mk('d1', { id: 'parecido', shas: ['e1', 'e2'], hashes: [ZEROS, hashAt(6)], closedAt: new Date('2026-11-04T15:00:00Z') }), mk('d1', { id: 'limpio' }), mk('d2', { id: 'otro' })];
    const res = review.buildDriverCases(rows, 'd1');
    assert.deepStrictEqual(res.cases.map(c => c.packageId), ['nuevo', 'parecido', 'viejo']);
    assert.deepStrictEqual(res.cases[0].kinds, ['NAME', 'SAME_FILE']); assert.strictEqual(res.cases[1].minBits, 6); assert.deepStrictEqual(res.cases[1].kinds, ['SIMILAR']);
    assert.strictEqual(res.driver.name, 'Conductor d1'); assert.strictEqual(res.totalCases, 3); assert.strictEqual(res.truncated, false);
    assert.strictEqual(review.buildDriverCases(rows, 'nadie'), null);
    const many = review.buildDriverCases(Array.from({ length: 450 }, () => mk('d9', { receiverName: '.' })), 'd9');
    assert.strictEqual(many.cases.length, 400); assert.strictEqual(many.totalCases, 450); assert.strictEqual(many.truncated, true);
});
t('B11 stopKey: el mismo edificio con otro depto/casa/torre es la misma parada; otra calle o comuna no', () => {
    need(review, 'services/closureReview.js');
    const k = review.stopKey;
    assert.strictEqual(k('Av. Los Leones 1234, Depto 56', 'Providencia'), k('AV LOS LEONES 1234 dpto 77', 'PROVIDENCIA'));
    assert.strictEqual(k('Los Alerces 45 casa B', 'Ñuñoa'), k('los alerces 45, Casa A', 'Nunoa'));
    assert.notStrictEqual(k('Los Alerces 45', 'Ñuñoa'), k('Los Alerces 46', 'Ñuñoa'));
    assert.notStrictEqual(k('Los Alerces 45', 'Ñuñoa'), k('Los Alerces 45', 'Macul'));
});
t('B12 sin cierres: informe vacío sin errores', () => {
    need(review, 'services/closureReview.js');
    const r = review.buildReport([]);
    assert.deepStrictEqual(r.drivers, []); assert.strictEqual(r.totals.closures, 0); assert.strictEqual(r.totals.nameBadPct, 0); assert.deepStrictEqual(r.both, []);
});

// ───────────── C. base falsa ─────────────
t('C1 fetchClosures: excluye el cierre automático por parámetro, usa la hora del evento ENTREGADO y devuelve fechas y arreglos', async () => {
    need(review, 'services/closureReview.js');
    S.rows = [{ id: 'P1', driverId: 'd1', driverName: 'Ana', driverStatus: 'APROBADO', receiverName: '.', address: 'Calle 1', commune: 'Maipú', closedAt: '2026-11-05T15:00:00.000Z', hasPhotos: true, photoCount: 2, shas: ['a', 'b'], hashes: ['', ''] },
        { id: 'P2', driverId: 'd1', driverName: 'Ana', driverStatus: 'APROBADO', receiverName: 'Juan', address: 'Calle 2', commune: 'Maipú', closedAt: '2026-11-05T16:00:00.000Z', hasPhotos: true, photoCount: null, shas: null, hashes: null }];
    let sqlSeen = '';
    const rows = await review.fetchClosures((text, params) => { sqlSeen = text; return run(text, params); }, '2026-11-03 02:00:00', '2026-11-10 02:00:00');
    assert.deepStrictEqual(S.rowQueries[0], ['2026-11-03 02:00:00', '2026-11-10 02:00:00', 'Cierre automático (verificado en Mercado Libre)']);
    assert.ok(/MAX\(te\.timestamp\) FROM tracking_events te WHERE te\."packageId" = p\.id AND te\.status = 'ENTREGADO'/.test(norm(sqlSeen)), 'hora del evento ENTREGADO');
    assert.ok(/p\.status = 'ENTREGADO'/.test(norm(sqlSeen)) && /p\."driverId" IS NOT NULL/.test(norm(sqlSeen)));
    assert.ok(rows[0].closedAt instanceof Date); assert.deepStrictEqual(rows[0].shas, ['a', 'b']); assert.strictEqual(rows[1].shas, null);
});
t('C2 scanBatch: guarda sha y huella por cierre; una sola foto no pide huella visual; lee el JSON; avisa si quedan más', async () => {
    need(review, 'services/closureReview.js');
    S.candidates = ['A', 'B', 'C']; S.photosById = { A: ['fa1', 'fa2'], B: JSON.stringify(['fb1']), C: [] };
    const asked = [];
    const hash = async (photos, opts) => { asked.push([photos.length, opts.withHash]); return { shas: photos.map((p, i) => `sha-${p}`), hashes: photos.map(() => (opts.withHash ? 'h' : '')) }; };
    const r1 = await review.scanBatch({ query: run, limit: 3, hash });
    assert.deepStrictEqual(r1, { scanned: 3, more: true });
    assert.deepStrictEqual(asked, [[2, true], [1, false], [0, false]]);
    assert.deepStrictEqual(S.inserted.map(x => [x.id, x.photoCount]), [['A', 2], ['B', 1], ['C', 0]]);
    assert.deepStrictEqual(S.inserted[0].shas, ['sha-fa1', 'sha-fa2']); assert.deepStrictEqual(S.inserted[0].hashes, ['h', 'h']); assert.deepStrictEqual(S.inserted[1].hashes, ['']);
    assert.deepStrictEqual(S.candidateParams, [31, 3]);
    S.inserted = []; S.candidates = ['A']; assert.deepStrictEqual(await review.scanBatch({ query: run, limit: 6, hash }), { scanned: 1, more: false });
    S.candidates = []; assert.deepStrictEqual(await review.scanBatch({ query: run, hash }), { scanned: 0, more: false });
});
t('C3 scanBatch de punta a punta con JPEG reales y el hilo de huellas: 2 fotos = 2 huellas; 1 foto = sin huella visual; PNG = sin huella visual', async () => {
    need(review, 'services/closureReview.js'); need(prints, 'services/photoPrints.js');
    const a = jpegOf(61, 480, 360); const b = recompress(a, 40); const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('xxxx')]);
    S.candidates = ['DOS', 'UNA', 'MIX']; S.photosById = { DOS: [uri(a), uri(b)], UNA: [uri(a)], MIX: [uri(a), uri(png, 'image/png')] };
    await review.scanBatch({ query: run, limit: 6 });
    const by = Object.fromEntries(S.inserted.map(x => [x.id, x]));
    assert.ok(by.DOS.hashes.every(h => /^[0-9a-f]{16}$/.test(h)) && by.DOS.hashes.length === 2);
    assert.ok(prints.bitDistance(by.DOS.hashes[0], by.DOS.hashes[1]) <= prints.SAME_IMAGE_BITS, 'la misma foto recomprimida queda como «misma imagen»');
    assert.notStrictEqual(by.DOS.shas[0], by.DOS.shas[1], 'archivos distintos');
    assert.deepStrictEqual(by.UNA.hashes, ['']); assert.strictEqual(by.UNA.shas.length, 1);
    assert.ok(/^[0-9a-f]{16}$/.test(by.MIX.hashes[0]) && by.MIX.hashes[1] === '', 'el PNG no tiene huella visual pero sí sha');
    // y el informe, alimentado con esas huellas, ve «misma imagen»
    const rep = review.buildReport([mk('dX', { id: 'DOS', shas: by.DOS.shas, hashes: by.DOS.hashes })]);
    assert.strictEqual(rep.drivers[0].recompressed, 1);
});
t('C4 purgeOldPrints borra con el margen pedido y devuelve cuántas', async () => {
    need(review, 'services/closureReview.js');
    assert.strictEqual(await review.purgeOldPrints(run, 90), 7); assert.deepStrictEqual(S.purged, [90]);
    assert.strictEqual(await review.purgeOldPrints(run), 7); assert.deepStrictEqual(S.purged, [90, 120]);
});

// ───────────── D. rutas ─────────────
let server; let base;
const tokenFor = (id, role) => jwt.sign({ user: { id, role } }, process.env.JWT_SECRET);
const get = async (url, token) => { const res = await fetch(base + url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); let body = null; try { body = await res.json(); } catch (e) { /* sin cuerpo */ } return { status: res.status, body }; };
const sampleRows = () => [
    { id: 'P1', driverId: 'd1', driverName: 'Ana Soto', driverStatus: 'APROBADO', receiverName: '.', address: 'Calle 1', commune: 'Maipú', closedAt: '2026-11-05T15:00:00.000Z', hasPhotos: true, photoCount: 2, shas: ['a', 'a'], hashes: ['', ''] },
    { id: 'P2', driverId: 'd1', driverName: 'Ana Soto', driverStatus: 'APROBADO', receiverName: 'Juan Pérez', address: 'Calle 2', commune: 'Maipú', closedAt: '2026-11-05T16:00:00.000Z', hasPhotos: true, photoCount: 2, shas: ['b', 'c'], hashes: ['', ''] },
    { id: 'P3', driverId: 'd2', driverName: 'Luis Rojas', driverStatus: 'APROBADO', receiverName: 'María', address: 'Calle 3', commune: 'Ñuñoa', closedAt: '2026-11-05T17:00:00.000Z', hasPhotos: false, photoCount: null, shas: null, hashes: null },
];
const Q = '?startDate=2026-11-03&endDate=2026-11-09';
const asUser = (id, role, over = {}) => { S.users[id] = { status: 'APROBADO', operatorPermissions: null, ...over }; return tokenFor(id, role); };
t('D1 un administrador ve el resumen: conductores, totales, cobertura y umbrales', async () => {
    S.rows = sampleRows();
    const res = await get('/api/reports/closure-quality' + Q, asUser('adm', 'ADMIN'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.drivers.map(d => d.name), ['Ana Soto', 'Luis Rojas']);
    assert.strictEqual(res.body.totals.closures, 3); assert.strictEqual(res.body.totals.identical, 1);
    assert.deepStrictEqual(res.body.coverage, { closures: 3, withPhotos: 2, scanned: 2, pending: 0 });
    assert.strictEqual(res.body.thresholds.similarBits, 8); assert.strictEqual(res.body.startDate, '2026-11-03');
    assert.deepStrictEqual(S.rowQueries[0], ['2026-11-03 02:00:00', '2026-11-10 02:00:00', 'Cierre automático (verificado en Mercado Libre)']);
});
t('D2 un operador ve el informe con los permisos de siempre o con canViewReports; sin ese permiso, no', async () => {
    S.rows = sampleRows();
    assert.strictEqual((await get('/api/reports/closure-quality' + Q, asUser('op1', 'OPERADOR_SISTEMAS'))).status, 200, 'sin permisos guardados');
    assert.strictEqual((await get('/api/reports/closure-quality' + Q, asUser('op2', 'OPERADOR_SISTEMAS', { operatorPermissions: { canViewReports: true, canManagePackages: false } }))).status, 200);
    assert.strictEqual((await get('/api/reports/closure-quality' + Q, asUser('op3', 'OPERADOR_SISTEMAS', { operatorPermissions: { canViewReports: false } }))).status, 403);
    assert.strictEqual((await get('/api/reports/closure-quality' + Q, asUser('op4', 'OPERADOR_SISTEMAS', { operatorPermissions: { canManagePackages: true } }))).status, 200, 'permiso no escrito = habilitado, como en el menú');
});
t('D3 conductor, cliente, facturación y retiros no ven nada; sin sesión da 401', async () => {
    S.rows = sampleRows();
    for (const role of ['DRIVER', 'CLIENT', 'FACTURACION', 'RETIROS', 'AUXILIAR']) assert.strictEqual((await get('/api/reports/closure-quality' + Q, asUser('u-' + role, role))).status, 403, role);
    assert.strictEqual((await get('/api/reports/closure-quality' + Q)).status, 401);
    assert.strictEqual(S.rowQueries.length, 0, 'ni siquiera se consultaron cierres');
});
t('D4 un perfil eliminado, deshabilitado o inexistente con sesión vigente tampoco lo ve', async () => {
    S.rows = sampleRows();
    for (const status of ['ELIMINADO', 'DESHABILITADO', 'PENDIENTE']) assert.strictEqual((await get('/api/reports/closure-quality' + Q, asUser('adm-' + status, 'ADMIN', { status }))).status, 403, status);
    assert.strictEqual((await get('/api/reports/closure-quality' + Q, tokenFor('fantasma', 'ADMIN'))).status, 403);
});
t('D5 fechas mal puestas: formato, orden y máximo de 31 días', async () => {
    const tk = asUser('adm', 'ADMIN');
    for (const q of ['', '?startDate=2026-11-03', '?startDate=hoy&endDate=ayer', '?startDate=2026-11-09&endDate=2026-11-03', '?startDate=2026-09-01&endDate=2026-11-09']) {
        const res = await get('/api/reports/closure-quality' + q, tk); assert.strictEqual(res.status, 400, q); assert.ok(res.body.message);
    }
    S.rows = [];
    assert.strictEqual((await get('/api/reports/closure-quality?startDate=2026-10-10&endDate=2026-11-09', tk)).status, 200, '31 días exactos');
    assert.strictEqual((await get('/api/reports/closure-quality?startDate=2026-10-09&endDate=2026-11-09', tk)).status, 400, '32 días');
});
t('D6 detalle de un conductor: casos, 400 sin driverId, 404 si no tiene cierres, 403 sin permiso', async () => {
    S.rows = sampleRows(); const tk = asUser('adm', 'ADMIN');
    const ok = await get('/api/reports/closure-quality/cases' + Q + '&driverId=d1', tk);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.cases.map(c => [c.packageId, c.kinds]), [['P1', ['NAME', 'SAME_FILE']]]);
    assert.strictEqual(ok.body.driver.name, 'Ana Soto'); assert.strictEqual(ok.body.totalCases, 1);
    assert.strictEqual((await get('/api/reports/closure-quality/cases' + Q, tk)).status, 400);
    assert.strictEqual((await get('/api/reports/closure-quality/cases' + Q + '&driverId=nadie', tk)).status, 404);
    assert.strictEqual((await get('/api/reports/closure-quality/cases' + Q + '&driverId=d1', asUser('dr', 'DRIVER'))).status, 403);
    assert.strictEqual((await get('/api/reports/closure-quality/cases' + Q + '&driverId=d1')).status, 401);
});
t('D7 el período se consulta una sola vez en 60 s (resumen y detalle lo comparten) y «refresh=1» fuerza otra consulta', async () => {
    S.rows = sampleRows(); const tk = asUser('adm', 'ADMIN'); const q = '?startDate=2026-11-01&endDate=2026-11-02';
    await get('/api/reports/closure-quality' + q, tk); await get('/api/reports/closure-quality/cases' + q + '&driverId=d1', tk); await get('/api/reports/closure-quality' + q, tk);
    assert.strictEqual(S.rowQueries.length, 1);
    await get('/api/reports/closure-quality' + q + '&refresh=1', tk);
    assert.strictEqual(S.rowQueries.length, 2);
    await get('/api/reports/closure-quality?startDate=2026-11-01&endDate=2026-11-03', tk);   // otro período = otra consulta
    assert.strictEqual(S.rowQueries.length, 3);
});

// ───────────── E. utilidades de la pantalla ─────────────
const driverRow = (over) => ({ driverId: 'x', name: 'Ana', status: 'APROBADO', closures: 100, nameBad: 0, nameBadPct: 0, nameBreakdown: { empty: 0, signs: 0, short: 0, filler: 0 }, withPhotos: 50, scanned: 50, pending: 0, reviewed: 40, identical: 0, recompressed: 0, sameImage: 0, similar: 0, reused: 0, flags: { name: false, photos: null }, score: 0, ...over });
t('E1 sortDrivers ordena por la columna pedida y desempata por gravedad y nombre', () => {
    const ui = tsModule('utils/closureReviewTypes.ts');
    const list = [driverRow({ driverId: 'a', name: 'Beta', closures: 10, score: 5 }), driverRow({ driverId: 'b', name: 'Alfa', closures: 30, score: 5 }), driverRow({ driverId: 'c', name: 'Ñandú', closures: 20, score: 9 })];
    assert.deepStrictEqual(ui.sortDrivers(list, 'closures', 'desc').map(d => d.driverId), ['b', 'c', 'a']);
    assert.deepStrictEqual(ui.sortDrivers(list, 'closures', 'asc').map(d => d.driverId), ['a', 'c', 'b']);
    assert.deepStrictEqual(ui.sortDrivers(list, 'name', 'asc').map(d => d.name), ['Alfa', 'Beta', 'Ñandú']);
    assert.deepStrictEqual(ui.sortDrivers(list, 'score', 'desc').map(d => d.driverId), ['c', 'b', 'a'], 'empate de score 5: gana el nombre Alfa');
    assert.deepStrictEqual(list.map(d => d.driverId), ['a', 'b', 'c'], 'no modifica la lista original');
});
t('E2 fechas: addDaysIso cruza mes y año sin depender de la zona horaria, daysInRange cuenta ambos extremos', () => {
    const ui = tsModule('utils/closureReviewTypes.ts');
    assert.strictEqual(ui.addDaysIso('2026-11-09', -13), '2026-10-27'); assert.strictEqual(ui.addDaysIso('2026-01-02', -5), '2025-12-28'); assert.strictEqual(ui.addDaysIso('2026-02-27', 2), '2026-03-01');
    assert.strictEqual(ui.addDaysIso('2026-04-04', 1), '2026-04-05', 'cambio de hora de abril'); assert.strictEqual(ui.addDaysIso('2026-09-05', 1), '2026-09-06', 'cambio de hora de septiembre');
    assert.strictEqual(ui.daysInRange('2026-10-27', '2026-11-09'), 14); assert.strictEqual(ui.daysInRange('2026-11-09', '2026-11-09'), 1); assert.ok(ui.daysInRange('2026-11-09', '2026-11-03') < 1);
});
t('E3 el CSV: separador «;», comillas escapadas, una fila por conductor, columnas alineadas y la lista que le tocó', () => {
    const ui = tsModule('utils/closureReviewTypes.ts');
    const report = { startDate: '2026-10-27', endDate: '2026-11-09', generatedAt: '', thresholds: {}, totals: {}, coverage: {}, both: [], drivers: [
        driverRow({ name: 'Ana "la Rápida"', nameBad: 12, nameBadPct: 12, nameBreakdown: { empty: 1, signs: 6, short: 4, filler: 1 }, flags: { name: true, photos: 'MAIN' }, identical: 2, recompressed: 1, sameImage: 3 }),
        driverRow({ name: 'Luis', flags: { name: false, photos: 'MINOR' } }), driverRow({ name: 'Eva' })] };
    const lines = ui.closureReviewCsv(report).split('\r\n');
    assert.strictEqual(lines.length, 4);
    const cols = (l) => l.split('";"').length; assert.ok(lines.every(l => cols(l) === cols(lines[0])), 'mismas columnas en todas las filas');
    assert.ok(lines[0].includes('Cierres (2026-10-27 a 2026-11-09)')); assert.ok(lines[1].startsWith('"Ana ""la Rápida"""'));
    assert.ok(lines[1].endsWith('"Nombre + Fotos"')); assert.ok(lines[2].endsWith('"Fotos (casos aislados)"')); assert.ok(lines[3].endsWith('""'));
    assert.strictEqual(ui.pctText(1, 3), '33 %'); assert.strictEqual(ui.pctText(0, 0), '—');
    assert.strictEqual(ui.hasFindings(driverRow({ flags: { name: false, photos: 'MINOR' } })), true); assert.strictEqual(ui.hasFindings(driverRow()), false);
});

// ───────────── F. conexión ─────────────
const text = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
t('F1 server.js crea la tabla de huellas y arranca el proceso de fondo; el servicio exporta start', () => {
    const server = text('server.js');
    assert.ok(/CREATE TABLE IF NOT EXISTS closure_photo_prints/.test(server) && /"packageId" TEXT PRIMARY KEY/.test(server) && /shas TEXT\[\]/.test(server) && /hashes TEXT\[\]/.test(server));
    assert.ok(/require\('\.\/services\/closurePhotoScanService'\)\.start\(/.test(server));
    const svc = require(path.join(ROOT, 'services/closurePhotoScanService.js')); assert.strictEqual(typeof svc.start, 'function'); assert.strictEqual(typeof svc.stop, 'function');
});
t('F2 la tabla guarda solo huellas: ninguna consulta del informe lee ni escribe las fotos en base64 salvo el escáner (una foto a la vez)', () => {
    const src = text('services/closureReview.js');
    const mentions = src.split('\n').filter(l => /deliveryPhotosBase64/.test(l) && !/^\s*\/\//.test(l));
    assert.ok(mentions.length === 3, 'solo el escáner (candidatos, lectura de una foto) y la marca hasPhotos: ' + mentions.length + ' → ' + mentions.join(' | '));
});
t('F3 menú y pantalla: administradores y operadores con permiso de reportes llegan a «Calidad de Cierres»', () => {
    const side = text('components/layout/Sidebar.tsx'); const dash = text('components/layout/DashboardLayout.tsx');
    assert.strictEqual((side.match(/id: 'closure-quality'/g) || []).length, 2, 'una entrada para el administrador y otra para el operador');
    assert.ok(/'meli-weekly-delivery', 'closure-quality'\]\.includes\(activeView\)/.test(side), 'abre el grupo Informes Operativos');
    assert.ok(/case 'closure-quality':\s*\n\s*if \(isAdmin \|\| \(isOp && permissions\?\.canViewReports\)\)/.test(dash));
    assert.ok(/import ClosureQualityReport from '..\/admin\/ClosureQualityReport'/.test(dash));
    const api = text('services/api.ts'); assert.ok(/\/reports\/closure-quality\?startDate=/.test(api) && /\/reports\/closure-quality\/cases\?startDate=/.test(api));
    assert.ok(/"jpeg-js"/.test(text('package.json')) && /"node_modules\/jpeg-js"/.test(text('package-lock.json')), 'jpeg-js declarado y en el lock (el Dockerfile usa npm ci)');
});

// ───────────── ejecución ─────────────
(async () => {
    const app = express(); app.use(express.json());
    const router = tryLoad('routes/reports.js');
    if (router) app.use('/api/reports', router);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    const log = console.log; let ok = 0; const fails = [];
    for (const [name, fn] of tests) {
        reset();
        if (/^D/.test(name)) console.log = () => {};
        try { await fn(); ok++; console.log = log; log('OK    ' + name); }
        catch (e) { console.log = log; fails.push(name); log('FALLA ' + name + '\n      ' + String(e.message).split('\n').slice(0, 3).join('\n      ') + (S.unknown.length ? '\n      consultas no previstas: ' + S.unknown.join(' | ') : '')); }
    }
    console.log = log;
    log(`\n${ok} de ${tests.length} pruebas OK`);
    server.close(); if (prints && prints.shutdown) await prints.shutdown();
    process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e.stack); process.exit(2); });
