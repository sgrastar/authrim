import { describe, expect, it } from 'vitest';
import {
  buildInitialAdminRolesBootstrapSql,
  buildInitialTenantBootstrapSql,
} from '../core/cloudflare.js';
import { createDefaultConfig } from '../core/config.js';

describe('buildInitialTenantBootstrapSql', () => {
  it('renames the bootstrap default tenant when the configured initial tenant differs', () => {
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';
    config.tenant.displayName = 'First Tenant';

    const sql = buildInitialTenantBootstrapSql(config);

    expect(sql).toContain("WHERE id = 'default'");
    expect(sql).toContain("AND 'first' <> 'default'");
    expect(sql).toContain("SET id = 'first'");
    expect(sql).toContain("tenant_code = 'first'");
    expect(sql).toContain("name = 'First Tenant'");
    expect(sql).toContain('INSERT INTO tenants');
  });

  it('updates the display name in place when the initial tenant remains default', () => {
    const config = createDefaultConfig('prod');
    config.tenant.name = 'default';
    config.tenant.displayName = 'Acme';

    const sql = buildInitialTenantBootstrapSql(config);

    expect(sql).toContain("AND 'default' <> 'default'");
    expect(sql).toContain("WHERE id = 'default';");
    expect(sql).toContain("name = 'Acme'");
  });

  it('escapes single quotes in tenant display names', () => {
    const config = createDefaultConfig('prod');
    config.tenant.name = 'tenant-1';
    config.tenant.displayName = "O'Hara";

    const sql = buildInitialTenantBootstrapSql(config);

    expect(sql).toContain("name = 'O''Hara'");
  });
});

describe('buildInitialAdminRolesBootstrapSql', () => {
  it('copies default system roles to the configured initial tenant', () => {
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';

    const sql = buildInitialAdminRolesBootstrapSql(config);

    expect(sql).toContain("id || '__' || 'first'");
    expect(sql).toContain("'first',");
    expect(sql).toContain("WHERE tenant_id = 'default'");
    expect(sql).toContain("AND 'first' <> 'default'");
    expect(sql).toContain('AND existing.name = admin_roles.name');
  });

  it('becomes a no-op when the initial tenant is default', () => {
    const config = createDefaultConfig('prod');
    config.tenant.name = 'default';

    const sql = buildInitialAdminRolesBootstrapSql(config);

    expect(sql).toContain("AND 'default' <> 'default'");
  });
});
