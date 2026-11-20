import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS } from '@authrim/ar-lib-core';
import { issueAgentBulkChildToken } from '../entrypoints/AgentDownscopeEntrypoint';
import { bulkScenario, NOW, pinTool, step } from './helpers/mut-entrypoint-fixtures';

const env = {} as never;

async function signedPermissions(scenario: Awaited<ReturnType<typeof bulkScenario>>) {
  await issueAgentBulkChildToken(env, scenario.request, scenario.deps);
  const claims = scenario.deps.signToken.mock.calls[0][2] as Record<string, unknown>;
  expect(claims.scope).toBe((claims.permissions as string[]).join(' '));
  return claims.permissions;
}

describe('Bulk child stage permissions', () => {
  it('adds the read permission of a low-risk step at validate and verify, sorted', async () => {
    for (const stage of ['validate', 'verify'] as const) {
      const scenario = await bulkScenario({ stage, steps: [step('admin.read.audit.search')] });
      await expect(signedPermissions(scenario)).resolves.toEqual([
        'admin:admin_audit:read',
        ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
      ]);
    }
  });

  it('maps client metadata writes to client read access outside apply', async () => {
    const scenario = await bulkScenario({
      stage: 'verify',
      steps: [step('admin.write.clients.metadata', { client_id: 'client-1' })],
    });
    await expect(signedPermissions(scenario)).resolves.toEqual([
      ADMIN_PERMISSIONS.BULK_PLANS_APPLY,
      ADMIN_PERMISSIONS.CLIENTS_READ,
    ]);
  });

  it('refuses a standard-risk step without a read mapping at validate', async () => {
    const scenario = await bulkScenario({
      stage: 'validate',
      steps: [step('admin.write.configuration.plan.create')],
    });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_validation_unavailable'
    );
    expect(scenario.repo.getGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown operation', { ...step('admin.read.audit.search'), operation: 'admin.unknown' }],
    [
      'a stale tool contract version',
      { ...step('admin.read.audit.search'), toolContractVersion: '99' },
    ],
    ['a high-risk tool', step('admin.write.users.suspend')],
  ])('refuses %s in the Plan', async (_name, badStep) => {
    const scenario = await bulkScenario({
      steps: [step('admin.write.clients.metadata', { client_id: 'client-1' })],
    });
    scenario.plan.definition.plan.steps = [badStep];
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_operation_unavailable'
    );
  });

  it('refuses a Plan without a stored definition', async () => {
    const scenario = await bulkScenario({ plan: { definition: undefined } });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_definition_unavailable'
    );
  });
});

describe('Bulk child Grant re-authorization', () => {
  it.each([
    ['inactive status', { status: 'revoked' }],
    ['an incomplete configuration snapshot', { taskSetId: undefined }],
    ['another client', { clientId: 'client-other' }],
    ['another delegator', { delegatorId: 'admin-2' }],
    ['another machine principal', { machinePrincipalId: 'principal-2' }],
    ['another consent version', { consentVersion: 5 }],
    ['a missing expiry', { expiresAt: undefined }],
    ['an expiry equal to now', { expiresAt: NOW }],
    ['a missing write scope', { scopes: ['agent:read'] }],
    ['an unpinned tool contract', { resolvedTools: [pinTool('admin.read.audit.search')] }],
  ])('rejects a Grant with %s', async (_name, grant) => {
    const scenario = await bulkScenario({ grant: grant as never });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_authorization_changed'
    );
    expect(scenario.repo.getActiveDelegatorPermissions).not.toHaveBeenCalled();
    expect(scenario.deps.signToken).not.toHaveBeenCalled();
  });

  it('rejects when any one of several steps is no longer authorized', async () => {
    const steps = [
      step('admin.read.audit.search'),
      step('admin.write.clients.metadata', { client_id: 'client-1' }),
    ];
    const scenario = await bulkScenario({
      steps,
      grant: { resolvedTools: [pinTool('admin.read.audit.search')] },
    });
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_authorization_changed'
    );
  });

  it('rechecks delegator, consent, and machine ceilings with the live identifiers', async () => {
    const scenario = await bulkScenario();
    await issueAgentBulkChildToken(env, scenario.request, scenario.deps);
    expect(scenario.repo.getActiveDelegatorPermissions).toHaveBeenCalledWith(
      'tenant-1',
      'admin-1',
      NOW
    );
    expect(scenario.repo.hasCurrentConsent).toHaveBeenCalledWith(
      'platform',
      'grant-bulk',
      'admin-1',
      'client-agent',
      2
    );
    expect(scenario.deps.getModeBPermissionLimit).toHaveBeenCalledWith(
      env,
      'tenant-1',
      'principal-1',
      'credential-1'
    );
  });

  it.each([
    ['no active delegator permissions', { delegatorPermissions: null }],
    ['withdrawn consent', { consent: false }],
    ['a revoked machine credential', { machinePermissions: null }],
    [
      'a Grant missing one stage permission',
      { grant: { permissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY] } },
    ],
    [
      'a delegator missing one stage permission',
      { delegatorPermissions: [ADMIN_PERMISSIONS.BULK_PLANS_APPLY] },
    ],
    [
      'a machine ceiling missing one stage permission',
      { machinePermissions: [ADMIN_PERMISSIONS.CLIENTS_WRITE] },
    ],
  ])('rejects %s', async (_name, options) => {
    const scenario = await bulkScenario(options);
    await expect(issueAgentBulkChildToken(env, scenario.request, scenario.deps)).rejects.toThrow(
      'agent_bulk_child_authorization_changed'
    );
    expect(scenario.deps.signToken).not.toHaveBeenCalled();
  });
});
