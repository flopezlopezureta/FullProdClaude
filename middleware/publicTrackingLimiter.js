const net = require('net');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/**
 * Límites de peticiones para el seguimiento PÚBLICO (GET /api/packages/public/track/:id), que no exige sesión.
 *
 * La ruta no exige sesión, así que se limita cuánto puede consultar una misma IP. Se aplican DOS contadores independientes por visitante:
 *   - requests: todas las consultas de una IP. Holgado a propósito: la pantalla de seguimiento consulta cada 30 s mientras el
 *     paquete va en camino (2 por minuto por pestaña abierta), y varios compradores pueden compartir una IP (oficina, red móvil).
 *   - misses: SOLO las consultas que no encuentran nada (404) o son rechazadas. Es la señal de alguien que adivina códigos: un
 *     comprador real casi nunca falla más de un par de veces. `skipSuccessfulRequests` hace que las consultas exitosas NO gasten este
 *     contador, de modo que un comprador con la pantalla abierta mucho rato nunca se bloquea por esto.
 */
const PUBLIC_TRACK_LIMITS = Object.freeze({
    requests: Object.freeze({ windowMs: 10 * 60 * 1000, limit: 300 }),
    misses: Object.freeze({ windowMs: 15 * 60 * 1000, limit: 20 }),
});

// Misma razón que el limitador de login de routes/auth.js: detrás de Cloudflare Tunnel + coolify-proxy, `req.ip` (con `trust proxy: 1`)
// es siempre la IP interna del proxy, la MISMA para todos los visitantes; usarla dejaría a todo el mundo en un solo contador. La IP real
// del visitante viene en CF-Connecting-IP. Solo se acepta si es una IP válida: un valor cualquiera (p. ej. un texto distinto en cada
// petición, enviado directo al servidor) no puede servir para abrir contadores nuevos y saltarse el límite; en ese caso se usa req.ip.
const clientIpKey = (req) => {
    const header = req.headers['cf-connecting-ip'];
    const cloudflareIp = typeof header === 'string' && net.isIP(header.trim()) ? header.trim() : null;
    return ipKeyGenerator(cloudflareIp || req.ip || '0.0.0.0');
};

const TOO_MANY = { message: 'Demasiadas consultas seguidas. Espera unos minutos e inténtalo de nuevo.' };

// El seguimiento incluye la posición del conductor y la zona del comprador: nada de esto debe quedar en cachés compartidas
// (Cloudflare, proxies) ni en buscadores. Va antes de los limitadores para que también lo lleven las respuestas 429.
const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
};

const publicTrackingLimiters = [
    noStore,
    rateLimit({
        ...PUBLIC_TRACK_LIMITS.requests,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: clientIpKey,
        message: TOO_MANY,
    }),
    rateLimit({
        ...PUBLIC_TRACK_LIMITS.misses,
        skipSuccessfulRequests: true,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: clientIpKey,
        message: TOO_MANY,
    }),
];

module.exports = { publicTrackingLimiters, PUBLIC_TRACK_LIMITS, clientIpKey };
