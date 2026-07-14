import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { LinkedIdentityRepository, type LinkedIdentity } from '../pii/linked-identity';

function adapter() {
  return {
    query: vi.fn().mockResolvedValue([]),
    queryOne: vi.fn().mockResolvedValue(null),
    execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 1 }),
  } as unknown as DatabaseAdapter;
}

function identity(rawAttributes: string | null): LinkedIdentity {
  return {
    id: 'identity-1',
    tenant_id: 'tenant-a',
    user_id: 'user-1',
    provider_id: 'provider-1',
    provider_user_id: 'external-1',
    provider_email: null,
    provider_name: null,
    raw_attributes: rawAttributes,
    linked_at: 1,
    last_used_at: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe('LinkedIdentityRepository PII boundaries', () => {
  it('rejects tenantless creation before writing PII', async () => {
    const db = adapter();
    const repository = new LinkedIdentityRepository(db);

    await expect(
      repository.createLinkedIdentity({
        tenant_id: ' ',
        user_id: 'user-1',
        provider_id: 'provider-1',
        provider_user_id: 'external-1',
      })
    ).rejects.toThrow('LinkedIdentityRepository create requires tenantId');
    expect(db.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['findByProviderUser', ['', 'provider-1', 'external-1']],
    ['findByUserId', ['', 'user-1']],
    ['findByUserAndProvider', ['', 'user-1', 'provider-1']],
    ['findByProviderEmail', ['', 'user@example.com']],
    ['updateLinkedIdentity', ['', 'identity-1', {}]],
    ['updateLastUsed', ['', 'identity-1']],
    ['deleteLinkedIdentity', ['', 'identity-1']],
    ['deleteByUserId', ['', 'user-1']],
    ['unlink', ['', 'user-1', 'provider-1']],
    ['getProviderStats', ['']],
  ] as const)('%s rejects an empty tenant before database access', async (method, args) => {
    const db = adapter();
    const repository = new LinkedIdentityRepository(db);
    const callable = repository[method] as (...values: never[]) => Promise<unknown>;

    await expect(callable.apply(repository, args as never)).rejects.toThrow('requires tenantId');
    expect(db.query).not.toHaveBeenCalled();
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('scopes provider statistics to one tenant', async () => {
    const db = adapter();
    vi.mocked(db.query).mockResolvedValue([
      { provider_id: 'google', count: 2 },
      { provider_id: 'saml', count: 1 },
    ]);
    const repository = new LinkedIdentityRepository(db);

    await expect(repository.getProviderStats('tenant-a')).resolves.toEqual(
      new Map([
        ['google', 2],
        ['saml', 1],
      ])
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = ? GROUP BY provider_id'),
      ['tenant-a']
    );
  });

  it('returns only plain-object raw attributes at the PII parsing boundary', () => {
    const repository = new LinkedIdentityRepository(adapter());

    expect(repository.getRawAttributes(identity('{"groups":["staff"]}'))).toEqual({
      groups: ['staff'],
    });
    expect(repository.getRawAttributes(identity('null'))).toBeNull();
    expect(repository.getRawAttributes(identity('["admin"]'))).toBeNull();
    expect(repository.getRawAttributes(identity('"admin"'))).toBeNull();
    expect(repository.getRawAttributes(identity('{'))).toBeNull();
  });

  it('keeps cross-tenant lookup behind its explicitly named maintenance method', async () => {
    const db = adapter();
    const repository = new LinkedIdentityRepository(db);

    await repository.findAcrossTenantsByProviderUser('provider-1', 'external-1');
    expect(db.query).toHaveBeenCalledWith(
      'SELECT * FROM linked_identities WHERE provider_id = ? AND provider_user_id = ?',
      ['provider-1', 'external-1']
    );
  });
});
