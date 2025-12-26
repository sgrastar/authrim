/**
 * Authrim Error Codes Definition
 *
 * Centralized error code registry for OAuth/OIDC and Authrim-specific errors.
 *
 * Error Code Format:
 * - RFC Standard: snake_case (invalid_request, invalid_grant, etc.)
 * - Authrim: AR + 6 digits (AR000001, AR010001, etc.)
 *
 * Code Ranges:
 * - AR000001 ~ AR009999: AUTH (Authentication)
 * - AR010001 ~ AR019999: TOKEN
 * - AR020001 ~ AR029999: CLIENT
 * - AR030001 ~ AR039999: USER
 * - AR040001 ~ AR049999: SESSION
 * - AR050001 ~ AR059999: POLICY
 * - AR060001 ~ AR069999: ADMIN
 * - AR070001 ~ AR079999: SAML
 * - AR080001 ~ AR089999: VC (Verifiable Credentials)
 * - AR090001 ~ AR099999: BRIDGE (External IdP)
 * - AR100001 ~ AR109999: CONFIG
 * - AR110001 ~ AR119999: RATE (Rate Limiting)
 * - AR120001 ~ AR129999: FLOW (Flow View API)
 * - AR900001 ~ AR999999: INTERNAL (Reserved)
 *
 * @packageDocumentation
 */

import type { ErrorCodeDefinition } from './types';

/**
 * RFC 6749 / OIDC Standard Error Codes
 * These are used as the `error` field in OAuth responses
 */
export const RFC_ERROR_CODES = {
  // OAuth 2.0 (RFC 6749)
  INVALID_REQUEST: 'invalid_request',
  INVALID_CLIENT: 'invalid_client',
  INVALID_GRANT: 'invalid_grant',
  UNAUTHORIZED_CLIENT: 'unauthorized_client',
  UNSUPPORTED_GRANT_TYPE: 'unsupported_grant_type',
  INVALID_SCOPE: 'invalid_scope',
  ACCESS_DENIED: 'access_denied',
  UNSUPPORTED_RESPONSE_TYPE: 'unsupported_response_type',
  SERVER_ERROR: 'server_error',
  TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable',

  // OIDC Core
  INTERACTION_REQUIRED: 'interaction_required',
  LOGIN_REQUIRED: 'login_required',
  ACCOUNT_SELECTION_REQUIRED: 'account_selection_required',
  CONSENT_REQUIRED: 'consent_required',
  INVALID_REQUEST_URI: 'invalid_request_uri',
  INVALID_REQUEST_OBJECT: 'invalid_request_object',
  REQUEST_NOT_SUPPORTED: 'request_not_supported',
  REQUEST_URI_NOT_SUPPORTED: 'request_uri_not_supported',
  REGISTRATION_NOT_SUPPORTED: 'registration_not_supported',

  // Token Errors (RFC 6750)
  INVALID_TOKEN: 'invalid_token',
  INSUFFICIENT_SCOPE: 'insufficient_scope',

  // Device Flow (RFC 8628)
  AUTHORIZATION_PENDING: 'authorization_pending',
  SLOW_DOWN: 'slow_down',
  EXPIRED_TOKEN: 'expired_token',

  // DPoP (RFC 9449)
  INVALID_DPOP_PROOF: 'invalid_dpop_proof',
  USE_DPOP_NONCE: 'use_dpop_nonce',

  // CIBA
  INVALID_BINDING_MESSAGE: 'invalid_binding_message',

  // OpenID4VCI
  ISSUANCE_PENDING: 'issuance_pending',
  UNSUPPORTED_CREDENTIAL_FORMAT: 'unsupported_credential_format',
  INVALID_PROOF: 'invalid_proof',
  INVALID_TRANSACTION_ID: 'invalid_transaction_id',

  // OpenID4VP
  INVALID_PRESENTATION: 'invalid_presentation',

  // Custom (non-RFC but commonly used)
  INVALID_REDIRECT_URI: 'invalid_redirect_uri',
  INVALID_CLIENT_METADATA: 'invalid_client_metadata',
} as const;

export type RFCErrorCode = (typeof RFC_ERROR_CODES)[keyof typeof RFC_ERROR_CODES];

/**
 * Authrim Error Codes
 */
export const AR_ERROR_CODES = {
  // ============================================
  // AUTH: Authentication & Session (AR000001 ~ AR009999)
  // ============================================
  AUTH_SESSION_EXPIRED: 'AR000001',
  AUTH_SESSION_NOT_FOUND: 'AR000002',
  AUTH_LOGIN_REQUIRED: 'AR000003',
  AUTH_MFA_REQUIRED: 'AR000004',
  AUTH_PASSKEY_FAILED: 'AR000005',
  AUTH_INVALID_CODE: 'AR000006',
  AUTH_CODE_EXPIRED: 'AR000007',
  AUTH_PKCE_REQUIRED: 'AR000008',
  AUTH_PKCE_INVALID: 'AR000009',
  AUTH_NONCE_MISMATCH: 'AR000010',
  AUTH_STATE_MISMATCH: 'AR000011',
  AUTH_REDIRECT_URI_MISMATCH: 'AR000012',
  AUTH_PROMPT_NONE_FAILED: 'AR000013',
  AUTH_MAX_AGE_EXCEEDED: 'AR000014',
  AUTH_DID_VERIFICATION_FAILED: 'AR000015',

  // ============================================
  // TOKEN (AR010001 ~ AR019999)
  // ============================================
  TOKEN_INVALID: 'AR010001',
  TOKEN_EXPIRED: 'AR010002',
  TOKEN_REVOKED: 'AR010003',
  TOKEN_REUSE_DETECTED: 'AR010004',
  TOKEN_INVALID_SIGNATURE: 'AR010005',
  TOKEN_INVALID_AUDIENCE: 'AR010006',
  TOKEN_INVALID_ISSUER: 'AR010007',
  TOKEN_DPOP_REQUIRED: 'AR010008',
  TOKEN_DPOP_INVALID: 'AR010009',
  TOKEN_DPOP_NONCE_REQUIRED: 'AR010010',

  // ============================================
  // CLIENT (AR020001 ~ AR029999)
  // ============================================
  CLIENT_AUTH_FAILED: 'AR020001',
  CLIENT_INVALID: 'AR020002',
  CLIENT_REDIRECT_URI_INVALID: 'AR020003',
  CLIENT_METADATA_INVALID: 'AR020004',
  CLIENT_NOT_ALLOWED_GRANT: 'AR020005',
  CLIENT_NOT_ALLOWED_SCOPE: 'AR020006',
  CLIENT_SECRET_EXPIRED: 'AR020007',
  CLIENT_JWKS_INVALID: 'AR020008',

  // ============================================
  // USER (AR030001 ~ AR039999)
  // ============================================
  USER_INVALID_CREDENTIALS: 'AR030001',
  USER_LOCKED: 'AR030002',
  USER_INACTIVE: 'AR030003',
  USER_NOT_FOUND: 'AR030004', // Internal only - masked in response
  USER_EMAIL_NOT_VERIFIED: 'AR030005',
  USER_PHONE_NOT_VERIFIED: 'AR030006',

  // ============================================
  // SESSION (AR040001 ~ AR049999)
  // ============================================
  SESSION_STORE_ERROR: 'AR040001',
  SESSION_INVALID_STATE: 'AR040002',
  SESSION_CONCURRENT_LIMIT: 'AR040003',

  // ============================================
  // POLICY (AR050001 ~ AR059999)
  // ============================================
  POLICY_FEATURE_DISABLED: 'AR050001',
  POLICY_NOT_CONFIGURED: 'AR050002',
  POLICY_INVALID_API_KEY: 'AR050003',
  POLICY_API_KEY_EXPIRED: 'AR050004',
  POLICY_API_KEY_INACTIVE: 'AR050005',
  POLICY_INSUFFICIENT_PERMISSIONS: 'AR050006',
  POLICY_REBAC_DENIED: 'AR050007',
  POLICY_ABAC_DENIED: 'AR050008',

  // ============================================
  // ADMIN (AR060001 ~ AR069999)
  // ============================================
  ADMIN_AUTH_REQUIRED: 'AR060001',
  ADMIN_INSUFFICIENT_PERMISSIONS: 'AR060002',
  ADMIN_INVALID_REQUEST: 'AR060003',
  ADMIN_RESOURCE_NOT_FOUND: 'AR060004',
  ADMIN_CONFLICT: 'AR060005',

  // ============================================
  // SAML (AR070001 ~ AR079999)
  // ============================================
  SAML_INVALID_RESPONSE: 'AR070001',
  SAML_SLO_FAILED: 'AR070002',
  SAML_SIGNATURE_INVALID: 'AR070003',
  SAML_ASSERTION_EXPIRED: 'AR070004',
  SAML_IDP_NOT_CONFIGURED: 'AR070005',

  // ============================================
  // VC - Verifiable Credentials (AR080001 ~ AR089999)
  // ============================================
  VC_ISSUANCE_PENDING: 'AR080001',
  VC_UNSUPPORTED_FORMAT: 'AR080002',
  VC_INVALID_PROOF: 'AR080003',
  VC_CREDENTIAL_REVOKED: 'AR080004',
  VC_STATUS_CHECK_FAILED: 'AR080005',
  VC_DID_RESOLUTION_FAILED: 'AR080006',

  // ============================================
  // BRIDGE - External IdP (AR090001 ~ AR099999)
  // ============================================
  BRIDGE_LINK_REQUIRED: 'AR090001',
  BRIDGE_PROVIDER_AUTH_FAILED: 'AR090002',
  BRIDGE_PROVIDER_UNAVAILABLE: 'AR090003',
  BRIDGE_ACCOUNT_ALREADY_LINKED: 'AR090004',
  BRIDGE_TOKEN_REFRESH_FAILED: 'AR090005',
  BRIDGE_JIT_PROVISIONING_FAILED: 'AR090006',

  // ============================================
  // CONFIG (AR100001 ~ AR109999)
  // ============================================
  CONFIG_KV_NOT_CONFIGURED: 'AR100001',
  CONFIG_INVALID_VALUE: 'AR100002',
  CONFIG_LOAD_ERROR: 'AR100003',
  CONFIG_MISSING_SECRET: 'AR100004',
  CONFIG_DB_NOT_CONFIGURED: 'AR100005',

  // ============================================
  // RATE - Rate Limiting (AR110001 ~ AR119999)
  // ============================================
  RATE_LIMIT_EXCEEDED: 'AR110001',
  RATE_SLOW_DOWN: 'AR110002',
  RATE_TOO_MANY_REQUESTS: 'AR110003',

  // ============================================
  // FLOW - Flow View API (AR120001 ~ AR129999)
  // ============================================
  FLOW_MISSING_CHALLENGE_ID: 'AR120001',
  FLOW_CHALLENGE_NOT_FOUND: 'AR120002',
  FLOW_CHALLENGE_EXPIRED: 'AR120003',
  FLOW_CHALLENGE_CONSUMED: 'AR120004',
  FLOW_INVALID_EVENT: 'AR120005',
  FLOW_INVALID_TRANSITION: 'AR120006',
  FLOW_VALIDATION_FAILED: 'AR120007',
  FLOW_WEBAUTHN_FAILED: 'AR120008',
  FLOW_EXTERNAL_IDP_FAILED: 'AR120009',
  FLOW_CAPABILITY_NOT_FOUND: 'AR120010',

  // ============================================
  // INTERNAL (AR900001 ~ AR999999) - Reserved
  // ============================================
  INTERNAL_ERROR: 'AR900001',
  INTERNAL_DO_ERROR: 'AR900002',
  INTERNAL_QUEUE_ERROR: 'AR900003',
} as const;

export type ARErrorCode = (typeof AR_ERROR_CODES)[keyof typeof AR_ERROR_CODES];

/**
 * Complete error code definitions with metadata
 */
export const ERROR_DEFINITIONS: Record<ARErrorCode, ErrorCodeDefinition> = {
  // ============================================
  // AUTH
  // ============================================
  [AR_ERROR_CODES.AUTH_SESSION_EXPIRED]: {
    code: 'AR000001',
    rfcError: RFC_ERROR_CODES.LOGIN_REQUIRED,
    status: 401,
    typeSlug: 'auth/session-expired',
    titleKey: 'auth.session_expired.title',
    detailKey: 'auth.session_expired.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_SESSION_NOT_FOUND]: {
    code: 'AR000002',
    rfcError: RFC_ERROR_CODES.LOGIN_REQUIRED,
    status: 401,
    typeSlug: 'auth/session-not-found',
    titleKey: 'auth.session_not_found.title',
    detailKey: 'auth.session_not_found.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_LOGIN_REQUIRED]: {
    code: 'AR000003',
    rfcError: RFC_ERROR_CODES.LOGIN_REQUIRED,
    status: 401,
    typeSlug: 'auth/login-required',
    titleKey: 'auth.login_required.title',
    detailKey: 'auth.login_required.detail',
    meta: { retryable: false, user_action: 'login', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_MFA_REQUIRED]: {
    code: 'AR000004',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 401,
    typeSlug: 'auth/mfa-required',
    titleKey: 'auth.mfa_required.title',
    detailKey: 'auth.mfa_required.detail',
    meta: { retryable: false, user_action: 'reauth', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_PASSKEY_FAILED]: {
    code: 'AR000005',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 400,
    typeSlug: 'auth/passkey-failed',
    titleKey: 'auth.passkey_failed.title',
    detailKey: 'auth.passkey_failed.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_INVALID_CODE]: {
    code: 'AR000006',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 400,
    typeSlug: 'auth/invalid-code',
    titleKey: 'auth.invalid_code.title',
    detailKey: 'auth.invalid_code.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_CODE_EXPIRED]: {
    code: 'AR000007',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 400,
    typeSlug: 'auth/code-expired',
    titleKey: 'auth.code_expired.title',
    detailKey: 'auth.code_expired.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_PKCE_REQUIRED]: {
    code: 'AR000008',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'auth/pkce-required',
    titleKey: 'auth.pkce_required.title',
    detailKey: 'auth.pkce_required.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_PKCE_INVALID]: {
    code: 'AR000009',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'auth/pkce-invalid',
    titleKey: 'auth.pkce_invalid.title',
    detailKey: 'auth.pkce_invalid.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.AUTH_NONCE_MISMATCH]: {
    code: 'AR000010',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'auth/nonce-mismatch',
    titleKey: 'auth.nonce_mismatch.title',
    detailKey: 'auth.nonce_mismatch.detail',
    meta: { retryable: false, user_action: 'login', severity: 'error' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.AUTH_STATE_MISMATCH]: {
    code: 'AR000011',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'auth/state-mismatch',
    titleKey: 'auth.state_mismatch.title',
    detailKey: 'auth.state_mismatch.detail',
    meta: { retryable: false, user_action: 'login', severity: 'error' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.AUTH_REDIRECT_URI_MISMATCH]: {
    code: 'AR000012',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'auth/redirect-uri-mismatch',
    titleKey: 'auth.redirect_uri_mismatch.title',
    detailKey: 'auth.redirect_uri_mismatch.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_PROMPT_NONE_FAILED]: {
    code: 'AR000013',
    rfcError: RFC_ERROR_CODES.LOGIN_REQUIRED,
    status: 400,
    typeSlug: 'auth/prompt-none-failed',
    titleKey: 'auth.prompt_none_failed.title',
    detailKey: 'auth.prompt_none_failed.detail',
    meta: { retryable: false, user_action: 'login', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_MAX_AGE_EXCEEDED]: {
    code: 'AR000014',
    rfcError: RFC_ERROR_CODES.LOGIN_REQUIRED,
    status: 400,
    typeSlug: 'auth/max-age-exceeded',
    titleKey: 'auth.max_age_exceeded.title',
    detailKey: 'auth.max_age_exceeded.detail',
    meta: { retryable: false, user_action: 'login', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.AUTH_DID_VERIFICATION_FAILED]: {
    code: 'AR000015',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'auth/did-verification-failed',
    titleKey: 'auth.did_verification_failed.title',
    detailKey: 'auth.did_verification_failed.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },

  // ============================================
  // TOKEN
  // ============================================
  [AR_ERROR_CODES.TOKEN_INVALID]: {
    code: 'AR010001',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'token/invalid',
    titleKey: 'token.invalid.title',
    detailKey: 'token.invalid.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.TOKEN_EXPIRED]: {
    code: 'AR010002',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'token/expired',
    titleKey: 'token.expired.title',
    detailKey: 'token.expired.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.TOKEN_REVOKED]: {
    code: 'AR010003',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'token/revoked',
    titleKey: 'token.revoked.title',
    detailKey: 'token.revoked.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.TOKEN_REUSE_DETECTED]: {
    code: 'AR010004',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'token/reuse-detected',
    titleKey: 'token.reuse_detected.title',
    detailKey: 'token.reuse_detected.detail',
    meta: { retryable: false, user_action: 'login', severity: 'critical' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.TOKEN_INVALID_SIGNATURE]: {
    code: 'AR010005',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 401,
    typeSlug: 'token/invalid-signature',
    titleKey: 'token.invalid_signature.title',
    detailKey: 'token.invalid_signature.detail',
    meta: { retryable: false, user_action: 'login', severity: 'error' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.TOKEN_INVALID_AUDIENCE]: {
    code: 'AR010006',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 401,
    typeSlug: 'token/invalid-audience',
    titleKey: 'token.invalid_audience.title',
    detailKey: 'token.invalid_audience.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.TOKEN_INVALID_ISSUER]: {
    code: 'AR010007',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 401,
    typeSlug: 'token/invalid-issuer',
    titleKey: 'token.invalid_issuer.title',
    detailKey: 'token.invalid_issuer.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.TOKEN_DPOP_REQUIRED]: {
    code: 'AR010008',
    rfcError: RFC_ERROR_CODES.INVALID_DPOP_PROOF,
    status: 400,
    typeSlug: 'token/dpop-required',
    titleKey: 'token.dpop_required.title',
    detailKey: 'token.dpop_required.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.TOKEN_DPOP_INVALID]: {
    code: 'AR010009',
    rfcError: RFC_ERROR_CODES.INVALID_DPOP_PROOF,
    status: 400,
    typeSlug: 'token/dpop-invalid',
    titleKey: 'token.dpop_invalid.title',
    detailKey: 'token.dpop_invalid.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.TOKEN_DPOP_NONCE_REQUIRED]: {
    code: 'AR010010',
    rfcError: RFC_ERROR_CODES.USE_DPOP_NONCE,
    status: 400,
    typeSlug: 'token/dpop-nonce-required',
    titleKey: 'token.dpop_nonce_required.title',
    detailKey: 'token.dpop_nonce_required.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'info' },
    securityLevel: 'public',
  },

  // ============================================
  // CLIENT
  // ============================================
  [AR_ERROR_CODES.CLIENT_AUTH_FAILED]: {
    code: 'AR020001',
    rfcError: RFC_ERROR_CODES.INVALID_CLIENT,
    status: 401,
    typeSlug: 'client/authentication-failed',
    titleKey: 'client.auth_failed.title',
    detailKey: 'client.auth_failed.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.CLIENT_INVALID]: {
    code: 'AR020002',
    rfcError: RFC_ERROR_CODES.INVALID_CLIENT,
    status: 401, // RFC 6749: invalid_client requires 401
    typeSlug: 'client/invalid',
    titleKey: 'client.invalid.title',
    detailKey: 'client.invalid.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'error' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.CLIENT_REDIRECT_URI_INVALID]: {
    code: 'AR020003',
    rfcError: RFC_ERROR_CODES.INVALID_REDIRECT_URI,
    status: 400,
    typeSlug: 'client/invalid-redirect-uri',
    titleKey: 'client.redirect_uri_invalid.title',
    detailKey: 'client.redirect_uri_invalid.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.CLIENT_METADATA_INVALID]: {
    code: 'AR020004',
    rfcError: RFC_ERROR_CODES.INVALID_CLIENT_METADATA,
    status: 400,
    typeSlug: 'client/invalid-metadata',
    titleKey: 'client.metadata_invalid.title',
    detailKey: 'client.metadata_invalid.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.CLIENT_NOT_ALLOWED_GRANT]: {
    code: 'AR020005',
    rfcError: RFC_ERROR_CODES.UNAUTHORIZED_CLIENT,
    status: 400,
    typeSlug: 'client/not-allowed-grant',
    titleKey: 'client.not_allowed_grant.title',
    detailKey: 'client.not_allowed_grant.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.CLIENT_NOT_ALLOWED_SCOPE]: {
    code: 'AR020006',
    rfcError: RFC_ERROR_CODES.INVALID_SCOPE,
    status: 400,
    typeSlug: 'client/not-allowed-scope',
    titleKey: 'client.not_allowed_scope.title',
    detailKey: 'client.not_allowed_scope.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.CLIENT_SECRET_EXPIRED]: {
    code: 'AR020007',
    rfcError: RFC_ERROR_CODES.INVALID_CLIENT,
    status: 401,
    typeSlug: 'client/secret-expired',
    titleKey: 'client.secret_expired.title',
    detailKey: 'client.secret_expired.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.CLIENT_JWKS_INVALID]: {
    code: 'AR020008',
    rfcError: RFC_ERROR_CODES.INVALID_CLIENT,
    status: 400,
    typeSlug: 'client/jwks-invalid',
    titleKey: 'client.jwks_invalid.title',
    detailKey: 'client.jwks_invalid.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },

  // ============================================
  // USER
  // ============================================
  [AR_ERROR_CODES.USER_INVALID_CREDENTIALS]: {
    code: 'AR030001',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'user/invalid-credentials',
    titleKey: 'user.invalid_credentials.title',
    detailKey: 'user.invalid_credentials.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.USER_LOCKED]: {
    code: 'AR030002',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'user/locked',
    titleKey: 'user.locked.title',
    detailKey: 'user.locked.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.USER_INACTIVE]: {
    code: 'AR030003',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'user/inactive',
    titleKey: 'user.inactive.title',
    detailKey: 'user.inactive.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.USER_NOT_FOUND]: {
    code: 'AR030004',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'user/not-found',
    titleKey: 'user.not_found.title',
    detailKey: 'user.not_found.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'internal', // Never expose to prevent enumeration
  },
  [AR_ERROR_CODES.USER_EMAIL_NOT_VERIFIED]: {
    code: 'AR030005',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 400,
    typeSlug: 'user/email-not-verified',
    titleKey: 'user.email_not_verified.title',
    detailKey: 'user.email_not_verified.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.USER_PHONE_NOT_VERIFIED]: {
    code: 'AR030006',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 400,
    typeSlug: 'user/phone-not-verified',
    titleKey: 'user.phone_not_verified.title',
    detailKey: 'user.phone_not_verified.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'info' },
    securityLevel: 'public',
  },

  // ============================================
  // SESSION
  // ============================================
  [AR_ERROR_CODES.SESSION_STORE_ERROR]: {
    code: 'AR040001',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'session/store-error',
    titleKey: 'session.store_error.title',
    detailKey: 'session.store_error.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.SESSION_INVALID_STATE]: {
    code: 'AR040002',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'session/invalid-state',
    titleKey: 'session.invalid_state.title',
    detailKey: 'session.invalid_state.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.SESSION_CONCURRENT_LIMIT]: {
    code: 'AR040003',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'session/concurrent-limit',
    titleKey: 'session.concurrent_limit.title',
    detailKey: 'session.concurrent_limit.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },

  // ============================================
  // POLICY
  // ============================================
  [AR_ERROR_CODES.POLICY_FEATURE_DISABLED]: {
    code: 'AR050001',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'policy/feature-disabled',
    titleKey: 'policy.feature_disabled.title',
    detailKey: 'policy.feature_disabled.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.POLICY_NOT_CONFIGURED]: {
    code: 'AR050002',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'policy/not-configured',
    titleKey: 'policy.not_configured.title',
    detailKey: 'policy.not_configured.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'error' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.POLICY_INVALID_API_KEY]: {
    code: 'AR050003',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 401,
    typeSlug: 'policy/invalid-api-key',
    titleKey: 'policy.invalid_api_key.title',
    detailKey: 'policy.invalid_api_key.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'masked',
  },
  [AR_ERROR_CODES.POLICY_API_KEY_EXPIRED]: {
    code: 'AR050004',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 401,
    typeSlug: 'policy/api-key-expired',
    titleKey: 'policy.api_key_expired.title',
    detailKey: 'policy.api_key_expired.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.POLICY_API_KEY_INACTIVE]: {
    code: 'AR050005',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 401,
    typeSlug: 'policy/api-key-inactive',
    titleKey: 'policy.api_key_inactive.title',
    detailKey: 'policy.api_key_inactive.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.POLICY_INSUFFICIENT_PERMISSIONS]: {
    code: 'AR050006',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'policy/insufficient-permissions',
    titleKey: 'policy.insufficient_permissions.title',
    detailKey: 'policy.insufficient_permissions.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.POLICY_REBAC_DENIED]: {
    code: 'AR050007',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'policy/rebac-denied',
    titleKey: 'policy.rebac_denied.title',
    detailKey: 'policy.rebac_denied.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.POLICY_ABAC_DENIED]: {
    code: 'AR050008',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'policy/abac-denied',
    titleKey: 'policy.abac_denied.title',
    detailKey: 'policy.abac_denied.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'info' },
    securityLevel: 'public',
  },

  // ============================================
  // ADMIN
  // ============================================
  [AR_ERROR_CODES.ADMIN_AUTH_REQUIRED]: {
    code: 'AR060001',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 401,
    typeSlug: 'admin/authentication-required',
    titleKey: 'admin.auth_required.title',
    detailKey: 'admin.auth_required.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS]: {
    code: 'AR060002',
    rfcError: RFC_ERROR_CODES.ACCESS_DENIED,
    status: 403,
    typeSlug: 'admin/insufficient-permissions',
    titleKey: 'admin.insufficient_permissions.title',
    detailKey: 'admin.insufficient_permissions.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.ADMIN_INVALID_REQUEST]: {
    code: 'AR060003',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'admin/invalid-request',
    titleKey: 'admin.invalid_request.title',
    detailKey: 'admin.invalid_request.detail',
    meta: { retryable: false, user_action: 'none', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND]: {
    code: 'AR060004',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 404,
    typeSlug: 'admin/resource-not-found',
    titleKey: 'admin.resource_not_found.title',
    detailKey: 'admin.resource_not_found.detail',
    meta: { retryable: false, user_action: 'none', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.ADMIN_CONFLICT]: {
    code: 'AR060005',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 409,
    typeSlug: 'admin/conflict',
    titleKey: 'admin.conflict.title',
    detailKey: 'admin.conflict.detail',
    meta: { retryable: false, user_action: 'none', severity: 'warn' },
    securityLevel: 'public',
  },

  // ============================================
  // SAML
  // ============================================
  [AR_ERROR_CODES.SAML_INVALID_RESPONSE]: {
    code: 'AR070001',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'saml/invalid-response',
    titleKey: 'saml.invalid_response.title',
    detailKey: 'saml.invalid_response.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.SAML_SLO_FAILED]: {
    code: 'AR070002',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'saml/slo-failed',
    titleKey: 'saml.slo_failed.title',
    detailKey: 'saml.slo_failed.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.SAML_SIGNATURE_INVALID]: {
    code: 'AR070003',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'saml/signature-invalid',
    titleKey: 'saml.signature_invalid.title',
    detailKey: 'saml.signature_invalid.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.SAML_ASSERTION_EXPIRED]: {
    code: 'AR070004',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'saml/assertion-expired',
    titleKey: 'saml.assertion_expired.title',
    detailKey: 'saml.assertion_expired.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.SAML_IDP_NOT_CONFIGURED]: {
    code: 'AR070005',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'saml/idp-not-configured',
    titleKey: 'saml.idp_not_configured.title',
    detailKey: 'saml.idp_not_configured.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'error' },
    securityLevel: 'internal',
  },

  // ============================================
  // VC - Verifiable Credentials
  // ============================================
  [AR_ERROR_CODES.VC_ISSUANCE_PENDING]: {
    code: 'AR080001',
    rfcError: RFC_ERROR_CODES.ISSUANCE_PENDING,
    status: 200,
    typeSlug: 'vc/issuance-pending',
    titleKey: 'vc.issuance_pending.title',
    detailKey: 'vc.issuance_pending.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.VC_UNSUPPORTED_FORMAT]: {
    code: 'AR080002',
    rfcError: RFC_ERROR_CODES.UNSUPPORTED_CREDENTIAL_FORMAT,
    status: 400,
    typeSlug: 'vc/unsupported-format',
    titleKey: 'vc.unsupported_format.title',
    detailKey: 'vc.unsupported_format.detail',
    meta: { retryable: false, user_action: 'update_client', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.VC_INVALID_PROOF]: {
    code: 'AR080003',
    rfcError: RFC_ERROR_CODES.INVALID_PROOF,
    status: 400,
    typeSlug: 'vc/invalid-proof',
    titleKey: 'vc.invalid_proof.title',
    detailKey: 'vc.invalid_proof.detail',
    meta: { retryable: false, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.VC_CREDENTIAL_REVOKED]: {
    code: 'AR080004',
    rfcError: RFC_ERROR_CODES.INVALID_TOKEN,
    status: 400,
    typeSlug: 'vc/credential-revoked',
    titleKey: 'vc.credential_revoked.title',
    detailKey: 'vc.credential_revoked.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.VC_STATUS_CHECK_FAILED]: {
    code: 'AR080005',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'vc/status-check-failed',
    titleKey: 'vc.status_check_failed.title',
    detailKey: 'vc.status_check_failed.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.VC_DID_RESOLUTION_FAILED]: {
    code: 'AR080006',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'vc/did-resolution-failed',
    titleKey: 'vc.did_resolution_failed.title',
    detailKey: 'vc.did_resolution_failed.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'public',
  },

  // ============================================
  // BRIDGE - External IdP
  // ============================================
  [AR_ERROR_CODES.BRIDGE_LINK_REQUIRED]: {
    code: 'AR090001',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 400,
    typeSlug: 'bridge/link-required',
    titleKey: 'bridge.link_required.title',
    detailKey: 'bridge.link_required.detail',
    meta: { retryable: false, user_action: 'login', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.BRIDGE_PROVIDER_AUTH_FAILED]: {
    code: 'AR090002',
    rfcError: RFC_ERROR_CODES.INTERACTION_REQUIRED,
    status: 400,
    typeSlug: 'bridge/provider-auth-failed',
    titleKey: 'bridge.provider_auth_failed.title',
    detailKey: 'bridge.provider_auth_failed.detail',
    meta: { retryable: false, transient: true, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.BRIDGE_PROVIDER_UNAVAILABLE]: {
    code: 'AR090003',
    rfcError: RFC_ERROR_CODES.TEMPORARILY_UNAVAILABLE,
    status: 503,
    typeSlug: 'bridge/provider-unavailable',
    titleKey: 'bridge.provider_unavailable.title',
    detailKey: 'bridge.provider_unavailable.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.BRIDGE_ACCOUNT_ALREADY_LINKED]: {
    code: 'AR090004',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'bridge/account-already-linked',
    titleKey: 'bridge.account_already_linked.title',
    detailKey: 'bridge.account_already_linked.detail',
    meta: { retryable: false, user_action: 'none', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.BRIDGE_TOKEN_REFRESH_FAILED]: {
    code: 'AR090005',
    rfcError: RFC_ERROR_CODES.INVALID_GRANT,
    status: 400,
    typeSlug: 'bridge/token-refresh-failed',
    titleKey: 'bridge.token_refresh_failed.title',
    detailKey: 'bridge.token_refresh_failed.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.BRIDGE_JIT_PROVISIONING_FAILED]: {
    code: 'AR090006',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'bridge/jit-provisioning-failed',
    titleKey: 'bridge.jit_provisioning_failed.title',
    detailKey: 'bridge.jit_provisioning_failed.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'internal',
  },

  // ============================================
  // CONFIG
  // ============================================
  [AR_ERROR_CODES.CONFIG_KV_NOT_CONFIGURED]: {
    code: 'AR100001',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'config/kv-not-configured',
    titleKey: 'config.kv_not_configured.title',
    detailKey: 'config.kv_not_configured.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'critical' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.CONFIG_INVALID_VALUE]: {
    code: 'AR100002',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'config/invalid-value',
    titleKey: 'config.invalid_value.title',
    detailKey: 'config.invalid_value.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'error' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.CONFIG_LOAD_ERROR]: {
    code: 'AR100003',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'config/load-error',
    titleKey: 'config.load_error.title',
    detailKey: 'config.load_error.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.CONFIG_MISSING_SECRET]: {
    code: 'AR100004',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'config/missing-secret',
    titleKey: 'config.missing_secret.title',
    detailKey: 'config.missing_secret.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'critical' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.CONFIG_DB_NOT_CONFIGURED]: {
    code: 'AR100005',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'config/db-not-configured',
    titleKey: 'config.db_not_configured.title',
    detailKey: 'config.db_not_configured.detail',
    meta: { retryable: false, user_action: 'contact_admin', severity: 'critical' },
    securityLevel: 'internal',
  },

  // ============================================
  // RATE - Rate Limiting
  // ============================================
  [AR_ERROR_CODES.RATE_LIMIT_EXCEEDED]: {
    code: 'AR110001',
    rfcError: RFC_ERROR_CODES.SLOW_DOWN,
    status: 429,
    typeSlug: 'rate-limit/exceeded',
    titleKey: 'rate.limit_exceeded.title',
    detailKey: 'rate.limit_exceeded.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.RATE_SLOW_DOWN]: {
    code: 'AR110002',
    rfcError: RFC_ERROR_CODES.SLOW_DOWN,
    status: 400,
    typeSlug: 'rate-limit/slow-down',
    titleKey: 'rate.slow_down.title',
    detailKey: 'rate.slow_down.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.RATE_TOO_MANY_REQUESTS]: {
    code: 'AR110003',
    rfcError: RFC_ERROR_CODES.SLOW_DOWN,
    status: 429,
    typeSlug: 'rate-limit/too-many-requests',
    titleKey: 'rate.too_many_requests.title',
    detailKey: 'rate.too_many_requests.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },

  // ============================================
  // FLOW - Flow View API
  // ============================================
  [AR_ERROR_CODES.FLOW_MISSING_CHALLENGE_ID]: {
    code: 'AR120001',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'flow/missing-challenge-id',
    titleKey: 'flow.missing_challenge_id.title',
    detailKey: 'flow.missing_challenge_id.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_CHALLENGE_NOT_FOUND]: {
    code: 'AR120002',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 404,
    typeSlug: 'flow/challenge-not-found',
    titleKey: 'flow.challenge_not_found.title',
    detailKey: 'flow.challenge_not_found.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_CHALLENGE_EXPIRED]: {
    code: 'AR120003',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 410,
    typeSlug: 'flow/challenge-expired',
    titleKey: 'flow.challenge_expired.title',
    detailKey: 'flow.challenge_expired.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_CHALLENGE_CONSUMED]: {
    code: 'AR120004',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 410,
    typeSlug: 'flow/challenge-consumed',
    titleKey: 'flow.challenge_consumed.title',
    detailKey: 'flow.challenge_consumed.detail',
    meta: { retryable: false, user_action: 'login', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_INVALID_EVENT]: {
    code: 'AR120005',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'flow/invalid-event',
    titleKey: 'flow.invalid_event.title',
    detailKey: 'flow.invalid_event.detail',
    meta: { retryable: false, user_action: 'none', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_INVALID_TRANSITION]: {
    code: 'AR120006',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'flow/invalid-transition',
    titleKey: 'flow.invalid_transition.title',
    detailKey: 'flow.invalid_transition.detail',
    meta: { retryable: false, user_action: 'none', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_VALIDATION_FAILED]: {
    code: 'AR120007',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 422,
    typeSlug: 'flow/validation-failed',
    titleKey: 'flow.validation_failed.title',
    detailKey: 'flow.validation_failed.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'info' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_WEBAUTHN_FAILED]: {
    code: 'AR120008',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'flow/webauthn-failed',
    titleKey: 'flow.webauthn_failed.title',
    detailKey: 'flow.webauthn_failed.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_EXTERNAL_IDP_FAILED]: {
    code: 'AR120009',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 400,
    typeSlug: 'flow/external-idp-failed',
    titleKey: 'flow.external_idp_failed.title',
    detailKey: 'flow.external_idp_failed.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'warn' },
    securityLevel: 'public',
  },
  [AR_ERROR_CODES.FLOW_CAPABILITY_NOT_FOUND]: {
    code: 'AR120010',
    rfcError: RFC_ERROR_CODES.INVALID_REQUEST,
    status: 404,
    typeSlug: 'flow/capability-not-found',
    titleKey: 'flow.capability_not_found.title',
    detailKey: 'flow.capability_not_found.detail',
    meta: { retryable: false, user_action: 'none', severity: 'warn' },
    securityLevel: 'public',
  },

  // ============================================
  // INTERNAL
  // ============================================
  [AR_ERROR_CODES.INTERNAL_ERROR]: {
    code: 'AR900001',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'internal/error',
    titleKey: 'internal.error.title',
    detailKey: 'internal.error.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.INTERNAL_DO_ERROR]: {
    code: 'AR900002',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'internal/do-error',
    titleKey: 'internal.do_error.title',
    detailKey: 'internal.do_error.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'internal',
  },
  [AR_ERROR_CODES.INTERNAL_QUEUE_ERROR]: {
    code: 'AR900003',
    rfcError: RFC_ERROR_CODES.SERVER_ERROR,
    status: 500,
    typeSlug: 'internal/queue-error',
    titleKey: 'internal.queue_error.title',
    detailKey: 'internal.queue_error.detail',
    meta: { retryable: true, user_action: 'retry', severity: 'error' },
    securityLevel: 'internal',
  },
};

/**
 * Get error definition by AR code
 */
export function getErrorDefinition(code: ARErrorCode): ErrorCodeDefinition | undefined {
  return ERROR_DEFINITIONS[code];
}

/**
 * Get error definition by type slug
 */
export function getErrorDefinitionBySlug(slug: string): ErrorCodeDefinition | undefined {
  return Object.values(ERROR_DEFINITIONS).find((def) => def.typeSlug === slug);
}
