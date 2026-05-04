import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
  ElevationGrantRepository,
} from '../admin/admin-approval-request';
import { MockDatabaseAdapter } from './mock-adapter';
import { canonicalizeApprovalScope, generateInvestigationId } from '../../services/approval-governance';

let adapter: MockDatabaseAdapter;
let requestRepo: ApprovalRequestRepository;
let approvalRepo: ApprovalRequestApprovalRepository;
let grantRepo: ElevationGrantRepository;

beforeEach(() => {
  adapter = new MockDatabaseAdapter();
  adapter.initTable('approval_requests');
  adapter.initTable('approval_request_approvals');
  adapter.initTable('elevation_grants');
  requestRepo = new ApprovalRequestRepository(adapter);
  approvalRepo = new ApprovalRequestApprovalRepository(adapter);
  grantRepo = new ElevationGrantRepository(adapter);
});

describe('Approval / Elevation repositories', () => {
  it('creates approval requests with canonical scope and structured references', async () => {
    const scope = canonicalizeApprovalScope({
      surface: 'admin_audit_detail',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'admin_audit_detail',
      resource_ids: ['audit-1'],
      redaction_level: 'masked',
    });

    const request = await requestRepo.createApprovalRequest({
      tenant_id: 'tenant-a',
      investigation_id: generateInvestigationId(),
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'artifact',
      target_subject_id: 'audit-1',
      request_surface: 'admin_audit_detail',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      reason_code: 'support_case',
      reason_note: 'Need to review audit detail',
      reference: {
        system: 'support_case',
        id: 'CASE-123',
        url: 'https://example.test/case/CASE-123',
      },
      ticket_reference: {
        system: 'jira',
        id: 'OPS-9',
      },
      policy_preset: 'support_case_default',
      expires_at: Date.now() + 10 * 60 * 1000,
    });

    expect(request.public_request_id).toMatch(/^apr_/);
    expect(request.scope_canonical).toBe(scope.canonical);
    expect(request.reference?.system).toBe('support_case');
    expect(request.ticket_reference?.id).toBe('OPS-9');
    expect(request.partial_access_allowed).toBe(false);
  });

  it('stores approval steps and allows partially-approved transitions', async () => {
    const scope = canonicalizeApprovalScope({
      surface: 'webhook_payload',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'webhook_delivery',
      resource_ids: ['delivery-1'],
    });

    const request = await requestRepo.createApprovalRequest({
      tenant_id: 'tenant-a',
      investigation_id: generateInvestigationId(),
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'artifact',
      target_subject_id: 'delivery-1',
      request_surface: 'webhook_payload',
      requested_action: 'detail_read',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      reason_code: 'technical_debug',
      policy_preset: 'support_case_default',
      expires_at: Date.now() + 15 * 60 * 1000,
    });

    const adminStep = await approvalRepo.createApproval({
      approval_request_id: request.id,
      step_key: 'admin-operator',
      side: 'admin_operator',
      subject_type: 'admin_user',
      subject_id: 'admin-approver-1',
      expires_at: request.expires_at,
    });
    await approvalRepo.createApproval({
      approval_request_id: request.id,
      step_key: 'customer-owner',
      side: 'customer_data_owner',
      subject_type: 'customer_delegate',
      subject_id: 'customer-1',
      expires_at: request.expires_at,
      relation_source: 'rebac_relation',
    });

    const updatedStep = await approvalRepo.updateApproval(adminStep.id, {
      status: 'approved',
      method: 'ciba',
      transport_channel: 'email',
      decided_at: Date.now(),
    });
    const updatedRequest = await requestRepo.updateApprovalRequestStatus(
      request.id,
      'partially_approved'
    );

    expect(updatedStep?.status).toBe('approved');
    expect(updatedStep?.method).toBe('ciba');
    expect(updatedRequest?.status).toBe('partially_approved');
    const requestApprovals = await approvalRepo.listApprovalsForRequest(request.id);
    expect(requestApprovals).toHaveLength(2);
  });

  it('creates public elevation grant metadata for downstream access', async () => {
    const scope = canonicalizeApprovalScope({
      surface: 'service_data',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'customer_profile',
      resource_ids: ['user-1'],
      redaction_level: 'raw',
      audience: 'svc://customer-portal',
      detail_classes: ['profile_export'],
    });

    const grant = await grantRepo.createElevationGrant({
      approval_request_id: 'approval-1',
      tenant_id: 'tenant-a',
      target_audience: 'svc://customer-portal',
      resource_class: 'customer_profile',
      redaction_level: 'raw',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      authorization_details_json: {
        type: 'authrim_break_glass',
        investigation_id: 'inv_123',
        redaction_level: 'raw',
      },
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      actor_subject_type: 'admin_user',
      actor_subject_id: 'admin-1',
      expires_at: Date.now() + 5 * 60 * 1000,
    });

    expect(grant.public_grant_id).toMatch(/^egr_/);
    expect(grant.authorization_details_json).toEqual({
      type: 'authrim_break_glass',
      investigation_id: 'inv_123',
      redaction_level: 'raw',
    });

    const reloaded = await grantRepo.getElevationGrantByPublicId(grant.public_grant_id);
    expect(reloaded?.scope_canonical).toBe(scope.canonical);

    const revoked = await grantRepo.updateElevationGrantStatus(grant.id, 'revoked', {
      revokedAt: Date.now(),
      revokeReason: 'approval_cancelled',
    });
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.revoke_reason).toBe('approval_cancelled');
  });

  it('lists grants by request and active actor/resource filters', async () => {
    const scope = canonicalizeApprovalScope({
      surface: 'admin_jobs',
      action: 'artifact_read',
      tenant_id: 'tenant-a',
      resource_class: 'user_import_result',
      resource_ids: ['job-1'],
    });

    const activeGrant = await grantRepo.createElevationGrant({
      approval_request_id: 'approval-1',
      tenant_id: 'tenant-a',
      target_audience: 'admin_api',
      resource_class: 'user_import_result',
      redaction_level: 'masked',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      actor_subject_type: 'admin_user',
      actor_subject_id: 'admin-1',
      expires_at: Date.now() + 60_000,
    });
    await grantRepo.createElevationGrant({
      approval_request_id: 'approval-2',
      tenant_id: 'tenant-a',
      target_audience: 'admin_api',
      resource_class: 'user_import_result',
      redaction_level: 'masked',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-2',
      actor_subject_type: 'admin_user',
      actor_subject_id: 'admin-2',
      expires_at: Date.now() + 60_000,
    });

    const byRequest = await grantRepo.listElevationGrantsForRequest('approval-1');
    expect(byRequest).toHaveLength(1);
    expect(byRequest[0]?.public_grant_id).toBe(activeGrant.public_grant_id);

    const activeForActor = await grantRepo.listActiveElevationGrants({
      tenantId: 'tenant-a',
      actorSubjectType: 'admin_user',
      actorSubjectId: 'admin-1',
      resourceClass: 'user_import_result',
      targetAudience: 'admin_api',
    });
    expect(activeForActor).toHaveLength(1);
    expect(activeForActor[0]?.approval_request_id).toBe('approval-1');
  });

  it('updates approval request detail object catalog pointer', async () => {
    const scope = canonicalizeApprovalScope({
      surface: 'approvals',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'approval_transport_detail',
      resource_ids: ['apr_test_1'],
    });

    const request = await requestRepo.createApprovalRequest({
      tenant_id: 'tenant-a',
      investigation_id: generateInvestigationId(),
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'artifact',
      target_subject_id: 'apr_test_1',
      request_surface: 'approvals',
      requested_action: 'detail_read',
      redaction_level: 'masked',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      reason_code: 'support_case',
      policy_preset: 'support_case_default',
      expires_at: Date.now() + 60_000,
    });

    expect(request.detail_object_catalog_id).toBeNull();

    const updated = await requestRepo.updateApprovalRequestDetailObjectCatalogId(
      request.id,
      'catalog-123'
    );

    expect(updated?.detail_object_catalog_id).toBe('catalog-123');
  });
});
