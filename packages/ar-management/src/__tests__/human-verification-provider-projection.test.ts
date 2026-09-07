import { describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import {
  deriveHumanVerificationInstallationId,
  disableTenantHumanVerificationProvider,
  projectTenantHumanVerificationProvider,
} from '../human-verification-provider-projection';

function environment() {
  const configureHumanVerificationInstallation = vi.fn(async (input) => ({
    installationId: input.installationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    state: input.enabled ? ('enabled' as const) : ('disabled' as const),
    configVersion: input.enabled ? 2 : 1,
  }));
  return {
    env: {
      AUTHRIM_ENVIRONMENT_NAME: 'test',
      PLUGIN_RUNNER: { configureHumanVerificationInstallation },
    } as unknown as Env,
    configureHumanVerificationInstallation,
  };
}

describe('human-verification provider projection', () => {
  it('projects the deterministic tenant installation with scoped config', async () => {
    const { env, configureHumanVerificationInstallation } = environment();
    const installationId = await projectTenantHumanVerificationProvider(env, {
      tenantId: 'tenant-a',
      pluginId: 'human-verification-google-recaptcha',
      operationId: 'operation-a',
      config: {
        siteKey: 'site-key',
        secretKey: 'secret-key',
        expectedHostname: 'login.example.com',
        widgetMode: 'score',
        scoreThreshold: 0.7,
      },
    });

    expect(installationId).toBe(
      await deriveHumanVerificationInstallationId(env, {
        tenantId: 'tenant-a',
        pluginId: 'human-verification-google-recaptcha',
      })
    );
    expect(configureHumanVerificationInstallation).toHaveBeenCalledWith({
      operationId: 'operation-a',
      installationId,
      tenantId: 'tenant-a',
      pluginId: 'human-verification-google-recaptcha',
      enabled: true,
      config: {
        siteKey: 'site-key',
        secretKey: 'secret-key',
        expectedHostname: 'login.example.com',
        widgetMode: 'score',
        scoreThreshold: 0.7,
      },
    });
  });

  it('rejects fail-open and missing credentials before Runner mutation', async () => {
    const { env, configureHumanVerificationInstallation } = environment();
    await expect(
      projectTenantHumanVerificationProvider(env, {
        tenantId: 'tenant-a',
        pluginId: 'human-verification-cloudflare-turnstile',
        config: { siteKey: 'site-key', secretKey: 'secret-key', failurePolicy: 'fail_open' },
      })
    ).rejects.toThrow('human_verification_projection_fail_open_forbidden');
    await expect(
      projectTenantHumanVerificationProvider(env, {
        tenantId: 'tenant-a',
        pluginId: 'human-verification-hcaptcha',
        config: { siteKey: 'site-key' },
      })
    ).rejects.toThrow('human_verification_projection_config_unavailable');
    expect(configureHumanVerificationInstallation).not.toHaveBeenCalled();
  });

  it('disables only the same deterministic tenant installation', async () => {
    const { env, configureHumanVerificationInstallation } = environment();
    await disableTenantHumanVerificationProvider(env, {
      tenantId: 'tenant-a',
      pluginId: 'human-verification-hcaptcha',
      operationId: 'operation-disable-a',
    });
    expect(configureHumanVerificationInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'operation-disable-a',
        tenantId: 'tenant-a',
        pluginId: 'human-verification-hcaptcha',
        enabled: false,
      })
    );
  });
});
