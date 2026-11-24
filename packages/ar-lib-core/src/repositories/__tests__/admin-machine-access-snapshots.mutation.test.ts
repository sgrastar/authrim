import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminMachineAccessRepository } from '../admin/admin-machine-access';
import {
  CREDENTIAL_MODEL,
  NOW,
  PRINCIPAL_MODEL,
  credentialRow,
  makeAdapter,
  principalRow,
} from './admin-machine-access.mutation-helpers';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

interface Scope {
  scope_mode: string;
  tenant_id: string | null;
}

function joinedRow(
  options: {
    principal?: Record<string, unknown>;
    credential?: Record<string, unknown>;
    principalPermissions?: string[];
    credentialPermissions?: string[];
    principalScopes?: Scope[];
    credentialScopes?: Scope[];
  } = {}
) {
  const p = principalRow(options.principal);
  const c = credentialRow(options.credential);
  return {
    ...p,
    credential_id: c.id,
    credential_principal_id: c.principal_id,
    credential_kid: c.kid,
    credential_public_jwk_json: c.public_jwk_json,
    credential_alg: c.alg,
    credential_display_name: c.display_name,
    credential_description: c.description,
    credential_status: c.status,
    credential_not_before: c.not_before,
    credential_expires_at: c.expires_at,
    credential_last_used_at: c.last_used_at,
    credential_last_used_ip: c.last_used_ip,
    credential_last_used_user_agent: c.last_used_user_agent,
    credential_created_by_actor_type: c.created_by_actor_type,
    credential_created_by_actor_id: c.created_by_actor_id,
    credential_created_at: c.created_at,
    credential_updated_at: c.updated_at,
    credential_revoked_at: c.revoked_at,
    credential_revoked_by_actor_type: c.revoked_by_actor_type,
    credential_revoked_by_actor_id: c.revoked_by_actor_id,
    credential_revoke_reason: c.revoke_reason,
    principal_permissions_json: JSON.stringify(options.principalPermissions ?? []),
    credential_permissions_json: JSON.stringify(options.credentialPermissions ?? []),
    principal_scopes_json: JSON.stringify(options.principalScopes ?? []),
    credential_scopes_json: JSON.stringify(options.credentialScopes ?? []),
  };
}

const allow = (tenant: string): Scope => ({ scope_mode: 'allow', tenant_id: tenant });

describe('findCredentialForClient', () => {
  it('maps the joined credential columns and returns null when nothing matches', async () => {
    const h = makeAdapter({ queryOne: () => joinedRow() });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.findCredentialForClient('client-1', 'kid-1')).toStrictEqual({
      principal: PRINCIPAL_MODEL,
      credential: CREDENTIAL_MODEL,
    });
    expect(h.queryOne.mock.calls[0][0]).toContain('WHERE p.client_id = ? AND c.kid = ?');
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['client-1', 'kid-1']);
    expect(
      await new AdminMachineAccessRepository(makeAdapter().adapter).findCredentialForClient(
        'a',
        'b'
      )
    ).toBeNull();
  });
});

describe('loadMachineGrantSnapshot', () => {
  it('returns null when the principal and credential do not pair up', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.loadMachineGrantSnapshot('amp_1', 'amk_1')).toBeNull();
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).toContain('JOIN admin_machine_credentials c ON c.principal_id = p.id');
    expect(sql).toContain('WHERE p.id = ? AND c.id = ?');
    expect(sql).toContain('admin_machine_principal_permissions');
    expect(sql).toContain('admin_machine_credential_permissions');
    expect(sql).toContain('admin_machine_principal_tenant_scopes');
    expect(sql).toContain('admin_machine_credential_tenant_scopes');
    expect(params).toStrictEqual(['amp_1', 'amk_1']);
  });

  it('uses the principal permissions when the credential has none, sorting everything', async () => {
    const h = makeAdapter({
      queryOne: () =>
        joinedRow({
          principalPermissions: ['admin:users.read', 'admin:clients.read'],
          principalScopes: [allow('t2'), { scope_mode: 'all', tenant_id: null }, allow('t1')],
        }),
    });
    const snapshot = await new AdminMachineAccessRepository(h.adapter).loadMachineGrantSnapshot(
      'amp_1',
      'amk_1'
    );
    expect(snapshot).toStrictEqual({
      principal: PRINCIPAL_MODEL,
      credential: CREDENTIAL_MODEL,
      principalPermissions: ['admin:clients.read', 'admin:users.read'],
      credentialPermissions: [],
      principalTenantScopes: [
        { scopeMode: 'all', tenantId: null },
        { scopeMode: 'allow', tenantId: 't1' },
        { scopeMode: 'allow', tenantId: 't2' },
      ],
      credentialTenantScopes: [],
      permissions: ['admin:clients.read', 'admin:users.read'],
      tenantScope: ['*'],
      explicitTenantScope: ['t1', 't2'],
    });
  });

  it('narrows permissions and tenants by the credential grant', async () => {
    const h = makeAdapter({
      queryOne: () =>
        joinedRow({
          principalPermissions: ['admin:users.read', 'admin:clients.read'],
          credentialPermissions: ['admin:users.read', 'admin:audit.read'],
          principalScopes: [allow('t1'), allow('t2')],
          credentialScopes: [allow('t2'), allow('t3')],
        }),
    });
    const snapshot = await new AdminMachineAccessRepository(h.adapter).loadMachineGrantSnapshot(
      'amp_1',
      'amk_1'
    );
    expect(snapshot?.credentialPermissions).toStrictEqual(['admin:audit.read', 'admin:users.read']);
    expect(snapshot?.permissions).toStrictEqual(['admin:users.read']);
    expect(snapshot?.tenantScope).toStrictEqual(['t2']);
    expect(snapshot?.explicitTenantScope).toStrictEqual(['t2']);
    expect(snapshot?.credentialTenantScopes).toStrictEqual([
      { scopeMode: 'allow', tenantId: 't2' },
      { scopeMode: 'allow', tenantId: 't3' },
    ]);
  });

  it('sorts scopes by mode then tenant, treating a missing tenant as empty', async () => {
    const h = makeAdapter({
      queryOne: () =>
        joinedRow({
          principalScopes: [
            { scope_mode: 'none', tenant_id: null },
            allow('b'),
            { scope_mode: 'all', tenant_id: null },
            allow('a'),
          ],
        }),
    });
    const snapshot = await new AdminMachineAccessRepository(h.adapter).loadMachineGrantSnapshot(
      'amp_1',
      'amk_1'
    );
    expect(
      snapshot?.principalTenantScopes.map((s) => `${s.scopeMode}:${s.tenantId ?? ''}`)
    ).toStrictEqual(['all:', 'allow:a', 'allow:b', 'none:']);
  });
});

describe('loadPrincipalGrantSnapshot', () => {
  it('returns null for an unknown principal', async () => {
    const h = makeAdapter();
    expect(
      await new AdminMachineAccessRepository(h.adapter).loadPrincipalGrantSnapshot('x')
    ).toBeNull();
    expect(h.queryOne.mock.calls[0][0]).toContain('WHERE p.id = ?');
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['x']);
  });

  it('sorts permissions and keeps scope order as stored', async () => {
    const h = makeAdapter({
      queryOne: () => ({
        ...principalRow(),
        principal_permissions_json: JSON.stringify(['admin:b', 'admin:a']),
        principal_scopes_json: JSON.stringify([allow('t2'), allow('t1')]),
      }),
    });
    expect(
      await new AdminMachineAccessRepository(h.adapter).loadPrincipalGrantSnapshot('amp_1')
    ).toStrictEqual({
      principal: PRINCIPAL_MODEL,
      permissions: ['admin:a', 'admin:b'],
      tenantScopes: [
        { scopeMode: 'allow', tenantId: 't2' },
        { scopeMode: 'allow', tenantId: 't1' },
      ],
    });
    expect(h.queryOne.mock.calls[0][0]).toContain('admin_machine_principal_permissions');
    expect(h.queryOne.mock.calls[0][0]).toContain('admin_machine_principal_tenant_scopes');
    expect(h.queryOne.mock.calls[0][0]).not.toContain('admin_machine_credential');
  });
});

describe('resolveTenantMachineLimit', () => {
  function repoFor(options: {
    principal?: Parameters<typeof joinedRow>[0] & { principalOnly?: boolean };
    missing?: boolean;
  }) {
    const h = makeAdapter({
      queryOne: (sql) => {
        if (options.missing) return null;
        const row = joinedRow(options.principal);
        if (sql.includes('JOIN admin_machine_credentials c')) return row;
        return {
          ...principalRow(options.principal?.principal),
          principal_permissions_json: row.principal_permissions_json,
          principal_scopes_json: row.principal_scopes_json,
        };
      },
    });
    return { h, repo: new AdminMachineAccessRepository(h.adapter) };
  }

  describe('without a credential', () => {
    it('returns null for an unknown principal', async () => {
      const { repo, h } = repoFor({ missing: true });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1')).toBeNull();
      expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['amp_1']);
    });

    it('returns the principal and its permissions when t1 is named explicitly', async () => {
      const { repo, h } = repoFor({
        principal: {
          principalPermissions: ['admin:b', 'admin:a'],
          principalScopes: [allow('t1'), allow('t9')],
        },
      });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1')).toStrictEqual({
        principal: PRINCIPAL_MODEL,
        credential: null,
        permissions: ['admin:a', 'admin:b'],
      });
      expect(h.queryOne).toHaveBeenCalledTimes(1);
      expect(h.queryOne.mock.calls[0][0]).not.toContain('JOIN admin_machine_credentials');
    });

    it.each([
      ['no scopes', []],
      ['only another tenant', [allow('t2')]],
      ['an all scope', [{ scope_mode: 'all', tenant_id: null }]],
      ['an all scope next to the tenant', [{ scope_mode: 'all', tenant_id: null }, allow('t1')]],
      ['a none scope next to the tenant', [{ scope_mode: 'none', tenant_id: null }, allow('t1')]],
    ])('returns null for %s', async (_name, scopes) => {
      const { repo } = repoFor({ principal: { principalScopes: scopes } });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1')).toBeNull();
    });

    it.each(['disabled', 'deleted'])('returns null for a %s principal', async (status) => {
      const { repo } = repoFor({
        principal: { principal: { status }, principalScopes: [allow('t1')] },
      });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1')).toBeNull();
    });
  });

  describe('with a credential', () => {
    const grant = {
      principalPermissions: ['admin:a', 'admin:b', 'admin:c'],
      principalScopes: [allow('t1')],
    };

    it('returns null when the principal and credential do not pair up', async () => {
      const { repo, h } = repoFor({ missing: true });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
      expect(h.queryOne.mock.calls[0][0]).toContain('JOIN admin_machine_credentials c');
      expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['amp_1', 'amk_1']);
    });

    it('returns every principal permission when the credential has no own permissions', async () => {
      const { repo } = repoFor({ principal: grant });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toStrictEqual({
        principal: PRINCIPAL_MODEL,
        credential: CREDENTIAL_MODEL,
        permissions: ['admin:a', 'admin:b', 'admin:c'],
      });
    });

    it('limits principal permissions to those the credential permits', async () => {
      const { repo } = repoFor({
        principal: { ...grant, credentialPermissions: ['admin:b', 'admin:z'] },
      });
      const result = await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1');
      expect(result?.permissions).toStrictEqual(['admin:b']);
    });

    it('lets a wildcard credential permission keep everything', async () => {
      const { repo } = repoFor({ principal: { ...grant, credentialPermissions: ['*'] } });
      const result = await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1');
      expect(result?.permissions).toStrictEqual(['admin:a', 'admin:b', 'admin:c']);
    });

    it('yields no permissions when the credential permits none of them', async () => {
      const { repo } = repoFor({ principal: { ...grant, credentialPermissions: ['admin:z'] } });
      const result = await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1');
      expect(result?.permissions).toStrictEqual([]);
    });

    it.each(['active', 'rotating'])('accepts a %s credential', async (status) => {
      const { repo } = repoFor({ principal: { ...grant, credential: { status } } });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).not.toBeNull();
    });

    it.each(['revoked', 'expired'])('rejects a %s credential', async (status) => {
      const { repo } = repoFor({ principal: { ...grant, credential: { status } } });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
    });

    it('rejects a disabled principal even with a valid credential', async () => {
      const { repo } = repoFor({ principal: { ...grant, principal: { status: 'disabled' } } });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
    });

    it('rejects a principal without an explicit scope for the tenant', async () => {
      const { repo } = repoFor({
        principal: { ...grant, principalScopes: [{ scope_mode: 'all', tenant_id: null }] },
      });
      expect(await repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
      const none = repoFor({ principal: { ...grant, principalScopes: [] } });
      expect(await none.repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
    });

    it('requires the credential scope, when it has one, to name the tenant explicitly', async () => {
      const ok = repoFor({ principal: { ...grant, credentialScopes: [allow('t1'), allow('t2')] } });
      expect(await ok.repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).not.toBeNull();
      const other = repoFor({ principal: { ...grant, credentialScopes: [allow('t2')] } });
      expect(await other.repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
      const all = repoFor({
        principal: { ...grant, credentialScopes: [{ scope_mode: 'all', tenant_id: null }] },
      });
      expect(await all.repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
      const mixed = repoFor({
        principal: {
          ...grant,
          credentialScopes: [allow('t1'), { scope_mode: 'none', tenant_id: null }],
        },
      });
      expect(await mixed.repo.resolveTenantMachineLimit('t1', 'amp_1', 'amk_1')).toBeNull();
    });
  });
});

describe('permission and tenant scope accessors', () => {
  it('reads principal and credential permissions in stored order', async () => {
    const h = makeAdapter({ query: () => [{ permission: 'admin:a' }, { permission: 'admin:b' }] });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.getPrincipalPermissions('amp_1')).toStrictEqual(['admin:a', 'admin:b']);
    expect(h.query.mock.calls[0][0]).toContain('FROM admin_machine_principal_permissions');
    expect(h.query.mock.calls[0][0]).toContain('WHERE principal_id = ?');
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY permission ASC');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['amp_1']);
    expect(await repo.getCredentialPermissions('amk_1')).toStrictEqual(['admin:a', 'admin:b']);
    expect(h.query.mock.calls[1][0]).toContain('FROM admin_machine_credential_permissions');
    expect(h.query.mock.calls[1][0]).toContain('WHERE credential_id = ?');
    expect(h.query.mock.calls[1][0]).toContain('ORDER BY permission ASC');
    expect(h.query.mock.calls[1][1]).toStrictEqual(['amk_1']);
  });

  it('reads principal and credential tenant scopes', async () => {
    const h = makeAdapter({
      query: () => [
        { scope_mode: 'allow', tenant_id: 't1' },
        { scope_mode: 'all', tenant_id: null },
      ],
    });
    const repo = new AdminMachineAccessRepository(h.adapter);
    const expected = [
      { scopeMode: 'allow', tenantId: 't1' },
      { scopeMode: 'all', tenantId: null },
    ];
    expect(await repo.getPrincipalTenantScopes('amp_1')).toStrictEqual(expected);
    expect(h.query.mock.calls[0][0]).toContain('FROM admin_machine_principal_tenant_scopes');
    expect(h.query.mock.calls[0][0]).toContain('WHERE principal_id = ?');
    expect(h.query.mock.calls[0][0]).toContain('ORDER BY scope_mode ASC, tenant_id ASC');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['amp_1']);
    expect(await repo.getCredentialTenantScopes('amk_1')).toStrictEqual(expected);
    expect(h.query.mock.calls[1][0]).toContain('FROM admin_machine_credential_tenant_scopes');
    expect(h.query.mock.calls[1][0]).toContain('WHERE credential_id = ?');
    expect(h.query.mock.calls[1][1]).toStrictEqual(['amk_1']);
  });

  it('replaces principal permissions and scopes with actor attribution', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const actor = { actorType: 'admin', actorId: 'adm' };
    await repo.setPrincipalPermissions('amp_1', ['admin:a', 'admin:a'], actor);
    expect(h.batch.mock.calls[0][0]).toStrictEqual([
      {
        sql: 'DELETE FROM admin_machine_principal_permissions WHERE principal_id = ?',
        params: ['amp_1'],
      },
      {
        sql: expect.stringContaining('INSERT INTO admin_machine_principal_permissions') as string,
        params: ['amp_1', 'admin:a', NOW, 'admin', 'adm'],
      },
    ]);

    await repo.setPrincipalTenantScopes('amp_1', [{ scopeMode: 'allow', tenantId: 't1' }], actor);
    expect(h.batch.mock.calls[1][0]).toStrictEqual([
      {
        sql: 'DELETE FROM admin_machine_principal_tenant_scopes WHERE principal_id = ?',
        params: ['amp_1'],
      },
      {
        sql: expect.stringContaining('INSERT INTO admin_machine_principal_tenant_scopes') as string,
        params: ['amp_1', 'allow', 't1', NOW, 'admin', 'adm'],
      },
    ]);

    await repo.setPrincipalTenantScopes('amp_1', []);
    expect(h.batch.mock.calls[2][0]).toStrictEqual([
      {
        sql: 'DELETE FROM admin_machine_principal_tenant_scopes WHERE principal_id = ?',
        params: ['amp_1'],
      },
    ]);
  });

  it('replaces credential permissions and scopes with actor attribution', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const actor = { actorType: 'admin', actorId: 'adm' };
    await repo.setCredentialPermissions('amk_1', ['admin:b'], actor);
    expect(h.batch.mock.calls[0][0]).toStrictEqual([
      {
        sql: 'DELETE FROM admin_machine_credential_permissions WHERE credential_id = ?',
        params: ['amk_1'],
      },
      {
        sql: expect.stringContaining('INSERT INTO admin_machine_credential_permissions') as string,
        params: ['amk_1', 'admin:b', NOW, 'admin', 'adm'],
      },
    ]);

    await repo.setCredentialTenantScopes('amk_1', [
      { scopeMode: 'all', tenantId: null },
      { scopeMode: 'allow', tenantId: 't1' },
    ]);
    expect(h.batch.mock.calls[1][0]).toStrictEqual([
      {
        sql: 'DELETE FROM admin_machine_credential_tenant_scopes WHERE credential_id = ?',
        params: ['amk_1'],
      },
      {
        sql: expect.stringContaining(
          'INSERT INTO admin_machine_credential_tenant_scopes'
        ) as string,
        params: ['amk_1', 'all', null, NOW, null, null],
      },
      {
        sql: expect.stringContaining(
          'INSERT INTO admin_machine_credential_tenant_scopes'
        ) as string,
        params: ['amk_1', 'allow', 't1', NOW, null, null],
      },
    ]);
  });

  it('keeps a scope with an empty tenant distinct from one with a different tenant when de-duplicating', async () => {
    const h = makeAdapter();
    await new AdminMachineAccessRepository(h.adapter).setPrincipalTenantScopes('amp_1', [
      { scopeMode: 'allow', tenantId: 't1' },
      { scopeMode: 'none', tenantId: 't1' },
      { scopeMode: 'allow', tenantId: 't1' },
      { scopeMode: 'allow', tenantId: 't2' },
    ]);
    const statements = h.batch.mock.calls[0][0];
    expect(statements.slice(1).map((s) => s.params.slice(1, 3))).toStrictEqual([
      ['allow', 't1'],
      ['none', 't1'],
      ['allow', 't2'],
    ]);
  });
});

describe('assertion jti and last-used tracking', () => {
  it('records a jti and reports true', async () => {
    const h = makeAdapter();
    expect(
      await new AdminMachineAccessRepository(h.adapter).recordAssertionJti({
        clientId: 'client-1',
        credentialId: 'amk_1',
        jti: 'jti-1',
        expiresAt: 1778600000,
      })
    ).toBe(true);
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO admin_machine_assertion_jti');
    expect(sql).toContain('client_id, credential_id, jti, expires_at, created_at');
    expect(params).toStrictEqual(['client-1', 'amk_1', 'jti-1', 1778600000, NOW]);
  });

  it('reports false when the jti was already recorded', async () => {
    const h = makeAdapter({
      execute: () => {
        throw new Error('UNIQUE constraint failed');
      },
    });
    expect(
      await new AdminMachineAccessRepository(h.adapter).recordAssertionJti({
        clientId: 'client-1',
        credentialId: 'amk_1',
        jti: 'jti-1',
        expiresAt: 1,
      })
    ).toBe(false);
  });

  it('updates last-used metadata, defaulting missing values to null', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.updateCredentialLastUsed({
      credentialId: 'amk_1',
      ipAddress: '203.0.113.7',
      userAgent: 'ua/1',
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('UPDATE admin_machine_credentials');
    expect(sql).toContain('SET last_used_at = ?, last_used_ip = ?, last_used_user_agent = ?');
    expect(sql).toContain('WHERE id = ?');
    expect(sql).not.toContain('updated_at');
    expect(params).toStrictEqual([NOW, '203.0.113.7', 'ua/1', 'amk_1']);

    await repo.updateCredentialLastUsed({ credentialId: 'amk_1' });
    expect(h.execute.mock.calls[1][1]).toStrictEqual([NOW, null, null, 'amk_1']);
    await repo.updateCredentialLastUsed({
      credentialId: 'amk_1',
      ipAddress: null,
      userAgent: null,
    });
    expect(h.execute.mock.calls[2][1]).toStrictEqual([NOW, null, null, 'amk_1']);
  });
});
