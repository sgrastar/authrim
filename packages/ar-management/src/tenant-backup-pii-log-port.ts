import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { loadChunkedSensitiveDetailJson } from '@authrim/ar-lib-core/services/sensitive-detail-chunk-store';
import type { Phase8SensitiveRowTransformPort } from './tenant-backup-phase8-row-transform';
import { tenantBackupDatabaseFamily } from './tenant-backup-database-inventory';

const PREFIX = 'sensitive-detail-catalog:';

function invalid(): never {
  throw new Error('backup_pii_log_external_value_invalid');
}

/** Resolve one catalog-backed PII log value while the source snapshot is still held. */
export function createTenantBackupPiiLogTransformPort(
  env: Pick<Env, 'SENSITIVE_DETAILS' | 'OBJECT_ENCRYPTION_ROOT_KEY'>,
  transformAdminEnvelope: Phase8SensitiveRowTransformPort['transformAdminEnvelope']
): Phase8SensitiveRowTransformPort {
  return {
    transformAdminEnvelope,
    async loadExternalPiiLogValues(input, catalogReference) {
      if (!catalogReference.startsWith(PREFIX)) invalid();
      const catalogId = catalogReference.slice(PREFIX.length);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(catalogId)) invalid();
      const resources = input.databases.tenant.filter(
        (resource) =>
          resource.databaseId === input.resourceId && tenantBackupDatabaseFamily(resource) === 'pii'
      );
      if (resources.length !== 1) invalid();
      const resource = resources[0];
      const source = await input.resolveSource({
        resourceId: resource.databaseId,
        family: 'pii',
      });
      input.context.signal.throwIfAborted();
      const payload = await loadChunkedSensitiveDetailJson(source as DatabaseAdapter, env, {
        tenantId: input.context.lease.tenantId,
        objectCatalogId: catalogId,
        expectedClass: 'pii_log_values',
      });
      input.context.signal.throwIfAborted();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid();
      return JSON.stringify(payload);
    },
  };
}
