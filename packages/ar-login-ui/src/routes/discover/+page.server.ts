import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	fetchDiscoveryConfig,
	getDiscoveryRequestHeaders,
	issueDiscoveryGrant,
	type DiscoveryCandidate,
	type DiscoveryConfigResponse
} from '../../lib/discovery-entry';
import { REMEMBERED_TENANT_COOKIE, readRememberedTenant } from '../../lib/discovery-session';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_DISCOVERY_RESPONSE_BYTES = 256 * 1024;

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

function readDiscoveryGrantContext(formData: FormData | URLSearchParams) {
	const expectedTenantId = String(formData.get('expected_tenant_id') || '').trim();
	const returnTo = String(formData.get('return_to') || '').trim();
	const loginHint = String(formData.get('login_hint') || '').trim();

	return {
		expectedTenantId: expectedTenantId || null,
		returnTo: returnTo || null,
		loginHint: loginHint || null
	};
}

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
		const error: { message?: string } = await readJsonWithLimit<{ message?: string }>(
			response
		).catch(() => ({}));
		throw new Error(error.message || 'Failed to resolve tenant');
	}

	return readJsonWithLimit<DiscoveryResponse>(response);
}

async function readJsonWithLimit<T>(response: Response): Promise<T> {
	const contentLength = response.headers.get('content-length');
	if (contentLength) {
		const parsed = Number.parseInt(contentLength, 10);
		if (Number.isFinite(parsed) && parsed > MAX_DISCOVERY_RESPONSE_BYTES) {
			throw new Error('Discovery response is too large');
		}
	}

	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > MAX_DISCOVERY_RESPONSE_BYTES) {
		throw new Error('Discovery response is too large');
	}
	return JSON.parse(text) as T;
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

function buildCommonDiscoverUrlWithParams(sourceUrl: URL, commonDiscoverUrl: string): string {
	const target = new URL(commonDiscoverUrl);
	for (const key of ['invite_token', 'app_hint', 'expected_tenant_id', 'return_to', 'login_hint']) {
		const value = sourceUrl.searchParams.get(key);
		if (value) {
			target.searchParams.set(key, value);
		}
	}
	return target.toString();
}

function defaultManualMode(
	config: DiscoveryConfigResponse['config']
): 'tenant_code' | 'tenant_slug' {
	if (config.discovery_methods.includes('tenant_code')) {
		return 'tenant_code';
	}

	return 'tenant_slug';
}

async function redirectResolvedCandidate(
	event: Parameters<Actions['resolve']>[0],
	config: DiscoveryConfigResponse,
	candidate: DiscoveryCandidate,
	options?: {
		expectedTenantId?: string | null;
		returnTo?: string | null;
		loginHint?: string | null;
	}
) {
	if (config.is_common_entry_host) {
		const grant = await issueDiscoveryGrant(
			event.fetch,
			{
				tenant_id: candidate.tenant_id,
				expected_tenant_id: options?.expectedTenantId || undefined,
				return_to: options?.returnTo || undefined,
				login_hint: options?.loginHint || undefined
			},
			getDiscoveryRequestHeaders(event)
		);
		throw redirect(303, grant.login_url);
	}

	throw redirect(303, candidate.login_url);
}

export const load: PageServerLoad = async (event) => {
	const discoveryHeaders = getDiscoveryRequestHeaders(event);
	const config = await fetchDiscoveryConfig(event.fetch, discoveryHeaders);
	const rememberedCandidate = readRememberedTenant(event.cookies.get(REMEMBERED_TENANT_COOKIE));
	const inviteToken = event.url.searchParams.get('invite_token');
	const appHint = event.url.searchParams.get('app_hint');
	const discoveryGrantContext = readDiscoveryGrantContext(event.url.searchParams);

	if (
		!config.single_tenant_mode &&
		!config.is_common_entry_host &&
		config.config.redirect_tenant_discover_to_common_entry &&
		config.common_discover_url
	) {
		throw redirect(303, buildCommonDiscoverUrlWithParams(event.url, config.common_discover_url));
	}

	if (config.single_tenant_mode && config.default_candidate && !inviteToken) {
		throw redirect(303, config.default_candidate.login_url);
	}

	if (
		config.is_common_entry_host &&
		config.config.skip_discovery_if_only_one_tenant &&
		config.single_active_tenant_candidate &&
		!inviteToken &&
		!appHint
	) {
		await redirectResolvedCandidate(
			event as never,
			config,
			config.single_active_tenant_candidate,
			discoveryGrantContext
		);
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
			...discoveryGrantContext,
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
		...discoveryGrantContext,
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
		const { expectedTenantId, returnTo, loginHint } = readDiscoveryGrantContext(formData);

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

				await redirectResolvedCandidate(event, config, result.candidate, {
					expectedTenantId,
					returnTo,
					loginHint: loginHint || (mode === 'email' && value ? value : null)
				});

				if (config.config.selection_policy === 'always_select') {
					return {
						mode,
						value,
						loginHint: mode === 'email' ? value : loginHint || '',
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
					loginHint: mode === 'email' ? value : loginHint || '',
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
