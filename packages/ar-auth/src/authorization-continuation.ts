const AUTHORIZATION_REQUEST_STRING_FIELDS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'resource',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'claims',
  'dpop_jkt',
  'par_request_uri',
  'authorization_details',
  'response_mode',
  'max_age',
  'prompt',
  'id_token_hint',
  'acr_values',
  'display',
  'ui_locales',
  'login_hint',
  'handoff',
  'org_id',
  'acting_as',
  'error_uri',
  'cancel_uri',
] as const;

type AuthorizationRequestStringField = (typeof AUTHORIZATION_REQUEST_STRING_FIELDS)[number];

export type AuthorizationRequestSource = 'frontchannel' | 'par';

export type AuthorizationRequestContinuation = {
  source: AuthorizationRequestSource;
  authorization_server: 'default';
  issuer?: string;
  integrity_protected: boolean;
} & Partial<Record<AuthorizationRequestStringField, string>>;

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function createAuthorizationRequestContinuation(
  metadata: Record<string, unknown>,
  overrides: Partial<Record<AuthorizationRequestStringField, string | undefined>> = {}
): AuthorizationRequestContinuation {
  const result: AuthorizationRequestContinuation = {
    source: metadata.authorization_request_source === 'par' ? 'par' : 'frontchannel',
    authorization_server: 'default',
    issuer: readString(metadata, 'issuer'),
    integrity_protected: metadata.authorization_request_integrity_protected === true,
  };

  for (const key of AUTHORIZATION_REQUEST_STRING_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(overrides, key)
      ? overrides[key]
      : readString(metadata, key);
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

export function parseAuthorizationRequestContinuation(
  value: unknown
): AuthorizationRequestContinuation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (
    (record.source !== 'frontchannel' && record.source !== 'par') ||
    record.authorization_server !== 'default' ||
    typeof record.integrity_protected !== 'boolean'
  ) {
    return null;
  }

  const result: AuthorizationRequestContinuation = {
    source: record.source,
    authorization_server: 'default',
    integrity_protected: record.integrity_protected,
  };
  const issuer = readString(record, 'issuer');
  if (issuer) result.issuer = issuer;

  for (const key of AUTHORIZATION_REQUEST_STRING_FIELDS) {
    const value = record[key];
    if (value !== undefined && typeof value !== 'string') return null;
    if (typeof value === 'string') result[key] = value;
  }

  if (!result.response_type || !result.client_id || !result.redirect_uri || !result.scope) {
    return null;
  }

  return result;
}

export function buildAuthorizeContinuationUrl(
  metadata: Record<string, unknown>,
  confirmationChallengeId: string,
  fallbackIssuer: string,
  confirmationParameter = '_confirmation_challenge'
): string {
  const issuer = readString(metadata, 'issuer') || fallbackIssuer;
  const authorizeUrl = new URL('/authorize', issuer);
  authorizeUrl.searchParams.set(confirmationParameter, confirmationChallengeId);
  return authorizeUrl.toString();
}
