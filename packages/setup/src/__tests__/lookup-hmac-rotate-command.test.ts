import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLookupHmacRotationMatchesPending,
  assertPendingLookupHmacState,
  parseLookupHmacRotation,
  parseLookupHmacVerificationStatus,
  parsePendingLookupHmacRotation,
  promoteLookupHmacCandidateSecret,
  lookupHmacRotationTargetComponents,
  runWithEphemeralSetupMachineAccess,
  type LookupHmacRotation,
  type PendingLookupHmacRotation,
} from '../cli/commands/lookup-hmac-rotate.js';
import type { AuthrimConfig } from '../core/config.js';

const sourceSecret = 'source-secret';
const candidateSecret = 'candidate-secret';
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

function pending(operationId: string | null = null): PendingLookupHmacRotation {
  return {
    schemaVersion: 1,
    environmentId: 'test',
    idempotencyKey: 'lookup-hmac-2-lookup-hmac-2-candidate',
    source: {
      generation: 1,
      keyId: 'lookup-hmac-1-source',
      slot: 'A',
      fingerprint: fingerprint(sourceSecret),
    },
    candidate: {
      generation: 2,
      keyId: 'lookup-hmac-2-candidate',
      slot: 'B',
      fingerprint: fingerprint(candidateSecret),
    },
    operationId,
  };
}

function rotation(operationId = 'lookup-hmac-operation-1'): LookupHmacRotation {
  const value = pending();
  return {
    operationId,
    state: 'distributing',
    source: value.source,
    candidate: value.candidate,
    fencingToken: 1,
  };
}

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('Lookup HMAC rotation command state', () => {
  it('focuses deployment on every Worker that owns a Lookup HMAC slot', () => {
    expect(lookupHmacRotationTargetComponents()).toEqual([
      'ar-lib-core',
      'ar-auth',
      'ar-token',
      'ar-userinfo',
      'ar-management',
      'ar-bridge',
    ]);
  });

  it('accepts only exact environment-bound pending metadata', () => {
    const value = pending();
    expect(parsePendingLookupHmacRotation(JSON.stringify(value), 'test')).toEqual(value);

    expect(() => parsePendingLookupHmacRotation(JSON.stringify(value), 'prod')).toThrow(
      'lookup_hmac_rotation_pending_state_invalid'
    );
    expect(() =>
      parsePendingLookupHmacRotation(JSON.stringify({ ...value, rawKey: 'secret' }), 'test')
    ).toThrow('lookup_hmac_rotation_pending_state_invalid');
    expect(() =>
      parsePendingLookupHmacRotation(
        JSON.stringify({
          ...value,
          candidate: { ...value.candidate, keyId: '../candidate' },
        }),
        'test'
      )
    ).toThrow('lookup_hmac_rotation_pending_state_invalid');
    expect(() =>
      parsePendingLookupHmacRotation(
        JSON.stringify({ ...value, idempotencyKey: 'lookup-hmac-wrong' }),
        'test'
      )
    ).toThrow('lookup_hmac_rotation_pending_state_invalid');
  });

  it('accepts source-active, dual-key, and completed resume states only', () => {
    const value = pending('lookup-hmac-operation-1');
    expect(() =>
      assertPendingLookupHmacState(value, {
        stateRevision: 1,
        activeGeneration: 1,
        activeSlot: 'A',
        activeKeyId: value.source.keyId,
        activeFingerprint: value.source.fingerprint,
        updatedAt: 1,
      })
    ).not.toThrow();
    expect(() =>
      assertPendingLookupHmacState(value, {
        stateRevision: 2,
        activeGeneration: 2,
        activeSlot: 'B',
        activeKeyId: value.candidate.keyId,
        activeFingerprint: value.candidate.fingerprint,
        previousGeneration: 1,
        previousSlot: 'A',
        previousKeyId: value.source.keyId,
        previousFingerprint: value.source.fingerprint,
        updatedAt: 2,
      })
    ).not.toThrow();
    expect(() =>
      assertPendingLookupHmacState(value, {
        stateRevision: 3,
        activeGeneration: 2,
        activeSlot: 'B',
        activeKeyId: value.candidate.keyId,
        activeFingerprint: value.candidate.fingerprint,
        updatedAt: 3,
      })
    ).not.toThrow();
    expect(() =>
      assertPendingLookupHmacState(value, {
        stateRevision: 4,
        activeGeneration: 3,
        activeSlot: 'A',
        activeKeyId: 'unrelated-key',
        activeFingerprint: 'f'.repeat(64),
        updatedAt: 4,
      })
    ).toThrow('lookup_hmac_rotation_pending_state_stale');
  });

  it('does not replace the inactive slot until promotion and validates the staged secret', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'authrim-lookup-hmac-rotate-'));
    const keysDir = join(tempDir, 'keys');
    await mkdir(keysDir);
    const value = pending('lookup-hmac-operation-1');
    const activePath = join(keysDir, 'lookup_hmac_key_slot_a.txt');
    const inactivePath = join(keysDir, 'lookup_hmac_key_slot_b.txt');
    const stagedPath = join(keysDir, `.lookup_hmac_key_slot_b.txt.staged.${value.candidate.keyId}`);
    await writeFile(activePath, sourceSecret, { mode: 0o600 });
    await writeFile(inactivePath, 'old-inactive-secret', { mode: 0o600 });
    await writeFile(stagedPath, candidateSecret, { mode: 0o600 });

    expect(await readFile(inactivePath, 'utf8')).toBe('old-inactive-secret');
    await promoteLookupHmacCandidateSecret(keysDir, value);

    expect(await readFile(activePath, 'utf8')).toBe(sourceSecret);
    expect(await readFile(inactivePath, 'utf8')).toBe(candidateSecret);
    expect((await stat(inactivePath)).mode & 0o777).toBe(0o600);
    await expect(readFile(stagedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(stagedPath, 'tampered-secret', { mode: 0o600 });
    await writeFile(inactivePath, 'different-secret', { mode: 0o600 });
    await expect(promoteLookupHmacCandidateSecret(keysDir, value)).rejects.toThrow(
      'lookup_hmac_rotation_candidate_secret_missing'
    );
    expect(await readFile(inactivePath, 'utf8')).toBe('different-secret');
  });

  it('pins a resumed operation and rejects mismatched Control metadata', () => {
    const first = pending();
    expect(() => assertLookupHmacRotationMatchesPending(rotation(), first)).not.toThrow();
    const resumed = pending('lookup-hmac-operation-1');
    expect(() =>
      assertLookupHmacRotationMatchesPending(rotation('lookup-hmac-operation-2'), resumed)
    ).toThrow('lookup_hmac_rotation_control_state_mismatch');
    expect(() =>
      assertLookupHmacRotationMatchesPending(
        { ...rotation(), candidate: { ...rotation().candidate, fingerprint: 'a'.repeat(64) } },
        first
      )
    ).toThrow('lookup_hmac_rotation_control_state_mismatch');
  });

  it('strictly validates rotation and exact five-target verification responses', () => {
    expect(parseLookupHmacRotation(rotation())).toEqual(rotation());
    expect(
      parseLookupHmacVerificationStatus(
        {
          phase: 'distribution',
          expected: 5,
          succeeded: 5,
          failed: 0,
          pending: [],
          complete: true,
        },
        'distribution'
      )
    ).toEqual({ expected: 5, succeeded: 5, failed: 0, complete: true });
    expect(() =>
      parseLookupHmacVerificationStatus(
        {
          phase: 'generation',
          expected: 5,
          succeeded: 5,
          failed: 0,
          pending: [],
          complete: true,
        },
        'distribution'
      )
    ).toThrow('lookup_hmac_verification_status_invalid');
    expect(() =>
      parseLookupHmacVerificationStatus(
        {
          phase: 'distribution',
          expected: 5,
          succeeded: 4,
          failed: 0,
          pending: [],
          complete: true,
        },
        'distribution'
      )
    ).toThrow('lookup_hmac_verification_status_invalid');
  });
});

describe('Lookup HMAC rotation setup machine lifecycle', () => {
  const config = {} as AuthrimConfig;

  it('registers access before the action and removes it afterward', async () => {
    const calls: string[] = [];
    const result = await runWithEphemeralSetupMachineAccess(
      {
        env: 'test',
        config,
        keysDir: '/tmp/keys',
        ensure: async () => {
          calls.push('ensure');
          return { success: true };
        },
        cleanup: async () => {
          calls.push('cleanup');
          return { success: true };
        },
      },
      async () => {
        calls.push('action');
        return 'completed';
      }
    );

    expect(result).toBe('completed');
    expect(calls).toEqual(['ensure', 'action', 'cleanup']);
  });

  it('removes access after an action failure and preserves the action error', async () => {
    const failure = new Error('rotation_failed');
    let cleanedUp = false;

    await expect(
      runWithEphemeralSetupMachineAccess(
        {
          env: 'test',
          config,
          keysDir: '/tmp/keys',
          ensure: async () => ({ success: true }),
          cleanup: async () => {
            cleanedUp = true;
            return { success: true };
          },
        },
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
    expect(cleanedUp).toBe(true);
  });

  it('reports a cleanup failure after a successful action', async () => {
    await expect(
      runWithEphemeralSetupMachineAccess(
        {
          env: 'test',
          config,
          keysDir: '/tmp/keys',
          ensure: async () => ({ success: true }),
          cleanup: async () => ({ success: false, error: 'cleanup_failed' }),
        },
        async () => 'completed'
      )
    ).rejects.toThrow('lookup_hmac_setup_machine_cleanup_failed:cleanup_failed');
  });

  it('preserves both action and thrown cleanup failures', async () => {
    const actionError = new Error('rotation_failed');
    let caught: unknown;
    try {
      await runWithEphemeralSetupMachineAccess(
        {
          env: 'test',
          config,
          keysDir: '/tmp/keys',
          ensure: async () => ({ success: true }),
          cleanup: async () => {
            throw new Error('cleanup_response_lost');
          },
        },
        async () => {
          throw actionError;
        }
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([
      actionError,
      expect.objectContaining({
        message: 'lookup_hmac_setup_machine_cleanup_failed:cleanup_response_lost',
      }),
    ]);
  });

  it('does not run the action or cleanup when access registration is rejected', async () => {
    let actionRan = false;
    let cleanupRan = false;

    await expect(
      runWithEphemeralSetupMachineAccess(
        {
          env: 'test',
          config,
          keysDir: '/tmp/keys',
          ensure: async () => ({ success: false, error: 'bootstrap_failed' }),
          cleanup: async () => {
            cleanupRan = true;
            return { success: true };
          },
        },
        async () => {
          actionRan = true;
        }
      )
    ).rejects.toThrow('lookup_hmac_setup_machine_bootstrap_failed:bootstrap_failed');
    expect(actionRan).toBe(false);
    expect(cleanupRan).toBe(false);
  });
});
