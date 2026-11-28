/**
 * Resource context resolvers for self-contract Check API requests.
 *
 * An end-user access token may ask only "may I do <action> on <resource type>[:<id>]". The
 * resource's owner, group and attributes are not taken from the request (the caller could claim
 * to own anything): a resolver registered for the resource type looks them up server-side.
 *
 * The registry here is in memory: a resolver registered for a tenant's resource type overrides the
 * stored registry (check-resource-registry.ts, `StoredResourceContextResolver`), which is what the
 * policy service resolves with by default. An empty registry resolves nothing, so a self-contract
 * check sees no resource context at all: no group-scoped role match, no resource attribute for the
 * tenant's rules, no relation.
 */

import type {
  ResolvedResourceContext,
  ResourceContextLookup,
  ResourceContextResolver,
} from '../types/check-api';

/** A resolver for one resource type of one tenant. */
export type ResourceContextResolverFn = (
  lookup: ResourceContextLookup
) => Promise<ResolvedResourceContext | null>;

/** The resolver that knows no resource: every self-contract check runs without a context. */
export const NO_RESOURCE_CONTEXT_RESOLVER: ResourceContextResolver = Object.freeze({
  resolve: async () => null,
});

/**
 * Resolvers by tenant and resource type. A lookup for a type nobody registered resolves to
 * `null` (nothing known).
 */
export class ResourceContextResolverRegistry implements ResourceContextResolver {
  private readonly resolvers = new Map<string, ResourceContextResolverFn>();

  private static key(tenantId: string, resourceType: string): string {
    return `${tenantId}\u0000${resourceType}`;
  }

  /** Register (or replace) the resolver of a tenant's resource type. */
  register(tenantId: string, resourceType: string, resolver: ResourceContextResolverFn): void {
    const tenant = tenantId.trim();
    const type = resourceType.trim();
    if (!tenant || !type) {
      throw new Error('A resource context resolver needs a tenant and a resource type');
    }
    this.resolvers.set(ResourceContextResolverRegistry.key(tenant, type), resolver);
  }

  /** Remove the resolver of a tenant's resource type (no-op when there is none). */
  unregister(tenantId: string, resourceType: string): void {
    this.resolvers.delete(
      ResourceContextResolverRegistry.key(tenantId.trim(), resourceType.trim())
    );
  }

  /** Whether a resolver is registered for a tenant's resource type. */
  has(tenantId: string, resourceType: string): boolean {
    return this.resolvers.has(ResourceContextResolverRegistry.key(tenantId, resourceType));
  }

  async resolve(lookup: ResourceContextLookup): Promise<ResolvedResourceContext | null> {
    const resolver = this.resolvers.get(
      ResourceContextResolverRegistry.key(lookup.tenantId, lookup.resourceType)
    );
    return resolver ? resolver(lookup) : null;
  }
}

export function createResourceContextResolverRegistry(): ResourceContextResolverRegistry {
  return new ResourceContextResolverRegistry();
}
