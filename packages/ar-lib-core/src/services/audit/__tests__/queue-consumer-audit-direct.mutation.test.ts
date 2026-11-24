import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import { processAuditQueue, type AuditQueueConsumerEnv } from '../queue-consumer';
import type { AuditQueueMessage } from '../types';
import {
  createFakeAdminDb,
  createFakeLogger,
  createMessage,
  fetchResponse,
  insertedDeliveryEvents,
  insertedNotifications,
  sqlCalls,
  type FakeAdminDb,
} from './queue-consumer-mutation-helpers';

const TIMESTAMP = 1779148800000;
const NOW = new Date('2026-03-04T05:06:07.000Z');
let tenantCounter = 0;

function nextTenant(): string {
  tenantCounter += 1;
  return `tenant-direct-${tenantCounter}`;
}

type SinkFailureMode = 'best_effort' | 'gate_cleanup' | 'retry_until_ttl';

function directBody(
  tenantId: string,
  sink: Record<string, unknown>,
  sinkFailureMode: SinkFailureMode = 'best_effort'
): AuditQueueMessage {
  return {
    type: 'event_log',
    tenantId,
    timestamp: TIMESTAMP,
    entries: [
      {
        id: 'evt-direct',
        tenantId,
        eventType: 'auth.login',
        eventCategory: 'auth',
        result: 'success',
        severity: 'info',
        createdAt: TIMESTAMP,
      },
    ],
    fanout: {
      auditProfileId: 'profile-direct',
      archives: [],
      sinks: [sink],
      archiveFailureMode: 'best_effort',
      sinkFailureMode,
    },
  } as unknown as AuditQueueMessage;
}

async function run(input: {
  sink?: Record<string, unknown>;
  mode?: SinkFailureMode;
  fetchImpl?: ReturnType<typeof vi.fn>;
  adminDb?: FakeAdminDb | null;
  env?: Record<string, unknown>;
  attempts?: number;
}) {
  const tenantId = nextTenant();
  const fetchMock = input.fetchImpl ?? vi.fn().mockResolvedValue(fetchResponse(200));
  vi.stubGlobal('fetch', fetchMock);
  const adminDb = input.adminDb === undefined ? createFakeAdminDb() : input.adminDb;
  const message = createMessage(
    directBody(
      tenantId,
      input.sink ?? { type: 'http', url: 'https://example.com/audit' },
      input.mode
    ),
    { attempts: input.attempts ?? 1 }
  );
  const logger = createFakeLogger();
  await processAuditQueue(
    { messages: [message] } as unknown as MessageBatch<AuditQueueMessage>,
    {
      DB: {},
      DB_PII: {},
      ...(adminDb ? { DB_ADMIN: adminDb } : {}),
      ...input.env,
    } as unknown as AuditQueueConsumerEnv,
    logger
  );
  const tenantKey = await deriveTenantKeyFromTenantId(tenantId, undefined);
  return { tenantId, tenantKey, fetchMock, adminDb, message, logger };
}

function claimStatements(db: FakeAdminDb) {
  return sqlCalls(db, "'delivery_in_progress'").filter(([sql]) =>
    String(sql).trimStart().startsWith('INSERT')
  );
}

describe('audit direct HTTP sink delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('successful delivery', () => {
    it('claims before posting, sends the canonical batch, and completes the claim', async () => {
      const { adminDb, fetchMock, message, tenantId, tenantKey } = await run({
        sink: {
          type: 'http',
          url: 'https://example.com/audit',
          headers: { 'X-Sink': 'one' },
          authTokenRef: 'DIRECT_SINK_TOKEN',
        },
        env: { DIRECT_SINK_TOKEN: 'direct-token' },
        attempts: 3,
      });

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://example.com/audit');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({
        'Content-Type': 'application/json',
        'X-Sink': 'one',
        Authorization: 'Bearer direct-token',
        'X-Authrim-Delivery': `${tenantId}:${TIMESTAMP}:evt-direct`,
      });
      expect(JSON.parse(init.body as string)).toMatchObject({ recordType: 'audit_batch' });

      const [claim] = claimStatements(adminDb);
      const claimParams = claim?.[1] as unknown[];
      expect(claimParams.slice(1, 8)).toEqual([
        tenantKey,
        'http:direct_url',
        'audit',
        'external_sink',
        'critical',
        3,
        null,
      ]);
      expect(claimParams[8]).toBe(NOW.getTime());
      expect(claimParams[9]).toBe(NOW.getTime());
      expect(claimParams[10]).toBe(NOW.getTime() + 60_000);
      expect(JSON.parse(claimParams[11] as string)).toMatchObject({
        audit_profile_id: 'profile-direct',
        target_type: 'http',
        destination_id: 'http:direct_url',
        record_count: 1,
        auth_token_ref_set: true,
        header_count: 1,
      });

      const [completion] = sqlCalls(adminDb, "SET status = 'delivered'");
      const completionParams = completion?.[1] as unknown[];
      expect(completionParams[0]).toBe(3);
      expect(completionParams[1]).toBeNull();
      expect(completionParams[4]).toBe(claimParams[0]);
      expect(JSON.parse(completionParams[3] as string)).toMatchObject({
        destination_id: 'http:direct_url',
        http_status: 200,
      });

      const claimOrder = adminDb.execute.mock.invocationCallOrder[0] ?? Infinity;
      expect(claimOrder).toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0);
      expect(insertedDeliveryEvents(adminDb)).toEqual([]);
      expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toEqual([]);
      expect(insertedNotifications(adminDb)).toEqual([]);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    });

    it('names the destination after the urlRef', async () => {
      const { adminDb } = await run({
        sink: { type: 'http', urlRef: 'DIRECT_URL_REF' },
        env: { DIRECT_URL_REF: 'https://ref.example/ingest' },
      });
      expect(claimStatements(adminDb)[0]?.[1]).toEqual(
        expect.arrayContaining(['http:DIRECT_URL_REF'])
      );
    });

    it('sends no Authorization header without a token ref and no custom headers', async () => {
      const { fetchMock } = await run({});
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual([
        'Content-Type',
        'X-Authrim-Delivery',
      ]);
    });

    it('sends only the token header when there are no custom headers', async () => {
      const { fetchMock } = await run({
        sink: { type: 'http', url: 'https://example.com/audit', authTokenRef: 'ONLY_TOKEN' },
        env: { ONLY_TOKEN: 'only' },
      });
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer only');
    });

    it('skips delivery when another worker already holds the claim', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes('delivery_in_progress') ? { rowsAffected: 0 } : undefined,
      });
      const { fetchMock, message } = await run({ adminDb });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sqlCalls(adminDb, "SET status = 'delivered'")).toEqual([]);
      expect(insertedDeliveryEvents(adminDb)).toEqual([]);
      expect(message.ack).toHaveBeenCalledOnce();
    });
  });

  describe('non-success responses', () => {
    it('records a failed event and a critical external notification for a permanent failure (best effort)', async () => {
      const { adminDb, fetchMock, message, logger, tenantId, tenantKey } = await run({
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(400)),
        attempts: 2,
      });
      expect(fetchMock).toHaveBeenCalledOnce();

      expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toHaveLength(1);
      expect(sqlCalls(adminDb, "SET status = 'delivered'")).toEqual([]);
      const events = insertedDeliveryEvents(adminDb);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantKey,
        destinationId: 'http:direct_url',
        logType: 'audit',
        plane: 'external_sink',
        lane: 'critical',
        status: 'failed',
        attemptCount: 2,
        errorClass: 'http_status_400',
        nextRetryAt: null,
      });
      expect(events[0]?.metadata).toMatchObject({ http_status: 400, record_count: 1 });

      const notifications = insertedNotifications(adminDb);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        tenantId,
        category: 'logging_delivery_failure',
        eventType: 'logging.delivery.failed',
        severity: 'critical',
        deduplicationKey: [
          'logging_delivery',
          'failed',
          tenantKey,
          'http:direct_url',
          'audit',
          'external_sink',
          'critical',
          'http_status_400',
        ].join(':'),
      });
      expect(notifications[0]?.payload).toMatchObject({
        status: 'failed',
        attempt_count: 2,
        error_class: 'http_status_400',
        external_notification_eligible: true,
        notification_routing_policy: expect.objectContaining({
          providers: ['internal_event', 'webhook', 'email'],
        }) as unknown,
      });

      expect(logger.warn).toHaveBeenCalledWith('audit_sink_delivery_failed', {
        tenantId,
        auditProfileId: 'profile-direct',
        sinkType: 'http',
        error: 'Error: HTTP sink delivery failed: 400',
      });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
    });

    it('records a retrying event with the Retry-After delay and retries under retry_until_ttl', async () => {
      const { adminDb, message, logger } = await run({
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(503, { 'Retry-After': '30' })),
        mode: 'retry_until_ttl',
      });
      const events = insertedDeliveryEvents(adminDb);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        status: 'retrying',
        errorClass: 'http_status_503',
        nextRetryAt: NOW.getTime() + 30_000,
      });
      expect(insertedNotifications(adminDb)[0]).toMatchObject({
        eventType: 'logging.delivery.retrying',
      });
      expect(insertedNotifications(adminDb)[0]?.payload).toMatchObject({
        external_notification_eligible: false,
      });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(message.ack).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'audit_queue_message_failed',
        expect.objectContaining({ error: 'Error: HTTP sink delivery retrying: 503' })
      );
    });

    it('stores a null next retry time when the retry delay is zero', async () => {
      const { adminDb } = await run({
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(429, { 'Retry-After': '0' })),
        mode: 'retry_until_ttl',
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'retrying',
        errorClass: 'http_status_429',
        nextRetryAt: null,
      });
    });

    it('marks 4xx responses retrying (not failed) under retry_until_ttl, without a retry time', async () => {
      const { adminDb, message, logger } = await run({
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(404)),
        mode: 'retry_until_ttl',
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'retrying',
        errorClass: 'http_status_404',
        nextRetryAt: null,
      });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'audit_queue_message_failed',
        expect.objectContaining({ error: 'Error: HTTP sink delivery failed: 404' })
      );
    });

    it('treats gate_cleanup sinks like retrying events without failing the message', async () => {
      const { adminDb, message, logger } = await run({
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(500, { 'Retry-After': '10' })),
        mode: 'gate_cleanup',
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'retrying',
        nextRetryAt: NOW.getTime() + 10_000,
      });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'audit_sink_delivery_failed',
        expect.objectContaining({ error: 'Error: HTTP sink delivery retrying: 500' })
      );
    });

    it('records the Retry-After time for a failed best-effort 5xx', async () => {
      const { adminDb } = await run({
        fetchImpl: vi.fn().mockResolvedValue(fetchResponse(502, { 'Retry-After': '12' })),
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'failed',
        errorClass: 'http_status_502',
        nextRetryAt: NOW.getTime() + 12_000,
      });
    });
  });

  describe('exceptions before or during delivery', () => {
    it.each([
      [
        'an unresolved token',
        { type: 'http', url: 'https://example.com/audit', authTokenRef: 'MISSING_TOKEN' },
        'http_sink_auth_unresolved',
        'HTTP sink auth token not resolved: MISSING_TOKEN',
      ],
      [
        'an unresolved url ref',
        { type: 'http', urlRef: 'MISSING_URL' },
        'http_sink_url_unresolved',
        'HTTP sink URL not resolved: MISSING_URL',
      ],
      [
        'a url that is neither inline nor referenced',
        { type: 'http' },
        'http_sink_url_unresolved',
        'HTTP sink URL not resolved: missing_url',
      ],
      [
        'a plain http url',
        { type: 'http', url: 'http://example.com/audit' },
        'http_sink_url_must_use_https',
        'http_sink_url_must_use_https',
      ],
    ])('classifies %s', async (_name, sink, errorClass, errorText) => {
      const { adminDb, fetchMock, message, logger, tenantId, tenantKey } = await run({ sink });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toHaveLength(1);
      const events = insertedDeliveryEvents(adminDb);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tenantKey,
        status: 'failed',
        errorClass,
        nextRetryAt: null,
        plane: 'external_sink',
      });
      expect(events[0]?.metadata).not.toHaveProperty('http_status');
      expect(insertedNotifications(adminDb)[0]).toMatchObject({
        tenantId,
        eventType: 'logging.delivery.failed',
      });
      expect(logger.warn).toHaveBeenCalledWith('audit_sink_delivery_failed', {
        tenantId,
        auditProfileId: 'profile-direct',
        sinkType: 'http',
        error: `Error: ${errorText}`,
      });
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('uses the generic error class for unexpected delivery exceptions', async () => {
      const { adminDb } = await run({
        fetchImpl: vi.fn().mockRejectedValue(new Error('socket hang up')),
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'failed',
        errorClass: 'http_sink_delivery_failed',
      });
    });

    it('retries the queue message for exceptions under retry_until_ttl', async () => {
      const { adminDb, message, logger } = await run({
        fetchImpl: vi.fn().mockRejectedValue(new Error('socket hang up')),
        mode: 'retry_until_ttl',
      });
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({ status: 'retrying' });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'audit_queue_message_failed',
        expect.objectContaining({ error: 'Error: socket hang up' })
      );
    });

    it('fails with claim_store_unavailable when DB_ADMIN is missing (best effort)', async () => {
      const { fetchMock, message, logger, tenantId } = await run({ adminDb: null });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('audit_sink_delivery_failed', {
        tenantId,
        auditProfileId: 'profile-direct',
        sinkType: 'http',
        error: 'Error: logging_delivery_claim_store_unavailable',
      });
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('retries when DB_ADMIN is missing under retry_until_ttl', async () => {
      const { message, logger } = await run({ adminDb: null, mode: 'retry_until_ttl' });
      expect(message.retry).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'audit_queue_message_failed',
        expect.objectContaining({ error: 'Error: logging_delivery_claim_store_unavailable' })
      );
    });

    it('preserves an emitted claim when completing it fails', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes("SET status = 'delivered'") ? { rowsAffected: 0 } : undefined,
      });
      const { message, logger, tenantId } = await run({ adminDb });

      expect(sqlCalls(adminDb, 'delivery_emission_uncertain')).toHaveLength(1);
      const [preserve] = sqlCalls(adminDb, 'delivery_emission_uncertain');
      expect((preserve?.[1] as unknown[])[0]).toBe(NOW.getTime());
      expect(sqlCalls(adminDb, 'DELETE FROM logging_delivery_events')).toEqual([]);
      expect(insertedDeliveryEvents(adminDb)[0]).toMatchObject({
        status: 'failed',
        errorClass: 'http_sink_delivery_failed',
      });
      expect(logger.warn).toHaveBeenCalledWith('audit_sink_delivery_failed', {
        tenantId,
        auditProfileId: 'profile-direct',
        sinkType: 'http',
        error: 'Error: logging_delivery_claim_not_owned',
      });
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('logs claim cleanup failures without masking the delivery error', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes('DELETE FROM logging_delivery_events')
            ? new Error('delete failed')
            : undefined,
      });
      const { logger, tenantId, message } = await run({
        adminDb,
        fetchImpl: vi.fn().mockRejectedValue(new Error('boom')),
      });
      expect(logger.warn).toHaveBeenCalledWith('audit_http_delivery_claim_cleanup_failed', {
        tenantId,
        auditProfileId: 'profile-direct',
        error: 'Error: delete failed',
      });
      expect(logger.warn).toHaveBeenCalledWith(
        'audit_sink_delivery_failed',
        expect.objectContaining({ error: 'Error: boom' })
      );
      expect(message.ack).toHaveBeenCalledOnce();
    });

    it('logs preservation failures for emitted claims', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) => {
          if (sql.includes("SET status = 'delivered'")) return { rowsAffected: 0 };
          if (sql.includes('delivery_emission_uncertain')) return new Error('preserve failed');
          return undefined;
        },
      });
      const { logger, tenantId } = await run({ adminDb });
      expect(logger.warn).toHaveBeenCalledWith('audit_http_delivery_claim_cleanup_failed', {
        tenantId,
        auditProfileId: 'profile-direct',
        error: 'Error: preserve failed',
      });
    });
  });

  describe('queue retry scheduling', () => {
    function claimActiveError(retryAt: unknown, name = 'LogChunkWriteClaimActiveError') {
      return Object.assign(new Error('claim active'), { name, retryAt });
    }

    async function runWithClaimError(error: Error) {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) =>
          sql.includes("'delivery_in_progress'") && sql.trimStart().startsWith('INSERT')
            ? error
            : undefined,
      });
      return run({ adminDb, mode: 'retry_until_ttl' });
    }

    it.each([
      ['2.5 seconds ahead', NOW.getTime() + 2500, 3],
      ['exactly one second ahead', NOW.getTime() + 1000, 1],
      ['1001 ms ahead', NOW.getTime() + 1001, 2],
      ['ten minutes ahead', NOW.getTime() + 600_000, 600],
      ['in the past', NOW.getTime() - 5000, 1],
      ['now', NOW.getTime(), 1],
    ])('delays the retry when the claim is active until %s', async (_name, retryAt, delay) => {
      const { message } = await runWithClaimError(claimActiveError(retryAt));
      expect(message.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: delay });
      expect(message.ack).not.toHaveBeenCalled();
    });

    it.each([
      ['a different error name', claimActiveError(NOW.getTime() + 9000, 'OtherError')],
      ['a non-numeric retryAt', claimActiveError('soon')],
      ['a missing retryAt', claimActiveError(undefined)],
    ])('retries immediately for %s', async (_name, error) => {
      const { message } = await runWithClaimError(error);
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
    });

    it('retries immediately when a non-object is thrown', async () => {
      const adminDb = createFakeAdminDb({
        executeResult: (sql) => {
          if (sql.includes("'delivery_in_progress'") && sql.trimStart().startsWith('INSERT')) {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'string failure';
          }
          return undefined;
        },
      });
      const { message } = await run({ adminDb, mode: 'retry_until_ttl' });
      expect(message.retry).toHaveBeenCalledExactlyOnceWith();
    });
  });
});
