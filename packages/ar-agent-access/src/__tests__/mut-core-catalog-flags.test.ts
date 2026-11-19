import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import { prepareAdminAgentAuditStatements, type AdminAgentAuditWrite } from '../core/audit';
import {
  BUILTIN_AGENT_TASK_SET_PRESETS,
  getAgentTaskSetWithBuiltins,
  resolveBuiltinAgentTaskSet,
} from '../core/builtin-task-sets';
import { evaluateAgentMcpFeatureFlag } from '../core/feature-flags';
import {
  AGENT_GRANT_DEFAULT_TTL_MS,
  AGENT_GRANT_MAX_TTL_MS,
  AGENT_GRANT_MIN_TTL_MS,
  resolveAgentGrantExpiration,
} from '../core/grant-lifecycle';
import type { AgentConfigurationRepository } from '../core/repositories';
import {
  createAgentToolCatalog,
  isPublicClientStandardOptInEligibleTool,
} from '../core/tool-catalog';
import { sealAgentToolDefinition } from '../core/tool-contract';
import type { AgentToolDefinitionSource } from '../core/types';
import { createAdminToolCatalog } from '../protocol/mcp/admin-tools';
import { makeCoreTool } from './helpers/mut-core-fixtures';

describe('sealAgentToolDefinition failures', () => {
  const source = (inputSchema: unknown, description = 'd'): AgentToolDefinitionSource =>
    ({
      ...makeCoreTool(),
      schemaDigest: undefined,
      description,
      inputSchema,
    }) as AgentToolDefinitionSource;

  it('names the first undefined path, including inside arrays', () => {
    expect(() => sealAgentToolDefinition(source({ properties: { a: undefined } }))).toThrow(
      'Invalid Agent tool contract: admin.write.clients.metadata ($.input_schema.properties.a is undefined)'
    );
    expect(() => sealAgentToolDefinition(source({ anyOf: [{}, { x: undefined }] }))).toThrow(
      'Invalid Agent tool contract: admin.write.clients.metadata ($.input_schema.anyOf[1].x is undefined)'
    );
  });

  it('omits the path when the failure is not an undefined value and keeps the cause', () => {
    let error: unknown;
    try {
      sealAgentToolDefinition(source({ type: 'object' }, '\ud800'));
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe(
      'Invalid Agent tool contract: admin.write.clients.metadata'
    );
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe('createAgentToolCatalog', () => {
  it('deeply freezes tool schemas', () => {
    const catalog = createAgentToolCatalog('v', [makeCoreTool()]);
    const schema = catalog.list()[0].inputSchema;
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties)).toBe(true);
    expect(Object.isFrozen(schema.required)).toBe(true);
  });

  it('rejects duplicate tool names', () => {
    expect(() =>
      createAgentToolCatalog('v', [makeCoreTool(), makeCoreTool({ id: 'other' })])
    ).toThrow('Duplicate Agent tool name: update_client_metadata');
  });
});

describe('isPublicClientStandardOptInEligibleTool', () => {
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const eligible = makeCoreTool({ publicClientStandardOptInEligible: true, annotations });

  it('accepts only the exact conservative declaration', () => {
    expect(isPublicClientStandardOptInEligibleTool(eligible)).toBe(true);
  });

  it.each([
    ['risk level', { riskLevel: 'low' as const }],
    ['destructive hint', { annotations: { ...annotations, destructiveHint: true } }],
    ['idempotent hint', { annotations: { ...annotations, idempotentHint: false } }],
    ['open world hint', { annotations: { ...annotations, openWorldHint: true } }],
    ['read-only hint', { annotations: { ...annotations, readOnlyHint: true } }],
    ['eligibility flag', { publicClientStandardOptInEligible: false }],
  ])('rejects a different %s', (_label, override) => {
    expect(isPublicClientStandardOptInEligibleTool({ ...eligible, ...override })).toBe(false);
  });
});

describe('evaluateAgentMcpFeatureFlag environment fallback', () => {
  it.each([
    [undefined, { enabled: false, reason: 'disabled_by_default' }],
    ['false', { enabled: false, reason: 'disabled_by_default' }],
    ['true', { enabled: true, reason: 'enabled_by_environment' }],
    ['', { enabled: false, reason: 'invalid_configuration' }],
    ['yes', { enabled: false, reason: 'invalid_configuration' }],
  ])('maps environment value %j', (environmentValue, decision) => {
    expect(evaluateAgentMcpFeatureFlag({ configurationAvailable: true, environmentValue })).toEqual(
      decision
    );
  });
});

describe('resolveAgentGrantExpiration', () => {
  it('exposes the TTL bounds', () => {
    expect([AGENT_GRANT_DEFAULT_TTL_MS, AGENT_GRANT_MAX_TTL_MS, AGENT_GRANT_MIN_TTL_MS]).toEqual([
      2_592_000_000, 7_776_000_000, 3_600_000,
    ]);
    expect(resolveAgentGrantExpiration(undefined, 0)).toBe(2_592_000_000);
  });

  it('treats 1e12 and above as milliseconds', () => {
    const now = 1e12 - 2 * 3_600_000;
    expect(resolveAgentGrantExpiration(1e12, now)).toBe(1e12);
    expect(resolveAgentGrantExpiration((now + 7_200_000) / 1000, now)).toBe(now + 7_200_000);
  });
});

describe('built-in Task Set resolution', () => {
  const repository = () =>
    ({
      listTaskSets: vi.fn().mockResolvedValue([]),
      getTaskSet: vi.fn().mockResolvedValue({ id: 'stored' }),
      getTaskSetVersion: vi.fn().mockResolvedValue({ id: 'stored-v' }),
    }) as unknown as AgentConfigurationRepository & {
      getTaskSet: ReturnType<typeof vi.fn>;
      getTaskSetVersion: ReturnType<typeof vi.fn>;
    };

  it('gives every preset a description', async () => {
    const catalog = createAdminToolCatalog();
    for (const preset of BUILTIN_AGENT_TASK_SET_PRESETS) {
      const record = await resolveBuiltinAgentTaskSet({
        tenantId: 't',
        id: preset.id,
        version: preset.version,
        catalog,
      });
      expect(record?.description?.length).toBeGreaterThan(0);
    }
  });

  it('rejects a catalog whose tools drifted from the pinned digest', async () => {
    const tools = createAdminToolCatalog().list();
    const drifted = tools.map((t, i) =>
      i === 0
        ? sealAgentToolDefinition({
            ...t,
            schemaDigest: undefined,
            description: `${t.description} (changed)`,
          })
        : t
    );
    const preset = BUILTIN_AGENT_TASK_SET_PRESETS.find((p) => p.toolIds.includes(tools[0].id))!;
    await expect(
      resolveBuiltinAgentTaskSet({
        tenantId: 't',
        id: preset.id,
        version: preset.version,
        catalog: createAgentToolCatalog('admin-agent-access-v9', drifted),
      })
    ).rejects.toThrow(
      `Built-in Task Set ${preset.id} v${preset.version} digest differs from its immutable snapshot`
    );
  });

  it('reads stored Task Sets by latest or explicit version', async () => {
    const catalog = createAdminToolCatalog();
    const repo = repository();
    await expect(
      getAgentTaskSetWithBuiltins({ repository: repo, catalog, tenantId: 't', id: 'ats_x' })
    ).resolves.toEqual({
      id: 'stored',
    });
    expect(repo.getTaskSet).toHaveBeenCalledWith('t', 'ats_x');
    await expect(
      getAgentTaskSetWithBuiltins({
        repository: repo,
        catalog,
        tenantId: 't',
        id: 'ats_x',
        version: 2,
      })
    ).resolves.toEqual({ id: 'stored-v' });
    expect(repo.getTaskSetVersion).toHaveBeenCalledWith('t', 'ats_x', 2);
  });
});

describe('prepareAdminAgentAuditStatements', () => {
  it('requires a writer and forwards the guard', async () => {
    const database = {} as DatabaseAdapter;
    const audit = { id: 'a' } as AdminAgentAuditWrite;
    await expect(prepareAdminAgentAuditStatements(undefined, database, audit)).rejects.toThrow(
      'admin_agent_audit_writer_required'
    );
    const writer = vi.fn().mockResolvedValue([]);
    const guard = { from: 'x', where: 'y', params: [] };
    await expect(prepareAdminAgentAuditStatements(writer, database, audit, guard)).resolves.toEqual(
      []
    );
    expect(writer).toHaveBeenCalledWith(database, audit, guard);
  });
});
