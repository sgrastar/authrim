import { beforeEach, describe, expect, it, vi } from 'vitest';

const envelope = vi.hoisted(() => ({ encrypt: vi.fn(), keyId: vi.fn() }));
vi.mock('../notification-intent-envelope', () => ({
  encryptNotificationIntentPayload: envelope.encrypt,
  notificationIntentEnvelopeKeyId: envelope.keyId,
}));

import {
  createNotificationDeliveryIntent,
  parseNotificationDeliveryPayload,
} from '../notification-delivery-intent';
import { NOW, baseInput, makeD1 } from './notification-delivery-intent.fixtures';

const CONFLICT = 'notification_intent_idempotency_conflict';
const REFLECTION = 'notification_intent_reflection_invalid';

type Row = Record<string, unknown>;
const run = (
  mutateIntent?: (row: Row) => Row | null,
  mutateOutbox?: (row: Row) => Row | null,
  over = {}
) => {
  const { db } = makeD1({ mutateIntent, mutateOutbox });
  return createNotificationDeliveryIntent(baseInput(db, over));
};

beforeEach(() => {
  envelope.encrypt.mockReset().mockResolvedValue('ENVELOPE');
});

describe('reflection of existing rows', () => {
  it('reports a commit failure only when both rows are missing', async () => {
    await expect(
      run(
        () => null,
        () => null
      )
    ).rejects.toThrow('notification_intent_commit_failed');
  });

  it('treats a half-present pair as an idempotency conflict', async () => {
    await expect(run(() => null)).rejects.toThrow(CONFLICT);
    await expect(run(undefined, () => null)).rejects.toThrow(CONFLICT);
  });

  it('conflicts when the stored provider list is not valid JSON', async () => {
    await expect(run((r) => ({ ...r, provider_installation_ids_json: '{nope' }))).rejects.toThrow(
      CONFLICT
    );
  });

  const intentMismatches: Array<[string, Row]> = [
    ['intent_id', { intent_id: 'other' }],
    ['tenant_id', { tenant_id: 'other' }],
    ['plugin_installation_id', { plugin_installation_id: 'inst-b' }],
    ['provider_order_version', { provider_order_version: 5 }],
    ['provider ids order', { provider_installation_ids_json: '["inst-b","inst-a"]' }],
    ['provider ids extra', { provider_installation_ids_json: '["inst-a","inst-b","inst-c"]' }],
    ['active index negative', { active_provider_index: -1 }],
    ['active index at length', { active_provider_index: 2 }],
    ['provider_started_at zero', { provider_started_at: 0 }],
    ['channel', { channel: 'sms' }],
    ['notification_kind', { notification_kind: 'other.kind' }],
    ['account_id', { account_id: 'acct-x' }],
    ['recipient_masked', { recipient_masked: 'm' }],
    ['payload_version', { payload_version: 2 }],
    ['idempotency_key', { idempotency_key: 'other' }],
    ['request_fingerprint', { request_fingerprint: 'deadbeef' }],
    ['fingerprint_key_id', { fingerprint_key_id: 'notification-intent-v0' }],
    ['expires_at', { expires_at: NOW + 601 }],
  ];
  it.each(intentMismatches)('conflicts when intent %s differs', async (_n, patch) => {
    await expect(run((r) => ({ ...r, ...patch }))).rejects.toThrow(CONFLICT);
  });

  const outboxMismatches: Array<[string, Row]> = [
    ['outbox_id', { outbox_id: 'other' }],
    ['tenant_id', { tenant_id: 'other' }],
    ['plugin_installation_id', { plugin_installation_id: 'inst-b' }],
    ['capability', { capability: 'notifier.other' }],
    ['event_type', { event_type: 'notification.other' }],
    ['event_version', { event_version: 2 }],
    ['idempotency_key', { idempotency_key: 'other' }],
    ['payload_json', { payload_json: '{}' }],
    ['payload_class', { payload_class: 'inline_v1' }],
  ];
  it.each(outboxMismatches)('conflicts when outbox %s differs', async (_n, patch) => {
    await expect(run(undefined, (r) => ({ ...r, ...patch }))).rejects.toThrow(CONFLICT);
  });

  it('accepts numeric strings for integer columns', async () => {
    const ref = await run(
      (r) => ({
        ...r,
        provider_order_version: '4',
        active_provider_index: '0',
        provider_started_at: String(NOW),
        payload_version: '1',
        expires_at: String(NOW + 600),
      }),
      (r) => ({ ...r, event_version: '1' })
    );
    expect(ref.expiresAt).toBe(NOW + 600);
  });

  const nonIntegers: Array<[string, boolean, Row]> = [
    ['active_provider_index', true, { active_provider_index: 'x' }],
    ['provider_order_version', true, { provider_order_version: '1.5' }],
    ['provider_started_at', true, { provider_started_at: 'x' }],
    ['payload_version', true, { payload_version: 'x' }],
    ['expires_at', true, { expires_at: Number.NaN }],
    ['event_version', false, { event_version: 'x' }],
  ];
  it.each(nonIntegers)(
    'rejects non-integer %s as reflection_invalid',
    async (_n, intent, patch) => {
      const promise = intent
        ? run((r) => ({ ...r, ...patch }))
        : run(undefined, (r) => ({ ...r, ...patch }));
      await expect(promise).rejects.toThrow(REFLECTION);
    }
  );

  it('follows the active provider when the intent has failed over', async () => {
    const ref = await run(
      (r) => ({ ...r, active_provider_index: 1 }),
      (r) => ({ ...r, plugin_installation_id: 'inst-b' })
    );
    expect(ref.pluginInstallationId).toBe('inst-a');
    await expect(
      run(
        (r) => ({ ...r, active_provider_index: 1 }),
        (r) => ({ ...r, plugin_installation_id: 'inst-a' })
      )
    ).rejects.toThrow(CONFLICT);
  });

  it('accepts the last valid active index and the first valid start time', async () => {
    const ref = await run(
      (r) => ({ ...r, active_provider_index: 1, provider_started_at: 1 }),
      (r) => ({ ...r, plugin_installation_id: 'inst-b' })
    );
    expect(ref.state).toBe('pending');
  });

  describe('state mapping', () => {
    it('delivered intents map to delivered regardless of key or outbox status', async () => {
      const ref = await run(
        (r) => ({ ...r, state: 'delivered', payload_key_id: null }),
        (r) => ({ ...r, status: 'done' })
      );
      expect(ref.state).toBe('delivered');
    });

    it.each(['canceled', 'expired', 'dead_letter'])('%s maps to permanent_failure', async (st) => {
      const ref = await run(
        (r) => ({ ...r, state: st }),
        (r) => ({ ...r, status: 'dead' })
      );
      expect(ref.state).toBe('permanent_failure');
    });

    it.each(['queued', 'locked', 'waiting_retry'])(
      'pending with outbox %s is pending',
      async (st) => {
        const ref = await run(undefined, (r) => ({ ...r, status: st }));
        expect(ref.state).toBe('pending');
      }
    );

    it.each([
      ['unknown outbox status', undefined, { status: 'done' }],
      ['empty outbox status', undefined, { status: '' }],
    ])('conflicts for pending with %s', async (_n, _i, outboxPatch) => {
      await expect(run(undefined, (r) => ({ ...r, ...outboxPatch }))).rejects.toThrow(CONFLICT);
    });

    it.each([null, ''])('conflicts for pending without a payload key (%j)', async (key) => {
      await expect(run((r) => ({ ...r, payload_key_id: key }))).rejects.toThrow(CONFLICT);
    });

    it.each(['failed', 'processing', 'PENDING', ''])(
      'conflicts for unknown state %j',
      async (st) => {
        await expect(run((r) => ({ ...r, state: st }))).rejects.toThrow(CONFLICT);
      }
    );
  });

  it('returns identifiers from the stored rows and the expected channel', async () => {
    const ref = await run(undefined, undefined, {
      payload: { channel: 'push', to: 'tok', body: 'b' },
    });
    expect(ref).toEqual({
      tenantId: 'tenant-1',
      intentId: 'intent-1',
      outboxId: 'outbox-1',
      pluginInstallationId: 'inst-a',
      notificationKind: 'auth.otp',
      channel: 'push',
      expiresAt: NOW + 600,
      state: 'pending',
    });
  });
});

describe('parseNotificationDeliveryPayload', () => {
  const valid = { channel: 'email', to: 't', body: 'b' };
  const INVALID = 'notification_intent_payload_invalid';

  it('returns only defined, normalized fields', () => {
    const parsed = parseNotificationDeliveryPayload({
      channel: 'email',
      to: 'to@example.com',
      body: 'body',
      subject: 'subj',
      from: 'f',
      replyTo: 'r',
      cc: ['c1'],
      bcc: ['b1', 'b2'],
      templateId: 'tpl',
      templateVars: { z: 1, a: { y: [1, null, 'x', true], b: 2 } },
      metadata: { k: 'v' },
    });
    expect(parsed).toStrictEqual({
      channel: 'email',
      to: 'to@example.com',
      body: 'body',
      from: 'f',
      subject: 'subj',
      replyTo: 'r',
      cc: ['c1'],
      bcc: ['b1', 'b2'],
      templateId: 'tpl',
      templateVars: { a: { b: 2, y: [1, null, 'x', true] }, z: 1 },
      metadata: { k: 'v' },
    });
    expect(Object.keys(parsed.templateVars ?? {})).toEqual(['a', 'z']);
    expect(parseNotificationDeliveryPayload(valid)).toStrictEqual(valid);
  });

  it('enforces the expected channel', () => {
    expect(parseNotificationDeliveryPayload(valid, 'email').channel).toBe('email');
    expect(() => parseNotificationDeliveryPayload(valid, 'sms')).toThrow(INVALID);
  });

  const invalid: Array<[string, unknown]> = [
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['unknown key', { ...valid, extra: 1 }],
    ['bad channel', { ...valid, channel: 'fax' }],
    ['missing channel', { to: 't', body: 'b' }],
    ['empty to', { ...valid, to: '' }],
    ['to too long', { ...valid, to: 't'.repeat(2049) }],
    ['non-string to', { ...valid, to: 1 }],
    ['empty body', { ...valid, body: '' }],
    ['body too long', { ...valid, body: 'b'.repeat(128 * 1024 + 1) }],
    ['subject too long', { ...valid, subject: 's'.repeat(999) }],
    ['subject non-string', { ...valid, subject: 1 }],
    ['from empty', { ...valid, from: '' }],
    ['from too long', { ...valid, from: 'f'.repeat(2049) }],
    ['replyTo non-string', { ...valid, replyTo: 1 }],
    ['templateId too long', { ...valid, templateId: 't'.repeat(2049) }],
    ['cc not array', { ...valid, cc: 'x' }],
    ['cc too many', { ...valid, cc: Array.from({ length: 51 }, () => 'a') }],
    ['bcc entry empty', { ...valid, bcc: [''] }],
    ['bcc entry non-string', { ...valid, bcc: [1] }],
    ['cc entry too long', { ...valid, cc: ['a'.repeat(2049)] }],
    ['templateVars null', { ...valid, templateVars: null }],
    ['templateVars array', { ...valid, templateVars: [] }],
    ['metadata string', { ...valid, metadata: 'x' }],
    ['metadata with function', { ...valid, metadata: { f: () => 1 } }],
    ['metadata with NaN', { ...valid, metadata: { n: Number.NaN } }],
    ['metadata with undefined', { ...valid, metadata: { u: undefined } }],
  ];
  it.each(invalid)('rejects %s', (_n, value) => {
    expect(() => parseNotificationDeliveryPayload(value)).toThrow(INVALID);
  });

  it('accepts the documented boundaries', () => {
    const edge = {
      channel: 'sms',
      to: 't'.repeat(2048),
      body: 'b'.repeat(128 * 1024),
      subject: 's'.repeat(998),
      from: 'f'.repeat(2048),
      replyTo: 'r',
      templateId: 't'.repeat(2048),
      cc: Array.from({ length: 50 }, () => 'a'.repeat(2048)),
      bcc: [],
    };
    const parsed = parseNotificationDeliveryPayload(edge);
    expect(parsed.cc).toHaveLength(50);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.subject).toHaveLength(998);
  });

  describe('JSON limits', () => {
    const nest = (depth: number): Record<string, unknown> => {
      let node: Record<string, unknown> = {};
      for (let i = 0; i < depth; i++) node = { n: node };
      return node;
    };
    it('allows depth 12 and rejects depth 13', () => {
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: nest(12) })
      ).not.toThrow();
      expect(() => parseNotificationDeliveryPayload({ ...valid, metadata: nest(13) })).toThrow(
        INVALID
      );
    });

    it('rejects circular structures', () => {
      const loop: Record<string, unknown> = {};
      loop.self = loop;
      expect(() => parseNotificationDeliveryPayload({ ...valid, metadata: loop })).toThrow(INVALID);
      const arr: unknown[] = [];
      arr.push(arr);
      expect(() => parseNotificationDeliveryPayload({ ...valid, metadata: { arr } })).toThrow(
        INVALID
      );
    });

    it('allows a shared (non-circular) reference twice', () => {
      const shared = { a: 1 };
      const parsed = parseNotificationDeliveryPayload({
        ...valid,
        metadata: { x: shared, y: [shared, shared] },
      });
      expect(parsed.metadata).toEqual({ x: { a: 1 }, y: [{ a: 1 }, { a: 1 }] });
    });

    it('limits collection entries to 2048 and keys to 512 chars', () => {
      const entries = (n: number) =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: entries(2048) })
      ).not.toThrow();
      expect(() => parseNotificationDeliveryPayload({ ...valid, metadata: entries(2049) })).toThrow(
        INVALID
      );
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: { ['k'.repeat(512)]: 1 } })
      ).not.toThrow();
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: { ['k'.repeat(513)]: 1 } })
      ).toThrow(INVALID);
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: { a: new Array(2048).fill(1) } })
      ).not.toThrow();
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: { a: new Array(2049).fill(1) } })
      ).toThrow(INVALID);
    });

    it('limits the total node budget to 8192', () => {
      const wide = (n: number) => ({
        a: new Array(n).fill(0),
      });
      // metadata object + array + n leaves
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: wide(2048) })
      ).not.toThrow();
      const many = (leaves: number) => {
        const out: Record<string, number[]> = {};
        let left = leaves;
        for (let i = 0; left > 0; i++) {
          const take = Math.min(2000, left);
          out[`a${i}`] = new Array<number>(take).fill(0);
          left -= take;
        }
        return out;
      };
      // 1 (root) + groups + leaves: 8192 exactly fits, one more does not.
      const fits = many(8192 - 1 - 5);
      expect(() => parseNotificationDeliveryPayload({ ...valid, metadata: fits })).not.toThrow();
      expect(() =>
        parseNotificationDeliveryPayload({ ...valid, metadata: many(8192 - 1 - 5 + 1) })
      ).toThrow(INVALID);
    });

    it('ignores inherited enumerable properties', () => {
      const proto = { inherited: 'x' };
      const meta = Object.create(proto) as Record<string, unknown>;
      meta.own = 1;
      expect(parseNotificationDeliveryPayload({ ...valid, metadata: meta }).metadata).toEqual({
        own: 1,
      });
    });
  });
});
