const express = require('express');
const router = express.Router();
const http = require('http');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const networkMetrics = require('../services/networkMetrics');

const isSuperUserEmail = (email) => email === 'admin' || email === 'admin@admin.cl';
async function requireSuperUser(req, res, next) {
    try {
        const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user?.id]);
        if (isSuperUserEmail(rows[0]?.email)) return next();
    } catch (e) { /* falls through to 403 below */ }
    return res.status(403).json({ message: 'Solo el super admin puede ver el tráfico de red.' });
}

// Private/local ranges can't be geolocated and would just waste a lookup — includes Docker's
// internal bridge network (172.16-31.x) since health checks and internal calls show up as those.
function isPrivateIp(ip) {
    if (!ip) return true;
    const clean = ip.replace('::ffff:', '');
    return clean === '127.0.0.1' || clean === '::1' ||
        /^10\./.test(clean) || /^192\.168\./.test(clean) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean);
}

// Small in-memory cache — ip-api.com's free tier is rate-limited (45 req/min), and the same
// handful of driver/office IPs get looked up repeatedly every time the report is opened.
const ispCache = new Map(); // ip -> { isp, org, city, cachedAt }
const ISP_CACHE_TTL_MS = 30 * 60 * 1000;

function lookupIsp(ip) {
    return new Promise((resolve) => {
        const cached = ispCache.get(ip);
        if (cached && Date.now() - cached.cachedAt < ISP_CACHE_TTL_MS) return resolve(cached);
        if (isPrivateIp(ip)) return resolve({ isp: 'Red interna', org: null, city: null });

        // ip-api.com's free tier rejects HTTPS ("SSL unavailable for this endpoint") — plain HTTP only.
        const req = http.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,isp,org,city,query`, { timeout: 4000 }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const result = parsed.status === 'success'
                        ? { isp: parsed.isp || null, org: parsed.org || null, city: parsed.city || null, cachedAt: Date.now() }
                        : { isp: null, org: null, city: null, cachedAt: Date.now() };
                    ispCache.set(ip, result);
                    resolve(result);
                } catch (e) {
                    resolve({ isp: null, org: null, city: null });
                }
            });
        });
        req.on('error', () => resolve({ isp: null, org: null, city: null }));
        req.on('timeout', () => { req.destroy(); resolve({ isp: null, org: null, city: null }); });
    });
}

// Shared by /report (live, in-memory) and /history (persisted, per day): resolves ISP for the
// top 15 IPs and attaches the given usersById map, mutating each entry in place.
async function enrichByIp(byIpArray, usersById) {
    const topIps = byIpArray.slice(0, 15);
    await Promise.all(topIps.map(async (entry) => {
        const info = await lookupIsp(entry.ip);
        entry.isp = info.isp;
        entry.org = info.org;
        entry.city = info.city;
    }));
    for (const entry of byIpArray) {
        entry.users = (entry.userIds || []).map(id => usersById.get(id) || id);
        delete entry.userIds;
    }
}

async function resolveUserNames(userIds) {
    const usersById = new Map();
    const distinct = [...new Set(userIds.filter(Boolean))];
    if (distinct.length > 0) {
        const { rows } = await db.query('SELECT id, name FROM users WHERE id = ANY($1)', [distinct]);
        for (const u of rows) usersById.set(u.id, u.name || u.id);
    }
    return usersById;
}

// GET /api/network-metrics/history-days — which of the last 3 days actually have data, for the
// day picker on the frontend (no point offering a day with nothing recorded).
router.get('/history-days', authMiddleware, requireSuperUser, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT date, SUM("requestCount")::int AS "requestCount" FROM network_traffic_daily
             WHERE date >= (CURRENT_DATE - INTERVAL '3 days')
             GROUP BY date ORDER BY date DESC`
        );
        // node-postgres parses a DATE column into a JS Date at UTC midnight of that calendar day —
        // res.json() then serializes it as a full ISO timestamp ("2026-08-16T04:00:00.000Z"), not
        // the plain YYYY-MM-DD the frontend day-picker and /history's ?date= param expect.
        res.json({ days: rows.map(r => ({ date: r.date.toISOString().slice(0, 10), requestCount: r.requestCount })) });
    } catch (e) {
        res.status(500).json({ message: 'No se pudo cargar el historial de días.', error: e.message });
    }
});

// GET /api/network-metrics/history?date=YYYY-MM-DD — persisted per-day traffic (up to 3 days
// back, enforced by the retention purge in services/networkMetrics.js, not just this query).
router.get('/history', authMiddleware, requireSuperUser, async (req, res) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ message: 'Parámetro "date" inválido (esperado YYYY-MM-DD).' });
    }
    try {
        const { rows } = await db.query(
            `SELECT ip, "requestCount", "totalMs", "maxMs", "errorCount", "userIds", "firstSeen", "lastSeen"
             FROM network_traffic_daily WHERE date = $1 AND date >= (CURRENT_DATE - INTERVAL '3 days')`,
            [date]
        );
        if (rows.length === 0) {
            return res.json({ byIp: [], totalRecords: 0, date });
        }

        const allUserIds = rows.flatMap(r => r.userIds || []);
        const usersById = await resolveUserNames(allUserIds);

        const byIpArray = rows
            .map(r => ({
                ip: r.ip,
                requestCount: r.requestCount,
                avgMs: Math.round(r.totalMs / r.requestCount),
                maxMs: r.maxMs,
                errorRate: Math.round((r.errorCount / r.requestCount) * 1000) / 10,
                errorCount: r.errorCount,
                firstSeen: new Date(r.firstSeen).getTime(),
                lastSeen: new Date(r.lastSeen).getTime(),
                userIds: r.userIds || [],
            }))
            .sort((a, b) => (b.avgMs * (1 + b.errorRate / 100)) - (a.avgMs * (1 + a.errorRate / 100)));

        await enrichByIp(byIpArray, usersById);

        res.json({
            byIp: byIpArray,
            totalRecords: byIpArray.reduce((sum, e) => sum + e.requestCount, 0),
            date,
        });
    } catch (e) {
        res.status(500).json({ message: 'No se pudo cargar el historial de ese día.', error: e.message });
    }
});

// GET /api/network-metrics/report
router.get('/report', authMiddleware, requireSuperUser, async (req, res) => {
    const records = networkMetrics.getRecords();

    if (records.length === 0) {
        return res.json({ byIp: [], byHour: [], totalRecords: 0, windowStart: null, windowEnd: null });
    }

    // --- Agrupado por IP ---
    const byIpMap = new Map();
    for (const r of records) {
        const key = r.ip || 'desconocida';
        if (!byIpMap.has(key)) {
            byIpMap.set(key, { ip: key, requestCount: 0, totalMs: 0, maxMs: 0, errorCount: 0, firstSeen: r.ts, lastSeen: r.ts, userIds: new Set() });
        }
        const entry = byIpMap.get(key);
        entry.requestCount++;
        entry.totalMs += r.durationMs;
        entry.maxMs = Math.max(entry.maxMs, r.durationMs);
        if (r.statusCode >= 400 || r.statusCode === 0) entry.errorCount++;
        entry.firstSeen = Math.min(entry.firstSeen, r.ts);
        entry.lastSeen = Math.max(entry.lastSeen, r.ts);
        if (r.userId) entry.userIds.add(r.userId);
    }

    // Resuelve nombre de todos los usuarios vistos, en una sola consulta — permite mostrar qué
    // admin/conductor generó el tráfico de cada IP (varios pueden compartir la misma wifi).
    const usersById = await resolveUserNames(records.map(r => r.userId));

    const byIpArray = Array.from(byIpMap.values())
        .map(e => ({
            ip: e.ip,
            requestCount: e.requestCount,
            avgMs: Math.round(e.totalMs / e.requestCount),
            maxMs: e.maxMs,
            errorRate: Math.round((e.errorCount / e.requestCount) * 1000) / 10,
            errorCount: e.errorCount,
            firstSeen: e.firstSeen,
            lastSeen: e.lastSeen,
            userIds: [...e.userIds],
        }))
        .sort((a, b) => (b.avgMs * (1 + b.errorRate / 100)) - (a.avgMs * (1 + a.errorRate / 100)));

    // Solo se consulta el ISP de las IPs con más tráfico, para no gastar el límite de la API gratuita.
    await enrichByIp(byIpArray, usersById);

    // --- Agrupado por hora del día (para ver si coincide con horas pico) ---
    const byHourMap = new Map();
    for (let h = 0; h < 24; h++) byHourMap.set(h, { hour: h, requestCount: 0, totalMs: 0, errorCount: 0 });
    for (const r of records) {
        const hour = new Date(r.ts).getHours();
        const entry = byHourMap.get(hour);
        entry.requestCount++;
        entry.totalMs += r.durationMs;
        if (r.statusCode >= 400 || r.statusCode === 0) entry.errorCount++;
    }
    const byHourArray = Array.from(byHourMap.values()).map(e => ({
        hour: e.hour,
        requestCount: e.requestCount,
        avgMs: e.requestCount > 0 ? Math.round(e.totalMs / e.requestCount) : 0,
        errorRate: e.requestCount > 0 ? Math.round((e.errorCount / e.requestCount) * 1000) / 10 : 0,
    }));

    res.json({
        byIp: byIpArray,
        byHour: byHourArray,
        totalRecords: records.length,
        windowStart: Math.min(...records.map(r => r.ts)),
        windowEnd: Math.max(...records.map(r => r.ts)),
    });
});

// GET /api/network-metrics/search?path=/auth/register&from=2026-08-21T00:00:00Z&to=2026-08-22T00:00:00Z
// Per-request lookup (path included) against request_log_recent — see server.js's comment on
// that table for why it exists: network_traffic_daily alone couldn't answer "which IP hit this
// specific endpoint at this specific time" during the 2026-08-22 incident. 7-day window only
// (purgeOldRequestLogs in services/networkMetrics.js), by design — not a permanent audit log.
router.get('/search', authMiddleware, requireSuperUser, async (req, res) => {
    const { path, from, to } = req.query;
    if (!path && !from && !to) {
        return res.status(400).json({ message: 'Especifica al menos "path", "from" o "to".' });
    }
    try {
        const conditions = [`"timestamp" >= (NOW() - INTERVAL '7 days')`];
        const values = [];
        if (path) {
            values.push(`%${path}%`);
            conditions.push(`path ILIKE $${values.length}`);
        }
        if (from) {
            values.push(from);
            conditions.push(`"timestamp" >= $${values.length}`);
        }
        if (to) {
            values.push(to);
            conditions.push(`"timestamp" <= $${values.length}`);
        }
        const { rows } = await db.query(
            `SELECT "timestamp", ip, method, path, "statusCode", "durationMs", "userId"
             FROM request_log_recent WHERE ${conditions.join(' AND ')}
             ORDER BY "timestamp" ASC LIMIT 500`,
            values
        );
        res.json({ results: rows, count: rows.length });
    } catch (e) {
        res.status(500).json({ message: 'Error al buscar en el registro de peticiones.', error: e.message });
    }
});

module.exports = router;
