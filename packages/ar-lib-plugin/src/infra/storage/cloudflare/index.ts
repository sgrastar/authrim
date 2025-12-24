/**
 * Cloudflare Storage Infrastructure Implementation
 *
 * Wraps ar-lib-core storage components to provide IStorageInfra interface.
 * This is the production implementation for Cloudflare Workers.
 */

import type {
  IStorageInfra,
  IStorageAdapter,
  IUserStore,
  IClientStore,
  ISessionStore,
  IPasskeyStore,
  IOrganizationStore,
  IRoleStore,
  IRoleAssignmentStore,
  IRelationshipStore,
  User,
  OAuthClient,
  Session,
  Passkey,
  Organization,
  Role,
  RoleAssignment,
  Relationship,
  InfraEnv,
  InfraHealthStatus,
  ExecuteResult,
  TransactionContext,
} from '../../types';

// =============================================================================
// Cloudflare Storage Infrastructure
// =============================================================================

export class CloudflareStorageInfra implements IStorageInfra {
  readonly provider = 'cloudflare' as const;

  private _adapter: CloudflareStorageAdapter | null = null;
  private _user: IUserStore | null = null;
  private _client: IClientStore | null = null;
  private _session: ISessionStore | null = null;
  private _passkey: IPasskeyStore | null = null;
  private _organization: IOrganizationStore | null = null;
  private _role: IRoleStore | null = null;
  private _roleAssignment: IRoleAssignmentStore | null = null;
  private _relationship: IRelationshipStore | null = null;
  private initialized = false;

  get adapter(): IStorageAdapter {
    this.ensureInitialized();
    return this._adapter!;
  }

  get user(): IUserStore {
    this.ensureInitialized();
    return this._user!;
  }

  get client(): IClientStore {
    this.ensureInitialized();
    return this._client!;
  }

  get session(): ISessionStore {
    this.ensureInitialized();
    return this._session!;
  }

  get passkey(): IPasskeyStore {
    this.ensureInitialized();
    return this._passkey!;
  }

  get organization(): IOrganizationStore {
    this.ensureInitialized();
    return this._organization!;
  }

  get role(): IRoleStore {
    this.ensureInitialized();
    return this._role!;
  }

  get roleAssignment(): IRoleAssignmentStore {
    this.ensureInitialized();
    return this._roleAssignment!;
  }

  get relationship(): IRelationshipStore {
    this.ensureInitialized();
    return this._relationship!;
  }

  async initialize(env: InfraEnv): Promise<void> {
    if (this.initialized) return;

    if (!env.DB) {
      throw new Error('CloudflareStorageInfra: DB (D1 Database) binding is required');
    }

    this._adapter = new CloudflareStorageAdapter(env);
    this._user = createUserStore(this._adapter);
    this._client = createClientStore(this._adapter);
    this._session = createSessionStore(this._adapter, env);
    this._passkey = createPasskeyStore(this._adapter);
    this._organization = createOrganizationStore(this._adapter);
    this._role = createRoleStore(this._adapter);
    this._roleAssignment = createRoleAssignmentStore(this._adapter);
    this._relationship = createRelationshipStore(this._adapter);

    this.initialized = true;
  }

  async healthCheck(): Promise<InfraHealthStatus> {
    if (!this.initialized) {
      return { status: 'unhealthy', provider: 'cloudflare', message: 'Not initialized' };
    }

    const startTime = Date.now();
    try {
      await this._adapter!.queryOne<{ result: number }>('SELECT 1 as result');
      return {
        status: 'healthy',
        provider: 'cloudflare',
        latencyMs: Date.now() - startTime,
        message: 'D1 database is responding',
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        provider: 'cloudflare',
        latencyMs: Date.now() - startTime,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('CloudflareStorageInfra: Not initialized. Call initialize() first.');
    }
  }
}

// =============================================================================
// Cloudflare Storage Adapter
// =============================================================================

export class CloudflareStorageAdapter implements IStorageAdapter {
  private db: D1Database;
  private kv?: KVNamespace;

  constructor(env: InfraEnv) {
    this.db = env.DB!;
    this.kv = env.AUTHRIM_CONFIG;
  }

  async get(key: string): Promise<string | null> {
    return this.kv ? this.kv.get(key) : null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (this.kv) {
      await this.kv.put(key, value, ttl ? { expirationTtl: ttl } : undefined);
    }
  }

  async delete(key: string): Promise<void> {
    if (this.kv) await this.kv.delete(key);
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const result = params?.length ? await stmt.bind(...params).all<T>() : await stmt.all<T>();
    return result.results;
  }

  async queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    return params?.length ? stmt.bind(...params).first<T>() : stmt.first<T>();
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const stmt = this.db.prepare(sql);
    const result = params?.length ? await stmt.bind(...params).run() : await stmt.run();
    return {
      success: result.success,
      rowsAffected: result.meta.changes,
      lastRowId: result.meta.last_row_id,
    };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      query: this.query.bind(this),
      queryOne: this.queryOne.bind(this),
      execute: this.execute.bind(this),
    });
  }
}

// =============================================================================
// Store Factory Functions
// =============================================================================

function createUserStore(adapter: IStorageAdapter): IUserStore {
  return {
    async get(userId: string): Promise<User | null> {
      return adapter.queryOne<User>('SELECT * FROM users WHERE id = ?', [userId]);
    },

    async getByEmail(email: string): Promise<User | null> {
      return adapter.queryOne<User>('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);
    },

    async create(user: Partial<User>): Promise<User> {
      const id = crypto.randomUUID();
      const now = Date.now();
      await adapter.execute(
        `INSERT INTO users (id, email, email_verified, name, given_name, family_name,
         picture, phone_number, phone_number_verified, mfa_enabled, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          user.email,
          user.email_verified ? 1 : 0,
          user.name ?? null,
          user.given_name ?? null,
          user.family_name ?? null,
          user.picture ?? null,
          user.phone_number ?? null,
          user.phone_number_verified ? 1 : 0,
          user.mfa_enabled ? 1 : 0,
          user.is_active !== false ? 1 : 0,
          now,
          now,
        ]
      );
      return { ...user, id, created_at: now, updated_at: now } as User;
    },

    async update(userId: string, updates: Partial<User>): Promise<User> {
      const entries = Object.entries(updates).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        const existing = await this.get(userId);
        if (!existing) throw new Error('User not found');
        return existing;
      }

      const setClauses = entries.map(([k]) => `${k} = ?`).concat('updated_at = ?');
      const values = entries.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : v));
      values.push(Date.now(), userId);

      await adapter.execute(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`, values);
      const updated = await this.get(userId);
      if (!updated) throw new Error('User not found after update');
      return updated;
    },

    async delete(userId: string): Promise<void> {
      await adapter.execute('DELETE FROM users WHERE id = ?', [userId]);
    },
  };
}

function createClientStore(adapter: IStorageAdapter): IClientStore {
  const parseClient = (row: Record<string, unknown>): OAuthClient => ({
    client_id: row.client_id as string,
    client_secret: row.client_secret as string | undefined,
    client_name: row.client_name as string | undefined,
    redirect_uris: JSON.parse((row.redirect_uris as string) || '[]') as string[],
    grant_types: JSON.parse((row.grant_types as string) || '[]') as string[],
    response_types: JSON.parse((row.response_types as string) || '[]') as string[],
    scope: row.scope as string | undefined,
    subject_type: (row.subject_type as 'public' | 'pairwise') ?? 'public',
    jwks: row.jwks ? JSON.parse(row.jwks as string) : undefined,
    jwks_uri: row.jwks_uri as string | undefined,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  });

  return {
    async get(clientId: string): Promise<OAuthClient | null> {
      const row = await adapter.queryOne<Record<string, unknown>>(
        'SELECT * FROM oauth_clients WHERE client_id = ?',
        [clientId]
      );
      return row ? parseClient(row) : null;
    },

    async create(client: Partial<OAuthClient>): Promise<OAuthClient> {
      const now = Date.now();
      const clientId = client.client_id ?? crypto.randomUUID();
      await adapter.execute(
        `INSERT INTO oauth_clients (client_id, client_secret, client_name, redirect_uris,
         grant_types, response_types, scope, subject_type, jwks, jwks_uri, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          clientId,
          client.client_secret ?? null,
          client.client_name ?? null,
          JSON.stringify(client.redirect_uris ?? []),
          JSON.stringify(client.grant_types ?? []),
          JSON.stringify(client.response_types ?? []),
          client.scope ?? null,
          client.subject_type ?? 'public',
          client.jwks ? JSON.stringify(client.jwks) : null,
          client.jwks_uri ?? null,
          now,
          now,
        ]
      );
      return {
        ...client,
        client_id: clientId,
        redirect_uris: client.redirect_uris ?? [],
        grant_types: client.grant_types ?? [],
        response_types: client.response_types ?? [],
        created_at: now,
        updated_at: now,
      } as OAuthClient;
    },

    async update(clientId: string, updates: Partial<OAuthClient>): Promise<OAuthClient> {
      const existing = await this.get(clientId);
      if (!existing) throw new Error('Client not found');
      const merged = { ...existing, ...updates, updated_at: Date.now() };
      await adapter.execute(
        `UPDATE oauth_clients SET client_name = ?, redirect_uris = ?, grant_types = ?,
         response_types = ?, scope = ?, subject_type = ?, jwks = ?, jwks_uri = ?, updated_at = ?
         WHERE client_id = ?`,
        [
          merged.client_name ?? null,
          JSON.stringify(merged.redirect_uris),
          JSON.stringify(merged.grant_types),
          JSON.stringify(merged.response_types),
          merged.scope ?? null,
          merged.subject_type ?? 'public',
          merged.jwks ? JSON.stringify(merged.jwks) : null,
          merged.jwks_uri ?? null,
          merged.updated_at,
          clientId,
        ]
      );
      return merged;
    },

    async delete(clientId: string): Promise<void> {
      await adapter.execute('DELETE FROM oauth_clients WHERE client_id = ?', [clientId]);
    },

    async list(options?: { limit?: number; offset?: number }): Promise<OAuthClient[]> {
      const rows = await adapter.query<Record<string, unknown>>(
        'SELECT * FROM oauth_clients ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [options?.limit ?? 100, options?.offset ?? 0]
      );
      return rows.map(parseClient);
    },
  };
}

function createSessionStore(adapter: IStorageAdapter, env: InfraEnv): ISessionStore {
  return {
    async get(sessionId: string): Promise<Session | null> {
      if (env.SESSION_STORE) {
        try {
          const id = env.SESSION_STORE.idFromName(sessionId);
          const stub = env.SESSION_STORE.get(id);
          const response = await stub.fetch(new Request('http://internal/get'));
          if (response.ok) {
            const data = await response.json();
            if (data) return data as Session;
          }
        } catch {
          /* fall through */
        }
      }
      return adapter.queryOne<Session>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
    },

    async create(session: Partial<Session>): Promise<Session> {
      const id = session.id ?? crypto.randomUUID();
      const now = Date.now();
      const full: Session = {
        id,
        user_id: session.user_id!,
        created_at: now,
        expires_at: session.expires_at ?? now + 3600000,
        last_activity_at: now,
        user_agent: session.user_agent,
        ip_address: session.ip_address,
        amr: session.amr,
        acr: session.acr,
        data: session.data,
      };
      await adapter.execute(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_activity_at,
         user_agent, ip_address, amr, acr, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          full.id,
          full.user_id,
          full.created_at,
          full.expires_at,
          full.last_activity_at,
          full.user_agent ?? null,
          full.ip_address ?? null,
          full.amr ? JSON.stringify(full.amr) : null,
          full.acr ?? null,
          full.data ? JSON.stringify(full.data) : null,
        ]
      );
      return full;
    },

    async update(sessionId: string, updates: Partial<Session>): Promise<Session> {
      const existing = await this.get(sessionId);
      if (!existing) throw new Error('Session not found');
      const merged = { ...existing, ...updates };
      await adapter.execute(
        `UPDATE sessions SET last_activity_at = ?, expires_at = ?, data = ? WHERE id = ?`,
        [
          merged.last_activity_at,
          merged.expires_at,
          merged.data ? JSON.stringify(merged.data) : null,
          sessionId,
        ]
      );
      return merged;
    },

    async delete(sessionId: string): Promise<void> {
      await adapter.execute('DELETE FROM sessions WHERE id = ?', [sessionId]);
    },

    async deleteAllForUser(userId: string): Promise<void> {
      await adapter.execute('DELETE FROM sessions WHERE user_id = ?', [userId]);
    },

    async listByUser(userId: string): Promise<Session[]> {
      return adapter.query<Session>(
        'SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
    },

    async extend(sessionId: string, additionalSeconds: number): Promise<Session | null> {
      const session = await this.get(sessionId);
      if (!session) return null;
      return this.update(sessionId, { expires_at: session.expires_at + additionalSeconds * 1000 });
    },
  };
}

function createPasskeyStore(adapter: IStorageAdapter): IPasskeyStore {
  return {
    async getByCredentialId(credentialId: string): Promise<Passkey | null> {
      return adapter.queryOne<Passkey>('SELECT * FROM passkeys WHERE credential_id = ?', [
        credentialId,
      ]);
    },

    async listByUser(userId: string): Promise<Passkey[]> {
      return adapter.query<Passkey>(
        'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
    },

    async create(passkey: Partial<Passkey>): Promise<Passkey> {
      const id = crypto.randomUUID();
      const now = Date.now();
      await adapter.execute(
        `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          passkey.user_id!,
          passkey.credential_id!,
          passkey.public_key!,
          passkey.counter ?? 0,
          passkey.transports ? JSON.stringify(passkey.transports) : null,
          passkey.device_name ?? null,
          now,
        ]
      );
      return { ...passkey, id, created_at: now } as Passkey;
    },

    async updateCounter(passkeyId: string, counter: number): Promise<Passkey> {
      const now = Date.now();
      await adapter.execute('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', [
        counter,
        now,
        passkeyId,
      ]);
      const updated = await adapter.queryOne<Passkey>('SELECT * FROM passkeys WHERE id = ?', [
        passkeyId,
      ]);
      if (!updated) throw new Error('Passkey not found after update');
      return updated;
    },

    async delete(passkeyId: string): Promise<void> {
      await adapter.execute('DELETE FROM passkeys WHERE id = ?', [passkeyId]);
    },
  };
}

function createOrganizationStore(adapter: IStorageAdapter): IOrganizationStore {
  return {
    async get(orgId: string): Promise<Organization | null> {
      return adapter.queryOne<Organization>('SELECT * FROM organizations WHERE id = ?', [orgId]);
    },

    async getByName(tenantId: string, name: string): Promise<Organization | null> {
      return adapter.queryOne<Organization>(
        'SELECT * FROM organizations WHERE tenant_id = ? AND name = ?',
        [tenantId, name]
      );
    },

    async create(org: Partial<Organization>): Promise<Organization> {
      const id = crypto.randomUUID();
      const now = Date.now();
      await adapter.execute(
        `INSERT INTO organizations (id, tenant_id, name, display_name, parent_org_id, metadata, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          org.tenant_id!,
          org.name!,
          org.display_name ?? null,
          org.parent_org_id ?? null,
          org.metadata ? JSON.stringify(org.metadata) : null,
          org.is_active !== false ? 1 : 0,
          now,
          now,
        ]
      );
      return {
        ...org,
        id,
        is_active: org.is_active !== false,
        created_at: now,
        updated_at: now,
      } as Organization;
    },

    async update(orgId: string, updates: Partial<Organization>): Promise<Organization> {
      const existing = await this.get(orgId);
      if (!existing) throw new Error('Organization not found');
      const merged = { ...existing, ...updates, updated_at: Date.now() };
      await adapter.execute(
        `UPDATE organizations SET name = ?, display_name = ?, parent_org_id = ?, metadata = ?, is_active = ?, updated_at = ? WHERE id = ?`,
        [
          merged.name,
          merged.display_name ?? null,
          merged.parent_org_id ?? null,
          merged.metadata ? JSON.stringify(merged.metadata) : null,
          merged.is_active ? 1 : 0,
          merged.updated_at,
          orgId,
        ]
      );
      return merged;
    },

    async delete(orgId: string): Promise<void> {
      await adapter.execute('DELETE FROM organizations WHERE id = ?', [orgId]);
    },

    async list(
      tenantId: string,
      options?: { limit?: number; offset?: number }
    ): Promise<Organization[]> {
      return adapter.query<Organization>(
        'SELECT * FROM organizations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [tenantId, options?.limit ?? 100, options?.offset ?? 0]
      );
    },
  };
}

function createRoleStore(adapter: IStorageAdapter): IRoleStore {
  return {
    async get(roleId: string): Promise<Role | null> {
      return adapter.queryOne<Role>('SELECT * FROM roles WHERE id = ?', [roleId]);
    },

    async getByName(tenantId: string, name: string): Promise<Role | null> {
      return adapter.queryOne<Role>('SELECT * FROM roles WHERE tenant_id = ? AND name = ?', [
        tenantId,
        name,
      ]);
    },

    async create(role: Partial<Role>): Promise<Role> {
      const id = crypto.randomUUID();
      const now = Date.now();
      await adapter.execute(
        `INSERT INTO roles (id, tenant_id, name, display_name, description, permissions, parent_role_id, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          role.tenant_id!,
          role.name!,
          role.display_name ?? null,
          role.description ?? null,
          role.permissions ? JSON.stringify(role.permissions) : null,
          role.parent_role_id ?? null,
          role.is_active !== false ? 1 : 0,
          now,
        ]
      );
      return { ...role, id, is_active: role.is_active !== false, created_at: now } as Role;
    },

    async update(roleId: string, updates: Partial<Role>): Promise<Role> {
      const existing = await this.get(roleId);
      if (!existing) throw new Error('Role not found');
      const merged = { ...existing, ...updates };
      await adapter.execute(
        `UPDATE roles SET name = ?, display_name = ?, description = ?, permissions = ?, parent_role_id = ?, is_active = ? WHERE id = ?`,
        [
          merged.name,
          merged.display_name ?? null,
          merged.description ?? null,
          merged.permissions ? JSON.stringify(merged.permissions) : null,
          merged.parent_role_id ?? null,
          merged.is_active ? 1 : 0,
          roleId,
        ]
      );
      return merged;
    },

    async delete(roleId: string): Promise<void> {
      await adapter.execute('DELETE FROM roles WHERE id = ?', [roleId]);
    },

    async list(tenantId: string, options?: { limit?: number; offset?: number }): Promise<Role[]> {
      return adapter.query<Role>(
        'SELECT * FROM roles WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [tenantId, options?.limit ?? 100, options?.offset ?? 0]
      );
    },
  };
}

function createRoleAssignmentStore(adapter: IStorageAdapter): IRoleAssignmentStore {
  return {
    async get(assignmentId: string): Promise<RoleAssignment | null> {
      return adapter.queryOne<RoleAssignment>('SELECT * FROM role_assignments WHERE id = ?', [
        assignmentId,
      ]);
    },

    async create(assignment: Partial<RoleAssignment>): Promise<RoleAssignment> {
      const id = crypto.randomUUID();
      const now = Date.now();
      await adapter.execute(
        `INSERT INTO role_assignments (id, subject_id, role_id, scope_type, scope_target, granted_by, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          assignment.subject_id!,
          assignment.role_id!,
          assignment.scope_type ?? 'global',
          assignment.scope_target ?? null,
          assignment.granted_by ?? null,
          assignment.expires_at ?? null,
          now,
          now,
        ]
      );
      return { ...assignment, id, created_at: now, updated_at: now } as RoleAssignment;
    },

    async update(assignmentId: string, updates: Partial<RoleAssignment>): Promise<RoleAssignment> {
      const existing = await this.get(assignmentId);
      if (!existing) throw new Error('Role assignment not found');
      const merged = { ...existing, ...updates, updated_at: Date.now() };
      await adapter.execute(
        `UPDATE role_assignments SET scope_type = ?, scope_target = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
        [
          merged.scope_type,
          merged.scope_target ?? null,
          merged.expires_at ?? null,
          merged.updated_at,
          assignmentId,
        ]
      );
      return merged;
    },

    async delete(assignmentId: string): Promise<void> {
      await adapter.execute('DELETE FROM role_assignments WHERE id = ?', [assignmentId]);
    },

    async listBySubject(subjectId: string): Promise<RoleAssignment[]> {
      return adapter.query<RoleAssignment>(
        'SELECT * FROM role_assignments WHERE subject_id = ? ORDER BY created_at DESC',
        [subjectId]
      );
    },

    async listByRole(roleId: string): Promise<RoleAssignment[]> {
      return adapter.query<RoleAssignment>(
        'SELECT * FROM role_assignments WHERE role_id = ? ORDER BY created_at DESC',
        [roleId]
      );
    },

    async getEffectiveRoles(subjectId: string): Promise<string[]> {
      const assignments = await adapter.query<{ role_id: string }>(
        `SELECT DISTINCT role_id FROM role_assignments WHERE subject_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
        [subjectId, Date.now()]
      );
      return assignments.map((a) => a.role_id);
    },

    async hasRole(subjectId: string, roleName: string): Promise<boolean> {
      const result = await adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM role_assignments ra JOIN roles r ON ra.role_id = r.id
         WHERE ra.subject_id = ? AND r.name = ? AND (ra.expires_at IS NULL OR ra.expires_at > ?)`,
        [subjectId, roleName, Date.now()]
      );
      return (result?.count ?? 0) > 0;
    },
  };
}

function createRelationshipStore(adapter: IStorageAdapter): IRelationshipStore {
  return {
    async get(relationshipId: string): Promise<Relationship | null> {
      return adapter.queryOne<Relationship>('SELECT * FROM relationships WHERE id = ?', [
        relationshipId,
      ]);
    },

    async create(relationship: Partial<Relationship>): Promise<Relationship> {
      const id = crypto.randomUUID();
      const now = Date.now();
      await adapter.execute(
        `INSERT INTO relationships (id, from_type, from_id, to_type, to_id, relationship_type, metadata, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          relationship.from_type!,
          relationship.from_id!,
          relationship.to_type!,
          relationship.to_id!,
          relationship.relationship_type!,
          relationship.metadata ? JSON.stringify(relationship.metadata) : null,
          relationship.expires_at ?? null,
          now,
          now,
        ]
      );
      return { ...relationship, id, created_at: now, updated_at: now } as Relationship;
    },

    async update(relationshipId: string, updates: Partial<Relationship>): Promise<Relationship> {
      const existing = await this.get(relationshipId);
      if (!existing) throw new Error('Relationship not found');
      const merged = { ...existing, ...updates, updated_at: Date.now() };
      await adapter.execute(
        `UPDATE relationships SET metadata = ?, expires_at = ?, updated_at = ? WHERE id = ?`,
        [
          merged.metadata ? JSON.stringify(merged.metadata) : null,
          merged.expires_at ?? null,
          merged.updated_at,
          relationshipId,
        ]
      );
      return merged;
    },

    async delete(relationshipId: string): Promise<void> {
      await adapter.execute('DELETE FROM relationships WHERE id = ?', [relationshipId]);
    },

    async listFrom(fromType: string, fromId: string): Promise<Relationship[]> {
      return adapter.query<Relationship>(
        'SELECT * FROM relationships WHERE from_type = ? AND from_id = ? ORDER BY created_at DESC',
        [fromType, fromId]
      );
    },

    async listTo(toType: string, toId: string): Promise<Relationship[]> {
      return adapter.query<Relationship>(
        'SELECT * FROM relationships WHERE to_type = ? AND to_id = ? ORDER BY created_at DESC',
        [toType, toId]
      );
    },

    async find(
      fromType: string,
      fromId: string,
      toType: string,
      toId: string,
      relationshipType: string
    ): Promise<Relationship | null> {
      return adapter.queryOne<Relationship>(
        `SELECT * FROM relationships WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND relationship_type = ?`,
        [fromType, fromId, toType, toId, relationshipType]
      );
    },
  };
}
