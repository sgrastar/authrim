import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeAdminDb,
  fetchResponse,
  insertedDeliveryEvents,
  insertedNotifications,
  sqlCalls,
} from './queue-consumer-mutation-helpers';
import { CREATED_AT, NOW, fanout, run, loggedError } from './queue-consumer-delivery-kit';

describe('logging delivery queue: delivery_fanout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const httpDestination = (
    config: Record<string, unknown> = { url: 'https://hook.example/in' }
  ) => ({
    provider: 'http',
    provider_config: JSON.stringify(config),
  });

  it('posts a log chunk reference and completes the claim', async () => {
    const adminDb = createFakeAdminDb({ destination: httpDestination() });
    const { fetchMock, message } = await run({ body: fanout(), adminDb, attempts: 2 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hook.example/in');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      payload_type: 'log_chunk_reference',
      payload_id: 'qpl_fan_1',
      tenant_key: 'tk_fan',
      catalog_id: 'cat_fan_1',
      object_key: 'logs/v1/object.json',
      log_type: 'audit',
      plane: 'archive',
      record_count: 3,
      created_at: CREATED_AT,
    });
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Authrim-Delivery': 'qpl_fan_1',
    });

    const [claim] = sqlCalls(adminDb, 'delivery_in_progress').filter(([sql]) =>
      String(sql).trimStart().startsWith('INSERT')
    );
    const claimParams = claim?.[1] as unknown[];
    expect(claimParams.slice(1, 8)).toEqual([
      'tk_fan',
      'dest_fan',
      'audit',
      'archive',
      'critical',
      2,
      'cat_fan_1',
    ]);
    expect(claimParams[10]).toBe(NOW.getTime() + 60_000);
    const { params, metadata } = (() => {
      const call = sqlCalls(adminDb, "SET status = 'delivered'")[0]?.[1] as unknown[];
      return { params: call, metadata: JSON.parse(call[3] as string) as Record<string, unknown> };
    })();
    expect(params[0]).toBe(2);
    expect(params[1]).toBe('cat_fan_1');
    expect(metadata).toEqual({
      payload_id: 'qpl_fan_1',
      catalog_id: 'cat_fan_1',
      object_key: 'logs/v1/object.json',
      record_count: 3,
      provider: 'http',
      http_status: 200,
      redacted_headers: {},
    });
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it.each(['url', 'endpointUrl'])('reads the endpoint from provider config key %s', async (key) => {
    const adminDb = createFakeAdminDb({
      destination: httpDestination({ [key]: ' https://cfg.example/x ' }),
    });
    const { fetchMock } = await run({ body: fanout(), adminDb });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cfg.example/x');
  });

  it.each([
    ['a missing destination', null, 'logging_delivery_destination_not_found'],
    [
      'an inactive destination',
      { lifecycle_status: 'paused' },
      'logging_delivery_destination_not_active',
    ],
    ['an http destination without a url', httpDestination({}), 'logging_delivery_http_url_missing'],
    [
      'an unsupported provider',
      { provider: 'kafka' },
      'logging_delivery_destination_provider_unsupported:kafka',
    ],
  ])('retries and records the failure for %s', async (_name, destination, expected) => {
    const adminDb = createFakeAdminDb({ destination });
    const { fetchMock, message, logger } = await run({ body: fanout(), adminDb, attempts: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(loggedError(logger)).toContain(expected);
    const [event] = insertedDeliveryEvents(adminDb);
    expect(event).toMatchObject({
      tenantKey: 'tk_fan',
      destinationId: 'dest_fan',
      logType: 'audit',
      plane: 'archive',
      lane: 'critical',
      status: 'retrying',
      attemptCount: 2,
      errorClass: 'delivery_fanout_failed',
      objectCatalogId: 'cat_fan_1',
    });
    expect(event?.nextRetryAt).toBeGreaterThanOrEqual(NOW.getTime() + 1600);
    expect(event?.nextRetryAt).toBeLessThanOrEqual(NOW.getTime() + 2400);
    expect(event?.metadata).toEqual({
      payload_id: 'qpl_fan_1',
      catalog_id: 'cat_fan_1',
      object_key: 'logs/v1/object.json',
      record_count: 3,
      error: `Error: ${expected}`,
    });
    expect(insertedNotifications(adminDb)[0]).toMatchObject({
      tenantId: 'tk_fan',
      eventType: 'logging.delivery.retrying',
      severity: 'critical',
    });
  });

  it('fails with admin_db_unavailable when DB_ADMIN is missing', async () => {
    const { message, logger } = await run({ body: fanout(), adminDb: null });
    expect(loggedError(logger)).toContain('logging_delivery_admin_db_unavailable');
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('acks the platform-default archive without contacting any provider', async () => {
    const adminDb = createFakeAdminDb();
    const { fetchMock, message } = await run({
      body: fanout({ destination_id: 'platform_default_r2_archive' }),
      adminDb,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(sqlCalls(adminDb, 'FROM admin_destinations')).toEqual([]);
  });

  it('acknowledges r2 destinations as already written', async () => {
    const adminDb = createFakeAdminDb({ destination: { provider: 'r2', provider_config: null } });
    const { message } = await run({ body: fanout(), adminDb, attempts: 4 });
    const [event] = insertedDeliveryEvents(adminDb);
    expect(event).toMatchObject({
      status: 'delivered',
      attemptCount: 4,
      objectCatalogId: 'cat_fan_1',
      destinationId: 'dest_fan',
    });
    expect(event?.metadata).toEqual({
      payload_id: 'qpl_fan_1',
      catalog_id: 'cat_fan_1',
      object_key: 'logs/v1/object.json',
      record_count: 3,
      provider: 'r2',
      mode: 'chunk_already_written',
    });
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('acks without posting when another worker holds the claim', async () => {
    const adminDb = createFakeAdminDb({
      destination: httpDestination(),
      executeResult: (sql) =>
        sql.includes('delivery_in_progress') ? { rowsAffected: 0 } : undefined,
    });
    const { fetchMock, message } = await run({ body: fanout(), adminDb });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(insertedDeliveryEvents(adminDb)).toEqual([]);
  });

  it('retries 5xx responses, releasing the claim and recording the retry time', async () => {
    const adminDb = createFakeAdminDb({ destination: httpDestination() });
    const { message } = await run({
      body: fanout(),
      adminDb,
      fetchImpl: vi.fn().mockResolvedValue(fetchResponse(502, { 'Retry-After': '20' })),
    });
    expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toHaveLength(1);
    expect(sqlCalls(adminDb, "SET status = 'delivered'")).toEqual([]);
    const [event] = insertedDeliveryEvents(adminDb);
    expect(event).toMatchObject({
      status: 'retrying',
      errorClass: 'http_status_502',
      nextRetryAt: NOW.getTime() + 20_000,
      objectCatalogId: 'cat_fan_1',
    });
    expect(event?.metadata).toMatchObject({
      provider: 'http',
      http_status: 502,
      redacted_headers: {},
    });
    expect(insertedNotifications(adminDb)).toHaveLength(1);
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('acks permanent failures after notifying', async () => {
    const adminDb = createFakeAdminDb({ destination: httpDestination() });
    const { message } = await run({
      body: fanout({ lane: 'bulk' }),
      adminDb,
      fetchImpl: vi.fn().mockResolvedValue(fetchResponse(410)),
    });
    expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
      status: 'failed',
      errorClass: 'http_status_410',
      nextRetryAt: null,
      lane: 'bulk',
    });
    expect(insertedNotifications(adminDb)[0]).toMatchObject({
      eventType: 'logging.delivery.failed',
      severity: 'medium',
    });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('preserves an emitted claim when completion fails', async () => {
    const adminDb = createFakeAdminDb({
      destination: httpDestination(),
      executeResult: (sql) =>
        sql.includes("SET status = 'delivered'") ? { rowsAffected: 0 } : undefined,
    });
    const { message } = await run({ body: fanout(), adminDb });
    expect(sqlCalls(adminDb, 'delivery_emission_uncertain')).toHaveLength(1);
    expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toEqual([]);
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('releases the claim and warns when cleanup fails after a delivery exception', async () => {
    const adminDb = createFakeAdminDb({
      destination: httpDestination(),
      executeResult: (sql) =>
        sql.includes('DELETE FROM logging_delivery_events') ? new Error('cleanup down') : undefined,
    });
    const { message, logger } = await run({
      body: fanout(),
      adminDb,
      fetchImpl: vi.fn().mockRejectedValue(new Error('boom')),
    });
    expect(logger.warn).toHaveBeenCalledWith('logging_http_delivery_claim_cleanup_failed', {
      payloadId: 'qpl_fan_1',
      error: 'Error: cleanup down',
    });
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it('logs preservation failures for emitted claims', async () => {
    const adminDb = createFakeAdminDb({
      destination: httpDestination(),
      executeResult: (sql) => {
        if (sql.includes("SET status = 'delivered'")) return { rowsAffected: 0 };
        if (sql.includes('delivery_emission_uncertain')) return new Error('preserve down');
        return undefined;
      },
    });
    const { logger } = await run({ body: fanout(), adminDb });
    expect(logger.warn).toHaveBeenCalledWith('logging_http_delivery_claim_cleanup_failed', {
      payloadId: 'qpl_fan_1',
      error: 'Error: preserve down',
    });
  });

  it('treats attempts below 1 as the first attempt', async () => {
    const adminDb = createFakeAdminDb({ destination: { provider: 'r2', provider_config: null } });
    await run({ body: fanout(), adminDb, attempts: 0 });
    expect(insertedDeliveryEvents(adminDb)[0]?.attemptCount).toBe(1);
  });

  it('derives stable claim ids per destination and payload', async () => {
    const claimId = async (body: unknown) => {
      const db = createFakeAdminDb({ destination: httpDestination() });
      await run({ body, adminDb: db });
      const [claim] = sqlCalls(db, 'delivery_in_progress').filter(([sql]) =>
        String(sql).trimStart().startsWith('INSERT')
      );
      return (claim?.[1] as unknown[])[0] as string;
    };
    const first = await claimId(fanout());
    expect(first).toMatch(/^lde_/);
    expect(await claimId(fanout())).toBe(first);
    expect(await claimId(fanout({ payload_id: 'qpl_other' }))).not.toBe(first);
    expect(await claimId(fanout({ destination_id: 'dest_other' }))).not.toBe(first);
  });
});
