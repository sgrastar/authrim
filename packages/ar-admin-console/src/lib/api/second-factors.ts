/**
 * The signed-in admin's step-up security keys (second factors) and their recovery, and the open
 * recovery requests of the tenant's other admins.
 *
 * Pages take a `SecondFactorsClient`; the browser one below talks to the Admin API and runs the
 * WebAuthn ceremonies, Storybook passes an in-memory one (`fake/second-factors-fake.ts`).
 */
import {
	startRegistration,
	type PublicKeyCredentialCreationOptionsJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/browser';
import { withCeremonyTimeout } from '#lib/api/admin-reauth.js';
import { adminFetch, API_BASE_URL } from '#lib/api/admin-request.js';
import { stepUpHeaders, withStepUp } from '#lib/api/admin-step-up.js';
import { ApiError } from '#lib/api/api-error.js';

export interface SecondFactor {
	id: string;
	kind: 'webauthn_credential' | 'keyring_holder_key';
	label: string | null;
	aaguid: string | null;
	created_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
}

/** How a new key can be registered now. */
export type EnrollmentMode = 'step_up' | 'first' | 'recovery_required';

export interface SecondFactorState {
	second_factors: SecondFactor[];
	active_count: number;
	minimum: number;
	enrollment: { mode: EnrollmentMode; first_enrollment_ends_at: number | null };
}

export interface SecondFactorRecovery {
	id: string;
	status: 'pending' | 'completed' | 'cancelled' | 'expired';
	label: string | null;
	aaguid: string | null;
	requested_at: number;
	not_before: number;
	expires_at: number;
}

export interface TenantRecoveryRequest extends SecondFactorRecovery {
	admin_user_id: string;
	admin_email: string | null;
}

export type RegisterResult =
	| { second_factor: SecondFactor }
	| { recovery: SecondFactorRecovery };

export interface SecondFactorsClient {
	list(): Promise<SecondFactorState>;
	/** Register a security key, or with `recovery` file a recovery request with it. */
	register(input: { label?: string; recovery?: boolean }): Promise<RegisterResult>;
	remove(id: string): Promise<void>;
	getRecovery(): Promise<SecondFactorRecovery | null>;
	completeRecovery(): Promise<void>;
	cancelRecovery(): Promise<void>;
	listTenantRecoveries(): Promise<TenantRecoveryRequest[]>;
	cancelTenantRecovery(id: string): Promise<void>;
}

async function request<T>(
	method: string,
	path: string,
	options: { body?: unknown; headers?: Record<string, string>; tenantScoped?: boolean } = {}
): Promise<T> {
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		method,
		headers: options.headers,
		includeJsonContentType: options.body !== undefined,
		skipTenantHeader: !options.tenantScoped,
		body: options.body === undefined ? undefined : JSON.stringify(options.body)
	});
	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			typeof payload.error === 'string' ? payload.error : '',
			typeof payload.error_description === 'string'
				? payload.error_description
				: `Request failed (${response.status})`,
			payload
		);
	}
	return payload as T;
}

const ME = '/api/admin/me';

export const httpSecondFactors: SecondFactorsClient = {
	list: () => request<SecondFactorState>('GET', `${ME}/second-factors`),

	async register({ label, recovery }) {
		const body = {
			rp_id: window.location.hostname,
			...(label ? { label } : {}),
			...(recovery ? { purpose: 'recovery' } : {})
		};
		// Adding a key once one exists is an L2 operation; the receipt is spent on the options.
		const { options, challenge_id } = await withStepUp((receipt) =>
			request<{ options: PublicKeyCredentialCreationOptionsJSON; challenge_id: string }>(
				'POST',
				`${ME}/second-factors/webauthn/options`,
				{ body, headers: stepUpHeaders(receipt) }
			)
		);
		const credential: RegistrationResponseJSON = await withCeremonyTimeout(
			startRegistration({ optionsJSON: options })
		);
		return request<RegisterResult>('POST', `${ME}/second-factors/webauthn/verify`, {
			body: { challenge_id, credential }
		});
	},

	async remove(id) {
		await withStepUp((receipt) =>
			request('DELETE', `${ME}/second-factors/${encodeURIComponent(id)}`, {
				headers: stepUpHeaders(receipt)
			})
		);
	},

	async getRecovery() {
		return (await request<{ recovery: SecondFactorRecovery | null }>(
			'GET',
			`${ME}/second-factor-recovery`
		)).recovery;
	},

	async completeRecovery() {
		await withStepUp(() => request('POST', `${ME}/second-factor-recovery/complete`, { body: {} }));
	},

	async cancelRecovery() {
		await request('POST', `${ME}/second-factor-recovery/cancel`, { body: {} });
	},

	async listTenantRecoveries() {
		return (
			await request<{ items: TenantRecoveryRequest[] }>(
				'GET',
				'/api/admin/admin-second-factor-recoveries',
				{ tenantScoped: true }
			)
		).items;
	},

	async cancelTenantRecovery(id) {
		await withStepUp(() =>
			request(
				'POST',
				`/api/admin/admin-second-factor-recoveries/${encodeURIComponent(id)}/cancel`,
				{ body: {}, tenantScoped: true }
			)
		);
	}
};
