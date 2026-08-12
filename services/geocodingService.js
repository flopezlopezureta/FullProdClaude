
const db = require('../db');
const gisService = require('./gisService');

let isGeocoding = false;

async function singleGeocodeCall(query) {
    try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'FullEnviosApp/1.0'
            },
            // Nominatim has no SLA and this call previously had no timeout at all — a slow/stalled
            // response could hang a JIT dispatch (routes/packages.js awaits this synchronously)
            // indefinitely, which is what made a stuck import look like a broken scanner to the
            // operator. Capped at 3s per attempt.
            signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
            const data = await response.json();
            if (data && data.length > 0) {
                return { 
                    lat: parseFloat(data[0].lat), 
                    lng: parseFloat(data[0].lon) 
                };
            }
        }
    } catch (err) {
        console.error(`[Geocoding] Call failed for query "${query}":`, err.message);
    }
    return null;
}

// Helper function to geocode address
async function geocodeAddress(address, commune, city) {
    if (!address || !commune) return { lat: null, lng: null };
    
    function getDirectionalVariants(addr) {
        if (!addr) return [];
        const variants = [];
        const clean = addr.trim();
        
        const mappings = [
            { regex: /\b(n|n\.)\b/gi, replacement: 'Norte' },
            { regex: /\b(s|s\.)\b/gi, replacement: 'Sur' },
            { regex: /\b(ote|ote\.)\b/gi, replacement: 'Oriente' },
            { regex: /\b(pte|pte\.)\b/gi, replacement: 'Poniente' },
            { regex: /\b(c|c\.|cent|cent\.)\b/gi, replacement: 'Central' },
            
            { regex: /\bnorte\b/gi, replacement: 'N' },
            { regex: /\bsur\b/gi, replacement: 'S' },
            { regex: /\boriente\b/gi, replacement: 'Ote' },
            { regex: /\bponiente\b/gi, replacement: 'Pte' },
            { regex: /\bcentral\b/gi, replacement: 'C' }
        ];
        
        for (const map of mappings) {
            const replaced = clean.replace(map.regex, map.replacement);
            if (replaced !== clean && !variants.includes(replaced)) {
                variants.push(replaced);
            }
        }
        return variants;
    }
    
    try {
        // Attempt 1: Standard query
        const query = `${address}, ${commune}, Chile`;
        let coords = await singleGeocodeCall(query);
        if (coords) return coords;
        
        // Attempt 2: Directional variants of standard query
        const variants = getDirectionalVariants(address);
        for (const v of variants) {
            console.log(`[Geocoding] Standard query yielded no results. Retrying with directional variant: "${v}"`);
            await new Promise(r => setTimeout(r, 1200));
            const variantQuery = `${v}, ${commune}, Chile`;
            coords = await singleGeocodeCall(variantQuery);
            if (coords) return coords;
        }
        
        // Check if there is no prefix (Pasaje/Calle)
        const cleanAddress = address.trim().toLowerCase();
        const hasPrefix = cleanAddress.startsWith('pasaje') || 
                          cleanAddress.startsWith('pje') || 
                          cleanAddress.startsWith('av') || 
                          cleanAddress.startsWith('calle');
                          
        if (!hasPrefix) {
            // Attempt 3: Prepend "Pasaje "
            console.log(`[Geocoding] Retrying with "Pasaje" prefix for: ${address}`);
            await new Promise(r => setTimeout(r, 1200));
            const pasajeQuery = `Pasaje ${address}, ${commune}, Chile`;
            coords = await singleGeocodeCall(pasajeQuery);
            if (coords) return coords;
            
            // Attempt 4: Directional variants of "Pasaje "
            const pasajeVariants = getDirectionalVariants(`Pasaje ${address}`);
            for (const v of pasajeVariants) {
                console.log(`[Geocoding] Retrying with "Pasaje" directional variant: "${v}"`);
                await new Promise(r => setTimeout(r, 1200));
                const variantQuery = `${v}, ${commune}, Chile`;
                coords = await singleGeocodeCall(variantQuery);
                if (coords) return coords;
            }
            
            // Attempt 5: Prepend "Calle "
            console.log(`[Geocoding] Retrying with "Calle" prefix for: ${address}`);
            await new Promise(r => setTimeout(r, 1200));
            const calleQuery = `Calle ${address}, ${commune}, Chile`;
            coords = await singleGeocodeCall(calleQuery);
            if (coords) return coords;
            
            // Attempt 6: Directional variants of "Calle "
            const calleVariants = getDirectionalVariants(`Calle ${address}`);
            for (const v of calleVariants) {
                console.log(`[Geocoding] Retrying with "Calle" directional variant: "${v}"`);
                await new Promise(r => setTimeout(r, 1200));
                const variantQuery = `${v}, ${commune}, Chile`;
                coords = await singleGeocodeCall(variantQuery);
                if (coords) return coords;
            }
        }
    } catch (error) {
        console.error("Geocoding error:", error.message);
    }
    return { lat: null, lng: null };
}

async function triggerBackgroundGeocoding() {
    if (isGeocoding) return;
    isGeocoding = true;
    
    console.log("Starting background geocoding process...");
    try {
        while (true) {
            // Find packages with null coordinates that haven't been tried recently or at all
            const { rows: pending } = await db.query(
                'SELECT id, "recipientAddress", "recipientCommune", "recipientCity" FROM packages WHERE "destLatitude" IS NULL LIMIT 10'
            );
            
            if (pending.length === 0) {
                console.log("No more packages to geocode.");
                break;
            }
            
            for (const pkg of pending) {
                console.log(`Geocoding package ${pkg.id}: ${pkg.recipientAddress}, ${pkg.recipientCommune}`);
                const coords = await geocodeAddress(pkg.recipientAddress, pkg.recipientCommune, pkg.recipientCity);
                
                if (coords.lat !== null) {
                    await db.query(
                        'UPDATE packages SET "destLatitude" = $1, "destLongitude" = $2, "destIsApproximate" = false WHERE id = $3',
                        [coords.lat, coords.lng, pkg.id]
                    );
                } else {
                    // Address couldn't be geocoded — fall back to the commune's real centroid
                    // (computed from actual comuna polygons, see gisService.getComunaCentroid)
                    // instead of the old 0.000001/0.000001 sentinel, a real point in the Gulf of
                    // Guinea that silently poisoned every distance/routing calculation downstream
                    // ("heading to the other side of the world"). Marked destIsApproximate so the
                    // UI can show "~X km to <commune>" instead of presenting it as the exact address.
                    const centroid = gisService.getComunaCentroid(pkg.recipientCommune);
                    const fallbackLat = centroid?.lat ?? 0.000001;
                    const fallbackLng = centroid?.lng ?? 0.000001;
                    await db.query(
                        'UPDATE packages SET "destLatitude" = $1, "destLongitude" = $2, "destIsApproximate" = true WHERE id = $3',
                        [fallbackLat, fallbackLng, pkg.id]
                    );
                }
                // Respect Nominatim rate limit (1 request per second)
                await new Promise(r => setTimeout(r, 1200));
            }
        }
    } catch (error) {
        console.error("Background geocoding error:", error);
    } finally {
        isGeocoding = false;
        console.log("Background geocoding process finished.");
    }
}

module.exports = {
    geocodeAddress,
    triggerBackgroundGeocoding
};
