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
            byIpMap.set(key, { ip: key, requestCount: 0, totalMs: 0, maxMs: 0, errorCount: 0, firstSeen: r.ts, lastSeen: r.ts });
        }
        const entry = byIpMap.get(key);
        entry.requestCount++;
        entry.totalMs += r.durationMs;
        entry.maxMs = Math.max(entry.maxMs, r.durationMs);
        if (r.statusCode >= 400 || r.statusCode === 0) entry.errorCount++;
        entry.firstSeen = Math.min(entry.firstSeen, r.ts);
        entry.lastSeen = Math.max(entry.lastSeen, r.ts);
    }

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
        }))
        .sort((a, b) => (b.avgMs * (1 + b.errorRate / 100)) - (a.avgMs * (1 + a.errorRate / 100)));

    // Solo se consulta el ISP de las IPs con más tráfico, para no gastar el límite de la API gratuita.
    const topIps = byIpArray.slice(0, 15);
    await Promise.all(topIps.map(async (entry) => {
        const info = await lookupIsp(entry.ip);
        entry.isp = info.isp;
        entry.org = info.org;
        entry.city = info.city;
    }));

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

module.exports = router;
