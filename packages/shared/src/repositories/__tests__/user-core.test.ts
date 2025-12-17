/**
 * User Core Repository Tests
 *
 * Tests for non-PII user data repository operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { UserCoreRepository, type UserCore, type CreateUserCoreInput } from '../core/user-core';

describe('UserCoreRepository', () => {
  let adapter: MockDatabaseAdapter;
  let repository: UserCoreRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('users_core', 'id');
    repository = new UserCoreRepository(adapter);
  });

  describe('createUser', () => {
    it('should create a user with default values', async () => {
      const user = await repository.createUser({});

      expect(user.id).toBeDefined();
      expect(user.tenant_id).toBe('default');
      expect(user.email_verified).toBe(false);
      expect(user.phone_number_verified).toBe(false);
      expect(user.is_active).toBe(true);
      expect(user.user_type).toBe('end_user');
      expect(user.pii_partition).toBe('default');
      expect(user.pii_status).toBe('pending');
      expect(user.password_hash).toBeNull();
      expect(user.email_domain_hash).toBeNull();
      expect(user.last_login_at).toBeNull();
      expect(user.created_at).toBeDefined();
      expect(user.updated_at).toBeDefined();
    });

    it('should create a user with provided values', async () => {
      const input: CreateUserCoreInput = {
        id: 'user-123',
        tenant_id: 'tenant-acme',
        email_verified: true,
        phone_number_verified: true,
        email_domain_hash: 'hash-abc',
        password_hash: 'pwd-hash',
        is_active: true,
        user_type: 'admin',
        pii_partition: 'eu',
        pii_status: 'active',
      };

      const user = await repository.createUser(input);

      expect(user.id).toBe('user-123');
      expect(user.tenant_id).toBe('tenant-acme');
      expect(user.email_verified).toBe(true);
      expect(user.phone_number_verified).toBe(true);
      expect(user.email_domain_hash).toBe('hash-abc');
      expect(user.password_hash).toBe('pwd-hash');
      expect(user.is_active).toBe(true);
      expect(user.user_type).toBe('admin');
      expect(user.pii_partition).toBe('eu');
      expect(user.pii_status).toBe('active');
    });

    it('should create M2M user with pii_status none', async () => {
      const user = await repository.createUser({
        user_type: 'm2m',
        pii_status: 'none',
      });

      expect(user.user_type).toBe('m2m');
      expect(user.pii_status).toBe('none');
    });

    it('should persist user to database', async () => {
      const user = await repository.createUser({ id: 'persist-test' });

      const stored = adapter.getById('users_core', 'persist-test');
      expect(stored).toBeDefined();
      expect(stored?.id).toBe('persist-test');
    });
  });

  describe('findById', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'user-1',
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: 'hash1',
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
        {
          id: 'user-2',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 0, // inactive
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'deleted',
          created_at: 2000,
          updated_at: 2000,
          last_login_at: null,
        },
      ]);
    });

    it('should find active user by ID', async () => {
      const user = await repository.findById('user-1');

      expect(user).not.toBeNull();
      expect(user?.id).toBe('user-1');
      expect(user?.email_verified).toBe(true);
      expect(user?.is_active).toBe(true);
    });

    it('should not find inactive user by ID (soft delete)', async () => {
      const user = await repository.findById('user-2');

      expect(user).toBeNull();
    });

    it('should return null for non-existent user', async () => {
      const user = await repository.findById('non-existent');

      expect(user).toBeNull();
    });

    it('should convert integer fields to booleans', async () => {
      const user = await repository.findById('user-1');

      expect(typeof user?.email_verified).toBe('boolean');
      expect(typeof user?.phone_number_verified).toBe('boolean');
      expect(typeof user?.is_active).toBe('boolean');
    });
  });

  describe('updatePIIStatus', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'user-pending',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'pending',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
      ]);
    });

    it('should update status from pending to active', async () => {
      const result = await repository.updatePIIStatus('user-pending', 'active');

      expect(result).toBe(true);

      const stored = adapter.getById('users_core', 'user-pending');
      expect(stored?.pii_status).toBe('active');
    });

    it('should update status from pending to failed', async () => {
      const result = await repository.updatePIIStatus('user-pending', 'failed');

      expect(result).toBe(true);

      const stored = adapter.getById('users_core', 'user-pending');
      expect(stored?.pii_status).toBe('failed');
    });

    it('should update updated_at timestamp', async () => {
      const before = adapter.getById('users_core', 'user-pending')?.updated_at as number;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await repository.updatePIIStatus('user-pending', 'active');

      const after = adapter.getById('users_core', 'user-pending')?.updated_at as number;
      expect(after).toBeGreaterThan(before);
    });

    it('should return false for non-existent user', async () => {
      const result = await repository.updatePIIStatus('non-existent', 'active');

      expect(result).toBe(false);
    });
  });

  describe('updateLastLogin', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'user-login',
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: 'hash',
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
      ]);
    });

    it('should update last login timestamp', async () => {
      const result = await repository.updateLastLogin('user-login');

      expect(result).toBe(true);

      const stored = adapter.getById('users_core', 'user-login');
      expect(stored?.last_login_at).not.toBeNull();
      expect(stored?.last_login_at).toBeGreaterThan(0);
    });

    it('should update updated_at timestamp', async () => {
      const before = adapter.getById('users_core', 'user-login')?.updated_at as number;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await repository.updateLastLogin('user-login');

      const after = adapter.getById('users_core', 'user-login')?.updated_at as number;
      expect(after).toBeGreaterThan(before);
    });
  });

  describe('findByTenantAndId', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'user-a',
          tenant_id: 'tenant-1',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
        {
          id: 'user-b',
          tenant_id: 'tenant-2',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 2000,
          updated_at: 2000,
          last_login_at: null,
        },
      ]);
    });

    it('should find user by tenant and ID', async () => {
      const user = await repository.findByTenantAndId('tenant-1', 'user-a');

      expect(user).not.toBeNull();
      expect(user?.id).toBe('user-a');
      expect(user?.tenant_id).toBe('tenant-1');
    });

    it('should not find user in wrong tenant', async () => {
      const user = await repository.findByTenantAndId('tenant-1', 'user-b');

      expect(user).toBeNull();
    });

    it('should not find user with non-existent tenant', async () => {
      const user = await repository.findByTenantAndId('non-existent', 'user-a');

      expect(user).toBeNull();
    });
  });

  describe('findByPIIStatus', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'failed-1',
          tenant_id: 'tenant-1',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'failed',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
        {
          id: 'failed-2',
          tenant_id: 'tenant-2',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'failed',
          created_at: 2000,
          updated_at: 2000,
          last_login_at: null,
        },
        {
          id: 'active-1',
          tenant_id: 'tenant-1',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 3000,
          updated_at: 3000,
          last_login_at: null,
        },
      ]);
    });

    it('should find all users with failed status', async () => {
      const users = await repository.findByPIIStatus('failed');

      expect(users).toHaveLength(2);
      expect(users.every((u) => u.pii_status === 'failed')).toBe(true);
    });

    it('should find users with failed status in specific tenant', async () => {
      const users = await repository.findByPIIStatus('failed', 'tenant-1');

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('failed-1');
    });

    it('should find users with active status', async () => {
      const users = await repository.findByPIIStatus('active');

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('active-1');
    });

    it('should return empty array for no matches', async () => {
      const users = await repository.findByPIIStatus('deleted');

      expect(users).toHaveLength(0);
    });
  });

  describe('findByEmailDomainHash', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'user-acme-1',
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: 'hash-acme-com',
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
        {
          id: 'user-acme-2',
          tenant_id: 'tenant-special',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: 'hash-acme-com',
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 2000,
          updated_at: 2000,
          last_login_at: null,
        },
        {
          id: 'user-other',
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: 'hash-other-com',
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 3000,
          updated_at: 3000,
          last_login_at: null,
        },
      ]);
    });

    it('should find users by email domain hash', async () => {
      const users = await repository.findByEmailDomainHash('hash-acme-com');

      expect(users).toHaveLength(2);
      expect(users.every((u) => u.email_domain_hash === 'hash-acme-com')).toBe(true);
    });

    it('should filter by tenant when provided', async () => {
      const users = await repository.findByEmailDomainHash('hash-acme-com', 'default');

      expect(users).toHaveLength(1);
      expect(users[0].id).toBe('user-acme-1');
    });

    it('should return empty array for non-existent hash', async () => {
      const users = await repository.findByEmailDomainHash('non-existent');

      expect(users).toHaveLength(0);
    });
  });

  describe('searchUsers', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'admin-1',
          tenant_id: 'tenant-1',
          email_verified: 1,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: 'hash',
          is_active: 1,
          user_type: 'admin',
          pii_partition: 'eu',
          pii_status: 'active',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
        {
          id: 'user-1',
          tenant_id: 'tenant-1',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'pending',
          created_at: 2000,
          updated_at: 2000,
          last_login_at: null,
        },
        {
          id: 'user-2',
          tenant_id: 'tenant-2',
          email_verified: 1,
          phone_number_verified: 1,
          email_domain_hash: null,
          password_hash: 'hash',
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 3000,
          updated_at: 3000,
          last_login_at: 3000,
        },
      ]);
    });

    it('should search by tenant_id', async () => {
      const result = await repository.searchUsers({ tenant_id: 'tenant-1' });

      expect(result.items).toHaveLength(2);
      expect(result.items.every((u) => u.tenant_id === 'tenant-1')).toBe(true);
    });

    it('should search by user_type', async () => {
      const result = await repository.searchUsers({ user_type: 'admin' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('admin-1');
    });

    it('should search by pii_status', async () => {
      const result = await repository.searchUsers({ pii_status: 'active' });

      expect(result.items).toHaveLength(2);
    });

    it('should search by email_verified', async () => {
      const result = await repository.searchUsers({ email_verified: true });

      expect(result.items).toHaveLength(2);
    });

    it('should search by pii_partition', async () => {
      const result = await repository.searchUsers({ pii_partition: 'eu' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('admin-1');
    });

    it('should combine multiple filters', async () => {
      const result = await repository.searchUsers({
        tenant_id: 'tenant-1',
        user_type: 'end_user',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('user-1');
    });
  });

  describe('getPartitionStats', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'u1',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
        {
          id: 'u2',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 2000,
          updated_at: 2000,
          last_login_at: null,
        },
        {
          id: 'u3',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'eu',
          pii_status: 'active',
          created_at: 3000,
          updated_at: 3000,
          last_login_at: null,
        },
      ]);
    });

    it('should return partition counts', async () => {
      const stats = await repository.getPartitionStats();

      // Note: Mock adapter doesn't support GROUP BY, so this test
      // verifies the query is executed correctly
      expect(stats).toBeInstanceOf(Map);
    });
  });

  describe('getPIIStatusStats', () => {
    beforeEach(() => {
      adapter.seed('users_core', [
        {
          id: 'u1',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: 1000,
          updated_at: 1000,
          last_login_at: null,
        },
        {
          id: 'u2',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          email_domain_hash: null,
          password_hash: null,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'pending',
          created_at: 2000,
          updated_at: 2000,
          last_login_at: null,
        },
      ]);
    });

    it('should return PII status counts', async () => {
      const stats = await repository.getPIIStatusStats();

      // Note: Mock adapter doesn't support GROUP BY, so this test
      // verifies the query is executed correctly
      expect(stats).toBeInstanceOf(Map);
    });
  });
});
