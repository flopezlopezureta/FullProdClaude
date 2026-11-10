// Hilo aparte que decodifica fotos y saca su huella visual (ver services/photoPrints.js). Recibe { id, bytes } y responde { id, hash } (hash = null si no pudo).
const { parentPort } = require('worker_threads');
const prints = require('./photoPrints');

if (parentPort) {
    parentPort.on('message', (msg) => {
        let hash = null;
        try { hash = prints.hashOfJpeg(Buffer.from(msg.bytes)); } catch (e) { hash = null; }
        parentPort.postMessage({ id: msg.id, hash });
    });
}
