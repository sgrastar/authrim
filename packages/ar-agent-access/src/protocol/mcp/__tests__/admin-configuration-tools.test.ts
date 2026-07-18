import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalizeJson, resolveAgentConfigurationPlan } from '../../../core';
import {
  ADMIN_CONFIGURATION_PROMPTS,
  ADMIN_CONFIGURATION_RESOURCES,
  ADMIN_CONFIGURATION_RESOURCE_TEMPLATES,
} from '../admin-configuration-context';
import { ADMIN_CONFIGURATION_TOOL_DEFINITIONS } from '../admin-configuration-tools';
import { createAdminToolCatalog } from '../admin-tools';
import { McpSdkJsonSchemaValidator } from '../json-schema-validator';

describe('Configuration Copilot MCP contracts', () => {
  it('validates a real catalog Plan with a separate resource precondition', async () => {
    await expect(
      resolveAgentConfigurationPlan({
        catalog: createAdminToolCatalog(),
        maxOperations: 10,
        schemaValidator: new McpSdkJsonSchemaValidator(),
        definition: {
          schemaVersion: 'authrim-agent-plan-v1',
          steps: [
            {
              id: 'step-1',
              operation: 'admin.write.clients.metadata',
              toolContractVersion: '1',
              input: { client_id: 'client-1', client_name: 'Updated' },
              resourcePrecondition: 'per-tenant-validation',
            },
          ],
        },
      })
    ).resolves.toMatchObject({ definition: { steps: [{ id: 'step-1' }] } });
  });

  it('pins every Tool input schema digest and forbids MCP Tasks', () => {
    expect(
      ADMIN_CONFIGURATION_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.schemaDigest])
    ).toEqual(
      ADMIN_CONFIGURATION_TOOL_DEFINITIONS.map((tool) => [
        tool.name,
        `sha256:${createHash('sha256').update(canonicalizeJson(tool.inputSchema)).digest('hex')}`,
      ])
    );
    expect(
      ADMIN_CONFIGURATION_TOOL_DEFINITIONS.every((tool) => tool.taskSupport === 'forbidden')
    ).toBe(true);
  });

  it('publishes curated versioned Resources and Prompts with internal authorization contracts', () => {
    expect(ADMIN_CONFIGURATION_RESOURCES.map((resource) => resource.uri)).toEqual([
      'authrim://capabilities/v1',
      'authrim://task-sets/v1',
      'authrim://scope-policies/v1',
      'authrim://schemas/auth-config-plan/v1',
    ]);
    expect(ADMIN_CONFIGURATION_RESOURCE_TEMPLATES.map((template) => template.uriTemplate)).toEqual([
      'authrim://schemas/{domain}/v1',
      'authrim://profiles/{profile}/v1',
    ]);
    expect(ADMIN_CONFIGURATION_PROMPTS.map((prompt) => prompt.name)).toEqual([
      'diagnose_auth_configuration_v1',
      'design_oidc_integration_v1',
      'design_saml_integration_v1',
      'review_auth_config_plan_v1',
    ]);
    expect(
      [...ADMIN_CONFIGURATION_RESOURCES, ...ADMIN_CONFIGURATION_PROMPTS].every(
        (entry) => entry.authorizationTool.requiredPermissions.length === 1
      )
    ).toBe(true);
  });
});
