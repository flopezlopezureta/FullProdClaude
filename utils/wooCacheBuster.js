// Algunas tiendas WooCommerce guardan en caché la respuesta de su API REST POR URL y la entregan vieja durante días (caso real de noviembre 2026: una tienda con LiteSpeed Cache,
// cabecera «x-litespeed-cache: hit», devolvía siempre el mismo listado de pedidos para la URL exacta del importador, mientras que cualquier otra URL con el mismo filtro traía los
// pedidos al día). El importador automático quedó ciego durante días y el operador tuvo que crear los paquetes a mano.
// Agregar a cada consulta de LECTURA un parámetro que cambia en cada llamada hace que la URL nunca coincida con una copia guardada; WooCommerce ignora los parámetros que no conoce.

/** Agrega «_=<milisegundos>» a la ruta de una consulta GET (con «?» o «&» según corresponda); otros métodos no se tocan. */
function withCacheBuster(path, method = 'GET', now = Date.now()) {
    if (String(method).toUpperCase() !== 'GET') return path;
    return `${path}${path.includes('?') ? '&' : '?'}_=${now}`;
}

module.exports = { withCacheBuster };
