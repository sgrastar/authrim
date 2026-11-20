import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareDurableObjectEventStore,
  CloudflareDurableObjectScheduler,
  CloudflareDurableObjectSessionStore,
} from '../platform/cloudflare/durable-object-stores';

/** Minimal sorted-key DurableObjectStorage double covering the calls the stores use. */
function fakeStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    data,
    get: vi.fn((key: string) => Promise.resolve(data.get(key))),
    put: vi.fn((keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') data.set(keyOrEntries, value);
      else for (const [key, entry] of Object.entries(keyOrEntries)) data.set(key, entry);
      return Promise.resolve();
    }),
    delete: vi.fn((keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      return Promise.resolve(true);
    }),
    list: vi.fn(({ prefix }: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...data.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
        )
      )
    ),
    setAlarm: vi.fn(() => Promise.resolve()),
    deleteAlarm: vi.fn(() => Promise.resolve()),
  };
  return storage;
}

const asStorage = (storage: ReturnType<typeof fakeStorage>) =>
  storage as unknown as DurableObjectStorage;

const session = (id: string, lastActiveAt = 1) =>
  ({ id, lastActiveAt, createdAt: 1 }) as never as { id: string; lastActiveAt: number };

const event = (id: string, sessionId: string, createdAt: number) =>
  ({ id, sessionId, createdAt, type: 'message' }) as never as {
    id: string;
    sessionId: string;
    createdAt: number;
  };

describe('CloudflareDurableObjectSessionStore', () => {
  it('stores sessions under a namespaced key and reads them back', async () => {
    const storage = fakeStorage();
    const store = new CloudflareDurableObjectSessionStore(asStorage(storage));
    await store.put(session('s-1') as never);
    expect([...storage.data.keys()]).toEqual(['agent-access:session:s-1']);
    await expect(store.get('s-1')).resolves.toMatchObject({ id: 's-1' });
    expect(storage.get).toHaveBeenCalledWith('agent-access:session:s-1');
    await expect(store.get('missing')).resolves.toBeNull();
  });

  it('touch updates lastActiveAt only for an existing session', async () => {
    const storage = fakeStorage();
    const store = new CloudflareDurableObjectSessionStore(asStorage(storage));
    await expect(store.touch('s-1', 50)).resolves.toBe(false);
    expect(storage.put).not.toHaveBeenCalled();
    await store.put(session('s-1', 1) as never);
    await expect(store.touch('s-1', 50)).resolves.toBe(true);
    expect(storage.data.get('agent-access:session:s-1')).toEqual({
      id: 's-1',
      lastActiveAt: 50,
      createdAt: 1,
    });
  });

  it('delete removes the namespaced key', async () => {
    const storage = fakeStorage();
    const store = new CloudflareDurableObjectSessionStore(asStorage(storage));
    await store.put(session('s-1') as never);
    await store.delete('s-1');
    expect(storage.delete).toHaveBeenCalledWith('agent-access:session:s-1');
    expect(storage.data.size).toBe(0);
  });
});

describe('CloudflareDurableObjectEventStore', () => {
  it('appends the event and its index entry with a zero-padded ordering key', async () => {
    const storage = fakeStorage();
    const store = new CloudflareDurableObjectEventStore(asStorage(storage));
    const first = event('e-1', 's-1', 42);
    await store.append(first as never);
    expect(Object.fromEntries(storage.data)).toEqual({
      'agent-access:event:s-1:0000000000000042:e-1': first,
      'agent-access:event-index:s-1:e-1': 'agent-access:event:s-1:0000000000000042:e-1',
    });
  });

  it('lists a session in createdAt order and resumes after a known event id', async () => {
    const storage = fakeStorage();
    const store = new CloudflareDurableObjectEventStore(asStorage(storage));
    const a = event('e-a', 's-1', 9);
    const b = event('e-b', 's-1', 10);
    const c = event('e-c', 's-1', 100);
    for (const item of [c, a, b, event('e-x', 's-10', 1), event('e-y', 's-2', 1)]) {
      await store.append(item as never);
    }
    await expect(store.listAfter('s-1', undefined)).resolves.toEqual([a, b, c]);
    expect(storage.list).toHaveBeenCalledWith({ prefix: 'agent-access:event:s-1:' });
    await expect(store.listAfter('s-1', '')).resolves.toEqual([a, b, c]);
    await expect(store.listAfter('s-1', 'e-a')).resolves.toEqual([b, c]);
    await expect(store.listAfter('s-1', 'e-c')).resolves.toEqual([]);
    await expect(store.listAfter('s-1', 'unknown')).resolves.toEqual([]);
  });

  it('purgeSession deletes only that session events and indexes', async () => {
    const storage = fakeStorage();
    const store = new CloudflareDurableObjectEventStore(asStorage(storage));
    await store.append(event('e-1', 's-1', 1) as never);
    await store.append(event('e-2', 's-1', 2) as never);
    await store.append(event('e-3', 's-2', 3) as never);
    await store.purgeSession('s-1');
    expect(storage.list).toHaveBeenCalledWith({ prefix: 'agent-access:event-index:s-1:' });
    expect([...storage.data.keys()].sort()).toEqual([
      'agent-access:event-index:s-2:e-3',
      'agent-access:event:s-2:0000000000000003:e-3',
    ]);
    expect(storage.delete).toHaveBeenCalledWith([
      'agent-access:event:s-1:0000000000000001:e-1',
      'agent-access:event:s-1:0000000000000002:e-2',
      'agent-access:event-index:s-1:e-1',
      'agent-access:event-index:s-1:e-2',
    ]);
  });
});

describe('CloudflareDurableObjectScheduler', () => {
  const job = (id: string, runAt: number) =>
    ({ id, runAt, kind: 'test' }) as never as {
      id: string;
      runAt: number;
    };

  it('schedule persists the job and arms the earliest alarm', async () => {
    const storage = fakeStorage();
    const scheduler = new CloudflareDurableObjectScheduler(asStorage(storage));
    await scheduler.schedule(job('j-late', 500) as never);
    expect(storage.data.get('agent-access:job:j-late')).toMatchObject({ runAt: 500 });
    expect(storage.setAlarm).toHaveBeenLastCalledWith(500);
    await scheduler.schedule(job('j-early', 100) as never);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(100);
    expect(storage.list).toHaveBeenCalledWith({ prefix: 'agent-access:job:' });
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
  });

  it('cancel removes the job and clears the alarm when none remain', async () => {
    const storage = fakeStorage();
    const scheduler = new CloudflareDurableObjectScheduler(asStorage(storage));
    await scheduler.schedule(job('j-1', 100) as never);
    await scheduler.schedule(job('j-2', 300) as never);
    await scheduler.cancel('j-1');
    expect(storage.delete).toHaveBeenCalledWith('agent-access:job:j-1');
    expect(storage.setAlarm).toHaveBeenLastCalledWith(300);
    await scheduler.cancel('j-2');
    expect(storage.deleteAlarm).toHaveBeenCalledTimes(1);
    expect(storage.data.size).toBe(0);
  });

  it('takeDueJobs returns and removes jobs due at or before now, then re-arms', async () => {
    const storage = fakeStorage();
    const scheduler = new CloudflareDurableObjectScheduler(asStorage(storage));
    await scheduler.schedule(job('j-a', 100) as never);
    await scheduler.schedule(job('j-b', 200) as never);
    await scheduler.schedule(job('j-c', 300) as never);
    storage.delete.mockClear();

    await expect(scheduler.takeDueJobs(50)).resolves.toEqual([]);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.setAlarm).toHaveBeenLastCalledWith(100);

    const due = await scheduler.takeDueJobs(200);
    expect(due.map((item) => item.id)).toEqual(['j-a', 'j-b']);
    expect(storage.delete).toHaveBeenCalledWith(['agent-access:job:j-a', 'agent-access:job:j-b']);
    expect([...storage.data.keys()]).toEqual(['agent-access:job:j-c']);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(300);

    await expect(scheduler.takeDueJobs(1_000)).resolves.toMatchObject([{ id: 'j-c' }]);
    expect(storage.deleteAlarm).toHaveBeenCalledTimes(1);
  });
});
