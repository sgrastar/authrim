/**
 * Step-up for operations the Admin API protects with L1 or L2.
 *
 * - L1 refuses with 403 `…fresh_auth_required`: the passkey is asked for again.
 * - L2 refuses with 403 `step_up_required`, a `step_up_id` and what is `missing` (`passkey`,
 *   `second_factor`). Each missing factor is verified in this session, the step-up is exchanged
 *   for a single-use receipt, and the operation is repeated once with the receipt in the
 *   `authrim-step-up-receipt` header.
 *
 * Operations that never need step-up are unaffected: their errors pass through as they are.
 */
import {
	startAuthentication,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';
import {
	isFreshAuthRequired,
	postJson,
	reauthenticateWithPasskey,
	withCeremonyTimeout
} from '#lib/api/admin-reauth.js';
import { adminFetch, API_BASE_URL } from '#lib/api/admin-request.js';
import { ApiError } from '#lib/api/api-error.js';

/** The request header that carries a receipt. */
export const STEP_UP_RECEIPT_HEADER = 'authrim-step-up-receipt';

export type StepUpFactor = 'passkey' | 'second_factor';

export interface StepUpRequired {
	stepUpId: string;
	missing: StepUpFactor[];
}

/** What a refusal asks for, when it is a step-up refusal. */
export function stepUpRequired(error: unknown): StepUpRequired | null {
	if (!(error instanceof ApiError) || error.status !== 403 || error.code !== 'step_up_required') {
		return null;
	}
	const stepUpId = error.body.step_up_id;
	if (typeof stepUpId !== 'string' || stepUpId.length === 0) return null;
	const missing = Array.isArray(error.body.missing)
		? error.body.missing.filter(
				(factor): factor is StepUpFactor => factor === 'passkey' || factor === 'second_factor'
			)
		: [];
	return { stepUpId, missing };
}

/** Verify one of the admin's registered security keys and record it on the session. */
export async function verifySecondFactor(): Promise<void> {
	const { options, challenge_id } = await postJson<{
		options: PublicKeyCredentialRequestOptionsJSON;
		challenge_id: string;
	}>('/api/admin/me/reauth/second-factor/options', { rp_id: window.location.hostname });
	const credential: AuthenticationResponseJSON = await withCeremonyTimeout(
		startAuthentication({ optionsJSON: options })
	);
	await postJson('/api/admin/me/reauth/second-factor/verify', { challenge_id, credential });
}

/** Exchange a step-up for its single-use receipt. */
export async function issueStepUpReceipt(stepUpId: string): Promise<string> {
	const { step_up_receipt } = await postJson<{ step_up_receipt: string; expires_at: number }>(
		'/api/admin/me/step-up/receipts',
		{ step_up_id: stepUpId }
	);
	return step_up_receipt;
}

export interface StepUpSteps {
	reauthenticate: () => Promise<unknown>;
	verifySecondFactor: () => Promise<unknown>;
	issueReceipt: (stepUpId: string) => Promise<string>;
}

const BROWSER_STEPS: StepUpSteps = {
	reauthenticate: reauthenticateWithPasskey,
	verifySecondFactor,
	issueReceipt: issueStepUpReceipt
};

/**
 * Run an operation, meeting a step-up refusal once. `operation` receives the receipt to send
 * (undefined on the first try). A second refusal is passed on as it is.
 */
export async function withStepUp<T>(
	operation: (receipt?: string) => Promise<T>,
	steps: StepUpSteps = BROWSER_STEPS
): Promise<T> {
	let required: StepUpRequired | null;
	let reauthenticated = false;
	try {
		return await operation();
	} catch (error) {
		if (!isFreshAuthRequired(error)) {
			required = stepUpRequired(error);
			if (!required) throw error;
		} else {
			// A route can ask for a fresh sign-in first and for the step-up only after it.
			await steps.reauthenticate();
			reauthenticated = true;
			try {
				return await operation();
			} catch (retryError) {
				required = stepUpRequired(retryError);
				if (!required) throw retryError;
			}
		}
	}
	if (required.missing.includes('passkey') && !reauthenticated) await steps.reauthenticate();
	if (required.missing.includes('second_factor')) await steps.verifySecondFactor();
	const receipt = await steps.issueReceipt(required.stepUpId);
	return operation(receipt);
}

/** Headers carrying a receipt, or none. */
export function stepUpHeaders(receipt?: string): Record<string, string> {
	return receipt ? { [STEP_UP_RECEIPT_HEADER]: receipt } : {};
}

export type StepUpLevel = 'L0' | 'L1' | 'L2';

export interface StepUpOperationRequirement {
	/** The level asked of a signed-in admin in the selected tenant. */
	level: StepUpLevel;
	/** The catalog floor, which a tenant may raise but not lower. */
	catalog_level: 'L1' | 'L2';
	always_enforced: boolean;
}

/** GET /api/admin/me/step-up/requirements. */
export interface StepUpRequirements {
	tenant_id: string;
	enforced: boolean;
	evidence_window_seconds: number;
	evidence: {
		/** Until when (ms) the session's passkey is fresh, or null. */
		passkey_fresh_until: number | null;
		/** Until when (ms) the session's security key is fresh, or null. */
		second_factor_fresh_until: number | null;
	};
	second_factor_registered: boolean;
	/** Keyed by operation name, e.g. `webhook.destination.update`. */
	operations: Record<string, StepUpOperationRequirement>;
}

/**
 * Which operations need L1 or L2 in the selected tenant, and how fresh the session's factors are.
 * A hint for telling the admin beforehand: the operation's own refusal still decides.
 */
export async function fetchStepUpRequirements(): Promise<StepUpRequirements> {
	const response = await adminFetch(`${API_BASE_URL}/api/admin/me/step-up/requirements`, {
		method: 'GET'
	});
	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const code = typeof payload.error === 'string' ? payload.error : '';
		const message =
			typeof payload.error_description === 'string'
				? payload.error_description
				: `Step-up requirements could not be loaded (${response.status})`;
		throw new ApiError(response.status, code, message, payload);
	}
	return payload as unknown as StepUpRequirements;
}

/**
 * What an operation would ask the admin for if run at `now`: nothing, the passkey, the security
 * key, or both. An operation the response does not list needs nothing beyond the session.
 */
export function stepUpFactorsNeeded(
	requirements: StepUpRequirements,
	operation: string,
	now: number = Date.now()
): StepUpFactor[] {
	const level = requirements.operations[operation]?.level ?? 'L0';
	if (level === 'L0') return [];
	const fresh = (until: number | null) => until !== null && until > now;
	const needed: StepUpFactor[] = [];
	if (!fresh(requirements.evidence.passkey_fresh_until)) needed.push('passkey');
	if (level === 'L2' && !fresh(requirements.evidence.second_factor_fresh_until)) {
		needed.push('second_factor');
	}
	return needed;
}
