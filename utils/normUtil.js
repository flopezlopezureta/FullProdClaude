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
// [no-space name, canonical] pairs for the typo-tolerant fallback below.
const NO_SPACE_ENTRIES = [];
for (const rm of RM_COMMUNES) {
    const rmNormalized = rm.split('').map(char => ACCENT_MAP[char] || char).join('');
    CANONICAL_MAP[rmNormalized] = rm;
    const noSpace = rmNormalized.replace(/\s+/g, '');
    NO_SPACE_MAP[noSpace] = rm;
    NO_SPACE_ENTRIES.push([noSpace, rm]);
}

// Damerau-Levenshtein distance (adjacent transpositions count as a single
// edit, which is what catches the most common typo shape, e.g. "Recna" vs
// "Renca").
const editDistance = (a, b) => {
    const al = a.length, bl = b.length;
    const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
    for (let i = 0; i <= al; i++) d[i][0] = i;
    for (let j = 0; j <= bl; j++) d[0][j] = j;
    for (let i = 1; i <= al; i++) {
        for (let j = 1; j <= bl; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
    }
    return d[al][bl];
};

// Typo-tolerant fallback for actual misspellings (not just accents/spacing),
// e.g. "Recna" -> "Renca". Safe to enable: the closest any two real RM
// communes ever get to each other (no-space, accent-stripped) is a distance
// of 3, so allowing up to 2 corrections can never make two different real
// communes ambiguous with each other on their own — as extra insurance,
// the match is still rejected below if a second candidate is ever equally
// close, rather than guessing.
const fuzzyMatchCommune = (noSpaceInput) => {
    if (!noSpaceInput || noSpaceInput.length < 4) return null; // too short to safely guess
    const maxDistance = noSpaceInput.length <= 4 ? 1 : (noSpaceInput.length <= 12 ? 2 : 3);
    let best = null, bestDist = Infinity, secondBestDist = Infinity;
    for (const [key, canonical] of NO_SPACE_ENTRIES) {
        const dist = editDistance(noSpaceInput, key);
        if (dist < bestDist) {
            secondBestDist = bestDist;
            bestDist = dist;
            best = canonical;
        } else if (dist < secondBestDist) {
            secondBestDist = dist;
        }
    }
    if (best && bestDist <= maxDistance && bestDist < secondBestDist) return best;
    return null;
};

/**
 * Normalizes a commune name:
 * 1. Trims whitespace, collapses internal whitespace, treats hyphens/underscores as spaces
 * 2. Converts to Uppercase
 * 3. Removes accents (incl. Ñ→N) & maps to correct canonical name
 * 4. Falls back to a spacing-insensitive match, then an unambiguous typo-tolerant match
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

    const fuzzy = fuzzyMatchCommune(noSpace);
    if (fuzzy) return fuzzy;

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
