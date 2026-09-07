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
  type LookupHmacRotation,
  type PendingLookupHmacRotation,
} from '../cli/commands/lookup-hmac-rotate.js';

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
  it('authorizes every Control phase under a fresh exact-D1 environment lock', async () => {
    const source = await readFile(
      new URL('../cli/commands/lookup-hmac-rotate.ts', import.meta.url),
      'utf8'
    );
    const lockIndex = source.indexOf('await acquireEnvironmentOperationForEnvironment({');
    const initialConfigIdentity = source.indexOf(
      'if (config.environment.prefix !== env)',
      source.indexOf('async function loadEnvironment(')
    );
    const lockedConfigIdentity = source.indexOf(
      'if (lockedConfig.environment.prefix !== context.env)',
      lockIndex
    );
    const lockIdentity = source.indexOf('if (operationLock.lock.env !== context.env)', lockIndex);
    const identityIndex = source.indexOf('assertFixedD1ResourceIdentities({', lockIndex);
    const adminIdentifierIndex = source.indexOf(
      'const adminDatabaseIdentifier = operationLock.lock.d1.DB_ADMIN?.id;',
      identityIndex
    );
    const machineAccessIndex = source.indexOf(
      'return await runEphemeralSetupMachineAccess({',
      adminIdentifierIndex
    );

    expect(lockIndex).toBeGreaterThan(-1);
    expect(initialConfigIdentity).toBeGreaterThan(-1);
    expect(lockIdentity).toBeGreaterThan(lockIndex);
    expect(lockedConfigIdentity).toBeGreaterThan(lockIndex);
    expect(identityIndex).toBeGreaterThan(lockIndex);
    expect(identityIndex).toBeGreaterThan(lockedConfigIdentity);
    expect(adminIdentifierIndex).toBeGreaterThan(identityIndex);
    expect(machineAccessIndex).toBeGreaterThan(adminIdentifierIndex);
    expect(source.slice(machineAccessIndex, machineAccessIndex + 300)).toContain(
      'databaseIdentifier: adminDatabaseIdentifier'
    );
    expect(source).toContain('lock.d1.CONTROL_DB?.id');
    expect(source).not.toContain('lock.d1.CONTROL_DB?.name');
  });

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
