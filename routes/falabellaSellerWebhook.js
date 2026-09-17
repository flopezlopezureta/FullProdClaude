const express = require('express');
const router = express.Router();
const db = require('../db');
const { processEvent } = require('../services/falabellaSellerOrderProcessor');

// POST /api/falabella-seller-webhook/order-created/:seller
//
// Receptor del webhook "onOrderCreated" de Seller Center (distinto de Falabella Directo — este
// se configura desde la cuenta del VENDEDOR, no con las credenciales de courier). Falabella lo
// llama directo, sin sesión de nuestra app, así que esta ruta va sin authMiddleware.
//
// Falabella todavía no especificó un esquema de firma/verificación para este webhook — a
// diferencia de las notificaciones de Shopify, que sí llevan HMAC (ver routes/integrations.js).
// Por ahora solo se registra el evento crudo tal como llega; si Falabella confirma una firma más
// adelante, verificarla aquí antes de aceptar el POST.
//
// El aviso solo trae el orderId — el LPN/TrackingCode se obtiene aparte, en
// services/falabellaSellerOrderProcessor.js, que llama a GetOrder/GetOrderItems con las
// credenciales de Seller Center que el vendedor ya conectó en su portal de cliente. Se responde
// 200 apenas se guarda el aviso crudo, y el procesamiento corre después sin bloquear la
// respuesta — así Falabella no espera a que termine la consulta a su propia API.
router.post('/order-created/:seller', express.json(), async (req, res) => {
    const { seller } = req.params;
    try {
        const orderId = req.body?.orderId || req.body?.data?.orderId || req.body?.order_id || null;

        const { rows } = await db.query(
            'INSERT INTO falabella_seller_order_events (seller, "orderId", "rawPayload") VALUES ($1, $2, $3) RETURNING id',
            [seller, orderId, JSON.stringify(req.body || {})]
        );

        console.log(`[FalabellaSellerWebhook] Nueva orden de ${seller}: orderId=${orderId}`);
        res.status(200).json({ received: true });

        const eventId = rows[0].id;
        processEvent(eventId).catch(err => {
            console.error(`[FalabellaSellerOrderProcessor] Fallo no controlado procesando evento ${eventId}:`, err);
        });
    } catch (err) {
        console.error(`[FalabellaSellerWebhook] Error procesando webhook de ${seller}:`, err);
        res.status(500).json({ message: 'Error al registrar el aviso.' });
    }
});

module.exports = router;
