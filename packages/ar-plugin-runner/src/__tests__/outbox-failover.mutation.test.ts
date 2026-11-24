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
const PROVIDERS = ['installation-a', 'installation-b', 'installation-c'];
const NINETY_DAYS = 90 * 24 * 60 * 60;
const providerFailure = (over: Record<string, unknown> = {}) => ({
  now: 300,
  errorCode: 'plugin_hook_provider_rejected',
  retryable: false,
  maxAttempts: 3,
  failureScope: 'provider' as const,
  ...over,
});
async function claimOne(now = 200): Promise<ClaimedPluginHook> {
  const claim = await store().store.claimNext({ ownerId: 'runner-a', now });
  if (!claim) throw new Error('nothing to claim');
  return claim;
}

beforeEach(() => {
  database = openCoreDatabase();
  insertIntent(database, { providers: PROVIDERS });
  insertNotificationOutbox(database);
});

describe('provider failover', () => {
  it('moves a rejected notification to the next provider without wiping the payload', async () => {
    const claim = await claimOne();
    await expect(store().store.fail(claim, providerFailure())).resolves.toBe('waiting_retry');
    expect(intentRow(database)).toMatchObject({
      state: 'pending',
      active_provider_index: 1,
      provider_started_at: 300,
      attempt_count: 1,
      last_error_code: 'plugin_hook_provider_rejected',
      updated_at: 300,
      payload_key_id: 'key-a',
    });
    expect(outboxRow(database, 'notification-a')).toMatchObject({
      plugin_installation_id: 'installation-b',
      status: 'waiting_retry',
      attempt_no: 0,
      claim_owner: null,
      claim_token: null,
      lease_until: null,
      next_attempt_at: 300,
      last_error_code: 'plugin_hook_provider_rejected',
      updated_at: 300,
    });
    const next = await store().store.claimNext({ ownerId: 'runner-b', now: 300 });
    expect(next).toMatchObject({
      attemptNo: 1,
      providerStartedAt: 300,
      invocation: { pluginInstallationId: 'installation-b' },
    });
  });
  it('walks the whole provider order and dead-letters after the last one', async () => {
    let claim = await claimOne();
    await store().store.fail(claim, providerFailure({ now: 300 }));
    claim = must(await store().store.claimNext({ ownerId: 'runner-a', now: 300 }));
    await store().store.fail(claim, providerFailure({ now: 310 }));
    expect(intentRow(database)).toMatchObject({
      active_provider_index: 2,
      provider_started_at: 310,
    });
    claim = must(await store().store.claimNext({ ownerId: 'runner-a', now: 310 }));
    expect(claim.invocation.pluginInstallationId).toBe('installation-c');
    await expect(store().store.fail(claim, providerFailure({ now: 320 }))).resolves.toBe(
      'dead_letter'
    );
    expect(intentRow(database)).toMatchObject({
      state: 'dead_letter',
      payload_key_id: null,
      attempt_count: 3,
      dead_lettered_at: 320,
      delete_after: 320 + NINETY_DAYS,
    });
    expect(outboxRow(database, 'notification-a')).toMatchObject({
      status: 'dead_letter',
      plugin_installation_id: 'installation-c',
    });
  });
  it('binds the intent advance and the outbox move in order', async () => {
    const claim = await claimOne();
    const { store: s, calls } = store();
    await s.fail(claim, providerFailure());
    const batch = must(calls.find((c) => c.kind === 'batch'));
    expect(batch.values).toEqual([
      1,
      300,
      'plugin_hook_provider_rejected',
      300,
      'intent-a',
      'tenant-a',
      0,
      'installation-a',
      'notification-a',
      'tenant-a',
      'installation-a',
      'runner-a',
      claim.claimToken,
      1,
      'installation-b',
      300,
      'plugin_hook_provider_rejected',
      300,
      'notification-a',
      'tenant-a',
      'installation-a',
      'runner-a',
      claim.claimToken,
      1,
      'intent-a',
      'tenant-a',
      1,
      300,
      'installation-b',
    ]);
  });
  it.each(['message', 'platform'] as const)(
    'does not fail over for a %s-scoped terminal failure',
    async (failureScope) => {
      const claim = await claimOne();
      await expect(store().store.fail(claim, providerFailure({ failureScope }))).resolves.toBe(
        'dead_letter'
      );
      expect(intentRow(database)).toMatchObject({ state: 'dead_letter', active_provider_index: 0 });
    }
  );
  it('keeps retrying the same provider while attempts remain', async () => {
    const claim = await claimOne();
    await expect(
      store().store.fail(claim, providerFailure({ retryable: true, maxAttempts: 3 }))
    ).resolves.toBe('waiting_retry');
    expect(intentRow(database)).toMatchObject({ active_provider_index: 0, attempt_count: 1 });
    expect(outboxRow(database, 'notification-a').plugin_installation_id).toBe('installation-a');
  });
  it('fails over once the retries of a provider are exhausted', async () => {
    const claim = await claimOne();
    await expect(
      store().store.fail(claim, providerFailure({ retryable: true, maxAttempts: 1 }))
    ).resolves.toBe('waiting_retry');
    expect(intentRow(database)).toMatchObject({ active_provider_index: 1 });
  });
  it('does not fail over an account event row', async () => {
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
    const claim = await claimOne();
    await expect(store().store.fail(claim, providerFailure())).resolves.toBe('dead_letter');
  });
  it('adopts an advance another worker already made', async () => {
    const claim = await claimOne();
    await store().store.fail(claim, providerFailure({ now: 300 }));
    await expect(store().store.fail(claim, providerFailure({ now: 305 }))).resolves.toBe(
      'waiting_retry'
    );
    expect(intentRow(database)).toMatchObject({
      active_provider_index: 1,
      provider_started_at: 300,
    });
  });
  it('refuses a claim for a provider that is not the active one at the first position', async () => {
    const claim = await claimOne();
    await expect(
      store().store.fail(
        { ...claim, invocation: { ...claim.invocation, pluginInstallationId: 'installation-z' } },
        providerFailure()
      )
    ).rejects.toThrow(/^plugin_outbox_stale_claim$/u);
  });
  it('refuses when the intent is no longer pending or the outbox row drifted', async () => {
    const claim = await claimOne();
    database.exec(
      "UPDATE notification_delivery_intents SET state = 'canceled', payload_key_id = NULL, payload_envelope_json = NULL, canceled_at = 150"
    );
    await expect(store().store.fail(claim, providerFailure())).rejects.toThrow(
      /^plugin_outbox_notification_state_invalid$/u
    );
  });
  it('refuses when the outbox row points at another provider than the intent', async () => {
    const claim = await claimOne();
    database.exec("UPDATE plugin_hook_outbox SET plugin_installation_id = 'installation-b'");
    await expect(store().store.fail(claim, providerFailure())).rejects.toThrow(
      /^plugin_outbox_notification_state_invalid$/u
    );
  });
  it('refuses when the intent does not exist', async () => {
    const claim = await claimOne();
    await expect(
      store().store.fail(
        {
          ...claim,
          invocation: {
            ...claim.invocation,
            payload: intentPayload({ intentId: 'other' }),
          },
        },
        providerFailure()
      )
    ).rejects.toThrow(/^plugin_outbox_notification_state_invalid$/u);
  });
  describe('provider lists read from storage', () => {
    const failWith = async (patch: Record<string, unknown>) => {
      const claim = await claimOne();
      return store({
        intercept: (call) => {
          if (call.kind !== 'first' || !call.sql.includes('outbox_status')) return undefined;
          const real = database
            .prepare(
              `SELECT intent.state, intent.provider_installation_ids_json, intent.active_provider_index, intent.provider_started_at, outbox.status AS outbox_status, outbox.plugin_installation_id AS outbox_plugin_installation_id, outbox.attempt_no AS outbox_attempt_no, outbox.claim_owner AS outbox_claim_owner, outbox.claim_token AS outbox_claim_token, outbox.next_attempt_at AS outbox_next_attempt_at FROM notification_delivery_intents intent JOIN plugin_hook_outbox outbox ON outbox.outbox_id = 'notification-a'`
            )
            .get();
          return { value: { ...real, ...patch } };
        },
      }).store.fail(claim, providerFailure());
    };
    const INVALID = /^plugin_outbox_notification_state_invalid$/u;
    it.each([
      ['unparseable', '{nope'],
      ['not an array', '{"a":1}'],
      ['empty', '[]'],
      ['nine entries', JSON.stringify(Array.from({ length: 9 }, (_, i) => `p${i}`))],
      ['a non-string entry', JSON.stringify(['installation-a', 5])],
      ['an unsafe entry', JSON.stringify(['installation-a', 'a b'])],
      ['duplicate entries', JSON.stringify(['installation-a', 'installation-a'])],
    ])('rejects a provider list that is %s', async (_label, json) => {
      await expect(failWith({ provider_installation_ids_json: json })).rejects.toThrow(INVALID);
    });
    it('accepts a list of exactly eight providers', async () => {
      database.exec('DELETE FROM plugin_hook_outbox; DELETE FROM notification_delivery_intents');
      const eight = [
        'installation-a',
        ...Array.from({ length: 7 }, (_, i) => `installation-p${i}`),
      ];
      insertIntent(database, { providers: eight });
      insertNotificationOutbox(database);
      await expect(failWith({})).resolves.toBe('waiting_retry');
      expect(intentRow(database)).toMatchObject({ active_provider_index: 1 });
    });
    it.each([
      ['a negative index', -1],
      ['a fractional index', 0.5],
      ['a textual index', 'x'],
    ])('rejects %s', async (_label, index) => {
      await expect(failWith({ active_provider_index: index })).rejects.toThrow(INVALID);
    });
    it('rejects an index beyond the list', async () => {
      await expect(failWith({ active_provider_index: 7 })).rejects.toThrow(INVALID);
    });
  });
  describe('advance verification', () => {
    const ok = { success: true, results: [], meta: { changes: 1 } };
    const advanceWith = async (
      batchResult: unknown,
      reflection?: (real: Record<string, unknown>) => Record<string, unknown> | null
    ) => {
      const claim = await claimOne();
      let loads = 0;
      return store({
        intercept: (call) => {
          if (call.kind === 'batch' && call.sql.includes('active_provider_index')) {
            if (batchResult === 'real') return undefined;
            return { value: batchResult };
          }
          if (call.kind === 'first' && call.sql.includes('outbox_status') && reflection) {
            loads += 1;
            if (loads < 2) return undefined;
            const real = database
              .prepare(
                `SELECT intent.state, intent.provider_installation_ids_json, intent.active_provider_index, intent.provider_started_at, outbox.status AS outbox_status, outbox.plugin_installation_id AS outbox_plugin_installation_id, outbox.attempt_no AS outbox_attempt_no, outbox.claim_owner AS outbox_claim_owner, outbox.claim_token AS outbox_claim_token, outbox.next_attempt_at AS outbox_next_attempt_at FROM notification_delivery_intents intent JOIN plugin_hook_outbox outbox ON outbox.outbox_id = 'notification-a'`
              )
              .get() as Record<string, unknown>;
            return { value: reflection(real) };
          }
          return undefined;
        },
      }).store.fail(claim, providerFailure());
    };
    const FAILED = /^plugin_outbox_provider_advance_failed$/u;
    it('rejects an unsuccessful batch statement', async () => {
      await expect(advanceWith([{ ...ok, success: false }, ok])).rejects.toThrow(FAILED);
    });
    it('rejects a batch statement that reports an error', async () => {
      await expect(advanceWith([ok, { ...ok, error: 'x' }])).rejects.toThrow(FAILED);
    });
    it('rejects an advance that cannot be read back', async () => {
      await expect(advanceWith('real', () => null)).rejects.toThrow(FAILED);
    });
    it.each([
      ['a non-pending intent', { state: 'canceled' }],
      ['another index', { active_provider_index: 2 }],
      ['another start time', { provider_started_at: 299 }],
      ['an outbox row not waiting', { outbox_status: 'queued' }],
      ['another outbox provider', { outbox_plugin_installation_id: 'installation-c' }],
      ['a non-zero attempt', { outbox_attempt_no: 1 }],
      ['a held claim owner', { outbox_claim_owner: 'someone' }],
      ['a held claim token', { outbox_claim_token: 'claim-x' }],
      ['another retry time', { outbox_next_attempt_at: 301 }],
    ])('rejects a reflection with %s', async (_label, patch) => {
      await expect(advanceWith('real', (real) => ({ ...real, ...patch }))).rejects.toThrow(
        /^plugin_outbox_(provider_advance_failed|notification_state_invalid)$/u
      );
    });
    it('accepts a faithful reflection', async () => {
      await expect(advanceWith('real', (real) => real)).resolves.toBe('waiting_retry');
    });
  });
});

describe('quarantine of malformed notification rows', () => {
  const claimWithBadPayload = async (over: Record<string, unknown> = {}) => {
    database.exec(
      `UPDATE plugin_hook_outbox SET payload_json = '{"tenantId":"other","intentId":"intent-a"}'`
    );
    const ok = { success: true, results: [], meta: { changes: 1 } };
    return store({
      intercept: (call) => {
        if (call.kind !== 'batch') return undefined;
        const results = [ok, ok];
        return { value: Object.entries(over).length ? over.results : results };
      },
    }).store.claimNext({ ownerId: 'runner-a', now: 200 });
  };
  const STALE = /^plugin_outbox_quarantine_stale$/u;
  const ok = { success: true, results: [], meta: { changes: 1 } };
  it.each([
    ['an unsuccessful statement', [{ ...ok, success: false }, ok]],
    ['a statement error', [ok, { ...ok, error: 'x' }]],
    ['an intent update touching two rows', [{ ...ok, meta: { changes: 2 } }, ok]],
    ['an outbox update touching nothing', [ok, { ...ok, meta: { changes: 0 } }]],
    ['an outbox update without a count', [ok, { ...ok, meta: {} }]],
  ])('reports %s as a stale quarantine', async (_label, results) => {
    await expect(claimWithBadPayload({ results })).rejects.toThrow(STALE);
  });
  it('accepts an intent that was already settled (zero rows) as long as the outbox row moved', async () => {
    await expect(
      claimWithBadPayload({ results: [{ ...ok, meta: { changes: 0 } }, ok] })
    ).rejects.toThrow(/^plugin_outbox_claim_invalid$/u);
  });
});

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}
