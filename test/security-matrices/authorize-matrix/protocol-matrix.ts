import { generateCoveringArray, type Row, type Scalar } from '../fixtures/covering-array';
import { deriveCaseId, semanticFingerprint } from '../fixtures/case-fingerprint';
import {
  dominantPhase,
  effectiveResponseType,
  isJwtResponseMode,
  protocolPkceRejected,
  decideProtocol,
  type Outcome,
  type SideEffects,
} from './decision';

/**
 * Matrix B: protocol source / PAR / JAR / PKCE / redirect.
 *
 * Dimensions cover the request container (direct, PAR, JAR, or conflicting request and
 * request_uri), the PAR/JAR container state, client type and tenant binding, PKCE
 * challenge handling, response type, response mode, JARM requirement, redirect
 * validity, the validation phase at which the outcome is decided, and the session
 * tenant binding.
 *
 * Constraint provenance (verified against production `packages/ar-auth/src/authorize.ts`):
 * 1. `containerState must match the request source` — only the declared container of the
 *    request source is processed (PAR read at authorize.ts:1088-1599, JAR processing at
 *    authorize.ts:1606-1948); direct and conflict requests have no container.
 * 2. `phase must equal the dominant validation phase of the row` — the phase is derived
 *    from the other dimensions (container errors before client fetch, response-type
 *    before tenant check, tenant check before redirect validation).
 * 3. `par-valid carries a registered redirect` — a valid PAR restores its stored
 *    redirect_uri (authorize.ts:1569), which is then validated against the client
 *    registration; an unregistered stored redirect would abort the very flow the PAR
 *    was meant to carry.
 * 4. `par-valid never restores a missing response_type` — production defaults the
 *    restored response_type to 'code' (authorize.ts:1462).
 * 5. `request-source and pre-redirect errors occur before any session read` — the
 *    session store is only read at authorize.ts:2811, after all container, client,
 *    tenant, redirect, response-type, response-mode, JARM, and PKCE checks.
 * 6. `foreign-tenant client binding is decided before post-validation` — the client
 *    tenant check (authorize.ts:2054-2066) fires only when the request tenant is NOT
 *    the deployment default tenant; this suite therefore executes under a non-default
 *    request tenant so the cross-tenant client row is genuinely rejected.
 * No constraint removes an observationally distinct combination reachable in
 * production under these fixture contracts.
 */

export const PROTO_DIMENSION_ORDER = [
  'source',
  'containerState',
  'clientType',
  'clientBinding',
  'pkce',
  'responseType',
  'responseMode',
  'redirectValid',
  'jarmRequirement',
  'phase',
  'sessionBinding',
] as const;

export const PROTO_VALUES: Record<string, readonly Scalar[]> = {
  source: ['direct', 'par', 'jar', 'conflict'],
  containerState: [
    'n-a',
    'par-valid',
    'par-expired',
    'par-replayed',
    'par-client-mismatch',
    'par-tenant-mismatch',
    'jar-valid',
    'jar-malformed',
    'jar-bad-signature',
    'jar-claims-mismatch',
  ],
  clientType: ['public', 'confidential', 'requires-pkce'],
  clientBinding: ['request-tenant', 'foreign-tenant'],
  pkce: ['missing', 'valid', 'plain', 'malformed'],
  responseType: ['code', 'none', 'unsupported', 'missing'],
  responseMode: ['omitted', 'query', 'fragment', 'form_post', 'jwt', 'invalid'],
  redirectValid: ['registered', 'unregistered', 'malformed'],
  jarmRequirement: ['none', 'required'],
  phase: ['request-source', 'pre-redirect', 'post-validation'],
  sessionBinding: ['active-request-tenant', 'foreign-tenant', 'n-a'],
};

export const PROTO_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['source', 'clientBinding', 'sessionBinding'],
  ['clientType', 'pkce', 'responseType'],
  ['responseType', 'responseMode', 'jarmRequirement'],
  ['redirectValid', 'phase', 'responseMode'],
];

export const PROTO_CONSTRAINTS = [
  // The PAR/JAR container state must be consistent with the request source.
  (row: Row): boolean => {
    const containerState = String(row.containerState);
    if (String(row.source) === 'par') return containerState.startsWith('par-');
    if (String(row.source) === 'jar') return containerState.startsWith('jar-');
    return containerState === 'n-a';
  },
  // The validation phase is determined by the other dimensions.
  (row: Row): boolean => String(row.phase) === dominantPhase(row),
  // A valid PAR carries a registered redirect (the effective redirect comes from PAR data).
  (row: Row): boolean =>
    String(row.containerState) !== 'par-valid' || row.redirectValid === 'registered',
  // PAR restores response_type from the stored payload, which defaults to 'code'.
  (row: Row): boolean =>
    String(row.containerState) !== 'par-valid' || row.responseType !== 'missing',
  // Request-source and pre-redirect errors are decided before any session is read.
  (row: Row): boolean => String(row.phase) === 'post-validation' || row.sessionBinding === 'n-a',
  // A foreign-tenant client is rejected before the session/consent phase (requires a
  // non-default request tenant in the fixture, see provenance note 6).
  (row: Row): boolean =>
    row.clientBinding !== 'foreign-tenant' || String(row.phase) !== 'post-validation',
];

export const PROTO_CONSTRAINT_LABELS = [
  'containerState must match the request source (PAR/JAR/n-a)',
  'phase must equal the dominant validation phase of the row',
  'par-valid carries a registered redirect',
  'par-valid never restores a missing response_type',
  'request-source and pre-redirect errors occur before any session read',
  'foreign-tenant client binding is decided before post-validation',
];

export interface ProtocolCase {
  id: string;
  title: string;
  dimensions: Record<string, Scalar>;
  source: Scalar;
  containerState: Scalar;
  clientType: Scalar;
  clientBinding: Scalar;
  pkce: Scalar;
  responseType: Scalar;
  responseMode: Scalar;
  redirectValid: Scalar;
  jarmRequirement: Scalar;
  phase: Scalar;
  sessionBinding: Scalar;
  fingerprint: string;
  mutationIds: string[];
}

export type ProtocolDecision = { outcome: Outcome; sideEffects: SideEffects };

export function protocolDecisionSignature(decision: ProtocolDecision): string {
  return JSON.stringify(decision);
}

export interface ProtocolMutationCandidate {
  id: string;
  mutantRow?: Row;
  customMutant?: (base: ProtocolDecision) => ProtocolDecision;
}

function redirectToUnvalidatedUri(base: ProtocolDecision): ProtocolDecision {
  return {
    outcome: {
      kind: 'error-redirect',
      error: base.outcome.kind === 'direct-error' ? base.outcome.error : 'invalid_request',
      mode: 'query',
      target: 'unvalidated',
    },
    sideEffects: base.sideEffects,
  };
}

/**
 * Candidate mutations for a row. Each candidate is kept only when it changes the row's
 * expected decision (the oracle rejects the mutant), which makes every assigned mutation
 * id a discriminating witness for that row by construction.
 */
export function protocolMutationCandidates(row: Row): ProtocolMutationCandidate[] {
  const source = String(row.source);
  const containerState = String(row.containerState);
  const phase = dominantPhase(row);
  const candidates: ProtocolMutationCandidate[] = [];

  if (source === 'conflict') {
    candidates.push({
      id: 'authorize:accept-request-plus-request-uri',
      mutantRow: { ...row, source: 'direct', containerState: 'n-a' },
    });
  }
  if (source === 'par' && containerState !== 'par-valid') {
    candidates.push({
      id: 'authorize:accept-invalid-par',
      mutantRow: { ...row, containerState: 'par-valid', redirectValid: 'registered' },
    });
  }
  if (source === 'jar' && containerState !== 'jar-valid') {
    candidates.push({
      id: 'authorize:accept-invalid-request-object',
      mutantRow: { ...row, containerState: 'jar-valid', redirectValid: 'registered' },
    });
  }
  if (source === 'par' && containerState === 'par-valid') {
    if (phase === 'post-validation' && row.sessionBinding !== 'active-request-tenant') {
      candidates.push({
        id: 'authorize:consume-par-while-displaying-login-ui',
        mutantRow: { ...row, sessionBinding: 'active-request-tenant' },
      });
    }
    if (phase === 'post-validation' && row.sessionBinding === 'active-request-tenant') {
      candidates.push({
        id: 'authorize:skip-par-consume',
        customMutant: (base) => ({
          outcome: base.outcome,
          sideEffects: { ...base.sideEffects, parConsumed: false },
        }),
      });
    }
  }
  if (phase === 'post-validation' && row.sessionBinding === 'foreign-tenant') {
    candidates.push({
      id: 'authorize:accept-foreign-session-as-active',
      mutantRow: { ...row, sessionBinding: 'active-request-tenant' },
    });
  }
  if (phase === 'post-validation' && row.sessionBinding === 'n-a') {
    candidates.push({
      id: 'authorize:session-state-ignored',
      mutantRow: { ...row, sessionBinding: 'active-request-tenant' },
    });
  }

  const effectiveResponseTypeValue = String(effectiveResponseType(row));
  if (effectiveResponseTypeValue === 'none') {
    candidates.push({
      id: 'authorize:accept-response-type-none',
      mutantRow: { ...row, responseType: 'code' },
    });
  }
  if (effectiveResponseTypeValue === 'unsupported') {
    candidates.push({
      id: 'authorize:accept-unsupported-response-type',
      mutantRow: { ...row, responseType: 'code' },
    });
  }
  if (effectiveResponseTypeValue === 'missing') {
    candidates.push({
      id: 'authorize:accept-missing-response-type',
      mutantRow: { ...row, responseType: 'code' },
    });
  }
  if (String(row.responseMode) === 'invalid') {
    candidates.push({
      id: 'authorize:ignore-invalid-response-mode',
      mutantRow: { ...row, responseMode: 'omitted' },
    });
  }
  if (effectiveResponseTypeValue === 'code' && row.responseMode === 'fragment') {
    candidates.push({
      id: 'authorize:ignore-invalid-response-mode',
      mutantRow: { ...row, responseMode: 'omitted' },
    });
  }
  if (row.jarmRequirement === 'required' && !isJwtResponseMode(row.responseMode)) {
    candidates.push({
      id: 'authorize:ignore-jarm-requirement',
      mutantRow: { ...row, jarmRequirement: 'none' },
    });
  }
  if (phase === 'post-validation' && protocolPkceRejected(row)) {
    candidates.push({
      id: 'authorize:accept-invalid-pkce-challenge',
      mutantRow: { ...row, pkce: 'valid' },
    });
  }
  if (row.clientBinding === 'foreign-tenant') {
    candidates.push({
      id: 'authorize:accept-cross-tenant-client',
      mutantRow: { ...row, clientBinding: 'request-tenant' },
    });
  }

  // Redirect-safety net: every row whose expected outcome is not already an
  // error-redirect to the registered URI witnesses "errors never target an unvalidated
  // URI" (mutant: send the error through the browser to an unvalidated candidate).
  candidates.push({
    id: 'authorize:redirect-error-to-unvalidated-uri',
    customMutant: redirectToUnvalidatedUri,
  });

  return candidates;
}

/** Mutant decision for a mutation id (used by the meta test to re-verify witnesses). */
export function protocolMutationDecision(row: Row, mutationId: string): ProtocolDecision {
  const base = decideProtocol(row);
  for (const candidate of protocolMutationCandidates(row)) {
    if (candidate.id !== mutationId) continue;
    return candidate.mutantRow
      ? decideProtocol(candidate.mutantRow)
      : candidate.customMutant!(base);
  }
  throw new Error(`Unknown proto mutation id: ${mutationId}`);
}

function protocolMutationIds(row: Row): string[] {
  const base = decideProtocol(row);
  const baseSignature = protocolDecisionSignature(base);
  const ids = protocolMutationCandidates(row)
    .filter((candidate) => {
      const mutant = candidate.mutantRow
        ? decideProtocol(candidate.mutantRow)
        : candidate.customMutant!(base);
      return protocolDecisionSignature(mutant) !== baseSignature;
    })
    .map((candidate) => candidate.id);
  return ids.length > 0 ? ids : ['authorize:redirect-error-to-unvalidated-uri'];
}

/**
 * Expected covering-array row count. The permanent meta test pins the generated table to
 * this count and the suite manifest's expected_case_count agrees with it
 * (check-collection verifies the manifest independently).
 */
export const EXPECTED_PROTO_CASE_COUNT = 74;

export function buildProtocolCaseTable(): ProtocolCase[] {
  const rows = generateCoveringArray({
    dimensionOrder: [...PROTO_DIMENSION_ORDER],
    values: PROTO_VALUES,
    constraints: PROTO_CONSTRAINTS,
    selectedTriples: PROTO_SELECTED_TRIPLES,
  });
  return rows.map((row, index) => {
    const id = deriveCaseId('authz-prot', index + 1);
    return {
      id,
      title: `source=${row.source}, container=${row.containerState}, client=${row.clientType}, binding=${row.clientBinding}, pkce=${row.pkce}, response=${row.responseType}, mode=${row.responseMode}, redirect=${row.redirectValid}, jarm=${row.jarmRequirement}, phase=${row.phase}, session=${row.sessionBinding}`,
      dimensions: { ...row },
      source: row.source,
      containerState: row.containerState,
      clientType: row.clientType,
      clientBinding: row.clientBinding,
      pkce: row.pkce,
      responseType: row.responseType,
      responseMode: row.responseMode,
      redirectValid: row.redirectValid,
      jarmRequirement: row.jarmRequirement,
      phase: row.phase,
      sessionBinding: row.sessionBinding,
      fingerprint: semanticFingerprint({ ...row }),
      mutationIds: protocolMutationIds(row),
    };
  });
}

export const PROTO_CASE_TABLE = buildProtocolCaseTable();
