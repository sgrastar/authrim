import type {
  Cardinality,
  FieldCatalogBundle,
  FieldRef,
  FieldMappingSet,
  MappingRuleEdge,
  MappingTransformStep,
  RedactionClassification,
  TargetType,
  TransformOperation,
  ValidationRule,
  ValidationRuleKind,
} from '@authrim/ar-lib-field-mapping/contract';
import type { DatabaseAdapter } from '../db/adapter';
import {
  PLATFORM_MAPPING_TENANT_ID,
  RuntimeIdentityMappingOwnerError,
} from './identity-mapping-owner';
import {
  catalogReferenceResolver,
  findConflictingSourceIds,
  mappingDestinationProfileIds,
  mappingReferenceCatalogEntryId,
  mappingReferencePath,
  normalizeDestinationProfileReference,
  resolveSourceClassification,
  sensitiveClassificationRank,
} from './identity-mapping-source-reads';

export type RuntimeIdentityMappingProtocol = 'saml' | 'oidc' | 'vc' | string;
export type RuntimeIdentityMappingRole = 'idp' | 'sp' | 'op' | 'rp' | string;

export interface RuntimeIdentityMappingResolutionContext {
  /** The tenant the call is made for. Activation scopes are matched against it. */
  tenantId: string;
  /**
   * The tenant ID that owns the Mapping Set and every row under it, when that is not the calling
   * tenant: only `PLATFORM_MAPPING_TENANT_ID` is accepted, and only together with
   * `fieldMappingSetId` (the platform's sets are read when one is named, and never searched for).
   * Unset, the calling tenant owns them.
   */
  ownerTenantId?: string;
  protocol: RuntimeIdentityMappingProtocol;
  role: RuntimeIdentityMappingRole;
  fieldMappingSetId?: string;
  fieldMappingVersionId?: string;
  localEntityId?: string;
  partnerEntityId?: string;
  clientId?: string;
  providerId?: string;
  credentialProfileId?: string;
  credentialConfigurationId?: string;
  direction?: 'issuance' | 'verification' | string;
  destinationProfileId?: string;
  /**
   * Give a snapshot compiled against the tenant's canonical fields (a catalog version derived on
   * the fly, with nothing stored under it) the stored default canonical catalog's entries, so the
   * classification of its sources can be told. Off, such a catalog stays empty, as it always was
   * for the callers that do not judge sources by it.
   */
  resolveCanonicalCatalog?: boolean;
  /**
   * Resolve the mapping's references against the catalog the way a Mapping Set the platform owns
   * is judged (see `catalogReferenceResolver`): an entry's row ID is brought to the stable ID the
   * runtime catalog carries, and a source that names no place reads the place of its entry. Off,
   * every reference is returned
   * as stored, as for every caller before it; the read of a Mapping Set the platform owns for OIDC
   * turns it on.
   */
  normalizeCatalogEntryIds?: boolean;
}

export interface RuntimeIdentityMappingBinding {
  id: string;
  /** The tenant ID that owns the activation (the calling tenant unless `ownerTenantId` was given). */
  tenantId: string;
  fieldMappingSetId: string;
  fieldMappingVersionId: string;
  mappingSnapshotHash: string;
  catalog: FieldCatalogBundle;
  edges: MappingRuleEdge[];
  transforms: MappingTransformStep[];
  validationRules: ValidationRule[];
  fieldMappingSet: FieldMappingSet;
  activationScope: Record<string, unknown>;
  destinationNamespace?: string;
  sourceProfileId?: string;
  destinationProfileId?: string;
  destinationProfileIds: string[];
}

export interface RuntimeDestinationReleaseField {
  key: string;
  classification: string;
  requiredScopes: string[];
}

/** Why a mapping may not release a field (named in audit events and logs; never carries a value). */
export type RuntimeIdentityMappingReleaseSafetyReason =
  | 'classification_lowered'
  | 'scope_required'
  | 'source_classification_unknown'
  | 'edge_reference_invalid'
  | 'source_reference_conflict';

export class RuntimeIdentityMappingReleaseSafetyError extends Error {
  constructor(
    message: string,
    readonly field: string,
    readonly reason: RuntimeIdentityMappingReleaseSafetyReason = 'classification_lowered'
  ) {
    super(message);
    this.name = 'RuntimeIdentityMappingReleaseSafetyError';
  }
}

export interface RuntimeIdentityMappingReleaseSafetyOptions {
  /**
   * Refuse a field whose source classification cannot be told (a source the catalog does not
   * describe and the runtime does not define), instead of letting it through unchecked.
   */
  requireKnownSources?: boolean;
}

export function assertRuntimeIdentityMappingReleaseSafety(
  binding: Pick<RuntimeIdentityMappingBinding, 'catalog' | 'edges'>,
  destinationFields: RuntimeDestinationReleaseField[],
  requireSensitiveScopes: boolean,
  options: RuntimeIdentityMappingReleaseSafetyOptions = {}
): void {
  const destinationByKey = new Map(destinationFields.map((field) => [field.key, field]));
  if (options.requireKnownSources) {
    assertKnownSourcesReleaseSafety(binding, destinationByKey, requireSensitiveScopes);
    return;
  }
  for (const edge of binding.edges) {
    if (edge.sourceRef.side !== 'source' || edge.targetRef.side !== 'destination') continue;
    const destination = destinationByKey.get(edge.targetRef.path);
    const source = findCatalogEntry(binding.catalog, edge.sourceRef);
    if (!source || !destination) continue;
    assertReleaseAllowed(
      source.classification,
      destination,
      edge.targetRef.path,
      requireSensitiveScopes
    );
  }
}

/**
 * The strict check: every edge is judged by what it reads, whether or not its destination is a
 * field of the profile (a value made for an edge can be matched to another edge, so an edge that
 * is not itself released is not exempt).
 * - An edge's sides must be what they are called: a source reference that says it is a
 *   destination (or the reverse) is not skipped, it is refused.
 * - The classification of a source is that of the place it reads (resolveSourceClassification);
 *   when that cannot be told, or the entry id it names is another place's, the edge is refused.
 * - One catalog entry id for two different reads is refused.
 */
function assertKnownSourcesReleaseSafety(
  binding: Pick<RuntimeIdentityMappingBinding, 'catalog' | 'edges'>,
  destinationByKey: Map<string, RuntimeDestinationReleaseField>,
  requireSensitiveScopes: boolean
): void {
  for (const edge of binding.edges) {
    if (edge.sourceRef.side !== 'source' || edge.targetRef.side !== 'destination') {
      throw new RuntimeIdentityMappingReleaseSafetyError(
        `Identity mapping edge references are not a source and a destination for ${edge.targetRef.path}`,
        edge.targetRef.path,
        'edge_reference_invalid'
      );
    }
  }
  const [conflict] = findConflictingSourceIds(binding.edges.map((edge) => edge.sourceRef));
  if (conflict) {
    throw new RuntimeIdentityMappingReleaseSafetyError(
      `Identity mapping names one catalog entry for different reads: ${conflict}`,
      conflict,
      'source_reference_conflict'
    );
  }
  const entries = binding.catalog.entries.map((entry) => ({
    ids: [entry.id],
    namespace: entry.namespace,
    path: entry.path,
    classification: entry.classification,
    targetType: entry.targetType,
  }));
  for (const edge of binding.edges) {
    const classification = resolveSourceClassification(entries, edge.sourceRef);
    if (classification === null) {
      throw new RuntimeIdentityMappingReleaseSafetyError(
        `Identity mapping source classification is unknown for ${edge.targetRef.path}`,
        edge.targetRef.path,
        'source_classification_unknown'
      );
    }
    const destination = destinationByKey.get(edge.targetRef.path);
    if (destination) {
      assertReleaseAllowed(
        classification,
        destination,
        edge.targetRef.path,
        requireSensitiveScopes
      );
    }
  }
}

function assertReleaseAllowed(
  sourceClassification: string,
  destination: RuntimeDestinationReleaseField,
  field: string,
  requireSensitiveScopes: boolean
): void {
  const sourceSensitivity = sensitiveClassificationRank(sourceClassification);
  if (sourceSensitivity === 0) return;
  if (sensitiveClassificationRank(destination.classification) < sourceSensitivity) {
    throw new RuntimeIdentityMappingReleaseSafetyError(
      `Identity mapping cannot lower sensitive classification for ${field}`,
      field,
      'classification_lowered'
    );
  }
  if (requireSensitiveScopes && destination.requiredScopes.length === 0) {
    throw new RuntimeIdentityMappingReleaseSafetyError(
      `Sensitive destination field must require at least one scope: ${field}`,
      field,
      'scope_required'
    );
  }
}

interface ActiveActivationRow {
  activation_id: string;
  tenant_id: string;
  field_mapping_set_id: string;
  field_mapping_version_id: string;
  activation_scope_json: string;
  version_label: string;
  field_mapping_hash: string;
  field_mapping_compatibility_range: string | null;
  catalog_version_id: string | null;
  catalog_version_label: string | null;
  catalog_bundle_hash: string | null;
  catalog_compatibility_range: string | null;
  snapshot_hash: string;
}

interface CatalogEntryRow {
  id: string;
  stable_field_id: string;
  namespace: string;
  path: string;
  target_taxonomy: string;
  value_type: string;
  cardinality: string;
  classification: string;
  aliases_json: string | null;
  validation_json: string | null;
}

interface EdgeRow {
  id: string;
  source_ref_json: string;
  target_ref_json: string;
  edge_kind: string | null;
  display_order: number;
}

interface TransformRow {
  id: string;
  edge_id: string | null;
  step_order: number;
  operation: string;
  parameters_json: string | null;
  target_ref_json: string | null;
}

interface ValidationRuleRow {
  id: string;
  target_ref_json: string;
  validation_kind: string;
  severity: string;
  parameters_json: string | null;
}

interface FieldMappingRuleRow {
  id: string;
  action: string;
  priority: number;
  scope_json: string | null;
  metadata_json: string | null;
}

/**
 * The tenant ID whose rows the call reads. Another owner than the calling tenant is the
 * platform's, and only for a Mapping Set the call names: an activation search over the platform's
 * rows would hand every tenant a platform activation it never chose.
 */
function resolveOwnerTenantId(context: RuntimeIdentityMappingResolutionContext): string {
  if (context.ownerTenantId === undefined) return context.tenantId;
  if (
    context.ownerTenantId !== context.tenantId &&
    context.ownerTenantId !== PLATFORM_MAPPING_TENANT_ID
  ) {
    throw new RuntimeIdentityMappingOwnerError(
      'Identity mapping owner must be the calling tenant or the platform'
    );
  }
  if (!context.fieldMappingSetId) {
    throw new RuntimeIdentityMappingOwnerError(
      'Identity mapping owner can only be set together with a Mapping Set ID'
    );
  }
  return context.ownerTenantId;
}

export async function resolveRuntimeIdentityMappingBinding(
  adapter: DatabaseAdapter,
  context: RuntimeIdentityMappingResolutionContext
): Promise<RuntimeIdentityMappingBinding | null> {
  const ownerTenantId = resolveOwnerTenantId(context);
  const activeRows = await loadActiveActivationRows(adapter, ownerTenantId, context);
  const rankedRows = rankActivations(activeRows, context);
  let selected: ActiveActivationRow | undefined = rankedRows[0];
  let selectedEdges: EdgeRow[] | undefined;
  if (context.destinationProfileId) {
    selected = undefined;
    for (const candidate of rankedRows) {
      const edges = await loadEdges(adapter, ownerTenantId, candidate.field_mapping_version_id);
      if (
        uniqueDestinationProfileIds(edges).some((profileId) =>
          destinationProfileReferencesMatch(profileId, context.destinationProfileId as string)
        )
      ) {
        selected = candidate;
        selectedEdges = edges;
        break;
      }
    }
  }
  if (!selected || !selected.catalog_version_id) {
    return null;
  }

  const [catalogEntries, edges, transforms, validationRules, fieldMappingRules] = await Promise.all(
    [
      loadCatalogEntries(
        adapter,
        ownerTenantId,
        selected.catalog_version_id,
        context.resolveCanonicalCatalog === true
      ),
      selectedEdges ?? loadEdges(adapter, ownerTenantId, selected.field_mapping_version_id),
      loadTransforms(adapter, ownerTenantId, selected.field_mapping_version_id),
      loadValidationRules(adapter, ownerTenantId, selected.field_mapping_version_id),
      loadFieldMappingRules(adapter, ownerTenantId, selected.field_mapping_version_id),
    ]
  );
  const resolveCatalogReference = catalogReferenceResolver(
    catalogEntries.map((entry) => ({
      ids: [entry.id, entry.stable_field_id || entry.id],
      namespace: entry.namespace,
      path: entry.path,
      classification: entry.classification,
      targetType: normalizeTargetType(entry.target_taxonomy),
    }))
  );
  // Only a set the platform owns is read this way (see `normalizeCatalogEntryIds`); the place of a
  // source that names none is taken from its catalog entry. A destination's path is its own name.
  const withCatalogReference = (ref: FieldRef): FieldRef =>
    context.normalizeCatalogEntryIds && ref.catalogEntryId
      ? {
          ...ref,
          ...resolveCatalogReference(
            { namespace: ref.namespace, path: ref.path, catalogEntryId: ref.catalogEntryId },
            { completePlace: ref.side === 'source' }
          ),
        }
      : ref;
  const activationScope = parseJsonObject(selected.activation_scope_json);
  const destinationProfileIds = runtimeDestinationProfileIds(
    edges.map((edge) => parseJsonObject(edge.target_ref_json)),
    activationScope
  );
  const scopedDestinationProfileId = readString(activationScope.destinationProfileId);

  return {
    id: selected.activation_id,
    tenantId: selected.tenant_id,
    fieldMappingSetId: selected.field_mapping_set_id,
    fieldMappingVersionId: selected.field_mapping_version_id,
    mappingSnapshotHash: selected.snapshot_hash,
    catalog: {
      identity: {
        id: selected.catalog_version_id,
        version: selected.catalog_version_label ?? selected.field_mapping_version_id,
        contentHash: selected.catalog_bundle_hash ?? selected.field_mapping_hash,
        compatibilityRange:
          selected.catalog_compatibility_range ??
          selected.field_mapping_compatibility_range ??
          '^0.3.0',
      },
      entries: catalogEntries.map(toCatalogEntry),
    },
    edges: toRuntimeEdges(edges).map((edge) => ({
      ...edge,
      sourceRef: withCatalogReference(edge.sourceRef),
      targetRef: withCatalogReference(edge.targetRef),
    })),
    transforms: toRuntimeTransforms(transforms, edges).map((transform) => ({
      ...transform,
      outputTargetRef: withCatalogReference(transform.outputTargetRef),
    })),
    validationRules: validationRules.map((rule) => ({
      id: rule.id,
      kind: rule.validation_kind as ValidationRuleKind,
      targetRef: withCatalogReference(parseFieldRef(rule.target_ref_json)),
      defaultSeverity: rule.severity as ValidationRule['defaultSeverity'],
      parameters: parseJsonObject(rule.parameters_json ?? '{}'),
    })),
    fieldMappingSet: {
      id: selected.field_mapping_version_id,
      rules: fieldMappingRules.map((rule) => ({
        id: rule.id,
        scope: toFieldMappingScope(rule.scope_json, activationScope),
        action: toFieldMappingAction(rule.action),
        priority: rule.priority,
        targetRef: parseFieldMappingTargetRef(rule.metadata_json),
      })),
    },
    activationScope,
    destinationNamespace: readString(activationScope.destinationNamespace),
    sourceProfileId: readString(activationScope.sourceProfileId),
    destinationProfileId: context.destinationProfileId
      ? destinationProfileIds.some((profileId) =>
          destinationProfileReferencesMatch(profileId, context.destinationProfileId as string)
        )
        ? context.destinationProfileId
        : scopedDestinationProfileId
      : destinationProfileIds.length === 1
        ? destinationProfileIds[0]
        : scopedDestinationProfileId,
    destinationProfileIds,
  };
}

/**
 * The Destination Profiles a mapping releases into, as the runtime counts them: the ones its
 * edges name (once each, without the prefix some authors give), and the one the activation's
 * scope names (`destinationProfileId`) when that is not already among them, compared as it was
 * written. A caller that needs exactly one counts this set, so a scope that names another profile
 * than the edges is two.
 */
export function runtimeDestinationProfileIds(
  targetRefs: ReadonlyArray<Record<string, unknown>>,
  activationScope: Record<string, unknown>
): string[] {
  const ids = mappingDestinationProfileIds(targetRefs);
  const scoped = readString(activationScope.destinationProfileId);
  if (scoped && !ids.includes(scoped)) ids.unshift(scoped);
  return ids;
}

function uniqueDestinationProfileIds(edges: EdgeRow[]): string[] {
  return mappingDestinationProfileIds(edges.map((edge) => parseJsonObject(edge.target_ref_json)));
}

async function loadActiveActivationRows(
  adapter: DatabaseAdapter,
  ownerTenantId: string,
  context: RuntimeIdentityMappingResolutionContext
): Promise<ActiveActivationRow[]> {
  const params: unknown[] = [ownerTenantId, 'active'];
  const fieldMappingSetFilter = context.fieldMappingSetId ? 'AND a.field_mapping_set_id = ?' : '';
  if (context.fieldMappingSetId) {
    params.push(context.fieldMappingSetId);
  }
  const fieldMappingVersionFilter = context.fieldMappingVersionId
    ? 'AND a.field_mapping_version_id = ?'
    : '';
  if (context.fieldMappingVersionId) {
    params.push(context.fieldMappingVersionId);
  }
  return adapter.query<ActiveActivationRow>(
    `SELECT a.id AS activation_id,
            a.tenant_id,
            a.field_mapping_set_id,
            a.field_mapping_version_id,
            a.activation_scope_json,
            v.version_label,
            v.field_mapping_hash,
            v.compatibility_range AS field_mapping_compatibility_range,
            s.catalog_version_id,
            s.snapshot_hash,
            cv.version_label AS catalog_version_label,
            cv.bundle_hash AS catalog_bundle_hash,
            cv.compatibility_range AS catalog_compatibility_range
       FROM field_mapping_activations a
       JOIN field_mapping_versions v
         ON v.tenant_id = a.tenant_id
        AND v.field_mapping_set_id = a.field_mapping_set_id
        AND v.id = a.field_mapping_version_id
       LEFT JOIN compiled_mapping_snapshots s
         ON s.tenant_id = a.tenant_id
        AND s.field_mapping_version_id = a.field_mapping_version_id
        AND s.lifecycle_state = 'active'
       LEFT JOIN field_catalog_versions cv
         ON cv.tenant_id = a.tenant_id
        AND cv.id = s.catalog_version_id
      WHERE a.tenant_id = ?
        AND a.lifecycle_state = ?
        ${fieldMappingSetFilter}
        ${fieldMappingVersionFilter}
      ORDER BY a.activated_at DESC, a.created_at DESC`,
    params
  );
}

function rankActivations(
  rows: ActiveActivationRow[],
  context: RuntimeIdentityMappingResolutionContext
): ActiveActivationRow[] {
  return rows
    .map((row) => ({
      row,
      score: activationScore(parseJsonObject(row.activation_scope_json), context),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score)
    .map((candidate) => candidate.row);
}

function destinationProfileReferencesMatch(left: string, right: string): boolean {
  return normalizeDestinationProfileReference(left) === normalizeDestinationProfileReference(right);
}

/**
 * Whether an activation with this scope applies to a call in this context: the rule `rankActivations`
 * ranks by, shared so that what judges a scope before it is saved is what the runtime will do.
 */
export function activationScopeApplies(
  scope: Record<string, unknown>,
  context: RuntimeIdentityMappingResolutionContext
): boolean {
  return activationScore(scope, context) >= 0;
}

function activationScore(
  scope: Record<string, unknown>,
  context: RuntimeIdentityMappingResolutionContext
): number {
  let score = 0;
  const checks: Array<[string | undefined, string | undefined, number]> = [
    [readString(scope.tenantId) ?? readString(scope.id), context.tenantId, 1],
    [readString(scope.protocol), context.protocol, 2],
    [readString(scope.role), context.role, 4],
    [
      readString(scope.localEntityId) ?? readString(scope.local_entity_id),
      context.localEntityId,
      8,
    ],
    [
      readString(scope.partnerEntityId) ??
        readString(scope.partner_entity_id) ??
        readString(scope.spEntityId) ??
        readString(scope.rpClientId),
      context.partnerEntityId ?? context.clientId,
      16,
    ],
    [readString(scope.clientId) ?? readString(scope.client_id), context.clientId, 16],
    [readString(scope.providerId) ?? readString(scope.provider_id), context.providerId, 16],
    [
      readString(scope.credentialProfileId) ?? readString(scope.credential_profile_id),
      context.credentialProfileId,
      32,
    ],
    [
      readString(scope.credentialConfigurationId) ?? readString(scope.credential_configuration_id),
      context.credentialConfigurationId,
      64,
    ],
    [readString(scope.direction), context.direction, 128],
  ];

  for (const [scopeValue, contextValue, weight] of checks) {
    if (!scopeValue) {
      continue;
    }
    if (scopeValue !== contextValue) {
      return -1;
    }
    score += weight;
  }

  return score;
}

/** The catalog id a snapshot of the tenant's canonical fields is compiled against (control plane). */
const DEFAULT_CANONICAL_CATALOG_ID = 'system_default_canonical_catalog';
const VIRTUAL_CANONICAL_CATALOG_VERSION = /^system_default_canonical_catalog_schema_v\d+$/;

/** Whether a catalog version is the tenant-fields catalog the control plane derives on the fly. */
export function isVirtualCanonicalCatalogVersion(catalogVersionId: string): boolean {
  return VIRTUAL_CANONICAL_CATALOG_VERSION.test(catalogVersionId);
}

async function loadCatalogEntries(
  adapter: DatabaseAdapter,
  tenantId: string,
  catalogVersionId: string,
  resolveCanonicalCatalog: boolean
): Promise<CatalogEntryRow[]> {
  const rows = await adapter.query<CatalogEntryRow>(
    `SELECT *
       FROM field_catalog_entries
      WHERE tenant_id = ? AND catalog_version_id = ?
      ORDER BY namespace ASC, path ASC`,
    [tenantId, catalogVersionId]
  );
  if (
    rows.length > 0 ||
    !resolveCanonicalCatalog ||
    !isVirtualCanonicalCatalogVersion(catalogVersionId)
  ) {
    return rows;
  }
  // A snapshot compiled against the tenant's canonical fields names a version the control plane
  // derives on the fly: nothing is stored under it. The fields it stands for are the stored
  // default canonical catalog's (the tenant's own fields are added by the caller that can read
  // them).
  return adapter.query<CatalogEntryRow>(
    `SELECT e.*
       FROM field_catalog_entries e
      WHERE e.tenant_id = ?
        AND e.catalog_version_id = (
          SELECT v.id
            FROM field_catalog_versions v
           WHERE v.tenant_id = ?
             AND v.catalog_id = ?
             AND v.lifecycle_state = 'active'
           ORDER BY v.created_at DESC, v.id DESC
           LIMIT 1
        )
      ORDER BY e.namespace ASC, e.path ASC`,
    [tenantId, tenantId, DEFAULT_CANONICAL_CATALOG_ID]
  );
}

interface CustomClaimSchemaRow {
  id: string;
  field_key: string;
  active_field_key: string | null;
  field_type: string | null;
  cardinality: string | null;
  is_pii: number | boolean | null;
}

/**
 * The tenant's own fields as canonical catalog entries (what the control plane compiles a
 * snapshot's virtual canonical catalog from): `field.canonical.<key>`, personal data when the
 * field is marked PII. `adapter` is the core database, where the field schemas live.
 */
export async function loadCustomClaimSchemaCatalogEntries(
  adapter: DatabaseAdapter,
  tenantId: string
): Promise<FieldCatalogBundle['entries']> {
  const rows = await adapter.query<CustomClaimSchemaRow>(
    `SELECT id, field_key, active_field_key, field_type, cardinality, is_pii
       FROM custom_claim_schemas
      WHERE tenant_id = ?
        AND is_active = TRUE
        AND operation_status = 'active'`,
    [tenantId]
  );
  return rows.flatMap((row) => {
    const key = (row.active_field_key ?? row.field_key)?.trim();
    if (!key) return [];
    return [
      {
        id: `field.canonical.${key}`,
        namespace: 'authrim.canonical',
        path: key,
        valueType:
          row.field_type === 'boolean' || row.field_type === 'number' || row.field_type === 'json'
            ? row.field_type
            : 'string',
        cardinality: normalizeCardinality(row.cardinality ?? 'single'),
        classification: row.is_pii === true || row.is_pii === 1 ? 'pii' : 'internal',
        targetType: 'canonical' as const,
      },
    ];
  });
}

/**
 * `entries` plus the entries the tenant's own fields add: an entry already there keeps the more
 * sensitive of the two classifications, so merging can only make a release stricter.
 */
export function mergeCanonicalCatalogEntries(
  entries: FieldCatalogBundle['entries'],
  additions: FieldCatalogBundle['entries']
): FieldCatalogBundle['entries'] {
  const merged = [...entries];
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]));
  for (const addition of additions) {
    const index = indexById.get(addition.id);
    if (index === undefined) {
      indexById.set(addition.id, merged.length);
      merged.push(addition);
    } else if (
      sensitiveClassificationRank(addition.classification) >
      sensitiveClassificationRank(merged[index].classification)
    ) {
      merged[index] = { ...merged[index], classification: addition.classification };
    }
  }
  return merged;
}

async function loadEdges(
  adapter: DatabaseAdapter,
  tenantId: string,
  fieldMappingVersionId: string
): Promise<EdgeRow[]> {
  return adapter.query<EdgeRow>(
    `SELECT e.id, e.source_ref_json, e.target_ref_json, e.edge_kind, e.display_order
       FROM mapping_rules r
       JOIN mapping_rule_edges e
         ON e.tenant_id = r.tenant_id
        AND e.rule_id = r.id
      WHERE r.tenant_id = ? AND r.field_mapping_version_id = ?
      ORDER BY r.priority ASC, r.created_at ASC, e.display_order ASC`,
    [tenantId, fieldMappingVersionId]
  );
}

async function loadTransforms(
  adapter: DatabaseAdapter,
  tenantId: string,
  fieldMappingVersionId: string
): Promise<TransformRow[]> {
  return adapter.query<TransformRow>(
    `SELECT t.id, t.edge_id, t.step_order, t.operation, t.parameters_json, e.target_ref_json
       FROM mapping_rules r
       JOIN mapping_transform_steps t
         ON t.tenant_id = r.tenant_id
        AND t.rule_id = r.id
       LEFT JOIN mapping_rule_edges e
         ON e.tenant_id = t.tenant_id
        AND e.id = t.edge_id
      WHERE r.tenant_id = ? AND r.field_mapping_version_id = ?
      ORDER BY r.priority ASC, t.step_order ASC`,
    [tenantId, fieldMappingVersionId]
  );
}

async function loadValidationRules(
  adapter: DatabaseAdapter,
  tenantId: string,
  fieldMappingVersionId: string
): Promise<ValidationRuleRow[]> {
  return adapter.query<ValidationRuleRow>(
    `SELECT v.id, v.target_ref_json, v.validation_kind, v.severity, v.parameters_json
       FROM mapping_rules r
       JOIN mapping_validation_rules v
         ON v.tenant_id = r.tenant_id
        AND v.rule_id = r.id
      WHERE r.tenant_id = ? AND r.field_mapping_version_id = ?
      ORDER BY r.priority ASC, v.created_at ASC`,
    [tenantId, fieldMappingVersionId]
  );
}

async function loadFieldMappingRules(
  adapter: DatabaseAdapter,
  tenantId: string,
  fieldMappingVersionId: string
): Promise<FieldMappingRuleRow[]> {
  return adapter.query<FieldMappingRuleRow>(
    `SELECT id, action, priority, scope_json, metadata_json
       FROM mapping_rules
      WHERE tenant_id = ? AND field_mapping_version_id = ?
      ORDER BY priority ASC, created_at ASC`,
    [tenantId, fieldMappingVersionId]
  );
}

function toCatalogEntry(row: CatalogEntryRow): FieldCatalogBundle['entries'][number] {
  const validation = parseJsonObject(row.validation_json ?? '{}');
  return {
    id: row.stable_field_id || row.id,
    namespace: row.namespace,
    path: row.path,
    aliases: parseAliasList(row.aliases_json),
    targetType: normalizeTargetType(row.target_taxonomy),
    valueType: row.value_type,
    cardinality: normalizeCardinality(row.cardinality),
    classification: normalizeClassification(row.classification),
    required: readBoolean(validation.required),
    nullable: readBoolean(validation.nullable),
    allowedValues: parseStringArray(validation.allowedValues),
  };
}

function findCatalogEntry(catalog: FieldCatalogBundle, ref: FieldRef) {
  if (ref.catalogEntryId) {
    const exact = catalog.entries.find((entry) => entry.id === ref.catalogEntryId);
    if (exact) return exact;
  }
  return catalog.entries.find(
    (entry) =>
      (entry.namespace === ref.namespace && entry.path === ref.path) ||
      entry.aliases?.some((alias) => alias.namespace === ref.namespace && alias.path === ref.path)
  );
}

function toRuntimeEdges(edges: EdgeRow[]): MappingRuleEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    sourceRef: parseFieldRef(edge.source_ref_json),
    targetRef: parseFieldRef(edge.target_ref_json),
    edgeKind: edge.edge_kind ?? undefined,
  }));
}

function toRuntimeTransforms(transforms: TransformRow[], edges: EdgeRow[]): MappingTransformStep[] {
  return transforms.map((transform) => ({
    id: transform.id,
    inputEdgeIds: transform.edge_id ? [transform.edge_id] : [],
    operation: transform.operation as TransformOperation,
    parameters: parseJsonObject(transform.parameters_json ?? '{}'),
    outputTargetRef: transform.target_ref_json
      ? parseFieldRef(transform.target_ref_json)
      : inferTransformOutputTargetRef(transform, edges),
  }));
}

/**
 * The edges and transforms of a version as the runtime reads them (every spelling of a reference
 * resolved), for a check that must judge a version before it is in use.
 */
export async function loadRuntimeMappingGraph(
  adapter: DatabaseAdapter,
  ownerTenantId: string,
  fieldMappingVersionId: string
): Promise<{ edges: MappingRuleEdge[]; transforms: MappingTransformStep[] }> {
  const [edges, transforms] = await Promise.all([
    loadEdges(adapter, ownerTenantId, fieldMappingVersionId),
    loadTransforms(adapter, ownerTenantId, fieldMappingVersionId),
  ]);
  return { edges: toRuntimeEdges(edges), transforms: toRuntimeTransforms(transforms, edges) };
}

function inferTransformOutputTargetRef(transform: TransformRow, edges: EdgeRow[]): FieldRef {
  const edge = transform.edge_id ? edges.find((item) => item.id === transform.edge_id) : undefined;
  return edge
    ? parseFieldRef(edge.target_ref_json)
    : { side: 'destination', namespace: 'unknown', path: transform.id };
}

function parseFieldMappingTargetRef(metadataJson: string | null): FieldRef | undefined {
  const metadata = parseJsonObject(metadataJson ?? '{}');
  const targetRef = metadata.targetRef;
  return isRecord(targetRef) ? normalizeFieldRef(targetRef) : undefined;
}

function toFieldMappingScope(
  scopeJson: string | null,
  fallbackScope: Record<string, unknown>
): FieldMappingSet['rules'][number]['scope'] {
  const scope = parseJsonObject(scopeJson ?? '{}');
  return {
    kind: (readString(scope.kind) ??
      readString(fallbackScope.kind) ??
      'tenant') as FieldMappingSet['rules'][number]['scope']['kind'],
    id: readString(scope.id) ?? readString(fallbackScope.id) ?? 'default',
  };
}

function toFieldMappingAction(action: string): FieldMappingSet['rules'][number]['action'] {
  return action === 'deny' || action === 'lock' ? action : 'allow';
}

function parseFieldRef(json: string): FieldRef {
  return normalizeFieldRef(parseJsonObject(json));
}

function normalizeFieldRef(value: Record<string, unknown>): FieldRef {
  return {
    side: (readString(value.side) ?? 'source') as FieldRef['side'],
    namespace: readString(value.namespace) ?? 'unknown',
    path: mappingReferencePath(value) ?? 'unknown',
    catalogEntryId: mappingReferenceCatalogEntryId(value),
    valueType: readString(value.valueType) ?? readString(value.value_type),
  };
}

function parseJsonObject(json: string | null | undefined): Record<string, unknown> {
  if (!json) {
    return {};
  }
  try {
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseAliasList(json: string | null): FieldCatalogBundle['entries'][number]['aliases'] {
  let parsed: unknown;
  try {
    parsed = json ? JSON.parse(json) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  return parsed
    .filter(isRecord)
    .map((alias) => ({
      namespace: readString(alias.namespace) ?? 'unknown',
      path: readString(alias.path) ?? 'unknown',
    }))
    .filter((alias) => alias.namespace !== 'unknown' && alias.path !== 'unknown');
}

function parseStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function normalizeTargetType(value: string): TargetType {
  return value === 'custom' ||
    value === 'derived' ||
    value === 'destination-only' ||
    value === 'review-only'
    ? value
    : value === 'destination'
      ? 'destination-only'
      : 'canonical';
}

function normalizeCardinality(value: string): Cardinality {
  return value === 'multi' ? 'multi' : 'single';
}

function normalizeClassification(value: string): RedactionClassification {
  return value === 'public' ||
    value === 'pii' ||
    value === 'secret' ||
    value === 'regulated' ||
    value === 'credential' ||
    value === 'token' ||
    value === 'key_material'
    ? value
    : 'internal';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
