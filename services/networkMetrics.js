// In-memory rolling log of HTTP requests, used to build the super-admin "Tráfico de Red" report.
// This "live" buffer is deliberately not persisted to the DB — it's a diagnostic tool, and it
// resets on every deploy, which is fine for "what's happening right now". For a real day-to-day
// history (up to 3 days back), flushToDaily() periodically rolls it up into the persisted
// network_traffic_daily table (per-IP daily totals, not raw per-request rows — that would grow
// unbounded), and purgeOldDays() enforces the 3-day retention.
const db = require('../db');

const MAX_RECORDS = 8000;
const records = [];
let lastFlushedTs = 0;

function recordRequest({ ip, method, path, statusCode, durationMs, userId }) {
    records.push({ ts: Date.now(), ip, method, path, statusCode, durationMs, userId: userId || null });
    if (records.length > MAX_RECORDS) records.shift();
}

function getRecords() {
    return records;
}

async function flushToDaily() {
    const toFlush = records.filter(r => r.ts > lastFlushedTs);
    const flushedThrough = Date.now();
    if (toFlush.length === 0) { lastFlushedTs = flushedThrough; return; }

    // Bucket by calendar day in the system's configured timezone, matching how "today" is
    // resolved everywhere else in the app (process.env.SYSTEM_TZ, set from system_settings).
    const groups = new Map();
    for (const r of toFlush) {
        const dateStr = new Date(r.ts).toLocaleDateString('en-CA', { timeZone: process.env.SYSTEM_TZ || undefined }); // en-CA => YYYY-MM-DD
        const ip = r.ip || 'desconocida';
        const key = `${dateStr}|${ip}`;
        if (!groups.has(key)) {
            groups.set(key, { date: dateStr, ip, requestCount: 0, totalMs: 0, maxMs: 0, errorCount: 0, userIds: new Set(), firstSeen: r.ts, lastSeen: r.ts });
        }
        const g = groups.get(key);
        g.requestCount++;
        g.totalMs += r.durationMs;
        g.maxMs = Math.max(g.maxMs, r.durationMs);
        if (r.statusCode >= 400 || r.statusCode === 0) g.errorCount++;
        if (r.userId) g.userIds.add(r.userId);
        g.firstSeen = Math.min(g.firstSeen, r.ts);
        g.lastSeen = Math.max(g.lastSeen, r.ts);
    }

    for (const g of groups.values()) {
        try {
            await db.query(
                `INSERT INTO network_traffic_daily (date, ip, "requestCount", "totalMs", "maxMs", "errorCount", "userIds", "firstSeen", "lastSeen")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (date, ip) DO UPDATE SET
                   "requestCount" = network_traffic_daily."requestCount" + EXCLUDED."requestCount",
                   "totalMs" = network_traffic_daily."totalMs" + EXCLUDED."totalMs",
                   "maxMs" = GREATEST(network_traffic_daily."maxMs", EXCLUDED."maxMs"),
                   "errorCount" = network_traffic_daily."errorCount" + EXCLUDED."errorCount",
                   "userIds" = ARRAY(SELECT DISTINCT unnest(network_traffic_daily."userIds" || EXCLUDED."userIds")),
                   "firstSeen" = LEAST(network_traffic_daily."firstSeen", EXCLUDED."firstSeen"),
                   "lastSeen" = GREATEST(network_traffic_daily."lastSeen", EXCLUDED."lastSeen")`,
                [g.date, g.ip, g.requestCount, g.totalMs, g.maxMs, g.errorCount, [...g.userIds], new Date(g.firstSeen), new Date(g.lastSeen)]
            );
        } catch (e) {
            console.error('[NetworkMetrics] Failed to flush daily aggregate:', g.date, g.ip, e.message);
        }
    }
    lastFlushedTs = flushedThrough;
}

async function purgeOldDays() {
    try {
        await db.query(`DELETE FROM network_traffic_daily WHERE date < (CURRENT_DATE - INTERVAL '3 days')`);
    } catch (e) {
        console.error('[NetworkMetrics] Failed to purge old daily traffic rows:', e.message);
    }
}

// Bulk-inserts the same records flushToDaily just aggregated, but as individual rows (path
// included) — see the request_log_recent comment in server.js for why. Shares flushToDaily's
// "only records newer than lastFlushedTs" filter deliberately, so both writes stay in sync and
// nothing gets double-logged on the next tick.
async function flushRequestLog(toFlush) {
    if (toFlush.length === 0) return;
    try {
        const values = [];
        const placeholders = toFlush.map((r, i) => {
            const base = i * 7;
            values.push(new Date(r.ts), r.ip || null, r.method || null, r.path || null, r.statusCode ?? null, r.durationMs ?? null, r.userId || null);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        }).join(', ');
        await db.query(
            `INSERT INTO request_log_recent ("timestamp", ip, method, path, "statusCode", "durationMs", "userId") VALUES ${placeholders}`,
            values
        );
    } catch (e) {
        console.error('[NetworkMetrics] Failed to flush request_log_recent:', e.message);
    }
}

async function purgeOldRequestLogs() {
    try {
        await db.query(`DELETE FROM request_log_recent WHERE "timestamp" < (NOW() - INTERVAL '7 days')`);
    } catch (e) {
        console.error('[NetworkMetrics] Failed to purge old request_log_recent rows:', e.message);
    }
}

function start(intervalMs = 10 * 60 * 1000) {
    setInterval(() => {
        // Both reads happen before flushToDaily moves lastFlushedTs forward, so they see the
        // exact same batch of new records.
        const toFlush = records.filter(r => r.ts > lastFlushedTs);
        flushToDaily().catch(e => console.error('[NetworkMetrics] Error in flushToDaily:', e.message));
        flushRequestLog(toFlush).catch(e => console.error('[NetworkMetrics] Error in flushRequestLog:', e.message));
        purgeOldDays().catch(e => console.error('[NetworkMetrics] Error in purgeOldDays:', e.message));
        purgeOldRequestLogs().catch(e => console.error('[NetworkMetrics] Error in purgeOldRequestLogs:', e.message));
    }, intervalMs);
}

module.exports = { recordRequest, getRecords, flushToDaily, purgeOldDays, purgeOldRequestLogs, start, MAX_RECORDS };
