import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import { DeviceCodeStore } from '../../../packages/ar-lib-core/src/durable-objects/DeviceCodeStore';
import { CIBARequestStore } from '../../../packages/ar-lib-core/src/durable-objects/CIBARequestStore';
import { parseRefreshTokenJti } from '../../../packages/ar-lib-core/src/utils/refresh-token-sharding';
import {
  createSecurityMatrixEnv,
  seedClientRow,
  seedRegionShardConfig,
  type SecurityMatrixEnvKit,
} from '../fixtures/env';
import { CallLedger, LedgerExecutionContext } from '../fixtures/call-ledger';
import { createMatrixTokenApp, requestUrl } from '../fixtures/hono-context';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import {
  CIBA_TOKEN_CASE_TABLE,
  DEVICE_TOKEN_CASE_TABLE,
  decideCibaToken,
  decideDeviceToken,
} from '../state-transition-matrix/cases';
import { StateTransitionNamespace } from '../state-transition-matrix/harness';
import {
  CLIENT_ID as DEVICE_CLIENT_ID,
  DEVICE_CODE,
  USER_CODE as DEVICE_USER_CODE,
  runDeviceTokenOp,
} from '../state-transition-matrix/device-observation';
import {
  AUTH_REQ_ID,
  CLIENT_ID as CIBA_CLIENT_ID,
  SECRET as CIBA_SECRET,
  hashSecret,
  runCibaTokenOp,
} from '../state-transition-matrix/ciba-observation';

/**
 * Withdrawing a consent moves the user's consent generation for the client on (and records when,
 * in oauth_client_consent_revocations in the account database). The token endpoint refuses a code,
 * approval or refresh-token family granted under an earlier generation, or, one recorded without
 * a generation, issued before the withdrawal: neither a family the index missed nor a grant in
 * flight outlives it.
 */

// Wall-clock based: refresh-token verification checks expiry against the real clock.
const T0 = Math.floor(Date.now() / 1000) * 1000;
const CLIENT = 'matrix-withdrawal-client';
const REDIRECT = 'https://client.example/callback';
const RESOURCE = 'svc://matrix-api';
const USER = 'user-001';

interface WithdrawalState {
  generation: number;
  revokedAt: number | null;
}

/**
 * The account database's answers for the test user's consent withdrawals, by client. A change can
 * be scheduled after a number of reads (a withdrawal completing between two reads), and a read
 * can be made to fail once.
 */
class Withdrawals {
  private states = new Map<string, WithdrawalState>();
  private scheduled = new Map<string, { afterReads: number; state: WithdrawalState }>();
  private failures = 0;
  private failAtRead: number | null = null;
  readCount = 0;

  constructor(kit: SecurityMatrixEnvKit) {
    const queryOne = kit.coreAdapter.queryOne.bind(kit.coreAdapter);
    kit.coreAdapter.queryOne = (async (sql: string, params: unknown[] = []) => {
      const row = await queryOne(sql, params);
      if (!sql.includes('FROM oauth_client_consent_revocations')) return row;
      if (this.failures > 0) {
        this.failures -= 1;
        throw new Error('account database unavailable');
      }
      if (this.failAtRead === this.readCount) {
        this.failAtRead = null;
        throw new Error('account database unavailable');
      }
      this.readCount += 1;
      const clientId = String(params[2]);
      const pending = this.scheduled.get(clientId);
      if (pending) {
        if (pending.afterReads === 0) {
          this.states.set(clientId, pending.state);
          this.scheduled.delete(clientId);
        } else {
          pending.afterReads -= 1;
        }
      }
      const state =
        params[0] === 'default' && params[1] === USER ? this.states.get(clientId) : undefined;
      return state && state.revokedAt !== null
        ? { generation: state.generation, revoked_at: state.revokedAt }
        : null;
    }) as typeof kit.coreAdapter.queryOne;
  }

  set(clientId: string, state: WithdrawalState): void {
    this.states.set(clientId, state);
  }

  /** Answer `state` from the read after the next `reads` reads on. */
  afterReads(clientId: string, reads: number, state: WithdrawalState): void {
    this.scheduled.set(clientId, { afterReads: reads, state });
  }

  failNextRead(): void {
    this.failures += 1;
  }

  /** Fail the read that follows `reads` more successful reads (e.g. the confirming one). */
  failReadAfter(reads: number): void {
    this.failAtRead = this.readCount + reads;
  }
}

/** An authorization code value long enough for the token endpoint's format check. */
function codeValue(name: string): string {
  return `consent-withdrawal-${name}`.padEnd(48, '0');
}

async function storeCode(
  kit: SecurityMatrixEnvKit,
  code: string,
  consentGeneration?: number
): Promise<void> {
  const stub = kit.authCodeNamespace.get(
    kit.authCodeNamespace.idFromName('tenant:default:auth-code')
  ) as unknown as { storeCodeRpc(request: Record<string, unknown>): Promise<unknown> };
  await stub.storeCodeRpc({
    code,
    tenantId: 'default',
    clientId: CLIENT,
    redirectUri: REDIRECT,
    userId: USER,
    scope: 'openid offline_access',
    resource: RESOURCE,
    ...(consentGeneration !== undefined ? { consentGeneration } : {}),
  });
}

interface TokenResult {
  status: number;
  body: Record<string, unknown>;
}

async function tokenPost(
  app: Hono<{ Bindings: Env }>,
  kit: SecurityMatrixEnvKit,
  body: Record<string, string>
): Promise<TokenResult> {
  kit.ledger.reset();
  const response = await app.fetch(
    new Request(requestUrl('/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }),
    kit.env,
    new LedgerExecutionContext(kit.ledger)
  );
  await kit.ledger.drain();
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function exchangeCode(app: Hono<{ Bindings: Env }>, kit: SecurityMatrixEnvKit, code: string) {
  return tokenPost(app, kit, {
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT,
    redirect_uri: REDIRECT,
  });
}

function refresh(app: Hono<{ Bindings: Env }>, kit: SecurityMatrixEnvKit, refreshToken: string) {
  return tokenPost(app, kit, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT,
  });
}

function rpcCalls(kit: SecurityMatrixEnvKit, method: string): number {
  return kit.ledger
    .all()
    .filter((entry) => entry.kind === 'do.rpc' && entry.target.endsWith(method)).length;
}

/** The family the rotator holds for the test user, for the refresh token's rotator instance. */
async function storedFamily(kit: SecurityMatrixEnvKit, refreshToken: string) {
  const payload = JSON.parse(
    Buffer.from(refreshToken.split('.')[1], 'base64url').toString('utf8')
  ) as { jti: string };
  const parsed = parseRefreshTokenJti(payload.jti);
  const name = `tenant:default:refresh-rotator:${CLIENT}:v${parsed.generation}:shard-${parsed.shardIndex}`;
  const stub = kit.rotatorNamespace.get(kit.rotatorNamespace.idFromName(name)) as unknown as {
    getFamilyRpc(userId: string): Promise<{ first_jti?: string } | null>;
  };
  return stub.getFamilyRpc(USER);
}

describe('token grants after a consent withdrawal', () => {
  let kit: SecurityMatrixEnvKit;
  let app: Hono<{ Bindings: Env }>;
  let withdrawals: Withdrawals;

  beforeEach(async () => {
    installFrozenNow(T0);
    kit = await createSecurityMatrixEnv(new CallLedger());
    seedRegionShardConfig(kit);
    seedClientRow(kit, {
      client_id: CLIENT,
      client_secret_hash: undefined,
      token_endpoint_auth_method: 'none',
      require_pkce: 0,
      scope: 'openid offline_access',
    });
    withdrawals = new Withdrawals(kit);
    app = createMatrixTokenApp(kit);
  });

  afterEach(() => {
    restoreRealClock();
  });

  it('refuses a code granted under an earlier generation, though issued after the withdrawal time', async () => {
    // Authorize read generation 0 and saw the old consent; the withdrawal completed before the
    // code was stored.
    withdrawals.set(CLIENT, { generation: 1, revokedAt: T0 - 1_000 });
    await storeCode(kit, codeValue('old-generation'), 0);

    const result = await exchangeCode(app, kit, codeValue('old-generation'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
    expect(rpcCalls(kit, 'consumeCodeRpc')).toBe(1);
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(0);
  });

  it('refuses a code without a generation issued before the withdrawal', async () => {
    await storeCode(kit, codeValue('legacy-before'));
    withdrawals.set(CLIENT, { generation: 1, revokedAt: T0 + 1_000 });
    installFrozenNow(T0 + 2_000);

    const result = await exchangeCode(app, kit, codeValue('legacy-before'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
    // Refused once redeemed, not for the code itself: it is consumed and no family is created.
    expect(rpcCalls(kit, 'consumeCodeRpc')).toBe(1);
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(0);
  });

  it('refuses a code without a generation issued at the withdrawal instant', async () => {
    withdrawals.set(CLIENT, { generation: 1, revokedAt: T0 });
    await storeCode(kit, codeValue('legacy-boundary'));

    const result = await exchangeCode(app, kit, codeValue('legacy-boundary'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
    expect(rpcCalls(kit, 'consumeCodeRpc')).toBe(1);
  });

  it('issues and refreshes tokens for a consent given again after the withdrawal', async () => {
    withdrawals.set(CLIENT, { generation: 2, revokedAt: T0 - 1_000 });
    await storeCode(kit, codeValue('reconsent'), 2);

    const issued = await exchangeCode(app, kit, codeValue('reconsent'));
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.refresh_token).toEqual(expect.any(String));
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(1);

    installFrozenNow(T0 + 1_000);
    const refreshed = await refresh(app, kit, String(issued.body.refresh_token));
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  });

  it('revokes exactly the family created while the consent was withdrawn, and refuses the grant', async () => {
    // The exchange reads generation 0; the withdrawal completes before the family is confirmed.
    await storeCode(kit, codeValue('race'), 0);
    withdrawals.afterReads(CLIENT, 1, { generation: 1, revokedAt: T0 });

    const result = await exchangeCode(app, kit, codeValue('race'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
    expect(result.body.refresh_token).toBeUndefined();
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(1);
    expect(rpcCalls(kit, 'revokeFamilyIfFirstJtiRpc')).toBe(1);
    expect(rpcCalls(kit, 'revokeFamilyRpc')).toBe(0);
  });

  it('refuses without offering a retry when the new family cannot be confirmed', async () => {
    // The code is consumed and its family created before the confirming read fails: a retry
    // could not succeed, so the grant is refused (not 503) and exactly that family revoked.
    await storeCode(kit, codeValue('confirm-fails'), 0);
    withdrawals.failReadAfter(1);

    const result = await exchangeCode(app, kit, codeValue('confirm-fails'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
    expect(result.body.refresh_token).toBeUndefined();
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(1);
    expect(rpcCalls(kit, 'revokeFamilyIfFirstJtiRpc')).toBe(1);
  });

  it('refuses without offering a retry when the consumed code cannot be checked', async () => {
    await storeCode(kit, codeValue('read-fails'), 0);
    withdrawals.failNextRead();

    const result = await exchangeCode(app, kit, codeValue('read-fails'));

    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
    expect(rpcCalls(kit, 'consumeCodeRpc')).toBe(1);
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(0);
  });

  it('refuses refreshing a family from an earlier generation, which the index never held', async () => {
    // The memory database keeps no family index rows, as when a background index write failed:
    // revoking the indexed families finds nothing to revoke.
    await storeCode(kit, codeValue('family'), 0);
    const issued = await exchangeCode(app, kit, codeValue('family'));
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const refreshToken = String(issued.body.refresh_token);

    installFrozenNow(T0 + 1_000);
    const beforeWithdrawal = await refresh(app, kit, refreshToken);
    expect(beforeWithdrawal.status, JSON.stringify(beforeWithdrawal.body)).toBe(200);

    // Withdrawn under a time before the family was created: only the generation refuses it.
    withdrawals.set(CLIENT, { generation: 1, revokedAt: T0 - 1_000 });
    installFrozenNow(T0 + 3_000);
    const afterWithdrawal = await refresh(app, kit, String(beforeWithdrawal.body.refresh_token));

    expect(afterWithdrawal.status).toBe(400);
    expect(afterWithdrawal.body.error).toBe('invalid_grant');
    expect(afterWithdrawal.body.access_token).toBeUndefined();
    expect(rpcCalls(kit, 'rotateRpc')).toBe(0);
    // Refused only: revoking the user's family here could end one issued since.
    expect(rpcCalls(kit, 'revokeFamilyRpc')).toBe(0);
  });

  it('leaves the family of a consent given again intact when an older refresh token is refused', async () => {
    await storeCode(kit, codeValue('family-a'), 0);
    const familyA = await exchangeCode(app, kit, codeValue('family-a'));
    expect(familyA.status, JSON.stringify(familyA.body)).toBe(200);

    // Withdrawn, then given again: family B replaces A in the same rotator.
    withdrawals.set(CLIENT, { generation: 2, revokedAt: T0 - 1_000 });
    await storeCode(kit, codeValue('family-b'), 2);
    const familyB = await exchangeCode(app, kit, codeValue('family-b'));
    expect(familyB.status, JSON.stringify(familyB.body)).toBe(200);
    const familyBToken = String(familyB.body.refresh_token);
    const familyBBefore = await storedFamily(kit, familyBToken);

    installFrozenNow(T0 + 1_000);
    const stale = await refresh(app, kit, String(familyA.body.refresh_token));
    expect(stale.status).toBe(400);
    expect(rpcCalls(kit, 'revokeFamilyRpc')).toBe(0);

    expect(await storedFamily(kit, familyBToken)).toEqual(familyBBefore);
    const refreshedB = await refresh(app, kit, familyBToken);
    expect(refreshedB.status, JSON.stringify(refreshedB.body)).toBe(200);
  });
});

describe('device and CIBA grants after a consent withdrawal', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;
  let withdrawals: Withdrawals;

  beforeEach(async () => {
    installFrozenNow(T0);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
    seedRegionShardConfig(kit);
    kit.coreAdapter.addBehavior({
      match: (sql) => sql.includes('FROM identity_accounts') && sql.includes('legacy_user_id'),
      result: () => [
        {
          id: 'account-user-001',
          tenant_id: 'default',
          subject_id: 'subject-user-001',
          legacy_user_id: USER,
          account_type: 'end_user',
          lifecycle_state: 'active',
          created_at: T0,
          updated_at: T0,
        },
      ],
    });
    withdrawals = new Withdrawals(kit);
  });

  afterEach(() => {
    restoreRealClock();
  });

  const deviceSuccess = DEVICE_TOKEN_CASE_TABLE.find(
    (entry) =>
      decideDeviceToken(entry.dimensions).status === 200 &&
      String(entry.dimensions.tenantBinding) !== 'foreign'
  )!;
  const cibaSuccess = CIBA_TOKEN_CASE_TABLE.find(
    (entry) =>
      decideCibaToken(entry.dimensions).status === 200 &&
      String(entry.dimensions.tenantBinding) !== 'foreign'
  )!;

  function internal(
    stub: { fetch(request: Request): Promise<Response> },
    path: string,
    body: Record<string, unknown>
  ): Promise<Response> {
    return stub.fetch(
      new Request(`https://internal/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': 'default' },
        body: JSON.stringify(body),
      })
    );
  }

  /** A device code requested now and approved by the test user, under `generation` if given. */
  async function seedApprovedDeviceCode(generation?: number, scope = 'openid'): Promise<void> {
    seedClientRow(kit, {
      client_id: DEVICE_CLIENT_ID,
      token_endpoint_auth_method: 'none',
      grant_types: 'urn:ietf:params:oauth:grant-type:device_code',
      default_resource: RESOURCE,
    });
    const namespace = new StateTransitionNamespace(DeviceCodeStore, kit.env, ledger, 'device');
    const stub = namespace.get(namespace.idFromName('tenant:default:device')) as unknown as {
      fetch(request: Request): Promise<Response>;
    };
    await internal(stub, 'store', {
      device_code: DEVICE_CODE,
      user_code: DEVICE_USER_CODE,
      client_id: DEVICE_CLIENT_ID,
      scope,
      status: 'pending',
      created_at: T0,
      verification_uri: 'https://example.com/device',
      expires_at: T0 + 3_600_000,
      interval: 5,
    });
    await internal(stub, 'approve', {
      user_code: DEVICE_USER_CODE,
      user_id: USER,
      sub: USER,
      ...(generation !== undefined ? { consent_generation: generation } : {}),
    });
    await namespace.drainAll();
    kit.env.DEVICE_CODE_STORE = namespace as never;
  }

  /** A CIBA request made now and approved by the test user, under `generation` if given. */
  async function seedApprovedCibaRequest(generation?: number, scope = 'openid'): Promise<void> {
    seedClientRow(kit, {
      client_id: CIBA_CLIENT_ID,
      token_endpoint_auth_method: 'client_secret_post',
      client_secret_hash: await hashSecret(CIBA_SECRET),
      default_resource: RESOURCE,
      grant_types: 'urn:openid:params:grant-type:ciba',
      backchannel_token_delivery_mode: 'poll',
    });
    const namespace = new StateTransitionNamespace(CIBARequestStore, kit.env, ledger, 'ciba');
    const stub = namespace.get(namespace.idFromName('tenant:default:ciba')) as unknown as {
      fetch(request: Request): Promise<Response>;
    };
    await internal(stub, 'store', {
      auth_req_id: AUTH_REQ_ID,
      client_id: CIBA_CLIENT_ID,
      scope,
      status: 'pending',
      delivery_mode: 'poll',
      created_at: T0,
      login_hint: 'user@example.com',
      expires_at: T0 + 3_600_000,
      interval: 5,
    });
    await internal(stub, 'approve', {
      auth_req_id: AUTH_REQ_ID,
      user_id: USER,
      sub: USER,
      ...(generation !== undefined ? { consent_generation: generation } : {}),
    });
    await namespace.drainAll();
    kit.env.CIBA_REQUEST_STORE = namespace as never;
  }

  it('refuses a device code requested before the withdrawal', async () => {
    await seedApprovedDeviceCode();
    withdrawals.set(DEVICE_CLIENT_ID, { generation: 1, revokedAt: T0 });
    ledger.reset();

    const result = await runDeviceTokenOp(kit, ledger, deviceSuccess);

    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid_grant');
    expect(JSON.parse(result.bodyText).access_token).toBeUndefined();
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(0);
  });

  it('refuses a device code approved under an earlier generation', async () => {
    await seedApprovedDeviceCode(0);
    withdrawals.set(DEVICE_CLIENT_ID, { generation: 1, revokedAt: T0 - 1_000 });
    ledger.reset();

    const result = await runDeviceTokenOp(kit, ledger, deviceSuccess);

    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid_grant');
  });

  it('issues tokens for a device code approved under the current generation', async () => {
    await seedApprovedDeviceCode(1);
    withdrawals.set(DEVICE_CLIENT_ID, { generation: 1, revokedAt: T0 - 1 });
    ledger.reset();

    const result = await runDeviceTokenOp(kit, ledger, deviceSuccess);

    expect(result.status, result.bodyText).toBe(200);
  });

  it('keeps a device code for the next poll when the withdrawals cannot be read', async () => {
    await seedApprovedDeviceCode(0);
    withdrawals.failNextRead();
    ledger.reset();

    const failed = await runDeviceTokenOp(kit, ledger, deviceSuccess);
    expect(failed.status).toBe(503);

    // The next poll, past the polling interval.
    ledger.reset();
    installFrozenNow(T0 + 10_000);
    const retried = await runDeviceTokenOp(kit, ledger, deviceSuccess);
    expect(retried.status, retried.bodyText).toBe(200);
  });

  it('refuses a reserved device code without a retry when its new family cannot be confirmed', async () => {
    await seedApprovedDeviceCode(0, 'openid offline_access');
    withdrawals.failReadAfter(1);
    ledger.reset();

    const result = await runDeviceTokenOp(kit, ledger, deviceSuccess);

    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid_grant');
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(1);
    expect(rpcCalls(kit, 'revokeFamilyIfFirstJtiRpc')).toBe(1);
  });

  it('refuses a CIBA request made before the withdrawal', async () => {
    await seedApprovedCibaRequest();
    withdrawals.set(CIBA_CLIENT_ID, { generation: 1, revokedAt: T0 });
    ledger.reset();

    const result = await runCibaTokenOp(kit, ledger, cibaSuccess);

    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid_grant');
    expect(JSON.parse(result.bodyText).access_token).toBeUndefined();
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(0);
  });

  it('refuses a CIBA request approved under an earlier generation', async () => {
    await seedApprovedCibaRequest(0);
    withdrawals.set(CIBA_CLIENT_ID, { generation: 1, revokedAt: T0 - 1_000 });
    ledger.reset();

    const result = await runCibaTokenOp(kit, ledger, cibaSuccess);

    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid_grant');
  });

  it('issues tokens for a CIBA request approved under the current generation', async () => {
    await seedApprovedCibaRequest(1);
    withdrawals.set(CIBA_CLIENT_ID, { generation: 1, revokedAt: T0 - 1 });
    ledger.reset();

    const result = await runCibaTokenOp(kit, ledger, cibaSuccess);

    expect(result.status, result.bodyText).toBe(200);
  });

  it('refuses a reserved CIBA request without a retry when its new family cannot be confirmed', async () => {
    await seedApprovedCibaRequest(0, 'openid offline_access');
    withdrawals.failReadAfter(1);
    ledger.reset();

    const result = await runCibaTokenOp(kit, ledger, cibaSuccess);

    expect(result.status).toBe(400);
    expect(result.error).toBe('invalid_grant');
    expect(rpcCalls(kit, 'createFamilyRpc')).toBe(1);
    expect(rpcCalls(kit, 'revokeFamilyIfFirstJtiRpc')).toBe(1);
  });

  it('keeps a CIBA request for the next poll when the withdrawals cannot be read', async () => {
    await seedApprovedCibaRequest(0);
    withdrawals.failNextRead();
    ledger.reset();

    const failed = await runCibaTokenOp(kit, ledger, cibaSuccess);
    expect(failed.status).toBe(503);

    // The next poll, past the polling interval.
    ledger.reset();
    installFrozenNow(T0 + 10_000);
    const retried = await runCibaTokenOp(kit, ledger, cibaSuccess);
    expect(retried.status, retried.bodyText).toBe(200);
  });
});
