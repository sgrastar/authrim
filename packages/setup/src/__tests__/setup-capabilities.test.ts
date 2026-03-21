import { describe, expect, it } from 'vitest';
import {
  deriveSetupCapabilityEstimate,
  deriveSetupCapabilityStatuses,
  type SetupCapabilityDiagnostics,
} from '../core/cloudflare.js';

function createDiagnostics(
  overrides: Partial<SetupCapabilityDiagnostics> = {}
): SetupCapabilityDiagnostics {
  return {
    wranglerInstalled: true,
    loggedIn: true,
    tokenAvailable: true,
    workersSubdomainAvailable: true,
    zoneReadAvailable: true,
    accessibleZoneCount: 1,
    dnsReadAvailable: true,
    pagesReadAvailable: true,
    ...overrides,
  };
}

describe('deriveSetupCapabilityEstimate', () => {
  it('marks all major setup features as available when required checks pass', () => {
    const capabilities = deriveSetupCapabilityEstimate(createDiagnostics());

    expect(capabilities).toEqual({
      workersDeploy: true,
      customDomain: true,
      multiTenant: true,
      nakedDomain: true,
      pages: true,
    });
  });

  it('disables custom-domain-dependent features when zone access is unavailable', () => {
    const capabilities = deriveSetupCapabilityEstimate(
      createDiagnostics({
        zoneReadAvailable: false,
        accessibleZoneCount: 0,
        dnsReadAvailable: false,
      })
    );

    expect(capabilities).toEqual({
      workersDeploy: true,
      customDomain: false,
      multiTenant: false,
      nakedDomain: false,
      pages: true,
    });
  });

  it('disables multi-tenant and naked-domain estimates when DNS access is unavailable', () => {
    const capabilities = deriveSetupCapabilityEstimate(
      createDiagnostics({
        dnsReadAvailable: false,
      })
    );

    expect(capabilities).toEqual({
      workersDeploy: true,
      customDomain: true,
      multiTenant: false,
      nakedDomain: false,
      pages: true,
    });
  });

  it('disables all optional capabilities when wrangler login is not ready', () => {
    const capabilities = deriveSetupCapabilityEstimate(
      createDiagnostics({
        wranglerInstalled: false,
        loggedIn: false,
        tokenAvailable: false,
        zoneReadAvailable: false,
        accessibleZoneCount: 0,
        dnsReadAvailable: false,
        pagesReadAvailable: false,
      })
    );

    expect(capabilities).toEqual({
      workersDeploy: false,
      customDomain: false,
      multiTenant: false,
      nakedDomain: false,
      pages: false,
    });
  });
});

describe('deriveSetupCapabilityStatuses', () => {
  it('marks accessible features as ok when prerequisite checks pass', () => {
    const statuses = deriveSetupCapabilityStatuses(createDiagnostics());

    expect(statuses).toEqual({
      workersDeploy: 'ok',
      customDomain: 'ok',
      multiTenant: 'ok',
      nakedDomain: 'ok',
      pages: 'ok',
    });
  });

  it('marks unverified DNS-dependent features as review instead of ng', () => {
    const statuses = deriveSetupCapabilityStatuses(
      createDiagnostics({
        zoneReadAvailable: false,
        dnsReadAvailable: false,
        pagesReadAvailable: false,
      })
    );

    expect(statuses).toEqual({
      workersDeploy: 'ok',
      customDomain: 'review',
      multiTenant: 'review',
      nakedDomain: 'review',
      pages: 'review',
    });
  });

  it('marks custom-domain features as ng when no accessible zone exists', () => {
    const statuses = deriveSetupCapabilityStatuses(
      createDiagnostics({
        zoneReadAvailable: true,
        accessibleZoneCount: 0,
        dnsReadAvailable: false,
      })
    );

    expect(statuses).toEqual({
      workersDeploy: 'ok',
      customDomain: 'ng',
      multiTenant: 'ng',
      nakedDomain: 'ng',
      pages: 'ok',
    });
  });
});
