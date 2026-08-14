/**
 * SCIM Mapper Property-Based Tests
 *
 * Uses fast-check to verify SCIM resource mapping behavior across
 * a wide range of inputs, ensuring consistency and security.
 *
 * RFC 7643 - SCIM Core Schema
 * RFC 7644 - SCIM Protocol
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  userToScim,
  groupToScim,
  scimToGroup,
  applyPatchOperations,
  validateScimUser,
  validateScimGroup,
  generateEtag,
  parseEtag,
} from '../utils/scim-mapper';
import type { InternalUser, InternalGroup } from '../utils/scim-mapper';
import {
  internalUserArb,
  minimalInternalUserArb,
  internalGroupArb,
  partialScimGroupArb,
  validPatchOpArb,
  prototypePollutionPatchOpArb,
  emailArb,
  nameArb,
  isoDateArb,
} from './helpers/fc-generators';

// =============================================================================
// User Mapping Properties
// =============================================================================

describe('SCIM Mapper Property Tests', () => {
  describe('User Mapping Properties', () => {
    it('∀ InternalUser: userToScim produces valid SCIM User structure', () => {
      fc.assert(
        fc.property(internalUserArb, (user) => {
          const context = { baseUrl: 'https://example.com' };
          const scimUser = userToScim(user, context);

          // Required SCIM fields
          expect(scimUser.schemas).toBeDefined();
          expect(scimUser.schemas.length).toBeGreaterThan(0);
          expect(scimUser.id).toBe(user.id);
          expect(scimUser.userName).toBeDefined();
          expect(scimUser.meta).toBeDefined();
          expect(scimUser.meta.resourceType).toBe('User');
          expect(scimUser.meta.location).toContain(user.id);
          expect(scimUser.meta.created).toBeDefined();
          expect(scimUser.meta.lastModified).toBeDefined();
        }),
        { numRuns: 200 }
      );
    });

    it('∀ InternalUser: userToScim preserves email correctly', () => {
      fc.assert(
        fc.property(minimalInternalUserArb, (user) => {
          const context = { baseUrl: 'https://example.com' };
          const scimUser = userToScim(user, context);

          expect(scimUser.emails).toBeDefined();
          expect(scimUser.emails!.length).toBeGreaterThan(0);
          expect(scimUser.emails![0].value).toBe(user.email);
          expect(scimUser.emails![0].primary).toBe(true);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ InternalUser with name: userToScim creates name object', () => {
      const userWithNameArb = fc.record({
        id: fc.uuid(),
        email: emailArb,
        email_verified: fc.constantFrom(0, 1),
        given_name: nameArb,
        family_name: nameArb,
        updated_at: isoDateArb,
        created_at: isoDateArb,
      });

      fc.assert(
        fc.property(userWithNameArb, (user) => {
          const context = { baseUrl: 'https://example.com' };
          const scimUser = userToScim(user as InternalUser, context);

          expect(scimUser.name).toBeDefined();
          expect(scimUser.name!.givenName).toBe(user.given_name);
          expect(scimUser.name!.familyName).toBe(user.family_name);
        }),
        { numRuns: 100 }
      );
    });

    it('∀ InternalUser with active: userToScim converts correctly', () => {
      fc.assert(
        fc.property(minimalInternalUserArb, fc.constantFrom(0, 1), (user, active) => {
          const userWithActive = { ...user, active };
          const context = { baseUrl: 'https://example.com' };
          const scimUser = userToScim(userWithActive, context);

          expect(scimUser.active).toBe(Boolean(active));
        }),
        { numRuns: 100 }
      );
    });
  });

  // =============================================================================
  // Group Mapping Properties
  // =============================================================================

  describe('Group Mapping Properties', () => {
    it('∀ InternalGroup: groupToScim produces valid SCIM Group structure', () => {
      fc.assert(
        fc.property(internalGroupArb, (group) => {
          const context = { baseUrl: 'https://example.com' };
          const scimGroup = groupToScim(group, context);

          expect(scimGroup.schemas).toBeDefined();
          expect(scimGroup.schemas.length).toBeGreaterThan(0);
          expect(scimGroup.id).toBe(group.id);
          expect(scimGroup.displayName).toBe(group.name);
          expect(scimGroup.meta).toBeDefined();
          expect(scimGroup.meta.resourceType).toBe('Group');
          expect(scimGroup.meta.location).toContain(group.id);
        }),
        { numRuns: 200 }
      );
    });

    it('∀ InternalGroup with external_id: groupToScim preserves externalId', () => {
      fc.assert(
        fc.property(
          internalGroupArb.filter((g) => g.external_id !== null),
          (group) => {
            const context = { baseUrl: 'https://example.com' };
            const scimGroup = groupToScim(group, context);
            expect(scimGroup.externalId).toBe(group.external_id);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('∀ partial SCIM Group: scimToGroup extracts correct fields', () => {
      fc.assert(
        fc.property(partialScimGroupArb, (scimGroup) => {
          const group = scimToGroup(scimGroup);

          if (scimGroup.displayName) {
            expect(group.name).toBe(scimGroup.displayName);
          }
          if (scimGroup.externalId) {
            expect(group.external_id).toBe(scimGroup.externalId);
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  // =============================================================================
  // Patch Operation Properties
  // =============================================================================

  describe('Patch Operation Properties', () => {
    it('∀ valid patch operation: applyPatchOperations modifies resource correctly', () => {
      const resourceArb = fc.record({
        displayName: fc.option(nameArb, { nil: undefined }),
        active: fc.boolean(),
        nickName: fc.option(nameArb, { nil: undefined }),
      });

      fc.assert(
        fc.property(resourceArb, validPatchOpArb, (resource, patchOp) => {
          const patched = applyPatchOperations(resource, [patchOp]);

          if (patchOp.op === 'remove') {
            // For simple paths, the property should be deleted
            if (!patchOp.path?.includes('.')) {
              expect(patched[patchOp.path as string]).toBeUndefined();
            }
          } else if (patchOp.op === 'add' || patchOp.op === 'replace') {
            // For simple paths, the value should be set
            if (patchOp.value !== undefined && !patchOp.path?.includes('.')) {
              expect(patched[patchOp.path as string]).toBe(patchOp.value);
            }
          }
        }),
        { numRuns: 200 }
      );
    });

    it('∀ prototype pollution attack: applyPatchOperations rejects dangerous paths', () => {
      fc.assert(
        fc.property(prototypePollutionPatchOpArb, (patchOp) => {
          const resource = { displayName: 'test' };

          // Apply the patch
          const patched = applyPatchOperations(resource, [patchOp]);

          // Verify no prototype pollution occurred
          const emptyObj = {} as Record<string, unknown>;
          expect(emptyObj['polluted']).toBeUndefined();
          expect(Object.prototype.hasOwnProperty.call(emptyObj, 'polluted')).toBe(false);
          expect(({} as { polluted?: string }).polluted).toBeUndefined();

          // The dangerous path should not exist on the patched object in a dangerous way
          if (
            patchOp.path === '__proto__' ||
            patchOp.path === 'constructor' ||
            patchOp.path === 'prototype'
          ) {
            // These should be skipped, so they shouldn't have the polluted value
            expect(patched['__proto__']).not.toBe(patchOp.value);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('∀ nested path: applyPatchOperations creates intermediate objects', () => {
      fc.assert(
        fc.property(nameArb, nameArb, (givenName, familyName) => {
          const resource = {};
          const patches = [
            { op: 'add' as const, path: 'name.givenName', value: givenName },
            { op: 'add' as const, path: 'name.familyName', value: familyName },
          ];

          const patched = applyPatchOperations(resource, patches);

          expect(patched.name).toBeDefined();
          expect(patched.name.givenName).toBe(givenName);
          expect(patched.name.familyName).toBe(familyName);
        }),
        { numRuns: 100 }
      );
    });

    it('empty operations array: returns unchanged resource', () => {
      fc.assert(
        fc.property(
          fc.record({
            displayName: nameArb,
            active: fc.boolean(),
          }),
          (resource) => {
            const patched = applyPatchOperations(resource, []);
            expect(patched).toEqual(resource);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // =============================================================================
  // Validation Properties
  // =============================================================================

  describe('Validation Properties', () => {
    it('∀ SCIM User without userName: validateScimUser returns error', () => {
      fc.assert(
        fc.property(
          fc.record({
            emails: fc.array(
              fc.record({
                value: emailArb,
                primary: fc.boolean(),
              }),
              { minLength: 1, maxLength: 3 }
            ),
          }),
          (scimUser) => {
            const result = validateScimUser(scimUser);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('userName is required');
          }
        ),
        { numRuns: 100 }
      );
    });

    it('∀ SCIM User with userName and without emails: validateScimUser returns valid', () => {
      fc.assert(
        fc.property(
          fc.record({
            userName: emailArb,
          }),
          (scimUser) => {
            const result = validateScimUser(scimUser);
            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('∀ SCIM User with userName and emails: validateScimUser returns valid', () => {
      fc.assert(
        fc.property(
          fc.record({
            userName: emailArb,
            emails: fc.array(
              fc.record({
                value: emailArb,
                primary: fc.option(fc.boolean(), { nil: undefined }),
              }),
              { minLength: 1, maxLength: 3 }
            ),
          }),
          (scimUser) => {
            const result = validateScimUser(scimUser);
            expect(result.valid).toBe(true);
            expect(result.errors.length).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('∀ SCIM Group without displayName: validateScimGroup returns error', () => {
      fc.assert(
        fc.property(
          fc.record({
            externalId: fc.option(fc.uuid(), { nil: undefined }),
          }),
          (scimGroup) => {
            const result = validateScimGroup(scimGroup);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('displayName is required');
          }
        ),
        { numRuns: 50 }
      );
    });

    it('∀ SCIM Group with displayName: validateScimGroup returns valid', () => {
      fc.assert(
        fc.property(
          fc.record({
            displayName: nameArb,
          }),
          (scimGroup) => {
            const result = validateScimGroup(scimGroup);
            expect(result.valid).toBe(true);
            expect(result.errors.length).toBe(0);
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // =============================================================================
  // ETag Properties
  // =============================================================================

  describe('ETag Properties', () => {
    it('∀ resource with timestamp: generateEtag produces weak ETag', () => {
      fc.assert(
        fc.property(
          fc.record({
            created_at: isoDateArb,
            updated_at: fc.oneof(isoDateArb, fc.constant(undefined as string | undefined)),
          }),
          (resource) => {
            const etag = generateEtag(resource);
            // ETag format: W/"<timestamp>" where timestamp is a positive number
            expect(etag).toMatch(/^W\/"-?\d+"$/);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('∀ same resource: generateEtag is deterministic', () => {
      fc.assert(
        fc.property(
          fc.record({
            created_at: isoDateArb,
            updated_at: isoDateArb,
          }),
          (resource) => {
            const etag1 = generateEtag(resource);
            const etag2 = generateEtag(resource);
            expect(etag1).toBe(etag2);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('∀ different updated_at: generateEtag produces different ETags', () => {
      fc.assert(
        fc.property(isoDateArb, isoDateArb, (dateStr1, dateStr2) => {
          const time1 = new Date(dateStr1).getTime();
          const time2 = new Date(dateStr2).getTime();

          // Skip if dates are the same
          if (time1 === time2) {
            return;
          }

          const resource1 = { created_at: dateStr1, updated_at: dateStr1 };
          const resource2 = { created_at: dateStr1, updated_at: dateStr2 };

          const etag1 = generateEtag(resource1);
          const etag2 = generateEtag(resource2);

          expect(etag1).not.toBe(etag2);
        }),
        { numRuns: 50 }
      );
    });

    it('∀ ETag: parseEtag removes weak prefix and quotes', () => {
      fc.assert(
        fc.property(
          fc.string({
            unit: fc.constantFrom(...'0123456789'.split('')),
            minLength: 1,
            maxLength: 20,
          }),
          (timestamp) => {
            const etag = `W/"${timestamp}"`;
            const parsed = parseEtag(etag);
            expect(parsed).toBe(timestamp);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
