import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PluginRunnerWorker, { SAML_DR_READ_ONLY_SURFACES, SAML_DR_WRITER_SURFACES } from '../worker';
import { callsTo, must, outcomes, resetKit } from './helpers/mock-kit';

vi.mock('@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer', () => ({
  runSamlDrCoveredOperation: (
    env: unknown,
    ctx: unknown,
    op: (env: unknown, ctx: unknown) => unknown
  ) => op(env, ctx),
  runSamlDrCoveredFetch: (
    env: unknown,
    ctx: unknown,
    op: (env: unknown, ctx: unknown) => unknown
  ) => op(env, ctx),
}));
vi.mock('../config-store', async () => ({
  D1PluginConfigStore: (await import('./helpers/mock-kit')).mockClass('D1PluginConfigStore', [
    'replaceCredentials',
  ]),
}));
vi.mock('../human-verification-installations', async () => ({
  D1HumanVerificationInstallationStore: (await import('./helpers/mock-kit')).mockClass(
    'D1HumanVerificationInstallationStore',
    ['configure']
  ),
}));
vi.mock('../notification-installations', async () => ({
  D1NotificationInstallationStore: (await import('./helpers/mock-kit')).mockClass(
    'D1NotificationInstallationStore',
    ['configure']
  ),
}));
vi.mock('../dynamic-worker-installations', async () => ({
  D1DynamicPluginInstallationStore: (await import('./helpers/mock-kit')).mockClass(
    'D1DynamicPluginInstallationStore',
    [
      'configure',
      'stageActivation',
      'rollout',
      'rolloutBatch',
      'listApproved',
      'status',
      'credentialInputs',
    ]
  ),
}));
vi.mock('../tenant-backup', async () => ({
  DynamicPluginTenantBackupService: (await import('./helpers/mock-kit')).mockClass(
    'DynamicPluginTenantBackupService',
    ['export', 'restore', 'verify']
  ),
}));
vi.mock('../notification-provider-order', async () => ({
  D1NotificationProviderOrderStore: (await import('./helpers/mock-kit')).mockClass(
    'D1NotificationProviderOrderStore',
    ['replace', 'resolve']
  ),
}));
vi.mock('../notification-intent', async () => ({
  encryptNotificationPayloadFromEnv: (await import('./helpers/mock-kit')).mockFn(
    'encryptNotificationPayloadFromEnv'
  ),
}));
vi.mock('../account-event-installations', async () => ({
  D1AccountEventInstallationResolver: (await import('./helpers/mock-kit')).mockClass(
    'D1AccountEventInstallationResolver',
    ['resolve']
  ),
}));
vi.mock('../external-gate', async () => ({
  D1TenantExternalGateStore: (await import('./helpers/mock-kit')).mockClass(
    'D1TenantExternalGateStore',
    ['set', 'listCandidates', 'get']
  ),
}));
vi.mock('../config-reencryption', async () => ({
  D1PluginConfigReencryptor: (await import('./helpers/mock-kit')).mockClass(
    'D1PluginConfigReencryptor',
    ['start']
  ),
}));
vi.mock('../encryption-keyring', async () => ({
  pluginEncryptionKeyringFromEnv: (await import('./helpers/mock-kit')).mockFn(
    'pluginEncryptionKeyringFromEnv'
  ),
}));
vi.mock('../sync-hook-service', async () => ({
  SyncHookService: (await import('./helpers/mock-kit')).mockClass('SyncHookService', [
    'runHumanVerification',
    'runPolicyDecision',
    'runFlowHook',
  ]),
}));
vi.mock('../sync-hooks', async () => ({
  DynamicWorkerSyncHookBackend: (await import('./helpers/mock-kit')).mockClass(
    'DynamicWorkerSyncHookBackend',
    []
  ),
}));
vi.mock('../sync-hook-backend-router', async () => ({
  SyncHookBackendRouter: (await import('./helpers/mock-kit')).mockClass(
    'SyncHookBackendRouter',
    []
  ),
}));
vi.mock('../builtin-human-verification', async () => ({
  createBuiltinHumanVerificationRegistry: (await import('./helpers/mock-kit')).mockFn(
    'createBuiltinHumanVerificationRegistry'
  ),
}));
vi.mock('../dynamic-worker-code', async () => ({
  R2PluginWorkerCodeResolver: (await import('./helpers/mock-kit')).mockClass(
    'R2PluginWorkerCodeResolver',
    []
  ),
}));
vi.mock('../installations', async () => ({
  D1PluginInstallationResolver: (await import('./helpers/mock-kit')).mockClass(
    'D1PluginInstallationResolver',
    []
  ),
}));
vi.mock('../scheduler', async () => ({
  PluginRunnerScheduler: (await import('./helpers/mock-kit')).mockClass('PluginRunnerScheduler', [
    'run',
  ]),
}));
vi.mock('../r2-bucket-metrics', async () => ({
  scanAndReportPluginBundleMetrics: (await import('./helpers/mock-kit')).mockFn(
    'scanAndReportPluginBundleMetrics'
  ),
}));
vi.mock('../notification-delivery-service', async () => ({
  ImmediateNotificationDeliveryService: (await import('./helpers/mock-kit')).mockClass(
    'ImmediateNotificationDeliveryService',
    ['deliver']
  ),
}));

const DB = { id: 'plugin-runner-db' };
const ENV = {
  AUTHRIM_ENVIRONMENT_NAME: 'test',
  PLUGIN_RUNNER_DB: DB,
  PLUGIN_MUTATION_HMAC_KEY: 'hmac-key',
};
type Rpc = Record<string, (input?: unknown) => Promise<unknown>>;
function exportsSpy() {
  return {
    PluginDynamicOutbound: vi.fn(() => 'outbound-fetcher'),
    PluginD1ResourceAccess: vi.fn(() => 'd1-stub'),
    PluginKvResourceAccess: vi.fn(() => 'kv-stub'),
    PluginR2ResourceAccess: vi.fn(() => 'r2-stub'),
  };
}
function as(caller: string, ex = exportsSpy()): Rpc {
  return new PluginRunnerWorker(
    {
      props: { caller, environmentId: 'test', audience: 'authrim-plugin-runner-v1' },
      exports: ex,
    } as never,
    ENV as never
  ) as unknown as Rpc;
}
function invoke(rpc: Rpc, method: string, input?: unknown): Promise<unknown> {
  return must(rpc[method]).call(rpc, input);
}
const CONTEXT = { tenantId: 'tenant-a', pluginInstallationId: 'inst-a' };
const RESOURCES = [
  { binding: 'A', kind: 'd1' },
  { binding: 'B', kind: 'kv_namespace' },
  { binding: 'C', kind: 'r2_bucket' },
];

beforeEach(() => {
  resetKit();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('fetch and surface inventory', () => {
  it('answers every HTTP request with a fixed, uncacheable 404', async () => {
    const response = as('ar-auth').fetch?.(
      new Request('https://internal.invalid/x')
    ) as never as Response;
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found');
    expect(Object.fromEntries([...response.headers.entries()].sort())).toEqual({
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
    });
  });
  it('names the writer surfaces exactly', () => {
    expect([...SAML_DR_WRITER_SURFACES].sort()).toEqual(
      [
        'scheduled',
        'rpc:PluginRunnerWorker.runHumanVerification',
        'rpc:PluginRunnerWorker.runPolicyDecision',
        'rpc:PluginRunnerWorker.runFlowHook',
        'rpc:PluginRunnerWorker.deliverNotification',
        'rpc:PluginRunnerWorker.replacePluginCredentials',
        'rpc:PluginRunnerWorker.configureNotificationInstallation',
        'rpc:PluginRunnerWorker.configureHumanVerificationInstallation',
        'rpc:PluginRunnerWorker.configureDynamicPluginInstallation',
        'rpc:PluginRunnerWorker.stageDynamicPluginActivation',
        'rpc:PluginRunnerWorker.rolloutDynamicPluginInstallation',
        'rpc:PluginRunnerWorker.rolloutDynamicPluginBatch',
        'rpc:PluginRunnerWorker.replaceDynamicPluginCredentials',
        'rpc:PluginRunnerWorker.restoreDynamicPluginBackup',
        'rpc:PluginRunnerWorker.replaceNotificationProviderOrder',
        'rpc:PluginRunnerWorker.setTenantExternalGate',
        'rpc:PluginRunnerWorker.startPluginCredentialRotation',
        'rpc:PluginDynamicOutbound.fetch',
        'rpc:PluginAccountMetadataAccess.write',
        'rpc:RuntimeSmokeEntrypoint.smokePluginResourceBindings',
      ].sort()
    );
  });
  it('names the read-only surfaces exactly and never overlaps the writers', () => {
    expect([...SAML_DR_READ_ONLY_SURFACES].sort()).toEqual(
      [
        'fetch',
        'rpc:PluginRunnerWorker.encryptNotificationPayload',
        'rpc:PluginRunnerWorker.exportDynamicPluginBackup',
        'rpc:PluginRunnerWorker.getDynamicPluginInstallationStatus',
        'rpc:PluginRunnerWorker.getTenantExternalGate',
        'rpc:PluginRunnerWorker.listApprovedDynamicPlugins',
        'rpc:PluginRunnerWorker.listTenantExternalGateCandidates',
        'rpc:PluginRunnerWorker.resolveAccountEventInstallations',
        'rpc:PluginRunnerWorker.resolveNotificationProviderOrder',
        'rpc:PluginRunnerWorker.verifyDynamicPluginBackup',
      ].sort()
    );
    const writers = new Set<string>(SAML_DR_WRITER_SURFACES);
    expect(SAML_DR_READ_ONLY_SURFACES.filter((surface) => writers.has(surface))).toEqual([]);
  });
});

describe('loopback factories handed to the services', () => {
  const HV = {
    tenantId: 'tenant-a',
    pluginInstallationId: 'inst-a',
    requestId: 'req-a',
    action: 'login',
    responseToken: 'tok',
  };
  const POLICY = {
    tenantId: 'tenant-a',
    pluginInstallationId: 'inst-a',
    requestId: 'req-a',
    subjectId: 'sub-a',
    action: 'read',
    resourceType: 'doc',
    resourceId: 'doc-a',
    attributes: {},
  };
  const FLOW = {
    tenantId: 'tenant-a',
    pluginInstallationId: 'inst-a',
    requestId: 'req-a',
    flowId: 'flow-a',
    hookName: 'before-login',
    stateVersion: 1,
  };
  const DELIVERY = {
    tenantId: 'tenant-a',
    intentId: 'intent-a',
    outboxId: 'outbox-a',
    pluginInstallationId: 'inst-a',
    bindingRef: 'TEST_TDB_CORE_A',
  };
  function exercise(factory: unknown, hostFactory: unknown, ex: ReturnType<typeof exportsSpy>) {
    expect((factory as (c: unknown) => unknown)(CONTEXT)).toBe('outbound-fetcher');
    expect(ex.PluginDynamicOutbound).toHaveBeenCalledWith({ props: CONTEXT });
    expect(
      (hostFactory as (...a: unknown[]) => unknown)(CONTEXT, [], RESOURCES, 'plugin-a')
    ).toEqual({ A: 'd1-stub', B: 'kv-stub', C: 'r2-stub' });
    expect(ex.PluginD1ResourceAccess).toHaveBeenCalledWith({
      props: {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        installationId: 'inst-a',
        binding: 'A',
        kind: 'd1',
      },
    });
  }
  it.each([
    ['ar-auth', 'runHumanVerification', HV],
    ['ar-policy', 'runPolicyDecision', POLICY],
    ['ar-auth', 'runFlowHook', FLOW],
  ])(
    '%s %s gives the backend working outbound and host-interface factories',
    async (caller, method, input) => {
      const ex = exportsSpy();
      await invoke(as(caller, ex), method, input);
      const backend = must(callsTo('DynamicWorkerSyncHookBackend.new')[0]);
      exercise(backend[3], backend[4], ex);
    }
  );
  it('gives immediate delivery the clock and the same factories', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_777_900);
    const ex = exportsSpy();
    await invoke(as('ar-auth', ex), 'deliverNotification', DELIVERY);
    const [env, now, outbound, hosts] = must(
      callsTo('ImmediateNotificationDeliveryService.new')[0]
    );
    expect(env).toEqual(ENV);
    expect((now as () => number)()).toBe(1_700_000_777);
    exercise(outbound, hosts, ex);
  });
  it('keeps the delivery inputs out of the service constructor', async () => {
    await invoke(as('ar-auth'), 'deliverNotification', DELIVERY);
    expect(must(callsTo('ImmediateNotificationDeliveryService.new')[0])).toHaveLength(4);
  });
});

describe('inputs that are not objects', () => {
  const INVALID = /^plugin_sync_input_invalid$/u;
  it.each([5, true, 0])(
    'rejects the primitive %s for the gate candidate listing',
    async (input) => {
      await expect(
        invoke(as('ar-management'), 'listTenantExternalGateCandidates', input)
      ).rejects.toThrow(INVALID);
    }
  );
  it.each([5, true, 'x'])('rejects the primitive %j for the gate setter', async (input) => {
    await expect(invoke(as('ar-management'), 'setTenantExternalGate', input)).rejects.toThrow(
      INVALID
    );
  });
  it('rejects a numeric attribute bag in a policy decision', async () => {
    await expect(
      invoke(as('ar-policy'), 'runPolicyDecision', {
        tenantId: 'tenant-a',
        pluginInstallationId: 'inst-a',
        requestId: 'req-a',
        subjectId: 'sub-a',
        action: 'read',
        resourceType: 'doc',
        resourceId: 'doc-a',
        attributes: 5,
      })
    ).rejects.toThrow(INVALID);
    expect(callsTo('SyncHookService.runPolicyDecision')).toEqual([]);
  });
  it('accepts the smallest credential version', async () => {
    outcomes.set('D1DynamicPluginInstallationStore.status', {
      state: 'enabled',
      configVersion: 1,
      installationId: 'inst-1',
    });
    outcomes.set('D1DynamicPluginInstallationStore.credentialInputs', { values: [] });
    await expect(
      invoke(as('ar-management'), 'replaceDynamicPluginCredentials', {
        operationId: 'op-1',
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        expectedConfigVersion: 1,
        credentials: {},
      })
    ).resolves.toBe('D1PluginConfigStore.replaceCredentials:result');
  });
});
