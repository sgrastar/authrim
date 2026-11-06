/**
 * Where the console loads an image the Admin API stored for the Login UI.
 *
 * Uploads answer a path on the API (`/api/assets/<tenant>/login-ui/<kind>/<file>`), and that path
 * is what settings and themes keep: the Login UI is served where the API is, so the path works
 * there wherever the tenant is reached. The console may be served elsewhere (its own worker, with
 * no proxy to the API), so it reads such a path from the API's origin. Anything else (an https URL
 * the admin entered, a data: URL) is used as it is.
 */
const ASSET_PATH = '/api/assets/';

export function resolveApiAssetUrl(url: string, apiBaseUrl: string): string {
	if (!url.startsWith(ASSET_PATH) || !apiBaseUrl) return url;
	return `${apiBaseUrl.replace(/\/+$/, '')}${url}`;
}

/** {@link resolveApiAssetUrl} against the console's API base URL (PUBLIC_API_BASE_URL). */
export function apiAssetUrl(url: string): string {
	return resolveApiAssetUrl(url, import.meta.env.PUBLIC_API_BASE_URL || '');
}
