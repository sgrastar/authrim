/**
 * What a mapping source reads, and how sensitive that is: the one definition the SAML attribute
 * release, the runtime release safety check and the control plane's activation check all use.
 *
 * A mapping edge names its source three ways (a namespace, a path, and a catalog entry id), and
 * they need not agree. Only the first two decide which value is read, so the classification of a
 * source is that of what it reads: the catalog is searched by the place the value is read from,
 * and the catalog entry id is a claim that has to be consistent with it, never what is trusted.
 */

/** The reference a mapping edge holds for a source (or a destination). */
export interface MappingSourceReference {
  namespace: string;
  path: string;
  catalogEntryId?: string;
}

/**
 * How a stored mapping reference is read. A reference is a JSON object whose spelling the author
 * chose, and the runtime resolver takes the first form it finds: the path is `path`, else
 * `fieldKey`, else `nodeId`; the catalog entry is `catalogEntryId`, else `catalog_entry_id`; the
 * Destination Profile is `profileId`, else `profile_id`. Everything that judges a reference (the
 * control plane when it saves, compiles and activates, and the resolver itself) reads it through
 * these, so none of them judges a form that the runtime then reads differently. A value counts when
 * it is a non-empty string, as for the runtime.
 */
function referenceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function mappingReferencePath(ref: Record<string, unknown>): string | undefined {
  return referenceString(ref.path) ?? referenceString(ref.fieldKey) ?? referenceString(ref.nodeId);
}

export function mappingReferenceCatalogEntryId(ref: Record<string, unknown>): string | undefined {
  return referenceString(ref.catalogEntryId) ?? referenceString(ref.catalog_entry_id);
}

export function mappingReferenceProfileId(ref: Record<string, unknown>): string | undefined {
  return referenceString(ref.profileId) ?? referenceString(ref.profile_id);
}

/** A stored source reference as the place it reads (an empty path when it names none). */
export function toMappingSourceReference(ref: Record<string, unknown>): MappingSourceReference {
  return {
    namespace: referenceString(ref.namespace) ?? '',
    path: mappingReferencePath(ref) ?? '',
    catalogEntryId: mappingReferenceCatalogEntryId(ref),
  };
}

/** A Destination Profile reference without the prefix some authors give it. */
export function normalizeDestinationProfileReference(profileId: string): string {
  return profileId.startsWith('destination-profile-')
    ? profileId.slice('destination-profile-'.length)
    : profileId;
}

/**
 * The Destination Profiles that stored target references release into, once each: what the
 * runtime resolver counts when it decides whether a mapping has exactly one.
 */
export function mappingDestinationProfileIds(
  targetRefs: ReadonlyArray<Record<string, unknown>>
): string[] {
  const profileIds = new Set<string>();
  for (const targetRef of targetRefs) {
    const profileId = mappingReferenceProfileId(targetRef);
    const side = referenceString(targetRef.side);
    if (profileId && (!side || side === 'destination')) {
      profileIds.add(normalizeDestinationProfileReference(profileId));
    }
  }
  return [...profileIds];
}

/**
 * The whole-path aliases of the subject's own keys (`sub` is the id), and the snake_case names of
 * its parts, as a path's first segment may spell them. Maps, not objects: a key such as
 * `constructor` (which a custom field may be named) must not find a member of Object.prototype.
 */
const SUBJECT_KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ['sub', 'id'],
  ['user_id', 'id'],
]);
const SUBJECT_ROOT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['custom_claims', 'customClaims'],
  ['custom_fields', 'customFields'],
]);

/**
 * The one spelling of a key path into the subject being released: `sub` and `user_id` are `id`,
 * and a path into a part names the part as the subject does (`custom_claims.x` is
 * `customClaims.x`). Everything that reads a value (the attribute release), classifies one, or
 * compares two reads goes through this, so no two spellings of one place are taken for two.
 */
export function normalizeSubjectReadPath(path: string): string {
  const aliased = SUBJECT_KEY_ALIASES.get(path) ?? path;
  const separator = aliased.indexOf('.');
  if (separator < 0) return aliased;
  const root = aliased.slice(0, separator);
  return `${SUBJECT_ROOT_ALIASES.get(root) ?? root}${aliased.slice(separator)}`;
}

/**
 * Where a source's value is read from in the subject being released (the key a namespace and a
 * path stand for), as a normalized key path: the namespaces of the subject's own parts keep that
 * part in the key, the others (the profile, the standard claims, the runtime's) name a top-level
 * key.
 */
export function mappingSourceSubjectPath(
  ref: Pick<MappingSourceReference, 'namespace' | 'path'>
): string {
  return normalizeSubjectReadPath(namespacedSubjectPath(ref));
}

function namespacedSubjectPath(ref: Pick<MappingSourceReference, 'namespace' | 'path'>): string {
  switch (ref.namespace) {
    case 'authrim.claims':
    case 'claims':
      return `claims.${ref.path}`;
    case 'authrim.custom_claims':
    case 'custom_claims':
      return `customClaims.${ref.path}`;
    case 'authrim.custom_fields':
    case 'custom_fields':
      return `customFields.${ref.path}`;
    case 'authrim.attributes':
    case 'attributes':
      return `attributes.${ref.path}`;
    case 'authrim.system':
      return ref.path === 'uid' ? 'id' : ref.path;
    default:
      // authrim.profile, authrim.claim, oidc.claim, the catalog's own namespace, and any other.
      return ref.path;
  }
}

/**
 * The parts of the subject that a tenant defines the keys of (custom claims, custom fields and
 * attributes). A Mapping Set the platform owns is shared by every tenant, so it cannot name a key
 * that only one tenant defines.
 */
const TENANT_DEFINED_SUBJECT_ROOTS: ReadonlySet<string> = new Set([
  'customClaims',
  'customFields',
  'attributes',
]);

/**
 * Whether a reference reads (as a source) one of the subject's tenant-defined parts, by whatever
 * spelling: a namespace of that part (`authrim.custom_claims`, `custom_fields`, ...) or a path
 * that starts with it (`custom_claims.x`). Decided by where the value is read from
 * (mappingSourceSubjectPath), so it cannot drift from what the attribute release reads.
 */
export function readsTenantDefinedSubjectPart(
  ref: Pick<MappingSourceReference, 'namespace' | 'path'>
): boolean {
  const readsFrom = mappingSourceSubjectPath(ref);
  const separator = readsFrom.indexOf('.');
  return TENANT_DEFINED_SUBJECT_ROOTS.has(
    separator < 0 ? readsFrom : readsFrom.slice(0, separator)
  );
}

/**
 * Whether a namespace alone is one of the subject's tenant-defined parts. Used for a reference
 * that is not read as a source (a destination), whose path is a name of the destination's own
 * and so says nothing about the subject.
 */
export function isTenantDefinedSubjectNamespace(namespace: string): boolean {
  const readsFrom = mappingSourceSubjectPath({ namespace, path: 'x' });
  return (
    readsFrom.startsWith('customClaims.') ||
    readsFrom.startsWith('customFields.') ||
    readsFrom.startsWith('attributes.')
  );
}

/**
 * Sources the runtime owns, not defined by any catalog: what they read and how sensitive it is.
 */
export const BUILT_IN_SYSTEM_IDENTITY_SOURCES: ReadonlyArray<{
  catalogEntryId: string;
  namespace: string;
  path: string;
  classification: string;
}> = [
  {
    catalogEntryId: 'system.identity.account_uuid',
    namespace: 'authrim.profile',
    path: 'account_id',
    classification: 'internal',
  },
  {
    catalogEntryId: 'system.identity.lifecycle_state',
    namespace: 'authrim.profile',
    path: 'lifecycle_state',
    classification: 'internal',
  },
  {
    catalogEntryId: 'system.identity.created_at',
    namespace: 'authrim.profile',
    path: 'created_at',
    classification: 'internal',
  },
  {
    catalogEntryId: 'system.identity.updated_at',
    namespace: 'authrim.profile',
    path: 'updated_at',
    classification: 'internal',
  },
  {
    catalogEntryId: 'system.identity.assurance_ial',
    namespace: 'authrim.profile',
    path: 'assurance_ial',
    classification: 'internal',
  },
  {
    catalogEntryId: 'system.identity.edu_person_assurance',
    namespace: 'authrim.profile',
    path: 'edu_person_assurance',
    classification: 'internal',
  },
];

/**
 * How sensitive a source or destination classification is, for deciding whether a mapping may
 * release a field to a destination: a destination must be at least as sensitive as its source.
 * key_material is the most sensitive; an unknown classification counts as the least.
 */
export function sensitiveClassificationRank(classification: string): number {
  if (classification === 'key_material') return 3;
  if (['regulated', 'secret', 'credential', 'token'].includes(classification)) return 2;
  if (classification === 'pii') return 1;
  return 0;
}

/** A catalog entry, as far as classifying a source needs it. */
export interface ClassifyingCatalogEntry {
  /** The ids a mapping edge may name the entry by. */
  ids: readonly string[];
  namespace: string;
  path: string;
  classification: string;
  /** destination-only entries describe what is released, not what is read. */
  targetType?: string;
}

/**
 * The classification of what a source reads, or null when it cannot be told.
 *
 * - A source the runtime defines (system.identity.*) must read the place that definition names.
 * - Otherwise the catalog is searched by the place the source reads from: every entry that
 *   describes that place counts, and the most sensitive classification among them is the
 *   source's. Entries that describe what is released (destination-only) are not sources.
 * - A catalog entry id the source names must be an entry of the catalog that describes the same
 *   place; an id that is unknown or describes another place makes the source unknown.
 */
export function resolveSourceClassification(
  entries: readonly ClassifyingCatalogEntry[],
  ref: MappingSourceReference
): string | null {
  const readsFrom = mappingSourceSubjectPath(ref);
  const builtIn = BUILT_IN_SYSTEM_IDENTITY_SOURCES.find(
    (source) => mappingSourceSubjectPath(source) === readsFrom && source.namespace === ref.namespace
  );
  if (ref.catalogEntryId?.startsWith('system.identity.')) {
    return builtIn && builtIn.catalogEntryId === ref.catalogEntryId ? builtIn.classification : null;
  }
  if (builtIn && !ref.catalogEntryId) return builtIn.classification;

  const isSource = (entry: ClassifyingCatalogEntry) => entry.targetType !== 'destination-only';
  if (ref.catalogEntryId) {
    const named = entries.filter((entry) => entry.ids.includes(ref.catalogEntryId as string));
    if (named.length === 0 || !named.every(isSource)) return null;
    if (named.some((entry) => mappingSourceSubjectPath(entry) !== readsFrom)) return null;
  }
  let strictest: string | null = null;
  for (const entry of entries) {
    if (!isSource(entry) || mappingSourceSubjectPath(entry) !== readsFrom) continue;
    if (
      strictest === null ||
      sensitiveClassificationRank(entry.classification) > sensitiveClassificationRank(strictest)
    ) {
      strictest = entry.classification;
    }
  }
  return strictest;
}

/**
 * The catalog entry ids that more than one place is read under: an id is an alias for one
 * entry, so two edges naming the same id for different reads would be taken for one source (its
 * value is matched by id), and the value read for one released as the other's.
 */
export function findConflictingSourceIds(refs: readonly MappingSourceReference[]): string[] {
  const readsById = new Map<string, string>();
  const conflicting = new Set<string>();
  for (const ref of refs) {
    if (!ref.catalogEntryId) continue;
    const readsFrom = mappingSourceSubjectPath(ref);
    const existing = readsById.get(ref.catalogEntryId);
    if (existing === undefined) readsById.set(ref.catalogEntryId, readsFrom);
    else if (existing !== readsFrom) conflicting.add(ref.catalogEntryId);
  }
  return [...conflicting];
}
