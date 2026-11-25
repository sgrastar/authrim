import { beforeEach, describe, expect, it, vi } from 'vitest';
import PluginRunnerWorker from '../worker';
import { rejectOpaque, callsTo, must, outcomes, resetKit } from './helpers/mock-kit';

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
function as(caller: string): Rpc {
  return new PluginRunnerWorker(
    {
      props: { caller, environmentId: 'test', audience: 'authrim-plugin-runner-v1' },
      exports: {},
    } as never,
    ENV as never
  ) as unknown as Rpc;
}
function invoke(caller: string, method: string, input?: unknown): Promise<unknown> {
  const rpc = as(caller);
  return must(rpc[method]).call(rpc, input);
}
const INVALID = 'plugin_sync_input_invalid';

beforeEach(() => {
  resetKit();
});

const HV = {
  tenantId: 'tenant-a',
  pluginInstallationId: 'inst-a',
  requestId: 'req-a',
  action: 'login',
  responseToken: 'tok',
};

describe('human verification input', () => {
  const run = (input: unknown) => invoke('ar-auth', 'runHumanVerification', input);
  it('forwards exactly the validated fields, omitting an absent remote address', async () => {
    await run({ ...HV, action: 'signup' });
    expect(callsTo('SyncHookService.runHumanVerification')).toEqual([
      [{ ...HV, action: 'signup' }],
    ]);
    const forwarded = must(callsTo('SyncHookService.runHumanVerification')[0])[0] as object;
    expect(Object.keys(forwarded).sort()).toEqual(Object.keys(HV).sort());
  });
  it('forwards a valid remote address unchanged', async () => {
    await run({ ...HV, remoteIp: '10.0.0.1' });
    expect(callsTo('SyncHookService.runHumanVerification')).toEqual([
      [{ ...HV, remoteIp: '10.0.0.1' }],
    ]);
  });
  it.each(['login', 'signup', 'reauth'])('accepts action %s', async (action) => {
    await run({ ...HV, action });
    expect(callsTo('SyncHookService.runHumanVerification')).toHaveLength(1);
  });
  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['missing token', { ...HV, responseToken: undefined }],
    ['extra key', { ...HV, extra: 1 }],
    ['unknown action', { ...HV, action: 'admin' }],
    ['numeric action', { ...HV, action: 1 }],
    ['an array action that stringifies to a valid one', { ...HV, action: ['login'] }],
    ['an object action', { ...HV, action: { toString: () => 'login' } }],
    ['empty token', { ...HV, responseToken: '' }],
    ['token too long', { ...HV, responseToken: 'a'.repeat(4097) }],
    ['numeric token', { ...HV, responseToken: 7 }],
    ['unsafe tenant', { ...HV, tenantId: '-a' }],
    ['unsafe installation', { ...HV, pluginInstallationId: 'a b' }],
    ['unsafe request', { ...HV, requestId: '' }],
    ['tenant too long', { ...HV, tenantId: 'a'.repeat(257) }],
    ['undefined remote key', { ...HV, remoteIp: undefined }],
  ])('rejects %s', async (_label, input) => {
    await expect(run(input)).rejects.toThrow(new RegExp(`^${INVALID}$`, 'u'));
    expect(callsTo('SyncHookService.runHumanVerification')).toEqual([]);
  });
  it('accepts a 256-character identifier', async () => {
    await run({ ...HV, tenantId: 'a'.repeat(256) });
    expect(callsTo('SyncHookService.runHumanVerification')).toHaveLength(1);
  });
  it('accepts a token of exactly 4096 characters and a single character', async () => {
    await run({ ...HV, responseToken: 'a'.repeat(4096) });
    await run({ ...HV, responseToken: 'a' });
    expect(callsTo('SyncHookService.runHumanVerification')).toHaveLength(2);
  });
  it.each([
    '0.0.0.0',
    '255.255.255.255',
    '1.2.3.4',
    '10.20.30.40',
    '100.200.99.9',
    '::1',
    '2001:db8::1',
    'ABCD:EF01::2',
    '1111:2222:3333:4444:5555:6666:7777:8888',
    '::ffff:1.2.3.4',
    '::ffff:255.255.255.255',
    '64:ff9b::10.0.0.1',
  ])('accepts remote address %s', async (remoteIp) => {
    await run({ ...HV, remoteIp });
    expect(callsTo('SyncHookService.runHumanVerification')).toEqual([[{ ...HV, remoteIp }]]);
  });
  it.each([
    '',
    1234,
    null,
    '256.0.0.1',
    '1.2.3.256',
    '01.2.3.4',
    '1.2.3.',
    '.1.2.3',
    '1.2.3.4.5',
    '1.2.3',
    '1.2.3.1000',
    '1.2.3.a',
    'abcd',
    '12345',
    'host.example',
    '1.2.3.4 ',
    '::g',
    '1:2:3:4:5:6:7:8:9',
    ':::',
    '1.2.3.-1',
    '::ffff:1.2.3.256',
    '::ffff:1.2.3',
    '::ffff:1.2.3.4.5',
    '1.2.3.4:80',
    ':1.2.3.4',
    '::ffff:01.2.3.4',
  ])('rejects remote address %j', async (remoteIp) => {
    await expect(run({ ...HV, remoteIp })).rejects.toThrow(new RegExp(`^${INVALID}$`, 'u'));
    expect(callsTo('SyncHookService.runHumanVerification')).toEqual([]);
  });
});

describe('policy decision input', () => {
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
  const run = (input: unknown) => invoke('ar-policy', 'runPolicyDecision', input);
  const attrs = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, i]));
  it('forwards mixed attribute types', async () => {
    const attributes = {
      flag: false,
      count: 0,
      ratio: -1.5,
      text: 'x'.repeat(256),
      'a.b:c-d_e': true,
    };
    await run({ ...POLICY, attributes });
    expect(callsTo('SyncHookService.runPolicyDecision')).toEqual([[{ ...POLICY, attributes }]]);
  });
  it('accepts exactly 16 attributes', async () => {
    await run({ ...POLICY, attributes: attrs(16) });
    expect(callsTo('SyncHookService.runPolicyDecision')).toHaveLength(1);
  });
  it.each([
    ['null input', null],
    ['missing attributes', { ...POLICY, attributes: undefined }],
    ['extra key', { ...POLICY, extra: 1 }],
    ['attributes null', { ...POLICY, attributes: null }],
    ['attributes array', { ...POLICY, attributes: [] }],
    ['attributes string', { ...POLICY, attributes: 'x' }],
    ['17 attributes', { ...POLICY, attributes: attrs(17) }],
    ['uppercase attribute key', { ...POLICY, attributes: { Bad: 1 } }],
    ['attribute key starts with digit', { ...POLICY, attributes: { '1a': 1 } }],
    ['attribute key too long', { ...POLICY, attributes: { ['a'.repeat(129)]: 1 } }],
    ['NaN attribute', { ...POLICY, attributes: { a: Number.NaN } }],
    ['infinite attribute', { ...POLICY, attributes: { a: Number.POSITIVE_INFINITY } }],
    ['string attribute too long', { ...POLICY, attributes: { a: 'x'.repeat(257) } }],
    ['null attribute', { ...POLICY, attributes: { a: null } }],
    ['object attribute', { ...POLICY, attributes: { a: {} } }],
    ['bigint attribute', { ...POLICY, attributes: { a: 1n } }],
    ['uppercase action', { ...POLICY, action: 'Read' }],
    ['action with space', { ...POLICY, action: 'read it' }],
    ['uppercase resource type', { ...POLICY, resourceType: 'Doc' }],
    ['empty resource type', { ...POLICY, resourceType: '' }],
    ['numeric action', { ...POLICY, action: 5 }],
    ['unsafe subject', { ...POLICY, subjectId: '.x' }],
    ['unsafe resource id', { ...POLICY, resourceId: '' }],
    ['unsafe tenant', { ...POLICY, tenantId: '' }],
    ['unsafe request', { ...POLICY, requestId: 'a/b' }],
    ['unsafe installation', { ...POLICY, pluginInstallationId: '_a' }],
  ])('rejects %s', async (_label, input) => {
    await expect(run(input)).rejects.toThrow(new RegExp(`^${INVALID}$`, 'u'));
    expect(callsTo('SyncHookService.runPolicyDecision')).toEqual([]);
  });
  it('accepts a 128-character name and rejects 129', async () => {
    await run({ ...POLICY, action: `a${'b'.repeat(127)}` });
    expect(callsTo('SyncHookService.runPolicyDecision')).toHaveLength(1);
    await expect(run({ ...POLICY, action: `a${'b'.repeat(128)}` })).rejects.toThrow(INVALID);
  });
});

describe('flow hook input', () => {
  const FLOW = {
    tenantId: 'tenant-a',
    pluginInstallationId: 'inst-a',
    requestId: 'req-a',
    flowId: 'flow-a',
    hookName: 'before-login',
    stateVersion: 1,
  };
  const run = (input: unknown) => invoke('ar-auth', 'runFlowHook', input);
  it('forwards an optional account id', async () => {
    await run({ ...FLOW, accountId: 'acc-a', stateVersion: Number.MAX_SAFE_INTEGER });
    expect(callsTo('SyncHookService.runFlowHook')).toEqual([
      [{ ...FLOW, accountId: 'acc-a', stateVersion: Number.MAX_SAFE_INTEGER }],
    ]);
  });
  it('omits the account id when absent', async () => {
    await run(FLOW);
    const forwarded = must(callsTo('SyncHookService.runFlowHook')[0])[0] as object;
    expect(Object.keys(forwarded).sort()).toEqual(Object.keys(FLOW).sort());
  });
  it.each([
    ['null', null],
    ['array', []],
    ['zero version', { ...FLOW, stateVersion: 0 }],
    ['negative version', { ...FLOW, stateVersion: -1 }],
    ['fractional version', { ...FLOW, stateVersion: 1.5 }],
    ['string version', { ...FLOW, stateVersion: '1' }],
    ['unsafe integer version', { ...FLOW, stateVersion: 2 ** 53 }],
    ['missing version', { ...FLOW, stateVersion: undefined }],
    ['extra key', { ...FLOW, extra: 1 }],
    ['bad hook name', { ...FLOW, hookName: 'Before' }],
    ['bad flow id', { ...FLOW, flowId: '' }],
    ['bad account id', { ...FLOW, accountId: '-x' }],
    ['undefined account key', { ...FLOW, accountId: undefined }],
    ['bad tenant', { ...FLOW, tenantId: '-x' }],
    ['bad installation', { ...FLOW, pluginInstallationId: '-x' }],
    ['bad request', { ...FLOW, requestId: '-x' }],
  ])('rejects %s', async (_label, input) => {
    await expect(run(input)).rejects.toThrow(new RegExp(`^${INVALID}$`, 'u'));
    expect(callsTo('SyncHookService.runFlowHook')).toEqual([]);
  });
});

describe('notification delivery input', () => {
  const DELIVERY = {
    tenantId: 'tenant-a',
    intentId: 'intent-a',
    outboxId: 'outbox-a',
    pluginInstallationId: 'inst-a',
    bindingRef: 'TEST_TDB_CORE_A',
  };
  const run = (input: unknown, caller = 'ar-auth') => invoke(caller, 'deliverNotification', input);
  it.each(['A_TDB_B', 'A1_TDB_9', `A_TDB_${'B'.repeat(120)}`, 'X_Y_TDB__'])(
    'accepts binding %s',
    async (bindingRef) => {
      await run({ ...DELIVERY, bindingRef });
      expect(callsTo('ImmediateNotificationDeliveryService.deliver')).toEqual([
        [{ ...DELIVERY, bindingRef }],
      ]);
    }
  );
  it.each([
    'a_TDB_B',
    'A_TDB_',
    'A_tdb_B',
    '1A_TDB_B',
    `A_TDB_${'B'.repeat(121)}`,
    'A_TDB_b',
    'TDB_B',
    'A_TDB_B\n',
    'xA_TDB_B ',
    '_A_TDB_B',
    7,
  ])('rejects binding %j with the notification code', async (bindingRef) => {
    await expect(run({ ...DELIVERY, bindingRef })).rejects.toThrow(
      /^plugin_notification_input_invalid$/u
    );
    expect(callsTo('ImmediateNotificationDeliveryService.deliver')).toEqual([]);
  });
  it.each([
    ['null', null],
    ['extra key', { ...DELIVERY, extra: 1 }],
    ['bad tenant', { ...DELIVERY, tenantId: '' }],
    ['bad intent', { ...DELIVERY, intentId: '-i' }],
    ['bad outbox', { ...DELIVERY, outboxId: ' ' }],
    ['bad installation', { ...DELIVERY, pluginInstallationId: '' }],
  ])('rejects %s with the sync code', async (_label, input) => {
    await expect(run(input)).rejects.toThrow(new RegExp(`^${INVALID}$`, 'u'));
  });
  it('answers pending whenever delivery fails, whatever the reason', async () => {
    outcomes.set('ImmediateNotificationDeliveryService.deliver', new Error('plugin_sync_x'));
    await expect(run(DELIVERY)).resolves.toBe('pending');
    outcomes.set('ImmediateNotificationDeliveryService.deliver', () => rejectOpaque('plain'));
    await expect(run(DELIVERY, 'ar-management')).resolves.toBe('pending');
  });
  it.each(['delivered', 'pending', 'permanent_failure'])('relays %s', async (verdict) => {
    outcomes.set('ImmediateNotificationDeliveryService.deliver', verdict);
    await expect(run(DELIVERY)).resolves.toBe(verdict);
  });
});

describe('provider order and account event input', () => {
  it.each(['email', 'sms', 'push'])('accepts channel %s', async (channel) => {
    await invoke('ar-auth', 'resolveNotificationProviderOrder', { tenantId: 'tenant-a', channel });
    expect(callsTo('D1NotificationProviderOrderStore.resolve')).toEqual([
      [{ tenantId: 'tenant-a', channel }],
    ]);
  });
  it.each([
    ['unknown channel', { tenantId: 'tenant-a', channel: 'fax' }],
    ['numeric channel', { tenantId: 'tenant-a', channel: 1 }],
    [
      'an array channel that stringifies to a valid one',
      { tenantId: 'tenant-a', channel: ['email'] },
    ],
  ])('rejects %s with the provider-order code', async (_label, input) => {
    await expect(invoke('ar-auth', 'resolveNotificationProviderOrder', input)).rejects.toThrow(
      /^plugin_notification_provider_order_input_invalid$/u
    );
  });
  it('rejects a bad tenant and extra keys with the sync code', async () => {
    for (const input of [
      { tenantId: '', channel: 'email' },
      { tenantId: 'tenant-a' },
      { tenantId: 'tenant-a', channel: 'email', extra: 1 },
      null,
    ]) {
      await expect(invoke('ar-auth', 'resolveNotificationProviderOrder', input)).rejects.toThrow(
        new RegExp(`^${INVALID}$`, 'u')
      );
    }
  });
  it('accepts only account.created for account event installations', async () => {
    for (const eventType of ['account.deleted', 'ACCOUNT.CREATED', undefined, 1]) {
      await expect(
        invoke('ar-management', 'resolveAccountEventInstallations', {
          tenantId: 'tenant-a',
          eventType,
        })
      ).rejects.toThrow(/^plugin_sync_account_event_input_invalid$/u);
    }
    await expect(
      invoke('ar-management', 'resolveAccountEventInstallations', {
        tenantId: '',
        eventType: 'account.created',
      })
    ).rejects.toThrow(new RegExp(`^${INVALID}$`, 'u'));
    expect(callsTo('D1AccountEventInstallationResolver.resolve')).toEqual([]);
  });
});

describe('tenant external gate input', () => {
  const GATE_INVALID = /^plugin_dynamic_external_gate_input_invalid$/u;
  const set = (input: unknown) => invoke('ar-management', 'setTenantExternalGate', input);
  const list = (input: unknown) =>
    invoke('ar-management', 'listTenantExternalGateCandidates', input);
  it('opens naming the generation read, accepting zero', async () => {
    await set({ tenantId: 'tenant-a', allowed: true, ifGeneration: 0 });
    expect(callsTo('D1TenantExternalGateStore.set')).toEqual([
      [{ tenantId: 'tenant-a', allowed: true, ifGeneration: 0 }],
    ]);
  });
  it('closes without any generation', async () => {
    await set({ tenantId: 'tenant-a', allowed: false });
    const forwarded = must(callsTo('D1TenantExternalGateStore.set')[0])[0] as object;
    expect(forwarded).toEqual({ tenantId: 'tenant-a', allowed: false });
    expect(Object.keys(forwarded)).toEqual(['tenantId', 'allowed']);
  });
  it.each([
    ['null', null, INVALID],
    ['undefined', undefined, INVALID],
    ['open without generation', { tenantId: 'tenant-a', allowed: true }, GATE_INVALID.source],
    ['non-boolean allowed', { tenantId: 'tenant-a', allowed: 'true' }, GATE_INVALID.source],
    [
      'negative generation',
      { tenantId: 'tenant-a', allowed: true, ifGeneration: -1 },
      GATE_INVALID.source,
    ],
    [
      'fractional generation',
      { tenantId: 'tenant-a', allowed: true, ifGeneration: 0.5 },
      GATE_INVALID.source,
    ],
    [
      'string generation',
      { tenantId: 'tenant-a', allowed: true, ifGeneration: '1' },
      GATE_INVALID.source,
    ],
    [
      'close with generation',
      { tenantId: 'tenant-a', allowed: false, ifGeneration: 0 },
      GATE_INVALID.source,
    ],
    ['extra key', { tenantId: 'tenant-a', allowed: false, extra: 1 }, INVALID],
    ['bad tenant', { tenantId: '../x', allowed: false }, INVALID],
  ])('rejects %s', async (_label, input, code) => {
    await expect(set(input)).rejects.toThrow(new RegExp(`^${code.replace(/^\^|\$$/gu, '')}$`, 'u'));
    expect(callsTo('D1TenantExternalGateStore.set')).toEqual([]);
  });
  it('lists with defaults and forwards limit and cursor', async () => {
    await list({});
    await list({ limit: 200 });
    await list({ after: null });
    await list({ limit: 1, after: 'tenant-b' });
    expect(callsTo('D1TenantExternalGateStore.listCandidates')).toEqual([
      [{ after: null }],
      [{ limit: 200, after: null }],
      [{ after: null }],
      [{ limit: 1, after: 'tenant-b' }],
    ]);
    const first = must(callsTo('D1TenantExternalGateStore.listCandidates')[0])[0] as object;
    expect(Object.keys(first)).toEqual(['after']);
  });
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['string limit', { limit: '5' }],
    ['fractional limit', { limit: 1.5 }],
    ['numeric cursor', { after: 5 }],
    ['unknown key', { limit: 5, tenantId: 'tenant-a' }],
  ])('rejects %s when listing candidates', async (_label, input) => {
    await expect(list(input)).rejects.toThrow(
      new RegExp(`^${INVALID}$|^${GATE_INVALID.source.slice(1, -1)}$`, 'u')
    );
    expect(callsTo('D1TenantExternalGateStore.listCandidates')).toEqual([]);
  });
  it('rejects bad gate lookups and rotation operations before the store', async () => {
    await expect(
      invoke('ar-management', 'getTenantExternalGate', { tenantId: '-x' })
    ).rejects.toThrow(INVALID);
    await expect(invoke('ar-management', 'getTenantExternalGate', {})).rejects.toThrow(INVALID);
    await expect(
      invoke('ar-management', 'startPluginCredentialRotation', { operationId: '' })
    ).rejects.toThrow(INVALID);
    await expect(
      invoke('ar-management', 'startPluginCredentialRotation', { operationId: 'a', x: 1 })
    ).rejects.toThrow(INVALID);
    await expect(invoke('ar-management', 'startPluginCredentialRotation', null)).rejects.toThrow(
      INVALID
    );
    expect(callsTo('D1TenantExternalGateStore.get')).toEqual([]);
    expect(callsTo('D1PluginConfigReencryptor.start')).toEqual([]);
  });
});
