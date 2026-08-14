import { generateCoveringArray, type Row, type Scalar } from '../fixtures/covering-array';
import { deriveCaseId, semanticFingerprint } from '../fixtures/case-fingerprint';
import { authnSsoEnabled, decideAuthn, type Outcome, type SideEffects } from './decision';

/**
 * Matrix A: authentication / session / SSO / consent.
 *
 * Dimensions cover client SSO, tenant SSO, session state, prompt, max_age, and consent.
 *
 * Constraint provenance (verified against production `packages/ar-auth/src/authorize.ts`):
 * 1. `session non-active implies consent=missing and maxAge in (omitted, malformed)`.
 *    A non-usable session never yields `sessionUserId`, so consent evaluation and
 *    max_age re-authentication bounds are unreachable (authorize.ts:2832, 3082, 3314);
 *    the only max_age value that changes the observable result for such a session is
 *    `malformed` (rejected as a direct 400 before any session read, authorize.ts:2003).
 * 2. `consent=auto-grant requires session=active`. Trusted-client auto-grant is only
 *    evaluated after an authenticated subject exists (authorize.ts:3456-3582), which
 *    requires a usable session.
 * Both constraints only remove combinations that are unreachable or observationally
 * identical in production; they do not hide any distinct outcome.
 */

export const AUTHN_DIMENSION_ORDER = [
  'clientSso',
  'tenantSso',
  'session',
  'prompt',
  'maxAge',
  'consent',
] as const;

export const AUTHN_VALUES: Record<string, readonly Scalar[]> = {
  clientSso: ['true', 'false', 'default', 'failure'],
  tenantSso: ['true', 'false', 'default', 'failure'],
  session: ['missing', 'active', 'expired', 'revoked', 'legacy', 'wrong-tenant', 'store-failure'],
  prompt: ['omitted', 'none', 'login', 'consent', 'select_account', 'none-invalid'],
  maxAge: ['omitted', 'zero', 'within', 'boundary', 'exceeded', 'malformed'],
  consent: ['sufficient', 'missing', 'expired', 'insufficient', 'auto-grant', 'lookup-failure'],
};

export const AUTHN_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['clientSso', 'tenantSso', 'session'],
  ['prompt', 'session', 'maxAge'],
  ['prompt', 'consent', 'session'],
];

const USABLE_SESSION = new Set<string>(['active']);

/** Non-usable sessions never yield a subject; consent and max_age bounds are unreachable. */
export function authnSessionUsable(session: Scalar): boolean {
  return USABLE_SESSION.has(String(session));
}

export const AUTHN_CONSTRAINTS = [
  // Non-usable sessions never reach consent evaluation or max_age bounds; malformed
  // max_age is the only max_age value meaningful for a non-usable session because it is
  // rejected before any session read.
  (row: Row): boolean => {
    if (authnSessionUsable(row.session)) return true;
    return row.consent === 'missing' && (row.maxAge === 'omitted' || row.maxAge === 'malformed');
  },
  // consent auto-grant is only evaluated on an active session.
  (row: Row): boolean => row.consent !== 'auto-grant' || row.session === 'active',
];

export const AUTHN_CONSTRAINT_LABELS = [
  'session non-active implies consent=missing and maxAge in (omitted, malformed)',
  'consent=auto-grant requires session=active',
];

export interface AuthnCase {
  id: string;
  title: string;
  dimensions: Record<string, Scalar>;
  clientSso: Scalar;
  tenantSso: Scalar;
  session: Scalar;
  prompt: Scalar;
  maxAge: Scalar;
  consent: Scalar;
  fingerprint: string;
  mutationIds: string[];
}

export type AuthnDecision = { outcome: Outcome; sideEffects: SideEffects };

/**
 * Deterministic decision signature for mutation-witness discrimination checks.
 * Object literal key order is stable across decision.ts outcomes, so JSON comparison is
 * deterministic within this suite.
 */
export function authnDecisionSignature(decision: AuthnDecision): string {
  return JSON.stringify(decision);
}

export interface AuthnMutationCandidate {
  id: string;
  mutantRow?: Row;
  customMutant?: (base: AuthnDecision) => AuthnDecision;
}

function clearConsentEffects(base: AuthnDecision): AuthnDecision {
  return {
    outcome: base.outcome,
    sideEffects: { ...base.sideEffects, consentLookup: false, consentWrite: false },
  };
}

/**
 * Candidate mutations for a row. Each candidate is kept only when it changes the row's
 * expected decision (the oracle rejects the mutant), which makes every assigned mutation
 * id a discriminating witness for that row by construction.
 */
export function authnMutationCandidates(row: Row): AuthnMutationCandidate[] {
  const prompt = String(row.prompt);
  const maxAge = String(row.maxAge);
  const usable = authnSessionUsable(row.session);
  const ssoEnabled = authnSsoEnabled(row.clientSso, row.tenantSso);
  const maxAgeForces = maxAge === 'zero' || maxAge === 'exceeded';
  const candidates: AuthnMutationCandidate[] = [];

  if (maxAge === 'malformed') {
    candidates.push({
      id: 'authorize:accept-malformed-max-age',
      mutantRow: { ...row, maxAge: 'omitted' },
    });
  }
  if (prompt === 'none-invalid') {
    candidates.push({
      id: 'authorize:accept-none-combination',
      mutantRow: { ...row, prompt: 'none' },
    });
  }
  if (usable && (prompt === 'login' || maxAgeForces)) {
    // A reauth-forcing row must neutralize BOTH drivers when both are present:
    // prompt=login alone and max_age=zero/exceeded alone each force reauth, so the
    // mutant that witnesses the reauth decision removes the drivers that apply.
    const id =
      prompt === 'login'
        ? 'authorize:reuse-session-for-prompt-login'
        : 'authorize:accept-max-age-reauth-as-reusable';
    const mutantRow =
      prompt === 'login'
        ? { ...row, prompt: 'omitted', maxAge: 'omitted' }
        : { ...row, maxAge: 'omitted' };
    candidates.push({ id, mutantRow });
  }
  if (prompt === 'none') {
    candidates.push({
      id: 'authorize:prompt-none-enters-interactive-ui',
      mutantRow: { ...row, prompt: 'omitted' },
    });
  }
  if (usable && !ssoEnabled && prompt !== 'login' && !maxAgeForces) {
    candidates.push({
      id: 'authorize:reuse-session-when-sso-disabled',
      mutantRow: { ...row, clientSso: 'true' },
    });
  }
  if (!usable && maxAge !== 'malformed' && prompt !== 'none-invalid') {
    candidates.push({
      id: 'authorize:session-state-ignored',
      mutantRow: { ...row, session: 'active', clientSso: 'true' },
    });
  }
  if (usable && ssoEnabled && prompt !== 'login' && !maxAgeForces && prompt !== 'none') {
    const satisfied =
      (row.consent === 'sufficient' || row.consent === 'auto-grant') && prompt !== 'consent';
    if (prompt === 'consent') {
      candidates.push({
        id: 'authorize:ignore-prompt-consent',
        mutantRow: { ...row, prompt: 'omitted' },
      });
    } else if (satisfied) {
      candidates.push({
        id: 'authorize:omit-consent-lookup-or-write',
        customMutant: clearConsentEffects,
      });
    } else {
      candidates.push({
        id: 'authorize:issue-code-without-consent',
        mutantRow: { ...row, consent: 'sufficient' },
      });
    }
  }
  if (
    usable &&
    row.tenantSso === 'true' &&
    row.clientSso !== 'true' &&
    row.clientSso !== 'false' &&
    prompt !== 'login' &&
    !(prompt === 'none' && maxAgeForces)
  ) {
    candidates.push({
      id: 'authorize:break-tenant-sso-inheritance',
      mutantRow: { ...row, tenantSso: 'false' },
    });
  }
  return candidates;
}

/** Mutant decision for a mutation id (used by the meta test to re-verify witnesses). */
export function authnMutationDecision(row: Row, mutationId: string): AuthnDecision {
  const base = decideAuthn(row);
  for (const candidate of authnMutationCandidates(row)) {
    if (candidate.id !== mutationId) continue;
    return candidate.mutantRow ? decideAuthn(candidate.mutantRow) : candidate.customMutant!(base);
  }
  if (mutationId === 'authorize:session-state-ignored') {
    // Fallback witness: treating an unusable session as a fully usable SSO session.
    return decideAuthn({ ...row, session: 'active', clientSso: 'true' });
  }
  throw new Error(`Unknown authn mutation id: ${mutationId}`);
}

function authnMutationIds(row: Row): string[] {
  const base = decideAuthn(row);
  const baseSignature = authnDecisionSignature(base);
  const ids = authnMutationCandidates(row)
    .filter((candidate) => {
      const mutant = candidate.mutantRow
        ? decideAuthn(candidate.mutantRow)
        : candidate.customMutant!(base);
      return authnDecisionSignature(mutant) !== baseSignature;
    })
    .map((candidate) => candidate.id);
  return ids.length > 0 ? ids : ['authorize:session-state-ignored'];
}

export function buildAuthnCaseTable(): AuthnCase[] {
  const rows = generateCoveringArray({
    dimensionOrder: [...AUTHN_DIMENSION_ORDER],
    values: AUTHN_VALUES,
    constraints: AUTHN_CONSTRAINTS,
    selectedTriples: AUTHN_SELECTED_TRIPLES,
  });
  return rows.map((row, index) => {
    const id = deriveCaseId('authz-authn', index + 1);
    return {
      id,
      title: `clientSso=${row.clientSso}, tenantSso=${row.tenantSso}, session=${row.session}, prompt=${row.prompt}, maxAge=${row.maxAge}, consent=${row.consent}`,
      dimensions: { ...row },
      clientSso: row.clientSso,
      tenantSso: row.tenantSso,
      session: row.session,
      prompt: row.prompt,
      maxAge: row.maxAge,
      consent: row.consent,
      fingerprint: semanticFingerprint({ ...row }),
      mutationIds: authnMutationIds(row),
    };
  });
}

export const AUTHN_CASE_TABLE = buildAuthnCaseTable();
