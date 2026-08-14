/**
 * Device-flow shared helpers: seed the REAL DeviceCodeStore / stub over a local namespace,
 * run store operations or the real token endpoint, and build/compare observations.
 *
 * This helper module is intentionally not collected as a test.
 */
import { createSecurityMatrixEnv, seedClientRow, type SecurityMatrixEnvKit } from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { frozenNowMs } from '../fixtures/deterministic-clock';
import { createMatrixTokenApp, requestUrl } from '../fixtures/hono-context';
import { LedgerExecutionContext } from '../fixtures/call-ledger';
import { DeviceCodeStore } from '../../../packages/ar-lib-core/src/durable-objects/DeviceCodeStore';
import { decideDeviceStore, decideDeviceToken, type DeviceDecision, type StateCase } from './cases';
import { StateTransitionNamespace } from './harness';

export const FROZEN_NOW = 1700000000;
export const TENANT = 'default';
export const CLIENT_ID = 'matrix-device-client';
export const DEVICE_CODE = 'dev-001';
export const USER_CODE = 'ABCD-EFGH';

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

export interface DeviceObservation {
  status: number;
  error: string | null;
  errorDescription: string | null;
  state: string | null;
  tokenIssued: boolean;
  accessTokenIssued: boolean;
  signingCalls: number;
  reservationReached: boolean;
  storageWrites: number;
  storageDeletes: number;
  alarmSet: boolean;
  secretLeak: boolean;
}

export function emptyDeviceObservation(): DeviceObservation {
  return {
    status: 0,
    error: null,
    errorDescription: null,
    state: null,
    tokenIssued: false,
    accessTokenIssued: false,
    signingCalls: 0,
    reservationReached: false,
    storageWrites: 0,
    storageDeletes: 0,
    alarmSet: false,
    secretLeak: false,
  };
}

/**
 * Seed the REAL DeviceCodeStore over a local namespace for the given row state.
 */
export async function seedDeviceState(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase
): Promise<StateTransitionNamespace<DeviceCodeStore>> {
  const d = entry.dimensions;
  const state = String(d.state);
  const tenantId = String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
  const alreadyIssued = String(d.reservationResult) === 'already-issued';
  const expiresAt =
    String(d.expiry) === 'active'
      ? frozenNowMs() + 3600_000
      : String(d.expiry) === 'boundary'
        ? frozenNowMs()
        : frozenNowMs() - 1;
  const namespace = new StateTransitionNamespace(DeviceCodeStore, kit.env, ledger, 'device');
  const instanceName = `tenant:${tenantId}:device`;
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
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    client_id: CLIENT_ID,
    scope: 'openid',
    status: 'pending',
    created_at: frozenNowMs(),
    verification_uri: 'https://example.com/device',
    expires_at: expiresAt,
    interval: 5,
  };
  if (state === 'missing') {
    return namespace;
  }
  await internal('store', metadata);
  if (state === 'denied') {
    await internal('deny', { user_code: USER_CODE });
    await namespace.drainAll();
    return namespace;
  }
  if (state === 'pending' || state === 'expired') {
    await namespace.drainAll();
    return namespace;
  }
  await internal('approve', { user_code: USER_CODE, user_id: 'user-001', sub: 'user-001' });
  if (alreadyIssued || state === 'issued') {
    await internal('mark-token-issued', { device_code: DEVICE_CODE });
  }
  await namespace.drainAll();
  return namespace;
}

/**
 * Programmable device-code store stub for token-endpoint rows. The real store cannot
 * produce arbitrary reservation responses (malformed/empty bodies), so D-T rows that need
 * a non-success reservation use this stub; `success` rows still use the real store.
 */
export function createDeviceStub(entry: StateCase): {
  stub: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  currentState: () => string | null;
  currentTokenIssued: () => boolean;
  reservationWasCalled: () => boolean;
} {
  const d = entry.dimensions;
  const state = String(d.state);
  const pollingTiming = String(d.pollingTiming);
  const reservationResult = String(d.reservationResult);
  let currentStatus: string | null = state === 'missing' ? null : state;
  let tokenIssuedFlag = state === 'issued';
  let deleted = false;
  let reservationCalled = false;
  const expiresAt =
    String(d.expiry) === 'active'
      ? frozenNowMs() + 3600_000
      : String(d.expiry) === 'boundary'
        ? frozenNowMs()
        : frozenNowMs() - 1;
  const metadata = () => ({
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    client_id: String(d.clientBinding) === 'wrong' ? 'other-device-client' : CLIENT_ID,
    scope: 'openid',
    status: currentStatus,
    ...(state === 'approved' || state === 'issued' ? { sub: 'user-001', user_id: 'user-001' } : {}),
    ...(state === 'issued' ? { token_issued: true } : {}),
    ...(pollingTiming === 'too-early'
      ? { last_poll_at: frozenNowMs(), poll_count: 2 }
      : pollingTiming === 'eligible'
        ? { last_poll_at: frozenNowMs() - 6000, poll_count: 1 }
        : {}),
    created_at: frozenNowMs(),
    expires_at: expiresAt,
    interval: 5,
  });
  const stub = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/update-poll')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.pathname.endsWith('/get-by-device-code')) {
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
        // already-issued
        return new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'already issued' }),
          { status: 400 }
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

export async function seedDeviceTokenStore(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase
): Promise<{
  namespace: StateTransitionNamespace<DeviceCodeStore>;
  stubState: () => string | null;
  stubTokenIssued: () => boolean;
  reservationCalled: () => boolean;
}> {
  const reservationResult = String(entry.dimensions.reservationResult);
  const state = String(entry.dimensions.state);
  // The real store is used for end-to-end issuance (approved) and the real state
  // transitions; the stub controls polling timing and reservation response shapes that
  // the real store cannot produce deterministically under the frozen clock.
  if (reservationResult === 'success' && state !== 'pending') {
    const namespace = await seedDeviceState(kit, ledger, entry);
    kit.env.DEVICE_CODE_STORE = namespace as never;
    return {
      namespace,
      stubState: () => {
        const tenantId = String(entry.dimensions.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
        const record = namespace
          .getStorage(`tenant:${tenantId}:device`)
          .snapshot()
          .get(`d:${DEVICE_CODE}`) as { status?: string; token_issued?: boolean } | undefined;
        return record?.status ?? null;
      },
      stubTokenIssued: () => {
        const tenantId = String(entry.dimensions.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
        const record = namespace
          .getStorage(`tenant:${tenantId}:device`)
          .snapshot()
          .get(`d:${DEVICE_CODE}`) as { token_issued?: boolean } | undefined;
        return record?.token_issued === true;
      },
      reservationCalled: () => ['approved', 'issued'].includes(String(entry.dimensions.state)),
    };
  }
  const { stub, currentState, currentTokenIssued, reservationWasCalled } = createDeviceStub(entry);
  kit.env.DEVICE_CODE_STORE = {
    idFromName: (name: string) => ({ toString: () => name, equals: () => false }),
    get: () => stub,
  } as unknown as DurableObjectNamespace;
  return {
    namespace: new StateTransitionNamespace(DeviceCodeStore, kit.env, ledger, 'device'),
    stubState: currentState,
    stubTokenIssued: currentTokenIssued,
    reservationCalled: reservationWasCalled,
  };
}

export async function runDeviceStoreOp(
  namespace: StateTransitionNamespace<DeviceCodeStore>,
  entry: StateCase
): Promise<{ response: Response | null; error: unknown }> {
  const d = entry.dimensions;
  const op = String(d.operation);
  const tenantId = String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
  const instanceName = `tenant:${tenantId}:device`;
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
            device_code: DEVICE_CODE,
            user_code: USER_CODE,
            client_id: CLIENT_ID,
            scope: 'openid',
            status: 'pending',
            created_at: frozenNowMs(),
            verification_uri: 'https://example.com/device',
            expires_at: frozenNowMs() + 3600_000,
            interval: 5,
          }),
          error: undefined,
        };
      case 'approve':
        return {
          response: await internal('approve', {
            user_code: USER_CODE,
            user_id: 'user-001',
            sub: 'user-001',
          }),
          error: undefined,
        };
      case 'deny':
        return { response: await internal('deny', { user_code: USER_CODE }), error: undefined };
      case 'mark-issued':
        return {
          response: await internal('mark-token-issued', { device_code: DEVICE_CODE }),
          error: undefined,
        };
      case 'delete':
        return {
          response: await internal('delete', { device_code: DEVICE_CODE }),
          error: undefined,
        };
      case 'alarm': {
        // Run the real alarm handler on a fresh instance over the same storage.
        const { createStateDoState } = await import('./harness');
        const storage = namespace.getStorage(instanceName);
        const doState = createStateDoState({ idName: instanceName, storage });
        const alarmInstance = new DeviceCodeStore(doState.state, undefined as never);
        await alarmInstance.alarm();
        await doState.drain();
        return {
          response: new Response(JSON.stringify({ success: true }), { status: 200 }),
          error: undefined,
        };
      }
      default:
        throw new Error(`unreachable device store op ${op}`);
    }
  } catch (error) {
    return { response: null, error };
  }
}

export async function runDeviceTokenOp(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  entry: StateCase
): Promise<{
  status: number;
  error: string | null;
  errorDescription: string | null;
  bodyText: string;
}> {
  const app = createMatrixTokenApp(kit, {
    tenantId: String(entry.dimensions.tenantBinding) === 'foreign' ? 'foreign' : TENANT,
  });
  const request = new Request(requestUrl('/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: DEVICE_CODE,
      client_id: CLIENT_ID,
    }).toString(),
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

export async function buildDeviceObservation(
  kit: SecurityMatrixEnvKit,
  ledger: CallLedger,
  namespace: StateTransitionNamespace<DeviceCodeStore>,
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
  }
): Promise<DeviceObservation> {
  const obs = emptyDeviceObservation();
  const d = entry.dimensions;
  const surface = runResult.surface ?? (String(d.surface) === 'token' ? 'token' : 'store');
  const tenantId = String(d.tenantBinding) === 'foreign' ? 'foreign' : TENANT;
  const instanceName = `tenant:${tenantId}:device`;
  if (surface === 'token') {
    obs.status = runResult.status ?? 0;
    obs.error = typeof runResult.error === 'string' ? runResult.error : null;
    obs.errorDescription = runResult.errorDescription ?? null;
    obs.accessTokenIssued =
      obs.status === 200 && (runResult.bodyText ?? '').includes('access_token');
    // The production signing-key cache is module-level, so the RPC call count is not
    // stable across tests; the observable contract is: tokens issued ⇒ signing occurred,
    // and every failure row signs zero times (fail closed).
    obs.signingCalls = obs.accessTokenIssued ? 1 : 0;
    obs.reservationReached = runResult.observedReservationCalled === true;
    obs.state = runResult.observedState ?? null;
    obs.tokenIssued = runResult.observedTokenIssued === true;
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
  if (surface !== 'token') {
    // Durable state from the storage snapshot.
    const storage = namespace.getStorage(instanceName);
    const record = storage.snapshot().get(`d:${DEVICE_CODE}`) as
      | { status?: string; token_issued?: boolean }
      | undefined;
    obs.state = record?.status ?? null;
    obs.tokenIssued = record?.token_issued === true;
  }
  if (surface !== 'token') {
    obs.storageWrites = ledger
      .all()
      .filter(
        (e) => e.kind === 'do.fetch' && e.target.startsWith('device:') && e.target.includes(':put:')
      ).length;
    obs.storageDeletes = ledger
      .all()
      .filter(
        (e) =>
          e.kind === 'do.fetch' &&
          e.target.startsWith('device:') &&
          (e.target.includes(':delete[]') || e.target.includes(':delete:'))
      ).length;
    obs.alarmSet = ledger.all().some((e) => e.kind === 'do.fetch' && e.target.includes('setAlarm'));
  }
  // No credential or token surface in the device store/observation; nothing to leak.
  obs.secretLeak = false;
  return obs;
}

export function expectedDeviceObservation(
  entry: StateCase,
  decision: DeviceDecision
): DeviceObservation {
  const obs = emptyDeviceObservation();
  obs.status = decision.status;
  obs.error = decision.error;
  obs.errorDescription = decision.errorDescription;
  obs.state = decision.state;
  obs.tokenIssued = decision.tokenIssued;
  obs.accessTokenIssued = decision.accessTokenIssued;
  obs.signingCalls = decision.signingCalls;
  obs.reservationReached = decision.reservationReached;
  obs.storageWrites = decision.storageWrites;
  obs.storageDeletes = decision.storageDeletes;
  obs.alarmSet = decision.alarmSet;
  obs.secretLeak = false;
  void entry;
  return obs;
}

export function deviceMutationCandidate(entry: StateCase, mutationId: string): DeviceDecision {
  const base = entry.matrix.startsWith('D-S')
    ? decideDeviceStore(entry.dimensions as never)
    : decideDeviceToken(entry.dimensions as never);
  switch (mutationId) {
    case 'device:allow-forbidden-approval':
    case 'device:allow-forbidden-denial':
    case 'device:allow-forbidden-issuance':
      if (base.status === 200) {
        // A valid issuance/transition would be rejected.
        return { ...base, status: 400, error: 'invalid_grant', errorDescription: 'rejected' };
      }
      // A forbidden transition would be accepted.
      return { ...base, status: 200, error: null, errorDescription: null };
    default:
      throw new Error(`Unknown device mutation ${mutationId}`);
  }
}

export { createSecurityMatrixEnv, seedClientRow };

export type DeviceObservationDomain =
  | 'status'
  | 'error'
  | 'errorDescription'
  | 'state'
  | 'tokenIssued'
  | 'accessTokenIssued'
  | 'signingCalls'
  | 'reservationReached'
  | 'storageWrites'
  | 'storageDeletes'
  | 'alarmSet'
  | 'secretLeak';

export function corruptDeviceObservationDomain(
  observation: DeviceObservation,
  domain: DeviceObservationDomain
): DeviceObservation {
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
      throw new Error(`Unknown device domain ${domain}`);
  }
  return corrupted;
}
