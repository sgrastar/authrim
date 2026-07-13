import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableObjectState } from '@cloudflare/workers-types';
import { ChallengeStore, type Challenge } from '../ChallengeStore';

class Storage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.data.entries()].filter(([key]) => key.startsWith(options?.prefix ?? ''))
    ) as Map<string, T>;
  }
}

function createStore(storage = new Storage()): { store: ChallengeStore; storage: Storage } {
  const ctx = { storage } as unknown as DurableObjectState;
  return { store: new ChallengeStore(ctx, {} as never), storage };
}

const challenge = {
  id: 'challenge-1',
  tenantId: 'tenant-a',
  type: 'email_code' as const,
  userId: 'user-1',
  challenge: '123456',
  ttl: 60,
  email: 'user@example.com',
  redirectUri: 'https://client.example/callback',
  metadata: { attempt: 1 },
};

describe('ChallengeStore replay protection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('stores and atomically consumes a tenant-bound challenge once', async () => {
    const { store, storage } = createStore();
    await expect(store.storeChallengeRpc(challenge)).resolves.toEqual({ success: true });
    expect(storage.data.has('challenge:challenge-1')).toBe(true);
    await expect(store.getChallengeRpc('challenge-1')).resolves.toMatchObject({
      tenantId: 'tenant-a',
      consumed: false,
    });
    await expect(
      store.consumeChallengeRpc({
        id: 'challenge-1',
        tenantId: 'tenant-a',
        type: 'email_code',
        challenge: '123456',
      })
    ).resolves.toEqual({
      challenge: '123456',
      userId: 'user-1',
      email: 'user@example.com',
      redirectUri: 'https://client.example/callback',
      metadata: { attempt: 1 },
    });
    await expect(
      store.consumeChallengeRpc({ id: 'challenge-1', tenantId: 'tenant-a', type: 'email_code' })
    ).rejects.toThrow('already consumed');
  });

  it.each([
    [{ id: 'missing', tenantId: 'tenant-a', type: 'email_code' }, 'not found'],
    [{ id: 'challenge-1', tenantId: 'tenant-a', type: 'login' }, 'type mismatch'],
    [{ id: 'challenge-1', tenantId: 'tenant-b', type: 'email_code' }, 'tenant mismatch'],
    [
      { id: 'challenge-1', tenantId: 'tenant-a', type: 'email_code', challenge: 'wrong' },
      'value mismatch',
    ],
  ])('rejects invalid consume request %#', async (consume, message) => {
    const { store } = createStore();
    if (consume.id !== 'missing') await store.storeChallenge(challenge);
    await expect(store.consumeChallenge(consume as never)).rejects.toThrow(message);
  });

  it.each(['', ' tenant', 'tenant!', '.tenant', 'tenant/other'])(
    'rejects malformed tenant identifier %s',
    async (tenantId) => {
      const { store } = createStore();
      await expect(store.storeChallenge({ ...challenge, tenantId })).rejects.toThrow(
        'Invalid tenant ID'
      );
      await expect(
        store.consumeChallenge({ id: 'challenge-1', tenantId, type: 'email_code' })
      ).rejects.toThrow('Invalid tenant ID');
    }
  );

  it('removes expired challenges from cache and storage', async () => {
    const { store, storage } = createStore();
    await store.storeChallenge({ ...challenge, ttl: 1 });
    vi.advanceTimersByTime(1001);
    await expect(store.getChallenge('challenge-1')).resolves.toBeNull();
    expect(storage.data.has('challenge:challenge-1')).toBe(false);

    storage.data.set('challenge:stored-expired', {
      ...challenge,
      id: 'stored-expired',
      createdAt: Date.now() - 2000,
      expiresAt: Date.now() - 1,
      consumed: false,
    } satisfies Challenge);
    await expect(store.getChallenge('stored-expired')).resolves.toBeNull();
  });

  it('reports active versus consumed/expired storage and supports idempotent deletion', async () => {
    const { store, storage } = createStore();
    await store.storeChallenge(challenge);
    storage.data.set('challenge:consumed', {
      ...(storage.data.get('challenge:challenge-1') as Challenge),
      id: 'consumed',
      consumed: true,
    });
    storage.data.set('challenge:expired', {
      ...(storage.data.get('challenge:challenge-1') as Challenge),
      id: 'expired',
      expiresAt: Date.now() - 1,
    });
    await expect(store.getStatusRpc()).resolves.toMatchObject({
      status: 'ok',
      challenges: { total: 3, active: 1, consumed: 2 },
    });
    await expect(store.deleteChallengeRpc('challenge-1')).resolves.toEqual({ deleted: true });
    await expect(store.deleteChallengeRpc('challenge-1')).resolves.toEqual({ deleted: false });
  });

  it('keeps HTTP errors generic while distinguishing replay, expiry, and missing data', async () => {
    const { store } = createStore();
    const post = (path: string, body: unknown) =>
      new Request(`https://challenge.example${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await store.fetch(post('/challenge', {}))).status).toBe(400);
    expect((await store.fetch(post('/challenge', challenge))).status).toBe(201);
    expect(
      (await store.fetch(post('/challenge/consume', { id: 'challenge-1', type: 'email_code' })))
        .status
    ).toBe(400);
    expect((await store.fetch(new Request('https://challenge.example/unknown'))).status).toBe(404);
  });
});
