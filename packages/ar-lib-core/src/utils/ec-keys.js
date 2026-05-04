/**
 * EC Key Generation and Management Utilities
 *
 * Provides functions for generating and exporting EC (Elliptic Curve) key pairs
 * for JWT signing using ES256, ES384, and ES512 algorithms.
 * Required for OpenID4VP/VCI and SD-JWT VC support (Phase 9).
 *
 * HAIP requires ES256, ES384, or ES512 for high-assurance credentials.
 *
 * @see RFC 7518 - JSON Web Algorithms (JWA)
 * @see draft-oid4vc-haip-sd-jwt-vc-06
 */
import { generateKeyPair, exportJWK, exportPKCS8, importJWK } from 'jose';
// =============================================================================
// Key Import Cache (LRU)
// =============================================================================
/** Maximum number of cached keys */
const MAX_KEY_CACHE_SIZE = 100;
/** Cache TTL in milliseconds (1 hour) */
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;
/** Cache for imported public keys */
const publicKeyCache = new Map();
/** Cache for imported private keys */
const privateKeyCache = new Map();
/**
 * Generate a cache key from a JWK
 *
 * Uses the JWK thumbprint-like hash for public keys,
 * and includes 'd' parameter for private keys.
 *
 * @param jwk - JWK to generate cache key for
 * @param isPrivate - Whether this is a private key
 * @returns Cache key string
 */
function generateCacheKey(jwk, isPrivate) {
    // Use essential parameters that uniquely identify the key
    const parts = [jwk.kty, jwk.crv, jwk.x, jwk.y];
    if (isPrivate && jwk.d) {
        parts.push(jwk.d);
    }
    return parts.filter(Boolean).join(':');
}
/**
 * Evict expired and LRU entries from a cache
 *
 * @param cache - The cache to clean up
 */
function evictFromCache(cache) {
    const now = Date.now();
    // First, remove expired entries
    for (const [key, entry] of cache.entries()) {
        if (now - entry.timestamp > KEY_CACHE_TTL_MS) {
            cache.delete(key);
        }
    }
    // If still over limit, remove LRU entries
    if (cache.size > MAX_KEY_CACHE_SIZE) {
        const entries = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        const toRemove = cache.size - MAX_KEY_CACHE_SIZE;
        for (let i = 0; i < toRemove; i++) {
            cache.delete(entries[i][0]);
        }
    }
}
/**
 * Clear all key caches
 *
 * Useful for testing or when security-critical events occur.
 */
export function clearKeyCaches() {
    publicKeyCache.clear();
    privateKeyCache.clear();
}
/**
 * Get cache statistics (for monitoring)
 *
 * @returns Cache statistics
 */
export function getKeyCacheStats() {
    return {
        publicKeyCount: publicKeyCache.size,
        privateKeyCount: privateKeyCache.size,
    };
}
/**
 * Algorithm to curve mapping
 */
export const ALGORITHM_TO_CURVE = {
    ES256: 'P-256',
    ES384: 'P-384',
    ES512: 'P-521',
};
/**
 * Curve to algorithm mapping
 */
export const CURVE_TO_ALGORITHM = {
    'P-256': 'ES256',
    'P-384': 'ES384',
    'P-521': 'ES512',
};
/**
 * Generate EC key pair for signing
 *
 * @param algorithm - EC algorithm (ES256, ES384, ES512)
 * @returns Promise<ECKeyPair>
 */
export async function generateECKeyPair(algorithm = 'ES256') {
    const { publicKey, privateKey } = await generateKeyPair(algorithm, {
        extractable: true,
    });
    return {
        publicKey: publicKey,
        privateKey: privateKey,
        algorithm,
        curve: ALGORITHM_TO_CURVE[algorithm],
    };
}
/**
 * Export EC public key as JWK format
 *
 * @param publicKey - Public key to export
 * @param algorithm - EC algorithm
 * @param kid - Key ID (optional)
 * @returns Promise<JWK>
 */
export async function exportECPublicJWK(publicKey, algorithm, kid) {
    const jwk = await exportJWK(publicKey);
    return {
        ...jwk,
        kty: 'EC',
        use: 'sig',
        alg: algorithm,
        ...(kid && { kid }),
    };
}
/**
 * Export EC private key as PEM format (PKCS#8)
 *
 * @param privateKey - Private key to export
 * @returns Promise<string> - PEM-formatted private key
 */
export async function exportECPrivateKey(privateKey) {
    return await exportPKCS8(privateKey);
}
/**
 * Generate a complete EC key set with public JWK and private PEM
 *
 * @param kid - Key ID
 * @param algorithm - EC algorithm (default: ES256)
 * @returns Promise<ECKeySet>
 */
export async function generateECKeySet(kid, algorithm = 'ES256') {
    const { publicKey, privateKey, curve } = await generateECKeyPair(algorithm);
    const publicJWK = await exportECPublicJWK(publicKey, algorithm, kid);
    const privatePEM = await exportECPrivateKey(privateKey);
    return {
        kid,
        algorithm,
        curve,
        publicJWK,
        privatePEM,
        publicKey,
        privateKey,
    };
}
/**
 * Import EC public key from JWK (with caching)
 *
 * Keys are cached by their JWK parameters to avoid repeated
 * expensive import operations. Cache uses LRU eviction.
 *
 * @param jwk - JWK to import
 * @param options - Import options
 * @returns Promise<CryptoKey>
 */
export async function importECPublicKey(jwk, options = {}) {
    const algorithm = jwk.alg;
    if (!algorithm || !['ES256', 'ES384', 'ES512'].includes(algorithm)) {
        throw new Error(`Unsupported or missing algorithm: ${algorithm}`);
    }
    // Check cache first (unless skipCache is set)
    if (!options.skipCache) {
        const cacheKey = generateCacheKey(jwk, false);
        const cached = publicKeyCache.get(cacheKey);
        if (cached) {
            const now = Date.now();
            // Check if not expired
            if (now - cached.timestamp <= KEY_CACHE_TTL_MS) {
                // Update last access time for LRU
                cached.lastAccess = now;
                return cached.key;
            }
            else {
                // Expired, remove from cache
                publicKeyCache.delete(cacheKey);
            }
        }
    }
    // Import the key
    const cryptoKey = (await importJWK(jwk, algorithm));
    // Cache the imported key
    if (!options.skipCache) {
        const cacheKey = generateCacheKey(jwk, false);
        const now = Date.now();
        // Evict old entries if needed
        if (publicKeyCache.size >= MAX_KEY_CACHE_SIZE) {
            evictFromCache(publicKeyCache);
        }
        publicKeyCache.set(cacheKey, {
            key: cryptoKey,
            timestamp: now,
            lastAccess: now,
        });
    }
    return cryptoKey;
}
/**
 * Import EC private key from JWK (with caching)
 *
 * Keys are cached by their JWK parameters to avoid repeated
 * expensive import operations. Cache uses LRU eviction.
 *
 * @param jwk - JWK to import (must include private key 'd' parameter)
 * @param options - Import options
 * @returns Promise<CryptoKey>
 */
export async function importECPrivateKey(jwk, options = {}) {
    if (!jwk.d) {
        throw new Error('JWK does not contain private key material');
    }
    const algorithm = jwk.alg;
    if (!algorithm || !['ES256', 'ES384', 'ES512'].includes(algorithm)) {
        throw new Error(`Unsupported or missing algorithm: ${algorithm}`);
    }
    // Check cache first (unless skipCache is set)
    if (!options.skipCache) {
        const cacheKey = generateCacheKey(jwk, true);
        const cached = privateKeyCache.get(cacheKey);
        if (cached) {
            const now = Date.now();
            // Check if not expired
            if (now - cached.timestamp <= KEY_CACHE_TTL_MS) {
                // Update last access time for LRU
                cached.lastAccess = now;
                return cached.key;
            }
            else {
                // Expired, remove from cache
                privateKeyCache.delete(cacheKey);
            }
        }
    }
    // Import the key
    const cryptoKey = (await importJWK(jwk, algorithm));
    // Cache the imported key
    if (!options.skipCache) {
        const cacheKey = generateCacheKey(jwk, true);
        const now = Date.now();
        // Evict old entries if needed
        if (privateKeyCache.size >= MAX_KEY_CACHE_SIZE) {
            evictFromCache(privateKeyCache);
        }
        privateKeyCache.set(cacheKey, {
            key: cryptoKey,
            timestamp: now,
            lastAccess: now,
        });
    }
    return cryptoKey;
}
/**
 * Get the EC curve from a JWK
 *
 * @param jwk - JWK to inspect
 * @returns ECCurve or null
 */
export function getECCurve(jwk) {
    if (jwk.kty !== 'EC' || !jwk.crv) {
        return null;
    }
    if (['P-256', 'P-384', 'P-521'].includes(jwk.crv)) {
        return jwk.crv;
    }
    return null;
}
/**
 * Get the algorithm for a given EC curve
 *
 * @param curve - EC curve
 * @returns ECAlgorithm
 */
export function getAlgorithmForCurve(curve) {
    return CURVE_TO_ALGORITHM[curve];
}
/**
 * Validate that a JWK is a valid EC key for signing
 *
 * @param jwk - JWK to validate
 * @returns Validation result
 */
export function validateECSigningKey(jwk) {
    if (jwk.kty !== 'EC') {
        return { valid: false, error: 'Key type must be EC' };
    }
    if (jwk.use && jwk.use !== 'sig') {
        return { valid: false, error: 'Key use must be "sig" for signing' };
    }
    const curve = getECCurve(jwk);
    if (!curve) {
        return { valid: false, error: 'Invalid or unsupported curve' };
    }
    const algorithm = getAlgorithmForCurve(curve);
    // Validate algorithm matches curve if specified
    if (jwk.alg && jwk.alg !== algorithm) {
        return { valid: false, error: `Algorithm ${jwk.alg} does not match curve ${curve}` };
    }
    // Check required parameters for EC public key
    if (!jwk.x || !jwk.y) {
        return { valid: false, error: 'Missing x or y coordinate' };
    }
    return { valid: true, algorithm, curve };
}
/**
 * Generate a thumbprint (JWK Thumbprint) for an EC key
 *
 * @param jwk - JWK to generate thumbprint for
 * @returns Promise<string> - Base64url encoded thumbprint
 */
export async function generateECKeyThumbprint(jwk) {
    // Required members for EC key thumbprint (RFC 7638)
    const thumbprintInput = JSON.stringify({
        crv: jwk.crv,
        kty: jwk.kty,
        x: jwk.x,
        y: jwk.y,
    });
    const encoder = new TextEncoder();
    const data = encoder.encode(thumbprintInput);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    // Base64url encode
    const bytes = new Uint8Array(hashBuffer);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]/g, '');
}
/**
 * Check if two EC public keys are equivalent
 *
 * @param jwk1 - First JWK
 * @param jwk2 - Second JWK
 * @returns True if keys are equivalent
 */
export function areECKeysEqual(jwk1, jwk2) {
    if (jwk1.kty !== 'EC' || jwk2.kty !== 'EC') {
        return false;
    }
    return jwk1.crv === jwk2.crv && jwk1.x === jwk2.x && jwk1.y === jwk2.y;
}
