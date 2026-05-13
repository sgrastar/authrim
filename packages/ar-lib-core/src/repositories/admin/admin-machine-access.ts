/**
 * Admin Machine Access Repository
 *
 * Repository for scoped machine principals and credentials stored in DB_ADMIN.
 */

import type { DatabaseAdapter } from '../../db/adapter';
import { generateId, getCurrentTimestamp } from '../base';

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

  async createPrincipal(
    input: AdminMachinePrincipalCreateInput
  ): Promise<AdminMachinePrincipal> {
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

    await this.adapter.execute(
      `INSERT INTO admin_machine_principals (
        id, client_id, display_name, description, principal_type, status,
        default_audience, token_ttl_seconds, created_by_actor_type, created_by_actor_id,
        created_at, updated_at, disabled_at, disabled_by_actor_type, disabled_by_actor_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ]
    );

    return this.principalFromRow(row);
  }

  async createCredential(
    input: AdminMachineCredentialCreateInput
  ): Promise<AdminMachineCredential> {
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

    await this.adapter.execute(
      `INSERT INTO admin_machine_credentials (
        id, principal_id, kid, public_jwk_json, alg, display_name, description, status,
        not_before, expires_at, last_used_at, last_used_ip, last_used_user_agent,
        created_by_actor_type, created_by_actor_id, created_at, updated_at, revoked_at,
        revoked_by_actor_type, revoked_by_actor_id, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ]
    );

    return this.credentialFromRow(row);
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
    input: AdminMachinePrincipalUpdateInput
  ): Promise<AdminMachinePrincipal | null> {
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
      return this.findPrincipalById(id);
    }

    updates.push('updated_at = ?');
    params.push(now, id);
    await this.adapter.execute(
      `UPDATE admin_machine_principals SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    return this.findPrincipalById(id);
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
    input: AdminMachineCredentialUpdateInput
  ): Promise<AdminMachineCredential | null> {
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
      return this.findCredentialById(id);
    }

    updates.push('updated_at = ?');
    params.push(now, id);
    await this.adapter.execute(
      `UPDATE admin_machine_credentials SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    return this.findCredentialById(id);
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
    const now = getCurrentTimestamp();
    await this.adapter.transaction(async (tx) => {
      await tx.execute('DELETE FROM admin_machine_principal_permissions WHERE principal_id = ?', [
        principalId,
      ]);
      for (const permission of permissions) {
        await tx.execute(
          `INSERT INTO admin_machine_principal_permissions (
            principal_id, permission, created_at, created_by_actor_type, created_by_actor_id
          ) VALUES (?, ?, ?, ?, ?)`,
          [principalId, permission, now, createdBy?.actorType ?? null, createdBy?.actorId ?? null]
        );
      }
    });
  }

  async setCredentialPermissions(
    credentialId: string,
    permissions: string[],
    createdBy?: AdminMachineActorRef
  ): Promise<void> {
    const now = getCurrentTimestamp();
    await this.adapter.transaction(async (tx) => {
      await tx.execute('DELETE FROM admin_machine_credential_permissions WHERE credential_id = ?', [
        credentialId,
      ]);
      for (const permission of permissions) {
        await tx.execute(
          `INSERT INTO admin_machine_credential_permissions (
            credential_id, permission, created_at, created_by_actor_type, created_by_actor_id
          ) VALUES (?, ?, ?, ?, ?)`,
          [credentialId, permission, now, createdBy?.actorType ?? null, createdBy?.actorId ?? null]
        );
      }
    });
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
    const now = getCurrentTimestamp();
    await this.adapter.transaction(async (tx) => {
      await tx.execute('DELETE FROM admin_machine_principal_tenant_scopes WHERE principal_id = ?', [
        principalId,
      ]);
      for (const scope of scopes) {
        await tx.execute(
          `INSERT INTO admin_machine_principal_tenant_scopes (
            principal_id, scope_mode, tenant_id, created_at, created_by_actor_type, created_by_actor_id
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            principalId,
            scope.scopeMode,
            scope.tenantId,
            now,
            createdBy?.actorType ?? null,
            createdBy?.actorId ?? null,
          ]
        );
      }
    });
  }

  async setCredentialTenantScopes(
    credentialId: string,
    scopes: AdminMachineTenantScope[],
    createdBy?: AdminMachineActorRef
  ): Promise<void> {
    const now = getCurrentTimestamp();
    await this.adapter.transaction(async (tx) => {
      await tx.execute('DELETE FROM admin_machine_credential_tenant_scopes WHERE credential_id = ?', [
        credentialId,
      ]);
      for (const scope of scopes) {
        await tx.execute(
          `INSERT INTO admin_machine_credential_tenant_scopes (
            credential_id, scope_mode, tenant_id, created_at, created_by_actor_type, created_by_actor_id
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            credentialId,
            scope.scopeMode,
            scope.tenantId,
            now,
            createdBy?.actorType ?? null,
            createdBy?.actorId ?? null,
          ]
        );
      }
    });
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
    await this.adapter.execute(
      `UPDATE admin_machine_credentials
       SET last_used_at = ?, last_used_ip = ?, last_used_user_agent = ?, updated_at = ?
       WHERE id = ?`,
      [now, input.ipAddress ?? null, input.userAgent ?? null, now, input.credentialId]
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

  private credentialFromJoinedRow(
    row: AdminMachineClientCredentialRow
  ): AdminMachineCredential {
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
