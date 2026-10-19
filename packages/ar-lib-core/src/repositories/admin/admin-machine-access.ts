/**
 * Admin Machine Access Repository
 *
 * Repository for scoped machine principals and credentials stored in DB_ADMIN.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';
import { hasAdminPermission } from '../../types/admin-user';
import { intersectMachinePermissionSets, resolveMachineTenantScope } from './admin-machine-grant';

export type AdminMachinePrincipalType =
  | 'setup_tool'
  | 'admin_ui_bff'
  | 'automation'
  | 'ci'
  | 'mcp_server'
  | 'ai_agent'
  | 'internal_service'
  | 'integration';

export type AdminMachinePrincipalStatus = 'active' | 'disabled' | 'deleted';
export type AdminMachineCredentialStatus = 'active' | 'rotating' | 'revoked' | 'expired';
export type AdminMachineCredentialAlgorithm = 'ES256' | 'PS256' | 'RS256';
export type AdminMachineTenantScopeMode = 'none' | 'all' | 'allow';

export interface AdminMachineActorRef {
  actorType?: string;
  actorId?: string;
}

export interface AdminMachinePrincipal {
  id: string;
  clientId: string;
  displayName: string;
  description: string | null;
  principalType: AdminMachinePrincipalType;
  status: AdminMachinePrincipalStatus;
  defaultAudience: string;
  tokenTtlSeconds: number;
  createdByActorType: string | null;
  createdByActorId: string | null;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
  disabledByActorType: string | null;
  disabledByActorId: string | null;
}

export interface AdminMachineCredential {
  id: string;
  principalId: string;
  kid: string;
  publicJwkJson: string;
  alg: AdminMachineCredentialAlgorithm;
  displayName: string;
  description: string | null;
  status: AdminMachineCredentialStatus;
  notBefore: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  lastUsedUserAgent: string | null;
  createdByActorType: string | null;
  createdByActorId: string | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
  revokedByActorType: string | null;
  revokedByActorId: string | null;
  revokeReason: string | null;
}

export interface AdminMachineTenantScope {
  scopeMode: AdminMachineTenantScopeMode;
  tenantId: string | null;
}

export interface AdminMachineClientCredential {
  principal: AdminMachinePrincipal;
  credential: AdminMachineCredential;
}

/**
 * A principal, one of its credentials, and the permissions and tenant scopes of both, read by one
 * statement, so they are the state at one instant. `permissions` and `tenantScope` are what the
 * credential ends up with (the principal's narrowed by the credential's); `tenantScope` holds
 * tenant IDs, or `'*'` for all of them.
 */
export interface AdminMachineGrantSnapshot {
  principal: AdminMachinePrincipal;
  credential: AdminMachineCredential;
  principalPermissions: string[];
  credentialPermissions: string[];
  principalTenantScopes: AdminMachineTenantScope[];
  credentialTenantScopes: AdminMachineTenantScope[];
  permissions: string[];
  tenantScope: string[];
}

export interface AdminMachinePrincipalCreateInput {
  id?: string;
  clientId: string;
  displayName: string;
  description?: string | null;
  principalType: AdminMachinePrincipalType;
  status?: AdminMachinePrincipalStatus;
  defaultAudience?: string;
  tokenTtlSeconds?: number;
  createdBy?: AdminMachineActorRef;
}

export interface AdminMachinePrincipalUpdateInput {
  displayName?: string;
  description?: string | null;
  status?: AdminMachinePrincipalStatus;
  tokenTtlSeconds?: number;
  disabledBy?: AdminMachineActorRef;
}

export interface AdminMachineCredentialCreateInput {
  id?: string;
  principalId: string;
  kid: string;
  publicJwkJson: string;
  alg: AdminMachineCredentialAlgorithm;
  displayName: string;
  description?: string | null;
  status?: AdminMachineCredentialStatus;
  notBefore?: number | null;
  expiresAt?: number | null;
  createdBy?: AdminMachineActorRef;
}

export interface AdminMachineCredentialUpdateInput {
  displayName?: string;
  description?: string | null;
  status?: AdminMachineCredentialStatus;
  notBefore?: number | null;
  expiresAt?: number | null;
  revokedBy?: AdminMachineActorRef;
  revokeReason?: string | null;
}

/**
 * Permissions and tenant scopes written together with the principal or credential they belong to.
 * Leaving one out leaves it as it is.
 */
export interface AdminMachineGrantWrite {
  permissions?: readonly string[];
  tenantScopes?: readonly AdminMachineTenantScope[];
}

/**
 * What a write was decided on. A write that changes what a principal or credential can do is
 * authorized against the state the route read; `revision` (from `getPrincipalRevision` /
 * `getCredentialRevision`, read before anything else) is checked inside the write's batch, so a
 * change made in between makes the whole batch fail with `AdminMachineConflictError` and write
 * nothing.
 */
export interface AdminMachineWriteGuard {
  principal?: { id: string; revision: string };
  credential?: { id: string; revision: string };
}

/** The state a write was decided on has changed; read it again and decide again. */
export class AdminMachineConflictError extends Error {
  constructor() {
    super('admin_machine_access_conflict');
    this.name = 'AdminMachineConflictError';
  }
}

interface BatchStatement {
  sql: string;
  params: unknown[];
}

export interface AdminMachinePrincipalListOptions {
  status?: AdminMachinePrincipalStatus;
  principalType?: AdminMachinePrincipalType;
  limit?: number;
  offset?: number;
}

interface AdminMachinePrincipalRow {
  id: string;
  client_id: string;
  display_name: string;
  description: string | null;
  principal_type: AdminMachinePrincipalType;
  status: AdminMachinePrincipalStatus;
  default_audience: string;
  token_ttl_seconds: number;
  created_by_actor_type: string | null;
  created_by_actor_id: string | null;
  created_at: number;
  updated_at: number;
  disabled_at: number | null;
  disabled_by_actor_type: string | null;
  disabled_by_actor_id: string | null;
}

interface AdminMachineCredentialRow {
  id: string;
  principal_id: string;
  kid: string;
  public_jwk_json: string;
  alg: AdminMachineCredentialAlgorithm;
  display_name: string;
  description: string | null;
  status: AdminMachineCredentialStatus;
  not_before: number | null;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  last_used_user_agent: string | null;
  created_by_actor_type: string | null;
  created_by_actor_id: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_by_actor_type: string | null;
  revoked_by_actor_id: string | null;
  revoke_reason: string | null;
}

interface AdminMachineGrantSnapshotRow extends AdminMachineClientCredentialRow {
  principal_permissions_json: string;
  credential_permissions_json: string;
  principal_scopes_json: string;
  credential_scopes_json: string;
}

interface AdminMachineClientCredentialRow extends AdminMachinePrincipalRow {
  credential_id: string;
  credential_principal_id: string;
  credential_kid: string;
  credential_public_jwk_json: string;
  credential_alg: AdminMachineCredentialAlgorithm;
  credential_display_name: string;
  credential_description: string | null;
  credential_status: AdminMachineCredentialStatus;
  credential_not_before: number | null;
  credential_expires_at: number | null;
  credential_last_used_at: number | null;
  credential_last_used_ip: string | null;
  credential_last_used_user_agent: string | null;
  credential_created_by_actor_type: string | null;
  credential_created_by_actor_id: string | null;
  credential_created_at: number;
  credential_updated_at: number;
  credential_revoked_at: number | null;
  credential_revoked_by_actor_type: string | null;
  credential_revoked_by_actor_id: string | null;
  credential_revoke_reason: string | null;
}

export class AdminMachineAccessRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async createPrincipal(input: AdminMachinePrincipalCreateInput): Promise<AdminMachinePrincipal> {
    const { row, statement } = this.principalInsert(input);
    await this.adapter.execute(statement.sql, statement.params);
    return this.principalFromRow(row);
  }

  /**
   * Create a principal with its permissions and tenant scopes in one atomic write. A principal
   * without them reaches nothing, so no state between the writes can hold more than the caller
   * meant to give.
   */
  async createPrincipalWithGrant(
    input: AdminMachinePrincipalCreateInput,
    grant: AdminMachineGrantWrite,
    actor?: AdminMachineActorRef
  ): Promise<AdminMachinePrincipal> {
    const { row, statement } = this.principalInsert(input);
    await this.adapter.batch([
      statement,
      ...this.grantStatements('principal', row.id, grant, actor),
    ]);
    return this.principalFromRow(row);
  }

  private principalInsert(input: AdminMachinePrincipalCreateInput): {
    row: AdminMachinePrincipalRow;
    statement: BatchStatement;
  } {
    const now = getCurrentTimestamp();
    const row: AdminMachinePrincipalRow = {
      id: input.id ?? generateId(),
      client_id: input.clientId,
      display_name: input.displayName,
      description: input.description ?? null,
      principal_type: input.principalType,
      status: input.status ?? 'active',
      default_audience: input.defaultAudience ?? 'authrim:admin-api',
      token_ttl_seconds: input.tokenTtlSeconds ?? 600,
      created_by_actor_type: input.createdBy?.actorType ?? null,
      created_by_actor_id: input.createdBy?.actorId ?? null,
      created_at: now,
      updated_at: now,
      disabled_at: null,
      disabled_by_actor_type: null,
      disabled_by_actor_id: null,
    };

    return {
      row,
      statement: {
        sql: `INSERT INTO admin_machine_principals (
        id, client_id, display_name, description, principal_type, status,
        default_audience, token_ttl_seconds, created_by_actor_type, created_by_actor_id,
        created_at, updated_at, disabled_at, disabled_by_actor_type, disabled_by_actor_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          row.id,
          row.client_id,
          row.display_name,
          row.description,
          row.principal_type,
          row.status,
          row.default_audience,
          row.token_ttl_seconds,
          row.created_by_actor_type,
          row.created_by_actor_id,
          row.created_at,
          row.updated_at,
          row.disabled_at,
          row.disabled_by_actor_type,
          row.disabled_by_actor_id,
        ],
      },
    };
  }

  async createCredential(
    input: AdminMachineCredentialCreateInput
  ): Promise<AdminMachineCredential> {
    const { row, statement } = this.credentialInsert(input);
    await this.adapter.execute(statement.sql, statement.params);
    return this.credentialFromRow(row);
  }

  /**
   * Create a credential with its own permissions and tenant scopes in one atomic write. Without
   * rows of its own a credential takes everything its principal has, so the key must not exist
   * before they do.
   */
  async createCredentialWithGrant(
    input: AdminMachineCredentialCreateInput,
    grant: AdminMachineGrantWrite,
    actor?: AdminMachineActorRef,
    guard?: AdminMachineWriteGuard
  ): Promise<AdminMachineCredential> {
    const { row, statement } = this.credentialInsert(input);
    await this.guardedBatch(
      [statement, ...this.grantStatements('credential', row.id, grant, actor)],
      guard
    );
    return this.credentialFromRow(row);
  }

  /**
   * Rotation as one atomic write: the previous credential is updated, and the new one is created
   * with its permissions and tenant scopes.
   */
  async rotateCredential(input: {
    previousCredentialId: string;
    previousUpdate: AdminMachineCredentialUpdateInput;
    next: AdminMachineCredentialCreateInput;
    grant: AdminMachineGrantWrite;
    actor?: AdminMachineActorRef;
    guard?: AdminMachineWriteGuard;
  }): Promise<AdminMachineCredential> {
    const { row, statement } = this.credentialInsert(input.next);
    const update = this.credentialUpdate(input.previousCredentialId, input.previousUpdate);
    await this.guardedBatch(
      [
        ...(update ? [update] : []),
        statement,
        ...this.grantStatements('credential', row.id, input.grant, input.actor),
      ],
      input.guard
    );
    return this.credentialFromRow(row);
  }

  private credentialInsert(input: AdminMachineCredentialCreateInput): {
    row: AdminMachineCredentialRow;
    statement: BatchStatement;
  } {
    const now = getCurrentTimestamp();
    const row: AdminMachineCredentialRow = {
      id: input.id ?? generateId(),
      principal_id: input.principalId,
      kid: input.kid,
      public_jwk_json: input.publicJwkJson,
      alg: input.alg,
      display_name: input.displayName,
      description: input.description ?? null,
      status: input.status ?? 'active',
      not_before: input.notBefore ?? null,
      expires_at: input.expiresAt ?? null,
      last_used_at: null,
      last_used_ip: null,
      last_used_user_agent: null,
      created_by_actor_type: input.createdBy?.actorType ?? null,
      created_by_actor_id: input.createdBy?.actorId ?? null,
      created_at: now,
      updated_at: now,
      revoked_at: null,
      revoked_by_actor_type: null,
      revoked_by_actor_id: null,
      revoke_reason: null,
    };

    return {
      row,
      statement: {
        sql: `INSERT INTO admin_machine_credentials (
        id, principal_id, kid, public_jwk_json, alg, display_name, description, status,
        not_before, expires_at, last_used_at, last_used_ip, last_used_user_agent,
        created_by_actor_type, created_by_actor_id, created_at, updated_at, revoked_at,
        revoked_by_actor_type, revoked_by_actor_id, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          row.id,
          row.principal_id,
          row.kid,
          row.public_jwk_json,
          row.alg,
          row.display_name,
          row.description,
          row.status,
          row.not_before,
          row.expires_at,
          row.last_used_at,
          row.last_used_ip,
          row.last_used_user_agent,
          row.created_by_actor_type,
          row.created_by_actor_id,
          row.created_at,
          row.updated_at,
          row.revoked_at,
          row.revoked_by_actor_type,
          row.revoked_by_actor_id,
          row.revoke_reason,
        ],
      },
    };
  }

  async findPrincipalByClientId(clientId: string): Promise<AdminMachinePrincipal | null> {
    const row = await this.adapter.queryOne<AdminMachinePrincipalRow>(
      'SELECT * FROM admin_machine_principals WHERE client_id = ?',
      [clientId]
    );
    return row ? this.principalFromRow(row) : null;
  }

  async findPrincipalById(id: string): Promise<AdminMachinePrincipal | null> {
    const row = await this.adapter.queryOne<AdminMachinePrincipalRow>(
      'SELECT * FROM admin_machine_principals WHERE id = ?',
      [id]
    );
    return row ? this.principalFromRow(row) : null;
  }

  async findCredentialById(id: string): Promise<AdminMachineCredential | null> {
    const row = await this.adapter.queryOne<AdminMachineCredentialRow>(
      'SELECT * FROM admin_machine_credentials WHERE id = ?',
      [id]
    );
    return row ? this.credentialFromRow(row) : null;
  }

  async listPrincipals(
    options: AdminMachinePrincipalListOptions = {}
  ): Promise<AdminMachinePrincipal[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.principalType) {
      conditions.push('principal_type = ?');
      params.push(options.principalType);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const rows = await this.adapter.query<AdminMachinePrincipalRow>(
      `SELECT * FROM admin_machine_principals
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return rows.map((row) => this.principalFromRow(row));
  }

  async updatePrincipal(
    id: string,
    input: AdminMachinePrincipalUpdateInput,
    guard?: AdminMachineWriteGuard
  ): Promise<AdminMachinePrincipal | null> {
    const statement = this.principalUpdate(id, input);
    if (statement) {
      await this.guardedBatch([statement], guard);
    }
    return this.findPrincipalById(id);
  }

  /**
   * Update a principal and replace its permissions and tenant scopes in one atomic write, so a
   * failure part-way leaves the principal as it was.
   */
  async updatePrincipalWithGrant(
    id: string,
    input: AdminMachinePrincipalUpdateInput,
    grant: AdminMachineGrantWrite,
    actor?: AdminMachineActorRef,
    guard?: AdminMachineWriteGuard
  ): Promise<AdminMachinePrincipal | null> {
    // Changing the grant changes the revision even when no field of the row does.
    const statement = this.principalUpdate(id, input) ?? this.principalTouch(id);
    await this.guardedBatch(
      [statement, ...this.grantStatements('principal', id, grant, actor)],
      guard
    );
    return this.findPrincipalById(id);
  }

  private principalTouch(id: string): BatchStatement {
    return {
      sql: 'UPDATE admin_machine_principals SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
      params: [getCurrentTimestamp(), id],
    };
  }

  private credentialTouch(id: string): BatchStatement {
    return {
      sql: 'UPDATE admin_machine_credentials SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
      params: [getCurrentTimestamp(), id],
    };
  }

  private principalUpdate(
    id: string,
    input: AdminMachinePrincipalUpdateInput
  ): BatchStatement | null {
    const updates: string[] = [];
    const params: unknown[] = [];
    const now = getCurrentTimestamp();

    if (input.displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(input.displayName);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
      if (input.status === 'disabled' || input.status === 'deleted') {
        updates.push('disabled_at = ?', 'disabled_by_actor_type = ?', 'disabled_by_actor_id = ?');
        params.push(now, input.disabledBy?.actorType ?? null, input.disabledBy?.actorId ?? null);
      }
    }
    if (input.tokenTtlSeconds !== undefined) {
      updates.push('token_ttl_seconds = ?');
      params.push(input.tokenTtlSeconds);
    }
    if (updates.length === 0) {
      return null;
    }

    updates.push('updated_at = MAX(updated_at + 1, ?)');
    params.push(now, id);
    return {
      sql: `UPDATE admin_machine_principals SET ${updates.join(', ')} WHERE id = ?`,
      params,
    };
  }

  async listCredentials(principalId: string): Promise<AdminMachineCredential[]> {
    const rows = await this.adapter.query<AdminMachineCredentialRow>(
      `SELECT * FROM admin_machine_credentials
       WHERE principal_id = ?
       ORDER BY created_at DESC`,
      [principalId]
    );
    return rows.map((row) => this.credentialFromRow(row));
  }

  async updateCredential(
    id: string,
    input: AdminMachineCredentialUpdateInput,
    guard?: AdminMachineWriteGuard
  ): Promise<AdminMachineCredential | null> {
    const statement = this.credentialUpdate(id, input);
    if (statement) {
      await this.guardedBatch([statement], guard);
    }
    return this.findCredentialById(id);
  }

  /** Update a credential and replace its permissions and tenant scopes in one atomic write. */
  async updateCredentialWithGrant(
    id: string,
    input: AdminMachineCredentialUpdateInput,
    grant: AdminMachineGrantWrite,
    actor?: AdminMachineActorRef,
    guard?: AdminMachineWriteGuard
  ): Promise<AdminMachineCredential | null> {
    const statement = this.credentialUpdate(id, input) ?? this.credentialTouch(id);
    await this.guardedBatch(
      [statement, ...this.grantStatements('credential', id, grant, actor)],
      guard
    );
    return this.findCredentialById(id);
  }

  private credentialUpdate(
    id: string,
    input: AdminMachineCredentialUpdateInput
  ): BatchStatement | null {
    const updates: string[] = [];
    const params: unknown[] = [];
    const now = getCurrentTimestamp();

    if (input.displayName !== undefined) {
      updates.push('display_name = ?');
      params.push(input.displayName);
    }
    if (input.description !== undefined) {
      updates.push('description = ?');
      params.push(input.description);
    }
    if (input.status !== undefined) {
      updates.push('status = ?');
      params.push(input.status);
      if (input.status === 'revoked') {
        updates.push('revoked_at = ?', 'revoked_by_actor_type = ?', 'revoked_by_actor_id = ?');
        params.push(now, input.revokedBy?.actorType ?? null, input.revokedBy?.actorId ?? null);
      }
    }
    if (input.notBefore !== undefined) {
      updates.push('not_before = ?');
      params.push(input.notBefore);
    }
    if (input.expiresAt !== undefined) {
      updates.push('expires_at = ?');
      params.push(input.expiresAt);
    }
    if (input.revokeReason !== undefined) {
      updates.push('revoke_reason = ?');
      params.push(input.revokeReason);
    }
    if (updates.length === 0) {
      return null;
    }

    updates.push('updated_at = MAX(updated_at + 1, ?)');
    params.push(now, id);
    return {
      sql: `UPDATE admin_machine_credentials SET ${updates.join(', ')} WHERE id = ?`,
      params,
    };
  }

  async findCredentialForClient(
    clientId: string,
    kid: string
  ): Promise<AdminMachineClientCredential | null> {
    const row = await this.adapter.queryOne<AdminMachineClientCredentialRow>(
      `SELECT
        p.*,
        c.id AS credential_id,
        c.principal_id AS credential_principal_id,
        c.kid AS credential_kid,
        c.public_jwk_json AS credential_public_jwk_json,
        c.alg AS credential_alg,
        c.display_name AS credential_display_name,
        c.description AS credential_description,
        c.status AS credential_status,
        c.not_before AS credential_not_before,
        c.expires_at AS credential_expires_at,
        c.last_used_at AS credential_last_used_at,
        c.last_used_ip AS credential_last_used_ip,
        c.last_used_user_agent AS credential_last_used_user_agent,
        c.created_by_actor_type AS credential_created_by_actor_type,
        c.created_by_actor_id AS credential_created_by_actor_id,
        c.created_at AS credential_created_at,
        c.updated_at AS credential_updated_at,
        c.revoked_at AS credential_revoked_at,
        c.revoked_by_actor_type AS credential_revoked_by_actor_type,
        c.revoked_by_actor_id AS credential_revoked_by_actor_id,
        c.revoke_reason AS credential_revoke_reason
       FROM admin_machine_principals p
       JOIN admin_machine_credentials c ON c.principal_id = p.id
       WHERE p.client_id = ? AND c.kid = ?`,
      [clientId, kid]
    );
    if (!row) {
      return null;
    }
    return {
      principal: this.principalFromRow(row),
      credential: this.credentialFromJoinedRow(row),
    };
  }

  /**
   * The principal, the credential and their permissions and tenant scopes as of one instant. Read
   * one by one, a change between the reads (a principal moved from one valid state to another)
   * gives a combination that was never stored; a token is issued, and an access token accepted,
   * on this snapshot only. The credential must belong to the principal.
   */
  async loadMachineGrantSnapshot(
    principalId: string,
    credentialId: string
  ): Promise<AdminMachineGrantSnapshot | null> {
    const row = await this.adapter.queryOne<AdminMachineGrantSnapshotRow>(
      `SELECT
        p.*,
        c.id AS credential_id,
        c.principal_id AS credential_principal_id,
        c.kid AS credential_kid,
        c.public_jwk_json AS credential_public_jwk_json,
        c.alg AS credential_alg,
        c.display_name AS credential_display_name,
        c.description AS credential_description,
        c.status AS credential_status,
        c.not_before AS credential_not_before,
        c.expires_at AS credential_expires_at,
        c.last_used_at AS credential_last_used_at,
        c.last_used_ip AS credential_last_used_ip,
        c.last_used_user_agent AS credential_last_used_user_agent,
        c.created_by_actor_type AS credential_created_by_actor_type,
        c.created_by_actor_id AS credential_created_by_actor_id,
        c.created_at AS credential_created_at,
        c.updated_at AS credential_updated_at,
        c.revoked_at AS credential_revoked_at,
        c.revoked_by_actor_type AS credential_revoked_by_actor_type,
        c.revoked_by_actor_id AS credential_revoked_by_actor_id,
        c.revoke_reason AS credential_revoke_reason,
        (SELECT json_group_array(permission) FROM admin_machine_principal_permissions
          WHERE principal_id = p.id) AS principal_permissions_json,
        (SELECT json_group_array(permission) FROM admin_machine_credential_permissions
          WHERE credential_id = c.id) AS credential_permissions_json,
        (SELECT json_group_array(json_object('scope_mode', scope_mode, 'tenant_id', tenant_id))
           FROM admin_machine_principal_tenant_scopes
          WHERE principal_id = p.id) AS principal_scopes_json,
        (SELECT json_group_array(json_object('scope_mode', scope_mode, 'tenant_id', tenant_id))
           FROM admin_machine_credential_tenant_scopes
          WHERE credential_id = c.id) AS credential_scopes_json
       FROM admin_machine_principals p
       JOIN admin_machine_credentials c ON c.principal_id = p.id
       WHERE p.id = ? AND c.id = ?`,
      [principalId, credentialId]
    );
    if (!row) {
      return null;
    }
    const permissions = (json: string) => (JSON.parse(json) as string[]).slice().sort();
    const scopes = (json: string): AdminMachineTenantScope[] =>
      (
        JSON.parse(json) as Array<{
          scope_mode: AdminMachineTenantScopeMode;
          tenant_id: string | null;
        }>
      )
        .map((entry) => ({ scopeMode: entry.scope_mode, tenantId: entry.tenant_id }))
        .sort((a, b) =>
          `${a.scopeMode}:${a.tenantId ?? ''}`.localeCompare(`${b.scopeMode}:${b.tenantId ?? ''}`)
        );
    const principalPermissions = permissions(row.principal_permissions_json);
    const credentialPermissions = permissions(row.credential_permissions_json);
    const principalTenantScopes = scopes(row.principal_scopes_json);
    const credentialTenantScopes = scopes(row.credential_scopes_json);
    return {
      principal: this.principalFromRow(row),
      credential: this.credentialFromJoinedRow(row),
      principalPermissions,
      credentialPermissions,
      principalTenantScopes,
      credentialTenantScopes,
      permissions:
        credentialPermissions.length > 0
          ? intersectMachinePermissionSets(principalPermissions, credentialPermissions)
          : principalPermissions,
      tenantScope: resolveMachineTenantScope(principalTenantScopes, credentialTenantScopes),
    };
  }

  /**
   * What a machine principal (with one of its credentials, if given) may do for one tenant, as the
   * agent paths limit a delegated grant by it: the principal's permissions, narrowed by the
   * credential's own. Only tenants named explicitly count: a principal or credential with a scope
   * of `all` or `none` has no limit here. The principal, the credential and everything read
   * about them come from one snapshot, so the scope of one stored state is never combined with
   * the permissions of another.
   */
  async resolveTenantMachineLimit(
    tenantId: string,
    principalId: string,
    credentialId?: string
  ): Promise<{
    principal: AdminMachinePrincipal;
    credential: AdminMachineCredential | null;
    permissions: string[];
  } | null> {
    const explicit = (scopes: readonly AdminMachineTenantScope[]) =>
      scopes.length > 0 &&
      scopes.every((scope) => scope.scopeMode === 'allow') &&
      scopes.some((scope) => scope.tenantId === tenantId);
    let principal: AdminMachinePrincipal;
    let credential: AdminMachineCredential | null = null;
    let principalPermissions: string[];
    let principalScopes: AdminMachineTenantScope[];
    let credentialPermissions: string[] = [];
    let credentialScopes: AdminMachineTenantScope[] = [];
    if (credentialId === undefined) {
      const snapshot = await this.loadPrincipalGrantSnapshot(principalId);
      if (!snapshot) return null;
      ({ principal, principalPermissions, principalScopes } = {
        principal: snapshot.principal,
        principalPermissions: snapshot.permissions,
        principalScopes: snapshot.tenantScopes,
      });
    } else {
      const snapshot = await this.loadMachineGrantSnapshot(principalId, credentialId);
      if (!snapshot) return null;
      principal = snapshot.principal;
      credential = snapshot.credential;
      principalPermissions = snapshot.principalPermissions;
      principalScopes = snapshot.principalTenantScopes;
      credentialPermissions = snapshot.credentialPermissions;
      credentialScopes = snapshot.credentialTenantScopes;
      if (credential.status !== 'active' && credential.status !== 'rotating') return null;
    }
    if (principal.status !== 'active' || !explicit(principalScopes)) return null;
    if (credentialScopes.length > 0 && !explicit(credentialScopes)) return null;
    return {
      principal,
      credential,
      permissions:
        credentialPermissions.length === 0
          ? principalPermissions
          : principalPermissions.filter((permission) =>
              credentialPermissions.some((limit) => hasAdminPermission([limit], permission))
            ),
    };
  }

  /** A principal with its permissions and tenant scopes as of one instant. */
  async loadPrincipalGrantSnapshot(principalId: string): Promise<{
    principal: AdminMachinePrincipal;
    permissions: string[];
    tenantScopes: AdminMachineTenantScope[];
  } | null> {
    const row = await this.adapter.queryOne<
      AdminMachinePrincipalRow & {
        principal_permissions_json: string;
        principal_scopes_json: string;
      }
    >(
      `SELECT
        p.*,
        (SELECT json_group_array(permission) FROM admin_machine_principal_permissions
          WHERE principal_id = p.id) AS principal_permissions_json,
        (SELECT json_group_array(json_object('scope_mode', scope_mode, 'tenant_id', tenant_id))
           FROM admin_machine_principal_tenant_scopes
          WHERE principal_id = p.id) AS principal_scopes_json
       FROM admin_machine_principals p
       WHERE p.id = ?`,
      [principalId]
    );
    if (!row) return null;
    return {
      principal: this.principalFromRow(row),
      permissions: (JSON.parse(row.principal_permissions_json) as string[]).slice().sort(),
      tenantScopes: (
        JSON.parse(row.principal_scopes_json) as Array<{
          scope_mode: AdminMachineTenantScopeMode;
          tenant_id: string | null;
        }>
      ).map((entry) => ({ scopeMode: entry.scope_mode, tenantId: entry.tenant_id })),
    };
  }

  async getPrincipalPermissions(principalId: string): Promise<string[]> {
    const rows = await this.adapter.query<{ permission: string }>(
      `SELECT permission
       FROM admin_machine_principal_permissions
       WHERE principal_id = ?
       ORDER BY permission ASC`,
      [principalId]
    );
    return rows.map((row) => row.permission);
  }

  async getCredentialPermissions(credentialId: string): Promise<string[]> {
    const rows = await this.adapter.query<{ permission: string }>(
      `SELECT permission
       FROM admin_machine_credential_permissions
       WHERE credential_id = ?
       ORDER BY permission ASC`,
      [credentialId]
    );
    return rows.map((row) => row.permission);
  }

  async setPrincipalPermissions(
    principalId: string,
    permissions: string[],
    createdBy?: AdminMachineActorRef
  ): Promise<void> {
    await this.adapter.batch(
      this.grantStatements('principal', principalId, { permissions }, createdBy)
    );
  }

  async setCredentialPermissions(
    credentialId: string,
    permissions: string[],
    createdBy?: AdminMachineActorRef
  ): Promise<void> {
    await this.adapter.batch(
      this.grantStatements('credential', credentialId, { permissions }, createdBy)
    );
  }

  async getPrincipalTenantScopes(principalId: string): Promise<AdminMachineTenantScope[]> {
    const rows = await this.adapter.query<{
      scope_mode: AdminMachineTenantScopeMode;
      tenant_id: string | null;
    }>(
      `SELECT scope_mode, tenant_id
       FROM admin_machine_principal_tenant_scopes
       WHERE principal_id = ?
       ORDER BY scope_mode ASC, tenant_id ASC`,
      [principalId]
    );
    return rows.map((row) => ({ scopeMode: row.scope_mode, tenantId: row.tenant_id }));
  }

  async getCredentialTenantScopes(credentialId: string): Promise<AdminMachineTenantScope[]> {
    const rows = await this.adapter.query<{
      scope_mode: AdminMachineTenantScopeMode;
      tenant_id: string | null;
    }>(
      `SELECT scope_mode, tenant_id
       FROM admin_machine_credential_tenant_scopes
       WHERE credential_id = ?
       ORDER BY scope_mode ASC, tenant_id ASC`,
      [credentialId]
    );
    return rows.map((row) => ({ scopeMode: row.scope_mode, tenantId: row.tenant_id }));
  }

  async setPrincipalTenantScopes(
    principalId: string,
    scopes: AdminMachineTenantScope[],
    createdBy?: AdminMachineActorRef
  ): Promise<void> {
    await this.adapter.batch(
      this.grantStatements('principal', principalId, { tenantScopes: scopes }, createdBy)
    );
  }

  async setCredentialTenantScopes(
    credentialId: string,
    scopes: AdminMachineTenantScope[],
    createdBy?: AdminMachineActorRef
  ): Promise<void> {
    await this.adapter.batch(
      this.grantStatements('credential', credentialId, { tenantScopes: scopes }, createdBy)
    );
  }

  /**
   * The revision of a principal: its row's `updated_at` and status, and its permissions and tenant
   * scopes, read by one statement. Every write through this repository moves `updated_at`, and the
   * sets are part of the value, so a change made any way shows.
   */
  async getPrincipalRevision(id: string): Promise<string | null> {
    const row = await this.adapter.queryOne<{ revision: string | null }>(
      `SELECT ${this.revisionExpression('principal')} AS revision
         FROM admin_machine_principals p WHERE p.id = ?`,
      [id, id, id]
    );
    return row?.revision ?? null;
  }

  /** The same for a credential (its validity window and status count as well). */
  async getCredentialRevision(id: string): Promise<string | null> {
    const row = await this.adapter.queryOne<{ revision: string | null }>(
      `SELECT ${this.revisionExpression('credential')} AS revision
         FROM admin_machine_credentials p WHERE p.id = ?`,
      [id, id, id]
    );
    return row?.revision ?? null;
  }

  private revisionExpression(owner: 'principal' | 'credential'): string {
    const column = owner === 'principal' ? 'principal_id' : 'credential_id';
    const window =
      owner === 'credential'
        ? " || '|' || COALESCE(p.not_before, '') || '|' || COALESCE(p.expires_at, '')"
        : '';
    return `(p.updated_at || '|' || p.status${window} || '|' ||
      COALESCE((SELECT group_concat(permission, char(31)) FROM (
        SELECT permission FROM admin_machine_${owner}_permissions
         WHERE ${column} = ? ORDER BY permission)), '') || '|' ||
      COALESCE((SELECT group_concat(scope_mode || ':' || COALESCE(tenant_id, ''), char(31)) FROM (
        SELECT scope_mode, tenant_id FROM admin_machine_${owner}_tenant_scopes
         WHERE ${column} = ? ORDER BY scope_mode, tenant_id)), ''))`;
  }

  /**
   * Run `statements` as one atomic batch that first checks `guard`. The check is a statement that
   * fails (integer overflow) when the revision is not the one the caller read; D1 runs a batch as
   * one transaction and a failing statement rolls all of it back, so nothing after it is written.
   * The revision is re-read afterwards to tell that failure from any other.
   */
  private async guardedBatch(
    statements: BatchStatement[],
    guard?: AdminMachineWriteGuard
  ): Promise<void> {
    const checks: BatchStatement[] = [];
    for (const [owner, entry] of [
      ['principal', guard?.principal],
      ['credential', guard?.credential],
    ] as const) {
      if (!entry) continue;
      const table =
        owner === 'principal' ? 'admin_machine_principals' : 'admin_machine_credentials';
      checks.push({
        sql: `SELECT CASE WHEN (SELECT ${this.revisionExpression(owner)} FROM ${table} p WHERE p.id = ?) = ?
                THEN 0 ELSE abs(-9223372036854775807 - 1) END AS revision_check`,
        params: [entry.id, entry.id, entry.id, entry.revision],
      });
    }
    if (checks.length === 0) {
      await this.adapter.batch(statements);
      return;
    }
    try {
      await this.adapter.batch([...checks, ...statements]);
    } catch (error) {
      const [principal, credential] = await Promise.all([
        guard?.principal ? this.getPrincipalRevision(guard.principal.id) : null,
        guard?.credential ? this.getCredentialRevision(guard.credential.id) : null,
      ]);
      if (
        (guard?.principal && principal !== guard.principal.revision) ||
        (guard?.credential && credential !== guard.credential.revision)
      ) {
        throw new AdminMachineConflictError();
      }
      throw error;
    }
  }

  /**
   * The statements that replace the permissions and/or tenant scopes of a principal or credential.
   * Run them in one `batch`: D1 applies a batch atomically, whereas a callback transaction does
   * not roll back, so a failure half-way would leave the old scope with the new permissions.
   * Duplicates are removed first; the table keys would refuse them.
   */
  private grantStatements(
    owner: 'principal' | 'credential',
    id: string,
    grant: AdminMachineGrantWrite,
    actor?: AdminMachineActorRef
  ): BatchStatement[] {
    const now = getCurrentTimestamp();
    const column = owner === 'principal' ? 'principal_id' : 'credential_id';
    const statements: BatchStatement[] = [];
    if (grant.permissions !== undefined) {
      const table = `admin_machine_${owner}_permissions`;
      statements.push({ sql: `DELETE FROM ${table} WHERE ${column} = ?`, params: [id] });
      for (const permission of new Set(grant.permissions)) {
        statements.push({
          sql: `INSERT INTO ${table} (
            ${column}, permission, created_at, created_by_actor_type, created_by_actor_id
          ) VALUES (?, ?, ?, ?, ?)`,
          params: [id, permission, now, actor?.actorType ?? null, actor?.actorId ?? null],
        });
      }
    }
    if (grant.tenantScopes !== undefined) {
      const table = `admin_machine_${owner}_tenant_scopes`;
      statements.push({ sql: `DELETE FROM ${table} WHERE ${column} = ?`, params: [id] });
      const seen = new Set<string>();
      for (const scope of grant.tenantScopes) {
        const key = `${scope.scopeMode}\u0000${scope.tenantId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        statements.push({
          sql: `INSERT INTO ${table} (
            ${column}, scope_mode, tenant_id, created_at, created_by_actor_type, created_by_actor_id
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            id,
            scope.scopeMode,
            scope.tenantId,
            now,
            actor?.actorType ?? null,
            actor?.actorId ?? null,
          ],
        });
      }
    }
    return statements;
  }

  async recordAssertionJti(input: {
    clientId: string;
    credentialId: string;
    jti: string;
    expiresAt: number;
  }): Promise<boolean> {
    try {
      await this.adapter.execute(
        `INSERT INTO admin_machine_assertion_jti (
          client_id, credential_id, jti, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [input.clientId, input.credentialId, input.jti, input.expiresAt, getCurrentTimestamp()]
      );
      return true;
    } catch {
      return false;
    }
  }

  async updateCredentialLastUsed(input: {
    credentialId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    const now = getCurrentTimestamp();
    // `updated_at` is the revision that authorization decisions are checked against; a key used
    // at every token request must not move it, or revoking a busy key would keep conflicting.
    await this.adapter.execute(
      `UPDATE admin_machine_credentials
       SET last_used_at = ?, last_used_ip = ?, last_used_user_agent = ?
       WHERE id = ?`,
      [now, input.ipAddress ?? null, input.userAgent ?? null, input.credentialId]
    );
  }

  private principalFromRow(row: AdminMachinePrincipalRow): AdminMachinePrincipal {
    return {
      id: row.id,
      clientId: row.client_id,
      displayName: row.display_name,
      description: row.description,
      principalType: row.principal_type,
      status: row.status,
      defaultAudience: row.default_audience,
      tokenTtlSeconds: row.token_ttl_seconds,
      createdByActorType: row.created_by_actor_type,
      createdByActorId: row.created_by_actor_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      disabledAt: row.disabled_at,
      disabledByActorType: row.disabled_by_actor_type,
      disabledByActorId: row.disabled_by_actor_id,
    };
  }

  private credentialFromRow(row: AdminMachineCredentialRow): AdminMachineCredential {
    return {
      id: row.id,
      principalId: row.principal_id,
      kid: row.kid,
      publicJwkJson: row.public_jwk_json,
      alg: row.alg,
      displayName: row.display_name,
      description: row.description,
      status: row.status,
      notBefore: row.not_before,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      lastUsedIp: row.last_used_ip,
      lastUsedUserAgent: row.last_used_user_agent,
      createdByActorType: row.created_by_actor_type,
      createdByActorId: row.created_by_actor_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
      revokedByActorType: row.revoked_by_actor_type,
      revokedByActorId: row.revoked_by_actor_id,
      revokeReason: row.revoke_reason,
    };
  }

  private credentialFromJoinedRow(row: AdminMachineClientCredentialRow): AdminMachineCredential {
    return this.credentialFromRow({
      id: row.credential_id,
      principal_id: row.credential_principal_id,
      kid: row.credential_kid,
      public_jwk_json: row.credential_public_jwk_json,
      alg: row.credential_alg,
      display_name: row.credential_display_name,
      description: row.credential_description,
      status: row.credential_status,
      not_before: row.credential_not_before,
      expires_at: row.credential_expires_at,
      last_used_at: row.credential_last_used_at,
      last_used_ip: row.credential_last_used_ip,
      last_used_user_agent: row.credential_last_used_user_agent,
      created_by_actor_type: row.credential_created_by_actor_type,
      created_by_actor_id: row.credential_created_by_actor_id,
      created_at: row.credential_created_at,
      updated_at: row.credential_updated_at,
      revoked_at: row.credential_revoked_at,
      revoked_by_actor_type: row.credential_revoked_by_actor_type,
      revoked_by_actor_id: row.credential_revoked_by_actor_id,
      revoke_reason: row.credential_revoke_reason,
    });
  }
}
