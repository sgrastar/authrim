import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { D1PluginHookOutboxStore } from '../outbox';
import {
  insertIntent,
  insertNotificationOutbox,
  insertOutbox,
  intentRow,
  outboxRow,
} from './helpers/outbox-seed';
import { createD1, openCoreDatabase, type D1Options } from './helpers/sqlite-d1';

let database: DatabaseSync;
function store(options: D1Options = {}) {
  const d1 = createD1(database, options);
  return { store: new D1PluginHookOutboxStore(d1.db), calls: d1.calls };
}
const ok = { success: true, results: [], meta: { changes: 1 } };
const REF = {
  ownerId: 'runner-a',
  now: 200,
  outboxId: 'notification-a',
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  intentId: 'intent-a',
};
const failure = (over: Record<string, unknown> = {}) => ({
  now: 300,
  errorCode: 'plugin_hook_provider_rejected',
  retryable: false,
  maxAttempts: 3,
  failureScope: 'provider' as const,
  ...over,
});
const providerState = () =>
  database
    .prepare(
      `SELECT intent.state, intent.provider_installation_ids_json, intent.active_provider_index, intent.provider_started_at, outbox.status AS outbox_status, outbox.plugin_installation_id AS outbox_plugin_installation_id, outbox.attempt_no AS outbox_attempt_no, outbox.claim_owner AS outbox_claim_owner, outbox.claim_token AS outbox_claim_token, outbox.next_attempt_at AS outbox_next_attempt_at FROM notification_delivery_intents intent JOIN plugin_hook_outbox outbox ON outbox.outbox_id = 'notification-a'`
    )
    .get() as Record<string, unknown>;

beforeEach(() => {
  database = openCoreDatabase();
});

describe('clock edges', () => {
  it('claims a reference and completes a hook at the smallest clock value', async () => {
    insertIntent(database, { startedAt: 1, createdAt: 1 });
    insertNotificationOutbox(database, { createdAt: 1 });
    const result = await store().store.claimReference({ ...REF, now: 1 });
    if (result.state !== 'claimed') throw new Error('expected a claim');
    expect(result.claim.leaseUntil).toBe(61);
    await expect(store().store.succeed(result.claim, 1)).resolves.toBeUndefined();
    expect(outboxRow(database, 'notification-a')).toMatchObject({
      status: 'succeeded',
      succeeded_at: 1,
    });
  });
  it('claims the next hook at the smallest clock value', async () => {
    insertOutbox(database, { createdAt: 1 });
    await expect(store().store.claimNext({ ownerId: 'runner-a', now: 1 })).resolves.toMatchObject({
      leaseUntil: 61,
    });
  });
});

describe('pending references', () => {
  beforeEach(() => {
    insertIntent(database);
    insertNotificationOutbox(database);
  });
  it('does not write while another worker holds a live lease or a retry is not due', async () => {
    await store().store.claimReference(REF);
    const { store: s, calls } = store();
    await expect(s.claimReference({ ...REF, ownerId: 'runner-b', now: 259 })).resolves.toEqual({
      state: 'pending',
    });
    expect(calls.filter((c) => c.kind === 'run' || c.kind === 'batch')).toEqual([]);
    const claim = await store().store.claimNext({ ownerId: 'runner-c', now: 260 });
    if (!claim) throw new Error('expected a claim');
    await store().store.fail(
      claim,
      failure({ now: 260, retryable: true, errorCode: 'plugin_hook_transient_failure' })
    );
    const due = outboxRow(database, 'notification-a').next_attempt_at as number;
    const waiting = store();
    await expect(
      waiting.store.claimReference({ ...REF, ownerId: 'runner-d', now: due - 1 })
    ).resolves.toEqual({
      state: 'pending',
    });
    expect(waiting.calls.filter((c) => c.kind === 'run')).toEqual([]);
  });
  it('refuses an intent state it does not know', async () => {
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('intent.state AS intent_state')
            ? { ...(value as object), intent_state: null }
            : value,
      }).store.claimReference(REF)
    ).rejects.toThrow(/^plugin_outbox_reference_state_invalid$/u);
  });
});

describe('quarantine reach', () => {
  const quarantineOf = (seed: Parameters<typeof insertOutbox>[1], options: D1Options = {}) => {
    insertOutbox(database, { ...seed, payload: 'null' });
    return store(options).store.claimNext({ ownerId: 'runner-a', now: 200 });
  };
  it.each([
    ['an account event', { id: 'event-a', key: 'notification/a' }],
    [
      'another capability',
      {
        id: 'event-a',
        capability: 'hook.other',
        eventType: 'notification.delivery.requested',
        key: 'notification/a',
      },
    ],
    [
      'another event type',
      {
        id: 'event-a',
        capability: 'notifier.send',
        eventType: 'notification.other',
        key: 'notification/a',
      },
    ],
    [
      'another event version',
      {
        id: 'event-a',
        capability: 'notifier.send',
        eventType: 'notification.delivery.requested',
        eventVersion: 2,
        key: 'notification/a',
      },
    ],
  ])('leaves a notification intent alone when the quarantined row is %s', async (_label, seed) => {
    insertIntent(database);
    await expect(quarantineOf(seed)).rejects.toThrow(/^plugin_outbox_claim_invalid$/u);
    expect(intentRow(database)).toMatchObject({ state: 'pending', payload_key_id: 'key-a' });
    expect(outboxRow(database, 'event-a').status).toBe('dead_letter');
  });
  it('wipes the intent of a quarantined notification row for the same provider only', async () => {
    insertIntent(database, { providers: ['installation-a'] });
    await expect(
      quarantineOf({
        id: 'event-a',
        capability: 'notifier.send',
        eventType: 'notification.delivery.requested',
        key: 'notification/a',
      })
    ).rejects.toThrow(/^plugin_outbox_claim_invalid$/u);
    expect(intentRow(database)).toMatchObject({
      state: 'dead_letter',
      last_error_code: 'plugin_outbox_payload_invalid',
    });
  });
  it.each([
    ['an unsuccessful result', { success: false, results: [], meta: { changes: 1 } }],
    [
      'a result carrying an error',
      { success: true, error: 'x', results: [], meta: { changes: 1 } },
    ],
    ['no change', { success: true, results: [], meta: { changes: 0 } }],
    ['no change count', { success: true, results: [], meta: {} }],
  ])('reports %s for an account row as a stale quarantine', async (_label, value) => {
    await expect(
      quarantineOf(
        { id: 'event-a' },
        {
          intercept: (call) =>
            call.kind === 'run' && call.sql.includes("status = 'dead_letter'")
              ? { value }
              : undefined,
        }
      )
    ).rejects.toThrow(/^plugin_outbox_quarantine_stale$/u);
  });
  it('reports an empty notification quarantine batch as stale', async () => {
    insertIntent(database);
    await expect(
      quarantineOf(
        {
          id: 'event-a',
          capability: 'notifier.send',
          eventType: 'notification.delivery.requested',
          key: 'notification/a',
        },
        { intercept: (call) => (call.kind === 'batch' ? { value: [] } : undefined) }
      )
    ).rejects.toThrow(/^plugin_outbox_quarantine_stale$/u);
  });
});

describe('completion batches', () => {
  it('treats an empty batch result as stale rather than crashing', async () => {
    insertIntent(database);
    insertNotificationOutbox(database);
    const claim = await store().store.claimNext({ ownerId: 'runner-a', now: 200 });
    if (!claim) throw new Error('expected a claim');
    await expect(
      store({
        intercept: (call) => (call.kind === 'batch' ? { value: [] } : undefined),
      }).store.succeed(claim, 210)
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
    await expect(
      store({
        intercept: (call) => (call.kind === 'batch' ? { value: [] } : undefined),
      }).store.fail(claim, failure({ retryable: false, failureScope: 'message' }))
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
  });
});

describe('provider failover edges', () => {
  async function claimed(providers: string[]) {
    insertIntent(database, { providers });
    insertNotificationOutbox(database);
    const claim = await store().store.claimNext({ ownerId: 'runner-a', now: 200 });
    if (!claim) throw new Error('expected a claim');
    return claim;
  }
  it('dead-letters when the only provider rejects', async () => {
    const claim = await claimed(['installation-a']);
    await expect(store().store.fail(claim, failure())).resolves.toBe('dead_letter');
    expect(intentRow(database)).toMatchObject({ state: 'dead_letter', payload_key_id: null });
  });
  it('refuses an advance whose statements report failure although the rows moved', async () => {
    const claim = await claimed(['installation-a', 'installation-b']);
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'batch' && call.sql.includes('active_provider_index')
            ? [{ ...ok, success: false }, ok]
            : value,
      }).store.fail(claim, failure())
    ).rejects.toThrow(/^plugin_outbox_provider_advance_failed$/u);
  });
  it('refuses an advance whose second statement carries an error although the rows moved', async () => {
    const claim = await claimed(['installation-a', 'installation-b']);
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'batch' && call.sql.includes('active_provider_index')
            ? [ok, { ...ok, error: 'x' }]
            : value,
      }).store.fail(claim, failure())
    ).rejects.toThrow(/^plugin_outbox_provider_advance_failed$/u);
  });
  it.each(['locked', 'queued', 'waiting_retry'])(
    'adopts an advance already made when the new provider row is %s',
    async (status) => {
      const claim = await claimed(['installation-a', 'installation-b']);
      await store().store.fail(claim, failure({ now: 300 }));
      let reads = 0;
      await expect(
        store({
          rewrite: (call, value) => {
            if (call.kind === 'first' && call.sql.includes('outbox_status')) {
              reads += 1;
              return { ...(value as object), outbox_status: status };
            }
            return value;
          },
        }).store.fail(claim, failure({ now: 305 }))
      ).resolves.toBe('waiting_retry');
      expect(reads).toBe(1);
      expect(intentRow(database)).toMatchObject({
        active_provider_index: 1,
        provider_started_at: 300,
      });
    }
  );
  it('refuses to adopt when the new provider row is in a settled status', async () => {
    const claim = await claimed(['installation-a', 'installation-b']);
    await store().store.fail(claim, failure({ now: 300 }));
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('outbox_status')
            ? { ...(value as object), outbox_status: 'succeeded' }
            : value,
      }).store.fail(claim, failure({ now: 305 }))
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
  });
  it.each([
    ['an unreadable start time', { provider_started_at: 'x' }],
    ['a zero start time', { provider_started_at: 0 }],
    ['an unreadable attempt number', { outbox_attempt_no: 'x' }],
    ['a missing retry time', { outbox_next_attempt_at: null }],
    ['an unreadable index', { active_provider_index: 'x' }],
  ])('rejects a reflection with %s as an invalid notification state', async (_label, patch) => {
    const claim = await claimed(['installation-a', 'installation-b']);
    let reads = 0;
    await expect(
      store({
        rewrite: (call, value) => {
          if (call.kind === 'first' && call.sql.includes('outbox_status')) {
            reads += 1;
            return reads === 2 ? { ...(value as object), ...patch } : value;
          }
          return value;
        },
      }).store.fail(claim, failure())
    ).rejects.toThrow(/^plugin_outbox_notification_state_invalid$/u);
  });
  it('rejects a reflection that shows another active provider as a failed advance', async () => {
    const claim = await claimed(['installation-a', 'installation-b', 'installation-c']);
    let reads = 0;
    await expect(
      store({
        rewrite: (call, value) => {
          if (call.kind === 'first' && call.sql.includes('outbox_status')) {
            reads += 1;
            return reads === 2 ? { ...(value as object), active_provider_index: 2 } : value;
          }
          return value;
        },
      }).store.fail(claim, failure())
    ).rejects.toThrow(/^plugin_outbox_provider_advance_failed$/u);
  });
  it.each([
    ['a list below the minimum', '[]'],
    [
      'a list above the maximum',
      JSON.stringify([
        'installation-a',
        ...Array.from({ length: 8 }, (_, i) => `installation-${i}`),
      ]),
    ],
  ])('rejects %s read from storage', async (_label, json) => {
    const claim = await claimed(['installation-a', 'installation-b']);
    await expect(
      store({
        rewrite: (call, value) =>
          call.kind === 'first' && call.sql.includes('outbox_status')
            ? { ...(value as object), provider_installation_ids_json: json }
            : value,
      }).store.fail(claim, failure())
    ).rejects.toThrow(/^plugin_outbox_notification_state_invalid$/u);
    expect(providerState().active_provider_index).toBe(0);
  });
});

describe('stale claims cannot touch the notification intent', () => {
  async function liveClaim(providers = ['installation-a']) {
    insertIntent(database, { providers });
    insertNotificationOutbox(database);
    const claim = await store().store.claimNext({ ownerId: 'runner-a', now: 200 });
    if (!claim) throw new Error('expected a claim');
    return claim;
  }
  async function staleClaim(providers = ['installation-a']) {
    return { ...(await liveClaim(providers)), claimToken: 'claim-stale' };
  }
  const untouched = () =>
    expect(intentRow(database)).toMatchObject({
      state: 'pending',
      attempt_count: 0,
      last_error_code: null,
      updated_at: 100,
      active_provider_index: 0,
    });
  it.each([
    [
      'a success',
      (claim: Awaited<ReturnType<typeof staleClaim>>) => store().store.succeed(claim, 300),
    ],
    [
      'a retried failure',
      (claim: Awaited<ReturnType<typeof staleClaim>>) =>
        store().store.fail(claim, failure({ retryable: true, failureScope: 'message' })),
    ],
    [
      'a terminal failure',
      (claim: Awaited<ReturnType<typeof staleClaim>>) =>
        store().store.fail(claim, failure({ retryable: false, failureScope: 'message' })),
    ],
  ])('leaves the intent alone for %s with a stale token', async (_label, run) => {
    const claim = await staleClaim();
    await expect(run(claim)).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
    untouched();
    expect(outboxRow(database, 'notification-a')).toMatchObject({ status: 'locked' });
  });
  it.each([
    ['another attempt', { attemptNo: 9 }],
    ['another owner', { claimOwner: 'someone-else' }],
    ['another outbox id', { outboxId: 'notification-other' }],
    ['another tenant', { invocation: { tenantId: 'tenant-other' } }],
    ['another installation', { invocation: { pluginInstallationId: 'installation-other' } }],
  ])('leaves the intent alone when only the claim has %s', async (_label, patch) => {
    // Everything but the patched field is the live claim, so only that one fence can stop it.
    const live = await liveClaim();
    const claim = {
      ...live,
      ...patch,
      invocation: { ...live.invocation, ...('invocation' in patch ? patch.invocation : {}) },
    };
    expect(claim.claimToken).toBe(live.claimToken);
    await expect(store().store.succeed(claim, 300)).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
    untouched();
    expect(outboxRow(database, 'notification-a')).toMatchObject({ status: 'locked' });
  });
  it.each([
    ['another attempt', { attemptNo: 9 }],
    ['another owner', { claimOwner: 'someone-else' }],
  ])(
    'keeps the provider and intent for a retried failure of a claim with %s',
    async (_label, patch) => {
      const claim = { ...(await liveClaim(['installation-a', 'installation-b'])), ...patch };
      await expect(store().store.fail(claim, failure())).rejects.toThrow(/^plugin_outbox_/u);
      untouched();
    }
  );
  it('does not advance the provider of the intent for a stale provider failure', async () => {
    const claim = await staleClaim(['installation-a', 'installation-b']);
    await expect(store().store.fail(claim, failure())).rejects.toThrow(/^plugin_outbox_/u);
    untouched();
    expect(outboxRow(database, 'notification-a')).toMatchObject({
      plugin_installation_id: 'installation-a',
      status: 'locked',
    });
  });
  it('still applies the intent update for the live claim', async () => {
    insertIntent(database);
    insertNotificationOutbox(database);
    const claim = await store().store.claimNext({ ownerId: 'runner-a', now: 200 });
    if (!claim) throw new Error('expected a claim');
    await store().store.fail(
      claim,
      failure({ now: 300, retryable: true, failureScope: 'message' })
    );
    expect(intentRow(database)).toMatchObject({
      attempt_count: 1,
      last_error_code: 'plugin_hook_provider_rejected',
      updated_at: 300,
    });
  });
});
