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

describe('principal and credential lookups', () => {
  it('finds a principal by client id', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.findPrincipalByClientId('client-1')).toStrictEqual(PRINCIPAL_MODEL);
    expect(h.queryOne).toHaveBeenCalledWith(
      'SELECT * FROM admin_machine_principals WHERE client_id = ?',
      ['client-1']
    );
    expect(
      await new AdminMachineAccessRepository(makeAdapter().adapter).findPrincipalByClientId('x')
    ).toBeNull();
  });

  it('finds a principal by id', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.findPrincipalById('amp_1')).toStrictEqual(PRINCIPAL_MODEL);
    expect(h.queryOne).toHaveBeenCalledWith('SELECT * FROM admin_machine_principals WHERE id = ?', [
      'amp_1',
    ]);
    expect(
      await new AdminMachineAccessRepository(makeAdapter().adapter).findPrincipalById('x')
    ).toBeNull();
  });

  it('finds a credential by id', async () => {
    const h = makeAdapter({ queryOne: () => credentialRow() });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.findCredentialById('amk_1')).toStrictEqual(CREDENTIAL_MODEL);
    expect(h.queryOne).toHaveBeenCalledWith(
      'SELECT * FROM admin_machine_credentials WHERE id = ?',
      ['amk_1']
    );
    expect(
      await new AdminMachineAccessRepository(makeAdapter().adapter).findCredentialById('x')
    ).toBeNull();
  });

  it('lists credentials of a principal newest first', async () => {
    const h = makeAdapter({
      query: () => [credentialRow(), credentialRow({ id: 'amk_2', kid: 'kid-2' })],
    });
    const repo = new AdminMachineAccessRepository(h.adapter);
    const credentials = await repo.listCredentials('amp_1');
    expect(credentials).toStrictEqual([
      CREDENTIAL_MODEL,
      { ...CREDENTIAL_MODEL, id: 'amk_2', kid: 'kid-2' },
    ]);
    const [sql, params] = h.query.mock.calls[0];
    expect(sql).toContain('FROM admin_machine_credentials');
    expect(sql).toContain('WHERE principal_id = ?');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toStrictEqual(['amp_1']);
  });
});

describe('listPrincipals', () => {
  it('lists without filters using default paging', async () => {
    const h = makeAdapter({ query: () => [principalRow(), principalRow({ id: 'amp_2' })] });
    const repo = new AdminMachineAccessRepository(h.adapter);
    const result = await repo.listPrincipals();
    expect(result).toStrictEqual([PRINCIPAL_MODEL, { ...PRINCIPAL_MODEL, id: 'amp_2' }]);
    const [sql, params] = h.query.mock.calls[0];
    expect(sql).not.toContain('WHERE');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(params).toStrictEqual([50, 0]);
  });

  it('filters by status and principal type', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.listPrincipals({ status: 'disabled' });
    expect(h.query.mock.calls[0][0]).toContain('WHERE status = ?');
    expect(h.query.mock.calls[0][1]).toStrictEqual(['disabled', 50, 0]);

    await repo.listPrincipals({ principalType: 'ci' });
    expect(h.query.mock.calls[1][0]).toContain('WHERE principal_type = ?');
    expect(h.query.mock.calls[1][1]).toStrictEqual(['ci', 50, 0]);

    await repo.listPrincipals({
      status: 'active',
      principalType: 'ai_agent',
      limit: 5,
      offset: 10,
    });
    expect(h.query.mock.calls[2][0]).toContain('WHERE status = ? AND principal_type = ?');
    expect(h.query.mock.calls[2][1]).toStrictEqual(['active', 'ai_agent', 5, 10]);
  });

  it.each([
    [undefined, 50],
    [0, 1],
    [-4, 1],
    [1, 1],
    [99, 99],
    [100, 100],
    [101, 100],
    [5000, 100],
  ])('clamps limit %s to %s', async (limit, expected) => {
    const h = makeAdapter();
    await new AdminMachineAccessRepository(h.adapter).listPrincipals({ limit });
    expect(h.query.mock.calls[0][1]).toStrictEqual([expected, 0]);
  });

  it.each([
    [undefined, 0],
    [-1, 0],
    [0, 0],
    [3, 3],
    [1000, 1000],
  ])('clamps offset %s to %s', async (offset, expected) => {
    const h = makeAdapter();
    await new AdminMachineAccessRepository(h.adapter).listPrincipals({ offset });
    expect(h.query.mock.calls[0][1]).toStrictEqual([50, expected]);
  });
});

describe('updatePrincipal', () => {
  it('does not write when there is nothing to update and returns the stored principal', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.updatePrincipal('amp_1', {})).toStrictEqual(PRINCIPAL_MODEL);
    expect(h.batch).not.toHaveBeenCalled();
    expect(h.queryOne).toHaveBeenCalledTimes(1);
  });

  it('returns null when the principal does not exist after the update', async () => {
    const h = makeAdapter();
    expect(
      await new AdminMachineAccessRepository(h.adapter).updatePrincipal('amp_x', {
        displayName: 'x',
      })
    ).toBeNull();
    expect(h.batch).toHaveBeenCalledTimes(1);
  });

  it('updates every plain field in a fixed order', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.updatePrincipal('amp_1', {
      displayName: 'New',
      description: null,
      status: 'active',
      tokenTtlSeconds: 0,
    });
    expect(h.batch.mock.calls[0][0]).toStrictEqual([
      {
        sql: 'UPDATE admin_machine_principals SET display_name = ?, description = ?, status = ?, token_ttl_seconds = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
        params: ['New', null, 'active', 0, NOW, 'amp_1'],
      },
    ]);
  });

  it.each(['disabled', 'deleted'] as const)(
    'records who disabled the principal when status becomes %s',
    async (status) => {
      const h = makeAdapter({ queryOne: () => principalRow() });
      await new AdminMachineAccessRepository(h.adapter).updatePrincipal('amp_1', {
        status,
        disabledBy: { actorType: 'admin', actorId: 'adm' },
      });
      expect(h.batch.mock.calls[0][0]).toStrictEqual([
        {
          sql: 'UPDATE admin_machine_principals SET status = ?, disabled_at = ?, disabled_by_actor_type = ?, disabled_by_actor_id = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
          params: [status, NOW, 'admin', 'adm', NOW, 'amp_1'],
        },
      ]);
    }
  );

  it('stores null disabler fields when no actor is given', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    await new AdminMachineAccessRepository(h.adapter).updatePrincipal('amp_1', {
      status: 'disabled',
      disabledBy: {},
    });
    expect(h.batch.mock.calls[0][0][0].params).toStrictEqual([
      'disabled',
      NOW,
      null,
      null,
      NOW,
      'amp_1',
    ]);
  });

  it('passes the guard through to the batch', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    await new AdminMachineAccessRepository(h.adapter).updatePrincipal(
      'amp_1',
      { displayName: 'x' },
      { principal: { id: 'amp_1', revision: 'r' } }
    );
    expect(h.batch.mock.calls[0][0]).toHaveLength(2);
    expect(h.batch.mock.calls[0][0][0].sql).toContain('revision_check');
  });
});

describe('updatePrincipalWithGrant', () => {
  it('uses the field update plus the grant statements', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    const result = await new AdminMachineAccessRepository(h.adapter).updatePrincipalWithGrant(
      'amp_1',
      { displayName: 'New' },
      { permissions: ['admin:a'] },
      { actorType: 'admin', actorId: 'adm' }
    );
    expect(result).toStrictEqual(PRINCIPAL_MODEL);
    const statements = h.batch.mock.calls[0][0];
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain('SET display_name = ?');
    expect(statements[1].sql).toBe(
      'DELETE FROM admin_machine_principal_permissions WHERE principal_id = ?'
    );
    expect(statements[2].params).toStrictEqual(['amp_1', 'admin:a', NOW, 'admin', 'adm']);
  });

  it('touches updated_at when only the grant changes', async () => {
    const h = makeAdapter({ queryOne: () => principalRow() });
    await new AdminMachineAccessRepository(h.adapter).updatePrincipalWithGrant(
      'amp_1',
      {},
      { tenantScopes: [{ scopeMode: 'none', tenantId: null }] }
    );
    const statements = h.batch.mock.calls[0][0];
    expect(statements[0]).toStrictEqual({
      sql: 'UPDATE admin_machine_principals SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
      params: [NOW, 'amp_1'],
    });
    expect(statements).toHaveLength(3);
    expect(statements[2].params).toStrictEqual(['amp_1', 'none', null, NOW, null, null]);
  });

  it('returns null for a vanished principal', async () => {
    const h = makeAdapter();
    expect(
      await new AdminMachineAccessRepository(h.adapter).updatePrincipalWithGrant('amp_1', {}, {})
    ).toBeNull();
  });
});

describe('updateCredential', () => {
  it('does not write when there is nothing to update', async () => {
    const h = makeAdapter({ queryOne: () => credentialRow() });
    expect(
      await new AdminMachineAccessRepository(h.adapter).updateCredential('amk_1', {})
    ).toStrictEqual(CREDENTIAL_MODEL);
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('returns null for a missing credential', async () => {
    const h = makeAdapter();
    expect(
      await new AdminMachineAccessRepository(h.adapter).updateCredential('amk_x', {
        displayName: 'x',
      })
    ).toBeNull();
  });

  it('updates every plain field in a fixed order', async () => {
    const h = makeAdapter({ queryOne: () => credentialRow() });
    await new AdminMachineAccessRepository(h.adapter).updateCredential('amk_1', {
      displayName: 'N',
      description: null,
      status: 'expired',
      notBefore: null,
      expiresAt: 0,
      revokeReason: null,
    });
    expect(h.batch.mock.calls[0][0]).toStrictEqual([
      {
        sql: 'UPDATE admin_machine_credentials SET display_name = ?, description = ?, status = ?, not_before = ?, expires_at = ?, revoke_reason = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
        params: ['N', null, 'expired', null, 0, null, NOW, 'amk_1'],
      },
    ]);
  });

  it('records who revoked the credential only for status revoked', async () => {
    const h = makeAdapter({ queryOne: () => credentialRow() });
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.updateCredential('amk_1', {
      status: 'revoked',
      revokedBy: { actorType: 'admin', actorId: 'adm' },
      revokeReason: 'leaked',
    });
    expect(h.batch.mock.calls[0][0]).toStrictEqual([
      {
        sql: 'UPDATE admin_machine_credentials SET status = ?, revoked_at = ?, revoked_by_actor_type = ?, revoked_by_actor_id = ?, revoke_reason = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
        params: ['revoked', NOW, 'admin', 'adm', 'leaked', NOW, 'amk_1'],
      },
    ]);

    await repo.updateCredential('amk_1', { status: 'revoked' });
    expect(h.batch.mock.calls[1][0][0].params).toStrictEqual([
      'revoked',
      NOW,
      null,
      null,
      NOW,
      'amk_1',
    ]);

    await repo.updateCredential('amk_1', { status: 'rotating', revokedBy: { actorId: 'x' } });
    expect(h.batch.mock.calls[2][0][0].sql).not.toContain('revoked_at');
    expect(h.batch.mock.calls[2][0][0].params).toStrictEqual(['rotating', NOW, 'amk_1']);
  });

  it('passes the guard through to the batch', async () => {
    const h = makeAdapter({ queryOne: () => credentialRow() });
    await new AdminMachineAccessRepository(h.adapter).updateCredential(
      'amk_1',
      { displayName: 'x' },
      { credential: { id: 'amk_1', revision: 'r' } }
    );
    expect(h.batch.mock.calls[0][0]).toHaveLength(2);
    expect(h.batch.mock.calls[0][0][0].params).toStrictEqual(['amk_1', 'amk_1', 'amk_1', 'r']);
  });
});

describe('updateCredentialWithGrant', () => {
  it('uses the field update plus the credential grant statements', async () => {
    const h = makeAdapter({ queryOne: () => credentialRow() });
    const result = await new AdminMachineAccessRepository(h.adapter).updateCredentialWithGrant(
      'amk_1',
      { displayName: 'N' },
      { permissions: ['admin:a'], tenantScopes: [{ scopeMode: 'allow', tenantId: 't1' }] },
      { actorType: 'admin', actorId: 'adm' }
    );
    expect(result).toStrictEqual(CREDENTIAL_MODEL);
    const statements = h.batch.mock.calls[0][0];
    expect(statements).toHaveLength(5);
    expect(statements[0].sql).toContain('UPDATE admin_machine_credentials SET display_name = ?');
    expect(statements[1].sql).toBe(
      'DELETE FROM admin_machine_credential_permissions WHERE credential_id = ?'
    );
    expect(statements[2].params).toStrictEqual(['amk_1', 'admin:a', NOW, 'admin', 'adm']);
    expect(statements[3].sql).toBe(
      'DELETE FROM admin_machine_credential_tenant_scopes WHERE credential_id = ?'
    );
    expect(statements[4].params).toStrictEqual(['amk_1', 'allow', 't1', NOW, 'admin', 'adm']);
  });

  it('touches updated_at when only the grant changes', async () => {
    const h = makeAdapter({ queryOne: () => credentialRow() });
    await new AdminMachineAccessRepository(h.adapter).updateCredentialWithGrant(
      'amk_1',
      {},
      { permissions: [] }
    );
    expect(h.batch.mock.calls[0][0][0]).toStrictEqual({
      sql: 'UPDATE admin_machine_credentials SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
      params: [NOW, 'amk_1'],
    });
  });

  it('returns null for a vanished credential', async () => {
    const h = makeAdapter();
    expect(
      await new AdminMachineAccessRepository(h.adapter).updateCredentialWithGrant('amk_1', {}, {})
    ).toBeNull();
  });
});
