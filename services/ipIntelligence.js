const http = require('http');

// Same private-range check as routes/networkMetrics.js (kept separate on purpose — this module
// has a narrower job: "is this IP a VPN/proxy/hosting provider", not general ISP enrichment).
function isPrivateIp(ip) {
    if (!ip) return true;
    const clean = ip.replace('::ffff:', '');
    return clean === '127.0.0.1' || clean === '::1' ||
        /^10\./.test(clean) || /^192\.168\./.test(clean) ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean);
}

// ip-api.com free tier, same as networkMetrics.js — separate small cache so this module doesn't
// depend on that route file, and a lookup failure here can never affect the traffic panel or
// vice versa. Fails OPEN (isVpn: false) on any error/timeout/rate-limit: a broken third-party
// lookup must never be able to lock every driver out of the app.
const cache = new Map(); // ip -> { isVpn, cachedAt }
const CACHE_TTL_MS = 30 * 60 * 1000;

function checkVpnOrProxy(ip) {
    return new Promise((resolve) => {
        if (isPrivateIp(ip)) return resolve({ isVpn: false });

        const cached = cache.get(ip);
        if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return resolve(cached);

        const req = http.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,proxy,hosting,query`, { timeout: 4000 }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    const result = {
                        isVpn: parsed.status === 'success' && (parsed.proxy === true || parsed.hosting === true),
                        cachedAt: Date.now(),
                    };
                    cache.set(ip, result);
                    resolve(result);
                } catch (e) {
                    resolve({ isVpn: false });
                }
            });
        });
        req.on('error', () => resolve({ isVpn: false }));
        req.on('timeout', () => { req.destroy(); resolve({ isVpn: false }); });
    });
}

module.exports = { checkVpnOrProxy };
