import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import {
  parseTenantBackupSelection,
  type TenantBackupSelection,
} from '@authrim/ar-lib-core/services/tenant-portability/selection-contract';
import {
  parseReplicationWriterConfiguration,
  type ReplicationWriterConfiguration,
} from '@authrim/ar-lib-core/services/deployment-replication/writer';
import { replicationCanonicalJson } from '@authrim/ar-lib-core/services/deployment-replication/transport';
import type { Env } from '@authrim/ar-lib-core';

export const REPLICATION_GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export interface ReplicationExportGrantScope {
  version: 1;
  kind: 'tenant_backup_export';
  tenantId: string;
  pairId: string;
  sourceDeploymentId: string;
  destinationDeploymentId: string;
  issuer: string;
  selection: TenantBackupSelection;
}
export interface ReplicationExportGrant {
  id: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  scope: ReplicationExportGrantScope;
}
interface GrantRow {
  id: string;
  tenant_id: string;
  created_by: string;
  scope_json: string;
  scope_sha256: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}
function denied(): never {
  throw new Error('backup_replication_grant_denied');
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) denied();
}
function time(now: number) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - REPLICATION_GRANT_MAX_AGE_MS
  )
    denied();
}
async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function replicationExportInstallation(
  env: Pick<Env, 'AUTHRIM_REPLICATION_WRITER'>
): ReplicationWriterConfiguration {
  if (!env.AUTHRIM_REPLICATION_WRITER) denied();
  return parseReplicationWriterConfiguration(env.AUTHRIM_REPLICATION_WRITER);
}
export function parseReplicationExportGrantScope(value: unknown): ReplicationExportGrantScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(',') !==
      'destinationDeploymentId,issuer,kind,pairId,selection,sourceDeploymentId,tenantId,version' ||
    v.version !== 1 ||
    v.kind !== 'tenant_backup_export'
  )
    denied();
  for (const id of [v.tenantId, v.pairId, v.sourceDeploymentId, v.destinationDeploymentId])
    identifier(id);
  if (
    v.sourceDeploymentId === v.destinationDeploymentId ||
    typeof v.issuer !== 'string' ||
    v.issuer.length > 2048
  )
    denied();
  const url = new URL(v.issuer);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) denied();
  return {
    version: 1,
    kind: 'tenant_backup_export',
    tenantId: v.tenantId as string,
    pairId: v.pairId as string,
    sourceDeploymentId: v.sourceDeploymentId as string,
    destinationDeploymentId: v.destinationDeploymentId as string,
    issuer: v.issuer,
    selection: parseTenantBackupSelection(v.selection),
  };
}
function bind(
  scope: ReplicationExportGrantScope,
  installed: ReplicationWriterConfiguration,
  tenantId: string
) {
  if (
    scope.tenantId !== tenantId ||
    (installed.version === 1 && installed.tenantId !== tenantId) ||
    scope.pairId !== installed.pairId ||
    scope.sourceDeploymentId !== installed.deploymentId
  )
    denied();
}
/** This identity is reserved to this router; possession never grants ordinary Admin API access. */
export function replicationExportActor(grant: Pick<ReplicationExportGrant, 'id'>): string {
  return `replication-export:${grant.id}`;
}
export class TenantBackupReplicationGrantStore {
  constructor(private readonly database: Pick<DatabaseAdapter, 'queryOne' | 'execute'>) {}
  async create(input: {
    tenantId: string;
    actorId: string;
    scope: unknown;
    expiresAt: number;
    now: number;
    auditId: string;
    installed: ReplicationWriterConfiguration;
  }) {
    time(input.now);
    identifier(input.actorId);
    identifier(input.auditId);
    const scope = parseReplicationExportGrantScope(input.scope);
    bind(scope, input.installed, input.tenantId);
    if (
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= input.now ||
      input.expiresAt > input.now + REPLICATION_GRANT_MAX_AGE_MS
    )
      denied();
    const id = crypto.randomUUID();
    const credential = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const scopeJson = replicationCanonicalJson(scope);
    await this.database.execute(
      `INSERT INTO tenant_backup_replication_grants
      (id,tenant_id,created_by,credential_sha256,scope_json,scope_sha256,created_at,expires_at,creation_audit_id)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.tenantId,
        input.actorId,
        await hash(credential),
        scopeJson,
        await hash(scopeJson),
        input.now,
        input.expiresAt,
        input.auditId,
      ]
    );
    const grant = await this.load(input.tenantId, id);
    if (
      !grant ||
      grant.createdBy !== input.actorId ||
      grant.expiresAt !== input.expiresAt ||
      replicationCanonicalJson(grant.scope) !== scopeJson
    )
      denied();
    return { grant, credential };
  }
  private async decode(row: GrantRow | null): Promise<ReplicationExportGrant | null> {
    if (!row) return null;
    if (
      typeof row.scope_json !== 'string' ||
      new TextEncoder().encode(row.scope_json).length > 8192 ||
      (await hash(row.scope_json)) !== row.scope_sha256
    )
      denied();
    const scope = parseReplicationExportGrantScope(JSON.parse(row.scope_json));
    if (replicationCanonicalJson(scope) !== row.scope_json || scope.tenantId !== row.tenant_id)
      denied();
    identifier(row.id);
    identifier(row.created_by);
    time(row.created_at);
    if (
      !Number.isSafeInteger(row.expires_at) ||
      row.expires_at <= row.created_at ||
      row.expires_at > row.created_at + REPLICATION_GRANT_MAX_AGE_MS ||
      (row.revoked_at !== null &&
        (!Number.isSafeInteger(row.revoked_at) || row.revoked_at < row.created_at))
    )
      denied();
    return {
      id: row.id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      scope,
    };
  }
  async load(tenantId: string, id: string) {
    identifier(tenantId);
    identifier(id);
    return this.decode(
      await this.database.queryOne<GrantRow>(
        'SELECT id,tenant_id,created_by,scope_json,scope_sha256,created_at,expires_at,revoked_at FROM tenant_backup_replication_grants WHERE id=? AND tenant_id=?',
        [id, tenantId]
      )
    );
  }
  async authenticate(input: {
    tenantId: string;
    id: string;
    credential: string;
    now: number;
    installed: ReplicationWriterConfiguration;
  }) {
    time(input.now);
    identifier(input.id);
    identifier(input.tenantId);
    if (!/^[a-f0-9]{64}$/.test(input.credential)) denied();
    const row = await this.database.queryOne<GrantRow>(
      `SELECT id,tenant_id,created_by,scope_json,scope_sha256,created_at,expires_at,revoked_at
      FROM tenant_backup_replication_grants WHERE id=? AND tenant_id=? AND credential_sha256=?
      AND created_at<=? AND expires_at>? AND revoked_at IS NULL`,
      [input.id, input.tenantId, await hash(input.credential), input.now, input.now]
    );
    const grant = await this.decode(row);
    if (!grant) denied();
    bind(grant.scope, input.installed, input.tenantId);
    return grant;
  }
  async revoke(input: {
    tenantId: string;
    id: string;
    actorId: string;
    auditId: string;
    now: number;
  }) {
    time(input.now);
    for (const id of [input.tenantId, input.id, input.actorId, input.auditId]) identifier(id);
    const row = await this.database.queryOne<GrantRow>(
      `UPDATE tenant_backup_replication_grants SET revoked_at=?,revoked_by=?,revocation_audit_id=?
      WHERE id=? AND tenant_id=? AND revoked_at IS NULL AND created_at<=?
      RETURNING id,tenant_id,created_by,scope_json,scope_sha256,created_at,expires_at,revoked_at`,
      [input.now, input.actorId, input.auditId, input.id, input.tenantId, input.now]
    );
    return (await this.decode(row)) ?? this.load(input.tenantId, input.id);
  }
}
