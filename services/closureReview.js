// Informe «Calidad de cierres»: qué conductores cierran las entregas con un nombre de quien recibe sin sentido («.», una letra…) o con fotos de evidencia repetidas.
// Es el informe que se hizo a mano el 2026-11-04 (PDF por conductor), ahora dentro de la app para que el operador lo consulte cuando quiera.
//
// Qué cuenta como «cierre de conductor»: un paquete ENTREGADO con conductor, que NO sea un «Cierre automático (verificado en Mercado Libre)» (ese lo cierra el sistema,
// no el conductor). La hora del cierre es la del evento ENTREGADO de tracking_events (igual que Cronometría: updatedAt se mueve cuando otros procesos tocan el paquete).
//
// Nombre: la misma regla del formulario del conductor (services/receiverName.js).
// Fotos (de las huellas que calcula services/closurePhotoScanService.js, tabla closure_photo_prints):
//   · «mismo archivo»  — dos fotos del mismo cierre con los mismos bytes.
//   · «misma imagen»   — la misma foto recomprimida (huellas visuales a ≤ 2 bits de 63).
//   · «muy parecidas»  — dos tomas casi iguales del mismo cierre (3 a 8 bits: el umbral del formulario). Evidencia más débil: conviene mirar las fotos.
//   · «reutilizada»    — el mismo archivo usado por el mismo conductor en OTRA dirección (varios paquetes de la misma parada no cuentan).

const receiverNames = require('./receiverName');
const prints = require('./photoPrints');

const AUTO_CLOSURE_NAME = 'Cierre automático (verificado en Mercado Libre)';
const MAX_RANGE_DAYS = 31;
const SCAN_WINDOW_DAYS = 31;

// Cuándo un conductor queda en las listas del informe (los umbrales del PDF del 4-nov).
const THRESHOLDS = Object.freeze({
    sameBits: prints.SAME_IMAGE_BITS, similarBits: prints.SIMILAR_BITS,
    nameMinCount: 3, namePercent: 10,          // nombre sin sentido: al menos 3 cierres Y 10 % de los suyos
    photoSame: 3, photoSimilar: 5, photoReuse: 3, // fotos: 3 «misma imagen», o 5 «muy parecidas», o 3 reutilizadas
});

const MAX_CASES_PER_DRIVER = 400;
const MAX_REUSE_EXAMPLES = 3;

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** «Av. Los Leones 1234, Depto 56» y «Av. Los Leones 1234 depto 77» son la misma parada (mismo edificio): sin depto/casa/torre… ni lo que va tras la primera coma. */
function stopKey(address, commune) {
    const street = fold(address).split(',')[0]
        .replace(/\b(depto|dpto|departamento|casa|oficina|of|torre|piso|local|block|bloque)\b.*$/, '')
        .replace(/[#.]/g, ' ').replace(/\s+/g, ' ').trim();
    return `${street}|${fold(commune).trim()}`;
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

/** Menor distancia (en bits) entre las huellas visuales de una lista; null si hay menos de dos huellas. */
function minBitsBetween(hashes) {
    const list = hashes.filter(Boolean);
    let min = null;
    for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < i; j++) {
            const d = prints.bitDistance(list[i], list[j]);
            if (min === null || d < min) min = d;
        }
    }
    return min;
}

/** ¿Hay dos fotos con los mismos bytes en la lista? (las fotos sin contenido, sha vacía, no cuentan). */
const hasRepeatedFile = (shas) => {
    const real = shas.filter(Boolean);
    return new Set(real).size < real.length;
};

const asList = (v) => (Array.isArray(v) ? v : []);

/**
 * Analiza los cierres de UN conductor. `closures`: { id, receiverName, address, commune, closedAt, hasPhotos, photoCount, shas, hashes }
 * (shas/hashes null = las fotos aún no se han procesado). Devuelve { stats, cases }.
 */
function analyzeDriver(closures, T = THRESHOLDS) {
    const stats = {
        closures: closures.length, nameBad: 0, nameBreakdown: { empty: 0, signs: 0, short: 0, filler: 0 },
        withPhotos: 0, scanned: 0, pending: 0, reviewed: 0, identical: 0, recompressed: 0, similar: 0, reused: 0,
    };
    const cases = new Map();
    const caseOf = (c) => {
        if (!cases.has(c.id)) {
            cases.set(c.id, { packageId: c.id, closedAt: c.closedAt, receiverName: c.receiverName || '', address: c.address || '', commune: c.commune || '', photoCount: c.photoCount || 0, kinds: [], minBits: null, reusedWith: [] });
        }
        return cases.get(c.id);
    };

    // mismo archivo en otros cierres del conductor (para detectar la reutilización en otra dirección)
    const withStop = closures.map(c => ({ ...c, stop: stopKey(c.address, c.commune) }));
    const byFile = new Map();
    for (const c of withStop) {
        for (const sha of new Set(asList(c.shas).filter(Boolean))) {
            if (!byFile.has(sha)) byFile.set(sha, []);
            byFile.get(sha).push(c);
        }
    }

    for (const c of withStop) {
        const problem = receiverNames.receiverNameProblem(c.receiverName);
        if (problem) {
            stats.nameBad++;
            if (problem === 'EMPTY') stats.nameBreakdown.empty++;
            else if (problem === 'NO_LETTERS') stats.nameBreakdown.signs++;
            else if (problem === 'TOO_SHORT') stats.nameBreakdown.short++;
            else stats.nameBreakdown.filler++;
            caseOf(c).kinds.push('NAME');
        }

        if (c.hasPhotos) stats.withPhotos++;
        if (c.shas == null) { if (c.hasPhotos) stats.pending++; continue; }
        if (c.hasPhotos) stats.scanned++;   // «procesados» se mide contra «con fotos»: nunca puede pasar del 100 %
        const shas = asList(c.shas);
        const hashes = asList(c.hashes);

        if (shas.length >= 2) {
            stats.reviewed++;
            const min = minBitsBetween(hashes);
            if (hasRepeatedFile(shas)) { stats.identical++; const k = caseOf(c); k.kinds.push('SAME_FILE'); k.minBits = 0; }
            else if (min !== null && min <= T.sameBits) { stats.recompressed++; const k = caseOf(c); k.kinds.push('SAME_IMAGE'); k.minBits = min; }
            else if (min !== null && min <= T.similarBits) { stats.similar++; const k = caseOf(c); k.kinds.push('SIMILAR'); k.minBits = min; }
        }

        // el mismo archivo ya usado por este conductor en otra dirección
        const others = [];
        for (const sha of new Set(shas.filter(Boolean))) {
            for (const o of byFile.get(sha) || []) if (o.id !== c.id && o.stop !== c.stop && !others.some(x => x.id === o.id)) others.push(o);
        }
        if (others.length) {
            stats.reused++;
            const k = caseOf(c);
            k.kinds.push('REUSED');
            k.reusedWith = others.sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt)).slice(0, MAX_REUSE_EXAMPLES)
                .map(o => ({ packageId: o.id, closedAt: o.closedAt, address: o.address || '', commune: o.commune || '' }));
        }
    }

    const ordered = [...cases.values()].sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
    return { stats, cases: ordered };
}

/** Resumen y banderas de un conductor a partir de sus cifras. */
function summarizeDriver(base, stats, T = THRESHOLDS) {
    const sameImage = stats.identical + stats.recompressed;
    const nameFlag = stats.nameBad >= T.nameMinCount && pct(stats.nameBad, stats.closures) >= T.namePercent;
    const photoMain = sameImage >= T.photoSame || stats.similar >= T.photoSimilar || stats.reused >= T.photoReuse;
    const photoAny = sameImage + stats.similar + stats.reused > 0;
    return {
        ...base, ...stats, sameImage,
        nameBadPct: pct(stats.nameBad, stats.closures),
        flags: { name: nameFlag, photos: photoMain ? 'MAIN' : (photoAny ? 'MINOR' : null) },
        score: stats.nameBad + sameImage * 3 + stats.similar + stats.reused,   // para ordenar: la misma imagen pesa el triple
    };
}

/**
 * Informe completo a partir de las filas de cierres (ver fetchClosures). Puro: sin base de datos.
 * Devuelve { drivers, totals, coverage, both } con los conductores ordenados de mayor a menor gravedad.
 */
function buildReport(rows, T = THRESHOLDS) {
    const byDriver = new Map();
    for (const r of rows) {
        if (!byDriver.has(r.driverId)) byDriver.set(r.driverId, []);
        byDriver.get(r.driverId).push(r);
    }
    const drivers = [];
    for (const [driverId, list] of byDriver) {
        const { stats } = analyzeDriver(list, T);
        drivers.push(summarizeDriver({ driverId, name: list[0].driverName || '(sin nombre)', status: list[0].driverStatus || null }, stats, T));
    }
    drivers.sort((a, b) => (b.score - a.score) || (b.closures - a.closures) || a.name.localeCompare(b.name, 'es'));

    const sum = (f) => drivers.reduce((n, d) => n + f(d), 0);
    const totals = {
        drivers: drivers.length, closures: sum(d => d.closures), nameBad: sum(d => d.nameBad), reviewed: sum(d => d.reviewed),
        sameImage: sum(d => d.sameImage), identical: sum(d => d.identical), similar: sum(d => d.similar), reused: sum(d => d.reused),
        flaggedName: drivers.filter(d => d.flags.name).length, flaggedPhotos: drivers.filter(d => d.flags.photos === 'MAIN').length,
    };
    totals.nameBadPct = pct(totals.nameBad, totals.closures);
    const coverage = { closures: totals.closures, withPhotos: sum(d => d.withPhotos), scanned: sum(d => d.scanned), pending: sum(d => d.pending) };
    const both = drivers.filter(d => d.flags.name && d.flags.photos !== null).map(d => d.name);
    return { drivers, totals, coverage, both };
}

/** Casos (cierres con hallazgos) de un conductor, del más reciente al más antiguo. */
function buildDriverCases(rows, driverId, T = THRESHOLDS) {
    const list = rows.filter(r => r.driverId === driverId);
    if (!list.length) return null;
    const { stats, cases } = analyzeDriver(list, T);
    const driver = summarizeDriver({ driverId, name: list[0].driverName || '(sin nombre)', status: list[0].driverStatus || null }, stats, T);
    return { driver, cases: cases.slice(0, MAX_CASES_PER_DRIVER), truncated: cases.length > MAX_CASES_PER_DRIVER, totalCases: cases.length };
}

// ───────────── base de datos ─────────────

/**
 * Cierres de conductor cuya hora de entrega cae en [start, end). `query(text, params)` = db.query.
 * Misma forma de elegir la hora que services/driverMetrics.js (evento ENTREGADO; updatedAt solo si no hay evento) y mismo tope de +3 días para acotar la consulta.
 */
async function fetchClosures(query, start, end) {
    const { rows } = await query(
        // MATERIALIZED: sin eso Postgres repite la subconsulta de la hora del evento cada vez que el SELECT usa «ev_at» (medido: el doble de lecturas de tracking_events)
        `WITH cand AS MATERIALIZED (
            SELECT p.id, p."driverId", p."deliveryReceiverName" AS "receiverName", p."recipientAddress" AS address, p."recipientCommune" AS commune,
                   p."updatedAt", (p."deliveryPhotosBase64" IS NOT NULL) AS "hasPhotos",
                   (SELECT MAX(te.timestamp) FROM tracking_events te WHERE te."packageId" = p.id AND te.status = 'ENTREGADO') AS ev_at
            FROM packages p
            WHERE p.status = 'ENTREGADO'
              AND p."driverId" IS NOT NULL
              AND COALESCE(p."deliveryReceiverName", '') <> $3
              AND p."updatedAt" >= $1::timestamptz
              AND p."updatedAt" < ($2::timestamptz + INTERVAL '3 days')
        )
        SELECT c.id, c."driverId", u.name AS "driverName", u.status AS "driverStatus", c."receiverName", c.address, c.commune,
               COALESCE(c.ev_at, c."updatedAt") AS "closedAt", c."hasPhotos",
               f."photoCount", f.shas, f.hashes
        FROM cand c
        LEFT JOIN users u ON u.id = c."driverId"
        LEFT JOIN closure_photo_prints f ON f."packageId" = c.id
        WHERE COALESCE(c.ev_at, c."updatedAt") >= $1::timestamptz
          AND COALESCE(c.ev_at, c."updatedAt") < $2::timestamptz`,
        [start, end, AUTO_CLOSURE_NAME]
    );
    return rows.map(r => ({ ...r, closedAt: new Date(r.closedAt), shas: r.shas == null ? null : r.shas, hashes: r.hashes == null ? null : r.hashes }));
}

/** Informe de un período: { range, thresholds, ...buildReport }. */
async function buildClosureReview({ query, start, end, startDate, endDate }) {
    const rows = await fetchClosures(query, start, end);
    return { startDate, endDate, generatedAt: new Date().toISOString(), thresholds: THRESHOLDS, ...buildReport(rows) };
}

async function buildDriverCaseList({ query, start, end, startDate, endDate, driverId }) {
    const rows = await fetchClosures(query, start, end);
    const result = buildDriverCases(rows, driverId);
    if (!result) return null;
    return { startDate, endDate, thresholds: THRESHOLDS, ...result };
}

/**
 * Procesa hasta `limit` cierres con fotos que aún no tienen huellas (los más recientes primero) y guarda sus huellas.
 * Devuelve { scanned, more } (more = puede haber más por procesar).
 */
async function scanBatch({ query, limit = 8, windowDays = SCAN_WINDOW_DAYS, hash = prints.printsOfPhotos }) {
    const { rows: candidates } = await query(
        `SELECT p.id
         FROM packages p
         LEFT JOIN closure_photo_prints f ON f."packageId" = p.id
         WHERE p.status = 'ENTREGADO'
           AND p."driverId" IS NOT NULL
           AND p."deliveryPhotosBase64" IS NOT NULL
           AND p."updatedAt" >= NOW() - make_interval(days => $1::int)
           AND f."packageId" IS NULL
         ORDER BY p."updatedAt" DESC
         LIMIT $2`,
        [windowDays, limit]
    );
    let scanned = 0;
    for (const { id } of candidates) {
        const { rows } = await query('SELECT "deliveryPhotosBase64" AS photos FROM packages WHERE id = $1', [id]);
        const photos = prints.asPhotoList(rows[0] ? rows[0].photos : null);
        // la huella visual compara las fotos de UNA entrega entre sí: con una sola foto no hace falta
        const { shas, hashes } = await hash(photos, { withHash: photos.length >= 2 });
        await query(
            `INSERT INTO closure_photo_prints ("packageId", "photoCount", shas, hashes) VALUES ($1, $2, $3, $4) ON CONFLICT ("packageId") DO NOTHING`,
            [id, photos.length, shas, hashes]
        );
        scanned++;
    }
    return { scanned, more: candidates.length === limit };
}

/** Borra las huellas más viejas que el período que el informe puede consultar (con margen). */
async function purgeOldPrints(query, keepDays = 120) {
    const { rowCount } = await query(`DELETE FROM closure_photo_prints WHERE "scannedAt" < NOW() - make_interval(days => $1::int)`, [keepDays]);
    return rowCount || 0;
}

module.exports = {
    AUTO_CLOSURE_NAME, MAX_RANGE_DAYS, SCAN_WINDOW_DAYS, THRESHOLDS,
    stopKey, minBitsBetween, hasRepeatedFile, analyzeDriver, summarizeDriver, buildReport, buildDriverCases,
    fetchClosures, buildClosureReview, buildDriverCaseList, scanBatch, purgeOldPrints,
};
