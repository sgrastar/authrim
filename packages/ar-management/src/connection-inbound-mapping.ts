/** Connection-owned incoming mapping DTO. Does not call the outgoing Mapping Set facade. */
import {
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  readRequestTextWithLimit,
  createAuditLogFromContext,
  bumpAuthenticationMethodsCacheRevision,
  type DatabaseAdapter,
} from '@authrim/ar-lib-core';
import {
  assertInboundMappingGraph,
  defaultInboundSources,
  inboundProfileTargets,
  inboundSourceField,
  evaluateInboundMapping,
  oidcInboundSources,
  samlInboundAttributeValue,
  type InboundMappingProtocol,
} from '@authrim/ar-lib-core/services/inbound-identity-mapping';
import {
  resolveRuntimeIdentityMappingBinding,
  loadCustomClaimSchemaCatalogEntries,
} from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
import {
  TRANSFORM_OPERATION_SCHEMAS,
  withMappingGraph,
} from '@authrim/ar-lib-field-mapping/authoring';
import type {
  FieldCatalogBundle,
  FieldCatalogEntry,
  FieldRef,
  MappingRuleGraph,
  SourceValueEnvelope,
} from '@authrim/ar-lib-field-mapping/contract';
import {
  badRequest,
  conflict,
  notFound,
  isRecord,
  hashStableJson,
  createRepository,
  controlPlaneErrorResponse,
  type AdminContext,
  IdentityMappingControlPlaneError,
  type FieldMappingVersionRuleInput,
} from './identity-mapping-control-plane';
import {
  parseMappingSetContent,
  contentFromStoredVersion,
} from './identity-mapping-set-facade-content';
import { createReplayIdempotency } from './admin-replay-idempotency';
import { requireExternalProviderStepUp } from './external-providers';

declare module 'hono' {
  interface ContextVariableMap {
    connectionInboundMappingStarted?: boolean;
  }
}

const BODY_LIMIT = 128 * 1024;
const STARTED = 'connectionInboundMappingStarted';
export const inboundMappingIdempotency = createReplayIdempotency({
  partition: 'connection-inbound-mapping',
  logModule: 'INBOUND_MAPPING',
  subject: 'Incoming mapping save',
  operation: (principal) => `connection.inbound.save:${principal}`,
  tenantId: (c) => getTenantIdFromContext(c),
  requestScope: (c) => `${c.req.method} ${c.req.path}`,
  ttlMs: 15 * 60 * 1000,
  bodyLimitBytes: BODY_LIMIT,
  startedKey: STARTED,
  bindToAuthority: true,
  unknownMessage: 'Read the connection before retrying with a new key',
});

interface ProviderRow {
  id: string;
  settings: string | null;
  updated_at: number;
  enabled: number;
  legacy_mapping?: string;
}
function objectJson(text: string | null): Record<string, unknown> {
  const value: unknown = JSON.parse(text ?? '{}');
  if (!isRecord(value)) throw badRequest('Invalid stored provider configuration');
  return value;
}
async function connection(c: AdminContext) {
  const value = c.req.param('kind') ?? (c.req.routePath.includes('/inbound/op/') ? 'op' : 'idp');
  const kind: 'op' | 'idp' =
    value === 'op'
      ? 'op'
      : value === 'idp'
        ? 'idp'
        : (() => {
            throw notFound('Connection not found');
          })();
  const id = c.req.param('id');
  if (!id || id.length > 200) throw notFound('Connection not found');
  const tenantId = getTenantIdFromContext(c);
  const protocol: InboundMappingProtocol = kind === 'op' ? 'oidc' : 'saml';
  const core = await resolveAuthCorePersistenceAdapterFromEnv(c.env, 'connection-inbound-mapping', {
    tenantId,
  });
  // Select only the settings used here; credentials and customer records never enter this API.
  const row =
    kind === 'op'
      ? await core.queryOne<ProviderRow>(
          `SELECT id, provider_quirks AS settings, updated_at, enabled, attribute_mapping AS legacy_mapping
         FROM upstream_providers WHERE tenant_id = ? AND id = ? AND provider_type = 'oidc'`,
          [tenantId, id]
        )
      : await core.queryOne<ProviderRow>(
          `SELECT id, config_json AS settings, updated_at, enabled FROM identity_providers
         WHERE tenant_id = ? AND id = ? AND provider_type = 'saml_idp'`,
          [tenantId, id]
        );
  if (!row) throw notFound('Connection not found');
  const settings = objectJson(row.settings);
  const configured = kind === 'op' ? settings.inboundIdentityMapping : settings.identityMapping;
  if (configured !== undefined && !isRecord(configured))
    throw badRequest('Invalid incoming mapping binding');
  const mapping = isRecord(configured) ? configured : undefined;
  const revision = await hashStableJson({ settings: row.settings, updatedAt: row.updated_at });
  const targets = inboundProfileTargets(await loadCustomClaimSchemaCatalogEntries(core, tenantId));
  return { kind, id, tenantId, protocol, core, row, settings, mapping, revision, targets };
}
type Connection = Awaited<ReturnType<typeof connection>>;
function resolution(input: Connection) {
  const setId = input.mapping?.fieldMappingSetId;
  const versionId = input.mapping?.fieldMappingVersionId;
  if (
    typeof setId !== 'string' ||
    !setId ||
    (versionId !== undefined && typeof versionId !== 'string')
  )
    throw badRequest('Invalid incoming mapping binding');
  return {
    tenantId: input.tenantId,
    protocol: input.protocol,
    role: input.protocol === 'oidc' ? 'rp' : 'sp',
    fieldMappingSetId: setId,
    fieldMappingVersionId: versionId,
    ...(input.kind === 'op'
      ? { providerId: input.id }
      : {
          partnerEntityId:
            typeof input.settings.entityId === 'string' ? input.settings.entityId : '',
        }),
  };
}
async function document(c: AdminContext, input: Connection) {
  const empty = parseMappingSetContent({ catalogVersionId: 'inbound', rules: [] });
  let storedContent = empty;
  let sources = defaultInboundSources(input.protocol);
  let editable = true;
  if (input.mapping) {
    const context = resolution(input);
    const binding = await resolveRuntimeIdentityMappingBinding(
      requireDedicatedAdminDatabaseAdapter(c.env, 'connection-inbound-read'),
      {
        ...context,
        fieldMappingSetId: context.fieldMappingSetId,
        fieldMappingVersionId: context.fieldMappingVersionId,
      }
    );
    if (!binding)
      throw new IdentityMappingControlPlaneError(
        'Configured incoming mapping is inactive or invalid',
        409,
        'inbound_mapping_invalid',
        { revision: input.revision }
      );
    if (
      input.mapping.inboundContract === 'connection-v1' &&
      binding.activationScope.inboundContract !== 'connection-v1'
    )
      throw conflict('Configured incoming mapping contract is invalid');
    const [version] = await createRepository(c).listFieldMappingVersions(
      input.tenantId,
      binding.fieldMappingSetId,
      { versionId: binding.fieldMappingVersionId }
    );
    if (!version) throw conflict('Configured incoming mapping version is missing');
    storedContent = contentFromStoredVersion(version);
    sources = binding.catalog.entries.filter((entry) => !entry.namespace.startsWith('authrim.'));
    try {
      inboundGraphs(storedContent.rules);
      if (storedContent.sourceProfileIds?.length || storedContent.compatibilityRange !== undefined)
        editable = false;
      assertInboundMappingGraph(
        input.protocol,
        binding.graphRules ?? [],
        binding.catalog,
        input.targets
      );
      if (version.releaseRules.length || version.conflictRules.length) editable = false;
    } catch {
      editable = false;
    }
  }
  return {
    revision: input.revision,
    protocol: input.protocol,
    role: input.protocol === 'oidc' ? 'rp' : 'sp',
    configured: !!input.mapping,
    editable,
    sources,
    targets: input.targets,
    content: storedContent,
    legacyMappingPresent:
      input.kind === 'op' && Object.keys(objectJson(input.row.legacy_mapping ?? '{}')).length > 0,
    providerUpdatedAt: new Date(input.row.updated_at).toISOString(),
    enabled: input.row.enabled === 1,
  };
}

function reference(value: Record<string, unknown> | undefined): FieldRef {
  if (
    !value ||
    (value.side !== 'source' && value.side !== 'destination') ||
    typeof value.namespace !== 'string' ||
    typeof value.path !== 'string' ||
    Object.keys(value).some(
      (key) => !['side', 'namespace', 'path', 'valueType', 'catalogEntryId'].includes(key)
    ) ||
    (value.valueType !== undefined && typeof value.valueType !== 'string') ||
    (value.catalogEntryId !== undefined && typeof value.catalogEntryId !== 'string')
  )
    throw badRequest('Invalid incoming field reference');
  return {
    side: value.side,
    namespace: value.namespace,
    path: value.path,
    ...(typeof value.valueType === 'string' ? { valueType: value.valueType } : {}),
    ...(typeof value.catalogEntryId === 'string' ? { catalogEntryId: value.catalogEntryId } : {}),
  };
}
export function inboundGraphs(rules: FieldMappingVersionRuleInput[]): MappingRuleGraph[] {
  return rules.map((rule) => {
    if (
      Object.keys(rule).some(
        (key) =>
          ![
            'ruleKey',
            'ruleKind',
            'action',
            'targetRef',
            'output',
            'priority',
            'scope',
            'condition',
            'metadata',
            'edges',
            'transforms',
            'validationRules',
            'releaseRules',
            'conflictRules',
          ].includes(key)
      ) ||
      (rule.priority ?? 0) !== 0 ||
      Object.keys(rule.metadata ?? {}).some((key) => key !== 'console') ||
      rule.action !== 'allow' ||
      !['direct', 'transform'].includes(rule.ruleKind) ||
      !rule.output ||
      (rule.releaseRules?.length ?? 0) ||
      (rule.conflictRules?.length ?? 0) ||
      (rule.validationRules?.length ?? 0) ||
      Object.keys(rule.scope ?? {}).length ||
      Object.keys(rule.condition ?? {}).length
    )
      throw badRequest('Incoming mappings support attribute transformation graphs only');
    const targetRef = reference(rule.targetRef);
    return {
      id: rule.ruleKey,
      targetRef,
      output: rule.output,
      edges: (rule.edges ?? []).map((edge, index) => {
        if (
          Object.keys(edge).some((key) => !['sourceRef', 'targetRef', 'edgeKind'].includes(key)) ||
          (edge.edgeKind !== undefined && edge.edgeKind !== 'direct')
        )
          throw badRequest('Incoming mappings support direct attribute edges only');
        return {
          id: `${rule.ruleKey}:edge:${index}`,
          sourceRef: reference(edge.sourceRef),
          targetRef: reference(edge.targetRef),
        };
      }),
      transforms: (rule.transforms ?? []).map((step, index) => {
        if (
          Object.keys(step).some(
            (key) => !['operation', 'inputs', 'parameters', 'targetRef'].includes(key)
          )
        )
          throw badRequest('Unsupported incoming transform fields');
        const schema = TRANSFORM_OPERATION_SCHEMAS.find(
          (item) => item.operation === step.operation
        );
        if (!schema || schema.operation === 'persistent_identifier' || step.targetRef)
          throw badRequest('Unsupported incoming transform');
        return {
          id: `${rule.ruleKey}:step:${index}`,
          operation: schema.operation,
          parameters: step.parameters,
          inputs: step.inputs ?? [],
        };
      }),
    };
  });
}
async function draft(c: AdminContext, input: Connection, preview = false) {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestTextWithLimit(c.req.raw, BODY_LIMIT));
  } catch {
    throw badRequest('Invalid or oversized incoming mapping request');
  }
  if (
    !isRecord(body) ||
    Object.keys(body).some(
      (key) => !['revision', 'sources', 'rules', ...(preview ? ['sample'] : [])].includes(key)
    )
  )
    throw badRequest('Invalid incoming mapping request fields');
  if (body.revision !== input.revision) throw conflict('Connection changed; reload before saving');
  if (!Array.isArray(body.sources) || !body.sources.length || body.sources.length > 100)
    throw badRequest('Incoming source schema must contain 1–100 fields');
  const sources = body.sources.map((field): FieldCatalogEntry => {
    if (
      !isRecord(field) ||
      Object.keys(field).some((key) => !['namespace', 'path', 'cardinality'].includes(key)) ||
      typeof field.namespace !== 'string' ||
      typeof field.path !== 'string' ||
      !['single', 'multi'].includes(String(field.cardinality))
    )
      throw badRequest('Invalid incoming source schema');
    try {
      return inboundSourceField(
        input.protocol,
        field.namespace,
        field.path,
        field.cardinality === 'multi'
      );
    } catch {
      throw badRequest('Unsupported incoming source field');
    }
  });
  if (new Set(sources.map((field) => field.id)).size !== sources.length)
    throw badRequest('Duplicate incoming source field');
  const content = parseMappingSetContent({ catalogVersionId: 'inbound', rules: body.rules });
  const repository = createRepository(c);
  await repository.assertFieldMappingVersionShape(input.tenantId, {
    ...content,
    versionLabel: 'incoming',
  });
  const graphs = inboundGraphs(content.rules);
  const catalog: FieldCatalogBundle = {
    identity: { id: 'inbound', version: 'v1', contentHash: 'inbound', compatibilityRange: '*' },
    entries: [...sources, ...input.targets],
  };
  try {
    assertInboundMappingGraph(input.protocol, graphs, catalog, input.targets);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : 'Invalid incoming mapping');
  }
  return { body, sources, content, graphs, catalog, repository };
}

export async function getConnectionInboundMapping(c: AdminContext) {
  try {
    return c.json(await document(c, await connection(c)));
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}

/** Atomic compare-and-swap of this setting only; unrelated provider configuration is preserved. */
export async function bindConnectionInboundMapping(input: {
  core: DatabaseAdapter;
  tenantId: string;
  id: string;
  kind: 'op' | 'idp';
  settings: Record<string, unknown>;
  previousSettings: string | null;
  updatedAt: number;
  setId: string;
  versionId: string;
}) {
  const now = Math.max(Date.now(), input.updatedAt + 1);
  const property = input.kind === 'op' ? 'inboundIdentityMapping' : 'identityMapping';
  const existing = input.settings[property];
  const binding = {
    ...(isRecord(existing) ? existing : {}),
    fieldMappingSetId: input.setId,
    fieldMappingVersionId: input.versionId,
    ...(input.kind === 'idp' ? { inboundContract: 'connection-v1' } : {}),
  };
  const next = JSON.stringify({ ...input.settings, [property]: binding });
  const result =
    input.kind === 'op'
      ? await input.core.execute(
          `UPDATE upstream_providers SET provider_quirks = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND provider_type = 'oidc' AND updated_at = ? AND COALESCE(provider_quirks, '{}') = ?`,
          [next, now, input.tenantId, input.id, input.updatedAt, input.previousSettings ?? '{}']
        )
      : await input.core.execute(
          `UPDATE identity_providers SET config_json = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND provider_type = 'saml_idp' AND updated_at = ? AND config_json = ?`,
          [next, now, input.tenantId, input.id, input.updatedAt, input.previousSettings]
        );
  if (result.rowsAffected !== 1)
    throw conflict('Connection changed while incoming mapping was saved');
}

export async function putConnectionInboundMapping(c: AdminContext) {
  let createdSet: string | undefined;
  let bound = false;
  let bindingAttempted = false;
  try {
    const input = await connection(c);
    const value = await draft(c, input);
    const refused = await requireExternalProviderStepUp(
      c,
      'update',
      input.id,
      JSON.stringify(value.body)
    );
    if (refused) return refused;
    c.set(STARTED, true);
    // Copy-on-write: even a shared/pinned existing set is never mutated by this endpoint.
    const key = crypto.randomUUID();
    const catalog = await value.repository.createCatalog(input.tenantId, {
      catalogKey: `inbound.${key}`,
      displayName: 'Incoming connection fields',
      versionLabel: 'v1',
      entries: value.catalog.entries,
    });
    const set = await value.repository.createFieldMappingSet(input.tenantId, {
      fieldMappingKey: `inbound.${key}`,
      displayName: 'Incoming connection mapping',
      ownerScopeType: 'tenant',
    });
    createdSet = set.id;
    const version = await value.repository.createFieldMappingVersion(input.tenantId, set.id, {
      versionLabel: 'v1',
      rules: value.content.rules,
    });
    await value.repository.publishFieldMappingVersion(input.tenantId, set.id, version.id);
    const snapshot = await value.repository.compileFieldMappingVersion(
      input.tenantId,
      set.id,
      version.id,
      { catalogVersionId: catalog.activeVersion.id }
    );
    await value.repository.activateFieldMappingVersion(
      input.tenantId,
      set.id,
      version.id,
      {
        snapshotId: snapshot.id,
        activationScope: {
          protocol: input.protocol,
          role: input.protocol === 'oidc' ? 'rp' : 'sp',
          inboundContract: 'connection-v1',
          ...(input.kind === 'op'
            ? { providerId: input.id }
            : { partnerEntityId: input.settings.entityId }),
        },
      },
      { expectedActiveVersionId: null }
    );
    bindingAttempted = true;
    await bindConnectionInboundMapping({
      core: input.core,
      tenantId: input.tenantId,
      id: input.id,
      kind: input.kind,
      settings: input.settings,
      previousSettings: input.row.settings,
      updatedAt: input.row.updated_at,
      setId: set.id,
      versionId: version.id,
    });
    bound = true;
    await bumpAuthenticationMethodsCacheRevision(c.env, input.tenantId);
    await createAuditLogFromContext(c, 'identity_mapping.inbound.saved', 'connection', input.id, {
      kind: input.kind,
      set_id: set.id,
      version_id: version.id,
    });
    return c.json(await document(c, await connection(c)));
  } catch (error) {
    if (
      createdSet &&
      !bound &&
      (!bindingAttempted ||
        (error instanceof IdentityMappingControlPlaneError && error.status === 409))
    ) {
      // An uncertain database outcome retains the graph: the provider may already reference it.
      const repository = createRepository(c);
      const tenantId = getTenantIdFromContext(c);
      const state = await repository.findFieldMappingSetState(tenantId, createdSet);
      if (state)
        await repository.deleteFieldMappingSetEndingActivation(tenantId, createdSet, {
          expectedCurrentVersionId: state.current_version_id,
          expectedActiveVersionId: state.active_version_id,
        });
    }
    return controlPlaneErrorResponse(c, error);
  }
}

export async function previewConnectionInboundMapping(c: AdminContext) {
  try {
    const input = await connection(c);
    const value = await draft(c, input, true);
    const sample = value.body.sample;
    if (!isRecord(sample)) throw badRequest('A synthetic sample object is required');
    const sources: SourceValueEnvelope[] =
      input.protocol === 'oidc'
        ? oidcInboundSources(sample, value.sources)
        : value.sources.flatMap((field) => {
            const namespace = sample[field.namespace];
            if (!isRecord(namespace) || !Object.hasOwn(namespace, field.path)) return [];
            return [
              {
                sourceRef: { side: 'source', namespace: field.namespace, path: field.path },
                value:
                  field.namespace === 'saml.attribute'
                    ? samlInboundAttributeValue(namespace[field.path])
                    : namespace[field.path],
              },
            ];
          });
    const graph = withMappingGraph({ graphRules: value.graphs, edges: [], transforms: [] });
    const result = await evaluateInboundMapping({
      env: c.env,
      tenantId: input.tenantId,
      protocol: input.protocol,
      sources,
      targets: input.targets,
      binding: {
        ...graph,
        catalog: value.catalog,
        validationRules: [],
        fieldMappingSet: { id: 'synthetic', rules: [] },
      },
    });
    return c.json(result);
  } catch (error) {
    return controlPlaneErrorResponse(
      c,
      error instanceof IdentityMappingControlPlaneError
        ? error
        : badRequest('inbound_mapping_evaluation_failed')
    );
  }
}
