import { describe, expect, it } from 'vitest';
import { AgentConfigurationRepository } from '../core/repositories/agent-configuration-repository';
import {
  AUDIT_STATEMENT,
  auditWrite,
  batchStatements,
  fakeAdapter,
  fakeAuditWriter,
  flat,
} from './helpers/mut-repos-fakes';

function setup() {
  const db = fakeAdapter();
  const writer = fakeAuditWriter();
  return { ...db, writer, repo: new AgentConfigurationRepository(db.adapter, writer) };
}

const planRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  version: 2,
  tenant_id: 'tenant-1',
  grant_id: 'grant-1',
  grant_generation: 3,
  consent_version: 4,
  actor_sub: 'agent:sub',
  client_id: 'client-1',
  definition_json: '{"schemaVersion":"authrim-agent-plan-v1","goal":"g","steps":[]}',
  snapshot_json: '{"s":1}',
  diff_json: '{"d":1}',
  validation_json: '{"v":1}',
  result_json: '{"r":1}',
  definition_digest: 'pd-1',
  status: 'ready',
  stage: 'apply',
  applied_step_count: 1,
  failed_step_id: 'step-2',
  failure_kind: 'boom',
  confirmation_id: 'conf-1',
  expires_at: 100,
  cancelled_at: 50,
  cancelled_by: 'admin-1',
  cancel_reason: 'stop',
  payload_purge_at: 200,
  payload_purged_at: 150,
  created_at: 1,
  updated_at: 2,
  ...overrides,
});

describe('AgentConfigurationRepository plan reads', () => {
  it('maps every stored plan column', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce(planRow());
    await expect(repo.getPlan('tenant-1', 'plan-1', 2)).resolves.toEqual({
      id: 'plan-1',
      version: 2,
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      consentVersion: 4,
      actorSub: 'agent:sub',
      clientId: 'client-1',
      definition: { schemaVersion: 'authrim-agent-plan-v1', goal: 'g', steps: [] },
      definitionDigest: 'pd-1',
      snapshot: { s: 1 },
      diff: { d: 1 },
      validation: { v: 1 },
      result: { r: 1 },
      status: 'ready',
      stage: 'apply',
      appliedStepCount: 1,
      failedStepId: 'step-2',
      failureKind: 'boom',
      confirmationId: 'conf-1',
      expiresAt: 100,
      cancelledAt: 50,
      cancelledBy: 'admin-1',
      cancelReason: 'stop',
      payloadPurgeAt: 200,
      payloadPurgedAt: 150,
      createdAt: 1,
      updatedAt: 2,
    });
    const [sql, params] = queryOne.mock.calls[0];
    expect(flat(sql)).toBe(
      'SELECT * FROM agent_configuration_plans WHERE tenant_id = ? AND id = ? AND version = ?'
    );
    expect(params).toEqual(['tenant-1', 'plan-1', 2]);
  });

  it('maps purged payloads and nullable columns to undefined', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce(
      planRow({
        definition_json: null,
        snapshot_json: null,
        diff_json: null,
        validation_json: null,
        result_json: null,
        failed_step_id: null,
        failure_kind: null,
        confirmation_id: null,
        cancelled_at: null,
        cancelled_by: null,
        cancel_reason: null,
        payload_purged_at: null,
      })
    );
    const record = await repo.getPlan('tenant-1', 'plan-1', 2);
    for (const key of [
      'definition',
      'snapshot',
      'diff',
      'validation',
      'result',
      'failedStepId',
      'failureKind',
      'confirmationId',
      'cancelledAt',
      'cancelledBy',
      'cancelReason',
      'payloadPurgedAt',
    ] as const) {
      expect(record?.[key]).toBeUndefined();
    }
  });

  it.each(['[]', '"text"', 'null', '42'])(
    'rejects stored JSON %s that is not an object',
    async (json) => {
      const { repo, queryOne } = setup();
      queryOne.mockResolvedValueOnce(planRow({ snapshot_json: json }));
      await expect(repo.getPlan('tenant-1', 'plan-1', 2)).rejects.toThrow(
        'Stored Agent configuration JSON is invalid'
      );
    }
  );

  it('returns null for missing plans', async () => {
    const { repo } = setup();
    await expect(repo.getPlan('tenant-1', 'plan-1', 2)).resolves.toBeNull();
    await expect(repo.getLatestPlan('tenant-1', 'plan-1')).resolves.toBeNull();
  });

  it('getLatestPlan orders by descending version', async () => {
    const { repo, queryOne } = setup();
    queryOne.mockResolvedValueOnce(planRow({ version: 7 }));
    await expect(repo.getLatestPlan('tenant-1', 'plan-1')).resolves.toMatchObject({ version: 7 });
    const [sql, params] = queryOne.mock.calls[0];
    expect(flat(sql)).toContain('WHERE tenant_id = ? AND id = ? ORDER BY version DESC LIMIT 1');
    expect(params).toEqual(['tenant-1', 'plan-1']);
  });

  it.each([
    [undefined, 100],
    [0, 1],
    [-5, 1],
    [50, 50],
    [200, 200],
    [999, 200],
  ])('listPlans clamps limit %s to %s', async (limit, bound) => {
    const { repo, query } = setup();
    query.mockResolvedValueOnce([planRow()]);
    const rows = await repo.listPlans('tenant-1', limit);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'plan-1', snapshot: { s: 1 } });
    const [sql, params] = query.mock.calls[0];
    expect(flat(sql)).toContain(
      'WHERE tenant_id = ? ORDER BY created_at DESC, id DESC, version DESC LIMIT ?'
    );
    expect(params).toEqual(['tenant-1', bound]);
  });
});

describe('AgentConfigurationRepository.createPlan', () => {
  it('inserts the draft plan, one pending row per step and the audit', async () => {
    const { repo, batch, writer } = setup();
    const definition = {
      schemaVersion: 'authrim-agent-plan-v1',
      goal: 'g',
      steps: [
        { id: 's1', operation: 'op.a', toolContractVersion: 'v1', input: { a: 1 } },
        {
          id: 's2',
          operation: 'op.b',
          toolContractVersion: 'v2',
          input: { b: 2 },
          resourcePrecondition: 'etag-1',
        },
      ],
    } as never;
    await repo.createPlan({
      id: 'plan-1',
      version: 2,
      tenantId: 'tenant-1',
      grantId: 'grant-1',
      grantGeneration: 3,
      consentVersion: 4,
      actorSub: 'agent:sub',
      clientId: 'client-1',
      definition,
      definitionDigest: 'pd-1',
      risks: ['low', 'high'],
      expiresAt: 100,
      payloadPurgeAt: 200,
      now: 10,
      audit: auditWrite(),
    });
    const statements = batchStatements(batch);
    expect(statements).toHaveLength(4);
    expect(flat(statements[0].sql)).toContain('INSERT INTO agent_configuration_plans');
    expect(flat(statements[0].sql)).toContain(
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'validate', ?, ?, ?, ?, ?)"
    );
    expect(statements[0].params).toEqual([
      'plan-1',
      2,
      'tenant-1',
      'grant-1',
      3,
      4,
      'agent:sub',
      'client-1',
      JSON.stringify(definition),
      'pd-1',
      'audit-1',
      100,
      200,
      10,
      10,
    ]);
    for (const step of statements.slice(1, 3)) {
      expect(flat(step.sql)).toContain('INSERT INTO agent_configuration_plan_steps');
      expect(flat(step.sql)).toContain("VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')");
    }
    expect(statements[1].params).toEqual([
      'plan-1',
      2,
      's1',
      0,
      'op.a',
      'v1',
      '{"a":1}',
      'pd-1',
      null,
      'low',
    ]);
    expect(statements[2].params).toEqual([
      'plan-1',
      2,
      's2',
      1,
      'op.b',
      'v2',
      '{"b":2}',
      'pd-1',
      'etag-1',
      'high',
    ]);
    expect(statements[3]).toBe(AUDIT_STATEMENT);
    expect(writer.mock.calls[0][2]).toBeUndefined();
  });
});
