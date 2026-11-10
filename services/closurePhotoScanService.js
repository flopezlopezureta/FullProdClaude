const db = require('../db');
const closureReview = require('./closureReview');

// Segundo plano del informe «Calidad de cierres»: saca las huellas de las fotos de los cierres de conductor (ver services/photoPrints.js) y las guarda en
// closure_photo_prints, para que el informe se arme en milisegundos sin volver a leer fotos de varios megas. Los cierres nuevos se procesan solos; al instalarse,
// pone al día los últimos SCAN_WINDOW_DAYS días (los más recientes primero) a ritmo suave. No toca el cierre de las entregas: solo lee fotos ya guardadas.
// Medido con datos reales (11-09): 34.588 cierres con fotos en 31 días (18.271 en 14); una foto mide 23 KB de mediana (p95 218 KB, máx 1,4 megapíxeles) y se decodifica en
// 23 ms de mediana (p95 110 ms). Con 12 cierres por vuelta y 1 s de pausa, los últimos 14 días quedan listos en cerca de 45 minutos y los 31 días en cerca de 1,5 horas.
const BATCH_SIZE = 12;                   // cierres por vuelta
const BUSY_PAUSE_MS = 1000;              // pausa entre vueltas mientras queden cierres por procesar
const IDLE_INTERVAL_MS = 5 * 60 * 1000;  // cuando no queda nada, se vuelve a mirar cada 5 minutos
const PURGE_EVERY_MS = 24 * 60 * 60 * 1000;

let running = false;
let timer = null;
let stopped = false;
let lastPurgeAt = 0;

function schedule(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
    if (typeof timer.unref === 'function') timer.unref();
}

async function tick() {
    if (running) return;
    running = true;
    let more = false;
    try {
        const result = await closureReview.scanBatch({ query: (text, params) => db.query(text, params), limit: BATCH_SIZE });
        more = result.more;
        if (result.scanned > 0) console.log(`[ClosurePhotoScan] ${result.scanned} cierres con fotos procesados${more ? ' (quedan más)' : ''}.`);
        if (Date.now() - lastPurgeAt > PURGE_EVERY_MS) {
            lastPurgeAt = Date.now();
            const removed = await closureReview.purgeOldPrints((text, params) => db.query(text, params));
            if (removed > 0) console.log(`[ClosurePhotoScan] ${removed} huellas antiguas eliminadas.`);
        }
    } catch (err) {
        console.error('[ClosurePhotoScan] Error procesando fotos de cierres:', err && err.message ? err.message : err);
    } finally {
        running = false;
    }
    schedule(more ? BUSY_PAUSE_MS : IDLE_INTERVAL_MS);
}

/** Arranca el proceso. `delayMs`: espera antes de la primera vuelta (deja que el servidor termine de arrancar). */
function start(delayMs = 60 * 1000) {
    stopped = false;
    schedule(delayMs);
}

function stop() {
    stopped = true;
    clearTimeout(timer);
}

module.exports = { start, stop, tick };
