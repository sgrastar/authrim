import type { AdminAgentAuditWriter } from '../../audit';
/** Test-only SQL oracle for repository CAS behavior; the production Iceberg port
 * is covered separately with real crypto, staging, retry objects and rollback. */
export const recordingAdminAgentAuditWriter: AdminAgentAuditWriter = async (
  _database,
  audit,
  guard
) => {
  const values = [
    audit.id,
    audit.tenantId,
    audit.adminUserId ?? null,
    audit.action,
    audit.resourceType,
    audit.resourceId,
    audit.result ?? 'success',
    audit.severity,
    audit.requestId ?? null,
    JSON.stringify(audit.metadata),
    audit.createdAt,
    audit.actorType,
    audit.actorSub,
    audit.actorMode ?? null,
    audit.actorAssurance ?? null,
    audit.tokenBinding ?? null,
    audit.actClientId ?? null,
    audit.actPrincipalId ?? null,
    audit.grantId ?? null,
    audit.elevationId ?? null,
    audit.mcpTool ?? null,
  ];
  const valuePlaceholders = values.map(() => '?').join(', ');
  const replayMatches = [
    'tenant_id',
    'admin_user_id',
    'action',
    'resource_type',
    'resource_id',
    'result',
    'severity',
    'request_id',
    'metadata_json',
    'created_at',
    'actor_type',
    'actor_sub',
    'actor_mode',
    'actor_assurance',
    'token_binding',
    'act_client_id',
    'act_principal_id',
    'grant_id',
    'elevation_id',
    'mcp_tool',
  ]
    .map((column) => `admin_audit_log.${column} IS excluded.${column}`)
    .join(' AND ');
  return [
    {
      sql: `INSERT INTO admin_audit_log (
      id, tenant_id, admin_user_id, action, resource_type, resource_id,
      result, severity, request_id, metadata_json, created_at,
      actor_type, actor_sub, actor_mode, actor_assurance, token_binding,
      act_client_id, act_principal_id, grant_id, elevation_id, mcp_tool
    ) ${guard ? `SELECT ${valuePlaceholders} FROM ${guard.from} WHERE ${guard.where}` : `VALUES (${valuePlaceholders})`}
    ON CONFLICT(id) DO UPDATE SET tenant_id = CASE
      WHEN ${replayMatches} THEN admin_audit_log.tenant_id
      ELSE NULL
    END`,
      params: guard ? [...values, ...guard.params] : values,
    },
  ];
};
