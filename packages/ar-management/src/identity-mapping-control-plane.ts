import type { Context } from 'hono';
import type { Env, DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  transitionAccountAuthenticationState,
} from '@authrim/ar-lib-core';
import {
  isProtectedIdentityMappingDestinationClaim,
  OIDC_PROTOCOL_ENVELOPE_CLAIMS,
} from '@authrim/ar-lib-core/services/destination-profile-consent';
import type {
  LifecycleSignalType,
  ProvisioningAssignmentCondition,
  ProvisioningAssignmentContext,
  ProvisioningAssignmentOwnershipContext,
  ProvisioningAssignmentTargetType,
} from './identity-provisioning-assignment';
import {
  decideLifecycleSignalRevocation,
  evaluateProvisioningAssignmentRule,
} from './identity-provisioning-assignment';
import {
  parseCsvSourceProfile,
  validateCatalogBundle,
} from '@authrim/ar-lib-field-mapping/authoring';
import type { CsvSourceProfileParserOptions } from '@authrim/ar-lib-field-mapping/authoring';
import type { FieldCatalogEntry } from '@authrim/ar-lib-field-mapping/contract';

type AdminContext = Context<{ Bindings: Env }>;

type LifecycleState = 'draft' | 'published' | 'active' | 'scheduled' | 'retired';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVATION_LEASE_TTL_MS = 60 * 1000;
const CSV_SOURCE_PROFILE_MAX_BYTES = 2 * 1024 * 1024;
const CSV_SOURCE_PROFILE_MAX_BASE64_CHARS = Math.ceil(CSV_SOURCE_PROFILE_MAX_BYTES / 3) * 4 + 4;
const CSV_SOURCE_PROFILE_MAX_ROWS = 1000;
const CSV_SOURCE_PROFILE_MAX_COLUMNS = 500;
const PROFILE_SCHEMA_MAX_JSON_BYTES = 128 * 1024;
const PROFILE_SCHEMA_MAX_DEPTH = 12;
const PROFILE_SCHEMA_MAX_NODES = 4000;
const PROFILE_SCHEMA_MAX_ARRAY_ITEMS = 1000;
const PROFILE_SCHEMA_MAX_OBJECT_KEYS = 500;
const PROFILE_SCHEMA_MAX_STRING_CHARS = 4096;
const POLICY_VERSION_MAX_RULES = 250;
const POLICY_RULE_MAX_EDGES = 500;
const POLICY_RULE_MAX_TRANSFORMS = 500;
const POLICY_RULE_MAX_VALIDATION_RULES = 250;
const POLICY_RULE_MAX_RELEASE_RULES = 250;
const POLICY_RULE_MAX_CONFLICT_RULES = 100;
const POLICY_SYMBOL_MAX_CHARS = 128;
const POLICY_SYMBOL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,127}$/;
const SUPPORTED_POLICY_TRANSFORM_OPERATIONS = new Set([
  'copy',
  'concat',
  'fallback',
  'normalize',
  'case',
  'trim',
  'affix_text',
  'oidc_pairwise_sub',
  'saml_edu_person_targeted_id',
  'text_to_boolean',
  'json_build',
  'json_extract_text',
  'json_extract_boolean',
  'json_extract_integer',
]);
const DEFAULT_CANONICAL_CATALOG_ID = 'system_default_canonical_catalog';
const DEFAULT_CANONICAL_CATALOG_KEY = 'authrim.default_canonical';
const DEFAULT_CANONICAL_CATALOG_DISPLAY_NAME = 'Authrim Default Canonical Catalog';
const DEFAULT_CANONICAL_NAMESPACE = 'authrim.canonical';

const SCHEMA_READINESS_INVENTORY: SchemaReadinessInventoryDefinition[] = [
  {
    id: 'UIM-SCH-016',
    objectName: 'field_mapping_sets',
    area: 'Field mapping set root',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'field mapping authoring',
    status: 'api_connected',
    gate: 'repo/API/tests; UI in PR12',
    schemaObject: 'field_mapping_sets',
  },
  {
    id: 'UIM-SCH-017',
    objectName: 'field_mapping_versions',
    area: 'Draft/published/active versions',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'activation / compile',
    status: 'api_connected',
    gate: 'repo/API/tests; hot-path use in later runtime slices',
    schemaObject: 'field_mapping_versions',
  },
  {
    id: 'UIM-SCH-019',
    objectName: 'mapping_rule_edges',
    area: 'Graph field-to-field edges',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation / PR12 UI',
    runtimePath: 'Svelte Flow graph',
    status: 'api_connected',
    gate: 'API/tests; UI in PR12',
    schemaObject: 'mapping_rule_edges',
  },
  {
    id: 'UIM-SCH-024',
    objectName: 'field_mapping_activations',
    area: 'Activation / schedule state',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'active snapshot selection',
    status: 'api_connected',
    gate: 'activation API/tests; runtime pointer use in later slices',
    schemaObject: 'field_mapping_activations',
  },
  {
    id: 'UIM-SCH-025',
    objectName: 'compiled_mapping_snapshots',
    area: 'Hot-path compiled field mapping',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'hot path',
    status: 'api_connected',
    gate: 'compile/activate API/tests; runtime hot-path use in later slices',
    schemaObject: 'compiled_mapping_snapshots',
  },
  {
    id: 'UIM-SCH-030',
    objectName: 'protocol_schema_catalogs',
    area: 'Protocol schema catalog',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'adapter validation',
    status: 'api_connected',
    gate: 'API/tests',
    schemaObject: 'protocol_schema_catalogs',
  },
  {
    id: 'UIM-SCH-031',
    objectName: 'external_schema_catalogs',
    area: 'Imported external metadata',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'draft suggestions',
    status: 'api_connected',
    gate: 'API/tests; import workflow later',
    schemaObject: 'external_schema_catalogs',
  },
  {
    id: 'UIM-SCH-032',
    objectName: 'mapping_templates',
    area: 'Built-in/custom templates',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'field mapping creation',
    status: 'api_connected',
    gate: 'API/tests; UI in PR12',
    schemaObject: 'mapping_templates',
  },
  {
    id: 'UIM-SCH-044',
    objectName: 'review_tasks',
    area: 'Manual review queue',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'PR9 consent / review',
    runtimePath: 'linking/conflict/release review',
    status: 'api_connected',
    gate: 'create/transition API + tests; full Admin UI queue in PR12',
    schemaObject: 'review_tasks',
  },
  {
    id: 'UIM-SCH-045',
    objectName: 'review_task_groups',
    area: 'Grouped bulk review',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'PR9 consent / review',
    runtimePath: 'bulk import/activation review',
    status: 'api_connected',
    gate: 'group API + tests; full Admin UI queue in PR12',
    schemaObject: 'review_task_groups',
  },
  {
    id: 'UIM-SCH-047',
    objectName: 'mapping_activation_leases',
    area: 'Activation concurrency lock',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'publish/activate/schedule',
    status: 'api_connected',
    gate: 'API/tests',
    schemaObject: 'mapping_activation_leases',
  },
  {
    id: 'UIM-SCH-048',
    objectName: 'idempotency_records',
    area: 'Mutation retry safety',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'field mapping foundation',
    runtimePath: 'Admin API mutation',
    status: 'api_connected',
    gate: 'API/tests',
    schemaObject: 'idempotency_records',
  },
  {
    id: 'UIM-SCH-068',
    objectName: 'external_lifecycle_signal_events',
    area: 'Lifecycle signal ledger',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'PR10 provisioning assignment',
    runtimePath: 'SCIM / VC / CSV / SAML / OIDC implemented source signal intake',
    status: 'api_connected',
    gate: 'implemented lifecycle signals connected; SSF adapter remains deferred',
    schemaObject: 'external_lifecycle_signal_events',
  },
  {
    id: 'UIM-SCH-071',
    objectName: 'federation_trust_sources',
    area: 'Normalized trust source registry',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'federation metadata PR',
    runtimePath: 'SAML-first trust source; OIDC/VC/SCIM/agent slots reserved',
    status: 'schema_added',
    gate: 'SAML repo + runtime + reserved slots disabled',
    schemaObject: 'federation_trust_sources',
    requiredForTier2Gate: true,
  },
  {
    id: 'UIM-SCH-072',
    objectName: 'federation_trust_anchors',
    area: 'Trust anchors / certificates / issuer roots',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'federation metadata PR',
    runtimePath: 'SAML aggregate / VC issuer validation; OIDC Fed no runtime in initial slice',
    status: 'schema_added',
    gate: 'repo + runtime + tests',
    schemaObject: 'federation_trust_anchors',
    requiredForTier2Gate: true,
  },
  {
    id: 'UIM-SCH-073',
    objectName: 'federation_metadata_documents',
    area: 'Fetched/imported metadata document ledger',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'federation metadata PR',
    runtimePath: 'metadata import / refresh / audit',
    status: 'schema_added',
    gate: 'jobs + audit + tests',
    schemaObject: 'federation_metadata_documents',
    requiredForTier2Gate: true,
  },
  {
    id: 'UIM-SCH-074',
    objectName: 'federation_entity_statements',
    area: 'OIDC Federation entity statement storage',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'future OIDC Federation PR',
    runtimePath: 'reserved only in initial slice',
    status: 'reserved_planned',
    gate: 'disabled feature + no runtime exposure + documented readiness',
    schemaObject: 'federation_entity_statements',
  },
  {
    id: 'UIM-SCH-075',
    objectName: 'federation_trust_chains',
    area: 'OIDC Federation trust chain resolution results',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'future OIDC Federation PR',
    runtimePath: 'reserved only in initial slice',
    status: 'reserved_planned',
    gate: 'disabled feature + no runtime exposure + documented readiness',
    schemaObject: 'federation_trust_chains',
  },
  {
    id: 'UIM-SCH-076',
    objectName: 'legacy SAML federation trust profile API removal',
    area: 'Legacy SAML aggregate trust profile removal',
    introducedPr: 'removed',
    expectedConnectionPr: 'SAML federation migration PR',
    runtimePath: 'SAML aggregate metadata import / trust validation uses federation_trust_sources',
    status: 'closed',
    gate: 'legacy table and API removed; normalized federation trust API is source of truth',
  },
  {
    id: 'UIM-SCH-083',
    objectName: 'federation_metadata_entity_summaries',
    area: 'Aggregate metadata entity summary index',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'federation metadata PR',
    runtimePath: 'SAML aggregate entity selection / diff',
    status: 'schema_added',
    gate: 'import + UI + tests',
    schemaObject: 'federation_metadata_entity_summaries',
    requiredForTier2Gate: true,
  },
  {
    id: 'UIM-SCH-086',
    objectName: 'SSF / CAEP / RISC adapter',
    area: 'Future shared signal protocol adapter',
    introducedPr: 'TBD',
    expectedConnectionPr: 'future lifecycle signal adapter PR',
    runtimePath: 'no runtime exposure in initial slice',
    status: 'adapter_deferred',
    gate: 'disabled feature + no endpoint + resume criteria',
  },
  {
    id: 'UIM-SCH-087',
    objectName: 'existing consent statement integration',
    area: 'Existing consent statement/version/user record APIs',
    introducedPr: 'existing',
    expectedConnectionPr: 'PR9 consent / review',
    runtimePath: 'release decision consent gate',
    status: 'service_connected',
    gate: 'legal basis gate service + tests; live protocol challenge UI later',
  },
  {
    id: 'UIM-SCH-088',
    objectName: 'attribute_release_consents',
    area: 'Destination-specific released attribute set consent',
    introducedPr: 'schema baseline PR',
    expectedConnectionPr: 'PR9 consent / review',
    runtimePath: 'SAML / federation release consent',
    status: 'repo_connected',
    gate: 'repository + release challenge tests; user-facing challenge UI later',
    schemaObject: 'attribute_release_consents',
  },
  {
    id: 'UIM-SCH-089',
    objectName: 'source_profiles',
    area: 'Source and destination profile registration',
    introducedPr: 'source profile CSV PR',
    expectedConnectionPr: 'PR12 Admin UI',
    runtimePath: 'Source & Destination Profiles / Flow Editor selector',
    status: 'api_connected',
    gate: 'CSV create/list API + Admin UI + tests',
    schemaObject: 'source_profiles',
  },
  {
    id: 'UIM-SCH-090',
    objectName: 'source_profile_versions',
    area: 'Versioned source profile schema summaries',
    introducedPr: 'source profile CSV PR',
    expectedConnectionPr: 'PR12 Admin UI',
    runtimePath: 'CSV source profile draft/review/active lifecycle',
    status: 'api_connected',
    gate: 'version lifecycle API + tests; no raw sample persistence',
    schemaObject: 'source_profile_versions',
  },
  {
    id: 'UIM-SCH-091',
    objectName: 'source_profile_parse_drafts',
    area: 'Temporary schema-only parse drafts',
    introducedPr: 'source profile CSV PR',
    expectedConnectionPr: 'PR12 Admin UI',
    runtimePath: 'CSV parse preview before save',
    status: 'api_connected',
    gate: 'parse API + expiry metadata + no raw sample persistence tests',
    schemaObject: 'source_profile_parse_drafts',
  },
  {
    id: 'UIM-SCH-092',
    objectName: 'destination_profiles',
    area: 'Destination profile registration',
    introducedPr: 'destination profile PR',
    expectedConnectionPr: 'Destination profile PR',
    runtimePath: 'Source & Destination Profiles / Flow Editor selector',
    status: 'api_connected',
    gate: 'OIDC/CSV create/list API + Admin UI + tests',
    schemaObject: 'destination_profiles',
  },
  {
    id: 'UIM-SCH-093',
    objectName: 'destination_profile_versions',
    area: 'Versioned destination release contract summaries',
    introducedPr: 'destination profile PR',
    expectedConnectionPr: 'Destination profile PR',
    runtimePath: 'OIDC/CSV draft/review/active lifecycle',
    status: 'api_connected',
    gate: 'version lifecycle API + release impact tests',
    schemaObject: 'destination_profile_versions',
  },
  {
    id: 'UIM-SCH-094',
    objectName: 'attribute_group_registry',
    area: 'Attribute group registry',
    introducedPr: 'destination profile PR',
    expectedConnectionPr: 'Destination profile PR',
    runtimePath: 'Destination profile group validation',
    status: 'api_connected',
    gate: 'attribute group API + over-release validation tests',
    schemaObject: 'attribute_group_registry',
  },
  {
    id: 'UIM-SCH-095',
    objectName: 'attribute_field_registry',
    area: 'Attribute field registry',
    introducedPr: 'destination profile PR',
    expectedConnectionPr: 'Destination profile PR',
    runtimePath: 'Destination profile field validation',
    status: 'api_connected',
    gate: 'attribute field API + reserved OIDC claim validation tests',
    schemaObject: 'attribute_field_registry',
  },
];

interface FieldMappingSetRow {
  id: string;
  tenant_id: string;
  field_mapping_key: string;
  display_name: string;
  description: string | null;
  owner_scope_type: string;
  owner_scope_id: string | null;
  lifecycle_state: LifecycleState;
  created_at: number;
  updated_at: number;
}

interface FieldMappingVersionRow {
  id: string;
  tenant_id: string;
  field_mapping_set_id: string;
  version_label: string;
  lifecycle_state: LifecycleState;
  field_mapping_hash: string;
  compatibility_range: string | null;
  author_id: string | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

interface FieldMappingVersionListRow extends FieldMappingVersionRow {
  snapshot_id: string | null;
  snapshot_catalog_version_id: string | null;
  snapshot_lifecycle_state: LifecycleState | null;
  snapshot_compiled_at: number | null;
}

interface FieldMappingRuleSummaryRow {
  field_mapping_version_id: string;
  rule_id: string;
  rule_key: string;
  rule_kind: string;
  action: string;
  priority: number;
  metadata_json: string | null;
  edge_id: string | null;
  source_ref_json: string | null;
  target_ref_json: string | null;
  edge_kind: string | null;
  display_order: number | null;
}

interface FieldMappingTransformSummaryRow {
  field_mapping_version_id: string;
  rule_id: string;
  transform_id: string;
  edge_id: string | null;
  step_order: number;
  operation: string;
  parameters_json: string | null;
}

interface SensitiveReleaseMappingEdgeRow {
  source_ref_json: string;
  target_ref_json: string;
}

interface FieldCatalogVersionRow {
  id: string;
  tenant_id: string;
  catalog_id: string;
  version_label: string;
  bundle_hash: string;
  compatibility_range: string | null;
  lifecycle_state: LifecycleState;
  created_at: number;
  updated_at: number;
}

interface FieldCatalogListRow {
  id: string;
  tenant_id: string;
  catalog_key: string;
  display_name: string;
  lifecycle_state: LifecycleState;
  version_id: string | null;
  version_label: string | null;
  bundle_hash: string | null;
  entry_id: string | null;
  stable_field_id: string | null;
  namespace: string | null;
  path: string | null;
  target_taxonomy: string | null;
  value_type: string | null;
  cardinality: string | null;
  classification: string | null;
  aliases_json: string | null;
  validation_json: string | null;
  ui_group_key: string | null;
  ui_group_label: string | null;
  ui_group_order: number | null;
  ui_field_order: number | null;
  examples_json: string | null;
  note: string | null;
}

interface CustomClaimSchemaCatalogRow {
  id: string;
  field_key: string | null;
  active_field_key: string | null;
  display_label: string | null;
  field_type: string | null;
  cardinality: string | null;
  is_pii: number | boolean | null;
  is_required: number | boolean | null;
  validation_rules: string | null;
  description: string | null;
  display_order: number | null;
  ui_group_key: string | null;
  ui_group_label: string | null;
  ui_group_order: number | null;
  ui_field_order: number | null;
  examples_json: string | null;
  schema_version: number | null;
}

interface FieldCatalogEntrySummary {
  id: string;
  stableFieldId: string;
  namespace: string;
  path: string;
  targetTaxonomy: string;
  valueType: string;
  cardinality: string;
  classification: string;
  aliases: Array<{ namespace: string; path: string }>;
  uiGroupKey: string | null;
  uiGroupLabel: string | null;
  uiGroupOrder: number;
  uiFieldOrder: number;
  examples: unknown[];
  note: string | null;
  allowedValues: string[];
  valueMultiplicity: 'single' | 'multi' | null;
  nullable: boolean | null;
  required: boolean | null;
}

interface FieldCatalogSummary {
  id: string;
  tenantId: string;
  catalogKey: string;
  displayName: string;
  lifecycleState: LifecycleState;
  versionId: string | null;
  versionLabel: string | null;
  bundleHash: string | null;
  entries: FieldCatalogEntrySummary[];
}

interface ProtocolSchemaCatalogRow {
  id: string;
  tenant_id: string;
  protocol: string;
  schema_key: string;
  schema_version: string | null;
  schema_json: string;
  lifecycle_state: LifecycleState;
  created_at: number;
  updated_at: number;
}

interface ExternalSchemaCatalogRow {
  id: string;
  tenant_id: string;
  source_type: string;
  source_id: string;
  schema_key: string;
  schema_json: string;
  imported_at: number;
  lifecycle_state: LifecycleState;
  created_at: number;
  updated_at: number;
}

interface MappingTemplateRow {
  id: string;
  tenant_id: string;
  template_key: string;
  template_scope: string;
  display_name: string;
  template_json: string;
  lifecycle_state: LifecycleState;
  created_at: number;
  updated_at: number;
}

interface SourceProfileRow {
  id: string;
  tenant_id: string;
  source_type: string;
  profile_key: string;
  display_name: string;
  lifecycle_state: string;
  active_version_id: string | null;
  created_at: number;
  updated_at: number;
  version_id: string | null;
  version_label: string | null;
  version_lifecycle_state: string | null;
  schema_hash: string | null;
  schema_json: string | null;
  warning_summary_json: string | null;
}

interface SourceProfileParseDraftRow {
  id: string;
  tenant_id: string;
  source_type: string;
  schema_hash: string;
  schema_json: string;
  parser_options_json: string | null;
  warning_summary_json: string | null;
  source_metadata_json: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface DestinationProfileRow {
  id: string;
  tenant_id: string;
  destination_type: string;
  profile_key: string;
  display_name: string;
  owner_scope_type: string;
  owner_scope_id: string | null;
  base_profile_id: string | null;
  lifecycle_state: string;
  active_version_id: string | null;
  created_at: number;
  updated_at: number;
  version_id: string | null;
  version_label: string | null;
  version_lifecycle_state: string | null;
  schema_hash: string | null;
  schema_json: string | null;
  validation_summary_json: string | null;
  warning_summary_json: string | null;
  release_impact_json: string | null;
}

interface AttributeGroupRegistryRow {
  id: string;
  tenant_id: string;
  owner_scope_type: string;
  owner_scope_id: string | null;
  protocol: string;
  group_type: string;
  group_key: string;
  display_name: string;
  description: string | null;
  field_keys_json: string;
  lifecycle_state: string;
  created_at: number;
  updated_at: number;
}

interface AttributeFieldRegistryRow {
  id: string;
  tenant_id: string;
  owner_scope_type: string;
  owner_scope_id: string | null;
  protocol: string;
  field_key: string;
  display_name: string;
  value_type: string;
  classification: string;
  surfaces_json: string;
  lifecycle_state: string;
  created_at: number;
  updated_at: number;
}

interface CompiledMappingSnapshotRow {
  id: string;
  tenant_id: string;
  field_mapping_version_id: string;
  catalog_version_id: string | null;
  snapshot_hash: string;
  lifecycle_state: LifecycleState;
}

interface MappingActivationLeaseRow {
  holder_id: string;
  expires_at: number;
}

interface IdempotencyRecordRow {
  request_hash: string;
  response_ref: string | null;
  status: 'in_progress' | 'complete' | 'failed';
}

interface ProvisioningAssignmentRuleRow {
  id: string;
  target_type: ProvisioningAssignmentTargetType;
  target_id: string;
  condition_json: string;
  priority: number;
}

interface ProvisioningAssignmentOwnershipRow {
  assignment_type: string;
  assignment_id: string;
  ownership_policy: string;
  revoke_policy: string;
  protected_until: number | null;
}

interface CreateCatalogRequest {
  catalogKey: string;
  displayName: string;
  versionLabel: string;
  compatibilityRange?: string;
  entries: FieldCatalogEntry[];
  customEntries?: Array<{
    customKey: string;
    displayName: string;
    valueType: string;
    classification?: string;
    catalogEntryId?: string;
  }>;
}

interface CreateFieldMappingSetRequest {
  fieldMappingKey: string;
  displayName: string;
  description?: string;
  ownerScopeType?: string;
  ownerScopeId?: string;
}

interface CreateProtocolSchemaRequest {
  protocol: string;
  schemaKey: string;
  schemaVersion?: string;
  schema: Record<string, unknown>;
}

interface ImportExternalSchemaRequest {
  sourceType: string;
  sourceId: string;
  schemaKey: string;
  schema: Record<string, unknown>;
}

interface CreateMappingTemplateRequest {
  templateKey: string;
  templateScope?: string;
  displayName: string;
  template: Record<string, unknown>;
}

interface ParseCsvSourceProfileRequest {
  contentBase64: string;
  encoding?: string;
  parserOptions?: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
}

interface CreateSourceProfileRequest {
  sourceType: 'csv' | 'scim' | 'saml' | 'directory';
  profileKey: string;
  displayName: string;
  versionLabel?: string;
  parseDraftId?: string;
  schema?: Record<string, unknown>;
  parserOptions?: Record<string, unknown>;
  warningSummary?: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
}

interface UpdateSourceProfileRequest {
  sourceType?: 'csv' | 'scim' | 'saml' | 'directory';
  profileKey?: string;
  displayName?: string;
  versionLabel?: string;
  parseDraftId?: string;
  schema?: Record<string, unknown>;
  parserOptions?: Record<string, unknown>;
  warningSummary?: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
}

interface CreateDestinationProfileRequest {
  destinationType: 'oidc' | 'csv' | 'saml' | 'resource_server';
  profileKey: string;
  displayName: string;
  ownerScopeType?: 'platform' | 'tenant' | 'client';
  ownerScopeId?: string | null;
  baseProfileId?: string | null;
  versionLabel?: string;
  schema: Record<string, unknown>;
  warningSummary?: Record<string, unknown>;
  releaseImpact?: Record<string, unknown>;
}

interface UpdateDestinationProfileRequest {
  destinationType?: 'oidc' | 'csv' | 'saml' | 'resource_server';
  profileKey?: string;
  displayName?: string;
  ownerScopeType?: 'platform' | 'tenant' | 'client';
  ownerScopeId?: string | null;
  baseProfileId?: string | null;
  versionLabel?: string;
  schema?: Record<string, unknown>;
  warningSummary?: Record<string, unknown>;
  releaseImpact?: Record<string, unknown>;
}

interface CreateAttributeGroupRequest {
  ownerScopeType?: 'platform' | 'tenant';
  ownerScopeId?: string | null;
  protocol: 'oidc' | 'saml' | 'vc';
  groupType: string;
  groupKey: string;
  displayName: string;
  description?: string | null;
  fieldKeys: string[];
}

interface CreateAttributeFieldRequest {
  ownerScopeType?: 'platform' | 'tenant';
  ownerScopeId?: string | null;
  protocol: 'oidc' | 'saml' | 'vc';
  fieldKey: string;
  displayName: string;
  valueType?: string;
  classification?: string;
  surfaces?: string[];
}

interface FieldMappingVersionRuleInput {
  ruleKey: string;
  ruleKind: string;
  action: string;
  priority?: number;
  scope?: Record<string, unknown>;
  condition?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  edges?: Array<{
    sourceRef: Record<string, unknown>;
    targetRef: Record<string, unknown>;
    edgeKind?: string;
  }>;
  transforms?: Array<{
    edgeIndex?: number;
    operation: string;
    parameters?: Record<string, unknown>;
  }>;
  validationRules?: Array<{
    targetRef: Record<string, unknown>;
    validationKind: string;
    severity?: string;
    parameters?: Record<string, unknown>;
  }>;
  releaseRules?: Array<{
    destinationType: string;
    destinationId?: string;
    sourceRef: Record<string, unknown>;
    releaseAction: string;
    legalBasis?: string;
    purpose?: string;
    condition?: Record<string, unknown>;
    priority?: number;
  }>;
  conflictRules?: Array<{
    targetRef: Record<string, unknown>;
    conflictStrategy: string;
    sourcePriority?: unknown[];
    condition?: Record<string, unknown>;
  }>;
}

interface CreateFieldMappingVersionRequest {
  versionLabel: string;
  compatibilityRange?: string;
  authorId?: string;
  sourceProfileIds?: string[];
  rules: FieldMappingVersionRuleInput[];
}

interface CompileFieldMappingRequest {
  catalogVersionId: string;
  compatibilityRange?: string;
  artifactRef?: string;
  metadata?: Record<string, unknown>;
}

interface ActivateFieldMappingRequest {
  snapshotId: string;
  activationScope: Record<string, unknown>;
  holderId?: string;
}

interface CreateSourceAuthorityContractRequest {
  sourceType: string;
  sourceId: string;
  fieldRef: Record<string, unknown>;
  authorityActions: string[];
  condition?: Record<string, unknown>;
  priority?: number;
}

interface EvaluateSourceAuthorityContractRequest {
  sourceType: string;
  sourceId: string;
  fieldRef: Record<string, unknown>;
  authorityAction: string;
}

interface RecordMappingEventRequest {
  eventType: string;
  fieldMappingVersionId?: string;
  subjectId?: string;
  sourceId?: string;
  outcome: string;
  reasonCodes?: string[];
  traceRef?: string;
}

interface EnqueueProjectionOutboxRequest {
  eventType: string;
  subjectId?: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  availableAt?: number;
}

interface CreateProjectionJobRequest {
  jobType: string;
  scope: Record<string, unknown>;
}

interface CreateReplayJobRequest {
  replayType: string;
  impactScope: Record<string, unknown>;
}

interface UpsertAdminSearchProjectionRequest {
  id?: string;
  subjectId?: string;
  accountId?: string;
  projectionKind: string;
  projection: Record<string, unknown>;
  classification?: string;
  lifecycleState?: string;
}

interface CreateReviewTaskRequest {
  taskType: string;
  subjectId?: string;
  accountId?: string;
  priority?: number;
  assignedTo?: string;
  payload: Record<string, unknown>;
  dueAt?: number;
}

interface ListReviewTasksOptions {
  status?: string;
  taskType?: string;
  assignedTo?: string;
  limit?: number;
}

type SchemaReadinessStatus =
  | 'tested'
  | 'closed'
  | 'api_connected'
  | 'repo_connected'
  | 'service_connected'
  | 'schema_added'
  | 'reserved_planned'
  | 'adapter_deferred'
  | 'existing_to_migrate'
  | 'breaking_planned';

type SchemaReadinessGateState = 'pass' | 'attention' | 'blocked' | 'deferred';

interface SchemaReadinessInventoryDefinition {
  id: string;
  objectName: string;
  area: string;
  introducedPr: string;
  expectedConnectionPr: string;
  runtimePath: string;
  status: SchemaReadinessStatus;
  gate: string;
  schemaObject?: string;
  requiredForTier2Gate?: boolean;
}

interface TransitionReviewTaskRequest {
  status: string;
  assignedTo?: string | null;
  reasonCodes?: string[];
}

interface CreateReviewTaskGroupRequest {
  groupKey: string;
  summary: Record<string, unknown>;
}

interface EnqueueOperationalNotificationRequest {
  category: string;
  eventType: string;
  severity: string;
  subjectType: string;
  subjectId: string;
  payload: Record<string, unknown>;
  deduplicationKey?: string;
}

interface TransitionOperationalNotificationStateRequest {
  state: string;
  assignedTo?: string | null;
}

interface CreateGroupRequest {
  groupKey: string;
  displayName: string;
  description?: string;
  parentGroupId?: string | null;
  metadata?: Record<string, unknown>;
}

interface CreateGroupMembershipRequest {
  groupId: string;
  subjectId?: string;
  accountId?: string;
  membershipType?: string;
  assignmentSource?: string;
  ownershipPolicy?: 'source_owned' | 'manual' | 'protected';
  revokePolicy?: 'auto' | 'review' | 'keep';
  protectedUntil?: number | null;
}

interface GrantEntitlementRequest {
  subjectId?: string;
  accountId?: string;
  entitlementType: string;
  entitlementKey: string;
  sourceId?: string | null;
  value?: Record<string, unknown> | null;
  ownershipPolicy?: 'source_owned' | 'manual' | 'protected';
  revokePolicy?: 'auto' | 'review' | 'keep';
  protectedUntil?: number | null;
}

interface CreateProvisioningAssignmentRuleRequest {
  scopeType?: string;
  scopeId?: string | null;
  ruleType: string;
  targetType: ProvisioningAssignmentTargetType;
  targetId: string;
  condition: ProvisioningAssignmentCondition;
  priority?: number;
  lifecycleState?: 'draft' | 'active' | 'retired';
}

interface EvaluateProvisioningAssignmentRequest extends ProvisioningAssignmentContext {
  subjectId?: string;
  accountId?: string;
  dryRun?: boolean;
}

interface RecordLifecycleSignalRequest {
  sourceType: string;
  sourceId: string;
  sourceEventId: string;
  sourceTimestamp?: number | null;
  bindingVersion?: string | null;
  signalType: LifecycleSignalType;
  subjectId?: string | null;
  accountId?: string | null;
  targetType: 'account' | 'group_membership' | 'entitlement' | 'permission';
  targetId: string;
  payloadRef?: string | null;
  ownership?: ProvisioningAssignmentOwnershipContext | null;
}

interface CreateKeyRegistryRequest {
  keyPurpose: string;
  scope: Record<string, unknown>;
  algorithm: string;
  backendType: string;
  materialRef: string;
  materialMetadata?: Record<string, unknown>;
  actorId?: string;
}

interface RotateKeyRegistryRequest {
  algorithm: string;
  backendType: string;
  materialRef: string;
  materialMetadata?: Record<string, unknown>;
  actorId?: string;
  jobMode?: 'rewrap' | 'blind_index' | 'both' | 'none';
  artifactScope?: Record<string, unknown>;
}

interface RecordKeyAccessRequest {
  keyVersionId?: string | null;
  actorId?: string | null;
  accessType: string;
  outcome: string;
}

interface CreateFederationTrustSourceRequest {
  sourceType: 'saml_aggregate' | 'saml_metadata' | 'saml_federation';
  sourceKey: string;
  displayName: string;
  lifecycleState?: 'draft' | 'active' | 'retired';
  protocolPayload?: Record<string, unknown>;
  anchors?: Array<{
    anchorType: string;
    anchorHash: string;
    anchorRef?: string | null;
    notBefore?: number | null;
    notAfter?: number | null;
  }>;
  scopeBindings?: Array<{
    scopeType: string;
    scopeId?: string | null;
    priority?: number;
  }>;
}

interface UpdateFederationTrustSourceRequest extends CreateFederationTrustSourceRequest {}

interface RegisterFederationMetadataDocumentRequest {
  trustSourceId: string;
  documentType: string;
  sourceUrl?: string | null;
  documentHash: string;
  documentRef?: string | null;
  validationState?: 'pending' | 'valid' | 'invalid' | 'warning';
  entitySummaries?: Array<{
    entityId: string;
    entityRole: string;
    displayName?: string | null;
    summary?: Record<string, unknown>;
  }>;
}

interface FederationMetadataDocumentListRow {
  id: string;
  trust_source_id: string;
  document_type: string;
  source_url: string | null;
  document_hash: string;
  document_ref: string | null;
  fetched_at: number | null;
  validated_at: number | null;
  validation_state: string;
  created_at: number;
  updated_at: number;
  entity_summary_id: string | null;
  entity_id: string | null;
  entity_role: string | null;
  display_name: string | null;
  summary_json: string | null;
}

const REVIEW_TASK_STATUSES = new Set([
  'open',
  'in_review',
  'approved',
  'rejected',
  'resolved',
  'dismissed',
]);

const OPERATIONAL_NOTIFICATION_STATES = new Set(['open', 'acknowledged', 'resolved']);

const IDENTITY_MAPPING_NOTIFICATION_CATEGORIES = new Set([
  'identity_mapping_signal',
  'identity_mapping_manual_review',
  'identity_mapping_propagation_failure',
  'identity_mapping_bulk_impact',
]);

const OPERATIONAL_NOTIFICATION_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const PROVISIONING_ASSIGNMENT_TARGET_TYPES = new Set(['group', 'entitlement', 'permission']);
const LIFECYCLE_SIGNAL_TYPES = new Set([
  'scim_active_false',
  'scim_group_removed',
  'csv_diff_removed',
  'claim_disappeared',
]);
const KEY_JOB_MODES = new Set(['rewrap', 'blind_index', 'both', 'none']);
const FEDERATION_TRUST_SOURCE_TYPES = new Set([
  'saml_aggregate',
  'saml_metadata',
  'saml_federation',
]);
const SOURCE_PROFILE_TYPES = new Set(['csv', 'scim', 'saml', 'directory']);
const SOURCE_PROFILE_VERSION_STATES = new Set(['draft', 'reviewed', 'active']);
const DESTINATION_PROFILE_TYPES = new Set(['oidc', 'csv', 'saml', 'resource_server']);
const DESTINATION_PROFILE_VERSION_STATES = new Set(['draft', 'reviewed', 'active']);
const PROFILE_OWNER_SCOPE_TYPES = new Set(['platform', 'tenant', 'client']);
const REGISTRY_OWNER_SCOPE_TYPES = new Set(['platform', 'tenant']);
const OIDC_SURFACES = new Set(['id_token', 'userinfo']);
const OIDC_STANDARD_SCOPES = new Set([
  'openid',
  'profile',
  'email',
  'phone',
  'address',
  'offline_access',
]);
const DIRECTORY_FACTS_EXTERNAL_SCHEMA_ID = 'builtin_directory_facts';
const DIRECTORY_FACTS_SCHEMA = {
  fields: [
    {
      key: 'directory.identity.subject',
      label: 'Directory Subject',
      type: 'string',
      required: true,
      classification: 'internal',
      description: 'Stable subject resolved by the directory connector.',
    },
    {
      key: 'directory.identity.canonical_username',
      label: 'Canonical Username',
      type: 'string',
      required: true,
      classification: 'pii',
      description: 'Normalized username selected from directory facts.',
    },
    {
      key: 'directory.identity.connector_id',
      label: 'Connector ID',
      type: 'string',
      required: true,
      classification: 'internal',
      description: 'Immutable Wordwarden connector identifier.',
    },
    {
      key: 'directory.attributes.mail',
      label: 'Directory Mail',
      type: 'string',
      classification: 'pii',
      description: 'Allowlisted directory mail attribute when requested.',
    },
    {
      key: 'directory.attributes.displayName',
      label: 'Directory Display Name',
      type: 'string',
      classification: 'pii',
      description: 'Allowlisted directory displayName attribute when requested.',
    },
    {
      key: 'directory.groups',
      label: 'Directory Groups',
      type: 'array',
      classification: 'internal',
      valueMultiplicity: 'multi',
      description: 'Opt-in group facts returned by Wordwarden.',
    },
    {
      key: 'directory.evidence.connector_id',
      label: 'Evidence Connector ID',
      type: 'string',
      classification: 'internal',
      description: 'Authrim connector config identifier for audit evidence.',
    },
    {
      key: 'directory.evidence.request_id',
      label: 'Wordwarden Request ID',
      type: 'string',
      classification: 'internal',
      description: 'Wordwarden verification request correlation ID.',
    },
  ],
  metadata: {
    source: 'authrim_wordwarden',
    attributesPolicy: 'allowlisted_only',
    groupsPolicy: 'opt_in',
  },
} satisfies Record<string, unknown>;
const OIDC_RESERVED_NON_PROFILE_CLAIMS = OIDC_PROTOCOL_ENVELOPE_CLAIMS;
const OIDC_STANDARD_CLAIMS = new Set([
  'sub',
  'name',
  'given_name',
  'family_name',
  'middle_name',
  'nickname',
  'preferred_username',
  'profile',
  'picture',
  'website',
  'email',
  'email_verified',
  'gender',
  'birthdate',
  'zoneinfo',
  'locale',
  'phone_number',
  'phone_number_verified',
  'address',
  'updated_at',
]);
const OIDC_STANDARD_SCOPE_ALLOWED_CLAIMS = new Map<string, string[]>([
  [
    'profile',
    [
      'name',
      'given_name',
      'family_name',
      'middle_name',
      'nickname',
      'preferred_username',
      'profile',
      'picture',
      'website',
      'gender',
      'birthdate',
      'zoneinfo',
      'locale',
      'updated_at',
    ],
  ],
  ['email', ['email', 'email_verified']],
  ['phone', ['phone_number', 'phone_number_verified']],
  ['address', ['address']],
]);
const FEDERATION_TRUST_LIFECYCLE_STATES = new Set(['draft', 'active', 'retired']);
const FEDERATION_METADATA_VALIDATION_STATES = new Set(['pending', 'valid', 'invalid', 'warning']);
const KEY_ACCESS_TYPES = new Set([
  'registry.create',
  'registry.rotate',
  'material.ref.read',
  'material.unwrap',
  'material.sign',
  'material.verify',
  'blind_index.derive',
  'rewrap.read',
  'debug_metadata.read',
]);
const KEY_ACCESS_OUTCOMES = new Set(['success', 'denied', 'failed']);

interface RepositoryResult<T> {
  result: T;
}

interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

interface SqlQueryExecutor extends SqlExecutor {
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
}

class IdentityMappingControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
  }
}

export class IdentityMappingControlPlaneRepository {
  constructor(
    private readonly adapter: DatabaseAdapter,
    private readonly now: () => number = () => Date.now(),
    private readonly coreAdapter?: DatabaseAdapter,
    private readonly beforeAccountSuspension?: (
      tenantId: string,
      accountId: string,
      sourceVersionMs: number,
      operationId: string
    ) => Promise<void>
  ) {}

  async listSchemaReadiness() {
    const schemaRows = await this.adapter.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"
    );
    const schemaObjects = new Set(schemaRows.map((row) => row.name));
    const readiness = SCHEMA_READINESS_INVENTORY.map((item) => {
      const schemaPresent = item.schemaObject ? schemaObjects.has(item.schemaObject) : null;
      const gateState = resolveSchemaReadinessGateState(item, schemaPresent);
      return {
        ...item,
        schemaPresent,
        gateState,
      };
    });

    return {
      rows: readiness,
      summary: {
        total: readiness.length,
        pass: readiness.filter((item) => item.gateState === 'pass').length,
        attention: readiness.filter((item) => item.gateState === 'attention').length,
        blocked: readiness.filter((item) => item.gateState === 'blocked').length,
        deferred: readiness.filter((item) => item.gateState === 'deferred').length,
      },
    };
  }

  async createCatalog(tenantId: string, input: CreateCatalogRequest) {
    validateRequiredString(input.catalogKey, 'catalogKey');
    validateRequiredString(input.displayName, 'displayName');
    validateRequiredString(input.versionLabel, 'versionLabel');
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw badRequest('entries must contain at least one catalog entry');
    }
    for (const entry of input.entries) {
      if (
        entry.targetType === 'destination-only' &&
        isProtectedIdentityMappingDestinationClaim(entry.namespace, entry.path)
      ) {
        throw badRequest(`${entry.namespace}:${entry.path} is reserved by the protocol envelope`);
      }
    }

    const catalogId = createId('catalog');
    const versionId = createId('catalog_version');
    const bundleHash = await hashStableJson({
      catalogKey: input.catalogKey,
      versionLabel: input.versionLabel,
      entries: input.entries,
    });
    const catalogBundle = {
      identity: {
        id: catalogId,
        version: input.versionLabel,
        contentHash: bundleHash,
        compatibilityRange: input.compatibilityRange ?? '*',
      },
      entries: input.entries,
    };
    const validation = validateCatalogBundle(catalogBundle);
    if (validation.status === 'failed') {
      throw badRequest('catalog bundle is invalid');
    }
    validateCustomEntries(input.entries, input.customEntries ?? []);

    const now = this.now();
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO field_catalogs (
          id, tenant_id, catalog_key, display_name, lifecycle_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [catalogId, tenantId, input.catalogKey, input.displayName, 'draft', now, now]
      );
      await tx.execute(
        `INSERT INTO field_catalog_versions (
          id, tenant_id, catalog_id, version_label, bundle_hash, compatibility_range,
          lifecycle_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          tenantId,
          catalogId,
          input.versionLabel,
          bundleHash,
          input.compatibilityRange ?? null,
          'draft',
          now,
          now,
        ]
      );

      for (const entry of input.entries) {
        await tx.execute(
          `INSERT INTO field_catalog_entries (
            id, tenant_id, catalog_version_id, stable_field_id, namespace, path, target_taxonomy,
            value_type, cardinality, classification, aliases_json, validation_json,
            ui_group_key, ui_group_label, ui_group_order, ui_field_order, examples_json, note,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('catalog_entry'),
            tenantId,
            versionId,
            entry.id,
            entry.namespace,
            entry.path,
            entry.targetType ?? 'canonical',
            entry.valueType,
            entry.cardinality,
            entry.classification,
            stableJson(entry.aliases ?? []),
            stableJson(catalogEntryValidation(entry)),
            entry.uiGroupKey ?? null,
            entry.uiGroupLabel ?? null,
            entry.uiGroupOrder ?? 0,
            entry.uiFieldOrder ?? 0,
            entry.examples ? stableJson(entry.examples) : null,
            (entry as FieldCatalogEntry & { note?: string }).note ?? null,
            now,
            now,
          ]
        );
      }

      for (const customEntry of input.customEntries ?? []) {
        await tx.execute(
          `INSERT INTO custom_field_catalog_entries (
            id, tenant_id, catalog_entry_id, custom_key, display_name, value_type, classification,
            lifecycle_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('custom_catalog_entry'),
            tenantId,
            customEntry.catalogEntryId ?? null,
            customEntry.customKey,
            customEntry.displayName,
            customEntry.valueType,
            customEntry.classification ?? 'internal',
            'active',
            now,
            now,
          ]
        );
      }
    });

    return {
      id: catalogId,
      tenantId,
      catalogKey: input.catalogKey,
      displayName: input.displayName,
      lifecycleState: 'draft',
      activeVersion: {
        id: versionId,
        versionLabel: input.versionLabel,
        bundleHash,
        compatibilityRange: input.compatibilityRange ?? null,
      },
    };
  }

  async listCatalogs(tenantId: string) {
    const rows = await this.adapter.query<FieldCatalogListRow>(
      `SELECT
          c.*,
          v.id AS version_id,
          v.version_label,
          v.bundle_hash,
          e.id AS entry_id,
          e.stable_field_id,
          e.namespace,
          e.path,
          e.target_taxonomy,
          e.value_type,
          e.cardinality,
          e.classification,
          e.aliases_json,
          e.validation_json,
          e.ui_group_key,
          e.ui_group_label,
          e.ui_group_order,
          e.ui_field_order,
          e.examples_json,
          e.note
         FROM field_catalogs c
         LEFT JOIN field_catalog_versions v ON v.catalog_id = c.id
         LEFT JOIN field_catalog_entries e ON e.catalog_version_id = v.id
        WHERE c.tenant_id = ?
        ORDER BY c.updated_at DESC, e.ui_group_order ASC, e.ui_field_order ASC, e.stable_field_id ASC`,
      [tenantId]
    );
    const catalogs = new Map<string, FieldCatalogSummary>();

    for (const row of rows) {
      const catalog = catalogs.get(row.id) ?? {
        id: row.id,
        tenantId: row.tenant_id,
        catalogKey: row.catalog_key,
        displayName: row.display_name,
        lifecycleState: row.lifecycle_state,
        versionId: row.version_id,
        versionLabel: row.version_label,
        bundleHash: row.bundle_hash,
        entries: [],
      };
      if (row.entry_id && row.stable_field_id && row.namespace && row.path) {
        const validation = parseJsonObject(row.validation_json ?? '{}', {});
        catalog.entries.push({
          id: row.entry_id,
          stableFieldId: row.stable_field_id,
          namespace: row.namespace,
          path: row.path,
          targetTaxonomy: row.target_taxonomy ?? 'canonical',
          valueType: row.value_type ?? 'string',
          cardinality: row.cardinality ?? 'single',
          classification: row.classification ?? 'internal',
          aliases: parseCatalogAliases(row.aliases_json),
          uiGroupKey: row.ui_group_key,
          uiGroupLabel: row.ui_group_label,
          uiGroupOrder: row.ui_group_order ?? 0,
          uiFieldOrder: row.ui_field_order ?? 0,
          examples: parseJsonUnknownArray(row.examples_json),
          note: row.note,
          allowedValues: parseStringArray(validation.allowedValues),
          valueMultiplicity:
            validation.valueMultiplicity === 'single' || validation.valueMultiplicity === 'multi'
              ? validation.valueMultiplicity
              : null,
          nullable: typeof validation.nullable === 'boolean' ? validation.nullable : null,
          required: typeof validation.required === 'boolean' ? validation.required : null,
        });
      }
      catalogs.set(row.id, catalog);
    }

    const storedCatalogs = Array.from(catalogs.values());
    const configuredCanonicalCatalog = await this.loadConfiguredCanonicalCatalog(tenantId);
    if (!configuredCanonicalCatalog) {
      return storedCatalogs;
    }

    return [
      configuredCanonicalCatalog,
      ...storedCatalogs.filter(
        (catalog) =>
          catalog.id !== DEFAULT_CANONICAL_CATALOG_ID &&
          catalog.catalogKey !== DEFAULT_CANONICAL_CATALOG_KEY
      ),
    ];
  }

  private async loadConfiguredCanonicalCatalog(
    tenantId: string
  ): Promise<FieldCatalogSummary | null> {
    let rows: CustomClaimSchemaCatalogRow[];
    try {
      rows = await (this.coreAdapter ?? this.adapter).query<CustomClaimSchemaCatalogRow>(
        `SELECT
            id,
            field_key,
            active_field_key,
            display_label,
            field_type,
            cardinality,
            is_pii,
            is_required,
            validation_rules,
            description,
            display_order,
            ui_group_key,
            ui_group_label,
            ui_group_order,
            ui_field_order,
            examples_json,
            schema_version
           FROM custom_claim_schemas
          WHERE tenant_id = ?
            AND is_active = 1
            AND operation_status = 'active'
          ORDER BY ui_group_order ASC, ui_field_order ASC, display_order ASC, field_key ASC`,
        [tenantId]
      );
    } catch {
      return null;
    }

    const entries = rows.flatMap((row) => customClaimSchemaToCatalogEntry(row));
    if (entries.length === 0) {
      return null;
    }

    const schemaVersion = rows.reduce(
      (max, row) =>
        typeof row.schema_version === 'number' && Number.isFinite(row.schema_version)
          ? Math.max(max, row.schema_version)
          : max,
      1
    );

    return {
      id: DEFAULT_CANONICAL_CATALOG_ID,
      tenantId,
      catalogKey: DEFAULT_CANONICAL_CATALOG_KEY,
      displayName: DEFAULT_CANONICAL_CATALOG_DISPLAY_NAME,
      lifecycleState: 'active',
      versionId: `${DEFAULT_CANONICAL_CATALOG_ID}_schema_v${schemaVersion}`,
      versionLabel: `v${schemaVersion}`,
      bundleHash: null,
      entries,
    };
  }

  async createProtocolSchema(tenantId: string, input: CreateProtocolSchemaRequest) {
    validateRequiredString(input.protocol, 'protocol');
    validateRequiredString(input.schemaKey, 'schemaKey');
    if (!isRecord(input.schema)) {
      throw badRequest('schema must be an object');
    }
    assertProfileSchemaBudget(input.schema, 'protocolSchema.schema');
    assertProfileFieldConstraints(input.schema, 'protocolSchema.schema');
    const now = this.now();
    const id = createId('protocol_schema');
    await this.adapter.execute(
      `INSERT INTO protocol_schema_catalogs (
        id, tenant_id, protocol, schema_key, schema_version, schema_json,
        lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.protocol,
        input.schemaKey,
        input.schemaVersion ?? null,
        stableJson(input.schema),
        'active',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      protocol: input.protocol,
      schemaKey: input.schemaKey,
      schemaVersion: input.schemaVersion ?? null,
      lifecycleState: 'active',
    };
  }

  async listProtocolSchemas(tenantId: string) {
    const rows = await this.adapter.query<ProtocolSchemaCatalogRow>(
      `SELECT * FROM protocol_schema_catalogs
        WHERE tenant_id = ?
        ORDER BY protocol ASC, schema_key ASC, updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      protocol: row.protocol,
      schemaKey: row.schema_key,
      schemaVersion: row.schema_version,
      schema: JSON.parse(row.schema_json) as Record<string, unknown>,
      lifecycleState: row.lifecycle_state,
    }));
  }

  async importExternalSchema(tenantId: string, input: ImportExternalSchemaRequest) {
    validateRequiredString(input.sourceType, 'sourceType');
    validateRequiredString(input.sourceId, 'sourceId');
    validateRequiredString(input.schemaKey, 'schemaKey');
    if (!isRecord(input.schema)) {
      throw badRequest('schema must be an object');
    }
    assertProfileSchemaBudget(input.schema, 'externalSchema.schema');
    assertProfileFieldConstraints(input.schema, 'externalSchema.schema');
    const now = this.now();
    const id = createId('external_schema');
    await this.adapter.execute(
      `INSERT INTO external_schema_catalogs (
        id, tenant_id, source_type, source_id, schema_key, schema_json,
        imported_at, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.sourceType,
        input.sourceId,
        input.schemaKey,
        stableJson(input.schema),
        now,
        'active',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      schemaKey: input.schemaKey,
      lifecycleState: 'active',
      importedAt: now,
    };
  }

  async listExternalSchemas(tenantId: string) {
    const rows = await this.adapter.query<ExternalSchemaCatalogRow>(
      `SELECT * FROM external_schema_catalogs
        WHERE tenant_id = ?
        ORDER BY imported_at DESC`,
      [tenantId]
    );
    return [
      {
        id: DIRECTORY_FACTS_EXTERNAL_SCHEMA_ID,
        tenantId,
        sourceType: 'directory',
        sourceId: 'wordwarden',
        sourceKey: 'directory-facts',
        displayName: 'Directory Facts',
        schemaKey: 'directory-facts',
        schema: DIRECTORY_FACTS_SCHEMA,
        lifecycleState: 'active',
        importedAt: 0,
      },
      ...rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        schemaKey: row.schema_key,
        schema: JSON.parse(row.schema_json) as Record<string, unknown>,
        lifecycleState: row.lifecycle_state,
        importedAt: row.imported_at,
      })),
    ];
  }

  async parseCsvSourceProfile(tenantId: string, input: ParseCsvSourceProfileRequest) {
    validateRequiredString(input.contentBase64, 'contentBase64');
    assertCsvSourceProfilePayloadBudget(input.contentBase64);
    const now = this.now();
    const encoding = normalizeCsvEncoding(input.encoding);
    assertNoSensitiveMetadata(input.sourceMetadata, 'sourceProfile.parse.sourceMetadata');
    const content = decodeBase64Text(input.contentBase64, encoding);
    const schema = parseCsvSourceProfile(content, normalizeCsvParserOptions(input.parserOptions));
    const schemaHash = await hashStableJson(schema);
    const draftId = createId('source_profile_parse_draft');
    const warningSummary = schema.summary;
    const parserOptions = schema.parser;
    const sourceMetadata = {
      ...(isRecord(input.sourceMetadata) ? input.sourceMetadata : {}),
      encoding,
      rawContentPersisted: false,
    };

    await this.adapter.execute(
      `INSERT INTO source_profile_parse_drafts (
        id, tenant_id, source_type, schema_hash, schema_json, parser_options_json,
        warning_summary_json, source_metadata_json, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        draftId,
        tenantId,
        'csv',
        schemaHash,
        stableJson(schema),
        stableJson(parserOptions),
        stableJson(warningSummary),
        stableJson(sourceMetadata),
        now + 60 * 60 * 1000,
        now,
        now,
      ]
    );

    return {
      parseDraftId: draftId,
      tenantId,
      sourceType: 'csv',
      schemaHash,
      schema,
      parserOptions,
      warningSummary,
      expiresAt: now + 60 * 60 * 1000,
    };
  }

  async createSourceProfile(tenantId: string, input: CreateSourceProfileRequest) {
    validateRequiredString(input.sourceType, 'sourceType');
    validateRequiredString(input.profileKey, 'profileKey');
    validateRequiredString(input.displayName, 'displayName');
    if (!SOURCE_PROFILE_TYPES.has(input.sourceType)) {
      throw badRequest('sourceType must be csv, scim, saml, or directory');
    }
    const duplicate = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM source_profiles
        WHERE tenant_id = ?
          AND profile_key = ?`,
      [tenantId, input.profileKey]
    );
    if (duplicate) {
      throw conflict('source profile key already exists');
    }
    const now = this.now();
    const draft = input.parseDraftId
      ? await this.getSourceProfileParseDraft(tenantId, input.parseDraftId, now)
      : null;
    const schema = isRecord(input.schema)
      ? input.schema
      : draft
        ? (JSON.parse(draft.schema_json) as Record<string, unknown>)
        : null;
    if (!schema) {
      throw badRequest('schema or parseDraftId is required');
    }
    assertProfileSchemaBudget(schema, 'sourceProfile.schema');
    assertProfileFieldConstraints(schema, 'sourceProfile.schema');
    assertNoSourceProfileRawSamples(schema, 'sourceProfile.schema');
    assertNoSensitiveMetadata(input.sourceMetadata, 'sourceProfile.sourceMetadata');
    const profileId = createId('source_profile');
    const versionId = createId('source_profile_version');
    const schemaHash = await hashStableJson(schema);
    const parserOptions = isRecord(input.parserOptions)
      ? input.parserOptions
      : draft?.parser_options_json
        ? (JSON.parse(draft.parser_options_json) as Record<string, unknown>)
        : {};
    const warningSummary = normalizeWarningSummary(
      input.warningSummary,
      draft?.warning_summary_json
    );
    const sourceMetadata = {
      ...(draft?.source_metadata_json
        ? (JSON.parse(draft.source_metadata_json) as Record<string, unknown>)
        : {}),
      ...(isRecord(input.sourceMetadata) ? input.sourceMetadata : {}),
      parseDraftId: input.parseDraftId ?? null,
      rawContentPersisted: false,
    };

    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO source_profiles (
          id, tenant_id, source_type, profile_key, display_name, lifecycle_state,
          active_version_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profileId,
          tenantId,
          input.sourceType,
          input.profileKey,
          input.displayName,
          'draft',
          null,
          now,
          now,
        ]
      );
      await tx.execute(
        `INSERT INTO source_profile_versions (
          id, tenant_id, profile_id, version_label, lifecycle_state, schema_hash, schema_json,
          parser_options_json, warning_summary_json, source_metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          tenantId,
          profileId,
          input.versionLabel ?? 'v1',
          'draft',
          schemaHash,
          stableJson(schema),
          stableJson(parserOptions),
          stableJson(warningSummary),
          stableJson(sourceMetadata),
          now,
          now,
        ]
      );
    });

    return {
      id: profileId,
      tenantId,
      sourceType: input.sourceType,
      profileKey: input.profileKey,
      displayName: input.displayName,
      lifecycleState: 'draft',
      version: {
        id: versionId,
        versionLabel: input.versionLabel ?? 'v1',
        lifecycleState: 'draft',
        schemaHash,
        schema,
        warningSummary,
      },
    };
  }

  async listSourceProfiles(tenantId: string) {
    const rows = await this.adapter.query<SourceProfileRow>(
      `SELECT p.*,
              v.id AS version_id,
              v.version_label,
              v.lifecycle_state AS version_lifecycle_state,
              v.schema_hash,
              v.schema_json,
              v.warning_summary_json
         FROM source_profiles p
         LEFT JOIN source_profile_versions v
           ON v.id = COALESCE(
             (
               SELECT latest.id
                 FROM source_profile_versions latest
                WHERE latest.tenant_id = p.tenant_id
                  AND latest.profile_id = p.id
                ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.id DESC
                LIMIT 1
             ),
             p.active_version_id
           )
        WHERE p.tenant_id = ?
        ORDER BY p.updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      sourceType: row.source_type,
      profileKey: row.profile_key,
      displayName: row.display_name,
      lifecycleState: row.lifecycle_state,
      activeVersionId: row.active_version_id,
      version: row.version_id
        ? {
            id: row.version_id,
            versionLabel: row.version_label,
            lifecycleState: row.version_lifecycle_state,
            schemaHash: row.schema_hash,
            schema: row.schema_json ? (JSON.parse(row.schema_json) as Record<string, unknown>) : {},
            warningSummary: row.warning_summary_json
              ? (JSON.parse(row.warning_summary_json) as Record<string, unknown>)
              : {},
          }
        : null,
    }));
  }

  async updateSourceProfile(
    tenantId: string,
    profileId: string,
    input: UpdateSourceProfileRequest
  ) {
    validateRequiredString(profileId, 'profileId');
    const existing = await this.adapter.queryOne<{
      id: string;
      source_type: string;
      profile_key: string;
      display_name: string;
    }>(
      `SELECT id, source_type, profile_key, display_name
         FROM source_profiles
        WHERE tenant_id = ? AND id = ?`,
      [tenantId, profileId]
    );
    if (!existing) {
      throw notFound('source profile not found');
    }
    const sourceType =
      input.sourceType ?? (existing.source_type as CreateSourceProfileRequest['sourceType']);
    if (!SOURCE_PROFILE_TYPES.has(sourceType)) {
      throw badRequest('sourceType must be csv, scim, saml, or directory');
    }
    const profileKey = input.profileKey ?? existing.profile_key;
    const displayName = input.displayName ?? existing.display_name;
    validateRequiredString(profileKey, 'profileKey');
    validateRequiredString(displayName, 'displayName');
    const duplicate = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM source_profiles
        WHERE tenant_id = ?
          AND profile_key = ?
          AND id <> ?`,
      [tenantId, profileKey, profileId]
    );
    if (duplicate) {
      throw conflict('source profile key already exists');
    }

    const now = this.now();
    const draft = input.parseDraftId
      ? await this.getSourceProfileParseDraft(tenantId, input.parseDraftId, now)
      : null;
    const schema = isRecord(input.schema)
      ? input.schema
      : draft
        ? (JSON.parse(draft.schema_json) as Record<string, unknown>)
        : null;
    if (!schema) {
      throw badRequest('schema or parseDraftId is required');
    }
    assertProfileSchemaBudget(schema, 'sourceProfile.schema');
    assertProfileFieldConstraints(schema, 'sourceProfile.schema');
    assertNoSourceProfileRawSamples(schema, 'sourceProfile.schema');
    assertNoSensitiveMetadata(input.sourceMetadata, 'sourceProfile.sourceMetadata');
    const versionId = createId('source_profile_version');
    const schemaHash = await hashStableJson(schema);
    const parserOptions = isRecord(input.parserOptions)
      ? input.parserOptions
      : draft?.parser_options_json
        ? (JSON.parse(draft.parser_options_json) as Record<string, unknown>)
        : {};
    const warningSummary = normalizeWarningSummary(
      input.warningSummary,
      draft?.warning_summary_json
    );
    const sourceMetadata = {
      ...(draft?.source_metadata_json
        ? (JSON.parse(draft.source_metadata_json) as Record<string, unknown>)
        : {}),
      ...(isRecord(input.sourceMetadata) ? input.sourceMetadata : {}),
      parseDraftId: input.parseDraftId ?? null,
      rawContentPersisted: false,
    };
    const versionLabel = input.versionLabel ?? 'draft';

    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE source_profiles
            SET source_type = ?, profile_key = ?, display_name = ?, lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [sourceType, profileKey, displayName, 'draft', now, tenantId, profileId]
      );
      await tx.execute(
        `INSERT INTO source_profile_versions (
          id, tenant_id, profile_id, version_label, lifecycle_state, schema_hash, schema_json,
          parser_options_json, warning_summary_json, source_metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          tenantId,
          profileId,
          versionLabel,
          'draft',
          schemaHash,
          stableJson(schema),
          stableJson(parserOptions),
          stableJson(warningSummary),
          stableJson(sourceMetadata),
          now,
          now,
        ]
      );
    });

    return {
      id: profileId,
      tenantId,
      sourceType,
      profileKey,
      displayName,
      lifecycleState: 'draft',
      version: {
        id: versionId,
        versionLabel,
        lifecycleState: 'draft',
        schemaHash,
        schema,
        warningSummary,
      },
    };
  }

  async reviewSourceProfileVersion(tenantId: string, profileId: string, versionId: string) {
    const row = await this.adapter.queryOne<{
      warning_summary_json: string | null;
      lifecycle_state: string;
    }>(
      `SELECT warning_summary_json, lifecycle_state
         FROM source_profile_versions
        WHERE tenant_id = ? AND profile_id = ? AND id = ?`,
      [tenantId, profileId, versionId]
    );
    if (!row) {
      throw notFound('source profile version not found');
    }
    if (!SOURCE_PROFILE_VERSION_STATES.has(row.lifecycle_state)) {
      throw badRequest('source profile version lifecycle state is invalid');
    }
    const warningSummary = row.warning_summary_json
      ? (JSON.parse(row.warning_summary_json) as Record<string, unknown>)
      : {};
    const blockingCount = getNumberProperty(warningSummary, 'blockingWarningCount');
    const confirmedCount = getNumberProperty(warningSummary, 'confirmedBlockingWarningCount');
    if (blockingCount > confirmedCount) {
      throw badRequest('PII and regulated candidates must be confirmed before review');
    }
    const now = this.now();
    await this.adapter.execute(
      `UPDATE source_profile_versions
          SET lifecycle_state = ?, reviewed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND profile_id = ? AND id = ?`,
      ['reviewed', now, now, tenantId, profileId, versionId]
    );
    return { id: versionId, lifecycleState: 'reviewed', reviewedAt: now };
  }

  async activateSourceProfileVersion(tenantId: string, profileId: string, versionId: string) {
    const row = await this.adapter.queryOne<{ lifecycle_state: string }>(
      `SELECT lifecycle_state
         FROM source_profile_versions
        WHERE tenant_id = ? AND profile_id = ? AND id = ?`,
      [tenantId, profileId, versionId]
    );
    if (!row) {
      throw notFound('source profile version not found');
    }
    if (row.lifecycle_state !== 'reviewed' && row.lifecycle_state !== 'active') {
      throw badRequest('source profile version must be reviewed before activation');
    }
    const now = this.now();
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE source_profile_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND profile_id = ? AND lifecycle_state = ?`,
        ['reviewed', now, tenantId, profileId, 'active']
      );
      await tx.execute(
        `UPDATE source_profile_versions
            SET lifecycle_state = ?, activated_at = ?, updated_at = ?
          WHERE tenant_id = ? AND profile_id = ? AND id = ?`,
        ['active', now, now, tenantId, profileId, versionId]
      );
      await tx.execute(
        `UPDATE source_profiles
            SET lifecycle_state = ?, active_version_id = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        ['active', versionId, now, tenantId, profileId]
      );
    });
    return { id: versionId, lifecycleState: 'active', activatedAt: now };
  }

  async deleteSourceProfile(tenantId: string, profileId: string) {
    validateRequiredString(profileId, 'profileId');
    const existing = await this.adapter.queryOne<{ id: string }>(
      `SELECT id FROM source_profiles WHERE tenant_id = ? AND id = ?`,
      [tenantId, profileId]
    );
    if (!existing) {
      throw notFound('source profile not found');
    }
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        'DELETE FROM source_profile_versions WHERE tenant_id = ? AND profile_id = ?',
        [tenantId, profileId]
      );
      await tx.execute('DELETE FROM source_profiles WHERE tenant_id = ? AND id = ?', [
        tenantId,
        profileId,
      ]);
    });
    return { id: profileId, deleted: true };
  }

  async createAttributeGroup(tenantId: string, input: CreateAttributeGroupRequest) {
    validateRequiredString(input.protocol, 'protocol');
    validateRequiredString(input.groupType, 'groupType');
    validateRequiredString(input.groupKey, 'groupKey');
    validateRequiredString(input.displayName, 'displayName');
    validateAttributeProtocol(input.protocol);
    validateAttributeKey(input.groupKey, 'groupKey');
    if (!Array.isArray(input.fieldKeys)) {
      throw badRequest('fieldKeys must be an array');
    }
    const owner = normalizeRegistryOwner(tenantId, input.ownerScopeType, input.ownerScopeId);
    const now = this.now();
    const id = createId('attribute_group');
    await this.adapter.execute(
      `INSERT INTO attribute_group_registry (
        id, tenant_id, owner_scope_type, owner_scope_id, protocol, group_type, group_key,
        display_name, description, field_keys_json, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        owner.tenantId,
        owner.ownerScopeType,
        owner.ownerScopeId,
        input.protocol,
        input.groupType,
        input.groupKey,
        input.displayName,
        input.description ?? null,
        stableJson(input.fieldKeys.map(String).filter(Boolean)),
        'active',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId: owner.tenantId,
      ownerScopeType: owner.ownerScopeType,
      ownerScopeId: owner.ownerScopeId,
      protocol: input.protocol,
      groupType: input.groupType,
      groupKey: input.groupKey,
      displayName: input.displayName,
      description: input.description ?? null,
      fieldKeys: input.fieldKeys.map(String).filter(Boolean),
      lifecycleState: 'active',
    };
  }

  async listAttributeGroups(tenantId: string) {
    const rows = await this.adapter.query<AttributeGroupRegistryRow>(
      `SELECT *
         FROM attribute_group_registry
        WHERE tenant_id IN (?, ?)
        ORDER BY owner_scope_type ASC, protocol ASC, group_type ASC, group_key ASC`,
      [tenantId, 'platform']
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      ownerScopeType: row.owner_scope_type,
      ownerScopeId: row.owner_scope_id,
      protocol: row.protocol,
      groupType: row.group_type,
      groupKey: row.group_key,
      displayName: row.display_name,
      description: row.description,
      fieldKeys: JSON.parse(row.field_keys_json) as string[],
      lifecycleState: row.lifecycle_state,
    }));
  }

  async createAttributeField(tenantId: string, input: CreateAttributeFieldRequest) {
    validateRequiredString(input.protocol, 'protocol');
    validateRequiredString(input.fieldKey, 'fieldKey');
    validateRequiredString(input.displayName, 'displayName');
    validateAttributeProtocol(input.protocol);
    validateAttributeKey(input.fieldKey, 'fieldKey');
    if (input.protocol === 'oidc') {
      validateOidcClaimName(input.fieldKey);
      if (OIDC_RESERVED_NON_PROFILE_CLAIMS.has(input.fieldKey)) {
        throw badRequest('fieldKey is reserved by the OIDC token envelope');
      }
    }
    const owner = normalizeRegistryOwner(tenantId, input.ownerScopeType, input.ownerScopeId);
    const now = this.now();
    const surfaces =
      input.protocol === 'oidc'
        ? normalizeOidcSurfaces(input.surfaces ?? ['id_token', 'userinfo'])
        : Array.from(new Set((input.surfaces ?? []).map(String).filter(Boolean))).sort();
    const id = createId('attribute_field');
    await this.adapter.execute(
      `INSERT INTO attribute_field_registry (
        id, tenant_id, owner_scope_type, owner_scope_id, protocol, field_key, display_name,
        value_type, classification, surfaces_json, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        owner.tenantId,
        owner.ownerScopeType,
        owner.ownerScopeId,
        input.protocol,
        input.fieldKey,
        input.displayName,
        input.valueType ?? 'string',
        input.classification ?? 'internal',
        stableJson(surfaces),
        'active',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId: owner.tenantId,
      ownerScopeType: owner.ownerScopeType,
      ownerScopeId: owner.ownerScopeId,
      protocol: input.protocol,
      fieldKey: input.fieldKey,
      displayName: input.displayName,
      valueType: input.valueType ?? 'string',
      classification: input.classification ?? 'internal',
      surfaces,
      lifecycleState: 'active',
    };
  }

  async listAttributeFields(tenantId: string) {
    const rows = await this.adapter.query<AttributeFieldRegistryRow>(
      `SELECT *
         FROM attribute_field_registry
        WHERE tenant_id IN (?, ?)
        ORDER BY owner_scope_type ASC, protocol ASC, field_key ASC`,
      [tenantId, 'platform']
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      ownerScopeType: row.owner_scope_type,
      ownerScopeId: row.owner_scope_id,
      protocol: row.protocol,
      fieldKey: row.field_key,
      displayName: row.display_name,
      valueType: row.value_type,
      classification: row.classification,
      surfaces: JSON.parse(row.surfaces_json) as string[],
      lifecycleState: row.lifecycle_state,
    }));
  }

  async createDestinationProfile(tenantId: string, input: CreateDestinationProfileRequest) {
    validateRequiredString(input.destinationType, 'destinationType');
    validateRequiredString(input.profileKey, 'profileKey');
    validateRequiredString(input.displayName, 'displayName');
    if (!DESTINATION_PROFILE_TYPES.has(input.destinationType)) {
      throw badRequest('destinationType must be oidc, csv, saml, or resource_server');
    }
    if (!isRecord(input.schema)) {
      throw badRequest('schema must be an object');
    }
    assertProfileSchemaBudget(input.schema, 'destinationProfile.schema');
    assertProfileFieldConstraints(input.schema, 'destinationProfile.schema');
    assertNoDestinationProfileRawValues(input.schema, 'destinationProfile.schema');

    const owner = normalizeProfileOwner(tenantId, input.ownerScopeType, input.ownerScopeId);
    assertDestinationProfileOwner(input.destinationType, owner);
    const duplicate = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM destination_profiles
        WHERE tenant_id = ?
          AND owner_scope_type = ?
          AND COALESCE(owner_scope_id, '') = COALESCE(?, '')
          AND destination_type = ?
          AND profile_key = ?`,
      [
        owner.tenantId,
        owner.ownerScopeType,
        owner.ownerScopeId,
        input.destinationType,
        input.profileKey,
      ]
    );
    if (duplicate) {
      throw conflict('destination profile key already exists for this owner scope');
    }
    const attributeGroups = await this.listAttributeGroups(tenantId);
    const validation = validateDestinationProfileSchema(
      input.destinationType,
      input.schema,
      attributeGroups
    );
    if (validation.errorCount > 0) {
      throw badRequest(`destination profile schema is invalid: ${validation.errors.join('; ')}`);
    }
    const warningSummary = {
      ...validation.warningSummary,
      ...(isRecord(input.warningSummary) ? input.warningSummary : {}),
    };
    const releaseImpact = {
      ...validation.releaseImpact,
      ...(isRecord(input.releaseImpact) ? input.releaseImpact : {}),
    };
    const now = this.now();
    const profileId = createId('destination_profile');
    const versionId = createId('destination_profile_version');
    const schemaHash = await hashStableJson(input.schema);

    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO destination_profiles (
          id, tenant_id, destination_type, profile_key, display_name, owner_scope_type,
          owner_scope_id, base_profile_id, lifecycle_state, active_version_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profileId,
          owner.tenantId,
          input.destinationType,
          input.profileKey,
          input.displayName,
          owner.ownerScopeType,
          owner.ownerScopeId,
          input.baseProfileId ?? null,
          'draft',
          null,
          now,
          now,
        ]
      );
      await tx.execute(
        `INSERT INTO destination_profile_versions (
          id, tenant_id, profile_id, version_label, lifecycle_state, schema_hash, schema_json,
          validation_summary_json, warning_summary_json, release_impact_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          owner.tenantId,
          profileId,
          input.versionLabel ?? 'v1',
          'draft',
          schemaHash,
          stableJson(input.schema),
          stableJson(validation),
          stableJson(warningSummary),
          stableJson(releaseImpact),
          now,
          now,
        ]
      );
    });

    return {
      id: profileId,
      tenantId: owner.tenantId,
      destinationType: input.destinationType,
      profileKey: input.profileKey,
      displayName: input.displayName,
      ownerScopeType: owner.ownerScopeType,
      ownerScopeId: owner.ownerScopeId,
      lifecycleState: 'draft',
      version: {
        id: versionId,
        versionLabel: input.versionLabel ?? 'v1',
        lifecycleState: 'draft',
        schemaHash,
        schema: input.schema,
        validationSummary: validation,
        warningSummary,
        releaseImpact,
      },
    };
  }

  async listDestinationProfiles(tenantId: string) {
    const rows = await this.adapter.query<DestinationProfileRow>(
      `SELECT p.*,
              v.id AS version_id,
              v.version_label,
              v.lifecycle_state AS version_lifecycle_state,
              v.schema_hash,
              v.schema_json,
              v.validation_summary_json,
              v.warning_summary_json,
              v.release_impact_json
         FROM destination_profiles p
         LEFT JOIN destination_profile_versions v
           ON v.id = COALESCE(
             (
               SELECT latest.id
                 FROM destination_profile_versions latest
                WHERE latest.tenant_id = p.tenant_id
                  AND latest.profile_id = p.id
                ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.id DESC
                LIMIT 1
             ),
             p.active_version_id
           )
        WHERE p.tenant_id IN (?, ?)
        ORDER BY p.owner_scope_type ASC, p.updated_at DESC`,
      [tenantId, 'platform']
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      destinationType: row.destination_type,
      profileKey: row.profile_key,
      displayName: row.display_name,
      ownerScopeType: row.owner_scope_type,
      ownerScopeId: row.owner_scope_id,
      baseProfileId: row.base_profile_id,
      lifecycleState: row.lifecycle_state,
      activeVersionId: row.active_version_id,
      version: row.version_id
        ? {
            id: row.version_id,
            versionLabel: row.version_label,
            lifecycleState: row.version_lifecycle_state,
            schemaHash: row.schema_hash,
            schema: row.schema_json ? (JSON.parse(row.schema_json) as Record<string, unknown>) : {},
            validationSummary: row.validation_summary_json
              ? (JSON.parse(row.validation_summary_json) as Record<string, unknown>)
              : {},
            warningSummary: row.warning_summary_json
              ? (JSON.parse(row.warning_summary_json) as Record<string, unknown>)
              : {},
            releaseImpact: row.release_impact_json
              ? (JSON.parse(row.release_impact_json) as Record<string, unknown>)
              : {},
          }
        : null,
    }));
  }

  async updateDestinationProfile(
    tenantId: string,
    profileId: string,
    input: UpdateDestinationProfileRequest,
    allowPlatformScope = false
  ) {
    validateRequiredString(profileId, 'profileId');
    const existing = await this.adapter.queryOne<{
      id: string;
      tenant_id: string;
      destination_type: string;
      profile_key: string;
      display_name: string;
      owner_scope_type: string;
      owner_scope_id: string | null;
      base_profile_id: string | null;
    }>(
      `SELECT id, tenant_id, destination_type, profile_key, display_name,
              owner_scope_type, owner_scope_id, base_profile_id
         FROM destination_profiles
        WHERE id = ?
          AND (tenant_id = ? OR (? = 1 AND tenant_id = ?))`,
      [profileId, tenantId, allowPlatformScope ? 1 : 0, 'platform']
    );
    if (!existing) {
      throw notFound('destination profile not found');
    }

    const destinationType =
      input.destinationType ??
      (existing.destination_type as 'oidc' | 'csv' | 'saml' | 'resource_server');
    if (!DESTINATION_PROFILE_TYPES.has(destinationType)) {
      throw badRequest('destinationType must be oidc, csv, saml, or resource_server');
    }
    if (!isRecord(input.schema)) {
      throw badRequest('schema is required');
    }
    assertProfileSchemaBudget(input.schema, 'destinationProfile.schema');
    assertProfileFieldConstraints(input.schema, 'destinationProfile.schema');
    assertNoDestinationProfileRawValues(input.schema, 'destinationProfile.schema');

    const owner = normalizeProfileOwner(
      tenantId,
      input.ownerScopeType ?? (existing.owner_scope_type as 'platform' | 'tenant' | 'client'),
      input.ownerScopeId === undefined ? existing.owner_scope_id : input.ownerScopeId
    );
    assertDestinationProfileOwner(destinationType, owner);
    if (owner.tenantId === 'platform' && !allowPlatformScope) {
      throw forbidden('platform owner scope requires platform admin');
    }
    if (owner.tenantId !== existing.tenant_id) {
      throw badRequest('destination profile owner tenant cannot be changed');
    }
    const profileKey = input.profileKey ?? existing.profile_key;
    const displayName = input.displayName ?? existing.display_name;
    validateRequiredString(profileKey, 'profileKey');
    validateRequiredString(displayName, 'displayName');
    const duplicate = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM destination_profiles
        WHERE tenant_id = ?
          AND owner_scope_type = ?
          AND COALESCE(owner_scope_id, '') = COALESCE(?, '')
          AND destination_type = ?
          AND profile_key = ?
          AND id <> ?`,
      [
        owner.tenantId,
        owner.ownerScopeType,
        owner.ownerScopeId,
        destinationType,
        profileKey,
        profileId,
      ]
    );
    if (duplicate) {
      throw conflict('destination profile key already exists for this owner scope');
    }

    const attributeGroups = await this.listAttributeGroups(tenantId);
    const validation = validateDestinationProfileSchema(
      destinationType,
      input.schema,
      attributeGroups
    );
    if (validation.errorCount > 0) {
      throw badRequest(`destination profile schema is invalid: ${validation.errors.join('; ')}`);
    }
    const warningSummary = {
      ...validation.warningSummary,
      ...(isRecord(input.warningSummary) ? input.warningSummary : {}),
    };
    const releaseImpact = {
      ...validation.releaseImpact,
      ...(isRecord(input.releaseImpact) ? input.releaseImpact : {}),
    };
    const now = this.now();
    const versionId = createId('destination_profile_version');
    const versionLabel = input.versionLabel ?? 'draft';
    const schemaHash = await hashStableJson(input.schema);

    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE destination_profiles
            SET tenant_id = ?, destination_type = ?, profile_key = ?, display_name = ?,
                owner_scope_type = ?, owner_scope_id = ?, base_profile_id = ?,
                lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [
          owner.tenantId,
          destinationType,
          profileKey,
          displayName,
          owner.ownerScopeType,
          owner.ownerScopeId,
          input.baseProfileId === undefined ? existing.base_profile_id : input.baseProfileId,
          'draft',
          now,
          existing.tenant_id,
          profileId,
        ]
      );
      await tx.execute(
        `INSERT INTO destination_profile_versions (
          id, tenant_id, profile_id, version_label, lifecycle_state, schema_hash, schema_json,
          validation_summary_json, warning_summary_json, release_impact_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          owner.tenantId,
          profileId,
          versionLabel,
          'draft',
          schemaHash,
          stableJson(input.schema),
          stableJson(validation),
          stableJson(warningSummary),
          stableJson(releaseImpact),
          now,
          now,
        ]
      );
    });

    return {
      id: profileId,
      tenantId: owner.tenantId,
      destinationType,
      profileKey,
      displayName,
      ownerScopeType: owner.ownerScopeType,
      ownerScopeId: owner.ownerScopeId,
      baseProfileId:
        input.baseProfileId === undefined ? existing.base_profile_id : input.baseProfileId,
      lifecycleState: 'draft',
      version: {
        id: versionId,
        versionLabel,
        lifecycleState: 'draft',
        schemaHash,
        schema: input.schema,
        validationSummary: validation,
        warningSummary,
        releaseImpact,
      },
    };
  }

  async reviewDestinationProfileVersion(
    tenantId: string,
    profileId: string,
    versionId: string,
    allowPlatformScope = false
  ) {
    const row = await this.adapter.queryOne<{
      tenant_id: string;
      validation_summary_json: string;
      warning_summary_json: string;
      release_impact_json: string;
      lifecycle_state: string;
    }>(
      `SELECT tenant_id, validation_summary_json, warning_summary_json, release_impact_json, lifecycle_state
         FROM destination_profile_versions
        WHERE profile_id = ? AND id = ?
          AND (tenant_id = ? OR (? = 1 AND tenant_id = ?))`,
      [profileId, versionId, tenantId, allowPlatformScope ? 1 : 0, 'platform']
    );
    if (!row) {
      throw notFound('destination profile version not found');
    }
    if (!DESTINATION_PROFILE_VERSION_STATES.has(row.lifecycle_state)) {
      throw badRequest('destination profile version lifecycle state is invalid');
    }
    const validationSummary = JSON.parse(row.validation_summary_json) as Record<string, unknown>;
    const warningSummary = JSON.parse(row.warning_summary_json) as Record<string, unknown>;
    const releaseImpact = JSON.parse(row.release_impact_json) as Record<string, unknown>;
    if (getNumberProperty(validationSummary, 'errorCount') > 0) {
      throw badRequest('destination profile validation errors must be resolved before review');
    }
    if (!isRecord(releaseImpact) || Object.keys(releaseImpact).length === 0) {
      throw badRequest('release impact summary is required before review');
    }
    const blockingCount = getNumberProperty(warningSummary, 'blockingWarningCount');
    const confirmedCount = getNumberProperty(warningSummary, 'confirmedBlockingWarningCount');
    if (blockingCount > confirmedCount) {
      throw badRequest('blocking destination release warnings must be confirmed before review');
    }
    const now = this.now();
    await this.adapter.execute(
      `UPDATE destination_profile_versions
          SET lifecycle_state = ?, reviewed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND profile_id = ? AND id = ?`,
      ['reviewed', now, now, row.tenant_id, profileId, versionId]
    );
    return { id: versionId, lifecycleState: 'reviewed', reviewedAt: now };
  }

  async activateDestinationProfileVersion(
    tenantId: string,
    profileId: string,
    versionId: string,
    allowPlatformScope = false
  ) {
    const row = await this.adapter.queryOne<{
      tenant_id: string;
      lifecycle_state: string;
      destination_type: string;
      owner_scope_type: string;
      owner_scope_id: string | null;
      schema_json: string;
    }>(
      `SELECT v.tenant_id, v.lifecycle_state, v.schema_json,
              p.destination_type, p.owner_scope_type, p.owner_scope_id
         FROM destination_profile_versions v
         JOIN destination_profiles p
           ON p.tenant_id = v.tenant_id AND p.id = v.profile_id
        WHERE v.profile_id = ? AND v.id = ?
          AND (v.tenant_id = ? OR (? = 1 AND v.tenant_id = ?))`,
      [profileId, versionId, tenantId, allowPlatformScope ? 1 : 0, 'platform']
    );
    if (!row) {
      throw notFound('destination profile version not found');
    }
    if (row.lifecycle_state !== 'reviewed' && row.lifecycle_state !== 'active') {
      throw badRequest('destination profile version must be reviewed before activation');
    }
    assertDestinationProfileOwner(row.destination_type, {
      ownerScopeType: row.owner_scope_type,
      ownerScopeId: row.owner_scope_id,
    });
    let schema: unknown;
    try {
      schema = JSON.parse(row.schema_json) as unknown;
    } catch {
      throw badRequest('destination profile schema is invalid');
    }
    if (!isRecord(schema)) {
      throw badRequest('destination profile schema is invalid');
    }
    const attributeGroups = await this.listAttributeGroups(
      row.tenant_id === 'platform' ? tenantId : row.tenant_id
    );
    const validation = validateDestinationProfileSchema(
      row.destination_type,
      schema,
      attributeGroups
    );
    if (validation.errorCount > 0) {
      throw badRequest(`destination profile schema is invalid: ${validation.errors.join('; ')}`);
    }
    if (row.destination_type === 'resource_server') {
      const conflictingProfile = await this.adapter.queryOne<{ id: string }>(
        `SELECT id
           FROM destination_profiles
          WHERE tenant_id = ?
            AND destination_type = 'resource_server'
            AND owner_scope_type = 'client'
            AND owner_scope_id = ?
            AND lifecycle_state = 'active'
            AND id <> ?
          LIMIT 1`,
        [row.tenant_id, row.owner_scope_id, profileId]
      );
      if (conflictingProfile) {
        throw conflict(
          'another active Resource Server destination profile already owns this client'
        );
      }
    }
    const now = this.now();
    await this.adapter.batch([
      {
        sql: `UPDATE destination_profile_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND profile_id = ? AND lifecycle_state = ?`,
        params: ['reviewed', now, row.tenant_id, profileId, 'active'],
      },
      {
        sql: `UPDATE destination_profile_versions
            SET lifecycle_state = ?, activated_at = ?, updated_at = ?
          WHERE tenant_id = ? AND profile_id = ? AND id = ?`,
        params: ['active', now, now, row.tenant_id, profileId, versionId],
      },
      {
        sql: `UPDATE destination_profiles
            SET lifecycle_state = ?, active_version_id = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        params: ['active', versionId, now, row.tenant_id, profileId],
      },
    ]);
    return { id: versionId, lifecycleState: 'active', activatedAt: now };
  }

  async deleteDestinationProfile(tenantId: string, profileId: string, allowPlatformScope = false) {
    validateRequiredString(profileId, 'profileId');
    const existing = await this.adapter.queryOne<{ id: string; tenant_id: string }>(
      `SELECT id, tenant_id
         FROM destination_profiles
        WHERE id = ?
          AND (tenant_id = ? OR (? = 1 AND tenant_id = ?))`,
      [profileId, tenantId, allowPlatformScope ? 1 : 0, 'platform']
    );
    if (!existing) {
      throw notFound('destination profile not found');
    }
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        'DELETE FROM destination_profile_versions WHERE tenant_id = ? AND profile_id = ?',
        [existing.tenant_id, profileId]
      );
      await tx.execute('DELETE FROM destination_profiles WHERE tenant_id = ? AND id = ?', [
        existing.tenant_id,
        profileId,
      ]);
    });
    return { id: profileId, deleted: true };
  }

  async createMappingTemplate(tenantId: string, input: CreateMappingTemplateRequest) {
    validateRequiredString(input.templateKey, 'templateKey');
    validateRequiredString(input.displayName, 'displayName');
    if (!isRecord(input.template)) {
      throw badRequest('template must be an object');
    }
    const now = this.now();
    const id = createId('mapping_template');
    await this.adapter.execute(
      `INSERT INTO mapping_templates (
        id, tenant_id, template_key, template_scope, display_name, template_json,
        lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.templateKey,
        input.templateScope ?? 'tenant',
        input.displayName,
        stableJson(input.template),
        'active',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      templateKey: input.templateKey,
      templateScope: input.templateScope ?? 'tenant',
      displayName: input.displayName,
      lifecycleState: 'active',
    };
  }

  async listMappingTemplates(tenantId: string) {
    const rows = await this.adapter.query<MappingTemplateRow>(
      `SELECT * FROM mapping_templates
        WHERE tenant_id = ? OR tenant_id = ?
        ORDER BY template_scope ASC, template_key ASC`,
      [tenantId, 'default']
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      templateKey: row.template_key,
      templateScope: row.template_scope,
      displayName: row.display_name,
      template: JSON.parse(row.template_json) as Record<string, unknown>,
      lifecycleState: row.lifecycle_state,
    }));
  }

  async createFieldMappingSet(tenantId: string, input: CreateFieldMappingSetRequest) {
    validateRequiredString(input.fieldMappingKey, 'fieldMappingKey');
    validateRequiredString(input.displayName, 'displayName');
    const now = this.now();
    const id = createId('field_mapping');
    await this.adapter.execute(
      `INSERT INTO field_mapping_sets (
        id, tenant_id, field_mapping_key, display_name, description, owner_scope_type, owner_scope_id,
        lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.fieldMappingKey,
        input.displayName,
        input.description ?? null,
        input.ownerScopeType ?? 'tenant',
        input.ownerScopeId ?? null,
        'draft',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      fieldMappingKey: input.fieldMappingKey,
      displayName: input.displayName,
      description: input.description ?? null,
      lifecycleState: 'draft',
      createdAt: now,
      updatedAt: now,
    };
  }

  async listFieldMappingSets(tenantId: string) {
    const rows = await this.adapter.query<FieldMappingSetRow>(
      `SELECT * FROM field_mapping_sets WHERE tenant_id = ? ORDER BY updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      fieldMappingKey: row.field_mapping_key,
      displayName: row.display_name,
      description: row.description,
      lifecycleState: row.lifecycle_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async deleteFieldMappingSet(tenantId: string, fieldMappingSetId: string) {
    const fieldMappingSet = await this.getFieldMappingSet(tenantId, fieldMappingSetId);
    if (!fieldMappingSet) {
      throw notFound('field mapping set not found');
    }
    const activeActivation = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM field_mapping_activations
        WHERE tenant_id = ?
          AND field_mapping_set_id = ?
          AND lifecycle_state = ?
        LIMIT 1`,
      [tenantId, fieldMappingSetId, 'active']
    );
    if (activeActivation) {
      throw conflict('active field mapping set must be deactivated before deletion');
    }

    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `DELETE FROM mapping_transform_steps
          WHERE tenant_id = ?
            AND rule_id IN (
              SELECT r.id
                FROM mapping_rules r
                JOIN field_mapping_versions v
                  ON v.tenant_id = r.tenant_id
                 AND v.id = r.field_mapping_version_id
               WHERE v.tenant_id = ?
                 AND v.field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM mapping_rule_edges
          WHERE tenant_id = ?
            AND rule_id IN (
              SELECT r.id
                FROM mapping_rules r
                JOIN field_mapping_versions v
                  ON v.tenant_id = r.tenant_id
                 AND v.id = r.field_mapping_version_id
               WHERE v.tenant_id = ?
                 AND v.field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM mapping_validation_rules
          WHERE tenant_id = ?
            AND rule_id IN (
              SELECT r.id
                FROM mapping_rules r
                JOIN field_mapping_versions v
                  ON v.tenant_id = r.tenant_id
                 AND v.id = r.field_mapping_version_id
               WHERE v.tenant_id = ?
                 AND v.field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM mapping_release_rules
          WHERE tenant_id = ?
            AND field_mapping_version_id IN (
              SELECT id
                FROM field_mapping_versions
               WHERE tenant_id = ?
                 AND field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM mapping_conflict_rules
          WHERE tenant_id = ?
            AND field_mapping_version_id IN (
              SELECT id
                FROM field_mapping_versions
               WHERE tenant_id = ?
                 AND field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM dependency_graph_snapshots
          WHERE tenant_id = ?
            AND field_mapping_version_id IN (
              SELECT id
                FROM field_mapping_versions
               WHERE tenant_id = ?
                 AND field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM compiled_mapping_snapshots
          WHERE tenant_id = ?
            AND field_mapping_version_id IN (
              SELECT id
                FROM field_mapping_versions
               WHERE tenant_id = ?
                 AND field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM mapping_rules
          WHERE tenant_id = ?
            AND field_mapping_version_id IN (
              SELECT id
                FROM field_mapping_versions
               WHERE tenant_id = ?
                 AND field_mapping_set_id = ?
            )`,
        [tenantId, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM field_mapping_activations WHERE tenant_id = ? AND field_mapping_set_id = ?`,
        [tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `DELETE FROM field_mapping_versions WHERE tenant_id = ? AND field_mapping_set_id = ?`,
        [tenantId, fieldMappingSetId]
      );
      await tx.execute(`DELETE FROM field_mapping_sets WHERE tenant_id = ? AND id = ?`, [
        tenantId,
        fieldMappingSetId,
      ]);
    });

    return {
      id: fieldMappingSetId,
      tenantId,
      deleted: true,
    };
  }

  async listFieldMappingVersions(tenantId: string, fieldMappingSetId: string) {
    const rows = await this.adapter.query<FieldMappingVersionListRow>(
      `SELECT v.*,
              s.id AS snapshot_id,
              s.catalog_version_id AS snapshot_catalog_version_id,
              s.lifecycle_state AS snapshot_lifecycle_state,
              s.compiled_at AS snapshot_compiled_at
         FROM field_mapping_versions v
         LEFT JOIN compiled_mapping_snapshots s
           ON s.tenant_id = v.tenant_id
          AND s.field_mapping_version_id = v.id
          AND s.compiled_at = (
                SELECT MAX(latest.compiled_at)
                  FROM compiled_mapping_snapshots latest
                 WHERE latest.tenant_id = v.tenant_id
                   AND latest.field_mapping_version_id = v.id
              )
        WHERE v.tenant_id = ? AND v.field_mapping_set_id = ?
        ORDER BY v.updated_at DESC, v.created_at DESC`,
      [tenantId, fieldMappingSetId]
    );
    const ruleRows = await this.adapter.query<FieldMappingRuleSummaryRow>(
      `SELECT v.id AS field_mapping_version_id,
              r.id AS rule_id,
              r.rule_key,
              r.rule_kind,
              r.action,
              r.priority,
              r.metadata_json,
              e.id AS edge_id,
              e.source_ref_json,
              e.target_ref_json,
              e.edge_kind,
              e.display_order
         FROM field_mapping_versions v
         JOIN mapping_rules r
           ON r.tenant_id = v.tenant_id
          AND r.field_mapping_version_id = v.id
         LEFT JOIN mapping_rule_edges e
          ON e.tenant_id = r.tenant_id
          AND e.rule_id = r.id
        WHERE v.tenant_id = ? AND v.field_mapping_set_id = ?
        ORDER BY v.id, r.priority ASC, r.created_at ASC, e.display_order ASC`,
      [tenantId, fieldMappingSetId]
    );
    const transformRows = await this.adapter.query<FieldMappingTransformSummaryRow>(
      `SELECT v.id AS field_mapping_version_id,
              r.id AS rule_id,
              t.id AS transform_id,
              t.edge_id,
              t.step_order,
              t.operation,
              t.parameters_json
         FROM field_mapping_versions v
         JOIN mapping_rules r
           ON r.tenant_id = v.tenant_id
          AND r.field_mapping_version_id = v.id
         JOIN mapping_transform_steps t
           ON t.tenant_id = r.tenant_id
          AND t.rule_id = r.id
        WHERE v.tenant_id = ? AND v.field_mapping_set_id = ?
        ORDER BY v.id, r.priority ASC, t.step_order ASC`,
      [tenantId, fieldMappingSetId]
    );
    const summariesByVersion = new Map<
      string,
      {
        source: boolean;
        destination: boolean;
        sourceProfileIds: Set<string>;
        destinationProfileIds: Set<string>;
        rules: Map<
          string,
          {
            id: string;
            ruleKey: string;
            ruleKind: string;
            action: string;
            priority: number;
            metadata: Record<string, unknown>;
            edges: Array<{
              id: string;
              sourceRef: Record<string, unknown>;
              targetRef: Record<string, unknown>;
              edgeKind: string;
              displayOrder: number;
            }>;
            transforms: Array<{
              id: string;
              edgeId: string | null;
              stepOrder: number;
              operation: string;
              parameters: Record<string, unknown>;
            }>;
          }
        >;
      }
    >();
    for (const row of ruleRows) {
      if (typeof row.rule_kind !== 'string') continue;
      const summary = summariesByVersion.get(row.field_mapping_version_id) ?? {
        source: false,
        destination: false,
        sourceProfileIds: new Set<string>(),
        destinationProfileIds: new Set<string>(),
        rules: new Map(),
      };
      if (row.rule_kind.includes('source')) summary.source = true;
      if (row.rule_kind.includes('destination') || row.rule_kind.includes('release')) {
        summary.destination = true;
      }
      for (const profileId of profileIdsFromFieldMappingRefs(
        row.source_ref_json,
        row.target_ref_json
      )) {
        if (
          profileId.startsWith('source-profile-') ||
          profileId.startsWith('source_profile_') ||
          profileId.startsWith('external-source-')
        ) {
          summary.sourceProfileIds.add(normalizeSourceProfileReference(profileId));
        }
        if (
          profileId.startsWith('destination-profile-') ||
          profileId.startsWith('destination_profile_') ||
          profileId.startsWith('protocol-destination-')
        ) {
          summary.destinationProfileIds.add(normalizeDestinationProfileReference(profileId));
        }
      }
      const rule = summary.rules.get(row.rule_id) ?? {
        id: row.rule_id,
        ruleKey: row.rule_key,
        ruleKind: row.rule_kind,
        action: row.action,
        priority: row.priority,
        metadata: parseJsonObject(row.metadata_json ?? '{}', {}),
        edges: [],
        transforms: [],
      };
      if (row.edge_id && row.source_ref_json && row.target_ref_json) {
        rule.edges.push({
          id: row.edge_id,
          sourceRef: parseJsonObject(row.source_ref_json, {}),
          targetRef: parseJsonObject(row.target_ref_json, {}),
          edgeKind: row.edge_kind ?? 'direct',
          displayOrder: row.display_order ?? 0,
        });
      }
      summary.rules.set(row.rule_id, rule);
      summariesByVersion.set(row.field_mapping_version_id, summary);
    }
    for (const row of transformRows) {
      const summary = summariesByVersion.get(row.field_mapping_version_id);
      const rule = summary?.rules.get(row.rule_id);
      if (!summary || !rule) continue;
      rule.transforms.push({
        id: row.transform_id,
        edgeId: row.edge_id,
        stepOrder: row.step_order,
        operation: row.operation,
        parameters: parseJsonObject(row.parameters_json ?? '{}', {}),
      });
    }
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      fieldMappingSetId: row.field_mapping_set_id,
      versionLabel: row.version_label,
      lifecycleState: row.lifecycle_state,
      fieldMappingHash: row.field_mapping_hash,
      compatibilityRange: row.compatibility_range,
      authorId: row.author_id,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      directions: {
        source: summariesByVersion.get(row.id)?.source ?? false,
        destination: summariesByVersion.get(row.id)?.destination ?? false,
      },
      sourceProfileIds: [...(summariesByVersion.get(row.id)?.sourceProfileIds ?? [])],
      destinationProfileIds: [...(summariesByVersion.get(row.id)?.destinationProfileIds ?? [])],
      rules: [...(summariesByVersion.get(row.id)?.rules.values() ?? [])],
      latestSnapshot: row.snapshot_id
        ? {
            id: row.snapshot_id,
            catalogVersionId: row.snapshot_catalog_version_id,
            lifecycleState: row.snapshot_lifecycle_state,
            compiledAt: row.snapshot_compiled_at,
          }
        : null,
    }));
  }

  async createFieldMappingVersion(
    tenantId: string,
    fieldMappingSetId: string,
    input: CreateFieldMappingVersionRequest
  ) {
    validateRequiredString(fieldMappingSetId, 'fieldMappingSetId');
    validateRequiredString(input.versionLabel, 'versionLabel');
    if (!Array.isArray(input.rules)) {
      throw badRequest('rules must be an array');
    }
    if (
      input.sourceProfileIds !== undefined &&
      (!Array.isArray(input.sourceProfileIds) ||
        input.sourceProfileIds.some(
          (profileId) => typeof profileId !== 'string' || !profileId.trim()
        ))
    ) {
      throw badRequest('sourceProfileIds must be an array of non-empty strings');
    }
    assertFieldMappingVersionRequestSafe(input);

    const fieldMappingSet = await this.getFieldMappingSet(tenantId, fieldMappingSetId);
    if (!fieldMappingSet) {
      throw notFound('field mapping set not found');
    }
    await this.assertMappingRequiredSourceFieldsConnected(tenantId, input);
    const existingVersion = await this.adapter.queryOne<{ id: string }>(
      `SELECT id FROM field_mapping_versions
        WHERE tenant_id = ? AND field_mapping_set_id = ? AND version_label = ?`,
      [tenantId, fieldMappingSetId, input.versionLabel]
    );
    if (existingVersion) {
      throw conflict('field mapping version label already exists');
    }

    const now = this.now();
    const versionId = createId('field_mapping_version');
    const fieldMappingHash = await hashStableJson({
      fieldMappingSetId,
      versionLabel: input.versionLabel,
      rules: input.rules,
    });
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO field_mapping_versions (
          id, tenant_id, field_mapping_set_id, version_label, lifecycle_state, field_mapping_hash,
          compatibility_range, author_id, published_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          tenantId,
          fieldMappingSetId,
          input.versionLabel,
          'draft',
          fieldMappingHash,
          input.compatibilityRange ?? null,
          input.authorId ?? null,
          null,
          now,
          now,
        ]
      );

      for (const rule of input.rules) {
        await this.insertFieldMappingRule(tx, tenantId, versionId, rule, now);
      }
    });

    return {
      id: versionId,
      tenantId,
      fieldMappingSetId,
      versionLabel: input.versionLabel,
      lifecycleState: 'draft',
      fieldMappingHash,
      compatibilityRange: input.compatibilityRange ?? null,
    };
  }

  private async assertMappingRequiredSourceFieldsConnected(
    tenantId: string,
    input: CreateFieldMappingVersionRequest
  ): Promise<void> {
    const sourceRefs = input.rules.flatMap((rule) =>
      (rule.edges ?? []).map((edge) => edge.sourceRef)
    );
    const profileRefs = new Set(input.sourceProfileIds ?? []);
    for (const sourceRef of sourceRefs) {
      const profileId = readStringValue(sourceRef.profileId);
      if (profileId && isSourceProfileMappingReference(profileId)) {
        profileRefs.add(profileId);
      }
    }
    if (profileRefs.size === 0) return;

    const rows = await this.adapter.query<{
      id: string;
      profile_key: string;
      source_type: string;
      schema_json: string | null;
    }>(
      `SELECT p.id, p.profile_key, p.source_type, v.schema_json
         FROM source_profiles p
         LEFT JOIN source_profile_versions v
           ON v.id = COALESCE(
             (
               SELECT latest.id
                 FROM source_profile_versions latest
                WHERE latest.tenant_id = p.tenant_id
                  AND latest.profile_id = p.id
                ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.id DESC
                LIMIT 1
             ),
             p.active_version_id
           )
        WHERE p.tenant_id = ?`,
      [tenantId]
    );

    const missing: string[] = [];
    for (const profileRef of profileRefs) {
      if (!isSourceProfileMappingReference(profileRef)) continue;
      const candidates = sourceProfileReferenceCandidates(profileRef);
      const profile = rows.find((row) => candidates.includes(row.id));
      if (!profile?.schema_json) {
        throw badRequest(`source profile referenced by mapping was not found: ${profileRef}`);
      }
      const schema = parseJsonObject(profile.schema_json, {});
      const requiredFields = mappingRequiredSourceFields(schema);
      if (requiredFields.length === 0) continue;

      const connectedPaths = new Set(
        sourceRefs.flatMap((sourceRef) => {
          const sourceRefProfileId = readStringValue(sourceRef.profileId);
          if (
            sourceRefProfileId &&
            !sourceProfileReferenceCandidates(sourceRefProfileId).includes(profile.id)
          ) {
            return [];
          }
          if (!sourceRefProfileId && profileRefs.size > 1) return [];
          const path = readStringValue(sourceRef.path);
          return path ? [path] : [];
        })
      );
      for (const field of requiredFields) {
        if (!field.aliases.some((alias) => connectedPaths.has(alias))) {
          missing.push(`${profile.profile_key}:${field.displayName}`);
        }
      }
    }

    if (missing.length > 0) {
      throw badRequest(`mapping-required source fields are not connected: ${missing.join(', ')}`);
    }
  }

  async publishFieldMappingVersion(
    tenantId: string,
    fieldMappingSetId: string,
    fieldMappingVersionId: string
  ) {
    const version = await this.getFieldMappingVersion(
      tenantId,
      fieldMappingSetId,
      fieldMappingVersionId
    );
    if (!version) {
      throw notFound('field mapping version not found');
    }
    const now = this.now();
    await this.adapter.execute(
      `UPDATE field_mapping_versions
          SET lifecycle_state = ?, published_at = ?, updated_at = ?
        WHERE tenant_id = ? AND field_mapping_set_id = ? AND id = ?`,
      ['published', now, now, tenantId, fieldMappingSetId, fieldMappingVersionId]
    );
    return {
      id: fieldMappingVersionId,
      tenantId,
      fieldMappingSetId,
      lifecycleState: 'published',
      publishedAt: now,
    };
  }

  async compileFieldMappingVersion(
    tenantId: string,
    fieldMappingSetId: string,
    fieldMappingVersionId: string,
    input: CompileFieldMappingRequest
  ) {
    validateRequiredString(input.catalogVersionId, 'catalogVersionId');
    const version = await this.getFieldMappingVersion(
      tenantId,
      fieldMappingSetId,
      fieldMappingVersionId
    );
    if (!version) {
      throw notFound('field mapping version not found');
    }
    const catalogVersion = await this.getCatalogVersion(tenantId, input.catalogVersionId);
    if (!catalogVersion) {
      throw notFound('catalog version not found');
    }
    assertNoSensitiveMetadata(input.metadata, 'metadata');

    const now = this.now();
    const dependencyGraph = {
      fieldMappingVersionId,
      fieldMappingHash: version.field_mapping_hash,
      catalogVersionId: catalogVersion.id,
      catalogHash: catalogVersion.bundle_hash,
      trustContextSnapshotId: null,
    };
    const graphHash = await hashStableJson(dependencyGraph);
    const snapshotHash = await hashStableJson({
      type: 'compiled_mapping_snapshot',
      dependencyGraph,
      compatibilityRange:
        input.compatibilityRange ??
        version.compatibility_range ??
        catalogVersion.compatibility_range,
    });
    const snapshotId = createId('mapping_snapshot');
    const graphId = createId('dependency_graph');

    await this.adapter.execute(
      `INSERT INTO dependency_graph_snapshots (
        id, tenant_id, field_mapping_version_id, snapshot_hash, graph_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [graphId, tenantId, fieldMappingVersionId, graphHash, stableJson(dependencyGraph), now]
    );
    await this.adapter.execute(
      `INSERT INTO compiled_mapping_snapshots (
        id, tenant_id, field_mapping_version_id, catalog_version_id, snapshot_hash, compatibility_range,
        artifact_ref, lifecycle_state, compiled_at, activated_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        tenantId,
        fieldMappingVersionId,
        catalogVersion.id,
        snapshotHash,
        input.compatibilityRange ??
          version.compatibility_range ??
          catalogVersion.compatibility_range,
        input.artifactRef ?? null,
        'draft',
        now,
        null,
        null,
        stableJson({
          ...(input.metadata ?? {}),
          dependencyGraphId: graphId,
          loadTimeHashVerified: true,
        }),
      ]
    );

    return {
      id: snapshotId,
      tenantId,
      fieldMappingVersionId,
      catalogVersionId: catalogVersion.id,
      snapshotHash,
      dependencyGraphId: graphId,
      lifecycleState: 'draft',
    };
  }

  async activateFieldMappingVersion(
    tenantId: string,
    fieldMappingSetId: string,
    fieldMappingVersionId: string,
    input: ActivateFieldMappingRequest
  ) {
    validateRequiredString(input.snapshotId, 'snapshotId');
    const version = await this.getFieldMappingVersion(
      tenantId,
      fieldMappingSetId,
      fieldMappingVersionId
    );
    if (!version) {
      throw notFound('field mapping version not found');
    }
    const snapshot = await this.getSnapshot(tenantId, fieldMappingVersionId, input.snapshotId);
    if (!snapshot) {
      throw notFound('compiled snapshot not found');
    }
    await this.assertSensitiveMappingReleaseSafety(
      tenantId,
      fieldMappingVersionId,
      snapshot.catalog_version_id
    );
    const now = this.now();
    if (snapshot.lifecycle_state === 'active') {
      const existingActivation = await this.adapter.queryOne<{ id: string }>(
        `SELECT id
           FROM field_mapping_activations
          WHERE tenant_id = ?
            AND field_mapping_set_id = ?
            AND field_mapping_version_id = ?
            AND lifecycle_state = ?
          LIMIT 1`,
        [tenantId, fieldMappingSetId, fieldMappingVersionId, 'active']
      );
      if (existingActivation) {
        await this.adapter.transaction(async (tx) => {
          await tx.execute(
            `UPDATE field_mapping_versions
                SET lifecycle_state = ?, updated_at = ?
              WHERE tenant_id = ?
                AND field_mapping_set_id = ?
                AND id <> ?
                AND lifecycle_state = ?`,
            ['published', now, tenantId, fieldMappingSetId, fieldMappingVersionId, 'active']
          );
          await tx.execute(
            `UPDATE compiled_mapping_snapshots
                SET lifecycle_state = ?, activated_at = ?
              WHERE tenant_id = ?
                AND field_mapping_version_id IN (
                  SELECT id
                    FROM field_mapping_versions
                   WHERE tenant_id = ?
                     AND field_mapping_set_id = ?
                     AND id <> ?
                )
                AND lifecycle_state = ?`,
            ['retired', now, tenantId, tenantId, fieldMappingSetId, fieldMappingVersionId, 'active']
          );
          await tx.execute(
            `UPDATE field_mapping_versions
                SET lifecycle_state = ?, updated_at = ?
              WHERE tenant_id = ? AND field_mapping_set_id = ? AND id = ?`,
            ['active', now, tenantId, fieldMappingSetId, fieldMappingVersionId]
          );
          await tx.execute(
            `UPDATE field_mapping_sets
                SET lifecycle_state = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
            ['active', now, tenantId, fieldMappingSetId]
          );
        });
        return {
          id: existingActivation.id,
          tenantId,
          fieldMappingSetId,
          fieldMappingVersionId,
          snapshotId: input.snapshotId,
          lifecycleState: 'active',
          alreadyActive: true,
        };
      }
      // A snapshot without an activation is not live. Continue through the normal activation
      // transaction so the complete activation record is restored.
    }

    const holderId = input.holderId ?? createId('activation_holder');
    const leaseKey = `field_mapping:${fieldMappingSetId}:activate`;
    await this.acquireActivationLease(tenantId, leaseKey, holderId, now);

    const activationId = createId('mapping_activation');
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE field_mapping_activations
            SET lifecycle_state = ?, active_until = ?, updated_at = ?
          WHERE tenant_id = ? AND field_mapping_set_id = ? AND lifecycle_state = ?`,
        ['retired', now, now, tenantId, fieldMappingSetId, 'active']
      );
      await tx.execute(
        `UPDATE compiled_mapping_snapshots
            SET lifecycle_state = ?, activated_at = ?
          WHERE tenant_id = ?
            AND field_mapping_version_id IN (
              SELECT id
                FROM field_mapping_versions
               WHERE tenant_id = ? AND field_mapping_set_id = ?
            )
            AND lifecycle_state = ?`,
        ['retired', now, tenantId, tenantId, fieldMappingSetId, 'active']
      );
      await tx.execute(
        `INSERT INTO field_mapping_activations (
          id, tenant_id, field_mapping_set_id, field_mapping_version_id, activation_scope_json,
          lifecycle_state, active_from, active_until, activated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          activationId,
          tenantId,
          fieldMappingSetId,
          fieldMappingVersionId,
          stableJson(input.activationScope),
          'active',
          now,
          null,
          now,
          now,
          now,
        ]
      );
      await tx.execute(
        `UPDATE field_mapping_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ?
            AND field_mapping_set_id = ?
            AND id <> ?
            AND lifecycle_state = ?`,
        ['published', now, tenantId, fieldMappingSetId, fieldMappingVersionId, 'active']
      );
      await tx.execute(
        `UPDATE field_mapping_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND field_mapping_set_id = ? AND id = ?`,
        ['active', now, tenantId, fieldMappingSetId, fieldMappingVersionId]
      );
      await tx.execute(
        `UPDATE field_mapping_sets
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        ['active', now, tenantId, fieldMappingSetId]
      );
      await tx.execute(
        `UPDATE compiled_mapping_snapshots
            SET lifecycle_state = ?, activated_at = ?
          WHERE tenant_id = ? AND field_mapping_version_id = ? AND id = ?`,
        ['active', now, tenantId, fieldMappingVersionId, input.snapshotId]
      );
    });

    return {
      id: activationId,
      tenantId,
      fieldMappingSetId,
      fieldMappingVersionId,
      snapshotId: input.snapshotId,
      lifecycleState: 'active',
      activatedAt: now,
      holderId,
    };
  }

  async deactivateFieldMappingVersion(
    tenantId: string,
    fieldMappingSetId: string,
    fieldMappingVersionId: string
  ) {
    const now = this.now();
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE field_mapping_activations
            SET lifecycle_state = ?, active_until = ?, updated_at = ?
          WHERE tenant_id = ? AND field_mapping_set_id = ? AND field_mapping_version_id = ? AND lifecycle_state = ?`,
        ['retired', now, now, tenantId, fieldMappingSetId, fieldMappingVersionId, 'active']
      );
      await tx.execute(
        `UPDATE compiled_mapping_snapshots
            SET lifecycle_state = ?, activated_at = ?
          WHERE tenant_id = ? AND field_mapping_version_id = ? AND lifecycle_state = ?`,
        ['retired', now, tenantId, fieldMappingVersionId, 'active']
      );
      await tx.execute(
        `UPDATE field_mapping_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND field_mapping_set_id = ? AND id = ? AND lifecycle_state = ?`,
        ['published', now, tenantId, fieldMappingSetId, fieldMappingVersionId, 'active']
      );
      await tx.execute(
        `UPDATE field_mapping_sets
            SET lifecycle_state = CASE
                  WHEN EXISTS (
                    SELECT 1
                      FROM field_mapping_activations a
                     WHERE a.tenant_id = ?
                       AND a.field_mapping_set_id = ?
                       AND a.lifecycle_state = ?
                  ) THEN ?
                  ELSE ?
                END,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [
          tenantId,
          fieldMappingSetId,
          'active',
          'active',
          'published',
          now,
          tenantId,
          fieldMappingSetId,
        ]
      );
    });
    return {
      id: fieldMappingVersionId,
      tenantId,
      fieldMappingSetId,
      lifecycleState: 'published',
      deactivatedAt: now,
    };
  }

  async rollbackFieldMappingSet(tenantId: string, fieldMappingSetId: string) {
    const previous = await this.adapter.queryOne<{
      id: string;
      field_mapping_version_id: string;
      active_from: number | null;
    }>(
      `SELECT id, field_mapping_version_id, active_from
         FROM field_mapping_activations
        WHERE tenant_id = ? AND field_mapping_set_id = ? AND lifecycle_state = ?
        ORDER BY active_from DESC, activated_at DESC
        LIMIT 1`,
      [tenantId, fieldMappingSetId, 'retired']
    );
    if (!previous) {
      throw conflict('no retired activation is available for rollback');
    }
    const now = this.now();
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE field_mapping_activations
            SET lifecycle_state = ?, active_until = ?, updated_at = ?
          WHERE tenant_id = ? AND field_mapping_set_id = ? AND lifecycle_state = ?`,
        ['retired', now, now, tenantId, fieldMappingSetId, 'active']
      );
      await tx.execute(
        `UPDATE field_mapping_activations
            SET lifecycle_state = ?, active_until = ?, activated_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        ['active', null, now, now, tenantId, previous.id]
      );
      await tx.execute(
        `UPDATE field_mapping_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND field_mapping_set_id = ? AND id = ?`,
        ['active', now, tenantId, fieldMappingSetId, previous.field_mapping_version_id]
      );
    });
    return {
      id: previous.id,
      tenantId,
      fieldMappingSetId,
      fieldMappingVersionId: previous.field_mapping_version_id,
      lifecycleState: 'active',
      rolledBackAt: now,
    };
  }

  async createSourceAuthorityContract(
    tenantId: string,
    input: CreateSourceAuthorityContractRequest
  ) {
    validateRequiredString(input.sourceType, 'sourceType');
    validateRequiredString(input.sourceId, 'sourceId');
    if (!isRecord(input.fieldRef)) {
      throw badRequest('fieldRef must be an object');
    }
    if (!Array.isArray(input.authorityActions) || input.authorityActions.length === 0) {
      throw badRequest('authorityActions must contain at least one action');
    }
    input.authorityActions.forEach((action) => validateRequiredString(action, 'authorityAction'));
    assertNoSensitiveMetadata(input.fieldRef, 'fieldRef');
    assertNoSensitiveMetadata(input.condition, 'condition');

    const now = this.now();
    const id = createId('source_authority');
    await this.adapter.execute(
      `INSERT INTO source_authority_contracts (
        id, tenant_id, source_type, source_id, field_ref_json, authority_actions_json,
        condition_json, priority, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.sourceType,
        input.sourceId,
        stableJson(input.fieldRef),
        stableJson(input.authorityActions),
        input.condition ? stableJson(input.condition) : null,
        input.priority ?? 0,
        'active',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      fieldRef: input.fieldRef,
      authorityActions: input.authorityActions,
      priority: input.priority ?? 0,
      lifecycleState: 'active',
    };
  }

  async listSourceAuthorityContracts(tenantId: string) {
    const rows = await this.adapter.query<{
      id: string;
      tenant_id: string;
      source_type: string;
      source_id: string;
      field_ref_json: string;
      authority_actions_json: string;
      condition_json: string | null;
      priority: number;
      lifecycle_state: string;
    }>(
      `SELECT *
         FROM source_authority_contracts
        WHERE tenant_id = ?
        ORDER BY priority DESC, updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      fieldRef: JSON.parse(row.field_ref_json) as Record<string, unknown>,
      authorityActions: JSON.parse(row.authority_actions_json) as string[],
      condition: row.condition_json
        ? (JSON.parse(row.condition_json) as Record<string, unknown>)
        : null,
      priority: row.priority,
      lifecycleState: row.lifecycle_state,
    }));
  }

  async evaluateSourceAuthorityContract(
    tenantId: string,
    input: EvaluateSourceAuthorityContractRequest
  ) {
    validateRequiredString(input.sourceType, 'sourceType');
    validateRequiredString(input.sourceId, 'sourceId');
    validateRequiredString(input.authorityAction, 'authorityAction');
    if (!isRecord(input.fieldRef)) {
      throw badRequest('fieldRef must be an object');
    }
    assertNoSensitiveMetadata(input.fieldRef, 'fieldRef');

    const requestedFieldRef = stableJson(input.fieldRef);
    const rows = await this.adapter.query<{
      id: string;
      tenant_id: string;
      source_type: string;
      source_id: string;
      field_ref_json: string;
      authority_actions_json: string;
      condition_json: string | null;
      priority: number;
      lifecycle_state: string;
    }>(
      `SELECT *
         FROM source_authority_contracts
        WHERE tenant_id = ?
          AND source_type = ?
          AND source_id = ?
          AND lifecycle_state = ?
        ORDER BY priority DESC, updated_at DESC`,
      [tenantId, input.sourceType, input.sourceId, 'active']
    );

    const matched = rows.find((row) => {
      const actions = JSON.parse(row.authority_actions_json) as string[];
      return row.field_ref_json === requestedFieldRef && actions.includes(input.authorityAction);
    });

    return {
      allowed: Boolean(matched),
      contractId: matched?.id ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      authorityAction: input.authorityAction,
      fieldRef: input.fieldRef,
      reasonCode: matched
        ? 'source_authority.allowed'
        : 'source_authority.no_matching_active_contract',
    };
  }

  async recordMappingEvent(tenantId: string, input: RecordMappingEventRequest) {
    validateRequiredString(input.eventType, 'eventType');
    validateRequiredString(input.outcome, 'outcome');
    const now = this.now();
    const id = createId('mapping_event');
    await this.adapter.execute(
      `INSERT INTO mapping_events (
        id, tenant_id, event_type, field_mapping_version_id, subject_id, source_id,
        outcome, reason_codes_json, trace_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.eventType,
        input.fieldMappingVersionId ?? null,
        input.subjectId ?? null,
        input.sourceId ?? null,
        input.outcome,
        stableJson(input.reasonCodes ?? []),
        input.traceRef ?? null,
        now,
      ]
    );
    return {
      id,
      tenantId,
      eventType: input.eventType,
      outcome: input.outcome,
      reasonCodes: input.reasonCodes ?? [],
      createdAt: now,
    };
  }

  async enqueueProjectionOutbox(tenantId: string, input: EnqueueProjectionOutboxRequest) {
    validateRequiredString(input.eventType, 'eventType');
    validateRequiredString(input.aggregateType, 'aggregateType');
    validateRequiredString(input.aggregateId, 'aggregateId');
    assertNoSensitiveMetadata(input.payload, 'payload');
    const now = this.now();
    const id = createId('projection_outbox');
    await this.adapter.execute(
      `INSERT INTO projection_outbox (
        id, tenant_id, event_type, subject_id, aggregate_type, aggregate_id,
        payload_json, status, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.eventType,
        input.subjectId ?? null,
        input.aggregateType,
        input.aggregateId,
        input.payload ? stableJson(input.payload) : null,
        'pending',
        input.availableAt ?? now,
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      status: 'pending',
      availableAt: input.availableAt ?? now,
    };
  }

  async createProjectionJob(tenantId: string, input: CreateProjectionJobRequest) {
    validateRequiredString(input.jobType, 'jobType');
    if (!isRecord(input.scope)) {
      throw badRequest('scope must be an object');
    }
    assertNoSensitiveMetadata(input.scope, 'scope');
    const now = this.now();
    const id = createId('projection_job');
    await this.adapter.execute(
      `INSERT INTO projection_jobs (
        id, tenant_id, job_type, scope_json, status, cursor_json,
        started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, input.jobType, stableJson(input.scope), 'queued', null, null, null, now, now]
    );
    return {
      id,
      tenantId,
      jobType: input.jobType,
      status: 'queued',
    };
  }

  async createReplayJob(tenantId: string, input: CreateReplayJobRequest) {
    validateRequiredString(input.replayType, 'replayType');
    if (!isRecord(input.impactScope)) {
      throw badRequest('impactScope must be an object');
    }
    assertNoSensitiveMetadata(input.impactScope, 'impactScope');
    const now = this.now();
    const id = createId('replay_job');
    await this.adapter.execute(
      `INSERT INTO replay_jobs (
        id, tenant_id, replay_type, impact_scope_json, status, cursor_json,
        result_summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.replayType,
        stableJson(input.impactScope),
        'queued',
        null,
        null,
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      replayType: input.replayType,
      status: 'queued',
    };
  }

  async upsertAdminSearchProjection(tenantId: string, input: UpsertAdminSearchProjectionRequest) {
    validateRequiredString(input.projectionKind, 'projectionKind');
    if (!isRecord(input.projection)) {
      throw badRequest('projection must be an object');
    }
    assertNoSensitiveMetadata(input.projection, 'projection');
    const now = this.now();
    const id = input.id ?? createId('admin_search_projection');
    await this.adapter.execute(
      `INSERT INTO admin_search_projections (
        id, tenant_id, subject_id, account_id, projection_kind, projection_json,
        classification, lifecycle_state, indexed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        projection_json = excluded.projection_json,
        classification = excluded.classification,
        lifecycle_state = excluded.lifecycle_state,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at`,
      [
        id,
        tenantId,
        input.subjectId ?? null,
        input.accountId ?? null,
        input.projectionKind,
        stableJson(input.projection),
        input.classification ?? 'internal',
        input.lifecycleState ?? 'active',
        now,
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      projectionKind: input.projectionKind,
      classification: input.classification ?? 'internal',
      lifecycleState: input.lifecycleState ?? 'active',
      indexedAt: now,
    };
  }

  async createReviewTask(tenantId: string, input: CreateReviewTaskRequest) {
    validateRequiredString(input.taskType, 'taskType');
    if (!isRecord(input.payload)) {
      throw badRequest('payload must be an object');
    }
    assertNoReviewPayloadRawIdentifiers(input.payload, 'payload');

    const now = this.now();
    const id = createId('review_task');
    await this.adapter.execute(
      `INSERT INTO review_tasks (
        id, tenant_id, task_type, subject_id, account_id, status, priority,
        assigned_to, payload_json, due_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.taskType,
        input.subjectId ?? null,
        input.accountId ?? null,
        'open',
        input.priority ?? 0,
        input.assignedTo ?? null,
        stableJson(input.payload),
        input.dueAt ?? null,
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      taskType: input.taskType,
      status: 'open',
      priority: input.priority ?? 0,
      payload: input.payload,
    };
  }

  async listReviewTasks(tenantId: string, options: ListReviewTasksOptions = {}) {
    const where = ['tenant_id = ?'];
    const params: Array<string | number> = [tenantId];

    if (options.status) {
      if (!REVIEW_TASK_STATUSES.has(options.status)) {
        throw badRequest('status is not supported for review task filters');
      }
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.taskType) {
      where.push('task_type = ?');
      params.push(options.taskType);
    }
    if (options.assignedTo) {
      where.push('assigned_to = ?');
      params.push(options.assignedTo);
    }

    const limit = clampListLimit(options.limit, 50, 200);
    params.push(limit);

    const rows = await this.adapter.query<{
      id: string;
      tenant_id: string;
      task_type: string;
      subject_id: string | null;
      account_id: string | null;
      status: string;
      priority: number;
      assigned_to: string | null;
      payload_json: string;
      due_at: number | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT
        id, tenant_id, task_type, subject_id, account_id, status, priority,
        assigned_to, payload_json, due_at, created_at, updated_at
      FROM review_tasks
      WHERE ${where.join(' AND ')}
      ORDER BY priority DESC, created_at ASC
      LIMIT ?`,
      params
    );

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      taskType: row.task_type,
      subjectId: row.subject_id,
      accountId: row.account_id,
      status: row.status,
      priority: row.priority,
      assignedTo: row.assigned_to,
      payload: parseReviewTaskPayload(row.payload_json),
      dueAt: row.due_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async transitionReviewTask(
    tenantId: string,
    reviewTaskId: string,
    input: TransitionReviewTaskRequest
  ) {
    validateRequiredString(reviewTaskId, 'reviewTaskId');
    validateRequiredString(input.status, 'status');
    if (!REVIEW_TASK_STATUSES.has(input.status)) {
      throw badRequest('status is not supported for review task transitions');
    }
    const existing = await this.adapter.queryOne<{
      id: string;
      status: string;
      subject_id: string | null;
      account_id: string | null;
    }>(
      'SELECT id, status, subject_id, account_id FROM review_tasks WHERE tenant_id = ? AND id = ?',
      [tenantId, reviewTaskId]
    );
    if (!existing) {
      throw notFound('review task not found');
    }
    if (existing.status === input.status) {
      return {
        id: reviewTaskId,
        status: input.status,
        idempotent: true,
      };
    }

    const now = this.now();
    await this.adapter.execute(
      `UPDATE review_tasks
          SET status = ?, assigned_to = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [input.status, input.assignedTo ?? null, now, tenantId, reviewTaskId]
    );
    await this.recordMappingEvent(tenantId, {
      eventType: 'review_task.transition',
      subjectId: existing.subject_id ?? undefined,
      outcome: input.status,
      reasonCodes: input.reasonCodes ?? [],
      traceRef: `review_task:${reviewTaskId}`,
    });
    return {
      id: reviewTaskId,
      previousStatus: existing.status,
      status: input.status,
      idempotent: false,
    };
  }

  async createReviewTaskGroup(tenantId: string, input: CreateReviewTaskGroupRequest) {
    validateRequiredString(input.groupKey, 'groupKey');
    if (!isRecord(input.summary)) {
      throw badRequest('summary must be an object');
    }
    assertNoReviewPayloadRawIdentifiers(input.summary, 'summary');

    const now = this.now();
    const id = createId('review_task_group');
    await this.adapter.execute(
      `INSERT INTO review_task_groups (
        id, tenant_id, group_key, status, summary_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, group_key) DO UPDATE SET
        summary_json = excluded.summary_json,
        updated_at = excluded.updated_at`,
      [id, tenantId, input.groupKey, 'open', stableJson(input.summary), now, now]
    );
    const group = await this.adapter.queryOne<{
      id: string;
      status: string;
      summary_json: string | null;
    }>(
      `SELECT id, status, summary_json
         FROM review_task_groups
        WHERE tenant_id = ? AND group_key = ?
        LIMIT 1`,
      [tenantId, input.groupKey]
    );
    return {
      id: group?.id ?? id,
      tenantId,
      groupKey: input.groupKey,
      status: group?.status ?? 'open',
      summary: group?.summary_json ? parseJsonObject(group.summary_json, {}) : input.summary,
    };
  }

  async enqueueOperationalNotification(
    tenantId: string,
    input: EnqueueOperationalNotificationRequest
  ) {
    validateRequiredString(input.category, 'category');
    validateRequiredString(input.eventType, 'eventType');
    validateRequiredString(input.severity, 'severity');
    validateRequiredString(input.subjectType, 'subjectType');
    validateRequiredString(input.subjectId, 'subjectId');
    if (!IDENTITY_MAPPING_NOTIFICATION_CATEGORIES.has(input.category)) {
      throw badRequest('category is not supported for identity mapping notifications');
    }
    if (!OPERATIONAL_NOTIFICATION_SEVERITIES.has(input.severity)) {
      throw badRequest('severity is not supported for operational notifications');
    }
    if (!isRecord(input.payload)) {
      throw badRequest('payload must be an object');
    }
    assertNoReviewPayloadRawIdentifiers(input.payload, 'payload');

    const now = this.now();
    const deduplicationKey = input.deduplicationKey
      ? `${tenantId}:${input.deduplicationKey}`
      : null;
    if (deduplicationKey) {
      const existing = await this.adapter.queryOne<{
        id: string;
        notification_event_id: string;
        state: string;
      }>(
        `SELECT s.id, s.notification_event_id, s.state
           FROM operational_notification_states s
           JOIN internal_notification_events e ON e.id = s.notification_event_id
          WHERE e.tenant_id = ? AND e.deduplication_key = ?
          LIMIT 1`,
        [tenantId, deduplicationKey]
      );
      if (existing) {
        return {
          id: existing.id,
          tenantId,
          notificationEventId: existing.notification_event_id,
          state: existing.state,
          severity: input.severity,
          category: input.category,
          idempotent: true,
        };
      }
    }

    const notificationEventId = createId('notification_event');
    const stateId = createId('operational_notification_state');
    await this.adapter.execute(
      `INSERT INTO internal_notification_events (
        id, tenant_id, category, event_type, severity, status, deduplication_key,
        payload_json, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        notificationEventId,
        tenantId,
        input.category,
        input.eventType,
        input.severity,
        'pending',
        deduplicationKey,
        stableJson(input.payload),
        0,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      ]
    );
    await this.adapter.execute(
      `INSERT INTO operational_notification_states (
        id, tenant_id, notification_event_id, subject_type, subject_id, state,
        assigned_to, acknowledged_at, resolved_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        stateId,
        tenantId,
        notificationEventId,
        input.subjectType,
        input.subjectId,
        'open',
        null,
        null,
        null,
        now,
        now,
      ]
    );
    return {
      id: stateId,
      tenantId,
      notificationEventId,
      state: 'open',
      severity: input.severity,
      category: input.category,
    };
  }

  async transitionOperationalNotificationState(
    tenantId: string,
    stateId: string,
    input: TransitionOperationalNotificationStateRequest
  ) {
    validateRequiredString(stateId, 'stateId');
    if (!OPERATIONAL_NOTIFICATION_STATES.has(input.state) || input.state === 'open') {
      throw badRequest('state is not supported for notification state transitions');
    }
    const existing = await this.adapter.queryOne<{
      id: string;
      state: string;
    }>('SELECT id, state FROM operational_notification_states WHERE tenant_id = ? AND id = ?', [
      tenantId,
      stateId,
    ]);
    if (!existing) {
      throw notFound('notification state not found');
    }
    if (existing.state === input.state) {
      return {
        id: stateId,
        state: input.state,
        idempotent: true,
      };
    }

    const now = this.now();
    await this.adapter.execute(
      `UPDATE operational_notification_states
          SET state = ?,
              assigned_to = ?,
              acknowledged_at = CASE WHEN ? = 'acknowledged' THEN ? ELSE acknowledged_at END,
              resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END,
              updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        input.state,
        input.assignedTo ?? null,
        input.state,
        now,
        input.state,
        now,
        now,
        tenantId,
        stateId,
      ]
    );
    return {
      id: stateId,
      previousState: existing.state,
      state: input.state,
      idempotent: false,
    };
  }

  async createGroup(tenantId: string, input: CreateGroupRequest) {
    validateRequiredString(input.groupKey, 'groupKey');
    validateRequiredString(input.displayName, 'displayName');
    if (input.metadata) {
      assertNoSensitiveMetadata(input.metadata, 'metadata');
    }
    return this.adapter.transaction((tx) => this.upsertGroup(tenantId, input, tx));
  }

  private async upsertGroup(
    tenantId: string,
    input: CreateGroupRequest,
    executor: SqlQueryExecutor
  ) {
    const now = this.now();
    const id = createId('group');
    await executor.execute(
      `INSERT INTO "groups" (
        id, tenant_id, group_key, display_name, description, parent_group_id,
        lifecycle_state, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, group_key) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        parent_group_id = excluded.parent_group_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
      [
        id,
        tenantId,
        input.groupKey,
        input.displayName,
        input.description ?? null,
        input.parentGroupId ?? null,
        'active',
        input.metadata ? stableJson(input.metadata) : null,
        now,
        now,
      ]
    );
    const group = await executor.queryOne<{
      id: string;
      group_key: string;
      display_name: string;
    }>('SELECT id, group_key, display_name FROM "groups" WHERE tenant_id = ? AND group_key = ?', [
      tenantId,
      input.groupKey,
    ]);
    return {
      id: group?.id ?? id,
      tenantId,
      groupKey: group?.group_key ?? input.groupKey,
      displayName: group?.display_name ?? input.displayName,
    };
  }

  async createGroupMembership(tenantId: string, input: CreateGroupMembershipRequest) {
    validateRequiredString(input.groupId, 'groupId');
    if (!input.subjectId && !input.accountId) {
      throw badRequest('subjectId or accountId is required');
    }
    return this.adapter.transaction((tx) => this.upsertGroupMembership(tenantId, input, tx));
  }

  private async upsertGroupMembership(
    tenantId: string,
    input: CreateGroupMembershipRequest,
    executor: SqlQueryExecutor
  ) {
    const now = this.now();
    const id = createId('group_membership');
    const existing = await executor.queryOne<{ id: string }>(
      `SELECT id
         FROM group_memberships
        WHERE tenant_id = ?
          AND group_id = ?
          AND subject_id IS ?
          AND account_id IS ?
          AND membership_type = ?
        LIMIT 1`,
      [
        tenantId,
        input.groupId,
        input.subjectId ?? null,
        input.accountId ?? null,
        input.membershipType ?? 'member',
      ]
    );
    if (existing) {
      await executor.execute(
        `UPDATE group_memberships
            SET assignment_source = ?,
                lifecycle_state = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [input.assignmentSource ?? 'manual', 'active', now, tenantId, existing.id]
      );
    } else {
      await executor.execute(
        `INSERT INTO group_memberships (
          id, tenant_id, group_id, subject_id, account_id, membership_type,
          assignment_source, lifecycle_state, starts_at, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          input.groupId,
          input.subjectId ?? null,
          input.accountId ?? null,
          input.membershipType ?? 'member',
          input.assignmentSource ?? 'manual',
          'active',
          null,
          null,
          now,
          now,
        ]
      );
    }
    const assignmentId = existing?.id ?? id;
    await this.recordAssignmentOwnership(
      tenantId,
      {
        assignmentType: 'group_membership',
        assignmentId,
        sourceId: input.assignmentSource ?? 'manual',
        ownershipPolicy: input.ownershipPolicy ?? 'manual',
        revokePolicy: input.revokePolicy ?? 'review',
        protectedUntil: input.protectedUntil ?? null,
      },
      executor
    );
    return {
      id: assignmentId,
      tenantId,
      groupId: input.groupId,
      subjectId: input.subjectId ?? null,
      accountId: input.accountId ?? null,
      lifecycleState: 'active',
    };
  }

  async grantEntitlement(tenantId: string, input: GrantEntitlementRequest) {
    validateRequiredString(input.entitlementType, 'entitlementType');
    validateRequiredString(input.entitlementKey, 'entitlementKey');
    if (!input.subjectId && !input.accountId) {
      throw badRequest('subjectId or accountId is required');
    }
    if (input.value) {
      assertNoReviewPayloadRawIdentifiers(input.value, 'value');
    }
    return this.adapter.transaction((tx) => this.upsertEntitlementGrant(tenantId, input, tx));
  }

  private async upsertEntitlementGrant(
    tenantId: string,
    input: GrantEntitlementRequest,
    executor: SqlQueryExecutor
  ) {
    const now = this.now();
    const id = createId('entitlement');
    const existing = await executor.queryOne<{ id: string }>(
      `SELECT id
         FROM entitlements
        WHERE tenant_id = ?
          AND entitlement_type = ?
          AND entitlement_key = ?
          AND subject_id IS ?
          AND account_id IS ?
        LIMIT 1`,
      [
        tenantId,
        input.entitlementType,
        input.entitlementKey,
        input.subjectId ?? null,
        input.accountId ?? null,
      ]
    );
    if (existing) {
      await executor.execute(
        `UPDATE entitlements
            SET source_id = ?,
                lifecycle_state = ?,
                value_json = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [
          input.sourceId ?? null,
          'active',
          input.value ? stableJson(input.value) : null,
          now,
          tenantId,
          existing.id,
        ]
      );
    } else {
      await executor.execute(
        `INSERT INTO entitlements (
          id, tenant_id, subject_id, account_id, entitlement_type, entitlement_key,
          source_id, lifecycle_state, value_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          tenantId,
          input.subjectId ?? null,
          input.accountId ?? null,
          input.entitlementType,
          input.entitlementKey,
          input.sourceId ?? null,
          'active',
          input.value ? stableJson(input.value) : null,
          now,
          now,
        ]
      );
    }
    const assignmentId = existing?.id ?? id;
    await this.recordAssignmentOwnership(
      tenantId,
      {
        assignmentType: input.entitlementType === 'permission' ? 'permission' : 'entitlement',
        assignmentId,
        sourceId: input.sourceId ?? null,
        ownershipPolicy: input.ownershipPolicy ?? 'source_owned',
        revokePolicy: input.revokePolicy ?? 'review',
        protectedUntil: input.protectedUntil ?? null,
      },
      executor
    );
    return {
      id: assignmentId,
      tenantId,
      entitlementType: input.entitlementType,
      entitlementKey: input.entitlementKey,
      lifecycleState: 'active',
    };
  }

  async createProvisioningAssignmentRule(
    tenantId: string,
    input: CreateProvisioningAssignmentRuleRequest
  ) {
    validateRequiredString(input.ruleType, 'ruleType');
    validateRequiredString(input.targetType, 'targetType');
    validateRequiredString(input.targetId, 'targetId');
    if (!PROVISIONING_ASSIGNMENT_TARGET_TYPES.has(input.targetType)) {
      throw badRequest('targetType is not supported for provisioning assignment');
    }
    if (!isRecord(input.condition)) {
      throw badRequest('condition must be an object');
    }
    assertNoReviewPayloadRawIdentifiers(input.condition, 'condition');
    return this.insertProvisioningAssignmentRule(tenantId, input, this.adapter);
  }

  private async insertProvisioningAssignmentRule(
    tenantId: string,
    input: CreateProvisioningAssignmentRuleRequest,
    executor: SqlExecutor
  ) {
    const now = this.now();
    const id = createId('provisioning_assignment_rule');
    await executor.execute(
      `INSERT INTO provisioning_assignment_rules (
        id, tenant_id, scope_type, scope_id, rule_type, target_type, target_id,
        condition_json, priority, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.scopeType ?? 'tenant',
        input.scopeId ?? tenantId,
        input.ruleType,
        input.targetType,
        input.targetId,
        stableJson(input.condition),
        input.priority ?? 0,
        input.lifecycleState ?? 'active',
        now,
        now,
      ]
    );
    return {
      id,
      tenantId,
      targetType: input.targetType,
      targetId: input.targetId,
      lifecycleState: input.lifecycleState ?? 'active',
    };
  }

  async evaluateProvisioningAssignmentRule(
    tenantId: string,
    ruleId: string,
    input: EvaluateProvisioningAssignmentRequest
  ) {
    validateRequiredString(ruleId, 'ruleId');
    if (!input.subjectId && !input.accountId) {
      throw badRequest('subjectId or accountId is required');
    }
    const rule = await this.adapter.queryOne<ProvisioningAssignmentRuleRow>(
      `SELECT id, target_type, target_id, condition_json, priority
         FROM provisioning_assignment_rules
        WHERE tenant_id = ? AND id = ? AND lifecycle_state = ?`,
      [tenantId, ruleId, 'active']
    );
    if (!rule) {
      throw notFound('provisioning assignment rule not found');
    }
    const evaluation = evaluateProvisioningAssignmentRule(
      {
        id: rule.id,
        targetType: rule.target_type,
        targetId: rule.target_id,
        condition: parseProvisioningAssignmentCondition(rule.condition_json),
        priority: rule.priority,
      },
      input
    );
    const outcome = evaluation.matched ? 'assigned' : 'skipped';
    if (evaluation.matched && !input.dryRun) {
      await this.adapter.transaction(async (tx) => {
        await this.applyProvisioningAssignment(tenantId, rule, input, tx);
        await this.recordProvisioningAssignmentEvent(
          tenantId,
          {
            ruleId,
            subjectId: input.subjectId,
            accountId: input.accountId,
            targetType: rule.target_type,
            targetId: rule.target_id,
            outcome,
            reasonCodes: evaluation.reasonCodes,
            traceRef: `rule:${ruleId}`,
          },
          tx
        );
      });
    } else {
      await this.recordProvisioningAssignmentEvent(tenantId, {
        ruleId,
        subjectId: input.subjectId,
        accountId: input.accountId,
        targetType: rule.target_type,
        targetId: rule.target_id,
        outcome,
        reasonCodes: evaluation.reasonCodes,
        traceRef: input.dryRun ? `dry-run:${ruleId}` : `rule:${ruleId}`,
      });
    }
    return {
      ...evaluation,
      outcome,
      dryRun: input.dryRun === true,
    };
  }

  async recordExternalLifecycleSignal(tenantId: string, input: RecordLifecycleSignalRequest) {
    validateRequiredString(input.sourceType, 'sourceType');
    validateRequiredString(input.sourceId, 'sourceId');
    validateRequiredString(input.sourceEventId, 'sourceEventId');
    validateRequiredString(input.signalType, 'signalType');
    validateRequiredString(input.targetType, 'targetType');
    validateRequiredString(input.targetId, 'targetId');
    if (!LIFECYCLE_SIGNAL_TYPES.has(input.signalType)) {
      throw badRequest('signalType is not supported');
    }
    if (
      input.targetType !== 'account' &&
      input.targetType !== 'group_membership' &&
      input.targetType !== 'entitlement' &&
      input.targetType !== 'permission'
    ) {
      throw badRequest('targetType is not supported for lifecycle signals');
    }
    const now = this.now();
    const dedupeKey = [
      input.sourceType,
      input.sourceId,
      input.sourceEventId,
      input.signalType,
      input.targetType,
      input.targetId,
    ].join(':');
    const existingEvent = await this.adapter.queryOne<{ id: string; processing_state: string }>(
      `SELECT id, processing_state
         FROM external_lifecycle_signal_events
        WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND dedupe_key = ?
        LIMIT 1`,
      [tenantId, input.sourceType, input.sourceId, dedupeKey]
    );
    if (existingEvent) {
      const existingDecision = await this.adapter.queryOne<{
        decision: string;
        reason_codes_json: string | null;
      }>(
        `SELECT decision, reason_codes_json
           FROM external_lifecycle_signal_decisions
          WHERE tenant_id = ? AND signal_event_id = ?
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, existingEvent.id]
      );
      if (existingDecision) {
        return {
          signalEventId: existingEvent.id,
          decision: existingDecision.decision,
          reasonCodes: parseJsonArray(existingDecision.reason_codes_json),
          idempotent: true,
        };
      }
    }

    const eventId = existingEvent?.id ?? createId('external_lifecycle_signal_event');
    const signalEventId = eventId;
    if (
      input.signalType === 'scim_active_false' &&
      input.targetType === 'account' &&
      this.beforeAccountSuspension
    ) {
      await this.beforeAccountSuspension(tenantId, input.targetId, now, signalEventId);
    }
    const lifecycleDecision = await this.adapter.transaction(async (tx) => {
      if (!existingEvent) {
        await tx.execute(
          `INSERT INTO external_lifecycle_signal_events (
            id, tenant_id, source_type, source_id, source_event_id, source_timestamp,
            observed_at, binding_version, payload_ref, signal_type, dedupe_key,
            processing_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventId,
            tenantId,
            input.sourceType,
            input.sourceId,
            input.sourceEventId,
            input.sourceTimestamp ?? null,
            now,
            input.bindingVersion ?? null,
            input.payloadRef ?? null,
            input.signalType,
            dedupeKey,
            'processing',
            now,
            now,
          ]
        );
      }
      const ownership =
        input.ownership ?? (await this.findAssignmentOwnership(tenantId, input, tx));
      const decision = decideLifecycleSignalRevocation({
        signalType: input.signalType,
        targetType: input.targetType,
        targetId: input.targetId,
        ownership,
        now,
      });
      await tx.execute(
        `INSERT INTO external_lifecycle_signal_decisions (
          id, tenant_id, signal_event_id, subject_id, account_id, decision,
          propagation_targets_json, reason_codes_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('external_lifecycle_signal_decision'),
          tenantId,
          signalEventId,
          input.subjectId ?? null,
          input.accountId ?? null,
          decision.decision,
          stableJson([{ targetType: input.targetType, targetId: input.targetId }]),
          stableJson(decision.reasonCodes),
          now,
        ]
      );
      await this.applyLifecycleSignalDecision(tenantId, input, signalEventId, decision, tx);
      await tx.execute(
        `UPDATE external_lifecycle_signal_events
            SET processing_state = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        ['processed', now, tenantId, signalEventId]
      );
      return decision;
    });
    return {
      signalEventId,
      decision: lifecycleDecision.decision,
      reasonCodes: lifecycleDecision.reasonCodes,
    };
  }

  async createKeyRegistry(tenantId: string, input: CreateKeyRegistryRequest) {
    validateRequiredString(input.keyPurpose, 'keyPurpose');
    validateRequiredString(input.algorithm, 'algorithm');
    validateRequiredString(input.backendType, 'backendType');
    validateRequiredString(input.materialRef, 'materialRef');
    if (!isRecord(input.scope)) {
      throw badRequest('scope must be an object');
    }
    if (input.materialMetadata) {
      assertNoSensitiveMetadata(input.materialMetadata, 'materialMetadata');
    }
    assertSafeMaterialBackend(input.backendType);
    assertSafeMaterialRef(input.materialRef);

    const now = this.now();
    const registryId = createId('key_registry');
    const versionId = createId('key_version');
    const materialRefId = createId('key_material_ref');
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO key_registries (
          id, tenant_id, key_purpose, scope_json, active_version_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          registryId,
          tenantId,
          input.keyPurpose,
          stableJson(input.scope),
          versionId,
          'active',
          now,
          now,
        ]
      );
      await tx.execute(
        `INSERT INTO key_versions (
          id, tenant_id, key_registry_id, version, status, algorithm,
          created_at, activated_at, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [versionId, tenantId, registryId, 1, 'active', input.algorithm, now, now, null]
      );
      await tx.execute(
        `INSERT INTO key_material_refs (
          id, tenant_id, key_version_id, backend_type, material_ref, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          materialRefId,
          tenantId,
          versionId,
          input.backendType,
          input.materialRef,
          input.materialMetadata ? stableJson(input.materialMetadata) : null,
          now,
        ]
      );
      await this.recordKeyAccessEvent(
        tenantId,
        registryId,
        {
          keyVersionId: versionId,
          actorId: input.actorId ?? null,
          accessType: 'registry.create',
          outcome: 'success',
        },
        tx
      );
    });
    return {
      id: registryId,
      tenantId,
      activeVersionId: versionId,
      keyPurpose: input.keyPurpose,
      status: 'active',
    };
  }

  async listKeyRegistries(tenantId: string) {
    const rows = await this.adapter.query<{
      id: string;
      key_purpose: string;
      scope_json: string;
      active_version_id: string | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, key_purpose, scope_json, active_version_id, status, created_at, updated_at
         FROM key_registries
        WHERE tenant_id = ?
        ORDER BY updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId,
      keyPurpose: row.key_purpose,
      scope: parseJsonObject(row.scope_json, {}),
      activeVersionId: row.active_version_id,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async rotateKeyRegistry(
    tenantId: string,
    keyRegistryId: string,
    input: RotateKeyRegistryRequest
  ) {
    validateRequiredString(keyRegistryId, 'keyRegistryId');
    validateRequiredString(input.algorithm, 'algorithm');
    validateRequiredString(input.backendType, 'backendType');
    validateRequiredString(input.materialRef, 'materialRef');
    if (input.materialMetadata) {
      assertNoSensitiveMetadata(input.materialMetadata, 'materialMetadata');
    }
    assertSafeMaterialBackend(input.backendType);
    assertSafeMaterialRef(input.materialRef);
    const jobMode = input.jobMode ?? 'rewrap';
    if (!KEY_JOB_MODES.has(jobMode)) {
      throw badRequest('jobMode is not supported');
    }
    const registry = await this.adapter.queryOne<{ active_version_id: string | null }>(
      `SELECT active_version_id
         FROM key_registries
        WHERE tenant_id = ? AND id = ? AND status = ?`,
      [tenantId, keyRegistryId, 'active']
    );
    if (!registry) {
      throw notFound('key registry not found');
    }
    const latest = await this.adapter.queryOne<{ version: number }>(
      `SELECT version
         FROM key_versions
        WHERE tenant_id = ? AND key_registry_id = ?
        ORDER BY version DESC
        LIMIT 1`,
      [tenantId, keyRegistryId]
    );
    const now = this.now();
    const nextVersion = (latest?.version ?? 0) + 1;
    const versionId = createId('key_version');
    const materialRefId = createId('key_material_ref');
    const jobs: Array<{ id: string; type: 'rewrap' | 'blind_index_rotation' }> = [];
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO key_versions (
          id, tenant_id, key_registry_id, version, status, algorithm,
          created_at, activated_at, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [versionId, tenantId, keyRegistryId, nextVersion, 'active', input.algorithm, now, now, null]
      );
      await tx.execute(
        `INSERT INTO key_material_refs (
          id, tenant_id, key_version_id, backend_type, material_ref, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          materialRefId,
          tenantId,
          versionId,
          input.backendType,
          input.materialRef,
          input.materialMetadata ? stableJson(input.materialMetadata) : null,
          now,
        ]
      );
      if (registry.active_version_id) {
        await tx.execute(
          `UPDATE key_versions
              SET status = ?, retired_at = ?
            WHERE tenant_id = ? AND id = ?`,
          ['retiring', now, tenantId, registry.active_version_id]
        );
      }
      await tx.execute(
        `UPDATE key_registries
            SET active_version_id = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [versionId, now, tenantId, keyRegistryId]
      );
      if (jobMode === 'rewrap' || jobMode === 'both') {
        const jobId = createId('rewrap_job');
        jobs.push({ id: jobId, type: 'rewrap' });
        await tx.execute(
          `INSERT INTO rewrap_jobs (
            id, tenant_id, key_registry_id, source_version_id, target_version_id,
            artifact_scope_json, status, cursor_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            jobId,
            tenantId,
            keyRegistryId,
            registry.active_version_id ?? null,
            versionId,
            stableJson(input.artifactScope ?? { scope: 'registry', keyRegistryId }),
            'queued',
            stableJson({ offset: 0 }),
            now,
            now,
          ]
        );
      }
      if (jobMode === 'blind_index' || jobMode === 'both') {
        const jobId = createId('blind_index_rotation_job');
        jobs.push({ id: jobId, type: 'blind_index_rotation' });
        await tx.execute(
          `INSERT INTO blind_index_rotation_jobs (
            id, tenant_id, key_registry_id, source_version_id, target_version_id,
            status, cursor_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            jobId,
            tenantId,
            keyRegistryId,
            registry.active_version_id ?? null,
            versionId,
            'queued',
            stableJson({ phase: 'dual_read', offset: 0 }),
            now,
            now,
          ]
        );
      }
      await this.recordKeyAccessEvent(
        tenantId,
        keyRegistryId,
        {
          keyVersionId: versionId,
          actorId: input.actorId ?? null,
          accessType: 'registry.rotate',
          outcome: 'success',
        },
        tx
      );
    });
    return {
      keyRegistryId,
      activeVersionId: versionId,
      version: nextVersion,
      jobs,
    };
  }

  async recordKeyAccess(tenantId: string, keyRegistryId: string, input: RecordKeyAccessRequest) {
    validateRequiredString(keyRegistryId, 'keyRegistryId');
    validateRequiredString(input.accessType, 'accessType');
    validateRequiredString(input.outcome, 'outcome');
    if (!KEY_ACCESS_TYPES.has(input.accessType)) {
      throw badRequest('accessType is not supported for key access events');
    }
    if (!KEY_ACCESS_OUTCOMES.has(input.outcome)) {
      throw badRequest('outcome is not supported for key access events');
    }
    await this.ensureKeyRegistry(tenantId, keyRegistryId);
    if (input.keyVersionId) {
      await this.ensureKeyVersion(tenantId, keyRegistryId, input.keyVersionId);
    }
    await this.recordKeyAccessEvent(tenantId, keyRegistryId, input);
    return { keyRegistryId, recorded: true };
  }

  async createFederationTrustSource(tenantId: string, input: CreateFederationTrustSourceRequest) {
    validateRequiredString(input.sourceType, 'sourceType');
    validateRequiredString(input.sourceKey, 'sourceKey');
    validateRequiredString(input.displayName, 'displayName');
    if (!FEDERATION_TRUST_SOURCE_TYPES.has(input.sourceType)) {
      throw badRequest('sourceType is not supported for federation trust');
    }
    const lifecycleState = input.lifecycleState ?? 'draft';
    if (!FEDERATION_TRUST_LIFECYCLE_STATES.has(lifecycleState)) {
      throw badRequest('lifecycleState is not supported for federation trust sources');
    }
    if (input.protocolPayload) {
      assertNoSensitiveMetadata(input.protocolPayload, 'protocolPayload');
    }
    if (input.anchors !== undefined && !Array.isArray(input.anchors)) {
      throw badRequest('anchors must be an array');
    }
    if (input.scopeBindings !== undefined && !Array.isArray(input.scopeBindings)) {
      throw badRequest('scopeBindings must be an array');
    }
    const now = this.now();
    const sourceId = createId('federation_trust_source');
    const trustContext = {
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      displayName: input.displayName,
      protocolPayload: input.protocolPayload ?? null,
      anchors: input.anchors ?? [],
      scopeBindings: input.scopeBindings ?? [],
    };
    const snapshotHash = await hashStableJson(trustContext);
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO federation_trust_sources (
          id, tenant_id, source_type, source_key, display_name, lifecycle_state,
          protocol_payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sourceId,
          tenantId,
          input.sourceType,
          input.sourceKey,
          input.displayName,
          lifecycleState,
          input.protocolPayload ? stableJson(input.protocolPayload) : null,
          now,
          now,
        ]
      );
      for (const anchor of input.anchors ?? []) {
        validateRequiredString(anchor.anchorType, 'anchor.anchorType');
        validateRequiredString(anchor.anchorHash, 'anchor.anchorHash');
        await tx.execute(
          `INSERT INTO federation_trust_anchors (
            id, tenant_id, trust_source_id, anchor_type, anchor_hash, anchor_ref,
            not_before, not_after, lifecycle_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('federation_trust_anchor'),
            tenantId,
            sourceId,
            anchor.anchorType,
            anchor.anchorHash,
            anchor.anchorRef ?? null,
            anchor.notBefore ?? null,
            anchor.notAfter ?? null,
            'active',
            now,
            now,
          ]
        );
      }
      for (const binding of input.scopeBindings ?? []) {
        validateRequiredString(binding.scopeType, 'scopeBinding.scopeType');
        await tx.execute(
          `INSERT INTO federation_trust_scope_bindings (
            id, tenant_id, trust_source_id, scope_type, scope_id, priority,
            lifecycle_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('federation_trust_scope_binding'),
            tenantId,
            sourceId,
            binding.scopeType,
            binding.scopeId ?? null,
            binding.priority ?? 0,
            'active',
            now,
            now,
          ]
        );
      }
      await tx.execute(
        `INSERT INTO federation_trust_context_snapshots (
          id, tenant_id, trust_source_id, snapshot_hash, trust_context_json,
          lifecycle_state, created_at, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('federation_trust_context_snapshot'),
          tenantId,
          sourceId,
          snapshotHash,
          stableJson(trustContext),
          lifecycleState === 'active' ? 'active' : 'draft',
          now,
          lifecycleState === 'active' ? now : null,
        ]
      );
    });
    return {
      id: sourceId,
      tenantId,
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      lifecycleState,
      snapshotHash,
    };
  }

  async updateFederationTrustSource(
    tenantId: string,
    trustSourceId: string,
    input: UpdateFederationTrustSourceRequest
  ) {
    validateRequiredString(trustSourceId, 'trustSourceId');
    validateRequiredString(input.sourceType, 'sourceType');
    validateRequiredString(input.sourceKey, 'sourceKey');
    validateRequiredString(input.displayName, 'displayName');
    if (!FEDERATION_TRUST_SOURCE_TYPES.has(input.sourceType)) {
      throw badRequest('sourceType is not supported for federation trust');
    }
    const lifecycleState = input.lifecycleState ?? 'draft';
    if (!FEDERATION_TRUST_LIFECYCLE_STATES.has(lifecycleState)) {
      throw badRequest('lifecycleState is not supported for federation trust sources');
    }
    if (input.protocolPayload) {
      assertNoSensitiveMetadata(input.protocolPayload, 'protocolPayload');
    }
    if (input.anchors !== undefined && !Array.isArray(input.anchors)) {
      throw badRequest('anchors must be an array');
    }
    if (input.scopeBindings !== undefined && !Array.isArray(input.scopeBindings)) {
      throw badRequest('scopeBindings must be an array');
    }
    await this.ensureFederationTrustSource(tenantId, trustSourceId);

    const now = this.now();
    const trustContext = {
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      displayName: input.displayName,
      protocolPayload: input.protocolPayload ?? null,
      anchors: input.anchors ?? [],
      scopeBindings: input.scopeBindings ?? [],
    };
    const snapshotHash = await hashStableJson(trustContext);
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE federation_trust_sources
            SET source_type = ?,
                source_key = ?,
                display_name = ?,
                lifecycle_state = ?,
                protocol_payload_json = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [
          input.sourceType,
          input.sourceKey,
          input.displayName,
          lifecycleState,
          input.protocolPayload ? stableJson(input.protocolPayload) : null,
          now,
          tenantId,
          trustSourceId,
        ]
      );
      await tx.execute(
        'DELETE FROM federation_trust_anchors WHERE tenant_id = ? AND trust_source_id = ?',
        [tenantId, trustSourceId]
      );
      await tx.execute(
        'DELETE FROM federation_trust_scope_bindings WHERE tenant_id = ? AND trust_source_id = ?',
        [tenantId, trustSourceId]
      );
      for (const anchor of input.anchors ?? []) {
        validateRequiredString(anchor.anchorType, 'anchor.anchorType');
        validateRequiredString(anchor.anchorHash, 'anchor.anchorHash');
        await tx.execute(
          `INSERT INTO federation_trust_anchors (
            id, tenant_id, trust_source_id, anchor_type, anchor_hash, anchor_ref,
            not_before, not_after, lifecycle_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('federation_trust_anchor'),
            tenantId,
            trustSourceId,
            anchor.anchorType,
            anchor.anchorHash,
            anchor.anchorRef ?? null,
            anchor.notBefore ?? null,
            anchor.notAfter ?? null,
            'active',
            now,
            now,
          ]
        );
      }
      for (const binding of input.scopeBindings ?? []) {
        validateRequiredString(binding.scopeType, 'scopeBinding.scopeType');
        await tx.execute(
          `INSERT INTO federation_trust_scope_bindings (
            id, tenant_id, trust_source_id, scope_type, scope_id, priority,
            lifecycle_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('federation_trust_scope_binding'),
            tenantId,
            trustSourceId,
            binding.scopeType,
            binding.scopeId ?? null,
            binding.priority ?? 0,
            'active',
            now,
            now,
          ]
        );
      }
      await tx.execute(
        `INSERT INTO federation_trust_context_snapshots (
          id, tenant_id, trust_source_id, snapshot_hash, trust_context_json,
          lifecycle_state, created_at, activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('federation_trust_context_snapshot'),
          tenantId,
          trustSourceId,
          snapshotHash,
          stableJson(trustContext),
          lifecycleState === 'active' ? 'active' : 'draft',
          now,
          lifecycleState === 'active' ? now : null,
        ]
      );
    });

    return {
      id: trustSourceId,
      tenantId,
      sourceType: input.sourceType,
      sourceKey: input.sourceKey,
      lifecycleState,
      snapshotHash,
    };
  }

  async deleteFederationTrustSource(tenantId: string, trustSourceId: string) {
    validateRequiredString(trustSourceId, 'trustSourceId');
    await this.ensureFederationTrustSource(tenantId, trustSourceId);
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        'DELETE FROM federation_trust_anchors WHERE tenant_id = ? AND trust_source_id = ?',
        [tenantId, trustSourceId]
      );
      await tx.execute(
        'DELETE FROM federation_trust_scope_bindings WHERE tenant_id = ? AND trust_source_id = ?',
        [tenantId, trustSourceId]
      );
      await tx.execute(
        'DELETE FROM federation_trust_context_snapshots WHERE tenant_id = ? AND trust_source_id = ?',
        [tenantId, trustSourceId]
      );
      await tx.execute(
        'DELETE FROM federation_metadata_validation_events WHERE tenant_id = ? AND trust_source_id = ?',
        [tenantId, trustSourceId]
      );
      await tx.execute(
        'DELETE FROM federation_metadata_entity_summaries WHERE tenant_id = ? AND metadata_document_id IN (SELECT id FROM federation_metadata_documents WHERE tenant_id = ? AND trust_source_id = ?)',
        [tenantId, tenantId, trustSourceId]
      );
      await tx.execute(
        'DELETE FROM federation_metadata_documents WHERE tenant_id = ? AND trust_source_id = ?',
        [tenantId, trustSourceId]
      );
      await tx.execute('DELETE FROM federation_trust_sources WHERE tenant_id = ? AND id = ?', [
        tenantId,
        trustSourceId,
      ]);
    });
    return { success: true };
  }

  async listFederationTrustSources(tenantId: string) {
    const rows = await this.adapter.query<{
      id: string;
      source_type: string;
      source_key: string;
      display_name: string;
      lifecycle_state: string;
      protocol_payload_json: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT id, source_type, source_key, display_name, lifecycle_state,
              protocol_payload_json, created_at, updated_at
         FROM federation_trust_sources
        WHERE tenant_id = ?
        ORDER BY updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId,
      sourceType: row.source_type,
      sourceKey: row.source_key,
      displayName: row.display_name,
      lifecycleState: row.lifecycle_state,
      protocolPayload: row.protocol_payload_json
        ? parseJsonObject(row.protocol_payload_json, {})
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async registerFederationMetadataDocument(
    tenantId: string,
    input: RegisterFederationMetadataDocumentRequest
  ) {
    validateRequiredString(input.trustSourceId, 'trustSourceId');
    validateRequiredString(input.documentType, 'documentType');
    validateRequiredString(input.documentHash, 'documentHash');
    const validationState = input.validationState ?? 'pending';
    if (!FEDERATION_METADATA_VALIDATION_STATES.has(validationState)) {
      throw badRequest('validationState is not supported for federation metadata documents');
    }
    if (input.entitySummaries !== undefined && !Array.isArray(input.entitySummaries)) {
      throw badRequest('entitySummaries must be an array');
    }
    await this.ensureFederationTrustSource(tenantId, input.trustSourceId);
    const now = this.now();
    const documentId = createId('federation_metadata_document');
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO federation_metadata_documents (
          id, tenant_id, trust_source_id, document_type, source_url, document_hash,
          document_ref, fetched_at, validated_at, validation_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          documentId,
          tenantId,
          input.trustSourceId,
          input.documentType,
          input.sourceUrl ?? null,
          input.documentHash,
          input.documentRef ?? null,
          now,
          validationState !== 'pending' ? now : null,
          validationState,
          now,
          now,
        ]
      );
      await tx.execute(
        `INSERT INTO federation_metadata_validation_events (
          id, tenant_id, trust_source_id, metadata_document_id, validation_state,
          reason_codes_json, trace_ref, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('federation_metadata_validation_event'),
          tenantId,
          input.trustSourceId,
          documentId,
          validationState,
          stableJson([`federation.metadata.${validationState}`]),
          `metadata-document:${documentId}`,
          now,
        ]
      );
      for (const summary of input.entitySummaries ?? []) {
        validateRequiredString(summary.entityId, 'entitySummary.entityId');
        validateRequiredString(summary.entityRole, 'entitySummary.entityRole');
        await tx.execute(
          `INSERT INTO federation_metadata_entity_summaries (
            id, tenant_id, metadata_document_id, entity_id, entity_role,
            display_name, summary_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createId('federation_metadata_entity_summary'),
            tenantId,
            documentId,
            summary.entityId,
            summary.entityRole,
            summary.displayName ?? null,
            summary.summary ? stableJson(summary.summary) : null,
            now,
            now,
          ]
        );
      }
    });
    return {
      id: documentId,
      trustSourceId: input.trustSourceId,
      validationState,
    };
  }

  async listFederationMetadataDocuments(tenantId: string, trustSourceId: string) {
    validateRequiredString(trustSourceId, 'trustSourceId');
    await this.ensureFederationTrustSource(tenantId, trustSourceId);

    const rows = await this.adapter.query<FederationMetadataDocumentListRow>(
      `SELECT
        d.id,
        d.trust_source_id,
        d.document_type,
        d.source_url,
        d.document_hash,
        d.document_ref,
        d.fetched_at,
        d.validated_at,
        d.validation_state,
        d.created_at,
        d.updated_at,
        e.id AS entity_summary_id,
        e.entity_id,
        e.entity_role,
        e.display_name,
        e.summary_json
      FROM federation_metadata_documents d
      LEFT JOIN federation_metadata_entity_summaries e
        ON e.tenant_id = d.tenant_id
       AND e.metadata_document_id = d.id
      WHERE d.tenant_id = ? AND d.trust_source_id = ?
      ORDER BY d.fetched_at DESC, d.created_at DESC, e.display_name ASC, e.entity_id ASC`,
      [tenantId, trustSourceId]
    );

    const documents = new Map<
      string,
      {
        id: string;
        tenantId: string;
        trustSourceId: string;
        documentType: string;
        sourceUrl: string | null;
        documentHash: string;
        documentRef: string | null;
        fetchedAt: number | null;
        validatedAt: number | null;
        validationState: string;
        createdAt: number;
        updatedAt: number;
        entitySummaries: Array<{
          id: string;
          entityId: string;
          entityRole: string;
          displayName: string | null;
          summary: Record<string, unknown> | null;
        }>;
      }
    >();

    for (const row of rows) {
      let document = documents.get(row.id);
      if (!document) {
        document = {
          id: row.id,
          tenantId,
          trustSourceId: row.trust_source_id,
          documentType: row.document_type,
          sourceUrl: row.source_url,
          documentHash: row.document_hash,
          documentRef: row.document_ref,
          fetchedAt: row.fetched_at,
          validatedAt: row.validated_at,
          validationState: row.validation_state,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          entitySummaries: [],
        };
        documents.set(row.id, document);
      }
      if (row.entity_summary_id && row.entity_id && row.entity_role) {
        document.entitySummaries.push({
          id: row.entity_summary_id,
          entityId: row.entity_id,
          entityRole: row.entity_role,
          displayName: row.display_name,
          summary: row.summary_json ? parseJsonObject(row.summary_json, {}) : null,
        });
      }
    }

    return [...documents.values()];
  }

  private async recordKeyAccessEvent(
    tenantId: string,
    keyRegistryId: string,
    input: RecordKeyAccessRequest,
    executor: SqlExecutor = this.adapter
  ) {
    await executor.execute(
      `INSERT INTO key_access_events (
        id, tenant_id, key_registry_id, key_version_id, actor_id,
        access_type, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId('key_access_event'),
        tenantId,
        keyRegistryId,
        input.keyVersionId ?? null,
        input.actorId ?? null,
        input.accessType,
        input.outcome,
        this.now(),
      ]
    );
  }

  private async ensureKeyRegistry(tenantId: string, keyRegistryId: string): Promise<void> {
    const row = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM key_registries
        WHERE tenant_id = ? AND id = ?`,
      [tenantId, keyRegistryId]
    );
    if (!row) {
      throw notFound('key registry not found');
    }
  }

  private async ensureKeyVersion(
    tenantId: string,
    keyRegistryId: string,
    keyVersionId: string
  ): Promise<void> {
    const row = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM key_versions
        WHERE tenant_id = ? AND key_registry_id = ? AND id = ?`,
      [tenantId, keyRegistryId, keyVersionId]
    );
    if (!row) {
      throw notFound('key version not found');
    }
  }

  private async ensureFederationTrustSource(
    tenantId: string,
    trustSourceId: string
  ): Promise<void> {
    const row = await this.adapter.queryOne<{ id: string }>(
      `SELECT id
         FROM federation_trust_sources
        WHERE tenant_id = ? AND id = ?`,
      [tenantId, trustSourceId]
    );
    if (!row) {
      throw notFound('federation trust source not found');
    }
  }

  private async applyProvisioningAssignment(
    tenantId: string,
    rule: ProvisioningAssignmentRuleRow,
    input: EvaluateProvisioningAssignmentRequest,
    executor: SqlQueryExecutor
  ) {
    if (rule.target_type === 'group') {
      await this.upsertGroupMembership(
        tenantId,
        {
          groupId: rule.target_id,
          subjectId: input.subjectId,
          accountId: input.accountId,
          membershipType: 'member',
          assignmentSource: `rule:${rule.id}`,
          ownershipPolicy: 'source_owned',
          revokePolicy: 'review',
        },
        executor
      );
      return;
    }
    await this.upsertEntitlementGrant(
      tenantId,
      {
        subjectId: input.subjectId,
        accountId: input.accountId,
        entitlementType: rule.target_type === 'permission' ? 'permission' : 'entitlement',
        entitlementKey: rule.target_id,
        sourceId: rule.id,
        ownershipPolicy: 'source_owned',
        revokePolicy: 'review',
      },
      executor
    );
  }

  private async recordProvisioningAssignmentEvent(
    tenantId: string,
    input: {
      ruleId: string | null;
      subjectId?: string | null;
      accountId?: string | null;
      targetType: string;
      targetId: string;
      outcome: string;
      reasonCodes: string[];
      traceRef: string;
    },
    executor: SqlExecutor = this.adapter
  ) {
    await executor.execute(
      `INSERT INTO provisioning_assignment_events (
        id, tenant_id, rule_id, subject_id, account_id, target_type, target_id,
        outcome, reason_codes_json, trace_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId('provisioning_assignment_event'),
        tenantId,
        input.ruleId,
        input.subjectId ?? null,
        input.accountId ?? null,
        input.targetType,
        input.targetId,
        input.outcome,
        stableJson(input.reasonCodes),
        input.traceRef,
        this.now(),
      ]
    );
  }

  private async recordAssignmentOwnership(
    tenantId: string,
    input: {
      assignmentType: string;
      assignmentId: string;
      sourceId?: string | null;
      ownershipPolicy: string;
      revokePolicy: string;
      protectedUntil?: number | null;
    },
    executor: SqlQueryExecutor = this.adapter
  ) {
    const now = this.now();
    const existing = await executor.queryOne<{ id: string }>(
      `SELECT id
         FROM provisioning_assignment_ownership
        WHERE tenant_id = ?
          AND assignment_type = ?
          AND assignment_id = ?
          AND source_id IS ?
        LIMIT 1`,
      [tenantId, input.assignmentType, input.assignmentId, input.sourceId ?? null]
    );
    if (existing) {
      await executor.execute(
        `UPDATE provisioning_assignment_ownership
            SET ownership_policy = ?,
                revoke_policy = ?,
                protected_until = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        [
          input.ownershipPolicy,
          input.revokePolicy,
          input.protectedUntil ?? null,
          now,
          tenantId,
          existing.id,
        ]
      );
      return;
    }
    await executor.execute(
      `INSERT INTO provisioning_assignment_ownership (
        id, tenant_id, assignment_type, assignment_id, source_id, ownership_policy,
        revoke_policy, protected_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId('provisioning_assignment_ownership'),
        tenantId,
        input.assignmentType,
        input.assignmentId,
        input.sourceId ?? null,
        input.ownershipPolicy,
        input.revokePolicy,
        input.protectedUntil ?? null,
        now,
        now,
      ]
    );
  }

  private async findAssignmentOwnership(
    tenantId: string,
    input: Pick<RecordLifecycleSignalRequest, 'targetType' | 'targetId'>,
    executor: SqlQueryExecutor = this.adapter
  ): Promise<ProvisioningAssignmentOwnershipContext | null> {
    const row = await executor.queryOne<ProvisioningAssignmentOwnershipRow>(
      `SELECT assignment_type, assignment_id, ownership_policy, revoke_policy, protected_until
         FROM provisioning_assignment_ownership
        WHERE tenant_id = ? AND assignment_type = ? AND assignment_id = ?
        ORDER BY updated_at DESC
        LIMIT 1`,
      [tenantId, input.targetType, input.targetId]
    );
    if (!row) {
      return null;
    }
    return {
      assignmentType: row.assignment_type,
      assignmentId: row.assignment_id,
      ownershipPolicy: row.ownership_policy,
      revokePolicy: row.revoke_policy,
      protectedUntil: row.protected_until,
    };
  }

  private async applyLifecycleSignalDecision(
    tenantId: string,
    input: RecordLifecycleSignalRequest,
    signalEventId: string,
    decision: { decision: string; reasonCodes: string[] },
    executor: SqlExecutor = this.adapter
  ) {
    if (decision.decision === 'revoke') {
      if (input.targetType === 'group_membership') {
        await executor.execute(
          `UPDATE group_memberships
              SET lifecycle_state = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?`,
          ['revoked', this.now(), tenantId, input.targetId]
        );
      }
      if (input.targetType === 'entitlement' || input.targetType === 'permission') {
        await executor.execute(
          `UPDATE entitlements
              SET lifecycle_state = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?`,
          ['revoked', this.now(), tenantId, input.targetId]
        );
      }
    }
    if (decision.decision === 'suspend_account') {
      await executor.execute(
        `UPDATE identity_accounts
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        ['suspended', this.now(), tenantId, input.targetId]
      );
    }
    await executor.execute(
      `INSERT INTO provisioning_revocation_events (
        id, tenant_id, subject_id, account_id, source_event_id, target_type,
        target_id, decision, reason_codes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createId('provisioning_revocation_event'),
        tenantId,
        input.subjectId ?? null,
        input.accountId ?? null,
        signalEventId,
        input.targetType,
        input.targetId,
        decision.decision,
        stableJson(decision.reasonCodes),
        this.now(),
      ]
    );
  }

  async runIdempotent<T>(
    tenantId: string,
    operationKey: string,
    idempotencyKey: string | null,
    requestBody: unknown,
    operation: () => Promise<T>
  ): Promise<RepositoryResult<T>> {
    if (!idempotencyKey) {
      throw badRequest('Idempotency-Key header is required');
    }
    const requestHash = await hashStableJson(requestBody);
    const existing = await this.adapter.queryOne<IdempotencyRecordRow>(
      `SELECT request_hash, response_ref, status
         FROM idempotency_records
        WHERE tenant_id = ? AND operation_key = ? AND idempotency_key = ?`,
      [tenantId, operationKey, idempotencyKey]
    );
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw conflict('Idempotency-Key was already used for a different request');
      }
      if (existing.status === 'complete' && existing.response_ref) {
        return { result: JSON.parse(existing.response_ref) as T };
      }
      if (existing.status === 'in_progress') {
        throw conflict('Idempotent operation is already in progress');
      }
    } else {
      const now = this.now();
      await this.adapter.execute(
        `INSERT INTO idempotency_records (
          id, tenant_id, idempotency_key, operation_key, request_hash, response_ref,
          status, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('idempotency'),
          tenantId,
          idempotencyKey,
          operationKey,
          requestHash,
          null,
          'in_progress',
          now + IDEMPOTENCY_TTL_MS,
          now,
          now,
        ]
      );
    }

    try {
      const result = await operation();
      await this.adapter.execute(
        `UPDATE idempotency_records
            SET status = ?, response_ref = ?, updated_at = ?
          WHERE tenant_id = ? AND operation_key = ? AND idempotency_key = ?`,
        ['complete', stableJson(result), this.now(), tenantId, operationKey, idempotencyKey]
      );
      return { result };
    } catch (error) {
      await this.adapter.execute(
        `UPDATE idempotency_records
            SET status = ?, updated_at = ?
          WHERE tenant_id = ? AND operation_key = ? AND idempotency_key = ?`,
        ['failed', this.now(), tenantId, operationKey, idempotencyKey]
      );
      throw error;
    }
  }

  private async getFieldMappingSet(tenantId: string, fieldMappingSetId: string) {
    return this.adapter.queryOne<FieldMappingSetRow>(
      `SELECT * FROM field_mapping_sets WHERE tenant_id = ? AND id = ?`,
      [tenantId, fieldMappingSetId]
    );
  }

  private async getFieldMappingVersion(
    tenantId: string,
    fieldMappingSetId: string,
    fieldMappingVersionId: string
  ) {
    return this.adapter.queryOne<FieldMappingVersionRow>(
      `SELECT * FROM field_mapping_versions
        WHERE tenant_id = ? AND field_mapping_set_id = ? AND id = ?`,
      [tenantId, fieldMappingSetId, fieldMappingVersionId]
    );
  }

  private async getCatalogVersion(tenantId: string, catalogVersionId: string) {
    const storedCatalogVersion = await this.adapter.queryOne<FieldCatalogVersionRow>(
      `SELECT * FROM field_catalog_versions WHERE tenant_id = ? AND id = ?`,
      [tenantId, catalogVersionId]
    );
    if (storedCatalogVersion) {
      return storedCatalogVersion;
    }

    const configuredCanonicalCatalog = await this.loadConfiguredCanonicalCatalog(tenantId);
    if (configuredCanonicalCatalog?.versionId !== catalogVersionId) {
      return null;
    }
    const bundleHash = await hashStableJson({
      catalogKey: configuredCanonicalCatalog.catalogKey,
      versionLabel: configuredCanonicalCatalog.versionLabel,
      entries: configuredCanonicalCatalog.entries ?? [],
    });
    const now = this.now();
    return {
      id: catalogVersionId,
      tenant_id: tenantId,
      catalog_id: configuredCanonicalCatalog.id,
      version_label: configuredCanonicalCatalog.versionLabel ?? catalogVersionId,
      bundle_hash: bundleHash,
      compatibility_range: '*',
      lifecycle_state: 'active' as LifecycleState,
      created_at: now,
      updated_at: now,
    };
  }

  private async getSnapshot(tenantId: string, fieldMappingVersionId: string, snapshotId: string) {
    return this.adapter.queryOne<CompiledMappingSnapshotRow>(
      `SELECT id, tenant_id, field_mapping_version_id, catalog_version_id, snapshot_hash, lifecycle_state
         FROM compiled_mapping_snapshots
        WHERE tenant_id = ? AND field_mapping_version_id = ? AND id = ?`,
      [tenantId, fieldMappingVersionId, snapshotId]
    );
  }

  private async assertSensitiveMappingReleaseSafety(
    tenantId: string,
    fieldMappingVersionId: string,
    catalogVersionId: string | null
  ): Promise<void> {
    const edgeRows = await this.adapter.query<SensitiveReleaseMappingEdgeRow>(
      `SELECT e.source_ref_json, e.target_ref_json
         FROM mapping_rules r
         JOIN mapping_rule_edges e
           ON e.tenant_id = r.tenant_id
          AND e.rule_id = r.id
        WHERE r.tenant_id = ?
          AND r.field_mapping_version_id = ?`,
      [tenantId, fieldMappingVersionId]
    );
    const releaseEdges = edgeRows
      .map((row) => ({
        sourceRef: parseJsonObject(row.source_ref_json, {}),
        targetRef: parseJsonObject(row.target_ref_json, {}),
      }))
      .filter(({ targetRef }) =>
        isDestinationProfileMappingReference(readStringValue(targetRef.profileId))
      );
    if (releaseEdges.length === 0) return;
    if (!catalogVersionId) {
      throw badRequest('sensitive destination mappings require a compiled catalog snapshot');
    }

    const sourceEntries = await this.loadCatalogEntriesForActivation(tenantId, catalogVersionId);
    const profileCache = new Map<string, DestinationProfileRow | null>();
    for (const { sourceRef, targetRef } of releaseEdges) {
      const sourceEntry = findCatalogEntryForMappingRef(sourceEntries, sourceRef);
      const sourceNamespace = readStringValue(sourceRef.namespace);
      if (!sourceEntry) {
        if (isBuiltInSystemIdentityMappingReference(sourceRef)) {
          // Runtime-owned identifiers are not custom claims and therefore are intentionally absent
          // from the tenant's canonical custom-claim catalog.
          continue;
        }
        if (sourceNamespace === 'authrim.profile') {
          throw badRequest(
            `mapping source field is missing from compiled catalog: ${readStringValue(sourceRef.path) ?? 'unknown'}`
          );
        }
        continue;
      }
      const sourceSensitivity = sensitiveClassificationRank(sourceEntry.classification);
      if (sourceSensitivity === 0) continue;

      const profileRef = readStringValue(targetRef.profileId);
      const targetPath = readStringValue(targetRef.path);
      if (!profileRef || !targetPath) {
        throw badRequest('sensitive destination mapping must reference a profile field');
      }
      let profile = profileCache.get(profileRef);
      if (profile === undefined) {
        profile = await this.loadActiveDestinationProfileForActivation(tenantId, profileRef);
        profileCache.set(profileRef, profile);
      }
      if (!profile || !profile.schema_json) {
        throw badRequest(`sensitive destination mapping profile is unavailable: ${profileRef}`);
      }
      const targetField = findDestinationProfileField(
        profile.destination_type,
        parseJsonObject(profile.schema_json, {}),
        targetPath
      );
      if (!targetField) {
        throw badRequest(`sensitive destination profile field is unavailable: ${targetPath}`);
      }
      const targetClassification = readStringValue(targetField.classification) ?? 'internal';
      if (sensitiveClassificationRank(targetClassification) < sourceSensitivity) {
        throw badRequest(
          `sensitive mapping cannot lower classification from ${sourceEntry.classification} to ${targetClassification}: ${targetPath}`
        );
      }
      if (
        (profile.destination_type === 'oidc' || profile.destination_type === 'resource_server') &&
        readStringArrayValue(targetField.requiredScopes).length === 0
      ) {
        throw badRequest(
          `sensitive destination field must require at least one scope: ${targetPath}`
        );
      }
    }
  }

  private async loadCatalogEntriesForActivation(
    tenantId: string,
    catalogVersionId: string
  ): Promise<FieldCatalogEntrySummary[]> {
    const configuredCatalog = await this.loadConfiguredCanonicalCatalog(tenantId);
    if (configuredCatalog?.versionId === catalogVersionId) return configuredCatalog.entries;

    const rows = await this.adapter.query<FieldCatalogListRow>(
      `SELECT e.id AS entry_id,
              e.stable_field_id,
              e.namespace,
              e.path,
              e.target_taxonomy,
              e.value_type,
              e.cardinality,
              e.classification,
              e.aliases_json,
              e.validation_json,
              e.ui_group_key,
              e.ui_group_label,
              e.ui_group_order,
              e.ui_field_order,
              e.examples_json,
              e.note
         FROM field_catalog_entries e
        WHERE e.tenant_id = ? AND e.catalog_version_id = ?`,
      [tenantId, catalogVersionId]
    );
    return rows.flatMap((row) => {
      if (!row.entry_id || !row.stable_field_id || !row.namespace || !row.path) return [];
      const validation = parseJsonObject(row.validation_json ?? '{}', {});
      return [
        {
          id: row.entry_id,
          stableFieldId: row.stable_field_id,
          namespace: row.namespace,
          path: row.path,
          targetTaxonomy: row.target_taxonomy ?? 'canonical',
          valueType: row.value_type ?? 'string',
          cardinality: row.cardinality ?? 'single',
          classification: row.classification ?? 'internal',
          aliases: parseCatalogAliases(row.aliases_json),
          uiGroupKey: row.ui_group_key,
          uiGroupLabel: row.ui_group_label,
          uiGroupOrder: row.ui_group_order ?? 0,
          uiFieldOrder: row.ui_field_order ?? 0,
          examples: parseJsonUnknownArray(row.examples_json),
          note: row.note,
          allowedValues: parseStringArray(validation.allowedValues),
          valueMultiplicity:
            validation.valueMultiplicity === 'single' || validation.valueMultiplicity === 'multi'
              ? validation.valueMultiplicity
              : null,
          nullable: typeof validation.nullable === 'boolean' ? validation.nullable : null,
          required: typeof validation.required === 'boolean' ? validation.required : null,
        },
      ];
    });
  }

  private async loadActiveDestinationProfileForActivation(
    tenantId: string,
    profileRef: string
  ): Promise<DestinationProfileRow | null> {
    const profileIds = destinationProfileReferenceCandidates(profileRef);
    const rows = await this.adapter.query<DestinationProfileRow>(
      `SELECT p.*,
              v.id AS version_id,
              v.version_label,
              v.lifecycle_state AS version_lifecycle_state,
              v.schema_hash,
              v.schema_json,
              v.validation_summary_json,
              v.warning_summary_json,
              v.release_impact_json
         FROM destination_profiles p
         JOIN destination_profile_versions v
           ON v.id = p.active_version_id
          AND v.profile_id = p.id
          AND v.tenant_id = p.tenant_id
        WHERE p.tenant_id IN (?, 'platform')
          AND p.id IN (${profileIds.map(() => '?').join(', ')})
          AND p.lifecycle_state = 'active'
          AND v.lifecycle_state = 'active'
        LIMIT 1`,
      [tenantId, ...profileIds]
    );
    return rows[0] ?? null;
  }

  private async insertFieldMappingRule(
    executor: SqlExecutor,
    tenantId: string,
    fieldMappingVersionId: string,
    rule: FieldMappingVersionRuleInput,
    now: number
  ) {
    validateRequiredString(rule.ruleKey, 'ruleKey');
    validateRequiredString(rule.ruleKind, 'ruleKind');
    validateRequiredString(rule.action, 'action');
    const ruleId = createId('mapping_rule');
    await executor.execute(
      `INSERT INTO mapping_rules (
        id, tenant_id, field_mapping_version_id, rule_key, rule_kind, action, priority, scope_json,
        condition_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ruleId,
        tenantId,
        fieldMappingVersionId,
        rule.ruleKey,
        rule.ruleKind,
        rule.action,
        rule.priority ?? 0,
        stableJson(rule.scope ?? {}),
        stableJson(rule.condition ?? {}),
        stableJson(rule.metadata ?? {}),
        now,
        now,
      ]
    );

    const edgeIds: string[] = [];
    for (const [index, edge] of (rule.edges ?? []).entries()) {
      const edgeId = createId('mapping_edge');
      edgeIds.push(edgeId);
      await executor.execute(
        `INSERT INTO mapping_rule_edges (
          id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind,
          display_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          edgeId,
          tenantId,
          ruleId,
          stableJson(edge.sourceRef),
          stableJson(edge.targetRef),
          edge.edgeKind ?? 'direct',
          index,
          now,
          now,
        ]
      );
    }

    for (const [index, transform] of (rule.transforms ?? []).entries()) {
      await executor.execute(
        `INSERT INTO mapping_transform_steps (
          id, tenant_id, rule_id, edge_id, step_order, operation, parameters_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('mapping_transform'),
          tenantId,
          ruleId,
          transform.edgeIndex === undefined ? null : (edgeIds[transform.edgeIndex] ?? null),
          index,
          transform.operation,
          stableJson(transform.parameters ?? {}),
          now,
          now,
        ]
      );
    }

    for (const validationRule of rule.validationRules ?? []) {
      await executor.execute(
        `INSERT INTO mapping_validation_rules (
          id, tenant_id, rule_id, target_ref_json, validation_kind, severity,
          parameters_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('mapping_validation'),
          tenantId,
          ruleId,
          stableJson(validationRule.targetRef),
          validationRule.validationKind,
          validationRule.severity ?? 'error',
          stableJson(validationRule.parameters ?? {}),
          now,
          now,
        ]
      );
    }

    for (const releaseRule of rule.releaseRules ?? []) {
      await executor.execute(
        `INSERT INTO mapping_release_rules (
          id, tenant_id, field_mapping_version_id, destination_type, destination_id, source_ref_json,
          release_action, legal_basis, purpose, condition_json, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('mapping_release'),
          tenantId,
          fieldMappingVersionId,
          releaseRule.destinationType,
          releaseRule.destinationId ?? null,
          stableJson(releaseRule.sourceRef),
          releaseRule.releaseAction,
          releaseRule.legalBasis ?? null,
          releaseRule.purpose ?? null,
          stableJson(releaseRule.condition ?? {}),
          releaseRule.priority ?? 0,
          now,
          now,
        ]
      );
    }

    for (const conflictRule of rule.conflictRules ?? []) {
      await executor.execute(
        `INSERT INTO mapping_conflict_rules (
          id, tenant_id, field_mapping_version_id, target_ref_json, conflict_strategy,
          source_priority_json, condition_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('mapping_conflict'),
          tenantId,
          fieldMappingVersionId,
          stableJson(conflictRule.targetRef),
          conflictRule.conflictStrategy,
          stableJson(conflictRule.sourcePriority ?? []),
          stableJson(conflictRule.condition ?? {}),
          now,
          now,
        ]
      );
    }
  }

  private async getSourceProfileParseDraft(tenantId: string, draftId: string, now: number) {
    const draft = await this.adapter.queryOne<SourceProfileParseDraftRow>(
      `SELECT *
         FROM source_profile_parse_drafts
        WHERE tenant_id = ? AND id = ?`,
      [tenantId, draftId]
    );
    if (!draft) {
      throw notFound('source profile parse draft not found');
    }
    if (draft.expires_at <= now) {
      throw badRequest('source profile parse draft has expired');
    }
    return draft;
  }

  private async acquireActivationLease(
    tenantId: string,
    leaseKey: string,
    holderId: string,
    now: number
  ) {
    const lease = await this.adapter.queryOne<MappingActivationLeaseRow>(
      `SELECT holder_id, expires_at
         FROM mapping_activation_leases
        WHERE tenant_id = ? AND lease_key = ?`,
      [tenantId, leaseKey]
    );
    if (lease && lease.expires_at > now && lease.holder_id !== holderId) {
      throw conflict('field mapping set activation is already locked by another holder');
    }
    await this.adapter.execute(
      `INSERT INTO mapping_activation_leases (
        id, tenant_id, lease_key, holder_id, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, lease_key) DO UPDATE SET
        holder_id = excluded.holder_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`,
      [
        createId('mapping_activation_lease'),
        tenantId,
        leaseKey,
        holderId,
        now + ACTIVATION_LEASE_TTL_MS,
        now,
        now,
      ]
    );
  }
}

function catalogEntryValidation(entry: FieldCatalogEntry): Record<string, unknown> {
  const input = entry as FieldCatalogEntry & {
    allowedValues?: unknown;
    valueMultiplicity?: unknown;
    nullable?: unknown;
    required?: unknown;
  };
  return {
    ...(parseStringArray(input.allowedValues).length > 0
      ? { allowedValues: parseStringArray(input.allowedValues) }
      : {}),
    ...(input.valueMultiplicity === 'single' || input.valueMultiplicity === 'multi'
      ? { valueMultiplicity: input.valueMultiplicity }
      : {}),
    ...(typeof input.nullable === 'boolean' ? { nullable: input.nullable } : {}),
    ...(typeof input.required === 'boolean' ? { required: input.required } : {}),
  };
}

function customClaimSchemaToCatalogEntry(
  row: CustomClaimSchemaCatalogRow
): FieldCatalogEntrySummary[] {
  const fieldKey = normalizeCatalogFieldKey(row.active_field_key ?? row.field_key);
  if (!fieldKey) {
    return [];
  }

  const validation = parseJsonObject(row.validation_rules ?? '{}', {});
  const allowedValuesFromCatalog = parseStringArray(validation.allowedValues);
  const enumValues = parseStringArray(validation.enum_values);
  const required = readDatabaseBoolean(row.is_required);

  return [
    {
      id: `custom_claim_schema:${row.id}`,
      stableFieldId: `field.canonical.${fieldKey}`,
      namespace: DEFAULT_CANONICAL_NAMESPACE,
      path: fieldKey,
      targetTaxonomy: 'canonical',
      valueType: normalizeCatalogValueType(row.field_type),
      cardinality: row.cardinality === 'multi' ? 'multi' : 'single',
      classification: readDatabaseBoolean(row.is_pii) ? 'pii' : 'internal',
      aliases: [{ namespace: 'oidc', path: fieldKey }],
      uiGroupKey: row.ui_group_key,
      uiGroupLabel: row.ui_group_label,
      uiGroupOrder: row.ui_group_order ?? 90,
      uiFieldOrder: row.ui_field_order ?? row.display_order ?? 100,
      examples: parseJsonUnknownArray(row.examples_json),
      note: row.description,
      allowedValues: allowedValuesFromCatalog.length > 0 ? allowedValuesFromCatalog : enumValues,
      valueMultiplicity:
        row.cardinality === 'multi'
          ? 'multi'
          : validation.valueMultiplicity === 'single' || validation.valueMultiplicity === 'multi'
            ? validation.valueMultiplicity
            : 'single',
      nullable: required ? false : null,
      required,
    },
  ];
}

function normalizeCatalogFieldKey(value: string | null): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : null;
}

function normalizeCatalogValueType(value: string | null): string {
  switch (value) {
    case 'boolean':
    case 'number':
    case 'date':
      return value;
    case 'enum':
    case 'string':
    default:
      return 'string';
  }
}

function readDatabaseBoolean(value: number | boolean | null): boolean {
  return value === true || value === 1;
}

export async function adminIdentityMappingCatalogsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    catalogs: await repository.listCatalogs(tenantId),
  }));
}

export async function adminIdentityMappingCatalogCreateHandler(c: AdminContext) {
  return handleMutation(c, 'catalog.create', async (repository, tenantId, body) =>
    repository.createCatalog(tenantId, body as CreateCatalogRequest)
  );
}

export async function adminIdentityMappingProtocolSchemasListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    protocolSchemas: await repository.listProtocolSchemas(tenantId),
  }));
}

export async function adminIdentityMappingProtocolSchemaCreateHandler(c: AdminContext) {
  return handleMutation(c, 'protocol-schema.create', async (repository, tenantId, body) =>
    repository.createProtocolSchema(tenantId, body as CreateProtocolSchemaRequest)
  );
}

export async function adminIdentityMappingExternalSchemasListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    externalSchemas: await repository.listExternalSchemas(tenantId),
  }));
}

export async function adminIdentityMappingExternalSchemaImportHandler(c: AdminContext) {
  return handleMutation(c, 'external-schema.import', async (repository, tenantId, body) =>
    repository.importExternalSchema(tenantId, body as ImportExternalSchemaRequest)
  );
}

export async function adminIdentityMappingSourceProfilesListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    sourceProfiles: await repository.listSourceProfiles(tenantId),
  }));
}

export async function adminIdentityMappingCsvSourceProfileParseHandler(c: AdminContext) {
  return handleMutation(c, 'source-profile.csv.parse', async (repository, tenantId, body) =>
    repository.parseCsvSourceProfile(tenantId, body as ParseCsvSourceProfileRequest)
  );
}

export async function adminIdentityMappingSourceProfileCreateHandler(c: AdminContext) {
  return handleMutation(c, 'source-profile.create', async (repository, tenantId, body) =>
    repository.createSourceProfile(tenantId, body as CreateSourceProfileRequest)
  );
}

export async function adminIdentityMappingSourceProfileUpdateHandler(c: AdminContext) {
  return handleMutation(c, 'source-profile.update', async (repository, tenantId, body) =>
    repository.updateSourceProfile(
      tenantId,
      requiredParam(c, 'sourceProfileId'),
      body as UpdateSourceProfileRequest
    )
  );
}

export async function adminIdentityMappingSourceProfileReviewHandler(c: AdminContext) {
  return handleMutation(c, 'source-profile.review', async (repository, tenantId) =>
    repository.reviewSourceProfileVersion(
      tenantId,
      requiredParam(c, 'sourceProfileId'),
      requiredParam(c, 'sourceProfileVersionId')
    )
  );
}

export async function adminIdentityMappingSourceProfileActivateHandler(c: AdminContext) {
  return handleMutation(c, 'source-profile.activate', async (repository, tenantId) =>
    repository.activateSourceProfileVersion(
      tenantId,
      requiredParam(c, 'sourceProfileId'),
      requiredParam(c, 'sourceProfileVersionId')
    )
  );
}

export async function adminIdentityMappingSourceProfileDeleteHandler(c: AdminContext) {
  return handleMutation(c, 'source-profile.delete', async (repository, tenantId) =>
    repository.deleteSourceProfile(tenantId, requiredParam(c, 'sourceProfileId'))
  );
}

export async function adminIdentityMappingDestinationProfilesListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    destinationProfiles: await repository.listDestinationProfiles(tenantId),
  }));
}

export async function adminIdentityMappingDestinationProfileCreateHandler(c: AdminContext) {
  return handleMutation(c, 'destination-profile.create', async (repository, tenantId, body) => {
    assertPlatformOwnerScopeAllowed(c, body);
    return repository.createDestinationProfile(tenantId, body as CreateDestinationProfileRequest);
  });
}

export async function adminIdentityMappingDestinationProfileUpdateHandler(c: AdminContext) {
  return handleMutation(c, 'destination-profile.update', async (repository, tenantId, body) => {
    assertPlatformOwnerScopeAllowed(c, body);
    return repository.updateDestinationProfile(
      tenantId,
      requiredParam(c, 'destinationProfileId'),
      body as UpdateDestinationProfileRequest,
      hasPlatformOwnerScopeAuthority(c)
    );
  });
}

export async function adminIdentityMappingDestinationProfileReviewHandler(c: AdminContext) {
  return handleMutation(c, 'destination-profile.review', async (repository, tenantId) =>
    repository.reviewDestinationProfileVersion(
      tenantId,
      requiredParam(c, 'destinationProfileId'),
      requiredParam(c, 'destinationProfileVersionId'),
      hasPlatformOwnerScopeAuthority(c)
    )
  );
}

export async function adminIdentityMappingDestinationProfileActivateHandler(c: AdminContext) {
  return handleMutation(c, 'destination-profile.activate', async (repository, tenantId) =>
    repository.activateDestinationProfileVersion(
      tenantId,
      requiredParam(c, 'destinationProfileId'),
      requiredParam(c, 'destinationProfileVersionId'),
      hasPlatformOwnerScopeAuthority(c)
    )
  );
}

export async function adminIdentityMappingDestinationProfileDeleteHandler(c: AdminContext) {
  return handleMutation(c, 'destination-profile.delete', async (repository, tenantId) =>
    repository.deleteDestinationProfile(
      tenantId,
      requiredParam(c, 'destinationProfileId'),
      hasPlatformOwnerScopeAuthority(c)
    )
  );
}

export async function adminIdentityMappingAttributeGroupsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    attributeGroups: await repository.listAttributeGroups(tenantId),
  }));
}

export async function adminIdentityMappingAttributeGroupCreateHandler(c: AdminContext) {
  return handleMutation(c, 'attribute-group.create', async (repository, tenantId, body) => {
    assertPlatformOwnerScopeAllowed(c, body);
    return repository.createAttributeGroup(tenantId, body as CreateAttributeGroupRequest);
  });
}

export async function adminIdentityMappingAttributeFieldsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    attributeFields: await repository.listAttributeFields(tenantId),
  }));
}

export async function adminIdentityMappingAttributeFieldCreateHandler(c: AdminContext) {
  return handleMutation(c, 'attribute-field.create', async (repository, tenantId, body) => {
    assertPlatformOwnerScopeAllowed(c, body);
    return repository.createAttributeField(tenantId, body as CreateAttributeFieldRequest);
  });
}

export async function adminIdentityMappingTemplatesListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    templates: await repository.listMappingTemplates(tenantId),
  }));
}

export async function adminIdentityMappingTemplateCreateHandler(c: AdminContext) {
  return handleMutation(c, 'template.create', async (repository, tenantId, body) =>
    repository.createMappingTemplate(tenantId, body as CreateMappingTemplateRequest)
  );
}

export async function adminIdentityFieldMappingSetsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    fieldMappingSets: await repository.listFieldMappingSets(tenantId),
  }));
}

export async function adminIdentityFieldMappingVersionsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    fieldMappingVersions: await repository.listFieldMappingVersions(
      tenantId,
      requiredParam(c, 'fieldMappingSetId')
    ),
  }));
}

export async function adminIdentityFieldMappingSetCreateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.create', async (repository, tenantId, body) =>
    repository.createFieldMappingSet(tenantId, body as CreateFieldMappingSetRequest)
  );
}

export async function adminIdentityFieldMappingSetDeleteHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.delete', async (repository, tenantId) =>
    repository.deleteFieldMappingSet(tenantId, requiredParam(c, 'fieldMappingSetId'))
  );
}

export async function adminIdentityFieldMappingVersionCreateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.create', async (repository, tenantId, body) => {
    const request = body as CreateFieldMappingVersionRequest;
    const adminAuth = (
      c as unknown as { get: (key: string) => { userId?: string } | undefined }
    ).get('adminAuth');
    return repository.createFieldMappingVersion(tenantId, requiredParam(c, 'fieldMappingSetId'), {
      ...request,
      authorId: request.authorId ?? adminAuth?.userId,
    });
  });
}

export async function adminIdentityFieldMappingVersionPublishHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.publish', async (repository, tenantId) =>
    repository.publishFieldMappingVersion(
      tenantId,
      requiredParam(c, 'fieldMappingSetId'),
      requiredParam(c, 'fieldMappingVersionId')
    )
  );
}

export async function adminIdentityFieldMappingVersionCompileHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.compile', async (repository, tenantId, body) =>
    repository.compileFieldMappingVersion(
      tenantId,
      requiredParam(c, 'fieldMappingSetId'),
      requiredParam(c, 'fieldMappingVersionId'),
      body as CompileFieldMappingRequest
    )
  );
}

export async function adminIdentityFieldMappingVersionActivateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.activate', async (repository, tenantId, body) =>
    repository.activateFieldMappingVersion(
      tenantId,
      requiredParam(c, 'fieldMappingSetId'),
      requiredParam(c, 'fieldMappingVersionId'),
      body as ActivateFieldMappingRequest
    )
  );
}

export async function adminIdentityFieldMappingVersionDeactivateHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.version.deactivate', async (repository, tenantId) =>
    repository.deactivateFieldMappingVersion(
      tenantId,
      requiredParam(c, 'fieldMappingSetId'),
      requiredParam(c, 'fieldMappingVersionId')
    )
  );
}

export async function adminIdentityFieldMappingSetRollbackHandler(c: AdminContext) {
  return handleMutation(c, 'field_mapping.rollback', async (repository, tenantId) =>
    repository.rollbackFieldMappingSet(tenantId, requiredParam(c, 'fieldMappingSetId'))
  );
}

export async function adminIdentityMappingSourceAuthorityContractsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    sourceAuthorityContracts: await repository.listSourceAuthorityContracts(tenantId),
  }));
}

export async function adminIdentityMappingSourceAuthorityContractCreateHandler(c: AdminContext) {
  return handleMutation(c, 'source-authority-contract.create', async (repository, tenantId, body) =>
    repository.createSourceAuthorityContract(tenantId, body as CreateSourceAuthorityContractRequest)
  );
}

export async function adminIdentityMappingSourceAuthorityEvaluateHandler(c: AdminContext) {
  return handleMutation(
    c,
    'source-authority-contract.evaluate',
    async (repository, tenantId, body) =>
      repository.evaluateSourceAuthorityContract(
        tenantId,
        body as EvaluateSourceAuthorityContractRequest
      )
  );
}

export async function adminIdentityMappingSchemaReadinessHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository) => repository.listSchemaReadiness());
}

export async function adminIdentityMappingReviewTasksListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    reviewTasks: await repository.listReviewTasks(tenantId, {
      status: c.req.query('status'),
      taskType: c.req.query('taskType'),
      assignedTo: c.req.query('assignedTo'),
      limit: parseOptionalInteger(c.req.query('limit')),
    }),
  }));
}

export async function adminIdentityMappingReviewTaskCreateHandler(c: AdminContext) {
  return handleMutation(c, 'review-task.create', async (repository, tenantId, body) =>
    repository.createReviewTask(tenantId, body as CreateReviewTaskRequest)
  );
}

export async function adminIdentityMappingReviewTaskTransitionHandler(c: AdminContext) {
  const reviewTaskId = c.req.param('reviewTaskId') ?? '';
  return handleMutation(c, 'review-task.transition', async (repository, tenantId, body) =>
    repository.transitionReviewTask(tenantId, reviewTaskId, body as TransitionReviewTaskRequest)
  );
}

export async function adminIdentityMappingReviewTaskGroupCreateHandler(c: AdminContext) {
  return handleMutation(c, 'review-task-group.create', async (repository, tenantId, body) =>
    repository.createReviewTaskGroup(tenantId, body as CreateReviewTaskGroupRequest)
  );
}

export async function adminIdentityMappingOperationalNotificationCreateHandler(c: AdminContext) {
  return handleMutation(c, 'operational-notification.create', async (repository, tenantId, body) =>
    repository.enqueueOperationalNotification(
      tenantId,
      body as EnqueueOperationalNotificationRequest
    )
  );
}

export async function adminIdentityMappingOperationalNotificationAcknowledgeHandler(
  c: AdminContext
) {
  const stateId = c.req.param('stateId') ?? '';
  return handleMutation(
    c,
    'operational-notification.acknowledge',
    async (repository, tenantId, body) =>
      repository.transitionOperationalNotificationState(tenantId, stateId, {
        ...(body as Omit<TransitionOperationalNotificationStateRequest, 'state'>),
        state: 'acknowledged',
      })
  );
}

export async function adminIdentityMappingOperationalNotificationResolveHandler(c: AdminContext) {
  const stateId = c.req.param('stateId') ?? '';
  return handleMutation(c, 'operational-notification.resolve', async (repository, tenantId, body) =>
    repository.transitionOperationalNotificationState(tenantId, stateId, {
      ...(body as Omit<TransitionOperationalNotificationStateRequest, 'state'>),
      state: 'resolved',
    })
  );
}

export async function adminIdentityMappingGroupCreateHandler(c: AdminContext) {
  return handleMutation(c, 'group.create', async (repository, tenantId, body) =>
    repository.createGroup(tenantId, body as CreateGroupRequest)
  );
}

export async function adminIdentityMappingGroupMembershipCreateHandler(c: AdminContext) {
  return handleMutation(c, 'group-membership.create', async (repository, tenantId, body) =>
    repository.createGroupMembership(tenantId, {
      ...(body as Omit<CreateGroupMembershipRequest, 'groupId'>),
      groupId: requiredParam(c, 'groupId'),
    })
  );
}

export async function adminIdentityMappingEntitlementGrantHandler(c: AdminContext) {
  return handleMutation(c, 'entitlement.grant', async (repository, tenantId, body) =>
    repository.grantEntitlement(tenantId, body as GrantEntitlementRequest)
  );
}

export async function adminIdentityMappingProvisioningAssignmentRuleCreateHandler(c: AdminContext) {
  return handleMutation(
    c,
    'provisioning-assignment-rule.create',
    async (repository, tenantId, body) =>
      repository.createProvisioningAssignmentRule(
        tenantId,
        body as CreateProvisioningAssignmentRuleRequest
      )
  );
}

export async function adminIdentityMappingProvisioningAssignmentRuleEvaluateHandler(
  c: AdminContext
) {
  return handleMutation(
    c,
    'provisioning-assignment-rule.evaluate',
    async (repository, tenantId, body) =>
      repository.evaluateProvisioningAssignmentRule(
        tenantId,
        requiredParam(c, 'ruleId'),
        body as EvaluateProvisioningAssignmentRequest
      )
  );
}

export async function adminIdentityMappingLifecycleSignalRecordHandler(c: AdminContext) {
  return handleMutation(c, 'lifecycle-signal.record', async (repository, tenantId, body) =>
    repository.recordExternalLifecycleSignal(tenantId, body as RecordLifecycleSignalRequest)
  );
}

export async function adminIdentityMappingKeyRegistryCreateHandler(c: AdminContext) {
  return handleMutation(c, 'key-registry.create', async (repository, tenantId, body) =>
    repository.createKeyRegistry(tenantId, body as CreateKeyRegistryRequest)
  );
}

export async function adminIdentityMappingKeyRegistriesListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    keyRegistries: await repository.listKeyRegistries(tenantId),
  }));
}

export async function adminIdentityMappingKeyRegistryRotateHandler(c: AdminContext) {
  return handleMutation(c, 'key-registry.rotate', async (repository, tenantId, body) =>
    repository.rotateKeyRegistry(
      tenantId,
      requiredParam(c, 'keyRegistryId'),
      body as RotateKeyRegistryRequest
    )
  );
}

export async function adminIdentityMappingKeyAccessRecordHandler(c: AdminContext) {
  return handleMutation(c, 'key-access.record', async (repository, tenantId, body) =>
    repository.recordKeyAccess(
      tenantId,
      requiredParam(c, 'keyRegistryId'),
      body as RecordKeyAccessRequest
    )
  );
}

export async function adminIdentityMappingFederationTrustSourceCreateHandler(c: AdminContext) {
  return handleMutation(c, 'federation-trust-source.create', async (repository, tenantId, body) =>
    repository.createFederationTrustSource(tenantId, body as CreateFederationTrustSourceRequest)
  );
}

export async function adminIdentityMappingFederationTrustSourcesListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    federationTrustSources: await repository.listFederationTrustSources(tenantId),
  }));
}

export async function adminIdentityMappingFederationTrustSourceUpdateHandler(c: AdminContext) {
  return handleMutation(c, 'federation-trust-source.update', async (repository, tenantId, body) =>
    repository.updateFederationTrustSource(
      tenantId,
      requiredParam(c, 'trustSourceId'),
      body as UpdateFederationTrustSourceRequest
    )
  );
}

export async function adminIdentityMappingFederationTrustSourceDeleteHandler(c: AdminContext) {
  return handleMutation(c, 'federation-trust-source.delete', async (repository, tenantId) =>
    repository.deleteFederationTrustSource(tenantId, requiredParam(c, 'trustSourceId'))
  );
}

export async function adminIdentityMappingFederationMetadataDocumentsListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    federationMetadataDocuments: await repository.listFederationMetadataDocuments(
      tenantId,
      requiredParam(c, 'trustSourceId')
    ),
  }));
}

export async function adminIdentityMappingFederationMetadataDocumentCreateHandler(c: AdminContext) {
  return handleMutation(
    c,
    'federation-metadata-document.create',
    async (repository, tenantId, body) =>
      repository.registerFederationMetadataDocument(
        tenantId,
        body as RegisterFederationMetadataDocumentRequest
      )
  );
}

async function handleControlPlane<T>(
  c: AdminContext,
  operation: (repository: IdentityMappingControlPlaneRepository, tenantId: string) => Promise<T>
): Promise<Response> {
  try {
    const tenantId = getTenantIdFromContext(c);
    const repository = createRepository(c);
    return c.json(await operation(repository, tenantId));
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}

async function handleMutation<T>(
  c: AdminContext,
  operationKey: string,
  operation: (
    repository: IdentityMappingControlPlaneRepository,
    tenantId: string,
    body: unknown
  ) => Promise<T>
): Promise<Response> {
  try {
    const body = await readJsonBody(c);
    const tenantId = getTenantIdFromContext(c);
    const repository = createRepository(c);
    const idempotencyKey = c.req.header('Idempotency-Key');
    const { result } = await repository.runIdempotent(
      tenantId,
      operationKey,
      idempotencyKey ?? null,
      body,
      () => operation(repository, tenantId, body)
    );
    return c.json({ result });
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}

function createRepository(c: AdminContext): IdentityMappingControlPlaneRepository {
  const tenantId = getTenantIdFromContext(c);
  const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
  return new IdentityMappingControlPlaneRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'identity-mapping-control-plane'),
    () => Date.now(),
    coreAdapter,
    async (targetTenantId, accountId, sourceVersionMs, operationId) => {
      const account = await coreAdapter.queryOne<{ legacy_user_id: string | null }>(
        'SELECT legacy_user_id FROM identity_accounts WHERE tenant_id = ? AND id = ?',
        [targetTenantId, accountId]
      );
      if (!account?.legacy_user_id) {
        throw new Error('account_authentication_subject_unavailable');
      }
      await transitionAccountAuthenticationState(c.env, {
        tenantId: targetTenantId,
        userId: account.legacy_user_id,
        lifecycle: 'suspended',
        sourceVersionMs,
        operationId,
        revokeSessions: true,
      });
    }
  );
}

function assertPlatformOwnerScopeAllowed(c: AdminContext, body: unknown): void {
  if (!isRecord(body) || body.ownerScopeType !== 'platform') {
    return;
  }
  if (hasPlatformOwnerScopeAuthority(c)) {
    return;
  }
  throw forbidden('platform owner scope requires platform admin authority');
}

function hasPlatformOwnerScopeAuthority(c: AdminContext): boolean {
  const auth = (c as unknown as { get(key: string): unknown }).get('adminAuth') as
    | {
        is_platform_admin?: boolean;
        roles?: string[];
        permissions?: string[];
      }
    | undefined;
  const roles = auth?.roles ?? [];
  const permissions = auth?.permissions ?? [];
  if (
    auth?.is_platform_admin === true ||
    roles.includes('super_admin') ||
    roles.includes('system_admin') ||
    permissions.includes('*')
  ) {
    return true;
  }
  return false;
}

async function readJsonBody(c: AdminContext): Promise<unknown> {
  try {
    const text = await c.req.text();
    if (!text.trim()) {
      return {};
    }
    const body = JSON.parse(text) as unknown;
    if (!isRecord(body)) {
      throw badRequest('Request body must be an object');
    }
    return body;
  } catch (error) {
    if (error instanceof IdentityMappingControlPlaneError) {
      throw error;
    }
    throw badRequest('Request body must be valid JSON');
  }
}

function controlPlaneErrorResponse(c: AdminContext, error: unknown): Response {
  if (error instanceof IdentityMappingControlPlaneError) {
    return c.json(
      {
        error: error.code,
        error_description: error.message,
      },
      error.status as 400 | 404 | 409 | 500
    );
  }
  return c.json(
    {
      error: 'internal_error',
      error_description: 'Identity mapping control plane operation failed',
    },
    500
  );
}

function validateRequiredString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badRequest(`${field} is required`);
  }
}

function normalizeCsvEncoding(value: unknown): string {
  const encoding = typeof value === 'string' ? value.trim().toLowerCase() : 'utf-8';
  if (encoding === 'utf8' || encoding === 'utf-8-bom') return 'utf-8';
  if (['utf-8', 'shift_jis', 'shift-jis', 'cp932', 'euc-jp'].includes(encoding)) {
    return encoding;
  }
  throw badRequest('encoding must be utf-8, shift_jis, cp932, or euc-jp');
}

function normalizeCsvParserOptions(value: unknown): CsvSourceProfileParserOptions {
  if (!isRecord(value)) return {};
  const options: CsvSourceProfileParserOptions = {};
  if (isCsvDelimiter(value.delimiter)) options.delimiter = value.delimiter;
  if (value.quote === '"' || value.quote === "'") options.quote = value.quote;
  if (value.escape === '"' || value.escape === "'" || value.escape === '\\') {
    options.escape = value.escape;
  }
  if (value.newline === 'auto' || value.newline === '\n' || value.newline === '\r\n') {
    options.newline = value.newline;
  }
  if (
    value.headerMode === 'auto' ||
    value.headerMode === 'first_row' ||
    value.headerMode === 'none'
  ) {
    options.headerMode = value.headerMode;
  }
  if (typeof value.maxRows === 'number') {
    const maxRows = Math.trunc(value.maxRows);
    if (maxRows < 1 || maxRows > CSV_SOURCE_PROFILE_MAX_ROWS) {
      throw badRequest(`maxRows must be between 1 and ${CSV_SOURCE_PROFILE_MAX_ROWS}`);
    }
    options.maxRows = maxRows;
  }
  if (typeof value.maxColumns === 'number') {
    const maxColumns = Math.trunc(value.maxColumns);
    if (maxColumns < 1 || maxColumns > CSV_SOURCE_PROFILE_MAX_COLUMNS) {
      throw badRequest(`maxColumns must be between 1 and ${CSV_SOURCE_PROFILE_MAX_COLUMNS}`);
    }
    options.maxColumns = maxColumns;
  }
  return options;
}

function isCsvDelimiter(
  value: unknown
): value is NonNullable<CsvSourceProfileParserOptions['delimiter']> {
  return value === 'auto' || value === ',' || value === '\t' || value === ';' || value === '|';
}

function decodeBase64Text(contentBase64: string, encoding: string): string {
  try {
    const binary = atob(contentBase64);
    if (binary.length > CSV_SOURCE_PROFILE_MAX_BYTES) {
      throw badRequest(
        `contentBase64 decoded payload must be at most ${CSV_SOURCE_PROFILE_MAX_BYTES} bytes`
      );
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder(encoding, { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch (error) {
    if (error instanceof IdentityMappingControlPlaneError) {
      throw error;
    }
    throw badRequest('contentBase64 could not be decoded with the selected encoding');
  }
}

function assertCsvSourceProfilePayloadBudget(contentBase64: string): void {
  if (contentBase64.length > CSV_SOURCE_PROFILE_MAX_BASE64_CHARS) {
    throw badRequest(
      `contentBase64 encoded payload must be at most ${CSV_SOURCE_PROFILE_MAX_BASE64_CHARS} characters`
    );
  }
}

function normalizeWarningSummary(
  value: unknown,
  fallbackJson?: string | null
): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (!fallbackJson) return {};
  const parsed = JSON.parse(fallbackJson) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function getNumberProperty(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
}

function normalizeProfileOwner(
  tenantId: string,
  ownerScopeType?: string,
  ownerScopeId?: string | null
) {
  const normalizedOwnerScopeType = ownerScopeType ?? 'tenant';
  if (!PROFILE_OWNER_SCOPE_TYPES.has(normalizedOwnerScopeType)) {
    throw badRequest('ownerScopeType must be platform, tenant, or client');
  }
  return {
    tenantId: normalizedOwnerScopeType === 'platform' ? 'platform' : tenantId,
    ownerScopeType: normalizedOwnerScopeType,
    ownerScopeId: normalizedOwnerScopeType === 'tenant' ? null : (ownerScopeId ?? null),
  };
}

function assertDestinationProfileOwner(
  destinationType: string,
  owner: { ownerScopeType: string; ownerScopeId: string | null }
): void {
  if (destinationType !== 'resource_server') return;
  if (owner.ownerScopeType !== 'client' || !owner.ownerScopeId) {
    throw badRequest('resource_server destination profiles must be owned by a specific client');
  }
}

function normalizeRegistryOwner(
  tenantId: string,
  ownerScopeType?: string,
  ownerScopeId?: string | null
) {
  const normalizedOwnerScopeType = ownerScopeType ?? 'tenant';
  if (!REGISTRY_OWNER_SCOPE_TYPES.has(normalizedOwnerScopeType)) {
    throw badRequest('ownerScopeType must be platform or tenant');
  }
  return {
    tenantId: normalizedOwnerScopeType === 'platform' ? 'platform' : tenantId,
    ownerScopeType: normalizedOwnerScopeType,
    ownerScopeId: normalizedOwnerScopeType === 'tenant' ? null : (ownerScopeId ?? null),
  };
}

function validateOidcClaimName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_:.~-]{0,127}$/.test(value)) {
    throw badRequest('claimName must be a valid OIDC claim name');
  }
}

function validateAttributeProtocol(value: string): void {
  if (!['oidc', 'saml', 'vc'].includes(value)) {
    throw badRequest('protocol must be oidc, saml, or vc');
  }
}

function validateAttributeKey(value: string, fieldName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_:.~-]{0,127}$/.test(value)) {
    throw badRequest(`${fieldName} must be a valid attribute key`);
  }
}

function normalizeOidcSurfaces(value: unknown[]): string[] {
  const surfaces = value.map(String).filter((surface) => OIDC_SURFACES.has(surface));
  if (surfaces.length === 0) {
    throw badRequest('surfaces must include id_token or userinfo');
  }
  return Array.from(new Set(surfaces)).sort();
}

function validateDestinationProfileSchema(
  destinationType: string,
  schema: Record<string, unknown>,
  attributeGroups: Array<{
    protocol: string;
    groupType: string;
    groupKey: string;
    fieldKeys: string[];
  }>
) {
  switch (destinationType) {
    case 'oidc':
      return validateOidcDestinationProfileSchema(schema, attributeGroups);
    case 'csv':
      return validateCsvDestinationProfileSchema(schema);
    case 'saml':
      return validateSamlDestinationProfileSchema(schema);
    case 'resource_server':
      return validateResourceServerDestinationProfileSchema(schema);
    default:
      throw badRequest('destinationType must be oidc, csv, saml, or resource_server');
  }
}

function validateResourceServerDestinationProfileSchema(schema: Record<string, unknown>) {
  const claims = Array.isArray(schema.claims)
    ? schema.claims.filter(isRecord)
    : ([] as Record<string, unknown>[]);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (schema.destinationType !== 'resource_server') {
    errors.push('destinationType must be resource_server');
  }

  const activeClaim = claims.find((claim) => claim.claimName === 'active');
  if (!activeClaim) {
    errors.push('Resource Server destination profile must include active');
  } else {
    if (activeClaim.required === false) {
      errors.push('Introspection active claim must be required');
    }
    if (
      Array.isArray(activeClaim.requiredScopes) &&
      activeClaim.requiredScopes.map(String).some(Boolean)
    ) {
      errors.push('Introspection active claim must not depend on optional scopes');
    }
  }

  const claimNames = new Set<string>();
  let piiClaimCount = 0;
  let regulatedClaimCount = 0;
  let requiredClaimCount = 0;
  for (const claim of claims) {
    const claimName = String(claim.claimName ?? '');
    if (!claimName) {
      errors.push('claimName is required');
      continue;
    }
    if (claimNames.has(claimName)) errors.push(`${claimName} appears more than once`);
    claimNames.add(claimName);
    try {
      validateOidcClaimName(claimName);
    } catch {
      errors.push(`${claimName} is not a valid introspection claim name`);
    }
    validateFieldConstraintDefinition(claim, `claim ${claimName}`, errors);
    if (claim.required === true || claimName === 'active') requiredClaimCount += 1;
    const requiredScopes = Array.isArray(claim.requiredScopes)
      ? claim.requiredScopes.map(String).filter(Boolean)
      : [];
    const classification = String(claim.classification ?? 'internal');
    if (classification === 'pii') piiClaimCount += 1;
    if (classification === 'regulated') regulatedClaimCount += 1;
    if (
      claimName !== 'active' &&
      (classification === 'pii' || classification === 'regulated') &&
      requiredScopes.length === 0
    ) {
      errors.push(`${claimName} must require at least one scope before releasing sensitive data`);
    }
  }

  return {
    errorCount: errors.length,
    errors,
    warningCount: warnings.length,
    warnings,
    warningSummary: {
      warningCount: warnings.length,
      blockingWarningCount: 0,
      overReleaseWarningCount: 0,
    },
    releaseImpact: {
      destinationType: 'resource_server',
      claimCount: claims.length,
      requiredClaimCount,
      surfaces: ['introspection'],
      piiClaimCount,
      regulatedClaimCount,
    },
  };
}

function validateOidcDestinationProfileSchema(
  schema: Record<string, unknown>,
  attributeGroups: Array<{
    protocol: string;
    groupType: string;
    groupKey: string;
    fieldKeys: string[];
  }>
) {
  const claims = Array.isArray(schema.claims)
    ? schema.claims.filter(isRecord)
    : ([] as Record<string, unknown>[]);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (schema.destinationType !== 'oidc') errors.push('destinationType must be oidc');
  if (!claims.some((claim) => claim.claimName === 'sub')) {
    errors.push('OIDC destination profile must include sub');
  }
  if (claims.some((claim) => claim.claimName === 'sub' && claim.required === false)) {
    errors.push('OIDC sub claim must be required');
  }
  const subjectClaims = claims.filter((claim) => claim.claimName === 'sub');
  for (const subjectClaim of subjectClaims) {
    const surfaces = Array.isArray(subjectClaim.surfaces) ? subjectClaim.surfaces.map(String) : [];
    if (!surfaces.includes('id_token') || !surfaces.includes('userinfo')) {
      errors.push('OIDC sub claim must target both id_token and userinfo');
    }
    if (
      Array.isArray(subjectClaim.requiredScopes) &&
      subjectClaim.requiredScopes.map(String).some(Boolean)
    ) {
      errors.push('OIDC sub claim must not depend on optional scopes');
    }
    if (subjectClaim.nullable === true) {
      errors.push('OIDC sub claim must not be nullable');
    }
  }

  const claimNames = new Set<string>();
  const attributeGroupFields = new Map(
    attributeGroups
      .filter((group) => group.protocol === 'oidc' && group.groupType === 'scope')
      .map((group) => [group.groupKey, group.fieldKeys])
  );
  let piiClaimCount = 0;
  let regulatedClaimCount = 0;
  let blockingWarningCount = 0;
  let overReleaseWarningCount = 0;
  let claimsParameterClaimCount = 0;
  let essentialClaimCount = 0;
  let requiredClaimCount = 0;

  for (const claim of claims) {
    const claimName = String(claim.claimName ?? '');
    if (!claimName) {
      errors.push('claimName is required');
      continue;
    }
    claimNames.add(claimName);
    try {
      validateOidcClaimName(claimName);
    } catch {
      errors.push(`${claimName} is not a valid OIDC claim name`);
    }
    if (OIDC_RESERVED_NON_PROFILE_CLAIMS.has(claimName)) {
      errors.push(`${claimName} is reserved by the OIDC token envelope`);
    }
    validateFieldConstraintDefinition(claim, `claim ${claimName}`, errors);
    if (claim.required === true || claimName === 'sub') requiredClaimCount += 1;
    const surfaces = Array.isArray(claim.surfaces) ? claim.surfaces.map(String) : [];
    if (surfaces.length === 0 || surfaces.some((surface) => !OIDC_SURFACES.has(surface))) {
      errors.push(`${claimName} must target id_token or userinfo`);
    }
    const requiredScopes = Array.isArray(claim.requiredScopes)
      ? claim.requiredScopes.map(String).filter(Boolean)
      : [];
    for (const scope of requiredScopes) {
      if (!OIDC_STANDARD_SCOPES.has(scope) && !attributeGroupFields.has(scope)) {
        warnings.push(`${claimName} references unknown attribute group ${scope}`);
      }
    }
    const classification = String(claim.classification ?? 'internal');
    if (classification === 'pii') piiClaimCount += 1;
    if (classification === 'regulated') regulatedClaimCount += 1;
    if (
      (classification === 'pii' || classification === 'regulated') &&
      requiredScopes.length === 0
    ) {
      errors.push(`${claimName} must require at least one scope before releasing sensitive data`);
    }
    if (isOverReleasedOidcClaim(claimName, requiredScopes, attributeGroupFields)) {
      overReleaseWarningCount += 1;
      warnings.push(`${claimName} is not covered by its configured scopes`);
    }
  }

  if (isRecord(schema.claimsParameter)) {
    const claimsParameter = schema.claimsParameter;
    for (const surface of ['id_token', 'userinfo']) {
      const surfaceClaims = claimsParameter[surface];
      if (!isRecord(surfaceClaims)) continue;
      for (const [claimName, requestConfig] of Object.entries(surfaceClaims)) {
        claimsParameterClaimCount += 1;
        if (!claimNames.has(claimName)) {
          errors.push(
            `claimsParameter.${surface}.${claimName} must reference a defined profile claim`
          );
        }
        if (isRecord(requestConfig) && requestConfig.essential === true) {
          essentialClaimCount += 1;
          warnings.push(`${claimName} uses OIDC claims essential syntax`);
        }
      }
    }
    if (claimsParameter.acr_values !== undefined || claimsParameter.acr !== undefined) {
      warnings.push('claimsParameter includes acr constraints for dry-run trace');
    }
    if (claimsParameter.ui_locales !== undefined || claimsParameter.locale !== undefined) {
      warnings.push('claimsParameter includes locale constraints for dry-run trace');
    }
  }

  return {
    errorCount: errors.length,
    errors,
    warningCount: warnings.length,
    warnings,
    warningSummary: {
      warningCount: warnings.length,
      blockingWarningCount,
      overReleaseWarningCount,
      essentialClaimCount,
    },
    releaseImpact: {
      destinationType: 'oidc',
      claimCount: claims.length,
      claimsParameterClaimCount,
      essentialClaimCount,
      requiredClaimCount,
      surfaces: ['id_token', 'userinfo'].filter((surface) =>
        claims.some((claim) => Array.isArray(claim.surfaces) && claim.surfaces.includes(surface))
      ),
      piiClaimCount,
      regulatedClaimCount,
    },
  };
}

function isOverReleasedOidcClaim(
  claimName: string,
  requiredScopes: string[],
  customScopeClaims: Map<string, string[]>
): boolean {
  if (claimName === 'sub') return false;
  if (!OIDC_STANDARD_CLAIMS.has(claimName)) {
    return !requiredScopes.some((scope) => customScopeClaims.get(scope)?.includes(claimName));
  }
  if (requiredScopes.length === 0) return true;
  for (const scope of requiredScopes) {
    if (OIDC_STANDARD_SCOPE_ALLOWED_CLAIMS.get(scope)?.includes(claimName)) return false;
  }
  return !requiredScopes.some((scope) => customScopeClaims.get(scope)?.includes(claimName));
}

function validateCsvDestinationProfileSchema(schema: Record<string, unknown>) {
  const columns = Array.isArray(schema.columns)
    ? schema.columns.filter(isRecord)
    : ([] as Record<string, unknown>[]);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (schema.destinationType !== 'csv') errors.push('destinationType must be csv');
  if (columns.length === 0) errors.push('CSV destination profile must include columns');
  const seenNames = new Set<string>();
  let piiColumnCount = 0;
  let regulatedColumnCount = 0;
  let blockingWarningCount = 0;
  for (const column of columns) {
    const columnName = String(column.columnName ?? '');
    if (!columnName) {
      errors.push('columnName is required');
      continue;
    }
    if (seenNames.has(columnName)) errors.push(`${columnName} appears more than once`);
    seenNames.add(columnName);
    validateFieldConstraintDefinition(column, `column ${columnName}`, errors);
    const classification = String(column.classification ?? 'internal');
    if (classification === 'pii') piiColumnCount += 1;
    if (classification === 'regulated') regulatedColumnCount += 1;
    if (
      (classification === 'pii' || classification === 'regulated') &&
      !isRecord(column.exportPolicy)
    ) {
      blockingWarningCount += 1;
      warnings.push(`${columnName} releases sensitive data without export policy`);
    }
  }
  return {
    errorCount: errors.length,
    errors,
    warningCount: warnings.length,
    warnings,
    warningSummary: {
      warningCount: warnings.length,
      blockingWarningCount,
    },
    releaseImpact: {
      destinationType: 'csv',
      columnCount: columns.length,
      encodingDefault: String(isRecord(schema.defaults) ? schema.defaults.encoding : 'utf-8'),
      piiColumnCount,
      regulatedColumnCount,
    },
  };
}

function validateSamlDestinationProfileSchema(schema: Record<string, unknown>) {
  const attributes = Array.isArray(schema.attributes)
    ? schema.attributes.filter(isRecord)
    : ([] as Record<string, unknown>[]);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (schema.destinationType !== 'saml') errors.push('destinationType must be saml');
  if (!isRecord(schema.nameId)) {
    errors.push('SAML destination profile must include nameId');
  }
  if (attributes.length === 0) errors.push('SAML destination profile must include attributes');

  const seenNames = new Set<string>();
  let piiAttributeCount = 0;
  let regulatedAttributeCount = 0;
  let blockingWarningCount = 0;

  for (const attribute of attributes) {
    const name = String(attribute.name ?? '');
    if (!name) {
      errors.push('SAML attribute name is required');
      continue;
    }
    if (seenNames.has(name)) errors.push(`${name} appears more than once`);
    seenNames.add(name);
    if (attribute.required !== undefined) {
      errors.push(
        `${name}.required must be configured on the SAML SP, not the Destination Profile`
      );
    }
    validateFieldConstraintDefinition(attribute, `SAML attribute ${name}`, errors);
    const classification = String(attribute.classification ?? 'internal');
    if (classification === 'pii') piiAttributeCount += 1;
    if (classification === 'regulated') regulatedAttributeCount += 1;
    if (
      (classification === 'pii' || classification === 'regulated') &&
      !isRecord(attribute.releasePolicy)
    ) {
      blockingWarningCount += 1;
      warnings.push(`${name} releases sensitive data without release policy`);
    }
  }

  return {
    errorCount: errors.length,
    errors,
    warningCount: warnings.length,
    warnings,
    warningSummary: {
      warningCount: warnings.length,
      blockingWarningCount,
    },
    releaseImpact: {
      destinationType: 'saml',
      attributeCount: attributes.length,
      nameIdFormat: isRecord(schema.nameId) ? String(schema.nameId.format ?? '') : '',
      piiAttributeCount,
      regulatedAttributeCount,
    },
  };
}

function requiredParam(c: AdminContext, name: string): string {
  const value = c.req.param(name);
  validateRequiredString(value, name);
  return value;
}

function validateCustomEntries(
  entries: FieldCatalogEntry[],
  customEntries: NonNullable<CreateCatalogRequest['customEntries']>
) {
  const lockedKeys = new Set<string>();
  for (const entry of entries) {
    lockedKeys.add(entry.id);
    lockedKeys.add(`${entry.namespace}:${entry.path}`);
    for (const alias of entry.aliases ?? []) {
      lockedKeys.add(`${alias.namespace}:${alias.path}`);
    }
  }
  const seenCustomKeys = new Set<string>();
  for (const customEntry of customEntries) {
    validateRequiredString(customEntry.customKey, 'customKey');
    validateRequiredString(customEntry.displayName, 'customEntry.displayName');
    validateRequiredString(customEntry.valueType, 'customEntry.valueType');
    if (lockedKeys.has(customEntry.customKey)) {
      throw badRequest('custom field cannot shadow a built-in catalog field');
    }
    if (seenCustomKeys.has(customEntry.customKey)) {
      throw badRequest('custom field keys must be unique');
    }
    seenCustomKeys.add(customEntry.customKey);
  }
}

function assertNoSensitiveMetadata(value: unknown, path: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveMetadata(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (
      normalized === 'value' ||
      normalized === 'rawvalue' ||
      normalized.includes('password') ||
      normalized.includes('secret') ||
      normalized.includes('token') ||
      normalized.includes('credential') ||
      normalized.includes('privatekey') ||
      normalized.includes('keymaterial')
    ) {
      throw badRequest(`${path}.${key} is not allowed in identity mapping metadata`);
    }
    assertNoSensitiveMetadata(item, `${path}.${key}`);
  }
}

function assertNoSourceProfileRawSamples(value: unknown, path: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSourceProfileRawSamples(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (
      normalized === 'samplevalues' ||
      normalized === 'rawvalues' ||
      normalized === 'rawrows' ||
      normalized === 'rawcsv' ||
      normalized === 'contentbase64'
    ) {
      throw badRequest(`${path}.${key} is not allowed in source profile schema`);
    }
    assertNoSourceProfileRawSamples(item, `${path}.${key}`);
  }
}

function assertProfileFieldConstraints(value: unknown, path: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertProfileFieldConstraints(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  validateFieldConstraintDefinition(value, path);
  for (const [key, item] of Object.entries(value)) {
    assertProfileFieldConstraints(item, `${path}.${key}`);
  }
}

function validateFieldConstraintDefinition(
  definition: Record<string, unknown>,
  path: string,
  errors?: string[]
): void {
  const report = (message: string) => {
    if (errors) {
      errors.push(message);
      return;
    }
    throw badRequest(message);
  };

  if (definition.allowedValues !== undefined) {
    if (
      !Array.isArray(definition.allowedValues) ||
      definition.allowedValues.some((value) => typeof value !== 'string')
    ) {
      report(`${path}.allowedValues must be an array of strings`);
    }
  }
  if (
    definition.valueMultiplicity !== undefined &&
    definition.valueMultiplicity !== 'single' &&
    definition.valueMultiplicity !== 'multi'
  ) {
    report(`${path}.valueMultiplicity must be single or multi`);
  }
  if (definition.nullable !== undefined && typeof definition.nullable !== 'boolean') {
    report(`${path}.nullable must be boolean`);
  }
  if (definition.required !== undefined && typeof definition.required !== 'boolean') {
    report(`${path}.required must be boolean`);
  }
  if (definition.mappingRequired !== undefined && typeof definition.mappingRequired !== 'boolean') {
    report(`${path}.mappingRequired must be boolean`);
  }
}

interface MappingRequiredSourceField {
  displayName: string;
  aliases: string[];
}

function mappingRequiredSourceFields(
  schema: Record<string, unknown>
): MappingRequiredSourceField[] {
  const fields = [schema.attributes, schema.fields, schema.columns].flatMap((definitions) =>
    Array.isArray(definitions)
      ? definitions.filter(isRecord).flatMap(mappingRequiredSourceFieldFromDefinition)
      : []
  );
  for (const value of [schema.claims, schema.properties]) {
    if (!isRecord(value)) continue;
    fields.push(
      ...Object.entries(value).flatMap(([key, definition]) => {
        if (!isRecord(definition) || definition.mappingRequired !== true) return [];
        return [{ displayName: key, aliases: [key] }];
      })
    );
  }
  return fields;
}

function mappingRequiredSourceFieldFromDefinition(
  definition: Record<string, unknown>
): MappingRequiredSourceField[] {
  if (definition.mappingRequired !== true) return [];
  const aliases = [
    definition.name,
    definition.key,
    definition.claimName,
    definition.columnName,
    definition.headerName,
    definition.id,
    definition.stableColumnId,
  ]
    .map(readStringValue)
    .filter((value): value is string => value !== null);
  const uniqueAliases = [...new Set(aliases)];
  if (uniqueAliases.length === 0) return [];
  return [{ displayName: uniqueAliases[0], aliases: uniqueAliases }];
}

function isSourceProfileMappingReference(profileId: string): boolean {
  return profileId.startsWith('source-profile-') || profileId.startsWith('source_profile_');
}

function sourceProfileReferenceCandidates(profileId: string): string[] {
  const candidates = new Set([profileId, normalizeSourceProfileReference(profileId)]);
  return [...candidates];
}

function normalizeSourceProfileReference(profileId: string): string {
  return profileId.startsWith('source-profile-')
    ? profileId.slice('source-profile-'.length)
    : profileId;
}

function isDestinationProfileMappingReference(profileId: string | null): boolean {
  return Boolean(
    profileId &&
    (profileId.startsWith('destination-profile-') || profileId.startsWith('destination_profile_'))
  );
}

function isBuiltInSystemIdentityMappingReference(ref: Record<string, unknown>): boolean {
  const catalogEntryId = readStringValue(ref.catalogEntryId);
  return Boolean(catalogEntryId?.startsWith('system.identity.'));
}

function destinationProfileReferenceCandidates(profileId: string): string[] {
  const candidates = new Set([profileId, normalizeDestinationProfileReference(profileId)]);
  return [...candidates];
}

function normalizeDestinationProfileReference(profileId: string): string {
  return profileId.startsWith('destination-profile-')
    ? profileId.slice('destination-profile-'.length)
    : profileId;
}

function findCatalogEntryForMappingRef(
  entries: FieldCatalogEntrySummary[],
  ref: Record<string, unknown>
): FieldCatalogEntrySummary | null {
  const catalogEntryId = readStringValue(ref.catalogEntryId);
  if (catalogEntryId) {
    const exact = entries.find(
      (entry) => entry.id === catalogEntryId || entry.stableFieldId === catalogEntryId
    );
    if (exact) return exact;
  }
  const namespace = readStringValue(ref.namespace);
  const path = readStringValue(ref.path);
  if (!namespace || !path) return null;
  return (
    entries.find(
      (entry) =>
        (entry.namespace === namespace && entry.path === path) ||
        entry.aliases.some((alias) => alias.namespace === namespace && alias.path === path)
    ) ?? null
  );
}

function findDestinationProfileField(
  destinationType: string,
  schema: Record<string, unknown>,
  path: string
): Record<string, unknown> | null {
  const definitions =
    destinationType === 'saml'
      ? schema.attributes
      : destinationType === 'csv'
        ? schema.columns
        : schema.claims;
  if (!Array.isArray(definitions)) return null;
  const key =
    destinationType === 'saml' ? 'name' : destinationType === 'csv' ? 'columnName' : 'claimName';
  return (
    definitions.filter(isRecord).find((definition) => readStringValue(definition[key]) === path) ??
    null
  );
}

function sensitiveClassificationRank(classification: string): number {
  if (classification === 'regulated') return 2;
  if (classification === 'pii') return 1;
  return 0;
}

function readStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function assertProfileSchemaBudget(value: unknown, path: string): void {
  const seen = new WeakSet<object>();
  let nodeCount = 0;

  const visit = (item: unknown, currentPath: string, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > PROFILE_SCHEMA_MAX_NODES) {
      throw badRequest(`${path} must contain at most ${PROFILE_SCHEMA_MAX_NODES} JSON nodes`);
    }
    if (depth > PROFILE_SCHEMA_MAX_DEPTH) {
      throw badRequest(`${currentPath} exceeds maximum depth ${PROFILE_SCHEMA_MAX_DEPTH}`);
    }
    if (typeof item === 'string' && item.length > PROFILE_SCHEMA_MAX_STRING_CHARS) {
      throw badRequest(
        `${currentPath} string value must be at most ${PROFILE_SCHEMA_MAX_STRING_CHARS} characters`
      );
    }
    if (item === undefined || item === null || typeof item !== 'object') {
      return;
    }
    if (seen.has(item)) {
      throw badRequest(`${currentPath} must not contain circular references`);
    }
    seen.add(item);

    if (Array.isArray(item)) {
      if (item.length > PROFILE_SCHEMA_MAX_ARRAY_ITEMS) {
        throw badRequest(
          `${currentPath} array must contain at most ${PROFILE_SCHEMA_MAX_ARRAY_ITEMS} items`
        );
      }
      item.forEach((child, index) => visit(child, `${currentPath}[${index}]`, depth + 1));
      return;
    }

    const entries = Object.entries(item);
    if (entries.length > PROFILE_SCHEMA_MAX_OBJECT_KEYS) {
      throw badRequest(
        `${currentPath} object must contain at most ${PROFILE_SCHEMA_MAX_OBJECT_KEYS} keys`
      );
    }
    entries.forEach(([key, child]) => visit(child, `${currentPath}.${key}`, depth + 1));
  };

  visit(value, path, 0);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > PROFILE_SCHEMA_MAX_JSON_BYTES) {
    throw badRequest(`${path} JSON must be at most ${PROFILE_SCHEMA_MAX_JSON_BYTES} bytes`);
  }
}

function assertFieldMappingVersionRequestSafe(input: CreateFieldMappingVersionRequest): void {
  assertProfileSchemaBudget(input, 'fieldMappingVersion');
  assertNoSensitiveMetadata(input, 'fieldMappingVersion');
  if (input.rules.length > POLICY_VERSION_MAX_RULES) {
    throw badRequest(`rules must contain at most ${POLICY_VERSION_MAX_RULES} items`);
  }
  const ruleKeys = new Set<string>();
  input.rules.forEach((rule, index) => {
    assertFieldMappingRuleSafe(rule, `rules[${index}]`);
    if (ruleKeys.has(rule.ruleKey)) {
      throw badRequest(`rules[${index}].ruleKey must be unique`);
    }
    ruleKeys.add(rule.ruleKey);
  });
}

function assertFieldMappingRuleSafe(rule: FieldMappingVersionRuleInput, path: string): void {
  validatePolicySymbol(rule.ruleKey, `${path}.ruleKey`);
  validatePolicySymbol(rule.ruleKind, `${path}.ruleKind`);
  validatePolicySymbol(rule.action, `${path}.action`);

  assertArrayLimit(rule.edges, POLICY_RULE_MAX_EDGES, `${path}.edges`);
  assertArrayLimit(rule.transforms, POLICY_RULE_MAX_TRANSFORMS, `${path}.transforms`);
  assertArrayLimit(
    rule.validationRules,
    POLICY_RULE_MAX_VALIDATION_RULES,
    `${path}.validationRules`
  );
  assertArrayLimit(rule.releaseRules, POLICY_RULE_MAX_RELEASE_RULES, `${path}.releaseRules`);
  assertArrayLimit(rule.conflictRules, POLICY_RULE_MAX_CONFLICT_RULES, `${path}.conflictRules`);

  rule.edges?.forEach((edge, index) => {
    assertNonEmptyRecord(edge.sourceRef, `${path}.edges[${index}].sourceRef`);
    assertNonEmptyRecord(edge.targetRef, `${path}.edges[${index}].targetRef`);
    const targetNamespace = readStringValue(edge.targetRef.namespace);
    const targetPath = readStringValue(edge.targetRef.path);
    if (
      targetNamespace &&
      targetPath &&
      isProtectedIdentityMappingDestinationClaim(targetNamespace, targetPath)
    ) {
      throw badRequest(
        `${path}.edges[${index}].targetRef targets a claim reserved by the protocol envelope`
      );
    }
    if (edge.edgeKind !== undefined) {
      validatePolicySymbol(edge.edgeKind, `${path}.edges[${index}].edgeKind`);
    }
  });

  rule.transforms?.forEach((transform, index) => {
    validatePolicySymbol(transform.operation, `${path}.transforms[${index}].operation`);
    if (!SUPPORTED_POLICY_TRANSFORM_OPERATIONS.has(transform.operation)) {
      throw badRequest(`${path}.transforms[${index}].operation is not supported`);
    }
    if (
      transform.edgeIndex !== undefined &&
      (!Number.isInteger(transform.edgeIndex) || transform.edgeIndex < 0)
    ) {
      throw badRequest(`${path}.transforms[${index}].edgeIndex must be a non-negative integer`);
    }
  });

  rule.validationRules?.forEach((validationRule, index) => {
    assertNonEmptyRecord(validationRule.targetRef, `${path}.validationRules[${index}].targetRef`);
    validatePolicySymbol(
      validationRule.validationKind,
      `${path}.validationRules[${index}].validationKind`
    );
    if (validationRule.severity !== undefined) {
      validatePolicySymbol(validationRule.severity, `${path}.validationRules[${index}].severity`);
    }
  });

  rule.releaseRules?.forEach((releaseRule, index) => {
    validatePolicySymbol(
      releaseRule.destinationType,
      `${path}.releaseRules[${index}].destinationType`
    );
    assertNonEmptyRecord(releaseRule.sourceRef, `${path}.releaseRules[${index}].sourceRef`);
    validatePolicySymbol(releaseRule.releaseAction, `${path}.releaseRules[${index}].releaseAction`);
    if (releaseRule.legalBasis !== undefined) {
      validatePolicySymbol(releaseRule.legalBasis, `${path}.releaseRules[${index}].legalBasis`);
    }
    if (releaseRule.purpose !== undefined) {
      validatePolicySymbol(releaseRule.purpose, `${path}.releaseRules[${index}].purpose`);
    }
  });

  rule.conflictRules?.forEach((conflictRule, index) => {
    assertNonEmptyRecord(conflictRule.targetRef, `${path}.conflictRules[${index}].targetRef`);
    validatePolicySymbol(
      conflictRule.conflictStrategy,
      `${path}.conflictRules[${index}].conflictStrategy`
    );
  });
}

function assertArrayLimit(value: unknown[] | undefined, limit: number, path: string): void {
  if (value !== undefined && value.length > limit) {
    throw badRequest(`${path} must contain at most ${limit} items`);
  }
}

function assertNonEmptyRecord(value: unknown, path: string): void {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw badRequest(`${path} must be a non-empty object`);
  }
}

function validatePolicySymbol(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`${path} is required`);
  }
  if (value.length > POLICY_SYMBOL_MAX_CHARS || !POLICY_SYMBOL_PATTERN.test(value)) {
    throw badRequest(`${path} must be a stable symbolic identifier`);
  }
}

function assertNoDestinationProfileRawValues(value: unknown, path: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDestinationProfileRawValues(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (
      normalized === 'samplevalues' ||
      normalized === 'rawvalues' ||
      normalized === 'rawclaims' ||
      normalized === 'rawrows' ||
      normalized === 'rawcsv'
    ) {
      throw badRequest(`${path}.${key} is not allowed in destination profile schema`);
    }
    assertNoDestinationProfileRawValues(item, `${path}.${key}`);
  }
}

function assertNoReviewPayloadRawIdentifiers(value: unknown, path: string): void {
  assertNoSensitiveMetadata(value, path);
  if (value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoReviewPayloadRawIdentifiers(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (
      normalized === 'email' ||
      normalized === 'mail' ||
      normalized === 'nameid' ||
      normalized === 'phone' ||
      normalized === 'phonenumber' ||
      normalized === 'sub' ||
      normalized === 'uid' ||
      normalized === 'userid'
    ) {
      throw badRequest(`${path}.${key} is not allowed in identity mapping review payloads`);
    }
    assertNoReviewPayloadRawIdentifiers(item, `${path}.${key}`);
  }
}

function resolveSchemaReadinessGateState(
  item: SchemaReadinessInventoryDefinition,
  schemaPresent: boolean | null
): SchemaReadinessGateState {
  if (item.status === 'reserved_planned' || item.status === 'adapter_deferred') {
    return 'deferred';
  }
  if (schemaPresent === false) {
    return 'blocked';
  }
  if (
    item.status === 'schema_added' ||
    item.status === 'existing_to_migrate' ||
    item.status === 'breaking_planned'
  ) {
    return item.requiredForTier2Gate ? 'blocked' : 'attention';
  }
  return 'pass';
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampListLimit(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(1, Math.min(Math.trunc(value), maxValue));
}

function parseJsonObject(
  value: string,
  fallback: Record<string, unknown>
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseReviewTaskPayload(value: string): Record<string, unknown> {
  const payload = parseJsonObject(value, {});
  assertNoReviewPayloadRawIdentifiers(payload, 'payload');
  return payload;
}

function parseProvisioningAssignmentCondition(value: string): ProvisioningAssignmentCondition {
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw badRequest('provisioning assignment rule condition must be an object');
    }
    return parsed as unknown as ProvisioningAssignmentCondition;
  } catch (error) {
    if (error instanceof IdentityMappingControlPlaneError) {
      throw error;
    }
    throw badRequest('provisioning assignment rule condition is invalid JSON');
  }
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
}

function parseJsonUnknownArray(value: string | null): unknown[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (isRecord(parsed) && Array.isArray(parsed.values)) {
      return parsed.values;
    }
    return [];
  } catch {
    return [];
  }
}

function parseCatalogAliases(value: string | null): Array<{ namespace: string; path: string }> {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (!isRecord(item) || typeof item.namespace !== 'string' || typeof item.path !== 'string') {
        return [];
      }
      return [{ namespace: item.namespace, path: item.path }];
    });
  } catch {
    return [];
  }
}

function profileIdsFromFieldMappingRefs(...values: Array<string | null>): string[] {
  const ids: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const parsed = parseJsonObject(value, {});
    const profileId = parsed.profileId;
    if (typeof profileId === 'string' && profileId.length > 0 && !ids.includes(profileId)) {
      ids.push(profileId);
    }
  }
  return ids;
}

function assertSafeMaterialRef(materialRef: string): void {
  const normalized = materialRef.trim().toLowerCase();
  if (!normalized.includes('://') && !normalized.startsWith('wrangler-secret:')) {
    throw badRequest('materialRef must be an external reference, not inline key material');
  }
  if (
    /-----begin [^-]+key-----/i.test(materialRef) ||
    /-----begin certificate-----/i.test(materialRef) ||
    normalized.includes('private_key=') ||
    normalized.includes('client_secret=') ||
    normalized.includes('password=') ||
    normalized.includes('token=')
  ) {
    throw badRequest('materialRef must not contain inline key material or secrets');
  }
}

function assertSafeMaterialBackend(backendType: string): void {
  const normalized = backendType.trim().toLowerCase().replace(/[_-]/g, '');
  if (normalized === 'inline' || normalized === 'localfile' || normalized === 'plaintext') {
    throw badRequest('backendType must reference an external key material backend');
  }
}

async function hashStableJson(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      const item = value[key];
      if (item !== undefined) {
        sorted[key] = sortForStableJson(item);
      }
      return sorted;
    }, {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badRequest(message: string): IdentityMappingControlPlaneError {
  return new IdentityMappingControlPlaneError(message, 400, 'invalid_request');
}

function notFound(message: string): IdentityMappingControlPlaneError {
  return new IdentityMappingControlPlaneError(message, 404, 'not_found');
}

function forbidden(message: string): IdentityMappingControlPlaneError {
  return new IdentityMappingControlPlaneError(message, 403, 'forbidden');
}

function conflict(message: string): IdentityMappingControlPlaneError {
  return new IdentityMappingControlPlaneError(message, 409, 'conflict');
}
