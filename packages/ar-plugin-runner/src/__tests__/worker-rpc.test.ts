import { describe, expect, it, vi } from 'vitest';
import PluginRunnerWorker from '../worker';
import type { PluginEgressContext } from '../types';
import type {
  PluginResourceBindingDescriptor,
  PluginResourceBindingProps,
} from '../resource-bindings';

function worker(
  caller: 'ar-auth' | 'ar-bridge' | 'ar-management' | 'ar-policy' | 'ar-saml',
  environmentId = 'test'
) {
  return new PluginRunnerWorker(
    {
      props: { caller, environmentId, audience: 'authrim-plugin-runner-v1' },
    } as ConstructorParameters<typeof PluginRunnerWorker>[0],
    {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      PLUGIN_RUNNER_DB: {} as D1Database,
      PLUGIN_LOADER: {} as never,
      PLUGIN_ENCRYPTION_KEY: 'plugin-runner-test-encryption-secret',
      PLUGIN_MUTATION_HMAC_KEY: 'plugin-runner-test-mutation-hmac-secret',
    } as unknown as ConstructorParameters<typeof PluginRunnerWorker>[1]
  );
}

describe('PluginRunnerWorker RPC boundary', () => {
  it('has no public HTTP operation surface', () => {
    const response = worker('ar-auth').fetch(new Request('https://internal.invalid/'));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('injects dedicated resources through loopback wrappers without provider identifiers', () => {
    const d1Access = vi.fn((_options: { props: PluginResourceBindingProps }) => ({
      all: vi.fn(),
      run: vi.fn(),
    }));
    const kvAccess = vi.fn(() => ({ get: vi.fn() }));
    const r2Access = vi.fn(() => ({ get: vi.fn() }));
    const runtime = new PluginRunnerWorker(
      {
        props: {
          caller: 'ar-management',
          environmentId: 'test',
          audience: 'authrim-plugin-runner-v1',
        },
        exports: {
          PluginAccountMetadataAccess: vi.fn(),
          PluginD1ResourceAccess: d1Access,
          PluginKvResourceAccess: kvAccess,
          PluginR2ResourceAccess: r2Access,
        },
      } as unknown as ConstructorParameters<typeof PluginRunnerWorker>[0],
      {
        AUTHRIM_ENVIRONMENT_NAME: 'test',
        PLUGIN_RUNNER_DB: {} as D1Database,
      } as unknown as ConstructorParameters<typeof PluginRunnerWorker>[1]
    );
    const context: PluginEgressContext = {
      contractVersion: 1,
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      capability: 'flow.evaluate',
      requestId: 'scope:a',
    };
    const resources: PluginResourceBindingDescriptor[] = [
      {
        logicalResourceId: 'state',
        binding: 'PLUGIN_STATE',
        hostBindingRef: `PRES_D1_${'A'.repeat(24)}`,
        kind: 'd1',
        access: 'read_write',
        ownershipFingerprint: 'a'.repeat(64),
      },
      {
        logicalResourceId: 'cache',
        binding: 'PLUGIN_CACHE',
        hostBindingRef: `PRES_KV_${'B'.repeat(24)}`,
        kind: 'kv_namespace',
        access: 'read_only',
        ownershipFingerprint: 'b'.repeat(64),
      },
      {
        logicalResourceId: 'objects',
        binding: 'PLUGIN_OBJECTS',
        hostBindingRef: `PRES_R2_${'C'.repeat(24)}`,
        kind: 'r2_bucket',
        access: 'read_write',
        ownershipFingerprint: 'c'.repeat(64),
      },
    ];
    const factory = runtime as unknown as {
      dynamicHostInterfaces(
        context: PluginEgressContext,
        bindings: [],
        resources: PluginResourceBindingDescriptor[],
        pluginId: string
      ): Record<string, unknown>;
    };

    const interfaces = factory.dynamicHostInterfaces(context, [], resources, 'plugin-a');
    expect(Object.keys(interfaces).sort()).toEqual([
      'PLUGIN_CACHE',
      'PLUGIN_OBJECTS',
      'PLUGIN_STATE',
    ]);
    expect(typeof (interfaces.PLUGIN_STATE as { all?: unknown }).all).toBe('function');
    expect(typeof (interfaces.PLUGIN_CACHE as { get?: unknown }).get).toBe('function');
    expect(typeof (interfaces.PLUGIN_OBJECTS as { get?: unknown }).get).toBe('function');
    expect(d1Access.mock.calls[0]?.[0]).toMatchObject({
      props: {
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        installationId: 'installation-a',
        hostBindingRef: `PRES_D1_${'A'.repeat(24)}`,
      },
    });
    expect(JSON.stringify(d1Access.mock.calls)).not.toContain('database_id');
  });

  it('rejects a caller outside the capability-specific RPC allowlist before D1 access', async () => {
    await expect(
      worker('ar-policy').runHumanVerification({
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        requestId: 'request-a',
        action: 'login',
        responseToken: 'token',
      })
    ).rejects.toThrow('plugin_sync_caller_unauthorized');
    await expect(
      worker('ar-auth').runPolicyDecision({
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        requestId: 'request-a',
        subjectId: 'account-a',
        action: 'read',
        resourceType: 'document',
        resourceId: 'document-a',
        attributes: {},
      })
    ).rejects.toThrow('plugin_sync_caller_unauthorized');
  });

  it('rejects cross-environment props and unknown input fields', async () => {
    await expect(
      worker('ar-auth', 'other').runHumanVerification({
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        requestId: 'request-a',
        action: 'login',
        responseToken: 'token',
      })
    ).rejects.toThrow('plugin_sync_caller_unauthorized');
    await expect(
      worker('ar-auth').runHumanVerification({
        tenantId: 'tenant-a',
        pluginInstallationId: 'installation-a',
        requestId: 'request-a',
        action: 'login',
        responseToken: 'token',
        arbitraryCapability: 'cloudflare.admin',
      })
    ).rejects.toThrow('plugin_sync_input_invalid');
  });

  it('accepts the runtime reauth action and rejects non-contract action names', async () => {
    const base = {
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      requestId: 'request-a',
      responseToken: 'token',
    };
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, action: 'reauth' })
    ).resolves.toEqual({ decision: 'deny', reasonCode: 'plugin_unavailable' });
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, action: 'admin' })
    ).rejects.toThrow('plugin_sync_input_invalid');
  });

  it('preserves the existing 4096-character human-verification token limit', async () => {
    const base = {
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      requestId: 'request-a',
      action: 'login',
    };
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, responseToken: 'a'.repeat(4_096) })
    ).resolves.toEqual({ decision: 'deny', reasonCode: 'plugin_unavailable' });
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, responseToken: 'a'.repeat(4_097) })
    ).rejects.toThrow('plugin_sync_input_invalid');
  });

  it('accepts only a bounded IPv4 or IPv6 remote address', async () => {
    const base = {
      tenantId: 'tenant-a',
      pluginInstallationId: 'installation-a',
      requestId: 'request-a',
      action: 'login',
      responseToken: 'token',
    };
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, remoteIp: '203.0.113.7' })
    ).resolves.toEqual({ decision: 'deny', reasonCode: 'plugin_unavailable' });
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, remoteIp: '2001:db8::1' })
    ).resolves.toEqual({ decision: 'deny', reasonCode: 'plugin_unavailable' });
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, remoteIp: '999.0.0.1' })
    ).rejects.toThrow('plugin_sync_input_invalid');
    await expect(
      worker('ar-auth').runHumanVerification({ ...base, remoteIp: 'forwarded.example' })
    ).rejects.toThrow('plugin_sync_input_invalid');
  });

  it.each(['ar-bridge', 'ar-saml'] as const)(
    'grants %s only the human-verification RPC capability',
    async (caller) => {
      const runtime = worker(caller);
      await expect(
        runtime.runHumanVerification({
          tenantId: 'tenant-a',
          pluginInstallationId: 'installation-a',
          requestId: 'request-a',
          action: 'login',
          responseToken: 'token',
        })
      ).resolves.toEqual({ decision: 'deny', reasonCode: 'plugin_unavailable' });
      await expect(
        runtime.runFlowHook({
          tenantId: 'tenant-a',
          pluginInstallationId: 'installation-a',
          requestId: 'request-a',
          flowId: 'flow-a',
          hookName: 'before-login',
          stateVersion: 1,
        })
      ).rejects.toThrow('plugin_sync_caller_unauthorized');
    }
  );

  it('limits credential replacement to Management and validates before D1 access', async () => {
    const input = {
      operationId: 'operation-a',
      tenantId: 'tenant-a',
      installationId: 'installation-a',
      expectedConfigVersion: 1,
      credentials: [],
    };
    await expect(worker('ar-auth').replacePluginCredentials(input)).rejects.toThrow(
      'plugin_sync_caller_unauthorized'
    );
    await expect(
      worker('ar-management').replacePluginCredentials({ ...input, cloudflareApiPath: '/workers' })
    ).rejects.toThrow('plugin_config_input_invalid');
  });

  it('limits account event subscription resolution to Management and an exact event contract', async () => {
    const input = { tenantId: 'tenant-a', eventType: 'account.created' };
    await expect(worker('ar-auth').resolveAccountEventInstallations(input)).rejects.toThrow(
      'plugin_sync_caller_unauthorized'
    );
    await expect(
      worker('ar-management').resolveAccountEventInstallations({
        ...input,
        arbitraryCapability: 'cloudflare.admin',
      })
    ).rejects.toThrow('plugin_sync_input_invalid');
    await expect(
      worker('ar-management').resolveAccountEventInstallations({
        tenantId: 'tenant-a',
        eventType: 'account.deleted',
      })
    ).rejects.toThrow('plugin_sync_account_event_input_invalid');
  });

  it('limits immediate notification delivery and returns pending on unavailable infrastructure', async () => {
    const input = {
      tenantId: 'tenant-a',
      intentId: 'intent-a',
      outboxId: 'outbox-a',
      pluginInstallationId: 'installation-a',
      bindingRef: 'TDB_CORE_A',
    };
    await expect(worker('ar-policy').deliverNotification(input)).rejects.toThrow(
      'plugin_sync_caller_unauthorized'
    );
    await expect(
      worker('ar-auth').deliverNotification({ ...input, cloudflareApiPath: '/workers' })
    ).rejects.toThrow('plugin_sync_input_invalid');
    await expect(worker('ar-auth').deliverNotification(input)).resolves.toBe('pending');
    await expect(worker('ar-management').deliverNotification(input)).resolves.toBe('pending');
  });

  it('limits notification installation mutation to Management before D1 access', async () => {
    const input = {
      installationId: 'notifier-resend-tenant-a',
      tenantId: 'tenant-a',
      pluginId: 'notifier-resend',
      backendKind: 'in_process',
      enabled: true,
    };
    await expect(worker('ar-auth').configureNotificationInstallation(input)).rejects.toThrow(
      'plugin_sync_caller_unauthorized'
    );
    await expect(
      worker('ar-management').configureNotificationInstallation({
        ...input,
        arbitraryCapability: 'cloudflare.admin',
      })
    ).rejects.toThrow('plugin_notification_installation_input_invalid');
  });

  it('limits Dynamic Worker installation and rollout mutations to Management', async () => {
    const input = { tenantId: 'tenant-a', pluginId: 'plugin-a', enabled: true };
    await expect(worker('ar-auth').configureDynamicPluginInstallation(input)).rejects.toThrow(
      'plugin_sync_caller_unauthorized'
    );
    await expect(
      worker('ar-auth').stageDynamicPluginActivation({
        tenantId: 'tenant-a',
        pluginId: 'plugin-a',
        activationRequestId: 'operation-a',
      })
    ).rejects.toThrow('plugin_sync_caller_unauthorized');
    await expect(
      worker('ar-management').configureDynamicPluginInstallation({
        ...input,
        codeSha256: 'a'.repeat(64),
      })
    ).rejects.toThrow('plugin_dynamic_installation_input_invalid');
    await expect(worker('ar-auth').rolloutDynamicPluginInstallation(input)).rejects.toThrow(
      'plugin_sync_caller_unauthorized'
    );
    await expect(
      worker('ar-auth').rolloutDynamicPluginBatch({
        operationId: 'rollout-a',
        pluginId: 'plugin-a',
        batchSize: 1,
      })
    ).rejects.toThrow('plugin_sync_caller_unauthorized');
  });

  it('separates provider-order mutation from runtime resolution', async () => {
    const replacement = {
      operationId: 'provider-order-operation-a',
      tenantId: 'tenant-a',
      channel: 'email',
      expectedConfigVersion: 0,
      installationIds: [],
    };
    await expect(worker('ar-auth').replaceNotificationProviderOrder(replacement)).rejects.toThrow(
      'plugin_sync_caller_unauthorized'
    );
    await expect(
      worker('ar-management').replaceNotificationProviderOrder({
        ...replacement,
        cloudflareApiPath: '/workers',
      })
    ).rejects.toThrow('plugin_notification_provider_order_input_invalid');
    await expect(
      worker('ar-policy').resolveNotificationProviderOrder({
        tenantId: 'tenant-a',
        channel: 'email',
      })
    ).rejects.toThrow('plugin_sync_caller_unauthorized');
    await expect(
      worker('ar-auth').resolveNotificationProviderOrder({
        tenantId: 'tenant-a',
        channel: 'email',
        arbitraryCapability: 'cloudflare.admin',
      })
    ).rejects.toThrow('plugin_sync_input_invalid');
  });
});
