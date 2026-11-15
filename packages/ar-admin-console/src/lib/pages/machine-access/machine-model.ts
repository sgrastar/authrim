/**
 * What the machine access forms check before anything is sent: the public key, the client id,
 * the permission strings and the token lifetime. The Admin API checks all of it again; these
 * checks only save a round trip and say what is wrong in plain words.
 */
import {
	MACHINE_TOKEN_TTL_MAX,
	pickPublicJwk,
	type MachineKeyAlgorithm,
	type MachineReach
} from '#lib/api/machine-access.js';

/** The members of a JWK that belong to a private key; the API refuses them too. */
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export type JwkProblem =
	| 'empty'
	| 'notJson'
	| 'notObject'
	| 'private'
	| 'keyType'
	| 'algorithm'
	| 'use'
	| 'keyOps';

export type JwkCheck =
	| { ok: true; jwk: Record<string, unknown>; alg: MachineKeyAlgorithm }
	| { ok: false; problem: JwkProblem };

/**
 * Reads pasted text as a public JWK. `alg` is the algorithm the admin chose; empty means "work it
 * out from the key" (an EC P-256 key is ES256, an RSA key its own `alg` when it has one, else RS256).
 */
export function checkPublicJwk(input: string, alg: MachineKeyAlgorithm | '' = ''): JwkCheck {
	const source = input.trim();
	if (!source) return { ok: false, problem: 'empty' };
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return { ok: false, problem: 'notJson' };
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, problem: 'notObject' };
	}
	const jwk = parsed as Record<string, unknown>;
	if (PRIVATE_JWK_MEMBERS.some((member) => member in jwk)) return { ok: false, problem: 'private' };
	if (jwk.use !== undefined && jwk.use !== 'sig') return { ok: false, problem: 'use' };
	if (
		Array.isArray(jwk.key_ops) &&
		jwk.key_ops.some((op) =>
			['sign', 'decrypt', 'unwrapKey', 'deriveKey', 'deriveBits'].includes(String(op))
		)
	) {
		return { ok: false, problem: 'keyOps' };
	}
	const filled = (value: unknown) => typeof value === 'string' && value.length > 0;
	const isEc = jwk.kty === 'EC' && jwk.crv === 'P-256' && filled(jwk.x) && filled(jwk.y);
	const isRsa = jwk.kty === 'RSA' && filled(jwk.n) && filled(jwk.e);
	if (!isEc && !isRsa) return { ok: false, problem: 'keyType' };
	const own = typeof jwk.alg === 'string' ? jwk.alg : undefined;
	const chosen: MachineKeyAlgorithm | undefined =
		alg || (own === 'ES256' || own === 'PS256' || own === 'RS256' ? own : undefined);
	const resolved = chosen ?? (isEc ? 'ES256' : 'RS256');
	if ((resolved === 'ES256') !== isEc) return { ok: false, problem: 'algorithm' };
	if (own !== undefined && own !== resolved) return { ok: false, problem: 'algorithm' };
	return { ok: true, jwk: pickPublicJwk(jwk), alg: resolved };
}

export const CLIENT_ID_PATTERN = /^\S{1,128}$/u;

/** A permission is one word-like string (`admin:users:read`, `*`), no spaces. */
export function permissionProblem(value: string): 'space' | 'long' | undefined {
	if (/\s/u.test(value)) return 'space';
	if (value.length > 200) return 'long';
	return undefined;
}

/** A whole-seconds token lifetime the API accepts, or the reason it does not. */
export function tokenTtlProblem(value: number | null): 'required' | 'range' | undefined {
	if (value === null) return 'required';
	return Number.isInteger(value) && value >= 1 && value <= MACHINE_TOKEN_TTL_MAX
		? undefined
		: 'range';
}

/** The reach is usable: "chosen tenants" needs at least one tenant. */
export function reachProblem(reach: MachineReach): 'noTenants' | undefined {
	return reach.mode === 'tenants' && reach.tenantIds.length === 0 ? 'noTenants' : undefined;
}

const DAY_MS = 86_400_000;

/** The end (epoch ms) of a key valid for `days` days from `now`; no days, no end. */
export function keyExpiry(days: number | null, now: number = Date.now()): number | undefined {
	return days !== null && days >= 1 ? now + Math.floor(days) * DAY_MS : undefined;
}

/** Whether a key can sign in now: active or in its rotation overlap, started, and not past its end. */
export function keyUsable(
	key: { status: string; expiresAt: number | null; notBefore?: number | null },
	now: number = Date.now()
): boolean {
	return (
		(key.status === 'active' || key.status === 'rotating') &&
		(key.notBefore == null || key.notBefore <= now) &&
		(key.expiresAt === null || key.expiresAt > now)
	);
}

/** A key that is in force but whose start (`notBefore`) is still ahead: the token endpoint refuses it. */
export function keyNotYetValid(
	key: { status: string; notBefore?: number | null },
	now: number = Date.now()
): boolean {
	return (
		(key.status === 'active' || key.status === 'rotating') &&
		key.notBefore != null &&
		key.notBefore > now
	);
}
