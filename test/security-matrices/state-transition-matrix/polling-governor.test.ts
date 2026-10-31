/**
 * Polling through the REAL token endpoint and the REAL DeviceCodeStore / CIBARequestStore
 * (RFC 8628 section 3.5, CIBA Core section 11). The D-T / C-T matrices pin the pending-poll
 * answers with a programmable store; these tests let the store's own record of the previous poll
 * decide, which is what a stub cannot do: the first poll is `authorization_pending`, a poll before
 * the interval is `slow_down` and raises the stored interval, a poll after it is pending again,
 * and polls past the cap end the request.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CIBARequestStore } from '../../../packages/ar-lib-core/src/durable-objects/CIBARequestStore';
import { DeviceCodeStore } from '../../../packages/ar-lib-core/src/durable-objects/DeviceCodeStore';
import { CallLedger, LedgerExecutionContext } from '../fixtures/call-ledger';
import {
  advanceFrozenClockByMs,
  frozenNowMs,
  installFrozenNow,
  restoreRealClock,
} from '../fixtures/deterministic-clock';
import {
  createSecurityMatrixEnv,
  seedClientRow,
  seedRegionShardConfig,
  type SecurityMatrixEnvKit,
} from '../fixtures/env';
import { createMatrixTokenApp, requestUrl } from '../fixtures/hono-context';
import { hashSecret } from './ciba-observation';
import { StateTransitionNamespace } from './harness';

const FROZEN_NOW = 1_700_000_000;
const TENANT = 'default';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEVICE_CODE = 'dev-poll-001';
const USER_CODE = 'ABCD-EFGH';
const DEVICE_CLIENT = 'poll-device-client';
const OTHER_DEVICE_CLIENT = 'other-poll-device-client';

const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
const AUTH_REQ_ID = 'ciba-poll-001';
const CIBA_CLIENT = 'poll-ciba-client';
const CIBA_SECRET = 'poll-ciba-secret-001';
const OTHER_CIBA_CLIENT = 'other-poll-ciba-client';
const OTHER_CIBA_SECRET = 'other-poll-ciba-secret';

type StoredRecord = Record<string, unknown> | undefined;

interface TokenAnswer {
  status: number;
  error: string | null;
  body: Record<string, unknown>;
}

let kit: SecurityMatrixEnvKit;
let ledger: CallLedger;

async function postToken(params: Record<string, string>): Promise<TokenAnswer> {
  // A drained ledger refuses later waitUntil work, which a token issuance enqueues
  ledger.reset();
  const app = createMatrixTokenApp(kit, { tenantId: TENANT });
  const response = await app.fetch(
    new Request(requestUrl('/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }),
    kit.env,
    new LedgerExecutionContext(ledger)
  );
  await ledger.drain();
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, error: (body.error as string | undefined) ?? null, body };
}

beforeEach(async () => {
  installFrozenNow(FROZEN_NOW);
  ledger = new CallLedger();
  kit = await createSecurityMatrixEnv(ledger);
  seedRegionShardConfig(kit);
  for (const clientId of [DEVICE_CLIENT, OTHER_DEVICE_CLIENT]) {
    seedClientRow(kit, {
      client_id: clientId,
      token_endpoint_auth_method: 'none',
      grant_types: DEVICE_GRANT,
      default_resource: 'svc://matrix-api',
    });
  }
  seedClientRow(kit, {
    client_id: CIBA_CLIENT,
    token_endpoint_auth_method: 'client_secret_post',
    client_secret_hash: await hashSecret(CIBA_SECRET),
    default_resource: 'svc://matrix-api',
    grant_types: CIBA_GRANT,
    backchannel_token_delivery_mode: 'poll',
  });
  seedClientRow(kit, {
    client_id: OTHER_CIBA_CLIENT,
    token_endpoint_auth_method: 'client_secret_post',
    client_secret_hash: await hashSecret(OTHER_CIBA_SECRET),
    default_resource: 'svc://matrix-api',
    grant_types: CIBA_GRANT,
    backchannel_token_delivery_mode: 'poll',
  });
  kit.coreAdapter.addBehavior({
    match: (sql) => sql.includes('FROM identity_accounts') && sql.includes('legacy_user_id'),
    result: () => [
      {
        id: 'account-user-001',
        tenant_id: TENANT,
        subject_id: 'subject-user-001',
        legacy_user_id: 'user-001',
        account_type: 'end_user',
        lifecycle_state: 'active',
        created_at: 1700000000,
        updated_at: 1700000000,
      },
    ],
  });
});

afterEach(() => {
  restoreRealClock();
});

describe('device flow polling through the token endpoint', () => {
  let namespace: StateTransitionNamespace<DeviceCodeStore>;
  const instance = `tenant:${TENANT}:device`;

  async function internal(path: string, body: Record<string, unknown>): Promise<Response> {
    return namespace.get(namespace.idFromName(instance)).fetch(
      new Request(`https://internal/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': TENANT },
        body: JSON.stringify(body),
      })
    );
  }

  async function seed(
    overrides: Record<string, unknown> = {},
    lifetimeMs = 600_000
  ): Promise<void> {
    namespace = new StateTransitionNamespace(DeviceCodeStore, kit.env, ledger, 'device');
    kit.env.DEVICE_CODE_STORE = namespace as never;
    await internal('store', {
      device_code: DEVICE_CODE,
      user_code: USER_CODE,
      client_id: DEVICE_CLIENT,
      scope: 'openid',
      status: 'pending',
      created_at: frozenNowMs(),
      expires_at: frozenNowMs() + lifetimeMs,
      poll_count: 0,
      interval: 5,
      ...overrides,
    });
    await namespace.drainAll();
  }

  function record(): StoredRecord {
    return namespace.getStorage(instance).snapshot().get(`d:${DEVICE_CODE}`) as StoredRecord;
  }

  function poll(clientId = DEVICE_CLIENT): Promise<TokenAnswer> {
    return postToken({ grant_type: DEVICE_GRANT, device_code: DEVICE_CODE, client_id: clientId });
  }

  it('answers authorization_pending to the first poll, not slow_down', async () => {
    await seed();

    const first = await poll();

    expect(first).toMatchObject({ status: 400, error: 'authorization_pending' });
    expect(record()).toMatchObject({ poll_count: 1, last_poll_at: frozenNowMs(), interval: 5 });
  });

  it('answers slow_down to a poll inside the interval and raises the stored interval', async () => {
    await seed();
    await poll();

    advanceFrozenClockByMs(1_000);
    const second = await poll();

    expect(second).toMatchObject({ status: 400, error: 'slow_down' });
    expect(record()).toMatchObject({ poll_count: 2, interval: 10, base_interval: 5 });
  });

  it('answers pending again once the raised interval has passed, and slow_down again before it', async () => {
    await seed();
    await poll();
    advanceFrozenClockByMs(1_000);
    await poll(); // slow_down: interval 10

    advanceFrozenClockByMs(5_000); // longer than the old interval, shorter than the new one
    expect((await poll()).error).toBe('slow_down');
    expect(record()).toMatchObject({ interval: 15 });

    advanceFrozenClockByMs(15_000);
    expect((await poll()).error).toBe('authorization_pending');
    expect(record()).toMatchObject({ interval: 15, poll_count: 4 });
  });

  it('stops raising the interval at the maximum', async () => {
    await seed();
    for (let index = 0; index < 20; index++) {
      await poll();
      advanceFrozenClockByMs(1_000);
    }

    expect(record()).toMatchObject({ interval: 60, poll_count: 20 });
  });

  it('works for a code stored before the interval was kept on it', async () => {
    await seed({ interval: undefined });

    expect((await poll()).error).toBe('authorization_pending');
    advanceFrozenClockByMs(1_000);
    expect((await poll()).error).toBe('slow_down');
    expect(record()).toMatchObject({ interval: 10 });
  });

  it('does not slow_down an approved code and issues the tokens', async () => {
    await seed();
    await poll();
    await internal('approve', { user_code: USER_CODE, user_id: 'user-001', sub: 'user-001' });
    await namespace.drainAll();

    advanceFrozenClockByMs(100);
    const answer = await poll();

    expect(answer.status).toBe(200);
    expect(answer.body).toHaveProperty('access_token');
  });

  it('answers access_denied for a denied code and expired_token once it expired', async () => {
    await seed();
    await poll();
    await internal('deny', { user_code: USER_CODE });
    await namespace.drainAll();
    advanceFrozenClockByMs(100);
    expect(await poll()).toMatchObject({ status: 403, error: 'access_denied' });

    await seed();
    await poll();
    advanceFrozenClockByMs(600_001);
    expect(await poll()).toMatchObject({ status: 400, error: 'expired_token' });
    expect(record()).toBeUndefined();
  });

  it('never ends a client that waits the interval for the whole lifetime', async () => {
    await seed();
    const start = frozenNowMs();

    let polls = 0;
    while (frozenNowMs() - start < 600_000) {
      const answer = await poll();
      expect(answer.error, `poll ${polls + 1}`).toBe('authorization_pending');
      polls++;
      advanceFrozenClockByMs(5_000);
    }

    expect(polls).toBe(120);
    expect(record()).toMatchObject({ poll_count: 120, interval: 5 });
  });

  it('ends a client that keeps polling every second: slow_down first, then expired_token at the cap', async () => {
    await seed();

    const answers: Array<string | null> = [];
    for (let index = 0; index < 140; index++) {
      answers.push((await poll()).error);
      advanceFrozenClockByMs(1_000);
    }

    expect(answers[0]).toBe('authorization_pending');
    expect(answers[1]).toBe('slow_down');
    // 130 polls fit (120 for the lifetime plus the margin of 10)
    expect(answers.slice(1, 130).every((answer) => answer === 'slow_down')).toBe(true);
    expect(answers.slice(130).every((answer) => answer === 'expired_token')).toBe(true);
    expect(record()).toBeUndefined();
  });

  describe('with the tenant device flow limits kept on the code', () => {
    it('raises the interval by the code increment, up to the code maximum interval', async () => {
      await seed({ slow_down_increment: 12, max_interval: 25 });
      await poll();

      advanceFrozenClockByMs(1_000);
      expect(await poll()).toMatchObject({ status: 400, error: 'slow_down' });
      expect(record()).toMatchObject({ interval: 17, base_interval: 5 });

      advanceFrozenClockByMs(1_000);
      expect((await poll()).error).toBe('slow_down');
      expect(record()).toMatchObject({ interval: 25 });

      // however often the client polls early, the tenant maximum holds
      for (let index = 0; index < 10; index++) {
        advanceFrozenClockByMs(1_000);
        await poll();
      }
      expect(record()).toMatchObject({ interval: 25 });
    });

    it('lets a tenant that allows a longer interval raise the code above the constant maximum', async () => {
      await seed({ interval: 60, max_interval: 120 });
      await poll();
      advanceFrozenClockByMs(1_000);
      await poll();

      expect(record()).toMatchObject({ interval: 65 });
    });

    it('never raises it by less than 5 seconds, whatever the code holds', async () => {
      await seed({ slow_down_increment: 1 });
      await poll();
      advanceFrozenClockByMs(1_000);
      await poll();

      expect(record()).toMatchObject({ interval: 10 });
    });

    it('answers pending once the interval the code was issued with has passed', async () => {
      await seed({ interval: 10 });
      expect((await poll()).error).toBe('authorization_pending');

      advanceFrozenClockByMs(6_000); // past the default 5 s, inside the code interval of 10 s
      expect((await poll()).error).toBe('slow_down');
      expect(record()).toMatchObject({ interval: 15, base_interval: 10 });
    });

    it('cuts a client off at a configured count above what the lifetime needs', async () => {
      // 600 s at 5 s needs 120 polls (cap 130); a configured 200 is the cap
      await seed({ max_poll_count: 200 });

      const answers: Array<string | null> = [];
      for (let index = 0; index < 210; index++) {
        answers.push((await poll()).error);
        advanceFrozenClockByMs(1_000);
      }

      expect(answers.slice(1, 200).every((answer) => answer === 'slow_down')).toBe(true);
      expect(answers.slice(200).every((answer) => answer === 'expired_token')).toBe(true);
      expect(record()).toBeUndefined();
    });

    it('does not cut off a client that follows the interval, whatever count is configured', async () => {
      // 600 s at 5 s needs 120 polls: the configured minimum of 10 is only a floor
      await seed({ max_poll_count: 10 });
      const start = frozenNowMs();

      let polls = 0;
      while (frozenNowMs() - start < 600_000) {
        expect((await poll()).error, `poll ${polls + 1}`).toBe('authorization_pending');
        polls++;
        advanceFrozenClockByMs(5_000);
      }

      expect(polls).toBe(120);
    });

    it('does not cut off a client that follows a longer lifetime and a short interval', async () => {
      // 1800 s at 5 s needs 360 polls; the default count of 120 must not end it
      await seed({ max_poll_count: 120 }, 1_800_000);
      const start = frozenNowMs();

      let polls = 0;
      while (frozenNowMs() - start < 1_800_000) {
        expect((await poll()).error, `poll ${polls + 1}`).toBe('authorization_pending');
        polls++;
        advanceFrozenClockByMs(5_000);
      }

      expect(polls).toBe(360);
    });

    it('ignores values a settings save could not have made, so a corrupt code keeps the constants', async () => {
      await seed({
        slow_down_increment: 2.5,
        max_interval: 1e9,
        max_poll_count: 1_000_000_000,
      });
      await poll();
      advanceFrozenClockByMs(1_000);
      await poll();

      expect(record()).toMatchObject({ interval: 10 });
    });
  });

  it('does not let another client change a code it does not own', async () => {
    await seed();
    await poll();
    advanceFrozenClockByMs(1_000);
    const before = structuredClone(record());

    const stranger = await poll(OTHER_DEVICE_CLIENT);
    advanceFrozenClockByMs(100);
    const strangerAgain = await poll(OTHER_DEVICE_CLIENT);

    expect(stranger).toMatchObject({ status: 400, error: 'invalid_grant' });
    expect(strangerAgain).toMatchObject({ status: 400, error: 'invalid_grant' });
    expect(record()).toEqual(before);
    // The owner is judged by its own polls only
    advanceFrozenClockByMs(5_000);
    expect((await poll()).error).toBe('authorization_pending');
  });
});

describe('CIBA polling through the token endpoint', () => {
  let namespace: StateTransitionNamespace<CIBARequestStore>;
  const instance = `tenant:${TENANT}:ciba`;

  async function internal(path: string, body: Record<string, unknown>): Promise<Response> {
    return namespace.get(namespace.idFromName(instance)).fetch(
      new Request(`https://internal/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Authrim-Tenant-Id': TENANT },
        body: JSON.stringify(body),
      })
    );
  }

  async function seed(
    overrides: Record<string, unknown> = {},
    lifetimeMs = 300_000
  ): Promise<void> {
    namespace = new StateTransitionNamespace(CIBARequestStore, kit.env, ledger, 'ciba');
    kit.env.CIBA_REQUEST_STORE = namespace as never;
    await internal('store', {
      auth_req_id: AUTH_REQ_ID,
      client_id: CIBA_CLIENT,
      scope: 'openid',
      status: 'pending',
      delivery_mode: 'poll',
      login_hint: 'user@example.com',
      created_at: frozenNowMs(),
      expires_at: frozenNowMs() + lifetimeMs,
      poll_count: 0,
      interval: 5,
      ...overrides,
    });
    await namespace.drainAll();
  }

  function record(): StoredRecord {
    return namespace.getStorage(instance).snapshot().get(`r:${AUTH_REQ_ID}`) as StoredRecord;
  }

  function poll(
    credentials: { client: string; secret: string } = { client: CIBA_CLIENT, secret: CIBA_SECRET }
  ): Promise<TokenAnswer> {
    return postToken({
      grant_type: CIBA_GRANT,
      auth_req_id: AUTH_REQ_ID,
      client_id: credentials.client,
      client_secret: credentials.secret,
    });
  }

  it('answers authorization_pending to the first poll, not slow_down', async () => {
    await seed();

    expect(await poll()).toMatchObject({ status: 400, error: 'authorization_pending' });
    expect(record()).toMatchObject({ poll_count: 1, last_poll_at: frozenNowMs() });
  });

  it('answers slow_down inside the interval, raises it, and answers pending after the new one', async () => {
    await seed();
    await poll();

    advanceFrozenClockByMs(1_000);
    expect(await poll()).toMatchObject({ status: 400, error: 'slow_down' });
    expect(record()).toMatchObject({ interval: 10, base_interval: 5, poll_count: 2 });

    advanceFrozenClockByMs(10_000);
    expect((await poll()).error).toBe('authorization_pending');
    expect(record()).toMatchObject({ interval: 10, poll_count: 3 });
  });

  it('stops raising the interval at the maximum', async () => {
    await seed();
    for (let index = 0; index < 20; index++) {
      await poll();
      advanceFrozenClockByMs(1_000);
    }

    expect(record()).toMatchObject({ interval: 60 });
  });

  it('never ends a client that waits the interval for the whole lifetime', async () => {
    await seed({}, 600_000);
    const start = frozenNowMs();

    let polls = 0;
    while (frozenNowMs() - start < 600_000) {
      expect((await poll()).error, `poll ${polls + 1}`).toBe('authorization_pending');
      polls++;
      advanceFrozenClockByMs(5_000);
    }

    expect(polls).toBe(120);
  });

  it('ends a client that keeps polling every second at the cap with expired_token', async () => {
    await seed({}, 600_000);

    const answers: Array<string | null> = [];
    for (let index = 0; index < 140; index++) {
      answers.push((await poll()).error);
      advanceFrozenClockByMs(1_000);
    }

    expect(answers.slice(1, 130).every((answer) => answer === 'slow_down')).toBe(true);
    expect(answers.slice(130).every((answer) => answer === 'expired_token')).toBe(true);
    expect(record()).toBeUndefined();
  });

  describe('with the tenant slow_down increment and poll count kept on the request', () => {
    it('raises the interval by the request increment, up to the request maximum', async () => {
      await seed({ slow_down_increment: 12, max_interval: 25 });
      await poll();

      advanceFrozenClockByMs(1_000);
      expect(await poll()).toMatchObject({ status: 400, error: 'slow_down' });
      expect(record()).toMatchObject({ interval: 17, base_interval: 5 });

      advanceFrozenClockByMs(1_000);
      expect((await poll()).error).toBe('slow_down');
      expect(record()).toMatchObject({ interval: 25 });
    });

    it('never raises it by less than 5 seconds, whatever the request holds', async () => {
      await seed({ slow_down_increment: 1 });
      await poll();
      advanceFrozenClockByMs(1_000);
      await poll();

      expect(record()).toMatchObject({ interval: 10 });
    });

    it('cuts a client off at a configured count above what the lifetime needs', async () => {
      // 300 s at 5 s needs 60 polls (cap 70); a configured 150 is the cap
      await seed({ max_poll_count: 150 });

      const answers: Array<string | null> = [];
      for (let index = 0; index < 160; index++) {
        answers.push((await poll()).error);
        advanceFrozenClockByMs(1_000);
      }

      expect(answers.slice(1, 150).every((answer) => answer === 'slow_down')).toBe(true);
      expect(answers.slice(150).every((answer) => answer === 'expired_token')).toBe(true);
      expect(record()).toBeUndefined();
    });

    it('does not cut off a client that follows the interval, whatever count is configured', async () => {
      // 600 s at 5 s needs 120 polls: the configured minimum of 10 is only a floor
      await seed({ max_poll_count: 10 }, 600_000);
      const start = frozenNowMs();

      let polls = 0;
      while (frozenNowMs() - start < 600_000) {
        expect((await poll()).error, `poll ${polls + 1}`).toBe('authorization_pending');
        polls++;
        advanceFrozenClockByMs(5_000);
      }

      expect(polls).toBe(120);
    });
  });

  it('does not let another authenticated client change a request it does not own', async () => {
    await seed();
    await poll();
    advanceFrozenClockByMs(1_000);
    const before = structuredClone(record());
    const stranger = { client: OTHER_CIBA_CLIENT, secret: OTHER_CIBA_SECRET };

    expect(await poll(stranger)).toMatchObject({ status: 400, error: 'invalid_grant' });
    advanceFrozenClockByMs(100);
    expect(await poll(stranger)).toMatchObject({ status: 400, error: 'invalid_grant' });

    expect(record()).toEqual(before);
  });

  it.each(['ping', 'push'])(
    'keeps answering authorization_pending to a %s request however often it is polled',
    async (deliveryMode) => {
      await seed({ delivery_mode: deliveryMode }, 600_000);

      for (let index = 0; index < 150; index++) {
        expect((await poll()).error, `poll ${index + 1}`).toBe('authorization_pending');
        advanceFrozenClockByMs(100);
      }

      expect(record()).toMatchObject({ interval: 5, poll_count: 150 });
      expect(record()).not.toHaveProperty('base_interval');
    }
  );

  it('issues the tokens of an approved poll-mode request however soon it is polled', async () => {
    await seed();
    await poll();
    await internal('approve', {
      auth_req_id: AUTH_REQ_ID,
      user_id: 'user-001',
      sub: 'user-001',
    });
    await namespace.drainAll();

    advanceFrozenClockByMs(100);
    const answer = await poll();

    expect(answer.status).toBe(200);
    expect(answer.body).toHaveProperty('access_token');
  });
});
