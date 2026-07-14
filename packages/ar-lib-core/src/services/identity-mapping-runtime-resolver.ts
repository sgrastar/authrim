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
} from '@authrim/ar-lib-field-mapping';
import type { DatabaseAdapter } from '../db/adapter';

export type RuntimeIdentityMappingProtocol = 'saml' | 'oidc' | 'vc' | string;
export type RuntimeIdentityMappingRole = 'idp' | 'sp' | 'op' | 'rp' | string;

export interface RuntimeIdentityMappingResolutionContext {
  tenantId: string;
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
}

export interface RuntimeIdentityMappingBinding {
  id: string;
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

export async function resolveRuntimeIdentityMappingBinding(
  adapter: DatabaseAdapter,
  context: RuntimeIdentityMappingResolutionContext
): Promise<RuntimeIdentityMappingBinding | null> {
  const activeRows = await loadActiveActivationRows(adapter, context);
  const selected = selectBestActivation(activeRows, context);
  if (!selected || !selected.catalog_version_id) {
    return null;
  }

  const [catalogEntries, edges, transforms, validationRules, fieldMappingRules] = await Promise.all(
    [
      loadCatalogEntries(adapter, context.tenantId, selected.catalog_version_id),
      loadEdges(adapter, context.tenantId, selected.field_mapping_version_id),
      loadTransforms(adapter, context.tenantId, selected.field_mapping_version_id),
      loadValidationRules(adapter, context.tenantId, selected.field_mapping_version_id),
      loadFieldMappingRules(adapter, context.tenantId, selected.field_mapping_version_id),
    ]
  );
  const activationScope = parseJsonObject(selected.activation_scope_json);

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
    edges: edges.map((edge) => ({
      id: edge.id,
      sourceRef: parseFieldRef(edge.source_ref_json),
      targetRef: parseFieldRef(edge.target_ref_json),
      edgeKind: edge.edge_kind ?? undefined,
    })),
    transforms: transforms.map((transform) => ({
      id: transform.id,
      inputEdgeIds: transform.edge_id ? [transform.edge_id] : [],
      operation: transform.operation as TransformOperation,
      parameters: parseJsonObject(transform.parameters_json ?? '{}'),
      outputTargetRef: transform.target_ref_json
        ? parseFieldRef(transform.target_ref_json)
        : inferTransformOutputTargetRef(transform, edges),
    })),
    validationRules: validationRules.map((rule) => ({
      id: rule.id,
      kind: rule.validation_kind as ValidationRuleKind,
      targetRef: parseFieldRef(rule.target_ref_json),
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
    destinationProfileId: readString(activationScope.destinationProfileId),
  };
}

async function loadActiveActivationRows(
  adapter: DatabaseAdapter,
  context: RuntimeIdentityMappingResolutionContext
): Promise<ActiveActivationRow[]> {
  const params: unknown[] = [context.tenantId, 'active'];
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

function selectBestActivation(
  rows: ActiveActivationRow[],
  context: RuntimeIdentityMappingResolutionContext
): ActiveActivationRow | undefined {
  return rows
    .map((row) => ({
      row,
      score: activationScore(parseJsonObject(row.activation_scope_json), context),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.row;
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

async function loadCatalogEntries(
  adapter: DatabaseAdapter,
  tenantId: string,
  catalogVersionId: string
): Promise<CatalogEntryRow[]> {
  return adapter.query<CatalogEntryRow>(
    `SELECT *
       FROM field_catalog_entries
      WHERE tenant_id = ? AND catalog_version_id = ?
      ORDER BY namespace ASC, path ASC`,
    [tenantId, catalogVersionId]
  );
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
    path:
      readString(value.path) ?? readString(value.fieldKey) ?? readString(value.nodeId) ?? 'unknown',
    catalogEntryId: readString(value.catalogEntryId) ?? readString(value.catalog_entry_id),
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
