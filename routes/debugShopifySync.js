// TEMPORAL — solo para diagnosticar por qué el auto-import de Shopify no trae pedidos pagados
// de la tienda de prueba full-envios-2.myshopify.com. Admin-only, de solo lectura hacia Shopify
// (no crea ni modifica nada). Eliminar una vez resuelto.
const express = require('express');
const router = express.Router();
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const https = require('https');
const { decrypt } = require('../services/falabellaCrypto');

const adminOnly = (req, res, next) => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ message: 'Solo admin.' });
    next();
};

const ORDERS_QUERY = `
  query GetOrders($searchQuery: String!, $first: Int!) {
    orders(first: $first, query: $searchQuery, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          legacyResourceId
          name
          number
          email
          displayFinancialStatus
          shippingAddress { firstName lastName phone address1 address2 city province }
        }
      }
    }
  }
`;

function callShopify(shopUrl, accessToken, query, variables) {
    return new Promise((resolve, reject) => {
        const hostname = shopUrl.trim().replace(/^https?:\/\//, '').split('/')[0];
        const body = JSON.stringify({ query, variables });
        const options = {
            hostname,
            path: '/admin/api/2026-01/graphql.json',
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': accessToken,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', (e) => reject({ networkError: e.message }));
        req.write(body);
        req.end();
    });
}

router.get('/debug-shopify-sync-check', authMiddleware, adminOnly, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT integrations->'accounts' as accounts FROM users WHERE email = 'shopyadmin@fullenvios.cl'`
        );
        const acc = (rows[0]?.accounts || []).find(a => a.type === 'SHOPIFY');
        if (!acc) return res.json({ error: 'No se encontró la cuenta Shopify vinculada.' });

        const rawToken = acc.credentials.accessToken;
        let accessToken;
        let decryptNote = 'sin encriptar (raw)';
        try {
            accessToken = rawToken.includes(':') ? decrypt(rawToken) : rawToken;
            if (rawToken.includes(':')) decryptNote = 'desencriptado ok';
        } catch (e) {
            return res.json({ error: 'Fallo al desencriptar el token', details: e.message });
        }

        const result = await callShopify(acc.credentials.shopUrl, accessToken, ORDERS_QUERY, {
            searchQuery: 'status:open financial_status:paid',
            first: 50
        });

        res.json({
            shopUrl: acc.credentials.shopUrl,
            tokenLengthRaw: rawToken.length,
            tokenLengthDecrypted: accessToken.length,
            decryptNote,
            shopifyResponse: result
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

module.exports = router;
