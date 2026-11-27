/**
 * Publication of a subject's committed service-group result into `group_memberships`, the one
 * membership table authorization reads (RBAC, claims).
 *
 * Contract:
 * - Only groups whose committed result has `dynamic === true` are published (`member` also
 *   counts SCIM contributions, which have their own rows), less the groups
 *   whose result depends on a field the person can write themselves while they carry roles
 *   (role-guard.ts; the fields' self-writable mark is read fresh at every publication). Each is a
 *   row on the subject's account database with `assignment_source = 'dynamic'` and
 *   `source_ref = dynamicMembershipSourceRef(generation, ruleVersion)`:
 *   `<generation, zero-padded to 16 digits>:<rule version>`. Generation first and padded, so the
 *   string order of two refs is the order of their generations (the result's generation grows by
 *   one with every committed evaluation of the subject).
 * - The newest generation published for the subject is kept in
 *   `dynamic_membership_publications` (same account database), upserted in the same batch as the
 *   rows. Every statement of the batch is fenced by "the recorded generation is not newer" and
 *   "the account is active" (`identity_accounts`, which a deletion moves out of `active` first),
 *   so an older generation never overwrites a newer one (`superseded`), also after an empty
 *   publication or after a group's rows were deleted, and nothing is published for an account
 *   being deleted. Re-running a generation is idempotent. The record is not restored with a
 *   tenant (a `rebuild` dataset): rows found without a generation on record stop granting at once
 *   and the current result is published as the first generation.
 * - Only a `fresh` result is published. A stale, pending or failed result (or an evaluation or
 *   read that throws) makes the subject's rows of generations up to the last confirmed one stale
 *   at once (`stale_after = now`): no dynamic membership counts until a fresh result is published.
 * - `stale_after` = publication time + the tenant's freshness window (setting
 *   `groups.dynamic_freshness_seconds`, default 86400, at least 3600; the minimum when the
 *   setting cannot be read). The reconcile paths renew a fresh result's rows once less than half
 *   the window remains, and write them again at once when the window was shortened.
 * - Publication is a second write after the result commit, in another database: right after
 *   writing (before the cache invalidation, whatever it does) it reads the committed result
 *   again. A newer generation committed meanwhile is published in turn (at most 3 rounds); a
 *   result no longer fresh, a failed re-read or the round limit make the rows just written stale.
 * - Every membership change (a publication, a subject's or a group's expiry) sets
 *   `invalidation_pending = 1` in its own batch. It is cleared only after the subject's cached
 *   RBAC claims were invalidated, and only while the record still names the generation read
 *   before that invalidation. A failed invalidation, or no claims cache binding, leaves it pending:
 *   every later publication attempt and the reconcile's pending pass invalidate it again.
 * - Writing `dynamic` rows does not bump any service-group input (the migration 017 triggers count
 *   only `scim` rows), so publication never makes its own result stale or re-triggers evaluation.
 */
import type { KVNamespace } from '@cloudflare/workers-types';
import type { DatabaseAdapter, PreparedStatement } from '../../db';
import { invalidateSubjectRBACCache } from '../../utils/rbac-cache';
import { getTenantSettingsDocument, type TenantSettingsStores } from '../../utils/tenant-settings';
import {
  GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS,
  GROUPS_DYNAMIC_FRESHNESS_KEY,
  GROUPS_DYNAMIC_FRESHNESS_MAX_SECONDS,
  GROUPS_DYNAMIC_FRESHNESS_MIN_SECONDS,
  GROUPS_SETTINGS_CATEGORY,
} from '../../types/settings/groups';
import { syncDynamicGroupCatalog } from './canonical';
import { selfWritableRoleGroups } from './role-guard';
import { loadGroupFields, type SavedGroupInputReader } from './inputs';
import type { DynamicGroupStore, GroupInputReader, GroupSnapshot } from './store';

/** The default freshness window; a tenant sets its own with `groups.dynamic_freshness_seconds`. */
export const DYNAMIC_MEMBERSHIP_FRESHNESS_SECONDS = GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS;
const GENERATION_DIGITS = 16;
const MAX_ATTEMPTS = 3;
const primary = { consistencyClass: 'primary_required' as const };

type Log = { warn(message: string, metadata?: Record<string, unknown>): void };

/** The window clamped to its bounds; anything not a whole number of seconds is the default. */
export function dynamicFreshnessWindow(value: unknown): number {
  if (value === undefined || value === null) return GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS;
  return Math.min(
    GROUPS_DYNAMIC_FRESHNESS_MAX_SECONDS,
    Math.max(GROUPS_DYNAMIC_FRESHNESS_MIN_SECONDS, seconds)
  );
}

/**
 * The tenant's freshness window, for every publication path (scheduler, API, PII erasure). A
 * settings document that cannot be read gives the minimum (the shorter window is the safe one)
 * and is logged.
 */
export async function resolveDynamicFreshnessSeconds(
  stores: TenantSettingsStores | undefined,
  tenantId: string,
  log?: Log
): Promise<number> {
  if (!stores) return GROUPS_DYNAMIC_FRESHNESS_DEFAULT_SECONDS;
  try {
    const settings = await getTenantSettingsDocument(stores, tenantId, GROUPS_SETTINGS_CATEGORY);
    return dynamicFreshnessWindow(settings?.[GROUPS_DYNAMIC_FRESHNESS_KEY]);
  } catch {
    log?.warn('Dynamic group freshness setting unreadable; using the minimum window', {
      tenantId,
    });
    return GROUPS_DYNAMIC_FRESHNESS_MIN_SECONDS;
  }
}

export function dynamicMembershipSourceRef(generation: number, ruleVersion: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0 || !Number.isSafeInteger(ruleVersion))
    throw new Error('group_generation_invalid');
  return `${String(generation).padStart(GENERATION_DIGITS, '0')}:${ruleVersion}`;
}

/** Every ref of a generation up to `generation` sorts below this bound. */
function refsUpTo(generation: number): string {
  return String(generation + 1).padStart(GENERATION_DIGITS, '0');
}

export function parseDynamicMembershipSourceRef(
  ref: string
): { generation: number; ruleVersion: number } | null {
  const match = /^(\d{16}):(\d+)$/.exec(ref);
  return match ? { generation: Number(match[1]), ruleVersion: Number(match[2]) } : null;
}

export type DynamicPublicationStatus = 'published' | 'current' | 'not_fresh' | 'superseded';

export interface DynamicPublicationResult {
  status: DynamicPublicationStatus;
  generation: number;
  groupIds: string[];
}

export interface DynamicPublicationOptions {
  cache?: KVNamespace;
  /** The tenant's freshness window in seconds (resolveDynamicFreshnessSeconds). */
  freshnessSeconds?: number;
  log?: Log;
}

interface DynamicRow {
  group_id: string;
  source_ref: string;
  lifecycle_state: string;
  stale_after: number | string | null;
}
interface PublicationRow {
  generation: string;
  invalidation_pending: number | string;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function dynamicRows(account: DatabaseAdapter, tenantId: string, subjectId: string) {
  return account.query<DynamicRow>(
    `SELECT group_id, source_ref, lifecycle_state, stale_after FROM group_memberships
      WHERE tenant_id = ? AND subject_id = ? AND assignment_source = 'dynamic'`,
    [tenantId, subjectId],
    primary
  );
}

async function publicationRow(account: DatabaseAdapter, tenantId: string, subjectId: string) {
  return account.queryOne<PublicationRow>(
    `SELECT generation, invalidation_pending FROM dynamic_membership_publications
      WHERE tenant_id = ? AND subject_id = ?`,
    [tenantId, subjectId],
    primary
  );
}

/** The groups the committed result makes dynamic members of, in a stable order. */
function dynamicGroupIds(snapshot: GroupSnapshot, excluded: ReadonlySet<string>): string[] {
  return Object.entries(snapshot.evaluation?.groups ?? {})
    .filter(([id, result]) => result.dynamic === true && !excluded.has(id))
    .map(([id]) => id)
    .sort();
}

/** Every published group must be an active canonical dynamic group; the catalog sync repairs. */
async function requireCanonicalGroups(store: DynamicGroupStore, ids: string[]) {
  const missing = async () => {
    const found = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += 90) {
      const batch = ids.slice(offset, offset + 90);
      for (const row of await store.db.query<{ id: string }>(
        `SELECT id FROM "groups" WHERE tenant_id = ? AND kind = 'dynamic'
          AND group_key = 'dynamic:' || id AND lifecycle_state = 'active'
          AND id IN (${batch.map(() => '?').join(', ')})`,
        [store.tenantId, ...batch],
        primary
      ))
        found.add(row.id);
    }
    return ids.filter((id) => !found.has(id));
  };
  if (!ids.length || !(await missing()).length) return;
  await syncDynamicGroupCatalog(store.db, store.tenantId, await store.catalog());
  if ((await missing()).length) throw new Error('group_canonical_missing');
}

function replaceStatements(
  account: DatabaseAdapter,
  tenantId: string,
  subjectId: string,
  ref: string,
  groupIds: string[],
  staleAfter: number,
  now: number
): PreparedStatement[] {
  const subject = "tenant_id = ? AND subject_id = ? AND assignment_source = 'dynamic'";
  const fence = `NOT EXISTS (SELECT 1 FROM dynamic_membership_publications AS published
    WHERE published.tenant_id = ? AND published.subject_id = ? AND published.generation > ?)
    AND EXISTS (SELECT 1 FROM identity_accounts AS account WHERE account.tenant_id = ?
    AND account.legacy_user_id = ? AND account.lifecycle_state = 'active')`;
  const fenceParams = [tenantId, subjectId, ref, tenantId, subjectId];
  return [
    ...(account.getType() === 'postgres'
      ? [
          {
            sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
            params: [JSON.stringify([tenantId, subjectId, 'dynamic'])],
          },
        ]
      : []),
    {
      sql: `UPDATE group_memberships SET lifecycle_state = 'revoked' WHERE ${subject} AND ${fence}`,
      params: [tenantId, subjectId, ...fenceParams],
    },
    ...groupIds.map((groupId) => ({
      sql: `INSERT INTO group_memberships (id, tenant_id, group_id, subject_id, assignment_source,
          source_ref, lifecycle_state, starts_at, expires_at, stale_after, created_at, updated_at)
        SELECT ?, ?, ?, ?, 'dynamic', ?, 'active', NULL, NULL, CAST(? AS BIGINT),
          CAST(? AS BIGINT), CAST(? AS BIGINT) WHERE ${fence}
        ON CONFLICT (tenant_id, group_id, subject_id, assignment_source, source_ref) DO UPDATE SET
          lifecycle_state = 'active', starts_at = NULL, expires_at = NULL,
          stale_after = excluded.stale_after, updated_at = excluded.updated_at`,
      params: [
        crypto.randomUUID(),
        tenantId,
        groupId,
        subjectId,
        ref,
        staleAfter,
        now,
        now,
        ...fenceParams,
      ],
    })),
    {
      sql: `DELETE FROM group_memberships WHERE ${subject} AND lifecycle_state = 'revoked' AND ${fence}`,
      params: [tenantId, subjectId, ...fenceParams],
    },
    // Last, so the fence above still reads the generation recorded before this batch.
    {
      sql: `INSERT INTO dynamic_membership_publications (tenant_id, subject_id, generation,
          published_at, invalidation_pending)
        SELECT ?, ?, ?, CAST(? AS BIGINT), 1 WHERE ${fence}
        ON CONFLICT (tenant_id, subject_id) DO UPDATE SET generation = excluded.generation,
          published_at = excluded.published_at, invalidation_pending = 1
        WHERE dynamic_membership_publications.generation <= excluded.generation`,
      params: [tenantId, subjectId, ref, now, ...fenceParams],
    },
  ];
}

/**
 * The statement that records a pending cache invalidation for the subject, in the batch of the
 * membership change itself. A subject without a publication record gets one with an unknown
 * generation (`''`): its rows were not written by a publication on record (see below).
 */
function pendingStatement(tenantId: string, subjectId: string, now: number): PreparedStatement {
  return {
    sql: `INSERT INTO dynamic_membership_publications (tenant_id, subject_id, generation,
        published_at, invalidation_pending) VALUES (?, ?, '', CAST(? AS BIGINT), 1)
      ON CONFLICT (tenant_id, subject_id) DO UPDATE SET invalidation_pending = 1`,
    params: [tenantId, subjectId, now],
  };
}

async function markStale(
  account: DatabaseAdapter,
  tenantId: string,
  subjectId: string,
  bound: { ref: string } | { upTo: number } | null
) {
  const now = nowSeconds();
  const condition =
    bound === null ? '' : 'ref' in bound ? ' AND source_ref = ?' : ' AND source_ref < ?';
  const value = bound === null ? [] : ['ref' in bound ? bound.ref : refsUpTo(bound.upTo)];
  const [result] = await account.batch([
    {
      sql: `UPDATE group_memberships SET stale_after = ?, updated_at = ?
        WHERE tenant_id = ? AND subject_id = ? AND assignment_source = 'dynamic'${condition}
          AND (stale_after IS NULL OR stale_after > ?)`,
      params: [now, now, tenantId, subjectId, ...value, now],
    },
    pendingStatement(tenantId, subjectId, now),
  ]);
  return result.rowsAffected > 0;
}

/**
 * Invalidates the subject's cached claims. On success the pending mark is cleared, and only while
 * the publication record still names the generation read before the invalidation (a change
 * recorded meanwhile stays pending). On failure, or without a claims cache binding, the mark stays
 * for the reconcile to retry.
 */
async function invalidate(
  account: DatabaseAdapter,
  options: DynamicPublicationOptions,
  tenantId: string,
  subjectId: string,
  generation: string | null
): Promise<boolean> {
  if (!options.cache) return false;
  const invalidated =
    generation ?? (await publicationRow(account, tenantId, subjectId))?.generation;
  try {
    await invalidateSubjectRBACCache(options.cache, tenantId, subjectId);
  } catch {
    options.log?.warn('Dynamic membership cache invalidation failed; retried by the reconcile', {
      tenantId,
    });
    return false;
  }
  if (invalidated === undefined) return true;
  await account.execute(
    `UPDATE dynamic_membership_publications SET invalidation_pending = 0
      WHERE tenant_id = ? AND subject_id = ? AND invalidation_pending <> 0 AND generation = ?`,
    [tenantId, subjectId, invalidated]
  );
  return true;
}

/**
 * The reconcile's pending pass: subjects of the account database whose cached claims still have
 * to be invalidated, whatever their rows or their expiry. Returns those it invalidated.
 */
export async function retryPendingDynamicInvalidations(
  account: DatabaseAdapter,
  tenantId: string,
  options: DynamicPublicationOptions,
  budget = 100
): Promise<string[]> {
  const rows = await account.query<{ subject_id: string; generation: string }>(
    `SELECT subject_id, generation FROM dynamic_membership_publications
      WHERE tenant_id = ? AND invalidation_pending <> 0 ORDER BY subject_id LIMIT ?`,
    [tenantId, budget],
    primary
  );
  const done: string[] = [];
  for (const row of rows)
    if (await invalidate(account, options, tenantId, row.subject_id, row.generation))
      done.push(row.subject_id);
  return done;
}

/**
 * Publishes the subject's committed result (see the contract above). `account` is the subject's
 * own account database (the reader's core database).
 */
export async function publishDynamicMemberships(
  store: DynamicGroupStore,
  reader: GroupInputReader,
  account: DatabaseAdapter,
  options: DynamicPublicationOptions = {}
): Promise<DynamicPublicationResult> {
  const { tenantId } = store;
  const subjectId = reader.userId;
  const window = dynamicFreshnessWindow(options.freshnessSeconds);
  const renewBefore = Math.floor(window / 2);
  // A pending invalidation of an earlier attempt first, whatever happens below.
  const recorded = await publicationRow(account, tenantId, subjectId);
  if (recorded && Number(recorded.invalidation_pending) !== 0)
    await invalidate(account, options, tenantId, subjectId, recorded.generation);
  let snapshot = await store.snapshot(subjectId, reader);
  let written: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const generation = snapshot.generation;
    if (snapshot.freshness !== 'fresh' || !snapshot.evaluation) {
      await expireDynamicMemberships(account, tenantId, subjectId, generation, options);
      return { status: 'not_fresh', generation, groupIds: [] };
    }
    const catalog = await store.catalog();
    const excluded =
      catalog && catalog.revision === snapshot.ruleVersion
        ? await selfWritableRoleGroups(
            store.db,
            tenantId,
            catalog.plan,
            await loadGroupFields(store.db, tenantId)
          )
        : new Set<string>();
    const groupIds = dynamicGroupIds(snapshot, excluded);
    const ref = dynamicMembershipSourceRef(generation, snapshot.ruleVersion);
    const [existing, published] = await Promise.all([
      dynamicRows(account, tenantId, subjectId),
      publicationRow(account, tenantId, subjectId),
    ]);
    if (published && published.generation > ref)
      return { status: 'superseded', generation, groupIds };
    // Rows without a generation on record (a restore, which rebuilds the record, or a lost
    // record): which publication wrote them is unknown, so they stop granting now; the current
    // result is then published as the first generation on record.
    if (existing.length && !published?.generation)
      await markStale(account, tenantId, subjectId, null);
    const now = nowSeconds();
    // Rows never outlive the result: at most the window, and no later than the time the input
    // changes by itself (a manual membership starting or ending).
    const validUntil = snapshot.evaluation.inputValidUntil;
    const expiry = validUntil === undefined ? now + window : Math.min(now + window, validUntil);
    const active = existing.filter((row) => row.lifecycle_state === 'active');
    const current =
      published?.generation === ref &&
      existing.every((row) => row.source_ref === ref) &&
      active.every(
        (row) =>
          row.stale_after !== null &&
          (Number(row.stale_after) > now + renewBefore || Number(row.stale_after) === expiry) &&
          // A window shortened (or a cap set) since: the rows are written again with it.
          Number(row.stale_after) <= expiry
      ) &&
      [...new Set(active.map((row) => row.group_id))].sort().join('\n') === groupIds.join('\n');
    if (current) return { status: 'current', generation, groupIds };
    await requireCanonicalGroups(store, groupIds);
    await account.batch(
      replaceStatements(account, tenantId, subjectId, ref, groupIds, expiry, now)
    );
    written = ref;
    // Two databases: read the committed result again first, whatever the invalidation does.
    let after: GroupSnapshot | null = null;
    let newer = false;
    try {
      after = await store.snapshot(subjectId, reader);
      newer = ((await publicationRow(account, tenantId, subjectId))?.generation ?? '') > ref;
    } catch {
      after = null;
    }
    let outcome: DynamicPublicationResult | null = null;
    if (newer) outcome = { status: 'superseded', generation, groupIds };
    else if (after && after.generation === generation && after.freshness === 'fresh')
      outcome = { status: 'published', generation, groupIds };
    else if (!after || after.freshness !== 'fresh' || after.generation === generation) {
      await markStale(account, tenantId, subjectId, { ref });
      outcome = { status: 'not_fresh', generation, groupIds };
    }
    await invalidate(account, options, tenantId, subjectId, ref);
    if (outcome) return outcome;
    snapshot = after!;
  }
  // The round limit: what was written last is not known to stand for the committed result.
  if (written) {
    await markStale(account, tenantId, subjectId, { ref: written });
    await invalidate(account, options, tenantId, subjectId, null);
  }
  return { status: 'not_fresh', generation: snapshot.generation, groupIds: [] };
}

/**
 * Makes the subject's dynamic rows of generations up to `lastGeneration` stale now (they stop
 * granting at once), then drops its cached claims. Rows of a newer generation (published by a
 * newer evaluation) are left as they are.
 */
export async function expireDynamicMemberships(
  account: DatabaseAdapter,
  tenantId: string,
  subjectId: string,
  lastGeneration: number,
  options: DynamicPublicationOptions = {}
): Promise<void> {
  if (await markStale(account, tenantId, subjectId, { upTo: lastGeneration }))
    await invalidate(account, options, tenantId, subjectId, null);
}

/**
 * After an evaluation or read that threw: the rows of generations up to the last committed one go
 * stale. When even that generation cannot be read, every dynamic row of the subject goes stale.
 */
export async function expireDynamicMembershipsAfterFailure(
  store: DynamicGroupStore,
  account: DatabaseAdapter,
  subjectId: string,
  options: DynamicPublicationOptions = {}
): Promise<void> {
  let generation: number | null = null;
  try {
    const row = await store.db.queryOne<{ generation: number | string }>(
      'SELECT generation FROM service_group_results WHERE tenant_id = ? AND user_id = ?',
      [store.tenantId, subjectId],
      primary
    );
    generation = Number(row?.generation ?? 0);
  } catch {
    generation = null;
  }
  const changed =
    generation === null
      ? await markStale(account, store.tenantId, subjectId, null)
      : await markStale(account, store.tenantId, subjectId, { upTo: generation });
  if (changed) await invalidate(account, options, store.tenantId, subjectId, null);
}

/**
 * Makes every published dynamic membership of the subject stale now (they stop granting at once;
 * the next fresh publication replaces them). Used when the inputs they were derived from are
 * erased.
 */
export async function markDynamicMembershipsStale(
  account: DatabaseAdapter,
  tenantId: string,
  subjectId: string,
  cache?: KVNamespace
): Promise<void> {
  await markStale(account, tenantId, subjectId, null);
  if (cache) await invalidate(account, { cache }, tenantId, subjectId, null);
}

/**
 * After a rule of the group changed: every dynamic row of the group on this account database
 * stops granting now (the next publication of each subject decides again), and the subjects'
 * cached claims are invalidated (a failure is recorded as pending). Returns the subjects.
 */
export async function expireDynamicGroupMemberships(
  account: DatabaseAdapter,
  tenantId: string,
  groupId: string,
  options: DynamicPublicationOptions = {}
): Promise<string[]> {
  const now = nowSeconds();
  const subjects = (
    await account.query<{ subject_id: string }>(
      `SELECT DISTINCT subject_id FROM group_memberships WHERE tenant_id = ? AND group_id = ?
        AND assignment_source = 'dynamic' AND (stale_after IS NULL OR stale_after > ?)`,
      [tenantId, groupId, now],
      primary
    )
  ).map((row) => row.subject_id);
  if (!subjects.length) return [];
  // The pending marks first (they name the rows still granting), then the expiry: one batch.
  await account.batch([
    {
      sql: `INSERT INTO dynamic_membership_publications (tenant_id, subject_id, generation,
          published_at, invalidation_pending)
        SELECT DISTINCT tenant_id, subject_id, '', CAST(? AS BIGINT), 1 FROM group_memberships
          WHERE tenant_id = ? AND group_id = ? AND assignment_source = 'dynamic'
            AND (stale_after IS NULL OR stale_after > ?)
        ON CONFLICT (tenant_id, subject_id) DO UPDATE SET invalidation_pending = 1`,
      params: [now, tenantId, groupId, now],
    },
    {
      sql: `UPDATE group_memberships SET stale_after = ?, updated_at = ?
        WHERE tenant_id = ? AND group_id = ? AND assignment_source = 'dynamic'
          AND (stale_after IS NULL OR stale_after > ?)`,
      params: [now, now, tenantId, groupId, now],
    },
  ]);
  for (const subjectId of subjects) await invalidate(account, options, tenantId, subjectId, null);
  return subjects;
}

export type DynamicEvaluationPublication =
  | DynamicPublicationResult
  | { status: 'failed'; error: string }
  | { status: 'expiry_pending'; error: string };

const errorCode = (error: unknown, fallback: string) =>
  error instanceof Error && /^group_[a-z_]+$/.test(error.message) ? error.message : fallback;

/**
 * Evaluates the subject, then publishes the committed result into its account database. An
 * evaluation that throws makes the subject's rows stale before the error is passed on. A
 * publication that throws (a read of the result or the catalog failed) makes them stale too and is
 * reported as `failed`; when even that cannot reach the account database it is reported as
 * `expiry_pending`, for the reconcile's scan of that database to expire them.
 */
export async function evaluateAndPublishDynamicMemberships(
  store: DynamicGroupStore,
  reader: SavedGroupInputReader,
  options: DynamicPublicationOptions = {}
): Promise<{ snapshot: GroupSnapshot; publication: DynamicEvaluationPublication }> {
  let snapshot: GroupSnapshot;
  try {
    snapshot = await store.evaluate(reader.userId, reader);
  } catch (error) {
    try {
      await expireDynamicMembershipsAfterFailure(store, reader.core, reader.userId, options);
    } catch {
      // Not even the expiry reached the account database: the reconcile's scan expires them.
      throw new Error('group_expiry_pending');
    }
    throw error;
  }
  try {
    return {
      snapshot,
      publication: await publishDynamicMemberships(store, reader, reader.core, options),
    };
  } catch (error) {
    const code = errorCode(error, 'group_publication_failed');
    try {
      await expireDynamicMembershipsAfterFailure(store, reader.core, reader.userId, options);
    } catch {
      return { snapshot, publication: { status: 'expiry_pending', error: code } };
    }
    return { snapshot, publication: { status: 'failed', error: code } };
  }
}
