/**
 * Queue delivery matrices through the production audit / DLQ / logging-delivery
 * consumers. Every message fake records EVERY ack()/retry() call (ackCalls/retryCalls)
 * plus the first-call-wins effective disposition. Every row asserts:
 * - ackCalls + retryCalls >= 1 per message (production always disposes the message)
 * - never both positive per message (no conflicting disposition)
 * - the effective disposition is exactly one of ack/retry
 * - mixed-batch success messages are never retried and failures are never acked
 * - duplicate delivery really re-delivers with fresh Message objects over the same
 *   durable state, and write calls are counted separately from unique durable effects
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createSecurityMatrixEnv, type SecurityMatrixEnvKit } from '../fixtures/env';
import { CallLedger } from '../fixtures/call-ledger';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import { QUEUE_AUDIT_CASE_TABLE, QUEUE_DLQ_CASE_TABLE, QUEUE_LOG_CASE_TABLE } from './cases';
import {
  FROZEN_NOW,
  batchIds,
  buildQueueObservation,
  makeQueueEnv,
  messageBody,
  queueCanarySecret,
  queueDecisionFor,
  queueMutationCandidate,
  runQueueRow,
} from './queue-observation';
import {
  processAuditQueue,
  processLoggingDeliveryQueue,
} from '../../../packages/ar-lib-core/src/services/audit/queue-consumer';
import { MessageFake, MessageBatchFake, createCapturingLogger, messageCallCounts } from './harness';

describe('state-transition Matrix Q-A: audit queue consumer', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;

  beforeEach(async () => {
    installFrozenNow(FROZEN_NOW);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of QUEUE_AUDIT_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const ids = batchIds(entry);
      const { logger } = await runQueueRow(kit, ledger, entry);
      const observation = await buildQueueObservation(kit, ledger, entry, ids, logger);
      const expected = queueDecisionFor(entry);
      expect(observation, entry.id).toEqual(expected);
      // Every message is disposed exactly once per delivery by one kind of call.
      const calls = messageCallCounts(ledger, ids);
      for (const id of ids) {
        expect(
          calls[id].ackCalls + calls[id].retryCalls,
          `${entry.id} ${id} total calls`
        ).toBeGreaterThanOrEqual(1);
        expect(
          calls[id].ackCalls > 0 && calls[id].retryCalls > 0,
          `${entry.id} ${id} conflicting calls`
        ).toBe(false);
        expect(calls[id].effective, `${entry.id} ${id} effective`).toBe(
          calls[id].ackCalls > 0 ? 'ack' : 'retry'
        );
      }
    });
  }

  it('every audit consumer case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of QUEUE_AUDIT_CASE_TABLE) {
      const base = queueDecisionFor(entry);
      const baseSignature = JSON.stringify(base);
      for (const mutationId of entry.mutationIds) {
        const mutant = queueMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  it('mixed batches isolate acked and retried messages', async () => {
    expect.hasAssertions();
    const entry = QUEUE_AUDIT_CASE_TABLE.find(
      (row) => String(row.dimensions.batchComposition) === 'mixed'
    ) as (typeof QUEUE_AUDIT_CASE_TABLE)[number];
    const ids = ['m1', 'm2'];
    const { logger } = await runQueueRow(kit, ledger, entry);
    const calls = messageCallCounts(ledger, ids);
    expect(calls['m1'].ackCalls, 'm1 acked').toBeGreaterThanOrEqual(1);
    expect(calls['m1'].retryCalls, 'm1 never retried').toBe(0);
    expect(calls['m2'].retryCalls, 'm2 retried').toBeGreaterThanOrEqual(1);
    expect(calls['m2'].ackCalls, 'm2 never acked').toBe(0);
    const observation = await buildQueueObservation(kit, ledger, entry, ids, logger);
    expect(observation.acked).toContain('m1');
    expect(observation.retried).toContain('m2');
  });

  it('a transient failure is never acked', async () => {
    expect.hasAssertions();
    const entry = QUEUE_AUDIT_CASE_TABLE.find(
      (row) => String(row.dimensions.bindingState) === 'throws'
    ) as (typeof QUEUE_AUDIT_CASE_TABLE)[number];
    const ids = batchIds(entry);
    const { logger } = await runQueueRow(kit, ledger, entry);
    const calls = messageCallCounts(ledger, ids);
    for (const id of ids) {
      expect(calls[id].ackCalls, `${id} transient never acked`).toBe(0);
      expect(calls[id].retryCalls, `${id} transient retried`).toBeGreaterThanOrEqual(1);
    }
    const observation = await buildQueueObservation(kit, ledger, entry, ids, logger);
    expect(observation.retried.length).toBeGreaterThan(0);
  });

  it('the canary secret never leaks on the audit path', async () => {
    expect.hasAssertions();
    const entry = QUEUE_AUDIT_CASE_TABLE[0];
    const ids = batchIds(entry);
    const { logger } = await runQueueRow(kit, ledger, entry);
    const observation = await buildQueueObservation(kit, ledger, entry, ids, logger);
    expect(observation.secretLeak, `${entry.id} credential canary leaked`).toBe(false);
  });
});

describe('state-transition Matrix Q-D: DLQ consumer', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;

  beforeEach(async () => {
    installFrozenNow(FROZEN_NOW);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of QUEUE_DLQ_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const ids = batchIds(entry);
      const { logger } = await runQueueRow(kit, ledger, entry);
      const observation = await buildQueueObservation(kit, ledger, entry, ids, logger);
      const expected = queueDecisionFor(entry);
      expect(observation, entry.id).toEqual(expected);
      const calls = messageCallCounts(ledger, ids);
      for (const id of ids) {
        expect(
          calls[id].ackCalls + calls[id].retryCalls,
          `${entry.id} ${id} total calls`
        ).toBeGreaterThanOrEqual(1);
        expect(
          calls[id].ackCalls > 0 && calls[id].retryCalls > 0,
          `${entry.id} ${id} conflicting calls`
        ).toBe(false);
        expect(calls[id].effective, `${entry.id} ${id} effective`).toBe(
          calls[id].ackCalls > 0 ? 'ack' : 'retry'
        );
      }
    });
  }

  it('every DLQ consumer case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of QUEUE_DLQ_CASE_TABLE) {
      const base = queueDecisionFor(entry);
      const baseSignature = JSON.stringify(base);
      for (const mutationId of entry.mutationIds) {
        const mutant = queueMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });
});

describe('state-transition Matrix Q-L: logging delivery consumer', () => {
  let kit: SecurityMatrixEnvKit;
  let ledger: CallLedger;

  beforeEach(async () => {
    installFrozenNow(FROZEN_NOW);
    ledger = new CallLedger();
    kit = await createSecurityMatrixEnv(ledger);
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of QUEUE_LOG_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const ids = batchIds(entry);
      const { logger } = await runQueueRow(kit, ledger, entry);
      const observation = await buildQueueObservation(kit, ledger, entry, ids, logger);
      const expected = queueDecisionFor(entry);
      expect(observation, entry.id).toEqual(expected);
      const calls = messageCallCounts(ledger, ids);
      for (const id of ids) {
        expect(
          calls[id].ackCalls + calls[id].retryCalls,
          `${entry.id} ${id} total calls`
        ).toBeGreaterThanOrEqual(1);
        expect(
          calls[id].ackCalls > 0 && calls[id].retryCalls > 0,
          `${entry.id} ${id} conflicting calls`
        ).toBe(false);
        expect(calls[id].effective, `${entry.id} ${id} effective`).toBe(
          calls[id].ackCalls > 0 ? 'ack' : 'retry'
        );
      }
    });
  }

  it('every logging-delivery case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of QUEUE_LOG_CASE_TABLE) {
      const base = queueDecisionFor(entry);
      const baseSignature = JSON.stringify(base);
      for (const mutationId of entry.mutationIds) {
        const mutant = queueMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  void MessageBatchFake;
});

describe('secret-leak oracle effectiveness', () => {
  it('the canary is an environment credential and is absent from the delivered message', async () => {
    expect.hasAssertions();
    installFrozenNow(FROZEN_NOW);
    const ledger = new CallLedger();
    const kit = await createSecurityMatrixEnv(ledger);
    const entry = QUEUE_AUDIT_CASE_TABLE[0];
    const canary = queueCanarySecret(entry.id);
    const body = messageBody(entry, 'm1', canary);
    const { env } = makeQueueEnv(kit, entry, ledger, canary);
    expect((env as Record<string, unknown>).OBJECT_ENCRYPTION_ROOT_KEY).toBe(canary);
    expect(JSON.stringify(body)).not.toContain(canary);
    restoreRealClock();
  });

  it('a leak into a derived R2 object body is detected', async () => {
    expect.hasAssertions();
    installFrozenNow(FROZEN_NOW);
    const ledger = new CallLedger();
    ledger.record('event', 'r2meta:AUDIT_ARCHIVE:logs/v1/chunk.jsonl.gz', {
      key: 'logs/v1/chunk.jsonl.gz',
      bodySnippet: null,
      canaryPresent: true,
    });
    const cap = { entries: [] } as unknown as Awaited<ReturnType<typeof createCapturingLogger>>;
    const { scanForSecretLeak, queueCanarySecret } = await import('./queue-observation');
    expect(scanForSecretLeak(ledger, cap, queueCanarySecret('st-qa-001'))).toBe(true);
    restoreRealClock();
  });

  it('a credential leak into a DLQ archive is detected', async () => {
    expect.hasAssertions();
    installFrozenNow(FROZEN_NOW);
    const ledger = new CallLedger();
    ledger.record('event', 'r2meta:AUDIT_ARCHIVE:dlq/tenant_key=x/key.json', {
      key: 'dlq/tenant_key=x/key.json',
      canaryPresent: true,
    });
    const cap = { entries: [] } as unknown as Awaited<ReturnType<typeof createCapturingLogger>>;
    const { scanForSecretLeak, queueCanarySecret } = await import('./queue-observation');
    expect(scanForSecretLeak(ledger, cap, queueCanarySecret('st-qa-001'))).toBe(true);
    restoreRealClock();
  });
});

describe('out-of-order queue delivery', () => {
  afterEach(() => {
    restoreRealClock();
  });

  it('preserves per-message disposition and durable effects for every production consumer', async () => {
    expect.hasAssertions();
    const representatives = [
      QUEUE_AUDIT_CASE_TABLE.find(
        (entry) =>
          entry.dimensions.batchComposition === 'all-success' &&
          entry.dimensions.delivery === 'first' &&
          entry.dimensions.bindingState === 'present' &&
          entry.dimensions.payloadFamily === 'event-log'
      ),
      QUEUE_DLQ_CASE_TABLE.find(
        (entry) =>
          entry.dimensions.batchComposition === 'all-success' &&
          entry.dimensions.delivery === 'first' &&
          entry.dimensions.bindingState === 'present'
      ),
      QUEUE_LOG_CASE_TABLE.find(
        (entry) =>
          entry.dimensions.batchComposition === 'all-success' &&
          entry.dimensions.delivery === 'first' &&
          entry.dimensions.schema === 'supported' &&
          entry.dimensions.bindingState === 'present' &&
          entry.dimensions.payloadFamily === 'iceberg-ingest'
      ),
    ];
    expect(representatives.every(Boolean), 'all queue consumers have an order probe').toBe(true);

    for (const entry of representatives) {
      if (!entry) throw new Error('missing out-of-order representative');
      const run = async (messageOrder: 'forward' | 'reverse') => {
        installFrozenNow(FROZEN_NOW);
        const ledger = new CallLedger();
        const kit = await createSecurityMatrixEnv(ledger);
        const ids = ['order-m1', 'order-m2'];
        const { logger } = await runQueueRow(kit, ledger, entry, {
          messageIds: ids,
          messageOrder,
        });
        return buildQueueObservation(kit, ledger, entry, ids, logger);
      };
      const forward = await run('forward');
      const reverse = await run('reverse');
      expect(reverse, `${entry.matrix} reverse-order observation`).toEqual(forward);
      expect(forward.acked, `${entry.matrix} both messages acknowledged`).toEqual([
        'order-m1',
        'order-m2',
      ]);
      expect(forward.retried, `${entry.matrix} no message retried`).toEqual([]);
    }
  });
});

describe('forward-only queue persistence boundaries', () => {
  afterEach(() => restoreRealClock());

  for (const type of ['event_log', 'pii_log']) {
    it(`rejects retired ${type} primary writes without ACK or a legacy durable effect`, async () => {
      installFrozenNow(FROZEN_NOW);
      const ledger = new CallLedger();
      const kit = await createSecurityMatrixEnv(ledger);
      const entry = QUEUE_AUDIT_CASE_TABLE.find(
        (row) =>
          row.dimensions.batchComposition === 'all-success' &&
          row.dimensions.bindingState === 'present'
      );
      if (!entry) throw new Error('missing healthy audit fixture');
      const { env, logger } = makeQueueEnv(kit, entry, ledger, queueCanarySecret(entry.id));
      const body: Record<string, unknown> = {
        ...messageBody(entry, 'legacy-m1', queueCanarySecret(entry.id)),
        type,
      };
      delete body.fanout;
      const message = new MessageFake({ id: 'legacy-m1', body }, ledger);
      await processAuditQueue(
        { queue: 'audit', messages: [message] } as never,
        env as never,
        logger.logger as never
      );
      expect(message.ackCalls).toBe(0);
      expect(message.retryCalls).toBe(1);
      expect(ledger.ofKind('r2.put')).toEqual([]);
      expect(ledger.ofKind('d1.execute')).toEqual([]);
    });
  }

  it('rejects retired ordinary chunk writes even with healthy bindings', async () => {
    installFrozenNow(FROZEN_NOW);
    const ledger = new CallLedger();
    const kit = await createSecurityMatrixEnv(ledger);
    const healthy = QUEUE_LOG_CASE_TABLE.find(
      (row) =>
        row.dimensions.payloadFamily === 'iceberg-ingest' &&
        row.dimensions.batchComposition === 'all-success' &&
        row.dimensions.delivery === 'first'
    );
    if (!healthy) throw new Error('missing healthy ingest fixture');
    const entry = {
      ...healthy,
      dimensions: { ...healthy.dimensions, payloadFamily: 'legacy-chunk-write' },
    };
    const { env, logger } = makeQueueEnv(kit, entry, ledger, queueCanarySecret(entry.id));
    const message = new MessageFake(
      { id: 'legacy-chunk', body: messageBody(entry, 'legacy-chunk', queueCanarySecret(entry.id)) },
      ledger
    );
    await processLoggingDeliveryQueue(
      { queue: 'logging-delivery', messages: [message] } as never,
      env as never,
      logger.logger as never
    );
    expect(message.ackCalls).toBe(0);
    expect(message.retryCalls).toBe(1);
    expect(ledger.ofKind('r2.put')).toEqual([]);
    expect(ledger.ofKind('d1.execute')).toEqual([]);
  });

  it('saves an unsupported envelope durably before its ACK', async () => {
    installFrozenNow(FROZEN_NOW);
    const ledger = new CallLedger();
    const kit = await createSecurityMatrixEnv(ledger);
    const entry = QUEUE_LOG_CASE_TABLE.find(
      (row) =>
        row.dimensions.schema === 'future' &&
        row.dimensions.batchComposition === 'all-success' &&
        row.dimensions.delivery === 'first'
    );
    if (!entry) throw new Error('missing future-schema fixture');
    await runQueueRow(kit, ledger, entry);
    const events = ledger.all();
    const save = events.findIndex(
      (event) => event.kind === 'r2.put' && event.target.includes('/unsupported/')
    );
    const ack = events.findIndex((event) => event.kind === 'ack');
    expect(save).toBeGreaterThanOrEqual(0);
    expect(ack).toBeGreaterThan(save);
  });

  it('detects the credential canary in a binary R2 payload without truncation', async () => {
    installFrozenNow(FROZEN_NOW);
    const ledger = new CallLedger();
    const kit = await createSecurityMatrixEnv(ledger);
    const entry = QUEUE_AUDIT_CASE_TABLE.find(
      (row) => row.dimensions.batchComposition === 'all-success'
    );
    if (!entry) throw new Error('missing audit fixture');
    const canary = queueCanarySecret(entry.id);
    const { env, logger } = makeQueueEnv(kit, entry, ledger, canary);
    const bucket = (
      env as { SENSITIVE_DETAILS: { put(key: string, body: Uint8Array): Promise<unknown> } }
    ).SENSITIVE_DETAILS;
    await bucket.put('binary-canary', new TextEncoder().encode(`${'x'.repeat(1000)}${canary}`));
    const { scanForSecretLeak } = await import('./queue-observation');
    expect(scanForSecretLeak(ledger, logger, canary)).toBe(true);
  });
});

describe('healthy database with unavailable queue payload storage', () => {
  afterEach(() => restoreRealClock());

  for (const payloadFamily of ['iceberg-ingest', 'future-schema']) {
    for (const fault of ['missing', 'throws']) {
      it(`${payloadFamily} retries ${fault} R2 while database bindings remain healthy`, async () => {
        installFrozenNow(FROZEN_NOW);
        const ledger = new CallLedger();
        const kit = await createSecurityMatrixEnv(ledger);
        const entry = QUEUE_LOG_CASE_TABLE.find(
          (row) =>
            row.id === `st-ql-app-r2-${payloadFamily}-${fault}` &&
            row.dimensions.payloadFamily === payloadFamily &&
            row.dimensions.bindingState === 'present' &&
            row.dimensions.dlqArchive === fault &&
            row.dimensions.batchComposition === 'all-fail'
        );
        if (!entry) throw new Error(`missing legal healthy-DB ${payloadFamily}/${fault} row`);
        const { messages, logger } = await runQueueRow(kit, ledger, entry);
        const observed = await buildQueueObservation(kit, ledger, entry, batchIds(entry), logger);
        expect(observed).toEqual(queueDecisionFor(entry));
        expect(
          messages.every((message) => message.ackCalls === 0 && message.retryCalls === 1)
        ).toBe(true);
        expect(observed.writeCalls).toBe(0);
        expect(observed.uniqueEffects).toBe(0);
        expect(observed.dlqSaved).toBe(false);
        expect(ledger.ofKind('queue.send')).toEqual([]);

        if (payloadFamily === 'iceberg-ingest') {
          const identityReads = ledger
            .ofKind('d1.queryOne')
            .filter((event) => event.target.includes('FROM log_iceberg_outbox'));
          expect(identityReads.length).toBe(messages.length);
          expect(identityReads.every((event) => (event.detail as { found: boolean }).found)).toBe(
            true
          );
        }
        if (fault === 'throws') {
          const target =
            payloadFamily === 'iceberg-ingest'
              ? 'LOG_ARCHIVE.get:throws'
              : 'SENSITIVE_DETAILS.put:throws';
          expect(
            ledger.ofKind('binding-operation').filter((event) => event.target === target)
          ).toHaveLength(messages.length);
        } else {
          const errorClass =
            payloadFamily === 'iceberg-ingest'
              ? 'log_iceberg_retry_bucket_unavailable'
              : 'logging_delivery_unsupported_payload_dlq_bucket_unavailable';
          expect(
            logger.entries.filter(
              (event) =>
                typeof event.context.error === 'string' && event.context.error.includes(errorClass)
            )
          ).toHaveLength(messages.length);
        }
      });
    }
  }
});
