import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  PreparedStatement,
  QueryOptions,
  TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import { describe, expect, it } from 'vitest';
import { AdminAgentAccessRepository, AgentAccessConflictError } from '../repositories';

interface RecordedQuery {
  kind: 'query' | 'queryOne' | 'execute';
  sql: string;
  params?: unknown[];
}

class RecordingDatabaseAdapter implements DatabaseAdapter {
  readonly calls: RecordedQuery[] = [];
  queryResults: unknown[][] = [];
  queryOneResults: unknown[] = [];
  executeResults: ExecuteResult[] = [];

  async query<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T[]> {
    this.calls.push({ kind: 'query', sql, params });
    return (this.queryResults.shift() ?? []) as T[];
  }

  async queryOne<T>(sql: string, params?: unknown[], _options?: QueryOptions): Promise<T | null> {
    this.calls.push({ kind: 'queryOne', sql, params });
    return (this.queryOneResults.shift() ?? null) as T | null;
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    this.calls.push({ kind: 'execute', sql, params });
    return this.executeResults.shift() ?? { rowsAffected: 1, success: true };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    return fn({
      query: (sql, params) => this.query(sql, params),
      queryOne: (sql, params) => this.queryOne(sql, params),
      execute: (sql, params) => this.execute(sql, params),
    });
  }

  async batch(statements: PreparedStatement[]): Promise<ExecuteResult[]> {
    return Promise.all(
      statements.map((statement) => this.execute(statement.sql, statement.params))
    );
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'recording' };
  }

  getType(): string {
    return 'recording';
  }

  async close(): Promise<void> {}
}

describe('AdminAgentAccessRepository', () => {
  it('stores an active Grant with the explicit uniqueness key', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
    await repository.createGrant({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      clientId: 'client-1',
      grantorId: 'admin-1',
      delegatorId: 'admin-2',
      permissions: ['admin:users:read'],
      scopes: ['agent:read'],
      resolvedScopeConstraints: { tenantIds: ['tenant-1'] },
      consentVersion: 1,
      generation: 1,
      status: 'active',
      delegationMode: 'user_consent',
      taskSetId: 'ats_read-only',
      taskSetVersion: 1,
      scopePolicyId: 'asp_tenant-1',
      scopePolicyVersion: 1,
      resolvedTools: [
        {
          toolId: 'users.get',
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
    });

    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].sql).toContain('INSERT INTO admin_agent_grants');
    expect(adapter.calls[0].params).toContain('active');
  });

  it('resolves the one active Grant for an exact tenant, delegator, and client', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({
      id: 'grant-1',
      tenant_id: 'tenant-1',
      client_id: 'client-1',
      machine_principal_id: null,
      grantor_id: 'admin-1',
      delegator_id: 'admin-2',
      permissions: '["admin:users:read"]',
      scopes: '["agent:read"]',
      resolved_scope_constraints: '{"tenantIds":["tenant-1"]}',
      consent_version: 2,
      generation: 3,
      status: 'active',
      delegation_mode: 'user_consent',
      expires_at: null,
    });
    const repository = new AdminAgentAccessRepository(adapter);

    await expect(
      repository.findActiveGrantForDelegatorClient('tenant-1', 'admin-2', 'client-1')
    ).resolves.toMatchObject({
      grantId: 'grant-1',
      tenantId: 'tenant-1',
      delegatorId: 'admin-2',
      clientId: 'client-1',
      generation: 3,
    });
    expect(adapter.calls[0]).toMatchObject({
      kind: 'queryOne',
      params: ['tenant-1', 'admin-2', 'client-1'],
    });
    expect(adapter.calls[0].sql).toContain("active_uniqueness_key = 'active'");
  });

  it('resolves only current permissions for an active delegator', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({ id: 'admin-2' });
    adapter.queryResults.push([
      { permissions_json: '["admin:users:read"]' },
      { permissions_json: '["admin:clients:read","admin:users:read"]' },
    ]);
    const repository = new AdminAgentAccessRepository(adapter);

    await expect(
      repository.getActiveDelegatorPermissions('tenant-1', 'admin-2', 100)
    ).resolves.toEqual(['admin:users:read', 'admin:clients:read']);
    expect(adapter.calls[1].sql).toContain('WITH RECURSIVE effective_roles');
    expect(adapter.calls[1].params).toEqual([
      'admin-2',
      'tenant-1',
      'tenant-1',
      'tenant-1',
      100,
      'tenant-1',
    ]);
  });

  it('requires both current consent records', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryResults.push([
      {
        id: 'consent-1',
        tenant_id: 'tenant-1',
        consent_type: 'delegation',
        grant_id: 'grant-1',
        user_id: 'admin-1',
        client_id: 'client-1',
        consent_version: 2,
        scopes: '["agent:read"]',
        granted_at: 100,
        revoked_at: null,
        revoked_reason: null,
      },
      {
        id: 'consent-2',
        tenant_id: 'tenant-1',
        consent_type: 'oauth_client',
        grant_id: 'grant-1',
        user_id: 'admin-1',
        client_id: 'client-1',
        consent_version: 1,
        scopes: '["agent:read"]',
        granted_at: 100,
        revoked_at: null,
        revoked_reason: null,
      },
    ]);
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.hasCurrentConsent('tenant-1', 'grant-1', 'admin-1', 'client-1', 2)
    ).resolves.toBe(true);
  });

  it('records both consent types and their audit event in one repository transaction', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
    const base = {
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      userId: 'admin-1',
      clientId: 'client-1',
      consentVersion: 2,
      scopes: ['agent:read'] as ['agent:read'],
      grantedAt: 100,
    };

    await repository.grantConsentPair({
      delegation: { ...base, id: 'consent-delegation', type: 'delegation' },
      oauthClient: { ...base, id: 'consent-oauth', type: 'oauth_client' },
      audit: {
        id: 'audit-1',
        tenantId: 'tenant-1',
        adminUserId: 'admin-1',
        action: 'agent.consent.granted',
        resourceType: 'admin_agent_grant',
        resourceId: 'grant-1',
        severity: 'info',
        actorType: 'admin_user',
        actorSub: 'admin_user:admin-1',
        grantId: 'grant-1',
        metadata: { consent_version: 2 },
        createdAt: 100,
      },
    });

    const writes = adapter.calls.filter((call) => call.kind === 'execute');
    expect(writes).toHaveLength(3);
    expect(writes[0].sql).toContain('INSERT INTO agent_consents');
    expect(writes[0].params).toContain('delegation');
    expect(writes[1].sql).toContain('INSERT INTO agent_consents');
    expect(writes[1].params).toContain('oauth_client');
    expect(writes[2].sql).toContain('INSERT INTO admin_audit_log');
    expect(writes[2].params).toContain('agent.consent.granted');
  });

  it('claims elevation with attempt and fence increments in one transaction', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({
      id: 'challenge-1',
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      status: 'executing',
      execution_attempt: 2,
      execution_fence: 4,
      execution_owner_id: 'worker-1',
      execution_lease_expires_at: 160,
    });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.claimElevationExecution('tenant-1', 'challenge-1', 'worker-1', 100, 160)
    ).resolves.toEqual({
      id: 'challenge-1',
      attempt: 2,
      fence: 4,
      ownerId: 'worker-1',
      leaseExpiresAt: 160,
    });
    expect(adapter.calls[0].sql).toContain('execution_attempt = execution_attempt + 1');
    expect(adapter.calls[0].sql).toContain('execution_fence = execution_fence + 1');
  });

  it('rejects stale elevation completion fences', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.executeResults.push({ rowsAffected: 0, success: true });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.completeElevationExecution({
        tenantId: 'tenant-1',
        challengeId: 'challenge-1',
        ownerId: 'old-worker',
        attempt: 1,
        fence: 1,
        status: 'consumed',
        completedAt: 200,
      })
    ).resolves.toBe(false);
  });

  it('reconciles stale elevation only for the observed attempt and fence', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.executeResults.push({ rowsAffected: 0, success: true });
    const repository = new AdminAgentAccessRepository(adapter);
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
          id: 'audit-1',
          tenantId: 'tenant-1',
          action: 'agent.elevation.indeterminate',
          resourceType: 'agent_elevation_challenge',
          resourceId: 'challenge-1',
          severity: 'warning',
          actorType: 'system',
          actorSub: 'system:reconciler-1',
          grantId: 'grant-1',
          elevationId: 'challenge-1',
          metadata: {},
          createdAt: 201,
        },
      })
    ).resolves.toBe(false);
    expect(adapter.calls[0].sql).toContain("status = 'executing'");
    expect(adapter.calls[0].sql).toContain('execution_lease_expires_at < ?');
    expect(adapter.calls[0].params).toEqual([
      'indeterminate',
      null,
      null,
      'indeterminate',
      201,
      201,
      'audit-1',
      'tenant-1',
      'challenge-1',
      200,
      2,
      4,
    ]);
  });

  it('writes the machine recovery audit only when the stale transition CAS succeeds', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.reconcileStaleElevation({
        tenantId: 'tenant-1',
        challengeId: 'challenge-1',
        expectedAttempt: 2,
        expectedFence: 4,
        staleBefore: 200,
        status: 'consumed',
        resultDigest: 'result-digest',
        reconciledAt: 201,
        audit: {
          id: 'audit-1',
          tenantId: 'tenant-1',
          action: 'agent.elevation.recovered',
          resourceType: 'agent_elevation_challenge',
          resourceId: 'challenge-1',
          severity: 'info',
          actorType: 'system',
          actorSub: 'system:reconciler-1',
          grantId: 'grant-1',
          elevationId: 'challenge-1',
          metadata: { idempotency_status: 'succeeded' },
          createdAt: 201,
        },
      })
    ).resolves.toBe(true);

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0].sql).toContain('UPDATE agent_elevation_challenges');
    expect(adapter.calls[1].sql).toContain('INSERT INTO admin_audit_log');
    expect(adapter.calls[1].params).toContain('agent.elevation.recovered');
  });

  it('permits only the first reviewed idempotent retry claim', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({
      id: 'challenge-1',
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      status: 'executing',
      execution_attempt: 3,
      execution_fence: 5,
      execution_owner_id: 'retry-worker',
      execution_lease_expires_at: 260,
      retry_count: 1,
    });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.claimStaleElevationRetry({
        tenantId: 'tenant-1',
        challengeId: 'challenge-1',
        expectedAttempt: 2,
        expectedFence: 4,
        staleBefore: 200,
        now: 201,
        ownerId: 'retry-worker',
        leaseExpiresAt: 260,
      })
    ).resolves.toMatchObject({ attempt: 3, fence: 5, ownerId: 'retry-worker' });
    expect(adapter.calls[0].sql).toContain('retry_count = 0');
    expect(adapter.calls[0].sql).toContain('retry_count = retry_count + 1');
  });

  it('stores and resolves the exact Management execution attempt and fence', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({
      operation: 'users.delete',
      request_digest: 'request-digest',
      status: 'succeeded',
      lease_expires_at: 160,
      result_envelope: '{"status":204}',
      result_digest: 'result-digest',
    });
    const repository = new AdminAgentAccessRepository(adapter);

    await expect(
      repository.beginManagementExecution({
        tenantId: 'tenant-1',
        idempotencyKey: 'challenge-1',
        executionAttempt: 2,
        executionFence: 4,
        operation: 'users.delete',
        requestDigest: 'request-digest',
        leaseExpiresAt: 160,
        createdAt: 100,
      })
    ).resolves.toBe(true);
    await expect(
      repository.lookupManagementExecution({
        tenantId: 'tenant-1',
        idempotencyKey: 'challenge-1',
        executionAttempt: 2,
        executionFence: 4,
      })
    ).resolves.toEqual({
      status: 'succeeded',
      operation: 'users.delete',
      requestDigest: 'request-digest',
      resultEnvelope: '{"status":204}',
      resultDigest: 'result-digest',
    });

    expect(adapter.calls[0].sql).toContain('INSERT OR IGNORE INTO agent_management_executions');
    expect(adapter.calls[1].params).toEqual(['tenant-1', 'challenge-1', 2, 4]);
  });

  it('commits human reconciliation evidence and audit through one guarded batch', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.reconcileIndeterminateElevation({
        tenantId: 'tenant-1',
        challengeId: 'challenge-1',
        reconciledBy: 'admin-2',
        outcome: 'executed',
        evidenceEnvelope: 'encrypted-evidence',
        evidenceDigest: 'evidence-digest',
        reconciledAt: 200,
        audit: {
          id: 'audit-reconcile-1',
          tenantId: 'tenant-1',
          adminUserId: 'admin-2',
          action: 'agent.elevation.reconciled',
          resourceType: 'agent_elevation',
          resourceId: 'challenge-1',
          severity: 'warn',
          actorType: 'admin_user',
          actorSub: 'admin_user:admin-2',
          grantId: 'grant-1',
          elevationId: 'challenge-1',
          metadata: { outcome: 'executed' },
          createdAt: 200,
        },
      })
    ).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain("status = 'indeterminate'");
    expect(adapter.calls[0].sql).toContain("reconciled_outcome = 'unresolved'");
    expect(adapter.calls[1].sql).toContain('INSERT INTO admin_audit_log');
    expect(adapter.calls[1].sql).toContain('reconciled_outcome = ?');
  });

  it('treats a missing Management execution fence as unknown, never not executed', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.lookupManagementExecution({
        tenantId: 'tenant-1',
        idempotencyKey: 'challenge-1',
        executionAttempt: 1,
        executionFence: 1,
      })
    ).resolves.toEqual({ status: 'not_found' });
  });

  it('crypto-erases expired terminal payloads without deleting hashes or audit identity', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(repository.purgeExpiredElevationPayloads(500)).resolves.toBe(1);
    expect(adapter.calls[0].sql).toContain('args_envelope = NULL');
    expect(adapter.calls[0].sql).toContain('reconciliation_evidence_envelope = NULL');
    expect(adapter.calls[0].sql).not.toContain('args_hash = NULL');
    expect(adapter.calls[0].params).toEqual([500, 500]);
  });

  it('rejects completion from an obsolete Management execution fence', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.executeResults.push({ rowsAffected: 0, success: true });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.completeManagementExecution({
        tenantId: 'tenant-1',
        idempotencyKey: 'challenge-1',
        executionAttempt: 1,
        executionFence: 1,
        status: 'succeeded',
        resultDigest: 'result-digest',
        completedAt: 200,
      })
    ).resolves.toBe(false);
    expect(adapter.calls[0].sql).toContain("status = 'in_progress'");
  });

  it('finalizes a token family only through the Grant and both consent fences', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
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
        now: 100,
      })
    ).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain('UPDATE admin_agent_token_families AS f');
    expect(adapter.calls[0].sql).toContain('g.generation = f.grant_generation');
    expect(adapter.calls[0].sql).toContain("c.consent_type = 'delegation'");
    expect(adapter.calls[0].sql).toContain("c.consent_type = 'oauth_client'");
  });

  it('consumes a Mode B delegation JWT identifier only through INSERT OR IGNORE', async () => {
    const adapter = new RecordingDatabaseAdapter();
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.consumeModeBDelegationJti({
        jti: 'adj-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        machinePrincipalId: 'amp-1',
        expiresAt: 500,
        consumedAt: 100,
      })
    ).resolves.toBe(true);
    expect(adapter.calls[0].sql).toContain('INSERT OR IGNORE INTO admin_agent_delegation_jtis');

    adapter.executeResults.push({ rowsAffected: 0, success: true });
    await expect(
      repository.consumeModeBDelegationJti({
        jti: 'adj-1',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        machinePrincipalId: 'amp-1',
        expiresAt: 500,
        consumedAt: 101,
      })
    ).resolves.toBe(false);
  });

  it('fails token-family finalization closed when a concurrent change wins', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.executeResults.push({ rowsAffected: 0, success: true });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.finalizeTokenFamily({
        familyId: 'family-1',
        finalizationNonce: 'stale-nonce',
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        grantGeneration: 2,
        adminUserId: 'admin-1',
        clientId: 'client-1',
        consentVersion: 2,
        now: 100,
      })
    ).resolves.toBe(false);
  });

  it('claims an expired outbox lease with a new owner and fencing token', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({
      id: 'outbox-1',
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      grant_generation: 2,
      client_id: 'client-1',
      event_type: 'revoke_grant_families',
      payload: '{"family_ids":["family-1"],"family_jtis":["jti-1"],"reason":"grant_revoked"}',
      status: 'processing',
      attempt_count: 2,
      processing_fence: 5,
      processing_owner_id: 'worker-2',
      processing_lease_expires_at: 260,
    });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.claimTokenRevocationOutbox({
        outboxId: 'outbox-1',
        ownerId: 'worker-2',
        now: 200,
        leaseExpiresAt: 260,
      })
    ).resolves.toMatchObject({
      id: 'outbox-1',
      attempt: 2,
      fence: 5,
      familyIds: ['family-1'],
      familyJtis: ['jti-1'],
    });
    expect(adapter.calls[0].sql).toContain('processing_fence = processing_fence + 1');
    expect(adapter.calls[0].sql).toContain('processing_lease_expires_at < ?');
  });

  it('fails closed on a stored outbox payload whose family IDs and locators diverge', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({
      id: 'outbox-1',
      tenant_id: 'tenant-1',
      grant_id: 'grant-1',
      grant_generation: 2,
      client_id: 'client-1',
      event_type: 'revoke_grant_families',
      payload:
        '{"family_ids":["family-1","family-2"],"family_jtis":["jti-1"],"reason":"grant_revoked"}',
      status: 'processing',
      attempt_count: 1,
      processing_fence: 1,
      processing_owner_id: 'worker-1',
      processing_lease_expires_at: 260,
    });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.claimTokenRevocationOutbox({
        outboxId: 'outbox-1',
        ownerId: 'worker-1',
        now: 200,
        leaseExpiresAt: 260,
      })
    ).rejects.toThrow('payload is invalid');
  });

  it('does not update token families when outbox ownership is stale', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.executeResults.push(
      { rowsAffected: 0, success: true },
      { rowsAffected: 0, success: true }
    );
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.completeTokenRevocationOutbox({
        outboxId: 'outbox-1',
        tenantId: 'tenant-1',
        ownerId: 'old-worker',
        fence: 1,
        completionId: 'completion-1',
        familyIds: ['family-1'],
        completedAt: 300,
      })
    ).resolves.toBe(false);
    expect(adapter.calls).toHaveLength(3);
    expect(adapter.calls[0].sql).toContain('completion_transition_id = ?');
    expect(adapter.calls[1].sql).toContain('completion_transition_id = ?');
    expect(adapter.calls[1].sql).toContain('EXISTS');
  });

  it('moves a fenced outbox failure to dead letter at the attempt ceiling', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.queryOneResults.push({ attempt_count: 8 });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.failTokenRevocationOutbox({
        outboxId: 'outbox-1',
        tenantId: 'tenant-1',
        ownerId: 'worker-1',
        fence: 7,
        expectedAttempt: 8,
        nextAttemptAt: 500,
        maxAttempts: 8,
        deadLetterAudit: {
          id: 'audit-1',
          tenantId: 'tenant-1',
          action: 'agent.token.revocation.dead_letter',
          resourceType: 'admin_agent_token_revocation_outbox',
          resourceId: 'outbox-1',
          severity: 'critical',
          actorType: 'system',
          actorSub: 'system:test-revoker',
          metadata: { attempt_count: 8 },
          createdAt: 500,
        },
      })
    ).resolves.toBe('dead_letter');
    expect(adapter.calls[0].params?.[0]).toBe('dead_letter');
    expect(adapter.calls[1].sql).toContain('INSERT INTO admin_audit_log');
    expect(adapter.calls[1].sql).toContain('failure_transition_id = ?');
  });

  it('invalidates a Grant, snapshots old-generation families, queues revocation, and audits atomically', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.executeResults.push(
      { rowsAffected: 1, success: true },
      { rowsAffected: 2, success: true },
      { rowsAffected: 2, success: true },
      { rowsAffected: 1, success: true },
      { rowsAffected: 1, success: true }
    );
    adapter.queryOneResults.push({
      payload:
        '{"family_ids":["family-1","family-2"],"family_jtis":["jti-1","jti-2"],"reason":"grant_revoked"}',
    });
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.invalidateGrantAndQueueTokenRevocation({
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
          requestId: 'request-1',
          actorType: 'admin_user',
          actorSub: 'admin_user:admin-1',
          metadata: {},
          createdAt: 200,
        },
      })
    ).resolves.toEqual({ familyCount: 2, nextGeneration: 4 });

    expect(adapter.calls.map((call) => call.kind)).toEqual([
      'execute',
      'execute',
      'execute',
      'execute',
      'execute',
      'queryOne',
    ]);
    expect(adapter.calls[0].sql).toContain('generation = generation + 1');
    expect(adapter.calls[0].sql).toContain('last_mutation_id = ?');
    expect(adapter.calls[2].sql).toContain('revocation_outbox_id = ?');
    expect(adapter.calls[3].sql).toContain('json_group_array(family_id)');
    expect(adapter.calls[4].sql).toContain('INSERT INTO admin_audit_log');
    expect(adapter.calls[4].sql).toContain('last_mutation_id = ?');
  });

  it('stops before consent, family, outbox, or audit writes when Grant generation is stale', async () => {
    const adapter = new RecordingDatabaseAdapter();
    adapter.executeResults.push(
      { rowsAffected: 0, success: true },
      { rowsAffected: 0, success: true },
      { rowsAffected: 0, success: true },
      { rowsAffected: 0, success: true },
      { rowsAffected: 0, success: true }
    );
    const repository = new AdminAgentAccessRepository(adapter);
    await expect(
      repository.invalidateGrantAndQueueTokenRevocation({
        tenantId: 'tenant-1',
        grantId: 'grant-1',
        clientId: 'client-1',
        expectedGeneration: 2,
        status: 'suspended',
        reason: 'grant_updated',
        outboxId: 'outbox-1',
        now: 200,
        audit: {
          id: 'audit-1',
          tenantId: 'tenant-1',
          action: 'agent.grant.suspended',
          resourceType: 'agent_grant',
          resourceId: 'grant-1',
          severity: 'warn',
          actorType: 'system',
          actorSub: 'system:cimd',
          metadata: {},
          createdAt: 200,
        },
      })
    ).rejects.toBeInstanceOf(AgentAccessConflictError);
    expect(adapter.calls).toHaveLength(6);
    expect(adapter.calls.slice(1).every((call) => call.sql.includes('last_mutation_id'))).toBe(
      true
    );
  });
});
