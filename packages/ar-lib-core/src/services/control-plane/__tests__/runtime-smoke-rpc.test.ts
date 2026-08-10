import { CompactSign, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_SMOKE_JWS_TYPE,
  RUNTIME_SMOKE_LOOKUP_METADATA_KEY,
  inspectRuntimeSmokeBinding,
  runtimeSmokeJti,
  signRuntimeSmokeRequest,
  verifyRuntimeSmokeRequest,
  type RuntimeSmokeClaims,
  type RuntimeSmokeD1Database,
  type RuntimeSmokeRequestInput,
} from '../runtime-smoke-rpc';

const NOW = 1_785_283_200;
const REQUEST: RuntimeSmokeRequestInput = {
  environmentId: 'test',
  operationId: 'op_123',
  attempt: 2,
  targetWorker: 'test-ar-auth',
  bindingRef: 'TEST_TDB_DEFAULT_1234_CORE',
  expectedMigrationGeneration: 4,
  dataRole: 'tenant_core/default',
  residencyPartition: 'default',
};

let privateJwk: JWK;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateJwk = { ...(await exportJWK(pair.privateKey)), kid: 'smoke-a', alg: 'EdDSA', use: 'sig' };
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'smoke-a', alg: 'EdDSA', use: 'sig' };
});

async function signed(request: RuntimeSmokeRequestInput = REQUEST, now = NOW): Promise<string> {
  return signRuntimeSmokeRequest({ request, privateJwk, keyId: 'smoke-a', now });
}

async function signRaw(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const key = await importJWK(privateJwk, 'EdDSA');
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader({
      alg: 'EdDSA',
      typ: RUNTIME_SMOKE_JWS_TYPE,
      kid: 'smoke-a',
      ...header,
    })
    .sign(key);
}

function verification(overrides: Record<string, unknown> = {}) {
  return {
    environmentId: 'test',
    targetWorker: 'test-ar-auth',
    publicJwks: { keys: [publicJwk] },
    now: NOW,
    ...overrides,
  };
}

describe('runtime smoke RPC JWS', () => {
  it('signs and verifies the exact 30-second request contract', async () => {
    const token = await signed();
    const claims = await verifyRuntimeSmokeRequest(token, verification());

    expect(claims).toEqual({
      iss: 'authrim-control:test',
      aud: 'test-ar-auth',
      iat: NOW,
      exp: NOW + 30,
      jti: 'op_123:2:test-ar-auth:TEST_TDB_DEFAULT_1234_CORE',
      operationId: 'op_123',
      attempt: 2,
      targetWorker: 'test-ar-auth',
      bindingRef: 'TEST_TDB_DEFAULT_1234_CORE',
      expectedMigrationGeneration: 4,
      dataRole: 'tenant_core/default',
      residencyPartition: 'default',
    });
  });

  it('accepts current and previous keys but rejects unknown and private JWKS material', async () => {
    const previous = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const previousPublic = {
      ...(await exportJWK(previous.publicKey)),
      kid: 'smoke-previous',
      alg: 'EdDSA',
      use: 'sig',
    };
    const token = await signed();
    await expect(
      verifyRuntimeSmokeRequest(
        token,
        verification({ publicJwks: { keys: [previousPublic, publicJwk] } })
      )
    ).resolves.toMatchObject({ operationId: 'op_123' });
    await expect(
      verifyRuntimeSmokeRequest(token, verification({ publicJwks: { keys: [previousPublic] } }))
    ).rejects.toThrow('runtime_smoke_unknown_key');
    await expect(
      verifyRuntimeSmokeRequest(token, verification({ publicJwks: { keys: [{ ...privateJwk }] } }))
    ).rejects.toThrow('runtime_smoke_public_jwks_contains_private_material');
  });

  it('rejects target, issuer, JTI, TTL, expiry, future issue time, and unknown claims', async () => {
    const valid = await verifyRuntimeSmokeRequest(await signed(), verification());
    const cases: Array<[string, Record<string, unknown>, number?]> = [
      ['runtime_smoke_target_mismatch', { ...valid, aud: 'test-ar-token' }],
      ['runtime_smoke_target_mismatch', { ...valid, targetWorker: 'test-ar-token' }],
      ['runtime_smoke_issuer_mismatch', { ...valid, iss: 'authrim-control:other' }],
      ['runtime_smoke_jti_mismatch', { ...valid, jti: 'wrong' }],
      ['runtime_smoke_ttl_invalid', { ...valid, exp: valid.iat + 31 }],
      ['runtime_smoke_expired', { ...valid, iat: NOW - 40, exp: NOW - 10 }],
      ['runtime_smoke_not_yet_valid', { ...valid, iat: NOW + 6, exp: NOW + 36 }],
      ['runtime_smoke_unknown_claim', { ...valid, rawSql: 'SELECT secret FROM users' }],
    ];
    for (const [error, claims] of cases) {
      await expect(
        verifyRuntimeSmokeRequest(await signRaw(claims), verification())
      ).rejects.toThrow(error);
    }
  });

  it('rejects malformed identifiers before signing and derives replay identity deterministically', async () => {
    await expect(signed({ ...REQUEST, bindingRef: 'DB' })).rejects.toThrow(
      'runtime_smoke_invalid_binding_ref'
    );
    await expect(signed({ ...REQUEST, bindingRef: 'TDB_DEFAULT_1234_CORE' })).rejects.toThrow(
      'runtime_smoke_invalid_binding_ref'
    );
    await expect(signed({ ...REQUEST, attempt: 0 })).rejects.toThrow(
      'runtime_smoke_invalid_attempt'
    );
    expect(runtimeSmokeJti(REQUEST)).toBe(runtimeSmokeJti(REQUEST));
    expect(runtimeSmokeJti({ ...REQUEST, attempt: 3 })).not.toBe(runtimeSmokeJti(REQUEST));
  });

  it('rejects an invalid signature and oversized input without leaking parser details', async () => {
    const token = await signed();
    const segments = token.split('.');
    segments[2] = `${segments[2]!.startsWith('a') ? 'b' : 'a'}${segments[2]!.slice(1)}`;
    await expect(verifyRuntimeSmokeRequest(segments.join('.'), verification())).rejects.toThrow(
      'runtime_smoke_signature_invalid'
    );
    await expect(verifyRuntimeSmokeRequest('x'.repeat(9 * 1024), verification())).rejects.toThrow(
      'runtime_smoke_invalid_jws'
    );
    await expect(verifyRuntimeSmokeRequest('x.y.z', verification())).rejects.toThrow(
      'runtime_smoke_invalid_protected_header'
    );
    await expect(
      verifyRuntimeSmokeRequest(
        await signRaw(await verifyRuntimeSmokeRequest(await signed(), verification()), {
          jku: 'https://attacker.invalid/jwks.json',
        }),
        verification()
      )
    ).rejects.toThrow('runtime_smoke_invalid_protected_header');
  });
});

function database(input: {
  metadata?: Partial<Record<string, unknown>> | null;
  migration?: { applied_count: number; last_filename_present: number } | null;
}) {
  const metadata =
    input.metadata === null
      ? null
      : {
          binding_ref: REQUEST.bindingRef,
          data_role: REQUEST.dataRole,
          residency_partition: REQUEST.residencyPartition,
          migration_generation: REQUEST.expectedMigrationGeneration,
          release_id: 'release-1',
          manifest_digest: 'a'.repeat(64),
          expected_file_count: 33,
          last_filename: '033_control_plane_shard_metadata.sql',
          ...input.metadata,
        };
  const migration = input.migration ?? { applied_count: 33, last_filename_present: 1 };
  const bind = vi.fn();
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: (...values: unknown[]) => {
        bind(...values);
        return statement;
      },
      first: async () =>
        sql.includes('lookup_schema_metadata')
          ? metadata === null
            ? null
            : { metadata_value: JSON.stringify(metadata) }
          : sql.includes('authrim_control_plane_shard_metadata')
            ? metadata
            : migration,
    };
    return statement;
  });
  return { value: { prepare } as RuntimeSmokeD1Database, prepare, bind };
}

function claims(): RuntimeSmokeClaims {
  return {
    iss: 'authrim-control:test',
    aud: REQUEST.targetWorker,
    iat: NOW,
    exp: NOW + 30,
    jti: runtimeSmokeJti(REQUEST),
    operationId: REQUEST.operationId,
    attempt: REQUEST.attempt,
    targetWorker: REQUEST.targetWorker,
    bindingRef: REQUEST.bindingRef,
    expectedMigrationGeneration: REQUEST.expectedMigrationGeneration,
    dataRole: REQUEST.dataRole,
    residencyPartition: REQUEST.residencyPartition,
  };
}

const VERSION = {
  id: 'version-123',
  tag: 'control-smoke',
  timestamp: '2026-07-29T00:00:00.000Z',
};

describe('runtime smoke D1 inspection', () => {
  it('returns only routing and version evidence after metadata and migration verification', async () => {
    const db = database({});
    await expect(
      inspectRuntimeSmokeBinding({
        claims: claims(),
        binding: db.value,
        versionMetadata: VERSION,
        now: NOW,
      })
    ).resolves.toEqual({
      bindingRef: REQUEST.bindingRef,
      migrationGeneration: 4,
      dataRole: 'tenant_core/default',
      residencyPartition: 'default',
      checkedAt: NOW,
      observedVersionId: 'version-123',
      observedVersionTag: 'control-smoke',
      observedVersionTimestamp: '2026-07-29T00:00:00.000Z',
    });
    expect(db.bind).toHaveBeenCalledWith('033_control_plane_shard_metadata.sql');
  });

  it('reads Lookup smoke metadata from the existing Lookup schema metadata table', async () => {
    const lookupClaims: RuntimeSmokeClaims = {
      ...claims(),
      bindingRef: 'TEST_TDB_LOOKUP_1234_LOOKUP',
      dataRole: 'lookup',
    };
    const db = database({
      metadata: {
        binding_ref: lookupClaims.bindingRef,
        data_role: 'lookup',
      },
    });

    await expect(
      inspectRuntimeSmokeBinding({
        claims: lookupClaims,
        binding: db.value,
        versionMetadata: VERSION,
        now: NOW,
      })
    ).resolves.toMatchObject({
      bindingRef: lookupClaims.bindingRef,
      dataRole: 'lookup',
    });
    expect(db.prepare.mock.calls[0]?.[0]).toContain('lookup_schema_metadata');
    expect(db.bind).toHaveBeenCalledWith(RUNTIME_SMOKE_LOOKUP_METADATA_KEY);
  });

  it('rejects Lookup metadata JSON with extra fields', async () => {
    const lookupClaims: RuntimeSmokeClaims = {
      ...claims(),
      bindingRef: 'TEST_TDB_LOOKUP_1234_LOOKUP',
      dataRole: 'lookup',
    };
    const db = database({
      metadata: {
        binding_ref: lookupClaims.bindingRef,
        data_role: 'lookup',
        unexpected: 'value',
      },
    });

    await expect(
      inspectRuntimeSmokeBinding({
        claims: lookupClaims,
        binding: db.value,
        versionMetadata: VERSION,
      })
    ).rejects.toThrow('runtime_smoke_metadata_invalid');
  });

  it.each([
    ['runtime_smoke_binding_unavailable', null, database({}).value, VERSION],
    ['runtime_smoke_binding_not_d1', {}, database({}).value, VERSION],
    ['runtime_smoke_version_metadata_invalid', database({}).value, database({}).value, {}],
    ['runtime_smoke_metadata_missing', database({ metadata: null }).value, null, VERSION],
    [
      'runtime_smoke_metadata_mismatch',
      database({ metadata: { binding_ref: 'TEST_TDB_OTHER_CORE' } }).value,
      null,
      VERSION,
    ],
    [
      'runtime_smoke_migration_state_mismatch',
      database({ migration: { applied_count: 32, last_filename_present: 1 } }).value,
      null,
      VERSION,
    ],
  ])('fails closed with %s', async (error, binding, _unused, versionMetadata) => {
    await expect(
      inspectRuntimeSmokeBinding({
        claims: claims(),
        binding,
        versionMetadata,
        now: NOW,
      })
    ).rejects.toThrow(error);
  });
});
