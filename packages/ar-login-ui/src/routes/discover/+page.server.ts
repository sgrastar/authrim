import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

const REMEMBERED_TENANT_COOKIE = 'authrim_last_tenant';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type DiscoveryMode = 'email' | 'tenant_code' | 'tenant_slug' | 'invite_token' | 'app_hint';
type DiscoverySource = 'email_domain' | 'tenant_code' | 'tenant_slug' | 'invitation' | 'app_hint';

interface DiscoveryCandidate {
	tenant_id: string;
	tenant_code: string;
	display_name: string;
	logo_url?: string | null;
	login_url: string;
	source: DiscoverySource;
}

interface DiscoveryConfigResponse {
	config: {
		tenant_id: string;
		mode: 'tenant_only' | 'discovery_optional' | 'discovery_required';
		discovery_methods: string[];
		selection_policy: 'auto_if_single' | 'always_select' | 'select_if_multiple' | 'manual_only';
		allow_manual_tenant_entry: boolean;
		remember_last_tenant: boolean;
		redirect_default_login_to_discovery: boolean;
	};
	single_tenant_mode: boolean;
	is_common_entry_host: boolean;
	default_candidate?: DiscoveryCandidate;
}

type DiscoveryResponse =
	| { result: 'resolved'; candidate: DiscoveryCandidate; invited_email?: string | null }
	| { result: 'multiple'; candidates: DiscoveryCandidate[] }
	| { result: 'manual_required'; methods: string[]; allow_manual_tenant_entry: boolean }
	| { result: 'not_found'; code: string };

function readRememberedTenant(rawValue: string | undefined): DiscoveryCandidate | null {
	if (!rawValue) return null;

	try {
		const parsed = JSON.parse(rawValue) as DiscoveryCandidate;
		if (
			typeof parsed?.tenant_id === 'string' &&
			typeof parsed?.tenant_code === 'string' &&
			typeof parsed?.display_name === 'string' &&
			typeof parsed?.login_url === 'string'
		) {
			return parsed;
		}
	} catch {
		// Ignore invalid cookies
	}

	return null;
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

async function fetchDiscoveryConfig(fetchFn: typeof fetch): Promise<DiscoveryConfigResponse> {
	const response = await fetchFn('/api/auth/discovery');
	if (!response.ok) {
		throw new Error('Failed to load discovery config');
	}
	return (await response.json()) as DiscoveryConfigResponse;
}

async function resolveDiscovery(
	fetchFn: typeof fetch,
	mode: DiscoveryMode,
	value: string
): Promise<DiscoveryResponse> {
	const response = await fetchFn('/api/auth/discovery', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
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

function notFoundMessage(code: string): string {
	switch (code) {
		case 'email_domain_not_found':
			return 'This email domain is not mapped to a tenant.';
		case 'tenant_code_not_found':
			return 'No tenant matched that tenant code.';
		case 'tenant_slug_not_found':
			return 'No tenant matched that tenant slug.';
		case 'invitation_not_found':
			return 'This invitation is invalid or has expired.';
		case 'app_hint_not_found':
			return 'No tenant matched that application hint.';
		default:
			return 'No tenant could be resolved.';
	}
}

export const load: PageServerLoad = async (event) => {
	const config = await fetchDiscoveryConfig(event.fetch);
	const rememberedCandidate = readRememberedTenant(event.cookies.get(REMEMBERED_TENANT_COOKIE));
	const inviteToken = event.url.searchParams.get('invite_token');
	const appHint = event.url.searchParams.get('app_hint');

	if (config.single_tenant_mode && config.default_candidate && !inviteToken) {
		throw redirect(303, config.default_candidate.login_url);
	}

	if (config.config.mode === 'tenant_only' && !inviteToken && !appHint) {
		throw redirect(303, '/login');
	}

	if (inviteToken) {
		const result = await resolveDiscovery(event.fetch, 'invite_token', inviteToken);
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
			inviteError:
				result.result === 'not_found'
					? notFoundMessage(result.code)
					: 'The invitation could not be resolved.'
		};
	}

	if (appHint) {
		const result = await resolveDiscovery(event.fetch, 'app_hint', appHint);
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
		inviteError: null
	};
};

export const actions: Actions = {
	resolve: async (event) => {
		const config = await fetchDiscoveryConfig(event.fetch);
		const formData = await event.request.formData();
		const mode = String(formData.get('mode') || '') as DiscoveryMode;
		const value = String(formData.get('value') || '').trim();
		const inviteToken = String(formData.get('invite_token') || '').trim();

		if (!value) {
			return fail(400, {
				error: 'A value is required.',
				mode,
				value
			});
		}

		try {
			const result = await resolveDiscovery(event.fetch, mode, value);

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
					mode,
					value,
					error: 'Tenant could not be resolved automatically. Use tenant code or slug.',
					candidates: [],
					result: 'manual_required' as const
				};
			}

			return fail(404, {
				mode,
				value,
				error: notFoundMessage(result.code),
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
				error: error instanceof Error ? error.message : 'Failed to resolve tenant',
				candidates: [],
				result: 'not_found' as const
			});
		}
	}
};
