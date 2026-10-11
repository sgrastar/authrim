/**
 * The address a re-authentication by email code is sent to. The login challenge does not tell the
 * page who is signed in (it answers anyone who holds the challenge id), so the person types the
 * address of their own account. The server sends a code only when it belongs to the user the
 * challenge names, and answers the same either way.
 */

export type ReauthEmailResult =
	| { ok: true; email: string }
	| { ok: false; reason: 'required' | 'invalid' };

export function readReauthEmail(value: string): ReauthEmailResult {
	const email = value.trim();
	if (!email) return { ok: false, reason: 'required' };
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, reason: 'invalid' };
	return { ok: true, email };
}
