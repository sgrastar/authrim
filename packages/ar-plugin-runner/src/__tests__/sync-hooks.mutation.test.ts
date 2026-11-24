import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  capabilityFor,
  DynamicWorkerSyncHookBackend,
  validateSyncHookResult,
  type FlowHookInput,
  type HumanVerificationHookInput,
  type PolicyDecisionHookInput,
  type SyncHookGroup,
  type SyncHookTarget,
} from '../sync-hooks';
import {
  StaticInProcessSyncHookRegistry,
  SyncHookBackendRouter,
  type InProcessSyncHookHandler,
} from '../sync-hook-backend-router';
import { must, rejectOpaque } from './helpers/mock-kit';

const HV: HumanVerificationHookInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  requestId: 'request-a',
  action: 'login',
  responseToken: 'token',
};
const POLICY: PolicyDecisionHookInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  requestId: 'request-a',
  subjectId: 'subject-a',
  action: 'read',
  resourceType: 'doc',
  resourceId: 'doc-a',
  attributes: {},
};
const FLOW: FlowHookInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'installation-a',
  requestId: 'request-a',
  flowId: 'flow-a',
  hookName: 'before-login',
  stateVersion: 1,
};
const DYNAMIC_TARGET: SyncHookTarget = {
  backendKind: 'dynamic_worker',
  scriptName: 'plugin-a',
  timeoutMs: 800,
};
const OK = { decision: 'allow', reasonCode: 'verified' };

describe('capabilityFor', () => {
  it('names the capability of each group', () => {
    expect(capabilityFor('human-verification', HV)).toBe('human_verification.verify');
    expect(capabilityFor('policy-decision', POLICY)).toBe('policy.decision');
    expect(capabilityFor('flow-hook', FLOW)).toBe('flow.before-login');
  });
});

describe('validateSyncHookResult', () => {
  const INVALID = /^plugin_sync_response_invalid$/u;
  it.each([
    ['human-verification', 'allow'],
    ['human-verification', 'deny'],
    ['policy-decision', 'allow'],
    ['policy-decision', 'deny'],
    ['flow-hook', 'continue'],
    ['flow-hook', 'deny'],
  ] as const)('accepts %s decision %s', (group, decision) => {
    expect(validateSyncHookResult({ decision, reasonCode: 'ok' }, group)).toEqual({
      decision,
      reasonCode: 'ok',
    });
  });
  it.each([
    ['human-verification', 'continue'],
    ['policy-decision', 'continue'],
    ['flow-hook', 'allow'],
    ['flow-hook', 'ALLOW'],
    ['human-verification', ''],
  ] as const)('refuses %s decision %j', (group, decision) => {
    expect(() => validateSyncHookResult({ decision, reasonCode: 'ok' }, group)).toThrow(INVALID);
  });
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['an array', []],
    ['an extra key', { ...OK, extra: 1 }],
    ['a missing reason', { decision: 'allow' }],
    ['a numeric reason', { decision: 'allow', reasonCode: 1 }],
    ['an uppercase reason', { decision: 'allow', reasonCode: 'Ok' }],
    ['a reason starting with a digit', { decision: 'allow', reasonCode: '1ok' }],
    ['a reason with a space', { decision: 'allow', reasonCode: 'o k' }],
    ['a reason that is too long', { decision: 'allow', reasonCode: `a${'b'.repeat(128)}` }],
    ['a numeric decision', { decision: 1, reasonCode: 'ok' }],
  ])('refuses %s', (_label, value) => {
    expect(() => validateSyncHookResult(value, 'human-verification')).toThrow(INVALID);
  });
  it('accepts reason codes of one and 128 characters with punctuation', () => {
    expect(
      validateSyncHookResult({ decision: 'allow', reasonCode: 'a' }, 'policy-decision')
    ).toBeTruthy();
    expect(
      validateSyncHookResult(
        { decision: 'allow', reasonCode: `a${'b'.repeat(127)}` },
        'policy-decision'
      )
    ).toBeTruthy();
    expect(
      validateSyncHookResult({ decision: 'allow', reasonCode: 'a:b_c-d' }, 'policy-decision')
    ).toBeTruthy();
  });
});

function harness(
  over: {
    response?: Response | (() => Response | Promise<Response>);
    target?: unknown;
    code?: Record<string, unknown>;
    hostInterfaces?: boolean;
    gate?: boolean;
    loader?: boolean;
    resolveFailure?: unknown;
  } = {}
) {
  const fetchEntry = vi.fn(async (_url: string, _init: RequestInit) =>
    typeof over.response === 'function'
      ? over.response()
      : (over.response ?? Response.json(OK, { status: 200 }))
  );
  const get = vi.fn((_id: string, factory: () => Promise<unknown>) => ({
    getEntrypoint: () => ({
      fetch: async (url: string, init: RequestInit) => (await factory(), fetchEntry(url, init)),
    }),
  }));
  const installations = {
    resolve: vi.fn(async () => {
      if (over.resolveFailure !== undefined) throw over.resolveFailure as Error;
      return over.target === undefined
        ? {
            scriptName: 'plugin-a',
            codeSha256: 'c'.repeat(64),
            pluginId: 'plugin-a',
            hostInterfaces: [{ name: 'H' }],
            resources: [{ binding: 'R' }],
          }
        : over.target;
    }),
    isExternalGateOpen: vi.fn(async () => over.gate !== false),
  };
  const code = {
    resolve: vi.fn(async () => ({ mainModule: 'index.js', modules: {}, ...over.code })),
  };
  const outbound = vi.fn(() => 'outbound-fetcher');
  const hostInterfaces = vi.fn(() => ({ HOST: 'iface' }));
  const backend = new DynamicWorkerSyncHookBackend(
    over.loader === false ? undefined : ({ get } as never),
    installations as never,
    code as never,
    outbound as never,
    over.hostInterfaces === false ? undefined : hostInterfaces
  );
  return { backend, get, fetchEntry, installations, code, outbound, hostInterfaces };
}
const invoke = (
  h: ReturnType<typeof harness>,
  target: SyncHookTarget = DYNAMIC_TARGET,
  payload: HumanVerificationHookInput | FlowHookInput = HV,
  group: SyncHookGroup = 'human-verification'
) => h.backend.invoke({ group, target, payload });

describe('DynamicWorkerSyncHookBackend', () => {
  const REJECTED = /^plugin_sync_rejected$/u;
  const TRANSIENT = /^plugin_sync_transient_failure$/u;
  const TARGET_INVALID = /^plugin_sync_target_invalid$/u;

  it('posts the payload to the typed internal endpoint with a pinned, scoped worker', async () => {
    const h = harness();
    await expect(invoke(h)).resolves.toEqual(OK);
    const workerId = createHash('sha256')
      .update(
        JSON.stringify(['tenant-a', 'installation-a', 'human_verification.verify', 'c'.repeat(64)])
      )
      .digest('hex');
    expect(h.get).toHaveBeenCalledWith(workerId, expect.any(Function));
    const [url, init] = must(h.fetchEntry.mock.calls[0]);
    expect(url).toBe('https://authrim.invalid/internal/plugin-sync/human-verification');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Authrim-Plugin-Contract': 'human-verification-v1',
      },
      body: JSON.stringify(HV),
      redirect: 'manual',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(h.installations.resolve).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      capability: 'human_verification.verify',
    });
  });
  it('launches the worker with host interfaces and an egress binding scoped to the worker id', async () => {
    const h = harness();
    await invoke(h);
    const context = {
      contractVersion: 1,
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      capability: 'human_verification.verify',
      requestId: expect.stringMatching(/^scope:[0-9a-f]{64}$/u) as unknown,
    };
    expect(h.outbound).toHaveBeenCalledWith(context);
    expect(h.hostInterfaces).toHaveBeenCalledWith(
      context,
      [{ name: 'H' }],
      [{ binding: 'R' }],
      'plugin-a'
    );
  });
  it('gives a worker without host interfaces an empty environment', async () => {
    const h = harness({
      hostInterfaces: false,
      target: {
        scriptName: 'plugin-a',
        codeSha256: 'c'.repeat(64),
        pluginId: 'plugin-a',
        hostInterfaces: [],
        resources: [],
      },
    });
    await expect(invoke(h)).resolves.toEqual(OK);
    expect(h.hostInterfaces).not.toHaveBeenCalled();
  });
  it('refuses host interfaces or resources when no factory exists', async () => {
    await expect(invoke(harness({ hostInterfaces: false }))).rejects.toThrow(TRANSIENT);
    await expect(
      invoke(
        harness({
          hostInterfaces: false,
          target: {
            scriptName: 'plugin-a',
            codeSha256: 'c'.repeat(64),
            pluginId: 'p',
            hostInterfaces: [],
            resources: [{ binding: 'R' }],
          },
        })
      )
    ).rejects.toThrow(TRANSIENT);
  });
  it('fails closed without a worker loader', async () => {
    await expect(invoke(harness({ loader: false }))).rejects.toThrow(REJECTED);
  });
  it.each([
    ['an in-process target', { backendKind: 'in_process', pluginId: 'plugin-a', timeoutMs: 800 }],
    ['an unsafe script', { ...DYNAMIC_TARGET, scriptName: 'Plugin' }],
    ['an empty script', { ...DYNAMIC_TARGET, scriptName: '' }],
    ['a zero timeout', { ...DYNAMIC_TARGET, timeoutMs: 0 }],
    ['an oversized timeout', { ...DYNAMIC_TARGET, timeoutMs: 30_001 }],
    ['a fractional timeout', { ...DYNAMIC_TARGET, timeoutMs: 1.5 }],
    ['a NaN timeout', { ...DYNAMIC_TARGET, timeoutMs: Number.NaN }],
  ])('refuses %s', async (_label, target) => {
    const h = harness();
    await expect(invoke(h, target as SyncHookTarget)).rejects.toThrow(TARGET_INVALID);
    expect(h.installations.resolve).not.toHaveBeenCalled();
  });
  it.each([1, 30_000])('accepts a timeout of %i ms', async (timeoutMs) => {
    await expect(invoke(harness(), { ...DYNAMIC_TARGET, timeoutMs })).resolves.toEqual(OK);
  });
  it('limits the request body to 32 KiB', async () => {
    const payload = (size: number): HumanVerificationHookInput => ({
      ...HV,
      responseToken: 'x'.repeat(size),
    });
    const base = JSON.stringify(payload(0)).length;
    await expect(invoke(harness(), DYNAMIC_TARGET, payload(32 * 1024 - base))).resolves.toEqual(OK);
    await expect(invoke(harness(), DYNAMIC_TARGET, payload(32 * 1024 - base + 1))).rejects.toThrow(
      /^plugin_sync_request_too_large$/u
    );
  });
  it('counts the request size in bytes', async () => {
    const wide: HumanVerificationHookInput = { ...HV, responseToken: '€'.repeat(11_000) };
    await expect(invoke(harness(), DYNAMIC_TARGET, wide)).rejects.toThrow(
      /^plugin_sync_request_too_large$/u
    );
  });
  describe('resolution failures are transient unless the gate closed', () => {
    it.each([
      ['an unresolvable installation', { target: null }],
      [
        'another script than the policy named',
        {
          target: {
            scriptName: 'other',
            codeSha256: 'c'.repeat(64),
            pluginId: 'p',
            hostInterfaces: [],
            resources: [],
          },
        },
      ],
      ['worker code carrying an environment', { code: { env: {} } }],
      ['a lookup failure', { resolveFailure: new Error('d1 down') }],
      ['a non-Error lookup failure', { resolveFailure: 'x' }],
    ])('%s', async (_label, over) => {
      const h = harness(over);
      await expect(invoke(h)).rejects.toThrow(TRANSIENT);
      expect(h.fetchEntry).not.toHaveBeenCalled();
    });
    it('rejects, without launching, when the gate closed while the code was fetched', async () => {
      const h = harness({ gate: false });
      await expect(invoke(h)).rejects.toThrow(REJECTED);
      expect(h.installations.isExternalGateOpen).toHaveBeenCalledWith('tenant-a');
      expect(h.fetchEntry).not.toHaveBeenCalled();
    });
    it('retries a worker that fails to run', async () => {
      const h = harness({ response: () => Promise.reject(new Error('boom')) });
      await expect(invoke(h)).rejects.toThrow(TRANSIENT);
    });
  });
  describe('responses', () => {
    const respond = (
      status: number,
      body: BodyInit | null = '',
      headers: Record<string, string> = {}
    ) => harness({ response: () => new Response(body, { status, headers }) });
    it.each([
      [429, 'plugin_sync_transient_failure'],
      [500, 'plugin_sync_transient_failure'],
      [503, 'plugin_sync_transient_failure'],
      [499, 'plugin_sync_rejected'],
      [400, 'plugin_sync_rejected'],
      [404, 'plugin_sync_rejected'],
      [302, 'plugin_sync_rejected'],
      [201, 'plugin_sync_rejected'],
    ])('maps status %i to %s', async (status, code) => {
      await expect(invoke(respond(status))).rejects.toThrow(new RegExp(`^${code}$`, 'u'));
    });
    it('cancels the body of a failed response', async () => {
      const cancel = vi.fn();
      const body = new ReadableStream({ cancel });
      await expect(
        invoke(harness({ response: () => new Response(body, { status: 500 }) }))
      ).rejects.toThrow(TRANSIENT);
      expect(cancel).toHaveBeenCalled();
    });
    it('refuses invalid JSON and malformed results', async () => {
      await expect(invoke(respond(200, '{nope'))).rejects.toThrow(
        /^plugin_sync_response_invalid$/u
      );
      await expect(invoke(respond(200, '{"decision":"allow"}'))).rejects.toThrow(
        /^plugin_sync_response_invalid$/u
      );
      await expect(invoke(respond(200, '[]'))).rejects.toThrow(/^plugin_sync_response_invalid$/u);
    });
    it('bounds the response to 16 KiB by declared length and by streamed size', async () => {
      const big = 'x'.repeat(16 * 1024 + 1);
      await expect(invoke(respond(200, big))).rejects.toThrow(/^plugin_sync_response_too_large$/u);
      await expect(
        invoke(
          harness({
            response: () =>
              new Response('{}', {
                status: 200,
                headers: { 'Content-Length': String(16 * 1024 + 1) },
              }),
          })
        )
      ).rejects.toThrow(/^plugin_sync_response_too_large$/u);
      await expect(invoke(respond(200, 'x'.repeat(16 * 1024)))).rejects.toThrow(
        /^plugin_sync_response_invalid$/u
      );
    });
    it('retries a response that cannot be read', async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new Error('stream broke'));
        },
      });
      await expect(
        invoke(harness({ response: () => new Response(body, { status: 200 }) }))
      ).rejects.toThrow(TRANSIENT);
    });
    it('validates the decision against the group of the call', async () => {
      const flow = harness({
        response: () => Response.json({ decision: 'allow', reasonCode: 'ok' }),
      });
      await expect(invoke(flow, DYNAMIC_TARGET, FLOW, 'flow-hook')).rejects.toThrow(
        /^plugin_sync_response_invalid$/u
      );
      const ok = harness({
        response: () => Response.json({ decision: 'continue', reasonCode: 'ok' }),
      });
      await expect(invoke(ok, DYNAMIC_TARGET, FLOW, 'flow-hook')).resolves.toEqual({
        decision: 'continue',
        reasonCode: 'ok',
      });
    });
  });
});

describe('SyncHookBackendRouter', () => {
  const IN_PROCESS: SyncHookTarget = {
    backendKind: 'in_process',
    pluginId: 'builtin-a',
    timeoutMs: 800,
  };
  function router(handler: InProcessSyncHookHandler | null) {
    const dynamic = { invoke: vi.fn(async () => OK) };
    const registry = new StaticInProcessSyncHookRegistry(
      handler ? new Map([['builtin-a:human_verification.verify', handler]]) : new Map()
    );
    return { router: new SyncHookBackendRouter(dynamic as never, registry), dynamic };
  }
  const call = (r: SyncHookBackendRouter, target: SyncHookTarget = IN_PROCESS) =>
    r.invoke({ group: 'human-verification', target, payload: HV });
  it('delegates dynamic targets to the dynamic backend untouched', async () => {
    const { router: r, dynamic } = router(null);
    await expect(call(r, DYNAMIC_TARGET)).resolves.toEqual(OK);
    expect(dynamic.invoke).toHaveBeenCalledWith({
      group: 'human-verification',
      target: DYNAMIC_TARGET,
      payload: HV,
    });
  });
  it.each([
    ['an unsafe plugin id', { ...IN_PROCESS, pluginId: '-x' }],
    ['a zero timeout', { ...IN_PROCESS, timeoutMs: 0 }],
    ['an oversized timeout', { ...IN_PROCESS, timeoutMs: 30_001 }],
    ['a fractional timeout', { ...IN_PROCESS, timeoutMs: 2.5 }],
  ])('refuses an in-process target with %s', async (_label, target) => {
    const { router: r } = router(vi.fn(async () => OK));
    await expect(call(r, target as SyncHookTarget)).rejects.toThrow(
      /^plugin_sync_target_invalid$/u
    );
  });
  it.each([1, 30_000])('accepts an in-process timeout of %i ms', async (timeoutMs) => {
    const { router: r } = router(vi.fn(async () => OK));
    await expect(call(r, { ...IN_PROCESS, timeoutMs })).resolves.toEqual(OK);
  });
  it('rejects a plugin without a registered handler for the capability', async () => {
    const { router: r } = router(null);
    await expect(call(r)).rejects.toThrow(/^plugin_sync_rejected$/u);
  });
  it('runs the handler with the payload and an unaborted signal, and validates the result', async () => {
    const handler = vi.fn<InProcessSyncHookHandler>(async () => OK);
    const { router: r } = router(handler);
    await expect(call(r)).resolves.toEqual(OK);
    const [payload, signal] = must(handler.mock.calls[0]);
    expect(payload).toBe(HV);
    expect(signal.aborted).toBe(false);
    const bad = router(async () => ({ decision: 'maybe', reasonCode: 'ok' }));
    await expect(call(bad.router)).rejects.toThrow(/^plugin_sync_response_invalid$/u);
  });
  it('passes a rejection through and turns every other failure into a transient one', async () => {
    await expect(
      call(router(async () => Promise.reject(new Error('plugin_sync_rejected'))).router)
    ).rejects.toThrow(/^plugin_sync_rejected$/u);
    await expect(
      call(router(async () => Promise.reject(new Error('plugin_sync_other'))).router)
    ).rejects.toThrow(/^plugin_sync_transient_failure$/u);
    await expect(call(router(() => rejectOpaque('plugin_sync_rejected')).router)).rejects.toThrow(
      /^plugin_sync_transient_failure$/u
    );
  });
  it('aborts a handler that outlives its timeout', async () => {
    let signal: AbortSignal | undefined;
    const { router: r } = router((_payload, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    await expect(call(r, { ...IN_PROCESS, timeoutMs: 5 })).rejects.toThrow(
      /^plugin_sync_transient_failure$/u
    );
    expect(signal?.aborted).toBe(true);
  });
  it('resolves handlers by exact plugin and capability', () => {
    const handler: InProcessSyncHookHandler = async () => OK;
    const registry = new StaticInProcessSyncHookRegistry(new Map([['p:c', handler]]));
    expect(registry.resolve('p', 'c')).toBe(handler);
    expect(registry.resolve('p', 'd')).toBeNull();
    expect(new StaticInProcessSyncHookRegistry().resolve('p', 'c')).toBeNull();
  });
});

describe('sync hook edges', () => {
  it('accepts a result whose keys arrive in any order', () => {
    expect(
      validateSyncHookResult({ reasonCode: 'ok', decision: 'allow' }, 'policy-decision')
    ).toEqual({ reasonCode: 'ok', decision: 'allow' });
  });
  it.each([
    ['trailing text', 'plugin a'],
    ['an uppercase letter', 'Plugin-a'],
  ])('refuses a script name with %s', async (_label, scriptName) => {
    const h = harness();
    await expect(invoke(h, { ...DYNAMIC_TARGET, scriptName })).rejects.toThrow(
      /^plugin_sync_target_invalid$/u
    );
  });
  it('refuses host interfaces alone when no factory exists', async () => {
    const h = harness({
      hostInterfaces: false,
      target: {
        scriptName: 'plugin-a',
        codeSha256: 'c'.repeat(64),
        pluginId: 'p',
        hostInterfaces: [{ name: 'H' }],
        resources: [],
      },
    });
    await expect(invoke(h)).rejects.toThrow(/^plugin_sync_transient_failure$/u);
    expect(h.fetchEntry).not.toHaveBeenCalled();
  });
});
