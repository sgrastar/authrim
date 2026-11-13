import type { LayoutServerLoad } from './$types';
import { fetchDiscoveryConfig, getDiscoveryRequestHeaders } from '../../lib/discovery-entry';
import { getLoginUILanguageConfig, resolveEnabledLoginUILocale } from '#lib/i18n/config.js';
import { LOGIN_UI_THEME_HINT_COOKIE, normalizeLoginUIThemeMode } from '#lib/theme-bootstrap.js';

const RESOLVED_TENANT_AUTH_ROUTES = new Set([
	'/callback',
	'/ciba',
	'/consent',
	'/device',
	'/device/authorize',
	'/error',
	'/login',
	'/logged-out',
	'/logout-complete',
	'/reauth',
	'/signup',
	'/statements/[slug]',
	'/verify-email-code'
]);

/**
 * The route ID without its layout groups: `/(main)/login` is the page at `/login`. Groups only
 * choose a layout, so a page keeps its behaviour when it moves between groups.
 */
export function _routePathFromRouteId(routeId: string): string {
	return routeId.replace(/\/\([^/)]+\)/g, '') || '/';
}

export function _shouldUseResolvedTenantBranding(routeId: string | null | undefined): boolean {
	if (!routeId) return false;
	const routePath = _routePathFromRouteId(routeId);
	return (
		RESOLVED_TENANT_AUTH_ROUTES.has(routePath) ||
		routePath === '/account' ||
		routePath.startsWith('/account/')
	);
}

export const load: LayoutServerLoad = async (event) => {
	// Get language preference from cookie
	const languageConfig = getLoginUILanguageConfig(event.locals.authenticationMethods?.ui);
	const requestedLanguage = resolveEnabledLoginUILocale(
		event.url?.searchParams.get('lang'),
		languageConfig
	);
	const preferredLanguage =
		requestedLanguage ??
		resolveEnabledLoginUILocale(event.cookies.get('preferredLanguage'), languageConfig) ??
		resolveEnabledLoginUILocale(event.locals.locale, languageConfig) ??
		languageConfig.defaultLocale;
	if (requestedLanguage) {
		event.cookies.set('preferredLanguage', preferredLanguage, {
			path: '/',
			maxAge: 60 * 60 * 24 * 365,
			httpOnly: false,
			sameSite: 'lax',
			secure: event.url?.protocol === 'https:'
		});
	}
	const emailVerificationProtocolEnabled = event.locals.emailVerificationProtocolEnabled === true;
	// The mode the visitor's last page resolved to: where a tenant that sets none (`auto`) opens.
	const themeHint = normalizeLoginUIThemeMode(event.cookies.get(LOGIN_UI_THEME_HINT_COOKIE));
	if (_shouldUseResolvedTenantBranding(event.route.id)) {
		return {
			preferredLanguage,
			themeHint,
			shouldLoadTenantBranding: true,
			emailVerificationProtocolEnabled,
			authenticationMethods: event.locals.authenticationMethods ?? null
		};
	}

	const discoveryHeaders = getDiscoveryRequestHeaders(event);
	const discoveryConfig = await fetchDiscoveryConfig(event.fetch, discoveryHeaders).catch(
		() => null
	);
	const shouldLoadTenantBranding = discoveryConfig
		? discoveryConfig.single_tenant_mode || !discoveryConfig.is_common_entry_host
		: true;

	return {
		preferredLanguage,
		themeHint,
		shouldLoadTenantBranding,
		emailVerificationProtocolEnabled,
		authenticationMethods: shouldLoadTenantBranding
			? (event.locals.authenticationMethods ?? null)
			: null
	};
};
