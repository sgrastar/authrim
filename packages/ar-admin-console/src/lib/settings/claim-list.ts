/**
 * The RBAC claim settings (`tokens.rbac_id_token_claims`, `tokens.rbac_access_token_claims`):
 * a comma-separated list of claim keys in the API, `none` for none.
 */
/** The RBAC claims each token can carry (ar-lib-core `IDTokenClaimKey`, `AccessTokenClaimKey`). */
export const RBAC_CLAIMS: Readonly<Record<string, readonly string[]>> = {
	'tokens.rbac_id_token_claims': [
		'roles',
		'groups',
		'permissions',
		'scoped_roles',
		'user_type',
		'relationships_summary'
	],
	'tokens.rbac_access_token_claims': ['roles', 'groups', 'scoped_roles', 'permissions']
};

/** The claims a stored value names: a comma-separated list, `none` for none. */
export function claimsOf(value: unknown): string[] {
	if (typeof value !== 'string' || value.trim() === 'none') return [];
	return value
		.split(',')
		.map((claim) => claim.trim())
		.filter(Boolean);
}

/**
 * The value after ticking or unticking one claim: the claims offered in their order, then any
 * claim stored that the console does not know (kept, so saving never drops it); `none` for none.
 */
export function toggleClaim(
	value: unknown,
	claim: string,
	on: boolean,
	offered: readonly string[]
): string {
	const current = claimsOf(value);
	const next = on ? [...current, claim] : current.filter((item) => item !== claim);
	const known = offered.filter((item) => next.includes(item));
	const unknown = next.filter((item) => !offered.includes(item));
	const all = [...known, ...new Set(unknown)];
	return all.length ? all.join(',') : 'none';
}
