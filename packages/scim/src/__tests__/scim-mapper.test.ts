/**
 * SCIM Mapper Tests
 */

import { describe, it, expect } from 'vitest';
import {
  userToScim,
  scimToUser,
  groupToScim,
  scimToGroup,
  generateEtag,
  parseEtag,
  applyPatchOperations,
  validateScimUser,
  validateScimGroup,
  type InternalUser,
  type InternalGroup,
} from '../utils/scim-mapper';
import type { ScimUser, ScimGroup } from '../types/scim';
import { SCIM_SCHEMAS } from '../types/scim';

describe('SCIM Mapper', () => {
  const baseUrl = 'https://auth.example.com';

  describe('userToScim', () => {
    it('should convert internal user to SCIM format', () => {
      const internalUser: InternalUser = {
        id: 'user-123',
        email: 'john@example.com',
        email_verified: 1,
        name: 'John Doe',
        given_name: 'John',
        family_name: 'Doe',
        preferred_username: 'johndoe',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        active: 1,
      };

      const scimUser = userToScim(internalUser, { baseUrl });

      expect(scimUser.schemas).toContain(SCIM_SCHEMAS.USER);
      expect(scimUser.id).toBe('user-123');
      expect(scimUser.userName).toBe('johndoe');
      expect(scimUser.name?.givenName).toBe('John');
      expect(scimUser.name?.familyName).toBe('Doe');
      expect(scimUser.emails).toHaveLength(1);
      expect(scimUser.emails?.[0].value).toBe('john@example.com');
      expect(scimUser.active).toBe(true);
      expect(scimUser.meta.resourceType).toBe('User');
      expect(scimUser.meta.location).toBe(`${baseUrl}/scim/v2/Users/user-123`);
    });

    it('should include phone number if present', () => {
      const internalUser: InternalUser = {
        id: 'user-123',
        email: 'john@example.com',
        email_verified: 1,
        phone_number: '+1234567890',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      const scimUser = userToScim(internalUser, { baseUrl });

      expect(scimUser.phoneNumbers).toHaveLength(1);
      expect(scimUser.phoneNumbers?.[0].value).toBe('+1234567890');
    });

    it('should parse address JSON', () => {
      const internalUser: InternalUser = {
        id: 'user-123',
        email: 'john@example.com',
        email_verified: 1,
        address_json: JSON.stringify({
          street_address: '123 Main St',
          locality: 'Springfield',
          region: 'IL',
          postal_code: '62701',
          country: 'US',
        }),
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      const scimUser = userToScim(internalUser, { baseUrl });

      expect(scimUser.addresses).toHaveLength(1);
      expect(scimUser.addresses?.[0].streetAddress).toBe('123 Main St');
      expect(scimUser.addresses?.[0].locality).toBe('Springfield');
    });

    it('should include enterprise extension if custom attributes present', () => {
      const internalUser: InternalUser = {
        id: 'user-123',
        email: 'john@example.com',
        email_verified: 1,
        custom_attributes_json: JSON.stringify({
          employeeNumber: 'EMP-123',
          department: 'Engineering',
          organization: 'Acme Corp',
        }),
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      const scimUser = userToScim(internalUser, { baseUrl });

      expect(scimUser.schemas).toContain(SCIM_SCHEMAS.ENTERPRISE_USER);
      const enterpriseExt = scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
      expect(enterpriseExt).toBeDefined();
      expect(enterpriseExt?.employeeNumber).toBe('EMP-123');
      expect(enterpriseExt?.department).toBe('Engineering');
    });

    it('should generate ETag', () => {
      const internalUser: InternalUser = {
        id: 'user-123',
        email: 'john@example.com',
        email_verified: 1,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      const scimUser = userToScim(internalUser, { baseUrl });

      expect(scimUser.meta.version).toBeDefined();
      expect(scimUser.meta.version).toMatch(/^W\//);
    });
  });

  describe('scimToUser', () => {
    it('should convert SCIM user to internal format', () => {
      const scimUser: Partial<ScimUser> = {
        userName: 'johndoe',
        name: {
          givenName: 'John',
          familyName: 'Doe',
        },
        emails: [
          {
            value: 'john@example.com',
            primary: true,
          },
        ],
        active: true,
      };

      const internalUser = scimToUser(scimUser);

      expect(internalUser.preferred_username).toBe('johndoe');
      expect(internalUser.given_name).toBe('John');
      expect(internalUser.family_name).toBe('Doe');
      expect(internalUser.email).toBe('john@example.com');
      expect(internalUser.active).toBe(1);
    });

    it('should extract primary email', () => {
      const scimUser: Partial<ScimUser> = {
        userName: 'johndoe',
        emails: [
          {
            value: 'john.work@example.com',
            type: 'work',
            primary: false,
          },
          {
            value: 'john@example.com',
            type: 'home',
            primary: true,
          },
        ],
      };

      const internalUser = scimToUser(scimUser);

      expect(internalUser.email).toBe('john@example.com');
    });

    it('should convert address', () => {
      const scimUser: Partial<ScimUser> = {
        userName: 'johndoe',
        addresses: [
          {
            streetAddress: '123 Main St',
            locality: 'Springfield',
            region: 'IL',
            postalCode: '62701',
            country: 'US',
            primary: true,
          },
        ],
      };

      const internalUser = scimToUser(scimUser);

      expect(internalUser.address_json).toBeDefined();
      const address = JSON.parse(internalUser.address_json!);
      expect(address.street_address).toBe('123 Main St');
      expect(address.locality).toBe('Springfield');
    });

    it('should handle enterprise extension', () => {
      const scimUser: Partial<ScimUser> = {
        userName: 'johndoe',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          employeeNumber: 'EMP-123',
          department: 'Engineering',
          organization: 'Acme Corp',
        },
      };

      const internalUser = scimToUser(scimUser);

      expect(internalUser.custom_attributes_json).toBeDefined();
      const customAttrs = JSON.parse(internalUser.custom_attributes_json!);
      expect(customAttrs.employeeNumber).toBe('EMP-123');
      expect(customAttrs.department).toBe('Engineering');
    });
  });

  describe('groupToScim', () => {
    it('should convert internal group to SCIM format', () => {
      const internalGroup: InternalGroup = {
        id: 'role-123',
        name: 'Administrators',
        description: 'Admin group',
        created_at: '2024-01-01T00:00:00Z',
      };

      const scimGroup = groupToScim(internalGroup, { baseUrl }, []);

      expect(scimGroup.schemas).toContain(SCIM_SCHEMAS.GROUP);
      expect(scimGroup.id).toBe('role-123');
      expect(scimGroup.displayName).toBe('Administrators');
      expect(scimGroup.meta.resourceType).toBe('Group');
      expect(scimGroup.meta.location).toBe(`${baseUrl}/scim/v2/Groups/role-123`);
    });

    it('should include members', () => {
      const internalGroup: InternalGroup = {
        id: 'role-123',
        name: 'Administrators',
        created_at: '2024-01-01T00:00:00Z',
      };

      const members = [
        { user_id: 'user-1', email: 'user1@example.com' },
        { user_id: 'user-2', email: 'user2@example.com' },
      ];

      const scimGroup = groupToScim(internalGroup, { baseUrl }, members);

      expect(scimGroup.members).toHaveLength(2);
      expect(scimGroup.members?.[0].value).toBe('user-1');
      expect(scimGroup.members?.[0].$ref).toBe(`${baseUrl}/scim/v2/Users/user-1`);
      expect(scimGroup.members?.[0].display).toBe('user1@example.com');
    });
  });

  describe('scimToGroup', () => {
    it('should convert SCIM group to internal format', () => {
      const scimGroup: Partial<ScimGroup> = {
        displayName: 'Administrators',
        externalId: 'ext-123',
      };

      const internalGroup = scimToGroup(scimGroup);

      expect(internalGroup.name).toBe('Administrators');
      expect(internalGroup.external_id).toBe('ext-123');
    });
  });

  describe('generateEtag', () => {
    it('should generate consistent ETag for same timestamp', () => {
      const resource1 = { updated_at: '2024-01-01T00:00:00Z' };
      const resource2 = { updated_at: '2024-01-01T00:00:00Z' };

      const etag1 = generateEtag(resource1);
      const etag2 = generateEtag(resource2);

      expect(etag1).toBe(etag2);
    });

    it('should generate different ETags for different timestamps', () => {
      const resource1 = { updated_at: '2024-01-01T00:00:00Z' };
      const resource2 = { updated_at: '2024-01-02T00:00:00Z' };

      const etag1 = generateEtag(resource1);
      const etag2 = generateEtag(resource2);

      expect(etag1).not.toBe(etag2);
    });

    it('should generate weak ETag format', () => {
      const resource = { updated_at: '2024-01-01T00:00:00Z' };
      const etag = generateEtag(resource);

      expect(etag).toMatch(/^W\//);
    });
  });

  describe('parseEtag', () => {
    it('should parse ETag value', () => {
      const etag = 'W/"1234567890"';
      const parsed = parseEtag(etag);

      expect(parsed).toBe('1234567890');
    });

    it('should handle ETag without quotes', () => {
      const etag = '1234567890';
      const parsed = parseEtag(etag);

      expect(parsed).toBe('1234567890');
    });
  });

  describe('applyPatchOperations', () => {
    it('should apply add operation', () => {
      const resource = { name: 'John' };
      const operations = [
        {
          op: 'add' as const,
          path: 'email',
          value: 'john@example.com',
        },
      ];

      const result = applyPatchOperations(resource, operations);

      expect(result.email).toBe('john@example.com');
      expect(result.name).toBe('John');
    });

    it('should apply replace operation', () => {
      const resource = { name: 'John', email: 'old@example.com' };
      const operations = [
        {
          op: 'replace' as const,
          path: 'email',
          value: 'new@example.com',
        },
      ];

      const result = applyPatchOperations(resource, operations);

      expect(result.email).toBe('new@example.com');
    });

    it('should apply remove operation', () => {
      const resource = { name: 'John', email: 'john@example.com' };
      const operations = [
        {
          op: 'remove' as const,
          path: 'email',
        },
      ];

      const result = applyPatchOperations(resource, operations);

      expect(result.email).toBeUndefined();
      expect(result.name).toBe('John');
    });

    it('should handle nested paths', () => {
      const resource = { name: { first: 'John', last: 'Doe' } };
      const operations = [
        {
          op: 'replace' as const,
          path: 'name.first',
          value: 'Jane',
        },
      ];

      const result = applyPatchOperations(resource, operations);

      expect(result.name.first).toBe('Jane');
      expect(result.name.last).toBe('Doe');
    });

    it('should handle operations without path (replace entire resource)', () => {
      const resource = { name: 'John', email: 'john@example.com' };
      const operations = [
        {
          op: 'replace' as const,
          value: { name: 'Jane', age: 30 },
        },
      ];

      const result = applyPatchOperations(resource, operations);

      expect(result.name).toBe('Jane');
      expect(result.age).toBe(30);
    });
  });

  describe('validateScimUser', () => {
    it('should validate user with required fields', () => {
      const user: Partial<ScimUser> = {
        userName: 'johndoe',
        emails: [{ value: 'john@example.com' }],
      };

      const result = validateScimUser(user);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail if userName is missing', () => {
      const user: Partial<ScimUser> = {
        emails: [{ value: 'john@example.com' }],
      };

      const result = validateScimUser(user);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('userName is required');
    });

    it('should fail if emails is missing', () => {
      const user: Partial<ScimUser> = {
        userName: 'johndoe',
      };

      const result = validateScimUser(user);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('At least one email is required');
    });

    it('should fail if emails is empty array', () => {
      const user: Partial<ScimUser> = {
        userName: 'johndoe',
        emails: [],
      };

      const result = validateScimUser(user);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('At least one email is required');
    });
  });

  describe('validateScimGroup', () => {
    it('should validate group with required fields', () => {
      const group: Partial<ScimGroup> = {
        displayName: 'Administrators',
      };

      const result = validateScimGroup(group);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail if displayName is missing', () => {
      const group: Partial<ScimGroup> = {};

      const result = validateScimGroup(group);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('displayName is required');
    });
  });
});
