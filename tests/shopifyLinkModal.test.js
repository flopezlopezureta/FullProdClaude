/**
 * Prueba del formulario «Vincular Tienda Shopify» (portal del cliente, ficha del administrador y manual).
 *   Antecedente: el botón «O usar conexión un-clic (Recomendado)» abría /api/integrations/shopify/auth en una ventana nueva; esa ruta exige sesión y la ventana no manda el
 *   token, así que mostraba {"message":"No hay token, autorización denegada."} (una página de error). Shopify pausó la revisión de la app (requisito 2.1.1: sin páginas de error).
 *   A. el formulario del cliente ya no ofrece ese botón, ofrece el enlace público de instalación (que sí funciona) y pide pegar el token
 *   B. la ficha del administrador tampoco lo ofrece (y conserva el ingreso manual del token)
 *   C. el manual del cliente describe los pasos que sí funcionan
 *   D. la ruta pública que usa el botón nuevo (GET /api/integrations/shopify/install) con el servidor real contra una base falsa; la ruta que exige sesión sigue exigiéndola
 * No toca ninguna base ni servicio real; todos los datos son inventados.
 *
 * Uso:   node tests/shopifyLinkModal.test.js
 *        HARNESS_ROOT=<carpeta con otra copia del código> node tests/shopifyLinkModal.test.js
 *        (otra copia = el código ANTERIOR, para comprobar que la prueba detecta el defecto, o el clon de Staging/Producción antes de subir)
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(process.env.HARNESS_ROOT || path.join(__dirname, '..'));
const load = (m) => require(require.resolve(m, { paths: [ROOT] }));
const express = load('express');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-local';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

const CLIENT_MODAL = 'components/client/AccountManagement.tsx';
const ADMIN_MODAL = 'components/modals/EditUserModal.tsx';
const MANUAL = 'public/manuals/shopify_guide.html';
// El modal de Shopify del cliente: desde su encabezado hasta el modal siguiente (Jumpseller).
const shopifyModalOf = (src) => { const a = src.indexOf('{/* Shopify Installation Modal */}'); const b = src.indexOf('{/* Jumpseller Modal */}'); assert.ok(a >= 0 && b > a, 'no encuentro el modal de Shopify'); return src.slice(a, b); };

// ═════════════ A. formulario del portal del cliente ═════════════
t('A1 el formulario del cliente ya no abre /api/integrations/shopify/auth (la ruta que exige sesión y mostraba el error 401)', () => {
    const src = read(CLIENT_MODAL);
    assert.ok(!/shopify\/auth\b/.test(src), 'sigue refiriéndose a /shopify/auth');
    assert.ok(!/shopify-auth/.test(src), 'sigue abriendo la ventana «shopify-auth»');
});
t('A2 ya no promete una «conexión un-clic (Recomendado)» ni dice que se deje el token vacío', () => {
    const modal = shopifyModalOf(read(CLIENT_MODAL));
    for (const bad of [/un-clic/i, /un clic/i, /Recomendado/, /Conectar autom/i, /deja el Token vac/i]) assert.ok(!bad.test(modal), 'quedó el texto ' + bad);
});
t('A3 ofrece el botón «1. Autorizar en Shopify y obtener el token», que abre la ruta PÚBLICA de instalación con el dominio escrito', () => {
    const modal = shopifyModalOf(read(CLIENT_MODAL));
    assert.ok(/1\. Autorizar en Shopify y obtener el token/.test(modal), 'falta el botón');
    assert.ok(/window\.open\(`\/api\/integrations\/shopify\/install\?shop=\$\{encodeURIComponent\(shopClean\)\}`, '_blank'\)/.test(modal), 'no abre la ruta pública de instalación en una pestaña nueva');
    assert.ok(/Por favor ingresa el dominio de tu tienda/.test(modal), 'no avisa si falta el dominio');
});
t('A4 el botón de autorizar se ve SIEMPRE (no solo con el token vacío)', () => {
    const modal = shopifyModalOf(read(CLIENT_MODAL));
    const i = modal.indexOf('1. Autorizar en Shopify y obtener el token');
    const antes = modal.slice(Math.max(0, i - 900), i);
    assert.ok(!/\{!shopifyAccessToken && \(/.test(antes), 'el botón está dentro de una condición «sin token»');
    assert.ok(!/\{!shopifyAccessToken && \(/.test(modal), 'quedó algún bloque que solo aparece sin token');
});
t('A5 el campo se llama «2. Token de acceso», pide pegar el de la página «Conexión exitosa» y no exige «una App Personalizada»', () => {
    const modal = shopifyModalOf(read(CLIENT_MODAL));
    assert.ok(/2\. Token de acceso/.test(modal));
    assert.ok(/Pega aquí el token de la página «Conexión exitosa»/.test(modal));
    assert.ok(!/Admin API Access Token \(shpat_\.\.\.\)/.test(modal), 'quedó la etiqueta antigua');
    assert.ok(!/creando una "App Personalizada"/.test(modal), 'quedó la instrucción antigua');
    assert.ok(/pega su token \(shpat_…\)/.test(modal), 'ya no explica que una app propia usa su token shpat_');
});
t('A6 el botón de vincular dice «Vincular tienda» y sigue creando la cuenta SHOPIFY con la tienda y el token', () => {
    const modal = shopifyModalOf(read(CLIENT_MODAL));
    assert.ok(/Vincular tienda/.test(modal) && !/Vincular con Token \(Manual\)/.test(modal));
    assert.ok(/api\.createIntegrationAccount\(\{\s*type: 'SHOPIFY',[\s\S]*?credentials: \{ shopUrl: shopifyUrl, accessToken: shopifyAccessToken \}/.test(modal), 'ya no crea la cuenta con la tienda y el token');
    assert.ok(/disabled=\{isTestingShopify \|\| !shopifyUrl\.trim\(\) \|\| !shopifyAccessToken\.trim\(\)\}/.test(modal), 'ya no exige tienda y token para vincular');
});

// ═════════════ B. ficha del administrador ═════════════
t('B1 la ficha del administrador tampoco abre /shopify/auth ni ofrece «Un solo clic»', () => {
    const src = read(ADMIN_MODAL);
    assert.ok(!/shopify\/auth\b/.test(src) && !/shopify-auth/.test(src));
    for (const bad of [/Un solo clic/i, /Recomendado: Conexi/, /handleConnectIntegration\('shopify'\)/]) assert.ok(!bad.test(src), 'quedó ' + bad);
});
t('B2 la ficha del administrador conserva el ingreso manual de la tienda y el token, con su prueba de conexión, y explica dónde se conecta la app de Full Envíos', () => {
    const src = read(ADMIN_MODAL);
    assert.ok(/value=\{clientShopifyUrl\}/.test(src) && /showShopifyToken/.test(src) && /handleTestShopify/.test(src), 'se perdió el ingreso manual');
    assert.ok(/Configuración → Cuentas Vinculadas → Shopify/.test(src), 'no dice dónde conectar la app de Full Envíos');
    assert.ok(/type === 'meli'/.test(src), 'el conector de Mercado Libre del mismo modal debe seguir');
});

// ═════════════ C. manual ═════════════
t('C1 el manual describe el flujo que funciona (autorizar → «Conexión Exitosa» → pegar el token → «Vincular tienda») y ya no manda al botón verde «Conectar automáticamente»', () => {
    const html = read(MANUAL);
    assert.ok(!/Conectar automáticamente/.test(html) && !/Conexión Automática/.test(html), 'quedó la conexión automática');
    for (const ok of [/Autorizar en Shopify y obtener el token/, /Conexión Exitosa/, /2\. Token de acceso/, /Vincular tienda/, /Cuentas Vinculadas/]) assert.ok(ok.test(html), 'falta ' + ok);
    assert.ok(/Conexión con una app propia/.test(html) && /shpat_/.test(html), 'falta la opción de app propia');
    assert.ok(/3\. Ajustes de Sincronización/.test(html), 'se perdió la sección siguiente del manual');
});

// ═════════════ D. el servidor ═════════════
let server, base, S;
const reset = () => { S = { clientId: 'cliente-falso-123', queries: [] }; };
const stub = (rel, exports) => { const p = require.resolve(path.join(ROOT, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
reset();
stub('db.js', {
    query: async (text) => {
        S.queries.push(String(text).replace(/\s+/g, ' ').trim());
        if (/FROM integration_settings WHERE id = 1/.test(text) && /shopify_client_id/.test(text)) return { rows: S.clientId === null ? [] : [{ shopify_client_id: S.clientId }] };
        if (/FROM users WHERE id = \$1/.test(text) && /status/.test(text)) return { rows: [{ status: 'APROBADO' }] };
        return { rows: [] };
    },
    getClient: async () => { throw new Error('no se usa'); }
});
stub('services/meliPollingService.js', { getValidMeliToken: async () => null, optimizedJITDiscovery: async () => null });
const get = async (p, headers) => { const r = await fetch(base + p, { redirect: 'manual', headers }); let body = ''; try { body = await r.text(); } catch (e) { /* sin cuerpo */ } return { status: r.status, location: r.headers.get('location'), body }; };

t('D1 GET /shopify/install?shop=… SIN sesión redirige (302) a la pantalla de autorización de Shopify de la app, con el permiso de pedidos y state=install', async () => {
    reset();
    const r = await get('/api/integrations/shopify/install?shop=mi-tienda.myshopify.com');
    assert.strictEqual(r.status, 302, r.body.slice(0, 200));
    const u = new URL(r.location);
    assert.strictEqual(u.origin, 'https://mi-tienda.myshopify.com');
    assert.strictEqual(u.pathname, '/admin/oauth/authorize');
    assert.strictEqual(u.searchParams.get('client_id'), 'cliente-falso-123');
    assert.ok(/read_orders/.test(u.searchParams.get('scope')), 'falta el permiso read_orders');
    assert.strictEqual(u.searchParams.get('state'), 'install');
    assert.ok(/\/api\/integrations\/shopify\/callback$/.test(u.searchParams.get('redirect_uri')), u.searchParams.get('redirect_uri'));
});
t('D2 acepta el dominio escrito de las formas que usa la gente (sin .myshopify.com, con https:// o con ruta) y siempre redirige al mismo dominio', async () => {
    for (const entrada of ['mi-tienda', 'https://mi-tienda.myshopify.com', 'https://mi-tienda.myshopify.com/admin/orders', 'mi-tienda.myshopify.com/']) {
        reset(); const r = await get('/api/integrations/shopify/install?shop=' + encodeURIComponent(entrada));
        assert.strictEqual(r.status, 302, entrada + ' → ' + r.status);
        assert.strictEqual(new URL(r.location).hostname, 'mi-tienda.myshopify.com', entrada);
    }
});
t('D3 rechaza (400) dominios ajenos o raros: no se puede usar para redirigir a otro sitio', async () => {
    for (const entrada of ['evil.com', 'mi-tienda.myshopify.com.evil.com', 'otra.com/mi-tienda.myshopify.com', 'a b.myshopify.com', '../x.myshopify.com']) {
        reset(); const r = await get('/api/integrations/shopify/install?shop=' + encodeURIComponent(entrada));
        assert.ok(r.status === 400 || r.status === 302 && new URL(r.location).hostname.endsWith('.myshopify.com') && !/evil/.test(new URL(r.location).hostname), entrada + ' → ' + r.status + ' ' + r.location);
        if (r.status === 302) assert.ok(/^[a-z0-9-]+\.myshopify\.com$/i.test(new URL(r.location).hostname), 'redirige a un host no permitido: ' + r.location);
    }
    reset(); assert.strictEqual((await get('/api/integrations/shopify/install?shop=evil.com')).status, 400);
    reset(); assert.strictEqual((await get('/api/integrations/shopify/install?shop=mi-tienda.myshopify.com.evil.com')).status, 400);
    reset(); assert.strictEqual((await get('/api/integrations/shopify/install')).status, 400, 'sin dominio');
});
t('D4 si el administrador no configuró el Client ID de la app, responde un error claro (500) en vez de redirigir a ciegas', async () => {
    reset(); S.clientId = null;
    const r = await get('/api/integrations/shopify/install?shop=mi-tienda.myshopify.com');
    assert.strictEqual(r.status, 500); assert.ok(/no ha configurado el Client ID/.test(r.body), r.body.slice(0, 200));
});
t('D5 la ruta /shopify/auth sigue exigiendo sesión (401): por eso ya no se usa desde un botón que abre una ventana', async () => {
    reset();
    const r = await get('/api/integrations/shopify/auth?shop=mi-tienda.myshopify.com');
    assert.strictEqual(r.status, 401, r.body.slice(0, 200));
});

// ───────────── ejecución ─────────────
(async () => {
    try {
        const app = express(); app.use(express.json()); app.use('/api/integrations', require(path.join(ROOT, 'routes/integrations.js')));
        server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); }); base = `http://127.0.0.1:${server.address().port}`;
    } catch (e) { console.error('No se pudo montar la ruta real:', e.stack); }
    const log = console.log; let ok = 0; const fails = [];
    for (const { name, fn } of tests) {
        const quiet = console.log, quietErr = console.error, quietWarn = console.warn; console.log = () => {}; console.error = () => {}; console.warn = () => {};
        try { await fn(); ok++; console.log = quiet; console.error = quietErr; console.warn = quietWarn; log('OK    ' + name); }
        catch (e) { console.log = quiet; console.error = quietErr; console.warn = quietWarn; fails.push(name); log('FALLA ' + name + '\n      ' + String(e && e.message).split('\n').slice(0, 6).join('\n      ')); }
    }
    log(`\n${ok} de ${tests.length} pruebas OK`);
    if (server) server.close(); process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e.stack); process.exit(2); });
