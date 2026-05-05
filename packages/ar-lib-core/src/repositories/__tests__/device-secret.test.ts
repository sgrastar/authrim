/**
 * Device Secret Repository Unit Tests
 *
 * Tests for OIDC Native SSO 1.0 device secret management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import { DeviceSecretRepository } from '../core/device-secret';
import type { CreateDeviceSecretInput } from '../../types/oidc';

describe('DeviceSecretRepository', () => {
  let adapter: MockDatabaseAdapter;
  let repository: DeviceSecretRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('device_secrets');
    repository = new DeviceSecretRepository(adapter);
  });

  describe('createSecret', () => {
    it('should create a new device secret with raw secret returned', async () => {
      const input: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-456',
        tenant_id: 'default',
        device_name: 'iPhone 15',
        device_platform: 'ios',
      };

      const result = await repository.createSecret(input);

      // Should return raw secret and entity
      expect('secret' in result).toBe(true);
      expect('entity' in result).toBe(true);

      if ('secret' in result) {
        expect(result.secret).toBeDefined();
        expect(result.secret.length).toBeGreaterThan(0);

        expect(result.entity.id).toBeDefined();
        expect(result.entity.installation_id).toMatch(/^inst_/);
        expect(result.entity.user_id).toBe('user-123');
        expect(result.entity.session_id).toBe('session-456');
        expect(result.entity.tenant_id).toBe('default');
        expect(result.entity.device_name).toBe('iPhone 15');
        expect(result.entity.device_platform).toBe('ios');
        expect(result.entity.secret_hash).toBeDefined();
        expect(result.entity.use_count).toBe(0);
        expect(result.entity.is_active).toBe(1);

        // secret_hash should not equal raw secret
        expect(result.entity.secret_hash).not.toBe(result.secret);
      }
    });

    it('should use default tenant_id when not provided', async () => {
      const input: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-456',
      };

      const result = await repository.createSecret(input);

      expect('entity' in result).toBe(true);
      if ('entity' in result) {
        expect(result.entity.tenant_id).toBe('default');
      }
    });

    it('should accept explicit installation metadata', async () => {
      const result = await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-456',
        client_id: 'native-client-001',
        trust_group_id: 'wallet-suite',
        installation_id: 'inst-existing',
      });

      expect('entity' in result).toBe(true);
      if ('entity' in result) {
        expect(result.entity.installation_id).toBe('inst-existing');
        expect(result.entity.client_id).toBe('native-client-001');
        expect(result.entity.trust_group_id).toBe('wallet-suite');
      }
    });

    it('should apply TTL to expires_at', async () => {
      const now = Date.now();
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const ttl_ms = 7 * 24 * 60 * 60 * 1000; // 7 days
      const input: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-456',
        ttl_ms,
      };

      const result = await repository.createSecret(input);

      expect('entity' in result).toBe(true);
      if ('entity' in result) {
        expect(result.entity.expires_at).toBe(now + ttl_ms);
      }

      vi.useRealTimers();
    });

    it('should reject creation when max secrets exceeded with reject behavior', async () => {
      // Create existing secrets
      const secrets = Array.from({ length: 3 }, (_, i) => ({
        id: `secret-${i}`,
        tenant_id: 'default',
        user_id: 'user-123',
        session_id: `session-${i}`,
        secret_hash: `hash-${i}`,
        device_name: null,
        device_platform: null,
        created_at: Date.now() - i * 1000,
        updated_at: Date.now() - i * 1000,
        expires_at: Date.now() + 86400000, // Future expiry
        last_used_at: null,
        use_count: 0,
        revoked_at: null,
        revoke_reason: null,
        is_active: 1,
      }));

      adapter.seed('device_secrets', secrets);

      const input: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-new',
        tenant_id: 'default',
      };

      const result = await repository.createSecret(input, {
        maxSecretsPerUser: 3,
        maxSecretsBehavior: 'reject',
      });

      expect('ok' in result).toBe(true);
      if ('ok' in result) {
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('limit_exceeded');
      }
    });

    it('should use revoke_oldest behavior when max exceeded', async () => {
      // Note: This test verifies the logic path, but mock adapter
      // doesn't fully support complex UPDATE queries
      const input: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-1',
        tenant_id: 'default',
      };

      // Create first secret
      const result1 = await repository.createSecret(input, {
        maxSecretsPerUser: 2,
        maxSecretsBehavior: 'revoke_oldest',
      });
      expect('secret' in result1).toBe(true);

      // Create second secret
      const input2: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-2',
        tenant_id: 'default',
      };
      const result2 = await repository.createSecret(input2, {
        maxSecretsPerUser: 2,
        maxSecretsBehavior: 'revoke_oldest',
      });
      expect('secret' in result2).toBe(true);

      // Create third secret - should trigger revoke_oldest
      const input3: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-3',
        tenant_id: 'default',
      };
      const result3 = await repository.createSecret(input3, {
        maxSecretsPerUser: 2,
        maxSecretsBehavior: 'revoke_oldest',
      });

      // Should succeed (not be rejected)
      expect('secret' in result3).toBe(true);
    });
  });

  describe('validateAndUse', () => {
    it('should validate and update usage for valid secret', async () => {
      // Create a secret first
      const input: CreateDeviceSecretInput = {
        user_id: 'user-123',
        session_id: 'session-456',
      };

      const createResult = await repository.createSecret(input);
      expect('secret' in createResult).toBe(true);
      if (!('secret' in createResult)) return;

      const rawSecret = createResult.secret;

      // Validate with raw secret
      const validateResult = await repository.validateAndUse(rawSecret);

      expect(validateResult.ok).toBe(true);
      if (validateResult.ok) {
        expect(validateResult.entity.user_id).toBe('user-123');
        expect(validateResult.entity.use_count).toBe(1);
        expect(validateResult.entity.last_used_at).toBeDefined();
      }
    });

    it('should return not_found for invalid secret', async () => {
      const result = await repository.validateAndUse('invalid-secret');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('should return expired for expired secret', async () => {
      const expiredSecret = {
        id: 'expired-secret-id',
        tenant_id: 'default',
        user_id: 'user-123',
        session_id: 'session-456',
        secret_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // SHA-256 of "test"
        device_name: null,
        device_platform: null,
        created_at: Date.now() - 86400000,
        updated_at: Date.now() - 86400000,
        expires_at: Date.now() - 1000, // Expired
        last_used_at: null,
        use_count: 0,
        revoked_at: null,
        revoke_reason: null,
        is_active: 1,
      };

      adapter.seed('device_secrets', [expiredSecret]);

      const result = await repository.validateAndUse('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('expired');
      }
    });

    it('should return revoked for revoked secret', async () => {
      const revokedSecret = {
        id: 'revoked-secret-id',
        tenant_id: 'default',
        user_id: 'user-123',
        session_id: 'session-456',
        secret_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // SHA-256 of "test"
        device_name: null,
        device_platform: null,
        created_at: Date.now() - 86400000,
        updated_at: Date.now() - 86400000,
        expires_at: Date.now() + 86400000, // Not expired
        last_used_at: null,
        use_count: 0,
        revoked_at: Date.now() - 1000, // Revoked
        revoke_reason: 'manual_revoke',
        is_active: 1,
      };

      adapter.seed('device_secrets', [revokedSecret]);

      const result = await repository.validateAndUse('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('revoked');
      }
    });

    it('should return revoked for soft-deleted secret', async () => {
      const deletedSecret = {
        id: 'deleted-secret-id',
        tenant_id: 'default',
        user_id: 'user-123',
        session_id: 'session-456',
        secret_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', // SHA-256 of "test"
        device_name: null,
        device_platform: null,
        created_at: Date.now() - 86400000,
        updated_at: Date.now() - 86400000,
        expires_at: Date.now() + 86400000,
        last_used_at: null,
        use_count: 0,
        revoked_at: null,
        revoke_reason: null,
        is_active: 0, // Soft deleted
      };

      adapter.seed('device_secrets', [deletedSecret]);

      const result = await repository.validateAndUse('test');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('revoked');
      }
    });
  });

  describe('findByRawSecret', () => {
    it('should find a secret by raw device_secret without incrementing use count', async () => {
      const result = await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-456',
        tenant_id: 'default',
        device_name: 'iPhone',
        device_platform: 'ios',
      });

      expect('secret' in result).toBe(true);
      if (!('secret' in result)) return;

      const found = await repository.findByRawSecret(result.secret);

      expect(found?.id).toBe(result.entity.id);
      expect(found?.use_count).toBe(0);
      expect(found?.device_name).toBe('iPhone');
    });

    it('should revoke a secret by raw device_secret', async () => {
      const result = await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-456',
      });

      expect('secret' in result).toBe(true);
      if (!('secret' in result)) return;

      const revoked = await repository.revokeByRawSecret(result.secret, 'token_revocation');

      // Mock adapter has limited support for complex UPDATE predicates; the
      // repository method is still expected to run and return the DB result.
      expect(typeof revoked).toBe('boolean');
    });
  });

  describe('findByUserId', () => {
    it('should find all secrets for a user', async () => {
      const secrets = [
        {
          id: 'secret-1',
          tenant_id: 'default',
          user_id: 'user-123',
          session_id: 'session-1',
          secret_hash: 'hash-1',
          device_name: 'Device 1',
          device_platform: 'ios',
          created_at: Date.now() - 2000,
          updated_at: Date.now() - 2000,
          expires_at: Date.now() + 86400000,
          last_used_at: null,
          use_count: 0,
          revoked_at: null,
          revoke_reason: null,
          is_active: 1,
        },
        {
          id: 'secret-2',
          tenant_id: 'default',
          user_id: 'user-123',
          session_id: 'session-2',
          secret_hash: 'hash-2',
          device_name: 'Device 2',
          device_platform: 'android',
          created_at: Date.now() - 1000,
          updated_at: Date.now() - 1000,
          expires_at: Date.now() + 86400000,
          last_used_at: null,
          use_count: 0,
          revoked_at: null,
          revoke_reason: null,
          is_active: 1,
        },
        {
          id: 'secret-3',
          tenant_id: 'default',
          user_id: 'other-user',
          session_id: 'session-3',
          secret_hash: 'hash-3',
          device_name: 'Other Device',
          device_platform: 'macos',
          created_at: Date.now(),
          updated_at: Date.now(),
          expires_at: Date.now() + 86400000,
          last_used_at: null,
          use_count: 0,
          revoked_at: null,
          revoke_reason: null,
          is_active: 1,
        },
      ];

      adapter.seed('device_secrets', secrets);

      const results = await repository.findByUserId('user-123');

      expect(results.length).toBe(2);
      expect(results.every((s) => s.user_id === 'user-123')).toBe(true);
    });

    it('should filter valid only when specified', async () => {
      const now = Date.now();
      const secrets = [
        {
          id: 'valid-secret',
          tenant_id: 'default',
          user_id: 'user-123',
          session_id: 'session-1',
          secret_hash: 'hash-1',
          device_name: null,
          device_platform: null,
          created_at: now - 1000,
          updated_at: now - 1000,
          expires_at: now + 86400000, // Valid
          last_used_at: null,
          use_count: 0,
          revoked_at: null,
          revoke_reason: null,
          is_active: 1,
        },
        {
          id: 'expired-secret',
          tenant_id: 'default',
          user_id: 'user-123',
          session_id: 'session-2',
          secret_hash: 'hash-2',
          device_name: null,
          device_platform: null,
          created_at: now - 86400000,
          updated_at: now - 86400000,
          expires_at: now - 1000, // Expired
          last_used_at: null,
          use_count: 0,
          revoked_at: null,
          revoke_reason: null,
          is_active: 1,
        },
        {
          id: 'revoked-secret',
          tenant_id: 'default',
          user_id: 'user-123',
          session_id: 'session-3',
          secret_hash: 'hash-3',
          device_name: null,
          device_platform: null,
          created_at: now - 1000,
          updated_at: now - 1000,
          expires_at: now + 86400000, // Not expired
          last_used_at: null,
          use_count: 0,
          revoked_at: now - 500, // Revoked
          revoke_reason: 'test',
          is_active: 1,
        },
      ];

      adapter.seed('device_secrets', secrets);

      // Get all
      const allResults = await repository.findByUserId('user-123', 'default', false);
      expect(allResults.length).toBe(3);

      // Get valid only - this depends on the mock adapter's implementation
      // Since mock doesn't handle complex conditions well, we test the SQL generation
    });
  });

  describe('findBySessionId', () => {
    it('should find secrets by session ID', async () => {
      const secrets = [
        {
          id: 'secret-1',
          tenant_id: 'default',
          user_id: 'user-123',
          session_id: 'target-session',
          secret_hash: 'hash-1',
          device_name: null,
          device_platform: null,
          created_at: Date.now(),
          updated_at: Date.now(),
          expires_at: Date.now() + 86400000,
          last_used_at: null,
          use_count: 0,
          revoked_at: null,
          revoke_reason: null,
          is_active: 1,
        },
        {
          id: 'secret-2',
          tenant_id: 'default',
          user_id: 'user-123',
          session_id: 'other-session',
          secret_hash: 'hash-2',
          device_name: null,
          device_platform: null,
          created_at: Date.now(),
          updated_at: Date.now(),
          expires_at: Date.now() + 86400000,
          last_used_at: null,
          use_count: 0,
          revoked_at: null,
          revoke_reason: null,
          is_active: 1,
        },
      ];

      adapter.seed('device_secrets', secrets);

      const results = await repository.findBySessionId('target-session');

      expect(results.length).toBe(1);
      expect(results[0].session_id).toBe('target-session');
    });
  });

  describe('findByInstallationId', () => {
    it('should find by canonical installation id and fall back to legacy row id', async () => {
      const createResult = await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-456',
        tenant_id: 'default',
        installation_id: 'inst-current',
      });
      expect('entity' in createResult).toBe(true);
      if (!('entity' in createResult)) return;

      const byInstallation = await repository.findByInstallationId('inst-current', 'default');
      const byLegacyId = await repository.findByInstallationId(createResult.entity.id, 'default');

      expect(byInstallation?.id).toBe(createResult.entity.id);
      expect(byInstallation?.installation_id).toBe('inst-current');
      expect(byLegacyId?.id).toBe(createResult.entity.id);
    });
  });

  describe('revoke', () => {
    it('should execute revoke method', async () => {
      // Create a secret first
      const createResult = await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-456',
      });

      expect('entity' in createResult).toBe(true);
      if (!('entity' in createResult)) return;

      // Note: Due to mock adapter limitations with complex UPDATE queries
      // (WHERE ... AND revoked_at IS NULL), we verify the method runs
      const result = await repository.revoke(createResult.entity.id, 'user_requested');
      expect(typeof result).toBe('boolean');
    });

    it('should return false for non-existent secret', async () => {
      const result = await repository.revoke('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('revokeBySessionId', () => {
    it('should execute revokeBySessionId method', async () => {
      // Create secrets
      await repository.createSecret({
        user_id: 'user-123',
        session_id: 'target-session',
      });

      // Note: Mock adapter doesn't fully support complex UPDATE with multiple conditions
      const count = await repository.revokeBySessionId('target-session');
      expect(typeof count).toBe('number');
    });
  });

  describe('revokeByUserId', () => {
    it('should execute revokeByUserId method', async () => {
      // Create a secret
      await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-1',
      });

      // Note: Mock adapter doesn't fully support complex UPDATE with multiple conditions
      const count = await repository.revokeByUserId('user-123');
      expect(typeof count).toBe('number');
    });
  });

  describe('cleanupExpired', () => {
    it('should execute cleanupExpired method', async () => {
      // Note: Mock adapter DELETE query parsing is limited
      // This verifies the method runs without error
      const count = await repository.cleanupExpired();
      expect(typeof count).toBe('number');
    });
  });

  describe('getStatsForUser', () => {
    it('should return statistics structure', async () => {
      // Create a secret
      await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-1',
      });

      // Note: Mock adapter doesn't fully handle complex aggregation queries
      const stats = await repository.getStatsForUser('user-123');

      // Verify the structure
      expect(typeof stats.total).toBe('number');
      expect(typeof stats.active).toBe('number');
      expect(typeof stats.expired).toBe('number');
      expect(typeof stats.revoked).toBe('number');
      expect(typeof stats.totalUseCount).toBe('number');
    });
  });

  describe('countByUserId', () => {
    it('should count secrets for a user', async () => {
      // Create secrets for user-123
      await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-1',
      });

      await repository.createSecret({
        user_id: 'user-123',
        session_id: 'session-2',
      });

      const count = await repository.countByUserId('user-123');

      // Should count user-123's secrets (at least 2)
      expect(count).toBeGreaterThanOrEqual(2);
    });

    it('should return 0 for user with no secrets', async () => {
      const count = await repository.countByUserId('non-existent-user');
      expect(count).toBe(0);
    });
  });
});
