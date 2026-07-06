import { beforeEach, describe, expect, it } from 'vitest';
import { TotpCredentialRepository } from '../core/totp-credential';
import { MockDatabaseAdapter } from './mock-adapter';

describe('TotpCredentialRepository', () => {
  let adapter: MockDatabaseAdapter;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('totp_credentials', 'id');
    adapter.initTable('totp_backup_codes', 'id');
  });

  it('creates and lists credentials only within the repository tenant', async () => {
    const tenantARepository = new TotpCredentialRepository(adapter, 'tenant-a');
    const tenantBRepository = new TotpCredentialRepository(adapter, 'tenant-b');

    await tenantARepository.create({
      id: 'totp-a',
      user_id: 'user-1',
      secret_encrypted: 'enc:a',
      label: 'Phone',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'active',
    });
    await tenantBRepository.create({
      id: 'totp-b',
      user_id: 'user-1',
      secret_encrypted: 'enc:b',
      label: 'Other tenant',
      algorithm: 'SHA256',
      digits: 8,
      period: 30,
      window: 1,
      status: 'active',
    });

    await expect(tenantARepository.findActiveByUserId('user-1')).resolves.toMatchObject([
      { id: 'totp-a', tenant_id: 'tenant-a', label: 'Phone' },
    ]);
    await expect(tenantBRepository.findActiveByUserId('user-1')).resolves.toMatchObject([
      { id: 'totp-b', tenant_id: 'tenant-b', label: 'Other tenant' },
    ]);
  });

  it('activates only pending credentials for the same user', async () => {
    const repository = new TotpCredentialRepository(adapter, 'tenant-a');
    await repository.create({
      id: 'totp-pending',
      user_id: 'user-1',
      secret_encrypted: 'enc:a',
      label: null,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'pending',
    });

    const activated = await repository.activate('totp-pending', 'user-1', 123);

    expect(activated).toMatchObject({
      id: 'totp-pending',
      status: 'active',
      last_used_time_step: 123,
    });
  });

  it('uses an atomic time-step predicate when marking a credential as used', async () => {
    const repository = new TotpCredentialRepository(adapter, 'tenant-a');
    await repository.create({
      id: 'totp-active',
      user_id: 'user-1',
      secret_encrypted: 'enc:a',
      label: null,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 1,
      status: 'active',
    });

    await expect(repository.markUsed('totp-active', 'user-1', 123)).resolves.toBe(true);
    expect(adapter.getById('totp_credentials', 'totp-active')).toMatchObject({
      last_used_time_step: 123,
    });
    expect(
      adapter
        .getQueryLog()
        .some((entry) => entry.sql.includes('last_used_time_step < ?'))
    ).toBe(true);
  });

  it('replaces and consumes backup codes without exposing other users', async () => {
    const repository = new TotpCredentialRepository(adapter, 'tenant-a');
    await repository.replaceBackupCodes('user-1', 'totp-a', [
      {
        id: 'code-a',
        user_id: 'user-1',
        credential_id: 'totp-a',
        code_hash: 'hash-a',
        code_prefix: 'ABCD',
      },
    ]);
    await repository.replaceBackupCodes('user-2', 'totp-b', [
      {
        id: 'code-b',
        user_id: 'user-2',
        credential_id: 'totp-b',
        code_hash: 'hash-b',
        code_prefix: 'WXYZ',
      },
    ]);

    await expect(repository.listBackupCodes('user-1')).resolves.toMatchObject([
      { id: 'code-a', user_id: 'user-1', code_prefix: 'ABCD', used_at: null },
    ]);
    await expect(repository.consumeBackupCode('user-1', 'hash-b')).resolves.toBeNull();

    const consumed = await repository.consumeBackupCode('user-1', 'hash-a');
    expect(consumed).toMatchObject({ id: 'code-a', used_at: expect.any(Number) });
    await expect(repository.consumeBackupCode('user-1', 'hash-a')).resolves.toBeNull();
  });
});
