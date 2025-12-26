/**
 * English Error Messages
 *
 * Message format: Supports {placeholder} for dynamic values
 *
 * @packageDocumentation
 */

import type { ErrorMessages } from '../types';

export const errorMessagesEn: ErrorMessages = {
  // ============================================
  // RFC Standard Errors
  // ============================================
  invalid_request: 'The request is missing a required parameter or is otherwise malformed',
  invalid_client: 'Client authentication failed',
  invalid_grant: 'The provided authorization grant is invalid, expired, or revoked',
  unauthorized_client: 'The client is not authorized to use this authorization grant type',
  unsupported_grant_type: 'The authorization grant type is not supported',
  invalid_scope: 'The requested scope is invalid, unknown, or malformed',
  access_denied: 'Access denied',
  unsupported_response_type: 'The authorization server does not support this response type',
  server_error: 'An unexpected error occurred',
  temporarily_unavailable: 'The service is temporarily unavailable',
  interaction_required: 'User interaction is required',
  login_required: 'Authentication is required',
  account_selection_required: 'Account selection is required',
  consent_required: 'User consent is required',
  invalid_request_uri: 'The request_uri is invalid',
  invalid_request_object: 'The request object is invalid',
  request_not_supported: 'The request parameter is not supported',
  request_uri_not_supported: 'The request_uri parameter is not supported',
  registration_not_supported: 'Dynamic client registration is not supported',
  invalid_token: 'The access token is invalid',
  insufficient_scope: 'Insufficient scope for this request',
  authorization_pending: 'Authorization is pending',
  slow_down: 'Please slow down your request rate',
  expired_token: 'The token has expired',
  invalid_dpop_proof: 'Invalid DPoP proof',
  use_dpop_nonce: 'A DPoP nonce is required',
  invalid_binding_message: 'Invalid binding message',
  issuance_pending: 'Credential issuance is pending',
  unsupported_credential_format: 'The credential format is not supported',
  invalid_proof: 'Invalid proof',
  invalid_redirect_uri: 'Invalid redirect URI',
  invalid_client_metadata: 'Invalid client metadata',

  // ============================================
  // AUTH
  // ============================================
  'auth.session_expired.title': 'Session Expired',
  'auth.session_expired.detail': 'Your authentication session has expired. Please log in again.',
  'auth.session_not_found.title': 'Session Not Found',
  'auth.session_not_found.detail': 'The session could not be found. Please log in again.',
  'auth.login_required.title': 'Login Required',
  'auth.login_required.detail': 'Authentication is required to access this resource.',
  'auth.mfa_required.title': 'MFA Required',
  'auth.mfa_required.detail': 'Multi-factor authentication verification is required.',
  'auth.passkey_failed.title': 'Passkey Authentication Failed',
  'auth.passkey_failed.detail': 'Passkey authentication failed. Please try again.',
  'auth.invalid_code.title': 'Invalid Code',
  'auth.invalid_code.detail': 'The verification code is invalid. Please enter a valid code.',
  'auth.code_expired.title': 'Code Expired',
  'auth.code_expired.detail': 'The verification code has expired. Please request a new code.',
  'auth.pkce_required.title': 'PKCE Required',
  'auth.pkce_required.detail': 'PKCE (code_challenge) is required for this request.',
  'auth.pkce_invalid.title': 'Invalid PKCE',
  'auth.pkce_invalid.detail': 'The PKCE code_verifier is invalid.',
  'auth.nonce_mismatch.title': 'Nonce Mismatch',
  'auth.nonce_mismatch.detail': 'The nonce does not match.',
  'auth.state_mismatch.title': 'State Mismatch',
  'auth.state_mismatch.detail': 'The state parameter does not match.',
  'auth.redirect_uri_mismatch.title': 'Redirect URI Mismatch',
  'auth.redirect_uri_mismatch.detail': 'The redirect_uri does not match the registered value.',
  'auth.prompt_none_failed.title': 'Silent Authentication Failed',
  'auth.prompt_none_failed.detail': 'Silent authentication failed. User interaction is required.',
  'auth.max_age_exceeded.title': 'Authentication Timeout',
  'auth.max_age_exceeded.detail':
    'The authentication age exceeds the max_age requirement. Please log in again.',
  'auth.did_verification_failed.title': 'DID Verification Failed',
  'auth.did_verification_failed.detail': 'DID signature verification failed.',

  // ============================================
  // TOKEN
  // ============================================
  'token.invalid.title': 'Invalid Token',
  'token.invalid.detail': 'The token is invalid or malformed.',
  'token.expired.title': 'Token Expired',
  'token.expired.detail': 'The token has expired.',
  'token.revoked.title': 'Token Revoked',
  'token.revoked.detail': 'The token has been revoked.',
  'token.reuse_detected.title': 'Token Reuse Detected',
  'token.reuse_detected.detail':
    'Refresh token reuse has been detected. All tokens have been revoked for security.',
  'token.invalid_signature.title': 'Invalid Signature',
  'token.invalid_signature.detail': 'The token signature is invalid.',
  'token.invalid_audience.title': 'Invalid Audience',
  'token.invalid_audience.detail': 'The token audience does not match.',
  'token.invalid_issuer.title': 'Invalid Issuer',
  'token.invalid_issuer.detail': 'The token issuer does not match.',
  'token.dpop_required.title': 'DPoP Required',
  'token.dpop_required.detail': 'A DPoP proof is required for this request.',
  'token.dpop_invalid.title': 'Invalid DPoP',
  'token.dpop_invalid.detail': 'The DPoP proof is invalid.',
  'token.dpop_nonce_required.title': 'DPoP Nonce Required',
  'token.dpop_nonce_required.detail':
    'A DPoP nonce is required. Please retry with the provided nonce.',

  // ============================================
  // CLIENT
  // ============================================
  'client.auth_failed.title': 'Client Authentication Failed',
  'client.auth_failed.detail': 'Client authentication failed.',
  'client.invalid.title': 'Invalid Client',
  'client.invalid.detail': 'The client is invalid or not registered.',
  'client.redirect_uri_invalid.title': 'Invalid Redirect URI',
  'client.redirect_uri_invalid.detail': 'The redirect URI is not registered for this client.',
  'client.metadata_invalid.title': 'Invalid Client Metadata',
  'client.metadata_invalid.detail': 'The client metadata is invalid.',
  'client.not_allowed_grant.title': 'Grant Type Not Allowed',
  'client.not_allowed_grant.detail': 'The client is not authorized to use this grant type.',
  'client.not_allowed_scope.title': 'Scope Not Allowed',
  'client.not_allowed_scope.detail': 'The client is not authorized to request this scope.',
  'client.secret_expired.title': 'Client Secret Expired',
  'client.secret_expired.detail': 'The client secret has expired.',
  'client.jwks_invalid.title': 'Invalid JWKS',
  'client.jwks_invalid.detail': 'The client JWKS is invalid or could not be retrieved.',

  // ============================================
  // USER
  // ============================================
  'user.invalid_credentials.title': 'Invalid Credentials',
  'user.invalid_credentials.detail': 'The provided credentials are invalid.',
  'user.locked.title': 'Account Locked',
  'user.locked.detail': 'This account has been locked. Please contact the administrator.',
  'user.inactive.title': 'Account Inactive',
  'user.inactive.detail': 'This account is inactive. Please contact the administrator.',
  'user.not_found.title': 'Invalid Credentials',
  'user.not_found.detail': 'The provided credentials are invalid.',
  'user.email_not_verified.title': 'Email Not Verified',
  'user.email_not_verified.detail': 'Please verify your email address before continuing.',
  'user.phone_not_verified.title': 'Phone Not Verified',
  'user.phone_not_verified.detail': 'Please verify your phone number before continuing.',

  // ============================================
  // SESSION
  // ============================================
  'session.store_error.title': 'Session Error',
  'session.store_error.detail': 'An error occurred while accessing the session store.',
  'session.invalid_state.title': 'Invalid Session State',
  'session.invalid_state.detail': 'The session state is invalid.',
  'session.concurrent_limit.title': 'Concurrent Session Limit',
  'session.concurrent_limit.detail': 'You have reached the maximum number of concurrent sessions.',

  // ============================================
  // POLICY
  // ============================================
  'policy.feature_disabled.title': 'Feature Disabled',
  'policy.feature_disabled.detail': 'This feature is currently disabled.',
  'policy.not_configured.title': 'Policy Not Configured',
  'policy.not_configured.detail': 'The policy service is not configured.',
  'policy.invalid_api_key.title': 'Invalid API Key',
  'policy.invalid_api_key.detail': 'The API key is invalid.',
  'policy.api_key_expired.title': 'API Key Expired',
  'policy.api_key_expired.detail': 'The API key has expired.',
  'policy.api_key_inactive.title': 'API Key Inactive',
  'policy.api_key_inactive.detail': 'The API key is inactive.',
  'policy.insufficient_permissions.title': 'Insufficient Permissions',
  'policy.insufficient_permissions.detail':
    'You do not have sufficient permissions for this operation.',
  'policy.rebac_denied.title': 'Access Denied',
  'policy.rebac_denied.detail': 'Access denied by relationship-based access control.',
  'policy.abac_denied.title': 'Access Denied',
  'policy.abac_denied.detail': 'Access denied by attribute-based access control.',

  // ============================================
  // ADMIN
  // ============================================
  'admin.auth_required.title': 'Admin Authentication Required',
  'admin.auth_required.detail': 'Administrator authentication is required.',
  'admin.insufficient_permissions.title': 'Insufficient Admin Permissions',
  'admin.insufficient_permissions.detail': 'You do not have sufficient administrator permissions.',
  'admin.invalid_request.title': 'Invalid Request',
  'admin.invalid_request.detail': 'The admin request is invalid.',
  'admin.resource_not_found.title': 'Resource Not Found',
  'admin.resource_not_found.detail': 'The requested resource was not found.',
  'admin.conflict.title': 'Conflict',
  'admin.conflict.detail': 'The request conflicts with existing data.',

  // ============================================
  // SAML
  // ============================================
  'saml.invalid_response.title': 'Invalid SAML Response',
  'saml.invalid_response.detail': 'The SAML response is invalid.',
  'saml.slo_failed.title': 'Single Logout Failed',
  'saml.slo_failed.detail': 'SAML single logout failed.',
  'saml.signature_invalid.title': 'Invalid SAML Signature',
  'saml.signature_invalid.detail': 'The SAML signature verification failed.',
  'saml.assertion_expired.title': 'SAML Assertion Expired',
  'saml.assertion_expired.detail': 'The SAML assertion has expired.',
  'saml.idp_not_configured.title': 'IdP Not Configured',
  'saml.idp_not_configured.detail': 'The SAML Identity Provider is not configured.',

  // ============================================
  // VC
  // ============================================
  'vc.issuance_pending.title': 'Issuance Pending',
  'vc.issuance_pending.detail': 'Credential issuance is pending. Please retry later.',
  'vc.unsupported_format.title': 'Unsupported Format',
  'vc.unsupported_format.detail': 'The requested credential format is not supported.',
  'vc.invalid_proof.title': 'Invalid Proof',
  'vc.invalid_proof.detail': 'The credential proof is invalid.',
  'vc.credential_revoked.title': 'Credential Revoked',
  'vc.credential_revoked.detail': 'The credential has been revoked.',
  'vc.status_check_failed.title': 'Status Check Failed',
  'vc.status_check_failed.detail': 'Failed to check the credential status.',
  'vc.did_resolution_failed.title': 'DID Resolution Failed',
  'vc.did_resolution_failed.detail': 'Failed to resolve the DID document.',

  // ============================================
  // BRIDGE
  // ============================================
  'bridge.link_required.title': 'Account Linking Required',
  'bridge.link_required.detail': 'Account linking is required to continue.',
  'bridge.provider_auth_failed.title': 'Provider Authentication Failed',
  'bridge.provider_auth_failed.detail': 'Authentication with the external provider failed.',
  'bridge.provider_unavailable.title': 'Provider Unavailable',
  'bridge.provider_unavailable.detail':
    'The external identity provider is temporarily unavailable.',
  'bridge.account_already_linked.title': 'Account Already Linked',
  'bridge.account_already_linked.detail': 'This external account is already linked.',
  'bridge.token_refresh_failed.title': 'Token Refresh Failed',
  'bridge.token_refresh_failed.detail': 'Failed to refresh the external provider token.',
  'bridge.jit_provisioning_failed.title': 'Provisioning Failed',
  'bridge.jit_provisioning_failed.detail': 'Just-in-time user provisioning failed.',

  // ============================================
  // CONFIG
  // ============================================
  'config.kv_not_configured.title': 'Configuration Error',
  'config.kv_not_configured.detail': 'The key-value store is not configured.',
  'config.invalid_value.title': 'Invalid Configuration',
  'config.invalid_value.detail': 'The configuration value is invalid.',
  'config.load_error.title': 'Configuration Load Error',
  'config.load_error.detail': 'Failed to load the configuration.',
  'config.missing_secret.title': 'Missing Secret',
  'config.missing_secret.detail': 'A required secret is not configured.',
  'config.db_not_configured.title': 'Database Not Configured',
  'config.db_not_configured.detail': 'The database is not configured.',

  // ============================================
  // RATE
  // ============================================
  'rate.limit_exceeded.title': 'Rate Limit Exceeded',
  'rate.limit_exceeded.detail': 'Rate limit exceeded. Please retry after {retry_after} seconds.',
  'rate.slow_down.title': 'Slow Down',
  'rate.slow_down.detail': 'You are polling too frequently. Please slow down.',
  'rate.too_many_requests.title': 'Too Many Requests',
  'rate.too_many_requests.detail': 'Too many requests. Please try again later.',

  // ============================================
  // FLOW
  // ============================================
  'flow.missing_challenge_id.title': 'Missing Challenge ID',
  'flow.missing_challenge_id.detail':
    'A challenge_id is required. Please start a new authentication flow.',
  'flow.challenge_not_found.title': 'Challenge Not Found',
  'flow.challenge_not_found.detail':
    'The authentication challenge was not found. Please start a new flow.',
  'flow.challenge_expired.title': 'Challenge Expired',
  'flow.challenge_expired.detail':
    'The authentication challenge has expired. Please start a new flow.',
  'flow.challenge_consumed.title': 'Challenge Already Used',
  'flow.challenge_consumed.detail':
    'This authentication challenge has already been completed. Please start a new flow.',
  'flow.invalid_event.title': 'Invalid Event',
  'flow.invalid_event.detail': 'The event type "{event}" is not recognized.',
  'flow.invalid_transition.title': 'Invalid Transition',
  'flow.invalid_transition.detail':
    'The event "{event}" is not allowed in the current state "{state}".',
  'flow.validation_failed.title': 'Validation Failed',
  'flow.validation_failed.detail': 'The submitted data failed validation. Please check your input.',
  'flow.webauthn_failed.title': 'Passkey Verification Failed',
  'flow.webauthn_failed.detail': 'Passkey verification failed. Please try again.',
  'flow.external_idp_failed.title': 'External Login Failed',
  'flow.external_idp_failed.detail':
    'Authentication with the external provider failed. Please try again.',
  'flow.capability_not_found.title': 'Capability Not Found',
  'flow.capability_not_found.detail': 'The capability "{capability_id}" was not found.',

  // ============================================
  // INTERNAL
  // ============================================
  'internal.error.title': 'Internal Error',
  'internal.error.detail': 'An internal error occurred.',
  'internal.do_error.title': 'Internal Error',
  'internal.do_error.detail': 'An internal error occurred.',
  'internal.queue_error.title': 'Internal Error',
  'internal.queue_error.detail': 'An internal error occurred.',
};
