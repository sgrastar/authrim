import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAgentBulkPlan } from '../bulk';
import { canonicalizeJson, sha256Base64Url } from '../canonical-json';
import {
  AdminAgentAccessRepository,
  AgentConfigurationRepository,
  AgentBaselineRepository,
  AgentBulkRepository,
} from '../repositories';

function findSqlite3(): string | null {
  try {
    return execFileSync('which', ['sqlite3'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite SQLite parameter');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  return sqlLiteral(JSON.stringify(value));
}

function bindSql(sql: string, params: unknown[] = []): string {
  let index = 0;
  const bound = sql.replaceAll('?', () => {
    if (index >= params.length) throw new TypeError('Missing SQLite parameter');
    return sqlLiteral(params[index++]);
  });
  if (index !== params.length) throw new TypeError('Unused SQLite parameter');
  return bound;
}

class SqliteCliAdapter implements DatabaseAdapter {
  constructor(
    private readonly sqlite3Path: string,
    private readonly databasePath: string
  ) {}

  private runJson<T>(sql: string): T[] {
    const output = execFileSync(this.sqlite3Path, ['-json', this.databasePath, sql], {
      encoding: 'utf8',
    }).trim();
    return output ? (JSON.parse(output) as T[]) : [];
  }

  query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    return Promise.resolve(this.runJson<T>(bindSql(sql, params)));
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    return (await this.query<T>(sql, params))[0] ?? null;
  }

  execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const rows = this.runJson<{ rowsAffected: number }>(
      `${bindSql(sql, params)}; SELECT changes() AS rowsAffected;`
    );
    return Promise.resolve({
      rowsAffected: rows.at(-1)?.rowsAffected ?? 0,
      success: true,
    });
  }

  transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      query: (sql, params) => this.query(sql, params),
      queryOne: (sql, params) => this.queryOne(sql, params),
      execute: (sql, params) => this.execute(sql, params),
    });
  }

  batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    if (statements.length === 0) return Promise.resolve([]);
    const script = [
      'BEGIN IMMEDIATE;',
      'CREATE TEMP TABLE _agent_batch_results (position INTEGER, rows_affected INTEGER);',
      ...statements.flatMap((statement, position) => [
        `${bindSql(statement.sql, statement.params)};`,
        `INSERT INTO _agent_batch_results VALUES (${position}, changes());`,
      ]),
      'COMMIT;',
      'SELECT rows_affected AS rowsAffected FROM _agent_batch_results ORDER BY position;',
    ].join('\n');
    const execution = spawnSync(this.sqlite3Path, ['-json', '-bail', this.databasePath, script], {
      encoding: 'utf8',
    });
    if (execution.error) throw execution.error;
    if (execution.status !== 0 || execution.stderr.trim().length > 0) {
      throw new Error(execution.stderr.trim() || `sqlite3 exited with ${execution.status}`);
    }
    const output = execution.stdout.trim();
    const rows = output ? (JSON.parse(output) as Array<{ rowsAffected: number }>) : [];
    return Promise.resolve(rows.map((row) => ({ rowsAffected: row.rowsAffected, success: true })));
  }

  isHealthy(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, latencyMs: 0, type: 'sqlite-cli' });
  }

  getType(): string {
    return 'sqlite-cli';
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const sqlite3Path = findSqlite3();
const describeWithSqlite = sqlite3Path ? describe : describe.skip;

describeWithSqlite('AdminAgentAccessRepository SQLite fences', () => {
  let temporaryDirectory: string;
  let adapter: SqliteCliAdapter;
  let repository: AdminAgentAccessRepository;
  let configurationRepository: AgentConfigurationRepository;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'authrim-agent-access-'));
    const databasePath = path.join(temporaryDirectory, 'test.db');
    adapter = new SqliteCliAdapter(sqlite3Path!, databasePath);
    repository = new AdminAgentAccessRepository(adapter);
    configurationRepository = new AgentConfigurationRepository(adapter);
    execFileSync(
      sqlite3Path!,
      [
        databasePath,
        `CREATE TABLE admin_agent_grants (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, client_id TEXT NOT NULL,
          machine_principal_id TEXT, grantor_id TEXT NOT NULL DEFAULT 'grantor-1',
          delegator_id TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '[]',
          scopes TEXT NOT NULL DEFAULT '[]', authorization_details TEXT,
          resolved_scope_constraints TEXT NOT NULL DEFAULT '{"tenantIds":["tenant-1"]}',
          task_set_id TEXT, task_set_version INTEGER, scope_policy_id TEXT,
          scope_policy_version INTEGER, resolved_tools TEXT, access_snapshot_hash TEXT,
          purpose TEXT, delegation_mode TEXT NOT NULL DEFAULT 'user_consent',
          management_mode TEXT NOT NULL DEFAULT 'managed',
          generation INTEGER NOT NULL,
          consent_version INTEGER NOT NULL, status TEXT NOT NULL, expires_at INTEGER,
          active_uniqueness_key TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER, created_at INTEGER NOT NULL DEFAULT 0,
          revoked_at INTEGER, revoked_by TEXT, last_mutation_id TEXT,
          UNIQUE (tenant_id, delegator_id, client_id, active_uniqueness_key)
        );
        CREATE TABLE agent_consents (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, consent_type TEXT NOT NULL,
          grant_id TEXT NOT NULL, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
          consent_version INTEGER NOT NULL, scopes TEXT, granted_at INTEGER,
          revoked_at INTEGER, revoked_reason TEXT, last_mutation_id TEXT,
          UNIQUE (grant_id, client_id, consent_type)
        );
        CREATE TABLE admin_agent_token_families (
          family_id TEXT PRIMARY KEY, family_jti TEXT NOT NULL UNIQUE,
          tenant_id TEXT NOT NULL, grant_id TEXT NOT NULL, grant_generation INTEGER NOT NULL,
          admin_user_id TEXT NOT NULL, client_id TEXT NOT NULL,
          consent_version INTEGER NOT NULL, status TEXT NOT NULL,
          finalization_nonce TEXT NOT NULL, finalized_at INTEGER, expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revocation_outbox_id TEXT
        );
        CREATE TABLE admin_agent_token_revocation_outbox (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, grant_id TEXT,
          grant_generation INTEGER, client_id TEXT NOT NULL, event_type TEXT NOT NULL,
          payload TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL,
          processing_fence INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
          processing_owner_id TEXT, processing_lease_expires_at INTEGER,
          created_at INTEGER NOT NULL, completed_at INTEGER,
          completion_transition_id TEXT, failure_transition_id TEXT
        );
        CREATE TABLE agent_task_sets (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
          description TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
          current_version INTEGER NOT NULL, management_mode TEXT NOT NULL DEFAULT 'managed',
          created_by TEXT NOT NULL,
          last_transition_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(tenant_id, name)
        );
        CREATE TABLE agent_task_set_versions (
          task_set_id TEXT NOT NULL, version INTEGER NOT NULL,
          tool_entries_json TEXT NOT NULL, resolved_permissions_json TEXT NOT NULL,
          definition_digest TEXT NOT NULL, catalog_version TEXT NOT NULL,
          status TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(task_set_id, version)
        );
        CREATE TABLE agent_scope_policies (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
          description TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
          current_version INTEGER NOT NULL, management_mode TEXT NOT NULL DEFAULT 'managed',
          created_by TEXT NOT NULL,
          last_transition_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(tenant_id, name)
        );
        CREATE TABLE agent_scope_policy_versions (
          scope_policy_id TEXT NOT NULL, version INTEGER NOT NULL,
          definition_json TEXT NOT NULL, definition_digest TEXT NOT NULL,
          selector_catalog_version TEXT NOT NULL, status TEXT NOT NULL,
          created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(scope_policy_id, version)
        );
        CREATE TABLE agent_elevation_challenges (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, grant_id TEXT NOT NULL,
          status TEXT NOT NULL, active_args_key TEXT NOT NULL,
          execution_result_envelope TEXT, execution_result_digest TEXT,
          execution_lease_expires_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
          execution_attempt INTEGER NOT NULL, execution_fence INTEGER NOT NULL,
          execution_owner_id TEXT, consumed_at INTEGER, terminal_at INTEGER,
          terminal_transition_id TEXT, expires_at INTEGER
        );
        CREATE TABLE admin_audit_log (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, admin_user_id TEXT,
          action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
          result TEXT NOT NULL, severity TEXT NOT NULL, request_id TEXT,
          metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
          actor_type TEXT, actor_sub TEXT, actor_mode TEXT, actor_assurance TEXT,
          token_binding TEXT, act_client_id TEXT, act_principal_id TEXT,
          grant_id TEXT, elevation_id TEXT, mcp_tool TEXT
        );
        CREATE TABLE admin_agent_login_handoffs (
          id TEXT PRIMARY KEY, target_tenant_id TEXT NOT NULL,
          target_origin TEXT NOT NULL, authorization_path TEXT NOT NULL,
          status TEXT NOT NULL, browser_binding_hash TEXT NOT NULL,
          source_session_id TEXT, source_session_hash TEXT, admin_user_id TEXT,
          code_hash TEXT UNIQUE, last_transition_id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          issued_at INTEGER, consumed_at INTEGER
        );
        CREATE TABLE admin_sessions (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
          ip_address TEXT, user_agent TEXT, created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, last_activity_at INTEGER,
          mfa_verified INTEGER NOT NULL, mfa_verified_at INTEGER,
          parent_session_id TEXT, derived_target_tenant_id TEXT
        );
        CREATE TABLE admin_users (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
          is_active INTEGER NOT NULL, status TEXT NOT NULL
        );
        CREATE TABLE admin_roles (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
          permissions_json TEXT NOT NULL, inherits_from TEXT, is_system INTEGER NOT NULL
        );
        CREATE TABLE admin_role_assignments (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
          admin_role_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT,
          expires_at INTEGER
        );`,
      ],
      { encoding: 'utf8' }
    );
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('resolves a home-tenant global role for a cross-tenant Agent Grant', async () => {
    await adapter.execute(
      `INSERT INTO admin_users (id, tenant_id, is_active, status)
       VALUES (?, ?, 1, 'active')`,
      ['admin-global', 'home-tenant']
    );
    await adapter.execute(
      `INSERT INTO admin_roles (id, tenant_id, permissions_json, inherits_from, is_system)
       VALUES (?, ?, ?, NULL, 0)`,
      ['role-global', 'home-tenant', '["admin:agent:use","admin:clients:read"]']
    );
    await adapter.execute(
      `INSERT INTO admin_role_assignments (
         id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, expires_at
       ) VALUES (?, ?, ?, ?, 'global', NULL, NULL)`,
      ['assignment-global', 'home-tenant', 'admin-global', 'role-global']
    );

    await expect(
      repository.getActiveDelegatorPermissions('target-tenant', 'admin-global', Date.now())
    ).resolves.toEqual(['admin:agent:use', 'admin:clients:read']);
  });

  it('does not apply a home-tenant-only assignment to another target tenant', async () => {
    await adapter.execute(
      `INSERT INTO admin_users (id, tenant_id, is_active, status)
       VALUES (?, ?, 1, 'active')`,
      ['admin-local', 'home-tenant']
    );
    await adapter.execute(
      `INSERT INTO admin_roles (id, tenant_id, permissions_json, inherits_from, is_system)
       VALUES (?, ?, ?, NULL, 0)`,
      ['role-local', 'home-tenant', '["admin:clients:read"]']
    );
    await adapter.execute(
      `INSERT INTO admin_role_assignments (
         id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, expires_at
       ) VALUES (?, ?, ?, ?, 'tenant', NULL, NULL)`,
      ['assignment-local', 'home-tenant', 'admin-local', 'role-local']
    );

    await expect(
      repository.getActiveDelegatorPermissions('target-tenant', 'admin-local', Date.now())
    ).resolves.toEqual([]);
    await expect(
      repository.getActiveDelegatorPermissions('home-tenant', 'admin-local', Date.now())
    ).resolves.toEqual(['admin:clients:read']);
  });

  it('applies an explicitly target-scoped home assignment only to that target tenant', async () => {
    await adapter.execute(
      `INSERT INTO admin_users (id, tenant_id, is_active, status)
       VALUES (?, ?, 1, 'active')`,
      ['admin-targeted', 'home-tenant']
    );
    await adapter.execute(
      `INSERT INTO admin_roles (id, tenant_id, permissions_json, inherits_from, is_system)
       VALUES (?, ?, ?, NULL, 0)`,
      ['role-targeted', 'home-tenant', '["admin:clients:read"]']
    );
    await adapter.execute(
      `INSERT INTO admin_role_assignments (
         id, tenant_id, admin_user_id, admin_role_id, scope_type, scope_id, expires_at
       ) VALUES (?, ?, ?, ?, 'tenant', ?, NULL)`,
      ['assignment-targeted', 'home-tenant', 'admin-targeted', 'role-targeted', 'target-tenant']
    );

    await expect(
      repository.getActiveDelegatorPermissions('target-tenant', 'admin-targeted', Date.now())
    ).resolves.toEqual(['admin:clients:read']);
    await expect(
      repository.getActiveDelegatorPermissions('other-tenant', 'admin-targeted', Date.now())
    ).resolves.toEqual([]);
  });

  it('rejects inactive cross-tenant delegators before resolving their roles', async () => {
    await adapter.execute(
      `INSERT INTO admin_users (id, tenant_id, is_active, status)
       VALUES (?, ?, 0, 'suspended')`,
      ['admin-inactive', 'home-tenant']
    );

    await expect(
      repository.getActiveDelegatorPermissions('target-tenant', 'admin-inactive', Date.now())
    ).resolves.toBeNull();
  });

  async function seedCurrentGrant(): Promise<void> {
    await adapter.execute(
      `INSERT INTO admin_agent_grants
        (id, tenant_id, client_id, delegator_id, generation, consent_version, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      ['grant-1', 'tenant-1', 'client-1', 'admin-1', 3, 4, 1_000]
    );
    for (const [id, type] of [
      ['consent-1', 'delegation'],
      ['consent-2', 'oauth_client'],
    ] as const) {
      await adapter.execute(
        `INSERT INTO agent_consents
          (id, tenant_id, consent_type, grant_id, user_id, client_id,
           consent_version, scopes, granted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'tenant-1', type, 'grant-1', 'admin-1', 'client-1', 4, '["agent:read"]', 100]
      );
    }
  }

  async function createPendingFamily(): Promise<void> {
    await repository.createPendingTokenFamily({
      familyId: 'family-1',
      familyJti: 'jti-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      adminUserId: 'admin-1',
      clientId: 'client-1',
      consentVersion: 4,
      finalizationNonce: 'nonce-1',
      createdAt: 100,
      expiresAt: 1000,
    });
  }

  it('issues and consumes a browser-bound Admin login handoff exactly once', async () => {
    const audit = (action: string, id: string, createdAt: number) => ({
      id,
      tenantId: 'tenant-1',
      action,
      resourceType: 'admin_agent_login_handoff',
      resourceId: 'alh-1',
      severity: 'info' as const,
      actorType: 'admin_user' as const,
      actorSub: action.endsWith('created') ? 'admin-agent-authorize' : 'admin-1',
      adminUserId: action.endsWith('created') ? undefined : 'admin-1',
      metadata: { target_origin: 'https://tenant.example.com' },
      createdAt,
    });

    await repository.createLoginHandoff({
      id: 'alh-1',
      targetTenantId: 'tenant-1',
      targetOrigin: 'https://tenant.example.com',
      authorizationPath: '/oauth/admin-agent/authorize?request_uri=urn%3Atest',
      browserBindingHash: 'browser-hash',
      transitionId: 'transition-created',
      createdAt: 100,
      expiresAt: 400,
      audit: audit('agent.login_handoff.created', 'audit-created', 100),
    });

    expect(
      await repository.issueLoginHandoff({
        id: 'alh-1',
        targetTenantId: 'tenant-1',
        sourceSessionId: 'admin-session-secret',
        sourceSessionHash: 'session-hash',
        adminUserId: 'admin-1',
        codeHash: 'code-hash',
        transitionId: 'transition-issued',
        issuedAt: 200,
        expiresAt: 260,
        audit: audit('agent.login_handoff.issued', 'audit-issued', 200),
      })
    ).toBe(true);

    expect(
      await repository.issueLoginHandoff({
        id: 'alh-1',
        targetTenantId: 'tenant-1',
        sourceSessionId: 'replacement-session',
        sourceSessionHash: 'replacement-hash',
        adminUserId: 'admin-2',
        codeHash: 'replacement-code-hash',
        transitionId: 'transition-issued-replay',
        issuedAt: 201,
        expiresAt: 261,
        audit: audit('agent.login_handoff.issued', 'audit-issued-replay', 201),
      })
    ).toBe(false);

    const issued = await repository.getLoginHandoffByCodeHash('code-hash');
    expect(issued).toMatchObject({
      status: 'issued',
      browserBindingHash: 'browser-hash',
      sourceSessionId: 'admin-session-secret',
      sourceSessionHash: 'session-hash',
      adminUserId: 'admin-1',
    });

    expect(
      await repository.consumeLoginHandoff({
        id: 'alh-1',
        targetTenantId: 'tenant-1',
        codeHash: 'code-hash',
        transitionId: 'transition-wrong-parent',
        consumedAt: 219,
        targetSession: {
          id: 'target-session-wrong-parent',
          tenantId: 'tenant-home',
          adminUserId: 'admin-1',
          parentSessionId: 'attacker-session',
          parentSessionHash: 'attacker-session-hash',
          createdAt: 150,
          expiresAt: 1000,
          mfaVerifiedAt: 150,
        },
        audit: audit('agent.login_handoff.consumed', 'audit-wrong-parent', 219),
      })
    ).toBe(false);

    expect(
      await repository.consumeLoginHandoff({
        id: 'alh-1',
        targetTenantId: 'tenant-1',
        codeHash: 'code-hash',
        transitionId: 'transition-consumed',
        consumedAt: 220,
        targetSession: {
          id: 'target-session-1',
          tenantId: 'tenant-home',
          adminUserId: 'admin-1',
          parentSessionId: 'admin-session-secret',
          parentSessionHash: 'session-hash',
          createdAt: 150,
          expiresAt: 1000,
          mfaVerifiedAt: 150,
        },
        audit: audit('agent.login_handoff.consumed', 'audit-consumed', 220),
      })
    ).toBe(true);
    expect(
      await repository.consumeLoginHandoff({
        id: 'alh-1',
        targetTenantId: 'tenant-1',
        codeHash: 'code-hash',
        transitionId: 'transition-consumed-replay',
        consumedAt: 221,
        targetSession: {
          id: 'target-session-replay',
          tenantId: 'tenant-home',
          adminUserId: 'admin-1',
          parentSessionId: 'admin-session-secret',
          parentSessionHash: 'session-hash',
          createdAt: 150,
          expiresAt: 1000,
          mfaVerifiedAt: 150,
        },
        audit: audit('agent.login_handoff.consumed', 'audit-consumed-replay', 221),
      })
    ).toBe(false);

    expect(await repository.getLoginHandoffById('alh-1')).toMatchObject({
      status: 'consumed',
      sourceSessionId: undefined,
      sourceSessionHash: 'session-hash',
      codeHash: 'code-hash',
    });
    const audits = await adapter.query<{ action: string }>(
      'SELECT action FROM admin_audit_log ORDER BY created_at'
    );
    expect(audits.map(({ action }) => action)).toEqual([
      'agent.login_handoff.created',
      'agent.login_handoff.issued',
      'agent.login_handoff.consumed',
    ]);
    expect(
      await adapter.query<{
        id: string;
        parent_session_id: string;
        derived_target_tenant_id: string;
      }>('SELECT id, parent_session_id, derived_target_tenant_id FROM admin_sessions')
    ).toEqual([
      {
        id: 'target-session-1',
        parent_session_id: 'admin-session-secret',
        derived_target_tenant_id: 'tenant-1',
      },
    ]);
  });

  it('creates a Grant and its admin audit atomically and lists the persisted contract', async () => {
    await repository.createGrantWithAudit({
      grant: {
        grantId: 'grant-created',
        tenantId: 'tenant-1',
        clientId: 'client-created',
        grantorId: 'grantor-1',
        delegatorId: 'delegator-1',
        permissions: ['admin:users:read'],
        scopes: ['agent:read'],
        authorizationDetails: [{ type: 'authrim_admin_agent' }],
        resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 50 },
        purpose: 'integration test',
        consentVersion: 1,
        generation: 1,
        status: 'active',
        delegationMode: 'user_consent',
        taskSetId: 'ats-read-only',
        taskSetVersion: 1,
        scopePolicyId: 'asp-tenant-1',
        scopePolicyVersion: 1,
        resolvedTools: [
          {
            toolId: 'admin.read.users.get',
            toolName: 'get_user',
            contractVersion: '1',
            schemaDigest: 'digest',
            permissions: ['admin:users:read'],
            requiredScope: 'agent:read',
            riskLevel: 'low',
            requiresElevation: false,
          },
        ],
        accessSnapshotHash: 'a'.repeat(43),
        createdAt: 100,
      },
      audit: {
        id: 'audit-created',
        tenantId: 'tenant-1',
        adminUserId: 'grantor-1',
        action: 'agent.grant.created',
        resourceType: 'admin_agent_grant',
        resourceId: 'grant-created',
        severity: 'info',
        actorType: 'admin_user',
        actorSub: 'admin_user:grantor-1',
        grantId: 'grant-created',
        metadata: {},
        createdAt: 100,
      },
    });

    await expect(repository.getGrantRecord('tenant-1', 'grant-created')).resolves.toMatchObject({
      grantId: 'grant-created',
      authorizationDetails: [{ type: 'authrim_admin_agent' }],
      purpose: 'integration test',
      resolvedScopeConstraints: { tenantIds: ['tenant-1'], maxPerCall: 50 },
    });
    await expect(repository.listGrants({ tenantId: 'tenant-1' })).resolves.toMatchObject({
      total: 1,
      grants: [{ grantId: 'grant-created' }],
    });
    await expect(repository.listGrantAudit('tenant-1', 'grant-created')).resolves.toMatchObject([
      { id: 'audit-created', action: 'agent.grant.created', metadata: {} },
    ]);
    await expect(
      adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM admin_audit_log WHERE id = 'audit-created'`
      )
    ).resolves.toEqual({ count: 1 });
  });

  it('atomically creates a Mode B Grant, both authorization records, and audit evidence', async () => {
    const consentBase = {
      tenantId: 'tenant-1',
      grantId: 'grant-mode-b',
      userId: 'delegator-1',
      clientId: 'client-mode-b',
      consentVersion: 1,
      scopes: ['agent:read'] as const,
      grantedAt: 100,
    };
    await repository.createGrantWithPreauthorization({
      grant: {
        grantId: 'grant-mode-b',
        tenantId: 'tenant-1',
        clientId: 'client-mode-b',
        machinePrincipalId: 'amp-1',
        grantorId: 'grantor-1',
        delegatorId: 'delegator-1',
        permissions: ['admin:users:read'],
        scopes: ['agent:read'],
        resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
        consentVersion: 1,
        generation: 1,
        status: 'active',
        delegationMode: 'admin_pre_authorized',
        taskSetId: 'ats-read-only',
        taskSetVersion: 1,
        scopePolicyId: 'asp-tenant-1',
        scopePolicyVersion: 1,
        resolvedTools: [
          {
            toolId: 'admin.read.users.get',
            toolName: 'get_user',
            contractVersion: '1',
            schemaDigest: 'digest',
            permissions: ['admin:users:read'],
            requiredScope: 'agent:read',
            riskLevel: 'low',
            requiresElevation: false,
          },
        ],
        accessSnapshotHash: 'b'.repeat(43),
        createdAt: 100,
      },
      delegationConsent: { ...consentBase, id: 'consent-mode-b-1', type: 'delegation' },
      oauthClientConsent: { ...consentBase, id: 'consent-mode-b-2', type: 'oauth_client' },
      audit: {
        id: 'audit-mode-b-grant',
        tenantId: 'tenant-1',
        adminUserId: 'grantor-1',
        action: 'agent.grant.created',
        resourceType: 'admin_agent_grant',
        resourceId: 'grant-mode-b',
        severity: 'info',
        actorType: 'admin_user',
        actorSub: 'admin_user:grantor-1',
        grantId: 'grant-mode-b',
        metadata: {},
        createdAt: 100,
      },
      consentAudit: {
        id: 'audit-mode-b-consent',
        tenantId: 'tenant-1',
        adminUserId: 'grantor-1',
        action: 'agent.consent.granted',
        resourceType: 'admin_agent_grant',
        resourceId: 'grant-mode-b',
        severity: 'info',
        actorType: 'admin_user',
        actorSub: 'admin_user:grantor-1',
        grantId: 'grant-mode-b',
        metadata: { authorization_basis: 'admin_pre_authorized' },
        createdAt: 100,
      },
    });

    await expect(
      repository.hasCurrentConsent('tenant-1', 'grant-mode-b', 'delegator-1', 'client-mode-b', 1)
    ).resolves.toBe(true);
    await expect(repository.listGrantAudit('tenant-1', 'grant-mode-b')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'agent.grant.created' }),
        expect.objectContaining({ action: 'agent.consent.granted' }),
      ])
    );
  });

  it('creates and scope-updates one system-managed self-service authorization atomically', async () => {
    const readTool = {
      toolId: 'admin.read.clients.list',
      toolName: 'list_clients',
      contractVersion: '1',
      schemaDigest: 'read-digest',
      permissions: ['admin:clients:read'],
      requiredScope: 'agent:read' as const,
      riskLevel: 'low' as const,
      requiresElevation: false,
    };
    const policy = {
      tenantIds: ['tenant-1'],
      environmentIds: [],
      domains: [],
      resourceIds: [],
      selectors: [],
      allowedFields: [],
      piiMode: 'masked' as const,
      maxPerCall: 50,
      maxPlanOperations: 25,
      maxBulkTenants: 1,
    };
    const taskResolved1 = {
      catalogVersion: 'catalog-v1',
      tools: [readTool],
      permissions: ['admin:clients:read'],
    };
    const taskDigest1 = await sha256Base64Url(canonicalizeJson(taskResolved1 as never));
    const policyDigest = await sha256Base64Url(canonicalizeJson(policy as never));
    const accessHash1 = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-self-service-snapshot-v1',
        tenant_id: 'tenant-1',
        admin_user_id: 'admin-1',
        client_id: 'client-self-service',
        grant_id: 'grant-self-service',
        expires_at: 700,
        scopes: ['agent:read'],
        task_set: { id: 'system-task-1', version: 1, digest: taskDigest1 },
        scope_policy: { id: 'system-policy-1', version: 1, digest: policyDigest },
        tools: [readTool],
      } as never)
    );
    const consentBase = {
      tenantId: 'tenant-1',
      grantId: 'grant-self-service',
      userId: 'admin-1',
      clientId: 'client-self-service',
      consentVersion: 1,
      scopes: ['agent:read'] as const,
      grantedAt: 100,
    };
    const auditBase = {
      tenantId: 'tenant-1',
      adminUserId: 'admin-1',
      resourceType: 'admin_agent_grant',
      resourceId: 'grant-self-service',
      severity: 'info' as const,
      actorType: 'admin_user' as const,
      actorSub: 'admin_user:admin-1',
      grantId: 'grant-self-service',
      createdAt: 100,
    };
    const initialAuthorization = {
      grant: {
        grantId: 'grant-self-service',
        tenantId: 'tenant-1',
        clientId: 'client-self-service',
        grantorId: 'admin-1',
        delegatorId: 'admin-1',
        permissions: ['admin:clients:read'],
        scopes: ['agent:read'],
        authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 50 }],
        resolvedScopeConstraints: {
          tenantIds: ['tenant-1'],
          piiMode: 'masked',
          maxPerCall: 50,
          maxPerPlan: 25,
          maxPerBulkPlan: 1,
        },
        consentVersion: 1,
        generation: 1,
        status: 'active',
        delegationMode: 'user_consent',
        taskSetId: 'system-task-1',
        taskSetVersion: 1,
        scopePolicyId: 'system-policy-1',
        scopePolicyVersion: 1,
        resolvedTools: [readTool],
        accessSnapshotHash: accessHash1,
        purpose: 'interactive_self_service',
        managementMode: 'system_managed',
        expiresAt: 700,
        createdAt: 100,
      },
      taskSet: {
        id: 'system-task-1',
        version: 1,
        digest: taskDigest1,
        resolved: {
          ...taskResolved1,
          digest: taskDigest1,
        },
      },
      scopePolicy: {
        id: 'system-policy-1',
        version: 1,
        digest: policyDigest,
        definition: policy,
        selectorCatalogVersion: 'selectors-v1',
      },
      delegationConsent: { ...consentBase, id: 'self-consent-1', type: 'delegation' },
      oauthClientConsent: { ...consentBase, id: 'self-consent-2', type: 'oauth_client' },
      audit: {
        ...auditBase,
        id: 'self-audit-create',
        action: 'agent.grant.created',
        metadata: { management_mode: 'system_managed' },
      },
      consentAudit: {
        ...auditBase,
        id: 'self-audit-consent',
        action: 'agent.consent.granted',
        metadata: { scopes: ['agent:read'] },
      },
    } satisfies Parameters<AdminAgentAccessRepository['createSelfServiceAuthorization']>[0];
    await repository.createSelfServiceAuthorization(initialAuthorization);
    await repository.createSelfServiceAuthorization(initialAuthorization);
    await expect(
      repository.createSelfServiceAuthorization({
        ...initialAuthorization,
        delegationConsent: {
          ...initialAuthorization.delegationConsent,
          grantedAt: initialAuthorization.delegationConsent.grantedAt + 1,
        },
      })
    ).rejects.toThrow();
    await expect(
      adapter.queryOne<{ granted_at: number }>(
        `SELECT granted_at FROM agent_consents
         WHERE grant_id = 'grant-self-service' AND consent_type = 'delegation'`
      )
    ).resolves.toEqual({ granted_at: 100 });
    await repository.createPendingTokenFamily({
      familyId: 'self-family-1',
      familyJti: 'self-jti-1',
      tenantId: 'tenant-1',
      grantId: 'grant-self-service',
      grantGeneration: 1,
      adminUserId: 'admin-1',
      clientId: 'client-self-service',
      consentVersion: 1,
      finalizationNonce: 'self-nonce-1',
      createdAt: 110,
      expiresAt: 1000,
    });
    const userTool = {
      toolId: 'admin.read.users.get',
      toolName: 'get_user',
      contractVersion: '1',
      schemaDigest: 'user-digest',
      permissions: ['admin:users:read'],
      requiredScope: 'agent:user-data:read' as const,
      riskLevel: 'low' as const,
      requiresElevation: false,
    };
    const replacementConsent = {
      ...consentBase,
      consentVersion: 2,
      scopes: ['agent:read', 'agent:user-data:read'] as const,
      grantedAt: 200,
    };
    const taskResolved2 = {
      catalogVersion: 'catalog-v1',
      tools: [readTool, userTool],
      permissions: ['admin:clients:read', 'admin:users:read'],
    };
    const taskDigest2 = await sha256Base64Url(canonicalizeJson(taskResolved2 as never));
    const replacementPolicy = { ...policy, maxPerCall: 2 };
    const replacementPolicyDigest = await sha256Base64Url(
      canonicalizeJson(replacementPolicy as never)
    );
    const accessHash2 = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-self-service-snapshot-v1',
        tenant_id: 'tenant-1',
        admin_user_id: 'admin-1',
        client_id: 'client-self-service',
        grant_id: 'grant-self-service',
        expires_at: 800,
        scopes: ['agent:read', 'agent:user-data:read'],
        task_set: { id: 'system-task-2', version: 1, digest: taskDigest2 },
        scope_policy: { id: 'system-policy-2', version: 1, digest: replacementPolicyDigest },
        tools: [readTool, userTool],
      } as never)
    );
    const replacement = {
      grant: {
        grantId: 'grant-self-service',
        tenantId: 'tenant-1',
        clientId: 'client-self-service',
        grantorId: 'admin-1',
        delegatorId: 'admin-1',
        permissions: ['admin:clients:read', 'admin:users:read'],
        scopes: ['agent:read', 'agent:user-data:read'],
        authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 2 }],
        resolvedScopeConstraints: {
          tenantIds: ['tenant-1'],
          piiMode: 'masked',
          maxPerCall: 2,
          maxPerPlan: 25,
          maxPerBulkPlan: 1,
        },
        consentVersion: 2,
        generation: 2,
        status: 'active',
        delegationMode: 'user_consent',
        taskSetId: 'system-task-2',
        taskSetVersion: 1,
        scopePolicyId: 'system-policy-2',
        scopePolicyVersion: 1,
        resolvedTools: [readTool, userTool],
        accessSnapshotHash: accessHash2,
        purpose: 'interactive_self_service',
        managementMode: 'system_managed',
        expiresAt: 800,
        createdAt: 200,
      },
      expectedGeneration: 1,
      transitionId: 'self-transition-2',
      outboxId: 'outbox_self-transition-2',
      taskSet: {
        id: 'system-task-2',
        version: 1,
        digest: taskDigest2,
        resolved: {
          ...taskResolved2,
          digest: taskDigest2,
        },
      },
      scopePolicy: {
        id: 'system-policy-2',
        version: 1,
        digest: replacementPolicyDigest,
        definition: replacementPolicy,
        selectorCatalogVersion: 'selectors-v1',
      },
      delegationConsent: {
        ...replacementConsent,
        id: 'self-consent-3',
        type: 'delegation',
      },
      oauthClientConsent: {
        ...replacementConsent,
        id: 'self-consent-4',
        type: 'oauth_client',
      },
      grantAudit: {
        ...auditBase,
        id: 'self-transition-2',
        action: 'agent.grant.updated',
        metadata: { scopes: replacementConsent.scopes },
        createdAt: 200,
      },
      consentAudit: {
        ...auditBase,
        id: 'self-audit-consent-2',
        action: 'agent.consent.granted',
        metadata: { scopes: replacementConsent.scopes },
        createdAt: 200,
      },
    } satisfies Parameters<AdminAgentAccessRepository['replaceSelfServiceAuthorization']>[0];
    await expect(repository.replaceSelfServiceAuthorization(replacement)).resolves.toEqual({
      familyCount: 1,
    });
    await expect(repository.replaceSelfServiceAuthorization(replacement)).resolves.toEqual({
      familyCount: 1,
    });
    await expect(
      repository.replaceSelfServiceAuthorization({ ...replacement, outboxId: 'outbox_other' })
    ).rejects.toThrow('outbox must be transition-bound');
    await expect(
      repository.replaceSelfServiceAuthorization({
        ...replacement,
        grant: {
          ...replacement.grant,
          authorizationDetails: [
            { type: 'authrim_admin_agent', max_subjects_per_call: 2 },
            { type: 'authrim_admin_agent', max_subjects_per_call: 2 },
          ],
        },
      })
    ).rejects.toThrow('changed during consent');
    const differentExpiryHash = await sha256Base64Url(
      canonicalizeJson({
        purpose: 'authrim-agent-self-service-snapshot-v1',
        tenant_id: 'tenant-1',
        admin_user_id: 'admin-1',
        client_id: 'client-self-service',
        grant_id: 'grant-self-service',
        expires_at: 801,
        scopes: ['agent:read', 'agent:user-data:read'],
        task_set: { id: 'system-task-2', version: 1, digest: taskDigest2 },
        scope_policy: { id: 'system-policy-2', version: 1, digest: replacementPolicyDigest },
        tools: [readTool, userTool],
      } as never)
    );
    await expect(
      repository.replaceSelfServiceAuthorization({
        ...replacement,
        grant: {
          ...replacement.grant,
          expiresAt: 801,
          accessSnapshotHash: differentExpiryHash,
        },
      })
    ).rejects.toThrow('changed during consent');
    await expect(
      repository.replaceSelfServiceAuthorization({
        ...replacement,
        delegationConsent: {
          ...replacement.delegationConsent,
          grantedAt: replacement.delegationConsent.grantedAt + 1,
        },
      })
    ).rejects.toThrow();
    await expect(
      adapter.queryOne<{ granted_at: number }>(
        `SELECT granted_at FROM agent_consents
         WHERE grant_id = 'grant-self-service' AND consent_type = 'delegation'`
      )
    ).resolves.toEqual({ granted_at: 200 });

    await expect(repository.getGrant('tenant-1', 'grant-self-service')).resolves.toMatchObject({
      generation: 2,
      consentVersion: 2,
      scopes: ['agent:read', 'agent:user-data:read'],
      authorizationDetails: [{ type: 'authrim_admin_agent', max_subjects_per_call: 2 }],
      resolvedScopeConstraints: expect.objectContaining({ maxPerCall: 2 }),
      taskSetId: 'system-task-2',
    });
    await expect(
      repository.getGrantRecord('tenant-1', 'grant-self-service')
    ).resolves.toMatchObject({ managementMode: 'system_managed' });
    await expect(
      adapter.queryOne<{ management_mode: string }>(
        `SELECT management_mode FROM agent_task_sets
         WHERE tenant_id = 'tenant-1' AND id = 'system-task-2'`
      )
    ).resolves.toEqual({ management_mode: 'system_managed' });
    await expect(configurationRepository.listTaskSets('tenant-1')).resolves.toEqual([]);
    await expect(configurationRepository.listScopePolicies('tenant-1')).resolves.toEqual([]);
    await expect(
      configurationRepository.getTaskSet('tenant-1', 'system-task-2')
    ).resolves.toMatchObject({ managementMode: 'system_managed' });
    await expect(
      configurationRepository.getScopePolicy('tenant-1', 'system-policy-2')
    ).resolves.toMatchObject({ managementMode: 'system_managed' });
    await expect(
      adapter.queryOne<{ management_mode: string }>(
        `SELECT management_mode FROM agent_scope_policies
         WHERE tenant_id = 'tenant-1' AND id = 'system-policy-2'`
      )
    ).resolves.toEqual({ management_mode: 'system_managed' });
    await expect(
      adapter.queryOne<{ status: string; revocation_outbox_id: string }>(
        `SELECT status, revocation_outbox_id FROM admin_agent_token_families
         WHERE family_id = 'self-family-1'`
      )
    ).resolves.toEqual({
      status: 'revocation_pending',
      revocation_outbox_id: 'outbox_self-transition-2',
    });
  });

  it('finalizes only while Grant generation and both consents remain current', async () => {
    await seedCurrentGrant();
    await createPendingFamily();
    await expect(
      repository.finalizeTokenFamily({
        familyId: 'family-1',
        finalizationNonce: 'nonce-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        grantGeneration: 3,
        adminUserId: 'admin-1',
        clientId: 'client-1',
        consentVersion: 4,
        now: 200,
      })
    ).resolves.toBe(true);
    await expect(
      adapter.queryOne<{ status: string }>(
        'SELECT status FROM admin_agent_token_families WHERE family_id = ?',
        ['family-1']
      )
    ).resolves.toEqual({ status: 'active' });
  });

  it('updates a Grant and invalidates consent and old token families in one batch', async () => {
    await seedCurrentGrant();
    await createPendingFamily();
    await repository.finalizeTokenFamily({
      familyId: 'family-1',
      finalizationNonce: 'nonce-1',
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      adminUserId: 'admin-1',
      clientId: 'client-1',
      consentVersion: 4,
      now: 110,
    });

    await expect(
      repository.updateGrantAndQueueTokenRevocation({
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        clientId: 'client-1',
        expectedGeneration: 3,
        permissions: ['admin:users:read'],
        scopes: ['agent:read'],
        resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
        purpose: 'updated',
        outboxId: 'outbox-update',
        now: 120,
        audit: {
          id: 'audit-update',
          tenantId: 'tenant-1',
          adminUserId: 'grantor-1',
          action: 'agent.grant.updated',
          resourceType: 'admin_agent_grant',
          resourceId: 'grant-1',
          severity: 'warn',
          actorType: 'admin_user',
          actorSub: 'admin_user:grantor-1',
          grantId: 'grant-1',
          metadata: { permissions: ['admin:users:read'] },
          createdAt: 120,
        },
      })
    ).resolves.toEqual({ familyCount: 1, nextGeneration: 4, nextConsentVersion: 5 });
    await expect(repository.getGrantRecord('tenant-1', 'grant-1')).resolves.toMatchObject({
      generation: 4,
      consentVersion: 5,
      permissions: ['admin:users:read'],
      purpose: 'updated',
    });
    await expect(
      adapter.queryOne<{ status: string }>(
        `SELECT status FROM admin_agent_token_families WHERE family_id = 'family-1'`
      )
    ).resolves.toEqual({ status: 'revocation_pending' });
    await expect(
      adapter.queryOne<{ active: number }>(
        `SELECT COUNT(*) AS active FROM agent_consents WHERE revoked_at IS NULL`
      )
    ).resolves.toEqual({ active: 0 });
  });

  it('leaves the family pending when Grant generation changed before finalization', async () => {
    await seedCurrentGrant();
    await createPendingFamily();
    await adapter.execute('UPDATE admin_agent_grants SET generation = 4 WHERE id = ?', ['grant-1']);
    await expect(
      repository.finalizeTokenFamily({
        familyId: 'family-1',
        finalizationNonce: 'nonce-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        grantGeneration: 3,
        adminUserId: 'admin-1',
        clientId: 'client-1',
        consentVersion: 4,
        now: 200,
      })
    ).resolves.toBe(false);
    await expect(
      adapter.queryOne<{ status: string }>(
        'SELECT status FROM admin_agent_token_families WHERE family_id = ?',
        ['family-1']
      )
    ).resolves.toEqual({ status: 'pending_finalization' });
  });

  it('resumes a suspended Grant without restoring revoked consent', async () => {
    await seedCurrentGrant();
    await repository.invalidateGrantAndQueueTokenRevocation({
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      clientId: 'client-1',
      expectedGeneration: 3,
      status: 'suspended',
      reason: 'admin',
      outboxId: 'outbox-suspend',
      now: 200,
      audit: {
        id: 'audit-suspend',
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        action: 'agent.grant.suspended',
        resourceType: 'admin_agent_grant',
        resourceId: 'grant-1',
        severity: 'warn',
        actorType: 'admin_user',
        actorSub: 'admin_user:admin-1',
        grantId: 'grant-1',
        metadata: {},
        createdAt: 200,
      },
    });
    const input = {
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      clientId: 'client-1',
      expectedGeneration: 4,
      transitionId: 'audit-resume',
      expiresAt: 2_592_000_300,
      now: 300,
      audit: {
        id: 'audit-resume',
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        action: 'agent.grant.resumed',
        resourceType: 'admin_agent_grant',
        resourceId: 'grant-1',
        severity: 'warn',
        actorType: 'admin_user',
        actorSub: 'admin_user:admin-1',
        grantId: 'grant-1',
        metadata: { consent_required: true },
        createdAt: 300,
      },
    } satisfies Parameters<AdminAgentAccessRepository['resumeGrantWithAudit']>[0];
    await expect(repository.resumeGrantWithAudit(input)).resolves.toBe(true);
    await expect(repository.resumeGrantWithAudit(input)).resolves.toBe(true);
    await expect(repository.getGrant('tenant-1', 'grant-1')).resolves.toMatchObject({
      status: 'active',
      generation: 4,
      consentVersion: 5,
      expiresAt: 2_592_000_300,
    });
    await expect(
      adapter.queryOne<{ active: number }>(
        'SELECT COUNT(*) AS active FROM agent_consents WHERE revoked_at IS NULL'
      )
    ).resolves.toEqual({ active: 0 });
  });

  it('revokes OAuth client consent and old families while leaving the Grant active', async () => {
    await seedCurrentGrant();
    await createPendingFamily();
    const input = {
      consentId: 'consent-2',
      tenantId: 'tenant-1',
      userId: 'admin-1',
      grantId: 'grant-1',
      clientId: 'client-1',
      grantGeneration: 3,
      outboxId: 'transition-consent',
      now: 200,
      audit: {
        id: 'transition-consent',
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        action: 'agent.consent.oauth_client.revoked',
        resourceType: 'agent_consent',
        resourceId: 'consent-2',
        severity: 'warn',
        actorType: 'admin_user',
        actorSub: 'admin_user:admin-1',
        grantId: 'grant-1',
        metadata: {},
        createdAt: 200,
      },
    } satisfies Parameters<
      AdminAgentAccessRepository['revokeOauthClientConsentAndQueueTokenRevocation']
    >[0];
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(input)
    ).resolves.toEqual({ familyCount: 1 });
    await expect(
      repository.revokeOauthClientConsentAndQueueTokenRevocation(input)
    ).resolves.toEqual({ familyCount: 1 });
    await expect(repository.getGrant('tenant-1', 'grant-1')).resolves.toMatchObject({
      status: 'active',
      generation: 3,
    });
    const consents = await repository.listUserConsents('tenant-1', 'admin-1');
    expect(consents.find((consent) => consent.type === 'delegation')?.revokedAt).toBeUndefined();
    expect(consents.find((consent) => consent.type === 'oauth_client')?.revokedReason).toBe('user');
  });

  it('atomically invalidates a Grant, snapshots families, queues revocation, and audits', async () => {
    await seedCurrentGrant();
    await createPendingFamily();
    const invalidation = {
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      clientId: 'client-1',
      expectedGeneration: 3,
      status: 'revoked',
      reason: 'grant_revoked',
      outboxId: 'outbox-1',
      now: 200,
      audit: {
        id: 'audit-1',
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        action: 'agent.grant.revoked',
        resourceType: 'agent_grant',
        resourceId: 'grant-1',
        severity: 'critical',
        actorType: 'admin_user',
        actorSub: 'admin_user:admin-1',
        metadata: {},
        createdAt: 200,
      },
    } satisfies Parameters<AdminAgentAccessRepository['invalidateGrantAndQueueTokenRevocation']>[0];

    await expect(repository.invalidateGrantAndQueueTokenRevocation(invalidation)).resolves.toEqual({
      familyCount: 1,
      nextGeneration: 4,
    });
    await expect(repository.invalidateGrantAndQueueTokenRevocation(invalidation)).resolves.toEqual({
      familyCount: 1,
      nextGeneration: 4,
    });

    await expect(
      adapter.queryOne<{
        generation: number;
        consent_version: number;
        status: string;
        last_mutation_id: string;
      }>(
        `SELECT generation, consent_version, status, last_mutation_id
         FROM admin_agent_grants WHERE id = 'grant-1'`
      )
    ).resolves.toEqual({
      generation: 4,
      consent_version: 5,
      status: 'revoked',
      last_mutation_id: 'outbox-1',
    });
    await expect(
      adapter.queryOne<{ payload: string }>(
        `SELECT payload FROM admin_agent_token_revocation_outbox WHERE id = 'outbox-1'`
      )
    ).resolves.toEqual({
      payload: '{"family_ids":["family-1"],"family_jtis":["jti-1"],"reason":"grant_revoked"}',
    });
    await expect(
      adapter.queryOne<{ status: string; revocation_outbox_id: string }>(
        `SELECT status, revocation_outbox_id FROM admin_agent_token_families
         WHERE family_id = 'family-1'`
      )
    ).resolves.toEqual({ status: 'revocation_pending', revocation_outbox_id: 'outbox-1' });
    await expect(
      adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM admin_audit_log WHERE id = 'audit-1'`
      )
    ).resolves.toEqual({ count: 1 });
  });

  it('leaves every dependent row unchanged when the Grant generation CAS loses', async () => {
    await seedCurrentGrant();
    await createPendingFamily();

    await expect(
      repository.invalidateGrantAndQueueTokenRevocation({
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        clientId: 'client-1',
        expectedGeneration: 2,
        status: 'suspended',
        reason: 'grant_updated',
        outboxId: 'outbox-stale',
        now: 200,
        audit: {
          id: 'audit-stale',
          tenantId: 'tenant-1',
          action: 'agent.grant.suspended',
          resourceType: 'agent_grant',
          resourceId: 'grant-1',
          severity: 'warning',
          actorType: 'system',
          actorSub: 'system:test',
          metadata: {},
          createdAt: 200,
        },
      })
    ).rejects.toThrow('Agent Grant changed before invalidation');

    await expect(
      adapter.queryOne<{ generation: number; status: string }>(
        `SELECT generation, status FROM admin_agent_grants WHERE id = 'grant-1'`
      )
    ).resolves.toEqual({ generation: 3, status: 'active' });
    await expect(
      adapter.queryOne<{ revoked_at: number | null }>(
        `SELECT revoked_at FROM agent_consents WHERE id = 'consent-1'`
      )
    ).resolves.toEqual({ revoked_at: null });
    await expect(
      adapter.queryOne<{ status: string }>(
        `SELECT status FROM admin_agent_token_families WHERE family_id = 'family-1'`
      )
    ).resolves.toEqual({ status: 'pending_finalization' });
    await expect(
      adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM admin_agent_token_revocation_outbox`
      )
    ).resolves.toEqual({ count: 0 });
    await expect(
      adapter.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM admin_audit_log')
    ).resolves.toEqual({ count: 0 });
  });

  it('commits a stale elevation terminal transition and its audit as one guarded batch', async () => {
    await adapter.execute(
      `INSERT INTO agent_elevation_challenges (
        id, tenant_id, grant_id, status, active_args_key,
        execution_lease_expires_at, execution_attempt, execution_fence
      ) VALUES ('challenge-1', 'tenant-1', 'grant-1', 'executing', 'active', 150, 2, 4)`
    );
    const audit = {
      id: 'audit-reconcile',
      tenantId: 'tenant-1',
      action: 'agent.elevation.indeterminate',
      resourceType: 'agent_elevation_challenge',
      resourceId: 'challenge-1',
      severity: 'warning' as const,
      actorType: 'system' as const,
      actorSub: 'system:test-reconciler',
      grantId: 'grant-1',
      elevationId: 'challenge-1',
      metadata: {},
      createdAt: 201,
    };

    await expect(
      repository.reconcileStaleElevation({
        tenantId: 'tenant-1',
        challengeId: 'challenge-1',
        expectedAttempt: 2,
        expectedFence: 4,
        staleBefore: 200,
        status: 'indeterminate',
        reconciledAt: 201,
        audit,
      })
    ).resolves.toBe(true);
    // D1Adapter may retry a batch after an ambiguous transport error. Exact replay is safe.
    await expect(
      repository.reconcileStaleElevation({
        tenantId: 'tenant-1',
        challengeId: 'challenge-1',
        expectedAttempt: 2,
        expectedFence: 4,
        staleBefore: 200,
        status: 'indeterminate',
        reconciledAt: 201,
        audit,
      })
    ).resolves.toBe(true);
    await expect(
      adapter.queryOne<{ status: string; terminal_transition_id: string }>(
        `SELECT status, terminal_transition_id FROM agent_elevation_challenges
         WHERE id = 'challenge-1'`
      )
    ).resolves.toEqual({ status: 'indeterminate', terminal_transition_id: 'audit-reconcile' });
    await expect(
      adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM admin_audit_log WHERE id = 'audit-reconcile'`
      )
    ).resolves.toEqual({ count: 1 });
  });

  it('expires an unclaimed elevation and writes its audit in the same guarded batch', async () => {
    await adapter.execute(
      `INSERT INTO agent_elevation_challenges (
        id, tenant_id, grant_id, status, active_args_key,
        execution_attempt, execution_fence, expires_at
      ) VALUES ('challenge-expired', 'tenant-1', 'grant-1', 'pending', 'active', 0, 0, 150)`
    );
    const audit = {
      id: 'audit-expired',
      tenantId: 'tenant-1',
      action: 'agent.elevation.expired',
      resourceType: 'agent_elevation',
      resourceId: 'challenge-expired',
      severity: 'info' as const,
      actorType: 'system' as const,
      actorSub: 'system:agent-elevation-expiry',
      grantId: 'grant-1',
      elevationId: 'challenge-expired',
      metadata: { reason: 'challenge_ttl_elapsed' },
      createdAt: 200,
    };

    await expect(
      repository.expireUnclaimedElevation({
        tenantId: 'tenant-1',
        challengeId: 'challenge-expired',
        expiredAt: 200,
        audit,
      })
    ).resolves.toBe(true);
    await expect(
      repository.expireUnclaimedElevation({
        tenantId: 'tenant-1',
        challengeId: 'challenge-expired',
        expiredAt: 200,
        audit,
      })
    ).resolves.toBe(true);
    await expect(
      adapter.queryOne<{ status: string; active_args_key: string }>(
        `SELECT status, active_args_key FROM agent_elevation_challenges
         WHERE id = 'challenge-expired'`
      )
    ).resolves.toEqual({ status: 'expired', active_args_key: 'challenge-expired' });
    await expect(
      adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM admin_audit_log WHERE id = 'audit-expired'`
      )
    ).resolves.toEqual({ count: 1 });
  });

  it('does not emit a stale elevation audit when its attempt/fence CAS loses', async () => {
    await adapter.execute(
      `INSERT INTO agent_elevation_challenges (
        id, tenant_id, grant_id, status, active_args_key,
        execution_lease_expires_at, execution_attempt, execution_fence
      ) VALUES ('challenge-1', 'tenant-1', 'grant-1', 'executing', 'active', 150, 3, 5)`
    );

    await expect(
      repository.reconcileStaleElevation({
        tenantId: 'tenant-1',
        challengeId: 'challenge-1',
        expectedAttempt: 2,
        expectedFence: 4,
        staleBefore: 200,
        status: 'indeterminate',
        reconciledAt: 201,
        audit: {
          id: 'audit-stale-reconcile',
          tenantId: 'tenant-1',
          action: 'agent.elevation.indeterminate',
          resourceType: 'agent_elevation_challenge',
          resourceId: 'challenge-1',
          severity: 'warning',
          actorType: 'system',
          actorSub: 'system:test-reconciler',
          grantId: 'grant-1',
          elevationId: 'challenge-1',
          metadata: {},
          createdAt: 201,
        },
      })
    ).resolves.toBe(false);
    await expect(
      adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM admin_audit_log WHERE id = 'audit-stale-reconcile'`
      )
    ).resolves.toEqual({ count: 0 });
  });

  it('completes a revocation outbox fence and its family rows atomically', async () => {
    await seedCurrentGrant();
    await createPendingFamily();
    await adapter.execute(
      `INSERT INTO admin_agent_token_revocation_outbox (
        id, tenant_id, grant_id, grant_generation, client_id, event_type, payload,
        status, attempt_count, processing_fence, next_attempt_at,
        processing_owner_id, processing_lease_expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 1, 3, 100, ?, 300, 100)`,
      [
        'outbox-1',
        'tenant-1',
        'grant-1',
        3,
        'client-1',
        'revoke_grant_families',
        '{"family_ids":["family-1"],"family_jtis":["jti-1"],"reason":"grant_revoked"}',
        'owner-1',
      ]
    );

    await expect(
      repository.completeTokenRevocationOutbox({
        outboxId: 'outbox-1',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        fence: 3,
        completionId: 'completion-1',
        familyIds: ['family-1'],
        completedAt: 200,
      })
    ).resolves.toBe(true);
    await expect(
      repository.completeTokenRevocationOutbox({
        outboxId: 'outbox-1',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        fence: 3,
        completionId: 'completion-1',
        familyIds: ['family-1'],
        completedAt: 200,
      })
    ).resolves.toBe(true);
    await expect(
      adapter.queryOne<{ status: string; completion_transition_id: string }>(
        `SELECT status, completion_transition_id
         FROM admin_agent_token_revocation_outbox WHERE id = 'outbox-1'`
      )
    ).resolves.toEqual({ status: 'completed', completion_transition_id: 'completion-1' });
    await expect(
      adapter.queryOne<{ status: string }>(
        `SELECT status FROM admin_agent_token_families WHERE family_id = 'family-1'`
      )
    ).resolves.toEqual({ status: 'revoked' });
  });

  it('moves the exact failed outbox attempt and its audit to dead letter atomically', async () => {
    await adapter.execute(
      `INSERT INTO admin_agent_token_revocation_outbox (
        id, tenant_id, client_id, event_type, payload, status, attempt_count,
        processing_fence, next_attempt_at, processing_owner_id,
        processing_lease_expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'processing', 8, 7, 100, ?, 300, 100)`,
      [
        'outbox-dead',
        'tenant-1',
        'client-1',
        'revoke_client_families',
        '{"family_ids":[],"family_jtis":[],"reason":"client_revoked"}',
        'owner-1',
      ]
    );

    await expect(
      repository.failTokenRevocationOutbox({
        outboxId: 'outbox-dead',
        tenantId: 'tenant-1',
        ownerId: 'owner-1',
        fence: 7,
        expectedAttempt: 8,
        nextAttemptAt: 500,
        maxAttempts: 8,
        deadLetterAudit: {
          id: 'audit-dead',
          tenantId: 'tenant-1',
          action: 'agent.token.revocation.dead_letter',
          resourceType: 'admin_agent_token_revocation_outbox',
          resourceId: 'outbox-dead',
          severity: 'critical',
          actorType: 'system',
          actorSub: 'system:test-revoker',
          metadata: { attempt_count: 8 },
          createdAt: 500,
        },
      })
    ).resolves.toBe('dead_letter');
    await expect(
      adapter.queryOne<{ status: string; failure_transition_id: string }>(
        `SELECT status, failure_transition_id
         FROM admin_agent_token_revocation_outbox WHERE id = 'outbox-dead'`
      )
    ).resolves.toEqual({ status: 'dead_letter', failure_transition_id: 'audit-dead' });
    await expect(
      adapter.queryOne<{ count: number }>(
        `SELECT COUNT(*) AS count FROM admin_audit_log WHERE id = 'audit-dead'`
      )
    ).resolves.toEqual({ count: 1 });
  });

  it('rolls back both consent rows when the same batch cannot append its audit', async () => {
    await adapter.execute(
      `INSERT INTO admin_audit_log (
        id, tenant_id, action, resource_type, resource_id, result, severity,
        metadata_json, created_at
      ) VALUES ('audit-conflict', 'tenant-1', 'existing', 'test', 'test',
        'success', 'info', '{}', 1)`
    );
    const base = {
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-1',
      clientId: 'client-1',
      consentVersion: 1,
      scopes: ['agent:read'] as const,
      grantedAt: 100,
    };

    await expect(
      repository.grantConsentPair({
        delegation: { ...base, id: 'consent-1', type: 'delegation' },
        oauthClient: { ...base, id: 'consent-2', type: 'oauth_client' },
        audit: {
          id: 'audit-conflict',
          tenantId: 'tenant-1',
          adminUserId: 'admin-1',
          action: 'agent.consent.granted',
          resourceType: 'admin_agent_grant',
          resourceId: 'grant-1',
          severity: 'info',
          actorType: 'admin_user',
          actorSub: 'admin_user:admin-1',
          grantId: 'grant-1',
          metadata: {},
          createdAt: 100,
        },
      })
    ).rejects.toThrow();
    await expect(
      adapter.queryOne<{ count: number }>('SELECT COUNT(*) AS count FROM agent_consents')
    ).resolves.toEqual({ count: 0 });
  });
});

describeWithSqlite('AgentBulkRepository SQLite lifecycle', () => {
  let temporaryDirectory: string;
  let adapter: SqliteCliAdapter;
  let repository: AgentBulkRepository;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'authrim-agent-bulk-'));
    const databasePath = path.join(temporaryDirectory, 'test.db');
    adapter = new SqliteCliAdapter(sqlite3Path!, databasePath);
    repository = new AgentBulkRepository(adapter);
    const rootCandidate = path.resolve(process.cwd(), 'migrations/admin/d1');
    const migrationDirectory = existsSync(rootCandidate)
      ? rootCandidate
      : path.resolve(process.cwd(), '../../migrations/admin/d1');
    const migrationSql = readdirSync(migrationDirectory)
      .filter((name) => /^\d{3}_.*\.sql$/u.test(name))
      .sort()
      .map((filename) =>
        readFileSync(path.join(migrationDirectory, filename), 'utf8')
          .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '0')
          .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', '0')
      )
      .join('\n');
    execFileSync(sqlite3Path!, ['-bail', databasePath], {
      encoding: 'utf8',
      input: migrationSql,
    });
  }, 30_000);

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('persists, claims, checkpoints, and completes a tenant child with CAS fences', async () => {
    await adapter.execute(
      `INSERT INTO admin_agent_grants (
        id, tenant_id, client_id, grantor_id, delegator_id, permissions,
        resolved_scope_constraints, scopes, delegation_mode, generation,
				consent_version, status, active_uniqueness_key, created_at, updated_at,
				task_set_id, task_set_version, scope_policy_id, scope_policy_version,
				resolved_tools, access_snapshot_hash, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'grant-1',
        'platform',
        'client-agent',
        'admin-1',
        'admin-1',
        '[]',
        '{"tenantIds":["platform","tenant-1"]}',
        '["agent:write"]',
        'admin_pre_authorized',
        1,
        1,
        'active',
        'active',
        1,
        1,
        'ats-bulk',
        1,
        'asp-bulk',
        1,
        '[{"toolId":"admin.write.clients.metadata"}]',
        'a'.repeat(43),
        3_600_001,
      ]
    );
    const resolved = await resolveAgentBulkPlan({
      schemaVersion: 'authrim-agent-bulk-plan-v1',
      targetTenantIds: ['tenant-1'],
      canaryTenantIds: ['tenant-1'],
      plan: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-1',
            operation: 'admin.write.clients.metadata',
            toolContractVersion: '1',
            input: { client_id: 'client-1', client_name: 'Updated' },
            resourcePrecondition: 'per-tenant-validation',
          },
        ],
      },
    });
    const auditBase = {
      tenantId: 'platform',
      adminUserId: 'admin-1',
      resourceType: 'agent_bulk_plan',
      severity: 'info' as const,
      actorType: 'admin_user' as const,
      actorSub: 'admin_user:admin-1',
      metadata: {},
      createdAt: 1,
    };
    await repository.create({
      id: 'bulk-1',
      version: 1,
      controlTenantId: 'platform',
      grantId: 'grant-1',
      actorSub: 'machine:principal-1',
      clientId: 'client-agent',
      delegatorId: 'admin-1',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      machinePrincipalId: 'principal-1',
      machineCredentialId: 'credential-1',
      grantGeneration: 1,
      consentVersion: 1,
      resolved,
      expiresAt: 10_000,
      payloadPurgeAt: 20_000,
      now: 1,
      audit: {
        ...auditBase,
        id: 'audit-create',
        action: 'agent.bulk_plan.created',
        resourceId: 'bulk-1',
      },
    });
    await repository.transition({
      controlTenantId: 'platform',
      id: 'bulk-1',
      version: 1,
      from: 'draft',
      to: 'ready',
      stage: 'validate',
      now: 2,
      audit: {
        ...auditBase,
        id: 'audit-ready',
        action: 'agent.bulk_plan.validated',
        resourceId: 'bulk-1',
        createdAt: 2,
      },
    });
    await repository.startApproved({
      controlTenantId: 'platform',
      id: 'bulk-1',
      version: 1,
      definitionDigest: resolved.digest,
      targetSnapshotDigest: resolved.targetSnapshotDigest,
      canaryDigest: resolved.canaryDigest,
      approvedBy: 'admin-1',
      approvalDigest: 'approval-digest',
      now: 3,
      audit: {
        ...auditBase,
        id: 'audit-start',
        action: 'agent.bulk_plan.started',
        resourceId: 'bulk-1',
        createdAt: 3,
      },
    });

    const [child] = await repository.listRunnableTenantExecutions({
      controlTenantId: 'platform',
      bulkPlanId: 'bulk-1',
      bulkPlanVersion: 1,
    });
    expect(child).toMatchObject({ stage: 'validate', status: 'pending' });
    await expect(
      repository.claimTenant({
        controlTenantId: 'platform',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 1,
        executionId: child!.id,
        expectedStage: 'validate',
        ownerId: 'worker-1',
        leaseExpiresAt: 64_000,
        childCapabilityDigest: 'child-digest',
        childCapabilityExpiresAt: 64_000,
        now: 4_000,
      })
    ).resolves.toBe(true);
    const claimed = await repository.getTenantExecution('platform', 'bulk-1', 1, child!.id);
    expect(claimed).toMatchObject({ status: 'running', executionAttempt: 1, executionFence: 1 });
    await expect(
      repository.advanceTenantStage({
        controlTenantId: 'platform',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 1,
        executionId: child!.id,
        executionAttempt: 1,
        executionFence: 1,
        from: 'validate',
        to: 'apply',
        preconditionSnapshotDigest: 'snapshot-digest',
        checkpoint: { snapshots: [{ step_id: 'step-1', resource_version: 'version-1' }] },
        checkpointDigest: 'snapshot-digest',
        now: 5_000,
        audit: {
          ...auditBase,
          id: 'audit-validated',
          action: 'agent.bulk_tenant.validated',
          resourceId: child!.id,
          createdAt: 5_000,
        },
      })
    ).resolves.toBe(true);
    await expect(
      repository.claimTenant({
        controlTenantId: 'platform',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 1,
        executionId: child!.id,
        expectedStage: 'apply',
        ownerId: 'worker-2',
        leaseExpiresAt: 66_000,
        childCapabilityDigest: 'apply-digest',
        childCapabilityExpiresAt: 66_000,
        now: 6_000,
      })
    ).resolves.toBe(true);
    const applying = await repository.getTenantExecution('platform', 'bulk-1', 1, child!.id);
    await expect(
      repository.completeTenant({
        controlTenantId: 'platform',
        bulkPlanId: 'bulk-1',
        bulkPlanVersion: 1,
        executionId: child!.id,
        executionAttempt: applying!.executionAttempt,
        executionFence: applying!.executionFence,
        status: 'failed',
        failureKind: 'precondition_failed',
        now: 7_000,
        audit: {
          ...auditBase,
          id: 'audit-failed',
          action: 'agent.bulk_tenant.failed',
          resourceId: child!.id,
          createdAt: 7_000,
        },
      })
    ).resolves.toBe(true);
    await expect(repository.get('platform', 'bulk-1', 1)).resolves.toMatchObject({
      failedCount: 1,
    });
    await adapter.execute(
      `UPDATE agent_bulk_tenant_executions SET status = 'running', failure_kind = NULL,
        completed_at = NULL WHERE id = ?`,
      [child!.id]
    );
    await adapter.execute(
      `UPDATE agent_bulk_plans SET failed_count = 0 WHERE id = ? AND version = ?`,
      ['bulk-1', 1]
    );
    await expect(
      repository.cancel({
        controlTenantId: 'platform',
        id: 'bulk-1',
        version: 1,
        cancelledBy: 'admin-1',
        reason: 'operator_requested',
        now: 8_000,
        audit: {
          ...auditBase,
          id: 'audit-cancelled',
          action: 'agent.bulk_plan.cancelled',
          resourceId: 'bulk-1',
          createdAt: 8_000,
        },
      })
    ).resolves.toBe(true);
    await expect(repository.listRunning()).resolves.toEqual([]);
    await expect(repository.get('platform', 'bulk-1', 1)).resolves.toMatchObject({
      cancelledAt: 8_000,
      cancelledBy: 'admin-1',
      cancelReason: 'operator_requested',
      indeterminateCount: 1,
    });
    await expect(
      repository.getTenantExecution('platform', 'bulk-1', 1, child!.id)
    ).resolves.toMatchObject({ status: 'indeterminate', failureKind: 'plan_cancelled' });
    await expect(
      repository.transition({
        controlTenantId: 'platform',
        id: 'bulk-1',
        version: 1,
        from: 'running',
        to: 'paused',
        stage: 'apply',
        now: 9_000,
        audit: {
          ...auditBase,
          id: 'audit-after-cancel',
          action: 'agent.bulk_plan.paused',
          resourceId: 'bulk-1',
          createdAt: 9_000,
        },
      })
    ).resolves.toBe(false);
  });

  it('materializes an inactive template copy only from the exact completed Bulk Plan version', async () => {
    await adapter.execute(
      `INSERT INTO admin_agent_grants (
        id, tenant_id, client_id, grantor_id, delegator_id, permissions,
        resolved_scope_constraints, scopes, delegation_mode, generation,
				consent_version, status, active_uniqueness_key, created_at, updated_at,
				task_set_id, task_set_version, scope_policy_id, scope_policy_version,
				resolved_tools, access_snapshot_hash, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'grant-template',
        'platform',
        'client-agent',
        'admin-1',
        'admin-1',
        '[]',
        '{"tenantIds":["platform","tenant-1"]}',
        '["agent:write"]',
        'admin_pre_authorized',
        1,
        1,
        'active',
        'active',
        1,
        1,
        'ats-bulk',
        1,
        'asp-bulk',
        1,
        '[{"toolId":"admin.write.clients.metadata"}]',
        'b'.repeat(43),
        3_600_001,
      ]
    );
    const resolved = await resolveAgentBulkPlan({
      schemaVersion: 'authrim-agent-bulk-plan-v1',
      targetTenantIds: ['tenant-1'],
      canaryTenantIds: ['tenant-1'],
      plan: {
        schemaVersion: 'authrim-agent-plan-v1',
        goal: 'Apply an approved Authrim configuration change',
        steps: [
          {
            id: 'step-1',
            operation: 'admin.write.clients.metadata',
            toolContractVersion: '1',
            input: { client_id: 'client-1', client_name: 'Updated' },
            resourcePrecondition: 'per-tenant-validation',
          },
        ],
      },
    });
    const auditBase = {
      tenantId: 'platform',
      adminUserId: 'admin-1',
      resourceType: 'agent_bulk_plan',
      severity: 'info' as const,
      actorType: 'admin_user' as const,
      actorSub: 'admin_user:admin-1',
      metadata: {},
      createdAt: 1,
    };
    await repository.create({
      id: 'bulk-template',
      version: 1,
      controlTenantId: 'platform',
      grantId: 'grant-template',
      actorSub: 'machine:principal-1',
      clientId: 'client-agent',
      delegatorId: 'admin-1',
      actorMode: 'mode_b',
      actorAssurance: 'machine_key',
      tokenBinding: 'dpop',
      machinePrincipalId: 'principal-1',
      machineCredentialId: 'credential-1',
      grantGeneration: 1,
      consentVersion: 1,
      resolved,
      expiresAt: 10_000,
      payloadPurgeAt: 20_000,
      now: 1,
      audit: {
        ...auditBase,
        id: 'audit-template-plan',
        action: 'agent.bulk_plan.created',
        resourceId: 'bulk-template',
      },
    });
    await adapter.execute(
      "UPDATE agent_bulk_plans SET status = 'completed' WHERE id = 'bulk-template' AND version = 1"
    );
    await adapter.execute(
      "UPDATE agent_bulk_tenant_executions SET stage = 'verify', status = 'succeeded' WHERE bulk_plan_id = 'bulk-template' AND bulk_plan_version = 1"
    );

    const baselines = new AgentBaselineRepository(adapter);
    await baselines.publishTemplate({
      id: 'template-1',
      version: 1,
      sourceTenantId: 'platform',
      templateType: 'task_set',
      sourceObjectId: 'task-source',
      sourceObjectVersion: 3,
      definition: {
        name: 'Shared client configuration',
        description: 'Pinned template copy',
        catalog_version: 'catalog-1',
        tools: [{ toolId: 'admin.write.clients.metadata', contractVersion: '1' }],
        permissions: ['admin:clients:write'],
      },
      definitionDigest: 'template-definition-digest',
      publishedBy: 'admin-1',
      publishedAt: 2,
      audit: {
        ...auditBase,
        id: 'audit-template-publish',
        action: 'agent.template.published',
        resourceType: 'agent_configuration_template',
        resourceId: 'template-1',
        createdAt: 2,
      },
    });
    const copied = await baselines.copyTemplate({
      id: 'copy-1',
      templateId: 'template-1',
      templateVersion: 1,
      targetTenantId: 'tenant-1',
      targetObjectId: 'task-copy-1',
      bulkPlanId: 'bulk-template',
      bulkPlanVersion: 1,
      copiedBy: 'admin-1',
      copiedAt: 3,
      audit: {
        ...auditBase,
        id: 'audit-template-copy',
        action: 'agent.template.copied',
        resourceType: 'agent_template_copy',
        resourceId: 'copy-1',
        createdAt: 3,
      },
    });
    expect(copied).toBe(true);
    await expect(
      adapter.queryOne<{ tenant_id: string; status: string; kind: string }>(
        'SELECT tenant_id, status, kind FROM agent_task_sets WHERE id = ?',
        ['task-copy-1']
      )
    ).resolves.toEqual({ tenant_id: 'tenant-1', status: 'archived', kind: 'template_copy' });
    await expect(
      baselines.copyTemplate({
        id: 'copy-wrong-version',
        templateId: 'template-1',
        templateVersion: 1,
        targetTenantId: 'tenant-1',
        targetObjectId: 'task-copy-wrong-version',
        bulkPlanId: 'bulk-template',
        bulkPlanVersion: 2,
        copiedBy: 'admin-1',
        copiedAt: 4,
        audit: {
          ...auditBase,
          id: 'audit-template-copy-wrong-version',
          action: 'agent.template.copied',
          resourceType: 'agent_template_copy',
          resourceId: 'copy-wrong-version',
          createdAt: 4,
        },
      })
    ).resolves.toBe(false);
    await expect(
      adapter.queryOne('SELECT id FROM agent_task_sets WHERE id = ?', ['task-copy-wrong-version'])
    ).resolves.toBeNull();

    const baselineDefinition = {
      schemaVersion: 'authrim-agent-baseline-v1' as const,
      taskSet: { id: 'task-source', version: 3, digest: '1234567890abcdef' },
      configurationProfile: resolved.definition.plan,
    };
    await baselines.createBaseline({
      id: 'baseline-managed',
      version: 1,
      controlTenantId: 'platform',
      name: 'Managed client metadata',
      mode: 'managed',
      enforcement: 'standard_auto_remediation',
      definition: baselineDefinition,
      definitionDigest: 'baseline-definition-digest',
      createdBy: 'admin-1',
      createdAt: 5,
      audit: {
        ...auditBase,
        id: 'audit-baseline-create',
        action: 'agent.baseline.created',
        resourceType: 'agent_baseline',
        resourceId: 'baseline-managed',
        createdAt: 5,
      },
    });
    await expect(
      baselines.assignBaseline({
        id: 'assignment-managed',
        controlTenantId: 'platform',
        baselineId: 'baseline-managed',
        baselineVersion: 1,
        tenantId: 'tenant-1',
        sourceBulkPlanId: 'bulk-template',
        sourceBulkPlanVersion: 1,
        assignedBy: 'admin-1',
        assignedAt: 6,
        audit: {
          ...auditBase,
          id: 'audit-baseline-assign',
          action: 'agent.baseline.assigned',
          resourceType: 'agent_baseline_assignment',
          resourceId: 'assignment-managed',
          createdAt: 6,
        },
      })
    ).resolves.toBe(true);
    await expect(
      baselines.evaluateAssignment({
        controlTenantId: 'platform',
        assignmentId: 'assignment-managed',
        status: 'drifted',
        currentDigest: 'drift-digest-1',
        evaluatedAt: 7,
        audit: {
          ...auditBase,
          id: 'audit-baseline-evaluate',
          action: 'agent.baseline.drift_evaluated',
          resourceType: 'agent_baseline_assignment',
          resourceId: 'assignment-managed',
          createdAt: 7,
        },
      })
    ).resolves.toBe('drifted');
    await expect(
      baselines.reserveAutoRemediation({
        controlTenantId: 'platform',
        assignmentId: 'assignment-managed',
        driftDigest: 'drift-digest-1',
        bulkPlanId: 'remediation-1',
        bulkPlanVersion: 1,
        requestedAt: 8,
        audit: {
          ...auditBase,
          id: 'audit-remediation-1',
          action: 'agent.baseline.remediation_requested',
          resourceType: 'agent_baseline_assignment',
          resourceId: 'assignment-managed',
          createdAt: 8,
        },
      })
    ).resolves.toBe(true);
    await expect(
      baselines.reserveAutoRemediation({
        controlTenantId: 'platform',
        assignmentId: 'assignment-managed',
        driftDigest: 'drift-digest-1',
        bulkPlanId: 'remediation-duplicate',
        bulkPlanVersion: 1,
        requestedAt: 9,
        audit: {
          ...auditBase,
          id: 'audit-remediation-duplicate',
          action: 'agent.baseline.remediation_requested',
          resourceType: 'agent_baseline_assignment',
          resourceId: 'assignment-managed',
          createdAt: 9,
        },
      })
    ).resolves.toBe(false);
    await expect(
      baselines.evaluateAssignment({
        controlTenantId: 'platform',
        assignmentId: 'assignment-managed',
        status: 'drifted',
        currentDigest: 'drift-digest-2',
        evaluatedAt: 10,
        audit: {
          ...auditBase,
          id: 'audit-baseline-reevaluate',
          action: 'agent.baseline.drift_evaluated',
          resourceType: 'agent_baseline_assignment',
          resourceId: 'assignment-managed',
          createdAt: 10,
        },
      })
    ).resolves.toBe('drifted');
    await expect(
      baselines.reserveAutoRemediation({
        controlTenantId: 'platform',
        assignmentId: 'assignment-managed',
        driftDigest: 'drift-digest-2',
        bulkPlanId: 'remediation-concurrent',
        bulkPlanVersion: 1,
        requestedAt: 11,
        audit: {
          ...auditBase,
          id: 'audit-remediation-concurrent',
          action: 'agent.baseline.remediation_requested',
          resourceType: 'agent_baseline_assignment',
          resourceId: 'assignment-managed',
          createdAt: 11,
        },
      })
    ).resolves.toBe(false);
    await expect(baselines.listPendingAutoRemediations()).resolves.toEqual([
      { controlTenantId: 'platform', assignmentId: 'assignment-managed' },
    ]);
    await expect(
      baselines.createException({
        id: 'exception-during-remediation',
        controlTenantId: 'platform',
        assignmentId: 'assignment-managed',
        fields: ['client-metadata.client_name'],
        reason: 'Must not race an already approved remediation',
        approvedBy: 'admin-1',
        approvedAt: 12,
        expiresAt: 100_000,
        audit: {
          ...auditBase,
          id: 'audit-exception-during-remediation',
          action: 'agent.baseline.exception_approved',
          resourceType: 'agent_baseline_exception',
          resourceId: 'exception-during-remediation',
          createdAt: 12,
        },
      })
    ).resolves.toBe(false);
    await expect(
      adapter.queryOne<{ count: number }>(
        "SELECT COUNT(*) AS count FROM admin_audit_log WHERE action = 'agent.baseline.remediation_requested'"
      )
    ).resolves.toEqual({ count: 1 });
  });
});
