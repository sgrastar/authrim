import { describe, expect, it } from 'vitest';
import { derivePluginInstallationId } from '../plugin-installation-id';

describe('derivePluginInstallationId', () => {
  const identity = {
    environmentId: 'test',
    tenantId: 'tenant-a',
    pluginId: 'human-verification-cloudflare-turnstile',
    purpose: 'human-verification',
  } as const;

  it('is deterministic and purpose-separated', async () => {
    await expect(derivePluginInstallationId(identity)).resolves.toBe(
      await derivePluginInstallationId({ ...identity })
    );
    await expect(
      derivePluginInstallationId({ ...identity, purpose: 'email-provider' })
    ).resolves.not.toBe(await derivePluginInstallationId(identity));
  });

  it('rejects unsafe identity components', async () => {
    await expect(derivePluginInstallationId({ ...identity, tenantId: 'tenant/a' })).rejects.toThrow(
      'plugin_installation_identity_invalid'
    );
  });
});
