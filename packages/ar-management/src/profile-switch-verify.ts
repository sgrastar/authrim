/**
 * Switching which profile applies (the environment default, a tenant's own) is decided by comparing
 * the CONTENTS of two profiles (core D1 `profile_registry`) but committed by a version-checked save
 * of a settings document (admin D1). One transaction cannot span the two databases, so the commit
 * only protects the document, not the profiles that were compared: another request could lengthen
 * the profile switched away from (an ungated change) after the decision and before the save, and the
 * switch would then shorten retention without a receipt.
 *
 * So the switch is verified after it commits: the compared profiles are read again from D1 and, if
 * any is no longer the payload that was compared, the document is put back to what it was (a
 * conditional save against the version just written) and the request answers 409. The window that
 * remains is between the commit and that re-read: for that moment the switch is live, and it is
 * undone only if a profile changed. A lock across the two databases is not used: a lock that
 * outlives a crashed Worker would block every switch, and Workers KV, D1 and the Durable Objects
 * offer no lease that both stores honour. Tokens are exact payload texts, so a rewrite that leaves
 * the profile equal in value also counts as a change (a retry costs one more step-up).
 */
import { DatabaseSettingsCanonicalStore } from '@authrim/ar-lib-core/services/settings-canonical-store';
import {
  requireDedicatedAdminDatabaseAdapter,
  createRuntimeProfileRegistryFromEnv,
  createRuntimeProfileWriterFromEnv,
  type Env,
  type RuntimeProfile,
  type RuntimeProfileKind,
  type SettingScope,
  type SettingsManager,
} from '@authrim/ar-lib-core';

/** A profile a decision was made on, with the payload D1 held when it was read (null: no row). */
export interface ComparedProfile {
  kind: RuntimeProfileKind;
  id: string;
  token: string | null;
}

/** What a caller keeps from the decision to verify the commit: filled by the deciding code. */
export interface ProfileSwitchGuard {
  compared: ComparedProfile[];
  /**
   * The version of the environment default document (infrastructure) the decision rested on, when
   * a side of the switch is the default. If it moves before the switch commits, the decision was
   * made on a default that is no longer in effect.
   */
  infrastructureVersion?: string;
  /** The scope's own document before the change (to put back). */
  before?: Record<string, unknown>;
}

/**
 * Read a profile to compare. A stored profile is read the way a write reads it (D1 row, or what KV
 * holds when D1 has none), with the payload recorded; a built-in profile cannot change. Throws
 * `ProfileProjectionDisagreementError` while KV and D1 disagree.
 */
export async function readComparedProfile(
  env: Env,
  kind: RuntimeProfileKind,
  id: string,
  guard?: ProfileSwitchGuard
): Promise<RuntimeProfile | null> {
  if (id.startsWith('builtin:')) {
    return createRuntimeProfileRegistryFromEnv(env).get(kind, id);
  }
  const read = await createRuntimeProfileWriterFromEnv(env).readForWrite(kind, id);
  guard?.compared.push({ kind, id, token: read.expected });
  return read.profile;
}

/** The version of the canonical environment default document now (null when it does not exist). */
async function infrastructureVersion(env: Env): Promise<string | null> {
  const store = new DatabaseSettingsCanonicalStore(
    requireDedicatedAdminDatabaseAdapter(env, 'settings-canonical')
  );
  return (await store.load('infrastructure', { type: 'platform' }))?.version ?? null;
}

/** Whether any compared profile is no longer as it was compared. */
export async function comparedProfilesChanged(
  env: Env,
  compared: ComparedProfile[]
): Promise<boolean> {
  const writer = createRuntimeProfileWriterFromEnv(env);
  for (const item of compared) {
    if ((await writer.storedPayload(item.kind, item.id)) !== item.token) return true;
  }
  return false;
}

/**
 * Put back the keys a committed save changed: to their previous own value, or cleared where there
 * was none. Conditional on the version that save produced; false when it cannot be put back (the
 * document changed again), which leaves the newer state alone.
 */
export async function revertCommittedKeys(input: {
  manager: SettingsManager;
  category: string;
  scope: SettingScope;
  committedVersion: string;
  before: Record<string, unknown>;
  keys: string[];
  actor: string;
}): Promise<boolean> {
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const key of input.keys) {
    if (key in input.before) set[key] = input.before[key];
    else clear.push(key);
  }
  try {
    await input.manager.patch(
      input.category,
      input.scope,
      { ifMatch: input.committedVersion, set, clear },
      input.actor,
      { skipDependencyCheck: true }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * After a committed switch: true when the compared profiles are unchanged. Otherwise the switch is
 * put back and false is returned (the caller answers 409).
 */
export async function verifySwitchAfterCommit(input: {
  env: Env;
  manager: SettingsManager;
  category: string;
  scope: SettingScope;
  guard: ProfileSwitchGuard;
  committedVersion: string;
  changedKeys: string[];
  actor: string;
}): Promise<boolean> {
  const { guard } = input;
  if (guard.compared.length === 0 && guard.infrastructureVersion === undefined) return true;
  const changed =
    (await comparedProfilesChanged(input.env, guard.compared)) ||
    (guard.infrastructureVersion !== undefined &&
      (await infrastructureVersion(input.env)) !== guard.infrastructureVersion);
  if (!changed) return true;
  await revertCommittedKeys({
    manager: input.manager,
    category: input.category,
    scope: input.scope,
    committedVersion: input.committedVersion,
    before: input.guard.before ?? {},
    keys: input.changedKeys,
    actor: input.actor,
  });
  return false;
}
