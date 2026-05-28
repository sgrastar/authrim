import type { Context } from 'hono';
import type { Env, DatabaseAdapter } from '@authrim/ar-lib-core';
import { getTenantIdFromContext, requireDedicatedAdminDatabaseAdapter } from '@authrim/ar-lib-core';
import { validateCatalogBundle } from '@authrim/ar-lib-identity-mapping';
import type { FieldCatalogEntry } from '@authrim/ar-lib-identity-mapping';

type AdminContext = Context<{ Bindings: Env }>;

type LifecycleState = 'draft' | 'published' | 'active' | 'scheduled' | 'retired';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVATION_LEASE_TTL_MS = 60 * 1000;

interface MappingPolicySetRow {
  id: string;
  tenant_id: string;
  policy_key: string;
  display_name: string;
  description: string | null;
  owner_scope_type: string;
  owner_scope_id: string | null;
  lifecycle_state: LifecycleState;
  created_at: number;
  updated_at: number;
}

interface MappingPolicyVersionRow {
  id: string;
  tenant_id: string;
  policy_set_id: string;
  version_label: string;
  lifecycle_state: LifecycleState;
  policy_hash: string;
  compatibility_range: string | null;
  author_id: string | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
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
  version_label: string | null;
  bundle_hash: string | null;
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

interface CompiledMappingSnapshotRow {
  id: string;
  tenant_id: string;
  policy_version_id: string;
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

interface CreatePolicySetRequest {
  policyKey: string;
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

interface PolicyVersionRuleInput {
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

interface CreatePolicyVersionRequest {
  versionLabel: string;
  compatibilityRange?: string;
  authorId?: string;
  rules: PolicyVersionRuleInput[];
}

interface CompilePolicyRequest {
  catalogVersionId: string;
  compatibilityRange?: string;
  artifactRef?: string;
  metadata?: Record<string, unknown>;
}

interface ActivatePolicyRequest {
  snapshotId: string;
  activationScope: Record<string, unknown>;
  holderId?: string;
}

interface RepositoryResult<T> {
  result: T;
}

interface SqlExecutor {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
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
    private readonly now: () => number = () => Date.now()
  ) {}

  async createCatalog(tenantId: string, input: CreateCatalogRequest) {
    validateRequiredString(input.catalogKey, 'catalogKey');
    validateRequiredString(input.displayName, 'displayName');
    validateRequiredString(input.versionLabel, 'versionLabel');
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw badRequest('entries must contain at least one catalog entry');
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
            value_type, cardinality, classification, aliases_json, validation_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            stableJson({}),
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
      `SELECT c.*, v.version_label, v.bundle_hash
         FROM field_catalogs c
         LEFT JOIN field_catalog_versions v ON v.catalog_id = c.id
        WHERE c.tenant_id = ?
        ORDER BY c.updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      catalogKey: row.catalog_key,
      displayName: row.display_name,
      lifecycleState: row.lifecycle_state,
      versionLabel: row.version_label,
      bundleHash: row.bundle_hash,
    }));
  }

  async createProtocolSchema(tenantId: string, input: CreateProtocolSchemaRequest) {
    validateRequiredString(input.protocol, 'protocol');
    validateRequiredString(input.schemaKey, 'schemaKey');
    if (!isRecord(input.schema)) {
      throw badRequest('schema must be an object');
    }
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
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      schemaKey: row.schema_key,
      schema: JSON.parse(row.schema_json) as Record<string, unknown>,
      lifecycleState: row.lifecycle_state,
      importedAt: row.imported_at,
    }));
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

  async createPolicySet(tenantId: string, input: CreatePolicySetRequest) {
    validateRequiredString(input.policyKey, 'policyKey');
    validateRequiredString(input.displayName, 'displayName');
    const now = this.now();
    const id = createId('mapping_policy');
    await this.adapter.execute(
      `INSERT INTO mapping_policy_sets (
        id, tenant_id, policy_key, display_name, description, owner_scope_type, owner_scope_id,
        lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        input.policyKey,
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
      policyKey: input.policyKey,
      displayName: input.displayName,
      description: input.description ?? null,
      lifecycleState: 'draft',
    };
  }

  async listPolicySets(tenantId: string) {
    const rows = await this.adapter.query<MappingPolicySetRow>(
      `SELECT * FROM mapping_policy_sets WHERE tenant_id = ? ORDER BY updated_at DESC`,
      [tenantId]
    );
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      policyKey: row.policy_key,
      displayName: row.display_name,
      description: row.description,
      lifecycleState: row.lifecycle_state,
    }));
  }

  async createPolicyVersion(
    tenantId: string,
    policySetId: string,
    input: CreatePolicyVersionRequest
  ) {
    validateRequiredString(policySetId, 'policySetId');
    validateRequiredString(input.versionLabel, 'versionLabel');
    if (!Array.isArray(input.rules)) {
      throw badRequest('rules must be an array');
    }
    for (const rule of input.rules) {
      assertNoSensitiveMetadata(rule.metadata, 'rule.metadata');
    }

    const policySet = await this.getPolicySet(tenantId, policySetId);
    if (!policySet) {
      throw notFound('policy set not found');
    }

    const now = this.now();
    const versionId = createId('mapping_policy_version');
    const policyHash = await hashStableJson({
      policySetId,
      versionLabel: input.versionLabel,
      rules: input.rules,
    });
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO mapping_policy_versions (
          id, tenant_id, policy_set_id, version_label, lifecycle_state, policy_hash,
          compatibility_range, author_id, published_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          versionId,
          tenantId,
          policySetId,
          input.versionLabel,
          'draft',
          policyHash,
          input.compatibilityRange ?? null,
          input.authorId ?? null,
          null,
          now,
          now,
        ]
      );

      for (const rule of input.rules) {
        await this.insertPolicyRule(tx, tenantId, versionId, rule, now);
      }
    });

    return {
      id: versionId,
      tenantId,
      policySetId,
      versionLabel: input.versionLabel,
      lifecycleState: 'draft',
      policyHash,
      compatibilityRange: input.compatibilityRange ?? null,
    };
  }

  async publishPolicyVersion(tenantId: string, policySetId: string, policyVersionId: string) {
    const version = await this.getPolicyVersion(tenantId, policySetId, policyVersionId);
    if (!version) {
      throw notFound('policy version not found');
    }
    const now = this.now();
    await this.adapter.execute(
      `UPDATE mapping_policy_versions
          SET lifecycle_state = ?, published_at = ?, updated_at = ?
        WHERE tenant_id = ? AND policy_set_id = ? AND id = ?`,
      ['published', now, now, tenantId, policySetId, policyVersionId]
    );
    return {
      id: policyVersionId,
      tenantId,
      policySetId,
      lifecycleState: 'published',
      publishedAt: now,
    };
  }

  async compilePolicyVersion(
    tenantId: string,
    policySetId: string,
    policyVersionId: string,
    input: CompilePolicyRequest
  ) {
    validateRequiredString(input.catalogVersionId, 'catalogVersionId');
    const version = await this.getPolicyVersion(tenantId, policySetId, policyVersionId);
    if (!version) {
      throw notFound('policy version not found');
    }
    const catalogVersion = await this.getCatalogVersion(tenantId, input.catalogVersionId);
    if (!catalogVersion) {
      throw notFound('catalog version not found');
    }
    assertNoSensitiveMetadata(input.metadata, 'metadata');

    const now = this.now();
    const dependencyGraph = {
      policyVersionId,
      policyHash: version.policy_hash,
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
        id, tenant_id, policy_version_id, snapshot_hash, graph_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [graphId, tenantId, policyVersionId, graphHash, stableJson(dependencyGraph), now]
    );
    await this.adapter.execute(
      `INSERT INTO compiled_mapping_snapshots (
        id, tenant_id, policy_version_id, catalog_version_id, snapshot_hash, compatibility_range,
        artifact_ref, lifecycle_state, compiled_at, activated_at, expires_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        tenantId,
        policyVersionId,
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
      policyVersionId,
      catalogVersionId: catalogVersion.id,
      snapshotHash,
      dependencyGraphId: graphId,
      lifecycleState: 'draft',
    };
  }

  async activatePolicyVersion(
    tenantId: string,
    policySetId: string,
    policyVersionId: string,
    input: ActivatePolicyRequest
  ) {
    validateRequiredString(input.snapshotId, 'snapshotId');
    const version = await this.getPolicyVersion(tenantId, policySetId, policyVersionId);
    if (!version) {
      throw notFound('policy version not found');
    }
    const snapshot = await this.getSnapshot(tenantId, policyVersionId, input.snapshotId);
    if (!snapshot) {
      throw notFound('compiled snapshot not found');
    }
    if (snapshot.lifecycle_state === 'active') {
      return {
        id: input.snapshotId,
        tenantId,
        policySetId,
        policyVersionId,
        lifecycleState: 'active',
        alreadyActive: true,
      };
    }

    const now = this.now();
    const holderId = input.holderId ?? createId('activation_holder');
    const leaseKey = `policy:${policySetId}:activate`;
    await this.acquireActivationLease(tenantId, leaseKey, holderId, now);

    const activationId = createId('mapping_activation');
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE mapping_policy_activations
            SET lifecycle_state = ?, active_until = ?, updated_at = ?
          WHERE tenant_id = ? AND policy_set_id = ? AND lifecycle_state = ?`,
        ['retired', now, now, tenantId, policySetId, 'active']
      );
      await tx.execute(
        `UPDATE compiled_mapping_snapshots
            SET lifecycle_state = ?, activated_at = ?
          WHERE tenant_id = ? AND policy_version_id = ? AND lifecycle_state = ?`,
        ['retired', now, tenantId, policyVersionId, 'active']
      );
      await tx.execute(
        `INSERT INTO mapping_policy_activations (
          id, tenant_id, policy_set_id, policy_version_id, activation_scope_json,
          lifecycle_state, active_from, active_until, activated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          activationId,
          tenantId,
          policySetId,
          policyVersionId,
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
        `UPDATE mapping_policy_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND policy_set_id = ? AND id = ?`,
        ['active', now, tenantId, policySetId, policyVersionId]
      );
      await tx.execute(
        `UPDATE mapping_policy_sets
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        ['active', now, tenantId, policySetId]
      );
      await tx.execute(
        `UPDATE compiled_mapping_snapshots
            SET lifecycle_state = ?, activated_at = ?
          WHERE tenant_id = ? AND policy_version_id = ? AND id = ?`,
        ['active', now, tenantId, policyVersionId, input.snapshotId]
      );
    });

    return {
      id: activationId,
      tenantId,
      policySetId,
      policyVersionId,
      snapshotId: input.snapshotId,
      lifecycleState: 'active',
      activatedAt: now,
      holderId,
    };
  }

  async rollbackPolicySet(tenantId: string, policySetId: string) {
    const previous = await this.adapter.queryOne<{
      id: string;
      policy_version_id: string;
      active_from: number | null;
    }>(
      `SELECT id, policy_version_id, active_from
         FROM mapping_policy_activations
        WHERE tenant_id = ? AND policy_set_id = ? AND lifecycle_state = ?
        ORDER BY active_from DESC, activated_at DESC
        LIMIT 1`,
      [tenantId, policySetId, 'retired']
    );
    if (!previous) {
      throw conflict('no retired activation is available for rollback');
    }
    const now = this.now();
    await this.adapter.transaction(async (tx) => {
      await tx.execute(
        `UPDATE mapping_policy_activations
            SET lifecycle_state = ?, active_until = ?, updated_at = ?
          WHERE tenant_id = ? AND policy_set_id = ? AND lifecycle_state = ?`,
        ['retired', now, now, tenantId, policySetId, 'active']
      );
      await tx.execute(
        `UPDATE mapping_policy_activations
            SET lifecycle_state = ?, active_until = ?, activated_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`,
        ['active', null, now, now, tenantId, previous.id]
      );
      await tx.execute(
        `UPDATE mapping_policy_versions
            SET lifecycle_state = ?, updated_at = ?
          WHERE tenant_id = ? AND policy_set_id = ? AND id = ?`,
        ['active', now, tenantId, policySetId, previous.policy_version_id]
      );
    });
    return {
      id: previous.id,
      tenantId,
      policySetId,
      policyVersionId: previous.policy_version_id,
      lifecycleState: 'active',
      rolledBackAt: now,
    };
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

  private async getPolicySet(tenantId: string, policySetId: string) {
    return this.adapter.queryOne<MappingPolicySetRow>(
      `SELECT * FROM mapping_policy_sets WHERE tenant_id = ? AND id = ?`,
      [tenantId, policySetId]
    );
  }

  private async getPolicyVersion(tenantId: string, policySetId: string, policyVersionId: string) {
    return this.adapter.queryOne<MappingPolicyVersionRow>(
      `SELECT * FROM mapping_policy_versions
        WHERE tenant_id = ? AND policy_set_id = ? AND id = ?`,
      [tenantId, policySetId, policyVersionId]
    );
  }

  private async getCatalogVersion(tenantId: string, catalogVersionId: string) {
    return this.adapter.queryOne<FieldCatalogVersionRow>(
      `SELECT * FROM field_catalog_versions WHERE tenant_id = ? AND id = ?`,
      [tenantId, catalogVersionId]
    );
  }

  private async getSnapshot(tenantId: string, policyVersionId: string, snapshotId: string) {
    return this.adapter.queryOne<CompiledMappingSnapshotRow>(
      `SELECT id, tenant_id, policy_version_id, catalog_version_id, snapshot_hash, lifecycle_state
         FROM compiled_mapping_snapshots
        WHERE tenant_id = ? AND policy_version_id = ? AND id = ?`,
      [tenantId, policyVersionId, snapshotId]
    );
  }

  private async insertPolicyRule(
    executor: SqlExecutor,
    tenantId: string,
    policyVersionId: string,
    rule: PolicyVersionRuleInput,
    now: number
  ) {
    validateRequiredString(rule.ruleKey, 'ruleKey');
    validateRequiredString(rule.ruleKind, 'ruleKind');
    validateRequiredString(rule.action, 'action');
    const ruleId = createId('mapping_rule');
    await executor.execute(
      `INSERT INTO mapping_rules (
        id, tenant_id, policy_version_id, rule_key, rule_kind, action, priority, scope_json,
        condition_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ruleId,
        tenantId,
        policyVersionId,
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
          id, tenant_id, policy_version_id, destination_type, destination_id, source_ref_json,
          release_action, legal_basis, purpose, condition_json, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('mapping_release'),
          tenantId,
          policyVersionId,
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
          id, tenant_id, policy_version_id, target_ref_json, conflict_strategy,
          source_priority_json, condition_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          createId('mapping_conflict'),
          tenantId,
          policyVersionId,
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
      throw conflict('mapping policy activation is already locked by another holder');
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

export async function adminIdentityMappingPoliciesListHandler(c: AdminContext) {
  return handleControlPlane(c, async (repository, tenantId) => ({
    policies: await repository.listPolicySets(tenantId),
  }));
}

export async function adminIdentityMappingPolicyCreateHandler(c: AdminContext) {
  return handleMutation(c, 'policy.create', async (repository, tenantId, body) =>
    repository.createPolicySet(tenantId, body as CreatePolicySetRequest)
  );
}

export async function adminIdentityMappingPolicyVersionCreateHandler(c: AdminContext) {
  return handleMutation(c, 'policy.version.create', async (repository, tenantId, body) =>
    repository.createPolicyVersion(
      tenantId,
      requiredParam(c, 'policySetId'),
      body as CreatePolicyVersionRequest
    )
  );
}

export async function adminIdentityMappingPolicyVersionPublishHandler(c: AdminContext) {
  return handleMutation(c, 'policy.version.publish', async (repository, tenantId) =>
    repository.publishPolicyVersion(
      tenantId,
      requiredParam(c, 'policySetId'),
      requiredParam(c, 'policyVersionId')
    )
  );
}

export async function adminIdentityMappingPolicyVersionCompileHandler(c: AdminContext) {
  return handleMutation(c, 'policy.version.compile', async (repository, tenantId, body) =>
    repository.compilePolicyVersion(
      tenantId,
      requiredParam(c, 'policySetId'),
      requiredParam(c, 'policyVersionId'),
      body as CompilePolicyRequest
    )
  );
}

export async function adminIdentityMappingPolicyVersionActivateHandler(c: AdminContext) {
  return handleMutation(c, 'policy.version.activate', async (repository, tenantId, body) =>
    repository.activatePolicyVersion(
      tenantId,
      requiredParam(c, 'policySetId'),
      requiredParam(c, 'policyVersionId'),
      body as ActivatePolicyRequest
    )
  );
}

export async function adminIdentityMappingPolicyRollbackHandler(c: AdminContext) {
  return handleMutation(c, 'policy.rollback', async (repository, tenantId) =>
    repository.rollbackPolicySet(tenantId, requiredParam(c, 'policySetId'))
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
  return new IdentityMappingControlPlaneRepository(
    requireDedicatedAdminDatabaseAdapter(c.env, 'identity-mapping-control-plane')
  );
}

async function readJsonBody(c: AdminContext): Promise<unknown> {
  try {
    const body = await c.req.json();
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

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
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

function conflict(message: string): IdentityMappingControlPlaneError {
  return new IdentityMappingControlPlaneError(message, 409, 'conflict');
}
