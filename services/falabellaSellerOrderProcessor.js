const db = require('../db');
const { getOrder, getOrderItems, unwrapFalabellaList } = require('./falabellaSellerApiService');

// Busca la cuenta Falabella que el vendedor ya conectó por su cuenta en el portal de cliente
// (components/client/AccountManagement.tsx → "Cuentas Vinculadas"), guardada en
// users.integrations->accounts. Es la MISMA credencial que ya usa el sync de GetOrders cada
// 5 min — no se pide ni se guarda ninguna credencial nueva para este flujo.
//
// El seller del webhook (ej. "kanino") se matchea contra users.name en minúsculas. Alcanza para
// el piloto (un solo vendedor); si se suman más vendedores y algún nombre tiene espacios o
// mayúsculas irregulares, revisar este match antes de asumir que "no está conectado".
async function getSellerCredentials(sellerSlug) {
    const { rows } = await db.query(
        `SELECT id, integrations FROM users WHERE role = 'CLIENT' AND LOWER(TRIM(name)) = LOWER($1)`,
        [sellerSlug]
    );
    if (rows.length === 0) return null;

    const account = (rows[0].integrations?.accounts || []).find(a => a.type === 'FALABELLA');
    if (!account || !account.credentials?.falabellaApiKey || !account.credentials?.falabellaSellerId) return null;

    return {
        userId: rows[0].id,
        apiKey: account.credentials.falabellaApiKey,
        sellerId: account.credentials.falabellaSellerId
    };
}

async function markEvent(eventId, fields) {
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(fields)) {
        sets.push(`"${key}" = $${i}`);
        values.push(value);
        i++;
    }
    values.push(eventId);
    await db.query(`UPDATE falabella_seller_order_events SET ${sets.join(', ')} WHERE id = $${i}`, values);
}

// Procesa un aviso de onOrderCreated: busca las credenciales del vendedor, consulta GetOrder/
// GetOrderItems, y cruza los TrackingCode (LPN) resultantes contra paquetes ya existentes de
// Falabella Directo (packages."falabellaDirectLpn") — así se sabe si ese pedido ya llegó
// escaneado a bodega o si el aviso llegó primero, que es la visibilidad temprana que pidió
// Falabella Directo originalmente.
//
// Fallos permanentes (sin orderId, vendedor sin cuenta conectada) marcan processed=true — no
// tiene sentido reintentarlos solos. Un fallo de red/API hacia Falabella deja processed=false
// para poder reprocesar el evento más adelante.
async function processEvent(eventId) {
    const { rows } = await db.query(
        `SELECT id, seller, "orderId" FROM falabella_seller_order_events WHERE id = $1`,
        [eventId]
    );
    if (rows.length === 0) {
        console.error(`[FalabellaSellerOrderProcessor] Evento ${eventId} no encontrado.`);
        return;
    }
    const { seller, orderId } = rows[0];

    if (!orderId) {
        await markEvent(eventId, { processed: true, error: 'El aviso no traía orderId.', processedAt: new Date() });
        console.warn(`[FalabellaSellerOrderProcessor] Evento ${eventId} (${seller}) sin orderId — descartado.`);
        return;
    }

    const creds = await getSellerCredentials(seller);
    if (!creds) {
        const errorMsg = `No se encontró una cuenta Falabella conectada para el vendedor "${seller}".`;
        await markEvent(eventId, { processed: true, error: errorMsg, processedAt: new Date() });
        console.warn(`[FalabellaSellerOrderProcessor] ${errorMsg} (evento ${eventId}, orderId ${orderId})`);
        return;
    }

    try {
        try {
            await getOrder(creds.apiKey, creds.sellerId, orderId);
            console.log(`[FalabellaSellerOrderProcessor] GetOrder OK para orderId ${orderId} (${seller}).`);
        } catch (err) {
            // No crítico: GetOrder no trae TrackingCode, solo metadata. Seguimos con GetOrderItems.
            console.warn(`[FalabellaSellerOrderProcessor] GetOrder falló para orderId ${orderId} (${seller}):`, err.body || err.message || err);
        }

        const itemsResponse = await getOrderItems(creds.apiKey, creds.sellerId, orderId);
        const items = unwrapFalabellaList(itemsResponse, 'OrderItems', 'OrderItem');
        const trackingCodes = [...new Set(items.map(i => i.TrackingCode).filter(Boolean))];

        let matchedPackageIds = [];
        if (trackingCodes.length > 0) {
            const { rows: matches } = await db.query(
                `SELECT id FROM packages WHERE "falabellaDirectLpn" = ANY($1)`,
                [trackingCodes]
            );
            matchedPackageIds = matches.map(m => m.id);
        }

        await markEvent(eventId, {
            processed: true,
            trackingCodes: JSON.stringify(trackingCodes),
            matchedPackageIds: JSON.stringify(matchedPackageIds),
            error: null,
            processedAt: new Date()
        });

        if (trackingCodes.length === 0) {
            console.log(`[FalabellaSellerOrderProcessor] orderId ${orderId} (${seller}): GetOrderItems aún no trae TrackingCode (puede que la guía todavía no se genere).`);
        } else if (matchedPackageIds.length > 0) {
            console.log(`[FalabellaSellerOrderProcessor] orderId ${orderId} (${seller}): LPN ${trackingCodes.join(', ')} — YA existe como paquete escaneado (${matchedPackageIds.join(', ')}).`);
        } else {
            console.log(`[FalabellaSellerOrderProcessor] orderId ${orderId} (${seller}): LPN ${trackingCodes.join(', ')} conocido ANTES del escaneo físico en bodega.`);
        }
    } catch (err) {
        const errorMsg = `GetOrderItems falló: ${err.message || JSON.stringify(err.body || err)}`;
        await markEvent(eventId, { error: errorMsg });
        console.error(`[FalabellaSellerOrderProcessor] orderId ${orderId} (${seller}):`, err.body || err.message || err);
    }
}

module.exports = { processEvent, getSellerCredentials };
