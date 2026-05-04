import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const { mockGetApprovalDecisionReceipt } = vi.hoisted(() => ({
  mockGetApprovalDecisionReceipt: vi.fn(),
}));

vi.mock('../approval-completion-receipt', () => ({
  getApprovalDecisionReceipt: mockGetApprovalDecisionReceipt,
}));

import { approvalReceiptsRouter } from '../routes/approval-receipts';

const mockEnv = {} as Env;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/approval-receipts', approvalReceiptsRouter);
  return app;
}

describe('approval receipts router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApprovalDecisionReceipt.mockResolvedValue({
      receipt_id: 'adr_1',
      artifact_id: 'apc_1',
      tenant_id: 'tenant-a',
      request_id: 'apr_public_1',
      approval_id: 'step-1',
      step_key: 'operator-1',
      investigation_id: 'inv_1',
      request_surface: 'admin_audit',
      requested_action: 'detail_read',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      approver_side: 'admin_operator',
      approver_subject_type: 'admin_user',
      approver_subject_id: 'admin-2',
      relation_type: null,
      relation_source: null,
      method: 'portal_confirm',
      transport_channel: 'portal_confirm',
      redaction_level: 'masked',
      request_status: 'approved',
      decision: 'approved',
      grant_ids: ['egr_public_1'],
      reference: null,
      ticket_reference: null,
      completed_at: 1730000000000,
      expires_at: 1730003600000,
      created_at: 1730000000000,
    });
  });

  it('returns receipt json with public paths', async () => {
    const app = createApp();
    const res = await app.request('/api/approval-receipts/adr_1', {}, mockEnv);

    expect(res.status).toBe(200);
    const payload = (await res.json()) as any;
    expect(payload.receipt_id).toBe('adr_1');
    expect(payload.receipt_path).toBe('/api/approval-receipts/adr_1');
    expect(payload.receipt_portal_path).toBe('/api/approval-receipts/adr_1/portal');
  });

  it('renders a human-usable receipt portal page', async () => {
    const app = createApp();
    const res = await app.request('/api/approval-receipts/adr_1/portal', {}, mockEnv);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Approval decision recorded');
    expect(html).toContain('adr_1');
    expect(html).toContain('approved');
  });
});
