/**
 * User PII Repository Tests
 *
 * Tests for personal identifiable information repository operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockDatabaseAdapter } from './mock-adapter';
import {
  UserPIIRepository,
  type UserPII,
  type CreateUserPIIInput,
  type OIDCUserInfo,
} from '../pii/user-pii';

describe('UserPIIRepository', () => {
  let adapter: MockDatabaseAdapter;
  let repository: UserPIIRepository;

  beforeEach(() => {
    adapter = new MockDatabaseAdapter();
    adapter.initTable('users_pii', 'id');
    repository = new UserPIIRepository(adapter);
  });

  describe('createPII', () => {
    it('should create PII record with required fields', async () => {
      const pii = await repository.createPII({
        id: 'user-123',
        email: 'test@example.com',
      });

      expect(pii.id).toBe('user-123');
      expect(pii.email).toBe('test@example.com');
      expect(pii.tenant_id).toBe('default');
      expect(pii.pii_class).toBe('PROFILE');
      expect(pii.created_at).toBeDefined();
      expect(pii.updated_at).toBeDefined();
    });

    it('should create PII record with all fields', async () => {
      const input: CreateUserPIIInput = {
        id: 'user-full',
        tenant_id: 'tenant-acme',
        pii_class: 'IDENTITY_CORE',
        email: 'john.doe@example.com',
        email_blind_index: 'blind-hash-123',
        phone_number: '+81-90-1234-5678',
        name: 'John Doe',
        given_name: 'John',
        family_name: 'Doe',
        nickname: 'johnny',
        preferred_username: 'johnd',
        picture: 'https://example.com/pic.jpg',
        website: 'https://johndoe.com',
        gender: 'male',
        birthdate: '1990-01-15',
        locale: 'en-US',
        zoneinfo: 'America/New_York',
        address_formatted: '123 Main St, City, ST 12345',
        address_street_address: '123 Main St',
        address_locality: 'City',
        address_region: 'ST',
        address_postal_code: '12345',
        address_country: 'US',
        declared_residence: 'US',
      };

      const pii = await repository.createPII(input);

      expect(pii.id).toBe('user-full');
      expect(pii.tenant_id).toBe('tenant-acme');
      expect(pii.pii_class).toBe('IDENTITY_CORE');
      expect(pii.email).toBe('john.doe@example.com');
      expect(pii.email_blind_index).toBe('blind-hash-123');
      expect(pii.phone_number).toBe('+81-90-1234-5678');
      expect(pii.name).toBe('John Doe');
      expect(pii.given_name).toBe('John');
      expect(pii.family_name).toBe('Doe');
      expect(pii.nickname).toBe('johnny');
      expect(pii.preferred_username).toBe('johnd');
      expect(pii.picture).toBe('https://example.com/pic.jpg');
      expect(pii.website).toBe('https://johndoe.com');
      expect(pii.gender).toBe('male');
      expect(pii.birthdate).toBe('1990-01-15');
      expect(pii.locale).toBe('en-US');
      expect(pii.zoneinfo).toBe('America/New_York');
      expect(pii.address_formatted).toBe('123 Main St, City, ST 12345');
      expect(pii.address_street_address).toBe('123 Main St');
      expect(pii.address_locality).toBe('City');
      expect(pii.address_region).toBe('ST');
      expect(pii.address_postal_code).toBe('12345');
      expect(pii.address_country).toBe('US');
      expect(pii.declared_residence).toBe('US');
    });

    it('should persist PII to database', async () => {
      await repository.createPII({
        id: 'persist-test',
        email: 'persist@example.com',
      });

      const stored = adapter.getById('users_pii', 'persist-test');
      expect(stored).toBeDefined();
      expect(stored?.email).toBe('persist@example.com');
    });

    it('should use provided adapter when specified', async () => {
      const otherAdapter = new MockDatabaseAdapter();
      otherAdapter.initTable('users_pii', 'id');

      await repository.createPII(
        {
          id: 'partition-test',
          email: 'partition@example.com',
        },
        otherAdapter
      );

      // Should be in otherAdapter, not default adapter
      const inDefault = adapter.getById('users_pii', 'partition-test');
      const inOther = otherAdapter.getById('users_pii', 'partition-test');

      expect(inDefault).toBeUndefined();
      expect(inOther).toBeDefined();
      expect(inOther?.email).toBe('partition@example.com');
    });
  });

  describe('findByUserId', () => {
    beforeEach(() => {
      adapter.seed('users_pii', [
        {
          id: 'user-1',
          tenant_id: 'default',
          pii_class: 'PROFILE',
          email: 'user1@example.com',
          email_blind_index: 'blind-1',
          phone_number: null,
          name: 'User One',
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ]);
    });

    it('should find PII by user ID', async () => {
      const pii = await repository.findByUserId('user-1');

      expect(pii).not.toBeNull();
      expect(pii?.id).toBe('user-1');
      expect(pii?.email).toBe('user1@example.com');
      expect(pii?.name).toBe('User One');
    });

    it('should return null for non-existent user', async () => {
      const pii = await repository.findByUserId('non-existent');

      expect(pii).toBeNull();
    });

    it('should use provided adapter when specified', async () => {
      const otherAdapter = new MockDatabaseAdapter();
      otherAdapter.initTable('users_pii', 'id');
      otherAdapter.seed('users_pii', [
        {
          id: 'partition-user',
          tenant_id: 'default',
          pii_class: 'PROFILE',
          email: 'partition@example.com',
          email_blind_index: null,
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ]);

      const fromDefault = await repository.findByUserId('partition-user');
      const fromOther = await repository.findByUserId('partition-user', otherAdapter);

      expect(fromDefault).toBeNull();
      expect(fromOther).not.toBeNull();
      expect(fromOther?.email).toBe('partition@example.com');
    });
  });

  describe('findByEmailBlindIndex', () => {
    beforeEach(() => {
      adapter.seed('users_pii', [
        {
          id: 'user-a',
          tenant_id: 'tenant-1',
          pii_class: 'PROFILE',
          email: 'usera@example.com',
          email_blind_index: 'blind-hash-a',
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 1000,
          updated_at: 1000,
        },
        {
          id: 'user-b',
          tenant_id: 'tenant-2',
          pii_class: 'PROFILE',
          email: 'userb@example.com',
          email_blind_index: 'blind-hash-b',
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 2000,
          updated_at: 2000,
        },
      ]);
    });

    it('should find PII by email blind index and tenant', async () => {
      const pii = await repository.findByEmailBlindIndex('blind-hash-a', 'tenant-1');

      expect(pii).not.toBeNull();
      expect(pii?.id).toBe('user-a');
    });

    it('should not find PII in wrong tenant', async () => {
      const pii = await repository.findByEmailBlindIndex('blind-hash-a', 'tenant-2');

      expect(pii).toBeNull();
    });

    it('should return null for non-existent blind index', async () => {
      const pii = await repository.findByEmailBlindIndex('non-existent', 'tenant-1');

      expect(pii).toBeNull();
    });
  });

  describe('updatePII', () => {
    beforeEach(() => {
      adapter.seed('users_pii', [
        {
          id: 'user-update',
          tenant_id: 'default',
          pii_class: 'PROFILE',
          email: 'original@example.com',
          email_blind_index: 'blind-original',
          phone_number: null,
          name: 'Original Name',
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ]);
    });

    it('should update single field', async () => {
      const updated = await repository.updatePII('user-update', {
        name: 'Updated Name',
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.email).toBe('original@example.com'); // unchanged
    });

    it('should update multiple fields', async () => {
      const updated = await repository.updatePII('user-update', {
        name: 'New Name',
        given_name: 'New',
        family_name: 'Name',
        locale: 'ja-JP',
      });

      expect(updated?.name).toBe('New Name');
      expect(updated?.given_name).toBe('New');
      expect(updated?.family_name).toBe('Name');
      expect(updated?.locale).toBe('ja-JP');
    });

    it('should update pii_class', async () => {
      const updated = await repository.updatePII('user-update', {
        pii_class: 'DEMOGRAPHIC',
        gender: 'female',
        birthdate: '1995-05-20',
      });

      expect(updated?.pii_class).toBe('DEMOGRAPHIC');
      expect(updated?.gender).toBe('female');
      expect(updated?.birthdate).toBe('1995-05-20');
    });

    it('should return null for non-existent user', async () => {
      const updated = await repository.updatePII('non-existent', {
        name: 'Test',
      });

      expect(updated).toBeNull();
    });
  });

  describe('deletePII', () => {
    beforeEach(() => {
      adapter.seed('users_pii', [
        {
          id: 'user-delete',
          tenant_id: 'default',
          pii_class: 'PROFILE',
          email: 'delete@example.com',
          email_blind_index: null,
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ]);
    });

    it('should delete PII record (hard delete)', async () => {
      const result = await repository.deletePII('user-delete');

      expect(result).toBe(true);

      const stored = adapter.getById('users_pii', 'user-delete');
      expect(stored).toBeUndefined();
    });

    it('should return false for non-existent user', async () => {
      const result = await repository.deletePII('non-existent');

      expect(result).toBe(false);
    });

    it('should use provided adapter when specified', async () => {
      const otherAdapter = new MockDatabaseAdapter();
      otherAdapter.initTable('users_pii', 'id');
      otherAdapter.seed('users_pii', [
        {
          id: 'partition-delete',
          tenant_id: 'default',
          pii_class: 'PROFILE',
          email: 'pdelete@example.com',
          email_blind_index: null,
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 1000,
          updated_at: 1000,
        },
      ]);

      const result = await repository.deletePII('partition-delete', otherAdapter);

      expect(result).toBe(true);

      const stored = otherAdapter.getById('users_pii', 'partition-delete');
      expect(stored).toBeUndefined();
    });
  });

  describe('toOIDCUserInfo', () => {
    it('should convert PII to minimal OIDC UserInfo', () => {
      const pii: UserPII = {
        id: 'user-123',
        tenant_id: 'default',
        pii_class: 'PROFILE',
        email: 'test@example.com',
        email_blind_index: null,
        phone_number: null,
        name: null,
        given_name: null,
        family_name: null,
        nickname: null,
        preferred_username: null,
        picture: null,
        website: null,
        gender: null,
        birthdate: null,
        locale: null,
        zoneinfo: null,
        address_formatted: null,
        address_street_address: null,
        address_locality: null,
        address_region: null,
        address_postal_code: null,
        address_country: null,
        declared_residence: null,
        created_at: 1000,
        updated_at: 1000,
      };

      const userInfo = repository.toOIDCUserInfo(pii, true, false);

      expect(userInfo.sub).toBe('user-123');
      expect(userInfo.email).toBe('test@example.com');
      expect(userInfo.email_verified).toBe(true);
      expect(userInfo.phone_number).toBeUndefined();
      expect(userInfo.name).toBeUndefined();
      expect(userInfo.address).toBeUndefined();
    });

    it('should convert PII with all fields to OIDC UserInfo', () => {
      const pii: UserPII = {
        id: 'user-full',
        tenant_id: 'default',
        pii_class: 'PROFILE',
        email: 'john@example.com',
        email_blind_index: null,
        phone_number: '+1-555-1234',
        name: 'John Doe',
        given_name: 'John',
        family_name: 'Doe',
        nickname: 'johnny',
        preferred_username: 'johnd',
        picture: 'https://example.com/pic.jpg',
        website: 'https://johndoe.com',
        gender: 'male',
        birthdate: '1990-01-15',
        locale: 'en-US',
        zoneinfo: 'America/New_York',
        address_formatted: '123 Main St',
        address_street_address: '123 Main St',
        address_locality: 'City',
        address_region: 'ST',
        address_postal_code: '12345',
        address_country: 'US',
        declared_residence: 'US',
        created_at: 1000,
        updated_at: 1000,
      };

      const userInfo = repository.toOIDCUserInfo(pii, true, true);

      expect(userInfo.sub).toBe('user-full');
      expect(userInfo.email).toBe('john@example.com');
      expect(userInfo.email_verified).toBe(true);
      expect(userInfo.phone_number).toBe('+1-555-1234');
      expect(userInfo.phone_number_verified).toBe(true);
      expect(userInfo.name).toBe('John Doe');
      expect(userInfo.given_name).toBe('John');
      expect(userInfo.family_name).toBe('Doe');
      expect(userInfo.nickname).toBe('johnny');
      expect(userInfo.preferred_username).toBe('johnd');
      expect(userInfo.picture).toBe('https://example.com/pic.jpg');
      expect(userInfo.website).toBe('https://johndoe.com');
      expect(userInfo.gender).toBe('male');
      expect(userInfo.birthdate).toBe('1990-01-15');
      expect(userInfo.locale).toBe('en-US');
      expect(userInfo.zoneinfo).toBe('America/New_York');
      expect(userInfo.address).toBeDefined();
      expect(userInfo.address?.formatted).toBe('123 Main St');
      expect(userInfo.address?.street_address).toBe('123 Main St');
      expect(userInfo.address?.locality).toBe('City');
      expect(userInfo.address?.region).toBe('ST');
      expect(userInfo.address?.postal_code).toBe('12345');
      expect(userInfo.address?.country).toBe('US');
    });

    it('should include partial address when some fields present', () => {
      const pii: UserPII = {
        id: 'user-partial-addr',
        tenant_id: 'default',
        pii_class: 'LOCATION',
        email: 'test@example.com',
        email_blind_index: null,
        phone_number: null,
        name: null,
        given_name: null,
        family_name: null,
        nickname: null,
        preferred_username: null,
        picture: null,
        website: null,
        gender: null,
        birthdate: null,
        locale: null,
        zoneinfo: null,
        address_formatted: null,
        address_street_address: null,
        address_locality: 'Tokyo',
        address_region: null,
        address_postal_code: null,
        address_country: 'JP',
        declared_residence: null,
        created_at: 1000,
        updated_at: 1000,
      };

      const userInfo = repository.toOIDCUserInfo(pii, false, false);

      expect(userInfo.address).toBeDefined();
      expect(userInfo.address?.formatted).toBeUndefined();
      expect(userInfo.address?.locality).toBe('Tokyo');
      expect(userInfo.address?.country).toBe('JP');
    });

    it('should not include phone_number_verified when phone_number is null', () => {
      const pii: UserPII = {
        id: 'user-no-phone',
        tenant_id: 'default',
        pii_class: 'PROFILE',
        email: 'test@example.com',
        email_blind_index: null,
        phone_number: null,
        name: 'Test User',
        given_name: null,
        family_name: null,
        nickname: null,
        preferred_username: null,
        picture: null,
        website: null,
        gender: null,
        birthdate: null,
        locale: null,
        zoneinfo: null,
        address_formatted: null,
        address_street_address: null,
        address_locality: null,
        address_region: null,
        address_postal_code: null,
        address_country: null,
        declared_residence: null,
        created_at: 1000,
        updated_at: 1000,
      };

      const userInfo = repository.toOIDCUserInfo(pii, true, true);

      expect(userInfo.phone_number).toBeUndefined();
      expect(userInfo.phone_number_verified).toBeUndefined();
    });
  });

  describe('findByTenant', () => {
    beforeEach(() => {
      adapter.seed('users_pii', [
        {
          id: 'tenant1-user1',
          tenant_id: 'tenant-1',
          pii_class: 'PROFILE',
          email: 't1u1@example.com',
          email_blind_index: null,
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 1000,
          updated_at: 1000,
        },
        {
          id: 'tenant1-user2',
          tenant_id: 'tenant-1',
          pii_class: 'PROFILE',
          email: 't1u2@example.com',
          email_blind_index: null,
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 2000,
          updated_at: 2000,
        },
        {
          id: 'tenant2-user1',
          tenant_id: 'tenant-2',
          pii_class: 'PROFILE',
          email: 't2u1@example.com',
          email_blind_index: null,
          phone_number: null,
          name: null,
          given_name: null,
          family_name: null,
          nickname: null,
          preferred_username: null,
          picture: null,
          website: null,
          gender: null,
          birthdate: null,
          locale: null,
          zoneinfo: null,
          address_formatted: null,
          address_street_address: null,
          address_locality: null,
          address_region: null,
          address_postal_code: null,
          address_country: null,
          declared_residence: null,
          created_at: 3000,
          updated_at: 3000,
        },
      ]);
    });

    it('should find users by tenant', async () => {
      const result = await repository.findByTenant('tenant-1');

      expect(result.items).toHaveLength(2);
      expect(result.items.every((u) => u.tenant_id === 'tenant-1')).toBe(true);
      expect(result.total).toBe(2);
    });

    it('should return empty for non-existent tenant', async () => {
      const result = await repository.findByTenant('non-existent');

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should support pagination', async () => {
      const result = await repository.findByTenant('tenant-1', { page: 1, limit: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(2);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });
  });
});
