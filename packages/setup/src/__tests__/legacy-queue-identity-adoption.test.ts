import { describe, expect, it } from 'vitest';
import type { AuthrimLock } from '../core/lock.js';
import {
  adoptLegacyQueueIdentities,
  assertLegacyQueueIdentityAdoptionPersisted,
} from '../core/legacy-queue-identity-adoption.js';

const canonicalQueues = [
  { binding: 'AUDIT_QUEUE', name: 'conformance-audit-queue' },
  {
    binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE',
    name: 'conformance-logging-delivery-critical-queue',
  },
  {
    binding: 'LOGGING_DELIVERY_QUEUE',
    name: 'conformance-logging-delivery-queue',
  },
  {
    binding: 'LOGGING_DELIVERY_BULK_QUEUE',
    name: 'conformance-logging-delivery-bulk-queue',
  },
] as const;

function legacyLock(): AuthrimLock {
  return {
    version: '1.0.0',
    env: 'conformance',
    createdAt: '2026-08-31T00:00:00.000Z',
    d1: {},
    kv: {},
    workers: {},
    queues: Object.fromEntries(
      canonicalQueues.map(({ binding, name }) => [binding, { name, id: name }])
    ),
  };
}

function liveQueues() {
  return canonicalQueues.map(({ binding, name }) => ({
    name,
    id: `provider-${binding.toLowerCase()}`,
  }));
}

function adopt(overrides: Partial<Parameters<typeof adoptLegacyQueueIdentities>[0]> = {}) {
  return adoptLegacyQueueIdentities({
    lock: legacyLock(),
    environment: 'conformance',
    authenticatedAccountId: 'account-id',
    configuredAccountId: 'account-id',
    liveQueues: liveQueues(),
    canonicalQueues,
    ...overrides,
  });
}

describe('legacy Queue identity adoption', () => {
  it('upgrades only id==name sentinels to an exact unique provider inventory', () => {
    const original = legacyLock();
    const result = adopt({ lock: original });

    expect(result.adopted).toHaveLength(4);
    expect(result.lock.queues?.AUDIT_QUEUE).toEqual({
      name: 'conformance-audit-queue',
      id: 'provider-audit_queue',
    });
    expect(original.queues?.AUDIT_QUEUE.id).toBe('conformance-audit-queue');
    expect(() =>
      assertLegacyQueueIdentityAdoptionPersisted(result.lock, 'conformance', result.adopted)
    ).not.toThrow();
  });

  it.each([
    [
      'account mismatch',
      { configuredAccountId: 'other-account' },
      'legacy_queue_adoption_account_mismatch',
    ],
    [
      'environment mismatch',
      { environment: 'other' },
      'legacy_queue_adoption_environment_mismatch',
    ],
    [
      'duplicate live name',
      { liveQueues: [...liveQueues(), liveQueues()[0]] },
      'legacy_queue_adoption_live_name_not_unique:AUDIT_QUEUE',
    ],
    [
      'missing provider ID',
      {
        liveQueues: liveQueues().map((queue, index) =>
          index === 0 ? { name: queue.name } : queue
        ),
      },
      'legacy_queue_adoption_provider_id_unavailable:AUDIT_QUEUE',
    ],
  ])('rejects %s without returning a partial checkpoint', (_name, overrides, error) => {
    expect(() => adopt(overrides)).toThrow(error);
  });

  it('never replaces an already immutable Queue ID', () => {
    const lock = legacyLock();
    for (const queue of Object.values(lock.queues ?? {})) queue.id = `existing-${queue.name}`;
    expect(() => adopt({ lock })).toThrow('legacy_queue_adoption_not_required');
    expect(lock.queues?.AUDIT_QUEUE.id).toBe('existing-conformance-audit-queue');
  });

  it('rejects a noncanonical binding/name and a failed checkpoint readback', () => {
    const lock = legacyLock();
    lock.queues!.AUDIT_QUEUE.name = 'other-audit-queue';
    lock.queues!.AUDIT_QUEUE.id = 'other-audit-queue';
    expect(() => adopt({ lock })).toThrow('legacy_queue_adoption_noncanonical_target:AUDIT_QUEUE');

    const result = adopt();
    const corrupted = structuredClone(result.lock);
    corrupted.queues!.AUDIT_QUEUE.id = 'replacement-id';
    expect(() =>
      assertLegacyQueueIdentityAdoptionPersisted(corrupted, 'conformance', result.adopted)
    ).toThrow('legacy_queue_adoption_checkpoint_verification_failed:AUDIT_QUEUE');
  });
});
