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
 *
 * SECURITY NOTE: This function removes all HTML markup by stripping < and >
 * characters first, then removes dangerous URL schemes. For user-facing
 * display, prefer escapeHtml() which preserves content while escaping.
 * This function is for cases where plain text content is acceptable.
 */
export function sanitizeText(str: string): string {
	if (!str || typeof str !== 'string') return '';

	let result = str;

	// Step 1: Remove all < and > characters to completely neutralize HTML tags
	// This is the most robust approach as it prevents any tag injection
	result = result.replace(/[<>]/g, '');

	// Step 2: Remove null bytes that could bypass filters
	result = result.replace(/\0/g, '');

	// Step 3: Neutralize dangerous URL schemes by removing the colon
	// This handles javascript:, vbscript:, data: schemes
	// Process character-by-character to avoid multi-character replacement issues
	const dangerousSchemes = ['javascript', 'vbscript', 'data'];
	for (const scheme of dangerousSchemes) {
		// Build regex that matches the scheme followed by optional whitespace and colon
		// Replace only the colon to break the URL scheme
		const regex = new RegExp(`(${scheme})\\s*:`, 'gi');
		result = result.replace(regex, '$1');
	}

	// Step 4: Remove event handler attributes (loop until stable to prevent bypass via nesting)
	let prev: string;
	do {
		prev = result;
		result = result.replace(/\s*on\w+\s*=\s*(['"])[^'"]*\1/gi, '');
		result = result.replace(/\s*on\w+\s*=\s*[^\s]+/gi, '');
	} while (result !== prev);

	// Step 5: Normalize whitespace
	result = result.replace(/[\r\n]+/g, ' ');

	return result.trim();
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
