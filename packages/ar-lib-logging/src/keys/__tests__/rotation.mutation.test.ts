import { describe, expect, it } from 'vitest';
import {
  activateCredentialRotation,
  finishCredentialRetirement,
  markCredentialRotationReady,
  prepareCredentialRotation,
  type CredentialRotationState,
} from '../credential-rotation';
import { buildRuntimeLoggingKeyRegistrySnapshot } from '../key-registry-snapshot';
import type { LoggingKeyRegistryRow, LoggingKeyVersionRow } from '../key-registry-snapshot';
import { rotateLoggingKeyRegistry } from '../key-rotation';

const registry: LoggingKeyRegistryRow = {
  id: 'reg_1',
  tenantKey: 't_1',
  surface: 'admin',
  logType: 'audit',
  plane: 'archive',
  activeVersion: 2,
  status: 'active',
  lastRotatedAt: 5,
  updatedAt: 6,
};

const ref = (version: number, scope = 'reg_1') => `logkey:d1_wrapped_key:${scope}:v${version}:key`;

function version(overrides: Partial<LoggingKeyVersionRow>): LoggingKeyVersionRow {
  return {
    keyRegistryId: 'reg_1',
    version: 2,
    backendRef: ref(2),
    status: 'active',
    usageCount: 0,
    staleCount: 0,
    createdAt: 10,
    retiredAt: null,
    ...overrides,
  };
}

describe('rotateLoggingKeyRegistry', () => {
  it('retires an unused active version and activates the next one', () => {
    const old = version({ version: 2 });
    const result = rotateLoggingKeyRegistry({
      registry,
      versions: [old],
      newBackendRef: ref(3),
      now: 100,
    });
    expect(result.registry).toStrictEqual({
      ...registry,
      activeVersion: 3,
      status: 'active',
      lastRotatedAt: 100,
      updatedAt: 100,
    });
    expect(result.versions).toStrictEqual([
      { ...old, status: 'retired', retiredAt: 100, staleCount: 0 },
      {
        keyRegistryId: 'reg_1',
        version: 3,
        backendRef: ref(3),
        status: 'active',
        usageCount: 0,
        staleCount: 0,
        createdAt: 100,
        retiredAt: null,
      },
    ]);
    expect(result.previousActiveVersions).toStrictEqual([old]);
  });

  it('keeps a version that still protects data until it is rewrapped, and marks the registry stale', () => {
    for (const usage of [{ usageCount: 3 }, { staleCount: 1 }, { usageCount: 1, staleCount: 5 }]) {
      const old = version(usage);
      const result = rotateLoggingKeyRegistry({
        registry,
        versions: [old],
        newBackendRef: ref(3),
        now: 100,
      });
      expect(result.registry.status).toBe('stale');
      expect(result.versions[0]).toStrictEqual({
        ...old,
        status: 'rewrap_required',
        retiredAt: null,
        staleCount: Math.max(old.staleCount, old.usageCount),
      });
    }
  });

  it('counts the larger of the usage and the stale count as stale', () => {
    const result = rotateLoggingKeyRegistry({
      registry,
      versions: [version({ usageCount: 9, staleCount: 2 })],
      newBackendRef: ref(3),
      now: 1,
    });
    expect(result.versions[0]?.staleCount).toBe(9);
    const other = rotateLoggingKeyRegistry({
      registry,
      versions: [version({ usageCount: 2, staleCount: 9 })],
      newBackendRef: ref(3),
      now: 1,
    });
    expect(other.versions[0]?.staleCount).toBe(9);
  });

  it('leaves versions that are not active as they were', () => {
    const retired = version({ version: 1, status: 'retired', retiredAt: 7 });
    const compromised = version({ version: 3, status: 'compromised', backendRef: ref(3) });
    const result = rotateLoggingKeyRegistry({
      registry: { ...registry, activeVersion: 3 },
      versions: [retired, compromised],
      newBackendRef: ref(4),
      now: 100,
    });
    expect(result.versions.slice(0, 2)).toStrictEqual([retired, compromised]);
    expect(result.previousActiveVersions).toEqual([]);
    expect(result.registry.status).toBe('active');
  });

  it('numbers the next version after the highest version known, whatever the registry says', () => {
    const higher = rotateLoggingKeyRegistry({
      registry: { ...registry, activeVersion: 1 },
      versions: [
        version({ version: 1, status: 'retired' }),
        version({ version: 5, status: 'retired' }),
      ],
      newBackendRef: ref(6),
      now: 1,
    });
    expect(higher.registry.activeVersion).toBe(6);
    const lower = rotateLoggingKeyRegistry({
      registry: { ...registry, activeVersion: 7 },
      versions: [version({ version: 1, status: 'retired' })],
      newBackendRef: ref(8),
      now: 1,
    });
    expect(lower.registry.activeVersion).toBe(8);
  });

  it('refuses a backend reference of another version', () => {
    for (const wrong of [ref(2), ref(4), ref(10)]) {
      expect(() =>
        rotateLoggingKeyRegistry({
          registry,
          versions: [version({})],
          newBackendRef: wrong,
          now: 1,
        })
      ).toThrow('logging_key_rotation_backend_ref_version_mismatch');
    }
  });

  it('only touches the versions of its own registry', () => {
    const own = version({});
    const foreign = version({
      keyRegistryId: 'reg_other',
      version: 9,
      backendRef: ref(9, 'reg_other'),
    });
    const result = rotateLoggingKeyRegistry({
      registry,
      versions: [own, foreign],
      newBackendRef: ref(3),
      now: 100,
    });
    expect(result.versions[0]).toStrictEqual(foreign);
    expect(result.versions).toHaveLength(3);
    expect(result.previousActiveVersions).toEqual([own]);
    expect(result.registry.activeVersion).toBe(3);
  });

  it('starts a registry with no versions at the version after its active one', () => {
    const result = rotateLoggingKeyRegistry({
      registry,
      versions: [],
      newBackendRef: ref(3),
      now: 1,
    });
    expect(result.versions).toHaveLength(1);
    expect(result.registry.status).toBe('active');
  });
});

const state = (overrides: Partial<CredentialRotationState> = {}): CredentialRotationState => ({
  credentialRef: 'cred://cur',
  credentialVersion: 1,
  nextCredentialRef: null,
  nextCredentialVersion: null,
  previousCredentialRef: null,
  previousCredentialRetireAfter: null,
  rotationStatus: 'none',
  ...overrides,
});

describe('credential rotation', () => {
  it('prepares the next credential for testing', () => {
    expect(
      prepareCredentialRotation(state(), { credentialRef: 'cred://next', credentialVersion: 2 })
    ).toStrictEqual(
      state({
        nextCredentialRef: 'cred://next',
        nextCredentialVersion: 2,
        rotationStatus: 'testing',
      })
    );
  });

  it('is ready only when a next credential is prepared', () => {
    const prepared = state({
      nextCredentialRef: 'cred://next',
      nextCredentialVersion: 2,
      rotationStatus: 'testing',
    });
    expect(markCredentialRotationReady(prepared)).toStrictEqual({
      ...prepared,
      rotationStatus: 'ready',
    });
    expect(
      markCredentialRotationReady(state({ nextCredentialRef: 'cred://next' })).rotationStatus
    ).toBe('failed');
    expect(markCredentialRotationReady(state({ nextCredentialVersion: 2 })).rotationStatus).toBe(
      'failed'
    );
    expect(markCredentialRotationReady(state()).rotationStatus).toBe('failed');
    expect(
      markCredentialRotationReady(
        state({ nextCredentialRef: 'cred://next', nextCredentialVersion: 0 })
      ).rotationStatus
    ).toBe('ready');
  });

  it('activates the next credential and keeps the old one for an overlap', () => {
    const current = state({
      nextCredentialRef: 'cred://next',
      nextCredentialVersion: 2,
      rotationStatus: 'ready',
    });
    expect(activateCredentialRotation(current, { now: 1000, overlapMs: 500 })).toStrictEqual({
      state: {
        credentialRef: 'cred://next',
        credentialVersion: 2,
        nextCredentialRef: null,
        nextCredentialVersion: null,
        previousCredentialRef: 'cred://cur',
        previousCredentialRetireAfter: 1500,
        rotationStatus: 'retiring',
      },
      previousCredentialRefToRetire: 'cred://cur',
    });
  });

  it('activates a first credential with nothing to retire', () => {
    const current = state({
      credentialRef: null,
      credentialVersion: 0,
      nextCredentialRef: 'cred://next',
      nextCredentialVersion: 1,
    });
    expect(activateCredentialRotation(current, { now: 1000, overlapMs: 500 })).toStrictEqual({
      state: {
        credentialRef: 'cred://next',
        credentialVersion: 1,
        nextCredentialRef: null,
        nextCredentialVersion: null,
        previousCredentialRef: null,
        previousCredentialRetireAfter: null,
        rotationStatus: 'active',
      },
      previousCredentialRefToRetire: null,
    });
  });

  it('fails to activate without a prepared credential, changing nothing else', () => {
    for (const current of [
      state(),
      state({ nextCredentialRef: 'cred://next' }),
      state({ nextCredentialVersion: 3 }),
    ]) {
      expect(activateCredentialRotation(current, { now: 1, overlapMs: 1 })).toStrictEqual({
        state: { ...current, rotationStatus: 'failed' },
        previousCredentialRefToRetire: null,
      });
    }
    expect(
      activateCredentialRotation(state({ nextCredentialRef: 'n', nextCredentialVersion: 0 }), {
        now: 1,
        overlapMs: 1,
      }).state.credentialVersion
    ).toBe(0);
  });

  it('finishes retirement once the overlap has passed, exactly', () => {
    const retiring = state({
      previousCredentialRef: 'cred://old',
      previousCredentialRetireAfter: 1500,
      rotationStatus: 'retiring',
    });
    expect(finishCredentialRetirement(retiring, 1499)).toBe(retiring);
    expect(finishCredentialRetirement(retiring, 1500)).toStrictEqual({
      ...retiring,
      previousCredentialRef: null,
      previousCredentialRetireAfter: null,
      rotationStatus: 'none',
    });
    expect(finishCredentialRetirement(retiring, 9999).rotationStatus).toBe('none');
    const noPrevious = state({ previousCredentialRetireAfter: 1 });
    expect(finishCredentialRetirement(noPrevious, 100)).toBe(noPrevious);
    const noTime = state({ previousCredentialRef: 'cred://old' });
    expect(finishCredentialRetirement(noTime, 100)).toBe(noTime);
    expect(
      finishCredentialRetirement(
        state({ previousCredentialRef: 'cred://old', previousCredentialRetireAfter: 0 }),
        0
      ).rotationStatus
    ).toBe('none');
  });
});

describe('buildRuntimeLoggingKeyRegistrySnapshot', () => {
  it('describes the registry and only its own versions, with the backend of each reference', () => {
    const own = [
      version({
        version: 1,
        status: 'retired',
        retiredAt: 7,
        backendRef: 'logkey:r2_wrapped_key:reg_1:v1:key',
      }),
      version({ version: 2 }),
    ];
    const foreign = version({ keyRegistryId: 'other', version: 9, backendRef: ref(9, 'other') });
    expect(
      buildRuntimeLoggingKeyRegistrySnapshot(registry, [own[0], foreign, own[1]])
    ).toStrictEqual({
      id: 'reg_1',
      tenant_key: 't_1',
      surface: 'admin',
      log_type: 'audit',
      plane: 'archive',
      active_version: 2,
      status: 'active',
      last_rotated_at: 5,
      updated_at: 6,
      versions: [
        {
          version: 1,
          backend: 'r2_wrapped_key',
          backend_ref: 'logkey:r2_wrapped_key:reg_1:v1:key',
          status: 'retired',
          created_at: 10,
          retired_at: 7,
        },
        {
          version: 2,
          backend: 'd1_wrapped_key',
          backend_ref: ref(2),
          status: 'active',
          created_at: 10,
          retired_at: null,
        },
      ],
    });
  });

  it('writes a missing surface, rotation time and retirement time as null', () => {
    const bare: LoggingKeyRegistryRow = {
      ...registry,
      surface: undefined,
      lastRotatedAt: undefined,
    };
    const snapshot = buildRuntimeLoggingKeyRegistrySnapshot(bare, [
      version({ retiredAt: undefined }),
    ]);
    expect(snapshot.surface).toBeNull();
    expect(snapshot.last_rotated_at).toBeNull();
    expect(snapshot.versions[0]?.retired_at).toBeNull();
    expect(
      buildRuntimeLoggingKeyRegistrySnapshot(
        { ...registry, surface: null, lastRotatedAt: null },
        []
      ).versions
    ).toEqual([]);
  });
});
