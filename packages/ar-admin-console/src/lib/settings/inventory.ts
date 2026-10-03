/**
 * Where every Settings API setting will live: the draft placement of the settings not yet on a
 * built page. A built page's placement (`placement.ts`, SETTINGS_PAGES) is the final word for
 * its settings; this file holds the rest, so that all of them have a place before their pages
 * are built. `placement.test.ts` checks that every setting of every category is placed exactly
 * once, here or on a built page.
 *
 * Reviewed in Storybook (Pages › Settings map). Section names here are working English names;
 * a page gets translated names when it is built and its settings move to SETTINGS_PAGES.
 *
 * Depths are those of `placement.ts`: primary (on the page), advanced (under the section's
 * Advanced part), search (only through search and the all-settings list, unless set here),
 * hidden (never shown).
 */
import type { Depth } from './placement';

export interface DraftPage {
	/** `<area>/<item>` of the navigation (nav-data.ts), or a proposed new item. */
	id: string;
	/** Working name, for pages that are not in the navigation yet. */
	title?: string;
	/** Not in the navigation yet: proposed by this inventory. */
	proposed?: boolean;
	/** Where the settings are set: a tenant (inherits the platform), an app, the platform. */
	scope: 'platform' | 'tenant' | 'client';
	note?: string;
}

export interface DraftEntry {
	key: string;
	page: string;
	section: string;
	depth: Depth;
	/** The same setting under another key: one of the two should go (API clean-up). */
	duplicateOf?: string;
	note?: string;
}

export const DRAFT_PAGES: readonly DraftPage[] = [
	{ id: 'authentication/methods', scope: 'tenant', note: 'A method × use matrix (dedicated UI).' },
	{
		id: 'authentication/staying-signed-in',
		scope: 'tenant',
		note: 'A built page: these are its settings not yet applied (still read from the older logout settings).'
	},
	{ id: 'authentication/social', scope: 'tenant' },
	{ id: 'authentication/enterprise', scope: 'tenant' },
	{ id: 'authentication/directory', scope: 'tenant' },
	{ id: 'authentication/federation-trust', scope: 'tenant' },
	{ id: 'authentication/protection', scope: 'tenant' },
	{ id: 'authentication/ip-allowlist', scope: 'tenant' },
	{
		id: 'applications/defaults',
		title: 'App defaults',
		proposed: true,
		scope: 'tenant',
		note: 'What every app of the tenant gets unless the app overrides it (oauth and security are tenant + app categories). Its own item under Applications, beside the service flows.'
	},
	{
		id: 'applications/all',
		scope: 'client',
		note: 'One app’s own settings, in the app (RP) step of its service flow. Its defaults come from App defaults.'
	},
	{ id: 'access/attributes', scope: 'tenant' },
	{ id: 'access/relationships', scope: 'tenant' },
	{ id: 'access/policies', scope: 'tenant' },
	{ id: 'access/roles', scope: 'tenant' },
	{ id: 'access/schema', scope: 'tenant' },
	{ id: 'users/lifecycle', scope: 'tenant' },
	{ id: 'users/support', scope: 'tenant' },
	{ id: 'customization/branding', scope: 'tenant' },
	{
		id: 'customization/login-ui',
		scope: 'tenant',
		note: 'The theme editor (dedicated UI with a live preview).'
	},
	{ id: 'customization/screens', scope: 'tenant' },
	{ id: 'customization/account-page', scope: 'tenant' },
	{ id: 'monitoring/diagnostics', scope: 'tenant' },
	{ id: 'monitoring/log-settings', scope: 'tenant' },
	{ id: 'monitoring/destinations', scope: 'tenant' },
	{ id: 'integrations/plugins', scope: 'tenant' },
	{ id: 'settings/general', scope: 'tenant' },
	{ id: 'settings/domains', scope: 'tenant' },
	{ id: 'settings/signing-keys', scope: 'tenant' },
	{ id: 'settings/compliance', scope: 'tenant' },
	{ id: 'settings/runtime', scope: 'tenant' },
	{ id: 'settings/team', scope: 'tenant' },
	{ id: 'plat-tenants/discovery', scope: 'platform' },
	{
		id: 'plat-infra/scale',
		scope: 'platform',
		note: 'Caches, retries and timeouts: technical tuning, found by search.'
	},
	{
		id: 'hidden',
		title: 'Not shown',
		scope: 'tenant',
		note: 'Deploy-time, in development, or a duplicate.'
	}
];

const entries: DraftEntry[] = [];

/** Places settings of one section, by depth; `notes` explain a judgement call. */
function place(
	page: string,
	section: string,
	groups: Partial<Record<Depth, readonly string[]>>,
	notes: Readonly<Record<string, string>> = {}
): void {
	for (const [depth, keys] of Object.entries(groups) as [Depth, readonly string[]][]) {
		for (const key of keys) entries.push({ key, page, section, depth, note: notes[key] });
	}
}

/** A setting that repeats another one: kept out of sight, flagged for the API clean-up. */
function duplicate(key: string, of: string, note?: string): void {
	entries.push({
		key,
		page: 'hidden',
		section: 'Duplicates',
		depth: 'hidden',
		duplicateOf: of,
		note
	});
}

// ---------------------------------------------------------------------------------------------
// Authentication

place('authentication/methods', 'Sign-in methods', {
	primary: [
		'authentication-methods.passkey.login_enabled',
		'authentication-methods.passkey.signup_enabled',
		'authentication-methods.email_otp.login_enabled',
		'authentication-methods.email_otp.signup_enabled',
		'authentication-methods.totp.login_enabled',
		'authentication-methods.totp.signup_enabled'
	],
	advanced: [
		'authentication-methods.passkey.reauth_enabled',
		'authentication-methods.passkey.account_link_enabled',
		'authentication-methods.email_otp.reauth_enabled',
		'authentication-methods.email_otp.account_link_enabled',
		'authentication-methods.totp.reauth_enabled',
		'authentication-methods.totp.account_link_enabled'
	],
	search: ['authentication-methods.cache_ttl']
});
place('authentication/methods', 'Guests', {
	primary: ['authentication-methods.guest.login_enabled'],
	advanced: [
		'authentication-methods.email_otp.guest_upgrade_enabled',
		'authentication-methods.passkey.guest_upgrade_enabled'
	]
});
place('authentication/methods', 'Authenticator app (TOTP)', {
	advanced: [
		'authentication-methods.totp.preset',
		'authentication-methods.totp.requirement_policy'
	],
	search: ['authentication-methods.totp.default_acr']
});
place('authentication/methods', 'Email codes and passkeys', {
	advanced: ['credentials.email_code_ttl', 'credentials.email_code_length'],
	search: ['credentials.passkey_registration_ttl', 'credentials.passkey_expiry']
});
place('authentication/methods', 'DID', {
	search: ['credentials.did_link_ttl', 'credentials.did_auth_ttl']
});
place(
	'authentication/methods',
	'Assurance levels',
	{
		advanced: [
			'assurance.enabled',
			'assurance.default_aal',
			'assurance.default_fal',
			'assurance.default_ial',
			'assurance.scope_aal_requirements',
			'assurance.upstream_acr_mappings',
			'assurance.scope_ial_requirements',
			'assurance.ial_assurance_values',
			'assurance.saml_authn_context_aal',
			'assurance.ida_profile',
			'assurance.include_in_id_token',
			'assurance.include_in_access_token',
			'assurance.fal2_requires_dpop',
			'assurance.fal3_requires_par'
		]
	},
	{
		'assurance.enabled':
			'NIST SP 800-63-4; few tenants need it, so the whole feature sits in Advanced.'
	}
);

place('authentication/social', 'Providers', {
	primary: [
		'authentication-methods.external_providers',
		'authentication-methods.external_provider_usage'
	]
});
place('authentication/social', 'Creating users on first sign-in', {
	primary: ['external_idp.jit_provisioning_enabled', 'external_idp.jit_update_on_login'],
	advanced: [
		'external_idp.jit_update_fields',
		'external_idp.token_encryption_enabled',
		'external_idp.jit_require_verified_email',
		'external_idp.jit_allowed_provider_ids',
		'external_idp.jit_default_role_id',
		'external_idp.jit_join_all_matching_orgs',
		'external_idp.jit_allow_user_without_org',
		'external_idp.jit_allow_unverified_domain_mappings'
	],
	search: [
		'external_idp.jwks_cache_ttl',
		'external_idp.jwks_fetch_timeout_ms',
		'external_idp.request_timeout_ms'
	]
});

place(
	'authentication/enterprise',
	'SAML',
	{
		primary: ['federation.saml_enabled'],
		advanced: [
			'federation.saml_nameid_format',
			'federation.saml_sso_binding',
			'federation.saml_slo_binding',
			'federation.require_signed_requests',
			'tenant.saml_attribute_release_failure_message_mode',
			'security.saml_clock_skew_seconds'
		],
		search: [
			'federation.saml_assertion_ttl',
			'federation.saml_request_ttl',
			'federation.saml_artifact_ttl',
			'federation.saml_artifact_resolution_timeout',
			'federation.metadata_cache_ttl'
		]
	},
	{
		'federation.require_signed_requests':
			'Named “federation” but only SAML signs requests; confirm it is SAML-only.'
	}
);

place('authentication/directory', 'Directory password', {
	primary: [
		'authentication-methods.directory_password.enabled',
		'authentication-methods.directory_password.label'
	],
	advanced: [
		'authentication-methods.directory_password.connector_id',
		'authentication-methods.directory_password.auto_provision'
	]
});

place(
	'authentication/federation-trust',
	'Account linking',
	{ primary: ['federation.auto_link_accounts', 'federation.allow_unverified_email'] },
	{
		'federation.allow_unverified_email':
			'Security-sensitive: kept on view, next to the setting it weakens.'
	}
);

place('authentication/protection', 'Failed sign-ins', {
	primary: ['rate_limit.auth_max_failed_attempts']
});
place('authentication/protection', 'Bot protection', {
	primary: [
		'authentication-methods.human_verification.login_enabled',
		'authentication-methods.human_verification.signup_enabled'
	],
	advanced: [
		'authentication-methods.human_verification.reauth_enabled',
		'authentication-methods.human_verification.provider'
	]
});
place('authentication/protection', 'Email sending limit', {
	advanced: ['rate_limit.email_max_requests', 'rate_limit.email_window']
});
place('authentication/protection', 'API rate limits', {
	advanced: [
		'rate_limit.strict',
		'rate_limit.moderate',
		'rate_limit.lenient',
		'rate_limit.public_read',
		'rate_limit.login_start',
		'rate_limit.send_challenge'
	],
	search: [
		'rate_limit.strict_window_seconds',
		'rate_limit.moderate_window_seconds',
		'rate_limit.lenient_window_seconds',
		'rate_limit.public_read_window_seconds',
		'rate_limit.login_start_window_seconds',
		'rate_limit.send_challenge_window_seconds',
		'rate_limit.loadtest',
		'rate_limit.loadtest_window_seconds',
		'security.min_response_time',
		'security.jitter'
	]
});

place('authentication/ip-allowlist', 'IP addresses', {
	primary: ['security.ip_allowlist_enabled', 'security.ip_blocklist_enabled']
});

// ---------------------------------------------------------------------------------------------
// Applications: the tenant's defaults for every app, and one app's own settings

place('applications/defaults', 'Authorization requests', {
	primary: ['security.pkce_required', 'security.par_required', 'oauth.state_required'],
	advanced: [
		'security.pkce_s256_required',
		'security.nonce_required',
		'oauth.scope_required',
		'oauth.prompt_none_behavior',
		'oauth.default_response_mode',
		'oauth.response_modes_supported',
		'oauth.jarm_enabled',
		'oauth.iss_response_param',
		'security.require_signed_request_object',
		'security.require_encrypted_request_object',
		'oauth.response_types_supported'
	],
	search: [
		'security.allow_unsigned_request_object',
		'oauth.auth_code_ttl',
		'oauth.state_expiry',
		'oauth.nonce_expiry',
		'oauth.max_codes_per_user',
		'oauth.par_default_ttl',
		'oauth.par_fapi_ttl'
	]
});
place('applications/defaults', 'Request objects by reference (request_uri)', {
	advanced: [
		'oauth.https_request_uri_enabled',
		'oauth.https_request_uri_allowed_domains',
		'security.https_request_uri'
	],
	search: ['oauth.https_request_uri_max_size', 'oauth.https_request_uri_timeout_ms']
});
place('applications/defaults', 'Redirect URIs', {
	primary: ['security.https_redirect_only'],
	advanced: ['security.allow_http_redirect', 'security.loopback_flexible_port']
});
place('applications/defaults', 'Sender-constrained tokens', {
	primary: ['security.dpop_bound_access_tokens'],
	advanced: [
		'security.dpop_required',
		'security.dpop_nonce_enabled',
		'security.dpop_nonce_resource_overrides',
		'security.mutual_tls_required',
		'security.sender_constrained_tokens',
		'security.token_binding_required'
	],
	search: ['security.dpop_nonce_ttl', 'security.dpop_jti_ttl']
});
place('applications/defaults', 'FAPI', {
	primary: ['security.fapi_enabled'],
	advanced: [
		'security.fapi_strict_dpop',
		'security.fapi_allow_public_clients',
		'security.fapi_require_private_key_jwt',
		'security.fapi_client_assertion_audience',
		'security.fapi_message_signing_enabled',
		'security.require_jarm'
	],
	search: [
		'security.request_object_signing_algs',
		'security.authorization_signing_algs',
		'security.default_authorization_signing_alg',
		'security.request_object_max_age_seconds',
		'security.request_object_max_lifetime_seconds',
		'security.request_object_clock_skew_seconds'
	]
});
place('applications/defaults', 'Rich authorization requests', {
	advanced: ['feature.enable_rar']
});
place('applications/defaults', 'Machine-to-machine (client credentials)', {
	primary: ['feature.enable_client_credentials']
});
place('applications/defaults', 'Token exchange', {
	primary: ['tokens.exchange_enabled'],
	advanced: [
		'tokens.exchange_delegation_enabled',
		'tokens.exchange_impersonation_enabled',
		'tokens.exchange_allowed_subject_token_types',
		'feature.enable_id_jag',
		'tokens.id_jag_allowed_issuers'
	],
	search: [
		'limits.token_exchange_max_resource_params',
		'limits.token_exchange_max_audience_params',
		'tokens.id_jag_max_token_lifetime',
		'tokens.id_jag_include_tenant_claim',
		'tokens.id_jag_require_confidential_client'
	]
});
place('applications/defaults', 'Tokens', {
	advanced: [
		'oauth.id_token_aud_format',
		'oauth.userinfo_require_openid',
		'tokens.access_token_singularization'
	],
	search: ['security.jwt_clock_skew_seconds']
});
place('applications/defaults', 'Browser apps', {
	advanced: ['tenant.browser_public_client_mode']
});
place('applications/defaults', 'Token introspection', {
	advanced: [
		'tokens.introspection_require_client_auth',
		'tokens.introspection_strict_validation',
		'tokens.introspection_extended_claims',
		'tokens.introspection_expected_audience'
	],
	search: [
		'tokens.introspection_cache_ttl',
		'tokens.introspection_cache_max_size',
		'tokens.introspection_cache_inactive',
		'feature.introspection_cache_enabled'
	]
});
place('applications/defaults', 'Error responses', {
	advanced: [
		'oauth.error_description',
		'oauth.error_uri',
		'oauth.error_response_format',
		'oauth.error_id_mode',
		'oauth.error_locale'
	]
});
place('applications/defaults', 'Device sign-in (Device Flow)', {
	advanced: [
		'device_flow.expires_in',
		'device_flow.user_code_charset',
		'device_flow.user_code_length'
	],
	search: [
		'device_flow.poll_interval',
		'device_flow.max_poll_count',
		'device_flow.slow_down_increment',
		'device_flow.min_expires_in',
		'device_flow.max_expires_in',
		'device_flow.min_interval',
		'device_flow.max_interval'
	]
});
place(
	'applications/defaults',
	'Backchannel sign-in (CIBA)',
	{
		advanced: [
			'ciba.expires_in',
			'ciba.binding_message_required',
			'ciba.user_code_enabled',
			'oauth.backchannel_token_delivery_mode',
			'oauth.backchannel_token_delivery_modes_supported'
		],
		search: [
			'ciba.poll_interval',
			'ciba.max_poll_count',
			'ciba.slow_down_increment',
			'ciba.min_expires_in',
			'ciba.max_expires_in',
			'ciba.min_interval',
			'ciba.max_interval',
			'ciba.max_binding_message_length',
			'ciba.auth_request_ttl',
			'ciba.ping_notification_timeout_ms',
			'ciba.push_notification_timeout_ms',
			'ciba.notifier_default_timeout_ms',
			'ciba.notifier_max_timeout_ms',
			'ciba.notifier_retry_delay_base_ms'
		]
	},
	{
		'oauth.backchannel_token_delivery_mode':
			'Lives in the oauth category but is a CIBA setting; shown with CIBA.'
	}
);
place('applications/defaults', 'Dynamic client registration', {
	primary: ['dcr.enabled'],
	advanced: [
		'dcr.require_initial_access_token',
		'dcr.scope_restriction_enabled',
		'dcr.allow_duplicate_software_id'
	]
});
place(
	'applications/defaults',
	'SCIM provisioning',
	{
		advanced: [
			'federation.scim_token_default_expiry',
			'federation.scim_token_min_expiry',
			'federation.scim_token_max_expiry'
		],
		search: [
			'federation.scim_lockout_seconds',
			'federation.scim_failure_window_seconds',
			'federation.scim_default_page_size',
			'federation.scim_max_page_size',
			'federation.scim_max_filter_complexity'
		]
	},
	{
		'federation.scim_token_default_expiry':
			'SCIM connections are service flows; the tenant-wide SCIM limits sit with the app defaults.'
	}
);
place('applications/defaults', 'Discovery document', {
	search: [
		'discovery.claims_supported',
		'discovery.claims_locales_supported',
		'discovery.acr_values_supported',
		'oauth.token_endpoint_auth_methods_supported',
		'feature.enable_ai_scopes'
	]
});

place('applications/all', 'App: tokens and sign-in', {
	primary: [
		'client.access_token_ttl',
		'client.refresh_token_ttl',
		'client.id_token_ttl',
		'client.sso_enabled'
	],
	advanced: [
		'client.refresh_token_rotation',
		'client.reuse_refresh_token',
		'client.default_max_age',
		'client.default_acr_values',
		'client.require_auth_time'
	]
});
place(
	'applications/all',
	'App: grants and responses',
	{ primary: ['client.grant_types', 'client.response_types'] },
	{
		'client.grant_types':
			'The allow_* switches below say the same thing; show one (a checklist of grant types).'
	}
);
place('applications/all', 'App: redirects and logout', {
	primary: ['client.frontchannel_logout_uri', 'client.backchannel_logout_uri'],
	advanced: [
		'client.strict_redirect_matching',
		'client.allow_localhost_redirect',
		'client.frontchannel_logout_session_required',
		'client.backchannel_logout_session_required',
		'client.initiate_login_uri',
		'client.request_uris',
		'client.login_ui_url'
	]
});
place('applications/all', 'App: security', {
	primary: ['client.token_endpoint_auth_method', 'client.pkce_required', 'client.dpop_mode'],
	advanced: [
		'client.par_required',
		'client.dpop_bound_access_tokens',
		'client.subject_type',
		'client.sector_identifier_uri',
		'client.token_exchange_allowed',
		'client.delegation_mode'
	]
});
place('applications/all', 'App: signing and encryption', {
	advanced: ['client.id_token_signing_alg', 'client.userinfo_signed_response_alg'],
	search: [
		'client.id_token_encrypted_response_alg',
		'client.id_token_encrypted_response_enc',
		'client.userinfo_encrypted_response_alg',
		'client.userinfo_encrypted_response_enc',
		'client.request_object_signing_alg',
		'client.request_object_encryption_alg',
		'client.request_object_encryption_enc',
		'client.jwt_bearer_signing_alg',
		'client.token_endpoint_auth_signing_alg'
	]
});
place('applications/all', 'App: scopes and audience', {
	primary: ['client.allowed_scopes'],
	advanced: [
		'client.allowed_scopes_restriction_enabled',
		'client.default_scope',
		'client.default_audience',
		'client.default_resource'
	]
});
place('applications/all', 'App: shown to people signing in', {
	primary: ['client.logo_uri', 'client.client_uri', 'client.policy_uri', 'client.tos_uri'],
	advanced: ['client.contacts']
});
place('applications/all', 'App: native and browser apps', {
	primary: ['client.application_type'],
	advanced: [
		'client.app_login_enabled',
		'client.native_sso_enabled',
		'client.native_channel_allowed',
		'client.allowed_channels',
		'client.trust_group',
		'client.browser_public_client_mode',
		'client.browser_refresh_token_policy'
	]
});
place(
	'applications/all',
	'Verifiable credentials (issuing and verifying flows)',
	{
		primary: ['feature.enable_sd_jwt'],
		advanced: ['vc.vp_request_expiry', 'vc.credential_offer_expiry'],
		search: ['vc.c_nonce_expiry', 'vc.pop_validity', 'vc.pop_clock_skew', 'vc.did_cache_ttl']
	},
	{
		'feature.enable_sd_jwt':
			'VC issuing and verifying are service flow connections; their tenant settings go with them.'
	}
);

// ---------------------------------------------------------------------------------------------
// Access control

place('access/attributes', 'Attribute-based access (ABAC)', {
	primary: ['feature.enable_abac'],
	advanced: ['feature.enable_verified_attributes']
});
place('access/relationships', 'Relationship-based access (ReBAC)', {
	primary: ['feature.enable_rebac']
});
place('access/policies', 'Policies', {
	primary: ['feature.enable_custom_rules'],
	advanced: [
		'feature.enable_policy_logging',
		'feature.enable_policy_embedding',
		'feature.enable_id_level_permissions',
		'feature.enable_check_api'
	],
	search: [
		'limits.max_embedded_permissions',
		'limits.max_resource_permissions',
		'limits.check_api_batch_size',
		'feature.enable_ai_ephemeral_auth'
	]
});
place('access/roles', 'Roles in tokens', {
	advanced: ['tokens.rbac_id_token_claims', 'tokens.rbac_access_token_claims']
});
place('access/schema', 'Custom claims', {
	advanced: [
		'feature.enable_custom_claim_schemas',
		'feature.enable_custom_claim_schemas_introspection',
		'feature.enable_custom_claims'
	],
	search: ['limits.custom_claim_schemas_max_per_target', 'limits.max_custom_claims']
});

// ---------------------------------------------------------------------------------------------
// Users

place('users/lifecycle', 'Guest accounts', {
	primary: [
		'account-lifecycle.guest.deletion_enabled',
		'account-lifecycle.guest.deletion_after_days',
		'account-lifecycle.guest.upgrade_enabled',
		'account-lifecycle.guest.upgrade_hold_minutes'
	]
});
place('users/support', 'Approvals', {
	primary: ['support_ops.allow_self_approval', 'support_ops.duty_separation']
});

// ---------------------------------------------------------------------------------------------
// Customization

place('customization/branding', 'Brand', {
	primary: [
		'login-ui.brand_name',
		'login-ui.logo_url',
		'login-ui.logo_display',
		'login-ui.favicon_url'
	],
	advanced: ['login-ui.brand_panel_title', 'login-ui.brand_panel_text']
});
place('customization/login-ui', 'Theme', {
	primary: [
		'login-ui.theme',
		'login-ui.variant',
		'login-ui.theme_template',
		'login-ui.page_layout',
		'login-ui.font_family',
		'login-ui.font_scale'
	],
	search: ['login-ui.thumbnail_url']
});
place('customization/login-ui', 'Colours', {
	advanced: [
		'login-ui.background_color',
		'login-ui.accent_color',
		'login-ui.title_color',
		'login-ui.text_color',
		'login-ui.copy_color'
	]
});
place('customization/login-ui', 'Layout', {
	advanced: [
		'login-ui.header_enabled',
		'login-ui.subtitle_enabled',
		'login-ui.footer_enabled',
		'login-ui.powered_by_enabled',
		'login-ui.auth_switch_link_enabled',
		'login-ui.topbar_position',
		'login-ui.theme_toggle_enabled',
		'login-ui.language_select_enabled',
		'login-ui.language_switcher_position',
		'login-ui.header_style',
		'login-ui.footer_style',
		'login-ui.logo_layout',
		'login-ui.background_image_url'
	]
});
place('customization/login-ui', 'Split layout', {
	advanced: [
		'login-ui.split_frame',
		'login-ui.split_panel_side',
		'login-ui.split_panel_width',
		'login-ui.split_background_mode',
		'login-ui.login_panel_background_color',
		'login-ui.login_panel_background_gradient_color',
		'login-ui.login_panel_background_opacity',
		'login-ui.login_panel_background_image_url',
		'login-ui.brand_content_mode',
		'login-ui.brand_position',
		'login-ui.brand_align'
	]
});
place('customization/login-ui', 'Text', {
	advanced: [
		'login-ui.header_text',
		'login-ui.text_localizations',
		'login-ui.footer_text',
		'login-ui.footer_links',
		'login-ui.custom_blocks'
	]
});
place('customization/login-ui', 'Languages', {
	primary: ['login-ui.supported_locales', 'login-ui.default_locale'],
	advanced: ['login-ui.primary_locales', 'login-ui.show_english_language_names']
});
place('customization/login-ui', 'Custom CSS and themes', {
	advanced: ['login-ui.custom_css', 'login-ui.custom_themes']
});
place('customization/screens', 'Screen flows', {
	primary: ['feature.enable_flow_engine'],
	advanced: [
		'tenant.ui_base_url',
		'tenant.ui_login_path',
		'tenant.ui_consent_path',
		'tenant.ui_reauth_path',
		'tenant.ui_error_path',
		'tenant.ui_device_path',
		'tenant.ui_device_authorize_path',
		'tenant.ui_logout_complete_path',
		'tenant.ui_logged_out_path',
		'tenant.ui_register_path'
	]
});
place('customization/account-page', 'Account page', {
	primary: ['self-service.account_page_enabled'],
	advanced: ['self-service.account_page_path', 'self-service.reauth_ttl_seconds']
});
place(
	'customization/account-page',
	'After signing in',
	{
		primary: ['login-entry.post_login_behavior'],
		advanced: [
			'login-entry.post_login_redirect_url',
			'login-entry.app_login_client_id',
			'login-entry.app_login_redirect_uri',
			'login-entry.app_login_final_return_to',
			'login-entry.app_login_scope',
			'security.trusted_redirect_origins'
		]
	},
	{
		'login-entry.post_login_behavior':
			'Where people land after signing in directly — the account page by default, so it sits with it.'
	}
);

// ---------------------------------------------------------------------------------------------
// Monitoring and integrations

place('monitoring/diagnostics', 'Diagnostic logging', {
	primary: ['diagnostic-logging.enabled', 'diagnostic-logging.log_level'],
	advanced: [
		'diagnostic-logging.http_request_enabled',
		'diagnostic-logging.http_response_enabled',
		'diagnostic-logging.token_validation_enabled',
		'diagnostic-logging.auth_decision_enabled',
		'diagnostic-logging.filter_pii',
		'diagnostic-logging.filter_tokens',
		'diagnostic-logging.storage_mode.default',
		'diagnostic-logging.storage_mode.by_client',
		'diagnostic-logging.retention_days',
		'diagnostic-logging.sdk_ingest_enabled',
		'diagnostic-logging.merged_output_enabled',
		'diagnostic-logging.r2_output_enabled'
	],
	search: [
		'diagnostic-logging.r2_bucket_binding',
		'diagnostic-logging.r2_path_prefix',
		'diagnostic-logging.output_format',
		'diagnostic-logging.buffer_strategy',
		'diagnostic-logging.batch_size',
		'diagnostic-logging.batch_interval_ms',
		'diagnostic-logging.token_hash_prefix_length',
		'diagnostic-logging.http_safe_headers',
		'diagnostic-logging.http_body_schema_aware'
	]
});
place('monitoring/log-settings', 'Permission check logs', {
	primary: ['audit.check_api_enabled'],
	advanced: [
		'audit.check_api_log_allow',
		'audit.check_api_sample_rate',
		'audit.check_api_retention_days'
	],
	search: ['audit.check_api_mode']
});
place(
	'monitoring/destinations',
	'Backups',
	{ primary: ['dr-backup.storage_destination_id'] },
	{
		'dr-backup.storage_destination_id':
			'Storage destinations are chosen in one place for every feature (logs, backups).'
	}
);
place('integrations/plugins', 'Plugins', {
	primary: ['plugin.enabled'],
	advanced: [
		'plugin.execution_timeout_ms',
		'plugin.memory_limit_mb',
		'plugin.auto_update_check',
		'plugin.notifier_resend_enabled'
	],
	search: ['plugin.notifier_console_enabled']
});

// ---------------------------------------------------------------------------------------------
// Tenant settings

place('settings/general', 'Tenant', {
	primary: ['tenant.name', 'tenant.logo_uri', 'tenant.tos_uri', 'tenant.policy_uri']
});
place('settings/domains', 'Domains and origins', {
	primary: ['tenant.base_domain', 'tenant.allowed_domains'],
	advanced: [
		'tenant.allowed_identifiers',
		'tenant.allowed_origins',
		'service-site.fallback_enabled'
	]
});
place('settings/signing-keys', 'Token signing', {
	advanced: [
		'oauth.id_token_signing_alg',
		'tokens.access_token_signing_key_id',
		'tokens.id_token_signing_key_id',
		'tokens.userinfo_signing_key_id'
	]
});
place(
	'settings/signing-keys',
	'Key rotation (platform)',
	{
		primary: ['encryption.key_rotation_enabled'],
		advanced: [
			'encryption.key_rotation_interval',
			'encryption.key_overlap_period',
			'encryption.default_signing_alg',
			'encryption.default_encryption_alg',
			'encryption.default_encryption_enc'
		]
	},
	{ 'encryption.key_rotation_enabled': 'Platform only, and read-only: set when deploying.' }
);
place('settings/compliance', 'Audit and data residency', {
	primary: [
		'tenant.audit_profile_id',
		'tenant.residency_profile_id',
		'infra.default_audit_profile_id',
		'infra.default_residency_profile_id'
	],
	advanced: ['tenant.isolation_enabled']
});
place(
	'settings/compliance',
	'Personal data encryption (platform)',
	{
		primary: ['encryption.pii_encryption_enabled'],
		advanced: [
			'encryption.pii_algorithm',
			'encryption.pii_fields',
			'encryption.domain_hash_enabled',
			'encryption.rp_token_encryption_enabled'
		],
		search: ['encryption.pii_key_version']
	},
	{ 'encryption.pii_encryption_enabled': 'Platform only, and read-only: set when deploying.' }
);
place(
	'settings/runtime',
	'Conformance testing',
	{ advanced: ['feature.conformance_enabled', 'feature.conformance_use_builtin_forms'] },
	{
		'feature.conformance_enabled':
			'OpenID certification runs only; should it be a platform-only switch?'
	}
);
place('settings/runtime', 'Limits', {
	search: ['limits.max_query_limit', 'limits.default_batch_size']
});
place('authentication/staying-signed-in', 'Logout channels and webhook', {
	advanced: [
		'session.backchannel_enabled',
		'session.frontchannel_enabled',
		'session.session_management_enabled',
		'session.check_session_iframe_enabled',
		'session.logout_webhook_enabled'
	],
	search: [
		'session.backchannel_include_sub',
		'session.backchannel_include_sid',
		'session.logout_webhook_include_sub',
		'session.logout_webhook_include_sid'
	]
});
place('settings/team', 'Admin sign-in', {
	advanced: ['session.ttl.admin_passkey']
});

// ---------------------------------------------------------------------------------------------
// Platform

place('plat-tenants/discovery', 'Finding the tenant', {
	primary: ['login-entry.mode', 'login-entry.discovery_methods', 'login-entry.selection_policy'],
	advanced: [
		'login-entry.override_enabled',
		'login-entry.email_resolution_policy',
		'login-entry.allow_manual_tenant_entry',
		'login-entry.remember_last_tenant',
		'login-entry.redirect_default_login_to_discovery',
		'login-entry.require_common_discovery_before_login',
		'login-entry.skip_discovery_if_only_one_tenant',
		'login-entry.redirect_tenant_discover_to_common_entry'
	]
});
place('plat-tenants/discovery', 'Discovery screen', {
	primary: ['tenant-discovery-ui.inherit_from_login_ui'],
	advanced: [
		'tenant-discovery-ui.override_enabled',
		'tenant-discovery-ui.theme',
		'tenant-discovery-ui.variant',
		'tenant-discovery-ui.brand_name',
		'tenant-discovery-ui.logo_url',
		'tenant-discovery-ui.page_title',
		'tenant-discovery-ui.kicker_text',
		'tenant-discovery-ui.title_text',
		'tenant-discovery-ui.subtitle_text'
	]
});
place('plat-infra/scale', 'Caches', {
	search: [
		'cache.jwks',
		'cache.api_key',
		'cache.default',
		'cache.config',
		'cache.plugin_context',
		'cache.tenant_context',
		'cache.ec_key',
		'cache.introspection_key',
		'cache.challenge_shard',
		'cache.refresh_token_shard',
		'cache.region_shard',
		'cache.status_list',
		'cache.status_list_jwks',
		'cache.feature_flags',
		'cache.version_check',
		'cache.token_revocation',
		'cache.user',
		'cache.consent',
		'cache.partition_settings',
		'cache.rules',
		'cache.rbac',
		'cache.introspection'
	]
});
place(
	'plat-infra/scale',
	'Infrastructure (read-only)',
	{
		search: [
			'infra.config_cache_ttl',
			'infra.tenant_context_cache_ttl',
			'infra.key_cache_ttl',
			'infra.jwks_cache_ttl',
			'infra.feature_flags_cache_ttl',
			'infra.retry_max',
			'infra.retry_initial_delay',
			'infra.retry_max_delay',
			'infra.backoff_multiplier',
			'infra.default_fetch_timeout_ms',
			'infra.do_cleanup_interval',
			'infra.do_audit_flush_delay',
			'infra.do_saml_request_expiry',
			'infra.do_saml_artifact_expiry'
		]
	},
	{
		'infra.config_cache_ttl':
			'Like cache.config, which is not read either: only its env var applies. Both are to leave the catalog.',
		'infra.tenant_context_cache_ttl':
			'Like cache.tenant_context; neither is read (a code constant applies). Both are to leave the catalog.',
		'infra.feature_flags_cache_ttl':
			'Like cache.feature_flags; neither is read (a code constant applies). Both are to leave the catalog.',
		'infra.do_saml_request_expiry':
			'Same as federation.saml_request_ttl, which is to be built; this one is to go.'
	}
);

// ---------------------------------------------------------------------------------------------
// Not shown: deploy-time, in development, and duplicates

place('hidden', 'Deploy-time or internal', {
	hidden: [
		'tenant.default_id',
		'tenant.user_id_format',
		'feature.enable_test_endpoints',
		'feature.enable_mock_auth',
		'infra.supported_signing_algs',
		'infra.dpop_signing_alg_values_supported',
		'encryption.pii_key_derivation',
		'encryption.domain_hash_salt_rotation',
		'encryption.password_iterations',
		'encryption.password_version'
	]
});
place('hidden', 'Kept by the theme and account page editors', {
	hidden: [
		'login-ui.published_version',
		'login-ui.published_at',
		'login-ui.published_snapshot',
		'login-ui.rollback_snapshot',
		'login-ui.account_pages',
		'login-ui.account_page_draft',
		'login-ui.account_page_published',
		'login-ui.account_page_published_version',
		'login-ui.account_page_published_at'
	]
});

/** The runtime reads the other key; this one is not read and is to go. */
const OTHER_APPLIES = 'The runtime reads the other key; this one is to go.';
/** Neither key is read: the app's registration applies. */
const REGISTRATION = "Neither key is read: the app's registration applies. This one is to go.";
duplicate('security.enable_abac', 'feature.enable_abac', OTHER_APPLIES);
duplicate('security.enable_rebac', 'feature.enable_rebac', OTHER_APPLIES);
duplicate('security.enable_policy_logging', 'feature.enable_policy_logging', OTHER_APPLIES);
duplicate(
	'security.enable_verified_attributes',
	'feature.enable_verified_attributes',
	OTHER_APPLIES
);
duplicate('feature.enable_token_exchange', 'tokens.exchange_enabled', OTHER_APPLIES);
duplicate('credentials.did_session_ttl', 'session.ttl.did', OTHER_APPLIES);
duplicate('client.dpop_required', 'client.dpop_mode', REGISTRATION);
duplicate('client.client_credentials_allowed', 'client.grant_types', REGISTRATION);
for (const grant of [
	'allow_authorization_code',
	'allow_client_credentials',
	'allow_refresh_token',
	'allow_device_code',
	'allow_ciba'
]) {
	duplicate(`client.${grant}`, 'client.grant_types', REGISTRATION);
}
for (const response of ['allow_code_response', 'allow_token_response', 'allow_id_token_response']) {
	duplicate(`client.${response}`, 'client.response_types', REGISTRATION);
}

export const DRAFT: readonly DraftEntry[] = entries;
