import { describe, expect, it } from 'vitest';
import {
  AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID,
  BUILTIN_AGENT_DISCOVERY_PROFILES,
  computeAgentToolContractDigest,
} from '../../../core';
import { ADMIN_DISCOVERY_TOOL_DEFINITIONS } from '../admin-discovery-tools';
import { createAdminToolCatalog } from '../admin-tools';

describe('Admin discovery profile Tool', () => {
  it('pins a closed, session-only Tool contract', () => {
    const tool = ADMIN_DISCOVERY_TOOL_DEFINITIONS[0]!;
    expect(tool.schemaDigest).toBe(computeAgentToolContractDigest(tool));
    expect(tool).toMatchObject({
      id: 'admin.session.discovery-profiles.select',
      name: 'set_active_tool_profiles',
      requiredPermissions: ['admin:agent:use'],
      requiredScope: 'agent:read',
      riskLevel: 'low',
      executionTarget: 'session_control',
    });
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
  });

  it('keeps every non-control catalog Tool discoverable through a named profile', () => {
    const covered = new Set(BUILTIN_AGENT_DISCOVERY_PROFILES.flatMap((profile) => profile.toolIds));
    const missing = createAdminToolCatalog()
      .list()
      .map((tool) => tool.id)
      .filter(
        (toolId) => toolId !== AGENT_DISCOVERY_PROFILE_CONTROL_TOOL_ID && !covered.has(toolId)
      );

    expect(missing).toEqual([]);
  });
});
