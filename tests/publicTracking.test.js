/**
 * Prueba del SEGUIMIENTO PÚBLICO (GET /api/packages/public/track/:id) contra una base FALSA en memoria: no toca la base de datos real
 * y todos los nombres, direcciones y teléfonos de aquí son inventados.
 *
 * Usa la RUTA REAL (routes/packages.js) por HTTP. Cada consulta que la ruta hace se interpreta a mano; una consulta no prevista queda en
 * S.unknown y hace fallar la prueba. La consulta de búsqueda se interpreta leyendo SU PROPIO TEXTO (qué columnas pide y por qué códigos
 * busca), así que si alguien vuelve a pedir una columna sensible o a aceptar un código retirado, la prueba lo detecta.
 *
 * Uso:   node tests/publicTracking.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/publicTracking.test.js
 *        (otra copia = el código ANTERIOR, para comprobar que la prueba detecta el defecto, o el clon de Staging/Producción antes de subir)
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

// ───────────── datos INVENTADOS (nada de esto es real) ─────────────
const NAME = 'Valentina Rojas Fuentes';
const STREET = 'Avenida Imaginaria 4567, Depto 12';
const PHONE = '+56987654321';
const EMAIL = 'valentina.rojas@ejemplo.invalid';
const DRIVER = 'Pedro Ficticio';
const RECEIVER = 'Carlos Inventado';
const ACCOUNT = 'Tienda Falsa';
const STAFF = 'Admin Secreto';
const DEST_LAT = -33.4412345, DEST_LNG = -70.6212345;       // el redondeo a 3 decimales da -33.441 / -70.621
const DRV_LAT = -33.45123456, DRV_LNG = -70.65123456;
const PII = [
    'Valentina', 'Rojas', 'Fuentes', 'Imaginaria', '4567', 'Depto', PHONE, '987654321', EMAIL, DRIVER, 'Ficticio', RECEIVER, 'Inventado',
    ACCOUNT, STAFF, 'Calle Vieja', 'Calle Nueva', '33.4412345', '70.6212345', 'Conserje', 'conserje',
];

// ───────────── estado de la base falsa ─────────────
let S;
const reset = () => { S = { settings: { publicTrackingEnabled: true }, packages: {}, users: {}, events: [], queries: [], unknown: [], lookup: null }; };
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const mkPkg = (id, over = {}) => ({
    id, status: 'PENDIENTE', source: 'MANUAL', driverId: null, trackingId: null, meliOrderId: null, meliFlexCode: null, shopifyOrderId: null,
    wooOrderId: null, jumpsellerOrderId: null, recipientName: NAME, recipientAddress: STREET, recipientCommune: 'PROVIDENCIA', recipientCity: 'SANTIAGO',
    recipientPhone: PHONE, recipientEmail: EMAIL, notes: 'Dejar con conserje', estimatedDelivery: '2026-10-31T15:00:00.000Z',
    updatedAt: '2026-10-31T12:00:00.000Z', destLatitude: DEST_LAT, destLongitude: DEST_LNG, ...over,
});
const add = (id, over) => (S.packages[id] = mkPkg(id, over));
const addDriver = () => (S.users['drv-1'] = { id: 'drv-1', name: DRIVER, latitude: DRV_LAT, longitude: DRV_LNG, lastLocationUpdate: '2026-10-31T12:30:00.000Z' });
const ev = (packageId, minute, status, location, details) => S.events.push({ packageId, status, location, details, timestamp: new Date(Date.UTC(2026, 9, 31, 10, minute)).toISOString() });

// Eventos con TODO lo que hoy se guarda en producción: nombres de conductores y de quien recibió, direcciones, comentarios internos.
const addRichHistory = (id) => {
    ev(id, 0, 'Creado', 'Tienda', `Auto-importado vía Shopify (${ACCOUNT}).`);
    ev(id, 1, 'Asignado', 'Centro de Distribución', `Asignado a conductor ${DRIVER}.`);
    ev(id, 2, 'COMENTARIO', STAFF, 'Cliente pidió llamar al +56987654321 antes de llegar');
    ev(id, 3, 'EN_TRANSITO', 'Centro de Distribución', `Paquete despachado por ${DRIVER}.`);
    ev(id, 4, 'En Tránsito', 'Mercado Libre', 'Envío en camino');
    ev(id, 5, 'Dirección Actualizada', 'PROVIDENCIA', 'Dirección cambiada de "Calle Vieja 1" a "Calle Nueva 2".');
    ev(id, 6, 'ALERTA_DUPLICADO', 'Centro de Distribución', 'Alerta: Paquete escaneado como duplicado.');
    ev(id, 7, 'CIERRE_OFICIAL_ML', 'Mercado Libre API', 'Hora real capturada de status_history: 2026-10-31T10:07:00.000Z');
    ev(id, 8, 'SYNC_FALABELLA_START', 'Falabella API', 'Iniciando sincronización de entrega con Falabella Seller Center.');
    ev(id, 9, 'FALABELLA_ESTADO_CONSULTADO', 'Falabella API', 'Estado real en Falabella: pending (Items: 111, 222).');
    ev(id, 10, 'No Flexeado', 'Centro de Distribución', 'Paquete marcado como No Flexeado.');
    ev(id, 11, 'ENTREGADO', STREET, `Entregado a ${RECEIVER}.`);
};

const COLS_ALLOWED = ['id', 'status', 'recipientName', 'recipientCommune', 'recipientCity', 'estimatedDelivery', 'updatedAt', 'destLatitude', 'destLongitude', 'driverLatitude', 'driverLongitude', 'driverLastUpdate'];

async function run(text, params = []) {
    const q = norm(text);
    S.queries.push({ q, params });
    const R = (rows) => ({ rows, rowCount: rows.length });
    let m;

    if (/^SELECT "publicTrackingEnabled" FROM system_settings WHERE id = 1$/.test(q)) {
        return R(S.settings ? [{ publicTrackingEnabled: S.settings.publicTrackingEnabled }] : []);
    }

    // Búsqueda del paquete: se interpreta el TEXTO de la consulta (columnas pedidas, códigos aceptados, orden, límite).
    if ((m = q.match(/^SELECT (.+?) FROM packages p LEFT JOIN users u ON p\."driverId" = u\.id WHERE (.+?)(?: ORDER BY (.+?))?(?: LIMIT (\d+))?$/))) {
        const select = m[1].split(',').map((item) => {
            const mm = item.trim().match(/^(p|u)\.(?:"(\w+)"|(\w+))(?: AS "(\w+)")?$/);
            if (!mm) throw new Error('Columna no interpretable en la base falsa: ' + item);
            const col = mm[2] || mm[3];
            return { from: mm[1], col, out: mm[4] || col };
        });
        const whereCols = m[2].split(' OR ').map((term) => {
            const mm = term.trim().match(/^p\.(?:"(\w+)"|(\w+)) = \$1$/);
            if (!mm) throw new Error('Condición no interpretable en la base falsa: ' + term);
            return mm[1] || mm[2];
        });
        const orderBy = (m[3] ? m[3].split(/, (?=\(|p\.)/) : []).map((term) => {
            let mm = term.trim().match(/^\(p\.id = \$1\) (ASC|DESC)$/);
            if (mm) return { exact: true, dir: mm[1] };
            mm = term.trim().match(/^p\.(?:"(\w+)"|(\w+)) (ASC|DESC)$/);
            if (!mm) throw new Error('ORDER BY no interpretable en la base falsa: ' + term);
            return { col: mm[1] || mm[2], dir: mm[3] };
        });
        S.lookup = { select: select.map((s) => s.out), where: whereCols, hasLimit: !!m[4] };
        let rows = Object.values(S.packages).filter((p) => whereCols.some((c) => p[c] !== null && p[c] !== undefined && p[c] === params[0]));
        rows.sort((a, b) => {
            for (const o of orderBy) {
                const va = o.exact ? (a.id === params[0] ? 1 : 0) : a[o.col];
                const vb = o.exact ? (b.id === params[0] ? 1 : 0) : b[o.col];
                if (va === vb) continue;
                const cmp = va > vb ? 1 : -1;
                return o.dir === 'DESC' ? -cmp : cmp;
            }
            return 0;
        });
        if (m[4]) rows = rows.slice(0, Number(m[4]));
        return R(rows.map((p) => {
            const u = S.users[p.driverId] || null;
            const out = {};
            for (const s of select) out[s.out] = s.from === 'p' ? p[s.col] : (u ? u[s.col] : null);
            return out;
        }));
    }

    // Historial: la consulta nueva pide SOLO status y timestamp; la anterior pedía todo (texto libre incluido).
    if (/^SELECT status, timestamp FROM tracking_events WHERE "packageId" = \$1 ORDER BY timestamp DESC(?: LIMIT \d+)?$/.test(q)) {
        return R(S.events.filter((e) => e.packageId === params[0]).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).map((e) => ({ status: e.status, timestamp: e.timestamp })));
    }
    if (/^SELECT \* FROM tracking_events WHERE "packageId" = \$1 ORDER BY timestamp DESC$/.test(q)) {
        return R(S.events.filter((e) => e.packageId === params[0]).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).map((e) => ({ ...e })));
    }

    S.unknown.push(q); throw new Error('Consulta no prevista en la base falsa: ' + q.slice(0, 160));
}

// ───────────── sustitutos de los módulos con efectos externos ─────────────
const stub = (rel, exports) => {
    let p; try { p = require.resolve(ROOT + '/' + rel); } catch (e) { return; }   // un entorno puede no tener el módulo
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('db.js', { query: (t, p) => run(t, p), getClient: async () => { throw new Error('esta prueba no usa transacciones'); } });
stub('services/notificationService.js', { notifyRecipient: async () => {}, notifyRecipientsBulk: async () => {} });
stub('services/meliPollingService.js', { optimizedJITDiscovery: async () => null });
stub('services/jumpsellerPollingService.js', {});
stub('services/geocodingService.js', { geocodeAddress: async () => null, triggerBackgroundGeocoding: () => {} });
stub('services/gisService.js', { getSectorForCoordinates: () => 'Sector de prueba' });
stub('services/timeService.js', { getLogicalDate: async (d) => (d ? new Date(d) : new Date()).toISOString().slice(0, 10), getSystemTimezone: async () => 'America/Santiago' });
stub('services/falabellaDirectService.js', {});

const packagesRouter = require(ROOT + '/routes/packages.js');
let pub; try { pub = require(ROOT + '/services/publicTracking.js'); } catch (e) { pub = require('../services/publicTracking.js'); }   // código anterior: sin el módulo, se usan solo sus constantes y funciones puras
let limits = null; try { limits = require(ROOT + '/middleware/publicTrackingLimiter.js').PUBLIC_TRACK_LIMITS; } catch (e) { /* código anterior: sin limitador */ }
const LIMIT_MISSES = limits ? limits.misses.limit : 20;
const LIMIT_REQUESTS = limits ? limits.requests.limit : 300;

const app = express(); app.use(express.json());
app.use('/api/packages', packagesRouter);

const results = []; const names = [];
const t = async (name, fn) => {
    reset();
    try { await fn(); results.push(1); console.log('OK    ' + name); } catch (e) { results.push(0); names.push(name); console.log('FALLA ' + name + '\n      ' + String(e.stack || e.message).split('\n').slice(0, 5).join('\n      ')); }
};

(async () => {
    const origErr = console.error; console.error = () => {};      // la ruta imprime los errores esperados (consultas no previstas)
    const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.on('listening', r));
    const port = server.address().port;

    // Cada prueba usa una IP "de Cloudflare" distinta: los contadores del limitador viven mientras corre el proceso.
    let seq = 0; const freshIp = () => { seq++; return `198.51.${Math.floor(seq / 250)}.${(seq % 250) + 1}`; };
    const GET = async (key, { ip = freshIp(), headers = {} } = {}) => {
        const r = await fetch(`http://127.0.0.1:${port}/api/packages/public/track/${encodeURIComponent(key)}`, { headers: { 'CF-Connecting-IP': ip, ...headers } });
        const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch (e) { /* no era JSON */ }
        return { status: r.status, body, text, headers: r.headers };
    };
    const packageQueries = () => S.queries.filter((x) => /FROM packages/.test(x.q));
    const assertNoPii = (text, extra = []) => { for (const s of [...PII, ...extra]) assert.ok(!text.includes(s), `la respuesta pública contiene un dato personal: «${s}»`); };

    // ═════════════ 1. funciones de enmascarado (puras) ═════════════
    await t('maskRecipientName: iniciales con punto, mayúsculas, tildes, máximo 4; sin nombre utilizable = null', async () => {
        assert.strictEqual(pub.maskRecipientName(NAME), 'V. R. F.');
        assert.strictEqual(pub.maskRecipientName('  maría   josé  pérez gonzález soto '), 'M. J. P. G.');
        assert.strictEqual(pub.maskRecipientName('Ñandú Álvarez'), 'Ñ. Á.');
        assert.strictEqual(pub.maskRecipientName('Cher'), 'C.');
        assert.strictEqual(pub.maskRecipientName('(Juan) Pérez'), 'J. P.');
        assert.strictEqual(pub.maskRecipientName('😀 Ana'), 'A.');
        for (const v of ['', '   ', '--- ...', null, undefined, 12345, {}]) assert.strictEqual(pub.maskRecipientName(v), null, JSON.stringify(v));
    });
    await t('roundCoordinate: 3 decimales (~100 m); vacío, no numérico o ~0 (marcador 0.000001) = null', async () => {
        assert.strictEqual(pub.roundCoordinate(DEST_LAT), -33.441);
        assert.strictEqual(pub.roundCoordinate(DEST_LNG), -70.621);
        assert.strictEqual(pub.roundCoordinate('-70.6218'), -70.622, 'también acepta texto numérico (NUMERIC de Postgres)');
        for (const v of [0.000001, 0, null, undefined, '', 'abc', NaN, Infinity]) assert.strictEqual(pub.roundCoordinate(v), null, String(v));
    });
    await t('normalizeEventStatus: junta las distintas escrituras del mismo estado', async () => {
        assert.strictEqual(pub.normalizeEventStatus('En Tránsito'), 'EN_TRANSITO');
        assert.strictEqual(pub.normalizeEventStatus('EN_TRANSITO'), 'EN_TRANSITO');
        assert.strictEqual(pub.normalizeEventStatus('Dirección Actualizada'), 'DIRECCION_ACTUALIZADA');
        assert.strictEqual(pub.normalizeEventStatus('Reasignado'), 'ASIGNADO');
        assert.strictEqual(pub.normalizeEventStatus(null), '');
    });
    await t('buildPublicHistory: solo hechos para el comprador, frase fija, sin repetidos seguidos, "registrado" una vez, más reciente primero', async () => {
        add('H1'); addRichHistory('H1');
        const events = S.events.filter((e) => e.packageId === 'H1').map((e) => ({ status: e.status, timestamp: e.timestamp }));
        const h = pub.buildPublicHistory(events);
        assert.deepStrictEqual(h.map((x) => x.status), ['ENTREGADO', 'DIRECCION_ACTUALIZADA', 'EN_TRANSITO', 'ASIGNADO', 'CREADO']);
        for (const x of h) { assert.deepStrictEqual(Object.keys(x).sort(), ['details', 'status', 'timestamp']); assert.strictEqual(x.details, pub.PUBLIC_EVENT_LABELS[x.status]); }
        assert.strictEqual(h[2].timestamp, new Date(Date.UTC(2026, 9, 31, 10, 3)).toISOString(), 'conserva la hora en que EMPEZÓ "en camino"');
        const again = pub.buildPublicHistory([{ status: 'Creado', timestamp: '2026-10-31T10:00:00Z' }, { status: 'Asignado', timestamp: '2026-10-31T10:05:00Z' }, { status: 'Creado', timestamp: '2026-10-31T10:10:00Z' }]);
        assert.deepStrictEqual(again.map((x) => x.status), ['ASIGNADO', 'CREADO'], 'el "Creado" que el sistema guarda al desasignar no se muestra otra vez');
        assert.deepStrictEqual(pub.buildPublicHistory(null), []);
    });

    // ═════════════ 2. la respuesta de la ruta ═════════════
    await t('ruta: consulta legítima por trackingId = 200 con SOLO los campos permitidos (paquete entregado: sin posición del conductor)', async () => {
        add('PK-1', { status: 'ENTREGADO', trackingId: 'TRK-2026-0001', driverId: 'drv-1' }); addDriver(); addRichHistory('PK-1');
        const r = await GET('TRK-2026-0001');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(Object.keys(r.body).sort(), ['destLatitude', 'destLongitude', 'estimatedDelivery', 'history', 'id', 'recipientCity', 'recipientCommune', 'recipientName', 'status', 'updatedAt']);
        assert.strictEqual(r.body.id, 'PK-1'); assert.strictEqual(r.body.status, 'ENTREGADO');
        assert.strictEqual(r.body.recipientCommune, 'PROVIDENCIA'); assert.strictEqual(r.body.recipientCity, 'SANTIAGO');
        assert.strictEqual(r.body.estimatedDelivery, '2026-10-31T15:00:00.000Z');
    });
    await t('ruta: nombre = iniciales; punto de entrega redondeado a ~100 m; la dirección no sale', async () => {
        add('PK-2', { status: 'PENDIENTE', trackingId: 'TRK-2' });
        const r = await GET('TRK-2');
        assert.strictEqual(r.body.recipientName, 'V. R. F.');
        assert.strictEqual(r.body.destLatitude, -33.441); assert.strictEqual(r.body.destLongitude, -70.621);
        assert.ok(!('recipientAddress' in r.body), 'sin dirección');
    });
    await t('ruta: NINGÚN dato personal en la respuesta, con el historial real de producción lleno de nombres, direcciones y comentarios', async () => {
        for (const st of ['PENDIENTE', 'RETIRADO', 'ASIGNADO', 'EN_TRANSITO', 'ENTREGADO', 'PROBLEMA', 'DEVUELTO', 'CANCELADO']) {
            reset(); addDriver();
            add('PK-3', { status: st, trackingId: 'TRK-3', driverId: 'drv-1', meliOrderId: 'ML-2000009999999', meliFlexCode: '46019998877', shopifyOrderId: '5890000000001', wooOrderId: '8001' });
            addRichHistory('PK-3');
            const r = await GET('TRK-3'); assert.strictEqual(r.status, 200, st);
            assertNoPii(r.text, ['ML-2000009999999', '46019998877', '5890000000001', '8001']);
            assert.ok(!r.text.includes('TRK-3'), 'tampoco devuelve el trackingId (quien lo tiene ya lo conoce y la pantalla no lo usa)');
        }
    });
    await t('ruta: el historial público trae solo estados permitidos con frase fija; no hay texto libre, ubicación ni eventos internos', async () => {
        add('PK-4', { status: 'ENTREGADO', trackingId: 'TRK-4' }); addRichHistory('PK-4');
        const r = await GET('TRK-4');
        assert.deepStrictEqual(r.body.history.map((x) => x.status), ['ENTREGADO', 'DIRECCION_ACTUALIZADA', 'EN_TRANSITO', 'ASIGNADO', 'CREADO']);
        for (const x of r.body.history) {
            assert.deepStrictEqual(Object.keys(x).sort(), ['details', 'status', 'timestamp']);
            assert.ok(Object.values(pub.PUBLIC_EVENT_LABELS).includes(x.details), 'frase fija: ' + x.details);
        }
        for (const hidden of ['COMENTARIO', 'ALERTA_DUPLICADO', 'CIERRE_OFICIAL_ML', 'SYNC_FALABELLA_START', 'FALABELLA_ESTADO_CONSULTADO', 'NO_FLEXEADO']) {
            assert.ok(!r.body.history.some((x) => x.status === hidden), 'evento interno publicado: ' + hidden);
        }
    });
    await t('ruta: la base se consulta SOLO por las columnas permitidas y el historial SOLO por status+timestamp (el texto libre nunca sale de la base)', async () => {
        add('PK-5', { trackingId: 'TRK-5' }); addRichHistory('PK-5');
        const r = await GET('TRK-5'); assert.strictEqual(r.status, 200);
        assert.ok(S.lookup, 'se hizo la búsqueda');
        const forbidden = S.lookup.select.filter((c) => !COLS_ALLOWED.includes(c));
        assert.deepStrictEqual(forbidden, [], 'la búsqueda pide columnas no permitidas: ' + forbidden.join(', '));
        assert.ok(S.queries.some((x) => /^SELECT status, timestamp FROM tracking_events/.test(x.q)), 'historial con status y timestamp solamente');
        assert.ok(!S.queries.some((x) => /SELECT \* FROM tracking_events/.test(x.q) || /tracking_events/.test(x.q) && /details|location/.test(x.q)), 'no lee details/location');
        assert.deepStrictEqual(S.unknown, []);
    });
    await t('ruta: posición del conductor SOLO en camino (EN_TRANSITO / ASIGNADO), igual que antes, y nunca su nombre', async () => {
        for (const st of ['EN_TRANSITO', 'ASIGNADO']) {
            reset(); addDriver(); add('PK-6', { status: st, trackingId: 'TRK-6', driverId: 'drv-1' }); addRichHistory('PK-6');
            const r = await GET('TRK-6');
            assert.strictEqual(r.body.driverLatitude, DRV_LAT, st); assert.strictEqual(r.body.driverLongitude, DRV_LNG, st); assert.ok('driverLastUpdate' in r.body, st);
            assert.deepStrictEqual(Object.keys(r.body).sort(), ['destLatitude', 'destLongitude', 'driverLastUpdate', 'driverLatitude', 'driverLongitude', 'estimatedDelivery', 'history', 'id', 'recipientCity', 'recipientCommune', 'recipientName', 'status', 'updatedAt']);
            assert.ok(!r.text.includes(DRIVER) && !r.text.includes('Ficticio'), 'el nombre del conductor no sale');
        }
        for (const st of ['PENDIENTE', 'RETIRADO', 'ENTREGADO', 'PROBLEMA', 'DEVUELTO', 'CANCELADO']) {
            reset(); addDriver(); add('PK-7', { status: st, trackingId: 'TRK-7', driverId: 'drv-1' });
            const r = await GET('TRK-7');
            for (const k of ['driverLatitude', 'driverLongitude', 'driverLastUpdate']) assert.ok(!(k in r.body), `${st}: no debe traer ${k}`);
            assert.ok(!r.text.includes(String(DRV_LAT)), st);
        }
    });
    await t('ruta: coordenada de marcador (0.000001) o ausente = sin punto en el mapa (null las dos), no medio punto', async () => {
        add('PK-8', { trackingId: 'TRK-8', destLatitude: 0.000001, destLongitude: 0.000001 });
        add('PK-9', { trackingId: 'TRK-9', destLatitude: -33.44, destLongitude: null });
        add('PK-10', { trackingId: 'TRK-10', destLatitude: null, destLongitude: null });
        for (const k of ['TRK-8', 'TRK-9', 'TRK-10']) { const r = await GET(k); assert.strictEqual(r.body.destLatitude, null, k); assert.strictEqual(r.body.destLongitude, null, k); }
    });
    await t('ruta: sin nombre en el paquete = recipientName null (la pantalla lo maneja), sin romper', async () => {
        add('PK-11', { trackingId: 'TRK-11', recipientName: null }); const r = await GET('TRK-11');
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.recipientName, null);
    });

    // ═════════════ 3. llaves de búsqueda ═════════════
    await t('llaves: SOLO id y trackingId (el texto de la consulta no menciona ninguna otra columna)', async () => {
        add('PK-12', { trackingId: 'TRK-12' }); await GET('TRK-12');
        assert.deepStrictEqual([...S.lookup.where].sort(), ['id', 'trackingId']);
    });
    await t('llaves: por id interno y por trackingId funcionan, y devuelven el mismo paquete', async () => {
        add('SHOP-AB12CD34', { source: 'SHOPIFY' }); add('MAN-1', { trackingId: 'TRK-ABC-123' });
        const a = await GET('SHOP-AB12CD34'); assert.strictEqual(a.status, 200); assert.strictEqual(a.body.id, 'SHOP-AB12CD34');
        const b = await GET('TRK-ABC-123'); assert.strictEqual(b.status, 200); assert.strictEqual(b.body.id, 'MAN-1');
        const c = await GET('MAN-1'); assert.strictEqual(c.status, 200); assert.strictEqual(c.body.id, 'MAN-1');
    });
    await t('llaves RETIRADAS: meliFlexCode, meliOrderId, shopifyOrderId, wooOrderId y jumpsellerOrderId = 404, con paquetes que SÍ los tienen', async () => {
        add('MELI-0AAA1111', { source: 'MERCADO_LIBRE', meliOrderId: '2000009999999', meliFlexCode: '46019998877' });
        add('SHOP-0BBB2222', { source: 'SHOPIFY', shopifyOrderId: '5890000000001' });
        add('WOO-0CCC3333', { source: 'WOOCOMMERCE', wooOrderId: '8001' });
        add('JUMP-0DDD4444', { source: 'JUMPSELLER', jumpsellerOrderId: '99887766' });
        for (const k of ['2000009999999', '46019998877', '5890000000001', '8001', '99887766']) {
            const r = await GET(k); assert.strictEqual(r.status, 404, `la llave retirada ${k} aún responde ${r.status}`); assert.deepStrictEqual(r.body, { message: 'Paquete no encontrado.' });
        }
        for (const k of ['MELI-0AAA1111', 'SHOP-0BBB2222', 'WOO-0CCC3333', 'JUMP-0DDD4444']) assert.strictEqual((await GET(k)).status, 200, k);
    });
    await t('llaves: un paquete cuyo id/trackingId coincide con otro de sus números (ingresado a mano) se encuentra por ese código; lo que lo protege es que la respuesta no trae datos personales', async () => {
        add('46019998877', { source: 'MANUAL', trackingId: '46019998877', meliFlexCode: '46019998877' });
        const r = await GET('46019998877'); assert.strictEqual(r.status, 200);
        assertNoPii(r.text);
    });
    await t('llaves: si un código es el id de un paquete y el trackingId de otro, gana el id exacto', async () => {
        add('B-OTRO', { trackingId: 'X-1', updatedAt: '2026-10-31T13:00:00.000Z' }); add('X-1', { trackingId: null, updatedAt: '2026-10-01T00:00:00.000Z' });
        const r = await GET('X-1'); assert.strictEqual(r.body.id, 'X-1');
    });
    await t('llaves: si varios paquetes comparten trackingId se devuelve uno solo (el más recientemente actualizado)', async () => {
        add('D-1', { trackingId: 'DUP', updatedAt: '2026-10-01T00:00:00.000Z' }); add('D-2', { trackingId: 'DUP', updatedAt: '2026-10-30T00:00:00.000Z' });
        const r = await GET('DUP'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.id, 'D-2'); assert.ok(S.lookup.hasLimit, 'LIMIT en la búsqueda');
    });
    await t('llaves: código vacío, de solo espacios o larguísimo = 404 SIN consultar paquetes; un intento de inyección SQL va como parámetro', async () => {
        for (const k of ['   ', 'x'.repeat(pub.MAX_KEY_LENGTH + 1)]) { const r = await GET(k); assert.strictEqual(r.status, 404); }
        assert.strictEqual(packageQueries().length, 0, 'no debe consultar paquetes con un código imposible');
        const evil = "' OR '1'='1"; add('PK-13', { trackingId: 'TRK-13' });
        const r = await GET(evil); assert.strictEqual(r.status, 404);
        const q = packageQueries()[0]; assert.deepStrictEqual(q.params, [evil]); assert.ok(!q.q.includes(evil), 'el código no se pega en el texto SQL');
        assert.strictEqual((await GET('%')).status, 404); assert.strictEqual((await GET('TRK-1_')).status, 404, '_ y % no son comodines');
    });
    await t('llaves: los enlaces que arman los avisos (trackingId || id) y los botones de copiar enlace (id) se resuelven en la ruta', async () => {
        add('MELI-0EEE5555', { source: 'MERCADO_LIBRE', trackingId: null, meliFlexCode: '46099999999' });   // integración ML: trackingId vacío → el aviso usa el id
        add('MAN-2', { trackingId: 'TRK-ABC-777' });
        add('SHOP-0FFF6666', { source: 'SHOPIFY', trackingId: null });
        for (const pkg of Object.values(S.packages)) {
            assert.strictEqual((await GET(pkg.trackingId || pkg.id)).status, 200, 'enlace de aviso: ' + (pkg.trackingId || pkg.id));
            assert.strictEqual((await GET(pkg.id)).status, 200, 'enlace copiado: ' + pkg.id);
        }
    });
    await t('enlaces: en el código SOLO se arman enlaces /tracking/ o /track/ con `trackingId || id` o `id` (si cambia, hay que revisar esta prueba y la ruta)', async () => {
        const found = [];
        const walk = (dir) => {
            for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, f.name);
                if (f.isDirectory()) walk(full);
                else if (/\.(js|ts|tsx)$/.test(f.name)) {
                    // Se ignoran las líneas de comentario: solo importan los enlaces que el código realmente arma.
                    const src = fs.readFileSync(full, 'utf8').split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
                    for (const mm of src.matchAll(/(?<!public)\/(?:tracking|track)\/\$\{([^}]+)\}/g)) found.push({ file: path.relative(ROOT, full).replace(/\\/g, '/'), expr: mm[1].trim() });
                }
            }
        };
        for (const d of ['services', 'routes', 'components', 'pages', 'utils', 'contexts']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
        assert.ok(found.length >= 4, 'se esperaban al menos 4 enlaces (2 en notificationService, 2 botones de copiar); hallados: ' + JSON.stringify(found));
        const bad = found.filter((x) => !['pkg.trackingId || pkg.id', 'pkg.id'].includes(x.expr));
        assert.deepStrictEqual(bad, [], 'enlaces de seguimiento con otra llave: ' + JSON.stringify(bad));
        assert.ok(found.some((x) => x.file === 'services/notificationService.js' && x.expr === 'pkg.trackingId || pkg.id'), 'los avisos al comprador usan trackingId || id');
    });

    // ═════════════ 4. desactivado, cabeceras ═════════════
    await t('seguimiento desactivado por el administrador = 403 con su mensaje y SIN consultar paquetes', async () => {
        S.settings = { publicTrackingEnabled: false }; add('PK-14', { trackingId: 'TRK-14' });
        const r = await GET('TRK-14'); assert.strictEqual(r.status, 403); assert.strictEqual(r.body.message, 'El seguimiento público está desactivado por el administrador.');
        assert.strictEqual(packageQueries().length, 0);
    });
    await t('sin fila de configuración = activo (como siempre)', async () => {
        S.settings = null; add('PK-15', { trackingId: 'TRK-15' }); assert.strictEqual((await GET('TRK-15')).status, 200);
    });
    await t('cabeceras: nada de caché compartida ni buscadores, en respuestas 200, 404 y 403', async () => {
        add('PK-16', { trackingId: 'TRK-16' });
        for (const [key, status] of [['TRK-16', 200], ['NO-EXISTE', 404]]) {
            const r = await GET(key); assert.strictEqual(r.status, status);
            assert.strictEqual(r.headers.get('cache-control'), 'no-store', 'Cache-Control ' + status); assert.match(r.headers.get('x-robots-tag') || '', /noindex/, 'X-Robots-Tag ' + status);
        }
        S.settings = { publicTrackingEnabled: false }; const d = await GET('TRK-16'); assert.strictEqual(d.status, 403); assert.strictEqual(d.headers.get('cache-control'), 'no-store');
    });

    // ═════════════ 5. límite de peticiones por IP ═════════════
    await t(`límite: tras ${LIMIT_MISSES} consultas que no encuentran nada, la siguiente = 429 con mensaje claro y Retry-After; otra IP no se ve afectada`, async () => {
        const ip = freshIp(), other = freshIp();
        for (let i = 1; i <= LIMIT_MISSES; i++) assert.strictEqual((await GET('NO-EXISTE-' + i, { ip })).status, 404, 'intento ' + i);
        const r = await GET('NO-EXISTE-X', { ip });
        assert.strictEqual(r.status, 429); assert.strictEqual(r.body.message, 'Demasiadas consultas seguidas. Espera unos minutos e inténtalo de nuevo.');
        assert.ok(r.headers.get('retry-after'), 'trae Retry-After'); assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        assert.strictEqual((await GET('NO-EXISTE-Y', { ip: other })).status, 404, 'otra IP sigue con su propio contador');
    });
    await t('límite: las consultas que SÍ encuentran el paquete no gastan el contador de fallidas (una pantalla abierta mucho rato no se bloquea)', async () => {
        add('PK-17', { trackingId: 'TRK-17' }); const ip = freshIp();
        for (let i = 0; i < LIMIT_MISSES + 15; i++) assert.strictEqual((await GET('TRK-17', { ip })).status, 200, 'consulta ' + i);
        for (let i = 1; i <= LIMIT_MISSES; i++) assert.strictEqual((await GET('NO-EXISTE-' + i, { ip })).status, 404, 'fallida ' + i);
        assert.strictEqual((await GET('NO-EXISTE-Z', { ip })).status, 429);
    });
    await t(`límite: tope general de ${LIMIT_REQUESTS} consultas por IP, incluso aciertos (barrido masivo de códigos conocidos)`, async () => {
        add('PK-18', { trackingId: 'TRK-18' }); const ip = freshIp(); const other = freshIp();
        for (let i = 1; i <= LIMIT_REQUESTS; i++) { const r = await GET('TRK-18', { ip }); if (r.status !== 200) assert.fail(`consulta ${i} respondió ${r.status}`); }
        assert.strictEqual((await GET('TRK-18', { ip })).status, 429);
        assert.strictEqual((await GET('TRK-18', { ip: other })).status, 200);
    });
    await t('límite: se cuenta por la IP real de Cloudflare (CF-Connecting-IP), no por la del proxy que es la misma para todos', async () => {
        // Todas las peticiones de la prueba llegan desde 127.0.0.1; si el contador usara esa IP, las pruebas anteriores se habrían bloqueado entre sí.
        const a = freshIp(), b = freshIp();
        for (let i = 1; i <= LIMIT_MISSES; i++) await GET('NO-EXISTE-' + i, { ip: a });
        assert.strictEqual((await GET('NO-EXISTE-A', { ip: a })).status, 429);
        assert.strictEqual((await GET('NO-EXISTE-B', { ip: b })).status, 404);
    });
    await t('límite: IPv6 de un mismo abonado (/56) comparte contador; otro abonado no', async () => {
        const ipv6 = (n, last) => `2001:db8:${n}:ab00::${last}`;     // mismo /56 (2001:db8:n:ab00::/56): cambia solo el final
        const x = Math.floor(Math.random() * 60000) + 1;
        for (let i = 1; i <= LIMIT_MISSES; i++) await GET('NO-EXISTE-' + i, { ip: ipv6(x.toString(16), i) });
        assert.strictEqual((await GET('NO-EXISTE-Q', { ip: ipv6(x.toString(16), 999) })).status, 429, 'mismo abonado, otra dirección → mismo contador');
        assert.strictEqual((await GET('NO-EXISTE-R', { ip: ipv6((x + 7).toString(16), 1) })).status, 404, 'otro abonado');
    });
    // Esta va al final: deja agotado el contador de 127.0.0.1 (la IP real del socket) por 15 minutos.
    await t('límite: una CF-Connecting-IP inválida NO sirve para abrir contadores nuevos (cae a la IP del socket)', async () => {
        for (let i = 1; i <= LIMIT_MISSES; i++) assert.strictEqual((await GET('NO-EXISTE-' + i, { ip: 'basura-' + i })).status, 404, 'intento ' + i);
        assert.strictEqual((await GET('NO-EXISTE-W', { ip: 'basura-otra' })).status, 429, 'cambiar el texto en cada petición no evita el límite');
    });

    console.error = origErr;
    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} pruebas OK` + (names.length ? `\nFALLARON:\n - ${names.join('\n - ')}` : ''));
    server.close(); process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.error('ERROR en la prueba:', e); process.exit(2); });
