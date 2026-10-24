/**
 * How the apps of one tenant choose their Mapping Set: how many follow the default, name a set of
 * their own, opt out, or hold a value that is not a choice. Counts only.
 *
 * Each stored `identity_mapping` is read by `readClientIdentityMappingChoice`, the reading the
 * selection makes at runtime, so a count never disagrees with what the selection would do for one
 * of the apps. The database groups the apps by the stored text, and each distinct text is read
 * once: apps that share a choice (no choice, the same set, the opt-out) cost one row.
 */
import { readClientIdentityMappingChoice, type DatabaseAdapter } from '@authrim/ar-lib-core';

export interface ClientIdentityMappingChoiceCounts {
  total: number;
  /** No choice of their own: they get the tenant's default, else the platform's. */
  followingDefault: number;
  /** They name a Mapping Set (クライアント指定): a default does not change them. */
  ownSet: number;
  /** `{ "mode": "none" }`: no mapping, whatever the defaults say. */
  optedOut: number;
  /** A value that is not a choice: the selection fails for them rather than fall to a default. */
  unusable: number;
  /** Of `unusable`, those whose selector names only a Destination Profile (the older kind). */
  legacyProfileOnly: number;
}

export async function countClientIdentityMappingChoices(
  core: DatabaseAdapter,
  tenantId: string
): Promise<ClientIdentityMappingChoiceCounts> {
  const rows = await core.query<{ identity_mapping: string | null; apps: number }>(
    `SELECT identity_mapping, COUNT(*) AS apps
       FROM oauth_clients
      WHERE tenant_id = ?
      GROUP BY identity_mapping`,
    [tenantId]
  );
  const counts: ClientIdentityMappingChoiceCounts = {
    total: 0,
    followingDefault: 0,
    ownSet: 0,
    optedOut: 0,
    unusable: 0,
    legacyProfileOnly: 0,
  };
  for (const row of rows) {
    const apps = Number(row.apps ?? 0);
    const choice = readClientIdentityMappingChoice(row.identity_mapping);
    counts.total += apps;
    if (choice.kind === 'unset') counts.followingDefault += apps;
    else if (choice.kind === 'set') counts.ownSet += apps;
    else if (choice.kind === 'none') counts.optedOut += apps;
    else {
      counts.unusable += apps;
      if (choice.reason === 'legacy_profile_only_selector') counts.legacyProfileOnly += apps;
    }
  }
  return counts;
}
