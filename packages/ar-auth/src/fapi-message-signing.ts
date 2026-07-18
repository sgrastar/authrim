export interface FAPI2MessageSigningConfig {
  enabled?: boolean;
  requireSignedRequestObject?: boolean;
  requireJarm?: boolean;
  requestObjectSigningAlgorithms?: string[];
  authorizationSigningAlgorithms?: Array<'RS256' | 'ES256'>;
  defaultAuthorizationSigningAlgorithm?: 'RS256' | 'ES256';
  maxRequestObjectAgeSeconds?: number;
  maxRequestObjectLifetimeSeconds?: number;
  clockSkewSeconds?: number;
}

export interface RequestObjectClaimValidationOptions {
  nowSeconds?: number;
  maxAgeSeconds?: number;
  maxLifetimeSeconds?: number;
}

function isIntegerTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Validate the additional request-object time constraints from the FAPI 2.0
 * Message Signing Final profile. JOSE performs the ordinary expiry/not-before
 * checks; this function enforces claim presence and the bounded validity window.
 */
export function validateFAPI2MessageSigningRequestObjectClaims(
  claims: Record<string, unknown>,
  options: RequestObjectClaimValidationOptions = {}
): string | null {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = options.maxAgeSeconds ?? 3600;
  const maxLifetime = options.maxLifetimeSeconds ?? 3600;

  if (!isIntegerTimestamp(claims.nbf)) {
    return 'nbf claim is required and must be an integer NumericDate';
  }
  if (!isIntegerTimestamp(claims.exp)) {
    return 'exp claim is required and must be an integer NumericDate';
  }
  if (claims.nbf < now - maxAge) {
    return `nbf claim must not be more than ${maxAge} seconds in the past`;
  }
  if (claims.exp <= claims.nbf) {
    return 'exp claim must be later than nbf';
  }
  if (claims.exp - claims.nbf > maxLifetime) {
    return `request object lifetime must not exceed ${maxLifetime} seconds`;
  }
  return null;
}
