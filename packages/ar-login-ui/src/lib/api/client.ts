/**
 * API Client for Authrim
 * Handles communication with the backend API
 */

import { browser } from '$app/environment';
import { getAuthConfig } from '$lib/auth';
import { generateLoginUiPKCE } from '$lib/authrim/pkce';
import { getDiagnosticSessionId as getLoggerSessionId } from '$lib/stores/diagnostic';
import { authrimFetch } from '$lib/authrim/fetch';
import {
	LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS,
	LOGIN_UI_SESSION_STORAGE_KEYS
} from '$lib/authrim/storage-keys';
import type {
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';

interface ApiFetchOptions extends RequestInit {
	baseUrl?: string;
}

// Type definitions
interface User {
	id: string;
	email: string;
	email_verified: boolean;
	name?: string | null;
	picture?: string | null;
	phone_number?: string | null;
	phone_number_verified?: boolean;
	given_name?: string | null;
	family_name?: string | null;
	created_at: number;
	updated_at: number;
	last_login_at?: number;
	[key: string]: unknown;
}

interface Passkey {
	id: string;
	user_id: string;
	credential_id: string;
	device_name?: string;
	created_at: number;
	last_used_at?: number;
}

interface Client {
	client_id: string;
	client_name: string;
	redirect_uris: string[];
	grant_types: string[];
	response_types: string[];
	scope?: string;
	logo_uri?: string | null;
	client_uri?: string | null;
	policy_uri?: string | null;
	tos_uri?: string | null;
	is_trusted?: boolean;
	skip_consent?: boolean;
	allow_claims_without_scope?: boolean;
	created_at: number;
	updated_at: number;
}

interface Activity {
	id: string;
	type: string;
	timestamp: number;
	[key: string]: unknown;
}

interface AuditLogEntry {
	id: string;
	userId?: string;
	user?: {
		id: string;
		email: string;
		name?: string;
		picture?: string;
	};
	action: string;
	resourceType?: string;
	resourceId?: string;
	ipAddress?: string;
	userAgent?: string;
	metadata?: Record<string, unknown>;
	createdAt: string;
}

interface CustomField {
	key: string;
	value: unknown;
}

interface ScimToken {
	tokenHash: string;
	description: string;
	createdAt: string;
	expiresAt: string | null;
	enabled: boolean;
}

export interface APIError {
	error: string;
	error_description: string;
	error_details?: Record<string, unknown>;
	webauthn_signal?: {
		unknown_credential?: boolean;
	};
	extensions?: Record<string, unknown>;
}

interface DirectAuthPkceState {
	codeVerifier: string;
}

interface DirectEmailCodeState extends DirectAuthPkceState {
	attemptId: string;
}

interface ManagedDirectSessionResponse {
	ok: boolean;
	session: {
		userId: string;
		createdAt: number;
		expiresAt: number;
		authTime?: number;
		acr?: string;
		amr?: string[];
	};
	user: {
		id: string;
		email: string;
		name?: string | null;
	};
	redirect_url?: string;
	authorization?: {
		challenge_id: string;
		type: 'login' | 'reauth';
	};
	migration?: DirectoryPasswordMigrationResponse['migration'];
}

interface DirectoryPasswordMigrationResponse {
	ok: false;
	migration: {
		required: boolean;
		action: 'prompt_passkey' | 'require_passkey';
		transaction_id?: string;
		transaction_token?: string;
		expires_at?: number;
		campaign_id: string;
		state: string;
		reason?: string;
		passkey_required_at?: number | null;
		email_code_fallback_mode?: string;
		email_code_fallback_available?: boolean;
		email_code_fallback?: {
			transaction_id: string;
			transaction_token: string;
			expires_at: number;
			masked_email: string;
		};
	};
	user?: {
		id: string;
		email: string;
		name?: string | null;
	};
}

interface DirectoryPasswordRecoveryResponse {
	ok: false;
	recovery: {
		required: boolean;
		reason: 'directory_unavailable';
		transaction_id: string;
		transaction_token: string;
		expires_at: number;
		masked_email: string;
	};
	user?: {
		id: string;
		email: string;
		name?: string | null;
	};
}

const directPasskeyLoginPkce = new Map<string, DirectAuthPkceState>();
const directPasskeySignupPkce = new Map<string, DirectAuthPkceState>();
const directEmailCodePkce = new Map<string, DirectEmailCodeState>();

// Get API base URL from the current browser origin or use the configured backend fallback.
// The Login UI worker proxies same-origin /api/* requests to PUBLIC_API_BASE_URL server-side,
// which avoids browser CORS for tenant/custom-domain login surfaces.
export function resolveApiBaseUrl(): string {
	// In browser, keep API calls same-origin and let hooks.server.ts proxy upstream.
	if (browser && typeof window !== 'undefined') {
		return window.location.origin;
	}

	// Try to get from environment variable (if set during build)
	try {
		// Use dynamic import to avoid build-time errors
		const envUrl = import.meta.env.PUBLIC_API_BASE_URL;
		if (envUrl) return envUrl;
	} catch {
		// Environment variable not set
	}

	// Default for SSR/build time
	return 'http://localhost:8786';
}

export const API_BASE_URL = resolveApiBaseUrl();

const DEFAULT_API_TIMEOUT = 30000; // 30 seconds

/**
 * Get the current diagnostic session ID.
 * Uses DiagnosticLogger if enabled, otherwise falls back to sessionStorage.
 */
export function getDiagnosticSessionId(): string | undefined {
	if (!browser) return undefined;

	// Prefer the DiagnosticLogger's session ID for consistency with ingest logs
	const fromLogger = getLoggerSessionId();
	if (fromLogger) return fromLogger;

	// Fallback: generate/persist via sessionStorage when logger is disabled
	const FALLBACK_KEY = LOGIN_UI_SESSION_STORAGE_KEYS.diagnosticSessionId;
	let sessionId = sessionStorage.getItem(FALLBACK_KEY);
	if (!sessionId) {
		const legacySessionId = sessionStorage.getItem(
			LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.diagnosticSessionId
		);
		if (legacySessionId) {
			sessionId = legacySessionId;
			sessionStorage.removeItem(LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.diagnosticSessionId);
			sessionStorage.setItem(FALLBACK_KEY, sessionId);
		}
	}
	if (!sessionId) {
		try {
			sessionId = crypto.randomUUID();
		} catch {
			const randomBytes = crypto.getRandomValues(new Uint8Array(8));
			const randomStr = Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
			sessionId = `diag_${Date.now()}_${randomStr}`;
		}
		sessionStorage.setItem(FALLBACK_KEY, sessionId);
	}
	return sessionId;
}

export function buildDiagnosticHeaders(headers?: HeadersInit): Headers {
	const merged = new Headers(headers);
	const sessionId = getDiagnosticSessionId();
	if (sessionId) {
		merged.set('X-Diagnostic-Session-Id', sessionId);
	}
	return merged;
}

/**
 * Generic fetch wrapper with error handling
 */
async function apiFetch<T>(
	endpoint: string,
	options: ApiFetchOptions = {}
): Promise<{ data?: T; error?: APIError }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), DEFAULT_API_TIMEOUT);

	try {
		const { baseUrl = API_BASE_URL, ...requestOptions } = options;
		const headers = buildDiagnosticHeaders(requestOptions.headers);
		if (!headers.has('Content-Type')) {
			headers.set('Content-Type', 'application/json');
		}
		const response = await authrimFetch(endpoint, {
			...requestOptions,
			baseUrl,
			signal: controller.signal,
			headers
		});

		// Handle empty response body (e.g., 204 No Content)
		let data: unknown;
		const contentType = response.headers.get('content-type');
		if (contentType?.includes('application/json')) {
			data = await response.json();
		} else {
			const text = await response.text();
			if (text) {
				try {
					data = JSON.parse(text);
				} catch {
					data = {};
				}
			} else {
				data = {};
			}
		}

		if (!response.ok) {
			return { error: data as APIError };
		}

		return { data: data as T };
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') {
			return {
				error: {
					error: 'timeout',
					error_description: 'Request timed out'
				}
			};
		}
		console.error('API fetch error:', error);
		// SECURITY: Do not expose internal error details to prevent information leakage
		return {
			error: {
				error: 'network_error',
				error_description: 'Network error occurred'
			}
		};
	} finally {
		clearTimeout(timeoutId);
	}
}

async function createDirectAuthPkce() {
	const pkce = await generateLoginUiPKCE();
	return {
		codeVerifier: pkce.codeVerifier,
		codeChallenge: pkce.codeChallenge,
		codeChallengeMethod: pkce.codeChallengeMethod
	};
}

function normalizeDirectEmail(value: string): string {
	return value.trim().toLowerCase();
}

function getDirectEmailCodeStateKey(email: string): string {
	return `${LOGIN_UI_SESSION_STORAGE_KEYS.directEmailCodeStatePrefix}${normalizeDirectEmail(email)}`;
}

function getLegacyDirectEmailCodeStateKey(email: string): string {
	return `${LOGIN_UI_LEGACY_SESSION_STORAGE_KEYS.directEmailCodeStatePrefix}${normalizeDirectEmail(email)}`;
}

function persistDirectEmailCodeState(email: string, state: DirectEmailCodeState): void {
	const normalizedEmail = normalizeDirectEmail(email);
	directEmailCodePkce.set(normalizedEmail, state);
	if (!browser) {
		return;
	}

	try {
		sessionStorage.setItem(getDirectEmailCodeStateKey(normalizedEmail), JSON.stringify(state));
	} catch {
		// Session storage is a convenience for page navigation; API errors remain fail-closed.
	}
}

function readDirectEmailCodeState(email: string): DirectEmailCodeState | null {
	const normalizedEmail = normalizeDirectEmail(email);
	const memoryState = directEmailCodePkce.get(normalizedEmail);

	if (!browser) {
		return memoryState ?? null;
	}

	try {
		const key = getDirectEmailCodeStateKey(normalizedEmail);
		const legacyKey = getLegacyDirectEmailCodeStateKey(normalizedEmail);
		const raw = sessionStorage.getItem(key) ?? sessionStorage.getItem(legacyKey);
		if (!raw) {
			return memoryState ?? null;
		}

		const parsed = JSON.parse(raw) as Partial<DirectEmailCodeState>;
		if (typeof parsed.attemptId === 'string' && typeof parsed.codeVerifier === 'string') {
			return {
				attemptId: parsed.attemptId,
				codeVerifier: parsed.codeVerifier
			};
		}
	} catch {
		return memoryState ?? null;
	}

	return memoryState ?? null;
}

function clearDirectEmailCodeState(email: string): void {
	const normalizedEmail = normalizeDirectEmail(email);
	directEmailCodePkce.delete(normalizedEmail);
	if (!browser) return;

	try {
		sessionStorage.removeItem(getDirectEmailCodeStateKey(normalizedEmail));
		sessionStorage.removeItem(getLegacyDirectEmailCodeStateKey(normalizedEmail));
	} catch {
		// State also lives in memory for the current page lifecycle.
	}
}

async function finalizeManagedDirectAuthSession(
	directAuthArtifact: string,
	codeVerifier: string,
	authorizationChallengeId?: string,
	deferAuthorizationContinuation = false
): Promise<{ data?: ManagedDirectSessionResponse; error?: APIError }> {
	return apiFetch<ManagedDirectSessionResponse>('/api/v1/auth/direct/session', {
		method: 'POST',
		body: JSON.stringify({
			direct_auth_artifact: directAuthArtifact,
			client_id: getAuthConfig().clientId,
			code_verifier: codeVerifier,
			channel: 'browser',
			authorization_challenge_id: authorizationChallengeId,
			defer_authorization_continuation: deferAuthorizationContinuation
		})
	});
}

function directSessionToLegacyAuthResponse(data: ManagedDirectSessionResponse): {
	verified: boolean;
	userId: string;
	user: User;
	session: {
		authTime?: number;
		acr?: string;
		amr?: string[];
		createdAt: number;
		expiresAt: number;
	};
	redirect_url?: string;
} {
	return {
		verified: true,
		userId: data.user.id,
		redirect_url: data.redirect_url,
		session: {
			authTime: data.session.authTime,
			acr: data.session.acr,
			amr: data.session.amr,
			createdAt: data.session.createdAt,
			expiresAt: data.session.expiresAt
		},
		user: {
			id: data.user.id,
			email: data.user.email,
			email_verified: true,
			name: data.user.name,
			created_at: data.session.createdAt,
			updated_at: data.session.createdAt
		}
	};
}

/**
 * Admin API - User Management
 */
export const adminUsersAPI = {
	/**
	 * List users with pagination and search
	 */
	async list(
		params: {
			page?: number;
			limit?: number;
			search?: string;
			verified?: 'true' | 'false';
		} = {}
	) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.search) queryParams.set('search', params.search);
		if (params.verified) queryParams.set('verified', params.verified);

		const query = queryParams.toString();
		return apiFetch<{
			users: User[];
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
		}>(`/api/admin/users${query ? '?' + query : ''}`);
	},

	/**
	 * Get user details by ID
	 */
	async get(userId: string) {
		return apiFetch<{
			user: User;
			passkeys: Passkey[];
			customFields: CustomField[];
		}>(`/api/admin/users/${userId}`);
	},

	/**
	 * Create a new user
	 */
	async create(userData: {
		email: string;
		name?: string;
		email_verified?: boolean;
		phone_number?: string;
		phone_number_verified?: boolean;
		[key: string]: unknown;
	}) {
		return apiFetch<{ user: User }>('/api/admin/users', {
			method: 'POST',
			body: JSON.stringify(userData)
		});
	},

	/**
	 * Update user
	 */
	async update(
		userId: string,
		updates: {
			name?: string;
			email_verified?: boolean;
			phone_number?: string;
			phone_number_verified?: boolean;
			picture?: string;
		}
	) {
		return apiFetch<{ user: User }>(`/api/admin/users/${userId}`, {
			method: 'PUT',
			body: JSON.stringify(updates)
		});
	},

	/**
	 * Delete user
	 */
	async delete(userId: string) {
		return apiFetch<{ success: boolean; message: string }>(`/api/admin/users/${userId}`, {
			method: 'DELETE'
		});
	}
};

/**
 * Admin API - Client Management
 */
export const adminClientsAPI = {
	/**
	 * List OAuth clients with pagination and search
	 */
	async list(params: { page?: number; limit?: number; search?: string } = {}) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.search) queryParams.set('search', params.search);

		const query = queryParams.toString();
		return apiFetch<{
			clients: Client[];
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
		}>(`/api/admin/clients${query ? '?' + query : ''}`);
	},

	/**
	 * Create a new OAuth client
	 */
	async create(clientData: {
		client_name: string;
		redirect_uris: string[];
		grant_types?: string[];
		response_types?: string[];
		scope?: string;
		logo_uri?: string;
		client_uri?: string;
		policy_uri?: string;
		tos_uri?: string;
		contacts?: string[];
		token_endpoint_auth_method?: string;
		subject_type?: string;
		sector_identifier_uri?: string;
		is_trusted?: boolean;
		skip_consent?: boolean;
		allow_claims_without_scope?: boolean;
	}) {
		return apiFetch<{ client: Client & { client_secret: string } }>('/api/admin/clients', {
			method: 'POST',
			body: JSON.stringify(clientData)
		});
	},

	/**
	 * Get client details by ID
	 */
	async get(clientId: string) {
		return apiFetch<{ client: Client }>(`/api/admin/clients/${clientId}`);
	},

	/**
	 * Update client
	 */
	async update(
		clientId: string,
		updates: {
			client_name?: string;
			redirect_uris?: string[];
			grant_types?: string[];
			scope?: string;
			logo_uri?: string | null;
			client_uri?: string | null;
			policy_uri?: string | null;
			tos_uri?: string | null;
			is_trusted?: boolean;
			skip_consent?: boolean;
			allow_claims_without_scope?: boolean;
		}
	) {
		return apiFetch<{ client: Client }>(`/api/admin/clients/${clientId}`, {
			method: 'PUT',
			body: JSON.stringify(updates)
		});
	},

	/**
	 * Delete client
	 */
	async delete(clientId: string) {
		return apiFetch<{ success: boolean; message: string }>(`/api/admin/clients/${clientId}`, {
			method: 'DELETE'
		});
	},

	/**
	 * Bulk delete clients
	 */
	async bulkDelete(clientIds: string[]) {
		return apiFetch<{ success: boolean; deleted: number; requested: number; errors?: string[] }>(
			'/api/admin/clients/bulk',
			{
				method: 'DELETE',
				body: JSON.stringify({ client_ids: clientIds })
			}
		);
	}
};

/**
 * Admin API - Statistics
 */
export const adminStatsAPI = {
	/**
	 * Get admin dashboard statistics
	 */
	async get() {
		return apiFetch<{
			stats: {
				activeUsers: number;
				totalUsers: number;
				registeredClients: number;
				newUsersToday: number;
				loginsToday: number;
			};
			recentActivity: Activity[];
		}>('/api/admin/stats');
	}
};

/**
 * Admin Sessions API
 */
export const adminSessionsAPI = {
	/**
	 * List sessions with pagination
	 */
	async list(
		params: {
			page?: number;
			limit?: number;
			userId?: string;
			active?: 'true' | 'false';
		} = {}
	) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.userId) queryParams.set('userId', params.userId);
		if (params.active) queryParams.set('active', params.active);

		const query = queryParams.toString();
		return apiFetch<{
			sessions: Array<{
				id: string;
				user_id: string;
				user_email: string;
				user_name?: string;
				created_at: string;
				last_accessed_at: string;
				expires_at: string;
				ip_address?: string;
				user_agent?: string;
				is_active: boolean;
			}>;
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
				hasNext: boolean;
				hasPrev: boolean;
			};
		}>(`/api/admin/sessions${query ? '?' + query : ''}`);
	},

	/**
	 * Get session details by ID
	 */
	async get(sessionId: string) {
		return apiFetch<{
			id: string;
			user_id: string;
			user_email: string;
			user_name?: string;
			created_at: string;
			last_accessed_at: string;
			expires_at: string;
			ip_address?: string;
			user_agent?: string;
			is_active: boolean;
		}>(`/api/admin/sessions/${sessionId}`);
	},

	/**
	 * Revoke a session
	 */
	async revoke(sessionId: string) {
		return apiFetch<{ success: boolean }>(`/api/admin/sessions/${sessionId}`, {
			method: 'DELETE'
		});
	}
};

/**
 * Auth API - Passkey
 */
export const passkeyAPI = {
	/**
	 * Get registration options for Passkey
	 */
	async getRegisterOptions(data: {
		email?: string;
		name?: string;
		userId?: string;
		custom_fields?: Record<string, unknown>;
		authorizationChallengeId?: string;
		human_verification_response?: string;
	}) {
		const pkce = await createDirectAuthPkce();
		const response = await apiFetch<{
			options: PublicKeyCredentialCreationOptionsJSON;
			challenge_id: string;
		}>('/api/v1/auth/direct/passkey/signup/start', {
			method: 'POST',
			body: JSON.stringify({
				client_id: getAuthConfig().clientId,
				code_challenge: pkce.codeChallenge,
				code_challenge_method: pkce.codeChallengeMethod,
				channel: 'browser',
				email: data.email || undefined,
				display_name: data.name,
				custom_fields: data.custom_fields,
				authorization_challenge_id: data.authorizationChallengeId,
				human_verification_response: data.human_verification_response
			})
		});
		if (response.data) {
			directPasskeySignupPkce.set(response.data.challenge_id, {
				codeVerifier: pkce.codeVerifier
			});
			return {
				data: {
					options: response.data.options,
					userId: response.data.challenge_id,
					challengeId: response.data.challenge_id
				},
				error: undefined
			};
		}
		return response as {
			data?: { options: PublicKeyCredentialCreationOptionsJSON; userId: string };
			error?: APIError;
		};
	},

	/**
	 * Verify Passkey registration
	 */
	async verifyRegistration(data: {
		userId: string;
		credential: unknown;
		deviceName?: string;
		authorizationChallengeId?: string;
		deferAuthorizationContinuation?: boolean;
	}) {
		const pkce = directPasskeySignupPkce.get(data.userId);
		if (!pkce) {
			return {
				error: {
					error: 'missing_pkce_state',
					error_description: 'Passkey registration state is missing or expired'
				}
			};
		}
		directPasskeySignupPkce.delete(data.userId);

		const finish = await apiFetch<{ direct_auth_artifact: string; expires_in: number }>(
			'/api/v1/auth/direct/passkey/signup/finish',
			{
				method: 'POST',
				body: JSON.stringify({
					challenge_id: data.userId,
					credential: data.credential,
					code_verifier: pkce.codeVerifier,
					channel: 'browser'
				})
			}
		);
		if (finish.error || !finish.data) {
			return finish as {
				data?: {
					verified: boolean;
					passkeyId: string;
					message: string;
					userId: string;
					user: User;
				};
				error?: APIError;
			};
		}

		const session = await finalizeManagedDirectAuthSession(
			finish.data.direct_auth_artifact,
			pkce.codeVerifier,
			data.authorizationChallengeId,
			data.deferAuthorizationContinuation === true
		);
		if (session.error || !session.data) {
			return session as {
				data?: {
					verified: boolean;
					passkeyId: string;
					message: string;
					userId: string;
					user: User;
				};
				error?: APIError;
			};
		}

		return {
			data: {
				...directSessionToLegacyAuthResponse(session.data),
				passkeyId: '',
				message: 'Passkey registration successful'
			},
			error: undefined
		};
	},

	/**
	 * Get authentication options for Passkey login
	 */
	async getLoginOptions(data: {
		email?: string;
		authorizationChallengeId?: string;
		human_verification_response?: string;
	}) {
		const pkce = await createDirectAuthPkce();
		const response = await apiFetch<{
			options: PublicKeyCredentialRequestOptionsJSON;
			challenge_id: string;
		}>('/api/v1/auth/direct/passkey/login/start', {
			method: 'POST',
			body: JSON.stringify({
				client_id: getAuthConfig().clientId,
				code_challenge: pkce.codeChallenge,
				code_challenge_method: pkce.codeChallengeMethod,
				channel: 'browser',
				email: data.email,
				authorization_challenge_id: data.authorizationChallengeId,
				human_verification_response: data.human_verification_response
			})
		});
		if (response.data) {
			directPasskeyLoginPkce.set(response.data.challenge_id, {
				codeVerifier: pkce.codeVerifier
			});
			return {
				data: {
					options: response.data.options,
					challengeId: response.data.challenge_id
				},
				error: undefined
			};
		}
		return response as {
			data?: { options: PublicKeyCredentialRequestOptionsJSON; challengeId: string };
			error?: APIError;
		};
	},

	/**
	 * Verify Passkey authentication
	 */
	async verifyLogin(data: {
		challengeId: string;
		credential: unknown;
		authorizationChallengeId?: string;
		deferAuthorizationContinuation?: boolean;
	}) {
		const pkce = directPasskeyLoginPkce.get(data.challengeId);
		if (!pkce) {
			return {
				error: {
					error: 'missing_pkce_state',
					error_description: 'Passkey login state is missing or expired'
				}
			};
		}
		directPasskeyLoginPkce.delete(data.challengeId);

		const finish = await apiFetch<{ direct_auth_artifact: string; expires_in: number }>(
			'/api/v1/auth/direct/passkey/login/finish',
			{
				method: 'POST',
				body: JSON.stringify({
					challenge_id: data.challengeId,
					credential: data.credential,
					code_verifier: pkce.codeVerifier,
					channel: 'browser'
				})
			}
		);
		if (finish.error || !finish.data) {
			return finish as {
				data?: {
					verified: boolean;
					userId: string;
					user: User;
					redirect_url?: string;
				};
				error?: APIError;
			};
		}

		const session = await finalizeManagedDirectAuthSession(
			finish.data.direct_auth_artifact,
			pkce.codeVerifier,
			data.authorizationChallengeId,
			data.deferAuthorizationContinuation === true
		);
		if (session.error || !session.data) {
			return session as {
				data?: {
					verified: boolean;
					userId: string;
					user: User;
					redirect_url?: string;
				};
				error?: APIError;
			};
		}

		return {
			data: directSessionToLegacyAuthResponse(session.data),
			error: undefined
		};
	}
};

/**
 * Auth API - Email Code (OTP)
 */
export const emailCodeAPI = {
	/**
	 * Send verification code to email
	 */
	async send(data: {
		email: string;
		name?: string;
		invite_token?: string;
		authorizationChallengeId?: string;
		custom_fields?: Record<string, unknown>;
		human_verification_response?: string;
		deferAuthorizationContinuation?: boolean;
		runtimeInteractionId?: string;
		emailVerification?: {
			token: string;
			challengeId: string;
			interactionId: string;
		};
	}) {
		const pkce = await createDirectAuthPkce();
		const response = await apiFetch<{
			attempt_id?: string;
			expires_in: number;
			masked_email?: string;
			_dev_code?: string;
			direct_auth_artifact?: string;
			is_new_user?: boolean;
		}>('/api/v1/auth/direct/email-code/send', {
			method: 'POST',
			body: JSON.stringify({
				client_id: getAuthConfig().clientId,
				email: data.email,
				display_name: data.name,
				code_challenge: pkce.codeChallenge,
				code_challenge_method: pkce.codeChallengeMethod,
				channel: 'browser',
				invite_token: data.invite_token,
				authorization_challenge_id: data.authorizationChallengeId,
				custom_fields: data.custom_fields,
				human_verification_response: data.human_verification_response,
				email_verification_token: data.emailVerification?.token,
				email_verification_challenge_id: data.emailVerification?.challengeId,
				runtime_interaction_id: data.runtimeInteractionId ?? data.emailVerification?.interactionId
			})
		});

		if (response.error || !response.data) {
			return response as {
				data?: { success: boolean; message: string; messageId?: string; code?: string };
				error?: APIError;
			};
		}
		if (response.data.direct_auth_artifact) {
			const session = await finalizeManagedDirectAuthSession(
				response.data.direct_auth_artifact,
				pkce.codeVerifier,
				data.authorizationChallengeId,
				data.deferAuthorizationContinuation === true
			);
			if (session.error || !session.data) {
				return session as {
					data?: {
						success: boolean;
						verified: boolean;
						userId: string;
						user: User;
						redirect_url?: string;
					};
					error?: APIError;
				};
			}
			return {
				data: {
					success: true,
					message: 'Email verified by provider',
					...directSessionToLegacyAuthResponse(session.data)
				},
				error: undefined
			};
		}
		if (!response.data.attempt_id) {
			return {
				error: {
					error: 'invalid_response',
					error_description: 'Email verification response is missing an attempt identifier'
				}
			};
		}

		persistDirectEmailCodeState(data.email, {
			attemptId: response.data.attempt_id,
			codeVerifier: pkce.codeVerifier
		});

		return {
			data: {
				success: true,
				verified: false,
				message: 'Verification code sent',
				messageId: response.data.attempt_id,
				code: response.data._dev_code
			},
			error: undefined
		};
	},

	/**
	 * Verify email code
	 */
	async verify(data: {
		code: string;
		email: string;
		authorizationChallengeId?: string;
		deferAuthorizationContinuation?: boolean;
	}) {
		const state = readDirectEmailCodeState(data.email);
		if (!state) {
			return {
				error: {
					error: 'missing_pkce_state',
					error_description: 'Email code state is missing or expired'
				}
			};
		}

		const finish = await apiFetch<{ direct_auth_artifact: string; expires_in: number }>(
			'/api/v1/auth/direct/email-code/verify',
			{
				method: 'POST',
				body: JSON.stringify({
					attempt_id: state.attemptId,
					code: data.code,
					code_verifier: state.codeVerifier,
					channel: 'browser'
				})
			}
		);
		if (finish.error || !finish.data) {
			return finish as {
				data?: {
					success: boolean;
					userId: string;
					user: User;
					redirect_url?: string;
				};
				error?: APIError;
			};
		}
		clearDirectEmailCodeState(data.email);

		const session = await finalizeManagedDirectAuthSession(
			finish.data.direct_auth_artifact,
			state.codeVerifier,
			data.authorizationChallengeId,
			data.deferAuthorizationContinuation === true
		);
		if (session.error || !session.data) {
			return session as {
				data?: {
					success: boolean;
					userId: string;
					user: User;
					redirect_url?: string;
				};
				error?: APIError;
			};
		}

		return {
			data: {
				success: true,
				...directSessionToLegacyAuthResponse(session.data)
			},
			error: undefined
		};
	}
};

/**
 * Auth API - TOTP
 */
export const totpAPI = {
	async startLogin(data: { identifier?: string; authorizationChallengeId?: string }) {
		return apiFetch<{ challenge_id: string; expires_in: number }>('/api/auth/totp/login/start', {
			method: 'POST',
			body: JSON.stringify({
				identifier: data.identifier,
				authorization_challenge_id: data.authorizationChallengeId
			})
		});
	},

	async verifyLogin(data: {
		challengeId: string;
		code: string;
		authorizationChallengeId?: string;
		deferAuthorizationContinuation?: boolean;
	}) {
		return apiFetch<{
			success: boolean;
			sessionId: string;
			redirect_url?: string;
			authorization?: {
				challenge_id?: string;
				type?: string;
			};
			session?: {
				userId: string;
				createdAt: number;
				expiresAt: number;
				authTime: number;
				acr?: string;
				amr?: string[];
			};
			user: {
				id: string;
				email: string;
				name?: string | null;
			};
		}>('/api/auth/totp/login/verify', {
			method: 'POST',
			body: JSON.stringify({
				challenge_id: data.challengeId,
				code: data.code,
				authorization_challenge_id: data.authorizationChallengeId,
				defer_authorization_continuation: data.deferAuthorizationContinuation === true
			})
		});
	},

	async createSignupOptions(data: {
		email: string;
		name?: string;
		label?: string;
		custom_fields?: Record<string, unknown>;
		authorizationChallengeId?: string;
		human_verification_response?: string;
	}) {
		return apiFetch<{
			challenge_id: string;
			expires_in: number;
			credential: {
				id: string;
				label: string | null;
				algorithm: 'SHA1' | 'SHA256';
				digits: number;
				period: number;
				window: number;
				status: 'pending' | 'active' | 'disabled';
				created_at: number;
				activated_at: number | null;
				last_used_at: number | null;
			};
			secret: string;
			otpauth_uri: string;
			profile: {
				algorithm: 'SHA1' | 'SHA256';
				digits: number;
				period: number;
				window: number;
			};
		}>('/api/auth/totp/signup/options', {
			method: 'POST',
			body: JSON.stringify({
				email: data.email,
				name: data.name,
				label: data.label,
				custom_fields: data.custom_fields,
				authorization_challenge_id: data.authorizationChallengeId,
				human_verification_response: data.human_verification_response
			})
		});
	},

	async activateSignup(data: {
		challengeId: string;
		code: string;
		deferAuthorizationContinuation?: boolean;
	}) {
		return apiFetch<{
			ok: boolean;
			success: boolean;
			backup_codes: string[];
			sessionId: string;
			redirect_url?: string;
			authorization?: {
				challenge_id?: string;
				type?: string;
			};
			session: {
				userId: string;
				createdAt: number;
				expiresAt: number;
				authTime: number;
				acr?: string;
				amr?: string[];
			};
			user: {
				id: string;
				email: string;
				name?: string | null;
			};
		}>('/api/auth/totp/signup/activate', {
			method: 'POST',
			body: JSON.stringify({
				challenge_id: data.challengeId,
				code: data.code,
				defer_authorization_continuation: data.deferAuthorizationContinuation === true
			})
		});
	}
};

/**
 * Auth API - Directory Password
 */
export const directoryPasswordAPI = {
	async login(data: {
		username: string;
		password: string;
		inviteToken?: string;
		authorizationChallengeId?: string;
		deferAuthorizationContinuation?: boolean;
		human_verification_response?: string;
	}) {
		const session = await apiFetch<
			| ManagedDirectSessionResponse
			| DirectoryPasswordMigrationResponse
			| DirectoryPasswordRecoveryResponse
		>('/api/auth/directory-password/login', {
			method: 'POST',
			body: JSON.stringify({
				username: data.username,
				password: data.password,
				invite_token: data.inviteToken,
				authorization_challenge_id: data.authorizationChallengeId,
				defer_authorization_continuation: data.deferAuthorizationContinuation === true,
				human_verification_response: data.human_verification_response
			})
		});
		if (session.error || !session.data) {
			return session as {
				data?: {
					success: boolean;
					userId: string;
					user: User;
					redirect_url?: string;
				};
				error?: APIError;
			};
		}

		if (session.data.ok === false && 'migration' in session.data) {
			return {
				data: {
					success: false,
					user: session.data.user,
					migration: session.data.migration
				},
				error: undefined
			};
		}

		if (session.data.ok === false && 'recovery' in session.data) {
			return {
				data: {
					success: false,
					user: session.data.user,
					recovery: session.data.recovery
				},
				error: undefined
			};
		}

		return {
			data: {
				success: true,
				...directSessionToLegacyAuthResponse(session.data as ManagedDirectSessionResponse),
				...(session.data.migration ? { migration: session.data.migration } : {})
			},
			error: undefined
		};
	},

	async migrationPasskeyOptions(data: {
		transactionId: string;
		transactionToken: string;
		displayName?: string;
	}) {
		return apiFetch<{
			challenge_id: string;
			options: PublicKeyCredentialCreationOptionsJSON;
		}>('/api/auth/directory-password/migration/passkey/options', {
			method: 'POST',
			body: JSON.stringify({
				transaction_id: data.transactionId,
				transaction_token: data.transactionToken,
				display_name: data.displayName
			})
		});
	},

	async migrationPasskeyVerify(data: {
		transactionId: string;
		transactionToken: string;
		challengeId: string;
		credential: unknown;
		deviceName?: string;
	}) {
		const session = await apiFetch<ManagedDirectSessionResponse>(
			'/api/auth/directory-password/migration/passkey/verify',
			{
				method: 'POST',
				body: JSON.stringify({
					transaction_id: data.transactionId,
					transaction_token: data.transactionToken,
					challenge_id: data.challengeId,
					credential: data.credential,
					device_name: data.deviceName
				})
			}
		);
		if (session.error || !session.data) {
			return session as {
				data?: {
					success: boolean;
					userId: string;
					user: User;
					redirect_url?: string;
				};
				error?: APIError;
			};
		}
		return {
			data: {
				success: true,
				...directSessionToLegacyAuthResponse(session.data)
			},
			error: undefined
		};
	},

	async migrationEmailCodeSend(data: { transactionId: string; transactionToken: string }) {
		return apiFetch<{
			success: boolean;
			challenge_id: string;
			expires_in: number;
			masked_email: string;
		}>('/api/auth/directory-password/migration/email-code/send', {
			method: 'POST',
			body: JSON.stringify({
				transaction_id: data.transactionId,
				transaction_token: data.transactionToken
			})
		});
	},

	async migrationEmailCodeVerify(data: {
		transactionId: string;
		transactionToken: string;
		challengeId: string;
		code: string;
	}) {
		const session = await apiFetch<ManagedDirectSessionResponse>(
			'/api/auth/directory-password/migration/email-code/verify',
			{
				method: 'POST',
				body: JSON.stringify({
					transaction_id: data.transactionId,
					transaction_token: data.transactionToken,
					challenge_id: data.challengeId,
					code: data.code
				})
			}
		);
		if (session.error || !session.data) {
			return session as {
				data?: {
					success: boolean;
					userId: string;
					user: User;
					redirect_url?: string;
				};
				error?: APIError;
			};
		}
		return {
			data: {
				success: true,
				...directSessionToLegacyAuthResponse(session.data)
			},
			error: undefined
		};
	}
};

// =============================================================================
// Login Challenge API (OIDC Dynamic OP - logo_uri, policy_uri, tos_uri)
// =============================================================================

/**
 * Login challenge client info
 */
interface LoginChallengeClientInfo {
	client_id: string;
	client_name: string;
	logo_uri?: string;
	client_uri?: string;
	policy_uri?: string;
	tos_uri?: string;
}

type LoginChallengeSessionMode = 'managed_browser_session' | 'cookie_session' | 'token_session';
type LoginChallengeHandoffMethod = 'cookie_session_finalize' | 'dpop_token_verify';

interface LoginChallengeWebOrigin {
	origin: string;
	client_ids: string[];
	cors: {
		allowed: boolean;
	};
	csp: {
		frame_ancestors?: string[];
	};
	handoff_allowed: boolean;
	iframe_allowed: boolean;
	environment?: string;
}

/**
 * Login challenge response data
 */
interface LoginChallengeData {
	challenge_id: string;
	client: LoginChallengeClientInfo;
	scope?: string;
	login_hint?: string;
	oidc?: {
		prompt?: string;
		max_age?: number;
		acr_values?: string[];
		nonce_present: boolean;
		claims_present: boolean;
	};
	session_mode?: LoginChallengeSessionMode;
	handoff_methods?: LoginChallengeHandoffMethod[];
	web_origin_registry?: {
		origins: LoginChallengeWebOrigin[];
	};
}

/**
 * Login Challenge API
 * Fetches client metadata for login page display during OAuth authorization flow
 */
export const loginChallengeAPI = {
	/**
	 * Get login challenge data including client metadata
	 * Used to display client logo, policy link, and ToS link on login page
	 */
	async getData(challengeId: string) {
		const apiBaseUrl = import.meta.env.VITE_OP_API_URL || API_BASE_URL;
		const params = new URLSearchParams({ challenge_id: challengeId });
		return apiFetch<LoginChallengeData>(`/auth/login-challenge?${params.toString()}`, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			baseUrl: apiBaseUrl
		});
	}
};

/**
 * Admin API - Audit Log
 */
export const adminAuditLogAPI = {
	/**
	 * List audit log entries with filtering and pagination
	 */
	async list(
		params: {
			page?: number;
			limit?: number;
			user_id?: string;
			action?: string;
			resource_type?: string;
			resource_id?: string;
			start_date?: string;
			end_date?: string;
		} = {}
	) {
		const queryParams = new URLSearchParams();
		if (params.page) queryParams.set('page', params.page.toString());
		if (params.limit) queryParams.set('limit', params.limit.toString());
		if (params.user_id) queryParams.set('user_id', params.user_id);
		if (params.action) queryParams.set('action', params.action);
		if (params.resource_type) queryParams.set('resource_type', params.resource_type);
		if (params.resource_id) queryParams.set('resource_id', params.resource_id);
		if (params.start_date) queryParams.set('start_date', params.start_date);
		if (params.end_date) queryParams.set('end_date', params.end_date);

		const query = queryParams.toString();
		return apiFetch<{
			entries: AuditLogEntry[];
			pagination: {
				page: number;
				limit: number;
				total: number;
				totalPages: number;
			};
		}>(`/api/admin/audit-logs${query ? '?' + query : ''}`);
	},

	/**
	 * Get audit log entry details by ID
	 */
	async get(entryId: string) {
		return apiFetch<AuditLogEntry>(`/api/admin/audit-logs/${entryId}`);
	}
};

/**
 * Admin API - Settings
 */
export const adminSettingsAPI = {
	/**
	 * Get system settings
	 */
	async get() {
		return apiFetch<{
			settings: {
				general: {
					siteName: string;
					logoUrl: string;
					language: string;
					timezone: string;
				};
				appearance: {
					primaryColor: string;
					secondaryColor: string;
					fontFamily: string;
				};
				security: {
					sessionTimeout: number;
					mfaEnforced: boolean;
					passwordMinLength: number;
					passwordRequireSpecialChar: boolean;
				};
				email: {
					emailProvider: 'resend' | 'cloudflare' | 'smtp';
					smtpHost: string;
					smtpPort: number;
					smtpUsername: string;
					smtpPassword: string;
				};
				advanced: {
					accessTokenTtl: number;
					idTokenTtl: number;
					refreshTokenTtl: number;
					passkeyEnabled: boolean;
					magicLinkEnabled: boolean;
				};
				ciba?: {
					enabled: boolean;
					defaultExpiresIn: number;
					minExpiresIn: number;
					maxExpiresIn: number;
					defaultInterval: number;
					minInterval: number;
					maxInterval: number;
					supportedDeliveryModes: string[];
					userCodeEnabled: boolean;
					bindingMessageMaxLength: number;
					notificationsEnabled: boolean;
					notificationProviders?: {
						email?: boolean;
						sms?: boolean;
						push?: boolean;
					};
				};
				policy?: {
					enableAbac: boolean;
					enableRebac: boolean;
					enablePolicyLogging: boolean;
					enableVerifiedAttributes: boolean;
					enableCustomRules: boolean;
					enableSdJwt: boolean;
					enablePolicyEmbedding: boolean;
					accessTokenClaims: string;
					idTokenClaims: string;
				};
			};
		}>('/api/admin/settings');
	},

	/**
	 * Update system settings
	 */
	async update(settings: {
		general?: {
			siteName?: string;
			logoUrl?: string;
			language?: string;
			timezone?: string;
		};
		appearance?: {
			primaryColor?: string;
			secondaryColor?: string;
			fontFamily?: string;
		};
		security?: {
			sessionTimeout?: number;
			mfaEnforced?: boolean;
			passwordMinLength?: number;
			passwordRequireSpecialChar?: boolean;
		};
		email?: {
			emailProvider?: 'resend' | 'cloudflare' | 'smtp';
			smtpHost?: string;
			smtpPort?: number;
			smtpUsername?: string;
			smtpPassword?: string;
		};
		advanced?: {
			accessTokenTtl?: number;
			idTokenTtl?: number;
			refreshTokenTtl?: number;
			passkeyEnabled?: boolean;
			magicLinkEnabled?: boolean;
		};
		ciba?: {
			enabled?: boolean;
			defaultExpiresIn?: number;
			minExpiresIn?: number;
			maxExpiresIn?: number;
			defaultInterval?: number;
			minInterval?: number;
			maxInterval?: number;
			supportedDeliveryModes?: string[];
			userCodeEnabled?: boolean;
			bindingMessageMaxLength?: number;
			notificationsEnabled?: boolean;
			notificationProviders?: {
				email?: boolean;
				sms?: boolean;
				push?: boolean;
			};
		};
		policy?: {
			enableAbac?: boolean;
			enableRebac?: boolean;
			enablePolicyLogging?: boolean;
			enableVerifiedAttributes?: boolean;
			enableCustomRules?: boolean;
			enableSdJwt?: boolean;
			enablePolicyEmbedding?: boolean;
			accessTokenClaims?: string;
			idTokenClaims?: string;
		};
	}) {
		return apiFetch<{
			success: boolean;
			message: string;
			settings: Record<string, unknown>;
		}>('/api/admin/settings', {
			method: 'PUT',
			body: JSON.stringify({ settings })
		});
	}
};

/**
 * Device Flow API
 * RFC 8628: OAuth 2.0 Device Authorization Grant
 */
export const deviceFlowAPI = {
	/**
	 * Verify device code with user approval
	 */
	async verifyDeviceCode(userCode: string, approve: boolean = true) {
		return apiFetch<{
			success: boolean;
			message?: string;
		}>('/api/devices/verify', {
			method: 'POST',
			body: JSON.stringify({
				user_code: userCode,
				approve
			})
		});
	},

	/**
	 * Verify a device code and get device info
	 */
	async verify(userCode: string) {
		return apiFetch<{
			client_name: string;
			client_uri?: string;
			logo_uri?: string;
			scopes: string[];
		}>('/api/devices/verify-code', {
			method: 'POST',
			body: JSON.stringify({ user_code: userCode }),
			credentials: 'include'
		});
	},

	/**
	 * Approve a device code
	 */
	async approve(userCode: string) {
		return apiFetch<{
			success: boolean;
			redirect_url?: string;
		}>('/api/devices/approve', {
			method: 'POST',
			body: JSON.stringify({ user_code: userCode, approve: true }),
			credentials: 'include'
		});
	},

	/**
	 * Deny a device code
	 */
	async deny(userCode: string) {
		return apiFetch<{
			success: boolean;
		}>('/api/devices/approve', {
			method: 'POST',
			body: JSON.stringify({ user_code: userCode, approve: false }),
			credentials: 'include'
		});
	}
};

/**
 * CIBA API
 * Client Initiated Backchannel Authentication
 */
export const cibaAPI = {
	/**
	 * Get a specific CIBA request by ID
	 */
	async getData(requestId: string) {
		const apiBaseUrl = import.meta.env.VITE_OP_API_URL || API_BASE_URL;
		try {
			const response = await fetch(`${apiBaseUrl}/api/ciba/requests/${requestId}`, {
				method: 'GET',
				headers: buildDiagnosticHeaders({ Accept: 'application/json' }),
				credentials: 'include'
			});
			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				return {
					error: {
						error: errorData.error || 'ciba_error',
						error_description: errorData.error_description || 'Failed to load CIBA request'
					}
				};
			}
			const data = await response.json();
			return { data };
		} catch {
			return {
				error: {
					error: 'network_error',
					error_description: 'Network error occurred'
				}
			};
		}
	},

	/**
	 * Get pending CIBA requests for current user
	 */
	async getPending() {
		const apiBaseUrl = import.meta.env.VITE_OP_API_URL || API_BASE_URL;
		try {
			const response = await fetch(`${apiBaseUrl}/api/ciba/requests/pending`, {
				method: 'GET',
				headers: buildDiagnosticHeaders({ Accept: 'application/json' }),
				credentials: 'include'
			});
			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				return {
					error: {
						error: errorData.error || 'ciba_error',
						error_description: errorData.error_description || 'Failed to load pending requests'
					}
				};
			}
			const data = await response.json();
			return { data: data.requests || data };
		} catch {
			return {
				error: {
					error: 'network_error',
					error_description: 'Network error occurred'
				}
			};
		}
	},

	/**
	 * Approve a CIBA request
	 */
	async approve(requestId: string) {
		return apiFetch<{ success: boolean }>(`/api/ciba/requests/${requestId}/approve`, {
			method: 'POST',
			credentials: 'include'
		});
	},

	/**
	 * Reject a CIBA request
	 */
	async reject(requestId: string) {
		return apiFetch<{ success: boolean }>(`/api/ciba/requests/${requestId}/reject`, {
			method: 'POST',
			credentials: 'include'
		});
	}
};

/**
 * SCIM Token Management API
 * For managing SCIM 2.0 provisioning tokens
 */
export const adminScimTokensAPI = {
	/**
	 * List all SCIM tokens
	 */
	async list() {
		return apiFetch<{
			tokens: ScimToken[];
			total: number;
		}>('/api/admin/scim-tokens');
	},

	/**
	 * Create a new SCIM token
	 */
	async create(description?: string, expiresInDays?: number) {
		return apiFetch<{
			token: string;
			tokenHash: string;
			description: string;
			expiresInDays: number;
			message: string;
		}>('/api/admin/scim-tokens', {
			method: 'POST',
			body: JSON.stringify({
				description,
				expiresInDays
			})
		});
	},

	/**
	 * Revoke a SCIM token
	 */
	async revoke(tokenHash: string) {
		return apiFetch<{
			message: string;
		}>(`/api/admin/scim-tokens/${tokenHash}`, {
			method: 'DELETE'
		});
	}
};

// =============================================================================
// External IdP API (external login)
// =============================================================================

/**
 * External IdP Provider type
 */
interface ExternalIdPProvider {
	id: string;
	slug?: string; // User-friendly identifier (e.g., "google")
	name: string;
	providerType: 'oidc' | 'oauth2';
	enabled: boolean;
	iconUrl?: string;
	iconName?: string;
	buttonColor?: string;
	buttonText?: string;
}

/**
 * External IdP API
 * Handles external identity provider login integration
 */
export const externalIdpAPI = {
	/**
	 * Get list of available external IdP providers
	 */
	async getProviders() {
		return apiFetch<{ providers: ExternalIdPProvider[] }>('/api/external/providers');
	},

	/**
	 * Start external IdP login flow
	 * Returns authorization URL to redirect user to
	 */
	async startLogin(
		providerId: string,
		redirectUri?: string,
		startUrl?: string,
		startMode: 'oauth_redirect' | 'saml_sp' = 'oauth_redirect',
		humanVerification?: { token?: string }
	): Promise<{
		url: string;
	}> {
		const encodedProviderId = encodeURIComponent(providerId);
		const targetUrl = new URL(startUrl || `/api/external/${encodedProviderId}/start`, API_BASE_URL);

		if (humanVerification?.token) {
			targetUrl.searchParams.set('human_verification_response', humanVerification.token);
		}

		if (startMode === 'saml_sp') {
			if (redirectUri) {
				targetUrl.searchParams.set('return_url', redirectUri);
			}
			return { url: targetUrl.toString() };
		}

		// Generate PKCE parameters (using static import)
		let pkceParams;
		try {
			pkceParams = await generateLoginUiPKCE();
		} catch (error) {
			console.error('Failed to generate PKCE parameters:', error);
			throw new Error(
				'PKCE generation failed. Your browser may not support required security features.'
			);
		}

		const params = new URLSearchParams();

		// Add client_id from auth config
		const authConfig = getAuthConfig();
		params.set('client_id', authConfig.clientId);

		// Add PKCE parameters
		params.set('code_challenge', pkceParams.codeChallenge);
		params.set('code_challenge_method', pkceParams.codeChallengeMethod);

		if (redirectUri) {
			params.set('redirect_uri', redirectUri);
		}

		for (const [key, value] of params.entries()) {
			targetUrl.searchParams.set(key, value);
		}

		// This returns a redirect, so callers navigate the browser instead of fetching it.
		return {
			url: targetUrl.toString()
		};
	}
};

// =============================================================================
// External IdP Admin API (Provider Management)
// =============================================================================

/**
 * External IdP Provider (Admin view with full details)
 */
export interface ExternalIdPProviderAdmin {
	id: string;
	slug?: string; // User-friendly identifier (e.g., "google")
	tenantId: string;
	name: string;
	providerType: 'oidc' | 'oauth2';
	enabled: boolean;
	priority: number;
	issuer?: string;
	clientId: string;
	hasSecret: boolean;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	userinfoEndpoint?: string;
	jwksUri?: string;
	scopes: string;
	attributeMapping: Record<string, string>;
	autoLinkEmail: boolean;
	jitProvisioning: boolean;
	requireEmailVerified: boolean;
	iconUrl?: string;
	iconName?: string;
	buttonColor?: string;
	buttonText?: string;
	createdAt: number;
	updatedAt: number;
}

/**
 * Create Provider Request
 */
export interface CreateProviderRequest {
	slug?: string; // User-friendly identifier (e.g., "google")
	name: string;
	provider_type?: 'oidc' | 'oauth2';
	client_id: string;
	client_secret: string;
	issuer?: string;
	scopes?: string;
	enabled?: boolean;
	priority?: number;
	auto_link_email?: boolean;
	jit_provisioning?: boolean;
	require_email_verified?: boolean;
	icon_url?: string | null;
	icon_name?: string | null;
	button_color?: string;
	button_text?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	userinfo_endpoint?: string;
	jwks_uri?: string;
	attribute_mapping?: Record<string, string>;
	template?: 'google' | 'github' | 'microsoft';
}

/**
 * Update Provider Request
 */
export interface UpdateProviderRequest {
	slug?: string; // User-friendly identifier (e.g., "google")
	name?: string;
	provider_type?: 'oidc' | 'oauth2';
	client_id?: string;
	client_secret?: string;
	issuer?: string;
	scopes?: string;
	enabled?: boolean;
	priority?: number;
	auto_link_email?: boolean;
	jit_provisioning?: boolean;
	require_email_verified?: boolean;
	icon_url?: string | null;
	icon_name?: string | null;
	button_color?: string;
	button_text?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	userinfo_endpoint?: string;
	jwks_uri?: string;
	attribute_mapping?: Record<string, string>;
}

/**
 * External IdP Admin API
 * Manages upstream identity providers (Google, GitHub, etc.)
 */
export const externalIdpAdminAPI = {
	/**
	 * List all providers
	 */
	async list(params: { tenant_id?: string } = {}) {
		const queryParams = new URLSearchParams();
		if (params.tenant_id) queryParams.set('tenant_id', params.tenant_id);
		const query = queryParams.toString();
		return apiFetch<{ providers: ExternalIdPProviderAdmin[] }>(
			`/api/admin/external-providers${query ? '?' + query : ''}`
		);
	},

	/**
	 * Get provider details
	 */
	async get(providerId: string) {
		return apiFetch<ExternalIdPProviderAdmin>(`/api/admin/external-providers/${providerId}`);
	},

	/**
	 * Create new provider
	 */
	async create(data: CreateProviderRequest) {
		return apiFetch<ExternalIdPProviderAdmin>('/api/admin/external-providers', {
			method: 'POST',
			body: JSON.stringify(data)
		});
	},

	/**
	 * Update provider
	 */
	async update(providerId: string, data: UpdateProviderRequest) {
		return apiFetch<ExternalIdPProviderAdmin>(`/api/admin/external-providers/${providerId}`, {
			method: 'PUT',
			body: JSON.stringify(data)
		});
	},

	/**
	 * Delete provider
	 */
	async delete(providerId: string) {
		return apiFetch<{ success: boolean }>(`/api/admin/external-providers/${providerId}`, {
			method: 'DELETE'
		});
	}
};

// =============================================================================
// Consent Screen API (Phase 2-B RBAC)
// =============================================================================

/**
 * Consent screen data types
 */
interface ConsentScopeInfo {
	name: string;
	title: string;
	description: string;
	required: boolean;
}

interface ConsentClientInfo {
	client_id: string;
	client_name: string;
	logo_uri?: string;
	client_uri?: string;
	policy_uri?: string;
	tos_uri?: string;
	is_trusted?: boolean;
}

interface ConsentUserInfo {
	id: string;
	email: string;
	name?: string;
	picture?: string;
}

interface ConsentOrgInfo {
	id: string;
	name: string;
	type: string;
	is_primary: boolean;
	plan?: string;
}

interface ConsentActingAsInfo {
	id: string;
	name?: string;
	email: string;
	relationship_type: string;
	permission_level: string;
}

interface ConsentFeatureFlags {
	org_selector_enabled: boolean;
	acting_as_enabled: boolean;
	show_roles: boolean;
}

interface ConsentScreenData {
	challenge_id: string;
	client: ConsentClientInfo;
	scopes: ConsentScopeInfo[];
	user: ConsentUserInfo;
	organizations: ConsentOrgInfo[];
	primary_org: ConsentOrgInfo | null;
	roles: string[];
	acting_as: ConsentActingAsInfo | null;
	target_org_id: string | null;
	features: ConsentFeatureFlags;
}

export interface ConsentSubmission {
	challenge_id: string;
	approved: boolean;
	selected_org_id?: string;
	acting_as_user_id?: string;
	consent_item_decisions?: Record<string, 'granted' | 'denied'>;
}

/**
 * Consent Screen API
 * Handles OAuth2/OIDC consent flow with RBAC support
 */
export const consentAPI = {
	/**
	 * Get consent screen data
	 * Uses OP API URL if configured, otherwise same origin
	 */
	async getData(challengeId: string) {
		const apiBaseUrl = import.meta.env.VITE_OP_API_URL || API_BASE_URL;
		const params = new URLSearchParams({ challenge_id: challengeId });
		return apiFetch<ConsentScreenData>(`/auth/consent?${params.toString()}`, {
			method: 'GET',
			headers: { Accept: 'application/json' },
			baseUrl: apiBaseUrl
		});
	},

	/**
	 * Submit consent decision
	 * Returns redirect URL on success
	 */
	async submit(submission: ConsentSubmission) {
		const apiBaseUrl = import.meta.env.VITE_OP_API_URL || API_BASE_URL;
		return apiFetch<{ redirect_url: string }>('/auth/consent', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			baseUrl: apiBaseUrl,
			body: JSON.stringify(submission)
		});
	}
};
