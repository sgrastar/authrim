import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inventoryCoreAuditWrites, type AuditWriteSite } from './helpers/core-audit-inventory';
import {
  ADMIN_OPERATION_CORE_EVENTS,
  isAdminOperationCoreEventPair,
  isAdminOperationCoreEventRow,
} from '../admin-operation-core-events';

/**
 * The end-user audit views leave out the admin operations listed in ADMIN_OPERATION_CORE_EVENTS.
 * A listed pair must never be one that something other than an admin route writes, or real
 * end-user and security events would disappear from those views.
 */

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const sites = inventoryCoreAuditWrites(repositoryRoot);

/** Admin route modules whose direct core writes (not through the context helper) are listed. */
const ADMIN_WRITERS = new Set([
  'packages/ar-management/src/admin-tenant-clone.ts',
  'packages/ar-management/src/admin-tenant-placement-migrations.ts',
  'packages/ar-management/src/admin-tenants.ts',
  'packages/ar-management/src/identifier-exceptions.ts',
  'packages/ar-management/src/identifier-salts.ts',
  'packages/ar-management/src/identifier-sources.ts',
  'packages/ar-management/src/identifier-stores.ts',
  'packages/ar-management/src/legacy-settings-import.ts',
  'packages/ar-management/src/mapping-hash-key.ts',
]);

function listedPairs(): Array<[action: string, resource: string]> {
  return Object.entries(ADMIN_OPERATION_CORE_EVENTS).flatMap(([resource, actions]) =>
    actions.map((action): [string, string] => [action, resource])
  );
}

const literal = (site: AuditWriteSite) =>
  site.actionKnown && !site.action.includes('*') && !site.resource.startsWith('dynamic:');

/** Writes by admin routes: the context helper, the known wrappers, and the listed modules. */
const adminSite = (site: AuditWriteSite) =>
  site.helper === 'createAuditLogFromContext' ||
  site.helper === 'wrapper' ||
  ADMIN_WRITERS.has(site.file);

describe('ADMIN_OPERATION_CORE_EVENTS', () => {
  it('lists no pair that a writer other than an admin route emits', () => {
    const foreign = sites.filter(
      (site) =>
        literal(site) &&
        isAdminOperationCoreEventPair(site.action, site.resource) &&
        !adminSite(site)
    );
    expect(foreign.map((site) => `${site.file}:${site.line} ${site.action}`)).toEqual([]);
  });

  it('lists no pair whose write names the end user it is about', () => {
    // Such a row is part of that user's history, so the end-user views keep it.
    const aboutAUser = sites.filter(
      (site) =>
        literal(site) && site.namesUser && isAdminOperationCoreEventPair(site.action, site.resource)
    );
    expect(aboutAUser.map((site) => `${site.file}:${site.line} ${site.action}`)).toEqual([]);
  });

  it('lists no event type that the dispatcher would record under the same resource', () => {
    // The event dispatcher records every published event in the core log, with the resource
    // taken from the type's first segment. Only these types, published by admin routes alone,
    // may be listed.
    const adminPublishedOnly = new Set(['client.created', 'client.updated', 'client.deleted']);
    const source = readFileSync(
      new URL('../../../ar-lib-core/src/types/events/event-types.ts', import.meta.url),
      'utf8'
    );
    const eventTypes = [...source.matchAll(/:\s*'([a-z0-9_.-]+)'/gu)].map((match) => match[1]);
    const clashing = eventTypes.filter(
      (type) =>
        isAdminOperationCoreEventPair(type, type.split('.')[0] ?? '') &&
        !adminPublishedOnly.has(type)
    );
    expect(clashing).toEqual([]);
  });

  it('covers every literal admin-route write that does not name its end user', () => {
    const uncovered = sites.filter(
      (site) =>
        adminSite(site) &&
        literal(site) &&
        !site.namesUser &&
        !isAdminOperationCoreEventPair(site.action, site.resource)
    );
    expect(uncovered.map((site) => `${site.file}:${site.line} ${site.action}`)).toEqual([]);
  });

  // Pairs stay listed after their writes move to the admin audit log: the older rows remain in
  // the end-user log until its retention removes them.

  it('holds only names that are safe to compare', () => {
    for (const [action, resource] of listedPairs()) {
      expect(action).toMatch(/^[a-z0-9_.-]+$/u);
      expect(resource).toMatch(/^[a-z0-9_]+$/u);
    }
  });
});

describe('isAdminOperationCoreEventRow', () => {
  it('matches a listed pair recorded by the legacy mirror', () => {
    expect(
      isAdminOperationCoreEventRow({
        event_type: 'screen.updated',
        details_json: JSON.stringify({ source: 'legacy_audit_log', resourceType: 'screen' }),
      })
    ).toBe(true);
  });

  it('keeps a row whose action or resource is not a listed pair', () => {
    for (const row of [
      // A security event under a resource admin routes also use.
      { event_type: 'security.rate_limit.exceeded', details_json: '{"resourceType":"security"}' },
      // A generic action name under another resource.
      { event_type: 'create', details_json: '{"resourceType":"account_profile"}' },
      // A user's attribute created by an admin names that user.
      { event_type: 'create', details_json: '{"resourceType":"user_attribute"}' },
      // An admin action on an end user stays in that user's history.
      { event_type: 'user.suspend', details_json: '{"resourceType":"user"}' },
      // The resource type is only read from resourceType.
      { event_type: 'screen.updated', details_json: '{"resource_type":"screen"}' },
    ]) {
      expect(isAdminOperationCoreEventRow(row)).toBe(false);
    }
  });

  it('keeps a row without readable details', () => {
    for (const details_json of [null, undefined, '', 'not json', '[]', '"screen"', 'null']) {
      expect(isAdminOperationCoreEventRow({ event_type: 'screen.updated', details_json })).toBe(
        false
      );
    }
    expect(
      isAdminOperationCoreEventRow({ event_type: 42, details_json: '{"resourceType":"screen"}' })
    ).toBe(false);
  });
});
