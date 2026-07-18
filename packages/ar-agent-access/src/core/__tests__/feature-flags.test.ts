import { describe, expect, it } from 'vitest';
import { evaluateAgentMcpFeatureFlag } from '../feature-flags';

describe('evaluateAgentMcpFeatureFlag', () => {
  it('lets an explicit tenant value override the environment', () => {
    expect(
      evaluateAgentMcpFeatureFlag({
        configurationAvailable: true,
        tenantValue: false,
        environmentValue: 'true',
      })
    ).toEqual({ enabled: false, reason: 'disabled_by_tenant' });
  });

  it('uses the environment only when no tenant value exists', () => {
    expect(
      evaluateAgentMcpFeatureFlag({
        configurationAvailable: true,
        environmentValue: 'true',
      })
    ).toEqual({ enabled: true, reason: 'enabled_by_environment' });
  });

  it.each([
    [{ configurationAvailable: false }, 'configuration_unavailable'],
    [{ configurationAvailable: true, tenantValue: 'true' }, 'invalid_configuration'],
    [{ configurationAvailable: true, environmentValue: '1' }, 'invalid_configuration'],
  ] as const)('fails closed for %o', (input, reason) => {
    expect(evaluateAgentMcpFeatureFlag(input)).toEqual({ enabled: false, reason });
  });
});
