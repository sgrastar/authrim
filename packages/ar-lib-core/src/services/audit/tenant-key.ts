import { deriveTenantKeyFromTenantId } from '@authrim/ar-lib-logging/contract';
import type { DatabaseAdapter } from '../../db/adapter';

export type TenantKeyResolver = (
  tenantId: string
) => string | null | undefined | Promise<string | null | undefined>;

export function createTenantRegistryKeyResolver(adapter: DatabaseAdapter): TenantKeyResolver {
  const cache = new Map<string, string>();
  return async (tenantId: string) => {
    const cached = cache.get(tenantId);
    if (cached) {
      return cached;
    }
    try {
      const row = await adapter.queryOne<{ tenant_key: string | null }>(
        'SELECT tenant_key FROM tenants WHERE id = ?',
        [tenantId]
      );
      if (row?.tenant_key) {
        cache.set(tenantId, row.tenant_key);
        return row.tenant_key;
      }
    } catch {
      return null;
    }
    return null;
  };
}

export async function resolveAuditTenantKey(
  tenantId: string,
  options: {
    tenantKeySalt?: string;
    tenantKeyResolver?: TenantKeyResolver;
  } = {}
): Promise<string> {
  const resolved = await options.tenantKeyResolver?.(tenantId);
  if (resolved) {
    return resolved;
  }
  return deriveTenantKeyFromTenantId(tenantId, options.tenantKeySalt);
}
