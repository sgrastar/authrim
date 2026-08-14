import type { CallLedger, LedgerEntry } from './call-ledger';

export interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

/**
 * Decode a JWT payload without verifying it (for assertions about claim shape).
 * Semantic verification of signatures is the signer's concern; here we only read claims.
 */
export function decodeJwtPayloadUnverified(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`decodeJwtPayloadUnverified: expected 3 JWT segments, got ${parts.length}`);
  }
  const payload = parts[1];
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const decoded = atob(padded);
  return JSON.parse(decoded) as Record<string, unknown>;
}

export function decodeJwtHeaderUnverified(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error(`decodeJwtHeaderUnverified: expected 3 JWT segments, got ${parts.length}`);
  }
  const header = parts[0];
  const base64 = header.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

export interface TokenResponseShape {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  [key: string]: unknown;
}

/**
 * Oracle: assert that a token response contains the expected claim subset in access/id tokens.
 */
export function assertTokenClaims(
  response: TokenResponseShape,
  expected: {
    accessToken?: Record<string, unknown>;
    idToken?: Record<string, unknown>;
    refreshToken?: Record<string, unknown>;
  }
): void {
  if (expected.accessToken && response.access_token) {
    const claims = decodeJwtPayloadUnverified(response.access_token);
    for (const [key, value] of Object.entries(expected.accessToken)) {
      if (typeof value === 'object' && value !== null) {
        expect(claims[key]).toEqual(value);
      } else {
        expect(claims[key]).toBe(value);
      }
    }
  }
  if (expected.idToken && response.id_token) {
    const claims = decodeJwtPayloadUnverified(response.id_token);
    for (const [key, value] of Object.entries(expected.idToken)) {
      if (typeof value === 'object' && value !== null) {
        expect(claims[key]).toEqual(value);
      } else {
        expect(claims[key]).toBe(value);
      }
    }
  }
  if (expected.refreshToken && response.refresh_token) {
    const claims = decodeJwtPayloadUnverified(response.refresh_token);
    for (const [key, value] of Object.entries(expected.refreshToken)) {
      if (typeof value === 'object' && value !== null) {
        expect(claims[key]).toEqual(value);
      } else {
        expect(claims[key]).toBe(value);
      }
    }
  }
}

/**
 * Oracle: assert that a serialized value does not contain any secret material.
 */
export function assertNoSecretLeak(value: string, secrets: string[]): void {
  for (const secret of secrets) {
    if (!secret) continue;
    expect(value).not.toContain(secret);
  }
}

/**
 * Collect all ledger serialization targets (error bodies and logged message details) and
 * assert none of them contain the provided secret values.
 */
export function assertLedgerSecretsRedacted(
  ledger: CallLedger,
  secrets: string[],
  targetKinds: Array<LedgerEntry['kind']> = ['d1.execute', 'queue.send', 'kv.put', 'r2.put']
): void {
  const serialized = ledger
    .all()
    .filter((entry) => targetKinds.includes(entry.kind))
    .map((entry) => {
      try {
        return JSON.stringify(entry.detail);
      } catch {
        return String(entry.detail);
      }
    })
    .join('\n');
  assertNoSecretLeak(serialized, secrets);
}

export function parseOAuthErrorBody(body: string): OAuthErrorBody {
  const parsed = JSON.parse(body) as OAuthErrorBody;
  return parsed;
}

export function hasOAuthError(body: string, error: string): boolean {
  return parseOAuthErrorBody(body).error === error;
}

export interface LedgerSideEffectExpectation {
  kind: LedgerEntry['kind'];
  targetContains?: string;
  expected: boolean;
}

/**
 * Oracle: assert the presence or confirmed absence of ledger side effects.
 */
export function assertLedgerSideEffects(
  ledger: CallLedger,
  expectations: LedgerSideEffectExpectation[]
): void {
  for (const expectation of expectations) {
    const present = ledger.has(expectation.kind, (target) =>
      expectation.targetContains ? target.includes(expectation.targetContains) : true
    );
    if (expectation.expected) {
      expect(present).toBe(true);
    } else {
      expect(present).toBe(false);
    }
  }
}
