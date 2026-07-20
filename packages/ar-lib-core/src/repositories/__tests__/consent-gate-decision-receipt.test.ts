import { describe, expect, it, vi } from 'vitest';
import { ConsentGateDecisionReceiptError, ConsentGateDecisionReceiptRepository } from '../identity';
import { MockDatabaseAdapter } from './mock-adapter';

const RECEIPT_ID = 'cgr_00000000000000000000000000000001';
const DENIED_RECEIPT_ID = 'cgr_00000000000000000000000000000002';

function createRepository(ids = [RECEIPT_ID, DENIED_RECEIPT_ID]) {
  const adapter = new MockDatabaseAdapter();
  adapter.initTable('consent_gate_decision_receipts', 'id');
  let idIndex = 0;
  return {
    adapter,
    repository: new ConsentGateDecisionReceiptRepository(
      adapter,
      () => ids[idIndex++] ?? 'receipt-extra'
    ),
  };
}

const receiptInput = {
  tenant_id: 'tenant-a',
  interaction_id: 'interaction-a',
  flow_id: 'flow-a',
  flow_version_id: 'flow-version-a',
  flow_node_id: 'node-a',
  gate_kind: 'oidc_authorization' as const,
  subject_user_id: 'user-a',
  target_type: 'oidc_client' as const,
  target_id: 'client-a',
  policy_id: 'policy-a',
  protocol_request_id: 'challenge-a',
  statement_version_set_hash: 'sha256:statements',
  release_set_hash: 'sha256:release',
  decision: {
    action: 'skip' as const,
    gateKind: 'oidc_authorization' as const,
    reasonCodes: ['consent.gate.satisfied'],
    forceInteraction: false,
    pendingItemIds: [],
    release: {
      protocol: 'oidc' as const,
      requested_scopes: ['openid', 'profile'],
      selected_scopes: ['openid'],
      required_scopes: ['openid'],
      requested_claims: ['email'],
      selected_claims: [],
      required_claims: [],
    },
  },
  evidence_record_ids: ['evidence-a'],
  expires_at: 2_000,
  now: 1_000,
};

const consumeInput = {
  tenant_id: receiptInput.tenant_id,
  id: RECEIPT_ID,
  interaction_id: receiptInput.interaction_id,
  flow_id: receiptInput.flow_id,
  flow_version_id: receiptInput.flow_version_id,
  flow_node_id: receiptInput.flow_node_id,
  gate_kind: receiptInput.gate_kind,
  subject_user_id: receiptInput.subject_user_id,
  target_type: receiptInput.target_type,
  target_id: receiptInput.target_id,
  protocol_request_id: receiptInput.protocol_request_id,
  statement_version_set_hash: receiptInput.statement_version_set_hash,
  release_set_hash: receiptInput.release_set_hash,
  now: 1_500,
};

describe('ConsentGateDecisionReceiptRepository', () => {
  it('stores JSON evidence without exposing protocol state in the receipt ID', async () => {
    const adapter = new MockDatabaseAdapter();
    adapter.initTable('consent_gate_decision_receipts', 'id');
    const repository = new ConsentGateDecisionReceiptRepository(adapter);
    const receipt = await repository.create(receiptInput);
    expect(receipt.id).toMatch(/^cgr_[a-f0-9]{32}$/u);
    await expect(repository.findById('tenant-a', receipt.id)).resolves.toMatchObject({
      evidence_record_ids: ['evidence-a'],
      decision: {
        action: 'skip',
        release: { requested_scopes: ['openid', 'profile'], selected_scopes: ['openid'] },
      },
    });
  });

  it('rejects an invalid receipt ID factory result', async () => {
    const adapter = new MockDatabaseAdapter();
    const repository = new ConsentGateDecisionReceiptRepository(adapter, () => 'predictable');
    await expect(repository.create(receiptInput)).rejects.toMatchObject({
      code: 'receipt_corrupt',
    });
  });

  it('creates a direct Legal Consent receipt without external target identifiers', async () => {
    const { repository } = createRepository();
    await expect(
      repository.create({
        tenant_id: 'tenant-a',
        interaction_id: 'interaction-direct',
        flow_id: 'flow-a',
        flow_version_id: 'flow-version-a',
        flow_node_id: 'legal-node',
        gate_kind: 'legal_document',
        subject_user_id: 'user-a',
        target_type: 'tenant',
        decision: {
          action: 'skip',
          gateKind: 'legal_document',
          reasonCodes: ['consent.gate.satisfied'],
          forceInteraction: false,
          pendingItemIds: [],
        },
        expires_at: Math.floor(Date.now() / 1000) + 60,
      })
    ).resolves.toMatchObject({
      target_id: null,
      protocol_request_id: null,
      policy_id: null,
      statement_version_set_hash: null,
      release_set_hash: null,
      evidence_record_ids: [],
      state: 'ready',
    });
  });

  it('hydrates a SAML attribute subset decision without raw attribute values', async () => {
    const { repository } = createRepository();
    const receipt = await repository.create({
      ...receiptInput,
      gate_kind: 'saml_attribute_release',
      target_type: 'saml_sp',
      target_id: 'https://sp.example.test/entity',
      protocol_request_id: '_request',
      decision: {
        action: 'skip',
        gateKind: 'saml_attribute_release',
        reasonCodes: ['consent.gate.release_selected'],
        forceInteraction: false,
        pendingItemIds: [],
        release: {
          protocol: 'saml',
          requested_attributes: ['mail', 'displayName'],
          selected_attributes: ['mail'],
          required_attributes: ['mail'],
          consent_mode: 'until_attributes_change',
        },
      },
    });

    expect(receipt.decision.release).toMatchObject({
      protocol: 'saml',
      selected_attributes: ['mail'],
    });
    expect(JSON.stringify(receipt)).not.toContain('user@example.test');
  });

  it('consumes an exactly bound receipt idempotently', async () => {
    const { repository } = createRepository();
    await repository.create(receiptInput);
    await expect(repository.consume(consumeInput)).resolves.toMatchObject({
      state: 'consumed',
      consumed_at: 1_500,
    });
    await expect(repository.consume({ ...consumeInput, now: 1_600 })).resolves.toMatchObject({
      state: 'consumed',
      consumed_at: 1_500,
    });
  });

  it('finds an existing interaction gate receipt for idempotent Flow retries', async () => {
    const { repository } = createRepository();
    await repository.create(receiptInput);

    await expect(
      repository.findLatestForInteractionGate({
        tenant_id: 'tenant-a',
        interaction_id: 'interaction-a',
        flow_node_id: 'node-a',
        gate_kind: 'oidc_authorization',
      })
    ).resolves.toMatchObject({ id: RECEIPT_ID, state: 'ready' });
    await expect(
      repository.findLatestForInteractionGate({
        tenant_id: 'tenant-b',
        interaction_id: 'interaction-a',
        flow_node_id: 'node-a',
        gate_kind: 'oidc_authorization',
      })
    ).resolves.toBeNull();
  });

  it.each([
    ['tenant', { tenant_id: 'tenant-b' }, 'receipt_not_found'],
    ['subject', { subject_user_id: 'user-b' }, 'receipt_binding_mismatch'],
    ['Client', { target_id: 'client-b' }, 'receipt_binding_mismatch'],
    ['request', { protocol_request_id: 'challenge-b' }, 'receipt_binding_mismatch'],
    ['release set', { release_set_hash: 'sha256:other' }, 'receipt_binding_mismatch'],
  ])('rejects a cross-boundary %s receipt', async (_name, overrides, code) => {
    const { repository } = createRepository();
    await repository.create(receiptInput);
    await expect(repository.consume({ ...consumeInput, ...overrides })).rejects.toMatchObject<
      Partial<ConsentGateDecisionReceiptError>
    >({ code });
  });

  it('expires a ready receipt and never consumes a denied receipt', async () => {
    const { repository } = createRepository();
    await repository.create(receiptInput);
    await expect(repository.consume({ ...consumeInput, now: 2_000 })).rejects.toMatchObject({
      code: 'receipt_expired',
    });
    await repository.create({ ...receiptInput, state: 'denied' });
    await expect(
      repository.consume({ ...consumeInput, id: DENIED_RECEIPT_ID })
    ).rejects.toMatchObject({ code: 'receipt_not_ready' });
  });

  it.each([
    ['missing external request binding', { protocol_request_id: null }],
    ['wrong protocol target', { target_type: 'saml_sp' as const }],
    ['tenant target with external identifiers', { target_type: 'tenant' as const }],
  ])('rejects an invalid receipt target: %s', async (_name, overrides) => {
    const { repository } = createRepository();
    await expect(repository.create({ ...receiptInput, ...overrides })).rejects.toMatchObject({
      code: 'receipt_binding_mismatch',
    });
  });

  it('rejects a receipt that is already expired at creation', async () => {
    const { repository } = createRepository();
    await expect(
      repository.create({ ...receiptInput, expires_at: 1_000, now: 1_000 })
    ).rejects.toMatchObject({ code: 'receipt_expired' });
  });

  it('handles an idempotent concurrent consume and rejects a conflicting state change', async () => {
    const { adapter, repository } = createRepository();
    await repository.create(receiptInput);
    const readyRow = adapter.getById('consent_gate_decision_receipts', RECEIPT_ID)!;
    const concurrentConsumed = {
      ...readyRow,
      state: 'consumed',
      consumed_at: 1_500,
      updated_at: 1_500,
    };
    const idempotentStore = {
      queryOne: vi.fn().mockResolvedValueOnce(readyRow).mockResolvedValueOnce(concurrentConsumed),
      execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 0 }),
    };
    await expect(
      new ConsentGateDecisionReceiptRepository(idempotentStore as never).consume(consumeInput)
    ).resolves.toMatchObject({ state: 'consumed', consumed_at: 1_500 });

    const conflictingStore = {
      queryOne: vi
        .fn()
        .mockResolvedValueOnce(readyRow)
        .mockResolvedValueOnce({ ...readyRow, state: 'denied' }),
      execute: vi.fn().mockResolvedValue({ success: true, rowsAffected: 0 }),
    };
    await expect(
      new ConsentGateDecisionReceiptRepository(conflictingStore as never).consume(consumeInput)
    ).rejects.toMatchObject({ code: 'receipt_not_ready' });
  });

  it('hydrates PostgreSQL JSONB objects and validates protocol errors', async () => {
    const { adapter, repository } = createRepository();
    await repository.create(receiptInput);
    const row = adapter.getById('consent_gate_decision_receipts', RECEIPT_ID)!;
    row.decision_json = {
      action: 'protocol_error',
      gateKind: 'oidc_authorization',
      reasonCodes: ['consent.gate.prompt_none_interaction_forbidden'],
      forceInteraction: false,
      pendingItemIds: [],
      protocolError: { error: 'consent_required', description: 'Interaction is required' },
    };
    row.evidence_record_ids_json = ['evidence-a'];
    await expect(repository.findById('tenant-a', RECEIPT_ID)).resolves.toMatchObject({
      decision: { protocolError: { error: 'consent_required' } },
      evidence_record_ids: ['evidence-a'],
    });

    row.decision_json = {
      ...(row.decision_json as Record<string, unknown>),
      protocolError: { error: 'unknown' },
    };
    await expect(repository.findById('tenant-a', RECEIPT_ID)).rejects.toMatchObject({
      code: 'receipt_corrupt',
    });
  });

  it('fails closed for corrupt persisted JSON', async () => {
    const { adapter, repository } = createRepository();
    adapter.seed('consent_gate_decision_receipts', [
      {
        ...receiptInput,
        id: RECEIPT_ID,
        decision_json: '{invalid',
        evidence_record_ids_json: '[]',
        state: 'ready',
        consumed_at: null,
        created_at: 1_000,
        updated_at: 1_000,
      },
    ]);
    await expect(repository.findById('tenant-a', RECEIPT_ID)).rejects.toMatchObject({
      code: 'receipt_corrupt',
    });
  });
});
