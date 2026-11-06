import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LITE_NEVER_LITE_TTL_MS,
  LITE_POLICY_SNAPSHOT_TTL_MS,
  initialLitePolicySnapshot,
  liteEverKvKey,
  readCurrentLitePolicySnapshot,
  readLiteModeAuthoritative,
  readLiteModeState,
  readLiteRuntimeState,
  resetLitePolicyRuntimeCache,
} from '../lite-policy';
import type { LitePolicySnapshot } from '../../types/login-ui-lite';

/** A LITE_POLICY_STORE namespace whose policy and marker instances count their calls. */
function storeNamespace(state: { everLite: boolean; mode: 'off' | 'always' }) {
  const calls = { snapshot: 0, marker: 0 };
  const failures = { snapshot: false, marker: false };
  const snapshot = (tenantId: string): LitePolicySnapshot => ({
    ...initialLitePolicySnapshot(tenantId),
    liteMode: state.mode,
    policyRevision: 'rev-1',
  });
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) =>
      name.startsWith('lite-policy-marker:')
        ? {
            isEverLiteRpc: async () => {
              calls.marker += 1;
              if (failures.marker) throw new Error('marker down');
              return state.everLite;
            },
          }
        : {
            getSnapshotRpc: async (tenantId: string) => {
              calls.snapshot += 1;
              if (failures.snapshot) throw new Error('policy down');
              return snapshot(tenantId);
            },
          },
  };
  return { namespace, calls, failures };
}

function kv(records: Record<string, string> = {}) {
  return { get: vi.fn(async (key: string) => records[key] ?? null) };
}

function envOf(namespace: unknown, settings: unknown = kv()) {
  return { LITE_POLICY_STORE: namespace, SETTINGS: settings } as never;
}

beforeEach(() => {
  resetLitePolicyRuntimeCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('readLiteRuntimeState: the cost on a tenant that never used lite mode', () => {
  it('reads only the marker, once per never-lite TTL, and never the policy instance', async () => {
    const { namespace, calls } = storeNamespace({ everLite: false, mode: 'off' });
    const env = envOf(namespace);
    // A sign-in request reads it in the handler and again in the human verification runner.
    for (let i = 0; i < 20; i++) expect(await readLiteModeState(env, 't1')).toBe('off');
    expect(calls).toEqual({ snapshot: 0, marker: 1 });

    vi.advanceTimersByTime(LITE_NEVER_LITE_TTL_MS - 1);
    await readLiteModeState(env, 't1');
    expect(calls.marker).toBe(1);
    vi.advanceTimersByTime(1);
    await readLiteModeState(env, 't1');
    expect(calls).toEqual({ snapshot: 0, marker: 2 });
  });

  it('never shares a pending read between requests, only answers', async () => {
    const { namespace, calls } = storeNamespace({ everLite: false, mode: 'off' });
    const env = envOf(namespace);
    // Before the first answer each request reads for itself (a request that is cancelled could
    // leave a shared read unsettled); after it, the answer is shared.
    const answers = await Promise.all(
      Array.from({ length: 3 }, () => readLiteModeState(env, 't1'))
    );
    expect(new Set(answers)).toEqual(new Set(['off']));
    expect(calls.marker).toBe(3);
    await readLiteModeState(env, 't1');
    expect(calls.marker).toBe(3);
  });

  it('keeps answering off through an outage of the whole policy store namespace', async () => {
    const { namespace, calls, failures } = storeNamespace({ everLite: false, mode: 'off' });
    const settings = kv();
    const env = envOf(namespace, settings);
    failures.marker = true;
    failures.snapshot = true;
    // Nothing remembered: no KV record of the tenant ever being lite.
    expect(await readLiteModeState(env, 't1')).toBe('off');
    expect(settings.get).toHaveBeenCalledWith(liteEverKvKey('t1'));
    expect(calls.snapshot).toBe(1);
  });

  it('never answers off from a stale "never lite" once it has expired', async () => {
    const { namespace, failures } = storeNamespace({ everLite: false, mode: 'off' });
    const env = envOf(namespace, kv({ [liteEverKvKey('t1')]: '1' }));
    expect(await readLiteModeState(env, 't1')).toBe('off');
    failures.marker = true;
    failures.snapshot = true;
    vi.advanceTimersByTime(LITE_NEVER_LITE_TTL_MS);
    // The KV record says the tenant was switched on since: the outage path decides, not the cache.
    expect(await readLiteModeState(env, 't1')).toBe('unknown');
  });
});

describe('readLiteRuntimeState: a tenant that was switched on', () => {
  it('remembers the marker and caches the snapshot for the snapshot TTL', async () => {
    const state = { everLite: true, mode: 'always' as 'off' | 'always' };
    const { namespace, calls } = storeNamespace(state);
    const env = envOf(namespace);
    const first = await readLiteRuntimeState(env, 't1');
    expect(first).toMatchObject({ liteMode: 'always', policyRevision: 'rev-1' });
    for (let i = 0; i < 10; i++) await readLiteRuntimeState(env, 't1');
    expect(calls).toEqual({ snapshot: 1, marker: 1 });

    state.mode = 'off';
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS);
    expect(await readLiteRuntimeState(env, 't1')).toBe('off');
    vi.advanceTimersByTime(LITE_NEVER_LITE_TTL_MS * 10);
    await readLiteRuntimeState(env, 't1');
    // The marker is never cleared: it is not read again.
    expect(calls.marker).toBe(1);
  });

  it('never answers from an older snapshot when the policy cannot be read', async () => {
    const state = { everLite: true, mode: 'always' as 'off' | 'always' };
    const { namespace, failures } = storeNamespace(state);
    const env = envOf(namespace);
    // An older `always` can carry older human verification requirements; an older `off` can
    // predate a switch on. Either way the tenant is ever lite, so it is unknown.
    expect(await readLiteModeState(env, 't1')).toBe('always');
    failures.snapshot = true;
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS);
    expect(await readLiteModeState(env, 't1')).toBe('unknown');
    resetLitePolicyRuntimeCache();
    failures.snapshot = false;
    state.mode = 'off';
    expect(await readLiteModeState(env, 't1')).toBe('off');
    failures.snapshot = true;
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS);
    expect(await readLiteModeState(env, 't1')).toBe('unknown');
  });

  it('lets a snapshot read as always override a cached "never lite"', async () => {
    const state = { everLite: false, mode: 'off' as 'off' | 'always' };
    const { namespace, calls, failures } = storeNamespace(state);
    const env = envOf(namespace);
    // The marker cannot be read, so the policy is read: `always` (the switch just happened).
    failures.marker = true;
    state.everLite = true;
    state.mode = 'always';
    expect(await readLiteModeState(env, 't1')).toBe('always');
    // From then on the tenant is ever lite in this isolate, whatever the marker read later.
    failures.marker = false;
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS);
    expect(await readLiteModeState(env, 't1')).toBe('always');
    expect(calls.marker).toBe(1);
  });

  it('is unknown when its policy cannot be read and nothing recent is remembered', async () => {
    const { namespace, failures } = storeNamespace({ everLite: true, mode: 'always' });
    const env = envOf(namespace);
    failures.snapshot = true;
    expect(await readLiteModeState(env, 't1')).toBe('unknown');
  });

  it('is unknown in a namespace outage when the KV record says it was switched on, or KV fails', async () => {
    const { namespace, failures } = storeNamespace({ everLite: true, mode: 'always' });
    failures.marker = true;
    failures.snapshot = true;
    expect(
      await readLiteModeState(envOf(namespace, kv({ [liteEverKvKey('t1')]: '1' })), 't1')
    ).toBe('unknown');
    resetLitePolicyRuntimeCache();
    const failing = { get: async () => Promise.reject(new Error('kv down')) };
    expect(await readLiteModeState(envOf(namespace, failing), 't1')).toBe('unknown');
    resetLitePolicyRuntimeCache();
    expect(await readLiteModeState({ LITE_POLICY_STORE: namespace } as never, 't1')).toBe(
      'unknown'
    );
  });

  it('never forgets a tenant seen as ever lite, however many others it reads', async () => {
    const lite = storeNamespace({ everLite: true, mode: 'always' });
    const env = envOf(lite.namespace);
    expect(await readLiteModeState(env, 'lite-tenant')).toBe('always');
    // The marker reads of many other tenants fill and evict the bounded entries.
    lite.failures.snapshot = false;
    for (let i = 0; i < 1_100; i++) await readLiteModeState(env, `other-${i}`);
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS);
    // Then the whole namespace is down and KV has no record yet: still not `off`.
    lite.failures.marker = true;
    lite.failures.snapshot = true;
    expect(await readLiteModeState(env, 'lite-tenant')).toBe('unknown');
  });

  it('reaches an isolate that saw the tenant as ever lite within the snapshot TTL', async () => {
    const state = { everLite: true, mode: 'always' as 'off' | 'always' };
    const { namespace } = storeNamespace(state);
    const env = envOf(namespace);
    expect(await readLiteModeState(env, 't1')).toBe('always');
    state.mode = 'off';
    expect(await readLiteModeState(env, 't1')).toBe('always');
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS);
    expect(await readLiteModeState(env, 't1')).toBe('off');
    state.mode = 'always';
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS);
    expect(await readLiteModeState(env, 't1')).toBe('always');
  });

  it('keeps tenants and namespaces apart', async () => {
    const lite = storeNamespace({ everLite: true, mode: 'always' });
    const normal = storeNamespace({ everLite: false, mode: 'off' });
    expect(await readLiteModeState(envOf(lite.namespace), 't1')).toBe('always');
    expect(await readLiteModeState(envOf(normal.namespace), 't1')).toBe('off');
    expect(await readLiteModeState(envOf(lite.namespace), 't2')).toBe('always');
    expect(lite.calls.marker).toBe(2);
  });
});

it('answers off without a policy store binding', async () => {
  expect(await readLiteRuntimeState({}, 't1')).toBe('off');
});

describe('readLiteModeAuthoritative (an answer that is kept)', () => {
  it('reads the store every time: one marker read for a tenant never lite', async () => {
    const { namespace, calls } = storeNamespace({ everLite: false, mode: 'off' });
    const env = envOf(namespace);
    expect(await readLiteModeAuthoritative(env, 't1')).toBe('off');
    expect(await readLiteModeAuthoritative(env, 't1')).toBe('off');
    expect(calls).toEqual({ snapshot: 0, marker: 2 });
  });

  it('reads the policy of an ever-lite tenant, and throws when it cannot', async () => {
    const state = { everLite: true, mode: 'always' as 'off' | 'always' };
    const { namespace, calls, failures } = storeNamespace(state);
    const env = envOf(namespace);
    expect(await readLiteModeAuthoritative(env, 't1')).toBe('always');
    state.mode = 'off';
    // No runtime cache in between: the switch is seen at once.
    expect(await readLiteModeAuthoritative(env, 't1')).toBe('off');
    expect(calls.snapshot).toBe(2);
    failures.snapshot = true;
    await expect(readLiteModeAuthoritative(env, 't1')).rejects.toThrow('lite_policy_unavailable');
  });
});

/** Lets pending promise callbacks run (the timers are fake). */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('answers that arrive out of order', () => {
  it('never keeps an older snapshot over a newer one, nor extends its TTL', async () => {
    resetLitePolicyRuntimeCache();
    const replies: Array<(snapshot: LitePolicySnapshot) => void> = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: (name: string) =>
        name.startsWith('lite-policy-marker:')
          ? { isEverLiteRpc: async () => true }
          : {
              getSnapshotRpc: () =>
                new Promise<LitePolicySnapshot>((resolve) => {
                  replies.push(resolve);
                }),
            },
    };
    const env = envOf(namespace);
    const at = (generation: number, liteMode: 'off' | 'always'): LitePolicySnapshot => ({
      ...initialLitePolicySnapshot('t1'),
      liteMode,
      generation,
      policyRevision: `rev-${generation}`,
    });
    // Read A starts (it will answer generation 2, `off`), then read B (generation 3, `always`).
    const a = readCurrentLitePolicySnapshot(env, 't1');
    const b = readCurrentLitePolicySnapshot(env, 't1');
    await flush();
    expect(replies).toHaveLength(2);
    replies[1]?.(at(3, 'always'));
    expect((await b).generation).toBe(3);
    vi.advanceTimersByTime(LITE_POLICY_SNAPSHOT_TTL_MS - 1);
    // A arrives late with the older commit: B's newer snapshot stays, and A answers it.
    replies[0]?.(at(2, 'off'));
    expect((await a).generation).toBe(3);
    expect(await readLiteModeState(env, 't1')).toBe('always');
    // The TTL still counts from B's start: one more millisecond and the policy is read again.
    vi.advanceTimersByTime(1);
    const next = readLiteModeState(env, 't1');
    await flush();
    expect(replies).toHaveLength(3);
    replies[2]?.(at(4, 'off'));
    expect(await next).toBe('off');
  });
});

describe('races between requests', () => {
  /** A namespace whose answers for t1 are released by hand; other tenants answer at once. */
  function manualNamespace() {
    const snapshotReplies: Array<(snapshot: LitePolicySnapshot) => void> = [];
    const markerReplies: Array<(everLite: boolean) => void> = [];
    const namespace = {
      idFromName: (name: string) => name,
      get: (name: string) => {
        const tenantId = name.slice(name.indexOf(':') + 1);
        if (name.startsWith('lite-policy-marker:')) {
          return {
            isEverLiteRpc: () =>
              tenantId === 't1'
                ? new Promise<boolean>((resolve) => markerReplies.push(resolve))
                : Promise.resolve(true),
          };
        }
        return {
          getSnapshotRpc: () =>
            tenantId === 't1'
              ? new Promise<LitePolicySnapshot>((resolve) => snapshotReplies.push(resolve))
              : Promise.resolve({
                  ...initialLitePolicySnapshot(tenantId),
                  liteMode: 'always' as const,
                  generation: 1,
                }),
        };
      },
    };
    return { namespace, snapshotReplies, markerReplies };
  }
  const at = (
    generation: number,
    liteMode: 'off' | 'always',
    login = false
  ): LitePolicySnapshot => ({
    ...initialLitePolicySnapshot('t1'),
    liteMode,
    generation,
    humanVerificationRequired: { login, signup: false, reauth: false },
  });

  it('never answers an earlier commit, even after the newer snapshot was evicted', async () => {
    const { namespace, snapshotReplies } = manualNamespace();
    const env = envOf(namespace);
    const a = readCurrentLitePolicySnapshot(env, 't1');
    const b = readCurrentLitePolicySnapshot(env, 't1');
    await flush();
    snapshotReplies[1]?.(at(3, 'always', true));
    expect((await b).generation).toBe(3);
    // Many other lite tenants evict t1's snapshot from the bounded entries.
    for (let i = 0; i < 1_100; i++) await readCurrentLitePolicySnapshot(env, `other-${i}`);
    snapshotReplies[0]?.(at(2, 'always', false));
    await expect(a).rejects.toThrow('lite_policy_unavailable');
  });

  it('does not answer off from a KV miss when the tenant was seen as lite meanwhile', async () => {
    let snapshotCalls = 0;
    const namespace = {
      idFromName: (name: string) => name,
      get: (name: string) =>
        name.startsWith('lite-policy-marker:')
          ? { isEverLiteRpc: async () => Promise.reject(new Error('marker down')) }
          : {
              getSnapshotRpc: async () => {
                snapshotCalls += 1;
                if (snapshotCalls === 1) throw new Error('policy down');
                return at(1, 'always');
              },
            },
    };
    let kvReply: (value: string | null) => void = () => undefined;
    const settings = { get: () => new Promise<string | null>((resolve) => (kvReply = resolve)) };
    const env = envOf(namespace, settings);
    // A: neither object answers; it asks KV, which is slow and will say "no record".
    const a = readLiteModeState(env, 't1');
    await flush();
    // Meanwhile B reads the policy: `always`.
    expect((await readCurrentLitePolicySnapshot(env, 't1')).liteMode).toBe('always');
    kvReply(null);
    expect(await a).toBe('always');
  });

  it('does not answer off from a marker read that started before the tenant was seen as lite', async () => {
    const { namespace, snapshotReplies, markerReplies } = manualNamespace();
    const env = envOf(namespace);
    // A's marker read is slow and will say "never lite" (it started before the switch).
    const a = readLiteModeState(env, 't1');
    await flush();
    // Meanwhile B learns the tenant is lite.
    const b = readLiteModeState(env, 't1');
    await flush();
    markerReplies[1]?.(true);
    await flush();
    snapshotReplies[0]?.(at(1, 'always'));
    expect(await b).toBe('always');
    vi.advanceTimersByTime(LITE_NEVER_LITE_TTL_MS + 1);
    markerReplies[0]?.(false);
    // The snapshot B kept has expired too: A reads the policy instead of answering off.
    await flush();
    snapshotReplies[1]?.(at(1, 'always'));
    expect(await a).toBe('always');
  });
});
