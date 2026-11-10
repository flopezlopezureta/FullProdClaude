// Comuna y región de un pedido de WooCommerce.
//
// Una tienda chilena suele pedir la COMUNA en una lista desplegable (el campo «estado» del pedido: p. ej. «CL_287» = Ñuñoa; la lista completa de la tienda sale de
// GET /data/countries/CL) y la «ciudad» en un campo libre que casi todos dejan en «Santiago». El importador solo miraba la ciudad escrita a mano, así que:
//   · un pedido con la ciudad mal escrita («San Tiago», «Santiagi», «Condominio La Siembra») no se reconocía como de la Región Metropolitana y se saltaba EN SILENCIO;
//   · nueve de cada diez paquetes importados quedaban con comuna SANTIAGO aunque el estado dijera Vitacura, Ñuñoa o Pudahuel (mal para zonas y para ubicar la dirección en el mapa).
// Aquí se decide con las dos fuentes, en este orden:
//   1. el ESTADO, si la lista de la tienda lo traduce a una comuna de la Región Metropolitana (coincidencia exacta; la lista no tiene errores de tipeo);
//   2. la CIUDAD: la comuna exacta o una abreviatura conocida, y un error de tipeo solo si es de UNA corrección («Santiagi», «Providensia») y el estado no dice que el
//      pedido es de otra parte (si el estado es de otra ciudad, una coincidencia por tipeo como «Rengo» → «Renca» no cuenta);
//   3. las reglas de región de siempre (el texto del estado o de la ciudad dice «metropolitana», «santiago», «rm»…) cuando no se identifica ninguna comuna.
// Todo es puro (sin red ni base): la lista de estados se pide aparte (getStateMap) y las comunas habilitadas vienen del setup.

const { normalizeCommune, resolveKnownCommuneDetailed, resolveExactCommune, checkOrderCommune } = require('../utils/normUtil');

const STATE_MAP_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TYPO_DISTANCE = 1;          // correcciones permitidas para aceptar una ciudad mal escrita como comuna de la RM
const stateMaps = new Map();          // «tienda|país» → { at, map }

/** código → nombre, a partir de la lista de estados de un país de la tienda ([{ code, name }]). */
function buildStateMap(states) {
    const map = new Map();
    for (const s of Array.isArray(states) ? states : []) {
        if (s && typeof s.code === 'string' && s.code && typeof s.name === 'string') map.set(s.code, s.name);
    }
    return map;
}

/**
 * Lista de estados de un país de la tienda (código → nombre), guardada 12 horas. `request(ruta)` hace la consulta a la tienda (el importador pasa la suya).
 * Si la tienda no la entrega, devuelve la última que se tenía (aunque esté vencida) o null: sin lista se sigue decidiendo con la ciudad, como antes.
 */
async function getStateMap(request, cacheKey, country = 'CL', now = Date.now()) {
    const key = `${cacheKey}|${country}`;
    const hit = stateMaps.get(key);
    if (hit && now - hit.at < STATE_MAP_TTL_MS) return hit.map;
    try {
        const data = await request(`/data/countries/${encodeURIComponent(country)}`);
        const map = buildStateMap(data && data.states);
        if (map.size > 0) { stateMaps.set(key, { at: now, map }); return map; }
    } catch (e) { /* la tienda no la entregó: ver arriba */ }
    return hit ? hit.map : null;
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

// Las reglas de región que ya tenía el importador (texto del estado o de la ciudad de envío).
const looksMetropolitan = (stateRaw, cityRaw) => {
    const state = stateRaw.toLowerCase();
    const city = cityRaw.toLowerCase();
    return state.includes('metropolitana') || state.includes('santiago') || state.includes('rm') || state.includes('r.m.')
        || city.includes('santiago') || city.includes('metropolitana') || city.includes('rm');
};

/**
 * Qué comuna es un pedido de WooCommerce y si el importador debe tomarlo.
 *   order          el pedido tal como lo entrega la API (usa shipping y billing: city y state)
 *   stateMap       código → nombre de los estados de la tienda (getStateMap), o null si no se tiene
 *   validCommunes  comunas habilitadas en el setup (normalizeCommune(nombre).toLowerCase()); vacío = todas
 * Devuelve { commune, source, isRM, allow, reason, stateName, cityText }:
 *   commune  nombre canónico en MAYÚSCULAS, o null si ninguna fuente la identifica
 *   source   'state' | 'city' | null: de dónde salió la comuna
 *   allow    true si es de la RM y su comuna no está deshabilitada
 *   reason   'ok' | 'not_rm' (no se pudo ubicar en la Región Metropolitana) | 'inactive' (comuna reconocida pero deshabilitada en el setup)
 */
function resolveWooCommune(order, { stateMap = null, validCommunes = [] } = {}) {
    const shipping = (order && order.shipping) || {};
    const billing = (order && order.billing) || {};
    const stateRaw = clean(shipping.state) || clean(billing.state);
    const cityRaw = clean(shipping.city);
    const cities = [shipping.city, billing.city].map(clean).filter(Boolean);

    const stateListed = !!(stateRaw && stateMap && stateMap.has(stateRaw));
    const stateName = stateListed ? stateMap.get(stateRaw) : stateRaw;
    const stateCommune = stateName ? resolveExactCommune(stateName) : null;
    // el estado dice que el pedido es de otra parte (una comuna fuera de la RM u otra región): una ciudad que "parece" comuna por un error de tipeo no lo desmiente
    const stateElsewhere = stateListed && !stateCommune && !/metropolitana/i.test(stateName);

    let commune = null;
    let source = null;
    if (stateCommune) {
        commune = stateCommune;
        source = 'state';
    } else {
        for (const text of cities) {
            const found = resolveKnownCommuneDetailed(text);
            if (!found.commune) continue;
            if (!found.fuzzy || (!stateElsewhere && found.distance <= MAX_TYPO_DISTANCE)) { commune = found.commune; source = 'city'; break; }
        }
    }

    const isRM = !!commune || /metropolitana/i.test(stateName) || looksMetropolitan(stateRaw, cityRaw) || validCommunes.includes(cityRaw.toLowerCase());
    const zone = commune ? checkOrderCommune([commune], validCommunes, { strict: false }) : { allow: true };
    const reason = !isRM ? 'not_rm' : (zone.allow ? 'ok' : 'inactive');
    return { commune, source, isRM, allow: isRM && zone.allow, reason, stateName, cityText: cityRaw };
}

/** La comuna que se guarda en el paquete: la identificada, o la normalización del texto de ciudad como se hacía antes. */
const communeForPackage = (resolved, order) => {
    if (resolved.commune) return resolved.commune;
    const shipping = (order && order.shipping) || {};
    const billing = (order && order.billing) || {};
    return normalizeCommune(shipping.city || billing.city || 'N/A');
};

module.exports = { MAX_TYPO_DISTANCE, buildStateMap, getStateMap, resolveWooCommune, communeForPackage, _stateMaps: stateMaps };
