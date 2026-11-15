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
 * A claim is what a rule's edge writes: its name (the target's path) in its namespace (the
 * runtime releases only what is written in the release namespace). It is `renamed` when one claim
 * goes and another comes through the same Destination Profile from the same attributes;
 * otherwise a claim that goes is `removed` and one that comes is `added`. A claim kept is
 * `profile_changed` when another profile releases it, `source_changed` when it reads other
 * attributes (or the same ones in another order of rule priority and edges: the last one wins),
 * `transform_changed` when the steps on its edges differ (an operation, its parameters, the edge
 * it is on, or their order), and `type_changed` when what it reads has another catalog type. A
 * step on no edge of its rule (none named, or one the rule does not have) is released nowhere, as
 * the runtime reads it, so it changes no claim.
 */
import {
  mappingReferenceCatalogEntryId,
  mappingReferencePath,
  mappingReferenceProfileId,
  normalizeDestinationProfileReference,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import { analyzeMappingDependencies } from '@authrim/ar-lib-field-mapping/authoring';
import {
  canonicalMappingRule,
  ruleOutput,
  transformInputs,
} from './identity-mapping-graph-contract';
import { findCatalogEntry } from '@authrim/ar-lib-field-mapping/runtime';
import type { MappingSetContent } from './identity-mapping-set-facade-content';

export type ClaimChangeKind =
  | 'added'
  | 'removed'
  | 'renamed'
  | 'profile_changed'
  | 'source_changed'
  | 'transform_changed'
  | 'type_changed'
  | 'validation_changed'
  /** The set's profile is switched: a claim the new one lists and the old did not, and so on. */
  | 'profile_field_added'
  | 'profile_field_removed'
  | 'profile_field_changed';

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
  /** The namespace the claim is written in (after; before for `removed`). */
  namespace: string;
  /** `renamed`: the namespace before, when it differs. */
  previous_namespace?: string;
  /** A validation definition was added, removed, or changed for this field. */
  validation_change?: 'added' | 'removed' | 'changed';
  /** Critical validation can reject the whole app's issuance, independently of claim scopes. */
  validation_effect?: 'may_reject' | 'validation_only';
  /** Per-source catalog types when a claim reads several attributes. */
  source_types_before?: Array<{ source: string; type: string | null }>;
  source_types_after?: Array<{ source: string; type: string | null }>;
}

interface ClaimShape {
  claim: string;
  namespace: string;
  profileId: string | null;
  /** The attributes it reads, as `namespace:path` (what decides what is read). */
  sourceKeys: string[];
  /** The same in the order the runtime writes them (the last one wins). */
  sourceOrder: string;
  /** The steps on the claim's edges in order, each with the place of its edge, as stable JSON. */
  transforms: string;
  /** The catalog types of each attribute, retaining their association when types are mixed. */
  sourceTypes: ReadonlyMap<string, string | null>;
  /** Distinct catalog types (`string`, `string[]`, or `string | string[]`). */
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

/** A claim's key: its namespace and name. */
function claimKey(namespace: string, claim: string): string {
  return `${namespace}\u0000${claim}`;
}

/** The claims a content fills, keyed by namespace and name. */
export function claimShapes(
  content: Pick<MappingSetContent, 'rules'>,
  catalog: CatalogTypes
): Map<string, ClaimShape> {
  // GET translates representable stored rows to graphs. Compare legacy writes through the same
  // output dependencies, so unused independent steps do not create a spurious change on resave.
  const normalizedRules = content.rules.map((rule) => {
    // Malformed historical steps were ignored by the legacy diff. They are not representable
    // graph inputs; saves and runtime loads validate them separately.
    if (
      !rule.output &&
      !rule.transforms?.some((step) => step.inputs !== undefined) &&
      rule.transforms?.some(
        (step) => !step.targetRef && (step.edgeIndex === undefined || !rule.edges?.[step.edgeIndex])
      )
    )
      return rule;
    return canonicalMappingRule(rule);
  });
  // An edge that names no profile is released through the set's one profile, as the runtime
  // resolves a set to exactly one.
  const profiles = new Set<string>();
  for (const rule of normalizedRules) {
    const targets = [
      ...(rule.targetRef ? [rule.targetRef] : []),
      ...(rule.edges ?? []).map((edge) => edge.targetRef),
      ...(rule.transforms ?? []).flatMap((step) => (step.targetRef ? [step.targetRef] : [])),
    ];
    for (const target of targets) {
      const profile = mappingReferenceProfileId(target);
      if (profile) profiles.add(normalizeDestinationProfileReference(profile));
    }
  }
  const setProfile = profiles.size === 1 ? [...profiles][0] : null;

  const shapes = new Map<
    string,
    {
      claim: string;
      namespace: string;
      profileId: string | null;
      sources: Set<string>;
      order: string[];
      transforms: string[];
      sourceTypes: Map<string, string | null>;
    }
  >();
  const rules = normalizedRules.map((rule) => {
    const output = ruleOutput(rule);
    if ((!rule.output && !rule.transforms?.some((step) => step.inputs !== undefined)) || !output)
      return { rule };
    const transforms = rule.transforms ?? [];
    const dependencies = analyzeMappingDependencies({
      edgeCount: rule.edges?.length ?? 0,
      transforms: transforms.map((step) => ({ inputs: transformInputs(step) })),
      output,
    });
    const targetRef =
      rule.targetRef ??
      ('edgeIndex' in output
        ? rule.edges?.[output.edgeIndex]?.targetRef
        : (transforms[output.stepIndex]?.targetRef ?? rule.edges?.[0]?.targetRef));
    return { rule, dependencies, targetRef };
  });
  // The edges in the order the runtime loads them: by rule priority, then by each edge's place in
  // its rule (rules saved together share their time, so theirs interleave), then as saved. Of
  // several edges into one claim, the last written wins.
  const edges = rules.flatMap(({ rule, dependencies, targetRef }, ruleIndex) =>
    (dependencies
      ? [...dependencies.edgeIndexes]
      : (rule.edges ?? []).map((_, index) => index)
    ).flatMap((edgeIndex, edgeOrder) => {
      const edge = rule.edges?.[edgeIndex];
      return edge
        ? [{ rule, ruleIndex, edge, edgeOrder, targetRef: targetRef ?? edge.targetRef }]
        : [];
    })
  );
  edges.sort(
    (a, b) =>
      (a.rule.priority ?? 0) - (b.rule.priority ?? 0) ||
      a.edgeOrder - b.edgeOrder ||
      a.ruleIndex - b.ruleIndex
  );
  const shapeFor = (targetRef: Record<string, unknown>) => {
    const claim = mappingReferencePath(targetRef);
    if (!claim) return null;
    const namespace = namespaceOf(targetRef);
    const key = claimKey(namespace, claim);
    const profile = mappingReferenceProfileId(targetRef);
    let shape = shapes.get(key);
    if (!shape) {
      shape = {
        claim,
        namespace,
        profileId: profile ? normalizeDestinationProfileReference(profile) : setProfile,
        sources: new Set(),
        order: [],
        transforms: [],
        sourceTypes: new Map(),
      };
      shapes.set(key, shape);
    }
    return { key, shape };
  };
  // Where each edge is among its claim's edges, so a step is told by the edge it is on.
  const placeOf = new Map<unknown, { key: string; place: number }>();
  for (const { edge, targetRef } of edges) {
    const found = shapeFor(targetRef);
    if (!found) continue;
    const { key, shape } = found;
    const source = sourceKey(edge.sourceRef, catalog);
    if (source) shape.sources.add(source);
    placeOf.set(edge, { key, place: shape.order.length });
    shape.order.push(source ?? '?');
    shape.sourceTypes.set(source ?? '?', typeOf(edge.sourceRef, catalog));
  }
  // The steps in the order the runtime loads them: by rule priority, then by each step's place in
  // its rule (so the steps of rules of one priority interleave), then as saved. A step on no edge
  // of its rule is released nowhere.
  const steps = rules.flatMap(({ rule, dependencies, targetRef }, ruleIndex) =>
    (rule.transforms ?? []).flatMap((step, stepIndex) =>
      dependencies && !dependencies.stepIndexes.includes(stepIndex)
        ? []
        : [{ rule, ruleIndex, step, stepIndex, dependencies, targetRef }]
    )
  );
  steps.sort(
    (a, b) =>
      (a.rule.priority ?? 0) - (b.rule.priority ?? 0) ||
      a.stepIndex - b.stepIndex ||
      a.ruleIndex - b.ruleIndex
  );
  for (const { rule, step, dependencies, targetRef } of steps) {
    if (dependencies && targetRef) {
      const found = shapeFor(targetRef);
      if (!found) continue;
      const inputs = transformInputs(step);
      const first = inputs[0];
      const edge = first && 'edgeIndex' in first ? rule.edges?.[first.edgeIndex] : undefined;
      found.shape.transforms.push(
        stable({
          at: edge ? (placeOf.get(edge)?.place ?? -1) : -1,
          operation: step.operation,
          parameters: step.parameters ?? {},
          ...(inputs.length > 1 ||
          inputs.some((ref) => 'stepIndex' in ref || ref.name !== undefined)
            ? { inputs }
            : {}),
        })
      );
      continue;
    }
    // A step with no input edge (a persistent identifier) fills the claim it names itself: the
    // claim has no source, and the step's settings are what changes.
    if (step.targetRef) {
      const own = shapeFor(step.targetRef);
      own?.shape.transforms.push(
        stable({ at: -1, operation: step.operation, parameters: step.parameters ?? {} })
      );
      continue;
    }
    const edge = step.edgeIndex === undefined ? undefined : (rule.edges ?? [])[step.edgeIndex];
    const at = edge ? placeOf.get(edge) : undefined;
    if (!at) continue;
    shapes
      .get(at.key)
      ?.transforms.push(
        stable({ at: at.place, operation: step.operation, parameters: step.parameters ?? {} })
      );
  }
  return new Map(
    [...shapes].map(([key, shape]) => {
      const types = [...new Set(shape.sourceTypes.values())];
      return [
        key,
        {
          claim: shape.claim,
          namespace: shape.namespace,
          profileId: shape.profileId,
          sourceKeys: [...shape.sources].sort(),
          sourceOrder: shape.order.join('\n'),
          transforms: shape.transforms.join('|'),
          sourceTypes: shape.sourceTypes,
          type: types.some((type) => type !== null)
            ? types
                .map((type) => type ?? 'unknown')
                .sort()
                .join(' | ')
            : null,
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
  const removed = [...before].filter(([key]) => !after.has(key)).map(([, shape]) => shape);
  const added = [...after].filter(([key]) => !before.has(key)).map(([, shape]) => shape);
  const renamedFrom = new Map<ClaimShape, ClaimShape>();
  const taken = new Set<ClaimShape>();
  for (const shape of added) {
    const match = removed.find(
      (old) =>
        !taken.has(old) &&
        old.sourceKeys.length > 0 &&
        old.profileId === shape.profileId &&
        sameSources(old, shape)
    );
    if (match) {
      renamedFrom.set(shape, match);
      taken.add(match);
    }
  }

  for (const shape of added) {
    const old = renamedFrom.get(shape);
    const base = { claim: shape.claim, profile_id: shape.profileId, namespace: shape.namespace };
    changes.push(
      old
        ? {
            kind: 'renamed',
            ...base,
            previous_claim: old.claim,
            ...(old.namespace !== shape.namespace ? { previous_namespace: old.namespace } : {}),
          }
        : { kind: 'added', ...base }
    );
  }
  for (const shape of removed) {
    if (!taken.has(shape)) {
      changes.push({
        kind: 'removed',
        claim: shape.claim,
        profile_id: shape.profileId,
        namespace: shape.namespace,
      });
    }
  }
  for (const [key, now] of after) {
    const was = before.get(key);
    if (!was) continue;
    // When the profile changes too, every change of the claim says which profile it had.
    const base = {
      claim: now.claim,
      profile_id: now.profileId,
      namespace: now.namespace,
      ...(was.profileId !== now.profileId ? { previous_profile_id: was.profileId } : {}),
    };
    if (was.profileId !== now.profileId) {
      changes.push({ kind: 'profile_changed', ...base });
    }
    // Other attributes, or the same ones in another order (another one is written last).
    if (!sameSources(was, now) || was.sourceOrder !== now.sourceOrder) {
      changes.push({ kind: 'source_changed', ...base });
    }
    if (was.transforms !== now.transforms) {
      changes.push({ kind: 'transform_changed', ...base });
    }
    const changedSourceType = [...was.sourceTypes].some(([source, type]) => {
      const next = now.sourceTypes.get(source);
      return type !== null && next !== undefined && next !== null && type !== next;
    });
    const completeTypes = (shape: ClaimShape) =>
      [...shape.sourceTypes.values()].every((type) => type !== null);
    if (
      was.type &&
      now.type &&
      (changedSourceType || (completeTypes(was) && completeTypes(now) && was.type !== now.type))
    ) {
      const sourceTypes = (shape: ClaimShape) =>
        [...shape.sourceTypes]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([source, type]) => ({ source, type }));
      changes.push({
        kind: 'type_changed',
        ...base,
        type_before: was.type,
        type_after: now.type,
        ...(was.sourceTypes.size > 1 || now.sourceTypes.size > 1
          ? { source_types_before: sourceTypes(was), source_types_after: sourceTypes(now) }
          : {}),
      });
    }
  }
  return changes.sort(
    (a, b) =>
      a.claim.localeCompare(b.claim) ||
      a.namespace.localeCompare(b.namespace) ||
      a.kind.localeCompare(b.kind)
  );
}

/**
 * Validation is independent of the claims an app releases: a critical failure rejects the whole
 * issuance. Compare definitions per target, without returning parameters or attribute values.
 * Noncritical changes are still shown on the set, but do not change the app's released claims.
 */
export function diffValidationRules(
  before: Pick<MappingSetContent, 'rules'> | null,
  after: Pick<MappingSetContent, 'rules'>,
  profileBefore: string | null,
  profileAfter: string | null
): ClaimChange[] {
  const read = (content: Pick<MappingSetContent, 'rules'> | null) => {
    const targets = new Map<
      string,
      { claim: string; namespace: string; definitions: string[]; critical: string[] }
    >();
    for (const rule of content?.rules ?? []) {
      for (const validation of rule.validationRules ?? []) {
        const ref = validation.targetRef;
        const claim = mappingReferencePath(ref) ?? mappingReferenceCatalogEntryId(ref) ?? 'unknown';
        const namespace = namespaceOf(ref);
        const side = ref.side === 'canonical' || ref.side === 'destination' ? ref.side : 'source';
        const key = stable({
          side,
          namespace,
          claim,
          catalogEntryId: mappingReferenceCatalogEntryId(ref),
        });
        const target = targets.get(key) ?? { claim, namespace, definitions: [], critical: [] };
        // The writer persists an omitted severity as error, including for a required rule.
        const severity = validation.severity ?? 'error';
        const definition = stable({
          kind: validation.validationKind,
          severity,
          parameters: validation.parameters ?? {},
        });
        target.definitions.push(definition);
        if (severity === 'critical') target.critical.push(definition);
        targets.set(key, target);
      }
    }
    return targets;
  };
  const was = read(before);
  const now = read(after);
  const signature = (definitions: string[] = []) => stable([...new Set(definitions)].sort());
  const changes: ClaimChange[] = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const previous = was.get(key);
    const current = now.get(key);
    if (signature(previous?.definitions) === signature(current?.definitions)) continue;
    const target = current ?? previous;
    if (!target) continue;
    changes.push({
      kind: 'validation_changed',
      claim: target.claim,
      namespace: target.namespace,
      profile_id: profileAfter,
      ...(profileBefore !== profileAfter ? { previous_profile_id: profileBefore } : {}),
      validation_change: !previous ? 'added' : !current ? 'removed' : 'changed',
      validation_effect:
        signature(previous?.critical) !== signature(current?.critical)
          ? 'may_reject'
          : 'validation_only',
    });
  }
  return changes.sort(
    (left, right) =>
      left.claim.localeCompare(right.claim) || left.namespace.localeCompare(right.namespace)
  );
}

/** A claim as it is released: its name, its namespace and its profile. */
export interface ReleasePoint {
  claim: string;
  namespace: string;
  profileId: string | null;
}

/** Where a change's claim is released before and after (null where it is not). */
export function releasePoints(change: ClaimChange): {
  before: ReleasePoint | null;
  after: ReleasePoint | null;
} {
  const after =
    change.kind === 'removed' || change.kind === 'profile_field_removed'
      ? null
      : { claim: change.claim, namespace: change.namespace, profileId: change.profile_id };
  const before =
    change.kind === 'added' || change.kind === 'profile_field_added'
      ? null
      : {
          claim: change.previous_claim ?? change.claim,
          namespace: change.previous_namespace ?? change.namespace,
          profileId:
            change.previous_profile_id !== undefined
              ? change.previous_profile_id
              : change.profile_id,
        };
  return { before, after };
}

/** The one profile a content's claims are released through, or null (none, or several). */
export function contentProfile(shapes: ReadonlyMap<string, ClaimShape>): string | null {
  const profiles = new Set([...shapes.values()].map((shape) => shape.profileId));
  const [only] = [...profiles];
  return profiles.size === 1 ? only : null;
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
      ? value.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const ref = item as Record<string, unknown>;
          return typeof ref.namespace === 'string' && typeof ref.path === 'string'
            ? [{ namespace: ref.namespace, path: ref.path }]
            : [];
        })
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
