import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult, HealthStatus, TransactionContext } from '../../db';
import { AdminMachineAccessRepository } from '../admin/admin-machine-access';
import { MockDatabaseAdapter } from './mock-adapter';

let adapter: MockDatabaseAdapter;
let repo: AdminMachineAccessRepository;

beforeEach(() => {
  adapter = new MockDatabaseAdapter();
  adapter.initTable('admin_machine_principals');
  adapter.initTable('admin_machine_credentials');
  adapter.initTable('admin_machine_principal_permissions', 'permission');
  adapter.initTable('admin_machine_credential_permissions', 'permission');
  adapter.initTable('admin_machine_assertion_jti', 'jti');
  repo = new AdminMachineAccessRepository(adapter);
});

describe('AdminMachineAccessRepository', () => {
  it('creates machine principals with explicit actor metadata', async () => {
    const principal = await repo.createPrincipal({
      id: 'amp_setup',
      clientId: 'setup-tool',
      displayName: 'Authrim Setup Tool',
      principalType: 'setup_tool',
      createdBy: { actorType: 'bootstrap', actorId: 'setup' },
    });

    expect(principal).toMatchObject({
      id: 'amp_setup',
      clientId: 'setup-tool',
      displayName: 'Authrim Setup Tool',
      principalType: 'setup_tool',
      status: 'active',
      defaultAudience: 'authrim:admin-api',
      tokenTtlSeconds: 600,
      createdByActorType: 'bootstrap',
      createdByActorId: 'setup',
    });
    expect(adapter.getById('admin_machine_principals', 'amp_setup')).toMatchObject({
      client_id: 'setup-tool',
      principal_type: 'setup_tool',
    });
  });

  it('creates public JWK credentials without storing private key material', async () => {
    const credential = await repo.createCredential({
      id: 'amk_setup_1',
      principalId: 'amp_setup',
      kid: 'setup-2026-05',
      publicJwkJson: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
      alg: 'ES256',
      displayName: 'Setup key',
      createdBy: { actorType: 'bootstrap', actorId: 'setup' },
    });

    expect(credential).toMatchObject({
      id: 'amk_setup_1',
      principalId: 'amp_setup',
      kid: 'setup-2026-05',
      alg: 'ES256',
      status: 'active',
      createdByActorType: 'bootstrap',
      createdByActorId: 'setup',
    });
    const stored = adapter.getById('admin_machine_credentials', 'amk_setup_1');
    expect(stored).toMatchObject({
      public_jwk_json: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
    });
    expect(stored).not.toHaveProperty('private_key');
    expect(stored).not.toHaveProperty('secret');
  });

  it('replaces principal and credential permission grants', async () => {
    await repo.setPrincipalPermissions('amp_setup', ['admin:tenants.read', 'admin:clients.create']);
    await repo.setCredentialPermissions('amk_setup_1', ['admin:clients.create']);

    expect(await repo.getPrincipalPermissions('amp_setup')).toEqual([
      'admin:clients.create',
      'admin:tenants.read',
    ]);
    expect(await repo.getCredentialPermissions('amk_setup_1')).toEqual(['admin:clients.create']);

    await repo.setPrincipalPermissions('amp_setup', ['admin:tenants.read']);
    expect(await repo.getPrincipalPermissions('amp_setup')).toEqual(['admin:tenants.read']);
  });

  it('records assertion jti values for replay detection', async () => {
    const recorded = await repo.recordAssertionJti({
      clientId: 'setup-tool',
      credentialId: 'amk_setup_1',
      jti: 'assertion-1',
      expiresAt: 1778600000,
    });

    expect(recorded).toBe(true);
    expect(adapter.getById('admin_machine_assertion_jti', 'assertion-1')).toMatchObject({
      client_id: 'setup-tool',
      credential_id: 'amk_setup_1',
      expires_at: 1778600000,
    });
  });

  it('updates credential last-used metadata without touching private key material', async () => {
    const execute = vi.fn(async (): Promise<ExecuteResult> => ({ success: true, rowsAffected: 1 }));
    const customRepo = new AdminMachineAccessRepository(
      createAdapter({ execute }) as DatabaseAdapter
    );

    await customRepo.updateCredentialLastUsed({
      credentialId: 'amk_setup_1',
      ipAddress: '203.0.113.10',
      userAgent: 'authrim-setup/1.0',
    });

    expect(execute).toHaveBeenCalledWith(expect.stringContaining('last_used_at'), [
      expect.any(Number),
      '203.0.113.10',
      'authrim-setup/1.0',
      expect.any(Number),
      'amk_setup_1',
    ]);
  });

  it('loads principal and credential by client_id and kid', async () => {
    const queryOne = vi.fn(async () => ({
      id: 'amp_setup',
      client_id: 'setup-tool',
      display_name: 'Authrim Setup Tool',
      description: null,
      principal_type: 'setup_tool',
      status: 'active',
      default_audience: 'authrim:admin-api',
      token_ttl_seconds: 600,
      created_by_actor_type: 'bootstrap',
      created_by_actor_id: 'setup',
      created_at: 1,
      updated_at: 1,
      disabled_at: null,
      disabled_by_actor_type: null,
      disabled_by_actor_id: null,
      credential_id: 'amk_setup_1',
      credential_principal_id: 'amp_setup',
      credential_kid: 'setup-2026-05',
      credential_public_jwk_json: '{"kty":"EC"}',
      credential_alg: 'ES256',
      credential_display_name: 'Setup key',
      credential_description: null,
      credential_status: 'active',
      credential_not_before: null,
      credential_expires_at: null,
      credential_last_used_at: null,
      credential_last_used_ip: null,
      credential_last_used_user_agent: null,
      credential_created_by_actor_type: 'bootstrap',
      credential_created_by_actor_id: 'setup',
      credential_created_at: 1,
      credential_updated_at: 1,
      credential_revoked_at: null,
      credential_revoked_by_actor_type: null,
      credential_revoked_by_actor_id: null,
      credential_revoke_reason: null,
    }));
    const customRepo = new AdminMachineAccessRepository(
      createAdapter({ queryOne }) as DatabaseAdapter
    );

    const result = await customRepo.findCredentialForClient('setup-tool', 'setup-2026-05');

    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('JOIN admin_machine_credentials'),
      ['setup-tool', 'setup-2026-05']
    );
    expect(result?.principal.clientId).toBe('setup-tool');
    expect(result?.credential.id).toBe('amk_setup_1');
  });
});

function createAdapter(overrides: Partial<DatabaseAdapter>): Partial<DatabaseAdapter> {
  const executeResult: ExecuteResult = { success: true, rowsAffected: 1 };
  return {
    query: async () => [],
    queryOne: async () => null,
    execute: async () => executeResult,
    transaction: async <T>(fn: (tx: TransactionContext) => Promise<T>) =>
      fn({
        query: async () => [],
        queryOne: async () => null,
        execute: async () => executeResult,
      }),
    batch: async () => [],
    isHealthy: async (): Promise<HealthStatus> => ({
      healthy: true,
      latencyMs: 0,
      type: 'mock',
    }),
    getType: () => 'mock',
    close: async () => {},
    ...overrides,
  };
}
