import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import { clearFeatureFlagCache, isTenantFlowProtocolConsentGatesEnabled } from '../feature-flags';

describe('tenant Flow protocol Consent Gate feature flag', () => {
  beforeEach(() => clearFeatureFlagCache());

  it('is opt-in by default', async () => {
    await expect(isTenantFlowProtocolConsentGatesEnabled({} as Env, 'tenant-a')).resolves.toBe(
      false
    );
  });

  it('lets an explicit tenant false override a deployment true for rollback', async () => {
    const get = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ 'feature.flow_protocol_consent_gates.enabled': false }));
    const env = {
      AUTHRIM_CONFIG: { get },
      ENABLE_FLOW_PROTOCOL_CONSENT_GATES: 'true',
    } as unknown as Env;

    await expect(isTenantFlowProtocolConsentGatesEnabled(env, 'tenant-a')).resolves.toBe(false);
    expect(get).toHaveBeenCalledWith('settings:tenant:tenant-a:feature-flags');
  });

  it('supports a tenant opt-in without a deployment-wide flag', async () => {
    const env = {
      AUTHRIM_CONFIG: {
        get: vi.fn().mockResolvedValue(JSON.stringify({ 'feature.consent_gate.enabled': true })),
      },
    } as unknown as Env;

    await expect(isTenantFlowProtocolConsentGatesEnabled(env, 'tenant-a')).resolves.toBe(true);
  });
});
