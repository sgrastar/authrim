import { describe, expect, it } from 'vitest';
import {
  evaluateAgentBaselineConfiguration,
  resolveAgentBaselineDefinition,
  validateAgentBaselineException,
} from '../baseline';

const digest = 'x'.repeat(32);

function profile(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'authrim-agent-plan-v1' as const,
    steps: [
      {
        id: 'client-metadata',
        operation: 'admin.write.clients.metadata',
        toolContractVersion: '1',
        input: {
          client_id: 'client-1',
          client_name: 'Configured client',
          ...extra,
        },
        resourcePrecondition: 'per-tenant-validation',
      },
    ],
  };
}

describe('Agent baseline contracts', () => {
  it('canonicalizes a managed report-only baseline', async () => {
    const resolved = await resolveAgentBaselineDefinition({
      mode: 'managed',
      enforcement: 'report_only',
      definition: {
        schemaVersion: 'authrim-agent-baseline-v1',
        taskSet: { id: 'task-set', version: 2, digest },
        scopePolicy: { id: 'scope-policy', version: 4, digest },
        configurationProfile: profile(),
      },
    });
    expect(resolved.definition.taskSet?.version).toBe(2);
    expect(resolved.digest).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
  });

  it('rejects auto-remediation for a one-time baseline', async () => {
    await expect(
      resolveAgentBaselineDefinition({
        mode: 'one_time',
        enforcement: 'standard_auto_remediation',
        definition: {
          schemaVersion: 'authrim-agent-baseline-v1',
          taskSet: { id: 'task-set', version: 1, digest },
          configurationProfile: profile(),
        },
      })
    ).rejects.toThrow('Baseline definition or policy is invalid');
  });

  it('rejects raw secret material in baseline profiles', async () => {
    await expect(
      resolveAgentBaselineDefinition({
        mode: 'managed',
        enforcement: 'report_only',
        definition: {
          schemaVersion: 'authrim-agent-baseline-v1',
          taskSet: { id: 'task-set', version: 1, digest },
          configurationProfile: profile({ client_secret: 'not-allowed' }),
        },
      })
    ).rejects.toThrow('Raw secret field is forbidden');
  });

  it('rejects a duplicated resource version in a declarative baseline step', async () => {
    await expect(
      resolveAgentBaselineDefinition({
        mode: 'managed',
        enforcement: 'report_only',
        definition: {
          schemaVersion: 'authrim-agent-baseline-v1',
          taskSet: { id: 'task-set', version: 1, digest },
          configurationProfile: profile({ resource_version: 'caller-supplied' }),
        },
      })
    ).rejects.toThrow('unsupported or non-declarative');
  });

  it('evaluates trusted current state and honors exact field exceptions', async () => {
    const definition = {
      schemaVersion: 'authrim-agent-baseline-v1' as const,
      taskSet: { id: 'task-set', version: 1, digest },
      configurationProfile: profile(),
    };
    const drifted = await evaluateAgentBaselineConfiguration({
      definition,
      current: [
        {
          stepId: 'client-metadata',
          operation: 'admin.write.clients.metadata',
          current: { client_name: 'Changed client' },
        },
      ],
    });
    expect(drifted).toMatchObject({
      status: 'drifted',
      driftFields: ['client-metadata.client_name'],
    });

    const excepted = await evaluateAgentBaselineConfiguration({
      definition,
      current: [
        {
          stepId: 'client-metadata',
          operation: 'admin.write.clients.metadata',
          current: { client_name: 'Changed client' },
        },
      ],
      exceptionFields: ['client-metadata.client_name'],
    });
    expect(excepted).toMatchObject({
      status: 'in_sync',
      driftFields: [],
      exceptedFields: ['client-metadata.client_name'],
    });
  });

  it('normalizes bounded, expiring field exceptions', () => {
    expect(
      validateAgentBaselineException({
        fields: ['client.redirect_uris', 'client.redirect_uris'],
        reason: 'Temporary compatibility window',
        now: 1_000,
        expiresAt: 2_000,
      })
    ).toEqual({
      fields: ['client.redirect_uris'],
      reason: 'Temporary compatibility window',
      expiresAt: 2_000,
    });
  });
});
