/**
 * The resource context resolvers of this policy service's self-contract checks.
 *
 * Empty by default: an end-user access token's check then has no resource context (no ownership,
 * resource group or resource attributes), so nothing it cannot prove grants it access. A tenant (or
 * the owner of a tenant's API key) is to register a resolver for a resource type here, with
 * `checkResourceContextResolvers.register(tenantId, resourceType, resolver)`. How resolvers are
 * declared and persisted is not built yet: this is the in-memory hook they will be wired to.
 */

import { createResourceContextResolverRegistry } from '@authrim/ar-lib-core';

export const checkResourceContextResolvers = createResourceContextResolverRegistry();
