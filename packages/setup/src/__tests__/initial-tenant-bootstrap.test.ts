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
    expect(sql).toContain('UPDATE flows');
    expect(sql).toContain('UPDATE flow_versions');
    expect(sql).toContain('UPDATE flow_assignments');
    expect(sql).toContain('UPDATE screens');
    expect(sql).toContain('UPDATE custom_claim_schemas');
    expect(sql).toContain("'builtin:' || 'first' || ':' || field.field_key");
    expect(sql).toContain("'display_name'");
    expect(sql).toContain("'picture_url'");
    expect(sql).toContain('(SELECT COUNT(*) FROM tenants) = 1');
    expect(sql).toContain('INSERT INTO tenants');
  });

  it('guards default tenant rename so existing multi-tenant databases keep their default tenant', () => {
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';

    const sql = buildInitialTenantBootstrapSql(config);

    expect(sql).toContain("WHERE id = 'default'");
    expect(sql).toContain("AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = 'first')");
    expect(sql).toContain('AND (SELECT COUNT(*) FROM tenants) = 1');
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
  it('canonicalizes legacy tenant-scoped system role copies for the configured initial tenant', () => {
    const config = createDefaultConfig('mt');
    config.tenant.name = 'first';

    const sql = buildInitialAdminRolesBootstrapSql(config);

    expect(sql).toContain('UPDATE admin_role_assignments');
    expect(sql).toContain('DELETE FROM admin_roles');
    expect(sql).toContain("canonical.tenant_id = 'default'");
    expect(sql).toContain("copy.tenant_id = 'first'");
    expect(sql).toContain("WHERE tenant_id = 'first'");
    expect(sql).toContain("AND 'first' <> 'default'");
  });

  it('becomes a no-op when the initial tenant is default', () => {
    const config = createDefaultConfig('prod');
    config.tenant.name = 'default';

    const sql = buildInitialAdminRolesBootstrapSql(config);

    expect(sql).not.toContain("id || '__' || 'default'");
    expect(sql).toContain("AND 'default' <> 'default'");
  });
});
