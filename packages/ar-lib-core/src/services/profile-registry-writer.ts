import { ensureDatabaseAdapter } from '../db/adapter-source';
import type { RuntimeProfile, RuntimeProfileKind } from '../types/runtime-profile';
import {
  DatabaseProfileRegistryBackend,
  PROFILE_REGISTRY_TOMBSTONE,
  type ConditionalProfileRegistryBackend,
  type ProfileWriteGuard,
} from './profile-registry';
import type { RuntimeProfileResolverEnv } from './runtime-profile-resolver';

/**
 * The KV copy of a profile does not match the D1 row a decision would be made on (a projection
 * that did not finish, or KV written by something else). The D1 copy has been written to KV
 * again; repeat the request.
 */
export class ProfileProjectionDisagreementError extends Error {
  constructor() {
    super('profile_registry_projection_disagrees');
    this.name = 'ProfileProjectionDisagreementError';
  }
}

export interface ProfileForWrite {
  profile: RuntimeProfile | null;
  /**
   * Pass to `putIfUnchanged` / `deleteIfUnchanged`: the stored payload, null when D1 holds no row
   * (a profile that exists only in KV reads as that profile with `expected` null: the write that
   * follows creates the D1 row, and loses if one appeared meanwhile).
   */
  expected: string | null;
  /** Pass as a guard when another write must be made only if this profile is unchanged. */
  guard: ProfileWriteGuard;
}

export interface ProfileWriteOptions {
  /** Other profiles the decision was made on, verified in the same statement as the write. */
  guards?: ProfileWriteGuard[];
  /**
   * Leave the KV projection to the caller (`flushProjection`): for a write that is one of
   * several and may still be compensated, so runtime never sees a state that is taken back.
   */
  deferProjection?: boolean;
}

export interface ProfileWriteResult {
  /** False when the stored profile was no longer the one compared: nothing was written. */
  committed: boolean;
  /** 'pending': saved, but the KV that runtime reads has not been updated yet. */
  projection?: 'pending';
}

function kvKey(kind: RuntimeProfileKind, id: string): string {
  return `profile-registry:${kind}:${id}`;
}

/**
 * Admin-side writes of runtime profiles. D1 (`profile_registry`) is the source of truth and every
 * write is conditional on the payload that was compared; for the KV backend (the default) KV is
 * a projection of D1 that runtime keeps reading. Profiles that exist only in KV are adopted into
 * D1 the first time they are read for a write.
 */
export class RuntimeProfileWriter {
  constructor(
    private readonly db: ConditionalProfileRegistryBackend,
    /** Null when runtime reads D1 itself (the database backend). */
    private readonly kv: KVNamespace | null
  ) {}

  /**
   * Read a profile to decide a write. Reads only (KV is repaired from D1 when they disagree,
   * which changes nothing runtime was told): a KV-only profile is not copied to D1 here, so a
   * request refused later leaves nothing behind. The write that follows creates the row.
   */
  async readForWrite(kind: RuntimeProfileKind, id: string): Promise<ProfileForWrite> {
    const row = await this.db.getStored(kind, id);
    const done = (profile: RuntimeProfile | null, expected: string | null): ProfileForWrite => ({
      profile,
      expected,
      guard: { kind, id, expectedPayload: expected },
    });
    if (!this.kv) return done(row?.profile ?? null, row?.payload ?? null);

    const projected = await this.kv.get(kvKey(kind, id));
    // D1 has never held this id: what KV holds (if anything) is the profile in effect. A
    // tombstone (deleted here) is a row, so a stale KV copy cannot come back this way.
    if (!row)
      return done(projected === null ? null : (JSON.parse(projected) as RuntimeProfile), null);
    // What KV should hold for this row: nothing for a tombstone.
    const expectedProjection = row.payload === PROFILE_REGISTRY_TOMBSTONE ? null : row.payload;
    if (expectedProjection !== projected) {
      await this.project(kind, id);
      throw new ProfileProjectionDisagreementError();
    }
    return done(row.profile, row.payload);
  }

  /** The payload D1 stores now (a tombstone included), null when there is no row. Read only. */
  async storedPayload(kind: RuntimeProfileKind, id: string): Promise<string | null> {
    return (await this.db.getStored(kind, id))?.payload ?? null;
  }

  async putIfUnchanged(
    profile: RuntimeProfile,
    expected: string | null,
    options: ProfileWriteOptions = {}
  ): Promise<ProfileWriteResult> {
    if (profile.id.startsWith('builtin:'))
      throw new Error('builtin_runtime_profiles_are_read_only');
    if (!(await this.db.putIfUnchanged(profile, expected, options.guards))) {
      return { committed: false };
    }
    if (options.deferProjection) return { committed: true };
    return { committed: true, ...(await this.flushProjection(profile.kind, profile.id)) };
  }

  /** `expected` null: a profile that exists only in KV; the delete records a tombstone for it. */
  async deleteIfUnchanged(
    kind: RuntimeProfileKind,
    id: string,
    expected: string | null,
    options: ProfileWriteOptions = {}
  ): Promise<ProfileWriteResult> {
    if (id.startsWith('builtin:')) throw new Error('builtin_runtime_profiles_are_read_only');
    const done =
      expected === null
        ? await this.db.insertRawIfAbsent(kind, id, PROFILE_REGISTRY_TOMBSTONE)
        : await this.db.deleteIfUnchanged(kind, id, expected);
    if (!done) return { committed: false };
    if (options.deferProjection) return { committed: true };
    return { committed: true, ...(await this.flushProjection(kind, id)) };
  }

  /** Copy D1 to KV now; 'pending' when that failed (the scheduled reconcile repairs it). */
  async flushProjection(kind: RuntimeProfileKind, id: string): Promise<{ projection?: 'pending' }> {
    try {
      await this.project(kind, id);
      return {};
    } catch {
      return { projection: 'pending' };
    }
  }

  /**
   * Repair the KV projection of every stored row (a projection that failed, a tombstone whose
   * KV delete failed, a KV value written by something else). Run on a schedule. KV-only
   * profiles have no row and are left alone.
   */
  async reconcileProjection(): Promise<{ checked: number; repaired: number; failures: number }> {
    if (!this.kv) return { checked: 0, repaired: 0, failures: 0 };
    const rows = await this.db.listStored();
    let repaired = 0;
    let failures = 0;
    for (const row of rows) {
      try {
        const want = row.payload === PROFILE_REGISTRY_TOMBSTONE ? null : row.payload;
        if ((await this.kv.get(kvKey(row.kind, row.id))) === want) continue;
        await this.project(row.kind, row.id);
        repaired += 1;
      } catch {
        failures += 1;
      }
    }
    return { checked: rows.length, repaired, failures };
  }

  /** Copy the latest D1 row to KV; repeated while D1 moves, so the last projection is the latest. */
  private async project(kind: RuntimeProfileKind, id: string): Promise<void> {
    if (!this.kv) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.db.getStored(kind, id);
      if (row?.profile) await this.kv.put(kvKey(kind, id), row.payload);
      else await this.kv.delete(kvKey(kind, id));
      const after = await this.db.getStored(kind, id);
      if ((after?.payload ?? null) === (row?.payload ?? null)) return;
    }
    throw new Error('profile_registry_projection_unsettled');
  }
}

export function createRuntimeProfileWriterFromEnv(
  env: RuntimeProfileResolverEnv
): RuntimeProfileWriter {
  const db = new DatabaseProfileRegistryBackend(ensureDatabaseAdapter(env.DB, 'profile-registry'));
  if (env.PROFILE_REGISTRY_BACKEND === 'database') return new RuntimeProfileWriter(db, null);
  const kv = env.AUTHRIM_CONFIG ?? env.SETTINGS;
  if (!kv) throw new Error('profile_registry_backend_not_configured');
  return new RuntimeProfileWriter(db, kv);
}

/** Scheduled: bring the KV projection of the profile registry back to D1 (KV backend only). */
export async function reconcileProfileRegistryProjection(
  env: RuntimeProfileResolverEnv
): Promise<{ checked: number; repaired: number; failures: number }> {
  if (env.PROFILE_REGISTRY_BACKEND === 'database') return { checked: 0, repaired: 0, failures: 0 };
  if (!(env.AUTHRIM_CONFIG ?? env.SETTINGS)) return { checked: 0, repaired: 0, failures: 0 };
  return createRuntimeProfileWriterFromEnv(env).reconcileProjection();
}
