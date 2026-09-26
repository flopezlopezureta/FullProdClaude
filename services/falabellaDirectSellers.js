// Mapeo de falabellaDirectSellerId (order.shipFrom.sellerId en la respuesta de
// getOrderByLpn — un código propio de Falabella, ej. "SC64F29") a un nombre legible. Falabella no
// expone un endpoint para resolver esto, así que se mantiene a mano; agregar una línea nueva acá
// cuando se sume un seller de Falabella Directo distinto a Kanino.
const SELLER_NAMES = {
    'SC64F29': 'Kanino',
};

// Arma el fragmento SQL "CASE p.\"falabellaDirectSellerId\" WHEN ... END" a partir del mapeo de
// arriba, para no tener que escribirlo a mano en cada uno de los SELECT de routes/packages.js.
// Un sellerId sin mapear (seller nuevo, o paquetes de antes de este fix) muestra el código crudo
// en vez de nada, para que siga siendo posible distinguirlos aunque no tengan nombre todavía.
function buildSellerNameSql(column = 'p."falabellaDirectSellerId"') {
    const whens = Object.entries(SELLER_NAMES)
        .map(([id, name]) => `WHEN '${id.replace(/'/g, "''")}' THEN '${name.replace(/'/g, "''")}'`)
        .join(' ');
    return `CASE ${column} ${whens} ELSE COALESCE(${column}, 'Seller desconocido') END`;
}

module.exports = { SELLER_NAMES, buildSellerNameSql };
