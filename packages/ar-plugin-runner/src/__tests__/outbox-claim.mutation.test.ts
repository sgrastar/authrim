import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1PluginHookOutboxStore } from '../outbox';
import {
  accountPayload,
  insertIntent,
  insertNotificationOutbox,
  insertOutbox,
  intentPayload,
  outboxRow,
} from './helpers/outbox-seed';
import { createD1, openCoreDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function store(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { store: new D1PluginHookOutboxStore(d1.db), calls: d1.calls };
}
const claim = (now = 200, ownerId = 'runner-a', options: D1Options = {}) =>
  store(options).store.claimNext({ ownerId, now });

beforeEach(() => {
  database = openCoreDatabase();
});

describe('claimNext input', () => {
  it.each([
    ['empty owner', { ownerId: '', now: 200 }],
    ['unsafe owner', { ownerId: '-runner', now: 200 }],
    ['owner with space', { ownerId: 'run ner', now: 200 }],
    ['owner too long', { ownerId: 'a'.repeat(257), now: 200 }],
    ['zero clock', { ownerId: 'runner-a', now: 0 }],
    ['negative clock', { ownerId: 'runner-a', now: -1 }],
    ['fractional clock', { ownerId: 'runner-a', now: 1.5 }],
    ['unsafe clock', { ownerId: 'runner-a', now: 2 ** 53 }],
    ['NaN clock', { ownerId: 'runner-a', now: Number.NaN }],
  ])('rejects %s before any database access', async (_label, input) => {
    const { store: s, calls } = store();
    await expect(s.claimNext(input)).rejects.toThrow(/^plugin_outbox_claim_input_invalid$/u);
    expect(calls).toEqual([]);
  });
  it('accepts a clock of exactly one and a 256-character owner', async () => {
    await expect(claim(1)).resolves.toBeNull();
    await expect(claim(1, 'o'.repeat(256))).resolves.toBeNull();
  });
  it('needs the D1 sessions API', async () => {
    const { store: s } = store({ withoutSession: true });
    await expect(s.claimNext({ ownerId: 'runner-a', now: 200 })).rejects.toThrow(
      /^plugin_outbox_d1_session_required$/u
    );
  });
  it('reads from the primary', async () => {
    const s = store();
    await s.store.claimNext({ ownerId: 'runner-a', now: 200 });
    expect(s.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
  });
});

describe('claimNext selection', () => {
  const lockedAt = async (id: string, at: number) => {
    insertOutbox(database, { id });
    await claim(at, 'runner-old');
  };
  it('returns null when nothing is due', async () => {
    await expect(claim()).resolves.toBeNull();
  });
  it('claims a queued row, fencing it with a fresh token and a 60 second lease', async () => {
    insertOutbox(database, { createdAt: 150 });
    const result = await claim(200);
    expect(result).toEqual({
      outboxId: 'outbox-a',
      attemptNo: 1,
      claimOwner: 'runner-a',
      claimToken: expect.stringMatching(/^claim-[0-9a-f-]{36}$/u) as unknown,
      leaseUntil: 260,
      createdAt: 150,
      providerStartedAt: 150,
      invocation: {
        pluginInstallationId: 'installation-a',
        tenantId: 'tenant-a',
        capability: 'hook.account.lifecycle',
        eventType: 'account.created',
        eventVersion: 1,
        idempotencyKey: 'event/outbox-a',
        payload: accountPayload(),
      },
    });
    expect(outboxRow(database)).toMatchObject({
      status: 'locked',
      attempt_no: 1,
      claim_owner: 'runner-a',
      claim_token: result?.claimToken,
      lease_until: 260,
      next_attempt_at: null,
      updated_at: 200,
    });
  });
  it('binds the clock twice into the candidate search and the claim', async () => {
    insertOutbox(database);
    const { store: s, calls } = store();
    await s.claimNext({ ownerId: 'runner-a', now: 200 });
    const search = calls.find((c) => c.kind === 'first');
    expect(search?.values).toEqual([200, 200]);
    const update = calls.find((c) => c.kind === 'run');
    expect(update?.values).toEqual([
      'runner-a',
      expect.stringMatching(/^claim-/u),
      260,
      200,
      'outbox-a',
      200,
      200,
    ]);
  });
  it('takes the oldest due row, then by creation time and id', async () => {
    insertOutbox(database, { id: 'b-late', createdAt: 120 });
    insertOutbox(database, { id: 'c-early', createdAt: 110 });
    insertOutbox(database, { id: 'a-early', createdAt: 110 });
    const order: string[] = [];
    for (let at = 200; at < 203; at++) order.push((await claim(at))?.outboxId ?? 'none');
    expect(order).toEqual(['a-early', 'c-early', 'b-late']);
  });
  it('orders retries by when they become due, not by creation', async () => {
    insertOutbox(database, { id: 'outbox-a', createdAt: 100 });
    insertOutbox(database, { id: 'outbox-b', createdAt: 101 });
    const first = await claim(200);
    const second = await claim(200, 'runner-b');
    expect([first?.outboxId, second?.outboxId]).toEqual(['outbox-a', 'outbox-b']);
    const s = store().store;
    // outbox-a retries at 200 + 5 = 205 (jitter 0); outbox-b retries at 150 + 5 would be earlier.
    await s.fail(must(first), {
      now: 300,
      errorCode: 'plugin_hook_transient_failure',
      retryable: true,
      maxAttempts: 3,
      failureScope: 'message',
    });
    await s.fail(must(second), {
      now: 290,
      errorCode: 'plugin_hook_transient_failure',
      retryable: true,
      maxAttempts: 3,
      failureScope: 'message',
    });
    expect(outboxRow(database, 'outbox-a').next_attempt_at).toBe(305);
    expect(outboxRow(database, 'outbox-b').next_attempt_at).toBe(295);
    await expect(claim(400, 'runner-c')).resolves.toMatchObject({ outboxId: 'outbox-b' });
  });
  it('leaves waiting, held, finished and canceled rows alone', async () => {
    for (const [index, id] of ['retry', 'held', 'done', 'dead', 'gone'].entries()) {
      insertOutbox(database, { id, createdAt: 101 + index });
    }
    const worker = store().store;
    const fail = (retryable: boolean) => ({
      now: 200,
      errorCode: 'plugin_hook_transient_failure',
      retryable,
      maxAttempts: 5,
      failureScope: 'message' as const,
    });
    await worker.fail(must(await claim(200, 'r1')), fail(true));
    must(await claim(200, 'r2'));
    await worker.succeed(must(await claim(200, 'r3')), 200);
    await worker.fail(must(await claim(200, 'r4')), fail(false));
    database.exec(
      "UPDATE plugin_hook_outbox SET status = 'canceled', canceled_at = 5 WHERE outbox_id = 'gone'"
    );
    const due = outboxRow(database, 'retry').next_attempt_at as number;
    expect(due).toBeGreaterThan(200);
    expect(outboxRow(database, 'held').lease_until).toBe(260);
    await expect(claim(201, 'r5')).resolves.toBeNull();
    await expect(claim(due - 1, 'r5')).resolves.toBeNull();
    await expect(claim(due, 'r5')).resolves.toMatchObject({ outboxId: 'retry', attemptNo: 2 });
  });
  it('treats the due instants as inclusive and the live lease as exclusive', async () => {
    insertOutbox(database, { id: 'outbox-a' });
    const first = must(await claim(200, 'r1'));
    await expect(claim(259, 'r2')).resolves.toBeNull();
    await expect(claim(260, 'r2')).resolves.toMatchObject({ outboxId: 'outbox-a', attemptNo: 2 });
    expect(first.attemptNo).toBe(1);
    const s = store().store;
    const third = must(await claim(320, 'r3'));
    await s.fail(third, {
      now: 330,
      errorCode: 'plugin_hook_transient_failure',
      retryable: true,
      maxAttempts: 9,
      failureScope: 'message',
    });
    const due = outboxRow(database).next_attempt_at as number;
    await expect(claim(due - 1, 'r4')).resolves.toBeNull();
    await expect(claim(due, 'r4')).resolves.toMatchObject({ attemptNo: 4 });
  });
  it('takes over an expired lease under a new token and attempt number', async () => {
    await lockedAt('outbox-a', 200);
    const taken = must(await claim(260, 'runner-b'));
    expect(taken).toMatchObject({ attemptNo: 2, claimOwner: 'runner-b', leaseUntil: 320 });
    expect(outboxRow(database)).toMatchObject({
      attempt_no: 2,
      claim_owner: 'runner-b',
      claim_token: taken.claimToken,
    });
  });
  it('returns null when another worker wins the claim', async () => {
    insertOutbox(database);
    await expect(
      claim(200, 'runner-a', {
        intercept: (call) =>
          call.kind === 'run'
            ? { value: { success: true, results: [], meta: { changes: 0 } } }
            : undefined,
      })
    ).resolves.toBeNull();
    expect(outboxRow(database).status).toBe('queued');
  });
  it('treats a missing change count as a lost race', async () => {
    insertOutbox(database);
    await expect(
      claim(200, 'runner-a', {
        intercept: (call) =>
          call.kind === 'run' ? { value: { success: true, results: [], meta: {} } } : undefined,
      })
    ).resolves.toBeNull();
  });
  it('refuses a candidate id that is not a safe identifier, leaving it queued', async () => {
    insertOutbox(database, { id: 'bad id' });
    await expect(claim()).rejects.toThrow(/^plugin_outbox_candidate_invalid$/u);
    expect(outboxRow(database, 'bad id').status).toBe('queued');
  });
  it('fails when the claimed row cannot be read back', async () => {
    insertOutbox(database);
    let reads = 0;
    await expect(
      claim(200, 'runner-a', {
        intercept: (call) => {
          if (call.kind !== 'first') return undefined;
          reads += 1;
          return reads === 2 ? { value: null } : undefined;
        },
      })
    ).rejects.toThrow(/^plugin_outbox_claim_reflection_failed$/u);
  });
});

describe('claimNext validation of the claimed row', () => {
  const invalid = /^plugin_outbox_claim_invalid$/u;
  const quarantined = () =>
    outboxRow(database, 'outbox-a') as {
      status: string;
      last_error_code: string;
      dead_lettered_at: number;
      delete_after: number;
      claim_owner: null;
      claim_token: null;
    };
  it.each([
    ['not JSON an object', 'null'],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['a number', '5'],
    ['an empty object', '{}'],
    ['another tenant', JSON.stringify(accountPayload({ tenantId: 'other' }))],
    ['another event type', JSON.stringify(accountPayload({ eventType: 'account.deleted' }))],
    ['another event version', JSON.stringify(accountPayload({ eventVersion: 2 }))],
    ['a string event version', JSON.stringify(accountPayload({ eventVersion: '1' }))],
    ['an extra key', JSON.stringify(accountPayload({ extra: 1 }))],
    ['a missing account', JSON.stringify({ ...accountPayload(), accountId: undefined })],
    ['an unsafe account id', JSON.stringify(accountPayload({ accountId: 'a b' }))],
    ['a numeric account id', JSON.stringify(accountPayload({ accountId: 5 }))],
    ['an intent reference on an account capability', JSON.stringify(intentPayload())],
  ])('quarantines a payload that is %s', async (_label, payload) => {
    insertOutbox(database, { payload });
    await expect(claim(200)).rejects.toThrow(invalid);
    expect(quarantined()).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'plugin_outbox_payload_invalid',
      dead_lettered_at: 200,
      delete_after: 200 + 90 * 24 * 60 * 60,
      claim_owner: null,
      claim_token: null,
    });
  });
  it.each([
    ['an uppercase capability', { capability: 'Hook.account' }],
    ['a capability with a space', { capability: 'hook account' }],
    ['a capability starting with a digit', { capability: '1hook' }],
    [
      'an uppercase event type',
      { eventType: 'Account.created', payload: accountPayload({ eventType: 'Account.created' }) },
    ],
    [
      'an event type that is too long',
      {
        eventType: `a${'b'.repeat(128)}`,
        payload: accountPayload({ eventType: `a${'b'.repeat(128)}` }),
      },
    ],
    ['an idempotency key with a space', { key: 'a b' }],
    [
      'a tenant with a space',
      { tenant: 'tenant a', payload: accountPayload({ tenantId: 'tenant a' }) },
    ],
    ['an installation starting with a dash', { installation: '-a' }],
  ])('quarantines a row with %s', async (_label, seed) => {
    insertOutbox(database, seed);
    await expect(claim(200)).rejects.toThrow(invalid);
    expect(quarantined().status).toBe('dead_letter');
  });
  it('accepts boundary-sized capability, event type and idempotency key', async () => {
    const name = `a${'b'.repeat(127)}`;
    insertOutbox(database, {
      capability: name,
      eventType: name,
      key: '!'.repeat(256),
      payload: accountPayload({ eventType: name }),
    });
    await expect(claim(200)).resolves.toMatchObject({ invocation: { capability: name } });
  });
  it('accepts a payload of an account event with any safe event version', async () => {
    insertOutbox(database, { eventVersion: 7, payload: accountPayload({ eventVersion: 7 }) });
    await expect(claim(200)).resolves.toMatchObject({
      invocation: { eventVersion: 7, payload: { eventVersion: 7 } },
    });
  });
  it.each([
    ['another capability', { capability: 'hook.account.lifecycle' }],
    [
      'another event type',
      {
        eventType: 'notification.other',
        payload: intentPayload({ eventType: 'notification.other' }),
      },
    ],
    ['another event version', { eventVersion: 2, payload: intentPayload({ eventVersion: 2 }) }],
  ])(
    'requires the exact notification contract for intent references (%s)',
    async (_label, seed) => {
      insertIntent(database);
      insertNotificationOutbox(database, seed);
      await expect(claim(200)).rejects.toThrow(invalid);
      expect(outboxRow(database, 'notification-a').status).toBe('dead_letter');
    }
  );
  it('dead-letters a notification row whose intent is gone, with its provider start missing', async () => {
    insertNotificationOutbox(database);
    await expect(claim(200)).rejects.toThrow(invalid);
    expect(outboxRow(database, 'notification-a').status).toBe('dead_letter');
  });
  it('quarantines a notification whose active provider is another installation', async () => {
    insertIntent(database, { providers: ['installation-a', 'installation-b'], activeIndex: 1 });
    insertNotificationOutbox(database);
    await expect(claim(200)).rejects.toThrow(invalid);
    expect(outboxRow(database, 'notification-a').status).toBe('dead_letter');
  });
  it('reports the intent start time and active provider for a notification claim', async () => {
    insertIntent(database, { startedAt: 120, createdAt: 100 });
    insertNotificationOutbox(database, { createdAt: 110 });
    await expect(claim(200)).resolves.toMatchObject({
      createdAt: 110,
      providerStartedAt: 120,
      invocation: {
        capability: 'notifier.send',
        eventType: 'notification.delivery.requested',
        payload: intentPayload(),
      },
    });
  });
  it('does not match an intent of another tenant', async () => {
    insertIntent(database, { tenant: 'tenant-b' });
    insertNotificationOutbox(database);
    await expect(claim(200)).rejects.toThrow(invalid);
  });
  describe('rows the database would not hold', () => {
    const base = {
      outbox_id: 'outbox-a',
      tenant_id: 'tenant-a',
      plugin_installation_id: 'installation-a',
      capability: 'hook.account.lifecycle',
      event_type: 'account.created',
      event_version: 1,
      idempotency_key: 'event/a',
      payload_json: JSON.stringify(accountPayload()),
      payload_class: 'reference_v1',
      status: 'locked',
      attempt_no: 1,
      claim_owner: 'runner-a',
      claim_token: 'claim-x',
      lease_until: 260,
      next_attempt_at: null,
      created_at: 100,
    };
    const claimWith = async (over: Record<string, unknown>) => {
      insertOutbox(database);
      let reads = 0;
      return claim(200, 'runner-a', {
        intercept: (call) => {
          if (call.kind !== 'first') return undefined;
          reads += 1;
          if (reads !== 2) return undefined;
          const real = outboxRow(database);
          return {
            value: { ...base, claim_owner: 'runner-a', claim_token: real.claim_token, ...over },
          };
        },
      });
    };
    it('accepts the unmodified shape', async () => {
      await expect(claimWith({})).resolves.toMatchObject({ outboxId: 'outbox-a' });
    });
    it.each([
      ['an unreadable event version', { event_version: 'x' }],
      ['a zero event version', { event_version: 0 }],
      ['a zero attempt', { attempt_no: 0 }],
      ['a textual attempt', { attempt_no: 'x' }],
      ['a missing lease', { lease_until: null }],
      ['a zero creation time', { created_at: 0 }],
      ['an unlocked status', { status: 'queued' }],
      ['another payload class', { payload_class: 'inline_v1' }],
    ])('refuses %s', async (_label, over) => {
      await expect(claimWith(over)).rejects.toThrow(invalid);
      expect(outboxRow(database).status).toBe('dead_letter');
    });
    it.each([
      ['no claim owner', { claim_owner: null }],
      ['an unsafe claim owner', { claim_owner: 'a b' }],
      ['no claim token', { claim_token: null }],
      ['an unsafe claim token', { claim_token: 'a b' }],
      ['an unsafe outbox id', { outbox_id: 'a b' }],
    ])('refuses %s without being able to quarantine it', async (_label, over) => {
      await expect(claimWith(over)).rejects.toThrow(/^plugin_outbox_quarantine_stale$/u);
    });
    it('refuses a payload that is not valid JSON or is oversized', async () => {
      await expect(claimWith({ payload_json: '{nope' })).rejects.toThrow(invalid);
    });
    it('refuses an oversized payload', async () => {
      await expect(
        claimWith({ payload_json: JSON.stringify(accountPayload({ pad: 'x'.repeat(16_400) })) })
      ).rejects.toThrow(invalid);
    });
  });
  it('reports a stale quarantine when the row was taken over meanwhile', async () => {
    insertOutbox(database, { payload: 'null' });
    await expect(
      claim(200, 'runner-a', {
        intercept: (call) =>
          call.kind === 'run' && call.sql.includes("status = 'dead_letter'")
            ? { value: { success: true, results: [], meta: { changes: 0 } } }
            : undefined,
      })
    ).rejects.toThrow(/^plugin_outbox_quarantine_stale$/u);
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}
