import { prepareLogIcebergRowWrite } from '@authrim/ar-lib-core/services/log-iceberg-emitter';
import { adminAuditReceiptStatement } from '@authrim/ar-lib-core/services/admin-audit-receipts';
import type { LogIcebergRuntimeEnv } from '@authrim/ar-lib-core/services/log-iceberg-runtime';
import type { AdminAgentAuditWriter } from '../../core/audit';

/** Publishes no searchable DB copy in pipeline mode. The committed pointer is
 * delivered by the existing minute scanner, including after a lost response. */
export function createCloudflareAdminAgentAuditWriter(
  env: LogIcebergRuntimeEnv
): AdminAgentAuditWriter {
  return async (database, audit, guard) => {
    audit = structuredClone(audit);
    guard = guard ? { ...guard, params: [...guard.params] } : undefined;
    const prepared = await prepareLogIcebergRowWrite(
      env,
      database,
      {
        tenantId: audit.tenantId,
        sourceDataset: 'admin.admin_audit_log',
        logType: 'admin_audit',
        eventAt: audit.createdAt,
        expiresAt: null,
        overview: {
          action: audit.action,
          result: audit.result ?? 'success',
          severity: audit.severity,
          resource_id: audit.resourceId,
          subject_id: audit.adminUserId ?? audit.actorSub,
          request_id: audit.requestId ?? null,
        },
        adminInlineMetadata: {
          admin_actor_type: audit.actorType,
          admin_actor_id: audit.actorSub,
          admin_agent_client_id: audit.actClientId ?? null,
          admin_agent_mode: audit.actorMode ?? null,
          admin_agent_assurance: audit.actorAssurance ?? null,
          admin_agent_grant_id: audit.grantId ?? null,
          admin_machine_principal_id: audit.actPrincipalId ?? null,
          admin_agent_correlation_id: audit.requestId ?? null,
        },
        row: {
          id: audit.id,
          tenant_id: audit.tenantId,
          admin_user_id: audit.adminUserId ?? null,
          action: audit.action,
          resource_type: audit.resourceType,
          resource_id: audit.resourceId,
          result: audit.result ?? 'success',
          severity: audit.severity,
          request_id: audit.requestId ?? null,
          metadata_json: JSON.stringify(audit.metadata),
          created_at: audit.createdAt,
          actor_type: audit.actorType,
          actor_sub: audit.actorSub,
          actor_mode: audit.actorMode ?? null,
          actor_assurance: audit.actorAssurance ?? null,
          token_binding: audit.tokenBinding ?? null,
          act_client_id: audit.actClientId ?? null,
          act_principal_id: audit.actPrincipalId ?? null,
          grant_id: audit.grantId ?? null,
          elevation_id: audit.elevationId ?? null,
          mcp_tool: audit.mcpTool ?? null,
        },
      },
      (record) => ({
        where:
          'EXISTS(SELECT 1 FROM admin_audit_receipts WHERE id=? AND tenant_id=? AND payload_hmac=?)',
        params: [audit.id, audit.tenantId, record.payload_hmac],
      })
    );
    return [
      adminAuditReceiptStatement(
        prepared.record,
        audit.tenantId,
        guard
          ? {
              where: `EXISTS(SELECT 1 FROM ${guard.from} WHERE ${guard.where})`,
              params: guard.params,
            }
          : undefined
      ),
      ...prepared.statements,
    ];
  };
}
