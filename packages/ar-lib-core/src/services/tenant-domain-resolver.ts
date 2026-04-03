/**
 * Tenant Domain Resolver Service
 *
 * Platform-level email domain → tenant routing.
 * When the Host header cannot determine a specific tenant (resolves to 'default'),
 * this service checks if the user's email domain maps to a specific tenant.
 *
 * Used during signup to automatically route users to their tenant.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  generateEmailDomainHashWithVersion,
  getEmailDomainHashConfig,
} from '../utils/email-domain-hash';
import { createLogger } from '../utils/logger';

const log = createLogger().module('TENANT-DOMAIN-RESOLVER');

// =============================================================================
// Types
// =============================================================================

interface TenantDomainMappingRow {
  tenant_id: string;
  priority: number;
}

export interface TenantDomainCandidate {
  tenant_id: string;
  priority: number;
}

// =============================================================================
// Resolver
// =============================================================================

/**
 * Resolve a tenant ID from an email address's domain.
 *
 * Looks up the email domain in `tenant_domain_mappings` (verified=1, is_active=1)
 * and returns the highest-priority matching tenant ID, or null if none found.
 *
 * This should only be called when the Host header resolves to 'default',
 * as Host-header tenant resolution always takes precedence.
 *
 * @param db - D1 database binding
 * @param email - User email address (e.g. "user@company.com")
 * @param env - Cloudflare Workers environment bindings
 * @returns Tenant ID string, or null if no mapping found
 */
export async function resolveTenantCandidatesFromEmailDomain(
  db: D1Database,
  email: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any
): Promise<TenantDomainCandidate[]> {
  try {
    const hashConfig = await getEmailDomainHashConfig(env);
    const hashResult = await generateEmailDomainHashWithVersion(email, hashConfig);

    const rows = await db
      .prepare(
        `SELECT tenant_domain_mappings.tenant_id, tenant_domain_mappings.priority
         FROM tenant_domain_mappings
         INNER JOIN tenants ON tenants.id = tenant_domain_mappings.tenant_id
         WHERE domain_hash = ?
           AND tenant_domain_mappings.verified = 1
           AND tenant_domain_mappings.is_active = 1
           AND tenants.is_active = 1
         ORDER BY priority DESC, tenant_domain_mappings.tenant_id ASC`
      )
      .bind(hashResult.hash)
      .all<TenantDomainMappingRow>();

    const results = rows.results ?? [];
    if (results.length === 0) {
      return [];
    }

    log.debug('Resolved tenant candidates from email domain', {
      count: results.length,
      tenant_ids: results.map((row) => row.tenant_id),
    });

    return results;
  } catch (error) {
    // Non-fatal: fall back to default tenant
    log.warn('Tenant domain resolution failed', { error: (error as Error).message });
    return [];
  }
}

export async function resolveTenantFromEmailDomain(
  db: D1Database,
  email: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any
): Promise<string | null> {
  const candidates = await resolveTenantCandidatesFromEmailDomain(db, email, env);
  const first = candidates[0];
  if (!first) {
    return null;
  }

  return first.tenant_id;
}
