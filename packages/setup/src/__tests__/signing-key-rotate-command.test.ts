import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createLockFile } from '../core/lock.js';
import {
  activatedSigningRotationNeedsDeployment,
  signingRotationTargetComponents,
  signingVerificationTargetComponents,
} from '../cli/commands/signing-key-rotate.js';

function lockWithDeployments(input: {
  updatedAt: number;
  deployedAt: string;
  missing?: string;
  previous?: boolean;
}) {
  const lock = createLockFile('test', {
    d1: [{ binding: 'CONTROL_DB', name: 'test-control', id: 'control-id' }],
    kv: [],
    queues: [],
    r2: [],
  });
  lock.controlKeyState = {
    runtimeRegistry: {
      activeSlot: 'B',
      activeKeyId: 'registry-v2',
      activeFingerprint: 'b'.repeat(64),
      ...(input.previous === false
        ? {}
        : {
            previousSlot: 'A' as const,
            previousKeyId: 'registry-v1',
            previousFingerprint: 'a'.repeat(64),
          }),
      updatedAt: input.updatedAt,
    },
    smokeRpc: {
      activeSlot: 'A',
      activeKeyId: 'smoke-v1',
      activeFingerprint: 'c'.repeat(64),
      updatedAt: 1,
    },
    lookupHmac: {
      stateRevision: 1,
      activeGeneration: 1,
      activeSlot: 'A',
      activeKeyId: 'lookup-v1',
      activeFingerprint: 'd'.repeat(64),
      updatedAt: 1,
    },
  };
  lock.workers = Object.fromEntries(
    signingRotationTargetComponents('runtime_registry')
      .filter((component) => component !== input.missing)
      .map((component) => [
        component,
        {
          name: `test-${component}`,
          deployedAt: input.deployedAt,
          version: '1.0.0',
        },
      ])
  );
  return lock;
}

describe('signing-key rotation command state', () => {
  it('validates canonical config and every loaded lock against the requested environment', async () => {
    const source = await readFile(
      new URL('../cli/commands/signing-key-rotate.ts', import.meta.url),
      'utf8'
    );
    const configLoad = source.indexOf('async function loadEnvironment(');
    const configIdentity = source.indexOf('if (config.environment.prefix !== env)', configLoad);
    const lockIdentityHelper = source.indexOf('function assertSigningKeyEnvironmentLock(');
    const initialLock = source.indexOf(
      'const initial = await loadLockFileAuto(context.environmentBaseDir, context.env)'
    );
    const initialIdentity = source.indexOf(
      'assertSigningKeyEnvironmentLock(initial.lock, context.env)',
      initialLock
    );

    expect(configIdentity).toBeGreaterThan(configLoad);
    expect(lockIdentityHelper).toBeGreaterThan(-1);
    expect(initialIdentity).toBeGreaterThan(initialLock);
    expect(source).toContain('assertSigningKeyEnvironmentLock(input.lock, input.context.env)');
    expect(source).toContain('assertSigningKeyEnvironmentLock(finalLock.lock, context.env)');
  });

  it('derives the target set from the secret allow-list and includes the signer', () => {
    const registry = signingRotationTargetComponents('runtime_registry');
    const smoke = signingRotationTargetComponents('smoke_rpc');

    expect(registry).toContain('ar-control');
    expect(registry).toContain('ar-management');
    expect(registry).toContain('ar-discovery');
    expect(registry).not.toContain('ar-router');
    expect(smoke).toContain('ar-control');
    expect(smoke).toContain('ar-agent-access');
    expect(smoke).toContain('ar-discovery');
    expect(smoke).not.toContain('ar-router');
    expect(signingVerificationTargetComponents('runtime_registry')).not.toContain('ar-control');
    expect(signingVerificationTargetComponents('smoke_rpc')).not.toContain('ar-control');
  });

  it('requires the final deployment when any target is missing or not newer than activation', () => {
    expect(
      activatedSigningRotationNeedsDeployment(
        lockWithDeployments({
          updatedAt: 100,
          deployedAt: '1970-01-01T00:01:40.000Z',
        }),
        'runtime_registry'
      )
    ).toBe(true);
    expect(
      activatedSigningRotationNeedsDeployment(
        lockWithDeployments({
          updatedAt: 100,
          deployedAt: '1970-01-01T00:01:41.000Z',
          missing: 'ar-management',
        }),
        'runtime_registry'
      )
    ).toBe(true);
  });

  it('marks the active switch deployed only when every target is newer', () => {
    expect(
      activatedSigningRotationNeedsDeployment(
        lockWithDeployments({
          updatedAt: 100,
          deployedAt: '1970-01-01T00:01:41.000Z',
        }),
        'runtime_registry'
      )
    ).toBe(false);
  });

  it('does not infer an in-progress rotation without previous-key metadata', () => {
    expect(
      activatedSigningRotationNeedsDeployment(
        lockWithDeployments({
          updatedAt: 100,
          deployedAt: '1970-01-01T00:00:01.000Z',
          previous: false,
        }),
        'runtime_registry'
      )
    ).toBe(false);
  });
});
