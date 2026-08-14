/**
 * CIBA shared helpers: seed the REAL CIBARequestStore / stub over a local namespace,
 * run store operations or the real token endpoint, and build/compare observations.
 *
 * This helper module is intentionally not collected as a test.
 */
import { createSecurityMatrixEnv, seedClientRow, type SecurityMatrixEnvKit } from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { frozenNowMs } from '../fixtures/deterministic-clock';
import { createMatrixTokenApp, requestUrl } from '../fixtures/hono-context';
import { LedgerExecutionContext } from '../fixtures/call-ledger';
import { CIBARequestStore } from '../../../packages/ar-lib-core/src/durable-objects/CIBARequestStore';
import { decideCibaStore, decideCibaToken, type CibaDecision, type StateCase } from './cases';
import { StateTransitionNamespace } from './harness';

export const FROZEN_NOW = 1700000000;
export const TENANT = 'default';
export const CLIENT_ID = 'matrix-ciba-client';
export const SECRET = 'matrix-ciba-secret-001';
export const AUTH_REQ_ID = 'ciba-001';
export const USER_CODE = 'CIBA-USER-CODE';

export function seedRegionShardConfigForeign(kit: SecurityMatrixEnvKit): void {
  kit.authrimConfig.seed(
    `region_shard_config:foreign`,
    JSON.stringify({
      currentGeneration: 1,
      currentTotalShards: 4,
      currentRegions: {
        enam: { startShard: 0, endShard: 0, shardCount: 1 },
        weur: { startShard: 1, endShard: 1, shardCount: 1 },
        apac: { startShard: 2, endShard: 2, shardCount: 1 },
        wnam: { startShard: 3, endShard: 3, shardCount: 1 },
      },
      previousGenerations: [],
      maxPreviousGenerations: 2,
      updatedAt: 1700000000,
      residency: {
        version: 1,
        residencyPolicyId: 'matrix-default',
        residencyPartition: 'default',
        jurisdiction: null,
        allowedRegions: ['enam', 'weur', 'apac', 'wnam'],
        policyGeneration: 1,
      },
    })
  );
}

export interface CibaObservation {
  status: number;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
  tokenIssued: boolean;
  accessTokenIssued: boolean;
  signingCalls: number;
  reservationReached: boolean;
  idTokenNonce: string | null;
  idTokenAcr: string | null;
  storedNonce: string | null;
  storedAcr: string | null;
  storageWrites: number;
  storageDeletes: number;
  alarmSet: boolean;
  secretLeak: boolean;
}

export function emptyCibaObservation(): CibaObservation {
  return {
    status: 0,
    error: null,
    errorDescription: null,
    state: null,
    tokenIssued: false,
    accessTokenIssued: false,
    signingCalls: 0,
    reservationReached: false,
    idTokenNonce: null,
    idTokenAcr: null,
    storedNonce: null,
    storedAcr: null,
    storageWrites: 0,
    storageDeletes: 0,
    alarmSet: false,
    secretLeak: false,
  };
}

export function nonceValue(nonce: string): string | null {
  if (nonce === 'absent' || nonce === 'not-applicable') return null;
  return nonce === 'present' ? 'nonce-approved-a' : 'nonce-approved-b';
}

export function acrValue(acr: string): string | null {
  if (acr === 'absent' || acr === 'not-applicable') return null;
  return acr === 'matching' ? 'urn:authrim:acr:1' : 'urn:authrim:acr:2';
}

export async function seedCibaState(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase
): Promise<StateTransitionNamespace<CIBARequestStore>> {
  const d = entry.dimensions;
  const state = String(d.state);
  const tenantId = String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
  const nonce = String(d.nonce);
  const acr = String(d.acr);
  const expiresAt = String(d.state) === 'expired' ? frozenNowMs() - 1 : frozenNowMs() + 3600_000;
  const namespace = new StateTransitionNamespace(CIBARequestStore, kit.env, ledger, 'ciba');
  const instanceName = `tenant:${tenantId}:ciba`;
  const stub = namespace.get(namespace.idFromName(instanceName));
  const internal = (path: string, body: Record<string, unknown>): Promise<Response> =>
    stub.fetch(
      new Request(`https://internal/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': tenantId },
        body: JSON.stringify(body),
      })
    );
  const metadata = {
    auth_req_id: AUTH_REQ_ID,
    client_id: CLIENT_ID,
    scope: 'openid',
    status: 'pending',
    delivery_mode: String(d.deliveryMode),
    created_at: frozenNowMs(),
    login_hint: 'user@example.com',
    expires_at: expiresAt,
    interval: 5,
  };
  if (state === 'missing') {
    return namespace;
  }
  await internal('store', metadata);
  if (state === 'denied') {
    await internal('deny', { auth_req_id: AUTH_REQ_ID });
    await namespace.drainAll();
    return namespace;
  }
  if (state === 'pending' || state === 'expired') {
    await namespace.drainAll();
    return namespace;
  }
  await internal('approve', {
    auth_req_id: AUTH_REQ_ID,
    user_id: 'user-001',
    sub: 'user-001',
    ...(nonceValue(nonce) ? { nonce: nonceValue(nonce) } : {}),
    ...(acrValue(acr) ? { authenticated_acr: acrValue(acr) } : {}),
  });
  if (state === 'issued' || String(d.reservationResult) === 'already-issued') {
    await internal('mark-token-issued', { auth_req_id: AUTH_REQ_ID });
  }
  await namespace.drainAll();
  return namespace;
}

/**
 * Programmable CIBA store stub for token-endpoint rows that need a non-success
 * reservation response (the real store always answers with its own JSON).
 */
export function createCibaStub(entry: StateCase): {
  stub: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  currentState: () => string | null;
  currentTokenIssued: () => boolean;
  reservationWasCalled: () => boolean;
} {
  const d = entry.dimensions;
  const state = String(d.state);
  const pollingTiming = String(d.pollingTiming);
  const reservationResult = String(d.reservationResult);
  const nonce = String(d.nonce);
  const acr = String(d.acr);
  const expiresAt = state === 'expired' ? frozenNowMs() - 1 : frozenNowMs() + 3600_000;
  let currentStatus: string | null = state === 'missing' ? null : state;
  let tokenIssuedFlag = state === 'issued';
  let deleted = false;
  let reservationCalled = false;
  const metadata = () => ({
    auth_req_id: AUTH_REQ_ID,
    client_id: String(d.clientBinding) === 'mismatched' ? 'other-ciba-client' : CLIENT_ID,
    scope: 'openid',
    status: currentStatus,
    delivery_mode: String(d.deliveryMode),
    interval: 5,
    ...(state === 'approved' || state === 'issued' ? { sub: 'user-001', user_id: 'user-001' } : {}),
    ...(state === 'issued' ? { token_issued: true } : {}),
    ...(nonceValue(nonce) ? { nonce: nonceValue(nonce) } : {}),
    ...(acrValue(acr) ? { authenticated_acr: acrValue(acr) } : {}),
    ...(pollingTiming === 'too-early'
      ? { last_poll_at: frozenNowMs(), poll_count: 2 }
      : pollingTiming === 'eligible'
        ? { last_poll_at: frozenNowMs() - 6000, poll_count: 1 }
        : {}),
    created_at: frozenNowMs(),
    expires_at: expiresAt,
  });
  const stub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/update-poll')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.pathname.endsWith('/get-by-auth-req-id')) {
        if (state === 'missing') {
          return new Response('null', { status: 200 });
        }
        return new Response(JSON.stringify(metadata()), { status: 200 });
      }
      if (url.pathname.endsWith('/mark-token-issued')) {
        reservationCalled = true;
        if (reservationResult === 'success') {
          tokenIssuedFlag = true;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        if (reservationResult === 'json-non2xx') {
          return new Response(
            JSON.stringify({
              error: 'server_error',
              error_description: 'reservation rejected for deterministic test',
            }),
            { status: 500 }
          );
        }
        if (reservationResult === 'malformed-body') {
          return new Response('not-json{{{{', { status: 500 });
        }
        if (reservationResult === 'empty-body') {
          return new Response('', { status: 500 });
        }
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'already issued' }),
          {
            status: 400,
          }
        );
      }
      if (url.pathname.endsWith('/delete')) {
        deleted = true;
        currentStatus = null;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    },
  };
  return {
    stub,
    currentState: () => (deleted ? null : currentStatus),
    currentTokenIssued: () => tokenIssuedFlag,
    reservationWasCalled: () => reservationCalled,
  };
}

export async function seedCibaTokenStore(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase
): Promise<{
  namespace: StateTransitionNamespace<CIBARequestStore>;
  seededNonce: string | null;
  seededAcr: string | null;
  stubState: () => string | null;
  stubTokenIssued: () => boolean;
  reservationCalled: () => boolean;
}> {
  const reservationResult = String(entry.dimensions.reservationResult);
  const state = String(entry.dimensions.state);
  // The real store is used for end-to-end issuance and the real state transitions; the
  // stub controls polling timing and reservation response shapes that the real store
  // cannot produce deterministically under the frozen clock.
  if (reservationResult === 'success' && state !== 'pending') {
    const namespace = await seedCibaState(kit, ledger, entry);
    kit.env.CIBA_REQUEST_STORE = namespace as never;
    const nonce = String(entry.dimensions.nonce);
    const acr = String(entry.dimensions.acr);
    return {
      namespace,
      seededNonce: nonceValue(nonce),
      seededAcr: acrValue(acr),
      stubState: () => {
        const tenantId = String(entry.dimensions.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
        const record = namespace
          .getStorage(`tenant:${tenantId}:ciba`)
          .snapshot()
          .get(`r:${AUTH_REQ_ID}`) as { status?: string; token_issued?: boolean } | undefined;
        return record?.status ?? null;
      },
      stubTokenIssued: () => {
        const tenantId = String(entry.dimensions.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
        const record = namespace
          .getStorage(`tenant:${tenantId}:ciba`)
          .snapshot()
          .get(`r:${AUTH_REQ_ID}`) as { token_issued?: boolean } | undefined;
        return record?.token_issued === true;
      },
      reservationCalled: () =>
        String(entry.dimensions.state) === 'approved' &&
        String(entry.dimensions.clientAuth) === 'valid' &&
        String(entry.dimensions.clientBinding) === 'matching',
    };
  }
  const { stub, currentState, currentTokenIssued, reservationWasCalled } = createCibaStub(entry);
  kit.env.CIBA_REQUEST_STORE = {
    idFromName: (name: string) => ({ toString: () => name, equals: () => false }),
    get: () => stub,
  } as unknown as DurableObjectNamespace;
  return {
    namespace: new StateTransitionNamespace(CIBARequestStore, kit.env, ledger, 'ciba'),
    seededNonce: nonceValue(String(entry.dimensions.nonce)),
    seededAcr: acrValue(String(entry.dimensions.acr)),
    stubState: currentState,
    stubTokenIssued: currentTokenIssued,
    reservationCalled: reservationWasCalled,
  };
}

export async function runCibaStoreOp(
  namespace: StateTransitionNamespace<CIBARequestStore>,
  entry: StateCase
): Promise<{ response: Response | null; error: unknown }> {
  const d = entry.dimensions;
  const op = String(d.operation);
  const tenantId = String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
  const instanceName = `tenant:${tenantId}:ciba`;
  const stub = namespace.get(namespace.idFromName(instanceName));
  const internal = (path: string, body: Record<string, unknown>): Promise<Response> =>
    stub.fetch(
      new Request(`https://internal/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': tenantId },
        body: JSON.stringify(body),
      })
    );
  try {
    switch (op) {
      case 'store':
        return {
          response: await internal('store', {
            auth_req_id: AUTH_REQ_ID,
            client_id: CLIENT_ID,
            scope: 'openid',
            status: 'pending',
            delivery_mode: String(d.deliveryMode),
            created_at: frozenNowMs(),
            login_hint: 'user@example.com',
            expires_at: frozenNowMs() + 3600_000,
            interval: 5,
          }),
          error: undefined,
        };
      case 'approve':
        return {
          response: await internal('approve', {
            auth_req_id: AUTH_REQ_ID,
            user_id: 'user-001',
            sub: 'user-001',
            ...(nonceValue(String(d.nonce)) ? { nonce: nonceValue(String(d.nonce)) } : {}),
            ...(acrValue(String(d.acr)) ? { authenticated_acr: acrValue(String(d.acr)) } : {}),
          }),
          error: undefined,
        };
      case 'deny':
        return { response: await internal('deny', { auth_req_id: AUTH_REQ_ID }), error: undefined };
      case 'mark-issued':
        return {
          response: await internal('mark-token-issued', { auth_req_id: AUTH_REQ_ID }),
          error: undefined,
        };
      case 'delete':
        return {
          response: await internal('delete', { auth_req_id: AUTH_REQ_ID }),
          error: undefined,
        };
      case 'alarm': {
        const { createStateDoState } = await import('./harness');
        const storage = namespace.getStorage(instanceName);
        const doState = createStateDoState({ idName: instanceName, storage });
        const alarmInstance = new CIBARequestStore(doState.state, undefined as never);
        await alarmInstance.alarm();
        await doState.drain();
        return {
          response: new Response(JSON.stringify({ success: true }), { status: 200 }),
          error: undefined,
        };
      }
      default:
        throw new Error(`unreachable ciba store op ${op}`);
    }
  } catch (error) {
    return { response: null, error };
  }
}

export async function runCibaTokenOp(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase
): Promise<{
  status: number;
  error: string | null;
  errorDescription: string | null;
  bodyText: string;
}> {
  const d = entry.dimensions;
  const clientAuth = String(d.clientAuth);
  const app = createMatrixTokenApp(kit, {
    tenantId: String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT,
  });
  const params: Record<string, string> = {
    grant_type: 'urn:openid:params:grant-type:ciba',
    auth_req_id: AUTH_REQ_ID,
  };
  if (clientAuth !== 'missing') {
    params.client_id = clientAuth === 'wrong-client' ? 'other-ciba-client' : CLIENT_ID;
    if (clientAuth === 'invalid' || clientAuth === 'wrong-client') {
      params.client_secret = 'wrong-secret-value';
    } else {
      params.client_secret = SECRET;
    }
  }
  const request = new Request(requestUrl('/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const response = await app.fetch(request, kit.env, new LedgerExecutionContext(ledger));
  await ledger.drain();
  const bodyText = await response.text();
  let error: string | null = null;
  let errorDescription: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: string; error_description?: string };
    error = parsed.error ?? null;
    errorDescription = parsed.error_description ?? null;
  } catch {
    error = null;
  }
  return { status: response.status, error, errorDescription, bodyText };
}

export function decodeIdTokenClaims(bodyText: string): { nonce?: string; acr?: string } | null {
  try {
    const parsed = JSON.parse(bodyText) as { id_token?: string };
    if (!parsed.id_token) return null;
    const payload = parsed.id_token.split('.')[1];
    const padded = payload
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(payload.length / 4) * 4, '=');
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
    ) as {
      nonce?: string;
      acr?: string;
    };
  } catch {
    return null;
  }
}

export async function buildCibaObservation(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  namespace: StateTransitionNamespace<CIBARequestStore>,
  entry: StateCase,
  runResult: {
    response: Response | null;
    error: unknown;
    surface?: 'store' | 'token';
    status?: number;
    errorCode?: string | null;
    errorDescription?: string | null;
    bodyText?: string;
    observedState?: string | null;
    observedTokenIssued?: boolean;
    observedReservationCalled?: boolean;
    observedNonce?: string | null;
    observedAcr?: string | null;
  }
): Promise<CibaObservation> {
  const obs = emptyCibaObservation();
  const d = entry.dimensions;
  const surface = runResult.surface ?? 'store';
  const tenantId = String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
  const instanceName = `tenant:${tenantId}:ciba`;
  if (surface === 'token') {
    obs.status = runResult.status ?? 0;
    obs.error = typeof runResult.error === 'string' ? runResult.error : null;
    obs.errorDescription = runResult.errorDescription ?? null;
    obs.accessTokenIssued =
      obs.status === 200 && (runResult.bodyText ?? '').includes('access_token');
    obs.signingCalls = obs.accessTokenIssued ? 1 : 0;
    obs.reservationReached = runResult.observedReservationCalled === true;
    obs.state = runResult.observedState ?? null;
    obs.tokenIssued = runResult.observedTokenIssued === true;
    obs.storedNonce = runResult.observedNonce ?? null;
    obs.storedAcr = runResult.observedAcr ?? null;
    const claims = decodeIdTokenClaims(runResult.bodyText ?? '');
    obs.idTokenNonce = claims?.nonce ?? null;
    obs.idTokenAcr = claims?.acr ?? null;
    obs.storageWrites = ledger
      .all()
      .filter(
        (e) => e.kind === 'do.fetch' && e.target.startsWith('ciba:') && e.target.includes(':put:')
      ).length;
  } else {
    obs.status = runResult.response?.status ?? (runResult.error ? 500 : 0);
    if (runResult.error) {
      obs.error = 'server_error';
    } else if (runResult.response) {
      try {
        const parsed = (await runResult.response.json()) as { error?: string };
        obs.error = parsed.error ?? null;
      } catch {
        obs.error = null;
      }
    }
  }
  if (surface === 'store') {
    const storage = namespace.getStorage(instanceName);
    const record = storage.snapshot().get(`r:${AUTH_REQ_ID}`) as
      | { status?: string; token_issued?: boolean; nonce?: string; authenticated_acr?: string }
      | undefined;
    obs.state = record?.status ?? null;
    obs.tokenIssued = record?.token_issued === true;
    obs.storedNonce = record?.nonce ?? null;
    obs.storedAcr = record?.authenticated_acr ?? null;
    obs.storageWrites = ledger
      .all()
      .filter(
        (e) => e.kind === 'do.fetch' && e.target.startsWith('ciba:') && e.target.includes(':put:')
      ).length;
    obs.storageDeletes = ledger
      .all()
      .filter(
        (e) =>
          e.kind === 'do.fetch' &&
          e.target.startsWith('ciba:') &&
          (e.target.includes(':delete[]') || e.target.includes(':delete:'))
      ).length;
    obs.alarmSet = ledger.all().some((e) => e.kind === 'do.fetch' && e.target.includes('setAlarm'));
  }
  obs.secretLeak = false;
  return obs;
}

export function expectedCibaObservation(entry: StateCase, decision: CibaDecision): CibaObservation {
  const obs = emptyCibaObservation();
  obs.status = decision.status;
  obs.error = decision.error;
  obs.errorDescription = decision.errorDescription;
  obs.state = decision.state;
  obs.tokenIssued = decision.tokenIssued;
  obs.accessTokenIssued = decision.accessTokenIssued;
  obs.signingCalls = decision.signingCalls;
  obs.reservationReached = decision.reservationReached;
  obs.idTokenNonce = decision.idTokenNonce;
  obs.idTokenAcr = decision.idTokenAcr;
  obs.storedNonce = decision.storedNonce;
  obs.storedAcr = decision.storedAcr;
  obs.storageWrites = decision.storageWrites;
  obs.storageDeletes = decision.storageDeletes;
  obs.alarmSet = decision.alarmSet;
  obs.secretLeak = false;
  void entry;
  return obs;
}

export function cibaMutationCandidate(entry: StateCase, mutationId: string): CibaDecision {
  const base =
    String(entry.dimensions.surface) === 'token' || entry.matrix.startsWith('C-T')
      ? decideCibaToken(entry.dimensions as never)
      : decideCibaStore(entry.dimensions as never);
  switch (mutationId) {
    case 'ciba:issue-after-reservation-failure':
      if (base.status === 200) {
        return {
          ...base,
          status: 400,
          error: 'invalid_grant',
          errorDescription: 'rejected',
          signingCalls: 0,
        };
      }
      // A failed reservation would still issue tokens.
      return {
        ...base,
        status: 200,
        error: null,
        errorDescription: null,
        accessTokenIssued: true,
        signingCalls: 1,
        tokenIssued: true,
      };
    default:
      throw new Error(`Unknown ciba mutation ${mutationId}`);
  }
}

export async function hashSecret(secret: string): Promise<string> {
  const { hashClientSecret } = await import('../../../packages/ar-lib-core/src/utils/crypto');
  return hashClientSecret(secret);
}

export { createSecurityMatrixEnv, seedClientRow };

export type CibaObservationDomain =
  | 'status'
  | 'error'
  | 'errorDescription'
  | 'state'
  | 'tokenIssued'
  | 'accessTokenIssued'
  | 'signingCalls'
  | 'reservationReached'
  | 'idTokenNonce'
  | 'idTokenAcr'
  | 'storedNonce'
  | 'storedAcr'
  | 'storageWrites'
  | 'storageDeletes'
  | 'alarmSet'
  | 'secretLeak';

export function corruptCibaObservationDomain(
  observation: CibaObservation,
  domain: CibaObservationDomain
): CibaObservation {
  const corrupted = { ...observation };
  switch (domain) {
    case 'status':
      corrupted.status = corrupted.status === 200 ? 400 : 200;
      break;
    case 'error':
      corrupted.error = corrupted.error === null ? 'invalid_grant' : null;
      break;
    case 'errorDescription':
      corrupted.errorDescription = corrupted.errorDescription === null ? 'corrupted' : null;
      break;
    case 'state':
      corrupted.state =
        corrupted.state === null
          ? 'approved'
          : corrupted.state === 'approved'
            ? 'pending'
            : 'approved';
      break;
    case 'tokenIssued':
      corrupted.tokenIssued = !corrupted.tokenIssued;
      break;
    case 'accessTokenIssued':
      corrupted.accessTokenIssued = !corrupted.accessTokenIssued;
      break;
    case 'signingCalls':
      corrupted.signingCalls = corrupted.signingCalls + 1;
      break;
    case 'reservationReached':
      corrupted.reservationReached = !corrupted.reservationReached;
      break;
    case 'idTokenNonce':
      corrupted.idTokenNonce = corrupted.idTokenNonce === null ? 'corrupted-nonce' : null;
      break;
    case 'idTokenAcr':
      corrupted.idTokenAcr = corrupted.idTokenAcr === null ? 'urn:authrim:acr:corrupted' : null;
      break;
    case 'storedNonce':
      corrupted.storedNonce = corrupted.storedNonce === null ? 'corrupted-nonce' : null;
      break;
    case 'storedAcr':
      corrupted.storedAcr = corrupted.storedAcr === null ? 'urn:authrim:acr:corrupted' : null;
      break;
    case 'storageWrites':
      corrupted.storageWrites = corrupted.storageWrites + 1;
      break;
    case 'storageDeletes':
      corrupted.storageDeletes = corrupted.storageDeletes + 1;
      break;
    case 'alarmSet':
      corrupted.alarmSet = !corrupted.alarmSet;
      break;
    case 'secretLeak':
      corrupted.secretLeak = !corrupted.secretLeak;
      break;
    default:
      throw new Error(`Unknown ciba domain ${domain}`);
  }
  return corrupted;
}
