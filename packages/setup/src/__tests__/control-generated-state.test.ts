import { describe, expect, it, vi } from 'vitest';
import { AuthrimLockSchema, createLockFile } from '../core/lock.js';
import {
  loadControlGeneratedD1Bindings,
  loadControlGeneratedKeyState,
  loadControlStagedSigningKeys,
  projectControlGeneratedD1Bindings,
  projectControlGeneratedKeyState,
  refreshLockFromControlGeneratedState,
} from '../core/control-generated-state.js';

const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);
const FINGERPRINT_C = 'c'.repeat(64);
const FINGERPRINT_D = 'd'.repeat(64);
const FINGERPRINT_E = 'e'.repeat(64);

function keyRows() {
  return [
    {
      row_kind: 'signing',
      key_purpose: 'runtime_registry',
      slot: 'B',
      key_id: 'registry-v2',
      fingerprint: FINGERPRINT_B,
      key_state: 'active',
      state_revision: null,
      generation: null,
      previous_slot: null,
      previous_key_id: null,
      previous_fingerprint: null,
      previous_generation: null,
      updated_at: 200,
    },
    {
      row_kind: 'signing',
      key_purpose: 'runtime_registry',
      slot: 'A',
      key_id: 'registry-v1',
      fingerprint: FINGERPRINT_A,
      key_state: 'previous',
      state_revision: null,
      generation: null,
      previous_slot: null,
      previous_key_id: null,
      previous_fingerprint: null,
      previous_generation: null,
      updated_at: 200,
    },
    {
      row_kind: 'signing',
      key_purpose: 'smoke_rpc',
      slot: 'B',
      key_id: 'smoke-v2',
      fingerprint: FINGERPRINT_D,
      key_state: 'active',
      state_revision: null,
      generation: null,
      previous_slot: null,
      previous_key_id: null,
      previous_fingerprint: null,
      previous_generation: null,
      updated_at: 201,
    },
    {
      row_kind: 'signing',
      key_purpose: 'smoke_rpc',
      slot: 'A',
      key_id: 'smoke-v1',
      fingerprint: FINGERPRINT_C,
      key_state: 'previous',
      state_revision: null,
      generation: null,
      previous_slot: null,
      previous_key_id: null,
      previous_fingerprint: null,
      previous_generation: null,
      updated_at: 201,
    },
    {
      row_kind: 'lookup_hmac',
      key_purpose: 'lookup_hmac',
      slot: 'B',
      key_id: 'lookup-v2',
      fingerprint: FINGERPRINT_E,
      key_state: 'dual_read',
      state_revision: 4,
      generation: 2,
      previous_slot: 'A',
      previous_key_id: 'lookup-v1',
      previous_fingerprint: FINGERPRINT_A,
      previous_generation: 1,
      updated_at: 202,
    },
  ];
}

function lock(includeTenantBinding = true) {
  return createLockFile('test', {
    d1: [
      { binding: 'CONTROL_DB', name: 'test-control', id: 'control-id' },
      { binding: 'DB', name: 'test-core', id: 'core-id' },
      ...(includeTenantBinding
        ? [{ binding: 'TDB_SLOT_0001_CORE', name: 'old-slot', id: 'old-slot-id' }]
        : []),
    ],
    kv: [],
    queues: [],
    r2: [],
  });
}

describe('Control generated D1 state', () => {
  it('loads ready provider-backed bindings with an environment-scoped query', async () => {
    const query = vi.fn(async () => [
      {
        binding_name: 'TDB_USERS_AABBCCDD_CORE',
        deterministic_name: 'authrim-test-users-jp-aabbccdd',
        provider_resource_id: '01234567-89ab-cdef-0123-456789abcdef',
        observed_state: 'present',
        provisioning_state: 'ready',
      },
      {
        binding_name: 'TDB_LOOKUP_ED83F354_LOOKUP',
        deterministic_name: 'authrim-test-lookup-default-ed83f354',
        provider_resource_id: '11234567-89ab-cdef-0123-456789abcdef',
        observed_state: 'present',
        provisioning_state: 'ready',
      },
    ]);

    await expect(
      loadControlGeneratedD1Bindings({
        controlDatabaseName: 'test-control',
        environmentId: 'env-test',
        query,
      })
    ).resolves.toEqual([
      {
        binding: 'TDB_LOOKUP_ED83F354_LOOKUP',
        name: 'authrim-test-lookup-default-ed83f354',
        id: '11234567-89ab-cdef-0123-456789abcdef',
      },
      {
        binding: 'TDB_USERS_AABBCCDD_CORE',
        name: 'authrim-test-users-jp-aabbccdd',
        id: '01234567-89ab-cdef-0123-456789abcdef',
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toContain("b.environment_id = 'env-test'");
  });

  it('fails closed when desired binding provider state is incomplete or conflicting', async () => {
    const notReady = vi.fn(async () => [
      {
        binding_name: 'TDB_USERS_AABBCCDD_CORE',
        deterministic_name: 'authrim-test-users-jp-aabbccdd',
        provider_resource_id: null,
        observed_state: null,
        provisioning_state: 'requested',
      },
    ]);
    await expect(
      refreshLockFromControlGeneratedState({
        lock: lock(),
        environmentId: 'env-test',
        query: notReady,
      })
    ).rejects.toThrow('control_generated_d1_binding_not_ready');

    const migrationIncomplete = vi.fn(async () => [
      {
        binding_name: 'TDB_USERS_AABBCCDD_CORE',
        deterministic_name: 'authrim-test-users-jp-aabbccdd',
        provider_resource_id: '01234567-89ab-cdef-0123-456789abcdef',
        observed_state: 'present',
        provisioning_state: 'creating',
      },
    ]);
    await expect(
      refreshLockFromControlGeneratedState({
        lock: lock(),
        environmentId: 'env-test',
        query: migrationIncomplete,
      })
    ).rejects.toThrow('control_generated_d1_invalid_state');

    const conflicting = vi.fn(async () => [
      {
        binding_name: 'TDB_USERS_AABBCCDD_CORE',
        deterministic_name: 'authrim-test-users-jp-aabbccdd',
        provider_resource_id: '01234567-89ab-cdef-0123-456789abcdef',
        observed_state: 'present',
        provisioning_state: 'ready',
      },
      {
        binding_name: 'TDB_USERS_AABBCCDD_CORE',
        deterministic_name: 'authrim-test-users-jp-other',
        provider_resource_id: '11234567-89ab-cdef-0123-456789abcdef',
        observed_state: 'present',
        provisioning_state: 'ready',
      },
    ]);
    await expect(
      refreshLockFromControlGeneratedState({
        lock: lock(),
        environmentId: 'env-test',
        query: conflicting,
      })
    ).rejects.toThrow('control_generated_d1_binding_conflict');
  });

  it('adds generated tenant bindings while preserving shared resources', () => {
    const projected = projectControlGeneratedD1Bindings(lock(false), [
      {
        binding: 'TDB_USERS_AABBCCDD_CORE',
        name: 'authrim-test-users-jp-aabbccdd',
        id: '01234567-89ab-cdef-0123-456789abcdef',
      },
    ]);

    expect(projected.lock.d1).toEqual({
      CONTROL_DB: { name: 'test-control', id: 'control-id' },
      DB: { name: 'test-core', id: 'core-id' },
      TDB_USERS_AABBCCDD_CORE: {
        name: 'authrim-test-users-jp-aabbccdd',
        id: '01234567-89ab-cdef-0123-456789abcdef',
      },
    });
    expect(projected.added).toEqual(['TDB_USERS_AABBCCDD_CORE']);
    expect(projected.removed).toEqual([]);
  });

  it('fails closed when Control export would remove an existing runtime binding', () => {
    expect(() => projectControlGeneratedD1Bindings(lock(), [])).toThrow(
      'control_generated_d1_binding_removal_requires_approval:TDB_SLOT_0001_CORE'
    );
  });

  it('fails closed when Control export would retarget an existing runtime binding', () => {
    expect(() =>
      projectControlGeneratedD1Bindings(lock(), [
        {
          binding: 'TDB_SLOT_0001_CORE',
          name: 'replacement-slot',
          id: 'replacement-slot-id',
        },
      ])
    ).toThrow('control_generated_d1_binding_retarget_requires_approval:TDB_SLOT_0001_CORE');
  });
});

describe('Control generated key state', () => {
  it('loads staged signing metadata separately without projecting it into the lock', async () => {
    const query = vi.fn(async () => [
      {
        row_kind: 'signing',
        key_purpose: 'runtime_registry',
        slot: 'B',
        key_id: 'registry-candidate',
        fingerprint: FINGERPRINT_B,
        key_state: 'staged',
        state_revision: null,
        generation: null,
        previous_slot: null,
        previous_key_id: null,
        previous_fingerprint: null,
        previous_generation: null,
        updated_at: 300,
      },
    ]);

    await expect(
      loadControlStagedSigningKeys({
        controlDatabaseName: 'test-control',
        environmentId: 'env-test',
        query,
      })
    ).resolves.toEqual([
      {
        purpose: 'runtime_registry',
        slot: 'B',
        keyId: 'registry-candidate',
        fingerprint: FINGERPRINT_B,
        updatedAt: 300,
      },
    ]);
    expect(query.mock.calls[0]?.[1]).toContain("state = 'staged'");
  });

  it('fails closed for duplicate staged candidates of one purpose', async () => {
    const candidate = {
      row_kind: 'signing',
      key_purpose: 'smoke_rpc',
      slot: 'B',
      key_id: 'smoke-candidate',
      fingerprint: FINGERPRINT_D,
      key_state: 'staged',
      state_revision: null,
      generation: null,
      previous_slot: null,
      previous_key_id: null,
      previous_fingerprint: null,
      previous_generation: null,
      updated_at: 300,
    };
    await expect(
      loadControlStagedSigningKeys({
        controlDatabaseName: 'test-control',
        environmentId: 'env-test',
        query: vi.fn(async () => [candidate, { ...candidate, slot: 'A' }]),
      })
    ).rejects.toThrow('control_generated_staged_signing_key_invalid');
  });

  it('projects only public rotation metadata for all three key purposes', async () => {
    const query = vi.fn(async () => keyRows());
    const state = await loadControlGeneratedKeyState({
      controlDatabaseName: 'test-control',
      environmentId: 'env-test',
      query,
    });

    expect(state).toEqual({
      runtimeRegistry: {
        activeSlot: 'B',
        activeKeyId: 'registry-v2',
        activeFingerprint: FINGERPRINT_B,
        previousSlot: 'A',
        previousKeyId: 'registry-v1',
        previousFingerprint: FINGERPRINT_A,
        updatedAt: 200,
      },
      smokeRpc: {
        activeSlot: 'B',
        activeKeyId: 'smoke-v2',
        activeFingerprint: FINGERPRINT_D,
        previousSlot: 'A',
        previousKeyId: 'smoke-v1',
        previousFingerprint: FINGERPRINT_C,
        updatedAt: 201,
      },
      lookupHmac: {
        stateRevision: 4,
        activeGeneration: 2,
        activeSlot: 'B',
        activeKeyId: 'lookup-v2',
        activeFingerprint: FINGERPRINT_E,
        previousGeneration: 1,
        previousSlot: 'A',
        previousKeyId: 'lookup-v1',
        previousFingerprint: FINGERPRINT_A,
        updatedAt: 202,
      },
    });
    expect(JSON.stringify(state)).not.toContain('private');
    expect(JSON.stringify(state)).not.toContain('secret');
    expect(query.mock.calls[0]?.[1]).toContain("environment_id = 'env-test'");
  });

  it('rejects partial, conflicting, and stale key projections', async () => {
    await expect(
      loadControlGeneratedKeyState({
        controlDatabaseName: 'test-control',
        environmentId: 'env-test',
        query: vi.fn(async () => keyRows().filter((row) => row.key_purpose !== 'smoke_rpc')),
      })
    ).rejects.toThrow('control_generated_smoke_rpc_key_state_incomplete');

    const conflictingRows = keyRows();
    conflictingRows[1] = { ...conflictingRows[1], slot: 'B' };
    await expect(
      loadControlGeneratedKeyState({
        controlDatabaseName: 'test-control',
        environmentId: 'env-test',
        query: vi.fn(async () => conflictingRows),
      })
    ).rejects.toThrow('control_generated_runtime_registry_key_state_conflict');

    const current = await loadControlGeneratedKeyState({
      controlDatabaseName: 'test-control',
      environmentId: 'env-test',
      query: vi.fn(async () => keyRows()),
    });
    const currentLock = projectControlGeneratedKeyState(lock(false), current).lock;
    const stale = structuredClone(current!);
    stale.lookupHmac.stateRevision = 3;
    stale.lookupHmac.updatedAt = 199;
    expect(() => projectControlGeneratedKeyState(currentLock, stale)).toThrow(
      'control_generated_lookupHmac_key_state_stale'
    );
  });

  it('rejects a hand-edited lock with partial previous-key metadata', async () => {
    const state = await loadControlGeneratedKeyState({
      controlDatabaseName: 'test-control',
      environmentId: 'env-test',
      query: vi.fn(async () => keyRows()),
    });
    const malformed = structuredClone(projectControlGeneratedKeyState(lock(false), state).lock);
    delete malformed.controlKeyState!.smokeRpc.previousFingerprint;

    expect(() => AuthrimLockSchema.parse(malformed)).toThrow('previous_key_metadata_incomplete');
  });

  it('treats semantically identical key state with reordered object keys as unchanged', async () => {
    const state = await loadControlGeneratedKeyState({
      controlDatabaseName: 'test-control',
      environmentId: 'env-test',
      query: vi.fn(async () => keyRows()),
    });
    const currentLock = projectControlGeneratedKeyState(lock(false), state).lock;
    const lookup = currentLock.controlKeyState!.lookupHmac;
    currentLock.controlKeyState = {
      ...currentLock.controlKeyState!,
      lookupHmac: {
        activeSlot: lookup.activeSlot,
        activeKeyId: lookup.activeKeyId,
        activeFingerprint: lookup.activeFingerprint,
        updatedAt: lookup.updatedAt,
        stateRevision: lookup.stateRevision,
        activeGeneration: lookup.activeGeneration,
        previousSlot: lookup.previousSlot,
        previousKeyId: lookup.previousKeyId,
        previousFingerprint: lookup.previousFingerprint,
        previousGeneration: lookup.previousGeneration,
      },
    };

    expect(projectControlGeneratedKeyState(currentLock, state)).toEqual({
      lock: currentLock,
      changed: false,
    });
  });
});
