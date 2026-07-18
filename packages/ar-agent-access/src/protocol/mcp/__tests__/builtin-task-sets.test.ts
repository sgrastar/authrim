import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_AGENT_TASK_SET_PRESETS,
  getAgentTaskSetWithBuiltins,
  listAgentTaskSetsWithBuiltins,
  resolveAgentTaskSetVersion,
  type AgentConfigurationRepository,
} from '../../../core';
import { createAdminToolCatalog } from '../admin-tools';
import { createAgentToolCatalog } from '../../../core';

function repository() {
  return {
    listTaskSets: vi.fn().mockResolvedValue([]),
    getTaskSet: vi.fn().mockResolvedValue(null),
    getTaskSetVersion: vi.fn().mockResolvedValue(null),
  } as unknown as AgentConfigurationRepository;
}

describe('built-in Agent Task Sets', () => {
  it('resolves all six versioned presets against the current immutable Tool catalog', async () => {
    const catalog = createAdminToolCatalog();
    const resolved = await Promise.all(
      BUILTIN_AGENT_TASK_SET_PRESETS.map((preset) =>
        resolveAgentTaskSetVersion({
          toolIds: preset.toolIds,
          catalog,
          creatorPermissions: ['admin:*'],
        })
      )
    );
    expect(resolved.map((item) => item.digest)).toEqual([
      '_e6Y6YcUQviBgNcpT1ppMCfCNvQyQl45DGcpemKLX7I',
      'ZHdWtMFNK2FIt0pGI_jilfYOaJK-nYd7gRP-qbrGo_c',
      'Ij3ISoppD4aP8M1PK0VoI4U2ViMXhwCUk8q8XRVipi8',
      '8yAjD04TtXK-8yxYvb5hbgUKrUapSbd3b9KqxZmKP8k',
      '02Rg4I8B6DhjhRDOgDr9NTESVDIQY7NC9jT3GG5WKSE',
      'w1IpPDBANiGKKbpd_a2_-yv3GZ1XBpnuk0N3hYDRCug',
    ]);
    const items = await listAgentTaskSetsWithBuiltins({
      repository: repository(),
      catalog,
      tenantId: 'tenant-1',
    });

    expect(items.map((item) => item.name)).toEqual([
      'read_only_inspector',
      'user_data_reader',
      'diagnostics_operator',
      'configuration_designer',
      'configuration_operator',
      'bulk_configuration_operator',
    ]);
    expect(items.every((item) => item.kind === 'builtin' && item.currentVersion === 4)).toBe(true);
    expect(items.map((item) => item.version.digest)).toEqual([
      '_e6Y6YcUQviBgNcpT1ppMCfCNvQyQl45DGcpemKLX7I',
      'ZHdWtMFNK2FIt0pGI_jilfYOaJK-nYd7gRP-qbrGo_c',
      'Ij3ISoppD4aP8M1PK0VoI4U2ViMXhwCUk8q8XRVipi8',
      '8yAjD04TtXK-8yxYvb5hbgUKrUapSbd3b9KqxZmKP8k',
      '02Rg4I8B6DhjhRDOgDr9NTESVDIQY7NC9jT3GG5WKSE',
      'w1IpPDBANiGKKbpd_a2_-yv3GZ1XBpnuk0N3hYDRCug',
    ]);
    expect(items.at(-1)?.version.tools.map((tool) => tool.toolId)).toContain(
      'admin.write.bulk.plan.create'
    );
    expect(
      items
        .find((item) => item.name === 'configuration_operator')
        ?.version.tools.some((tool) => tool.toolId === 'admin.write.users.suspend')
    ).toBe(false);
    expect(
      items
        .filter((item) => item.name !== 'user_data_reader')
        .flatMap((item) => item.version.tools)
        .some((tool) => tool.toolId.startsWith('admin.read.users.'))
    ).toBe(false);
    expect(
      items
        .find((item) => item.name === 'user_data_reader')
        ?.version.tools.map((tool) => tool.toolId)
    ).toEqual(['admin.read.users.get', 'admin.read.users.search']);
  });

  it('does not resolve unknown versions or silently fall through to tenant storage', async () => {
    const stored = repository();
    const item = await getAgentTaskSetWithBuiltins({
      repository: stored,
      catalog: createAdminToolCatalog(),
      tenantId: 'tenant-1',
      id: BUILTIN_AGENT_TASK_SET_PRESETS[0]!.id,
      version: 1,
    });

    expect(item).toBeNull();
    expect(stored.getTaskSetVersion).not.toHaveBeenCalled();
  });

  it('fails closed instead of silently changing a built-in version with another catalog', async () => {
    await expect(
      getAgentTaskSetWithBuiltins({
        repository: repository(),
        catalog: createAgentToolCatalog('admin-agent-access-v6', []),
        tenantId: 'tenant-1',
        id: BUILTIN_AGENT_TASK_SET_PRESETS[0]!.id,
        version: 4,
      })
    ).rejects.toThrow('requires catalog admin-agent-access-v5');
  });
});
