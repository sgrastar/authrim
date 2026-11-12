/**
 * Platform profiles (`pmp_…` method, `psp_…` session) a restored bundle's Flows name. They belong
 * to the target environment, not to the bundle: a Flow restored next to a profile the target does
 * not have (or is deleting) would offer no sign-in method, or make no session. The restore
 * preview warns about each (non-blocking: the operator may create the profile afterwards).
 *
 * Which Flow rows count follows platform-profile-references.ts: a live Flow's draft, and the
 * version it publishes. A deleted Flow (row kept, `deleted_at` set) counts for nothing. A bundle
 * carries no running interactions, so the third source there does not apply.
 *
 * Only ids and kinds leave this module (the preview is stored and displayed).
 */
import type { DatabaseAdapter } from '../../db/adapter';
import {
  isPlatformProfileId,
  PlatformProfileRepository,
  type PlatformProfileKind,
} from '../../repositories/admin/platform-profile';
import type { Phase4ExternalPrerequisite } from './phase4-external-prerequisites.js';

export const PLATFORM_PROFILE_FLOW_DATASET = 'core.flows';
export const PLATFORM_PROFILE_FLOW_VERSION_DATASET = 'core.flow_versions';

/** Most distinct ids looked up, and most warnings kept (the approval cursor is 16 KiB). */
export const PLATFORM_PROFILE_LOOKUP_LIMIT = 256;
export const PLATFORM_PROFILE_WARNING_LIMIT = 32;
/** Most Flow version rows read; a bundle beyond it is refused rather than half-checked. */
export const PLATFORM_PROFILE_VERSION_ROW_LIMIT = 20000;

const METHOD_KEY = 'authentication_profile_ref';
const SESSION_KEY = 'session_profile_ref';
const SAFE_ID = /^[A-Za-z0-9_.:/-]{1,256}$/;

export interface BundlePlatformProfileIds {
  method: readonly string[];
  session: readonly string[];
  /** Not every Flow version could be read (past the row limit): the list may miss some. */
  incomplete?: boolean;
}

/**
 * Said in place of the profiles not checked: the scan stopped at one of its limits. Advisory too:
 * a bundle too large to check fully still restores.
 */
export const PLATFORM_PROFILE_CHECK_INCOMPLETE: Phase4ExternalPrerequisite = {
  id: 'platform_profiles',
  kind: 'platform_profile_check',
  scope: 'shared',
  resolution: 'target_binding',
  status: 'unresolved',
  required: false,
};

type PortableRow = Record<string, unknown>;

function parseRow(rowJson: string): PortableRow {
  const row: unknown = JSON.parse(rowJson);
  if (!row || typeof row !== 'object' || Array.isArray(row))
    throw new Error('backup_restore_profile_row_invalid');
  return row as PortableRow;
}

/** A portable column is `[type, value]`; only a text value is read. */
function text(row: PortableRow, column: string): string | null {
  const cell = row[column];
  return Array.isArray(cell) && cell[0] === 'text' && typeof cell[1] === 'string' ? cell[1] : null;
}

function isNull(row: PortableRow, column: string): boolean {
  const cell = row[column];
  return cell === undefined || (Array.isArray(cell) && cell[1] === null);
}

function walk(value: unknown, method: Set<string>, session: Set<string>, depth = 0): void {
  if (depth > 64) throw new Error('backup_restore_profile_row_invalid');
  if (Array.isArray(value)) {
    for (const item of value) walk(item, method, session, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      if (key === METHOD_KEY && isPlatformProfileId('method', item)) method.add(item);
      if (key === SESSION_KEY && isPlatformProfileId('session', item)) session.add(item);
    } else walk(item, method, session, depth + 1);
  }
}

function scanJsonColumn(
  row: PortableRow,
  column: string,
  method: Set<string>,
  session: Set<string>
): void {
  const raw = text(row, column);
  if (!raw) return;
  if (raw.length > 4 * 1024 * 1024) throw new Error('backup_restore_profile_row_invalid');
  walk(JSON.parse(raw), method, session);
}

/**
 * The platform profile ids named by the bundle's live Flows: their drafts, and the versions they
 * publish. `readRows` yields the validated rows (as portable row JSON) of one dataset, from the
 * start; an unselected dataset yields none.
 */
export async function collectBundlePlatformProfileIds(
  readRows: (datasetId: string) => AsyncIterable<string>
): Promise<BundlePlatformProfileIds> {
  const method = new Set<string>();
  const session = new Set<string>();
  const publishedVersions = new Set<string>();
  for await (const rowJson of readRows(PLATFORM_PROFILE_FLOW_DATASET)) {
    const row = parseRow(rowJson);
    if (!isNull(row, 'deleted_at')) continue;
    scanJsonColumn(row, 'draft_editor_json', method, session);
    scanJsonColumn(row, 'draft_runtime_base_json', method, session);
    const published = text(row, 'published_version_id');
    if (published) publishedVersions.add(published);
  }
  let incomplete = false;
  if (publishedVersions.size > 0) {
    let rows = 0;
    for await (const rowJson of readRows(PLATFORM_PROFILE_FLOW_VERSION_DATASET)) {
      if (++rows > PLATFORM_PROFILE_VERSION_ROW_LIMIT) {
        incomplete = true;
        break;
      }
      const row = parseRow(rowJson);
      const versionId = text(row, 'id');
      if (!versionId || !publishedVersions.has(versionId)) continue;
      scanJsonColumn(row, 'runtime_snapshot_json', method, session);
    }
  }
  return {
    method: [...method].sort(),
    session: [...session].sort(),
    ...(incomplete ? { incomplete } : {}),
  };
}

/**
 * The ids the target cannot use: not there, or not active (deleting/deleted). Each becomes a
 * non-required, unresolved `shared` prerequisite; usable ones are not listed.
 */
export async function findUnusablePlatformProfiles(
  admin: Pick<DatabaseAdapter, 'queryOne'>,
  ids: BundlePlatformProfileIds
): Promise<Phase4ExternalPrerequisite[]> {
  const adapter = admin as DatabaseAdapter;
  const candidates: Array<{ kind: PlatformProfileKind; id: string }> = [
    ...ids.method.map((id) => ({ kind: 'method' as const, id })),
    ...ids.session.map((id) => ({ kind: 'session' as const, id })),
  ].filter(({ id }) => SAFE_ID.test(id));
  const incomplete = ids.incomplete === true || candidates.length > PLATFORM_PROFILE_LOOKUP_LIMIT;
  const warnings: Phase4ExternalPrerequisite[] = [];
  for (const { kind, id } of candidates.slice(0, PLATFORM_PROFILE_LOOKUP_LIMIT)) {
    const profile = await new PlatformProfileRepository(adapter, kind).find(id);
    if (profile?.state === 'active') continue;
    warnings.push({
      id,
      kind: kind === 'method' ? 'platform_method_profile' : 'platform_session_profile',
      scope: 'shared',
      resolution: 'target_binding',
      status: 'unresolved',
      required: false,
    });
  }
  const shown = warnings
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, PLATFORM_PROFILE_WARNING_LIMIT);
  return incomplete ? [...shown, PLATFORM_PROFILE_CHECK_INCOMPLETE] : shown;
}

export function isPlatformProfilePrerequisite(
  value: Pick<Phase4ExternalPrerequisite, 'kind'>
): boolean {
  return (
    value.kind === 'platform_method_profile' ||
    value.kind === 'platform_session_profile' ||
    value.kind === 'platform_profile_check'
  );
}
