import { describe, expect, it } from 'vitest';
import { saveTenantSettingsTogether } from '../routes/settings-v2/tenant-settings-apply';

type SaveInput = Parameters<typeof saveTenantSettingsTogether>[0];

describe('saving tenant settings together', () => {
  // Refused before anything is read or written, so the request context is never touched.
  const c = {} as SaveInput['c'];

  it('refuses a category whose save does more than the checks (a guard, a gate, a cache)', async () => {
    await expect(
      saveTenantSettingsTogether({
        c,
        adminAuth: undefined,
        tenantId: 'tenant-a',
        changes: [
          { category: 'session', body: { ifMatch: 'v', set: {}, clear: [] } },
          { category: 'plugin', body: { ifMatch: 'v', set: {}, clear: [] } },
        ],
      })
    ).rejects.toThrow('settings_together_unsupported');
  });
});
