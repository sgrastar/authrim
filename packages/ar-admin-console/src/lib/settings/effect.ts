/**
 * Settings that a saved value does not change yet: the Settings API stores them, but the
 * runtime does not read them. Every other setting is applied.
 *
 * From the settings effectiveness inventory (2026-09-30), less the settings made to apply
 * since: the older stores consolidated into the Settings API (logout, errors, rate limits,
 * just-in-time provisioning, policy flags and embedding limits, token lifetimes, FAPI and the
 * other protocol settings (PAR, request objects, response types, DPoP nonces, discovery claims),
 * token exchange, introspection, conformance, UI routing), the IdP profile update on sign-in, and
 * the password lockout threshold and email code lifetime; and less the settings that left the
 * catalog (duplicates, copies of the app registration, and values too fine or fixed at
 * deployment). Update this list when a setting starts to apply or leaves the catalog.
 *
 * Shown in the settings map (Storybook: Pages › Settings map).
 */

/** Why a setting is not applied, and what is planned for it. */
export type NotApplied =
	/** No feature behind it yet; it is to be built. */
	| 'to-build'
	/** Only an environment variable or a code constant applies; to be read from the setting. */
	| 'to-wire'
	/** Applied from an older store only; to be read from the Settings API. */
	| 'to-consolidate'
	/** Internal state, not a setting. */
	| 'internal'
	/** Kept until its design is decided. */
	| 'on-hold'
	/** How the runtime uses it is to be checked. */
	| 'to-check';

function reason(why: NotApplied, keys: readonly string[]): [string, NotApplied][] {
	return keys.map((key) => [key, why]);
}

export const NOT_APPLIED: ReadonlyMap<string, NotApplied> = new Map([
	// to-build (28)
	...reason('to-build', [
		'federation.saml_artifact_resolution_timeout',
		'federation.saml_artifact_ttl',
		'federation.saml_assertion_ttl',
		'federation.saml_enabled',
		'federation.saml_nameid_format',
		'federation.saml_request_ttl',
		'federation.saml_slo_binding',
		'federation.saml_sso_binding',
		'federation.scim_token_default_expiry',
		'federation.scim_token_max_expiry',
		'oauth.id_token_expiry',
		'oauth.offline_access_required',
		'oauth.refresh_id_token_reissue',
		'oauth.refresh_token_absolute_expiry',
		'oauth.refresh_token_absolute_expiry_enabled',
		'oauth.refresh_token_sliding_window_enabled',
		'rate_limit.email_max_requests',
		'rate_limit.email_window',
		'security.dpop_bound_access_tokens',
		'security.https_redirect_only',
		'security.pkce_required',
		'security.require_encrypted_request_object',
		'session.default_ttl',
		'session.max_ttl',
		'session.refresh_default',
		'tokens.exchange_delegation_enabled',
		'tokens.exchange_impersonation_enabled',
		'tokens.introspection_extended_claims'
	]),
	// to-wire (6)
	...reason('to-wire', [
		'assurance.default_ial',
		'assurance.ida_profile',
		'assurance.ial_assurance_values',
		'assurance.saml_authn_context_aal',
		'assurance.scope_ial_requirements',
		'oauth.refresh_token_rotation'
	]),
	// internal (5)
	...reason('internal', [
		'login-ui.account_page_draft',
		'login-ui.published_at',
		'login-ui.published_snapshot',
		'login-ui.published_version',
		'login-ui.rollback_snapshot'
	]),
	// on-hold (3)
	...reason('on-hold', [
		'discovery.acr_values_supported',
		'oauth.id_token_signing_alg',
		'oauth.jarm_enabled'
	]),
	// to-check (2)
	...reason('to-check', [
		'authentication-methods.directory_password.label',
		'dr-backup.storage_destination_id'
	])
]);
