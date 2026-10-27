import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  getGlobalHandlerRegistry,
  getGlobalHookRegistry,
} from '@authrim/ar-lib-core/utils/event-dispatcher-factory';
import { assertAwsEventPolicyReady, createAwsEventRuntimePorts } from './event-runtime';

afterEach(() => {
  getGlobalHandlerRegistry().clear();
  getGlobalHookRegistry().clear();
});

describe('AWS local event delivery', () => {
  it('records passkey success as a durable tenant-scoped audit event', async () => {
    const append = vi.fn(async () => undefined);
    const ports = createAwsEventRuntimePorts({ tenantId: 'tenant-a', audit: { append } });
    const result = await ports.publish({
      type: 'auth.passkey.succeeded',
      tenantId: 'tenant-a',
      data: { userId: 'user-1', method: 'passkey' },
    });
    expect(result).toMatchObject({ success: true, delivery: { auditLog: true } });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.eventId,
        tenantId: 'tenant-a',
        action: 'auth.passkey.succeeded',
        resource: 'auth',
        resourceId: 'user-1',
        metadata: JSON.stringify({ userId: 'user-1', method: 'passkey' }),
      })
    );
  });

  it('rejects cross-tenant events, skipped audits, and failed durable writes', async () => {
    const append = vi.fn(async () => undefined);
    const ports = createAwsEventRuntimePorts({ tenantId: 'tenant-a', audit: { append } });
    const payload = {
      type: 'auth.passkey.failed',
      tenantId: 'tenant-a',
      data: { errorCode: 'credential_not_found' },
    };
    await expect(ports.publish({ ...payload, tenantId: 'tenant-b' })).rejects.toThrow(
      'aws_event_delivery_unsupported'
    );
    await expect(ports.publish(payload, { skipAuditLog: true })).rejects.toThrow(
      'aws_event_delivery_unsupported'
    );
    expect(append).not.toHaveBeenCalled();
    append.mockRejectedValueOnce(new Error('database_offline'));
    await expect(ports.publish(payload)).rejects.toThrow('database_offline');
  });

  it('rejects active webhooks, unavailable policy tables, and active local handlers', async () => {
    const queryOne = vi.fn(async () => null);
    const db = { queryOne } as unknown as Pick<DatabaseAdapter, 'queryOne'>;
    await expect(assertAwsEventPolicyReady(db, 'tenant-a')).resolves.toBeUndefined();
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('FROM webhook_configs'), [
      'tenant-a',
    ]);

    queryOne.mockResolvedValueOnce({ id: 'webhook-1' } as never);
    await expect(assertAwsEventPolicyReady(db, 'tenant-a')).rejects.toThrow(
      'aws_event_webhooks_unsupported'
    );
    queryOne.mockRejectedValueOnce(new Error('missing_table'));
    await expect(assertAwsEventPolicyReady(db, 'tenant-a')).rejects.toThrow(
      'aws_event_policy_unavailable'
    );

    getGlobalHandlerRegistry().register({
      id: 'side-effect',
      name: 'side effect',
      eventPattern: 'auth.*',
      handler: async () => undefined,
    });
    await expect(assertAwsEventPolicyReady(db, 'tenant-a')).rejects.toThrow(
      'aws_event_internal_handlers_unsupported'
    );
  });
});
