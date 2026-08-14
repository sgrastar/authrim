import type { Row, Scalar } from '../fixtures/covering-array';

/**
 * Independent authorization decision table owned by the security matrix suite.
 *
 * Expected results are derived ONLY from the declared matrix dimensions and the
 * production behavior contract verified from `packages/ar-auth/src/authorize.ts`
 * (source landmarks noted inline). This module never imports or calls production
 * authorization helpers, validators, or handlers; it encodes the observable
 * OAuth/OIDC contract for the declared dimension domain.
 */

export type ResponseMode = 'query' | 'fragment' | 'form_post' | 'jwt';

export type Outcome =
  | { kind: 'direct-error'; status: number; error: string }
  | { kind: 'html-error'; status: number; htmlContains: string }
  | {
      kind: 'error-redirect';
      error: string;
      mode: ResponseMode;
      target?: 'registered' | 'unvalidated';
    }
  | { kind: 'challenge'; challengeType: 'login' | 'reauth' | 'consent'; path: string }
  | { kind: 'code-success'; mode: ResponseMode };

export interface SideEffects {
  /** Authorization code record present (true) or confirmed absent (false) in the store. */
  codeIssued: boolean;
  /** Challenge record type stored in the challenge store, or null. */
  challengeStored: 'login' | 'reauth' | 'consent' | null;
  /** PAR consumed by this request (meaningful only when a valid PAR was presented). */
  parConsumed: boolean;
  /** Consent row upserted (auto-grant) for this request. */
  consentWrite: boolean;
  /** Consent lookup (oauth_client_consents read) was reached. */
  consentLookup: boolean;
  /** A sharded session cookie was presented and a session-store read was attempted. */
  sessionReadAttempted: boolean;
  /** The session-store read failed (store-failure dimension). */
  sessionReadFailed: boolean;
  /** The session record rejected its storage binding (wrong-tenant dimension). */
  sessionBindingRejected: boolean;
  /** Client SSO settings KV read failed (lookup-failure dimension). */
  clientSsoReadFailed: boolean;
  /** Tenant SSO settings KV read failed (lookup-failure dimension). */
  tenantSsoReadFailed: boolean;
}

export function emptySideEffects(): SideEffects {
  return {
    codeIssued: false,
    challengeStored: null,
    parConsumed: false,
    consentWrite: false,
    consentLookup: false,
    sessionReadAttempted: false,
    sessionReadFailed: false,
    sessionBindingRejected: false,
    clientSsoReadFailed: false,
    tenantSsoReadFailed: false,
  };
}

// =============================================================================
// Authentication / session / SSO / consent matrix (Matrix A)
// =============================================================================
//
// Production contract (authorize.ts), in decision order:
// - SSO priority: client setting > tenant setting > default(false). A settings read
//   failure is swallowed by the Settings Manager (`loadKVData` returns {}), so a
//   failed lookup behaves exactly like the next level of the override chain while
//   remaining observable through the settings KV ledger (authorize.ts:2905-2963).
// - Session handling: only region-sharded session IDs are read (authorize.ts:2811).
//   Expired, revoked, and legacy-namespace sessions resolve to null; a conflicting
//   tenant binding and a storage read failure are swallowed as "no session". The
//   read itself is still attempted for every sharded cookie (ledger-observable).
// - max_age malformed is a direct 400 before any client/session/SSO read
//   (authorize.ts:2003).
// - prompt=none combined with other values is rejected (invalid_request) after the
//   session read (authorize.ts:3134).
// - prompt=login and max_age=0/exceeded force a reauth challenge whenever the
//   session is usable, EVEN when SSO is disabled: the reauth flag is computed
//   before the SSO-disabled clearing and suppresses it (authorize.ts:3067-3099,
//   3103, 3222). The SSO setting only gates session REUSE, not reauthentication.
// - With a non-usable session or SSO disabled, prompt=none is rejected
//   (login_required); any other prompt redirects to login (authorize.ts:3146-3160,
//   3314).
// - prompt=none with a usable session and enabled SSO returns login_required when
//   max_age=0 or the auth age exceeds max_age (authorize.ts:3195-3207), and
//   otherwise evaluates consent (consent_required without UI, or a code).
// - consent is evaluated only with a usable session and enabled SSO; prompt=consent
//   always forces the consent challenge; trusted-client auto-grant performs a
//   consent lookup and writes a row only when none exists (authorize.ts:3456-3677).
// - select_account has no direct authorization-endpoint branch in production
//   (authorize.ts:3213: "handled by consent UI ... don't affect the authorization
//   endpoint logic directly"), so it observes exactly the prompt-omitted contract.

/** Sharded cookies for which a session-store read is attempted. */
const ACTIVE_SESSION_READ_STATES: ReadonlySet<string> = new Set([
  'active',
  'expired',
  'revoked',
  'legacy',
  'wrong-tenant',
  'store-failure',
]);

/** Client setting wins over tenant setting; defaults and lookup failures inherit. */
export function authnSsoEnabled(clientSso: Scalar, tenantSso: Scalar): boolean {
  if (clientSso === 'true') return true;
  if (clientSso === 'false') return false;
  return tenantSso === 'true';
}

function authnConsentSatisfied(consent: Scalar, prompt: Scalar): boolean {
  if (consent === 'auto-grant') {
    return prompt !== 'consent';
  }
  return consent === 'sufficient' && prompt !== 'consent';
}

export function decideAuthn(row: Row): { outcome: Outcome; sideEffects: SideEffects } {
  const sideEffects = emptySideEffects();
  const ssoEnabled = authnSsoEnabled(row.clientSso, row.tenantSso);
  const usable = row.session === 'active';
  const prompt = String(row.prompt);
  const maxAge = String(row.maxAge);
  const maxAgeForcesReauth = maxAge === 'zero' || maxAge === 'exceeded';

  sideEffects.sessionReadAttempted = ACTIVE_SESSION_READ_STATES.has(String(row.session));
  sideEffects.sessionReadFailed = row.session === 'store-failure';
  sideEffects.sessionBindingRejected = row.session === 'wrong-tenant';
  sideEffects.clientSsoReadFailed = row.clientSso === 'failure';
  sideEffects.tenantSsoReadFailed = row.tenantSso === 'failure';

  if (maxAge === 'malformed') {
    // Pre-session validation error: malformed max_age is rejected directly by the AS
    // (authorize.ts:2003) before any client/session/SSO read.
    return {
      outcome: { kind: 'direct-error', status: 400, error: 'invalid_request' },
      sideEffects: {
        ...sideEffects,
        sessionReadAttempted: false,
        sessionReadFailed: false,
        sessionBindingRejected: false,
        clientSsoReadFailed: false,
        tenantSsoReadFailed: false,
      },
    };
  }

  if (prompt === 'none-invalid') {
    // prompt=none combined with other values is rejected after the session read
    // (authorize.ts:3134).
    return {
      outcome: {
        kind: 'error-redirect',
        error: 'invalid_request',
        mode: 'query',
        target: 'registered',
      },
      sideEffects,
    };
  }

  // prompt=login and max_age re-authentication are decided BEFORE the SSO clearing:
  // a usable session forces reauth even when session sharing is disabled.
  if (usable && prompt !== 'none' && (prompt === 'login' || maxAgeForcesReauth)) {
    sideEffects.challengeStored = 'reauth';
    return {
      outcome: { kind: 'challenge', challengeType: 'reauth', path: '/flow/confirm' },
      sideEffects,
    };
  }

  // SSO-disabled clearing (authorize.ts:3103) makes even an active session unusable
  // for anything except the forced reauth handled above.
  if (!usable || !ssoEnabled) {
    if (prompt === 'none') {
      return {
        outcome: {
          kind: 'error-redirect',
          error: 'login_required',
          mode: 'query',
          target: 'registered',
        },
        sideEffects,
      };
    }
    sideEffects.challengeStored = 'login';
    return {
      outcome: { kind: 'challenge', challengeType: 'login', path: '/flow/login' },
      sideEffects,
    };
  }

  // From here: usable session and SSO enabled (prompt != login, max_age not forcing).
  if (prompt === 'none') {
    if (maxAgeForcesReauth) {
      // prompt=none must not show UI: max_age re-authentication becomes login_required
      // (authorize.ts:3195-3207).
      return {
        outcome: {
          kind: 'error-redirect',
          error: 'login_required',
          mode: 'query',
          target: 'registered',
        },
        sideEffects,
      };
    }
    sideEffects.consentLookup = true;
    if (authnConsentSatisfied(row.consent, prompt)) {
      sideEffects.codeIssued = true;
      sideEffects.consentWrite = row.consent === 'auto-grant';
      return { outcome: { kind: 'code-success', mode: 'query' }, sideEffects };
    }
    return {
      outcome: {
        kind: 'error-redirect',
        error: 'consent_required',
        mode: 'query',
        target: 'registered',
      },
      sideEffects,
    };
  }

  // prompt: omitted, select_account, or consent
  sideEffects.consentLookup = true;
  if (authnConsentSatisfied(row.consent, prompt)) {
    sideEffects.codeIssued = true;
    sideEffects.consentWrite = row.consent === 'auto-grant';
    return { outcome: { kind: 'code-success', mode: 'query' }, sideEffects };
  }
  sideEffects.challengeStored = 'consent';
  return {
    outcome: { kind: 'challenge', challengeType: 'consent', path: '/auth/consent' },
    sideEffects,
  };
}

// =============================================================================
// Protocol-source / PAR / JAR / PKCE / redirect matrix (Matrix B)
// =============================================================================

const JWT_MODES: ReadonlySet<string> = new Set([
  'jwt',
  'query.jwt',
  'fragment.jwt',
  'form_post.jwt',
]);

export function normalizeResponseMode(responseMode: Scalar): ResponseMode {
  const mode = String(responseMode);
  if (mode === 'fragment') return 'fragment';
  if (mode === 'form_post' || mode === 'form_post.jwt') return 'form_post';
  if (JWT_MODES.has(mode)) return 'jwt';
  return 'query';
}

export function isJwtResponseMode(responseMode: Scalar): boolean {
  return JWT_MODES.has(String(responseMode));
}

export function dominantPhase(row: Row): string {
  const source = String(row.source);
  const containerState = String(row.containerState);
  // request + request_uri conflict (authorize.ts:786) and container-processing failures
  // (PAR read errors, JAR parse/verification errors) happen before any client fetch.
  if (source === 'conflict') return 'pre-redirect';
  if (source === 'par' && containerState !== 'par-valid') return 'request-source';
  if (source === 'jar' && containerState !== 'jar-valid') return 'request-source';
  // Response-type validation (authorize.ts:1954-1987) precedes the client tenant check.
  if (effectiveResponseType(row) === 'unsupported') return 'pre-redirect';
  if (effectiveResponseType(row) === 'missing') return 'pre-redirect';
  // Cross-tenant client rejection (authorize.ts:2054) precedes redirect validation.
  if (row.clientBinding === 'foreign-tenant') return 'pre-redirect';
  // Redirect format/registration validation (authorize.ts:2237-2438).
  if (String(row.redirectValid) !== 'registered') return 'pre-redirect';
  return 'post-validation';
}

/** Response type after request-object/PAR restoration (jar claims may supply it). */
export function effectiveResponseType(row: Row): Scalar {
  if (
    row.responseType === 'missing' &&
    row.source === 'jar' &&
    row.containerState === 'jar-valid'
  ) {
    return 'code';
  }
  return row.responseType;
}

/**
 * PKCE rejection at the authorization endpoint (authorize.ts:2732-2760).
 *
 * - Public clients and clients with `require_pkce` always require a valid S256
 *   challenge when the response type issues a code.
 * - Any presented challenge must use S256; plain and malformed challenges are
 *   rejected regardless of client type.
 * - Confidential clients without the PKCE requirement may omit the challenge.
 */
export function protocolPkceRejected(row: Row): boolean {
  if (effectiveResponseType(row) !== 'code') return false;
  const clientType = String(row.clientType);
  const pkce = String(row.pkce);
  if (pkce === 'valid') return false;
  if (clientType === 'public' || clientType === 'requires-pkce') return true;
  return pkce === 'plain' || pkce === 'malformed';
}

export function decideProtocol(row: Row): { outcome: Outcome; sideEffects: SideEffects } {
  const sideEffects = emptySideEffects();
  const phase = dominantPhase(row);
  const mode = normalizeResponseMode(row.responseMode);

  if (phase === 'request-source') {
    if (String(row.source) === 'par') {
      // PAR read failure (expired, replayed, client/tenant mismatch). RFC 9126 error
      // redirection is allowed only after independently re-validating the outer client
      // and redirect URI against the request tenant (authorize.ts:1486-1521). The error
      // response mode is ALWAYS query: the production call passes no response_mode and
      // hardcodes responseType 'code' (authorize.ts:1506-1513).
      const canRedirect =
        row.clientBinding === 'request-tenant' && String(row.redirectValid) === 'registered';
      if (canRedirect) {
        return {
          outcome: {
            kind: 'error-redirect',
            error: 'invalid_request_uri',
            mode: 'query',
            target: 'registered',
          },
          sideEffects,
        };
      }
      return {
        outcome: { kind: 'direct-error', status: 400, error: 'invalid_request_uri' },
        sideEffects,
      };
    }
    // JAR processing failures are returned directly as JSON, never redirected
    // (authorize.ts:1607-1948).
    return {
      outcome: { kind: 'direct-error', status: 400, error: 'invalid_request_object' },
      sideEffects,
    };
  }

  if (phase === 'pre-redirect') {
    if (String(row.source) === 'conflict') {
      // request + request_uri are mutually exclusive (authorize.ts:786); the PAR is
      // never read or consumed for such requests.
      return {
        outcome: { kind: 'direct-error', status: 400, error: 'invalid_request' },
        sideEffects,
      };
    }
    // Effective response-type validation precedes the client tenant and redirect checks
    // (authorize.ts:1954-1987).
    if (effectiveResponseType(row) === 'missing') {
      return {
        outcome: { kind: 'direct-error', status: 400, error: 'invalid_request' },
        sideEffects,
      };
    }
    if (effectiveResponseType(row) === 'unsupported') {
      return {
        outcome: { kind: 'direct-error', status: 400, error: 'unsupported_response_type' },
        sideEffects,
      };
    }
    // Cross-tenant client rejection (authorize.ts:2054-2066). This branch is only
    // reachable when the request tenant is NOT the deployment default tenant.
    if (row.clientBinding === 'foreign-tenant') {
      return {
        outcome: { kind: 'direct-error', status: 400, error: 'invalid_client' },
        sideEffects,
      };
    }
    if (row.redirectValid === 'malformed') {
      return {
        outcome: { kind: 'html-error', status: 400, htmlContains: 'Invalid Redirect URI' },
        sideEffects,
      };
    }
    return {
      outcome: { kind: 'html-error', status: 400, htmlContains: 'Unregistered Redirect URI' },
      sideEffects,
    };
  }

  // post-validation phase (redirect already proven registered)
  const responseType = String(effectiveResponseType(row));

  if (responseType === 'none') {
    // The tenant-profile gate (authorize.ts:2523) never admits response_type=none, so
    // the session-check response path is unreachable. Asserted strictly; see FINDINGS.md.
    return {
      outcome: {
        kind: 'error-redirect',
        error: 'unsupported_response_type',
        mode,
        target: 'registered',
      },
      sideEffects,
    };
  }

  if (String(row.responseMode) === 'invalid') {
    return {
      outcome: {
        kind: 'error-redirect',
        error: 'invalid_request',
        mode: 'query',
        target: 'registered',
      },
      sideEffects,
    };
  }
  if (responseType === 'code' && row.responseMode === 'fragment') {
    return {
      outcome: {
        kind: 'error-redirect',
        error: 'invalid_request',
        mode: 'fragment',
        target: 'registered',
      },
      sideEffects,
    };
  }
  if (row.jarmRequirement === 'required' && !isJwtResponseMode(row.responseMode)) {
    return {
      outcome: { kind: 'error-redirect', error: 'invalid_request', mode, target: 'registered' },
      sideEffects,
    };
  }
  if (protocolPkceRejected(row)) {
    return {
      outcome: { kind: 'error-redirect', error: 'invalid_request', mode, target: 'registered' },
      sideEffects,
    };
  }

  // PKCE, mode, and JARM checks happen before any session read (authorize.ts:2811).
  sideEffects.sessionReadAttempted = row.sessionBinding !== 'n-a';
  sideEffects.sessionBindingRejected = row.sessionBinding === 'foreign-tenant';

  if (row.sessionBinding !== 'active-request-tenant') {
    sideEffects.challengeStored = 'login';
    return {
      outcome: { kind: 'challenge', challengeType: 'login', path: '/flow/login' },
      sideEffects,
    };
  }

  sideEffects.codeIssued = true;
  sideEffects.consentLookup = true;
  sideEffects.parConsumed = String(row.containerState) === 'par-valid';
  return { outcome: { kind: 'code-success', mode }, sideEffects };
}
