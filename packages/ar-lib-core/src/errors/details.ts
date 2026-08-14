/**
 * Phase 1 machine-readable error details.
 *
 * These codes are returned as `error_details.code` next to standard OAuth
 * top-level errors. They are intentionally separate from ARxxxx internal error
 * codes because clients branch on the public snake_case contract.
 */

export const PHASE1_ERROR_DETAIL_CODES = {
  INVALID_CURSOR: 'invalid_cursor',
  UNKNOWN_AUDIT_FIELD: 'unknown_audit_field',
  REVOKE_DISABLED: 'revoke_disabled',
  INTROSPECTION_DISABLED: 'introspection_disabled',
  UNAUTHORIZED_INTROSPECTION_CALLER: 'unauthorized_introspection_caller',

  NATIVE_SSO_DISABLED: 'native_sso_disabled',
  NATIVE_SSO_CLIENT_DISABLED: 'native_sso_client_disabled',
  NATIVE_SSO_RATE_LIMITED: 'native_sso_rate_limited',
  DEVICE_SECRET_MISSING: 'device_secret_missing',
  ID_TOKEN_MALFORMED: 'id_token_malformed',
  ID_TOKEN_SIGNATURE_INVALID: 'id_token_signature_invalid',
  ID_TOKEN_ISSUER_INVALID: 'id_token_issuer_invalid',
  ID_TOKEN_AUDIENCE_INVALID: 'id_token_audience_invalid',
  ID_TOKEN_EXPIRED: 'id_token_expired',
  ID_TOKEN_REPLAYED: 'id_token_replayed',
  DPOP_PROOF_MISSING: 'dpop_proof_missing',
  DPOP_PROOF_INVALID: 'dpop_proof_invalid',
  DEVICE_SECRET_BINDING_FAILED: 'device_secret_binding_failed',
  TRUST_GROUP_NOT_ALLOWED: 'trust_group_not_allowed',
  DEVICE_SECRET_INACTIVE: 'device_secret_inactive',
  NATIVE_SSO_SCOPE_INVALID: 'native_sso_scope_invalid',
  NATIVE_SSO_SERVER_ERROR: 'native_sso_server_error',

  STEP_UP_REQUIRED: 'step_up_required',
  PREFERRED_METHOD_UNAVAILABLE: 'preferred_method_unavailable',
  IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
  INVALID_STEP_UP_INPUT: 'invalid_step_up_input',
  STEP_UP_ATTEMPTS_EXHAUSTED: 'step_up_attempts_exhausted',
  RESEND_LIMIT_EXCEEDED: 'resend_limit_exceeded',
  USER_CANCELED: 'user_canceled',

  LEGACY_PASSKEY_ERROR_UNSUPPORTED: 'legacy_passkey_error_unsupported',
  LEGACY_APP_SUITE_NOT_SUPPORTED: 'legacy_app_suite_not_supported',
  LEGACY_NATIVE_SSO_DISCOVERY_UNSUPPORTED: 'legacy_native_sso_discovery_unsupported',
  LEGACY_ENDPOINT_NOT_SUPPORTED: 'legacy_endpoint_not_supported',
} as const;

export type Phase1ErrorDetailCode =
  (typeof PHASE1_ERROR_DETAIL_CODES)[keyof typeof PHASE1_ERROR_DETAIL_CODES];

export type NativeSSOErrorDetailCode = Extract<
  Phase1ErrorDetailCode,
  | 'native_sso_disabled'
  | 'native_sso_client_disabled'
  | 'native_sso_rate_limited'
  | 'device_secret_missing'
  | 'id_token_malformed'
  | 'id_token_signature_invalid'
  | 'id_token_issuer_invalid'
  | 'id_token_audience_invalid'
  | 'id_token_expired'
  | 'id_token_replayed'
  | 'dpop_proof_missing'
  | 'dpop_proof_invalid'
  | 'device_secret_binding_failed'
  | 'trust_group_not_allowed'
  | 'device_secret_inactive'
  | 'native_sso_scope_invalid'
  | 'native_sso_server_error'
>;

export type DeviceSecretPolicyErrorDetailCode = Extract<
  Phase1ErrorDetailCode,
  'revoke_disabled' | 'introspection_disabled' | 'unauthorized_introspection_caller'
>;

export type CompatibilityErrorDetailCode = Extract<
  Phase1ErrorDetailCode,
  | 'legacy_app_suite_not_supported'
  | 'legacy_native_sso_discovery_unsupported'
  | 'legacy_endpoint_not_supported'
  | 'legacy_passkey_error_unsupported'
>;

export type Phase1ErrorDetailUserAction =
  | 'retry'
  | 'reauthenticate'
  | 'update_client'
  | 'contact_support'
  | 'none';

export type Phase1ErrorDetailSeverity = 'warning' | 'error' | 'fatal';

export interface Phase1ErrorDetailDefinition {
  message: string;
  transient: boolean;
  retryable: boolean;
  user_action: Phase1ErrorDetailUserAction;
  severity: Phase1ErrorDetailSeverity;
}

export type Phase1ErrorDetailDefinitions = Record<
  Phase1ErrorDetailCode,
  Phase1ErrorDetailDefinition
>;

export interface Phase1ErrorDetails<Code extends Phase1ErrorDetailCode = Phase1ErrorDetailCode> {
  code: Code;
  retryable: boolean;
  severity: Phase1ErrorDetailSeverity;
  user_action: Phase1ErrorDetailUserAction;
  transient?: boolean;
  field?: string;
  input_state?: unknown;
  [key: string]: unknown;
}

export type Phase1ErrorDetailsOverrides = Partial<Omit<Phase1ErrorDetails, 'code'>> &
  Record<string, unknown>;

export const PHASE1_ERROR_DETAIL_DEFINITIONS: Phase1ErrorDetailDefinitions = {
  invalid_cursor: {
    message: 'Device inventory cursor is invalid, expired, or tampered',
    transient: false,
    retryable: false,
    user_action: 'retry',
    severity: 'error',
  },
  unknown_audit_field: {
    message: 'Delegated write audit envelope contains an unknown field',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  revoke_disabled: {
    message: 'Device secret revocation is disabled for this caller',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  introspection_disabled: {
    message: 'Device secret introspection is disabled for this caller',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  unauthorized_introspection_caller: {
    message: 'Caller is not authorized to introspect device secrets',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  native_sso_disabled: {
    message: 'Native SSO is disabled for this tenant or deployment',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  native_sso_client_disabled: {
    message: 'Client is not configured for Native SSO',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  native_sso_rate_limited: {
    message: 'Native SSO token exchange is rate limited',
    transient: true,
    retryable: true,
    user_action: 'retry',
    severity: 'warning',
  },
  device_secret_missing: {
    message: 'Native SSO device_secret actor token is missing',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  id_token_malformed: {
    message: 'Subject ID token could not be parsed',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  id_token_signature_invalid: {
    message: 'Subject ID token signature is invalid',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  id_token_issuer_invalid: {
    message: 'Subject ID token issuer is invalid',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  id_token_audience_invalid: {
    message: 'Subject ID token audience is invalid',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  id_token_expired: {
    message: 'Subject ID token is expired beyond the allowed window',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  id_token_replayed: {
    message: 'Subject ID token has already been used for Native SSO token exchange',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  dpop_proof_missing: {
    message: 'DPoP proof is required but missing',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  dpop_proof_invalid: {
    message: 'DPoP proof is invalid',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  device_secret_binding_failed: {
    message: 'Device secret binding did not match the subject token',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  trust_group_not_allowed: {
    message: 'Cross-client Native SSO is not allowed for this trust group',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  device_secret_inactive: {
    message: 'Device secret is inactive or revoked',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  native_sso_scope_invalid: {
    message: 'Native SSO scope must include openid and be permitted for the client',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  native_sso_server_error: {
    message: 'Native SSO token exchange failed due to a server-side issuance error',
    transient: true,
    retryable: true,
    user_action: 'retry',
    severity: 'error',
  },
  step_up_required: {
    message: 'Additional assurance is required',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'warning',
  },
  preferred_method_unavailable: {
    message: 'Preferred step-up method is unavailable',
    transient: false,
    retryable: true,
    user_action: 'retry',
    severity: 'warning',
  },
  idempotency_conflict: {
    message: 'Idempotency key conflicts with a previous request',
    transient: false,
    retryable: false,
    user_action: 'contact_support',
    severity: 'error',
  },
  invalid_step_up_input: {
    message: 'Step-up input is invalid',
    transient: false,
    retryable: true,
    user_action: 'retry',
    severity: 'warning',
  },
  step_up_attempts_exhausted: {
    message: 'Step-up attempts have been exhausted',
    transient: false,
    retryable: false,
    user_action: 'reauthenticate',
    severity: 'error',
  },
  resend_limit_exceeded: {
    message: 'Step-up resend limit has been exceeded',
    transient: false,
    retryable: false,
    user_action: 'none',
    severity: 'warning',
  },
  user_canceled: {
    message: 'User canceled the step-up action',
    transient: false,
    retryable: true,
    user_action: 'retry',
    severity: 'warning',
  },
  legacy_passkey_error_unsupported: {
    message: 'Legacy passkey error code is no longer supported',
    transient: false,
    retryable: false,
    user_action: 'update_client',
    severity: 'fatal',
  },
  legacy_app_suite_not_supported: {
    message: 'Legacy app suite configuration is no longer supported',
    transient: false,
    retryable: false,
    user_action: 'update_client',
    severity: 'fatal',
  },
  legacy_native_sso_discovery_unsupported: {
    message: 'Native SSO discovery document is too old for Phase 1 clients',
    transient: false,
    retryable: false,
    user_action: 'update_client',
    severity: 'fatal',
  },
  legacy_endpoint_not_supported: {
    message: 'This legacy endpoint is no longer supported in Authrim Phase 1',
    transient: false,
    retryable: false,
    user_action: 'update_client',
    severity: 'fatal',
  },
};

export function getPhase1ErrorDetailDefinition(
  code: Phase1ErrorDetailCode
): Phase1ErrorDetailDefinition {
  return PHASE1_ERROR_DETAIL_DEFINITIONS[code];
}

export function createPhase1ErrorDetails<Code extends Phase1ErrorDetailCode>(
  code: Code,
  overrides: Phase1ErrorDetailsOverrides = {}
): Phase1ErrorDetails<Code> {
  const definition = getPhase1ErrorDetailDefinition(code);
  const { code: _ignoredCode, ...safeOverrides } = overrides;
  const details: Phase1ErrorDetails<Code> = {
    code,
    retryable: definition.retryable,
    severity: definition.severity,
    user_action: definition.user_action,
  };

  if (definition.transient) {
    details.transient = true;
  }

  return {
    ...details,
    ...safeOverrides,
  };
}
