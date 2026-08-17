// In-memory rolling log of HTTP requests, used to build the super-admin "Tráfico de Red" report.
// Deliberately not persisted to the DB — this is a diagnostic tool (is a client's own network
// flaky, not a system-of-record), and an in-memory ring buffer is enough for that; it resets on
// deploy, which is fine since each deploy is a natural "start a fresh window" point anyway.
const MAX_RECORDS = 8000;
const records = [];

function recordRequest({ ip, method, path, statusCode, durationMs, userId }) {
    records.push({ ts: Date.now(), ip, method, path, statusCode, durationMs, userId: userId || null });
    if (records.length > MAX_RECORDS) records.shift();
}

function getRecords() {
    return records;
}

module.exports = { recordRequest, getRecords, MAX_RECORDS };
