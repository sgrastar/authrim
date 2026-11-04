/**
 * Step-up for operations the Admin API protects with L1 or L2.
 *
 * - L1 refuses with 403 `…fresh_auth_required`: the passkey is asked for again.
 * - L2 refuses with 403 `step_up_required` with a `step_up_id` and the `missing` factors
 *   (`passkey`, `second_factor`). Each missing factor is verified in this session, the step-up
 *   is exchanged for a single-use receipt, and the request is repeated once with the receipt in
 *   the `authrim-step-up-receipt` header.
 *
 * `adminFetch` and the legacy `apiFetch` run every request through `runWithStepUp`, so callers
 * need no step-up code. If the user cancels a browser prompt (or any step fails) the original
 * 403 response is returned unchanged.
 */
import {
	startAuthentication,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/browser';

export const STEP_UP_RECEIPT_HEADER = 'authrim-step-up-receipt';

export type StepUpFactor = 'passkey' | 'second_factor';

export type StepUpDecision =
	| { kind: 'fresh_auth' }
	| { kind: 'step_up'; stepUpId: string; missing: StepUpFactor[] };

/** Reads a 403 response (without consuming it) and says what step-up it asks for, if any. */
export async function readStepUpDecision(response: Response): Promise<StepUpDecision | null> {
	if (response.status !== 403) return null;
	const body = (await response
		.clone()
		.json()
		.catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') return null;
	const code = typeof body.error === 'string' ? body.error : '';
	if (code.endsWith('fresh_auth_required') || body.fresh_auth_required === true) {
		return { kind: 'fresh_auth' };
	}
	if (code === 'step_up_required') {
		const stepUpId = body.step_up_id;
		if (typeof stepUpId !== 'string' || stepUpId.length === 0) return null;
		const missing = Array.isArray(body.missing)
			? body.missing.filter((f): f is StepUpFactor => f === 'passkey' || f === 'second_factor')
			: [];
		return { kind: 'step_up', stepUpId, missing };
	}
	return null;
}

export interface StepUpSteps {
	reauthenticate: () => Promise<void>;
	verifySecondFactor: () => Promise<void>;
	issueReceipt: (stepUpId: string) => Promise<string>;
}

/** POST JSON to the Admin API without step-up handling; returns the parsed body or throws. */
export type StepUpPost = (path: string, body: unknown) => Promise<Record<string, unknown>>;

export function createBrowserSteps(post: StepUpPost): StepUpSteps {
	const rpId = () => window.location.hostname;
	return {
		async reauthenticate() {
			const { options, challenge_id } = (await post('/api/admin/me/reauth/passkey/options', {
				rp_id: rpId()
			})) as { options: PublicKeyCredentialRequestOptionsJSON; challenge_id: string };
			const credential: AuthenticationResponseJSON = await startAuthentication({
				optionsJSON: options
			});
			await post('/api/admin/me/reauth/passkey/verify', { challenge_id, credential });
		},
		async verifySecondFactor() {
			const { options, challenge_id } = (await post('/api/admin/me/reauth/second-factor/options', {
				rp_id: rpId()
			})) as { options: PublicKeyCredentialRequestOptionsJSON; challenge_id: string };
			const credential: AuthenticationResponseJSON = await startAuthentication({
				optionsJSON: options
			});
			await post('/api/admin/me/reauth/second-factor/verify', { challenge_id, credential });
		},
		async issueReceipt(stepUpId) {
			const { step_up_receipt } = (await post('/api/admin/me/step-up/receipts', {
				step_up_id: stepUpId
			})) as { step_up_receipt: string };
			if (typeof step_up_receipt !== 'string' || !step_up_receipt) {
				throw new Error('No step-up receipt was issued');
			}
			return step_up_receipt;
		}
	};
}

/**
 * Send a request; when it is refused for step-up, meet the step-up and send it once more.
 * `send(receipt)` must build a fresh request each call (new idempotency key, replayable body).
 */
export async function runWithStepUp(
	send: (receipt?: string) => Promise<Response>,
	steps: StepUpSteps
): Promise<Response> {
	const first = await send();
	const decision = await readStepUpDecision(first);
	if (!decision) return first;
	let receipt: string | undefined;
	try {
		if (decision.kind === 'fresh_auth') {
			await steps.reauthenticate();
		} else {
			if (decision.missing.includes('passkey')) await steps.reauthenticate();
			if (decision.missing.includes('second_factor')) await steps.verifySecondFactor();
			receipt = await steps.issueReceipt(decision.stepUpId);
		}
	} catch {
		// Cancelled prompt or failed verification: the caller sees the original refusal.
		return first;
	}
	return send(receipt);
}
