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
	/** The level the refusal names (`required_level`), when it names one. */
	level?: StepUpPromptLevel;
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
	const level = error.body.required_level;
	return level === 'L1' || level === 'L2' ? { stepUpId, missing, level } : { stepUpId, missing };
}

export type StepUpPromptLevel = 'L1' | 'L2';

/** What the admin is asked before a step-up: the operation's level and the checks it takes. */
export interface StepUpPromptRequest {
	level: StepUpPromptLevel;
	factors: StepUpFactor[];
}

/** Asks the admin whether to go on; resolves false when they decline. */
export type StepUpPrompt = (request: StepUpPromptRequest) => Promise<boolean>;

let activePrompt: StepUpPrompt | null = null;

/**
 * Register the dialog that asks before a step-up (the console mounts one). Returns the function
 * that unregisters it. Without one, a step-up runs without asking.
 */
export function setStepUpPrompt(prompt: StepUpPrompt): () => void {
	activePrompt = prompt;
	return () => {
		if (activePrompt === prompt) activePrompt = null;
	};
}

/**
 * The admin declined the step-up: neither the checks nor the operation ran. Named as a declined
 * WebAuthn ceremony is (`NotAllowedError`), so that the pages report it as they report one.
 */
export class StepUpCancelledError extends Error {
	constructor() {
		super('The step-up was cancelled');
		this.name = 'NotAllowedError';
	}
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
	/** Loads the tenant's requirements, for asking before the operation is sent. */
	requirements?: () => Promise<StepUpRequirements>;
	/** Asks the admin before the checks; omitted, the registered dialog (if any) asks. */
	prompt?: StepUpPrompt | null;
}

const BROWSER_STEPS: StepUpSteps = {
	reauthenticate: reauthenticateWithPasskey,
	verifySecondFactor,
	issueReceipt: issueStepUpReceipt,
	requirements: () => fetchStepUpRequirements()
};

export interface StepUpOptions {
	/**
	 * The operation's name in the step-up catalog (e.g. `admin.passkey.add`). Given, the admin is
	 * asked and the checks are made before the operation is sent; the refusal still decides.
	 */
	operation?: string;
}

/**
 * Run an operation, meeting a step-up refusal once. `operation` receives the receipt to send
 * (undefined on the first try). A second refusal is passed on as it is.
 *
 * Before any check the admin is asked (the operation's level and the checks it takes); declining
 * throws StepUpCancelledError and nothing runs. With `options.operation` the tenant's requirements
 * say beforehand what the operation will take; otherwise, or when they could not be loaded or
 * have gone stale, the refusal does.
 */
export async function withStepUp<T>(
	operation: (receipt?: string) => Promise<T>,
	steps: StepUpSteps = BROWSER_STEPS,
	options: StepUpOptions = {}
): Promise<T> {
	const prompt = steps.prompt === undefined ? activePrompt : steps.prompt;
	const ask = async (request: StepUpPromptRequest) => {
		if (!prompt || request.factors.length === 0) return;
		if (!(await prompt(request))) throw new StepUpCancelledError();
	};
	const check = async (factors: StepUpFactor[]) => {
		if (factors.includes('passkey')) await steps.reauthenticate();
		if (factors.includes('second_factor')) await steps.verifySecondFactor();
	};
	/** Ask for what a refusal is missing (nothing when the checks made beforehand still hold). */
	const meet = async (required: StepUpRequired) => {
		await ask({ level: required.level ?? 'L2', factors: required.missing });
		await check(required.missing);
	};

	if (options.operation && steps.requirements) {
		// Only a hint: when it cannot be loaded or read, the refusal decides as before.
		const loaded = await steps.requirements().catch(() => null);
		const requirements =
			loaded &&
			typeof loaded.operations === 'object' &&
			loaded.operations !== null &&
			loaded.evidence
				? loaded
				: null;
		const level = requirements?.operations[options.operation]?.level;
		if (requirements && (level === 'L1' || level === 'L2')) {
			const factors = stepUpFactorsNeeded(requirements, options.operation);
			await ask({ level, factors });
			await check(factors);
		}
	}

	// A refusal after checks made beforehand means they went stale meanwhile: it is asked again,
	// for what the refusal names.
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
			await ask({ level: 'L1', factors: ['passkey'] });
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
	// The passkey was just confirmed for the fresh sign-in: only what else is missing is asked for.
	await meet(
		reauthenticated
			? { ...required, missing: required.missing.filter((factor) => factor !== 'passkey') }
			: required
	);
	// The admin may take a while to answer and verify: by then another check may have gone stale,
	// or the step-up itself may have expired (it lives a few minutes). Either is met once or twice
	// more; past that the refusal is passed on.
	let stepUpId = required.stepUpId;
	for (let retries = 0; ; retries++) {
		let receipt: string;
		try {
			receipt = await steps.issueReceipt(stepUpId);
		} catch (error) {
			if (retries >= MAX_RECEIPT_RETRIES) throw error;
			const missing = evidenceMissing(error);
			if (missing) {
				// The step-up still stands: verify what went stale and ask for its receipt again.
				await meet({ stepUpId, missing, level: required.level });
				continue;
			}
			if (!isUnknownStepUp(error)) throw error;
			// The step-up is gone: the operation is sent once more for a new one.
			let renewed: StepUpRequired | null;
			try {
				return await operation();
			} catch (again) {
				renewed = stepUpRequired(again);
				if (!renewed) throw again;
			}
			await meet(renewed);
			stepUpId = renewed.stepUpId;
			continue;
		}
		return operation(receipt);
	}
}

const MAX_RECEIPT_RETRIES = 2;

/** Whether a receipt was refused because its step-up is gone (expired, or not found). */
function isUnknownStepUp(error: unknown): boolean {
	return error instanceof ApiError && error.code === 'invalid_step_up';
}

/** The checks a receipt was refused for (`step_up_evidence_required`), or null. */
function evidenceMissing(error: unknown): StepUpFactor[] | null {
	if (!(error instanceof ApiError) || error.code !== 'step_up_evidence_required') return null;
	const missing = Array.isArray(error.body.missing)
		? error.body.missing.filter(
				(factor): factor is StepUpFactor => factor === 'passkey' || factor === 'second_factor'
			)
		: [];
	return missing.length > 0 ? missing : null;
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
