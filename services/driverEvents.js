const EventEmitter = require('events');

// Lightweight in-process pub/sub for pushing real-time signals to a driver's
// connected SSE stream(s). Purely additive: nothing else in the app depends
// on this, so a missing/failed emit never breaks existing polling-based flows.
const bus = new EventEmitter();
bus.setMaxListeners(0);

function emitDriverEvent(driverId, payload) {
    if (!driverId) return;
    bus.emit(`driver:${driverId}`, payload);
}

module.exports = { bus, emitDriverEvent };
