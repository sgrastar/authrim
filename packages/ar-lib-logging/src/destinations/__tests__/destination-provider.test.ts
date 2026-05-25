import { describe, expect, it } from 'vitest';
import {
  getDefaultDestinationCapabilities,
  isDestinationSelectableForTenant,
  validateDestinationProviderConfig,
  type LoggingDestination,
} from '../index';

describe('destination provider registry', () => {
  it('validates required provider fields', () => {
    expect(validateDestinationProviderConfig('r2', { bindingRef: 'AUDIT_ARCHIVE' })).toMatchObject({
      valid: true,
    });
    expect(validateDestinationProviderConfig('http', {})).toMatchObject({
      valid: false,
      errors: [{ field: 'url', message: 'required' }],
    });
  });

  it('returns provider default capabilities', () => {
    expect(getDefaultDestinationCapabilities('r2')).toContain('sensitive_detail_write');
    expect(getDefaultDestinationCapabilities('http')).toEqual(['log_sink_write']);
  });

  it('checks tenant/log/plane eligibility without exposing raw credentials', () => {
    const destination: LoggingDestination = {
      id: 'dest_platform',
      scopeType: 'shared',
      scopeId: null,
      destinationKind: 'object_storage',
      provider: 'r2',
      name: 'platform-default',
      displayName: 'Platform Default',
      lifecycleStatus: 'active',
      healthStatus: 'healthy',
      providerConfig: { bindingRef: 'AUDIT_ARCHIVE' },
      capabilityPolicy: {
        allowedTenantIds: ['tenant-a'],
        allowedLogTypes: ['audit'],
        allowedPlanes: ['archive'],
        region: 'global',
        criticalAllowed: true,
        defaultFallbackEligible: true,
      },
    };

    expect(
      isDestinationSelectableForTenant({
        destination,
        tenantId: 'tenant-a',
        logType: 'audit',
        plane: 'archive',
        region: 'global',
        critical: true,
      })
    ).toBe(true);
    expect(
      isDestinationSelectableForTenant({
        destination,
        tenantId: 'tenant-b',
        logType: 'audit',
        plane: 'archive',
        region: 'global',
        critical: true,
      })
    ).toBe(false);
  });
});
