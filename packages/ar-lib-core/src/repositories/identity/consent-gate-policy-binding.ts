import type { DatabaseAdapter } from '../../db/adapter';
import type {
  ConsentGateKind,
  ConsentGateNodeConfig,
  ConsentGateTargetType,
} from '../../types/consent-gates';
import { generateId, getCurrentTimestamp } from '../base';
import { requireTenantId } from '../tenant';

export interface ConsentGatePolicyBindingRow {
  id: string;
  tenant_id: string;
  gate_kind: ConsentGateKind;
  target_type: ConsentGateTargetType;
  target_id: string | null;
  policy_id: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface CreateConsentGatePolicyBindingInput {
  id?: string;
  tenant_id: string;
  gate_kind: ConsentGateKind;
  target_type: ConsentGateTargetType;
  target_id?: string | null;
  policy_id: string;
  enabled?: boolean;
}

export interface UpdateConsentGatePolicyBindingInput {
  gate_kind?: ConsentGateKind;
  target_type?: ConsentGateTargetType;
  target_id?: string | null;
  policy_id?: string;
  enabled?: boolean;
}

export type ConsentGatePolicyBindingErrorCode =
  | 'binding_not_found'
  | 'invalid_target'
  | 'invalid_gate_target'
  | 'policy_not_found';

export class ConsentGatePolicyBindingError extends Error {
  constructor(
    readonly code: ConsentGatePolicyBindingErrorCode,
    message: string
  ) {
    super(`${code}:${message}`);
    this.name = 'ConsentGatePolicyBindingError';
  }
}

export class ConsentGatePolicyBindingRepository {
  constructor(private readonly adapter: DatabaseAdapter) {}

  async list(tenantId: string): Promise<ConsentGatePolicyBindingRow[]> {
    const tenant = requireTenantId(tenantId, 'ConsentGatePolicyBindingRepository.list');
    return this.adapter.query<ConsentGatePolicyBindingRow>(
      `SELECT *
         FROM consent_gate_policy_bindings
        WHERE tenant_id = ?
        ORDER BY gate_kind ASC, target_type ASC, target_id ASC, created_at ASC`,
      [tenant]
    );
  }

  async findById(tenantId: string, id: string): Promise<ConsentGatePolicyBindingRow | null> {
    const tenant = requireTenantId(tenantId, 'ConsentGatePolicyBindingRepository.findById');
    return this.adapter.queryOne<ConsentGatePolicyBindingRow>(
      `SELECT *
         FROM consent_gate_policy_bindings
        WHERE tenant_id = ? AND id = ?
        LIMIT 1`,
      [tenant, id]
    );
  }

  async findEnabledExact(input: {
    tenant_id: string;
    gate_kind: ConsentGateKind;
    target_type: Exclude<ConsentGateTargetType, 'tenant'>;
    target_id: string;
  }): Promise<ConsentGatePolicyBindingRow | null> {
    const tenant = requireTenantId(
      input.tenant_id,
      'ConsentGatePolicyBindingRepository.findEnabledExact'
    );
    const targetId = input.target_id.trim();
    if (!targetId) {
      throw new ConsentGatePolicyBindingError('invalid_target', 'target_id is required');
    }
    return this.adapter.queryOne<ConsentGatePolicyBindingRow>(
      `SELECT b.*
         FROM consent_gate_policy_bindings b
         JOIN consent_policies p ON p.id = b.policy_id AND p.tenant_id = b.tenant_id
        WHERE b.tenant_id = ?
          AND b.gate_kind = ?
          AND b.target_type = ?
          AND b.target_id = ?
          AND b.enabled = 1
        LIMIT 1`,
      [tenant, input.gate_kind, input.target_type, targetId]
    );
  }

  async findEnabledTenantDefault(
    tenantId: string,
    gateKind: ConsentGateKind
  ): Promise<ConsentGatePolicyBindingRow | null> {
    const tenant = requireTenantId(
      tenantId,
      'ConsentGatePolicyBindingRepository.findEnabledTenantDefault'
    );
    return this.adapter.queryOne<ConsentGatePolicyBindingRow>(
      `SELECT b.*
         FROM consent_gate_policy_bindings b
         JOIN consent_policies p ON p.id = b.policy_id AND p.tenant_id = b.tenant_id
        WHERE b.tenant_id = ?
          AND b.gate_kind = ?
          AND b.target_type = 'tenant'
          AND b.target_id IS NULL
          AND b.enabled = 1
        LIMIT 1`,
      [tenant, gateKind]
    );
  }

  async policyExists(tenantId: string, policyId: string): Promise<boolean> {
    const tenant = requireTenantId(tenantId, 'ConsentGatePolicyBindingRepository.policyExists');
    const policy = await this.adapter.queryOne<{ id: string }>(
      `SELECT id FROM consent_policies WHERE tenant_id = ? AND id = ? LIMIT 1`,
      [tenant, policyId]
    );
    return policy !== null;
  }

  async create(input: CreateConsentGatePolicyBindingInput): Promise<ConsentGatePolicyBindingRow> {
    const tenant = requireTenantId(input.tenant_id, 'ConsentGatePolicyBindingRepository.create');
    const targetId = normalizeBindingTarget(input.target_type, input.target_id);
    assertGateTargetCompatibility(input.gate_kind, input.target_type);
    await this.assertPolicyBelongsToTenant(tenant, input.policy_id);
    const now = getCurrentTimestamp();
    const row: ConsentGatePolicyBindingRow = {
      id: input.id ?? generateId(),
      tenant_id: tenant,
      gate_kind: input.gate_kind,
      target_type: input.target_type,
      target_id: targetId,
      policy_id: input.policy_id,
      enabled: input.enabled === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    };
    await this.adapter.execute(
      `INSERT INTO consent_gate_policy_bindings (
        id, tenant_id, gate_kind, target_type, target_id, policy_id, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.gate_kind,
        row.target_type,
        row.target_id,
        row.policy_id,
        row.enabled,
        row.created_at,
        row.updated_at,
      ]
    );
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateConsentGatePolicyBindingInput
  ): Promise<ConsentGatePolicyBindingRow> {
    const tenant = requireTenantId(tenantId, 'ConsentGatePolicyBindingRepository.update');
    const existing = await this.findById(tenant, id);
    if (!existing) {
      throw new ConsentGatePolicyBindingError('binding_not_found', 'binding does not exist');
    }
    const targetType = input.target_type ?? existing.target_type;
    const targetId = normalizeBindingTarget(
      targetType,
      input.target_id === undefined ? existing.target_id : input.target_id
    );
    const gateKind = input.gate_kind ?? existing.gate_kind;
    assertGateTargetCompatibility(gateKind, targetType);
    const policyId = input.policy_id ?? existing.policy_id;
    await this.assertPolicyBelongsToTenant(tenant, policyId);
    const updated: ConsentGatePolicyBindingRow = {
      ...existing,
      gate_kind: gateKind,
      target_type: targetType,
      target_id: targetId,
      policy_id: policyId,
      enabled: input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
      updated_at: getCurrentTimestamp(),
    };
    await this.adapter.execute(
      `UPDATE consent_gate_policy_bindings
          SET gate_kind = ?, target_type = ?, target_id = ?, policy_id = ?, enabled = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        updated.gate_kind,
        updated.target_type,
        updated.target_id,
        updated.policy_id,
        updated.enabled,
        updated.updated_at,
        tenant,
        id,
      ]
    );
    return updated;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const tenant = requireTenantId(tenantId, 'ConsentGatePolicyBindingRepository.delete');
    const result = await this.adapter.execute(
      `DELETE FROM consent_gate_policy_bindings WHERE tenant_id = ? AND id = ?`,
      [tenant, id]
    );
    return result.rowsAffected > 0;
  }

  private async assertPolicyBelongsToTenant(tenantId: string, policyId: string): Promise<void> {
    if (!(await this.policyExists(tenantId, policyId))) {
      throw new ConsentGatePolicyBindingError(
        'policy_not_found',
        'policy does not exist in the binding tenant'
      );
    }
  }
}

export type ConsentGatePolicyResolutionSource =
  | 'fixed'
  | 'exact_binding'
  | 'tenant_default'
  | 'fallback'
  | 'skip';

export interface ResolvedConsentGatePolicyBinding {
  policyId: string | null;
  source: ConsentGatePolicyResolutionSource;
  binding: ConsentGatePolicyBindingRow | null;
}

export class ConsentGatePolicyConfigurationError extends Error {
  constructor(readonly gateKind: ConsentGateKind) {
    super(`required_policy_missing:${gateKind}`);
    this.name = 'ConsentGatePolicyConfigurationError';
  }
}

export async function resolveConsentGatePolicyBinding(input: {
  repository: ConsentGatePolicyBindingRepository;
  tenantId: string;
  nodeConfig: ConsentGateNodeConfig;
  gateKind: ConsentGateKind;
  targetType: ConsentGateTargetType;
  targetId: string | null;
}): Promise<ResolvedConsentGatePolicyBinding> {
  const tenantId = requireTenantId(input.tenantId, 'resolveConsentGatePolicyBinding');
  const resolution =
    input.nodeConfig.policy_resolution ??
    (input.nodeConfig.consent_policy_ref ? 'fixed' : 'target_binding');
  const fixedPolicyId = input.nodeConfig.consent_policy_ref?.trim();
  const fallbackPolicyId = input.nodeConfig.fallback_policy_ref?.trim();

  if (resolution === 'fixed' && fixedPolicyId) {
    if (await input.repository.policyExists(tenantId, fixedPolicyId)) {
      return { policyId: fixedPolicyId, source: 'fixed', binding: null };
    }
    return missingPolicyResult(input.gateKind, input.nodeConfig.policy_required === true);
  }

  if (resolution === 'target_binding') {
    const exactBinding =
      input.targetType !== 'tenant' && input.targetId?.trim()
        ? await input.repository.findEnabledExact({
            tenant_id: tenantId,
            gate_kind: input.gateKind,
            target_type: input.targetType,
            target_id: input.targetId,
          })
        : null;
    if (exactBinding) {
      return { policyId: exactBinding.policy_id, source: 'exact_binding', binding: exactBinding };
    }

    const tenantDefault = await input.repository.findEnabledTenantDefault(tenantId, input.gateKind);
    if (tenantDefault) {
      return {
        policyId: tenantDefault.policy_id,
        source: 'tenant_default',
        binding: tenantDefault,
      };
    }
  }

  if (fallbackPolicyId) {
    if (await input.repository.policyExists(tenantId, fallbackPolicyId)) {
      return { policyId: fallbackPolicyId, source: 'fallback', binding: null };
    }
    return missingPolicyResult(input.gateKind, input.nodeConfig.policy_required === true);
  }
  if (input.nodeConfig.policy_required === true) {
    throw new ConsentGatePolicyConfigurationError(input.gateKind);
  }
  return { policyId: null, source: 'skip', binding: null };
}

function missingPolicyResult(
  gateKind: ConsentGateKind,
  required: boolean
): ResolvedConsentGatePolicyBinding {
  if (required) throw new ConsentGatePolicyConfigurationError(gateKind);
  return { policyId: null, source: 'skip', binding: null };
}

function normalizeBindingTarget(
  targetType: ConsentGateTargetType,
  targetId: string | null | undefined
): string | null {
  const normalized = targetId?.trim() || null;
  if (targetType === 'tenant') {
    if (normalized !== null) {
      throw new ConsentGatePolicyBindingError(
        'invalid_target',
        'tenant default binding must not have target_id'
      );
    }
    return null;
  }
  if (!normalized) {
    throw new ConsentGatePolicyBindingError(
      'invalid_target',
      `${targetType} binding requires target_id`
    );
  }
  return normalized;
}

function assertGateTargetCompatibility(
  gateKind: ConsentGateKind,
  targetType: ConsentGateTargetType
): void {
  const compatible =
    targetType === 'tenant' ||
    gateKind === 'legal_document' ||
    (gateKind === 'oidc_authorization' && targetType === 'oidc_client') ||
    (gateKind === 'saml_attribute_release' && targetType === 'saml_sp');
  if (!compatible) {
    throw new ConsentGatePolicyBindingError(
      'invalid_gate_target',
      `${gateKind} cannot bind to ${targetType}`
    );
  }
}
