/**
 * Which tenant a custom (vanity) domain belongs to, for the Router.
 *
 * The Router has no tenant database or lookup registry, so on a host outside BASE_DOMAIN it
 * cannot tell which tenant's settings (account page, service site) apply. This Worker resolves
 * custom domains for its own requests already; this entrypoint gives the Router the same answer.
 * Read-only: it reads the lookup registry and the tenant's vanity domain row (and refreshes the
 * KV hint the resolver keeps). Answers null when no tenant owns the host, and throws when the
 * lookup fails, so the Router never caches an outage as "no tenant".
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { resolveVanityHostTenantId, type Env } from '@authrim/ar-lib-core';

export interface TenantHostRpcProps {
  caller: string;
  audience: string;
  environmentId: string;
}

export interface TenantHostResolution {
  tenantId: string | null;
}

export const TENANT_HOST_RPC_AUDIENCE = 'authrim-tenant-host-v1';

/** A hostname with an optional port; anything else is not a Host header worth resolving. */
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*(?::\d{1,5})?$/iu;

export class TenantHostEntrypoint extends WorkerEntrypoint<Env, TenantHostRpcProps> {
  async resolveTenantForHost(host: string): Promise<TenantHostResolution> {
    const props = this.ctx.props;
    if (
      props?.caller !== 'ar-router' ||
      props.audience !== TENANT_HOST_RPC_AUDIENCE ||
      !this.env.AUTHRIM_ENVIRONMENT_NAME ||
      props.environmentId !== this.env.AUTHRIM_ENVIRONMENT_NAME
    ) {
      throw new Error('tenant_host_rpc_caller_unauthorized');
    }
    if (typeof host !== 'string' || host.length > 260 || !HOST_PATTERN.test(host)) {
      return { tenantId: null };
    }
    try {
      return { tenantId: await resolveVanityHostTenantId(this.env, host) };
    } catch {
      // The lookup failed (not "no tenant"): the Router falls back without caching. The cause
      // is logged here and not sent across.
      throw new Error('tenant_host_lookup_failed');
    }
  }
}
