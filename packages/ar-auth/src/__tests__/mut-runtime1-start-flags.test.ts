/**
 * Whether the runtime runs for a tenant (the feature flag, its settings keys and its cache), and the
 * Server-Timing a start reports when timing is turned on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
} from '../login-runtime-flow';
import { createContext, mocks, readJson, resetHarness } from './helpers/mut-runtime1-harness';

vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal())
);
vi.mock('@authrim/ar-lib-core/services/log-iceberg-emitter', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).icebergMock(await importOriginal())
);
vi.mock('../direct-auth', async (importOriginal) =>
  (await import('./helpers/mut-runtime1-harness')).directAuthMock(await importOriginal())
);

/** A SETTINGS namespace holding the tenant's feature flags (read again on every get). */
function flagSettings(read: () => Record<string, unknown> | null) {
  return {
    get: vi.fn(async (key: string) => {
      if (key !== 'settings:tenant:tenant_test:feature-flags') return null;
      const flags = read();
      return flags ? JSON.stringify(flags) : null;
    }),
  };
}

/** Starts with a target that is refused (400) once the flag lets the start run: 403 if it does not. */
async function startStatus(env: Record<string, unknown>, headers: Record<string, string> = {}) {
  const c = createContext({ body: { target_type: 'device' }, env, headers });
  const response = await loginRuntimeInteractionStartHandler(c);
  return { status: response.status, data: await readJson(response), c };
}

beforeEach(() => {
  resetHarness();
  clearLoginRuntimeFlowVersionCacheForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the feature flag of the runtime', () => {
  it('is off without the environment flag or a setting', async () => {
    const { status, data } = await startStatus({ ENABLE_LOGIN_RUNTIME_FLOW: 'false' });
    expect(status).toBe(403);
    expect(data).toMatchObject({
      error: 'flow_runtime_disabled',
      error_description: 'LoginUI runtime Flow is disabled',
    });
    expect(mocks.getFeatureFlag).toHaveBeenCalledWith(
      'ENABLE_LOGIN_RUNTIME_FLOW',
      expect.anything(),
      false
    );
  });

  it.each([
    'feature.enable_login_runtime_flow',
    'feature.login_runtime_flow.enabled',
    'feature.flow_runtime.enabled',
  ])('is turned on by the tenant setting %s over the environment', async (key) => {
    const settings = flagSettings(() => ({ [key]: true }));
    const { status } = await startStatus({
      ENABLE_LOGIN_RUNTIME_FLOW: 'false',
      SETTINGS: settings,
    });
    expect(status).toBe(400);
    expect(mocks.getFeatureFlag).not.toHaveBeenCalled();
  });

  it('is turned off by an explicit false setting even when the environment turns it on', async () => {
    const settings = flagSettings(() => ({ 'feature.flow_runtime.enabled': 'false' }));
    const { status } = await startStatus({ ENABLE_LOGIN_RUNTIME_FLOW: 'true', SETTINGS: settings });
    expect(status).toBe(403);
    expect(mocks.getFeatureFlag).not.toHaveBeenCalled();
  });

  it('lets one true key win over another false one', async () => {
    const settings = flagSettings(() => ({
      'feature.enable_login_runtime_flow': false,
      'feature.flow_runtime.enabled': true,
    }));
    expect(
      (await startStatus({ ENABLE_LOGIN_RUNTIME_FLOW: 'false', SETTINGS: settings })).status
    ).toBe(400);
  });

  it('falls back to the environment when the settings set none of its keys', async () => {
    const settings = flagSettings(() => ({ 'feature.other': true }));
    expect(
      (await startStatus({ ENABLE_LOGIN_RUNTIME_FLOW: 'true', SETTINGS: settings })).status
    ).toBe(400);
    expect(mocks.getFeatureFlag).toHaveBeenCalledTimes(1);
  });
});

describe('the cache of the feature flag', () => {
  /** Turns the flag on, then off in the settings, and reads it again `afterMs` later. */
  async function readAgainAfter(afterMs: number, env: Record<string, unknown> = {}) {
    clearLoginRuntimeFlowVersionCacheForTests();
    let flags: Record<string, unknown> = { 'feature.flow_runtime.enabled': true };
    const settings = flagSettings(() => flags);
    const base = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const fullEnv = { ENABLE_LOGIN_RUNTIME_FLOW: 'false', SETTINGS: settings, ...env };
    expect((await startStatus(fullEnv)).status).toBe(400);
    flags = { 'feature.flow_runtime.enabled': false };
    clock.mockReturnValue(base + afterMs);
    const { status } = await startStatus(fullEnv);
    clock.mockRestore();
    return { cached: status === 400, settingsReads: settings.get.mock.calls.length };
  }

  it('keeps the flag for the default three minutes', async () => {
    expect((await readAgainAfter(179_000)).cached).toBe(true);
    expect((await readAgainAfter(181_000)).cached).toBe(false);
  });

  it('keeps it for the configured time in seconds', async () => {
    expect((await readAgainAfter(29_000, { FEATURE_FLAGS_CACHE_TTL: '30' })).cached).toBe(true);
    expect((await readAgainAfter(31_000, { FEATURE_FLAGS_CACHE_TTL: '30' })).cached).toBe(false);
    expect((await readAgainAfter(31_000, { CONFIG_CACHE_TTL: '30' })).cached).toBe(false);
    expect((await readAgainAfter(29_000, { CONFIG_CACHE_TTL: '30' })).cached).toBe(true);
  });

  it('keeps it at least ten seconds and at most ten minutes', async () => {
    expect((await readAgainAfter(9_000, { FEATURE_FLAGS_CACHE_TTL: '1' })).cached).toBe(true);
    expect((await readAgainAfter(11_000, { FEATURE_FLAGS_CACHE_TTL: '1' })).cached).toBe(false);
    expect((await readAgainAfter(599_000, { FEATURE_FLAGS_CACHE_TTL: '9999' })).cached).toBe(true);
    expect((await readAgainAfter(601_000, { FEATURE_FLAGS_CACHE_TTL: '9999' })).cached).toBe(false);
  });

  it('keeps the default for a time that is zero, negative or not a number', async () => {
    for (const ttl of ['0', '-5', 'soon']) {
      expect((await readAgainAfter(179_000, { FEATURE_FLAGS_CACHE_TTL: ttl })).cached).toBe(true);
      expect((await readAgainAfter(181_000, { FEATURE_FLAGS_CACHE_TTL: ttl })).cached).toBe(false);
    }
  });

  it('keeps the flag of one environment apart from another', async () => {
    let flags: Record<string, unknown> = { 'feature.flow_runtime.enabled': true };
    const settings = flagSettings(() => flags);
    const env = { ENABLE_LOGIN_RUNTIME_FLOW: 'false', SETTINGS: settings };
    expect((await startStatus({ ...env, ENVIRONMENT: 'staging' })).status).toBe(400);
    flags = { 'feature.flow_runtime.enabled': false };
    expect((await startStatus({ ...env, ENVIRONMENT: 'staging' })).status).toBe(400);
    expect((await startStatus({ ...env, ENVIRONMENT: 'production' })).status).toBe(403);
  });
});

describe('the timing a start reports', () => {
  /** A clock that moves 3 ms each time it is read. */
  function tickingClock() {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 3));
  }

  function serverTiming(c: { header: ReturnType<typeof vi.fn> }): string | undefined {
    return c.header.mock.calls.find(([name]) => name === 'Server-Timing')?.[1] as
      | string
      | undefined;
  }

  function spans(header: string): Array<[string, number]> {
    return header.split(', ').map((part) => {
      const match = /^([a-z_]+);dur=(\d+\.\d)$/.exec(part);
      if (!match) throw new Error(`not a span: ${part}`);
      return [match[1], Number(match[2])];
    });
  }

  it.each(['true', ' TRUE ', '1', 'yes'])(
    'reports each step it timed when AUTHRIM_FLOW_RUNTIME_TIMING is %j',
    async (value) => {
      tickingClock();
      const { c } = await startStatus({ AUTHRIM_FLOW_RUNTIME_TIMING: value });
      const timed = spans(serverTiming(c) ?? '');
      expect(timed.map(([name]) => name)).toEqual([
        'feature_flag',
        'parse_body',
        'auth_context',
        'resolve_target',
        'total',
      ]);
      for (const [, durationMs] of timed) {
        expect(Number.isInteger(durationMs)).toBe(true);
        expect(durationMs).toBeGreaterThanOrEqual(0);
        expect(durationMs).toBeLessThan(1000);
      }
      const total = timed[timed.length - 1][1];
      expect(total).toBeGreaterThan(0);
      expect(total).toBeGreaterThanOrEqual(
        timed.slice(0, -1).reduce((sum, [, durationMs]) => sum + durationMs, 0)
      );
      expect(c.header).not.toHaveBeenCalledWith(
        'X-Authrim-Diagnostic-Session-Id',
        expect.anything()
      );
    }
  );

  it('reports a start the flag stops too', async () => {
    tickingClock();
    const { c } = await startStatus({
      ENABLE_LOGIN_RUNTIME_FLOW: 'false',
      AUTHRIM_FLOW_RUNTIME_TIMING: 'true',
    });
    expect(spans(serverTiming(c) ?? '').map(([name]) => name)).toEqual(['feature_flag', 'total']);
  });

  it.each([
    ['not set', {}],
    ['off', { AUTHRIM_FLOW_RUNTIME_TIMING: 'no' }],
    ['diagnostic timing alone, without a session', { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true' }],
  ])('reports nothing when timing is %s', async (_label, env) => {
    const { c } = await startStatus(env);
    expect(c.header).not.toHaveBeenCalled();
  });

  it('reports nothing for a diagnostic session while diagnostic timing is off', async () => {
    const { c } = await startStatus({}, { 'X-Diagnostic-Session-Id': 'session-1' });
    expect(c.header).not.toHaveBeenCalled();
  });

  it.each(['true', '1', ' Yes '])(
    'reports a diagnostic session (diagnostic timing %j), its id made safe',
    async (value) => {
      const { c } = await startStatus(
        { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: value },
        { 'X-Diagnostic-Session-Id': ' run 1/ab:c.d-e ' }
      );
      expect(serverTiming(c)).toMatch(/^feature_flag;dur=/);
      expect(c.header).toHaveBeenCalledWith('X-Authrim-Diagnostic-Session-Id', 'run_1_ab:c.d-e');
    }
  );

  it('cuts a long diagnostic session id, and ignores a blank one', async () => {
    const long = await startStatus(
      { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true' },
      { 'X-Diagnostic-Session-Id': 'a'.repeat(200) }
    );
    expect(long.c.header).toHaveBeenCalledWith('X-Authrim-Diagnostic-Session-Id', 'a'.repeat(128));

    const blank = await startStatus(
      { AUTHRIM_DIAGNOSTIC_TIMING_ENABLED: 'true' },
      { 'X-Diagnostic-Session-Id': '   ' }
    );
    expect(blank.c.header).not.toHaveBeenCalled();
  });
});
