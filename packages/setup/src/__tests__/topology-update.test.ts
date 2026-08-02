import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import type { AuthrimLock } from '../core/lock.js';
import {
  assertPendingTopologyUpdate,
  completeTopologyUpdate,
  prepareTopologyUpdate,
  topologyUpdateResumeInstruction,
} from '../core/topology-update.js';

function deployedLock(): AuthrimLock {
  return {
    version: '1.0.0',
    productVersion: '0.4.0',
    env: 'prod',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    d1: {},
    kv: {},
  };
}

describe('topology update journal', () => {
  it('authorizes only the prepared kind, product, config, and token', () => {
    const config = createDefaultConfig('prod');
    const prepared = prepareTopologyUpdate(deployedLock(), {
      kind: 'r2',
      targetProductVersion: '0.4.0',
      config,
    });

    expect(() =>
      assertPendingTopologyUpdate(prepared.lock, {
        kind: 'r2',
        targetProductVersion: '0.4.0',
        config,
        authorizationToken: prepared.authorizationToken,
      })
    ).not.toThrow();
    expect(() =>
      assertPendingTopologyUpdate(prepared.lock, {
        kind: 'external_database',
        targetProductVersion: '0.4.0',
        config,
      })
    ).toThrow('topology_update_kind_mismatch');
    expect(() =>
      assertPendingTopologyUpdate(prepared.lock, {
        targetProductVersion: '0.4.0',
        config,
        authorizationToken: 'wrong-token',
      })
    ).toThrow('topology_update_token_invalid');
    expect(() =>
      assertPendingTopologyUpdate(prepared.lock, {
        targetProductVersion: '0.4.0',
        config: { ...config, updatedAt: '2026-07-21T01:00:00.000Z' },
      })
    ).toThrow('topology_update_config_changed');
  });

  it('rotates Web authorization while preserving the durable operation start time', () => {
    const config = createDefaultConfig('prod');
    const first = prepareTopologyUpdate(deployedLock(), {
      kind: 'r2',
      targetProductVersion: '0.4.0',
      config,
    });
    const resumed = prepareTopologyUpdate(first.lock, {
      kind: 'r2',
      targetProductVersion: '0.4.0',
      config,
    });

    expect(resumed.resumed).toBe(true);
    expect(resumed.lock.topologyUpdate?.startedAt).toBe(first.lock.topologyUpdate?.startedAt);
    expect(resumed.authorizationToken).not.toBe(first.authorizationToken);
    expect(() =>
      assertPendingTopologyUpdate(resumed.lock, {
        targetProductVersion: '0.4.0',
        config,
        authorizationToken: first.authorizationToken,
      })
    ).toThrow('topology_update_token_invalid');
  });

  it('allows a one-way preparation transition and refuses deployment completion too early', () => {
    const config = createDefaultConfig('prod');
    const preparing = prepareTopologyUpdate(deployedLock(), {
      kind: 'tenant_database',
      phase: 'preparing',
      subject: 'tenant-a:1',
      targetProductVersion: '0.4.0',
      config,
    });

    expect(() =>
      completeTopologyUpdate(preparing.lock, {
        targetProductVersion: '0.4.0',
        config,
      })
    ).toThrow('topology_update_phase_mismatch:preparing:pending_deploy');

    const ready = prepareTopologyUpdate(preparing.lock, {
      kind: 'tenant_database',
      phase: 'pending_deploy',
      subject: 'tenant-a:1',
      targetProductVersion: '0.4.0',
      config,
    });
    expect(ready.lock.topologyUpdate?.phase).toBe('pending_deploy');
    expect(() =>
      prepareTopologyUpdate(ready.lock, {
        kind: 'tenant_database',
        phase: 'preparing',
        subject: 'tenant-a:1',
        targetProductVersion: '0.4.0',
        config,
      })
    ).toThrow('topology_update_phase_regression');
  });

  it('clears the journal only after validating the deployed config and product version', () => {
    const config = createDefaultConfig('prod');
    const prepared = prepareTopologyUpdate(deployedLock(), {
      kind: 'external_database',
      targetProductVersion: '0.4.0',
      config,
    });

    const completed = completeTopologyUpdate(prepared.lock, {
      targetProductVersion: '0.4.0',
      config,
    });
    expect(completed.topologyUpdate).toBeUndefined();
  });

  it('provides argument-free retry instructions where the journal already has the target', () => {
    const config = createDefaultConfig('prod');
    const external = prepareTopologyUpdate(deployedLock(), {
      kind: 'external_database',
      targetProductVersion: '0.4.0',
      config,
    });
    const tenant = prepareTopologyUpdate(deployedLock(), {
      kind: 'tenant_database',
      phase: 'preparing',
      subject: "tenant'a:2",
      targetProductVersion: '0.4.0',
      config,
    });

    expect(topologyUpdateResumeInstruction(external.lock.topologyUpdate!, 'prod')).toBe(
      "npx @authrim/setup external-db-register --env 'prod'"
    );
    expect(topologyUpdateResumeInstruction(tenant.lock.topologyUpdate!, 'prod')).toBe(
      "npx @authrim/setup tenant-db --env 'prod' --tenant-id 'tenant'\\''a' --generation 2"
    );
  });
});
