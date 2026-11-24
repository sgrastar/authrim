import { vi } from 'vitest';
import type { CreateNotificationDeliveryIntentInput } from '../notification-delivery-intent';

export const NOW = 1_700_000_000;
export const HMAC_KEY = 'k'.repeat(32);

export const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export interface BoundStatement {
  sql: string;
  args: unknown[];
}

export interface FakeD1Options {
  /** Whether the inserted rows are visible to later primary reads (false = commit lost). */
  persist?: boolean;
  /** Batch behaviour: results to return, or an error to throw. */
  batchResult?: Array<{ success?: boolean; error?: string }> | Error;
  mutateIntent?: (row: Record<string, unknown>) => Record<string, unknown> | null;
  mutateOutbox?: (row: Record<string, unknown>) => Record<string, unknown> | null;
  withSession?: boolean;
}

/** In-memory D1 stand-in that reflects exactly what the code inserted. */
export function makeD1(options: FakeD1Options = {}) {
  const batches: BoundStatement[][] = [];
  const reads: BoundStatement[] = [];
  const persist = options.persist ?? true;
  const session = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql,
        args,
        first: async () => {
          reads.push({ sql, args });
          const inserted = batches.at(-1);
          if (!persist || !inserted) return null;
          if (sql.includes('FROM notification_delivery_intents')) {
            const a = inserted[0].args;
            const row = {
              intent_id: a[0],
              tenant_id: a[1],
              plugin_installation_id: a[2],
              provider_order_version: a[3],
              provider_installation_ids_json: a[4],
              active_provider_index: 0,
              provider_started_at: a[5],
              channel: a[6],
              notification_kind: a[7],
              account_id: a[8],
              recipient_masked: a[9],
              payload_version: 1,
              payload_key_id: a[12],
              idempotency_key: a[14],
              state: 'pending',
              expires_at: a[17],
              request_fingerprint: a[15],
              fingerprint_key_id: a[16],
            };
            return options.mutateIntent ? options.mutateIntent(row) : row;
          }
          const a = inserted[1].args;
          const row = {
            outbox_id: a[0],
            tenant_id: a[1],
            plugin_installation_id: a[2],
            capability: a[3],
            event_type: a[4],
            event_version: a[5],
            idempotency_key: a[6],
            payload_json: a[7],
            payload_class: 'reference_v1',
            status: 'queued',
          };
          return options.mutateOutbox ? options.mutateOutbox(row) : row;
        },
      }),
    }),
    batch: vi.fn(async (statements: BoundStatement[]) => {
      batches.push(statements);
      if (options.batchResult instanceof Error) throw options.batchResult;
      return options.batchResult ?? statements.map(() => ({ success: true }));
    }),
  };
  const db: Record<string, unknown> = {};
  if (options.withSession !== false) db.withSession = vi.fn(() => session);
  return { db: db as unknown as D1Database, session, batches, reads };
}

export function baseInput(
  db: D1Database,
  over: Partial<CreateNotificationDeliveryIntentInput> = {}
): CreateNotificationDeliveryIntentInput {
  return {
    db,
    environmentId: 'env-1',
    publicJwks: '{"keys":[]}',
    activeKeyId: 'key-1',
    idempotencyHmacKey: HMAC_KEY,
    tenantId: 'tenant-1',
    intentId: 'intent-1',
    outboxId: 'outbox-1',
    providerOrder: { configVersion: 4, installationIds: ['inst-a', 'inst-b'] },
    notificationKind: 'auth.otp',
    idempotencyKey: 'idem-1',
    expiresAt: NOW + 600,
    payload: { channel: 'email', to: 'a@example.com', body: 'hello' },
    now: NOW,
    ...over,
  };
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
