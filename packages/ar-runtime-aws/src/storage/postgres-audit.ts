import type { AuditRuntimePorts } from '@authrim/ar-lib-core/types/audit-runtime-ports';
import { sanitizeEventDetails } from '@authrim/ar-lib-core/services/audit/utils';
import { DEFAULT_PII_CONFIG } from '@authrim/ar-lib-core/services/audit/types';
import type { PostgresQueryClient } from './postgres-transient-state';

/** Durable local delivery for the initial AWS profile; external fanout is unsupported. */
export function createPostgresAuditRuntimePorts(
  db: PostgresQueryClient,
  tenantIds: readonly string[]
): AuditRuntimePorts {
  if (tenantIds.length === 0 || tenantIds.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id))) {
    throw new Error('aws_audit_tenant_inventory_invalid');
  }
  const allowed = new Set(tenantIds);
  return {
    async append(entry) {
      if (!allowed.has(entry.tenantId)) throw new Error('aws_audit_tenant_unknown');
      if (entry.requireDurableFanout) throw new Error('aws_audit_external_fanout_unsupported');
      if (
        !/^[A-Za-z0-9._:-]{1,200}$/u.test(entry.id) ||
        !Number.isSafeInteger(entry.createdAt) ||
        entry.createdAt < 0
      ) {
        throw new Error('aws_audit_event_invalid');
      }
      const metadata: unknown = JSON.parse(entry.metadata || '{}');
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('aws_audit_metadata_invalid');
      }
      const payload = JSON.stringify({
        ...entry,
        metadata: sanitizeEventDetails(metadata as Record<string, unknown>, DEFAULT_PII_CONFIG),
      });
      if (new TextEncoder().encode(payload).byteLength > 64 * 1024)
        throw new Error('aws_audit_event_too_large');
      const result = await db.query<{ id: string }>(
        `INSERT INTO authrim_aws_audit_events AS current
           (tenant_id, id, created_at_ms, action, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE SET id = EXCLUDED.id
           WHERE current.payload = EXCLUDED.payload
         RETURNING id`,
        [entry.tenantId, entry.id, entry.createdAt, entry.action, payload]
      );
      if (result.rows.length !== 1) throw new Error('aws_audit_event_conflict');
    },
  };
}
