/**
 * Client Settings Category
 *
 * Per-client OAuth settings.
 * API: GET/PATCH /api/admin/clients/:clientId/settings
 * Config Level: client
 */

import type { CategoryMeta, SettingMeta } from '../../utils/settings-manager';

/**
 * Client Settings Interface
 */
export interface ClientSettings {
  // Token Settings
  'client.access_token_ttl': number;
  'client.refresh_token_ttl': number;
  'client.id_token_ttl': number;

  // Security Settings
  'client.pkce_required': boolean;
  'client.par_required': boolean;
  'client.dpop_required': boolean;

  // App Login Settings (first-party authority lives in Client Trust Policy)
  'client.app_login_enabled': boolean;

  // SSO Override
  'client.sso_enabled': boolean;

  // Token Behavior
  'client.refresh_token_rotation': boolean;
  'client.reuse_refresh_token': boolean;

  // Grant Types
  'client.allow_authorization_code': boolean;
  'client.allow_client_credentials': boolean;
  'client.allow_refresh_token': boolean;
  'client.allow_device_code': boolean;
  'client.allow_ciba': boolean;

  // Response Types
  'client.allow_code_response': boolean;
  'client.allow_token_response': boolean;
  'client.allow_id_token_response': boolean;

  // Redirect Settings
  'client.strict_redirect_matching': boolean;
  'client.allow_localhost_redirect': boolean;

  // UserInfo Settings
  'client.userinfo_signed_response_alg': string;

  // Authentication Method
  'client.token_endpoint_auth_method': string;

  // Grant/Response Types (string format for multiple values)
  'client.grant_types': string;
  'client.response_types': string;

  // Subject Type
  'client.subject_type': string;

  // DPoP & Token Exchange
  'client.dpop_bound_access_tokens': boolean;
  'client.dpop_mode': 'disabled' | 'critical_only' | 'all';
  'client.token_exchange_allowed': boolean;
  'client.delegation_mode': string;

  // Logout URIs
  'client.frontchannel_logout_uri': string;
  'client.frontchannel_logout_session_required': boolean;
  'client.backchannel_logout_uri': string;
  'client.backchannel_logout_session_required': boolean;

  // Scopes & Audience
  'client.allowed_scopes': string;
  'client.default_scope': string;
  'client.default_audience': string;
  'client.default_resource': string;
  'client.allowed_scopes_restriction_enabled': boolean;
  'client.client_credentials_allowed': boolean;

  // Client Metadata URIs
  'client.logo_uri': string;
  'client.contacts': string;
  'client.tos_uri': string;
  'client.policy_uri': string;
  'client.client_uri': string;
  'client.initiate_login_uri': string;
  'client.login_ui_url': string;

  // Application Settings
  'client.application_type': string;
  'client.sector_identifier_uri': string;
  'client.trust_group': string;
  'client.native_sso_enabled': boolean;
  'client.native_channel_allowed': boolean;
  'client.allowed_channels': string;
  'client.browser_public_client_mode': '' | 'strict' | 'cookie_fallback';
  'client.browser_refresh_token_policy': 'disabled' | 'dpop_bound';

  // Authentication Requirements
  'client.default_max_age': number;
  'client.default_acr_values': string;
  'client.require_auth_time': boolean;

  // Request Objects
  'client.request_uris': string;

  // Algorithm Settings (per-client)
  'client.id_token_signing_alg': string;
  'client.id_token_encrypted_response_alg': string;
  'client.id_token_encrypted_response_enc': string;
  'client.userinfo_encrypted_response_alg': string;
  'client.userinfo_encrypted_response_enc': string;
  'client.request_object_signing_alg': string;
  'client.request_object_encryption_alg': string;
  'client.request_object_encryption_enc': string;
  'client.jwt_bearer_signing_alg': string;
  'client.token_endpoint_auth_signing_alg': string;
}

/**
 * Client Settings Metadata
 */
export const CLIENT_SETTINGS_META: Record<keyof ClientSettings, SettingMeta> = {
  'client.access_token_ttl': {
    key: 'client.access_token_ttl',
    type: 'duration',
    default: 3600,
    envKey: 'CLIENT_ACCESS_TOKEN_TTL',
    label: 'Access Token TTL',
    description: 'Client-specific access token lifetime in seconds',
    min: 60,
    max: 86400,
    unit: 'seconds',
    visibility: 'public',
  },
  'client.refresh_token_ttl': {
    key: 'client.refresh_token_ttl',
    type: 'duration',
    default: 7776000,
    envKey: 'CLIENT_REFRESH_TOKEN_TTL',
    label: 'Refresh Token TTL',
    description: 'Client-specific refresh token lifetime in seconds (default: 90 days)',
    min: 3600,
    max: 31536000,
    unit: 'seconds',
    visibility: 'public',
  },
  'client.id_token_ttl': {
    key: 'client.id_token_ttl',
    type: 'duration',
    default: 3600,
    envKey: 'CLIENT_ID_TOKEN_TTL',
    label: 'ID Token TTL',
    description: 'Client-specific ID token lifetime in seconds',
    min: 60,
    max: 86400,
    unit: 'seconds',
    visibility: 'public',
  },
  'client.pkce_required': {
    key: 'client.pkce_required',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_PKCE_REQUIRED',
    label: 'PKCE Required',
    description: 'Require PKCE for this client',
    visibility: 'public',
  },
  'client.par_required': {
    key: 'client.par_required',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_PAR_REQUIRED',
    label: 'PAR Required',
    description: 'Require Pushed Authorization Requests for this client',
    visibility: 'public',
  },
  'client.dpop_required': {
    key: 'client.dpop_required',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_DPOP_REQUIRED',
    label: 'DPoP Required',
    description: 'Require DPoP for this client',
    visibility: 'public',
  },
  'client.app_login_enabled': {
    key: 'client.app_login_enabled',
    type: 'boolean',
    default: false,
    label: 'App Login Enabled',
    description:
      'Allow Login UI direct sign-in to start this first-party OIDC client after authentication.',
    visibility: 'admin',
  },
  'client.sso_enabled': {
    key: 'client.sso_enabled',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_SSO_ENABLED',
    label: 'SSO Enabled',
    description:
      'Enable Single Sign-On for this client. When disabled, users must authenticate even with an existing session.',
    visibility: 'public',
  },
  'client.refresh_token_rotation': {
    key: 'client.refresh_token_rotation',
    type: 'boolean',
    default: true,
    envKey: 'CLIENT_REFRESH_TOKEN_ROTATION',
    label: 'Refresh Token Rotation',
    description: 'Issue new refresh token on use (security best practice)',
    visibility: 'public',
  },
  'client.reuse_refresh_token': {
    key: 'client.reuse_refresh_token',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_REUSE_REFRESH_TOKEN',
    label: 'Reuse Refresh Token',
    description: 'Allow refresh token reuse within grace period',
    visibility: 'admin',
  },
  'client.allow_authorization_code': {
    key: 'client.allow_authorization_code',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_CLIENT_AUTH_CODE',
    label: 'Allow Authorization Code',
    description: 'Enable authorization code grant',
    visibility: 'public',
  },
  'client.allow_client_credentials': {
    key: 'client.allow_client_credentials',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_CREDENTIALS',
    label: 'Allow Client Credentials',
    description: 'Enable client credentials grant',
    visibility: 'public',
  },
  'client.allow_refresh_token': {
    key: 'client.allow_refresh_token',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_CLIENT_REFRESH_TOKEN',
    label: 'Allow Refresh Token',
    description: 'Enable refresh token grant',
    visibility: 'public',
  },
  'client.allow_device_code': {
    key: 'client.allow_device_code',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_DEVICE_CODE',
    label: 'Allow Device Code',
    description: 'Enable device authorization grant',
    visibility: 'public',
  },
  'client.allow_ciba': {
    key: 'client.allow_ciba',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_CIBA',
    label: 'Allow CIBA',
    description: 'Enable CIBA (backchannel authentication)',
    visibility: 'public',
  },
  'client.allow_code_response': {
    key: 'client.allow_code_response',
    type: 'boolean',
    default: true,
    envKey: 'ENABLE_CLIENT_CODE_RESPONSE',
    label: 'Allow Code Response',
    description: 'Enable code response type',
    visibility: 'admin',
  },
  'client.allow_token_response': {
    key: 'client.allow_token_response',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_TOKEN_RESPONSE',
    label: 'Allow Token Response',
    description: 'Enable token response type (implicit flow)',
    visibility: 'admin',
  },
  'client.allow_id_token_response': {
    key: 'client.allow_id_token_response',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_ID_TOKEN_RESPONSE',
    label: 'Allow ID Token Response',
    description: 'Enable id_token response type (implicit flow)',
    visibility: 'admin',
  },
  'client.strict_redirect_matching': {
    key: 'client.strict_redirect_matching',
    type: 'boolean',
    default: true,
    envKey: 'CLIENT_STRICT_REDIRECT_MATCHING',
    label: 'Strict Redirect Matching',
    description: 'Require exact redirect URI matching',
    visibility: 'admin',
  },
  'client.allow_localhost_redirect': {
    key: 'client.allow_localhost_redirect',
    type: 'boolean',
    default: false,
    envKey: 'ENABLE_CLIENT_LOCALHOST_REDIRECT',
    label: 'Allow Localhost Redirect',
    description: 'Allow localhost redirect URIs (development)',
    visibility: 'admin',
  },
  'client.userinfo_signed_response_alg': {
    key: 'client.userinfo_signed_response_alg',
    type: 'enum',
    default: 'none',
    envKey: 'CLIENT_USERINFO_SIGNED_RESPONSE_ALG',
    label: 'UserInfo Signed Response Alg',
    description: 'Algorithm for signed UserInfo responses (none, RS256, ES256)',
    enum: ['none', 'RS256', 'ES256'],
    visibility: 'admin',
  },

  // Authentication Method
  'client.token_endpoint_auth_method': {
    key: 'client.token_endpoint_auth_method',
    type: 'enum',
    default: 'client_secret_basic',
    envKey: 'CLIENT_TOKEN_ENDPOINT_AUTH_METHOD',
    label: 'Token Endpoint Auth Method',
    description: 'Client authentication method for token endpoint',
    enum: ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'],
    visibility: 'public',
  },

  // Grant/Response Types
  'client.grant_types': {
    key: 'client.grant_types',
    type: 'string',
    default: 'authorization_code',
    envKey: 'CLIENT_GRANT_TYPES',
    label: 'Grant Types',
    description:
      'Allowed grant types (comma-separated: authorization_code, refresh_token, client_credentials, etc.)',
    visibility: 'public',
  },
  'client.response_types': {
    key: 'client.response_types',
    type: 'string',
    default: 'code',
    envKey: 'CLIENT_RESPONSE_TYPES',
    label: 'Response Types',
    description: 'Allowed response types (comma-separated: code, token, id_token)',
    visibility: 'public',
  },

  // Subject Type
  'client.subject_type': {
    key: 'client.subject_type',
    type: 'enum',
    default: 'public',
    envKey: 'CLIENT_SUBJECT_TYPE',
    label: 'Subject Type',
    description: 'Subject identifier type for this client',
    enum: ['public', 'pairwise'],
    visibility: 'admin',
  },

  // DPoP & Token Exchange
  'client.dpop_bound_access_tokens': {
    key: 'client.dpop_bound_access_tokens',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_DPOP_BOUND_ACCESS_TOKENS',
    label: 'DPoP Bound Access Tokens',
    description: 'Bind access tokens to DPoP proof',
    visibility: 'admin',
  },
  'client.dpop_mode': {
    key: 'client.dpop_mode',
    type: 'enum',
    default: 'disabled',
    envKey: 'CLIENT_DPOP_MODE',
    label: 'DPoP Mode',
    description:
      'DPoP enforcement mode: disabled (no DPoP), critical_only (token/revoke/introspect only), all (all endpoints)',
    enum: ['disabled', 'critical_only', 'all'],
    visibility: 'public',
  },
  'client.token_exchange_allowed': {
    key: 'client.token_exchange_allowed',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_TOKEN_EXCHANGE_ALLOWED',
    label: 'Token Exchange Allowed',
    description: 'Allow token exchange (RFC 8693) for this client',
    visibility: 'admin',
  },
  'client.delegation_mode': {
    key: 'client.delegation_mode',
    type: 'enum',
    default: 'delegation',
    envKey: 'CLIENT_DELEGATION_MODE',
    label: 'Delegation Mode',
    description: 'Token exchange delegation mode',
    enum: ['delegation', 'impersonation'],
    visibility: 'admin',
  },

  // Logout URIs
  'client.frontchannel_logout_uri': {
    key: 'client.frontchannel_logout_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_FRONTCHANNEL_LOGOUT_URI',
    label: 'Frontchannel Logout URI',
    description: 'URI for frontchannel logout notifications',
    visibility: 'public',
  },
  'client.frontchannel_logout_session_required': {
    key: 'client.frontchannel_logout_session_required',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_FRONTCHANNEL_LOGOUT_SESSION_REQUIRED',
    label: 'Frontchannel Logout Session Required',
    description: 'Require session ID in frontchannel logout',
    visibility: 'admin',
  },
  'client.backchannel_logout_uri': {
    key: 'client.backchannel_logout_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_BACKCHANNEL_LOGOUT_URI',
    label: 'Backchannel Logout URI',
    description: 'URI for backchannel logout notifications',
    visibility: 'public',
  },
  'client.backchannel_logout_session_required': {
    key: 'client.backchannel_logout_session_required',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_BACKCHANNEL_LOGOUT_SESSION_REQUIRED',
    label: 'Backchannel Logout Session Required',
    description: 'Require session ID in backchannel logout token',
    visibility: 'admin',
  },

  // Scopes & Audience
  'client.allowed_scopes': {
    key: 'client.allowed_scopes',
    type: 'string',
    default: '',
    envKey: 'CLIENT_ALLOWED_SCOPES',
    label: 'Allowed Scopes',
    description: 'Scopes allowed for this client (space-separated, empty = all)',
    visibility: 'public',
  },
  'client.default_scope': {
    key: 'client.default_scope',
    type: 'string',
    default: '',
    envKey: 'CLIENT_DEFAULT_SCOPE',
    label: 'Default Scope',
    description: 'Default scopes if none requested (space-separated)',
    visibility: 'public',
  },
  'client.default_audience': {
    key: 'client.default_audience',
    type: 'string',
    default: '',
    envKey: 'CLIENT_DEFAULT_AUDIENCE',
    label: 'Default Audience',
    description: 'Default audience for tokens',
    visibility: 'admin',
  },
  'client.default_resource': {
    key: 'client.default_resource',
    type: 'string',
    default: '',
    envKey: 'CLIENT_DEFAULT_RESOURCE',
    label: 'Default Resource',
    description:
      'Default resource target for access tokens when the token request omits resource/audience.',
    visibility: 'admin',
  },
  'client.allowed_scopes_restriction_enabled': {
    key: 'client.allowed_scopes_restriction_enabled',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_ALLOWED_SCOPES_RESTRICTION_ENABLED',
    label: 'Scope Restriction Enabled',
    description: 'Enable allowed_scopes restriction',
    visibility: 'admin',
  },
  'client.client_credentials_allowed': {
    key: 'client.client_credentials_allowed',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_CLIENT_CREDENTIALS_ALLOWED',
    label: 'Client Credentials Allowed',
    description: 'Allow client credentials grant for machine-to-machine',
    visibility: 'admin',
  },

  // Client Metadata URIs
  'client.logo_uri': {
    key: 'client.logo_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_LOGO_URI',
    label: 'Logo URI',
    description: 'URI for client logo image',
    visibility: 'public',
  },
  'client.contacts': {
    key: 'client.contacts',
    type: 'string',
    default: '',
    envKey: 'CLIENT_CONTACTS',
    label: 'Contacts',
    description: 'Contact email addresses (comma-separated)',
    visibility: 'public',
  },
  'client.tos_uri': {
    key: 'client.tos_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_TOS_URI',
    label: 'Terms of Service URI',
    description: 'URI for terms of service',
    visibility: 'public',
  },
  'client.policy_uri': {
    key: 'client.policy_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_POLICY_URI',
    label: 'Privacy Policy URI',
    description: 'URI for privacy policy',
    visibility: 'public',
  },
  'client.client_uri': {
    key: 'client.client_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_CLIENT_URI',
    label: 'Client URI',
    description: 'URI for client homepage',
    visibility: 'public',
  },
  'client.initiate_login_uri': {
    key: 'client.initiate_login_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_INITIATE_LOGIN_URI',
    label: 'Initiate Login URI',
    description: 'URI to initiate login from RP',
    visibility: 'admin',
  },
  'client.login_ui_url': {
    key: 'client.login_ui_url',
    type: 'string',
    default: '',
    envKey: 'CLIENT_LOGIN_UI_URL',
    label: 'Login UI URL',
    description:
      'Client-specific login UI base URL (overrides global UI_URL). Must use HTTPS except localhost.',
    visibility: 'public',
  },

  // Application Settings
  'client.application_type': {
    key: 'client.application_type',
    type: 'enum',
    default: 'web',
    envKey: 'CLIENT_APPLICATION_TYPE',
    label: 'Application Type',
    description: 'Type of client application',
    enum: ['web', 'native', 'spa'],
    visibility: 'public',
  },
  'client.sector_identifier_uri': {
    key: 'client.sector_identifier_uri',
    type: 'string',
    default: '',
    envKey: 'CLIENT_SECTOR_IDENTIFIER_URI',
    label: 'Sector Identifier URI',
    description: 'URI for pairwise subject identifier calculation',
    visibility: 'admin',
  },
  'client.trust_group': {
    key: 'client.trust_group',
    type: 'string',
    default: '',
    envKey: 'CLIENT_TRUST_GROUP',
    label: 'Trust Group',
    description:
      'Tenant-scoped trust group identifier for explicit cross-client Native SSO opt-in.',
    visibility: 'admin',
  },
  'client.native_sso_enabled': {
    key: 'client.native_sso_enabled',
    type: 'boolean',
    default: true,
    envKey: 'CLIENT_NATIVE_SSO_ENABLED',
    label: 'Native SSO Enabled',
    description:
      'Enable same-client Native SSO for eligible native clients. Set false to explicitly disable.',
    visibility: 'admin',
  },
  'client.native_channel_allowed': {
    key: 'client.native_channel_allowed',
    type: 'boolean',
    default: true,
    envKey: 'CLIENT_NATIVE_CHANNEL_ALLOWED',
    label: 'Native Channel Allowed',
    description: 'Allow native-channel Direct Auth and Native SSO flows for this client.',
    visibility: 'admin',
  },
  'client.allowed_channels': {
    key: 'client.allowed_channels',
    type: 'string',
    default: '',
    envKey: 'CLIENT_ALLOWED_CHANNELS',
    label: 'Allowed Channels',
    description:
      'Optional comma-separated Direct Auth channels. Empty uses the application_type default policy.',
    visibility: 'admin',
  },
  'client.browser_public_client_mode': {
    key: 'client.browser_public_client_mode',
    type: 'enum',
    default: '',
    envKey: 'CLIENT_BROWSER_PUBLIC_CLIENT_MODE',
    label: 'Browser Public Client Mode',
    description:
      'Optional client override for browser public client DPoP/browser-token behavior. Empty uses the server default.',
    enum: ['', 'strict', 'cookie_fallback'],
    visibility: 'admin',
  },
  'client.browser_refresh_token_policy': {
    key: 'client.browser_refresh_token_policy',
    type: 'enum',
    default: 'disabled',
    envKey: 'CLIENT_BROWSER_REFRESH_TOKEN_POLICY',
    label: 'Browser Refresh Token Policy',
    description: 'Refresh token issuance policy for browser public clients.',
    enum: ['disabled', 'dpop_bound'],
    visibility: 'admin',
  },

  // Authentication Requirements
  'client.default_max_age': {
    key: 'client.default_max_age',
    type: 'number',
    default: 0,
    envKey: 'CLIENT_DEFAULT_MAX_AGE',
    label: 'Default Max Age',
    description: 'Default max authentication age in seconds (0 = no limit)',
    min: 0,
    max: 86400,
    unit: 'seconds',
    visibility: 'admin',
  },
  'client.default_acr_values': {
    key: 'client.default_acr_values',
    type: 'string',
    default: '',
    envKey: 'CLIENT_DEFAULT_ACR_VALUES',
    label: 'Default ACR Values',
    description: 'Default authentication context class reference values',
    visibility: 'admin',
  },
  'client.require_auth_time': {
    key: 'client.require_auth_time',
    type: 'boolean',
    default: false,
    envKey: 'CLIENT_REQUIRE_AUTH_TIME',
    label: 'Require Auth Time',
    description: 'Require auth_time claim in ID token',
    visibility: 'admin',
  },

  // Request Objects
  'client.request_uris': {
    key: 'client.request_uris',
    type: 'string',
    default: '',
    envKey: 'CLIENT_REQUEST_URIS',
    label: 'Request URIs',
    description: 'Allowed request_uri values (comma-separated)',
    visibility: 'admin',
  },

  // Algorithm Settings (per-client)
  'client.id_token_signing_alg': {
    key: 'client.id_token_signing_alg',
    type: 'enum',
    default: 'RS256',
    envKey: 'CLIENT_ID_TOKEN_SIGNING_ALG',
    label: 'ID Token Signing Algorithm',
    description: 'Algorithm for signing ID tokens',
    enum: ['RS256', 'ES256'],
    visibility: 'public',
  },
  'client.id_token_encrypted_response_alg': {
    key: 'client.id_token_encrypted_response_alg',
    type: 'enum',
    default: '',
    envKey: 'CLIENT_ID_TOKEN_ENCRYPTED_RESPONSE_ALG',
    label: 'ID Token Encryption Alg',
    description: 'Key encryption algorithm for encrypted ID tokens (empty = no encryption)',
    enum: [
      '',
      'RSA-OAEP',
      'RSA-OAEP-256',
      'A128KW',
      'A192KW',
      'A256KW',
      'ECDH-ES',
      'ECDH-ES+A128KW',
      'ECDH-ES+A256KW',
    ],
    visibility: 'admin',
  },
  'client.id_token_encrypted_response_enc': {
    key: 'client.id_token_encrypted_response_enc',
    type: 'enum',
    default: 'A256GCM',
    envKey: 'CLIENT_ID_TOKEN_ENCRYPTED_RESPONSE_ENC',
    label: 'ID Token Encryption Enc',
    description: 'Content encryption algorithm for encrypted ID tokens',
    enum: ['A128GCM', 'A192GCM', 'A256GCM', 'A128CBC-HS256', 'A256CBC-HS512'],
    visibility: 'admin',
  },
  'client.userinfo_encrypted_response_alg': {
    key: 'client.userinfo_encrypted_response_alg',
    type: 'enum',
    default: '',
    envKey: 'CLIENT_USERINFO_ENCRYPTED_RESPONSE_ALG',
    label: 'UserInfo Encryption Alg',
    description: 'Key encryption algorithm for encrypted UserInfo (empty = no encryption)',
    enum: ['', 'RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES', 'ECDH-ES+A256KW'],
    visibility: 'admin',
  },
  'client.userinfo_encrypted_response_enc': {
    key: 'client.userinfo_encrypted_response_enc',
    type: 'enum',
    default: 'A256GCM',
    envKey: 'CLIENT_USERINFO_ENCRYPTED_RESPONSE_ENC',
    label: 'UserInfo Encryption Enc',
    description: 'Content encryption algorithm for encrypted UserInfo',
    enum: ['A128GCM', 'A256GCM', 'A128CBC-HS256', 'A256CBC-HS512'],
    visibility: 'admin',
  },
  'client.request_object_signing_alg': {
    key: 'client.request_object_signing_alg',
    type: 'enum',
    default: '',
    envKey: 'CLIENT_REQUEST_OBJECT_SIGNING_ALG',
    label: 'Request Object Signing Alg',
    description: 'Required signing algorithm for request objects (JAR)',
    enum: ['', 'RS256', 'ES256', 'PS256', 'EdDSA'],
    visibility: 'admin',
  },
  'client.request_object_encryption_alg': {
    key: 'client.request_object_encryption_alg',
    type: 'enum',
    default: '',
    envKey: 'CLIENT_REQUEST_OBJECT_ENCRYPTION_ALG',
    label: 'Request Object Encryption Alg',
    description: 'Key encryption algorithm for encrypted request objects',
    enum: ['', 'RSA-OAEP', 'RSA-OAEP-256', 'ECDH-ES', 'ECDH-ES+A256KW'],
    visibility: 'admin',
  },
  'client.request_object_encryption_enc': {
    key: 'client.request_object_encryption_enc',
    type: 'enum',
    default: 'A256GCM',
    envKey: 'CLIENT_REQUEST_OBJECT_ENCRYPTION_ENC',
    label: 'Request Object Encryption Enc',
    description: 'Content encryption algorithm for encrypted request objects',
    enum: ['A128GCM', 'A256GCM', 'A128CBC-HS256', 'A256CBC-HS512'],
    visibility: 'admin',
  },
  'client.jwt_bearer_signing_alg': {
    key: 'client.jwt_bearer_signing_alg',
    type: 'enum',
    default: 'RS256',
    envKey: 'CLIENT_JWT_BEARER_SIGNING_ALG',
    label: 'JWT Bearer Signing Alg',
    description: 'Signing algorithm for JWT Bearer assertions',
    enum: ['RS256', 'ES256', 'PS256', 'EdDSA'],
    visibility: 'admin',
  },
  'client.token_endpoint_auth_signing_alg': {
    key: 'client.token_endpoint_auth_signing_alg',
    type: 'enum',
    default: 'RS256',
    envKey: 'CLIENT_TOKEN_ENDPOINT_AUTH_SIGNING_ALG',
    label: 'Token Auth Signing Alg',
    description: 'Signing algorithm for private_key_jwt authentication',
    enum: ['RS256', 'ES256', 'PS256', 'EdDSA'],
    visibility: 'admin',
  },
};

/**
 * Client Category Metadata
 */
export const CLIENT_CATEGORY_META: CategoryMeta = {
  category: 'client',
  label: 'Client Settings',
  description: 'Per-client OAuth configuration',
  settings: CLIENT_SETTINGS_META,
};

/**
 * Default Client settings values
 */
export const CLIENT_DEFAULTS: ClientSettings = {
  'client.access_token_ttl': 3600,
  'client.refresh_token_ttl': 7776000,
  'client.id_token_ttl': 3600,
  'client.pkce_required': false,
  'client.par_required': false,
  'client.dpop_required': false,
  'client.app_login_enabled': false,
  'client.sso_enabled': false,
  'client.refresh_token_rotation': true,
  'client.reuse_refresh_token': false,
  'client.allow_authorization_code': true,
  'client.allow_client_credentials': false,
  'client.allow_refresh_token': true,
  'client.allow_device_code': false,
  'client.allow_ciba': false,
  'client.allow_code_response': true,
  'client.allow_token_response': false,
  'client.allow_id_token_response': false,
  'client.strict_redirect_matching': true,
  'client.allow_localhost_redirect': false,
  'client.userinfo_signed_response_alg': 'none',
  // New settings
  'client.token_endpoint_auth_method': 'client_secret_basic',
  'client.grant_types': 'authorization_code',
  'client.response_types': 'code',
  'client.subject_type': 'public',
  'client.dpop_bound_access_tokens': false,
  'client.dpop_mode': 'disabled',
  'client.token_exchange_allowed': false,
  'client.delegation_mode': 'delegation',
  'client.frontchannel_logout_uri': '',
  'client.frontchannel_logout_session_required': false,
  'client.backchannel_logout_uri': '',
  'client.backchannel_logout_session_required': false,
  'client.allowed_scopes': '',
  'client.default_scope': '',
  'client.default_audience': '',
  'client.default_resource': '',
  'client.allowed_scopes_restriction_enabled': false,
  'client.client_credentials_allowed': false,
  'client.logo_uri': '',
  'client.contacts': '',
  'client.tos_uri': '',
  'client.policy_uri': '',
  'client.client_uri': '',
  'client.initiate_login_uri': '',
  'client.login_ui_url': '',
  'client.application_type': 'web',
  'client.sector_identifier_uri': '',
  'client.trust_group': '',
  'client.native_sso_enabled': true,
  'client.native_channel_allowed': true,
  'client.allowed_channels': '',
  'client.browser_public_client_mode': '',
  'client.browser_refresh_token_policy': 'disabled',
  'client.default_max_age': 0,
  'client.default_acr_values': '',
  'client.require_auth_time': false,
  'client.request_uris': '',
  // Algorithm settings
  'client.id_token_signing_alg': 'RS256',
  'client.id_token_encrypted_response_alg': '',
  'client.id_token_encrypted_response_enc': 'A256GCM',
  'client.userinfo_encrypted_response_alg': '',
  'client.userinfo_encrypted_response_enc': 'A256GCM',
  'client.request_object_signing_alg': '',
  'client.request_object_encryption_alg': '',
  'client.request_object_encryption_enc': 'A256GCM',
  'client.jwt_bearer_signing_alg': 'RS256',
  'client.token_endpoint_auth_signing_alg': 'RS256',
};
