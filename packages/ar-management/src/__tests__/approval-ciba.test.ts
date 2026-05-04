import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalCompletionArtifact, ApprovalRequest, ApprovalRequestApproval, CIBARequestMetadata, Env } from '@authrim/ar-lib-core';

const {
  mockGenerateAuthReqId,
  mockGenerateCIBAUserCode,
  mockGetCIBARequestStoreForNewRequest,
  mockGetCIBARequestStoreById,
} = vi.hoisted(() => ({
  mockGenerateAuthReqId: vi.fn(),
  mockGenerateCIBAUserCode: vi.fn(),
  mockGetCIBARequestStoreForNewRequest: vi.fn(),
  mockGetCIBARequestStoreById: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    generateAuthReqId: mockGenerateAuthReqId,
    generateCIBAUserCode: mockGenerateCIBAUserCode,
    getCIBARequestStoreForNewRequest: mockGetCIBARequestStoreForNewRequest,
    getCIBARequestStoreById: mockGetCIBARequestStoreById,
  };
});

import {
  getApprovalCibaStatus,
  respondToApprovalCibaRequest,
  startApprovalCibaRequest,
} from '../approval-ciba';

function createMockEnv() {
  const kvStore = new Map<string, string>();
  let currentMetadata: CIBARequestMetadata | null = null;

  const stub = {
    fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = (await request.json()) as Record<string, unknown>;

      if (url.pathname === '/store') {
        currentMetadata = body as unknown as CIBARequestMetadata;
        return new Response(JSON.stringify({ success: true }));
      }

      if (url.pathname === '/get-by-auth-req-id') {
        return new Response(JSON.stringify(currentMetadata), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname === '/approve') {
        currentMetadata = {
          ...(currentMetadata as CIBARequestMetadata),
          status: 'approved',
          user_id: String(body.user_id),
          sub: String(body.sub),
          nonce: String(body.nonce),
        };
        return new Response(JSON.stringify({ success: true }));
      }

      if (url.pathname === '/deny') {
        currentMetadata = {
          ...(currentMetadata as CIBARequestMetadata),
          status: 'denied',
        };
        return new Response(JSON.stringify({ success: true }));
      }

      return new Response(JSON.stringify({ success: true }));
    }),
  };

  mockGetCIBARequestStoreForNewRequest.mockResolvedValue({
    stub,
    cibaId: 'g1:apac:1:cba_generated',
    resolution: { generation: 1, regionKey: 'apac', shardIndex: 1 },
    instanceName: 'tenant-a:apac:cba:1',
  });
  mockGetCIBARequestStoreById.mockReturnValue({
    stub,
    resolution: { generation: 1, regionKey: 'apac', shardIndex: 1 },
    instanceName: 'tenant-a:apac:cba:1',
    authReqId: 'g1:apac:1:cba_generated',
  });

  const env = {
    AUTHRIM_CONFIG: {
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        kvStore.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        kvStore.delete(key);
      }),
    },
  } as unknown as Env;

  return {
    env,
    kvStore,
    getCurrentMetadata: () => currentMetadata,
  };
}

function makeArtifact(): ApprovalCompletionArtifact {
  return {
    artifact_id: 'apc_1',
    tenant_id: 'tenant-a',
    request_id: 'apr_public_1',
    approval_id: 'step-1',
    step_key: 'delegate-1',
    investigation_id: 'inv_1',
    request_surface: 'service_data',
    requested_action: 'detail_read',
    target_subject_type: 'user',
    target_subject_id: 'user-1',
    requester_subject_type: 'admin_user',
    requester_subject_id: 'admin-1',
    approver_side: 'customer_data_owner',
    approver_subject_type: 'customer_delegate',
    approver_subject_id: 'customer-1',
    relation_type: null,
    relation_source: null,
    method: 'ciba',
    transport_channel: 'ciba',
    redaction_level: 'masked',
    policy_preset: 'support_case_default',
    reuse_scope: 'request',
    partial_access_allowed: false,
    reference: null,
    ticket_reference: null,
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    consumed: false,
  };
}

function makeRequest(): ApprovalRequest {
  return {
    id: 'req-1',
    public_request_id: 'apr_public_1',
    tenant_id: 'tenant-a',
    investigation_id: 'inv_1',
    requester_subject_type: 'admin_user',
    requester_subject_id: 'admin-1',
    target_subject_type: 'user',
    target_subject_id: 'user-1',
    request_surface: 'service_data',
    requested_action: 'detail_read',
    redaction_level: 'masked',
    status: 'pending',
    scope_json: {
      version: 1,
      surface: 'service_data',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'customer_profile',
    },
    scope_canonical: '{}',
    reason_code: 'support_case',
    reason_note: null,
    reference: null,
    ticket_reference: null,
    reuse_scope: 'request',
    policy_preset: 'support_case_default',
    partial_access_allowed: false,
    requested_at: Date.now(),
    expires_at: Date.now() + 60_000,
    decided_at: null,
    detail_object_catalog_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

function makeApproval(): ApprovalRequestApproval {
  return {
    id: 'step-1',
    approval_request_id: 'req-1',
    step_key: 'delegate-1',
    side: 'customer_data_owner',
    subject_type: 'customer_delegate',
    subject_id: 'customer-1',
    relation_type: null,
    relation_source: null,
    status: 'pending',
    method: 'ciba',
    transport_channel: 'ciba',
    reason_code: null,
    reason_note: null,
    last_notification_action: null,
    last_notified_at: null,
    notification_count: 0,
    requested_at: Date.now(),
    decided_at: null,
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
}

describe('approval ciba helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateAuthReqId.mockReturnValue('internal-auth-req');
    mockGenerateCIBAUserCode.mockReturnValue('ABCD-EFGH');
  });

  it('starts a CIBA request and reuses the existing pending request', async () => {
    const { env, kvStore, getCurrentMetadata } = createMockEnv();
    const artifact = makeArtifact();
    const request = makeRequest();
    const approval = makeApproval();

    const first = await startApprovalCibaRequest({
      env,
      tenantId: 'tenant-a',
      artifact,
      request,
      approval,
    });
    const second = await startApprovalCibaRequest({
      env,
      tenantId: 'tenant-a',
      artifact,
      request,
      approval,
    });

    expect(first.authReqId).toBe('g1:apac:1:cba_generated');
    expect(first.reused).toBe(false);
    expect(second.authReqId).toBe('g1:apac:1:cba_generated');
    expect(second.reused).toBe(true);
    expect(getCurrentMetadata()?.status).toBe('pending');
    expect(kvStore.has('approval_ciba:artifact:apc_1')).toBe(true);
    expect(mockGetCIBARequestStoreForNewRequest).toHaveBeenCalledTimes(1);
  });

  it('returns approved status after a CIBA device decision', async () => {
    const { env } = createMockEnv();
    const artifact = makeArtifact();
    const request = makeRequest();
    const approval = makeApproval();

    await startApprovalCibaRequest({
      env,
      tenantId: 'tenant-a',
      artifact,
      request,
      approval,
    });

    await respondToApprovalCibaRequest({
      env,
      tenantId: 'tenant-a',
      artifactId: artifact.artifact_id,
      actorSubjectId: 'customer-1',
      authReqId: 'g1:apac:1:cba_generated',
      userCode: 'ABCD-EFGH',
      decision: 'approved',
    });

    const status = await getApprovalCibaStatus({
      env,
      tenantId: 'tenant-a',
      artifactId: artifact.artifact_id,
    });

    expect(status).not.toBeNull();
    expect(status?.status).toBe('approved');
    expect(status?.authReqId).toBe('g1:apac:1:cba_generated');
    expect(status?.decisionAt).toEqual(expect.any(Number));
  });

  it('rejects mismatched CIBA verification codes', async () => {
    const { env } = createMockEnv();
    const artifact = makeArtifact();
    const request = makeRequest();
    const approval = makeApproval();

    await startApprovalCibaRequest({
      env,
      tenantId: 'tenant-a',
      artifact,
      request,
      approval,
    });

    await expect(
      respondToApprovalCibaRequest({
        env,
        tenantId: 'tenant-a',
        artifactId: artifact.artifact_id,
        actorSubjectId: 'customer-1',
        authReqId: 'g1:apac:1:cba_generated',
        userCode: 'WRONG-CODE',
        decision: 'approved',
      })
    ).rejects.toThrow('Invalid approval CIBA verification code');
  });
});
