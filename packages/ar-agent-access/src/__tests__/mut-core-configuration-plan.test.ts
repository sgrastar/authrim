import { describe, expect, it } from 'vitest';
import {
  assertNoRawSecrets,
  resolveAgentConfigurationPlan,
  type AgentConfigurationPlanDefinition,
  type AgentConfigurationSchemaValidator,
} from '../core/configuration';
import type { JsonObject, JsonValue } from '../core/types';
import { makeCoreCatalog, makeCoreTool } from './helpers/mut-core-fixtures';

function recordingValidator(result: { valid: boolean; errorMessage?: string } = { valid: true }) {
  const schemas: JsonObject[] = [];
  const inputs: JsonValue[] = [];
  const validator: AgentConfigurationSchemaValidator = {
    validate(schema, input) {
      schemas.push(schema);
      inputs.push(input);
      return result;
    },
  };
  return { validator, schemas, inputs };
}

const readTool = makeCoreTool({
  id: 'admin.read.clients',
  name: 'list_clients',
  riskLevel: 'low',
  requiredScope: 'agent:read',
  requiredPermissions: ['admin:clients:read'],
  inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
});
const writeTool = makeCoreTool({
  inputSchema: {
    type: 'object',
    minProperties: 3,
    properties: {
      client_id: { type: 'string' },
      client_name: { type: 'string' },
      resource_version: { type: 'string' },
    },
    required: ['client_id', 'resource_version', 7],
  },
});
const catalog = makeCoreCatalog([readTool, writeTool]);

const step = {
  id: 'step-1',
  operation: writeTool.id,
  toolContractVersion: '1',
  input: { client_name: 'B', client_id: 'A' },
  resourcePrecondition: 'etag:"v1"',
};
const definition: AgentConfigurationPlanDefinition = {
  schemaVersion: 'authrim-agent-plan-v1',
  goal: '  Rename the client  ',
  steps: [step],
};

const resolve = (
  def: AgentConfigurationPlanDefinition,
  validator = recordingValidator().validator,
  maxOperations = 3
) =>
  resolveAgentConfigurationPlan({
    definition: def,
    catalog,
    maxOperations,
    schemaValidator: validator,
  });

describe('resolveAgentConfigurationPlan normalization', () => {
  it('returns the trimmed, canonical definition and per-step risks from the matching tool', async () => {
    const rec = recordingValidator();
    const result = await resolve(
      {
        ...definition,
        steps: [{ id: 'read', operation: readTool.id, toolContractVersion: '1', input: {} }, step],
      },
      rec.validator
    );
    expect(result.definition).toStrictEqual({
      schemaVersion: 'authrim-agent-plan-v1',
      goal: 'Rename the client',
      steps: [
        { id: 'read', operation: readTool.id, toolContractVersion: '1', input: {} },
        {
          id: 'step-1',
          operation: writeTool.id,
          toolContractVersion: '1',
          input: { client_id: 'A', client_name: 'B' },
          resourcePrecondition: 'etag:"v1"',
        },
      ],
    });
    expect(Object.keys(result.definition.steps[1].input)).toEqual(['client_id', 'client_name']);
    expect(result.risks).toEqual(['low', 'standard']);
    expect(result.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(rec.inputs).toEqual([{}, step.input]);
  });

  it('strips resource_version from the step input schema and raises minProperties', async () => {
    const rec = recordingValidator();
    await resolve(definition, rec.validator);
    expect(rec.schemas[0]).toEqual({
      type: 'object',
      properties: { client_id: { type: 'string' }, client_name: { type: 'string' } },
      required: ['client_id'],
      minProperties: 2,
    });
  });

  it('derives an empty property map and minProperties from required when the schema lacks them', async () => {
    const rec = recordingValidator();
    await resolve(
      {
        ...definition,
        steps: [{ id: 's', operation: readTool.id, toolContractVersion: '1', input: {} }],
      },
      rec.validator
    );
    expect(rec.schemas[0]).toEqual({
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: [],
      minProperties: 1,
    });
  });

  it('ignores non-object properties and keeps a larger original minProperties', async () => {
    const odd = makeCoreTool({
      id: 'admin.odd',
      name: 'odd',
      riskLevel: 'low',
      inputSchema: { type: 'object', properties: 'ab', minProperties: 5 },
    });
    const arrayProps = makeCoreTool({
      id: 'admin.array',
      name: 'array_props',
      riskLevel: 'low',
      inputSchema: { type: 'object', properties: ['x'] },
    });
    const rec = recordingValidator();
    await resolveAgentConfigurationPlan({
      catalog: makeCoreCatalog([odd, arrayProps]),
      maxOperations: 5,
      schemaValidator: rec.validator,
      definition: {
        ...definition,
        steps: [
          { id: 'a', operation: odd.id, toolContractVersion: '1', input: {} },
          { id: 'b', operation: arrayProps.id, toolContractVersion: '1', input: {} },
        ],
      },
    });
    expect(rec.schemas[0]).toEqual({
      type: 'object',
      properties: {},
      required: [],
      minProperties: 4,
    });
    expect(rec.schemas[1]).toEqual({
      type: 'object',
      properties: {},
      required: [],
      minProperties: 1,
    });
  });

  it('accepts a goal whose trimmed length is exactly 500 and steps up to maxOperations', async () => {
    const result = await resolve(
      { ...definition, goal: ` ${'g'.repeat(500)} `, steps: [step] },
      undefined,
      1
    );
    expect(result.definition.goal).toBe('g'.repeat(500));
  });
});

describe('resolveAgentConfigurationPlan rejections', () => {
  it.each([
    ['schema version', { schemaVersion: 'authrim-agent-plan-v2' }],
    ['non-string goal', { goal: 42 }],
    ['blank goal', { goal: '   ' }],
    ['goal over 500', { goal: 'g'.repeat(501) }],
    ['no steps', { steps: [] }],
    ['too many steps', { steps: [step, { ...step, id: 'step-2' }] }],
  ])('rejects a plan with %s', async (_label, override) => {
    await expect(
      resolve(
        { ...definition, ...override } as unknown as AgentConfigurationPlanDefinition,
        undefined,
        1
      )
    ).rejects.toThrow('Configuration Plan size or schema version is invalid');
  });

  it('rejects malformed or duplicate step IDs', async () => {
    await expect(resolve({ ...definition, steps: [{ ...step, id: 'bad id' }] })).rejects.toThrow(
      'Plan step ID is invalid'
    );
    await expect(resolve({ ...definition, steps: [step, step] })).rejects.toThrow(
      'Plan step ID is invalid'
    );
  });

  it('requires a resource precondition for non-low-risk steps only', async () => {
    await expect(
      resolve({ ...definition, steps: [{ ...step, resourcePrecondition: undefined }] })
    ).rejects.toThrow(`Plan write operation requires a resource precondition: ${writeTool.id}`);
    await expect(
      resolve({ ...definition, steps: [{ ...step, resourcePrecondition: '' }] })
    ).rejects.toThrow('requires a resource precondition');
  });

  it('reports schema validation failures with and without a detail message', async () => {
    await expect(
      resolve(definition, recordingValidator({ valid: false, errorMessage: 'bad field' }).validator)
    ).rejects.toThrow(`Plan operation input is invalid: ${writeTool.id} (bad field)`);
    const err = await resolve(definition, recordingValidator({ valid: false }).validator).catch(
      (e: Error) => e
    );
    expect((err as Error).message).toBe(`Plan operation input is invalid: ${writeTool.id}`);
  });

  it.each([['!etag'], ['etag!'], ['etag v1'], ['x'.repeat(257)]])(
    'rejects malformed resource precondition %s',
    async (resourcePrecondition) => {
      await expect(
        resolve({ ...definition, steps: [{ ...step, resourcePrecondition }] })
      ).rejects.toThrow('Plan resource precondition is invalid');
    }
  );

  it('accepts a precondition on a low-risk step and keeps it', async () => {
    const result = await resolve({
      ...definition,
      steps: [
        {
          id: 'r',
          operation: readTool.id,
          toolContractVersion: '1',
          input: {},
          resourcePrecondition: 'x'.repeat(256),
        },
      ],
    });
    expect(result.definition.steps[0].resourcePrecondition).toBe('x'.repeat(256));
  });
});

describe('assertNoRawSecrets', () => {
  it.each([
    ['secret'],
    ['PASSWORD'],
    ['private_key'],
    ['private-key'],
    ['privatekey'],
    ['client_secret'],
    ['access_token'],
    ['access-token'],
    ['accesstoken'],
    ['refresh_token'],
    ['refreshtoken'],
    ['recovery_code'],
    ['recovery-code'],
    ['recoverycode'],
    ['my_password_hint'],
  ])('forbids a raw %s field', (key) => {
    expect(() => assertNoRawSecrets({ [key]: 'value' })).toThrow(
      `Raw secret field is forbidden at $.${key}`
    );
  });

  it.each([['private'], ['access'], ['token'], ['refresh'], ['recovery'], ['code'], ['key']])(
    'allows the non-secret field %s',
    (key) => {
      expect(() => assertNoRawSecrets({ [key]: 'value' })).not.toThrow();
    }
  );

  it('allows null or undefined secret fields but still forbids falsy values', () => {
    expect(() => assertNoRawSecrets({ password: null })).not.toThrow();
    expect(() => assertNoRawSecrets({ password: undefined } as unknown as JsonValue)).not.toThrow();
    expect(() => assertNoRawSecrets({ password: '' })).toThrow(
      'Raw secret field is forbidden at $.password'
    );
  });

  it('reports full paths through arrays and nested objects', () => {
    expect(() => assertNoRawSecrets([{ ok: 1 }, { password: 'x' }])).toThrow(
      'Raw secret field is forbidden at $[1].password'
    );
    expect(() => assertNoRawSecrets({ a: { b: [0, { secret: 'x' }] } })).toThrow(
      'Raw secret field is forbidden at $.a.b[1].secret'
    );
    expect(() => assertNoRawSecrets({ a: [{ secret_ref: 'nope' }] }, '$root')).toThrow(
      'Invalid opaque secret_ref at $root.a[0].secret_ref'
    );
  });

  it('validates the opaque secret_ref format exactly', () => {
    for (const ok of ['asr_' + 'a'.repeat(16), 'asr_' + 'A_-'.repeat(40)]) {
      expect(() => assertNoRawSecrets({ secret_ref: ok })).not.toThrow();
    }
    for (const bad of [
      'asr_' + 'a'.repeat(15),
      'asr_' + 'a'.repeat(121),
      'xasr_' + 'a'.repeat(16),
      'asr_' + 'a'.repeat(16) + '!',
      7,
    ]) {
      expect(() => assertNoRawSecrets({ secret_ref: bad })).toThrow(
        'Invalid opaque secret_ref at $.secret_ref'
      );
    }
  });

  it('ignores primitives', () => {
    expect(() => assertNoRawSecrets('password')).not.toThrow();
    expect(() => assertNoRawSecrets(null)).not.toThrow();
  });
});
