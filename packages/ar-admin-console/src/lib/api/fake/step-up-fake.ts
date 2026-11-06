/**
 * In-memory step-up for the whole-console mock and Storybook: an operation goes through the real
 * `withStepUp` (so the console's step-up dialog asks, as it would), against a fake Admin API that
 * refuses as the real one does. The passkey and security key checks are assumed to succeed after
 * a short wait, and stay fresh for the evidence window.
 */
import { ApiError } from '#lib/api/api-error.js';
import {
	withStepUp,
	type StepUpFactor,
	type StepUpLevel,
	type StepUpRequirements
} from '#lib/api/admin-step-up.js';

export interface FakeStepUpOptions {
	/** Each operation's level; operations not listed are L0. */
	levels?: Record<string, Exclude<StepUpLevel, 'L0'>>;
	/** How long a check stays fresh, in milliseconds (the server's evidence window). */
	windowMs?: number;
	/** Milliseconds a check (a passkey or a security key) takes. */
	delay?: number;
}

export interface FakeStepUp {
	/** Run `perform` as the operation `name`, meeting its step-up first. */
	run<T>(name: string, perform: () => Promise<T>): Promise<T>;
	/** Forget the checks made (as if the window had passed). */
	expire(): void;
}

const DEFAULT_LEVELS: Record<string, Exclude<StepUpLevel, 'L0'>> = {
	'webhook.destination.update': 'L2',
	'admin.second_factor.remove': 'L2',
	'admin.passkey.add': 'L1'
};

export function createFakeStepUp(options: FakeStepUpOptions = {}): FakeStepUp {
	const levels = options.levels ?? DEFAULT_LEVELS;
	const windowMs = options.windowMs ?? 5 * 60_000;
	// The same clock withStepUp reads the requirements by (tests fake it with vi.useFakeTimers).
	const now = () => Date.now();
	const evidence: Record<StepUpFactor, number | null> = { passkey: null, second_factor: null };

	const fresh = (factor: StepUpFactor) => {
		const until = evidence[factor];
		return until !== null && until > now();
	};
	const missingFor = (level: StepUpLevel): StepUpFactor[] => {
		const missing: StepUpFactor[] = [];
		if (level !== 'L0' && !fresh('passkey')) missing.push('passkey');
		if (level === 'L2' && !fresh('second_factor')) missing.push('second_factor');
		return missing;
	};
	const verify = (factor: StepUpFactor) => async () => {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		evidence[factor] = now() + windowMs;
	};

	return {
		run<T>(name: string, perform: () => Promise<T>): Promise<T> {
			const level: StepUpLevel = (levels[name] as StepUpLevel | undefined) ?? 'L0';
			const requirements = async (): Promise<StepUpRequirements> => ({
				tenant_id: 'acme',
				enforced: true,
				evidence_window_seconds: windowMs / 1000,
				evidence: {
					passkey_fresh_until: evidence.passkey,
					second_factor_fresh_until: evidence.second_factor
				},
				second_factor_registered: true,
				operations:
					level === 'L0' ? {} : { [name]: { level, catalog_level: level, always_enforced: false } }
			});
			return withStepUp(
				async (receipt) => {
					if (level === 'L1' && !fresh('passkey')) {
						throw new ApiError(403, 'admin_fresh_auth_required', 'Fresh authentication required');
					}
					if (level === 'L2' && !receipt) {
						throw new ApiError(403, 'step_up_required', 'This operation needs a step-up receipt', {
							step_up_id: 'asr_fake',
							required_level: 'L2',
							missing: missingFor('L2')
						});
					}
					return perform();
				},
				{
					reauthenticate: verify('passkey'),
					verifySecondFactor: verify('second_factor'),
					issueReceipt: async () => {
						const missing = missingFor(level);
						if (missing.length > 0) {
							throw new ApiError(403, 'step_up_evidence_required', 'Verify the missing factors', {
								missing
							});
						}
						return 'asp_fake';
					},
					requirements
				},
				{ operation: name }
			);
		},
		expire() {
			evidence.passkey = null;
			evidence.second_factor = null;
		}
	};
}
