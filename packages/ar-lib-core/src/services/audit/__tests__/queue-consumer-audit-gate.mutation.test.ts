import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAdminDb } from './queue-consumer-mutation-helpers';
import { nextTenant, auditBody, run, stdEnv } from './queue-consumer-audit-kit';

describe('audit queue consumer: message gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries messages without a fanout plan and logs the exact failure context', async () => {
    const tenantId = nextTenant();
    const body = auditBody(tenantId, []);
    delete (body as { fanout?: unknown }).fanout;
    const { message, logger } = await run(body, {}, { attempts: 3 });

    expect(message.retry).toHaveBeenCalledWith();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('processing_audit_message', {
      messageId: message.id,
      type: 'event_log',
      entryCount: 2,
      tenantId,
    });
    expect(logger.error).toHaveBeenCalledWith('audit_queue_message_failed', {
      messageId: message.id,
      type: 'event_log',
      entryCount: 2,
      tenantId,
      attempts: 3,
      error: 'Error: audit_queue_legacy_primary_message_not_supported',
    });
  });

  it.each([
    ['logpush', { type: 'logpush', destinationRef: 'LOGS' }],
    ['firehose', { type: 'firehose', streamRef: 'STREAM' }],
  ])('rejects fanout plans with a %s sink', async (_name, sink) => {
    const tenantId = nextTenant();
    const { adminDb, env } = stdEnv();
    const { message, logger } = await run(
      auditBody(tenantId, [{ type: 'http', url: 'https://example.com/ok' }, sink]),
      env
    );
    expect(message.retry).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      'audit_queue_message_failed',
      expect.objectContaining({ error: 'Error: audit_queue_legacy_archive_target_not_supported' })
    );
    expect(adminDb.execute).not.toHaveBeenCalled();
  });

  it('acks plans with only http sinks and no archives', async () => {
    const tenantId = nextTenant();
    const { message } = await run(auditBody(tenantId, []), {});
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe('audit queue consumer: tenant key resolution', () => {
  const registrySink = {
    type: 'http',
    destinationId: 'dest-registry',
    url: 'https://example.com/a',
  };

  function registryDb(handler: () => unknown) {
    return createFakeAdminDb({ queryOne: () => handler() });
  }

  it('uses the registered tenant key and caches it per tenant', async () => {
    const tenantId = nextTenant();
    const db = registryDb(() => ({ tenant_key: 't_registered' }));
    const { env, critical } = stdEnv();

    await run(auditBody(tenantId, [registrySink]), { ...env, DB: db });
    await run(auditBody(tenantId, [registrySink]), { ...env, DB: db });

    expect(db.queryOne).toHaveBeenCalledTimes(1);
    expect(db.queryOne).toHaveBeenCalledWith('SELECT tenant_key FROM tenants WHERE id = ?', [
      tenantId,
    ]);
    expect(critical.send).toHaveBeenCalledTimes(2);
    expect(critical.send.mock.calls[0]?.[0]).toMatchObject({ tenant_key: 't_registered' });
    expect(critical.send.mock.calls[1]?.[0]).toMatchObject({ tenant_key: 't_registered' });
  });

  it('does not share cached tenant keys between tenants', async () => {
    const first = nextTenant();
    const second = nextTenant();
    const { env, critical } = stdEnv();
    await run(auditBody(first, [registrySink]), {
      ...env,
      DB: registryDb(() => ({ tenant_key: 't_first' })),
    });
    await run(auditBody(second, [registrySink]), {
      ...env,
      DB: registryDb(() => ({ tenant_key: 't_second' })),
    });
    expect(
      critical.send.mock.calls.map(([payload]) => (payload as { tenant_key: string }).tenant_key)
    ).toEqual(['t_first', 't_second']);
  });

  it.each([
    ['no registry row', () => null],
    ['a row without a tenant key', () => ({ tenant_key: null })],
    ['a row with an empty tenant key', () => ({ tenant_key: '' })],
    [
      'a failing registry query',
      () => {
        throw new Error('no such column: tenant_key');
      },
    ],
  ])('derives the tenant key from the tenant id for %s', async (_name, handler) => {
    const tenantId = nextTenant();
    const db = registryDb(handler);
    const { env, critical } = stdEnv();
    await run(auditBody(tenantId, [registrySink]), {
      ...env,
      DB: db,
      LOGGING_TENANT_KEY_SALT: 'pepper',
    });
    expect(db.queryOne).toHaveBeenCalledOnce();
    expect(critical.send.mock.calls[0]?.[0]).toMatchObject({
      tenant_key: await deriveTenantKeyFromTenantId(tenantId, 'pepper'),
    });
  });

  it('derives the tenant key when the database cannot be queried', async () => {
    const tenantId = nextTenant();
    const { env, critical } = stdEnv();
    await run(auditBody(tenantId, [registrySink]), { ...env, DB: {} });
    expect(critical.send.mock.calls[0]?.[0]).toMatchObject({
      tenant_key: await deriveTenantKeyFromTenantId(tenantId, undefined),
    });
  });
});
