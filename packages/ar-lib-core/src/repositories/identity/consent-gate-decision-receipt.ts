import type { DatabaseAdapter, TransactionContext } from '../../db/adapter';
import type {
  ConsentGateDecisionReceipt,
  ConsentGateDecisionReceiptState,
  ConsentGateDecisionResult,
  ConsentGateKind,
  ConsentGateTargetType,
} from '../../types/consent-gates';
import { CONSENT_GATE_KINDS } from '../../types/consent-gates';
import { requireTenantId } from '../tenant';

type ConsentGateStore = Pick<DatabaseAdapter | TransactionContext, 'queryOne' | 'execute'>;

interface ConsentGateDecisionReceiptDatabaseRow {
  id: string;
  tenant_id: string;
  interaction_id: string;
  flow_id: string;
  flow_version_id: string;
  flow_node_id: string;
  gate_kind: ConsentGateKind;
  subject_user_id: string;
  target_type: ConsentGateTargetType;
  target_id: string | null;
  policy_id: string | null;
  protocol_request_id: string | null;
  statement_version_set_hash: string | null;
  release_set_hash: string | null;
  decision_json: string | ConsentGateDecisionResult;
  evidence_record_ids_json: string | string[];
  state: ConsentGateDecisionReceiptState;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface CreateConsentGateDecisionReceiptInput {
  tenant_id: string;
  interaction_id: string;
  flow_id: string;
  flow_version_id: string;
  flow_node_id: string;
  gate_kind: ConsentGateKind;
  subject_user_id: string;
  target_type: ConsentGateTargetType;
  target_id?: string | null;
  policy_id?: string | null;
  protocol_request_id?: string | null;
  statement_version_set_hash?: string | null;
  release_set_hash?: string | null;
  decision: ConsentGateDecisionResult;
  evidence_record_ids?: string[];
  state?: Extract<ConsentGateDecisionReceiptState, 'ready' | 'denied'>;
  expires_at: number;
  now?: number;
}

export type ConsentGateDecisionReceiptErrorCode =
  | 'receipt_not_found'
  | 'receipt_binding_mismatch'
  | 'receipt_not_ready'
  | 'receipt_expired'
  | 'receipt_corrupt';

export class ConsentGateDecisionReceiptError extends Error {
  constructor(
    readonly code: ConsentGateDecisionReceiptErrorCode,
    message: string
  ) {
    super(`${code}:${message}`);
    this.name = 'ConsentGateDecisionReceiptError';
  }
}

export class ConsentGateDecisionReceiptRepository {
  constructor(
    private readonly store: ConsentGateStore,
    private readonly idFactory: () => string = () => `cgr_${crypto.randomUUID().replace(/-/gu, '')}`
  ) {}

  async create(input: CreateConsentGateDecisionReceiptInput): Promise<ConsentGateDecisionReceipt> {
    const tenant = requireTenantId(input.tenant_id, 'ConsentGateDecisionReceiptRepository.create');
    assertReceiptTarget(input);
    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (input.expires_at <= now) {
      throw new ConsentGateDecisionReceiptError(
        'receipt_expired',
        'receipt expiration must be in the future'
      );
    }
    const targetId = input.target_id?.trim() || null;
    const protocolRequestId = input.protocol_request_id?.trim() || null;
    const receiptId = this.idFactory();
    if (!/^cgr_[a-f0-9]{32}$/u.test(receiptId)) {
      throw new ConsentGateDecisionReceiptError(
        'receipt_corrupt',
        'receipt ID generator returned an invalid opaque identifier'
      );
    }
    const receipt: ConsentGateDecisionReceipt = {
      id: receiptId,
      tenant_id: tenant,
      interaction_id: input.interaction_id,
      flow_id: input.flow_id,
      flow_version_id: input.flow_version_id,
      flow_node_id: input.flow_node_id,
      gate_kind: input.gate_kind,
      subject_user_id: input.subject_user_id,
      target_type: input.target_type,
      target_id: targetId,
      policy_id: input.policy_id ?? null,
      protocol_request_id: protocolRequestId,
      statement_version_set_hash: input.statement_version_set_hash ?? null,
      release_set_hash: input.release_set_hash ?? null,
      decision: input.decision,
      evidence_record_ids: input.evidence_record_ids ?? [],
      state: input.state ?? 'ready',
      expires_at: input.expires_at,
      consumed_at: null,
      created_at: now,
      updated_at: now,
    };
    await this.store.execute(
      `INSERT INTO consent_gate_decision_receipts (
        id, tenant_id, interaction_id, flow_id, flow_version_id, flow_node_id, gate_kind,
        subject_user_id, target_type, target_id, policy_id, protocol_request_id,
        statement_version_set_hash, release_set_hash, decision_json, evidence_record_ids_json,
        state, expires_at, consumed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receipt.id,
        receipt.tenant_id,
        receipt.interaction_id,
        receipt.flow_id,
        receipt.flow_version_id,
        receipt.flow_node_id,
        receipt.gate_kind,
        receipt.subject_user_id,
        receipt.target_type,
        receipt.target_id,
        receipt.policy_id,
        receipt.protocol_request_id,
        receipt.statement_version_set_hash,
        receipt.release_set_hash,
        JSON.stringify(receipt.decision),
        JSON.stringify(receipt.evidence_record_ids),
        receipt.state,
        receipt.expires_at,
        receipt.consumed_at,
        receipt.created_at,
        receipt.updated_at,
      ]
    );
    return receipt;
  }

  async findById(tenantId: string, id: string): Promise<ConsentGateDecisionReceipt | null> {
    const tenant = requireTenantId(tenantId, 'ConsentGateDecisionReceiptRepository.findById');
    const row = await this.store.queryOne<ConsentGateDecisionReceiptDatabaseRow>(
      `SELECT *
         FROM consent_gate_decision_receipts
        WHERE tenant_id = ? AND id = ?
        LIMIT 1`,
      [tenant, id]
    );
    return row ? hydrateReceipt(row) : null;
  }

  async findLatestForInteractionGate(input: {
    tenant_id: string;
    interaction_id: string;
    flow_node_id: string;
    gate_kind: ConsentGateKind;
  }): Promise<ConsentGateDecisionReceipt | null> {
    const tenant = requireTenantId(
      input.tenant_id,
      'ConsentGateDecisionReceiptRepository.findLatestForInteractionGate'
    );
    const row = await this.store.queryOne<ConsentGateDecisionReceiptDatabaseRow>(
      `SELECT *
         FROM consent_gate_decision_receipts
        WHERE tenant_id = ?
          AND interaction_id = ?
          AND flow_node_id = ?
          AND gate_kind = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [tenant, input.interaction_id, input.flow_node_id, input.gate_kind]
    );
    return row ? hydrateReceipt(row) : null;
  }

  async consume(input: {
    tenant_id: string;
    id: string;
    interaction_id: string;
    flow_id: string;
    flow_version_id: string;
    flow_node_id: string;
    gate_kind: ConsentGateKind;
    subject_user_id: string;
    target_type: ConsentGateTargetType;
    target_id: string | null;
    protocol_request_id: string | null;
    statement_version_set_hash: string | null;
    release_set_hash: string | null;
    now?: number;
  }): Promise<ConsentGateDecisionReceipt> {
    const tenant = requireTenantId(input.tenant_id, 'ConsentGateDecisionReceiptRepository.consume');
    const receipt = await this.findById(tenant, input.id);
    if (!receipt) {
      throw new ConsentGateDecisionReceiptError('receipt_not_found', 'receipt does not exist');
    }
    assertReceiptBinding(receipt, { ...input, tenant_id: tenant });
    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (receipt.expires_at <= now) {
      if (receipt.state === 'ready') {
        await this.store.execute(
          `UPDATE consent_gate_decision_receipts
              SET state = 'expired', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND state = 'ready'`,
          [now, tenant, input.id]
        );
      }
      throw new ConsentGateDecisionReceiptError('receipt_expired', 'receipt has expired');
    }
    if (receipt.state === 'consumed') {
      return receipt;
    }
    if (receipt.state !== 'ready') {
      throw new ConsentGateDecisionReceiptError(
        'receipt_not_ready',
        `receipt state is ${receipt.state}`
      );
    }
    const result = await this.store.execute(
      `UPDATE consent_gate_decision_receipts
          SET state = 'consumed', consumed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND state = 'ready'`,
      [now, now, tenant, input.id]
    );
    if (result.rowsAffected === 0) {
      const concurrent = await this.findById(tenant, input.id);
      if (concurrent?.state === 'consumed') return concurrent;
      throw new ConsentGateDecisionReceiptError(
        'receipt_not_ready',
        'receipt was changed before it could be consumed'
      );
    }
    return { ...receipt, state: 'consumed', consumed_at: now, updated_at: now };
  }
}

function hydrateReceipt(row: ConsentGateDecisionReceiptDatabaseRow): ConsentGateDecisionReceipt {
  try {
    const decision =
      typeof row.decision_json === 'string' ? JSON.parse(row.decision_json) : row.decision_json;
    const evidenceRecordIds =
      typeof row.evidence_record_ids_json === 'string'
        ? JSON.parse(row.evidence_record_ids_json)
        : row.evidence_record_ids_json;
    if (!isDecisionResult(decision) || !isStringArray(evidenceRecordIds)) {
      throw new Error('invalid receipt JSON');
    }
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      interaction_id: row.interaction_id,
      flow_id: row.flow_id,
      flow_version_id: row.flow_version_id,
      flow_node_id: row.flow_node_id,
      gate_kind: row.gate_kind,
      subject_user_id: row.subject_user_id,
      target_type: row.target_type,
      target_id: row.target_id,
      policy_id: row.policy_id,
      protocol_request_id: row.protocol_request_id,
      statement_version_set_hash: row.statement_version_set_hash,
      release_set_hash: row.release_set_hash,
      decision,
      evidence_record_ids: evidenceRecordIds,
      state: row.state,
      expires_at: row.expires_at,
      consumed_at: row.consumed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch {
    throw new ConsentGateDecisionReceiptError('receipt_corrupt', 'receipt JSON is invalid');
  }
}

function isDecisionResult(value: unknown): value is ConsentGateDecisionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    ['skip', 'challenge', 'deny', 'protocol_error'].includes(String(candidate.action)) &&
    CONSENT_GATE_KINDS.includes(candidate.gateKind as ConsentGateKind) &&
    isStringArray(candidate.reasonCodes) &&
    typeof candidate.forceInteraction === 'boolean' &&
    isStringArray(candidate.pendingItemIds) &&
    (candidate.protocolError === undefined || isProtocolError(candidate.protocolError)) &&
    (candidate.release === undefined || isReleaseDecision(candidate.release))
  );
}

function isReleaseDecision(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.protocol === 'oidc' &&
    isStringArray(candidate.requested_scopes) &&
    isStringArray(candidate.selected_scopes) &&
    isStringArray(candidate.required_scopes) &&
    isStringArray(candidate.requested_claims) &&
    isStringArray(candidate.selected_claims) &&
    isStringArray(candidate.required_claims)
  ) {
    return true;
  }
  return (
    candidate.protocol === 'saml' &&
    isStringArray(candidate.requested_attributes) &&
    isStringArray(candidate.selected_attributes) &&
    isStringArray(candidate.required_attributes) &&
    ['once', 'every_time', 'until_attributes_change'].includes(String(candidate.consent_mode))
  );
}

function isProtocolError(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.error === 'invalid_request' || candidate.error === 'consent_required') &&
    typeof candidate.description === 'string'
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function assertReceiptBinding(
  receipt: ConsentGateDecisionReceipt,
  expected: {
    tenant_id: string;
    interaction_id: string;
    flow_id: string;
    flow_version_id: string;
    flow_node_id: string;
    gate_kind: ConsentGateKind;
    subject_user_id: string;
    target_type: ConsentGateTargetType;
    target_id: string | null;
    protocol_request_id: string | null;
    statement_version_set_hash: string | null;
    release_set_hash: string | null;
  }
): void {
  const matches =
    receipt.tenant_id === expected.tenant_id &&
    receipt.interaction_id === expected.interaction_id &&
    receipt.flow_id === expected.flow_id &&
    receipt.flow_version_id === expected.flow_version_id &&
    receipt.flow_node_id === expected.flow_node_id &&
    receipt.gate_kind === expected.gate_kind &&
    receipt.subject_user_id === expected.subject_user_id &&
    receipt.target_type === expected.target_type &&
    receipt.target_id === expected.target_id &&
    receipt.protocol_request_id === expected.protocol_request_id &&
    receipt.statement_version_set_hash === expected.statement_version_set_hash &&
    receipt.release_set_hash === expected.release_set_hash;
  if (!matches) {
    throw new ConsentGateDecisionReceiptError(
      'receipt_binding_mismatch',
      'receipt does not match the protocol continuation'
    );
  }
}

function assertReceiptTarget(input: {
  gate_kind: ConsentGateKind;
  target_type: ConsentGateTargetType;
  target_id?: string | null;
  protocol_request_id?: string | null;
}): void {
  const targetId = input.target_id?.trim() || null;
  const protocolRequestId = input.protocol_request_id?.trim() || null;
  const targetShapeValid =
    (input.target_type === 'tenant' && targetId === null) ||
    (input.target_type !== 'tenant' && targetId !== null && protocolRequestId !== null);
  const gateTargetValid =
    input.gate_kind === 'legal_document' ||
    (input.gate_kind === 'oidc_authorization' && input.target_type === 'oidc_client') ||
    (input.gate_kind === 'saml_attribute_release' && input.target_type === 'saml_sp');
  if (!targetShapeValid || !gateTargetValid) {
    throw new ConsentGateDecisionReceiptError(
      'receipt_binding_mismatch',
      'receipt target or protocol request binding is invalid'
    );
  }
}
