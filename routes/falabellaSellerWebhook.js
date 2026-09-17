const express = require('express');
const router = express.Router();
const db = require('../db');

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
// El aviso solo trae el orderId (confirmado por Falabella) — obtener el LPN/TrackingCode y el
// resto de los datos de la orden requiere un paso siguiente aún no construido: consultar
// GetOrder/GetOrderItems de Seller API con las credenciales propias de cada vendedor (email +
// API Key de un usuario "Seller Full Access" en su Seller Center). Mientras ese paso no exista,
// esta ruta solo deja el aviso guardado para revisión manual.
router.post('/order-created/:seller', express.json(), async (req, res) => {
    const { seller } = req.params;
    try {
        const orderId = req.body?.orderId || req.body?.data?.orderId || req.body?.order_id || null;

        await db.query(
            'INSERT INTO falabella_seller_order_events (seller, "orderId", "rawPayload") VALUES ($1, $2, $3)',
            [seller, orderId, JSON.stringify(req.body || {})]
        );

        console.log(`[FalabellaSellerWebhook] Nueva orden de ${seller}: orderId=${orderId}`);
        res.status(200).json({ received: true });
    } catch (err) {
        console.error(`[FalabellaSellerWebhook] Error procesando webhook de ${seller}:`, err);
        res.status(500).json({ message: 'Error al registrar el aviso.' });
    }
});

module.exports = router;
