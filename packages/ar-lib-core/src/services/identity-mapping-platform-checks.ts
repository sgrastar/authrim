/**
 * What a Mapping Set the platform owns may contain.
 *
 * A platform Mapping Set is shared by every tenant, so it can only use what every tenant has: the
 * standard canonical fields of the platform catalog. It cannot read a key that one tenant defines
 * (custom claims, custom fields, attributes), make a persistent identifier (the profile that holds
 * its secret belongs to a tenant), or release into a Destination Profile that a tenant owns.
 *
 * These functions only judge; each returns a message for the first violation, or null. The control
 * plane turns the message into its own error.
 */
import {
  catalogReferenceResolver,
  isTenantDefinedSubjectNamespace,
  mappingDestinationProfileIds,
  mappingReferenceCatalogEntryId,
  mappingReferencePath,
  mappingSourceSubjectPath,
  readsTenantDefinedSubjectPart,
  resolveSourceClassification,
  toMappingSourceReference,
  type ClassifyingCatalogEntry,
} from './identity-mapping-source-reads';

type Ref = Record<string, unknown>;

/** A rule of a version as the author wrote it (see FieldMappingVersionRuleInput). */
export interface PlatformCheckedRule {
  edges?: Array<{ sourceRef: Ref; targetRef: Ref }>;
  transforms?: Array<{ operation: string; parameters?: Record<string, unknown> }>;
  validationRules?: Array<{ targetRef: Ref }>;
  releaseRules?: Array<{ sourceRef: Ref }>;
  conflictRules?: Array<{ targetRef: Ref }>;
}

/** Operations that make a persistent identifier from a tenant's secret. */
const PERSISTENT_IDENTIFIER_OPERATIONS: ReadonlySet<string> = new Set([
  'oidc_pairwise_sub',
  'saml_edu_person_targeted_id',
]);

/**
 * The side of a reference that names none. The runtime resolver reads a missing `side` as
 * `source` (for an edge's reference, a validation rule's and every other), so a reference without
 * one is judged as a source here too, never as a destination that is let through.
 */
const RUNTIME_DEFAULT_SIDE: 'source' | 'destination' = 'source';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The names a reference can be read by: the runtime takes the claim name from path, else
 * fieldKey, else nodeId, so each spelling is judged.
 */
function refNames(ref: Ref): string[] {
  return [ref.path, ref.fieldKey, ref.nodeId].flatMap((name) => str(name) ?? []);
}

/**
 * Whether a reference names a part of the subject that a tenant defines. A source is judged by
 * where it reads from (the namespace and every spelling of the path); a destination, whose path
 * is a name of its own, by its namespace only.
 */
function refUsesTenantDefinedField(ref: Ref): boolean {
  const namespace = str(ref.namespace) ?? '';
  if ((str(ref.side) ?? RUNTIME_DEFAULT_SIDE) === 'destination') {
    return isTenantDefinedSubjectNamespace(namespace);
  }
  if (isTenantDefinedSubjectNamespace(namespace)) return true;
  const names = refNames(ref);
  return (names.length > 0 ? names : ['']).some((path) =>
    readsTenantDefinedSubjectPart({ namespace, path })
  );
}

function describeRef(ref: Ref): string {
  return `${str(ref.namespace) ?? 'unknown'}:${mappingReferencePath(ref) ?? 'unknown'}`;
}

function transformViolation(transform: {
  operation: string;
  parameters?: Record<string, unknown> | null;
}): string | null {
  if (
    PERSISTENT_IDENTIFIER_OPERATIONS.has(transform.operation) ||
    str(transform.parameters?.persistentIdentifierProfileId) !== null
  ) {
    return `platform mapping cannot make a persistent identifier (${transform.operation})`;
  }
  return null;
}

/**
 * The Destination Profiles a set of target references release into, as the runtime counts them
 * (`profileId` or `profile_id`, whatever the reference's spelling), or a violation. A platform
 * Mapping Set releases into exactly one, and a reference that names two (`profileId` and
 * `profile_id` that differ) is refused, since only one of them is what the runtime reads.
 */
export function platformDestinationProfileRefs(
  targetRefs: ReadonlyArray<Ref>
): { profileIds: string[] } | { violation: string } {
  for (const targetRef of targetRefs) {
    const first = str(targetRef.profileId);
    const second = str(targetRef.profile_id);
    if (first && second && first !== second) {
      return { violation: 'platform mapping reference names two different Destination Profiles' };
    }
  }
  const profileIds = mappingDestinationProfileIds(targetRefs);
  if (profileIds.length !== 1) {
    return {
      violation: 'platform mapping must release into exactly one OIDC Destination Profile',
    };
  }
  return { profileIds };
}

/**
 * The first thing in a version's rules that a platform Mapping Set may not hold, or null.
 * Checked when the version is saved.
 */
export function findPlatformMappingVersionViolation(
  rules: readonly PlatformCheckedRule[],
  sourceProfileIds?: readonly string[]
): string | null {
  if (sourceProfileIds && sourceProfileIds.length > 0) {
    return 'platform mapping cannot use a source profile';
  }
  for (const rule of rules) {
    for (const edge of rule.edges ?? []) {
      if (refUsesTenantDefinedField(edge.sourceRef)) {
        return `platform mapping cannot read a tenant-defined field: ${describeRef(edge.sourceRef)}`;
      }
      if (refUsesTenantDefinedField(edge.targetRef)) {
        return `platform mapping cannot use a tenant-defined field: ${describeRef(edge.targetRef)}`;
      }
    }
    for (const validationRule of rule.validationRules ?? []) {
      if (refUsesTenantDefinedField(validationRule.targetRef)) {
        return `platform mapping cannot validate a tenant-defined field: ${describeRef(validationRule.targetRef)}`;
      }
    }
    for (const releaseRule of rule.releaseRules ?? []) {
      if (refUsesTenantDefinedField(releaseRule.sourceRef)) {
        return `platform mapping cannot release a tenant-defined field: ${describeRef(releaseRule.sourceRef)}`;
      }
    }
    for (const conflictRule of rule.conflictRules ?? []) {
      if (refUsesTenantDefinedField(conflictRule.targetRef)) {
        return `platform mapping cannot resolve conflicts on a tenant-defined field: ${describeRef(conflictRule.targetRef)}`;
      }
    }
    for (const transform of rule.transforms ?? []) {
      const violation = transformViolation(transform);
      if (violation) return violation;
    }
  }
  return null;
}

/** A catalog entry as the compile check needs it. */
export interface PlatformCatalogEntry extends ClassifyingCatalogEntry {
  /** The target taxonomy: `canonical`, `destination-only`, or `custom`. */
  targetTaxonomy: string;
}

/** What is stored for a version, as far as the compile check reads it. */
export interface PlatformStoredMapping {
  edges: Array<{ sourceRef: Ref; targetRef: Ref }>;
  validationRules: Array<{ targetRef: Ref }>;
  transforms: Array<{ operation: string; parameters: Record<string, unknown> }>;
}

/**
 * The first thing in a stored version that the platform catalog it is compiled against does not
 * back, or null: every source (and every validation rule on a source) must be a field of the
 * catalog, a field that a tenant defines or the catalog marks `custom` is refused, and what the
 * save-time check refuses is refused again, since this is the last stop before activation.
 */
export function findPlatformMappingCompileViolation(
  mapping: PlatformStoredMapping,
  entries: readonly PlatformCatalogEntry[]
): string | null {
  const saveTime = findPlatformMappingVersionViolation([
    {
      edges: mapping.edges,
      validationRules: mapping.validationRules,
      transforms: mapping.transforms,
    },
  ]);
  if (saveTime) return saveTime;

  const customEntries = entries.filter((entry) => entry.targetTaxonomy === 'custom');
  const resolve = catalogReferenceResolver(entries);
  // A source reference is judged as the place it reads once resolved against the catalog (one that
  // names only its entry reads the entry's place); a destination (whose path is a name of its own)
  // only by the entry ID it names.
  const catalogSource = (ref: Ref) =>
    resolve(toMappingSourceReference(ref), { completePlace: true });
  const namesCustomEntry = (ref: Ref): boolean => {
    const entryId = mappingReferenceCatalogEntryId(ref) ?? null;
    const isSource = (str(ref.side) ?? RUNTIME_DEFAULT_SIDE) === 'source';
    const place = isSource ? catalogSource(ref) : null;
    return customEntries.some(
      (entry) =>
        (entryId !== null && entry.ids.includes(entryId)) ||
        (place !== null && mappingSourceSubjectPath(entry) === mappingSourceSubjectPath(place))
    );
  };

  for (const edge of mapping.edges) {
    if (resolveSourceClassification(entries, catalogSource(edge.sourceRef)) === null) {
      return `platform mapping source is not a field of the platform catalog: ${describeRef(edge.sourceRef)}`;
    }
    if (namesCustomEntry(edge.sourceRef)) {
      return `platform mapping cannot use a custom catalog field: ${describeRef(edge.sourceRef)}`;
    }
    if (namesCustomEntry(edge.targetRef)) {
      return `platform mapping cannot use a custom catalog field: ${describeRef(edge.targetRef)}`;
    }
  }
  for (const rule of mapping.validationRules) {
    const ref = rule.targetRef;
    if (
      (str(ref.side) ?? RUNTIME_DEFAULT_SIDE) === 'source' &&
      resolveSourceClassification(entries, catalogSource(ref)) === null
    ) {
      return `platform mapping validation target is not a field of the platform catalog: ${describeRef(ref)}`;
    }
    if (namesCustomEntry(ref)) {
      return `platform mapping cannot validate a custom catalog field: ${describeRef(ref)}`;
    }
  }
  return null;
}

/**
 * The activation scope a platform Mapping Set is written with. A platform activation applies to
 * every tenant, so its scope names no tenant (an activation scoped to the tenant `platform` would
 * match no calling tenant), and no app, protocol or entity either: only the empty scope is
 * written. The shapes a caller used for a tenant-wide activation (`{ kind: 'tenant' }`, with the
 * platform's own ID or none) are accepted and normalised; anything narrower is refused.
 */
export function normalizePlatformActivationScope(
  scope: unknown,
  platformTenantId: string
): { scope: Record<string, never> } | { violation: string } {
  if (scope === undefined || scope === null) return { scope: {} };
  if (typeof scope !== 'object' || Array.isArray(scope)) {
    return { violation: 'activationScope must be an object' };
  }
  for (const [key, value] of Object.entries(scope as Record<string, unknown>)) {
    const allowed =
      (key === 'kind' && value === 'tenant') || (key === 'id' && value === platformTenantId);
    if (!allowed) {
      return {
        violation: 'platform mapping activation cannot be scoped; leave activationScope empty',
      };
    }
  }
  return { scope: {} };
}
