import {
  ensureDatabaseAdapter,
  type DatabaseAdapter,
  type DatabaseSource,
} from '@authrim/ar-lib-core';
import {
  createTenantRegistryKeyResolver,
  type TenantKeyResolver,
} from '@authrim/ar-lib-core/services/audit/tenant-key';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function createOpaqueTenantKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `t_${base64Url(bytes)}`;
}

export function createLoggingTenantKeyResolver(adapter: DatabaseAdapter): TenantKeyResolver {
  return createTenantRegistryKeyResolver(adapter);
}

function canQueryTenantKeySource(
  source: DatabaseSource | null | undefined
): source is DatabaseSource {
  const candidate = source as unknown as {
    queryOne?: unknown;
    prepare?: unknown;
  };
  return (
    !!candidate &&
    (typeof candidate.queryOne === 'function' || typeof candidate.prepare === 'function')
  );
}

export function createLoggingTenantKeyResolverFromSource(
  source: DatabaseSource | null | undefined,
  partition: string
): TenantKeyResolver | undefined {
  if (!canQueryTenantKeySource(source)) {
    return undefined;
  }
  return createLoggingTenantKeyResolver(ensureDatabaseAdapter(source, partition));
}
