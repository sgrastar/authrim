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
	tenantId: string
): string {
	const target = new URL(commonDiscoverUrl);
	target.searchParams.set('expected_tenant_id', tenantId);
	target.searchParams.set('return_to', buildCurrentUrlWithoutGrant(url, request));
	return target.toString();
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
					config.config.tenant_id
				)
			);
		}
	}

	if (!config.single_tenant_mode && config.is_common_entry_host) {
		throw redirect(303, '/discover');
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
				config.config.tenant_id
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
