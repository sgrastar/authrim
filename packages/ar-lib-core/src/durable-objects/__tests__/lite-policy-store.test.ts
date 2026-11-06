import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { LITE_POLICY_LEASE_TTL_MS, LitePolicyStore } from '../LitePolicyStore';
import { LITE_POLICY_INITIAL_REVISION } from '../../types/login-ui-lite';

class Storage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

function createStore(storage = new Storage()): { store: LitePolicyStore; storage: Storage } {
  const ctx = { storage } as unknown as DurableObjectState;
  return { store: new LitePolicyStore(ctx, {} as never), storage };
}

const NONE = { login: false, signup: false, reauth: false };

async function commitAlways(store: LitePolicyStore, required = NONE) {
  const lease = await store.acquireLeaseRpc('tenant-a');
  if (!lease.acquired) throw new Error('lease not acquired');
  return store.commitRpc({
    tenantId: 'tenant-a',
    token: lease.token,
    expectedGeneration: lease.generation,
    liteMode: 'always',
    humanVerificationRequired: required,
  });
}

describe('LitePolicyStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a store that never committed as off with the initial revision, without writing', async () => {
    const { store, storage } = createStore();
    await expect(store.getSnapshotRpc('tenant-a')).resolves.toEqual({
      tenantId: 'tenant-a',
      liteMode: 'off',
      humanVerificationRequired: NONE,
      policyRevision: LITE_POLICY_INITIAL_REVISION,
      generation: 0,
      updatedAt: 0,
    });
    expect(storage.data.size).toBe(0);
  });

  it('publishes a change under a live lease and moves the generation and the revision', async () => {
    const { store } = createStore();
    const result = await commitAlways(store, { login: true, signup: true, reauth: false });
    expect(result).toMatchObject({
      committed: true,
      snapshot: {
        liteMode: 'always',
        humanVerificationRequired: { login: true, signup: true, reauth: false },
        generation: 1,
      },
    });
    const snapshot = await store.getSnapshotRpc('tenant-a');
    expect(snapshot.policyRevision).not.toBe(LITE_POLICY_INITIAL_REVISION);
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
  });

  it('keeps the revision when a commit does not change the policy', async () => {
    const { store } = createStore();
    await commitAlways(store);
    const before = await store.getSnapshotRpc('tenant-a');
    const again = await commitAlways(store);
    expect(again).toMatchObject({ committed: true });
    const after = await store.getSnapshotRpc('tenant-a');
    expect(after.policyRevision).toBe(before.policyRevision);
    expect(after.generation).toBe(before.generation + 1);
  });

  it('gives one lease at a time', async () => {
    const { store } = createStore();
    const first = await store.acquireLeaseRpc('tenant-a');
    expect(first.acquired).toBe(true);
    const second = await store.acquireLeaseRpc('tenant-a');
    expect(second).toEqual({
      acquired: false,
      reason: 'busy',
      retryAfterMs: LITE_POLICY_LEASE_TTL_MS,
    });
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(true);
  });

  it('refuses a commit whose lease ran out, even when nobody took another', async () => {
    const { store } = createStore();
    const lease = await store.acquireLeaseRpc('tenant-a');
    if (!lease.acquired) throw new Error('lease not acquired');
    vi.advanceTimersByTime(LITE_POLICY_LEASE_TTL_MS);
    await expect(
      store.commitRpc({
        tenantId: 'tenant-a',
        token: lease.token,
        expectedGeneration: lease.generation,
        liteMode: 'always',
        humanVerificationRequired: NONE,
      })
    ).resolves.toEqual({ committed: false, reason: 'lease_lost' });
    expect((await store.getSnapshotRpc('tenant-a')).liteMode).toBe('off');
  });

  it('refuses the commit of an owner whose lease another caller took over', async () => {
    const { store } = createStore();
    const stale = await store.acquireLeaseRpc('tenant-a');
    if (!stale.acquired) throw new Error('lease not acquired');
    vi.advanceTimersByTime(LITE_POLICY_LEASE_TTL_MS);
    await commitAlways(store);
    await expect(
      store.commitRpc({
        tenantId: 'tenant-a',
        token: stale.token,
        expectedGeneration: stale.generation,
        liteMode: 'off',
        humanVerificationRequired: NONE,
      })
    ).resolves.toEqual({ committed: false, reason: 'lease_lost' });
    expect((await store.getSnapshotRpc('tenant-a')).liteMode).toBe('always');
  });

  it('refuses a commit for a generation the lease did not see', async () => {
    const { store } = createStore();
    const lease = await store.acquireLeaseRpc('tenant-a');
    if (!lease.acquired) throw new Error('lease not acquired');
    await expect(
      store.commitRpc({
        tenantId: 'tenant-a',
        token: lease.token,
        expectedGeneration: lease.generation + 1,
        liteMode: 'always',
        humanVerificationRequired: NONE,
      })
    ).resolves.toEqual({ committed: false, reason: 'generation_mismatch' });
  });

  it('releases only its own lease', async () => {
    const { store } = createStore();
    const lease = await store.acquireLeaseRpc('tenant-a');
    if (!lease.acquired) throw new Error('lease not acquired');
    await expect(store.releaseRpc('tenant-a', 'someone-else')).resolves.toEqual({
      released: false,
    });
    await expect(store.releaseRpc('tenant-a', lease.token)).resolves.toEqual({ released: true });
    expect((await store.acquireLeaseRpc('tenant-a')).acquired).toBe(true);
  });

  it('serves one tenant per instance', async () => {
    const { store } = createStore();
    await commitAlways(store);
    await expect(store.getSnapshotRpc('tenant-b')).rejects.toThrow('lite_policy_tenant_mismatch');
    await expect(store.acquireLeaseRpc('tenant-b')).rejects.toThrow('lite_policy_tenant_mismatch');
  });

  it('refuses an unknown mode', async () => {
    const { store } = createStore();
    const lease = await store.acquireLeaseRpc('tenant-a');
    if (!lease.acquired) throw new Error('lease not acquired');
    await expect(
      store.commitRpc({
        tenantId: 'tenant-a',
        token: lease.token,
        expectedGeneration: lease.generation,
        liteMode: 'auto' as never,
        humanVerificationRequired: NONE,
      })
    ).rejects.toThrow('lite_policy_invalid_mode');
  });
});

describe('LitePolicyStore keepLease', () => {
  it('publishes and keeps the lease at the new generation', async () => {
    vi.useFakeTimers();
    const { store } = createStore();
    const lease = await store.acquireLeaseRpc('tenant-a');
    if (!lease.acquired) throw new Error('lease not acquired');
    const first = await store.commitRpc({
      tenantId: 'tenant-a',
      token: lease.token,
      expectedGeneration: lease.generation,
      liteMode: 'always',
      humanVerificationRequired: { login: true, signup: true, reauth: false },
      keepLease: true,
    });
    expect(first).toMatchObject({ committed: true, snapshot: { generation: 1 } });
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(true);
    expect((await store.acquireLeaseRpc('tenant-a')).acquired).toBe(false);
    const second = await store.commitRpc({
      tenantId: 'tenant-a',
      token: lease.token,
      expectedGeneration: 1,
      liteMode: 'always',
      humanVerificationRequired: { login: false, signup: true, reauth: false },
    });
    expect(second).toMatchObject({ committed: true, snapshot: { generation: 2 } });
    expect((await store.getStatusRpc('tenant-a')).changeInProgress).toBe(false);
    vi.useRealTimers();
  });
});
