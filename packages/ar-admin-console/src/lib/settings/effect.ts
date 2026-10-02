/**
 * Settings that a saved value does not change yet: the Settings API stores them, but the
 * runtime does not read them (or reads the same setting under another key). Every other
 * setting is applied.
 *
 * From the settings effectiveness inventory (2026-09-30), less the settings made to apply
 * since: the older stores consolidated into the Settings API (logout, errors, rate limits,
 * just-in-time provisioning, policy flags and embedding limits, token lifetimes, FAPI and the
 * other protocol settings (PAR, request objects, response types, DPoP nonces, discovery claims),
 * token exchange, introspection, conformance, UI routing) and the IdP profile update on sign-in.
 * Update this list when a setting starts to apply or leaves the catalog.
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
	/** The same setting as another key, which is the one applied. */
	| 'duplicate'
	/** A copy of the app's registration metadata; the app registration applies. */
	| 'client-registration'
	/** Too fine or deploy-time: to leave the catalog (an existing env var still applies). */
	| 'to-remove'
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
	// to-build (27)
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
		'tokens.exchange_impersonation_enabled',
		'tokens.introspection_extended_claims'
	]),
	// to-wire (2)
	...reason('to-wire', ['credentials.email_code_ttl', 'rate_limit.auth_max_failed_attempts']),
	// duplicate (37)
	...reason('duplicate', [
		'authentication-methods.directory_password.auto_provision',
		'authentication-methods.directory_password.connector_id',
		'client.access_token_ttl',
		'client.allow_authorization_code',
		'client.allow_ciba',
		'client.allow_client_credentials',
		'client.allow_code_response',
		'client.allow_device_code',
		'client.allow_id_token_response',
		'client.allow_localhost_redirect',
		'client.allow_refresh_token',
		'client.allow_token_response',
		'client.allowed_scopes_restriction_enabled',
		'client.client_credentials_allowed',
		'client.dpop_required',
		'client.id_token_ttl',
		'client.par_required',
		'client.pkce_required',
		'client.refresh_token_rotation',
		'client.refresh_token_ttl',
		'credentials.did_session_ttl',
		'feature.enable_token_exchange',
		'infra.do_saml_artifact_expiry',
		'infra.do_saml_request_expiry',
		'oauth.backchannel_token_delivery_mode',
		'oauth.backchannel_token_delivery_modes_supported',
		'oauth.refresh_token_remaining_expiry_inherit',
		'security.allow_http_redirect',
		'security.enable_abac',
		'security.enable_policy_logging',
		'security.enable_rebac',
		'security.enable_verified_attributes',
		'security.https_request_uri',
		'security.pkce_s256_required',
		'tenant.policy_uri',
		'tenant.tos_uri',
		'tokens.exchange_delegation_enabled'
	]),
	// client-registration (43)
	...reason('client-registration', [
		'client.allowed_channels',
		'client.allowed_scopes',
		'client.application_type',
		'client.backchannel_logout_session_required',
		'client.backchannel_logout_uri',
		'client.browser_public_client_mode',
		'client.browser_refresh_token_policy',
		'client.client_uri',
		'client.contacts',
		'client.default_acr_values',
		'client.default_max_age',
		'client.default_scope',
		'client.delegation_mode',
		'client.dpop_bound_access_tokens',
		'client.dpop_mode',
		'client.frontchannel_logout_session_required',
		'client.frontchannel_logout_uri',
		'client.grant_types',
		'client.id_token_encrypted_response_alg',
		'client.id_token_encrypted_response_enc',
		'client.id_token_signing_alg',
		'client.initiate_login_uri',
		'client.login_ui_url',
		'client.logo_uri',
		'client.native_channel_allowed',
		'client.native_sso_enabled',
		'client.policy_uri',
		'client.request_object_encryption_alg',
		'client.request_object_encryption_enc',
		'client.request_object_signing_alg',
		'client.request_uris',
		'client.require_auth_time',
		'client.response_types',
		'client.sector_identifier_uri',
		'client.subject_type',
		'client.token_endpoint_auth_method',
		'client.token_endpoint_auth_signing_alg',
		'client.token_exchange_allowed',
		'client.tos_uri',
		'client.trust_group',
		'client.userinfo_encrypted_response_alg',
		'client.userinfo_encrypted_response_enc',
		'client.userinfo_signed_response_alg'
	]),
	// to-remove (125)
	...reason('to-remove', [
		'cache.api_key',
		'cache.challenge_shard',
		'cache.config',
		'cache.consent',
		'cache.default',
		'cache.ec_key',
		'cache.feature_flags',
		'cache.introspection',
		'cache.introspection_key',
		'cache.jwks',
		'cache.partition_settings',
		'cache.plugin_context',
		'cache.rbac',
		'cache.refresh_token_shard',
		'cache.region_shard',
		'cache.rules',
		'cache.status_list',
		'cache.status_list_jwks',
		'cache.tenant_context',
		'cache.token_revocation',
		'cache.user',
		'cache.version_check',
		'client.jwt_bearer_signing_alg',
		'client.reuse_refresh_token',
		'client.strict_redirect_matching',
		'credentials.did_auth_ttl',
		'credentials.did_link_ttl',
		'credentials.email_code_length',
		'credentials.passkey_expiry',
		'credentials.passkey_registration_ttl',
		'discovery.claims_locales_supported',
		'encryption.default_encryption_alg',
		'encryption.default_encryption_enc',
		'encryption.default_signing_alg',
		'encryption.domain_hash_enabled',
		'encryption.domain_hash_salt_rotation',
		'encryption.key_overlap_period',
		'encryption.key_rotation_enabled',
		'encryption.key_rotation_interval',
		'encryption.password_iterations',
		'encryption.password_version',
		'encryption.pii_algorithm',
		'encryption.pii_encryption_enabled',
		'encryption.pii_fields',
		'encryption.pii_key_derivation',
		'encryption.pii_key_version',
		'encryption.rp_token_encryption_enabled',
		'external_idp.jwks_cache_ttl',
		'external_idp.jwks_fetch_timeout_ms',
		'external_idp.request_timeout_ms',
		'external_idp.token_encryption_enabled',
		'feature.enable_mock_auth',
		'feature.enable_test_endpoints',
		'federation.allow_unverified_email',
		'federation.auto_link_accounts',
		'federation.metadata_cache_ttl',
		'federation.require_signed_requests',
		'federation.scim_default_page_size',
		'federation.scim_failure_window_seconds',
		'federation.scim_lockout_seconds',
		'federation.scim_max_filter_complexity',
		'federation.scim_max_page_size',
		'federation.scim_token_min_expiry',
		'infra.backoff_multiplier',
		'infra.config_cache_ttl',
		'infra.default_fetch_timeout_ms',
		'infra.do_audit_flush_delay',
		'infra.do_cleanup_interval',
		'infra.dpop_signing_alg_values_supported',
		'infra.feature_flags_cache_ttl',
		'infra.jwks_cache_ttl',
		'infra.key_cache_ttl',
		'infra.retry_initial_delay',
		'infra.retry_max',
		'infra.retry_max_delay',
		'infra.supported_signing_algs',
		'infra.tenant_context_cache_ttl',
		'limits.default_batch_size',
		'limits.max_query_limit',
		'limits.token_exchange_max_audience_params',
		'limits.token_exchange_max_resource_params',
		'oauth.default_response_mode',
		'oauth.error_description',
		'oauth.error_uri',
		'oauth.id_token_aud_format',
		'oauth.iss_response_param',
		'oauth.prompt_none_behavior',
		'oauth.refresh_token_rotation',
		'oauth.response_modes_supported',
		'oauth.scope_required',
		'security.dpop_jti_ttl',
		'security.dpop_nonce_ttl',
		'security.ip_allowlist_enabled',
		'security.ip_blocklist_enabled',
		'security.jitter',
		'security.jwt_clock_skew_seconds',
		'security.loopback_flexible_port',
		'security.min_response_time',
		'security.mutual_tls_required',
		'security.nonce_required',
		'security.saml_clock_skew_seconds',
		'security.sender_constrained_tokens',
		'security.token_binding_required',
		'session.backchannel_retry_backoff_multiplier',
		'session.backchannel_retry_initial_delay_ms',
		'session.backchannel_retry_max_delay_ms',
		'session.min_ttl',
		'session.token_ttl',
		'session.tombstone_ttl',
		'tenant.base_domain',
		'tenant.default_id',
		'tenant.isolation_enabled',
		'tokens.access_token_signing_key_id',
		'tokens.access_token_singularization',
		'tokens.id_token_signing_key_id',
		'tokens.introspection_cache_inactive',
		'tokens.introspection_cache_max_size',
		'tokens.introspection_require_client_auth',
		'tokens.userinfo_signing_key_id',
		'vc.c_nonce_expiry',
		'vc.credential_offer_expiry',
		'vc.did_cache_ttl',
		'vc.pop_clock_skew',
		'vc.pop_validity',
		'vc.vp_request_expiry'
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
