import { describe, expect, it } from 'vitest';
import { TenantConfigSchema, type AuthrimConfig } from '../core/config.js';
import { normalizeTenantConfigForApiDomain } from '../core/tenant-mode.js';
import { generateEnvVars } from '../core/wrangler.js';
import { getHtmlTemplate } from '../web/ui.js';
import {
  SCENARIOS,
  buildAuthrimConfig,
  WORKERS_SUBDOMAIN,
} from '../../../../test/shared-fixtures/deployment-topology-matrix.js';

describe('tenant.loginEntryMode through the web setup flow', () => {
  it('survives load, the server-side tenant rebuild, and reaches ar-management only', () => {
    const scenario = SCENARIOS.find((candidate) => candidate.config.baseDomain)!;
    const built = buildAuthrimConfig(scenario) as AuthrimConfig;
    built.tenant.multiTenant = true;
    built.tenant.loginEntryMode = 'tenant_only';

    // Load: the file is parsed by the schema.
    const loaded = {
      ...built,
      tenant: TenantConfigSchema.parse(JSON.parse(JSON.stringify(built.tenant))),
    };
    expect(loaded.tenant.loginEntryMode).toBe('tenant_only');

    // /config/default rebuilds the tenant with this function.
    const config = { ...loaded, tenant: normalizeTenantConfigForApiDomain(loaded.tenant) };
    expect(config.tenant.loginEntryMode).toBe('tenant_only');

    expect(generateEnvVars('ar-management', config, WORKERS_SUBDOMAIN)['LOGIN_ENTRY_MODE']).toBe(
      'tenant_only'
    );
    expect(
      generateEnvVars('ar-auth', config, WORKERS_SUBDOMAIN)['LOGIN_ENTRY_MODE']
    ).toBeUndefined();
    // The downloaded file is the config itself.
    expect(JSON.parse(JSON.stringify(config)).tenant.loginEntryMode).toBe('tenant_only');
  });

  it('is carried by both tenant rebuilds of the web screen (browser script, checked as text only)', () => {
    const html = getHtmlTemplate('token');
    const carried = html.match(/loginEntryMode: config\.tenant\?\.loginEntryMode,/g) ?? [];
    expect(carried).toHaveLength(2);
  });
});
