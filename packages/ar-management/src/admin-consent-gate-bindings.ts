import type { Context } from 'hono';
import {
  CONSENT_GATE_KINDS,
  ConsentGatePolicyBindingError,
  ConsentGatePolicyBindingRepository,
  ConsentGatePolicyConfigurationError,
  createAuthContextFromHono,
  getLogger,
  getTenantIdFromContext,
  resolveConsentGatePolicyBinding,
  type ConsentGateKind,
  type ConsentGateNodeConfig,
  type ConsentGateTargetType,
  type Env,
} from '@authrim/ar-lib-core';

const TARGET_TYPES = new Set<ConsentGateTargetType>(['tenant', 'oidc_client', 'saml_sp']);

type AdminContext = Context<{ Bindings: Env }>;

function invalid(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'invalid_request', error_description }, 400);
}

function notFound(c: AdminContext, error_description: string): Response {
  return c.json({ error: 'not_found', error_description }, 404);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value.trim() || null : undefined;
}

function readGateKind(value: unknown): ConsentGateKind | null {
  return typeof value === 'string' && CONSENT_GATE_KINDS.includes(value as ConsentGateKind)
    ? (value as ConsentGateKind)
    : null;
}

function readTargetType(value: unknown): ConsentGateTargetType | null {
  return typeof value === 'string' && TARGET_TYPES.has(value as ConsentGateTargetType)
    ? (value as ConsentGateTargetType)
    : null;
}

function repository(c: AdminContext, tenantId: string) {
  return new ConsentGatePolicyBindingRepository(createAuthContextFromHono(c, tenantId).coreAdapter);
}

function bindingErrorResponse(c: AdminContext, error: unknown): Response | null {
  if (error instanceof ConsentGatePolicyBindingError) {
    if (error.code === 'binding_not_found' || error.code === 'policy_not_found') {
      return notFound(c, error.message.split(':').slice(1).join(':'));
    }
    return invalid(c, error.message.split(':').slice(1).join(':'));
  }
  if (error instanceof ConsentGatePolicyConfigurationError) {
    return c.json(
      {
        error: 'configuration_error',
        error_description: 'A required Consent Gate Policy could not be resolved',
      },
      409
    );
  }
  if (error instanceof Error && /UNIQUE|unique constraint/iu.test(error.message)) {
    return c.json(
      {
        error: 'conflict',
        error_description: 'A binding already exists for this Gate and target',
      },
      409
    );
  }
  return null;
}

export async function adminConsentGateBindingsListHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_CONSENT_GATE_BINDINGS');
  try {
    const tenantId = getTenantIdFromContext(c);
    return c.json({ bindings: await repository(c, tenantId).list(tenantId) });
  } catch (error) {
    log.error('Failed to list Consent Gate Policy bindings', { action: 'list' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to list Consent Gate Policy bindings' },
      500
    );
  }
}

export async function adminConsentGateBindingGetHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_CONSENT_GATE_BINDINGS');
  try {
    const tenantId = getTenantIdFromContext(c);
    const binding = await repository(c, tenantId).findById(tenantId, c.req.param('id')!);
    return binding ? c.json({ binding }) : notFound(c, 'Consent Gate Policy binding not found');
  } catch (error) {
    log.error('Failed to get Consent Gate Policy binding', { action: 'get' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to get Consent Gate Policy binding' },
      500
    );
  }
}

export async function adminConsentGateBindingCreateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_CONSENT_GATE_BINDINGS');
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const gateKind = readGateKind(body.gate_kind);
    const targetType = readTargetType(body.target_type);
    const policyId = readString(body.policy_id);
    if (!gateKind) return invalid(c, 'gate_kind is invalid');
    if (!targetType) return invalid(c, 'target_type is invalid');
    if (!policyId) return invalid(c, 'policy_id is required');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return invalid(c, 'enabled must be a boolean');
    }
    const targetId = readNullableString(body.target_id);
    if (body.target_id !== undefined && targetId === undefined) {
      return invalid(c, 'target_id must be a string or null');
    }
    const tenantId = getTenantIdFromContext(c);
    const binding = await repository(c, tenantId).create({
      tenant_id: tenantId,
      gate_kind: gateKind,
      target_type: targetType,
      target_id: targetId,
      policy_id: policyId,
      enabled: body.enabled as boolean | undefined,
    });
    return c.json({ binding }, 201);
  } catch (error) {
    const mapped = bindingErrorResponse(c, error);
    if (mapped) return mapped;
    log.error('Failed to create Consent Gate Policy binding', { action: 'create' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to create Consent Gate Policy binding' },
      500
    );
  }
}

export async function adminConsentGateBindingUpdateHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_CONSENT_GATE_BINDINGS');
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const gateKind = body.gate_kind === undefined ? undefined : readGateKind(body.gate_kind);
    const targetType =
      body.target_type === undefined ? undefined : readTargetType(body.target_type);
    const targetId = readNullableString(body.target_id);
    const policyId = body.policy_id === undefined ? undefined : readString(body.policy_id);
    if (body.gate_kind !== undefined && !gateKind) return invalid(c, 'gate_kind is invalid');
    if (body.target_type !== undefined && !targetType) return invalid(c, 'target_type is invalid');
    if (body.target_id !== undefined && targetId === undefined) {
      return invalid(c, 'target_id must be a string or null');
    }
    if (body.policy_id !== undefined && !policyId) return invalid(c, 'policy_id is required');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return invalid(c, 'enabled must be a boolean');
    }
    if (
      gateKind === undefined &&
      targetType === undefined &&
      targetId === undefined &&
      policyId === undefined &&
      body.enabled === undefined
    ) {
      return invalid(c, 'At least one binding field is required');
    }
    const tenantId = getTenantIdFromContext(c);
    const binding = await repository(c, tenantId).update(tenantId, c.req.param('id')!, {
      gate_kind: gateKind ?? undefined,
      target_type: targetType ?? undefined,
      target_id: targetId,
      policy_id: policyId,
      enabled: body.enabled as boolean | undefined,
    });
    return c.json({ binding });
  } catch (error) {
    const mapped = bindingErrorResponse(c, error);
    if (mapped) return mapped;
    log.error('Failed to update Consent Gate Policy binding', { action: 'update' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to update Consent Gate Policy binding' },
      500
    );
  }
}

export async function adminConsentGateBindingDeleteHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_CONSENT_GATE_BINDINGS');
  try {
    const tenantId = getTenantIdFromContext(c);
    const deleted = await repository(c, tenantId).delete(tenantId, c.req.param('id')!);
    return deleted
      ? c.json({ success: true })
      : notFound(c, 'Consent Gate Policy binding not found');
  } catch (error) {
    log.error('Failed to delete Consent Gate Policy binding', { action: 'delete' }, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to delete Consent Gate Policy binding' },
      500
    );
  }
}

export async function adminConsentGateBindingPreviewHandler(c: AdminContext) {
  const log = getLogger(c).module('ADMIN_CONSENT_GATE_BINDINGS');
  try {
    const body = (await c.req.json()) as Record<string, unknown>;
    const gateKind = readGateKind(body.gate_kind);
    const targetType = readTargetType(body.target_type);
    const targetId = readNullableString(body.target_id);
    if (!gateKind) return invalid(c, 'gate_kind is invalid');
    if (!targetType) return invalid(c, 'target_type is invalid');
    if (body.target_id !== undefined && targetId === undefined) {
      return invalid(c, 'target_id must be a string or null');
    }
    if (targetType !== 'tenant' && !targetId) return invalid(c, 'target_id is required');
    if (targetType === 'tenant' && targetId) {
      return invalid(c, 'tenant target must not include target_id');
    }
    if (
      body.node_config !== undefined &&
      (!body.node_config || typeof body.node_config !== 'object' || Array.isArray(body.node_config))
    ) {
      return invalid(c, 'node_config must be an object');
    }
    const rawNodeConfig = (body.node_config as Record<string, unknown> | undefined) ?? {};
    const policyResolution = rawNodeConfig.policy_resolution;
    if (
      policyResolution !== undefined &&
      policyResolution !== 'fixed' &&
      policyResolution !== 'target_binding'
    ) {
      return invalid(c, 'node_config.policy_resolution is invalid');
    }
    if (
      rawNodeConfig.policy_required !== undefined &&
      typeof rawNodeConfig.policy_required !== 'boolean'
    ) {
      return invalid(c, 'node_config.policy_required must be a boolean');
    }
    for (const field of ['consent_policy_ref', 'fallback_policy_ref'] as const) {
      if (rawNodeConfig[field] !== undefined && !readString(rawNodeConfig[field])) {
        return invalid(c, `node_config.${field} must be a nonblank string`);
      }
    }
    const nodeConfig: ConsentGateNodeConfig = {
      policy_resolution: policyResolution,
      consent_policy_ref: readString(rawNodeConfig.consent_policy_ref),
      fallback_policy_ref: readString(rawNodeConfig.fallback_policy_ref),
      policy_required: rawNodeConfig.policy_required === true,
    };
    const tenantId = getTenantIdFromContext(c);
    const coreAdapter = createAuthContextFromHono(c, tenantId).coreAdapter;
    const effective = await resolveConsentGatePolicyBinding({
      repository: new ConsentGatePolicyBindingRepository(coreAdapter),
      tenantId,
      nodeConfig,
      gateKind,
      targetType,
      targetId: targetId ?? null,
    });
    const policy = effective.policyId
      ? await coreAdapter.queryOne<{
          id: string;
          display_name: string;
          description: string | null;
        }>(
          `SELECT id, display_name, description
			 FROM consent_policies
			WHERE tenant_id = ? AND id = ? AND is_active = 1
			LIMIT 1`,
          [tenantId, effective.policyId]
        )
      : null;
    const statementVersions = effective.policyId
      ? await coreAdapter.query<{
          statement_id: string;
          statement_slug: string;
          version: string | null;
          requirement: string;
          checkbox_mode: string;
          checkbox_default_checked: number;
        }>(
          `SELECT cpi.statement_id, cs.slug AS statement_slug,
				  csv.version, cpi.requirement, cpi.checkbox_mode,
				  cpi.checkbox_default_checked
			 FROM consent_policy_items cpi
			 JOIN consent_statements cs
			   ON cs.tenant_id = cpi.tenant_id AND cs.id = cpi.statement_id
			 LEFT JOIN consent_statement_versions csv
			   ON csv.tenant_id = cpi.tenant_id AND csv.statement_id = cpi.statement_id
			  AND ((cpi.version_mode = 'fixed' AND csv.id = cpi.version_id)
				OR (cpi.version_mode <> 'fixed' AND csv.is_current = 1))
			WHERE cpi.tenant_id = ? AND cpi.policy_id = ?
			ORDER BY cpi.display_order ASC, cpi.statement_id ASC`,
          [tenantId, effective.policyId]
        )
      : [];
    const affectedTargets = effective.policyId
      ? (await new ConsentGatePolicyBindingRepository(coreAdapter).list(tenantId)).filter(
          (binding) =>
            binding.enabled === 1 &&
            binding.gate_kind === gateKind &&
            binding.policy_id === effective.policyId
        )
      : [];
    return c.json({
      effective: {
        gate_kind: gateKind,
        target_type: targetType,
        target_id: targetId ?? null,
        policy_id: effective.policyId,
        source: effective.source,
        binding_id: effective.binding?.id ?? null,
        policy: policy
          ? {
              id: policy.id,
              display_name: policy.display_name,
              description: policy.description,
            }
          : null,
        statement_versions: statementVersions,
        affected_targets: affectedTargets.map((binding) => ({
          target_type: binding.target_type,
          target_id: binding.target_id,
          binding_id: binding.id,
        })),
      },
    });
  } catch (error) {
    const mapped = bindingErrorResponse(c, error);
    if (mapped) return mapped;
    log.error(
      'Failed to preview Consent Gate Policy binding',
      { action: 'preview' },
      error as Error
    );
    return c.json(
      { error: 'server_error', error_description: 'Failed to preview Consent Gate Policy binding' },
      500
    );
  }
}
