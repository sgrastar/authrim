import {
  validateAccountWebhookFields,
  type DatabaseAdapter,
  type WebhookConfigWithScope,
} from '@authrim/ar-lib-core';

interface Snapshot {
  account_id: string;
  registration_state: 'guest' | 'registered';
  email_before_json: string | null;
  email_after_json: string | null;
  expires_at: number;
}

/** Called only after tenant-scoped subscription matching, never by audit/internal handlers. */
export async function materializeAccountWebhookPayload(input: {
  tenantId: string;
  eventId: string;
  eventType: string;
  userId: string;
  data: Record<string, unknown>;
  webhook: WebhookConfigWithScope;
  adapters: () => Promise<DatabaseAdapter[]>;
  now: number;
  occurredAt: number;
}): Promise<Record<string, unknown>> {
  const { webhook, data } = input;
  if (webhook.tenantId !== input.tenantId || webhook.scope !== 'tenant' || !webhook.active) {
    throw new Error('account_webhook_scope_denied');
  }
  const fields = webhook.payloadFields ?? [];
  if (!validateAccountWebhookFields(fields)) throw new Error('account_webhook_fields_invalid');
  const isEmail = input.eventType === 'account.email.changed';
  const isDeletion = input.eventType.endsWith('.deleted');
  // Selected fields are event-specific; metadata-only events retain their existing contract.
  if (!isEmail && !isDeletion) return data;
  const configuredAt = Date.parse(webhook.updatedAt);
  if (!Number.isFinite(configuredAt) || configuredAt > input.occurredAt) {
    throw new Error('account_webhook_selection_newer_than_event');
  }
  if (!fields.length) return data;
  const snapshotId = isDeletion
    ? `account-deletion:${input.tenantId}:${input.userId}`
    : input.eventId;
  for (const adapter of await input.adapters()) {
    const snapshot = await adapter.queryOne<Snapshot>(
      `SELECT account_id, registration_state, email_before_json, email_after_json, expires_at
       FROM account_webhook_snapshots WHERE tenant_id = ? AND id = ? AND user_id = ?`,
      [input.tenantId, snapshotId, input.userId],
      { consistencyClass: 'primary_required' }
    );
    if (!snapshot) continue;
    const fieldJson = JSON.stringify([...fields].sort());
    await adapter.execute(
      `INSERT INTO account_webhook_delivery_fields
       (tenant_id, event_id, webhook_id, fields_json, destination_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, event_id, webhook_id) DO NOTHING`,
      [input.tenantId, input.eventId, webhook.id, fieldJson, webhook.url, input.now]
    );
    const selection = await adapter.queryOne<{ fields_json: string; destination_url: string }>(
      `SELECT fields_json, destination_url FROM account_webhook_delivery_fields
       WHERE tenant_id = ? AND event_id = ? AND webhook_id = ?`,
      [input.tenantId, input.eventId, webhook.id],
      { consistencyClass: 'primary_required' }
    );
    if (
      !selection ||
      selection.fields_json !== fieldJson ||
      selection.destination_url !== webhook.url
    ) {
      throw new Error('account_webhook_selection_changed');
    }
    if (!fields.length) return data;
    if (Number(snapshot.expires_at) <= input.now)
      throw new Error('account_webhook_snapshot_expired');
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (fields.includes('email')) {
      const decode = (value: string | null): string | null => {
        if (value === null) throw new Error('account_webhook_snapshot_unavailable');
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new Error('account_webhook_snapshot_invalid');
        }
        if (parsed !== null && typeof parsed !== 'string')
          throw new Error('account_webhook_snapshot_invalid');
        return parsed;
      };
      before.email = decode(snapshot.email_before_json);
      after.email = decode(snapshot.email_after_json);
    }
    if (fields.includes('registration_state')) {
      before.registration_state = snapshot.registration_state;
      after.registration_state = snapshot.registration_state;
    }
    if (isDeletion) return { ...data, account_id: snapshot.account_id, before, after: null };
    const changes: Record<string, unknown> = {};
    for (const field of fields) changes[field] = { before: before[field], after: after[field] };
    return { ...data, account_id: snapshot.account_id, changes };
  }
  if (!fields.length) return data;
  throw new Error('account_webhook_snapshot_unavailable');
}
