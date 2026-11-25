import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1PluginHookOutboxStore, type ClaimedPluginHook } from '../outbox';
import {
  insertIntent,
  insertNotificationOutbox,
  intentPayload,
  intentRow,
  outboxRow,
} from './helpers/outbox-seed';
import { createD1, openCoreDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function store(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { store: new D1PluginHookOutboxStore(d1.db), calls: d1.calls };
}
const REF = {
  ownerId: 'runner-a',
  now: 200,
  outboxId: 'notification-a',
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  intentId: 'intent-a',
};
const reference = (over: Record<string, unknown> = {}, options: D1Options = {}) =>
  store(options).store.claimReference({ ...REF, ...over });
const lost = { value: { success: true, results: [], meta: { changes: 0 } } };

function endIntent(state: 'delivered' | 'canceled' | 'expired' | 'dead_letter') {
  const column = {
    delivered: 'delivered_at',
    canceled: 'canceled_at',
    expired: 'canceled_at',
    dead_letter: 'dead_lettered_at',
  }[state];
  database.exec(
    `UPDATE notification_delivery_intents SET state = '${state}', payload_key_id = NULL, payload_envelope_json = NULL, ${column} = 150 WHERE intent_id = 'intent-a'`
  );
}

beforeEach(() => {
  database = openCoreDatabase();
  insertIntent(database);
  insertNotificationOutbox(database);
});

describe('claimReference input', () => {
  it.each([
    ['owner', { ownerId: '' }],
    ['owner start', { ownerId: '-x' }],
    ['outbox id', { outboxId: 'a b' }],
    ['tenant', { tenantId: '' }],
    ['installation', { pluginInstallationId: '-x' }],
    ['intent', { intentId: ' ' }],
    ['zero clock', { now: 0 }],
    ['fractional clock', { now: 1.5 }],
    ['unsafe clock', { now: 2 ** 53 }],
    ['long owner', { ownerId: 'a'.repeat(257) }],
  ])('rejects a bad %s before touching the database', async (_label, over) => {
    const { store: s, calls } = store();
    await expect(s.claimReference({ ...REF, ...over })).rejects.toThrow(
      /^plugin_outbox_reference_input_invalid$/u
    );
    expect(calls).toEqual([]);
  });
  it.each([
    ['another tenant', { tenantId: 'tenant-b' }],
    ['another outbox row', { outboxId: 'other' }],
    ['another intent', { intentId: 'other' }],
    ['another first provider', { pluginInstallationId: 'installation-z' }],
  ])('does not find a reference naming %s', async (_label, over) => {
    await expect(reference(over)).rejects.toThrow(/^plugin_outbox_reference_not_found$/u);
    expect(outboxRow(database, 'notification-a').status).toBe('queued');
  });
  it('does not find an outbox row whose payload differs from the fixed reference', async () => {
    database.exec(
      `UPDATE plugin_hook_outbox SET payload_json = '{"tenantId":"tenant-a","intentId":"intent-a","eventType":"notification.delivery.requested","eventVersion":1,"x":1}'`
    );
    await expect(reference()).rejects.toThrow(/^plugin_outbox_reference_not_found$/u);
  });
});

describe('claimReference outcome', () => {
  it('claims a queued reference with the intent start time', async () => {
    const result = await reference();
    expect(result).toEqual({
      state: 'claimed',
      claim: {
        outboxId: 'notification-a',
        attemptNo: 1,
        claimOwner: 'runner-a',
        claimToken: expect.stringMatching(/^claim-[0-9a-f-]{36}$/u) as unknown,
        leaseUntil: 260,
        createdAt: 100,
        providerStartedAt: 100,
        invocation: {
          pluginInstallationId: 'installation-a',
          tenantId: 'tenant-a',
          capability: 'notifier.send',
          eventType: 'notification.delivery.requested',
          eventVersion: 1,
          idempotencyKey: 'notification/a',
          payload: intentPayload(),
        },
      },
    });
    expect(outboxRow(database, 'notification-a')).toMatchObject({
      status: 'locked',
      attempt_no: 1,
      claim_owner: 'runner-a',
      lease_until: 260,
      next_attempt_at: null,
      updated_at: 200,
    });
  });
  it('binds the claim update in order', async () => {
    const { store: s, calls } = store();
    await s.claimReference(REF);
    const update = calls.find((c) => c.kind === 'run');
    expect(update?.values).toEqual([
      'runner-a',
      expect.stringMatching(/^claim-/u),
      260,
      200,
      'notification-a',
      'tenant-a',
      'installation-a',
      JSON.stringify({
        tenantId: 'tenant-a',
        intentId: 'intent-a',
        eventType: 'notification.delivery.requested',
        eventVersion: 1,
      }),
      'intent-a',
      'tenant-a',
      'installation-a',
      200,
      200,
    ]);
  });
  it.each([
    ['delivered', 'delivered'],
    ['canceled', 'permanent_failure'],
    ['expired', 'permanent_failure'],
    ['dead_letter', 'permanent_failure'],
  ] as const)('reports an intent that is %s as %s without claiming', async (state, expected) => {
    endIntent(state);
    await expect(reference()).resolves.toEqual({ state: expected });
    expect(outboxRow(database, 'notification-a').status).toBe('queued');
  });
  it('reports a live lease as pending and takes over an expired one', async () => {
    await reference({ now: 200 });
    await expect(reference({ now: 259, ownerId: 'runner-b' })).resolves.toEqual({
      state: 'pending',
    });
    await expect(reference({ now: 260, ownerId: 'runner-b' })).resolves.toMatchObject({
      state: 'claimed',
      claim: { attemptNo: 2, claimOwner: 'runner-b', leaseUntil: 320 },
    });
  });
  it('reports a waiting retry as pending until it is due', async () => {
    const claim = await reference();
    if (claim.state !== 'claimed') throw new Error('expected a claim');
    await store().store.fail(claim.claim, {
      now: 200,
      errorCode: 'plugin_hook_transient_failure',
      retryable: true,
      maxAttempts: 5,
      failureScope: 'message',
    });
    const due = outboxRow(database, 'notification-a').next_attempt_at as number;
    await expect(reference({ now: due - 1, ownerId: 'runner-b' })).resolves.toEqual({
      state: 'pending',
    });
    await expect(reference({ now: due, ownerId: 'runner-b' })).resolves.toMatchObject({
      state: 'claimed',
      claim: { attemptNo: 2 },
    });
  });
  it.each(['succeeded', 'dead_letter', 'canceled'])(
    'refuses a pending intent whose outbox row is %s',
    async (status) => {
      const claim = await reference();
      if (claim.state !== 'claimed') throw new Error('expected a claim');
      if (status === 'canceled') {
        database.exec(
          "UPDATE plugin_hook_outbox SET status = 'canceled', canceled_at = 5, claim_owner = NULL, claim_token = NULL, lease_until = NULL"
        );
      } else {
        database.exec(
          `UPDATE plugin_hook_outbox SET status = '${status}', claim_owner = NULL, claim_token = NULL, lease_until = NULL, ${
            status === 'succeeded'
              ? 'succeeded_at = 5, delete_after = 604805'
              : 'dead_lettered_at = 5, delete_after = 7776005'
          }`
        );
      }
      await expect(reference({ ownerId: 'runner-b' })).rejects.toThrow(
        /^plugin_outbox_reference_state_invalid$/u
      );
    }
  );
  it('reports the settled state seen after losing the claim race', async () => {
    let calls = 0;
    await expect(
      reference(
        {},
        { intercept: (call) => (call.kind === 'run' ? ((calls += 1), lost) : undefined) }
      )
    ).resolves.toEqual({ state: 'pending' });
    expect(calls).toBe(1);
  });
  it('reports a live lease taken by the winner of a race as pending', async () => {
    await expect(
      reference(
        {},
        {
          intercept: (call) => {
            if (call.kind !== 'run') return undefined;
            database.exec(
              "UPDATE plugin_hook_outbox SET status = 'locked', attempt_no = 1, claim_owner = 'other', claim_token = 'claim-other', lease_until = 300, updated_at = 150"
            );
            return lost;
          },
        }
      )
    ).resolves.toEqual({ state: 'pending' });
  });
  it('reports a race that settled the intent as its settled state', async () => {
    await expect(
      reference(
        {},
        {
          intercept: (call) => {
            if (call.kind !== 'run') return undefined;
            endIntent('delivered');
            return lost;
          },
        }
      )
    ).resolves.toEqual({ state: 'delivered' });
  });
  it('fails when the reference vanishes after losing the race', async () => {
    let loads = 0;
    await expect(
      reference(
        {},
        {
          intercept: (call) => {
            if (call.kind === 'first') {
              loads += 1;
              return loads === 2 ? { value: null } : undefined;
            }
            return call.kind === 'run' ? lost : undefined;
          },
        }
      )
    ).rejects.toThrow(/^plugin_outbox_reference_not_found$/u);
  });
  it.each([
    ['missing', null],
    ['not locked', { status: 'queued' }],
    ['owned by another worker', { claim_owner: 'someone-else' }],
    ['carrying another token', { claim_token: 'claim-other' }],
  ])('refuses a reflection that is %s', async (_label, patch) => {
    let loads = 0;
    await expect(
      reference(
        {},
        {
          intercept: (call) => {
            if (call.kind !== 'first') return undefined;
            loads += 1;
            if (loads !== 2) return undefined;
            if (patch === null) return { value: null };
            const real = database
              .prepare(
                "SELECT *, 'pending' AS intent_state FROM plugin_hook_outbox WHERE outbox_id = 'notification-a'"
              )
              .get();
            return { value: { ...real, ...patch } };
          },
        }
      )
    ).rejects.toThrow(/^plugin_outbox_claim_reflection_failed$/u);
  });
  it('quarantines a claimed reference that cannot be decoded and says so', async () => {
    let loads = 0;
    await expect(
      reference(
        {},
        {
          intercept: (call) => {
            if (call.kind !== 'first') return undefined;
            loads += 1;
            if (loads !== 2) return undefined;
            const real = database
              .prepare("SELECT * FROM plugin_hook_outbox WHERE outbox_id = 'notification-a'")
              .get();
            return {
              value: {
                ...real,
                intent_state: 'pending',
                payload_json: '{"tenantId":"other","intentId":"intent-a"}',
              },
            };
          },
        }
      )
    ).rejects.toThrow(/^plugin_outbox_claim_invalid$/u);
    expect(outboxRow(database, 'notification-a')).toMatchObject({
      status: 'dead_letter',
      last_error_code: 'plugin_outbox_payload_invalid',
    });
    expect(intentRow(database)).toMatchObject({ state: 'dead_letter', payload_key_id: null });
  });
});

describe('completion', () => {
  async function claimed(seedAccount = false): Promise<ClaimedPluginHook> {
    if (seedAccount) {
      database.exec('DELETE FROM plugin_hook_outbox; DELETE FROM notification_delivery_intents');
      database
        .prepare(
          `INSERT INTO plugin_hook_outbox (outbox_id, tenant_id, plugin_installation_id, capability, event_type, event_version, idempotency_key, payload_json, payload_class, status, attempt_no, created_at, updated_at) VALUES ('outbox-a', 'tenant-a', 'installation-a', 'hook.account.lifecycle', 'account.created', 1, 'event/a', ?, 'reference_v1', 'queued', 0, 100, 100)`
        )
        .run(
          JSON.stringify({
            tenantId: 'tenant-a',
            accountId: 'account-a',
            eventType: 'account.created',
            eventVersion: 1,
          })
        );
    }
    const result = await store().store.claimNext({ ownerId: 'runner-a', now: 200 });
    if (!result) throw new Error('nothing to claim');
    return result;
  }
  const failure = (over: Record<string, unknown> = {}) => ({
    now: 210,
    errorCode: 'plugin_hook_transient_failure',
    retryable: true,
    maxAttempts: 3,
    failureScope: 'message' as const,
    ...over,
  });

  it('records success on an account event row with a seven day retention', async () => {
    const claim = await claimed(true);
    await store().store.succeed(claim, 210);
    expect(outboxRow(database)).toMatchObject({
      status: 'succeeded',
      claim_owner: null,
      claim_token: null,
      lease_until: null,
      next_attempt_at: null,
      last_error_code: null,
      succeeded_at: 210,
      dead_lettered_at: null,
      delete_after: 210 + 7 * 24 * 60 * 60,
      updated_at: 210,
    });
  });
  it('records success on a notification row without counting an attempt', async () => {
    const claim = await claimed();
    await store().store.succeed(claim, 210);
    expect(outboxRow(database, 'notification-a')).toMatchObject({ status: 'succeeded' });
    expect(intentRow(database)).toMatchObject({
      attempt_count: 0,
      last_error_code: null,
      updated_at: 210,
    });
  });
  it.each([0, -1, 1.5, Number.NaN, 2 ** 53])('refuses a completion clock of %s', async (now) => {
    const claim = await claimed();
    await expect(store().store.succeed(claim, now)).rejects.toThrow(
      /^plugin_outbox_completion_input_invalid$/u
    );
    expect(outboxRow(database, 'notification-a').status).toBe('locked');
  });
  it.each([
    ['another owner', { claimOwner: 'someone-else' }],
    ['another token', { claimToken: 'claim-other' }],
    ['another attempt', { attemptNo: 9 }],
    ['another outbox row', { outboxId: 'other' }],
  ])('refuses a stale claim naming %s', async (_label, patch) => {
    const claim = await claimed(true);
    await expect(store().store.succeed({ ...claim, ...patch }, 210)).rejects.toThrow(
      /^plugin_outbox_stale_claim$/u
    );
    expect(outboxRow(database).status).toBe('locked');
  });
  it('refuses a stale claim on another tenant or installation', async () => {
    const claim = await claimed(true);
    await expect(
      store().store.succeed(
        { ...claim, invocation: { ...claim.invocation, tenantId: 'tenant-b' } },
        210
      )
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
    await expect(
      store().store.succeed(
        { ...claim, invocation: { ...claim.invocation, pluginInstallationId: 'other' } },
        210
      )
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
  });
  it('refuses a notification completion when the outbox row is stale, leaving that row locked', async () => {
    const claim = await claimed();
    await expect(
      store().store.succeed({ ...claim, claimToken: 'claim-other' }, 210)
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
    expect(outboxRow(database, 'notification-a')).toMatchObject({
      status: 'locked',
      claim_token: claim.claimToken,
    });
  });
  it('refuses when the notification intent does not exist', async () => {
    const claim = await claimed();
    await expect(
      store().store.succeed(
        {
          ...claim,
          invocation: { ...claim.invocation, payload: intentPayload({ intentId: 'other' }) },
        },
        210
      )
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
  });
  it('refuses unsuccessful batch results', async () => {
    const claim = await claimed();
    const ok = { success: true, results: [], meta: { changes: 1 } };
    for (const results of [
      [{ ...ok, success: false }, ok],
      [ok, { ...ok, error: 'x' }],
      [ok, { ...ok, meta: { changes: 0 } }],
      [{ ...ok, meta: { changes: 0 } }, ok],
      [ok, { ...ok, meta: {} }],
    ]) {
      await expect(
        store({
          intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
        }).store.succeed(claim, 210)
      ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
    }
  });
  it('refuses an account row whose update changed nothing or reported failure', async () => {
    const claim = await claimed(true);
    await expect(
      store({ intercept: (call) => (call.kind === 'run' ? lost : undefined) }).store.succeed(
        claim,
        210
      )
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
    await expect(
      store({
        intercept: (call) =>
          call.kind === 'run' ? { value: { success: true, results: [], meta: {} } } : undefined,
      }).store.succeed(claim, 210)
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
  });

  describe('failure', () => {
    it.each([
      ['uppercase', 'Plugin_failure'],
      ['digit first', '1plugin'],
      ['empty', ''],
      ['space', 'plugin failure'],
      ['dot', 'plugin.failure'],
      ['too long', `a${'b'.repeat(128)}`],
    ])('rejects an error code that is %s', async (_label, errorCode) => {
      const claim = await claimed();
      await expect(store().store.fail(claim, failure({ errorCode }))).rejects.toThrow(
        /^plugin_outbox_failure_input_invalid$/u
      );
    });
    it.each([0, -1, 101, 1.5, Number.NaN, 2 ** 53])('rejects %s attempts', async (maxAttempts) => {
      const claim = await claimed();
      await expect(store().store.fail(claim, failure({ maxAttempts }))).rejects.toThrow(
        /^plugin_outbox_failure_input_invalid$/u
      );
    });
    it.each([1, 100])('accepts a ceiling of %i attempts', async (maxAttempts) => {
      const claim = await claimed(true);
      await expect(store().store.fail(claim, failure({ maxAttempts }))).resolves.toMatch(
        /^(waiting_retry|dead_letter)$/u
      );
    });
    it('accepts error codes at the length limit and with the allowed punctuation', async () => {
      const claim = await claimed(true);
      await expect(
        store().store.fail(claim, failure({ errorCode: `a${'b'.repeat(127)}` }))
      ).resolves.toBe('waiting_retry');
    });
    it('schedules a retry with the deterministic jittered delay', async () => {
      const claim = await claimed(true);
      await expect(store().store.fail(claim, failure())).resolves.toBe('waiting_retry');
      expect(outboxRow(database)).toMatchObject({
        status: 'waiting_retry',
        next_attempt_at: 215,
        last_error_code: 'plugin_hook_transient_failure',
        claim_owner: null,
        claim_token: null,
        lease_until: null,
        delete_after: null,
        dead_lettered_at: null,
        succeeded_at: null,
        updated_at: 210,
      });
    });
    it.each([
      [1, 5],
      [2, 11],
      [3, 21],
      [4, 41],
      [8, 721],
      [9, 949],
      [10, 949],
    ])('delays attempt %i of outbox-a by %i seconds', async (attemptNo, delay) => {
      let claim = await claimed(true);
      let clock = 200;
      for (let attempt = 1; attempt < attemptNo; attempt++) {
        await store().store.fail(claim, failure({ now: clock, maxAttempts: 100 }));
        clock = outboxRow(database).next_attempt_at as number;
        const next = await store().store.claimNext({ ownerId: 'runner-a', now: clock });
        if (!next) throw new Error('retry was not due');
        claim = next;
      }
      expect(claim.attemptNo).toBe(attemptNo);
      await store().store.fail(claim, failure({ now: clock, maxAttempts: 100 }));
      expect(outboxRow(database).next_attempt_at).toBe(clock + delay);
    });
    it('dead-letters when the attempts are used up, keeping the row for ninety days', async () => {
      const claim = await claimed(true);
      await expect(store().store.fail(claim, failure({ maxAttempts: 1 }))).resolves.toBe(
        'dead_letter'
      );
      expect(outboxRow(database)).toMatchObject({
        status: 'dead_letter',
        next_attempt_at: null,
        dead_lettered_at: 210,
        delete_after: 210 + 90 * 24 * 60 * 60,
        last_error_code: 'plugin_hook_transient_failure',
      });
    });
    it('dead-letters a non-retryable failure at once', async () => {
      const claim = await claimed(true);
      await expect(store().store.fail(claim, failure({ retryable: false }))).resolves.toBe(
        'dead_letter'
      );
    });
    it('counts a retried notification attempt on its intent without wiping the payload', async () => {
      const claim = await claimed();
      await expect(store().store.fail(claim, failure())).resolves.toBe('waiting_retry');
      expect(intentRow(database)).toMatchObject({
        state: 'pending',
        attempt_count: 1,
        last_error_code: 'plugin_hook_transient_failure',
        payload_key_id: 'key-a',
        updated_at: 210,
      });
    });
    it('wipes the payload of a dead-lettered notification and records the final failure', async () => {
      const claim = await claimed();
      await expect(store().store.fail(claim, failure({ retryable: false }))).resolves.toBe(
        'dead_letter'
      );
      expect(intentRow(database)).toMatchObject({
        state: 'dead_letter',
        payload_key_id: null,
        payload_envelope_json: null,
        dead_lettered_at: 210,
        delivery_status: 'failed',
        delivery_status_updated_at: 210,
        attempt_count: 1,
        last_error_code: 'plugin_hook_transient_failure',
        delete_after: 210 + 90 * 24 * 60 * 60,
        updated_at: 210,
      });
      expect(outboxRow(database, 'notification-a')).toMatchObject({
        status: 'dead_letter',
        dead_lettered_at: 210,
        delete_after: 210 + 90 * 24 * 60 * 60,
      });
    });
    it('refuses to dead-letter a notification when the batch results are not clean', async () => {
      const claim = await claimed();
      const ok = { success: true, results: [], meta: { changes: 1 } };
      for (const results of [
        [{ ...ok, success: false }, ok],
        [ok, { ...ok, error: 'x' }],
        [ok, { ...ok, meta: { changes: 0 } }],
        [ok, { ...ok, meta: {} }],
        [ok],
      ]) {
        await expect(
          store({
            intercept: (call) => (call.kind === 'batch' ? { value: results } : undefined),
          }).store.fail(claim, failure({ retryable: false }))
        ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
      }
    });
  });
});
