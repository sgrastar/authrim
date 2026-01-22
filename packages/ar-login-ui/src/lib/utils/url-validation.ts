/**
 * URL validation utilities
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
