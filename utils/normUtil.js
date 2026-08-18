/**
 * Utility functions for data normalization across the system.
 */

const RM_COMMUNES = [
    "SANTIAGO", "LAS CONDES", "VITACURA", "LO BARNECHEA", "PROVIDENCIA", "ÑUÑOA", "LA REINA", 
    "MACUL", "PEÑALOLÉN", "LA FLORIDA", "SAN JOAQUÍN", "LA GRANJA", "SAN RAMÓN", "LA CISTERNA", 
    "EL BOSQUE", "SAN MIGUEL", "LO ESPEJO", "PEDRO AGUIRRE CERDA", "CERRILLOS", "MAIPÚ", 
    "ESTACIÓN CENTRAL", "QUINTA NORMAL", "LO PRADO", "CERRO NAVIA", "RENCA", "INDEPENDENCIA", 
    "RECOLETA", "CONCHALÍ", "HUECHURABA", "QUILICURA", "PUDAHUEL", "LA PINTANA", "SAN BERNARDO", 
    "PUENTE ALTO", "LAMPA", "COLINA", "BUIN", "PAINE", "PEÑAFLOR", "TALAGANTE", "MELIPILLA", 
    "CURACAVÍ", "PIRQUE", "SAN JOSÉ DE MAIPO", "CALERA DE TANGO", "PADRE HURTADO", "EL MONTE", 
    "ISLA DE MAIPO", "MARÍA PINTO", "SAN PEDRO", "ALHUÉ"
];

const ACCENT_MAP = {
    'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U',
    'À': 'A', 'È': 'E', 'Ì': 'I', 'Ò': 'O', 'Ù': 'U',
    'Ä': 'A', 'Ë': 'E', 'Ï': 'I', 'Ö': 'O', 'Ü': 'U',
    // Ñ is folded to N here too (not just a display accent) so any commune
    // containing it — current or future — matches whether or not the source
    // sent the accent correctly, without needing a hardcoded alias per name.
    'Ñ': 'N'
};

// Pre-compute canonical map for fast lookups
const CANONICAL_MAP = {};
// Secondary map ignoring internal spacing entirely (e.g. "SANJOAQUIN" or
// "SAN  JOAQUIN" both resolve), used as a fallback when the spaced form
// doesn't match — covers missing, doubled, or misplaced whitespace.
const NO_SPACE_MAP = {};
for (const rm of RM_COMMUNES) {
    const rmNormalized = rm.split('').map(char => ACCENT_MAP[char] || char).join('');
    CANONICAL_MAP[rmNormalized] = rm;
    NO_SPACE_MAP[rmNormalized.replace(/\s+/g, '')] = rm;
}

/**
 * Normalizes a commune name:
 * 1. Trims whitespace, collapses internal whitespace, treats hyphens/underscores as spaces
 * 2. Converts to Uppercase
 * 3. Removes accents (incl. Ñ→N) & maps to correct canonical name
 * 4. Falls back to a spacing-insensitive match before giving up
 * @param {string} commune
 * @returns {string}
 */
const normalizeCommune = (commune) => {
    if (!commune) return 'SIN COMUNA';

    let normalized = commune.trim().toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    let clean = normalized.split('').map(char => ACCENT_MAP[char] || char).join('');

    // Word-level aliases that aren't just accent/spacing variants
    if (clean === 'SANTIAGO CENTRO' || clean === 'STGO CENTRO' || clean === 'STGO') return 'SANTIAGO';

    if (CANONICAL_MAP[clean]) return CANONICAL_MAP[clean];

    const noSpace = clean.replace(/\s+/g, '');
    if (NO_SPACE_MAP[noSpace]) return NO_SPACE_MAP[noSpace];

    return clean;
};

/**
 * Normalizes a city name.
 * @param {string} city 
 * @returns {string}
 */
const normalizeCity = (city) => {
    if (!city) return 'SANTIAGO';
    return city.trim().toUpperCase();
};

module.exports = {
    normalizeCommune,
    normalizeCity
};
