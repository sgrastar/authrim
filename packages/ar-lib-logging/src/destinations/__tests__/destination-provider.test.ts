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

  it('rejects an unknown http auth mode at save time but accepts known and omitted ones', () => {
    const base = { url: 'https://collector.example/logs' };
    for (const mode of ['none', 'bearer', 'api_key', 'custom_headers', 'hmac']) {
      for (const key of ['authProfile', 'auth_profile', 'authMode', 'auth_mode']) {
        expect(validateDestinationProviderConfig('http', { ...base, [key]: mode }).valid).toBe(
          true
        );
      }
    }
    // Omitted / null / blank are "not provided" (delivery defaults them).
    expect(validateDestinationProviderConfig('http', base).valid).toBe(true);
    expect(validateDestinationProviderConfig('http', { ...base, authMode: null }).valid).toBe(true);
    expect(validateDestinationProviderConfig('http', { ...base, authMode: '  ' }).valid).toBe(true);

    for (const key of ['authProfile', 'auth_profile', 'authMode', 'auth_mode']) {
      for (const bad of ['mystery', 'Bearer', 5, true, {}]) {
        const result = validateDestinationProviderConfig('http', { ...base, [key]: bad });
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual([{ field: key, message: 'invalid_value' }]);
      }
    }
    // Only the effective (highest-priority) key is validated, as in delivery.
    expect(
      validateDestinationProviderConfig('http', {
        ...base,
        authProfile: 'bearer',
        auth_mode: 'legacy_stale',
      }).valid
    ).toBe(true);
    expect(
      validateDestinationProviderConfig('http', { ...base, authMode: 'bearer', auth_mode: 'x' })
        .valid
    ).toBe(true);
    // Blank higher-priority key falls through to the next provided one.
    expect(
      validateDestinationProviderConfig('http', { ...base, authProfile: ' ', authMode: 'mystery' })
        .errors
    ).toEqual([{ field: 'authMode', message: 'invalid_value' }]);
    // Effective key invalid, lower key valid: rejected.
    expect(
      validateDestinationProviderConfig('http', {
        ...base,
        authProfile: 'mystery',
        auth_mode: 'bearer',
      }).errors
    ).toEqual([{ field: 'authProfile', message: 'invalid_value' }]);
    // Only http destinations carry an HTTP sink auth mode.
    expect(
      validateDestinationProviderConfig('r2', { bindingRef: 'A', authMode: 'mystery' }).valid
    ).toBe(true);
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

  it('uses a destination not checked yet, and not one a check found unhealthy', () => {
    const base = {
      id: 'dest_new',
      scopeType: 'platform',
      scopeId: 'global',
      kind: 'audit',
      provider: 'r2',
      lifecycleStatus: 'active',
      capabilityPolicy: {
        allowedTenantIds: null,
        allowedLogTypes: null,
        allowedPlanes: null,
        criticalAllowed: true,
      },
    } as unknown as LoggingDestination;
    const selectable = (healthStatus: string) =>
      isDestinationSelectableForTenant({
        destination: { ...base, healthStatus } as LoggingDestination,
        tenantId: 'tenant-a',
        logType: 'audit',
        plane: 'archive',
      });
    // Created destinations start as 'unknown': they are used before the first health check.
    expect(selectable('unknown')).toBe(true);
    expect(selectable('healthy')).toBe(true);
    expect(selectable('degraded')).toBe(false);
    expect(selectable('unreachable')).toBe(false);
  });
});
