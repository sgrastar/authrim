import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { app as managementApp } from '../index';
import { findAdminRouteAccessRule } from '../admin-route-access';

/**
 * The mapping Admin API is one family, `/api/admin/identity-mapping/*`. Two things that were
 * misfiled under the old `field-mapping` family live under their own names:
 * `/api/admin/federation/*` (trust sources and metadata documents) and
 * `/api/admin/identifiers/*` (persistent identifier material, the hash key, key registries).
 * There are no aliases: every old path is gone, and every moved path stays behind the same
 * deny-by-default permission (settings read for GET, settings write for the rest).
 */

// [method, old path, new path]
const MOVED: ReadonlyArray<readonly [string, string, string]> = [
  ['POST', '/api/admin/field-mapping/preview/csv', '/api/admin/identity-mapping/preview/csv'],
  ['POST', '/api/admin/field-mapping/preview/saml', '/api/admin/identity-mapping/preview/saml'],
  ['POST', '/api/admin/field-mapping/preview/oidc', '/api/admin/identity-mapping/preview/oidc'],
  ['GET', '/api/admin/field-mapping/oidc-scopes', '/api/admin/identity-mapping/oidc-scopes'],
  ['POST', '/api/admin/field-mapping/oidc-scopes', '/api/admin/identity-mapping/oidc-scopes'],
  [
    'PUT',
    '/api/admin/field-mapping/oidc-scopes/:id',
    '/api/admin/identity-mapping/oidc-scopes/:id',
  ],
  [
    'DELETE',
    '/api/admin/field-mapping/oidc-scopes/:id',
    '/api/admin/identity-mapping/oidc-scopes/:id',
  ],
  ['GET', '/api/admin/field-mapping/identifier-stores', '/api/admin/identifiers/stores'],
  [
    'POST',
    '/api/admin/field-mapping/identifier-stores/:name/import',
    '/api/admin/identifiers/stores/:name/import',
  ],
  ['GET', '/api/admin/field-mapping/identifier-sources', '/api/admin/identifiers/sources'],
  [
    'POST',
    '/api/admin/field-mapping/identifier-sources/:name/import',
    '/api/admin/identifiers/sources/:name/import',
  ],
  ['GET', '/api/admin/field-mapping/identifier-exceptions', '/api/admin/identifiers/exceptions'],
  [
    'POST',
    '/api/admin/field-mapping/identifier-exceptions/:name/import',
    '/api/admin/identifiers/exceptions/:name/import',
  ],
  ['GET', '/api/admin/field-mapping/hash-key', '/api/admin/identifiers/hash-key'],
  ['POST', '/api/admin/field-mapping/hash-key/rotate', '/api/admin/identifiers/hash-key/rotate'],
  ['GET', '/api/admin/field-mapping/identifier-salts', '/api/admin/identifiers/salts'],
  ['PUT', '/api/admin/field-mapping/identifier-salts/:name', '/api/admin/identifiers/salts/:name'],
  ['GET', '/api/admin/field-mapping/catalogs', '/api/admin/identity-mapping/catalogs'],
  ['POST', '/api/admin/field-mapping/catalogs', '/api/admin/identity-mapping/catalogs'],
  [
    'GET',
    '/api/admin/field-mapping/protocol-schemas',
    '/api/admin/identity-mapping/protocol-schemas',
  ],
  [
    'POST',
    '/api/admin/field-mapping/protocol-schemas',
    '/api/admin/identity-mapping/protocol-schemas',
  ],
  [
    'GET',
    '/api/admin/field-mapping/external-schemas',
    '/api/admin/identity-mapping/external-schemas',
  ],
  [
    'POST',
    '/api/admin/field-mapping/external-schemas',
    '/api/admin/identity-mapping/external-schemas',
  ],
  [
    'GET',
    '/api/admin/field-mapping/source-profiles',
    '/api/admin/identity-mapping/source-profiles',
  ],
  [
    'POST',
    '/api/admin/field-mapping/source-profiles/csv/parse',
    '/api/admin/identity-mapping/source-profiles/csv/parse',
  ],
  [
    'POST',
    '/api/admin/field-mapping/source-profiles',
    '/api/admin/identity-mapping/source-profiles',
  ],
  [
    'PUT',
    '/api/admin/field-mapping/source-profiles/:sourceProfileId',
    '/api/admin/identity-mapping/source-profiles/:sourceProfileId',
  ],
  [
    'POST',
    '/api/admin/field-mapping/source-profiles/:sourceProfileId/versions/:sourceProfileVersionId/review',
    '/api/admin/identity-mapping/source-profiles/:sourceProfileId/versions/:sourceProfileVersionId/review',
  ],
  [
    'POST',
    '/api/admin/field-mapping/source-profiles/:sourceProfileId/versions/:sourceProfileVersionId/activate',
    '/api/admin/identity-mapping/source-profiles/:sourceProfileId/versions/:sourceProfileVersionId/activate',
  ],
  [
    'DELETE',
    '/api/admin/field-mapping/source-profiles/:sourceProfileId',
    '/api/admin/identity-mapping/source-profiles/:sourceProfileId',
  ],
  [
    'GET',
    '/api/admin/field-mapping/destination-profiles',
    '/api/admin/identity-mapping/destination-profiles',
  ],
  [
    'POST',
    '/api/admin/field-mapping/destination-profiles',
    '/api/admin/identity-mapping/destination-profiles',
  ],
  [
    'PUT',
    '/api/admin/field-mapping/destination-profiles/:destinationProfileId',
    '/api/admin/identity-mapping/destination-profiles/:destinationProfileId',
  ],
  [
    'POST',
    '/api/admin/field-mapping/destination-profiles/:destinationProfileId/versions/:destinationProfileVersionId/review',
    '/api/admin/identity-mapping/destination-profiles/:destinationProfileId/versions/:destinationProfileVersionId/review',
  ],
  [
    'POST',
    '/api/admin/field-mapping/destination-profiles/:destinationProfileId/versions/:destinationProfileVersionId/activate',
    '/api/admin/identity-mapping/destination-profiles/:destinationProfileId/versions/:destinationProfileVersionId/activate',
  ],
  [
    'DELETE',
    '/api/admin/field-mapping/destination-profiles/:destinationProfileId',
    '/api/admin/identity-mapping/destination-profiles/:destinationProfileId',
  ],
  [
    'GET',
    '/api/admin/field-mapping/attribute-groups',
    '/api/admin/identity-mapping/attribute-groups',
  ],
  [
    'POST',
    '/api/admin/field-mapping/attribute-groups',
    '/api/admin/identity-mapping/attribute-groups',
  ],
  [
    'GET',
    '/api/admin/field-mapping/attribute-fields',
    '/api/admin/identity-mapping/attribute-fields',
  ],
  [
    'POST',
    '/api/admin/field-mapping/attribute-fields',
    '/api/admin/identity-mapping/attribute-fields',
  ],
  ['GET', '/api/admin/field-mapping/templates', '/api/admin/identity-mapping/templates'],
  ['POST', '/api/admin/field-mapping/templates', '/api/admin/identity-mapping/templates'],
  [
    'GET',
    '/api/admin/field-mapping/source-authority-contracts',
    '/api/admin/identity-mapping/source-authority-contracts',
  ],
  [
    'POST',
    '/api/admin/field-mapping/source-authority-contracts',
    '/api/admin/identity-mapping/source-authority-contracts',
  ],
  [
    'POST',
    '/api/admin/field-mapping/source-authority-contracts/evaluate',
    '/api/admin/identity-mapping/source-authority-contracts/evaluate',
  ],
  [
    'GET',
    '/api/admin/field-mapping/schema-readiness',
    '/api/admin/identity-mapping/schema-readiness',
  ],
  ['GET', '/api/admin/field-mapping/review-tasks', '/api/admin/identity-mapping/review-tasks'],
  ['POST', '/api/admin/field-mapping/review-tasks', '/api/admin/identity-mapping/review-tasks'],
  [
    'POST',
    '/api/admin/field-mapping/review-tasks/:reviewTaskId/transition',
    '/api/admin/identity-mapping/review-tasks/:reviewTaskId/transition',
  ],
  [
    'POST',
    '/api/admin/field-mapping/review-task-groups',
    '/api/admin/identity-mapping/review-task-groups',
  ],
  [
    'POST',
    '/api/admin/field-mapping/operational-notifications',
    '/api/admin/identity-mapping/operational-notifications',
  ],
  [
    'POST',
    '/api/admin/field-mapping/operational-notification-states/:stateId/acknowledge',
    '/api/admin/identity-mapping/operational-notification-states/:stateId/acknowledge',
  ],
  [
    'POST',
    '/api/admin/field-mapping/operational-notification-states/:stateId/resolve',
    '/api/admin/identity-mapping/operational-notification-states/:stateId/resolve',
  ],
  ['POST', '/api/admin/field-mapping/groups', '/api/admin/identity-mapping/groups'],
  [
    'POST',
    '/api/admin/field-mapping/groups/:groupId/memberships',
    '/api/admin/identity-mapping/groups/:groupId/memberships',
  ],
  ['POST', '/api/admin/field-mapping/entitlements', '/api/admin/identity-mapping/entitlements'],
  [
    'POST',
    '/api/admin/field-mapping/provisioning-assignment-rules',
    '/api/admin/identity-mapping/provisioning-assignment-rules',
  ],
  [
    'POST',
    '/api/admin/field-mapping/provisioning-assignment-rules/:ruleId/evaluate',
    '/api/admin/identity-mapping/provisioning-assignment-rules/:ruleId/evaluate',
  ],
  [
    'POST',
    '/api/admin/field-mapping/lifecycle-signals',
    '/api/admin/identity-mapping/lifecycle-signals',
  ],
  ['POST', '/api/admin/field-mapping/key-registries', '/api/admin/identifiers/key-registries'],
  ['GET', '/api/admin/field-mapping/key-registries', '/api/admin/identifiers/key-registries'],
  [
    'POST',
    '/api/admin/field-mapping/key-registries/:keyRegistryId/rotate',
    '/api/admin/identifiers/key-registries/:keyRegistryId/rotate',
  ],
  [
    'POST',
    '/api/admin/field-mapping/key-registries/:keyRegistryId/access-events',
    '/api/admin/identifiers/key-registries/:keyRegistryId/access-events',
  ],
  [
    'POST',
    '/api/admin/field-mapping/federation-trust-sources',
    '/api/admin/federation/trust-sources',
  ],
  [
    'GET',
    '/api/admin/field-mapping/federation-trust-sources',
    '/api/admin/federation/trust-sources',
  ],
  [
    'PUT',
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId',
    '/api/admin/federation/trust-sources/:trustSourceId',
  ],
  [
    'DELETE',
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId',
    '/api/admin/federation/trust-sources/:trustSourceId',
  ],
  [
    'GET',
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId/metadata-documents',
    '/api/admin/federation/trust-sources/:trustSourceId/metadata-documents',
  ],
  [
    'GET',
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId',
    '/api/admin/federation/trust-sources/:trustSourceId',
  ],
  [
    'GET',
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId/entities',
    '/api/admin/federation/trust-sources/:trustSourceId/entities',
  ],
  [
    'GET',
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId/entity-keywords',
    '/api/admin/federation/trust-sources/:trustSourceId/entity-keywords',
  ],
  [
    'GET',
    '/api/admin/field-mapping/federation-trust-sources/:trustSourceId/refresh-history',
    '/api/admin/federation/trust-sources/:trustSourceId/refresh-history',
  ],
  [
    'POST',
    '/api/admin/field-mapping/federation-metadata-documents',
    '/api/admin/federation/metadata-documents',
  ],
];

// The step-by-step version workflow of a set is gone: the facade (`/sets`) saves, and
// `/history` restores.
const REMOVED: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/admin/field-mapping/field-mapping-sets'],
  ['POST', '/api/admin/field-mapping/field-mapping-sets'],
  ['DELETE', '/api/admin/field-mapping/field-mapping-sets/set-a'],
  ['GET', '/api/admin/field-mapping/field-mapping-sets/set-a/versions'],
  ['POST', '/api/admin/field-mapping/field-mapping-sets/set-a/versions'],
  ['POST', '/api/admin/field-mapping/field-mapping-sets/set-a/versions/v1/publish'],
  ['POST', '/api/admin/field-mapping/field-mapping-sets/set-a/versions/v1/compile'],
  ['POST', '/api/admin/field-mapping/field-mapping-sets/set-a/versions/v1/activate'],
  ['POST', '/api/admin/field-mapping/field-mapping-sets/set-a/versions/v1/deactivate'],
  ['POST', '/api/admin/field-mapping/field-mapping-sets/set-a/rollback'],
];

function registered(method: string, path: string): boolean {
  return managementApp.routes.some((route) => route.method === method && route.path === path);
}

describe('the mapping Admin API is one family', () => {
  it('registers every moved route at its new path and none at the old one', () => {
    for (const [method, oldPath, newPath] of MOVED) {
      expect(registered(method, newPath), `${method} ${newPath}`).toBe(true);
      expect(registered(method, oldPath), `${method} ${oldPath}`).toBe(false);
    }
  });

  it('registers nothing under /api/admin/field-mapping', () => {
    const left = managementApp.routes
      .filter((route) => route.path.startsWith('/api/admin/field-mapping'))
      .map((route) => `${route.method} ${route.path}`);
    expect(left).toEqual([]);
  });

  it('removes the step-by-step set and version routes', () => {
    for (const [method, path] of REMOVED) {
      const pattern = path.replace('/api/admin/field-mapping/', '/api/admin/identity-mapping/');
      expect(findAdminRouteAccessRule(method, path), `${method} ${path}`).toBeNull();
      expect(
        managementApp.routes.some(
          (route) => route.method === method && route.path.includes('field-mapping-sets')
        ),
        pattern
      ).toBe(false);
    }
  });

  it('refuses every old path at the gate, which has no rule for it', () => {
    for (const [method, oldPath] of MOVED) {
      expect(findAdminRouteAccessRule(method, oldPath), `${method} ${oldPath}`).toBeNull();
    }
  });

  it('keeps every moved route gated by the settings permission it had', () => {
    for (const [method, , newPath] of MOVED) {
      const concrete = newPath.replace(/:[A-Za-z]+/g, 'x');
      const rule = findAdminRouteAccessRule(method, concrete);
      expect(rule, `${method} ${newPath}`).not.toBeNull();
      const expected =
        method === 'GET' ? ADMIN_PERMISSIONS.SETTINGS_READ : ADMIN_PERMISSIONS.SETTINGS_WRITE;
      expect(rule?.permissions, `${method} ${newPath}`).toEqual([expected]);
    }
  });

  it('declares no rule for a method a moved path is not routed with', () => {
    const matches = (pattern: string, path: string) =>
      new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path);
    let checked = 0;
    for (const [, , newPath] of MOVED) {
      const concrete = newPath.replace(/:[A-Za-z]+/g, 'x');
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        const routed = MOVED.some(
          ([otherMethod, , otherPath]) => otherMethod === method && matches(otherPath, concrete)
        );
        if (routed) continue;
        expect(findAdminRouteAccessRule(method, concrete), `${method} ${newPath}`).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('declares no rule for an unknown path under the moved families', () => {
    for (const path of [
      '/api/admin/identity-mapping/not-a-route',
      '/api/admin/identity-mapping/catalogs/extra/segments',
      '/api/admin/federation/not-a-route',
      '/api/admin/identifiers/not-a-route',
    ]) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(findAdminRouteAccessRule(method, path), `${method} ${path}`).toBeNull();
      }
    }
  });
});
