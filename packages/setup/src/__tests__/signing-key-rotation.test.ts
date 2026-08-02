import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519JwkKeyPair } from '../core/keys.js';
import type { ControlKeyState } from '../core/lock.js';
import {
  activateControlSigningKeyRotation,
  SIGNING_KEY_PREVIOUS_ROLLBACK_WINDOW_SECONDS,
  stageControlSigningKeyRotation,
  type SigningKeyRotationBatchExecutor,
  type StagedSigningKeyRotation,
} from '../core/signing-key-rotation.js';
import type { D1BatchExecutionResult, D1BatchStatement } from '../core/cloudflare.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function result(results: unknown[] = []): D1BatchExecutionResult {
  return { success: true, results };
}

function fingerprint(jwk: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('hex');
}

function keyState(input: {
  purpose: 'runtime_registry' | 'smoke_rpc';
  keyId: string;
  keyFingerprint: string;
  previous?: boolean;
  updatedAt?: number;
}): ControlKeyState {
  const selected = {
    activeSlot: 'A' as const,
    activeKeyId: input.keyId,
    activeFingerprint: input.keyFingerprint,
    ...(input.previous
      ? {
          previousSlot: 'B' as const,
          previousKeyId: `${input.keyId}-previous`,
          previousFingerprint: 'f'.repeat(64),
        }
      : {}),
    updatedAt: input.updatedAt ?? 100,
  };
  const fallback = {
    activeSlot: 'A' as const,
    activeKeyId: 'fallback-v1',
    activeFingerprint: 'e'.repeat(64),
    updatedAt: 100,
  };
  return {
    runtimeRegistry: input.purpose === 'runtime_registry' ? selected : fallback,
    smokeRpc: input.purpose === 'smoke_rpc' ? selected : fallback,
    lookupHmac: {
      stateRevision: 1,
      activeGeneration: 1,
      activeSlot: 'A',
      activeKeyId: 'lookup-v1',
      activeFingerprint: 'd'.repeat(64),
      updatedAt: 100,
    },
  };
}

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'authrim-signing-rotation-'));
  temporaryDirectories.push(value);
  return value;
}

describe('Control signing-key rotation', () => {
  it('stages an inactive private slot and public candidate without putting private material in Control DB', async () => {
    const keysDir = await directory();
    const active = generateEd25519JwkKeyPair('runtime-v1');
    const activeFingerprint = fingerprint(active.publicJwk);
    let stagedBatch: readonly D1BatchStatement[] | undefined;
    const executeBatch: SigningKeyRotationBatchExecutor = vi.fn(async (_databaseId, batch) => {
      if (batch.length === 1) {
        return [
          result([
            {
              slot: 'a',
              key_id: active.keyId,
              public_jwk_json: JSON.stringify(active.publicJwk),
              public_key_fingerprint: activeFingerprint,
              state: 'active',
              updated_at: 100,
            },
          ]),
        ];
      }
      stagedBatch = batch;
      const candidate = batch[2].params!;
      return [
        result(),
        result(),
        result(),
        result(),
        result(),
        result([
          {
            slot: 'a',
            key_id: active.keyId,
            public_jwk_json: JSON.stringify(active.publicJwk),
            public_key_fingerprint: activeFingerprint,
            state: 'active',
            updated_at: 10_000,
          },
          {
            slot: candidate[2],
            key_id: candidate[3],
            public_jwk_json: candidate[4],
            public_key_fingerprint: candidate[5],
            state: 'staged',
            updated_at: candidate[7],
          },
        ]),
      ];
    });

    const staged = await stageControlSigningKeyRotation({
      controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
      environmentId: 'test',
      keysDir,
      purpose: 'runtime_registry',
      controlKeyState: keyState({
        purpose: 'runtime_registry',
        keyId: active.keyId,
        keyFingerprint: activeFingerprint,
      }),
      now: 10_000,
      executeBatch,
    });

    expect(staged).toMatchObject({
      activeSlot: 'A',
      candidateSlot: 'B',
      activeKeyId: 'runtime-v1',
      privateSecretName: 'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B',
      verifyingSecretName: 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
      resumed: false,
    });
    const privateJwk = JSON.parse(
      await readFile(join(keysDir, 'runtime_registry_signing_jwk_slot_b.private.jwk.json'), 'utf8')
    );
    expect(privateJwk.d).toBeTypeOf('string');
    expect(privateJwk.kid).toBe(staged.candidateKeyId);
    const publicJwks = JSON.parse(
      await readFile(join(keysDir, 'tenant_runtime_registry_verify.jwks.json'), 'utf8')
    );
    expect(publicJwks.keys.map((key: { kid: string }) => key.kid)).toEqual([
      'runtime-v1',
      staged.candidateKeyId,
    ]);
    expect(JSON.stringify(publicJwks)).not.toContain('"d"');
    expect(JSON.stringify(stagedBatch)).not.toContain(privateJwk.d);
    expect(stagedBatch?.[1].sql).toContain('SET updated_at = ?');
    expect(stagedBatch?.[2].sql).toContain('WHERE EXISTS');
    expect(stagedBatch?.[3].sql).toContain('WHERE EXISTS');
    expect(stagedBatch?.[4].sql).toContain('WHERE EXISTS');
  });

  it('does not overwrite an inactive rollback key before the Control transaction commits', async () => {
    const keysDir = await directory();
    const active = generateEd25519JwkKeyPair('runtime-v2');
    const previous = generateEd25519JwkKeyPair('runtime-v1');
    const inactivePath = join(keysDir, 'runtime_registry_signing_jwk_slot_b.private.jwk.json');
    await writeFile(inactivePath, JSON.stringify(previous.privateJwk));
    const executeBatch: SigningKeyRotationBatchExecutor = vi.fn(async (_databaseId, batch) => {
      if (batch.length === 1) {
        return [
          result([
            {
              slot: 'a',
              key_id: active.keyId,
              public_jwk_json: JSON.stringify(active.publicJwk),
              public_key_fingerprint: fingerprint(active.publicJwk),
              state: 'active',
              updated_at: 100,
            },
            {
              slot: 'b',
              key_id: previous.keyId,
              public_jwk_json: JSON.stringify(previous.publicJwk),
              public_key_fingerprint: fingerprint(previous.publicJwk),
              state: 'previous',
              updated_at: 100,
            },
          ]),
        ];
      }
      throw new Error('simulated_control_commit_failure');
    });

    await expect(
      stageControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir,
        purpose: 'runtime_registry',
        controlKeyState: keyState({
          purpose: 'runtime_registry',
          keyId: active.keyId,
          keyFingerprint: fingerprint(active.publicJwk),
          previous: true,
          updatedAt: 100,
        }),
        now: 10_000,
        executeBatch,
      })
    ).rejects.toThrow('simulated_control_commit_failure');

    expect(JSON.parse(await readFile(inactivePath, 'utf8')).kid).toBe(previous.keyId);
    expect((await readdir(keysDir)).some((name) => name.includes('.staged.'))).toBe(true);
  });

  it('promotes a pending private key when resuming after a lost Control response', async () => {
    const keysDir = await directory();
    const active = generateEd25519JwkKeyPair('smoke-v1');
    const candidate = generateEd25519JwkKeyPair('smoke-v2');
    const pendingPath = join(
      keysDir,
      `.smoke_rpc_signing_jwk_slot_b.private.jwk.json.staged.${candidate.keyId}`
    );
    await writeFile(pendingPath, JSON.stringify(candidate.privateJwk));
    const executeBatch: SigningKeyRotationBatchExecutor = vi.fn(async () => [
      result([
        {
          slot: 'a',
          key_id: active.keyId,
          public_jwk_json: JSON.stringify(active.publicJwk),
          public_key_fingerprint: fingerprint(active.publicJwk),
          state: 'active',
          updated_at: 10_000,
        },
        {
          slot: 'b',
          key_id: candidate.keyId,
          public_jwk_json: JSON.stringify(candidate.publicJwk),
          public_key_fingerprint: fingerprint(candidate.publicJwk),
          state: 'staged',
          updated_at: 10_000,
        },
      ]),
    ]);

    await expect(
      stageControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir,
        purpose: 'smoke_rpc',
        controlKeyState: keyState({
          purpose: 'smoke_rpc',
          keyId: active.keyId,
          keyFingerprint: fingerprint(active.publicJwk),
          updatedAt: 10_000,
        }),
        now: 10_100,
        executeBatch,
      })
    ).resolves.toMatchObject({
      candidateKeyId: candidate.keyId,
      candidateSlot: 'B',
      resumed: true,
    });
    expect(
      JSON.parse(
        await readFile(join(keysDir, 'smoke_rpc_signing_jwk_slot_b.private.jwk.json'), 'utf8')
      ).kid
    ).toBe(candidate.keyId);
  });

  it('rejects a tampered staged key id before deriving a pending file path', async () => {
    const keysDir = await directory();
    const active = generateEd25519JwkKeyPair('smoke-v1');
    const candidate = generateEd25519JwkKeyPair('smoke-v2');
    const tamperedPublic = { ...candidate.publicJwk, kid: '../outside' };
    await expect(
      stageControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir,
        purpose: 'smoke_rpc',
        controlKeyState: keyState({
          purpose: 'smoke_rpc',
          keyId: active.keyId,
          keyFingerprint: fingerprint(active.publicJwk),
          updatedAt: 10_000,
        }),
        now: 10_100,
        executeBatch: vi.fn(async () => [
          result([
            {
              slot: 'a',
              key_id: active.keyId,
              public_jwk_json: JSON.stringify(active.publicJwk),
              public_key_fingerprint: fingerprint(active.publicJwk),
              state: 'active',
              updated_at: 10_000,
            },
            {
              slot: 'b',
              key_id: '../outside',
              public_jwk_json: JSON.stringify(tamperedPublic),
              public_key_fingerprint: fingerprint(tamperedPublic),
              state: 'staged',
              updated_at: 10_000,
            },
          ]),
        ]),
      })
    ).rejects.toThrow('signing_key_rotation_staged_metadata_invalid');
  });

  it('refuses to overwrite a previous slot while its rollback window is active', async () => {
    const active = generateEd25519JwkKeyPair('smoke-v2');
    const now = 20_000;
    await expect(
      stageControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir: await directory(),
        purpose: 'smoke_rpc',
        controlKeyState: keyState({
          purpose: 'smoke_rpc',
          keyId: active.keyId,
          keyFingerprint: fingerprint(active.publicJwk),
          previous: true,
          updatedAt: now - SIGNING_KEY_PREVIOUS_ROLLBACK_WINDOW_SECONDS + 1,
        }),
        now,
        executeBatch: vi.fn(),
      })
    ).rejects.toThrow('signing_key_rotation_previous_key_rollback_window_active');
  });

  it('atomically reflects active and previous metadata before updating the runtime key id file', async () => {
    const keysDir = await directory();
    await writeFile(join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'), 'runtime-v1');
    const staged: StagedSigningKeyRotation = {
      purpose: 'runtime_registry',
      activeSlot: 'A',
      candidateSlot: 'B',
      activeKeyId: 'runtime-v1',
      candidateKeyId: 'runtime-v2',
      activeFingerprint: 'a'.repeat(64),
      candidateFingerprint: 'b'.repeat(64),
      privateSecretName: 'RUNTIME_REGISTRY_SIGNING_JWK_SLOT_B',
      verifyingSecretName: 'TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS',
      operationId: `op_key_stage_${'c'.repeat(32)}`,
      resumed: false,
    };
    let activationBatch: readonly D1BatchStatement[] | undefined;
    const executeBatch: SigningKeyRotationBatchExecutor = vi.fn(async (_databaseId, batch) => {
      activationBatch = batch;
      return [
        result(),
        result(),
        result(),
        result(),
        result([
          {
            slot: 'b',
            key_id: 'runtime-v2',
            public_jwk_json: '{}',
            public_key_fingerprint: 'b'.repeat(64),
            state: 'active',
            updated_at: 200,
          },
          {
            slot: 'a',
            key_id: 'runtime-v1',
            public_jwk_json: '{}',
            public_key_fingerprint: 'a'.repeat(64),
            state: 'previous',
            updated_at: 200,
          },
        ]),
      ];
    });

    await activateControlSigningKeyRotation({
      controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
      environmentId: 'test',
      keysDir,
      staged,
      expectedWorkerScriptNames: ['test-ar-auth', 'test-ar-management'],
      now: 200,
      executeBatch,
    });

    expect(activationBatch).toHaveLength(5);
    expect(activationBatch?.[0].sql).toContain("state = 'previous'");
    expect(activationBatch?.[1].sql).toContain("state = 'active'");
    expect(activationBatch?.[0].sql).toContain('control_signing_key_verifications');
    expect(
      await readFile(join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'), 'utf8')
    ).toBe('runtime-v2');
  });

  it('rejects duplicate verification targets before attempting activation', async () => {
    const executeBatch = vi.fn();
    await expect(
      activateControlSigningKeyRotation({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir: await directory(),
        staged: {
          purpose: 'smoke_rpc',
          activeSlot: 'A',
          candidateSlot: 'B',
          activeKeyId: 'smoke-v1',
          candidateKeyId: 'smoke-v2',
          activeFingerprint: 'a'.repeat(64),
          candidateFingerprint: 'b'.repeat(64),
          privateSecretName: 'SMOKE_RPC_SIGNING_JWK_SLOT_B',
          verifyingSecretName: 'CONTROL_SMOKE_VERIFYING_PUBLIC_JWKS',
          operationId: `op_key_stage_${'c'.repeat(32)}`,
          resumed: false,
        },
        expectedWorkerScriptNames: ['test-ar-auth', 'test-ar-auth'],
        executeBatch,
      })
    ).rejects.toThrow('signing_key_rotation_verification_targets_invalid');
    expect(executeBatch).not.toHaveBeenCalled();
  });
});
