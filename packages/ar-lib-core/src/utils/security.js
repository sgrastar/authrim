/**
 * Security Utilities
 *
 * Common security functions to prevent attacks like prototype pollution.
 */
/**
 * Dangerous keys that could be used for prototype pollution attacks
 */
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
/**
 * Sanitize object to prevent prototype pollution
 * Removes dangerous keys like __proto__, constructor, prototype
 *
 * @param obj - The object to sanitize
 * @returns A new object with dangerous keys removed
 */
export function sanitizeObject(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return {};
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (!DANGEROUS_KEYS.includes(key)) {
            result[key] = value;
        }
    }
    return result;
}
/**
 * Check if a key is dangerous (could cause prototype pollution)
 *
 * @param key - The key to check
 * @returns true if the key is dangerous
 */
export function isDangerousKey(key) {
    return DANGEROUS_KEYS.includes(key);
}
