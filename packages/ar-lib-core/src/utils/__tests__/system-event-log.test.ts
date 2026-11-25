import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';

const mocks = vi.hoisted(() => ({
  logSystemEvent: vi.fn(),
  failClosed: vi.fn(),
}));
vi.mock('../audit-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit-log')>()),
  getUnifiedAuditService: () => ({ logSystemEvent: mocks.logSystemEvent }),
  isTenantAuditActionFailClosed: mocks.failClosed,
}));

import { AuditLogDeliveryError } from '../audit-log';
import {
  checkSystemEventDetails,
  isSystemEventDetailValue,
  logSystemEvent,
} from '../system-event-log';

const env = {} as Env;
const input = {
  tenantId: 'tenant-1',
  source: 'authrim/account_webhook_outbox',
  action: 'webhook.outbox.dropped',
  targetType: 'account_webhook_outbox',
  targetId: 'tenant-1',
  severity: 'warning' as const,
  createdAt: 1_800_000_000_000,
  details: { dropped: 2, reason: 'capability_disabled', event_types: { 'account.created': 2 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logSystemEvent.mockResolvedValue(undefined);
  mocks.failClosed.mockResolvedValue(true);
});

describe('logSystemEvent', () => {
  it('maps the input as the end-user log would and writes to the system dataset', async () => {
    await logSystemEvent(env, input);
    expect(mocks.logSystemEvent).toHaveBeenCalledExactlyOnceWith('tenant-1', {
      createdAt: input.createdAt,
      source: 'authrim/account_webhook_outbox',
      eventType: 'webhook.outbox.dropped',
      // The category the same action got in the end-user log: routing rules see no change.
      eventCategory: 'audit',
      result: 'success',
      severity: 'warn',
      targetType: 'account_webhook_outbox',
      targetId: 'tenant-1',
      details: input.details,
    });
  });

  it('reads result and error_code from the details, as the end-user log does', async () => {
    await logSystemEvent(env, {
      ...input,
      action: 'directory_connector_heartbeat.failed',
      targetType: 'directory_connector_instance',
      details: { reason: 'signature_mismatch', error_code: 'signature_mismatch' },
    });
    expect(mocks.logSystemEvent).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ result: 'failure', errorCode: 'signature_mismatch' })
    );
  });

  it('fails the caller when a fail-closed action could not be stored', async () => {
    mocks.logSystemEvent.mockRejectedValue(new Error('archive_unavailable'));
    await expect(logSystemEvent(env, input)).rejects.toBeInstanceOf(AuditLogDeliveryError);
  });

  it('lets a fail-open action go on when it could not be stored', async () => {
    mocks.failClosed.mockResolvedValue(false);
    mocks.logSystemEvent.mockRejectedValue(new Error('archive_unavailable'));
    await expect(logSystemEvent(env, input)).resolves.toBeUndefined();
  });

  it('fails the caller for a durable fanout even when the action is fail-open', async () => {
    mocks.failClosed.mockResolvedValue(false);
    mocks.logSystemEvent.mockRejectedValue(new Error('archive_unavailable'));
    await expect(
      logSystemEvent(env, { ...input, requireDurableFanout: true })
    ).rejects.toBeInstanceOf(AuditLogDeliveryError);
  });

  it('does nothing without a tenant and refuses malformed names', async () => {
    await logSystemEvent(env, { ...input, tenantId: ' ' });
    expect(mocks.logSystemEvent).not.toHaveBeenCalled();
    await expect(logSystemEvent(env, { ...input, source: 'outbox' })).rejects.toThrow(
      'system_event_source_invalid'
    );
    await expect(logSystemEvent(env, { ...input, action: 'a b' })).rejects.toThrow(
      'system_event_action_invalid'
    );
    await expect(logSystemEvent(env, { ...input, targetId: 'x'.repeat(201) })).rejects.toThrow(
      'system_event_target_id_invalid'
    );
  });

  it('hands the row to a deployment-owned audit store when one is bound', async () => {
    const append = vi
      .fn<(entry: { metadata: string }) => Promise<void>>()
      .mockResolvedValue(undefined);
    await logSystemEvent({ AUDIT_RUNTIME_PORTS: { append } } as unknown as Env, {
      ...input,
      id: 'fixed-1',
    });
    expect(mocks.logSystemEvent).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: 'fixed-1',
        tenantId: 'tenant-1',
        userId: 'system',
        action: 'webhook.outbox.dropped',
        resource: 'account_webhook_outbox',
        resourceId: 'tenant-1',
        userAgent: 'authrim/account_webhook_outbox',
        severity: 'warning',
        createdAt: input.createdAt,
      })
    );
    expect(JSON.parse(append.mock.calls[0][0].metadata)).toEqual({
      ...input.details,
      source_dataset: 'runtime.system_events',
    });
    append.mockRejectedValue(new Error('down'));
    await expect(
      logSystemEvent({ AUDIT_RUNTIME_PORTS: { append } } as unknown as Env, input)
    ).rejects.toBeInstanceOf(AuditLogDeliveryError);
  });
});

describe('checkSystemEventDetails', () => {
  it('keeps counts by kind whose kinds are event types, codes included', () => {
    expect(
      checkSystemEventDetails({
        event_types: { 'account.email.changed': 1, 'account.created': 2, 'user.deleted': 1 },
        by_reason: { signature_mismatch: 3, unknown_heartbeat_key: 1 },
      })
    ).toEqual({
      event_types: { 'account.email.changed': 1, 'account.created': 2, 'user.deleted': 1 },
      by_reason: { signature_mismatch: 3, unknown_heartbeat_key: 1 },
    });
    expect(isSystemEventDetailValue('hb-active')).toBe(true);
    for (const value of ['192.0.2.1', '2001:db8::1', '::ffff:192.0.2.1', 'a b', 'x@y', '/p']) {
      expect(isSystemEventDetailValue(value), value).toBe(false);
    }
  });

  it('keeps scalars and one level of scalar maps', () => {
    expect(
      checkSystemEventDetails({
        dropped: 2,
        ok: true,
        note: null,
        job: 'job:2026-11-26',
        by_kind: { 'account.created': 1, b: 2 },
      })
    ).toEqual({
      dropped: 2,
      ok: true,
      note: null,
      job: 'job:2026-11-26',
      by_kind: { 'account.created': 1, b: 2 },
    });
    expect(checkSystemEventDetails(undefined)).toEqual({});
  });

  it.each([
    [{ user_id: 'u1' }, 'detail_key_refused:user_id'],
    [{ userId: 'u1' }, 'detail_key_invalid:userId'],
    [{ email_hash: 'x' }, 'detail_key_refused:email_hash'],
    [{ ip_address: '10.0.0.1' }, 'detail_key_refused:ip_address'],
    [{ user_agent: 'x' }, 'detail_key_refused:user_agent'],
    [{ metadata_url: 'x' }, 'detail_key_refused:metadata_url'],
    [{ note: 'see https://example.com/x' }, 'detail_invalid:note'],
    [{ note: 'someone@example.com' }, 'detail_invalid:note'],
    [{ nested: { deeper: { x: 1 } } }, 'detail_invalid:nested.deeper'],
    [{ list: [1, 2] }, 'detail_invalid:list'],
    [{ count: Number.NaN }, 'detail_invalid:count'],
    [{ by: { user_id: 1 } }, 'detail_key_refused:by.user_id'],
    [{ by_kind: { 'user.id': 'usr-123' } }, 'detail_key_refused:by_kind.user.id'],
    [{ by_kind: { 'account.created': 'usr-123' } }, 'detail_invalid:by_kind.account.created'],
    [{ by_kind: { email: 1 } }, 'detail_key_refused:by_kind.email'],
    [{ by_kind: { name: 1 } }, 'detail_key_refused:by_kind.name'],
    [{ full_name: 'Alice' }, 'detail_key_refused:full_name'],
    [{ ip: '192.0.2.1' }, 'detail_key_refused:ip'],
    [{ peer: '192.0.2.1' }, 'detail_invalid:peer'],
    [{ peer: '2001:db8::1' }, 'detail_invalid:peer'],
    [{ peer: '::ffff:192.0.2.1' }, 'detail_invalid:peer'],
    [{ by_kind: { '192.0.2.1': 1 } }, 'detail_key_refused:by_kind.192.0.2.1'],
    [{ by_kind: { '2001:db8::1': 1 } }, 'detail_key_refused:by_kind.2001:db8::1'],
    [{ by_kind: { '::ffff:192.0.2.1': 1 } }, 'detail_key_refused:by_kind.::ffff:192.0.2.1'],
    [{ note: 'Alice Smith' }, 'detail_invalid:note'],
    [{ path: '/users/1' }, 'detail_invalid:path'],
    [{ source_dataset: 'core.event_log' }, 'detail_key_reserved:source_dataset'],
    [{ sourceDataset: 'core.event_log' }, 'detail_key_invalid:sourceDataset'],
    [{ origin: 'x' }, 'detail_key_reserved:origin'],
    [{ resource_id: 'x' }, 'detail_key_reserved:resource_id'],
    [{ by: { source_dataset: 'x' } }, 'detail_key_reserved:by.source_dataset'],
  ])('refuses %j', (details, reason) => {
    expect(() => checkSystemEventDetails(details)).toThrow(`system_event_${reason}`);
  });
});
