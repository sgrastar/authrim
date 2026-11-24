import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, makeAdapter } from './admin-machine-access.mutation-helpers';
import {
  AdminMachineAccessRepository,
  AdminMachineConflictError,
  type AdminMachineWriteGuard,
} from '../admin/admin-machine-access';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('principal and credential creation', () => {
  it('createPrincipal stores defaults and returns the mapped principal', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const principal = await repo.createPrincipal({
      clientId: 'client-1',
      displayName: 'P',
      principalType: 'ci',
    });
    expect(principal).toStrictEqual({
      id: principal.id,
      clientId: 'client-1',
      displayName: 'P',
      description: null,
      principalType: 'ci',
      status: 'active',
      defaultAudience: 'authrim:admin-api',
      tokenTtlSeconds: 600,
      createdByActorType: null,
      createdByActorId: null,
      createdAt: NOW,
      updatedAt: NOW,
      disabledAt: null,
      disabledByActorType: null,
      disabledByActorId: null,
    });
    expect(principal.id).not.toBe('');
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO admin_machine_principals');
    expect(params).toStrictEqual([
      principal.id,
      'client-1',
      'P',
      null,
      'ci',
      'active',
      'authrim:admin-api',
      600,
      null,
      null,
      NOW,
      NOW,
      null,
      null,
      null,
    ]);
    expect(h.batch).not.toHaveBeenCalled();
  });

  it('createPrincipal honours every explicit input', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const principal = await repo.createPrincipal({
      id: 'amp_x',
      clientId: 'c',
      displayName: 'D',
      description: 'why',
      principalType: 'mcp_server',
      status: 'disabled',
      defaultAudience: 'aud',
      tokenTtlSeconds: 0,
      createdBy: { actorType: 'admin', actorId: 'adm' },
    });
    expect(principal).toMatchObject({
      id: 'amp_x',
      description: 'why',
      status: 'disabled',
      defaultAudience: 'aud',
      tokenTtlSeconds: 0,
      createdByActorType: 'admin',
      createdByActorId: 'adm',
    });
    expect(h.execute.mock.calls[0][1]).toStrictEqual([
      'amp_x',
      'c',
      'D',
      'why',
      'mcp_server',
      'disabled',
      'aud',
      0,
      'admin',
      'adm',
      NOW,
      NOW,
      null,
      null,
      null,
    ]);
  });

  it('createPrincipalWithGrant writes the principal and its grant in one batch', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const principal = await repo.createPrincipalWithGrant(
      { id: 'amp_g', clientId: 'c', displayName: 'D', principalType: 'ci' },
      {
        permissions: ['admin:a', 'admin:b', 'admin:a'],
        tenantScopes: [
          { scopeMode: 'allow', tenantId: 't1' },
          { scopeMode: 'allow', tenantId: 't1' },
          { scopeMode: 'all', tenantId: null },
          { scopeMode: 'allow', tenantId: 't2' },
        ],
      },
      { actorType: 'admin', actorId: 'adm' }
    );
    expect(principal.id).toBe('amp_g');
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.batch).toHaveBeenCalledTimes(1);
    const statements = h.batch.mock.calls[0][0];
    expect(statements).toHaveLength(1 + 1 + 2 + 1 + 3);
    expect(statements[0].sql).toContain('INSERT INTO admin_machine_principals');
    expect(statements[0].params[0]).toBe('amp_g');
    expect(statements[1]).toStrictEqual({
      sql: 'DELETE FROM admin_machine_principal_permissions WHERE principal_id = ?',
      params: ['amp_g'],
    });
    expect(statements[2].sql).toContain('INSERT INTO admin_machine_principal_permissions');
    expect(statements[2].sql).toContain('principal_id, permission, created_at');
    expect(statements[2].params).toStrictEqual(['amp_g', 'admin:a', NOW, 'admin', 'adm']);
    expect(statements[3].params).toStrictEqual(['amp_g', 'admin:b', NOW, 'admin', 'adm']);
    expect(statements[4]).toStrictEqual({
      sql: 'DELETE FROM admin_machine_principal_tenant_scopes WHERE principal_id = ?',
      params: ['amp_g'],
    });
    expect(statements[5].sql).toContain('INSERT INTO admin_machine_principal_tenant_scopes');
    expect(statements[5].params).toStrictEqual(['amp_g', 'allow', 't1', NOW, 'admin', 'adm']);
    expect(statements[6].params).toStrictEqual(['amp_g', 'all', null, NOW, 'admin', 'adm']);
    expect(statements[7].params).toStrictEqual(['amp_g', 'allow', 't2', NOW, 'admin', 'adm']);
  });

  it('createPrincipalWithGrant leaves out grants that were not given and defaults the actor to null', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.createPrincipalWithGrant(
      { id: 'amp_g', clientId: 'c', displayName: 'D', principalType: 'ci' },
      { permissions: ['admin:a'] }
    );
    const onlyPerms = h.batch.mock.calls[0][0];
    expect(onlyPerms).toHaveLength(3);
    expect(onlyPerms[2].params).toStrictEqual(['amp_g', 'admin:a', NOW, null, null]);

    await repo.createPrincipalWithGrant(
      { id: 'amp_h', clientId: 'c2', displayName: 'D', principalType: 'ci' },
      { tenantScopes: [] }
    );
    const onlyScopes = h.batch.mock.calls[1][0];
    expect(onlyScopes).toHaveLength(2);
    expect(onlyScopes[1].sql).toBe(
      'DELETE FROM admin_machine_principal_tenant_scopes WHERE principal_id = ?'
    );

    await repo.createPrincipalWithGrant(
      { id: 'amp_i', clientId: 'c3', displayName: 'D', principalType: 'ci' },
      {}
    );
    expect(h.batch.mock.calls[2][0]).toHaveLength(1);
  });

  it('createCredential stores defaults and returns the mapped credential', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const credential = await repo.createCredential({
      principalId: 'amp_1',
      kid: 'kid-1',
      publicJwkJson: '{"kty":"EC"}',
      alg: 'PS256',
      displayName: 'Key',
    });
    expect(credential).toStrictEqual({
      id: credential.id,
      principalId: 'amp_1',
      kid: 'kid-1',
      publicJwkJson: '{"kty":"EC"}',
      alg: 'PS256',
      displayName: 'Key',
      description: null,
      status: 'active',
      notBefore: null,
      expiresAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      lastUsedUserAgent: null,
      createdByActorType: null,
      createdByActorId: null,
      createdAt: NOW,
      updatedAt: NOW,
      revokedAt: null,
      revokedByActorType: null,
      revokedByActorId: null,
      revokeReason: null,
    });
    const [sql, params] = h.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO admin_machine_credentials');
    expect(params).toStrictEqual([
      credential.id,
      'amp_1',
      'kid-1',
      '{"kty":"EC"}',
      'PS256',
      'Key',
      null,
      'active',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      NOW,
      NOW,
      null,
      null,
      null,
      null,
    ]);
  });

  it('createCredential honours explicit inputs', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const credential = await repo.createCredential({
      id: 'amk_x',
      principalId: 'amp_1',
      kid: 'k',
      publicJwkJson: '{}',
      alg: 'RS256',
      displayName: 'K',
      description: 'd',
      status: 'rotating',
      notBefore: 5,
      expiresAt: 0,
      createdBy: { actorType: 'bootstrap', actorId: 'setup' },
    });
    expect(credential).toMatchObject({
      id: 'amk_x',
      description: 'd',
      status: 'rotating',
      notBefore: 5,
      expiresAt: 0,
      createdByActorType: 'bootstrap',
      createdByActorId: 'setup',
    });
    const params = h.execute.mock.calls[0][1];
    expect(params.slice(6, 10)).toStrictEqual(['d', 'rotating', 5, 0]);
    expect(params.slice(13, 15)).toStrictEqual(['bootstrap', 'setup']);
  });

  const credentialInput = {
    id: 'amk_new',
    principalId: 'amp_1',
    kid: 'k',
    publicJwkJson: '{}',
    alg: 'ES256' as const,
    displayName: 'K',
  };

  it('createCredentialWithGrant batches without a guard check when no guard is given', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const credential = await repo.createCredentialWithGrant(
      credentialInput,
      { permissions: ['admin:a'], tenantScopes: [{ scopeMode: 'allow', tenantId: 't1' }] },
      { actorType: 'admin', actorId: 'adm' }
    );
    expect(credential.id).toBe('amk_new');
    expect(h.batch).toHaveBeenCalledTimes(1);
    const statements = h.batch.mock.calls[0][0];
    expect(statements.map((s) => s.sql.split('\n')[0].trim())).toStrictEqual([
      'INSERT INTO admin_machine_credentials (',
      'DELETE FROM admin_machine_credential_permissions WHERE credential_id = ?',
      'INSERT INTO admin_machine_credential_permissions (',
      'DELETE FROM admin_machine_credential_tenant_scopes WHERE credential_id = ?',
      'INSERT INTO admin_machine_credential_tenant_scopes (',
    ]);
    expect(statements[1].params).toStrictEqual(['amk_new']);
    expect(statements[2].sql).toContain('credential_id, permission, created_at');
    expect(statements[4].sql).toContain('credential_id, scope_mode, tenant_id, created_at');
    expect(h.queryOne).not.toHaveBeenCalled();
  });

  it('createCredentialWithGrant prepends revision checks for each guard entry', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.createCredentialWithGrant(credentialInput, { permissions: [] }, undefined, {
      principal: { id: 'amp_1', revision: 'rev-p' },
      credential: { id: 'amk_old', revision: 'rev-c' },
    });
    const statements = h.batch.mock.calls[0][0];
    expect(statements).toHaveLength(2 + 2);
    expect(statements[0].sql).toContain('FROM admin_machine_principals p WHERE p.id = ?');
    expect(statements[0].sql).toContain('abs(-9223372036854775807 - 1) END AS revision_check');
    expect(statements[0].params).toStrictEqual(['amp_1', 'amp_1', 'amp_1', 'rev-p']);
    expect(statements[1].sql).toContain('FROM admin_machine_credentials p WHERE p.id = ?');
    expect(statements[1].params).toStrictEqual(['amk_old', 'amk_old', 'amk_old', 'rev-c']);
    expect(statements[2].sql).toContain('INSERT INTO admin_machine_credentials');
  });

  it('a guard with neither entry is treated as no guard', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.createCredentialWithGrant(credentialInput, {}, undefined, {});
    expect(h.batch.mock.calls[0][0]).toHaveLength(1);
  });

  it('rotateCredential updates the previous key, inserts the next and its grant in order', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    const next = await repo.rotateCredential({
      previousCredentialId: 'amk_old',
      previousUpdate: {
        status: 'rotating',
        expiresAt: 999,
      },
      next: credentialInput,
      grant: { permissions: ['admin:a'] },
      actor: { actorType: 'admin', actorId: 'adm' },
      guard: { principal: { id: 'amp_1', revision: 'r1' } },
    });
    expect(next.id).toBe('amk_new');
    const statements = h.batch.mock.calls[0][0];
    expect(statements).toHaveLength(1 + 1 + 1 + 2);
    expect(statements[0].sql).toContain('revision_check');
    expect(statements[1]).toStrictEqual({
      sql: 'UPDATE admin_machine_credentials SET status = ?, expires_at = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
      params: ['rotating', 999, NOW, 'amk_old'],
    });
    expect(statements[2].sql).toContain('INSERT INTO admin_machine_credentials');
    expect(statements[3].sql).toContain('DELETE FROM admin_machine_credential_permissions');
    expect(statements[4].params).toStrictEqual(['amk_new', 'admin:a', NOW, 'admin', 'adm']);
  });

  it('rotateCredential skips the previous-key update when it has no fields', async () => {
    const h = makeAdapter();
    const repo = new AdminMachineAccessRepository(h.adapter);
    await repo.rotateCredential({
      previousCredentialId: 'amk_old',
      previousUpdate: {},
      next: credentialInput,
      grant: {},
    });
    const statements = h.batch.mock.calls[0][0];
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('INSERT INTO admin_machine_credentials');
  });
});

describe('guarded batch failures', () => {
  const guard: AdminMachineWriteGuard = {
    principal: { id: 'amp_1', revision: 'rev-p' },
    credential: { id: 'amk_1', revision: 'rev-c' },
  };

  function failingRepo(revisions: { principal?: string | null; credential?: string | null }) {
    const failure = new Error('batch failed');
    const h = makeAdapter({
      batch: () => {
        throw failure;
      },
      queryOne: (sql) => {
        if (sql.includes('FROM admin_machine_principals p WHERE p.id = ?')) {
          return revisions.principal === null ? null : { revision: revisions.principal };
        }
        if (sql.includes('FROM admin_machine_credentials p WHERE p.id = ?')) {
          return revisions.credential === null ? null : { revision: revisions.credential };
        }
        return null;
      },
    });
    return { h, failure, repo: new AdminMachineAccessRepository(h.adapter) };
  }

  const attempt = (repo: AdminMachineAccessRepository, g: AdminMachineWriteGuard) =>
    repo.updateCredentialWithGrant('amk_1', { displayName: 'x' }, {}, undefined, g);

  it('rethrows the original error when the revisions are unchanged', async () => {
    const { h, failure, repo } = failingRepo({ principal: 'rev-p', credential: 'rev-c' });
    await expect(attempt(repo, guard)).rejects.toBe(failure);
    expect(h.queryOne).toHaveBeenCalledTimes(2);
    expect(h.queryOne.mock.calls[0][1]).toStrictEqual(['amp_1', 'amp_1', 'amp_1']);
    expect(h.queryOne.mock.calls[1][1]).toStrictEqual(['amk_1', 'amk_1', 'amk_1']);
  });

  it('throws a conflict when the principal revision moved', async () => {
    const { repo } = failingRepo({ principal: 'other', credential: 'rev-c' });
    const error = await attempt(repo, guard).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminMachineConflictError);
    expect((error as Error).message).toBe('admin_machine_access_conflict');
    expect((error as Error).name).toBe('AdminMachineConflictError');
  });

  it('throws a conflict when only the credential revision moved', async () => {
    const { repo } = failingRepo({ principal: 'rev-p', credential: 'other' });
    await expect(attempt(repo, guard)).rejects.toBeInstanceOf(AdminMachineConflictError);
  });

  it('throws a conflict when the guarded row is gone', async () => {
    const gone = failingRepo({ principal: null, credential: 'rev-c' });
    await expect(attempt(gone.repo, guard)).rejects.toBeInstanceOf(AdminMachineConflictError);
    const goneCredential = failingRepo({ principal: 'rev-p', credential: null });
    await expect(attempt(goneCredential.repo, guard)).rejects.toBeInstanceOf(
      AdminMachineConflictError
    );
  });

  it('only re-reads the revisions that were guarded', async () => {
    const principalOnly = failingRepo({ principal: 'rev-p' });
    await expect(attempt(principalOnly.repo, { principal: guard.principal })).rejects.toBe(
      principalOnly.failure
    );
    expect(principalOnly.h.queryOne).toHaveBeenCalledTimes(1);
    expect(principalOnly.h.queryOne.mock.calls[0][0]).toContain('admin_machine_principals p');

    const credentialOnly = failingRepo({ credential: 'rev-c' });
    await expect(attempt(credentialOnly.repo, { credential: guard.credential })).rejects.toBe(
      credentialOnly.failure
    );
    expect(credentialOnly.h.queryOne).toHaveBeenCalledTimes(1);
    expect(credentialOnly.h.queryOne.mock.calls[0][0]).toContain('admin_machine_credentials p');
  });

  it('does not wrap failures of unguarded batches', async () => {
    const failure = new Error('boom');
    const h = makeAdapter({
      batch: () => {
        throw failure;
      },
    });
    const repo = new AdminMachineAccessRepository(h.adapter);
    await expect(repo.updateCredentialWithGrant('amk_1', {}, {})).rejects.toBe(failure);
    expect(h.queryOne).not.toHaveBeenCalled();
  });
});

describe('revision expressions', () => {
  it('reads the principal revision with its credentials folded in', async () => {
    const h = makeAdapter({ queryOne: () => ({ revision: 'abc' }) });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.getPrincipalRevision('amp_1')).toBe('abc');
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).toContain('AS revision');
    expect(sql).toContain('FROM admin_machine_principals p WHERE p.id = ?');
    expect(sql).toContain('admin_machine_principal_permissions');
    expect(sql).toContain('admin_machine_principal_tenant_scopes');
    expect(sql).toContain('WHERE principal_id = ? ORDER BY permission');
    expect(sql).toContain('admin_machine_credential_permissions');
    expect(sql).toContain('FROM admin_machine_credentials WHERE principal_id = p.id');
    expect(sql).not.toContain("COALESCE(p.not_before, '')");
    expect(params).toStrictEqual(['amp_1', 'amp_1', 'amp_1']);
  });

  it('reads the credential revision with its validity window', async () => {
    const h = makeAdapter({ queryOne: () => ({ revision: 'def' }) });
    const repo = new AdminMachineAccessRepository(h.adapter);
    expect(await repo.getCredentialRevision('amk_1')).toBe('def');
    const [sql, params] = h.queryOne.mock.calls[0];
    expect(sql).toContain('FROM admin_machine_credentials p WHERE p.id = ?');
    expect(sql).toContain("COALESCE(p.not_before, '')");
    expect(sql).toContain("COALESCE(p.expires_at, '')");
    expect(sql).toContain('admin_machine_credential_permissions');
    expect(sql).toContain('WHERE credential_id = ? ORDER BY permission');
    expect(sql).not.toContain('FROM admin_machine_credentials WHERE principal_id = p.id');
    expect(params).toStrictEqual(['amk_1', 'amk_1', 'amk_1']);
  });

  it('returns null for a missing row or a null revision', async () => {
    const missing = new AdminMachineAccessRepository(makeAdapter().adapter);
    expect(await missing.getPrincipalRevision('x')).toBeNull();
    expect(await missing.getCredentialRevision('x')).toBeNull();
    const nulled = new AdminMachineAccessRepository(
      makeAdapter({ queryOne: () => ({ revision: null }) }).adapter
    );
    expect(await nulled.getPrincipalRevision('x')).toBeNull();
    expect(await nulled.getCredentialRevision('x')).toBeNull();
  });
});
