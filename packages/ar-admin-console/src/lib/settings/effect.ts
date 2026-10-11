/**
 * Settings that a saved value does not change yet: the Settings API stores them, but the
 * runtime does not read them. Every other setting is applied.
 *
 * From the settings effectiveness inventory (2026-09-30), less the settings made to apply
 * since: the older stores consolidated into the Settings API (logout, errors, rate limits,
 * just-in-time provisioning, policy flags and embedding limits, token lifetimes, FAPI and the
 * other protocol settings (PAR, request objects, response types, DPoP nonces, discovery claims),
 * token exchange, introspection, conformance, UI routing), the IdP profile update on sign-in, and
 * the password lockout threshold, email code lifetime and email send limit, refresh token
 * rotation, the advertised ACR values, the tenant's ID token signing algorithm, the token exchange
 * ceilings, extended introspection claims, the SCIM token lifetime, and the SAML switch, assertion
 * and request lifetimes and provider defaults, and the scope-to-IAL requirements; and less the settings that left the catalog (duplicates, copies of the app
 * registration, and values too fine or fixed at deployment). Update this list when a setting starts to apply or leaves the catalog.
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
	// to-build (12)
	...reason('to-build', [
		'diagnostic-logging.filter_pii',
		'diagnostic-logging.filter_tokens',
		'diagnostic-logging.merged_output_enabled',
		'dr-backup.storage_destination_id',
		'federation.saml_artifact_resolution_timeout',
		'federation.saml_artifact_ttl',
		'plugin.auto_update_check',
		'plugin.enabled',
		'plugin.execution_timeout_ms',
		'plugin.memory_limit_mb',
		'plugin.notifier_console_enabled',
		'tenant.ui_register_path'
	]),
	// to-wire (34)
	...reason('to-wire', [
		'assurance.default_ial',
		'assurance.ial_assurance_values',
		'assurance.ida_profile',
		'assurance.saml_authn_context_aal',
		'ciba.auth_request_ttl',
		'ciba.binding_message_required',
		'ciba.expires_in',
		'ciba.max_binding_message_length',
		'ciba.max_expires_in',
		'ciba.max_interval',
		'ciba.max_poll_count',
		'ciba.min_expires_in',
		'ciba.min_interval',
		'ciba.notifier_default_timeout_ms',
		'ciba.notifier_max_timeout_ms',
		'ciba.notifier_retry_delay_base_ms',
		'ciba.ping_notification_timeout_ms',
		'ciba.poll_interval',
		'ciba.push_notification_timeout_ms',
		'ciba.slow_down_increment',
		'ciba.user_code_enabled',
		'client.default_audience',
		'client.default_resource',
		'device_flow.expires_in',
		'device_flow.max_expires_in',
		'device_flow.max_interval',
		'device_flow.max_poll_count',
		'device_flow.min_expires_in',
		'device_flow.min_interval',
		'device_flow.poll_interval',
		'device_flow.slow_down_increment',
		'device_flow.user_code_charset',
		'device_flow.user_code_length',
		'tenant.name'
	]),
	// internal (5)
	...reason('internal', [
		'login-ui.account_page_draft',
		'login-ui.published_at',
		'login-ui.published_snapshot',
		'login-ui.published_version',
		'login-ui.rollback_snapshot'
	])
]);
