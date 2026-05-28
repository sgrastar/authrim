import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type {
  DatabaseAdapter,
  ExecuteResult,
  Env,
  HealthStatus,
  TransactionContext,
} from '@authrim/ar-lib-core';
import {
  adminIdentityMappingProtocolSchemasListHandler,
  adminIdentityMappingPoliciesListHandler,
  adminIdentityMappingPolicyCreateHandler,
  IdentityMappingControlPlaneRepository,
} from '../identity-mapping-control-plane';

interface RecordedExecute {
  sql: string;
  params: unknown[];
}

function createAdapter(options: {
  queryRows?: Record<string, unknown>[];
  queryOneRows?: Array<Record<string, unknown> | null>;
}): DatabaseAdapter & { executes: RecordedExecute[] } {
  const executes: RecordedExecute[] = [];
  const queryRows = [...(options.queryRows ?? [])];
  const queryOneRows = [...(options.queryOneRows ?? [])];
  const executeResult: ExecuteResult = { rowsAffected: 1, success: true };
  return {
    executes,
    async query<T>(): Promise<T[]> {
      return queryRows as T[];
    },
    async queryOne<T>(): Promise<T | null> {
      return (queryOneRows.shift() ?? null) as T | null;
    },
    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
      executes.push({ sql, params });
      return executeResult;
    },
    async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
      return fn(this);
    },
    async batch(): Promise<ExecuteResult[]> {
      return [];
    },
    async isHealthy(): Promise<HealthStatus> {
      return { healthy: true, latencyMs: 1, type: 'test' };
    },
    getType(): string {
      return 'test';
    },
    async close(): Promise<void> {},
  };
}

const catalogEntry = {
  id: 'field.canonical.email',
  namespace: 'authrim.profile',
  path: 'email',
  targetType: 'canonical' as const,
  valueType: 'string',
  cardinality: 'single' as const,
  classification: 'pii' as const,
};

describe('IdentityMappingControlPlaneRepository catalog operations', () => {
  it('stores deterministic catalog metadata and entries', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.createCatalog('tenant_a', {
      catalogKey: 'default',
      displayName: 'Default Catalog',
      versionLabel: '2026-05-28',
      entries: [catalogEntry],
      customEntries: [
        {
          customKey: 'custom.department',
          displayName: 'Department',
          valueType: 'string',
          classification: 'internal',
        },
      ],
    });

    expect(result.catalogKey).toBe('default');
    expect(result.activeVersion.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO field_catalogs'),
      expect.stringContaining('INSERT INTO field_catalog_versions'),
      expect.stringContaining('INSERT INTO field_catalog_entries'),
      expect.stringContaining('INSERT INTO custom_field_catalog_entries'),
    ]);
  });

  it('rejects custom fields that shadow built-in catalog fields', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createCatalog('tenant_a', {
        catalogKey: 'default',
        displayName: 'Default Catalog',
        versionLabel: '2026-05-28',
        entries: [catalogEntry],
        customEntries: [
          {
            customKey: 'field.canonical.email',
            displayName: 'Email Shadow',
            valueType: 'string',
          },
        ],
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository policy activation', () => {
  it('compiles a load-time verified snapshot with dependency graph hash', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'policy_version_1',
          tenant_id: 'tenant_a',
          policy_set_id: 'policy_1',
          version_label: 'v1',
          lifecycle_state: 'published',
          policy_hash: 'policy_hash_1',
          compatibility_range: '^1',
        },
        {
          id: 'catalog_version_1',
          tenant_id: 'tenant_a',
          catalog_id: 'catalog_1',
          version_label: 'v1',
          bundle_hash: 'catalog_hash_1',
          compatibility_range: '^1',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.compilePolicyVersion(
      'tenant_a',
      'policy_1',
      'policy_version_1',
      {
        catalogVersionId: 'catalog_version_1',
      }
    );

    expect(result.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.snapshotHash).not.toBe('policy_hash_1');
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO dependency_graph_snapshots'),
      expect.stringContaining('INSERT INTO compiled_mapping_snapshots'),
    ]);
    const snapshotMetadata = String(adapter.executes[1].params[11]);
    expect(snapshotMetadata).toContain('"loadTimeHashVerified":true');
    expect(snapshotMetadata).toContain('"dependencyGraphId"');
  });

  it('blocks activation when another holder has an unexpired lease', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'policy_version_1',
          tenant_id: 'tenant_a',
          policy_set_id: 'policy_1',
          version_label: 'v1',
          lifecycle_state: 'published',
          policy_hash: 'policy_hash_1',
        },
        {
          id: 'snapshot_1',
          tenant_id: 'tenant_a',
          policy_version_id: 'policy_version_1',
          catalog_version_id: 'catalog_version_1',
          snapshot_hash: 'snapshot_hash_1',
          lifecycle_state: 'draft',
        },
        {
          holder_id: 'other-holder',
          expires_at: 2000,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.activatePolicyVersion('tenant_a', 'policy_1', 'policy_version_1', {
        snapshotId: 'snapshot_1',
        activationScope: { kind: 'tenant', id: 'tenant_a' },
        holderId: 'current-holder',
      })
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('prevents idempotency-key reuse with a different request hash', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          request_hash: 'previous_hash',
          response_ref: null,
          status: 'in_progress',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.runIdempotent(
        'tenant_a',
        'policy.create',
        'idem-1',
        { policyKey: 'new' },
        async () => ({
          id: 'policy_1',
        })
      )
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects sensitive policy metadata before persistence', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'policy_1',
          tenant_id: 'tenant_a',
          policy_key: 'default',
          display_name: 'Default policy',
          description: null,
          lifecycle_state: 'draft',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createPolicyVersion('tenant_a', 'policy_1', {
        versionLabel: 'v1',
        rules: [
          {
            ruleKey: 'unsafe',
            ruleKind: 'mapping',
            action: 'allow',
            metadata: {
              rawValue: 'person@example.test',
            },
          },
        ],
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository identity registry operations', () => {
  it('stores source authority contracts and queues projection work without raw values', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const authority = await repository.createSourceAuthorityContract('tenant_a', {
      sourceType: 'scim',
      sourceId: 'scim-directory',
      fieldRef: { namespace: 'authrim.profile', path: 'email' },
      authorityActions: ['write', 'verify'],
      condition: { assuranceLevel: 'ial2' },
      priority: 10,
    });
    const event = await repository.recordMappingEvent('tenant_a', {
      eventType: 'identity.binding.matched',
      sourceId: 'scim-directory',
      subjectId: 'subject-1',
      outcome: 'matched',
      reasonCodes: ['identity.hard_match'],
      traceRef: 'trace://identity/1',
    });
    const outbox = await repository.enqueueProjectionOutbox('tenant_a', {
      eventType: 'subject.updated',
      subjectId: 'subject-1',
      aggregateType: 'identity_subject',
      aggregateId: 'subject-1',
      payload: { changedFields: ['email'] },
    });

    expect(authority.priority).toBe(10);
    expect(event.reasonCodes).toEqual(['identity.hard_match']);
    expect(outbox.status).toBe('pending');
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO source_authority_contracts'),
      expect.stringContaining('INSERT INTO mapping_events'),
      expect.stringContaining('INSERT INTO projection_outbox'),
    ]);
  });

  it('evaluates source authority contracts by source, action, and field ref', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'authority-1',
          tenant_id: 'tenant_a',
          source_type: 'scim',
          source_id: 'scim-directory',
          field_ref_json: JSON.stringify({ namespace: 'authrim.profile', path: 'email' }),
          authority_actions_json: JSON.stringify(['write', 'verify']),
          condition_json: null,
          priority: 10,
          lifecycle_state: 'active',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateSourceAuthorityContract('tenant_a', {
        sourceType: 'scim',
        sourceId: 'scim-directory',
        fieldRef: { path: 'email', namespace: 'authrim.profile' },
        authorityAction: 'write',
      })
    ).resolves.toMatchObject({
      allowed: true,
      contractId: 'authority-1',
      reasonCode: 'source_authority.allowed',
    });

    await expect(
      repository.evaluateSourceAuthorityContract('tenant_a', {
        sourceType: 'scim',
        sourceId: 'scim-directory',
        fieldRef: { namespace: 'authrim.profile', path: 'email' },
        authorityAction: 'revoke',
      })
    ).resolves.toMatchObject({
      allowed: false,
      contractId: null,
      reasonCode: 'source_authority.no_matching_active_contract',
    });
  });

  it('creates replay and projection jobs with safe scoped payloads', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const projectionJob = await repository.createProjectionJob('tenant_a', {
      jobType: 'tenant_discovery_rebuild',
      scope: { tenantId: 'tenant_a', subjectIds: ['subject-1'] },
    });
    const replayJob = await repository.createReplayJob('tenant_a', {
      replayType: 'mapping_policy_impact',
      impactScope: { policyVersionId: 'policy-version-1' },
    });
    const projection = await repository.upsertAdminSearchProjection('tenant_a', {
      id: 'projection-1',
      subjectId: 'subject-1',
      projectionKind: 'identity_summary',
      projection: { displayLabel: 'Ada L.', matchReasons: ['email_domain'] },
      classification: 'internal',
    });

    expect(projectionJob.status).toBe('queued');
    expect(replayJob.status).toBe('queued');
    expect(projection.id).toBe('projection-1');
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO projection_jobs'),
      expect.stringContaining('INSERT INTO replay_jobs'),
      expect.stringContaining('INSERT INTO admin_search_projections'),
    ]);
  });

  it('rejects sensitive projection and outbox payloads', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.enqueueProjectionOutbox('tenant_a', {
        eventType: 'subject.updated',
        aggregateType: 'identity_subject',
        aggregateId: 'subject-1',
        payload: { rawValue: 'person@example.edu' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    await expect(
      repository.upsertAdminSearchProjection('tenant_a', {
        projectionKind: 'identity_summary',
        projection: { token: 'secret-token' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository review and notification operations', () => {
  it('creates redacted review tasks and records idempotent state transitions', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'review-task-1',
          status: 'open',
          subject_id: 'subject-1',
          account_id: 'account-1',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const task = await repository.createReviewTask('tenant_a', {
      taskType: 'identity_link_review',
      subjectId: 'subject-1',
      accountId: 'account-1',
      priority: 20,
      payload: {
        source: 'saml',
        destination: 'oidc',
        riskSummary: 'verified-anchor candidate requires admin approval',
      },
    });
    const transition = await repository.transitionReviewTask('tenant_a', 'review-task-1', {
      status: 'approved',
      assignedTo: 'admin-1',
      reasonCodes: ['admin_approved_candidate_link'],
    });

    expect(task.status).toBe('open');
    expect(transition).toMatchObject({
      previousStatus: 'open',
      status: 'approved',
      idempotent: false,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO review_tasks'),
      expect.stringContaining('UPDATE review_tasks'),
      expect.stringContaining('INSERT INTO mapping_events'),
    ]);
  });

  it('groups bulk review impact without storing raw values', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const group = await repository.createReviewTaskGroup('tenant_a', {
      groupKey: 'bulk-impact:policy-version-1',
      summary: {
        affectedTenant: 'tenant_a',
        source: 'scim-directory',
        destination: 'saml-sp',
        affectedSubjects: 35,
        risk: 'medium',
      },
    });

    expect(group.groupKey).toBe('bulk-impact:policy-version-1');
    expect(adapter.executes[0].sql).toContain('INSERT INTO review_task_groups');
    expect(String(adapter.executes[0].params[4])).toContain('"affectedSubjects":35');
  });

  it('creates operational notification state for high priority identity mapping events', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const notification = await repository.enqueueOperationalNotification('tenant_a', {
      category: 'identity_mapping_manual_review',
      eventType: 'identity_mapping.review_required',
      severity: 'high',
      subjectType: 'review_task',
      subjectId: 'review-task-1',
      deduplicationKey: 'review-task-1:manual-review',
      payload: {
        reviewTaskId: 'review-task-1',
        reasonCodes: ['candidate_requires_admin_approval'],
      },
    });

    expect(notification).toMatchObject({
      state: 'open',
      severity: 'high',
      category: 'identity_mapping_manual_review',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO internal_notification_events'),
      expect.stringContaining('INSERT INTO operational_notification_states'),
    ]);
    expect(adapter.executes[0].params[6]).toBe('tenant_a:review-task-1:manual-review');
  });

  it('returns an existing operational notification state for duplicate deduplication keys', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'notification-state-1',
          notification_event_id: 'notification-event-1',
          state: 'open',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const notification = await repository.enqueueOperationalNotification('tenant_a', {
      category: 'identity_mapping_manual_review',
      eventType: 'identity_mapping.review_required',
      severity: 'high',
      subjectType: 'review_task',
      subjectId: 'review-task-1',
      deduplicationKey: 'review-task-1:manual-review',
      payload: {
        reviewTaskId: 'review-task-1',
        reasonCodes: ['candidate_requires_admin_approval'],
      },
    });

    expect(notification).toMatchObject({
      id: 'notification-state-1',
      notificationEventId: 'notification-event-1',
      idempotent: true,
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('acknowledges and resolves operational notification states idempotently', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'notification-state-1',
          state: 'open',
        },
        {
          id: 'notification-state-1',
          state: 'resolved',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.transitionOperationalNotificationState('tenant_a', 'notification-state-1', {
        state: 'resolved',
        assignedTo: 'admin-1',
      })
    ).resolves.toMatchObject({
      previousState: 'open',
      state: 'resolved',
      idempotent: false,
    });
    await expect(
      repository.transitionOperationalNotificationState('tenant_a', 'notification-state-1', {
        state: 'resolved',
      })
    ).resolves.toMatchObject({
      state: 'resolved',
      idempotent: true,
    });
    expect(adapter.executes).toHaveLength(1);
    expect(adapter.executes[0].sql).toContain('UPDATE operational_notification_states');
  });

  it('rejects raw values in review and notification payloads', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createReviewTask('tenant_a', {
        taskType: 'release_review',
        payload: { email: 'person@example.edu' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    await expect(
      repository.enqueueOperationalNotification('tenant_a', {
        category: 'identity_mapping_signal',
        eventType: 'identity_mapping.high_signal',
        severity: 'critical',
        subjectType: 'subject',
        subjectId: 'subject-1',
        payload: { token: 'secret-token' },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects unsupported review statuses and notification categories before storage', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'review-task-1',
          status: 'open',
          subject_id: 'subject-1',
          account_id: null,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.transitionReviewTask('tenant_a', 'review-task-1', {
        status: 'raw_user_supplied_status',
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    await expect(
      repository.enqueueOperationalNotification('tenant_a', {
        category: 'storage_registry_security',
        eventType: 'identity_mapping.review_required',
        severity: 'high',
        subjectType: 'review_task',
        subjectId: 'review-task-1',
        payload: {
          reviewTaskId: 'review-task-1',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository provisioning assignment operations', () => {
  it('creates groups, memberships, entitlements, and ownership records', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'group-1',
          group_key: 'faculty',
          display_name: 'Faculty',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createGroup('tenant_a', {
        groupKey: 'faculty',
        displayName: 'Faculty',
        metadata: {
          source: 'provisioning',
        },
      })
    ).resolves.toMatchObject({
      id: 'group-1',
      groupKey: 'faculty',
    });
    await repository.createGroupMembership('tenant_a', {
      groupId: 'group-1',
      subjectId: 'subject-1',
      assignmentSource: 'rule:assignment-rule-1',
      ownershipPolicy: 'source_owned',
      revokePolicy: 'review',
    });
    await repository.grantEntitlement('tenant_a', {
      subjectId: 'subject-1',
      entitlementType: 'permission',
      entitlementKey: 'profile:read',
      sourceId: 'assignment-rule-1',
      revokePolicy: 'auto',
    });

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO "groups"'),
      expect.stringContaining('INSERT INTO group_memberships'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
      expect.stringContaining('INSERT INTO entitlements'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
    ]);
  });

  it('updates existing subject-only assignments before inserting duplicates', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'existing-membership',
        },
        null,
        {
          id: 'existing-entitlement',
        },
        null,
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createGroupMembership('tenant_a', {
        groupId: 'group-1',
        subjectId: 'subject-1',
        assignmentSource: 'rule:assignment-rule-1',
      })
    ).resolves.toMatchObject({
      id: 'existing-membership',
    });
    await expect(
      repository.grantEntitlement('tenant_a', {
        subjectId: 'subject-1',
        entitlementType: 'permission',
        entitlementKey: 'profile:read',
      })
    ).resolves.toMatchObject({
      id: 'existing-entitlement',
    });

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('UPDATE group_memberships'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
      expect.stringContaining('UPDATE entitlements'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
    ]);
  });

  it('evaluates conditional assignment and grants a group on import, JIT, or registration context', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'group',
          target_id: 'group-1',
          condition_json: JSON.stringify({
            eventTypes: ['import', 'jit', 'registration'],
            sourceTypes: ['scim'],
            domains: ['example.edu'],
          }),
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const evaluation = await repository.evaluateProvisioningAssignmentRule(
      'tenant_a',
      'assignment-rule-1',
      {
        eventType: 'jit',
        sourceType: 'scim',
        domain: 'example.edu',
        subjectId: 'subject-1',
      }
    );

    expect(evaluation).toMatchObject({
      matched: true,
      outcome: 'assigned',
      targetType: 'group',
      targetId: 'group-1',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO group_memberships'),
      expect.stringContaining('INSERT INTO provisioning_assignment_ownership'),
      expect.stringContaining('INSERT INTO provisioning_assignment_events'),
    ]);
  });

  it('records dry-run assignment events without granting memberships or entitlements', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'permission',
          target_id: 'profile:read',
          condition_json: JSON.stringify({
            eventTypes: ['import'],
          }),
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateProvisioningAssignmentRule('tenant_a', 'assignment-rule-1', {
        eventType: 'import',
        subjectId: 'subject-1',
        dryRun: true,
      })
    ).resolves.toMatchObject({
      matched: true,
      outcome: 'assigned',
      dryRun: true,
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO provisioning_assignment_events'),
    ]);
  });

  it('does not grant assignments when a persisted rule has malformed condition JSON', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'group',
          target_id: 'group-1',
          condition_json: '{not-json',
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateProvisioningAssignmentRule('tenant_a', 'assignment-rule-1', {
        eventType: 'jit',
        sourceType: 'scim',
        domain: 'example.edu',
        subjectId: 'subject-1',
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('rejects raw identifiers in assignment conditions and entitlement values', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.createProvisioningAssignmentRule('tenant_a', {
        ruleType: 'email_exact_match',
        targetType: 'group',
        targetId: 'group-1',
        condition: {
          claims: {
            email: 'person@example.edu',
          },
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    await expect(
      repository.grantEntitlement('tenant_a', {
        subjectId: 'subject-1',
        entitlementType: 'permission',
        entitlementKey: 'profile:read',
        value: {
          email: 'person@example.edu',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(adapter.executes).toHaveLength(0);
  });

  it('migrates organization domain mapping to group assignment without making org the source of truth', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'mapping-1',
          domain_hash: 'blind-domain-hash',
          org_id: 'legacy-org-1',
        },
        {
          id: 'group-1',
          group_key: 'example-edu',
          display_name: 'Example EDU',
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const migration = await repository.migrateOrgDomainMappingToGroup('tenant_a', 'mapping-1', {
      groupKey: 'example-edu',
      displayName: 'Example EDU',
    });

    expect(migration).toMatchObject({
      mappingId: 'mapping-1',
      groupId: 'group-1',
      migrationState: 'migrated',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO "groups"'),
      expect.stringContaining('INSERT INTO provisioning_assignment_rules'),
      expect.stringContaining('UPDATE org_domain_mappings'),
    ]);
    expect(String(adapter.executes[1].params[7])).toContain('blind-domain-hash');
  });

  it('creates migrated org-domain rules that can match later source contexts by domain hash', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'assignment-rule-1',
          target_type: 'group',
          target_id: 'group-1',
          condition_json: JSON.stringify({
            claims: {
              domainHash: 'blind-domain-hash',
            },
          }),
          priority: 10,
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.evaluateProvisioningAssignmentRule('tenant_a', 'assignment-rule-1', {
        eventType: 'jit',
        sourceType: 'scim',
        subjectId: 'subject-1',
        claims: {
          domainHash: 'blind-domain-hash',
        },
      })
    ).resolves.toMatchObject({
      matched: true,
      outcome: 'assigned',
      targetType: 'group',
      targetId: 'group-1',
    });
  });

  it('records SCIM active:false lifecycle signal as an account suspension decision', async () => {
    const adapter = createAdapter({
      queryOneRows: [null],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.recordExternalLifecycleSignal('tenant_a', {
      sourceType: 'scim',
      sourceId: 'directory-1',
      sourceEventId: 'event-1',
      signalType: 'scim_active_false',
      accountId: 'account-1',
      targetType: 'account',
      targetId: 'account-1',
    });

    expect(result).toMatchObject({
      decision: 'suspend_account',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO external_lifecycle_signal_events'),
      expect.stringContaining('INSERT INTO external_lifecycle_signal_decisions'),
      expect.stringContaining('UPDATE identity_accounts'),
      expect.stringContaining('INSERT INTO provisioning_revocation_events'),
      expect.stringContaining('UPDATE external_lifecycle_signal_events'),
    ]);
  });

  it('routes protected SCIM group removal, CSV diff, and claim disappearance to review instead of silent revoke', async () => {
    for (const signalType of [
      'scim_group_removed',
      'csv_diff_removed',
      'claim_disappeared',
    ] as const) {
      const adapter = createAdapter({
        queryOneRows: [null],
      });
      const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

      const result = await repository.recordExternalLifecycleSignal('tenant_a', {
        sourceType: signalType.startsWith('scim') ? 'scim' : 'csv',
        sourceId: 'source-1',
        sourceEventId: `${signalType}-source-event`,
        signalType,
        subjectId: 'subject-1',
        targetType: signalType === 'scim_group_removed' ? 'group_membership' : 'entitlement',
        targetId: 'assignment-1',
        ownership: {
          assignmentType: signalType === 'scim_group_removed' ? 'group_membership' : 'entitlement',
          assignmentId: 'assignment-1',
          ownershipPolicy: 'manual',
          revokePolicy: 'auto',
          protectedUntil: 2000,
        },
      });

      expect(result.decision).toBe('review');
      expect(adapter.executes.map((item) => item.sql).join('\n')).not.toContain(
        'SET lifecycle_state = ?'
      );
      expect(adapter.executes.map((item) => item.sql)).toEqual([
        expect.stringContaining('INSERT INTO external_lifecycle_signal_events'),
        expect.stringContaining('INSERT INTO external_lifecycle_signal_decisions'),
        expect.stringContaining('INSERT INTO provisioning_revocation_events'),
        expect.stringContaining('UPDATE external_lifecycle_signal_events'),
      ]);
    }
  });

  it('applies source-owned auto revocation for entitlement lifecycle signals', async () => {
    const adapter = createAdapter({
      queryOneRows: [null],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    const result = await repository.recordExternalLifecycleSignal('tenant_a', {
      sourceType: 'csv',
      sourceId: 'directory-export',
      sourceEventId: 'event-1',
      signalType: 'csv_diff_removed',
      subjectId: 'subject-1',
      targetType: 'entitlement',
      targetId: 'entitlement-1',
      ownership: {
        assignmentType: 'entitlement',
        assignmentId: 'entitlement-1',
        ownershipPolicy: 'source_owned',
        revokePolicy: 'auto',
      },
    });

    expect(result).toMatchObject({
      decision: 'revoke',
    });
    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO external_lifecycle_signal_events'),
      expect.stringContaining('INSERT INTO external_lifecycle_signal_decisions'),
      expect.stringContaining('UPDATE entitlements'),
      expect.stringContaining('INSERT INTO provisioning_revocation_events'),
      expect.stringContaining('UPDATE external_lifecycle_signal_events'),
    ]);
  });

  it('does not duplicate lifecycle signal decisions or revocation side effects for retries', async () => {
    const adapter = createAdapter({
      queryOneRows: [
        {
          id: 'signal-event-1',
          processing_state: 'processed',
        },
        {
          decision: 'review',
          reason_codes_json: JSON.stringify([
            'lifecycle_signal.scim_group_removed',
            'provisioning.revocation.review_required',
          ]),
        },
      ],
    });
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await expect(
      repository.recordExternalLifecycleSignal('tenant_a', {
        sourceType: 'scim',
        sourceId: 'directory-1',
        sourceEventId: 'event-1',
        signalType: 'scim_group_removed',
        subjectId: 'subject-1',
        targetType: 'group_membership',
        targetId: 'membership-1',
      })
    ).resolves.toMatchObject({
      signalEventId: 'signal-event-1',
      decision: 'review',
      idempotent: true,
      reasonCodes: [
        'lifecycle_signal.scim_group_removed',
        'provisioning.revocation.review_required',
      ],
    });
    expect(adapter.executes).toHaveLength(0);
  });
});

describe('IdentityMappingControlPlaneRepository schema and template catalogs', () => {
  it('stores protocol schemas, external schemas, and mapping templates', async () => {
    const adapter = createAdapter({});
    const repository = new IdentityMappingControlPlaneRepository(adapter, () => 1000);

    await repository.createProtocolSchema('tenant_a', {
      protocol: 'scim',
      schemaKey: 'User',
      schemaVersion: '2.0',
      schema: { attributes: [{ name: 'userName', type: 'string' }] },
    });
    await repository.importExternalSchema('tenant_a', {
      sourceType: 'saml',
      sourceId: 'idp-1',
      schemaKey: 'attributes',
      schema: { attributes: [{ name: 'mail' }] },
    });
    await repository.createMappingTemplate('tenant_a', {
      templateKey: 'csv-basic',
      displayName: 'CSV Basic',
      template: { rules: [{ from: 'email', to: 'authrim.profile.email' }] },
    });

    expect(adapter.executes.map((item) => item.sql)).toEqual([
      expect.stringContaining('INSERT INTO protocol_schema_catalogs'),
      expect.stringContaining('INSERT INTO external_schema_catalogs'),
      expect.stringContaining('INSERT INTO mapping_templates'),
    ]);
    expect(String(adapter.executes[0].params[5])).toBe(
      '{"attributes":[{"name":"userName","type":"string"}]}'
    );
  });
});

describe('identity mapping control plane Admin API handlers', () => {
  it('lists policy sets through the Admin API response shape', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'policy_1',
          tenant_id: 'tenant_a',
          policy_key: 'default',
          display_name: 'Default policy',
          description: null,
          owner_scope_type: 'tenant',
          owner_scope_id: null,
          lifecycle_state: 'draft',
          created_at: 1000,
          updated_at: 1000,
        },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.get('/api/admin/identity-mapping/policies', adminIdentityMappingPoliciesListHandler);

    const response = await app.request(
      '/api/admin/identity-mapping/policies',
      { headers: { 'X-Tenant-Id': 'tenant_a' } },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      policies: [
        {
          id: 'policy_1',
          tenantId: 'tenant_a',
          policyKey: 'default',
          displayName: 'Default policy',
          description: null,
          lifecycleState: 'draft',
        },
      ],
    });
  });

  it('lists protocol schemas through the Admin API response shape', async () => {
    const adapter = createAdapter({
      queryRows: [
        {
          id: 'protocol_schema_1',
          tenant_id: 'tenant_a',
          protocol: 'scim',
          schema_key: 'User',
          schema_version: '2.0',
          schema_json: '{"attributes":[{"name":"userName"}]}',
          lifecycle_state: 'active',
          created_at: 1000,
          updated_at: 1000,
        },
      ],
    });
    const app = new Hono<{ Bindings: Env }>();
    app.get(
      '/api/admin/identity-mapping/protocol-schemas',
      adminIdentityMappingProtocolSchemasListHandler
    );

    const response = await app.request(
      '/api/admin/identity-mapping/protocol-schemas',
      { headers: { 'X-Tenant-Id': 'tenant_a' } },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      protocolSchemas: [
        {
          id: 'protocol_schema_1',
          tenantId: 'tenant_a',
          protocol: 'scim',
          schemaKey: 'User',
          schemaVersion: '2.0',
          schema: { attributes: [{ name: 'userName' }] },
          lifecycleState: 'active',
        },
      ],
    });
  });

  it('requires idempotency keys for mutation handlers', async () => {
    const adapter = createAdapter({});
    const app = new Hono<{ Bindings: Env }>();
    app.post('/api/admin/identity-mapping/policies', adminIdentityMappingPolicyCreateHandler);

    const response = await app.request(
      '/api/admin/identity-mapping/policies',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant_a',
        },
        body: JSON.stringify({
          policyKey: 'default',
          displayName: 'Default policy',
        }),
      },
      { DB_ADMIN: adapter } as unknown as Env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Idempotency-Key header is required',
    });
    expect(adapter.executes).toHaveLength(0);
  });
});
