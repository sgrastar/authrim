/**
 * How a Mapping Set's content changes the claims it fills: for each claim, the Destination Profile
 * it is released through, the attributes it is filled from, the steps on the way (in their order)
 * and the type of what it reads, before and after. Names and kinds of change only, never a value.
 *
 * References are read as the runtime reads them: the path, namespace and profile through the
 * shared readers (`mappingReferencePath`, `mappingReferenceProfileId`,
 * `normalizeDestinationProfileReference`), the catalog entry of a source with the runtime's
 * `findCatalogEntry` (its ID first, then its place or one of the entry's aliases).
 *
 * A claim is what a rule's edge writes in the release namespace (the target's path). It is
 * `renamed` when one claim goes and another comes through the same Destination Profile from the
 * same attributes; otherwise a claim that goes is `removed` and one that comes is `added`. A claim
 * kept is `profile_changed` when another profile releases it, `source_changed` when it reads other
 * attributes (or the same ones in another order of rule priority and edges: the last one wins), `transform_changed` when the steps on its edges differ (their order counts), and
 * `type_changed` when what it reads has another type in the catalog.
 */
import {
  mappingReferenceCatalogEntryId,
  mappingReferencePath,
  mappingReferenceProfileId,
  normalizeDestinationProfileReference,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { findCatalogEntry } from '@authrim/ar-lib-field-mapping/runtime';
import type { MappingSetContent } from './identity-mapping-set-facade-content';

export type ClaimChangeKind =
  | 'added'
  | 'removed'
  | 'renamed'
  | 'profile_changed'
  | 'source_changed'
  | 'transform_changed'
  | 'type_changed';

export interface ClaimChange {
  kind: ClaimChangeKind;
  claim: string;
  /** `renamed`: the claim's name before. */
  previous_claim?: string;
  type_before?: string;
  type_after?: string;
  /** The Destination Profile the claim is released through (after; before for `removed`). */
  profile_id: string | null;
  /** The profile before, when another profile releases the claim now. */
  previous_profile_id?: string | null;
}

interface ClaimShape {
  claim: string;
  profileId: string | null;
  /** The attributes it reads, as `namespace:path` (what decides what is read). */
  sourceKeys: string[];
  /** The same in the order the runtime writes them (the last one wins). */
  sourceOrder: string;
  /** The steps on the claim's edges, in order, as stable JSON. */
  transforms: string;
  /** The catalog type of what it reads (`string`, `string[]`), when every source has one. */
  type: string | null;
}

/** A content's catalog version, as the runtime finds an entry in it. */
export interface CatalogTypes {
  bundle: Parameters<typeof findCatalogEntry>[0];
  /** An entry's row ID → its stable ID (the ID the runtime catalog carries). */
  stableIds: ReadonlyMap<string, string>;
}

export const NO_CATALOG: CatalogTypes = { bundle: { entries: [] } as never, stableIds: new Map() };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function namespaceOf(ref: Record<string, unknown>): string {
  return typeof ref.namespace === 'string' ? ref.namespace : '';
}

function typeOf(ref: Record<string, unknown>, catalog: CatalogTypes): string | null {
  const id = mappingReferenceCatalogEntryId(ref);
  const entry = findCatalogEntry(catalog.bundle, {
    namespace: namespaceOf(ref),
    path: mappingReferencePath(ref) ?? '',
    ...(id ? { catalogEntryId: catalog.stableIds.get(id) ?? id } : {}),
  });
  if (!entry) return null;
  return entry.cardinality === 'multi' ? `${entry.valueType}[]` : entry.valueType;
}

/**
 * The place a source reads, as `namespace:path`: a reference that names only its catalog entry
 * reads the place the entry describes (as the runtime completes it), the namespace it names kept.
 */
function sourceKey(ref: Record<string, unknown>, catalog: CatalogTypes): string | null {
  const path = mappingReferencePath(ref);
  if (path) return `${namespaceOf(ref)}:${path}`;
  const id = mappingReferenceCatalogEntryId(ref);
  if (!id) return null;
  const entry = findCatalogEntry(catalog.bundle, {
    namespace: namespaceOf(ref),
    path: '',
    catalogEntryId: catalog.stableIds.get(id) ?? id,
  });
  // An entry the catalog does not have reads nothing known: the ID itself tells two apart.
  return entry ? `${namespaceOf(ref) || entry.namespace}:${entry.path}` : `entry:${id}`;
}

/** The claims a content fills, keyed by claim name. */
export function claimShapes(
  content: Pick<MappingSetContent, 'rules'>,
  catalog: CatalogTypes
): Map<string, ClaimShape> {
  // An edge that names no profile is released through the set's one profile, as the runtime
  // resolves a set to exactly one.
  const profiles = new Set<string>();
  for (const rule of content.rules) {
    for (const edge of rule.edges ?? []) {
      const profile = mappingReferenceProfileId(edge.targetRef);
      if (profile) profiles.add(normalizeDestinationProfileReference(profile));
    }
  }
  const setProfile = profiles.size === 1 ? [...profiles][0] : null;

  const shapes = new Map<
    string,
    {
      profileId: string | null;
      sources: Set<string>;
      order: string[];
      transforms: string[];
      types: Set<string>;
    }
  >();
  const rules = content.rules;
  // The edges in the order the runtime loads them: by rule priority, then by each edge's place in
  // its rule (rules saved together share their time, so theirs interleave), then as saved. Of
  // several edges into one claim, the last written wins.
  const edges = rules.flatMap((rule, ruleIndex) =>
    (rule.edges ?? []).map((edge, edgeIndex) => ({ rule, ruleIndex, edge, edgeIndex }))
  );
  edges.sort(
    (a, b) =>
      (a.rule.priority ?? 0) - (b.rule.priority ?? 0) ||
      a.edgeIndex - b.edgeIndex ||
      a.ruleIndex - b.ruleIndex
  );
  for (const { edge } of edges) {
    const claim = mappingReferencePath(edge.targetRef);
    if (!claim) continue;
    const profile = mappingReferenceProfileId(edge.targetRef);
    let shape = shapes.get(claim);
    if (!shape) {
      shape = {
        profileId: profile ? normalizeDestinationProfileReference(profile) : setProfile,
        sources: new Set(),
        order: [],
        transforms: [],
        types: new Set(),
      };
      shapes.set(claim, shape);
    }
    const key = sourceKey(edge.sourceRef, catalog);
    if (key) shape.sources.add(key);
    shape.order.push(key ?? '?');
    shape.types.add(typeOf(edge.sourceRef, catalog) ?? '');
  }
  // The steps in the order the runtime loads them: by rule priority, then by each step's place in
  // its rule (so the steps of rules of one priority interleave), then as saved. Each is compared
  // with the input it takes (its edge's source, or every edge for a step that names none) and is
  // counted for each claim it reaches.
  const steps = rules.flatMap((rule, ruleIndex) =>
    (rule.transforms ?? []).map((step, stepIndex) => ({ rule, ruleIndex, step, stepIndex }))
  );
  steps.sort(
    (a, b) =>
      (a.rule.priority ?? 0) - (b.rule.priority ?? 0) ||
      a.stepIndex - b.stepIndex ||
      a.ruleIndex - b.ruleIndex
  );
  for (const { rule, step } of steps) {
    const edges = rule.edges ?? [];
    const reached =
      step.edgeIndex === undefined
        ? edges.map((_, index) => index)
        : edges[step.edgeIndex]
          ? [step.edgeIndex]
          : [];
    const input =
      step.edgeIndex === undefined
        ? '*'
        : edges[step.edgeIndex]
          ? (sourceKey(edges[step.edgeIndex].sourceRef, catalog) ?? '?')
          : '?';
    const signature = stable({
      input,
      operation: step.operation,
      parameters: step.parameters ?? {},
    });
    for (const claim of new Set(
      reached.map((index) => mappingReferencePath(edges[index].targetRef))
    )) {
      if (claim) shapes.get(claim)?.transforms.push(signature);
    }
  }
  return new Map(
    [...shapes].map(([claim, shape]) => {
      const types = [...shape.types];
      return [
        claim,
        {
          claim,
          profileId: shape.profileId,
          sourceKeys: [...shape.sources].sort(),
          sourceOrder: shape.order.join('\n'),
          transforms: shape.transforms.join('|'),
          type: types.length === 1 && types[0] !== '' ? types[0] : null,
        },
      ];
    })
  );
}

/** The attributes a content's claim reads, by path (for showing; the keys decide). */
export function sourcePaths(shape: Pick<ClaimShape, 'sourceKeys'>): string[] {
  return shape.sourceKeys.map((key) => key.slice(key.indexOf(':') + 1));
}

const sameSources = (a: ClaimShape, b: ClaimShape) =>
  a.sourceKeys.join('\n') === b.sourceKeys.join('\n');

/** The changes from one content's claims to another's, in claim order. */
export function diffClaimShapes(
  before: ReadonlyMap<string, ClaimShape>,
  after: ReadonlyMap<string, ClaimShape>
): ClaimChange[] {
  const changes: ClaimChange[] = [];
  const removed = [...before.values()].filter((shape) => !after.has(shape.claim));
  const added = [...after.values()].filter((shape) => !before.has(shape.claim));
  const renamedFrom = new Map<string, ClaimShape>();
  const taken = new Set<string>();
  for (const shape of added) {
    const match = removed.find(
      (old) =>
        !taken.has(old.claim) &&
        old.sourceKeys.length > 0 &&
        old.profileId === shape.profileId &&
        sameSources(old, shape)
    );
    if (match) {
      renamedFrom.set(shape.claim, match);
      taken.add(match.claim);
    }
  }

  for (const shape of added) {
    const old = renamedFrom.get(shape.claim);
    changes.push(
      old
        ? {
            kind: 'renamed',
            claim: shape.claim,
            previous_claim: old.claim,
            profile_id: shape.profileId,
          }
        : { kind: 'added', claim: shape.claim, profile_id: shape.profileId }
    );
  }
  for (const shape of removed) {
    if (!taken.has(shape.claim)) {
      changes.push({ kind: 'removed', claim: shape.claim, profile_id: shape.profileId });
    }
  }
  for (const [claim, now] of after) {
    const was = before.get(claim);
    if (!was) continue;
    // When the profile changes too, every change of the claim says which profile it had.
    const base = {
      claim,
      profile_id: now.profileId,
      ...(was.profileId !== now.profileId ? { previous_profile_id: was.profileId } : {}),
    };
    if (was.profileId !== now.profileId) {
      changes.push({ kind: 'profile_changed', ...base });
    }
    // Other attributes, or the same ones in another order (another one is written last).
    if (!sameSources(was, now) || was.sourceOrder !== now.sourceOrder) {
      changes.push({ kind: 'source_changed', ...base });
    } else if (was.transforms !== now.transforms) {
      changes.push({ kind: 'transform_changed', ...base });
    }
    if (was.type && now.type && was.type !== now.type) {
      changes.push({ kind: 'type_changed', ...base, type_before: was.type, type_after: now.type });
    }
  }
  return changes.sort((a, b) => a.claim.localeCompare(b.claim) || a.kind.localeCompare(b.kind));
}

/** Where a change's claim is released before and after (null where it is not). */
export function releasePoints(change: ClaimChange): {
  before: { claim: string; profileId: string | null } | null;
  after: { claim: string; profileId: string | null } | null;
} {
  const after =
    change.kind === 'removed' ? null : { claim: change.claim, profileId: change.profile_id };
  const before =
    change.kind === 'added'
      ? null
      : {
          claim: change.previous_claim ?? change.claim,
          profileId:
            change.previous_profile_id !== undefined
              ? change.previous_profile_id
              : change.profile_id,
        };
  return { before, after };
}

interface CatalogEntryRow {
  id: string;
  stable_field_id: string | null;
  namespace: string;
  path: string;
  aliases_json: string | null;
  value_type: string;
  cardinality: string | null;
}

function parseAliases(raw: string | null): Array<{ namespace: string; path: string }> {
  try {
    const value = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(value)
      ? value.flatMap((item) =>
          item &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).namespace === 'string' &&
          typeof (item as Record<string, unknown>).path === 'string'
            ? [{ namespace: item.namespace as string, path: item.path as string }]
            : []
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * A content's catalog version as the runtime reads it: its entries under the set's owner (a set
 * the platform owns reads the platform's), by stable ID, place and aliases. A version that is not
 * stored (the virtual canonical one) gives no types.
 */
export async function readCatalogTypes(
  admin: DatabaseAdapter,
  ownerTenantId: string,
  catalogVersionId: string | null
): Promise<CatalogTypes> {
  if (!catalogVersionId) return NO_CATALOG;
  const rows = await admin.query<CatalogEntryRow>(
    `SELECT id, stable_field_id, namespace, path, aliases_json, value_type, cardinality
       FROM field_catalog_entries
      WHERE tenant_id = ? AND catalog_version_id = ?
      ORDER BY namespace ASC, path ASC`,
    [ownerTenantId, catalogVersionId]
  );
  return {
    bundle: {
      entries: rows.map((row) => ({
        id: row.stable_field_id || row.id,
        namespace: row.namespace,
        path: row.path,
        aliases: parseAliases(row.aliases_json),
        valueType: row.value_type,
        cardinality: row.cardinality === 'multi' ? 'multi' : 'single',
      })),
    } as never,
    stableIds: new Map(rows.map((row) => [row.id, row.stable_field_id || row.id])),
  };
}
