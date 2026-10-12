import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	getDiscoveryRequestHeaders,
	isCurrentSessionActive,
	verifyLoginChallengeForCurrentTenant,
	verifyDiscoveryGrant
} from '../../lib/discovery-entry';
import { fetchCachedLoginDiscoveryConfig } from '../../lib/login-discovery-config-cache';
import { shouldUseFastPlainLoginShell } from '../../lib/server/login-entry-fast-path';

const DISCOVERY_GRANT_VERIFIED_COOKIE = 'authrim_discovery_grant_verified';
const INVALID_CHALLENGE_ERROR_URL = '/error?error=invalid_request';

function buildPublicUrl(url: URL, request: Request): URL {
	const nextUrl = new URL(url);
	const originalHost = request.headers.get('x-authrim-original-host')?.trim();
	if (originalHost) {
		nextUrl.protocol = 'https:';
		nextUrl.host = originalHost;
	}
	return nextUrl;
}

function buildCurrentUrlWithoutGrant(url: URL, request: Request): string {
	const nextUrl = buildPublicUrl(url, request);
	nextUrl.searchParams.delete('discovery_grant');
	return nextUrl.toString();
}

function buildCommonDiscoverRedirect(
	url: URL,
	request: Request,
	commonDiscoverUrl: string,
	tenantId: string,
	hasProtocolLoginContext: boolean
): string {
	const target = new URL(commonDiscoverUrl);
	target.searchParams.set(
		'expected_tenant_id',
		hasProtocolLoginContext ? readExpectedTenantId(url, tenantId) : tenantId
	);
	target.searchParams.set('return_to', buildCurrentUrlWithoutGrant(url, request));
	return target.toString();
}

const TENANT_HINT_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The tenant a protocol request (SAML SSO) belongs to. A request sent to the shared Login UI names
 * it in tenant_hint; otherwise it is the tenant of this host. The value is only what discovery's
 * result must match: a client can change it, which at worst drops the protocol context.
 */
function readExpectedTenantId(url: URL, hostTenantId: string): string {
	const hint = url.searchParams.get('tenant_hint');
	return hint && hint.length <= 63 && TENANT_HINT_PATTERN.test(hint) ? hint : hostTenantId;
}

function buildCommonEntryDiscoverRedirect(url: URL, request: Request, tenantId: string): string {
	const params = new URLSearchParams({
		expected_tenant_id: readExpectedTenantId(url, tenantId),
		return_to: buildCurrentUrlWithoutGrant(url, request)
	});
	return `/discover?${params.toString()}`;
}

function consumeVerifiedGrantCookie(
	event: Parameters<PageServerLoad>[0],
	currentUrl: string
): boolean {
	const verifiedUrl = event.cookies.get(DISCOVERY_GRANT_VERIFIED_COOKIE);
	if (verifiedUrl !== currentUrl) {
		return false;
	}

	event.cookies.delete(DISCOVERY_GRANT_VERIFIED_COOKIE, {
		path: '/login'
	});
	return true;
}

function getDiscoveryConfigCacheKey(
	discoveryHeaders: HeadersInit | undefined,
	event: Parameters<PageServerLoad>[0]
): string {
	return new Headers(discoveryHeaders).get('x-authrim-original-host') || event.url.host;
}

export const load: PageServerLoad = async (event) => {
	const challengeId = event.url.searchParams.get('challenge_id');
	const discoveryHeaders = getDiscoveryRequestHeaders(event);
	const hasProtocolLoginContext =
		!!challengeId ||
		event.url.searchParams.has('saml_request_id') ||
		event.url.searchParams.get('return_to') === 'saml_sso';

	if (challengeId) {
		const bootstrapTarget = event.locals?.loginChallengeThemeTarget;
		if (bootstrapTarget?.challengeId === challengeId) {
			if (bootstrapTarget.valid) {
				return {
					authenticationMethods: event.locals?.authenticationMethods ?? undefined
				};
			}
			throw redirect(303, INVALID_CHALLENGE_ERROR_URL);
		}
		const challengeBelongsToCurrentTenant = await verifyLoginChallengeForCurrentTenant(
			event.fetch,
			challengeId,
			discoveryHeaders
		).catch(() => false);
		if (challengeBelongsToCurrentTenant) {
			return {};
		}
		throw redirect(303, INVALID_CHALLENGE_ERROR_URL);
	}

	if (!hasProtocolLoginContext && event.cookies.get('authrim_session')) {
		const sessionActive = await isCurrentSessionActive(event.fetch, discoveryHeaders).catch(
			() => false
		);
		if (sessionActive) {
			throw redirect(303, '/');
		}
	}

	if (shouldUseFastPlainLoginShell(event)) {
		return {};
	}

	const config = await fetchCachedLoginDiscoveryConfig(
		event.fetch,
		getDiscoveryConfigCacheKey(discoveryHeaders, event),
		discoveryHeaders
	).catch(() => null);
	if (!config) {
		return {};
	}

	const currentUrlWithoutGrant = buildCurrentUrlWithoutGrant(event.url, event.request);
	const discoveryGrant = event.url.searchParams.get('discovery_grant');
	if (discoveryGrant) {
		const verification = await verifyDiscoveryGrant(
			event.fetch,
			{
				grant: discoveryGrant,
				current_url: currentUrlWithoutGrant
			},
			discoveryHeaders
		).catch(() => null);

		if (verification?.valid) {
			if (verification.target_url) {
				const verifiedReturnUrl = new URL(verification.target_url);
				verifiedReturnUrl.searchParams.delete('discovery_grant');
				const verifiedReturnTo = verifiedReturnUrl.toString();
				event.cookies.set(DISCOVERY_GRANT_VERIFIED_COOKIE, verifiedReturnTo, {
					path: '/login',
					httpOnly: true,
					secure: true,
					sameSite: 'lax',
					maxAge: 300
				});
				throw redirect(303, verifiedReturnTo);
			}

			if (event.url.toString() !== currentUrlWithoutGrant) {
				event.cookies.set(DISCOVERY_GRANT_VERIFIED_COOKIE, currentUrlWithoutGrant, {
					path: '/login',
					httpOnly: true,
					secure: true,
					sameSite: 'lax',
					maxAge: 300
				});
				throw redirect(303, currentUrlWithoutGrant);
			}
			return {};
		}

		if (config.common_discover_url) {
			throw redirect(
				303,
				buildCommonDiscoverRedirect(
					event.url,
					event.request,
					config.common_discover_url,
					config.config.tenant_id,
					hasProtocolLoginContext
				)
			);
		}
	}

	if (!config.single_tenant_mode && config.is_common_entry_host) {
		// A URL the discovery grant just sent back here (the same host can be the common entry).
		if (consumeVerifiedGrantCookie(event, currentUrlWithoutGrant)) {
			return {};
		}

		// A protocol request (SAML SSO) is carried to /discover so the grant can return to it.
		throw redirect(
			303,
			hasProtocolLoginContext
				? buildCommonEntryDiscoverRedirect(event.url, event.request, config.config.tenant_id)
				: '/discover'
		);
	}

	if (
		!config.single_tenant_mode &&
		!config.is_common_entry_host &&
		config.config.mode !== 'tenant_only' &&
		config.config.require_common_discovery_before_login &&
		config.common_discover_url
	) {
		if (consumeVerifiedGrantCookie(event, currentUrlWithoutGrant)) {
			return {};
		}

		throw redirect(
			303,
			buildCommonDiscoverRedirect(
				event.url,
				event.request,
				config.common_discover_url,
				// This host's own tenant is the one that counts here: a tenant_hint does not replace it.
				config.config.tenant_id,
				false
			)
		);
	}

	return {};
};

export const actions: Actions = {
	resolve: async () => {
		throw redirect(303, '/discover');
	}
};
