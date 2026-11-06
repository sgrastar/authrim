/**
 * Keyring as a second factor, in memory, for Storybook and tests. The wallet side is simulated by
 * time: after `answerAfterMs` the presentation is being checked, `checkMs` later it ends with
 * `outcome`. `outcome: 'pending'` never answers (to look at the waiting dialog).
 */
import { ApiError } from '../api-error';
import type { KeyringFactorClient } from '../keyring-factor';
import type { PresentationProgress } from '#lib/keyring/presentation-flow.svelte.js';

export interface FakeKeyringFactorOptions {
	outcome?: 'verified' | 'pending' | 'expired' | 'match_code_mismatch' | 'credential_not_active';
	answerAfterMs?: number;
	checkMs?: number;
	/** Lifetime of a request (5 minutes by default). */
	ttlMs?: number;
	/** Refuse the start with this error code (403/409). */
	refuse?: 'keyring_not_registered' | 'keyring_not_eligible' | 'second_factor_recovery_required';
	now?: () => number;
}

export function createFakeKeyringFactor(
	options: FakeKeyringFactorOptions = {}
): KeyringFactorClient {
	const now = options.now ?? Date.now;
	const answerAfter = options.answerAfterMs ?? 4_000;
	const check = options.checkMs ?? 2_000;
	const started = new Map<string, number>();
	let sequence = 0;

	async function start() {
		if (options.refuse) {
			const status = options.refuse === 'keyring_not_registered' ? 409 : 403;
			throw new ApiError(status, options.refuse, options.refuse);
		}
		const requestId = `g1:apac:0:vp_fake${++sequence}`;
		started.set(requestId, now());
		return {
			requestId,
			qr: `openid4vp://?client_id=decentralized_identifier%3Adid%3Aweb%3Aidp.example.com&request_uri=https%3A%2F%2Fidp.example.com%2Fvp%2Fadmin%2Frequest%2F${encodeURIComponent(requestId)}`,
			matchCode: String(37 + sequence)
				.padStart(2, '0')
				.slice(-2),
			expiresAt: now() + (options.ttlMs ?? 300_000)
		};
	}

	async function progress(requestId: string): Promise<PresentationProgress> {
		const at = started.get(requestId);
		if (at === undefined) throw new ApiError(404, 'not_found', 'not found');
		const elapsed = now() - at;
		const outcome = options.outcome ?? 'verified';
		if (outcome === 'pending' || elapsed < answerAfter) return { status: 'pending' };
		if (elapsed < answerAfter + check) return { status: 'processing' };
		if (outcome === 'verified') return { status: 'verified' };
		if (outcome === 'expired') return { status: 'expired' };
		return { status: 'failed', error: outcome };
	}

	return {
		startStepUp: start,
		stepUpProgress: progress,
		startEnroll: start,
		enrollProgress: progress
	};
}
