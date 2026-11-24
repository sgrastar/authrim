import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncHookService } from '../sync-hook-service';
import type {
  FlowHookInput,
  HumanVerificationHookInput,
  PolicyDecisionHookInput,
} from '../sync-hooks';
import { rows, seedArtifact, seedInstallation, seedPlugin } from './helpers/dynamic-plugin-seed';
import { createD1, openRunnerDatabase, type D1Options } from './helpers/sqlite-d1';

const NOW = 1_000;
const DENY = { decision: 'deny', reasonCode: 'plugin_unavailable' };
const HV: HumanVerificationHookInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'builtin-installation',
  requestId: 'request-a',
  action: 'login',
  responseToken: 'token',
};
const POLICY: PolicyDecisionHookInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'builtin-installation',
  requestId: 'request-a',
  subjectId: 'subject-a',
  action: 'read',
  resourceType: 'doc',
  resourceId: 'doc-a',
  attributes: {},
};
const FLOW: FlowHookInput = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'builtin-installation',
  requestId: 'request-a',
  flowId: 'flow-a',
  hookName: 'before-login',
  stateVersion: 1,
};

let database: DatabaseSync;
function service(
  backend: { invoke: ReturnType<typeof vi.fn> },
  options: D1Options = {},
  now = NOW
) {
  const d1 = createD1(database, options);
  return { service: new SyncHookService(d1.db, backend as never, () => now), calls: d1.calls };
}
const backendReturning = (value: unknown = { decision: 'allow', reasonCode: 'ok' }) => ({
  invoke: vi.fn(async () => value),
});
const backendFailing = () => ({
  invoke: vi.fn(() => Promise.reject(new Error('plugin_sync_transient_failure'))),
});
const breaker = () =>
  database.prepare('SELECT * FROM plugin_runner_circuit_breakers').get() as
    | Record<string, unknown>
    | undefined;

function policy(
  capability: string,
  over: { threshold?: number; cooldown?: number; timeout?: number; failure?: string } = {}
) {
  database
    .prepare(
      `INSERT INTO plugin_runner_hook_policies (plugin_id, capability, timeout_ms, failure_policy, max_attempts, async_retry_budget_seconds, circuit_breaker_threshold, circuit_breaker_cooldown_seconds, updated_at) VALUES ('builtin-plugin', ?, ?, ?, 1, 60, ?, ?, 1)`
    )
    .run(
      capability,
      over.timeout ?? 750,
      over.failure ?? 'fail_closed',
      over.threshold ?? 3,
      over.cooldown ?? 30
    );
}

beforeEach(async () => {
  database = openRunnerDatabase();
  await seedInstallation(database, {
    installationId: 'builtin-installation',
    pluginId: 'builtin-plugin',
    backendKind: 'in_process',
    state: 'enabled',
  });
  for (const capability of ['human_verification.verify', 'policy.decision', 'flow.before-login']) {
    policy(capability);
  }
});

describe('execution', () => {
  it.each([
    ['runHumanVerification', 'human-verification', HV],
    ['runPolicyDecision', 'policy-decision', POLICY],
    ['runFlowHook', 'flow-hook', FLOW],
  ] as const)(
    '%s asks the backend for its group with the resolved target',
    async (method, group, input) => {
      const backend = backendReturning();
      const { service: s } = service(backend);
      await expect((s[method] as (i: unknown) => Promise<unknown>).call(s, input)).resolves.toEqual(
        {
          decision: 'allow',
          reasonCode: 'ok',
        }
      );
      expect(backend.invoke).toHaveBeenCalledWith({
        group,
        target: { backendKind: 'in_process', pluginId: 'builtin-plugin', timeoutMs: 750 },
        payload: input,
      });
    }
  );
  it('resolves the policy of the hook named by a flow', async () => {
    policy('flow.after-login');
    const backend = backendReturning();
    await service(backend).service.runFlowHook({ ...FLOW, hookName: 'after-login' });
    expect(backend.invoke).toHaveBeenCalledOnce();
    await expect(
      service(backendReturning()).service.runFlowHook({ ...FLOW, hookName: 'unknown-hook' })
    ).resolves.toEqual(DENY);
  });
  it.each([
    ['unsafe tenant', { ...HV, tenantId: '-a' }],
    ['unsafe installation', { ...HV, pluginInstallationId: '' }],
  ])('denies an input with an %s without reading storage', async (_label, input) => {
    const backend = backendReturning();
    const { service: s, calls } = service(backend);
    await expect(s.runHumanVerification(input)).resolves.toEqual(DENY);
    expect(calls).toEqual([]);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
  it('denies a hook name that cannot form a capability', async () => {
    const { service: s, calls } = service(backendReturning());
    await expect(s.runFlowHook({ ...FLOW, hookName: 'Bad Name' })).resolves.toEqual(DENY);
    expect(calls).toEqual([]);
  });
  it('binds the capability three times, then the installation and tenant', async () => {
    const { service: s, calls } = service(backendReturning());
    await s.runHumanVerification(HV);
    expect(calls.find((c) => c.kind === 'first')?.values).toEqual([
      'human_verification.verify',
      'human_verification.verify',
      'human_verification.verify',
      'builtin-installation',
      'tenant-a',
    ]);
  });
  it('needs the D1 sessions API', async () => {
    const backend = backendReturning();
    await expect(
      service(backend, { withoutSession: true }).service.runHumanVerification(HV)
    ).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
});

describe('policy availability', () => {
  const denied = async (mutate: () => void) => {
    mutate();
    const backend = backendReturning();
    await expect(service(backend).service.runHumanVerification(HV)).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  };
  it('denies a disabled installation', () =>
    denied(() => database.exec("UPDATE plugin_runner_installations SET state = 'disabled'")));
  it('denies an installation of another tenant', () =>
    denied(() => database.exec("UPDATE plugin_runner_installations SET tenant_id = 'tenant-b'")));
  it('denies a capability without a policy', () =>
    denied(() => database.exec('DELETE FROM plugin_runner_hook_policies')));
  it.each(['fail_open', 'retry_async'])('denies a policy that is not fail-closed (%s)', (failure) =>
    denied(() =>
      database.exec(`UPDATE plugin_runner_hook_policies SET failure_policy = '${failure}'`)
    )
  );
  it('denies a built-in installation that carries a script name', async () => {
    const backend = backendReturning();
    await expect(
      service(backend, {
        rewrite: (call, value) =>
          call.kind === 'first' && value ? { ...value, script_name: 'x' } : value,
      }).service.runHumanVerification(HV)
    ).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
});

describe('dynamic installations', () => {
  async function dynamic(
    options: { gate?: boolean; script?: string; policyCapability?: string } = {}
  ) {
    seedPlugin(database, { pluginId: 'dyn-plugin' });
    database
      .prepare(
        `INSERT INTO plugin_runner_dynamic_worker_hook_policies (plugin_id, version_digest, capability, timeout_ms, failure_policy, max_attempts, async_retry_budget_seconds, circuit_breaker_threshold, circuit_breaker_cooldown_seconds, updated_at) VALUES ('dyn-plugin', ?, ?, 900, 'fail_closed', 1, 60, 2, 20, 1)`
      )
      .run('1'.repeat(64), options.policyCapability ?? 'human_verification.verify');
    const id = await seedInstallation(database, {
      tenantId: 'tenant-a',
      pluginId: 'dyn-plugin',
      installationId: 'dyn-installation',
      state: 'enabled',
      scriptName: options.script,
    });
    seedArtifact(database, id, '1'.repeat(64), 'active', 'dyn-plugin');
    if (options.gate !== false) {
      database.exec(
        "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 1, 1, 1)"
      );
    }
  }
  const input = { ...HV, pluginInstallationId: 'dyn-installation' };
  it('runs an enabled pinned installation with the dynamic policy and script', async () => {
    await dynamic();
    const backend = backendReturning();
    await expect(service(backend).service.runHumanVerification(input)).resolves.toMatchObject({
      decision: 'allow',
    });
    expect(backend.invoke).toHaveBeenCalledWith({
      group: 'human-verification',
      target: { backendKind: 'dynamic_worker', scriptName: 'dyn-plugin', timeoutMs: 900 },
      payload: input,
    });
  });
  it('denies while the tenant gate is closed or absent', async () => {
    await dynamic({ gate: false });
    const backend = backendReturning();
    await expect(service(backend).service.runHumanVerification(input)).resolves.toEqual(DENY);
    database.exec(
      "INSERT INTO plugin_runner_tenant_external_gates (tenant_id, allowed, generation, updated_at) VALUES ('tenant-a', 0, 1, 1)"
    );
    await expect(service(backend).service.runHumanVerification(input)).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
  it('denies a capability that the pinned release has no policy for', async () => {
    await dynamic({ policyCapability: 'policy.decision' });
    const backend = backendReturning();
    await expect(service(backend).service.runHumanVerification(input)).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
  it('denies an installation without an active pin, a revoked release or a withdrawn manifest', async () => {
    await dynamic();
    const backend = backendReturning();
    database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'revoked'");
    await expect(service(backend).service.runHumanVerification(input)).resolves.toEqual(DENY);
    database.exec("UPDATE plugin_runner_dynamic_worker_manifests SET state = 'active'");
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'revoked'");
    await expect(service(backend).service.runHumanVerification(input)).resolves.toEqual(DENY);
    database.exec("UPDATE plugin_runner_dynamic_worker_releases SET state = 'published'");
    database.exec(
      "UPDATE plugin_runner_dynamic_worker_artifacts SET state = 'retired', activated_at = NULL"
    );
    await expect(service(backend).service.runHumanVerification(input)).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
  it('denies a dynamic installation whose script name is not usable', async () => {
    await dynamic();
    database.exec(
      "UPDATE plugin_runner_installations SET script_name = 'Bad Script' WHERE installation_id = 'dyn-installation'"
    );
    const backend = backendReturning();
    await expect(service(backend).service.runHumanVerification(input)).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
});

describe('circuit breaker', () => {
  const run = (backend: { invoke: ReturnType<typeof vi.fn> }, now = NOW, options: D1Options = {}) =>
    service(backend, options, now).service.runHumanVerification(HV);
  it('records a success as a closed breaker', async () => {
    await run(backendReturning());
    expect(breaker()).toMatchObject({
      plugin_id: 'builtin-plugin',
      tenant_id: 'tenant-a',
      capability: 'human_verification.verify',
      state: 'closed',
      failure_count: 0,
      opened_at: null,
      retry_after: null,
      updated_at: NOW,
      probe_token: null,
      probe_until: null,
    });
  });
  it('turns a backend failure into a denial and counts it', async () => {
    await expect(run(backendFailing())).resolves.toEqual(DENY);
    expect(breaker()).toMatchObject({
      state: 'closed',
      failure_count: 1,
      opened_at: null,
      retry_after: null,
    });
  });
  it('opens the breaker at the threshold and blocks calls until the cooldown ends', async () => {
    const backend = backendFailing();
    for (let attempt = 0; attempt < 3; attempt++) await run(backend, NOW + attempt);
    expect(breaker()).toMatchObject({
      state: 'open',
      failure_count: 3,
      opened_at: NOW + 2,
      retry_after: NOW + 2 + 30,
    });
    const blocked = backendReturning();
    await expect(run(blocked, NOW + 31)).resolves.toEqual(DENY);
    expect(blocked.invoke).not.toHaveBeenCalled();
    await expect(run(blocked, NOW + 31 + 0)).resolves.toEqual(DENY);
  });
  it('opens at once when the threshold is one', async () => {
    database.exec('UPDATE plugin_runner_hook_policies SET circuit_breaker_threshold = 1');
    await run(backendFailing());
    expect(breaker()).toMatchObject({
      state: 'open',
      failure_count: 1,
      opened_at: NOW,
      retry_after: NOW + 30,
    });
  });
  it('lets exactly one probe through once the cooldown has elapsed and closes on success', async () => {
    database.exec('UPDATE plugin_runner_hook_policies SET circuit_breaker_threshold = 1');
    await run(backendFailing());
    const probe = backendReturning();
    await expect(run(probe, NOW + 29)).resolves.toEqual(DENY);
    expect(probe.invoke).not.toHaveBeenCalled();
    await expect(run(probe, NOW + 30)).resolves.toMatchObject({ decision: 'allow' });
    expect(probe.invoke).toHaveBeenCalledOnce();
    expect(breaker()).toMatchObject({
      state: 'closed',
      failure_count: 0,
      retry_after: null,
      probe_token: null,
    });
  });
  it('fences a second caller while a probe is in flight and frees the fence when it expires', async () => {
    database.exec('UPDATE plugin_runner_hook_policies SET circuit_breaker_threshold = 1');
    await run(backendFailing());
    let resolveProbe: (value: unknown) => void = () => undefined;
    const slow = {
      invoke: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveProbe = resolve;
          })
      ),
    };
    const first = run(slow, NOW + 30);
    await vi.waitFor(() => expect(slow.invoke).toHaveBeenCalled());
    expect(breaker()).toMatchObject({ state: 'half_open', probe_until: NOW + 30 + 60 });
    const second = backendReturning();
    await expect(run(second, NOW + 31)).resolves.toEqual(DENY);
    await expect(run(second, NOW + 30 + 59)).resolves.toEqual(DENY);
    expect(second.invoke).not.toHaveBeenCalled();
    await expect(run(second, NOW + 30 + 60)).resolves.toMatchObject({ decision: 'allow' });
    resolveProbe({ decision: 'allow', reasonCode: 'ok' });
    await first;
  });
  it('re-opens the breaker when the probe fails even though the threshold was not reached', async () => {
    database.exec('UPDATE plugin_runner_hook_policies SET circuit_breaker_threshold = 5');
    database.exec(
      `INSERT INTO plugin_runner_circuit_breakers (plugin_id, tenant_id, capability, state, failure_count, opened_at, retry_after, updated_at) VALUES ('builtin-plugin', 'tenant-a', 'human_verification.verify', 'open', 2, 1, 100, 1)`
    );
    await run(backendFailing(), 200);
    expect(breaker()).toMatchObject({
      state: 'open',
      failure_count: 3,
      opened_at: 200,
      retry_after: 230,
      probe_token: null,
    });
  });
  it('keeps breakers apart per tenant and capability', async () => {
    await run(backendFailing());
    await service(backendFailing()).service.runPolicyDecision(POLICY);
    expect(
      rows<{ capability: string; failure_count: number }>(
        database,
        'SELECT capability, failure_count FROM plugin_runner_circuit_breakers ORDER BY capability'
      )
    ).toEqual([
      { capability: 'human_verification.verify', failure_count: 1 },
      { capability: 'policy.decision', failure_count: 1 },
    ]);
  });
  it('denies when the success cannot be recorded, discarding the backend answer', async () => {
    const backend = backendReturning();
    await expect(
      run(backend, NOW, {
        intercept: (call) =>
          call.kind === 'run' && call.sql.includes("'closed', 0")
            ? { value: { success: true, results: [], meta: { changes: 0 } } }
            : undefined,
      })
    ).resolves.toEqual(DENY);
    expect(backend.invoke).toHaveBeenCalledOnce();
  });
  it('treats a missing change count as not recorded', async () => {
    await expect(
      run(backendReturning(), NOW, {
        intercept: (call) =>
          call.kind === 'run' ? { value: { success: true, results: [], meta: {} } } : undefined,
      })
    ).resolves.toEqual(DENY);
  });
  it('still denies when the failure cannot be recorded', async () => {
    await expect(
      run(backendFailing(), NOW, {
        intercept: (call) =>
          call.kind === 'run'
            ? { value: { success: true, results: [], meta: { changes: 0 } } }
            : undefined,
      })
    ).resolves.toEqual(DENY);
  });
  it('binds the breaker update of a probe to the clock and a 60 second fence', async () => {
    database.exec('UPDATE plugin_runner_hook_policies SET circuit_breaker_threshold = 1');
    await run(backendFailing());
    const { service: s, calls } = service(backendReturning(), {}, NOW + 30);
    await s.runHumanVerification(HV);
    const update = calls.find((c) => c.kind === 'run' && c.sql.includes("state = 'half_open'"));
    expect(update?.values).toEqual([
      expect.stringMatching(/^probe-[0-9a-f-]{36}$/u),
      NOW + 30 + 60,
      NOW + 30,
      'builtin-plugin',
      'tenant-a',
      'human_verification.verify',
      NOW + 30,
      NOW + 30,
    ]);
  });
});

describe('stored policy edges', () => {
  const rewriteRow = (patch: Record<string, unknown>) => ({
    rewrite: (call: { kind: string; sql: string }, value: unknown) =>
      call.kind === 'first' && call.sql.includes('breaker.state AS breaker_state') && value
        ? { ...value, ...patch }
        : value,
  });
  const denied = async (patch: Record<string, unknown>) => {
    const backend = backendReturning();
    await expect(
      service(backend, rewriteRow(patch)).service.runHumanVerification(HV)
    ).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  };
  const allowed = async (patch: Record<string, unknown>) => {
    const backend = backendReturning();
    await expect(
      service(backend, rewriteRow(patch)).service.runHumanVerification(HV)
    ).resolves.toMatchObject({ decision: 'allow' });
    expect(backend.invoke).toHaveBeenCalledOnce();
  };
  it.each([
    [
      'an installation id with trailing text',
      { ...HV, pluginInstallationId: 'builtin installation' },
    ],
    ['a tenant id with trailing text', { ...HV, tenantId: 'tenant a' }],
  ])('denies %s without reading storage', async (_label, input) => {
    const { service: s, calls } = service(backendReturning());
    await expect(s.runHumanVerification(input)).resolves.toEqual(DENY);
    expect(calls).toEqual([]);
  });
  it.each([0, 30_001, 'x', 1.5])('denies a stored timeout of %j', (timeout) =>
    denied({ timeout_ms: timeout })
  );
  it.each([1, 30_000])('runs with a stored timeout of %i ms', (timeout) =>
    allowed({ timeout_ms: timeout })
  );
  it.each([0, 1_001, 'x'])('denies a stored breaker threshold of %j', (value) =>
    denied({ circuit_breaker_threshold: value })
  );
  it.each([0, 86_401, 'x'])('denies a stored breaker cooldown of %j', (value) =>
    denied({ circuit_breaker_cooldown_seconds: value })
  );
  it.each([1, 1_000])('runs with a stored breaker threshold of %i', (value) =>
    allowed({ circuit_breaker_threshold: value })
  );
  it.each([1, 86_400])('runs with a stored breaker cooldown of %i seconds', (value) =>
    allowed({ circuit_breaker_cooldown_seconds: value })
  );
  it('denies an unknown backend kind and an unknown breaker state', async () => {
    await denied({ backend_kind: 'wasm' });
    await denied({ breaker_state: 'weird' });
  });
  it.each([
    ['retry_after', 'x'],
    ['retry_after', -1],
    ['probe_until', 'x'],
    ['probe_until', -1],
  ])('denies an open or half-open breaker with an unreadable %s of %j', async (column, value) => {
    await denied({
      breaker_state: column === 'retry_after' ? 'open' : 'half_open',
      retry_after: 0,
      probe_until: 0,
      [column]: value,
    });
  });
  it('never runs a hook behind an open breaker that has no retry time to fence a probe with', async () => {
    await denied({ breaker_state: 'open', retry_after: null, probe_until: null });
  });
  it('lets an open breaker probe when only a stale probe fence lies in the future', async () => {
    database.exec(
      `INSERT INTO plugin_runner_circuit_breakers (plugin_id, tenant_id, capability, state, failure_count, opened_at, retry_after, updated_at, probe_until) VALUES ('builtin-plugin', 'tenant-a', 'human_verification.verify', 'open', 3, 1, 900, 1, 5000)`
    );
    const backend = backendReturning();
    await expect(
      service(backend, {}, 1_000).service.runHumanVerification(HV)
    ).resolves.toMatchObject({ decision: 'allow' });
  });
  it('lets a half-open breaker probe when only a stale retry time lies in the future', async () => {
    database.exec(
      `INSERT INTO plugin_runner_circuit_breakers (plugin_id, tenant_id, capability, state, failure_count, opened_at, retry_after, updated_at, probe_token, probe_until) VALUES ('builtin-plugin', 'tenant-a', 'human_verification.verify', 'half_open', 3, 1, 5000, 1, 'old', 900)`
    );
    const backend = backendReturning();
    await expect(
      service(backend, {}, 1_000).service.runHumanVerification(HV)
    ).resolves.toMatchObject({ decision: 'allow' });
  });
  it('blocks an open breaker until its retry time and a half-open one until its probe fence ends', async () => {
    database.exec(
      `INSERT INTO plugin_runner_circuit_breakers (plugin_id, tenant_id, capability, state, failure_count, opened_at, retry_after, updated_at) VALUES ('builtin-plugin', 'tenant-a', 'human_verification.verify', 'open', 3, 1, 1001, 1)`
    );
    await expect(
      service(backendReturning(), {}, 1_000).service.runHumanVerification(HV)
    ).resolves.toEqual(DENY);
    database.exec(
      "UPDATE plugin_runner_circuit_breakers SET state = 'half_open', retry_after = 1, probe_until = 1001, probe_token = 'x'"
    );
    await expect(
      service(backendReturning(), {}, 1_000).service.runHumanVerification(HV)
    ).resolves.toEqual(DENY);
  });
  it('denies a probe that lost the race for the half-open fence', async () => {
    database.exec(
      `INSERT INTO plugin_runner_circuit_breakers (plugin_id, tenant_id, capability, state, failure_count, opened_at, retry_after, updated_at) VALUES ('builtin-plugin', 'tenant-a', 'human_verification.verify', 'open', 3, 1, 900, 1)`
    );
    const backend = backendReturning();
    await expect(
      service(
        backend,
        {
          intercept: (call) =>
            call.kind === 'run' && call.sql.includes("state = 'half_open'")
              ? { value: { success: true, results: [], meta: { changes: 0 } } }
              : undefined,
        },
        1_000
      ).service.runHumanVerification(HV)
    ).resolves.toEqual(DENY);
    expect(backend.invoke).not.toHaveBeenCalled();
  });
  it('reads from the primary and defaults the clock to seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_222_900);
    try {
      const d1 = createD1(database);
      await new SyncHookService(d1.db, backendReturning() as never).runHumanVerification(HV);
      expect(d1.calls.find((c) => c.kind === 'session')?.sql).toBe('first-primary');
      expect(breaker()).toMatchObject({ updated_at: 1_700_000_222 });
    } finally {
      vi.useRealTimers();
    }
  });
});
