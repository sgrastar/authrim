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
import { MessageBatchFake, createCapturingLogger, messageCallCounts } from './harness';

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
          entry.dimensions.payloadFamily === 'chunk-write'
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
