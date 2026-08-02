import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateBase64Secret, generateEd25519JwkKeyPair } from '../core/keys.js';
import {
  initializeControlKeyState,
  reconcileLocalControlKeyFiles,
  type ControlKeyStateBatchExecutor,
} from '../core/control-key-state.js';
import type { D1BatchExecutionResult, D1BatchStatement } from '../core/cloudflare.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function keysDirectory(): Promise<{ directory: string; lookupSecret: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'authrim-control-key-state-'));
  temporaryDirectories.push(directory);
  const runtime = generateEd25519JwkKeyPair('runtime-v1');
  const smoke = generateEd25519JwkKeyPair('smoke-v1');
  const lookupSecret = generateBase64Secret(32);
  await Promise.all([
    writeFile(
      join(directory, 'tenant_runtime_registry_signing_private.jwk.json'),
      JSON.stringify(runtime.privateJwk)
    ),
    writeFile(
      join(directory, 'tenant_runtime_registry_verify.jwks.json'),
      JSON.stringify({ keys: [runtime.publicJwk] })
    ),
    writeFile(join(directory, 'tenant_runtime_registry_signing_key_id.txt'), runtime.keyId),
    writeFile(
      join(directory, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'),
      JSON.stringify(smoke.privateJwk)
    ),
    writeFile(
      join(directory, 'control_smoke_verify.jwks.json'),
      JSON.stringify({ keys: [smoke.publicJwk] })
    ),
    writeFile(join(directory, 'lookup_hmac_key_slot_a.txt'), lookupSecret),
  ]);
  return { directory, lookupSecret };
}

function result(results: unknown[] = []): D1BatchExecutionResult {
  return { success: true, results };
}

function jwkFingerprint(jwk: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('hex');
}

function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret.trim()).digest('hex');
}

function reflectedInitialization(batch: readonly D1BatchStatement[]): D1BatchExecutionResult[] {
  const runtime = batch[1].params!;
  const smoke = batch[2].params!;
  const lookup = batch[3].params!;
  return [
    result(),
    result(),
    result(),
    result(),
    result(),
    result(
      [runtime, smoke].map((params) => ({
        key_purpose: params[1],
        slot: 'a',
        key_id: params[2],
        public_jwk_json: params[3],
        public_key_fingerprint: params[4],
        state: 'active',
      }))
    ),
    result([
      {
        state_revision: 1,
        rotation_state: 'stable',
        write_mode: 'current_only',
        current_key_generation: 1,
        current_key_id: lookup[1],
        current_key_slot: 'A',
        current_key_fingerprint: lookup[2],
      },
    ]),
  ];
}

describe('Control key-state initialization', () => {
  it('registers public metadata atomically without sending private or HMAC key bodies to Control DB', async () => {
    const keys = await keysDirectory();
    let mutationBatch: readonly D1BatchStatement[] | undefined;
    const executeBatch: ControlKeyStateBatchExecutor = vi.fn(async (_databaseId, batch) => {
      if (batch.length === 1) {
        return [
          result([
            {
              active_signing_purposes: 0,
              malformed_signing_purposes: 0,
              lookup_state_count: 0,
            },
          ]),
        ];
      }
      mutationBatch = batch;
      return reflectedInitialization(batch);
    });

    const initialized = await initializeControlKeyState({
      controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
      environmentId: 'test',
      keysDir: keys.directory,
      now: 100,
      executeBatch,
    });

    expect(initialized.initialized).toBe(true);
    expect(initialized.operationId).toMatch(/^op_key_init_[a-f0-9]{32}$/u);
    expect(initialized.fingerprints).toEqual({
      runtimeRegistry: expect.stringMatching(/^[a-f0-9]{64}$/u),
      smokeRpc: expect.stringMatching(/^[a-f0-9]{64}$/u),
      lookupHmac: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const serialized = JSON.stringify(mutationBatch);
    expect(serialized).not.toContain(keys.lookupSecret);
    expect(serialized).not.toContain('"d"');
    expect(serialized).not.toContain('private');
    expect(mutationBatch).toHaveLength(7);
  });

  it('recovers local public files and active key id from authoritative slot metadata', async () => {
    const keys = await keysDirectory();
    const runtimeA = JSON.parse(
      await readFile(
        join(keys.directory, 'tenant_runtime_registry_signing_private.jwk.json'),
        'utf8'
      )
    );
    const smokeA = JSON.parse(
      await readFile(join(keys.directory, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'), 'utf8')
    );
    const runtimeB = generateEd25519JwkKeyPair('runtime-v2');
    const smokeB = generateEd25519JwkKeyPair('smoke-v2');
    const lookupB = generateBase64Secret(32);
    await Promise.all([
      writeFile(
        join(keys.directory, 'runtime_registry_signing_jwk_slot_b.private.jwk.json'),
        JSON.stringify(runtimeB.privateJwk)
      ),
      writeFile(
        join(keys.directory, 'smoke_rpc_signing_jwk_slot_b.private.jwk.json'),
        JSON.stringify(smokeB.privateJwk)
      ),
      writeFile(join(keys.directory, 'lookup_hmac_key_slot_b.txt'), lookupB),
    ]);

    await reconcileLocalControlKeyFiles({
      keysDir: keys.directory,
      controlKeyState: {
        runtimeRegistry: {
          activeSlot: 'B',
          activeKeyId: runtimeB.keyId,
          activeFingerprint: jwkFingerprint(runtimeB.publicJwk),
          previousSlot: 'A',
          previousKeyId: runtimeA.kid,
          previousFingerprint: jwkFingerprint(runtimeA),
          updatedAt: 200,
        },
        smokeRpc: {
          activeSlot: 'B',
          activeKeyId: smokeB.keyId,
          activeFingerprint: jwkFingerprint(smokeB.publicJwk),
          previousSlot: 'A',
          previousKeyId: smokeA.kid,
          previousFingerprint: jwkFingerprint(smokeA),
          updatedAt: 200,
        },
        lookupHmac: {
          stateRevision: 2,
          activeGeneration: 2,
          activeSlot: 'B',
          activeKeyId: 'lookup-v2',
          activeFingerprint: secretFingerprint(lookupB),
          previousGeneration: 1,
          previousSlot: 'A',
          previousKeyId: 'lookup-v1',
          previousFingerprint: secretFingerprint(keys.lookupSecret),
          updatedAt: 200,
        },
      },
    });

    expect(
      await readFile(join(keys.directory, 'tenant_runtime_registry_signing_key_id.txt'), 'utf8')
    ).toBe('runtime-v2');
    const runtimePublic = JSON.parse(
      await readFile(join(keys.directory, 'tenant_runtime_registry_verify.jwks.json'), 'utf8')
    );
    expect(runtimePublic.keys.map((key: { kid: string }) => key.kid)).toEqual([
      'runtime-v2',
      runtimeA.kid,
    ]);
    expect(JSON.stringify(runtimePublic)).not.toContain('"d"');
  });

  it('preserves a Control-authorized staged candidate in the deployment JWKS', async () => {
    const keys = await keysDirectory();
    const runtimeA = JSON.parse(
      await readFile(
        join(keys.directory, 'tenant_runtime_registry_signing_private.jwk.json'),
        'utf8'
      )
    );
    const smokeA = JSON.parse(
      await readFile(join(keys.directory, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'), 'utf8')
    );
    const runtimeB = generateEd25519JwkKeyPair('runtime-candidate');
    await writeFile(
      join(keys.directory, 'runtime_registry_signing_jwk_slot_b.private.jwk.json'),
      JSON.stringify(runtimeB.privateJwk)
    );

    await reconcileLocalControlKeyFiles({
      keysDir: keys.directory,
      controlKeyState: {
        runtimeRegistry: {
          activeSlot: 'A',
          activeKeyId: runtimeA.kid,
          activeFingerprint: jwkFingerprint(runtimeA),
          updatedAt: 300,
        },
        smokeRpc: {
          activeSlot: 'A',
          activeKeyId: smokeA.kid,
          activeFingerprint: jwkFingerprint(smokeA),
          updatedAt: 100,
        },
        lookupHmac: {
          stateRevision: 1,
          activeGeneration: 1,
          activeSlot: 'A',
          activeKeyId: 'lookup-v1',
          activeFingerprint: secretFingerprint(keys.lookupSecret),
          updatedAt: 100,
        },
      },
      stagedSigningKeys: [
        {
          purpose: 'runtime_registry',
          slot: 'B',
          keyId: runtimeB.keyId,
          fingerprint: jwkFingerprint(runtimeB.publicJwk),
          updatedAt: 300,
        },
      ],
    });

    const publicJwks = JSON.parse(
      await readFile(join(keys.directory, 'tenant_runtime_registry_verify.jwks.json'), 'utf8')
    );
    expect(publicJwks.keys.map((key: { kid: string }) => key.kid)).toEqual([
      runtimeA.kid,
      runtimeB.keyId,
    ]);
    expect(JSON.stringify(publicJwks)).not.toContain('"d"');
  });

  it('fails closed when a local Lookup slot does not match Control metadata', async () => {
    const keys = await keysDirectory();
    const runtime = JSON.parse(
      await readFile(
        join(keys.directory, 'tenant_runtime_registry_signing_private.jwk.json'),
        'utf8'
      )
    );
    const smoke = JSON.parse(
      await readFile(join(keys.directory, 'smoke_rpc_signing_jwk_slot_a.private.jwk.json'), 'utf8')
    );
    await expect(
      reconcileLocalControlKeyFiles({
        keysDir: keys.directory,
        controlKeyState: {
          runtimeRegistry: {
            activeSlot: 'A',
            activeKeyId: runtime.kid,
            activeFingerprint: jwkFingerprint(runtime),
            updatedAt: 100,
          },
          smokeRpc: {
            activeSlot: 'A',
            activeKeyId: smoke.kid,
            activeFingerprint: jwkFingerprint(smoke),
            updatedAt: 100,
          },
          lookupHmac: {
            stateRevision: 1,
            activeGeneration: 1,
            activeSlot: 'A',
            activeKeyId: 'lookup-v1',
            activeFingerprint: '0'.repeat(64),
            updatedAt: 100,
          },
        },
      })
    ).rejects.toThrow('control_lookup_hmac_local_active_key_mismatch');
  });

  it('treats complete existing state as authoritative without reading local keys', async () => {
    const executeBatch: ControlKeyStateBatchExecutor = vi.fn(async () => [
      result([
        {
          active_signing_purposes: 2,
          malformed_signing_purposes: 0,
          lookup_state_count: 1,
        },
      ]),
    ]);

    await expect(
      initializeControlKeyState({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir: '/does/not/exist',
        executeBatch,
      })
    ).resolves.toEqual({ initialized: false, operationId: null, fingerprints: null });
  });

  it('fails closed for partial state instead of filling missing rows from local files', async () => {
    const executeBatch: ControlKeyStateBatchExecutor = vi.fn(async () => [
      result([
        {
          active_signing_purposes: 1,
          malformed_signing_purposes: 0,
          lookup_state_count: 0,
        },
      ]),
    ]);

    await expect(
      initializeControlKeyState({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir: '/does/not/exist',
        executeBatch,
      })
    ).rejects.toThrow('control_key_state_partial_initialization');
  });

  it('rejects a public key that does not match the private slot', async () => {
    const keys = await keysDirectory();
    const mismatched = generateEd25519JwkKeyPair('runtime-v1');
    await writeFile(
      join(keys.directory, 'tenant_runtime_registry_verify.jwks.json'),
      JSON.stringify({ keys: [mismatched.publicJwk] })
    );
    const executeBatch: ControlKeyStateBatchExecutor = vi.fn(async () => [
      result([
        {
          active_signing_purposes: 0,
          malformed_signing_purposes: 0,
          lookup_state_count: 0,
        },
      ]),
    ]);

    await expect(
      initializeControlKeyState({
        controlDatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
        environmentId: 'test',
        keysDir: keys.directory,
        executeBatch,
      })
    ).rejects.toThrow('runtime_registry_initial_public_key_invalid');
  });
});
