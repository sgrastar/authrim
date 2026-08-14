import { generateCoveringArray, type Row, type Scalar } from '../fixtures/covering-array';
import { deriveCaseId, semanticFingerprint } from '../fixtures/case-fingerprint';

// =============================================================================
// Matrix T-A: client authentication × code ownership/state
// =============================================================================
//
// Dimensions cover the registered client-authentication method, the presented
// credentials, the client kind, the authorization-code state, and the request tenant.
// The authentication result (success | invalid_client) is derived from
// (registeredMethod, presented, client) by the independent decision table below;
// production landmarks: token.ts client-credential extraction (1594-1631),
// validateRegisteredClientAuthenticationMethod (client-authentication.ts:167),
// client fetch (token.ts:1678-1684), secret verification (token.ts:1832-1847),
// and assertion validation (token.ts:1807-1831).

export const TA_DIMENSION_ORDER = [
  'registeredMethod',
  'presented',
  'client',
  'codeState',
  'requestTenant',
] as const;

export const TA_VALUES: Record<string, readonly Scalar[]> = {
  registeredMethod: [
    'none',
    'client_secret_basic',
    'client_secret_post',
    'client_secret_jwt',
    'private_key_jwt',
  ],
  presented: ['none', 'basic', 'post', 'jwt', 'malformed', 'conflicting'],
  client: ['public', 'confidential', 'unknown', 'wrong-tenant'],
  codeState: [
    'fresh',
    'consumed',
    'replayed',
    'expired',
    'malformed',
    'wrong-client',
    'wrong-tenant',
  ],
  requestTenant: ['matching', 'foreign'],
};

/**
 * Independent authentication-result oracle (token.ts landmarks above).
 * - unknown and wrong-tenant clients fail the tenant-scoped client fetch.
 * - malformed and conflicting presentations fail before any client-specific branch.
 * - otherwise the presented credential must exactly match the registered method.
 */
export function taAuthSuccess(
  registeredMethod: Scalar,
  presented: Scalar,
  client: Scalar
): boolean {
  if (client === 'unknown' || client === 'wrong-tenant') return false;
  if (presented === 'malformed' || presented === 'conflicting') return false;
  if (registeredMethod === 'none') return presented === 'none' && client === 'public';
  if (registeredMethod === 'client_secret_basic')
    return presented === 'basic' && client === 'confidential';
  if (registeredMethod === 'client_secret_post')
    return presented === 'post' && client === 'confidential';
  if (registeredMethod === 'client_secret_jwt') return false;
  if (registeredMethod === 'private_key_jwt') {
    return presented === 'jwt' && client === 'confidential';
  }
  return false;
}

/**
 * A failed authentication returns before any code read (token.ts:1787-1847 precedes the
 * consume at 1929), so an auth-failure row loses no observable information by keeping the
 * code fresh and the request tenant matching.
 */
export const TA_CONSTRAINTS = [
  // A failed authentication returns before any code read (token.ts:1787-1847 precedes the
  // consume at 1929), so an auth-failure row loses no observable information by keeping the
  // code fresh and the request tenant matching.
  (row: Row): boolean =>
    taAuthSuccess(row.registeredMethod, row.presented, row.client) ||
    (row.codeState === 'fresh' && row.requestTenant === 'matching'),
  // Client type and registered authentication method describe one registration: a public
  // client is registered with method none, a confidential client with a credential method.
  // Mixed registrations do not exist in production (isPublicClientMetadata, token.ts:476).
  (row: Row): boolean => {
    if (row.client === 'public') return row.registeredMethod === 'none';
    if (row.client === 'confidential') return row.registeredMethod !== 'none';
    return true;
  },
];

export const TA_CONSTRAINT_LABELS = [
  'auth-failure rows keep codeState=fresh and requestTenant=matching (failure precedes any code read)',
  'client type and registered authentication method must describe one coherent registration',
];

export const TA_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['registeredMethod', 'presented', 'client'],
];

export interface TokenACase {
  id: string;
  title: string;
  dimensions: Record<string, Scalar>;
  registeredMethod: Scalar;
  presented: Scalar;
  client: Scalar;
  codeState: Scalar;
  requestTenant: Scalar;
  fingerprint: string;
  mutationIds: string[];
}

function taMutationCandidates(
  row: Row
): Array<{ id: string; mutantRow?: Row; custom?: (base: TokenADecision) => TokenADecision }> {
  const base = decideTokenA(row);
  const candidates: Array<{
    id: string;
    mutantRow?: Row;
    custom?: (base: TokenADecision) => TokenADecision;
  }> = [];
  if (base.authResult === 'invalid_client') {
    candidates.push({
      id: 'token:consume-before-auth',
      custom: (b) => ({ ...b, codeConsumed: true, outcome: { kind: 'success' } }),
    });
    candidates.push({
      id: 'token:accept-bad-client-credentials',
      mutantRow: { ...row, presented: 'none' },
    });
  }
  if (base.codeConsumed) {
    candidates.push({
      id: 'token:issue-without-code-consume',
      custom: (b) => ({ ...b, codeConsumed: false }),
    });
  }
  if (base.outcome.kind === 'invalid_grant' && base.revocationCount === 0) {
    candidates.push({
      id: 'token:revoke-on-non-replay-grant-failure',
      custom: (b) => ({ ...b, revocationCount: 2 }),
    });
  }
  if (base.revocationCount > 0) {
    candidates.push({
      id: 'token:omit-revocation-after-replay',
      custom: (b) => ({ ...b, revocationCount: 0 }),
    });
  }
  if (base.outcome.kind === 'success') {
    candidates.push({
      id: 'token:derive-claims-wrong-tenant',
      custom: (b) => ({ ...b, outcome: { kind: 'invalid_grant' } }),
    });
  }
  return candidates;
}

function taMutationIds(row: Row): string[] {
  const base = decideTokenA(row);
  const baseSignature = taDecisionSignature(base);
  const ids = taMutationCandidates(row)
    .filter((candidate) => {
      const mutant = candidate.mutantRow
        ? decideTokenA(candidate.mutantRow)
        : candidate.custom!(base);
      return taDecisionSignature(mutant) !== baseSignature;
    })
    .map((candidate) => candidate.id);
  return ids.length > 0 ? ids : ['token:consume-before-auth'];
}

export function buildTokenACaseTable(): TokenACase[] {
  const rows = generateCoveringArray({
    dimensionOrder: [...TA_DIMENSION_ORDER],
    values: TA_VALUES,
    constraints: TA_CONSTRAINTS,
    selectedTriples: TA_SELECTED_TRIPLES,
  });
  const cases = rows.map((row, index) => {
    const id = deriveCaseId('token-a', index + 1);
    return {
      id,
      title: `reg=${row.registeredMethod}, presented=${row.presented}, client=${row.client}, code=${row.codeState}, tenant=${row.requestTenant}`,
      dimensions: { ...row },
      registeredMethod: row.registeredMethod,
      presented: row.presented,
      client: row.client,
      codeState: row.codeState,
      requestTenant: row.requestTenant,
      fingerprint: semanticFingerprint({ ...row }),
      mutationIds: taMutationIds(row),
    };
  });
  return appendTaSuccessRows(cases);
}

/**
 * The greedy covering array covers every legal (registeredMethod, presented, client)
 * triple with code-failure rows, so a genuine success path (fresh code, matching tenant,
 * successful authentication) never gets selected. The success path is required to
 * exercise token issuance; append one success row per successful authentication
 * combination, skipping any that the generator already placed.
 */
function appendTaSuccessRows(cases: TokenACase[]): TokenACase[] {
  const seen = new Set(cases.map((entry) => entry.fingerprint));
  const appended: TokenACase[] = [];
  for (const registeredMethod of TA_VALUES.registeredMethod) {
    for (const presented of TA_VALUES.presented) {
      for (const client of TA_VALUES.client) {
        if (!taAuthSuccess(registeredMethod, presented, client)) continue;
        const row: Row = {
          registeredMethod,
          presented,
          client,
          codeState: 'fresh',
          requestTenant: 'matching',
        };
        const fingerprint = semanticFingerprint({ ...row });
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        const index = cases.length + appended.length + 1;
        appended.push({
          id: deriveCaseId('token-a', index + 1),
          title: `reg=${registeredMethod}, presented=${presented}, client=${client}, code=fresh, tenant=matching`,
          dimensions: { ...row },
          registeredMethod,
          presented,
          client,
          codeState: 'fresh',
          requestTenant: 'matching',
          fingerprint,
          mutationIds: taMutationIds(row),
        });
      }
    }
  }
  return [...cases, ...appended];
}

export const TA_CASE_TABLE = buildTokenACaseTable();
export const EXPECTED_TA_CASE_COUNT = TA_CASE_TABLE.length;

// =============================================================================
// Matrix T-B: grant binding × issuance/postcondition
// =============================================================================
//
// Dimensions cover the authorization-code bindings, the presented PKCE verifier,
// redirect URI handling, resource/audience resolution, DPoP proofs, the downstream
// failure injection point, and the replay/JTI state. The revocation outcome is derived
// from (downstream, replayState, jtiState, binding validity); production landmarks:
// audience resolution (token.ts:374-447, 1851-1872), code consume with replay
// classification (AuthorizationCodeStore.consumeCodeRpc:686-761), replay JTI
// revocation (token.ts:1948-2000), signing (token.ts:2155-2176), refresh family
// (token.ts:2896-2956), issued-token registration (token.ts:3003-3064).

export const TB_DIMENSION_ORDER = [
  'codeBinding',
  'pkce',
  'redirect',
  'resource',
  'dpop',
  'downstream',
  'replayState',
  'jtiState',
] as const;

export const TB_VALUES: Record<string, readonly Scalar[]> = {
  codeBinding: ['none', 'pkce', 'dpop', 'pkce+dpop'],
  pkce: ['valid', 'missing', 'mismatched', 'malformed'],
  redirect: ['exact', 'omitted', 'mismatched', 'malformed'],
  resource: ['omitted-default', 'exact', 'changed', 'conflict', 'disallowed'],
  dpop: ['absent', 'valid', 'different-key', 'malformed', 'replayed'],
  downstream: ['success', 'signing', 'family', 'registration', 'revocation'],
  replayState: ['fresh', 'used'],
  jtiState: ['none', 'access', 'access+refresh'],
};

/**
 * True when every binding the code carries is satisfied by the presented request, so the
 * consume reaches the used/replay classification instead of failing earlier.
 */
export function tbBindingValid(row: Row): boolean {
  const pkceOk = String(row.codeBinding).includes('pkce') ? row.pkce === 'valid' : true;
  const dpopOk = String(row.codeBinding).includes('dpop')
    ? row.dpop === 'valid'
    : row.dpop !== 'malformed' && row.dpop !== 'replayed';
  const redirectOk = row.redirect === 'exact';
  const resourceOk = row.resource === 'omitted-default' || row.resource === 'exact';
  return pkceOk && dpopOk && redirectOk && resourceOk;
}

/**
 * Independent revocation-outcome oracle. An authenticated replay revokes exactly the
 * registered JTIs; a raced registration rejection revokes the tokens issued by this
 * request; a revocation failure revokes nothing (the failure is swallowed by the replay
 * handler, token.ts:1957-1991); everything else revokes nothing.
 */
export function tbRevocationOutcome(row: Row): 'none' | 'access' | 'access+refresh' {
  if (row.downstream === 'registration') return 'access+refresh';
  if (row.downstream === 'revocation') return 'none';
  if (row.replayState === 'used' && tbBindingValid(row)) {
    return String(row.jtiState) as 'none' | 'access' | 'access+refresh';
  }
  return 'none';
}

export const TB_CONSTRAINTS = [
  // Replay-aware failures and success require the consume to reach the intended branch.
  (row: Row): boolean => {
    const downstream = String(row.downstream);
    if (downstream === 'signing' || downstream === 'family' || downstream === 'registration') {
      return row.replayState === 'fresh' && tbBindingValid(row);
    }
    if (downstream === 'revocation') {
      return row.replayState === 'used' && row.jtiState !== 'none' && tbBindingValid(row);
    }
    return true;
  },
  // Registered JTIs only exist on a code that was already consumed once.
  (row: Row): boolean => row.jtiState === 'none' || row.replayState === 'used',
];

export const TB_CONSTRAINT_LABELS = [
  'signing/family/registration failures require a fresh code with valid bindings; revocation failure requires an authenticated replay with registered JTIs',
  'registered JTIs require an already-used code',
];

export const TB_SELECTED_TRIPLES: Array<[string, string, string]> = [
  ['codeBinding', 'pkce', 'dpop'],
  ['redirect', 'resource', 'replayState'],
];

export interface TokenBCase {
  id: string;
  title: string;
  dimensions: Record<string, Scalar>;
  codeBinding: Scalar;
  pkce: Scalar;
  redirect: Scalar;
  resource: Scalar;
  dpop: Scalar;
  downstream: Scalar;
  replayState: Scalar;
  jtiState: Scalar;
  fingerprint: string;
  mutationIds: string[];
}

export function tbMutationCandidates(
  row: Row
): Array<{ id: string; mutantRow?: Row; custom?: (base: TokenBDecision) => TokenBDecision }> {
  const base = decideTokenB(row);
  const candidates: Array<{
    id: string;
    mutantRow?: Row;
    custom?: (base: TokenBDecision) => TokenBDecision;
  }> = [];
  if (base.codeConsumed) {
    candidates.push({
      id: 'token:issue-without-code-consume',
      custom: (b) => ({ ...b, codeConsumed: false }),
    });
  } else if (
    base.outcome.kind === 'invalid_grant' ||
    base.outcome.kind === 'invalid_request' ||
    base.outcome.kind === 'invalid_target'
  ) {
    candidates.push({
      id: 'token:consume-code-on-rejected-grant',
      custom: (b) => ({ ...b, codeConsumed: true }),
    });
  }
  if (base.revocationCount > 0) {
    candidates.push({
      id: 'token:omit-revocation-after-replay',
      custom: (b) => ({ ...b, revocationCount: 0 }),
    });
  } else if (base.outcome.kind === 'invalid_grant' && base.replayReached) {
    candidates.push({
      id: 'token:omit-revocation-after-replay',
      custom: (b) => ({ ...b, revocationCount: 1 }),
    });
  }
  if (base.outcome.kind === 'success') {
    candidates.push({
      id: 'token:derive-claims-wrong-tenant',
      custom: (b) => ({ ...b, outcome: { kind: 'invalid_grant' } }),
    });
    candidates.push({
      id: 'token:skip-issued-token-registration',
      custom: (b) => ({ ...b, registrationCount: 0 }),
    });
  }
  if (base.registrationCount > 0) {
    candidates.push({
      id: 'token:register-before-success',
      custom: (b) => ({ ...b, registrationCount: 0 }),
    });
  }
  if (base.outcome.kind === 'invalid_dpop_proof') {
    candidates.push({
      id: 'token:accept-bad-dpop-proof',
      custom: (b) => ({ ...b, outcome: { kind: 'success' } }),
    });
  }
  // Every case must carry at least one witness: a row that ends in any non-success
  // outcome still discriminates an oracle that would wrongly claim the request.
  if (base.outcome.kind !== 'success') {
    candidates.push({
      id: 'token:derive-claims-wrong-tenant',
      custom: (b) => ({ ...b, outcome: { kind: 'invalid_grant' } }),
    });
  }
  return candidates;
}

function tbMutationIds(row: Row): string[] {
  const base = decideTokenB(row);
  const baseSignature = tbDecisionSignature(base);
  const ids = tbMutationCandidates(row)
    .filter((candidate) => {
      const mutant = candidate.mutantRow
        ? decideTokenB(candidate.mutantRow)
        : candidate.custom!(base);
      return tbDecisionSignature(mutant) !== baseSignature;
    })
    .map((candidate) => candidate.id);
  return ids.length > 0 ? ids : ['token:derive-claims-wrong-tenant'];
}

export function buildTokenBCaseTable(): TokenBCase[] {
  const rows = generateCoveringArray({
    dimensionOrder: [...TB_DIMENSION_ORDER],
    values: TB_VALUES,
    constraints: TB_CONSTRAINTS,
    selectedTriples: TB_SELECTED_TRIPLES,
  });
  const cases = rows.map((row, index) => {
    const id = deriveCaseId('token-b', index + 1);
    return {
      id,
      title: `binding=${row.codeBinding}, pkce=${row.pkce}, redirect=${row.redirect}, resource=${row.resource}, dpop=${row.dpop}, downstream=${row.downstream}, replay=${row.replayState}, jti=${row.jtiState}`,
      dimensions: { ...row },
      codeBinding: row.codeBinding,
      pkce: row.pkce,
      redirect: row.redirect,
      resource: row.resource,
      dpop: row.dpop,
      downstream: row.downstream,
      replayState: row.replayState,
      jtiState: row.jtiState,
      fingerprint: semanticFingerprint({ ...row }),
      mutationIds: tbMutationIds(row),
    };
  });
  return appendTbSuccessRows(cases);
}

/**
 * The greedy covering array places every (codeBinding, pkce, dpop) and
 * (redirect, resource, replayState) legal triple with failing or replay rows, so a
 * genuine issuance success path is never selected. Append one success row per binding
 * shape that must actually issue tokens (including the DPoP-bound and PKCE+DPoP shapes
 * needed by the claim oracle), plus one authenticated-replay row per registered-JTI
 * state so every derived (replayState, jtiState, revocationOutcome) combination is
 * observed. Rows the generator already placed are skipped.
 */
function appendTbSuccessRows(cases: TokenBCase[]): TokenBCase[] {
  const seen = new Set(cases.map((entry) => entry.fingerprint));
  const successShapes: Array<{ codeBinding: string; pkce: string; dpop: string }> = [
    { codeBinding: 'none', pkce: 'valid', dpop: 'absent' },
    { codeBinding: 'pkce', pkce: 'valid', dpop: 'absent' },
    { codeBinding: 'dpop', pkce: 'valid', dpop: 'valid' },
    { codeBinding: 'pkce+dpop', pkce: 'valid', dpop: 'valid' },
    { codeBinding: 'none', pkce: 'valid', dpop: 'valid' },
    { codeBinding: 'none', pkce: 'valid', dpop: 'different-key' },
  ];
  const replayJtiStates = ['none', 'access', 'access+refresh'];
  const appended: TokenBCase[] = [];
  const appendRow = (row: Row): void => {
    const fingerprint = semanticFingerprint({ ...row });
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    const index = cases.length + appended.length + 1;
    appended.push({
      id: deriveCaseId('token-b', index + 1),
      title: `binding=${row.codeBinding}, pkce=${row.pkce}, redirect=${row.redirect}, resource=${row.resource}, dpop=${row.dpop}, downstream=${row.downstream}, replay=${row.replayState}, jti=${row.jtiState}`,
      dimensions: { ...row },
      codeBinding: row.codeBinding,
      pkce: row.pkce,
      redirect: row.redirect,
      resource: row.resource,
      dpop: row.dpop,
      downstream: row.downstream,
      replayState: row.replayState,
      jtiState: row.jtiState,
      fingerprint,
      mutationIds: tbMutationIds(row),
    });
  };
  for (const shape of successShapes) {
    appendRow({
      codeBinding: shape.codeBinding,
      pkce: shape.pkce,
      redirect: 'exact',
      resource: 'omitted-default',
      dpop: shape.dpop,
      downstream: 'success',
      replayState: 'fresh',
      jtiState: 'none',
    });
  }
  for (const jtiState of replayJtiStates) {
    appendRow({
      codeBinding: 'none',
      pkce: 'valid',
      redirect: 'exact',
      resource: 'omitted-default',
      dpop: 'absent',
      downstream: 'success',
      replayState: 'used',
      jtiState,
    });
  }
  return [...cases, ...appended];
}

export const TB_CASE_TABLE = buildTokenBCaseTable();
export const EXPECTED_TB_CASE_COUNT = TB_CASE_TABLE.length;

// =============================================================================
// Independent decision tables (T-A and T-B)
// =============================================================================

export type TokenOutcome =
  | { kind: 'success' }
  | { kind: 'invalid_client' }
  | { kind: 'invalid_grant'; description?: string }
  | { kind: 'invalid_request' }
  | { kind: 'invalid_target' }
  | { kind: 'invalid_dpop_proof' }
  | { kind: 'use_dpop_nonce' }
  | { kind: 'server_error' };

export interface TokenADecision {
  authResult: 'success' | 'invalid_client';
  outcome: TokenOutcome;
  codeConsumed: boolean;
  revocationCount: number;
}

export function taDecisionSignature(decision: TokenADecision): string {
  return JSON.stringify(decision);
}

export function decideTokenA(row: Row): TokenADecision {
  const authSuccess = taAuthSuccess(row.registeredMethod, row.presented, row.client);
  if (!authSuccess) {
    return {
      authResult: 'invalid_client',
      outcome: { kind: 'invalid_client' },
      codeConsumed: false,
      revocationCount: 0,
    };
  }
  // A malformed code is rejected by validateAuthCode (token.ts:1646-1655) before any
  // tenant-scoped consume, even for a foreign request tenant.
  if (String(row.codeState) === 'malformed') {
    return {
      authResult: 'success',
      outcome: { kind: 'invalid_grant' },
      codeConsumed: false,
      revocationCount: 0,
    };
  }
  if (row.requestTenant === 'foreign') {
    // The code lives in a store the request tenant never reads, so the consume RPC is
    // still reached and fails (token.ts:1904-1913, consume at 1929-1944 against the
    // request-tenant instance) — ledger-observable, no code transition.
    return {
      authResult: 'success',
      outcome: { kind: 'invalid_grant' },
      codeConsumed: true,
      revocationCount: 0,
    };
  }
  switch (String(row.codeState)) {
    case 'fresh':
      return {
        authResult: 'success',
        outcome: { kind: 'success' },
        codeConsumed: true,
        revocationCount: 0,
      };
    case 'consumed':
    case 'expired':
    case 'wrong-client':
    case 'wrong-tenant':
    case 'replayed':
      // The consume RPC is reached and fails (already consumed / expired / mismatch /
      // replay classification), so it is ledger-observable.
      return {
        authResult: 'success',
        outcome: { kind: 'invalid_grant' },
        codeConsumed: true,
        revocationCount: row.codeState === 'replayed' ? 2 : 0,
      };
    default:
      throw new Error(`Unknown T-A codeState: ${String(row.codeState)}`);
  }
}

export interface TokenBDecision {
  outcome: TokenOutcome;
  codeConsumed: boolean;
  replayReached: boolean;
  revocationCount: number;
  registrationCount: number;
  familyCreated: boolean;
  accessTokenIssued: boolean;
  idTokenIssued: boolean;
  refreshTokenIssued: boolean;
  cnfBound: boolean;
}

export function tbDecisionSignature(decision: TokenBDecision): string {
  return JSON.stringify(decision);
}

export function decideTokenB(row: Row): TokenBDecision {
  const codeBinding = String(row.codeBinding);
  const dpop = String(row.dpop);
  const pkce = String(row.pkce);
  const redirect = String(row.redirect);
  const resource = String(row.resource);
  const downstream = String(row.downstream);
  const replayState = String(row.replayState);
  const jtiState = String(row.jtiState);
  const bindingValid = tbBindingValid(row);
  const replayReached = replayState === 'used' && bindingValid;
  const revocations = tbRevocationOutcome(row);
  const revocationCount = revocations === 'access+refresh' ? 2 : revocations === 'access' ? 1 : 0;

  const base: TokenBDecision = {
    outcome: { kind: 'success' },
    codeConsumed: false,
    replayReached,
    revocationCount,
    registrationCount: 0,
    familyCreated: false,
    accessTokenIssued: false,
    idTokenIssued: false,
    refreshTokenIssued: false,
    cnfBound: false,
  };

  // Order follows token.ts: redirect format (1668-1675), DPoP proof validation
  // (1763-1785), audience resolution (1851-1872), consume (1929-2077).
  if (redirect === 'omitted') {
    return { ...base, outcome: { kind: 'invalid_request' } };
  }
  if (redirect === 'malformed') {
    return { ...base, outcome: { kind: 'invalid_request' } };
  }
  if (dpop === 'malformed') {
    return { ...base, outcome: { kind: 'invalid_dpop_proof' } };
  }
  if (dpop === 'replayed') {
    // A reused proof jti makes the DPoP JTI store reject with 400, which the handler maps
    // to use_dpop_nonce (dpop.ts:361-375, token.ts:863-875).
    return { ...base, outcome: { kind: 'use_dpop_nonce' } };
  }
  if (resource === 'changed' || resource === 'conflict' || resource === 'disallowed') {
    return { ...base, outcome: { kind: 'invalid_target' } };
  }
  if (!bindingValid) {
    // PKCE mismatch/format failure, redirect mismatch, DPoP key mismatch/proof-required
    // all fail inside consumeCodeRpc before the used/replay classification and never
    // transition the code to used (AuthorizationCodeStore.consumeCodeRpc:686-703).
    return { ...base, codeConsumed: true, outcome: { kind: 'invalid_grant' } };
  }
  if (replayReached) {
    // Authenticated replay: the consume RPC is reached, the code is NOT transitioned to
    // used again, and the registered JTIs are revoked (AuthorizationCodeStore:705-761,
    // token.ts:1948-2000).
    return {
      ...base,
      codeConsumed: true,
      outcome: { kind: 'invalid_grant' },
      revocationCount,
    };
  }

  // Fresh code with valid bindings: consume succeeds, then the downstream phase runs.
  base.codeConsumed = true;
  if (downstream === 'signing') {
    return { ...base, outcome: { kind: 'server_error' } };
  }
  if (downstream === 'family') {
    return { ...base, outcome: { kind: 'server_error' }, familyCreated: false };
  }
  if (downstream === 'registration') {
    // The raced registration is attempted (one RPC call) but rejected, revoking the
    // tokens issued by this request (token.ts:3003-3036). Issuance (including the
    // refresh family) completed before the registration step, so the family exists.
    return {
      ...base,
      outcome: { kind: 'invalid_grant' },
      registrationCount: 1,
      familyCreated: true,
      accessTokenIssued: true,
      idTokenIssued: true,
      refreshTokenIssued: true,
      revocationCount: 2,
    };
  }
  if (downstream === 'revocation') {
    // Constrained to replay rows; revoked nothing because the revocation store failed.
    return { ...base, outcome: { kind: 'invalid_grant' }, revocationCount: 0 };
  }
  return {
    ...base,
    outcome: { kind: 'success' },
    registrationCount: 1,
    familyCreated: true,
    accessTokenIssued: true,
    idTokenIssued: true,
    refreshTokenIssued: true,
    cnfBound: codeBinding.includes('dpop') || dpop === 'valid' || dpop === 'different-key',
  };
}
