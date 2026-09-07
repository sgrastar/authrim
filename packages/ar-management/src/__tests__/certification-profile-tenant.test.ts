import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildTenantSystemSettingsKey } from '@authrim/ar-lib-core';
import { adminApplyCertificationProfileHandler } from '../admin';

describe('tenant-scoped certification profiles', () => {
  it('stores the selected profile without changing global system settings', async () => {
    const globalSettings = JSON.stringify({
      fapi: { enabled: false },
      oidc: { requirePar: false },
    });
    const values = new Map<string, string>([['system_settings', globalSettings]]);
    const settings = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as KVNamespace;
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      (c as { set: (key: string, value: string) => void }).set('tenantId', 'fapi2');
      await next();
    });
    app.put('/api/admin/settings/profile/:profileName', adminApplyCertificationProfileHandler);

    const response = await app.request('/api/admin/settings/profile/fapi-2', { method: 'PUT' }, {
      SETTINGS: settings,
    } as Env);
    const body = (await response.json()) as {
      success: boolean;
      tenant_id: string;
    };
    const tenantSettings = JSON.parse(
      values.get(buildTenantSystemSettingsKey('fapi2')) ?? '{}'
    ) as {
      fapi?: { enabled?: boolean };
      oidc?: { requirePar?: boolean };
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, tenant_id: 'fapi2' });
    expect(values.get('system_settings')).toBe(globalSettings);
    expect(tenantSettings.fapi?.enabled).toBe(true);
    expect(tenantSettings.oidc?.requirePar).toBe(true);
    expect(settings.put).toHaveBeenCalledWith(
      buildTenantSystemSettingsKey('fapi2'),
      expect.any(String)
    );
  });
});
