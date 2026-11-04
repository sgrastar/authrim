/**
 * In-memory step-up security keys for Storybook and tests. Follows the Admin API's rules: one
 * active key must remain, a first key only inside the enrollment window, a recovery request waits
 * before it can be completed and is cancelled by the admin or another admin. The WebAuthn
 * ceremonies and step-up prompts are assumed to succeed.
 */
import { ApiError } from '../api-error';
import type {
	SecondFactor,
	SecondFactorRecovery,
	SecondFactorsClient,
	SecondFactorState,
	TenantRecoveryRequest
} from '../second-factors';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface FakeSecondFactorsOptions {
	/** Milliseconds each call takes. */
	delay?: number;
	/** Fail every call with this status. */
	fail?: 403 | 500;
	keys?: Array<Partial<SecondFactor> & { label: string }>;
	/** Whether the first-enrollment window is still open (only matters with no active key). */
	firstEnrollmentOpen?: boolean;
	/** The admin's own request: waiting, or ready to complete. */
	recovery?: 'waiting' | 'ready';
	/** Open requests of other admins in the tenant. */
	tenantRequests?: Array<{ email: string; waitingHours?: number }>;
	/** Recovery cannot be filed (the only admin, or email not available). */
	recoveryRefused?: 'recovery_requires_last_resort' | 'recovery_notification_unavailable';
	now?: number;
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export function createFakeSecondFactors(
	options: FakeSecondFactorsOptions = {}
): SecondFactorsClient {
	const now = options.now ?? Date.now();
	let keys: SecondFactor[] = (options.keys ?? []).map((key, index) => ({
		id: key.id ?? `sf-${index + 1}`,
		kind: 'webauthn_credential',
		aaguid: null,
		created_at: now - (index + 3) * DAY,
		last_used_at: index === 0 ? now - 2 * HOUR : null,
		revoked_at: null,
		...key
	}));
	let recovery: SecondFactorRecovery | null = options.recovery
		? {
				id: 'rec-own',
				status: 'pending',
				label: 'New security key',
				aaguid: null,
				requested_at: now - (options.recovery === 'ready' ? 30 : 3) * HOUR,
				not_before: now + (options.recovery === 'ready' ? -6 : 21) * HOUR,
				expires_at: now + 7 * DAY
			}
		: null;
	let tenantRequests: TenantRecoveryRequest[] = (options.tenantRequests ?? []).map(
		(request, index) => ({
			id: `rec-${index + 1}`,
			status: 'pending',
			label: null,
			aaguid: null,
			requested_at: now - (request.waitingHours ?? 2) * HOUR,
			not_before: now + (24 - (request.waitingHours ?? 2)) * HOUR,
			expires_at: now + 8 * DAY,
			admin_user_id: `admin-${index + 2}`,
			admin_email: request.email
		})
	);

	const wait = () => new Promise((resolve) => setTimeout(resolve, options.delay ?? 300));
	const call = async <T>(run: () => T): Promise<T> => {
		await wait();
		if (options.fail) throw new ApiError(options.fail, 'error', 'Request failed');
		return run();
	};
	const active = () => keys.filter((key) => key.revoked_at === null);

	return {
		list: () =>
			call(
				(): SecondFactorState => ({
					second_factors: keys,
					active_count: active().length,
					minimum: 1,
					enrollment: {
						mode:
							active().length > 0
								? 'step_up'
								: options.firstEnrollmentOpen
									? 'first'
									: 'recovery_required',
						first_enrollment_ends_at: now + (options.firstEnrollmentOpen ? 5 : -2) * DAY
					}
				})
			),

		register: ({ label, recovery: asRecovery }) =>
			call(() => {
				if (asRecovery) {
					if (options.recoveryRefused) {
						throw new ApiError(
							options.recoveryRefused === 'recovery_requires_last_resort' ? 403 : 503,
							options.recoveryRefused,
							'Refused'
						);
					}
					if (recovery) throw new ApiError(409, 'recovery_pending', 'Already open');
					recovery = {
						id: nextId('rec'),
						status: 'pending',
						label: label ?? null,
						aaguid: null,
						requested_at: Date.now(),
						not_before: Date.now() + DAY,
						expires_at: Date.now() + 8 * DAY
					};
					return { recovery };
				}
				if (active().length === 0 && !options.firstEnrollmentOpen) {
					throw new ApiError(403, 'second_factor_recovery_required', 'Recovery required');
				}
				const key: SecondFactor = {
					id: nextId('sf'),
					kind: 'webauthn_credential',
					label: label ?? null,
					aaguid: null,
					created_at: Date.now(),
					last_used_at: null,
					revoked_at: null
				};
				keys = [key, ...keys];
				return { second_factor: key };
			}),

		remove: (id) =>
			call(() => {
				if (!active().some((key) => key.id === id)) throw new ApiError(404, 'not_found', 'x');
				if (active().length <= 1) throw new ApiError(409, 'second_factor_minimum', 'x');
				keys = keys.map((key) => (key.id === id ? { ...key, revoked_at: Date.now() } : key));
			}),

		getRecovery: () => call(() => recovery),

		completeRecovery: () =>
			call(() => {
				if (!recovery) throw new ApiError(404, 'not_found', 'x');
				if (Date.now() < recovery.not_before) {
					throw new ApiError(409, 'recovery_waiting', 'x', { not_before: recovery.not_before });
				}
				const at = Date.now();
				keys = [
					{
						id: nextId('sf'),
						kind: 'webauthn_credential',
						label: recovery.label,
						aaguid: null,
						created_at: at,
						last_used_at: null,
						revoked_at: null
					},
					...keys.map((key) => (key.revoked_at === null ? { ...key, revoked_at: at } : key))
				];
				recovery = null;
			}),

		cancelRecovery: () =>
			call(() => {
				if (!recovery) throw new ApiError(404, 'not_found', 'x');
				recovery = null;
			}),

		listTenantRecoveries: () => call(() => tenantRequests),

		cancelTenantRecovery: (id) =>
			call(() => {
				if (!tenantRequests.some((request) => request.id === id)) {
					throw new ApiError(404, 'not_found', 'x');
				}
				tenantRequests = tenantRequests.filter((request) => request.id !== id);
			})
	};
}
