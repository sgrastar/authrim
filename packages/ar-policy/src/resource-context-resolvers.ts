/**
 * The resource context resolvers of this policy service's self-contract checks.
 *
 * By default a check resolves its resource from the tenant's registry (core `check_resource_types`
 * and `check_resources`, see `StoredResourceContextResolver` in ar-lib-core): the type's
 * action-to-relation map and what the tenant's application server registered about the resource
 * (`/api/check/resources`). Nothing registered resolves to no resource context, so nothing the
 * caller cannot prove grants it access.
 *
 * `checkResourceContextResolvers` is an in-memory override: a resolver registered there for a
 * tenant's resource type (`register(tenantId, resourceType, resolver)`, used by tests) is asked
 * instead of the stored registry.
 */

import {
  createResourceContextResolverRegistry,
  createStoredResourceContextResolver,
  type DatabaseAdapter,
  type ResourceContextResolver,
} from '@authrim/ar-lib-core';

export const checkResourceContextResolvers = createResourceContextResolverRegistry();

/** The resolver of a request: the in-memory override for its type, else the stored registry. */
export function createCheckResourceContextResolver(db: DatabaseAdapter): ResourceContextResolver {
  const stored = createStoredResourceContextResolver(db);
  return {
    resolve: (lookup) =>
      checkResourceContextResolvers.has(lookup.tenantId, lookup.resourceType)
        ? checkResourceContextResolvers.resolve(lookup)
        : stored.resolve(lookup),
  };
}
