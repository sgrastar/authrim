import { describe, expect, it, vi } from 'vitest';
import {
  refuseMachineOnExcludedTenant,
  allScopeExcludesTenant,
  isAllScopeNonPlatformMachine,
  machineExcludedTenantsOf,
  machineExcludedTenantsProblem,
  readMachineExcludedTenants,
  resolveMachineExcludedTenants,
} from '../machine-excluded-tenants';
import {
  MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS_KEY as KEY,
  MAX_MACHINE_ACCESS_EXCLUDED_TENANTS,
} from '../../types/settings/machine-access';
import {
  isPlatformMachinePrincipal,
  resolveMachineExplicitTenantScope,
  resolveMachineTenantScope,
} from '../../repositories/admin/admin-machine-grant';
import { resolveAdminPathTargetTenant } from '../../utils/tenant-request-policy';
import type { AdminAuthContext } from '../../types/admin';

function machine(overrides: Partial<AdminAuthContext> = {}): AdminAuthContext {
  return {
    userId: 'amp_auto',
    actorId: 'amp_auto',
    actorType: 'machine',
    authMethod: 'machine_access_token',
    principalType: 'automation',
    clientId: 'auto-client',
    roles: [],
    permissions: ['*'],
    hierarchyLevel: 0,
    mfaVerified: false,
    tenantId: 'default',
    tenantScope: ['*'],
    tenantScopeExplicit: [],
    ...overrides,
  };
}

describe('machineExcludedTenantsProblem (validation of the saved value)', () => {
  it.each(['', '   ', 'default', 'default,acme', ' default , acme-2 ', 'a'.repeat(63)])(
    'accepts %j',
    (value) => {
      expect(machineExcludedTenantsProblem(value)).toBeNull();
    }
  );

  it.each([
    ['default,', 'empty entry'],
    [',default', 'empty entry'],
    ['default,,acme', 'empty entry'],
    ['*', 'wildcard'],
    ['default,*', 'wildcard'],
    ['Default', 'lowercase'],
    ['acme_corp', 'lowercase'],
    ['-acme', 'lowercase'],
    ['acme.example', 'lowercase'],
    ['a'.repeat(64), 'lowercase'],
    ['default,default', 'twice'],
    ['default acme', 'lowercase'],
  ])('refuses %j with a clear message', (value, expected) => {
    const problem = machineExcludedTenantsProblem(value);
    expect(problem).not.toBeNull();
    expect(problem).toContain(expected);
  });

  it.each([true, false, 5, null, undefined, ['default'], { a: 1 }])(
    'refuses a value that is not text: %j',
    (value) => {
      expect(machineExcludedTenantsProblem(value)).toContain('comma-separated list');
    }
  );

  it('refuses more than the most tenants allowed', () => {
    const many = Array.from({ length: MAX_MACHINE_ACCESS_EXCLUDED_TENANTS + 1 }, (_, i) => `t${i}`);
    expect(machineExcludedTenantsProblem(many.join(','))).toContain('at most');
    expect(machineExcludedTenantsProblem(many.slice(0, -1).join(','))).toBeNull();
  });

  it('does not echo control characters of a refused value', () => {
    const problem = machineExcludedTenantsProblem('bad\u0000id');
    expect(problem).not.toBeNull();
    expect(problem).not.toContain('\u0000');
  });
});

describe('readMachineExcludedTenants', () => {
  it('reads an absent or empty value as no tenant', () => {
    for (const value of [undefined, '', '  ']) {
      expect(readMachineExcludedTenants(value)).toEqual({ kind: 'none' });
    }
  });

  it('reads a valid list', () => {
    expect(readMachineExcludedTenants('default, acme')).toEqual({
      kind: 'list',
      tenants: new Set(['default', 'acme']),
    });
  });

  it('reads a stored null as every tenant, not as unset', () => {
    expect(readMachineExcludedTenants(null)).toEqual({ kind: 'all' });
    expect(readMachineExcludedTenants(undefined)).toEqual({ kind: 'none' });
  });

  it('reads anything that is not a valid list as every tenant, never as none', () => {
    for (const value of ['*', 'Default', 'a,,b', false, 7, {}, 'x'.repeat(100)]) {
      expect(readMachineExcludedTenants(value)).toEqual({ kind: 'all' });
    }
  });
});

describe('resolveMachineExcludedTenants (the platform setting as runtime reads it)', () => {
  it('is none by default', async () => {
    await expect(resolveMachineExcludedTenants({})).resolves.toEqual({ kind: 'none' });
  });

  it('reads the environment variable when nothing is saved', async () => {
    const env = { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: 'default' } as never;
    await expect(resolveMachineExcludedTenants(env)).resolves.toEqual({
      kind: 'list',
      tenants: new Set(['default']),
    });
  });

  it('prefers the saved value over the environment variable', async () => {
    const env = {
      MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: 'default',
      SETTINGS: { get: async () => JSON.stringify({ [KEY]: 'acme' }) },
    } as never;
    await expect(resolveMachineExcludedTenants(env)).resolves.toEqual({
      kind: 'list',
      tenants: new Set(['acme']),
    });
  });

  it('reads a saved value that is not valid as every tenant', async () => {
    const env = {
      SETTINGS: { get: async () => JSON.stringify({ [KEY]: 'NOT A TENANT' }) },
    } as never;
    await expect(resolveMachineExcludedTenants(env)).resolves.toEqual({ kind: 'all' });
  });

  it('reads settings that cannot be read as every tenant (fails closed)', async () => {
    const throwing = {
      SETTINGS: {
        get: async () => {
          throw new Error('kv down');
        },
      },
    } as never;
    await expect(resolveMachineExcludedTenants(throwing)).resolves.toEqual({ kind: 'all' });
    const garbled = { SETTINGS: { get: async () => '{not json' } } as never;
    await expect(resolveMachineExcludedTenants(garbled)).resolves.toEqual({ kind: 'all' });
  });
});

describe('who the exclusion applies to', () => {
  const list = readMachineExcludedTenants('default');

  it('applies to an all-tenants token of an automation principal', () => {
    expect(isAllScopeNonPlatformMachine(machine())).toBe(true);
    expect(allScopeExcludesTenant(machine(), list, 'default')).toBe(true);
    expect(allScopeExcludesTenant(machine(), list, 'acme')).toBe(false);
  });

  it.each(['automation', 'ci', 'integration', 'mcp_server', 'ai_agent'] as const)(
    'applies to the non-platform principal type %s',
    (principalType) => {
      expect(
        allScopeExcludesTenant(machine({ principalType: principalType as never }), list, 'default')
      ).toBe(true);
    }
  );

  it.each(['setup_tool', 'admin_ui_bff', 'internal_service'] as const)(
    'never applies to the platform principal type %s',
    (principalType) => {
      const auth = machine({ principalType: principalType as never });
      expect(isAllScopeNonPlatformMachine(auth)).toBe(false);
      expect(allScopeExcludesTenant(auth, readMachineExcludedTenants('*'), 'default')).toBe(false);
      expect(allScopeExcludesTenant(auth, list, 'default')).toBe(false);
    }
  );

  it('never applies to the bootstrap principals by their fixed ids or client id', () => {
    expect(isPlatformMachinePrincipal({ id: 'amp_authrim_setup' })).toBe(true);
    expect(isPlatformMachinePrincipal({ id: 'amp_authrim_admin_ui_bff' })).toBe(true);
    expect(isPlatformMachinePrincipal({ clientId: 'authrim-setup' })).toBe(true);
    expect(
      allScopeExcludesTenant(
        machine({ actorId: 'amp_authrim_setup', userId: 'amp_authrim_setup' }),
        list,
        'default'
      )
    ).toBe(false);
    expect(allScopeExcludesTenant(machine({ clientId: 'authrim-setup' }), list, 'default')).toBe(
      false
    );
  });

  it('never applies to a human session, an agent token or a token limited to named tenants', () => {
    expect(
      allScopeExcludesTenant(
        machine({ authMethod: 'session', tenantScope: ['*'] }),
        list,
        'default'
      )
    ).toBe(false);
    expect(
      allScopeExcludesTenant(machine({ authMethod: 'bearer', tenantScope: ['*'] }), list, 'default')
    ).toBe(false);
    expect(allScopeExcludesTenant(machine({ tenantScope: ['default'] }), list, 'default')).toBe(
      false
    );
  });

  it('accepts a protected tenant the principal and credential name explicitly', () => {
    const named = machine({ tenantScopeExplicit: ['default'] });
    expect(allScopeExcludesTenant(named, list, 'default')).toBe(false);
    expect(allScopeExcludesTenant(named, list, 'DEFAULT')).toBe(false);
    // Naming one tenant does not open another listed one.
    expect(allScopeExcludesTenant(named, readMachineExcludedTenants('default,acme'), 'acme')).toBe(
      true
    );
  });

  it('compares case-insensitively and counts an unreadable tenant as any excluded one', () => {
    expect(allScopeExcludesTenant(machine(), list, 'DeFault')).toBe(true);
    expect(allScopeExcludesTenant(machine(), list, ' default ')).toBe(true);
    expect(allScopeExcludesTenant(machine(), list, null)).toBe(true);
  });

  it('with an unreadable setting, excludes every tenant that is not named explicitly', () => {
    const all = readMachineExcludedTenants('*');
    expect(allScopeExcludesTenant(machine(), all, 'acme')).toBe(true);
    expect(allScopeExcludesTenant(machine({ tenantScopeExplicit: ['acme'] }), all, 'acme')).toBe(
      false
    );
  });

  it('with an empty list, excludes nothing', () => {
    const none = readMachineExcludedTenants('');
    expect(allScopeExcludesTenant(machine(), none, 'default')).toBe(false);
    expect(allScopeExcludesTenant(machine(), none, null)).toBe(false);
  });
});

describe('resolveMachineExplicitTenantScope', () => {
  const all = { scopeMode: 'all' as const, tenantId: null };
  const allow = (tenantId: string) => ({ scopeMode: 'allow' as const, tenantId });

  it('is empty for a plain all-tenants scope', () => {
    expect(resolveMachineExplicitTenantScope([all], [])).toEqual([]);
  });

  it('keeps a tenant named next to the all entry, while the scope stays all', () => {
    const principal = [all, allow('default')];
    expect(resolveMachineTenantScope(principal, [])).toEqual(['*']);
    expect(resolveMachineExplicitTenantScope(principal, [])).toEqual(['default']);
  });

  it('needs the credential to name the tenant too, when it has a scope of its own', () => {
    const principal = [all, allow('default'), allow('acme')];
    expect(resolveMachineExplicitTenantScope(principal, [all])).toEqual([]);
    expect(resolveMachineExplicitTenantScope(principal, [all, allow('acme')])).toEqual(['acme']);
    expect(resolveMachineExplicitTenantScope(principal, [allow('default')])).toEqual(['default']);
  });

  it('is the allow-list for a scope without an all entry', () => {
    expect(resolveMachineExplicitTenantScope([allow('a'), allow('b')], [allow('b')])).toEqual([
      'b',
    ]);
  });
});

describe('resolveAdminPathTargetTenant (decided on the router path)', () => {
  it.each([
    ['/api/admin/tenants/default', 'default'],
    ['/api/admin/tenants/default/', 'default'],
    ['/api/admin/tenants/default/provisioning', 'default'],
    ['/api/admin/tenants/default/provisioning/cleanup', 'default'],
    ['/api/admin/tenants/default/lifecycle/suspend', 'default'],
    ['/api/admin/tenants/default/settings/security', 'default'],
    ['/api/admin/tenants/DEFAULT', 'default'],
    ['/api/admin/tenants/Default/info', 'default'],
    ['/api/admin/tenants/%64efault', 'default'],
    ['/api/admin/tenants/%44EFAULT/provisioning', 'default'],
    ['/api/admin/tenants/%2564efault', 'default'],
    ['/api/admin/tenants/%25252564efault', null],
    ['/api/admin/tenants/%20default', 'default'],
    ['/api/admin/tenants/%EF%BD%84efault', 'default'],
    ['/api/admin/Tenants/default', 'default'],
    ['/api/admin/settings/logging/tenant/default', 'default'],
    ['/api/admin/settings/logging/tenant/Default/x', 'default'],
  ])('reads %s as the tenant %s', (path, expected) => {
    const target = resolveAdminPathTargetTenant(path);
    if (expected === null) {
      expect(target).toEqual({ kind: 'unresolvable' });
    } else {
      expect(target).toEqual({ kind: 'tenant', tenantId: expected });
    }
  });

  it('reads a malformed escape as unresolvable', () => {
    expect(resolveAdminPathTargetTenant('/api/admin/tenants/%zz')).toEqual({
      kind: 'unresolvable',
    });
    expect(resolveAdminPathTargetTenant('/api/admin/tenants/%E0%A4%A')).toEqual({
      kind: 'unresolvable',
    });
  });

  it.each([
    '/api/admin/tenants',
    '/api/admin/tenants/',
    '/api/admin/users',
    '/api/admin/platform/settings/security',
    '/api/admin/tenantsx/default',
    null,
    undefined,
  ])('finds no target in %s', (path) => {
    expect(resolveAdminPathTargetTenant(path)).toEqual({ kind: 'none' });
  });
});

describe('refuseMachineOnExcludedTenant: not named, named, and unresolved', () => {
  const context = (auth: AdminAuthContext, exclude = 'default') => {
    const store = new Map<string, unknown>([['adminAuth', auth]]);
    return {
      env: { MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS: exclude },
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => void store.set(key, value),
      json: (body: unknown, status = 200) => Response.json(body, { status }),
    };
  };

  it('does not judge an operation that names no tenant (platform-wide)', async () => {
    expect(await refuseMachineOnExcludedTenant(context(machine()), undefined)).toBeNull();
  });

  it('judges a named tenant, and refuses one that was named but cannot be resolved', async () => {
    expect((await refuseMachineOnExcludedTenant(context(machine()), 'default'))?.status).toBe(403);
    expect(await refuseMachineOnExcludedTenant(context(machine()), 'acme')).toBeNull();
    expect((await refuseMachineOnExcludedTenant(context(machine()), null))?.status).toBe(403);
  });

  it('never limits a caller the setting does not apply to', async () => {
    const tool = machine({ principalType: 'setup_tool' as never });
    expect(await refuseMachineOnExcludedTenant(context(tool), 'default')).toBeNull();
    expect(await refuseMachineOnExcludedTenant(context(tool), null)).toBeNull();
  });

  it('reads the setting once per request', async () => {
    const reads = vi.fn(async () => null);
    const c = context(machine());
    (c.env as Record<string, unknown>).SETTINGS = { get: reads };
    await refuseMachineOnExcludedTenant(c, 'acme');
    await refuseMachineOnExcludedTenant(c, 'acme');
    await machineExcludedTenantsOf(c);
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
