/**
 * URL validation utilities
 *
 * Provides defense-in-depth URL validation for:
 * - Download URLs (trusted domain allowlist)
 * - Redirect URLs (same-origin or HTTPS external)
 * - Return URLs (same-origin only, for post-auth redirects)
 * - Image URLs (HTTPS or data:image only)
 * - CSS color values (style injection prevention)
 */

/**
 * Trusted storage domains for download URLs
 * Add your specific bucket/storage domains here
 */
const TRUSTED_DOWNLOAD_DOMAINS = [
	'storage.googleapis.com'
	// Add specific R2 bucket domains as needed, e.g.:
	// 'your-account-id.r2.cloudflarestorage.com'
];

/**
 * Validate download URL to prevent open redirect attacks
 * Only allows URLs from trusted domains or relative paths
 */
export function isValidDownloadUrl(url: string): boolean {
	if (!url) return false;
	try {
		const parsedUrl = new URL(url, window.location.origin);
		// Allow same-origin URLs
		if (parsedUrl.origin === window.location.origin) return true;

		// Only allow HTTPS for external URLs
		if (parsedUrl.protocol !== 'https:') return false;

		// Check for exact domain match or subdomain of trusted domain
		return TRUSTED_DOWNLOAD_DOMAINS.some((trustedDomain) => {
			// Exact match
			if (parsedUrl.hostname === trustedDomain) return true;
			// Subdomain match (e.g., bucket.storage.googleapis.com)
			if (parsedUrl.hostname.endsWith('.' + trustedDomain)) {
				// Ensure it's a direct subdomain, not deeply nested
				const subdomain = parsedUrl.hostname.slice(0, -(trustedDomain.length + 1));
				// Only allow single-level subdomains (no dots)
				return !subdomain.includes('.');
			}
			return false;
		});
	} catch {
		return false;
	}
}

/**
 * Validate redirect URL from API responses (consent, device, reauth flows).
 * Allows same-origin or HTTPS external URLs.
 * These are typically RP-registered redirect_uris validated by the backend,
 * but we add a client-side check as defense-in-depth.
 */
export function isValidRedirectUrl(url: string): boolean {
	if (!url) return false;
	// Reject protocol-relative URLs (//evil.com) which resolve to attacker-controlled origins
	if (url.startsWith('//')) return false;
	try {
		const parsed = new URL(url, window.location.origin);
		// Same-origin is always allowed
		if (parsed.origin === window.location.origin) return true;
		// External URLs must use HTTPS
		return parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Validate return URL for post-authentication redirect.
 * Only allows same-origin URLs to prevent open redirect attacks.
 * Used after OAuth callback to redirect user back to their original page.
 */
export function isValidReturnUrl(url: string): boolean {
	if (!url) return false;
	// Reject protocol-relative URLs (//evil.com) which resolve to attacker-controlled origins
	if (url.startsWith('//')) return false;
	try {
		const parsed = new URL(url, window.location.origin);
		return parsed.origin === window.location.origin;
	} catch {
		return false;
	}
}

/**
 * Validate image URL for use in <img> src attributes.
 * Allows HTTPS URLs and safe base64-encoded data:image URIs only.
 * Prevents javascript: and other dangerous schemes.
 * SVG data URIs are excluded to prevent XSS via inline SVG event handlers.
 */
export function isValidImageUrl(url: string): boolean {
	if (!url) return false;
	if (url.startsWith('//')) return false;
	// Explicitly reject SVG data URIs — SVG can contain <script> and event handlers (XSS).
	// This guard catches all SVG variants (svg+xml, svg+xml;charset=..., etc.)
	if (/^data:image\/svg/i.test(url)) return false;
	// Allow base64-encoded data:image URIs for safe raster formats only.
	if (/^data:image\/(png|jpeg|jpg|gif|webp|bmp|ico|avif);base64,/i.test(url)) return true;
	try {
		const currentOrigin =
			typeof window !== 'undefined' ? window.location.origin : 'https://login.authrim.invalid';
		const parsed = new URL(url, currentOrigin);
		if (parsed.origin === currentOrigin) return true;
		return parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Validate URL for use in <a href> links displayed in the UI.
 * Only allows http: and https: schemes to prevent javascript:, data:, and other dangerous URIs.
 * Used for client_uri, policy_uri, tos_uri from API responses.
 */
export function isValidLinkUrl(url: string): boolean {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:';
	} catch {
		return false;
	}
}

/**
 * Sanitize CSS color value to prevent style injection.
 * Only allows hex (#fff, #ffffff, #ffffffff), rgb/rgba, hsl/hsla, and named colors.
 * Each numeric value is individually validated to prevent injection via
 * broad character classes.
 * Returns empty string for invalid values.
 */
export function sanitizeColor(color: string | undefined | null): string {
	if (!color || typeof color !== 'string') return '';
	const trimmed = color.trim();

	// Hex colors: #fff (3), #ffffff (6), #ffffffff (8)
	if (/^#[0-9A-Fa-f]{3}$/.test(trimmed)) return trimmed;
	if (/^#[0-9A-Fa-f]{6}$/.test(trimmed)) return trimmed;
	if (/^#[0-9A-Fa-f]{8}$/.test(trimmed)) return trimmed;

	// rgb/rgba: each value captured and validated individually
	const rgbMatch = trimmed.match(
		/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+))?\s*\)$/i
	);
	if (rgbMatch) {
		const [, r, g, b] = rgbMatch;
		if (Number(r) <= 255 && Number(g) <= 255 && Number(b) <= 255) return trimmed;
		return '';
	}

	// hsl/hsla: hue 0-360, saturation/lightness 0-100%, optional alpha 0-1
	const hslMatch = trimmed.match(
		/^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*(?:,\s*(0|1|0?\.\d+))?\s*\)$/i
	);
	if (hslMatch) {
		const [, h, s, l] = hslMatch;
		if (Number(h) <= 360 && Number(s) <= 100 && Number(l) <= 100) return trimmed;
		return '';
	}

	// Named CSS colors (alphabetic only, 3-20 chars)
	if (/^[a-z]{3,20}$/i.test(trimmed)) return trimmed;

	return '';
}
