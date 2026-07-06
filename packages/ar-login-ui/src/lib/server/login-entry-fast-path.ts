import { env as dynamicEnv } from '$env/dynamic/public';
import type { RequestEvent } from '@sveltejs/kit';

function getPlatformEnv(event: RequestEvent): Record<string, unknown> | undefined {
	return (event.platform as { env?: Record<string, unknown> } | undefined)?.env;
}

function getConfiguredHost(value: unknown): string | null {
	const text = String(value || '').trim();
	if (!text || text === '__DISABLED__') return null;
	try {
		return new URL(text).host.toLowerCase();
	} catch {
		return null;
	}
}

function getEffectiveRequestHost(event: RequestEvent): string {
	return (
		event.request.headers.get('x-authrim-original-host')?.trim() || event.url.host
	).toLowerCase();
}

function getConfiguredSameOriginHosts(event: RequestEvent): Set<string> {
	const platformEnv = getPlatformEnv(event);
	const hosts = [
		platformEnv?.PUBLIC_API_BASE_URL,
		platformEnv?.PUBLIC_AUTHRIM_ISSUER,
		dynamicEnv.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_AUTHRIM_ISSUER,
		import.meta.env.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_AUTHRIM_ISSUER
	]
		.map(getConfiguredHost)
		.filter((host): host is string => Boolean(host));
	return new Set(hosts);
}

function isSameOriginConfiguredLoginHost(event: RequestEvent): boolean {
	const requestHost = getEffectiveRequestHost(event);
	return getConfiguredSameOriginHosts(event).has(requestHost);
}

function hasProtocolLoginContext(event: RequestEvent): boolean {
	return (
		event.url.searchParams.has('challenge_id') ||
		event.url.searchParams.has('saml_request_id') ||
		event.url.searchParams.get('return_to') === 'saml_sso'
	);
}

export function shouldUseFastPlainLoginShell(event: RequestEvent): boolean {
	if (!isSameOriginConfiguredLoginHost(event)) return false;
	if (hasProtocolLoginContext(event)) return false;
	if (event.url.searchParams.has('discovery_grant')) return false;
	if (event.cookies.get('authrim_session')) return false;
	return true;
}

export function shouldUseFastTenantRootRedirect(event: RequestEvent): boolean {
	if (!isSameOriginConfiguredLoginHost(event)) return false;
	if (event.url.searchParams.has('challenge_id')) return false;
	if (event.cookies.get('authrim_session')) return false;
	return true;
}
