/**
 * The proof-of-work challenge a lite page embeds (ar-auth's
 * `GET /api/auth/human-verification/pow-challenge?action=`). The page asks for it when it draws a
 * form that sends something human verification may guard (a code, a guest sign-in).
 */
import type { LiteBackendClient } from './backend-client';

export type LitePowAction = 'login' | 'signup' | 'reauth';

export interface LitePowChallenge {
	algorithm: string;
	challenge: string;
	maxnumber: number;
	salt: string;
	signature: string;
}

function isChallenge(value: unknown): value is LitePowChallenge {
	if (typeof value !== 'object' || value === null) return false;
	const c = value as Record<string, unknown>;
	return (
		c.algorithm === 'SHA-256' &&
		typeof c.challenge === 'string' &&
		/^[0-9a-f]{64}$/u.test(c.challenge) &&
		typeof c.salt === 'string' &&
		c.salt.length > 0 &&
		c.salt.length <= 512 &&
		typeof c.signature === 'string' &&
		c.signature.length > 0 &&
		c.signature.length <= 512 &&
		typeof c.maxnumber === 'number' &&
		Number.isSafeInteger(c.maxnumber) &&
		c.maxnumber > 0
	);
}

/**
 * The challenge for the action, or why there is none: `not_lite` (404: the tenant is not in lite
 * mode, nothing to embed), `unavailable` (any other answer; the page cannot be sent safely).
 */
export async function fetchLitePowChallenge(
	backend: LiteBackendClient,
	action: LitePowAction
): Promise<
	| { ok: true; challenge: LitePowChallenge; policyRevision: string }
	| { ok: false; reason: 'not_lite' | 'unavailable' }
> {
	let answer;
	try {
		answer = await backend.request(
			`/api/auth/human-verification/pow-challenge?action=${encodeURIComponent(action)}`
		);
	} catch {
		return { ok: false, reason: 'unavailable' };
	}
	if (answer.status === 404) return { ok: false, reason: 'not_lite' };
	const json = answer.json as { challenge?: unknown; policy_revision?: unknown } | null;
	if (
		answer.status !== 200 ||
		!json ||
		!isChallenge(json.challenge) ||
		typeof json.policy_revision !== 'string'
	) {
		return { ok: false, reason: 'unavailable' };
	}
	return { ok: true, challenge: json.challenge, policyRevision: json.policy_revision };
}
