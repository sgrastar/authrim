/**
 * Text sanitization utilities for XSS prevention
 *
 * While Svelte automatically escapes template interpolation,
 * this provides an additional defense layer for API responses.
 */

/**
 * HTML entities to escape
 */
const HTML_ENTITIES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#x27;',
	'/': '&#x2F;',
	'`': '&#x60;',
	'=': '&#x3D;'
};

/**
 * Escape HTML special characters in a string
 * This is a defense-in-depth measure on top of Svelte's auto-escaping
 */
export function escapeHtml(str: string): string {
	if (!str || typeof str !== 'string') return '';
	return str.replace(/[&<>"'`=/]/g, (char) => HTML_ENTITIES[char] || char);
}

/**
 * Sanitize a string by removing potential script injection patterns
 * More aggressive than escapeHtml - removes dangerous patterns entirely
 */
export function sanitizeText(str: string): string {
	if (!str || typeof str !== 'string') return '';

	return (
		str
			// Remove script tags and their content
			.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
			// Remove event handlers
			.replace(/\s*on\w+\s*=\s*(['"])[^'"]*\1/gi, '')
			.replace(/\s*on\w+\s*=\s*[^\s>]+/gi, '')
			// Remove javascript: URLs
			.replace(/javascript:/gi, '')
			// Remove data: URLs that could contain scripts
			.replace(/data:\s*text\/html/gi, '')
			// Remove any remaining HTML tags (keep text content)
			.replace(/<[^>]*>/g, '')
			// Trim whitespace
			.trim()
	);
}

/**
 * Sanitize an object's string properties recursively
 * Useful for sanitizing API responses
 */
export function sanitizeObject<T extends Record<string, unknown>>(
	obj: T,
	keysToSanitize: string[]
): T {
	if (!obj || typeof obj !== 'object') return obj;

	const result = { ...obj };

	for (const key of keysToSanitize) {
		if (key in result && typeof result[key] === 'string') {
			(result as Record<string, unknown>)[key] = sanitizeText(result[key] as string);
		}
	}

	return result;
}
