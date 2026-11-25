import { beforeEach, describe, expect, it, vi } from 'vitest';
import PluginRunnerWorker from '../worker';
import { rejectOpaque, callsTo, log, must, outcomes, resetKit } from './helpers/mock-kit';

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

const CALLERS = ['ar-auth', 'ar-bridge', 'ar-management', 'ar-policy', 'ar-saml'] as const;
type Caller = (typeof CALLERS)[number];
const DB = { id: 'plugin-runner-db' };
const ENV = {
  AUTHRIM_ENVIRONMENT_NAME: 'test',
  PLUGIN_RUNNER_DB: DB,
  PLUGIN_LOADER: { id: 'loader' },
  PLUGIN_BUNDLES: { id: 'bundles' },
  PLUGIN_MUTATION_HMAC_KEY: 'hmac-key',
};
const KEYRING = 'pluginEncryptionKeyringFromEnv:result';

function worker(
  props: Record<string, unknown> | undefined,
  env: Record<string, unknown> = ENV
): Record<string, (input?: unknown) => Promise<unknown>> {
  const ctx = {
    props,
    exports: { PluginDynamicOutbound: vi.fn(() => 'outbound-fetcher') },
  };
  return new PluginRunnerWorker(ctx as never, env as never) as unknown as Record<
    string,
    (input?: unknown) => Promise<unknown>
  >;
}
function invoke(
  rpc: Record<string, (input?: unknown) => Promise<unknown>>,
  method: string,
  input?: unknown
): Promise<unknown> {
  return must(rpc[method]).call(rpc, input);
}
const as = (caller: Caller, environmentId = 'test') =>
  worker({ caller, environmentId, audience: 'authrim-plugin-runner-v1' });

interface Row {
  method: string;
  allowed: readonly Caller[];
  input?: unknown;
  expected: Array<{ call: string; args: unknown[] }>;
  result: string;
}
const MGMT = ['ar-management'] as const;
const dyn = (method: string, args: unknown[], input: unknown): Row => ({
  method: '',
  allowed: MGMT,
  input,
  expected: [
    { call: 'D1DynamicPluginInstallationStore.new', args: [DB, 'test'] },
    { call: `D1DynamicPluginInstallationStore.${method}`, args },
  ],
  result: `D1DynamicPluginInstallationStore.${method}:result`,
});
const withMethod = (method: string, row: Row): Row => ({ ...row, method });
const HV = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'inst-a',
  requestId: 'req-a',
  action: 'login',
  responseToken: 'tok',
};
const SYNC_CTORS = [
  'D1PluginInstallationResolver.new',
  'R2PluginWorkerCodeResolver.new',
  'DynamicWorkerSyncHookBackend.new',
  'createBuiltinHumanVerificationRegistry',
  'SyncHookBackendRouter.new',
  'SyncHookService.new',
];
const syncRow = (
  method: string,
  allowed: readonly Caller[],
  input: unknown,
  args: unknown
): Row => ({
  method,
  allowed,
  input,
  expected: [
    ...SYNC_CTORS.map((call) => ({ call, args: expect.anything() as unknown })).map(
      (entry) => entry as { call: string; args: unknown[] }
    ),
    { call: `SyncHookService.${method}`, args: [args] },
  ],
  result: `SyncHookService.${method}:result`,
});
const ROWS: Row[] = [
  syncRow('runHumanVerification', ['ar-auth', 'ar-bridge', 'ar-management', 'ar-saml'], HV, HV),
  syncRow(
    'runPolicyDecision',
    ['ar-policy'],
    {
      tenantId: 'tenant-a',
      pluginInstallationId: 'inst-a',
      requestId: 'req-a',
      subjectId: 'sub-a',
      action: 'read',
      resourceType: 'doc',
      resourceId: 'doc-a',
      attributes: { level: 3 },
    },
    {
      tenantId: 'tenant-a',
      pluginInstallationId: 'inst-a',
      requestId: 'req-a',
      subjectId: 'sub-a',
      action: 'read',
      resourceType: 'doc',
      resourceId: 'doc-a',
      attributes: { level: 3 },
    }
  ),
  syncRow(
    'runFlowHook',
    ['ar-auth', 'ar-management'],
    {
      tenantId: 'tenant-a',
      pluginInstallationId: 'inst-a',
      requestId: 'req-a',
      flowId: 'flow-a',
      hookName: 'before-login',
      stateVersion: 2,
    },
    {
      tenantId: 'tenant-a',
      pluginInstallationId: 'inst-a',
      requestId: 'req-a',
      flowId: 'flow-a',
      hookName: 'before-login',
      stateVersion: 2,
    }
  ),
  {
    method: 'deliverNotification',
    allowed: ['ar-auth', 'ar-management'],
    input: {
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      outboxId: 'outbox-a',
      pluginInstallationId: 'inst-a',
      bindingRef: 'TEST_TDB_CORE_A',
    },
    expected: [
      { call: 'ImmediateNotificationDeliveryService.new', args: expect.anything() as never },
      {
        call: 'ImmediateNotificationDeliveryService.deliver',
        args: [
          {
            tenantId: 'tenant-a',
            intentId: 'intent-a',
            outboxId: 'outbox-a',
            pluginInstallationId: 'inst-a',
            bindingRef: 'TEST_TDB_CORE_A',
          },
        ],
      },
    ],
    result: 'ImmediateNotificationDeliveryService.deliver:result',
  },
  {
    method: 'replacePluginCredentials',
    allowed: MGMT,
    input: { k: 1 },
    expected: [
      { call: 'pluginEncryptionKeyringFromEnv', args: [ENV] },
      { call: 'D1PluginConfigStore.new', args: [DB, KEYRING, 'hmac-key'] },
      { call: 'D1PluginConfigStore.replaceCredentials', args: [{ k: 1 }] },
    ],
    result: 'D1PluginConfigStore.replaceCredentials:result',
  },
  {
    method: 'configureNotificationInstallation',
    allowed: MGMT,
    input: { k: 2 },
    expected: [
      { call: 'D1NotificationInstallationStore.new', args: [DB] },
      { call: 'D1NotificationInstallationStore.configure', args: [{ k: 2 }] },
    ],
    result: 'D1NotificationInstallationStore.configure:result',
  },
  {
    method: 'configureHumanVerificationInstallation',
    allowed: MGMT,
    input: { k: 3 },
    expected: [
      { call: 'pluginEncryptionKeyringFromEnv', args: [ENV] },
      { call: 'D1HumanVerificationInstallationStore.new', args: [DB, KEYRING, 'hmac-key'] },
      { call: 'D1HumanVerificationInstallationStore.configure', args: [{ k: 3 }] },
    ],
    result: 'D1HumanVerificationInstallationStore.configure:result',
  },
  withMethod('configureDynamicPluginInstallation', dyn('configure', [{ k: 4 }], { k: 4 })),
  withMethod('stageDynamicPluginActivation', dyn('stageActivation', [{ k: 5 }], { k: 5 })),
  withMethod('rolloutDynamicPluginInstallation', dyn('rollout', [{ k: 6 }], { k: 6 })),
  withMethod('rolloutDynamicPluginBatch', dyn('rolloutBatch', [{ k: 7 }], { k: 7 })),
  withMethod('listApprovedDynamicPlugins', dyn('listApproved', [], undefined)),
  withMethod('getDynamicPluginInstallationStatus', dyn('status', [{ k: 8 }], { k: 8 })),
  {
    method: 'exportDynamicPluginBackup',
    allowed: MGMT,
    input: { k: 9 },
    expected: [
      { call: 'DynamicPluginTenantBackupService.new', args: [ENV] },
      { call: 'DynamicPluginTenantBackupService.export', args: [{ k: 9 }] },
    ],
    result: 'DynamicPluginTenantBackupService.export:result',
  },
  {
    method: 'restoreDynamicPluginBackup',
    allowed: MGMT,
    input: { k: 10 },
    expected: [
      { call: 'DynamicPluginTenantBackupService.new', args: [ENV] },
      { call: 'DynamicPluginTenantBackupService.restore', args: [{ k: 10 }] },
    ],
    result: 'DynamicPluginTenantBackupService.restore:result',
  },
  {
    method: 'verifyDynamicPluginBackup',
    allowed: MGMT,
    input: { k: 11 },
    expected: [
      { call: 'DynamicPluginTenantBackupService.new', args: [ENV] },
      { call: 'DynamicPluginTenantBackupService.verify', args: [{ k: 11 }] },
    ],
    result: 'DynamicPluginTenantBackupService.verify:result',
  },
  {
    method: 'replaceNotificationProviderOrder',
    allowed: MGMT,
    input: { k: 12 },
    expected: [
      { call: 'D1NotificationProviderOrderStore.new', args: [DB] },
      { call: 'D1NotificationProviderOrderStore.replace', args: [{ k: 12 }] },
    ],
    result: 'D1NotificationProviderOrderStore.replace:result',
  },
  {
    method: 'resolveNotificationProviderOrder',
    allowed: ['ar-auth', 'ar-management'],
    input: { tenantId: 'tenant-a', channel: 'sms' },
    expected: [
      { call: 'D1NotificationProviderOrderStore.new', args: [DB] },
      {
        call: 'D1NotificationProviderOrderStore.resolve',
        args: [{ tenantId: 'tenant-a', channel: 'sms' }],
      },
    ],
    result: 'D1NotificationProviderOrderStore.resolve:result',
  },
  {
    method: 'encryptNotificationPayload',
    allowed: ['ar-auth', 'ar-management'],
    input: { k: 13 },
    expected: [{ call: 'encryptNotificationPayloadFromEnv', args: [ENV, { k: 13 }] }],
    result: 'encryptNotificationPayloadFromEnv:result',
  },
  {
    method: 'resolveAccountEventInstallations',
    allowed: MGMT,
    input: { tenantId: 'tenant-a', eventType: 'account.created' },
    expected: [
      { call: 'D1AccountEventInstallationResolver.new', args: [DB] },
      {
        call: 'D1AccountEventInstallationResolver.resolve',
        args: [{ tenantId: 'tenant-a', eventType: 'account.created' }],
      },
    ],
    result: 'D1AccountEventInstallationResolver.resolve:result',
  },
  {
    method: 'setTenantExternalGate',
    allowed: MGMT,
    input: { tenantId: 'tenant-a', allowed: true, ifGeneration: 4 },
    expected: [
      { call: 'D1TenantExternalGateStore.new', args: [DB] },
      {
        call: 'D1TenantExternalGateStore.set',
        args: [{ tenantId: 'tenant-a', allowed: true, ifGeneration: 4 }],
      },
    ],
    result: 'D1TenantExternalGateStore.set:result',
  },
  {
    method: 'listTenantExternalGateCandidates',
    allowed: MGMT,
    input: { limit: 7, after: 'tenant-z' },
    expected: [
      { call: 'D1TenantExternalGateStore.new', args: [DB] },
      {
        call: 'D1TenantExternalGateStore.listCandidates',
        args: [{ limit: 7, after: 'tenant-z' }],
      },
    ],
    result: 'D1TenantExternalGateStore.listCandidates:result',
  },
  {
    method: 'getTenantExternalGate',
    allowed: MGMT,
    input: { tenantId: 'tenant-a' },
    expected: [
      { call: 'D1TenantExternalGateStore.new', args: [DB] },
      { call: 'D1TenantExternalGateStore.get', args: ['tenant-a'] },
    ],
    result: 'D1TenantExternalGateStore.get:result',
  },
  {
    method: 'startPluginCredentialRotation',
    allowed: MGMT,
    input: { operationId: 'op-1' },
    expected: [
      { call: 'pluginEncryptionKeyringFromEnv', args: [ENV] },
      { call: 'D1PluginConfigReencryptor.new', args: [DB, KEYRING] },
      { call: 'D1PluginConfigReencryptor.start', args: ['op-1'] },
    ],
    result: 'D1PluginConfigReencryptor.start:result',
  },
];

beforeEach(() => {
  resetKit();
});

describe('PluginRunnerWorker RPC routing', () => {
  const cases = ROWS.flatMap((row) => CALLERS.map((caller) => ({ row, caller })));
  it.each(cases)('$row.method for $caller', async ({ row, caller }) => {
    const rpc = as(caller);
    const fn = (input: unknown) => invoke(rpc, row.method, input);
    if (!row.allowed.includes(caller)) {
      await expect(fn(row.input)).rejects.toThrow(/^plugin_sync_caller_unauthorized$/u);
      expect(log).toEqual([]);
      return;
    }
    await expect(fn(row.input)).resolves.toBe(row.result);
    expect(log.map((entry) => entry.call)).toEqual(row.expected.map((entry) => entry.call));
    row.expected.forEach((entry, index) => {
      if (entry.args === (expect.anything() as unknown)) return;
      expect(must(log[index]).args).toEqual(entry.args);
    });
  });

  it('wires the sync hook service from the environment bindings', async () => {
    await invoke(as('ar-auth'), 'runHumanVerification', HV);
    expect(callsTo('D1PluginInstallationResolver.new')).toEqual([[DB]]);
    expect(callsTo('R2PluginWorkerCodeResolver.new')).toEqual([[ENV.PLUGIN_BUNDLES]]);
    expect(callsTo('createBuiltinHumanVerificationRegistry')).toEqual([[ENV]]);
    const backend = must(callsTo('DynamicWorkerSyncHookBackend.new')[0]);
    expect(backend[0]).toBe(ENV.PLUGIN_LOADER);
    expect(backend).toHaveLength(5);
    const router = must(callsTo('SyncHookBackendRouter.new')[0]);
    expect(router[1]).toBe('createBuiltinHumanVerificationRegistry:result');
    const service = must(callsTo('SyncHookService.new')[0]);
    expect(service[0]).toBe(DB);
  });

  it('hands the sync hook backend a loopback outbound and host interface factory', async () => {
    await invoke(as('ar-auth'), 'runFlowHook', {
      tenantId: 'tenant-a',
      pluginInstallationId: 'inst-a',
      requestId: 'req-a',
      flowId: 'flow-a',
      hookName: 'before-login',
      stateVersion: 1,
    });
    const backend = must(callsTo('DynamicWorkerSyncHookBackend.new')[0]);
    const outbound = must(backend[3]) as (context: unknown) => unknown;
    const hostInterfaces = must(backend[4]) as (...args: unknown[]) => unknown;
    expect(outbound({ tenantId: 'tenant-a' })).toBe('outbound-fetcher');
    expect(
      hostInterfaces({ tenantId: 'tenant-a', pluginInstallationId: 'i' }, [], [], 'p')
    ).toEqual({});
  });
});

describe('PluginRunnerWorker authorization', () => {
  const valid = {
    caller: 'ar-management',
    environmentId: 'test',
    audience: 'authrim-plugin-runner-v1',
  };
  const input = { tenantId: 'tenant-a' };
  it.each([
    ['missing props', undefined],
    ['unknown caller', { ...valid, caller: 'ar-other' }],
    ['wrong audience', { ...valid, audience: 'authrim-plugin-runner-v2' }],
    ['other environment', { ...valid, environmentId: 'prod' }],
    ['unsafe environment id', { ...valid, environmentId: '-bad' }],
  ])('rejects %s', async (_label, props) => {
    const env =
      _label === 'unsafe environment id' ? { ...ENV, AUTHRIM_ENVIRONMENT_NAME: '-bad' } : ENV;
    await expect(invoke(worker(props, env), 'getTenantExternalGate', input)).rejects.toThrow(
      /^plugin_sync_caller_unauthorized$/u
    );
    expect(log).toEqual([]);
  });

  it('accepts matching props', async () => {
    await expect(invoke(worker(valid), 'getTenantExternalGate', input)).resolves.toBe(
      'D1TenantExternalGateStore.get:result'
    );
  });
});

describe('PluginRunnerWorker error exposure', () => {
  const rpc = () => as('ar-management');
  it.each([
    'plugin_sync_x',
    'plugin_config_input_invalid',
    'plugin_notification_a1',
    'plugin_dynamic_conflict_9',
  ])('exposes the fixed code %s as a fresh error', async (message) => {
    const original = new Error(message);
    outcomes.set('D1TenantExternalGateStore.get', original);
    const failure = await invoke(rpc(), 'getTenantExternalGate', { tenantId: 'tenant-a' }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(original);
    expect((failure as Error).message).toBe(message);
  });

  it.each([
    'plugin_other_x',
    'plugin_sync_',
    'plugin_sync_UPPER',
    'xplugin_sync_a',
    'plugin_sync_a\nsecret',
    '\nplugin_sync_a',
    'plugin_sync_a-b',
    'database password leaked',
  ])('hides %j behind plugin_sync_internal_error', async (message) => {
    outcomes.set('D1TenantExternalGateStore.get', new Error(message));
    await expect(invoke(rpc(), 'getTenantExternalGate', { tenantId: 'tenant-a' })).rejects.toThrow(
      /^plugin_sync_internal_error$/u
    );
  });

  it('hides non-Error rejections even when they look like a fixed code', async () => {
    outcomes.set('D1TenantExternalGateStore.get', () => rejectOpaque('plugin_sync_x'));
    await expect(invoke(rpc(), 'getTenantExternalGate', { tenantId: 'tenant-a' })).rejects.toThrow(
      /^plugin_sync_internal_error$/u
    );
    outcomes.set('D1TenantExternalGateStore.get', () => rejectOpaque({ message: 'plugin_sync_x' }));
    await expect(invoke(rpc(), 'getTenantExternalGate', { tenantId: 'tenant-a' })).rejects.toThrow(
      /^plugin_sync_internal_error$/u
    );
  });

  it('applies the same masking to covered operations', async () => {
    outcomes.set('D1PluginConfigStore.replaceCredentials', new Error('boom'));
    await expect(invoke(rpc(), 'replacePluginCredentials', {})).rejects.toThrow(
      /^plugin_sync_internal_error$/u
    );
  });
});
