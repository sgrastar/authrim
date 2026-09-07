const AUTH_CONTEXT_QUERY_PARAMETERS = [
	'challenge_id',
	'invite_token',
	'tenant_host',
	'login_hint',
	'email',
	'tenant',
	'return_to',
	'account_return',
	'saml_request_id',
	'saml_sp_entity_id'
] as const;

export function buildAuthSwitchHref(
	target: '/login' | '/signup',
	searchParams: URLSearchParams
): string {
	const targetParams = new URLSearchParams();
	for (const key of AUTH_CONTEXT_QUERY_PARAMETERS) {
		for (const value of searchParams.getAll(key)) {
			targetParams.append(key, value);
		}
	}
	const query = targetParams.toString();
	return query ? `${target}?${query}` : target;
}
