import { describe, expect, it } from 'vitest';
import {
  computeAgentToolContractDigest,
  isPublicClientStandardOptInEligibleTool,
} from '../../../core';
import { ADMIN_WRITE_TOOL_DEFINITIONS } from '../admin-write-tools';
import { ADMIN_CONFIGURATION_INSPECTION_TOOL_DEFINITIONS } from '../admin-inspection-tools';
import { createAdminToolCatalog } from '../admin-tools';

describe('Admin write tool catalog', () => {
  it('pins schema digests and write contracts for every write tool', () => {
    for (const tool of ADMIN_WRITE_TOOL_DEFINITIONS) {
      expect(tool.schemaDigest).toBe(computeAgentToolContractDigest(tool));
      expect(['standard', 'high']).toContain(tool.riskLevel);
      expect(tool.requiredScope).toBe('agent:write');
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
      });
      expect(tool.annotations?.destructiveHint).toBe(tool.riskLevel === 'high');
    }
  });

  it('publishes read and reviewed write tools from one immutable catalog', () => {
    const catalog = createAdminToolCatalog();
    expect(catalog.list()).toHaveLength(50);
    expect(catalog.get('inspect_protocol_security')).toMatchObject({
      id: 'admin.read.protocol-security.inspect',
      requiredPermissions: ['admin:settings:read'],
      riskLevel: 'low',
    });
    expect(catalog.get('suspend_user')).toMatchObject({
      id: 'admin.write.users.suspend',
      requiredPermissions: ['admin:users:suspend'],
    });
    expect(catalog.get('update_client_metadata')).toMatchObject({
      id: 'admin.write.clients.metadata',
      riskLevel: 'standard',
      requiredPermissions: ['admin:clients:write'],
    });
    expect(catalog.get('update_assurance_settings')).toMatchObject({
      id: 'admin.write.assurance.update',
      riskLevel: 'high',
      requiredPermissions: ['admin:settings:assurance:update'],
    });
    expect(catalog.get('update_protocol_security_settings')).toMatchObject({
      id: 'admin.write.protocol-security.update',
      riskLevel: 'high',
      requiredPermissions: ['admin:settings:security:update'],
    });
    expect(catalog.get('update_token_exchange_settings')).toMatchObject({
      id: 'admin.write.token-exchange.update',
      riskLevel: 'high',
      requiredPermissions: ['admin:settings:token_exchange:update'],
    });
    expect(catalog.get('create_auth_config_plan')).toMatchObject({
      id: 'admin.write.configuration.plan.create',
      riskLevel: 'standard',
      requiredPermissions: ['admin:auth_config_plans:create'],
    });
    expect(catalog.get('validate_auth_config_plan')).toMatchObject({
      id: 'admin.write.configuration.plan.validate',
      riskLevel: 'low',
      requiredPermissions: ['admin:auth_config_plans:create'],
    });
  });

  it('limits public Mode A opt-in to explicitly reviewed reversible single-object contracts', () => {
    const catalog = createAdminToolCatalog();
    const eligible = catalog.list().filter(isPublicClientStandardOptInEligibleTool);
    expect(eligible.map((tool) => tool.name).sort()).toEqual([
      'apply_auth_config_plan',
      'cancel_auth_config_plan',
      'create_auth_config_plan',
      'update_client_metadata',
    ]);
    expect(catalog.get('create_bulk_plan')?.publicClientStandardOptInEligible).not.toBe(true);
    expect(catalog.get('suspend_user')?.publicClientStandardOptInEligible).not.toBe(true);
  });

  it('pins every broad configuration inspection to a closed input schema', () => {
    for (const tool of ADMIN_CONFIGURATION_INSPECTION_TOOL_DEFINITIONS) {
      expect(tool.schemaDigest).toBe(computeAgentToolContractDigest(tool));
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
      expect(tool.requiredScope).toBe('agent:read');
    }
  });
});
