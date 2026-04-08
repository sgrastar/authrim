import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	fetchDiscoveryConfig,
	getDiscoveryRequestHeaders,
	type DiscoveryCandidate,
	type DiscoveryConfigResponse
} from '../../lib/discovery-entry';
import { REMEMBERED_TENANT_COOKIE, readRememberedTenant } from '../../lib/discovery-session';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type DiscoveryMode = 'email' | 'tenant_code' | 'tenant_slug' | 'invite_token' | 'app_hint';

type DiscoveryResponse =
	| { result: 'resolved'; candidate: DiscoveryCandidate; invited_email?: string | null }
	| { result: 'multiple'; candidates: DiscoveryCandidate[] }
	| { result: 'manual_required'; methods: string[]; allow_manual_tenant_entry: boolean }
	| { result: 'not_found'; code: string };

type DiscoveryErrorCode =
	| 'email_not_found'
	| 'email_domain_not_found'
	| 'tenant_code_not_found'
	| 'tenant_slug_not_found'
	| 'invitation_not_found'
	| 'app_hint_not_found'
	| 'not_found'
	| 'value_required'
	| 'manual_required'
	| 'invitation_unresolved'
	| 'resolve_failed';

function buildSignupUrl(
	candidate: DiscoveryCandidate,
	inviteToken: string,
	invitedEmail?: string | null
): string {
	const signupUrl = new URL(candidate.login_url);
	signupUrl.pathname = '/signup';
	signupUrl.searchParams.set('invite_token', inviteToken);
	signupUrl.searchParams.set('tenant', candidate.display_name);
	if (invitedEmail) {
		signupUrl.searchParams.set('email', invitedEmail);
	}
	return signupUrl.toString();
}

async function resolveDiscovery(
	fetchFn: typeof fetch,
	mode: DiscoveryMode,
	value: string,
	headers?: HeadersInit
): Promise<DiscoveryResponse> {
	const requestHeaders = new Headers(headers);
	requestHeaders.set('Content-Type', 'application/json');

	const response = await fetchFn('/api/auth/discovery', {
		method: 'POST',
		headers: requestHeaders,
		body: JSON.stringify({ mode, value })
	});

	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as { message?: string };
		throw new Error(error.message || 'Failed to resolve tenant');
	}

	return (await response.json()) as DiscoveryResponse;
}

function setRememberedTenantCookie(
	cookies: Parameters<PageServerLoad>[0]['cookies'],
	candidate: DiscoveryCandidate
) {
	cookies.set(REMEMBERED_TENANT_COOKIE, JSON.stringify(candidate), {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: COOKIE_MAX_AGE_SECONDS
	});
}

function clearRememberedTenantCookie(cookies: Parameters<PageServerLoad>[0]['cookies']) {
	cookies.delete(REMEMBERED_TENANT_COOKIE, {
		path: '/'
	});
}

function defaultManualMode(
	config: DiscoveryConfigResponse['config']
): 'tenant_code' | 'tenant_slug' {
	if (config.discovery_methods.includes('tenant_code')) {
		return 'tenant_code';
	}

	return 'tenant_slug';
}

export const load: PageServerLoad = async (event) => {
	const discoveryHeaders = getDiscoveryRequestHeaders(event);
	const config = await fetchDiscoveryConfig(event.fetch, discoveryHeaders);
	const rememberedCandidate = readRememberedTenant(event.cookies.get(REMEMBERED_TENANT_COOKIE));
	const inviteToken = event.url.searchParams.get('invite_token');
	const appHint = event.url.searchParams.get('app_hint');

	if (config.single_tenant_mode && config.default_candidate && !inviteToken) {
		throw redirect(303, config.default_candidate.login_url);
	}

	if (
		config.config.mode === 'tenant_only' &&
		!config.is_common_entry_host &&
		!inviteToken &&
		!appHint
	) {
		throw redirect(303, '/login');
	}

	if (!config.single_tenant_mode && !config.is_common_entry_host && !inviteToken && !appHint) {
		throw redirect(303, '/login');
	}

	if (inviteToken) {
		const result = await resolveDiscovery(
			event.fetch,
			'invite_token',
			inviteToken,
			discoveryHeaders
		);
		if (result.result === 'resolved') {
			if (config.config.remember_last_tenant) {
				setRememberedTenantCookie(event.cookies, result.candidate);
			}
			throw redirect(
				303,
				buildSignupUrl(result.candidate, inviteToken, result.invited_email || undefined)
			);
		}

		return {
			config,
			rememberedCandidate,
			inviteToken,
			inviteErrorCode:
				result.result === 'not_found'
					? (result.code as DiscoveryErrorCode)
					: ('invitation_unresolved' as const)
		};
	}

	if (appHint) {
		const result = await resolveDiscovery(event.fetch, 'app_hint', appHint, discoveryHeaders);
		if (result.result === 'resolved') {
			if (config.config.remember_last_tenant) {
				setRememberedTenantCookie(event.cookies, result.candidate);
			}
			throw redirect(303, result.candidate.login_url);
		}
	}

	return {
		config,
		rememberedCandidate,
		inviteToken,
		inviteErrorCode: null
	};
};

export const actions: Actions = {
	resolve: async (event) => {
		const discoveryHeaders = getDiscoveryRequestHeaders(event);
		const config = await fetchDiscoveryConfig(event.fetch, discoveryHeaders);
		const formData = await event.request.formData();
		const mode = String(formData.get('mode') || '') as DiscoveryMode;
		const value = String(formData.get('value') || '').trim();
		const inviteToken = String(formData.get('invite_token') || '').trim();

		if (!config.single_tenant_mode && !config.is_common_entry_host && !inviteToken) {
			throw redirect(303, '/login');
		}

		if (!value) {
			return fail(400, {
				errorCode: 'value_required' as const,
				mode,
				value
			});
		}

		try {
			const result = await resolveDiscovery(event.fetch, mode, value, discoveryHeaders);

			if (result.result === 'resolved') {
				if (config.config.remember_last_tenant) {
					setRememberedTenantCookie(event.cookies, result.candidate);
				} else {
					clearRememberedTenantCookie(event.cookies);
				}

				if (inviteToken || result.candidate.source === 'invitation') {
					throw redirect(
						303,
						buildSignupUrl(
							result.candidate,
							inviteToken || value,
							result.invited_email || undefined
						)
					);
				}

				if (config.is_common_entry_host) {
					throw redirect(303, result.candidate.login_url);
				}

				if (config.config.selection_policy === 'always_select') {
					return {
						mode,
						value,
						error: '',
						candidates: [result.candidate],
						result: 'multiple' as const
					};
				}

				throw redirect(303, result.candidate.login_url);
			}

			if (result.result === 'multiple') {
				return {
					mode,
					value,
					error: '',
					candidates: result.candidates,
					result: 'multiple' as const
				};
			}

			if (result.result === 'manual_required') {
				return {
					mode: defaultManualMode(config.config),
					value,
					errorCode: 'manual_required' as const,
					candidates: [],
					result: 'manual_required' as const
				};
			}

			return fail(404, {
				mode,
				value,
				errorCode: result.code as DiscoveryErrorCode,
				candidates: [],
				result: 'not_found' as const
			});
		} catch (error) {
			if (typeof error === 'object' && error !== null && 'status' in error && 'location' in error) {
				throw error;
			}

			return fail(500, {
				mode,
				value,
				errorCode: 'resolve_failed' as const,
				candidates: [],
				result: 'not_found' as const
			});
		}
	}
};
