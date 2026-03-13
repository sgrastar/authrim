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
export async function resolveTenantFromEmailDomain(
  db: D1Database,
  email: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any
): Promise<string | null> {
  try {
    const hashConfig = await getEmailDomainHashConfig(env);
    const hashResult = await generateEmailDomainHashWithVersion(email, hashConfig);

    const row = await db
      .prepare(
        `SELECT tenant_id, priority
         FROM tenant_domain_mappings
         WHERE domain_hash = ? AND verified = 1 AND is_active = 1
         ORDER BY priority DESC
         LIMIT 1`
      )
      .bind(hashResult.hash)
      .first<TenantDomainMappingRow>();

    if (!row) {
      return null;
    }

    log.debug('Resolved tenant from email domain', {
      tenant_id: row.tenant_id,
      priority: row.priority,
    });

    return row.tenant_id;
  } catch (error) {
    // Non-fatal: fall back to default tenant
    log.warn('Tenant domain resolution failed', { error: (error as Error).message });
    return null;
  }
}
