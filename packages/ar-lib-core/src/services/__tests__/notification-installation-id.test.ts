import { describe, expect, it } from 'vitest';
import { deriveNotificationInstallationId } from '../notification-installation-id';

const identity = {
  environmentId: 'test',
  tenantId: 'tenant-a',
  pluginId: 'notifier-resend',
  purpose: 'email-primary',
};

describe('notification installation identity', () => {
  it('derives a stable safe identifier from the complete identity tuple', async () => {
    const first = await deriveNotificationInstallationId(identity);
    const second = await deriveNotificationInstallationId({ ...identity });

    expect(first).toBe(second);
    expect(first).toMatch(/^notification-installation-v1-[0-9a-f]{64}$/u);
  });

  it.each(['environmentId', 'tenantId', 'pluginId', 'purpose'] as const)(
    'domain-separates the %s component',
    async (field) => {
      const [first, second] = await Promise.all([
        deriveNotificationInstallationId(identity),
        deriveNotificationInstallationId({ ...identity, [field]: `${identity[field]}-other` }),
      ]);
      expect(first).not.toBe(second);
    }
  );

  it('rejects malformed or ambiguous identity components', async () => {
    await expect(
      deriveNotificationInstallationId({ ...identity, tenantId: 'tenant/a' })
    ).rejects.toThrow('notification_installation_identity_invalid');
    await expect(deriveNotificationInstallationId({ ...identity, purpose: '' })).rejects.toThrow(
      'notification_installation_identity_invalid'
    );
  });
});
