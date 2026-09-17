const https = require('https');
const { decrypt, buildFalabellaSignature } = require('./falabellaCrypto');

// Llama a la Seller API de Falabella (sellercenter-api.falabella.com) con el mismo esquema de
// firma que ya usa GetOrders en routes/integrations.js — UserID+Signature (HMAC-SHA256) sobre
// los parámetros ordenados. Reutilizada acá para las dos acciones que pidió Falabella (Agustín,
// 2026-09-16) para el proyecto de visibilidad temprana: GetOrder y GetOrderItems.
function callSellerApi(apiKey, sellerId, action, version, extraParams = {}) {
    return new Promise((resolve, reject) => {
        if (!apiKey) return reject(new Error('La API Key de Falabella es requerida.'));
        if (!sellerId) return reject(new Error('El Seller ID (UserID) de Falabella es requerido.'));

        const decryptedApiKey = apiKey.includes(':') ? decrypt(apiKey) : apiKey;

        const baseParams = {
            Action: action,
            Timestamp: new Date().toISOString(),
            UserID: sellerId,
            Version: version,
            Format: 'JSON',
            ...extraParams
        };

        const signature = buildFalabellaSignature(baseParams, decryptedApiKey);
        const sortedKeys = Object.keys(baseParams).sort();
        const queryString = sortedKeys
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(baseParams[key])}`)
            .join('&') + `&Signature=${encodeURIComponent(signature)}`;

        const options = {
            hostname: 'sellercenter-api.falabella.com',
            path: `/?${queryString}`,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsedData = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        if (parsedData.ErrorResponse) {
                            reject({ statusCode: res.statusCode, body: parsedData, isFalabellaError: true });
                        } else {
                            resolve(parsedData);
                        }
                    } else {
                        reject({ statusCode: res.statusCode, body: parsedData });
                    }
                } catch (e) {
                    reject({ statusCode: res.statusCode, body: data, isRaw: true });
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.end();
    });
}

// Extrae una lista de la envoltura típica de Falabella: SuccessResponse.Body.<Plural>.<Singular>,
// que puede venir como objeto único o como arreglo — mismo patrón ya confirmado en producción
// para GetOrders (routes/integrations.js, fetchOrdersByStatus).
function unwrapFalabellaList(response, pluralKey, singularKey) {
    const raw = response?.SuccessResponse?.Body?.[pluralKey];
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map(item => item[singularKey]).filter(Boolean);
    } else if (raw[singularKey]) {
        return Array.isArray(raw[singularKey]) ? raw[singularKey] : [raw[singularKey]];
    }
    return [];
}

// GetOrder (v2) — metadata de la orden (OrderNumber, PromisedShippingTime, Warehouse, etc.).
// Ojo: Falabella documenta este endpoint con Version 2.0, distinto de GetOrders/GetOrderItems
// que usan 1.0. No trae TrackingCode — eso vive a nivel de item, no de orden.
const getOrder = (apiKey, sellerId, orderId) =>
    callSellerApi(apiKey, sellerId, 'GetOrder', '2.0', { OrderId: orderId });

// GetOrderItems — acá está el TrackingCode (LPN) real de cada paquete/ítem de la orden.
const getOrderItems = (apiKey, sellerId, orderId) =>
    callSellerApi(apiKey, sellerId, 'GetOrderItems', '1.0', { OrderId: orderId });

module.exports = { getOrder, getOrderItems, unwrapFalabellaList };
