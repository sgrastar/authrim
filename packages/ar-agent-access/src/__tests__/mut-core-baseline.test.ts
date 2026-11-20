import { describe, expect, it } from 'vitest';
import {
  evaluateAgentBaselineConfiguration,
  resolveAgentBaselineDefinition,
  validateAgentBaselineException,
  type AgentBaselineDefinition,
} from '../core/baseline';
import { canonicalizeJson, sha256Base64Url } from '../core/canonical-json';
import type { JsonValue } from '../core/types';

const step = {
  id: 'step-1',
  operation: 'admin.write.clients.metadata',
  toolContractVersion: '1',
  input: { client_id: 'c1', client_name: 'Managed' },
  resourcePrecondition: 'per-tenant-validation',
};
const definition: AgentBaselineDefinition = {
  schemaVersion: 'authrim-agent-baseline-v1',
  taskSet: { id: 'ats_1', version: 1, digest: 'a'.repeat(16) },
  scopePolicy: { id: 'asp_1', version: 2, digest: 'b'.repeat(128) },
  configurationProfile: { schemaVersion: 'authrim-agent-plan-v1', goal: 'Baseline', steps: [step] },
};
const resolve = (
  def: AgentBaselineDefinition,
  mode = 'managed' as 'managed' | 'one_time',
  enforcement = 'standard_auto_remediation' as 'report_only' | 'standard_auto_remediation'
) => resolveAgentBaselineDefinition({ definition: def, mode, enforcement });
const INVALID = 'Baseline definition or policy is invalid';

describe('resolveAgentBaselineDefinition', () => {
  it('returns the canonical definition and its digest', async () => {
    const result = await resolve(definition);
    expect(result.definition).toEqual(definition);
    expect(Object.keys(result.definition)).toEqual([
      'configurationProfile',
      'schemaVersion',
      'scopePolicy',
      'taskSet',
    ]);
    expect(result.digest).toBe(
      await sha256Base64Url(canonicalizeJson(definition as unknown as JsonValue))
    );
  });

  it('accepts either reference alone and valid mode/enforcement pairs', async () => {
    const { taskSet: _t, ...onlyScope } = definition;
    const { scopePolicy: _s, ...onlyTaskSet } = definition;
    await expect(resolve(onlyScope)).resolves.toBeDefined();
    await expect(resolve(onlyTaskSet)).resolves.toBeDefined();
    await expect(resolve(definition, 'one_time', 'report_only')).resolves.toBeDefined();
    await expect(resolve(definition, 'managed', 'report_only')).resolves.toBeDefined();
  });

  it.each([
    ['schema version', { ...definition, schemaVersion: 'v2' }, 'managed', 'report_only'],
    ['mode', definition, 'always', 'report_only'],
    ['enforcement', definition, 'managed', 'auto'],
    ['one-time remediation', definition, 'one_time', 'standard_auto_remediation'],
    [
      'no references',
      { ...definition, taskSet: undefined, scopePolicy: undefined },
      'managed',
      'report_only',
    ],
    [
      'missing profile',
      { ...definition, configurationProfile: undefined },
      'managed',
      'report_only',
    ],
    [
      'profile version',
      {
        ...definition,
        configurationProfile: { ...definition.configurationProfile, schemaVersion: 'x' },
      },
      'managed',
      'report_only',
    ],
    [
      'non-array steps',
      { ...definition, configurationProfile: { ...definition.configurationProfile, steps: {} } },
      'managed',
      'report_only',
    ],
    [
      'empty steps',
      { ...definition, configurationProfile: { ...definition.configurationProfile, steps: [] } },
      'managed',
      'report_only',
    ],
  ])('rejects an invalid %s', async (_label, def, mode, enforcement) => {
    await expect(
      resolveAgentBaselineDefinition({
        definition: def as unknown as AgentBaselineDefinition,
        mode: mode as 'managed',
        enforcement: enforcement as 'report_only',
      })
    ).rejects.toThrow(INVALID);
  });

  it.each([
    ['id', { id: 'bad id' }],
    ['id prefix', { id: '!ats' }],
    ['id suffix', { id: 'ats!' }],
    ['fractional version', { version: 1.5 }],
    ['zero version', { version: 0 }],
    ['short digest', { digest: 'a'.repeat(15) }],
    ['long digest', { digest: 'a'.repeat(129) }],
    ['digest prefix', { digest: '=' + 'a'.repeat(20) }],
    ['digest suffix', { digest: 'a'.repeat(20) + '=' }],
  ])('rejects a Task Set / Scope Policy reference with invalid %s', async (_label, override) => {
    await expect(
      resolve({ ...definition, taskSet: { ...definition.taskSet!, ...override } })
    ).rejects.toThrow('Task Set reference is invalid');
    await expect(
      resolve({ ...definition, scopePolicy: { ...definition.scopePolicy!, ...override } })
    ).rejects.toThrow('Scope Policy reference is invalid');
  });

  it.each([
    ['other operation', { operation: 'admin.write.login-ui.update' }],
    ['shared precondition', { resourcePrecondition: 'etag:v1' }],
    ['resource_version', { input: { client_id: 'c1', client_name: 'x', resource_version: 'v' } }],
    ['identifier only', { input: { client_id: 'c1' } }],
    ['empty input', { input: {} }],
  ])('rejects a step with %s', async (_label, override) => {
    const steps = [step, { ...step, id: 'step-2', ...override }];
    await expect(
      resolve({
        ...definition,
        configurationProfile: { ...definition.configurationProfile, steps },
      })
    ).rejects.toThrow('Baseline contains an unsupported or non-declarative operation');
  });

  it('accepts a step without client_id that sets a field, and rejects raw secrets', async () => {
    const ok = { ...step, input: { client_name: 'x' } };
    await expect(
      resolve({
        ...definition,
        configurationProfile: { ...definition.configurationProfile, steps: [ok] },
      })
    ).resolves.toBeDefined();
    const secret = { ...step, input: { client_id: 'c1', client_secret: 'raw' } };
    await expect(
      resolve({
        ...definition,
        configurationProfile: { ...definition.configurationProfile, steps: [secret] },
      })
    ).rejects.toThrow('Raw secret field is forbidden at $.steps[0].input.client_secret');
  });
});

const twoSteps: AgentBaselineDefinition = {
  ...definition,
  configurationProfile: {
    ...definition.configurationProfile,
    steps: [
      { ...step, id: 'b', input: { client_id: 'c2', z: 1, y: { k: 'v' }, resource_version: 'rv' } },
      { ...step, id: 'a', input: { client_id: 'c1', x: 'v' } },
    ],
  },
};

describe('evaluateAgentBaselineConfiguration', () => {
  const op = step.operation;

  it('reports in_sync when every declared field matches, ignoring identifiers', async () => {
    const result = await evaluateAgentBaselineConfiguration({
      definition: twoSteps,
      current: [
        { stepId: 'a', operation: op, current: { x: 'v', client_id: 'other' } },
        { stepId: 'b', operation: op, current: { z: 1, y: { k: 'v' } } },
      ],
    });
    expect(result).toMatchObject({ status: 'in_sync', driftFields: [], exceptedFields: [] });
    expect(result.currentDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('sorts drift and excepted paths across steps and flags missing resources', async () => {
    const result = await evaluateAgentBaselineConfiguration({
      definition: twoSteps,
      current: [
        { stepId: 'a', operation: op, current: null },
        { stepId: 'b', operation: op, current: { z: 2, y: { k: 'v' } } },
      ],
      exceptionFields: ['a.x', 'a.$resource'],
    });
    expect(result.status).toBe('drifted');
    expect(result.driftFields).toEqual(['b.z']);
    expect(result.exceptedFields).toEqual(['a.$resource', 'a.x']);

    const all = await evaluateAgentBaselineConfiguration({ definition: twoSteps, current: [] });
    expect(all.driftFields).toEqual(['a.$resource', 'a.x', 'b.$resource', 'b.y', 'b.z']);
    expect(all.exceptedFields).toEqual([]);
  });

  it('treats a missing current value as null and compares canonically', async () => {
    const def: AgentBaselineDefinition = {
      ...definition,
      configurationProfile: {
        ...definition.configurationProfile,
        steps: [{ ...step, id: 's', input: { client_id: 'c', n: null, o: { b: 1, a: 2 } } }],
      },
    };
    await expect(
      evaluateAgentBaselineConfiguration({
        definition: def,
        current: [{ stepId: 's', operation: op, current: { o: { a: 2, b: 1 } } }],
      })
    ).resolves.toMatchObject({ status: 'in_sync', driftFields: [] });
    await expect(
      evaluateAgentBaselineConfiguration({
        definition: def,
        current: [{ stepId: 's', operation: op, current: { n: 0, o: { a: 2, b: 1 } } }],
      })
    ).resolves.toMatchObject({ status: 'drifted', driftFields: ['s.n'] });
  });

  it('only reports an all-excepted drift as in_sync', async () => {
    const result = await evaluateAgentBaselineConfiguration({
      definition,
      current: [{ stepId: 'step-1', operation: op, current: { client_name: 'Other' } }],
      exceptionFields: ['step-1.client_name'],
    });
    expect(result).toMatchObject({
      status: 'in_sync',
      driftFields: [],
      exceptedFields: ['step-1.client_name'],
    });
  });

  it('rejects current state read for a different operation', async () => {
    await expect(
      evaluateAgentBaselineConfiguration({
        definition,
        current: [{ stepId: 'step-1', operation: 'admin.write.login-ui.update', current: {} }],
      })
    ).rejects.toThrow('Baseline current-state operation does not match the Plan');
  });

  it('binds the state digest to existence, resource id and current values', async () => {
    const digest = async (
      def: AgentBaselineDefinition,
      current: { current: Record<string, JsonValue> | null }[]
    ) =>
      (
        await evaluateAgentBaselineConfiguration({
          definition: def,
          current: current.map((c) => ({
            stepId: 'step-1',
            operation: op,
            current: c.current as never,
          })),
        })
      ).currentDigest;
    const missing = await digest(definition, []);
    const nullState = await digest(definition, [{ current: null }]);
    const empty = await digest(definition, [{ current: {} }]);
    const valued = await digest(definition, [{ current: { client_name: 'Managed' } }]);
    expect(missing).toBe(nullState);
    expect(empty).not.toBe(missing);
    expect(valued).not.toBe(empty);
    const otherClient = {
      ...definition,
      configurationProfile: {
        ...definition.configurationProfile,
        steps: [{ ...step, input: { client_id: 'c9', client_name: 'Managed' } }],
      },
    };
    expect(await digest(otherClient, [{ current: {} }])).not.toBe(empty);
    expect(empty).toBe(
      await sha256Base64Url(
        canonicalizeJson({
          schema_version: 'authrim-agent-baseline-state-v1',
          steps: [
            { step_id: 'step-1', operation: op, resource_id: 'c1', exists: true, values: {} },
          ],
        })
      )
    );
  });
});

describe('validateAgentBaselineException', () => {
  const now = 1_000_000;
  const year = 365 * 24 * 60 * 60_000;
  const valid = {
    fields: ['b.x', 'a.y', 'b.x'],
    reason: '  approved change  ',
    expiresAt: now + 1,
    now,
  };

  it('returns sorted unique fields and a trimmed reason', () => {
    expect(validateAgentBaselineException(valid)).toEqual({
      fields: ['a.y', 'b.x'],
      reason: 'approved change',
      expiresAt: now + 1,
    });
  });

  it('accepts inclusive boundaries', () => {
    expect(() =>
      validateAgentBaselineException({
        ...valid,
        fields: Array.from({ length: 100 }, (_, i) => `f${i}`),
        reason: 'abc',
        expiresAt: now + year,
      })
    ).not.toThrow();
    expect(() =>
      validateAgentBaselineException({
        ...valid,
        fields: ['x'.repeat(200)],
        reason: 'r'.repeat(1000),
      })
    ).not.toThrow();
  });

  it.each([
    ['no fields', { fields: [] }],
    ['too many fields', { fields: Array.from({ length: 101 }, (_, i) => `f${i}`) }],
    ['malformed field', { fields: ['a.x', 'bad field'] }],
    ['field prefix', { fields: ['/a.x'] }],
    ['field suffix', { fields: ['a.x/'] }],
    ['long field', { fields: ['x'.repeat(201)] }],
    ['short trimmed reason', { reason: '  ab  ' }],
    ['long reason', { reason: 'r'.repeat(1001) }],
    ['fractional expiry', { expiresAt: now + 0.5 }],
    ['expiry at now', { expiresAt: now }],
    ['expiry in past', { expiresAt: now - 1 }],
    ['expiry beyond one year', { expiresAt: now + year + 1 }],
  ])('rejects %s', (_label, override) => {
    expect(() => validateAgentBaselineException({ ...valid, ...override })).toThrow(
      'Baseline exception is invalid'
    );
  });
});
