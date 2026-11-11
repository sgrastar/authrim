/**
 * Where a platform profile (services/platform-profiles.ts) is named, across every tenant, before
 * it is deleted: a profile still named would leave those Flows with none (they then offer no
 * method, or make no session).
 *
 * Each tenant's Core database is read for the Flows that name it:
 * - a Flow's draft (its editor and its runtime);
 * - the version it publishes;
 * - a version an interaction still running started with (it reads that version to the end, even
 *   after another is published).
 * The id is looked for as text, not as one JSON spelling of it: a platform profile's id is unique
 * and long, so its text names it wherever it appears.
 *
 * A tenant that cannot be read is reported as not looked at; the caller then refuses to delete
 * (an incomplete search proves nothing).
 */
import type { DatabaseAdapter } from '../db/adapter';

export interface PlatformProfileReferenceScan {
  /** Tenants with a Flow that names the profile (at most `referenceLimit`). */
  tenants: string[];
  /** Whether more tenants name it than are listed. */
  truncated: boolean;
  /** What could not be looked at (any of it means the search is incomplete). */
  unscanned: Array<{ tenantId?: string; reason: string }>;
}

export interface FindPlatformProfileReferencesInput {
  profileId: string;
  /** The tenants that can still be read (not those whose deletion is complete), at most `limit`. */
  listTenantIds: (limit: number) => Promise<readonly string[]>;
  /** A tenant's Core database (null or a throw: that tenant is reported as not looked at). */
  resolveCoreAdapter: (tenantId: string) => Promise<DatabaseAdapter | null>;
  /** How many tenants are looked at, at most (more is reported as not looked at). */
  tenantLimit?: number;
  /** How many tenants are read at once. */
  concurrency?: number;
  /** How many naming tenants are listed. */
  referenceLimit?: number;
  nowSeconds?: number;
}

const DEFAULT_TENANT_LIMIT = 1000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_REFERENCE_LIMIT = 20;

/** A LIKE pattern that matches the text as it is (its wildcards escaped with `\`). */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Whether a tenant's Flows name the profile (draft, published version, or a running one). Also
 * the check before a tenant deletes a profile of its own.
 */
export async function flowsNameProfile(
  core: DatabaseAdapter,
  tenantId: string,
  profileId: string,
  nowSeconds: number
): Promise<boolean> {
  const pattern = containsPattern(profileId);
  const row = await core.queryOne<{ hit: number }>(
    `SELECT 1 AS hit FROM flows f
      WHERE f.tenant_id = ? AND f.deleted_at IS NULL
        AND (f.draft_editor_json LIKE ? ESCAPE '\\' OR f.draft_runtime_base_json LIKE ? ESCAPE '\\')
     UNION ALL
     SELECT 1 AS hit FROM flow_versions v
      WHERE v.tenant_id = ? AND v.runtime_snapshot_json LIKE ? ESCAPE '\\'
        AND (v.id IN (SELECT f.published_version_id FROM flows f
                       WHERE f.tenant_id = ? AND f.deleted_at IS NULL)
             OR v.id IN (SELECT i.flow_version_id FROM flow_interactions i
                          WHERE i.tenant_id = ? AND i.state IN ('created', 'active')
                            AND i.expires_at > ?))
     LIMIT 1`,
    [tenantId, pattern, pattern, tenantId, pattern, tenantId, tenantId, nowSeconds]
  );
  return row !== null && row !== undefined;
}

export async function findPlatformProfileReferences(
  input: FindPlatformProfileReferencesInput
): Promise<PlatformProfileReferenceScan> {
  const tenantLimit = input.tenantLimit ?? DEFAULT_TENANT_LIMIT;
  const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
  const referenceLimit = input.referenceLimit ?? DEFAULT_REFERENCE_LIMIT;
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tenants: string[] = [];
  const unscanned: PlatformProfileReferenceScan['unscanned'] = [];
  let truncated = false;

  let tenantIds: readonly string[];
  try {
    // One more than can be looked at, to tell whether there are more.
    tenantIds = await input.listTenantIds(tenantLimit + 1);
  } catch {
    return { tenants, truncated, unscanned: [{ reason: 'tenant_directory_unavailable' }] };
  }
  if (tenantIds.length > tenantLimit) {
    unscanned.push({ reason: 'tenant_limit_exceeded' });
    tenantIds = tenantIds.slice(0, tenantLimit);
  }

  for (let start = 0; start < tenantIds.length; start += concurrency) {
    const chunk = tenantIds.slice(start, start + concurrency);
    const results = await Promise.all(
      chunk.map(async (tenantId) => {
        let core: DatabaseAdapter | null;
        try {
          core = await input.resolveCoreAdapter(tenantId);
        } catch {
          core = null;
        }
        if (!core) return { tenantId, outcome: 'unavailable' as const };
        try {
          return {
            tenantId,
            outcome: (await flowsNameProfile(core, tenantId, input.profileId, nowSeconds))
              ? ('named' as const)
              : ('clear' as const),
          };
        } catch {
          return { tenantId, outcome: 'unreadable' as const };
        }
      })
    );
    for (const result of results) {
      if (result.outcome === 'named') {
        if (tenants.length < referenceLimit) tenants.push(result.tenantId);
        else truncated = true;
      } else if (result.outcome === 'unavailable') {
        unscanned.push({ tenantId: result.tenantId, reason: 'core_database_unavailable' });
      } else if (result.outcome === 'unreadable') {
        unscanned.push({ tenantId: result.tenantId, reason: 'flows_unreadable' });
      }
    }
  }
  return { tenants, truncated, unscanned };
}
