import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestRepository, ElevationGrantRepository } from '../../repositories/admin/admin-approval-request';
import { MockDatabaseAdapter } from '../../repositories/__tests__/mock-adapter';
import { canonicalizeApprovalScope, generateInvestigationId } from '../approval-governance';
import {
  authorizeDownstreamGrantServiceAccess,
  buildDownstreamGrantEnforcementProfile,
  buildDownstreamGrantAuthorizationDetail,
  buildDownstreamGrantDeniedPayload,
  createDownstreamGrantServiceAuthorizer,
  downstreamGrantMiddleware,
  DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
  extractDownstreamGrantDecisionContext,
  extractDownstreamGrantTokenFromAuthorizationHeader,
  evaluateDownstreamGrantServiceAuthorizationHeader,
  evaluateDownstreamGrantServiceAuthorizationHeaderWithVerifier,
  extractDownstreamGrantDecisionContextFromIntrospection,
  evaluateDownstreamGrantServiceIntrospection,
  evaluateDownstreamGrantServiceJwt,
  getDownstreamGrantMiddlewareContext,
  isElevationGrantSubjectTokenType,
  resolveElevationGrantSubjectToken,
  resolveDownstreamGrantServiceDecisionFromAuthorizationHeader,
  resolveDownstreamGrantServiceDecision,
  resolveDownstreamGrantServiceDecisionFromIntrospection,
  shouldFailClosedForDownstreamGrant,
  shouldRequireDownstreamOnlineCheck,
  ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
} from '../downstream-elevation-grant';

let adapter: MockDatabaseAdapter;
let requestRepo: ApprovalRequestRepository;
let grantRepo: ElevationGrantRepository;

beforeEach(() => {
  adapter = new MockDatabaseAdapter();
  adapter.initTable('approval_requests');
  adapter.initTable('elevation_grants');
  requestRepo = new ApprovalRequestRepository(adapter);
  grantRepo = new ElevationGrantRepository(adapter);
});

function createTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('downstream elevation grant helpers', () => {
  it('builds canonical downstream authorization detail', async () => {
    const scope = canonicalizeApprovalScope({
      surface: 'service_data',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'customer_profile',
      resource_ids: ['user-1'],
      detail_classes: ['profile_export'],
      dataset: 'profiles',
      audience: 'svc://customer-portal',
      redaction_level: 'raw',
    });

    const request = await requestRepo.createApprovalRequest({
      tenant_id: 'tenant-a',
      investigation_id: generateInvestigationId(),
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'service_data',
      requested_action: 'detail_read',
      redaction_level: 'raw',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      reason_code: 'technical_debug',
      policy_preset: 'technical_debug_default',
      expires_at: Date.now() + 10 * 60 * 1000,
      ticket_reference: {
        system: 'jira',
        id: 'OPS-101',
      },
    });

    const grant = await grantRepo.createElevationGrant({
      approval_request_id: request.id,
      tenant_id: 'tenant-a',
      target_audience: 'svc://customer-portal',
      resource_class: 'customer_profile',
      redaction_level: 'raw',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      actor_subject_type: 'admin_user',
      actor_subject_id: 'admin-1',
      expires_at: Date.now() + 5 * 60 * 1000,
    });

    const detail = buildDownstreamGrantAuthorizationDetail(request, grant);
    expect(detail.type).toBe(DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE);
    expect(detail.grant_id).toBe(grant.public_grant_id);
    expect(detail.request_id).toBe(request.public_request_id);
    expect(detail.target_subject_id).toBe('user-1');
    expect(detail.resource_ids).toEqual(['user-1']);
    expect(detail.detail_classes).toEqual(['profile_export']);
    expect(detail.audience).toBe('svc://customer-portal');
  });

  it('resolves active elevation grant subject token payloads', async () => {
    const scope = canonicalizeApprovalScope({
      surface: 'service_data',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'customer_profile',
      resource_ids: ['user-1'],
      detail_classes: ['profile_export'],
      audience: 'svc://customer-portal',
      redaction_level: 'raw',
    });

    const request = await requestRepo.createApprovalRequest({
      tenant_id: 'tenant-a',
      investigation_id: generateInvestigationId(),
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_subject_type: 'user',
      target_subject_id: 'user-1',
      request_surface: 'service_data',
      requested_action: 'detail_read',
      redaction_level: 'raw',
      status: 'approved',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      reason_code: 'technical_debug',
      policy_preset: 'technical_debug_default',
      expires_at: Date.now() + 10 * 60 * 1000,
    });

    const grant = await grantRepo.createElevationGrant({
      approval_request_id: request.id,
      tenant_id: 'tenant-a',
      target_audience: 'svc://customer-portal',
      resource_class: 'customer_profile',
      redaction_level: 'raw',
      scope_json: scope.normalized,
      scope_canonical: scope.canonical,
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      actor_subject_type: 'admin_user',
      actor_subject_id: 'admin-1',
      expires_at: Date.now() + 5 * 60 * 1000,
    });

    const resolved = await resolveElevationGrantSubjectToken({
      adapter,
      tenantId: 'tenant-a',
      requestingClientId: 'svc-client-1',
      tokenPayload: {
        iss: 'https://issuer.example.com',
        sub: 'user-1',
        aud: ['svc-client-1'],
        token_use: 'elevation_grant_subject',
        authrim_elevation: {
          grant_id: grant.public_grant_id,
          request_id: request.public_request_id,
        },
      },
    });

    expect(resolved.grant.public_grant_id).toBe(grant.public_grant_id);
    expect(resolved.request.public_request_id).toBe(request.public_request_id);
    expect(resolved.authorizationDetails[0]?.type).toBe(DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE);
    expect(resolved.actClaim.sub).toBe('admin_user:admin-1');
    expect(resolved.targetSubject.id).toBe('user-1');
  });

  it('extracts downstream decision context from access token claims', () => {
    const payload = {
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_1',
          request_id: 'apr_public_1',
          investigation_id: 'inv_123',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-1'],
          detail_classes: ['profile_export'],
          dataset: 'profiles',
          audience: 'svc://customer-portal',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
      act: {
        sub: 'admin_user:admin-1',
        client_id: 'svc-client-1',
      },
    };

    const context = extractDownstreamGrantDecisionContext(payload);
    expect(context).not.toBeNull();
    expect(context?.grantId).toBe('egr_public_1');
    expect(context?.requestId).toBe('apr_public_1');
    expect(context?.actorSubject).toBe('admin_user:admin-1');
    expect(context?.detailClasses).toEqual(['profile_export']);
    expect(context?.redactionLevel).toBe('masked');
  });

  it('extracts downstream decision context from introspection responses', () => {
    const context = extractDownstreamGrantDecisionContextFromIntrospection({
      active: true,
      sub: 'user-1',
      act: {
        sub: 'admin_user:admin-1',
        client_id: 'svc-client-1',
      },
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_2',
          request_id: 'apr_public_2',
          investigation_id: 'inv_456',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-2'],
          detail_classes: ['profile_export'],
          dataset: 'profiles',
          audience: 'svc://customer-portal',
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-2',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
      authrim_elevation: {
        grant_id: 'egr_public_2',
        request_id: 'apr_public_2',
        investigation_id: 'inv_456',
        target_subject_type: 'user',
        target_subject_id: 'user-2',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        resource_class: 'customer_profile',
        redaction_level: 'raw',
        target_audience: 'svc://customer-portal',
        scope: {
          audience: 'svc://customer-portal',
          dataset: 'profiles',
          resource_ids: ['user-2'],
          detail_classes: ['profile_export'],
          partial_access_allowed: false,
        },
      },
    });

    expect(context).not.toBeNull();
    expect(context?.grantId).toBe('egr_public_2');
    expect(context?.requestId).toBe('apr_public_2');
    expect(context?.investigationId).toBe('inv_456');
    expect(context?.resourceIds).toEqual(['user-2']);
    expect(context?.detailClasses).toEqual(['profile_export']);
    expect(context?.audience).toBe('svc://customer-portal');
    expect(context?.actorClientId).toBe('svc-client-1');
  });

  it('falls back to authrim_elevation scope when authorization details are omitted', () => {
    const context = extractDownstreamGrantDecisionContextFromIntrospection({
      active: true,
      authrim_elevation: {
        grant_id: 'egr_public_3',
        request_id: 'apr_public_3',
        investigation_id: 'inv_789',
        target_subject_type: 'user',
        target_subject_id: 'user-3',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-2',
        resource_class: 'customer_profile',
        redaction_level: 'masked',
        target_audience: 'svc://customer-portal',
        scope: {
          audience: 'svc://customer-portal',
          dataset: 'profiles',
          resource_ids: ['user-3'],
          detail_classes: ['profile_export'],
          partial_access_allowed: true,
        },
      },
    });

    expect(context).not.toBeNull();
    expect(context?.grantId).toBe('egr_public_3');
    expect(context?.resourceIds).toEqual(['user-3']);
    expect(context?.detailClasses).toEqual(['profile_export']);
    expect(context?.dataset).toBe('profiles');
    expect(context?.partialAccessAllowed).toBe(true);
  });

  it('builds a fail-closed enforcement profile for high-risk raw detail access', () => {
    const context = extractDownstreamGrantDecisionContext({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_4',
          request_id: 'apr_public_4',
          investigation_id: 'inv_high',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-4'],
          detail_classes: ['profile_export'],
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-4',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-9',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    expect(context).not.toBeNull();
    expect(buildDownstreamGrantEnforcementProfile(context!)).toEqual({
      riskLevel: 'high',
      verificationMode: 'online_check_required',
      cacheMode: 'no_cache',
      failureMode: 'fail_closed',
    });
  });

  it('builds a cacheable enforcement profile for masked detail access', () => {
    const context = extractDownstreamGrantDecisionContext({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_5',
          request_id: 'apr_public_5',
          investigation_id: 'inv_low',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-5'],
          detail_classes: ['profile_export'],
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-5',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-10',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    expect(context).not.toBeNull();
    expect(buildDownstreamGrantEnforcementProfile(context!)).toEqual({
      riskLevel: 'standard',
      verificationMode: 'offline_ok',
      cacheMode: 'short_ttl',
      failureMode: 'policy_controlled',
    });
  });

  it('resolves a service decision from JWT claims', () => {
    const decision = resolveDownstreamGrantServiceDecision({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_6',
          request_id: 'apr_public_6',
          investigation_id: 'inv_service_jwt',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-6'],
          detail_classes: ['profile_export'],
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-6',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-11',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    expect(decision).not.toBeNull();
    expect(decision?.source).toBe('jwt');
    expect(decision?.context.grantId).toBe('egr_public_6');
    expect(decision?.enforcement.verificationMode).toBe('offline_ok');
  });

  it('extracts bearer tokens from Authorization headers', () => {
    expect(extractDownstreamGrantTokenFromAuthorizationHeader('Bearer token-1')).toBe('token-1');
    expect(extractDownstreamGrantTokenFromAuthorizationHeader('DPoP token-2')).toBe('token-2');
    expect(extractDownstreamGrantTokenFromAuthorizationHeader('Basic abc123')).toBeNull();
    expect(extractDownstreamGrantTokenFromAuthorizationHeader(null)).toBeNull();
  });

  it('resolves a service decision directly from an Authorization header', () => {
    const token = createTestJwt({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_header_1',
          request_id: 'apr_public_header_1',
          investigation_id: 'inv_service_header',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-header-1'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-header-1',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-16',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
      act: {
        sub: 'admin_user:admin-16',
        client_id: 'svc-client-1',
      },
    });

    const decision = resolveDownstreamGrantServiceDecisionFromAuthorizationHeader(
      `Bearer ${token}`
    );

    expect(decision).not.toBeNull();
    expect(decision?.source).toBe('jwt');
    expect(decision?.context.grantId).toBe('egr_public_header_1');
  });

  it('resolves a service decision from introspection responses', () => {
    const decision = resolveDownstreamGrantServiceDecisionFromIntrospection({
      active: true,
      authrim_elevation: {
        grant_id: 'egr_public_7',
        request_id: 'apr_public_7',
        investigation_id: 'inv_service_introspection',
        target_subject_type: 'user',
        target_subject_id: 'user-7',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-12',
        resource_class: 'customer_profile',
        redaction_level: 'raw',
        target_audience: 'svc://customer-portal',
        scope: {
          audience: 'svc://customer-portal',
          dataset: 'profiles',
          resource_ids: ['user-7'],
          detail_classes: ['profile_export'],
          partial_access_allowed: false,
        },
      },
    });

    expect(decision).not.toBeNull();
    expect(decision?.source).toBe('introspection');
    expect(decision?.context.grantId).toBe('egr_public_7');
    expect(decision?.enforcement.verificationMode).toBe('online_check_required');
  });

  it('marks high-risk grants for online check and fail-closed handling', () => {
    const decision = resolveDownstreamGrantServiceDecisionFromIntrospection({
      active: true,
      authrim_elevation: {
        grant_id: 'egr_public_8',
        request_id: 'apr_public_8',
        investigation_id: 'inv_high_risk',
        target_subject_type: 'user',
        target_subject_id: 'user-8',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-13',
        resource_class: 'customer_profile',
        redaction_level: 'raw',
        scope: {
          resource_ids: ['user-8'],
          detail_classes: ['profile_export'],
        },
      },
    });

    expect(decision).not.toBeNull();
    expect(shouldRequireDownstreamOnlineCheck(decision!.enforcement)).toBe(true);
    expect(shouldFailClosedForDownstreamGrant(decision!.enforcement)).toBe(true);
    expect(shouldRequireDownstreamOnlineCheck(decision!.context)).toBe(true);
    expect(shouldFailClosedForDownstreamGrant(decision!.context)).toBe(true);
  });

  it('authorizes service access when the downstream grant scope matches', () => {
    const decision = resolveDownstreamGrantServiceDecision({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_9',
          request_id: 'apr_public_9',
          investigation_id: 'inv_authorize',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-9'],
          detail_classes: ['profile_export'],
          dataset: 'profiles',
          audience: 'svc://customer-portal',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-9',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-14',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
      act: {
        sub: 'admin_user:admin-14',
        client_id: 'svc-client-1',
      },
    });

    const result = authorizeDownstreamGrantServiceAccess({
      decision,
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      requiredResourceId: 'user-9',
      requiredDetailClass: 'profile_export',
      localAuthorization: {
        allowed: true,
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBeNull();
    expect(result.correlationId).toBe('inv_authorize');
    expect(result.redactionLevel).toBe('masked');
  });

  it('authorizes and rejects array-based downstream grant scope requirements', () => {
    const decision = resolveDownstreamGrantServiceDecision({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_array',
          request_id: 'apr_public_array',
          investigation_id: 'inv_array_scope',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-1', 'user-2'],
          detail_classes: ['profile_export', 'audit_detail'],
          audience: 'svc://customer-portal',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    const allowed = authorizeDownstreamGrantServiceAccess({
      decision,
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      requiredResourceIds: ['user-1', 'user-2'],
      requiredDetailClasses: ['profile_export', 'audit_detail'],
    });

    expect(allowed.allowed).toBe(true);

    const denied = authorizeDownstreamGrantServiceAccess({
      decision,
      expectedAudience: 'svc://customer-portal',
      requiredResourceIds: ['user-1', 'user-3'],
    });

    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe('grant_resource_scope_mismatch');
  });

  it('denies service access when the service local authorization rejects it', () => {
    const decision = resolveDownstreamGrantServiceDecision({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_10',
          request_id: 'apr_public_10',
          investigation_id: 'inv_local_deny',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-10'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-10',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-15',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    const result = authorizeDownstreamGrantServiceAccess({
      decision,
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      localAuthorization: {
        allowed: false,
        reasonCode: 'local_ownership_mismatch',
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('local_ownership_mismatch');
    expect(result.redactionLevel).toBe('raw');
    expect(result.enforcement?.failureMode).toBe('fail_closed');
  });

  it('evaluates JWT-backed service access in one step', () => {
    const result = evaluateDownstreamGrantServiceJwt({
      tokenPayload: {
        authorization_details: [
          {
            type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
            grant_id: 'egr_public_11',
            request_id: 'apr_public_11',
            investigation_id: 'inv_eval_jwt',
            request_surface: 'service_data',
            requested_action: 'detail_read',
            resource_class: 'customer_profile',
            resource_ids: ['user-11'],
            detail_classes: ['profile_export'],
            audience: 'svc://customer-portal',
            redaction_level: 'masked',
            target_subject_type: 'user',
            target_subject_id: 'user-11',
            requester_subject_type: 'admin_user',
            requester_subject_id: 'admin-16',
            policy_preset: 'support_case_default',
            reuse_scope: 'request',
            partial_access_allowed: false,
          },
        ],
      },
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      requiredResourceId: 'user-11',
      localAuthorization: {
        allowed: true,
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.decision?.source).toBe('jwt');
    expect(result.requiresOnlineCheck).toBe(false);
    expect(result.failClosed).toBe(false);
  });

  it('evaluates downstream grant access directly from an Authorization header', () => {
    const token = createTestJwt({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_header_2',
          request_id: 'apr_public_header_2',
          investigation_id: 'inv_service_header_eval',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-header-2'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-header-2',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-17',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    const result = evaluateDownstreamGrantServiceAuthorizationHeader({
      authorizationHeader: `Bearer ${token}`,
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      requiredResourceId: 'user-header-2',
      requiredDetailClass: 'profile_export',
      localAuthorization: { allowed: true },
    });

    expect(result.allowed).toBe(true);
    expect(result.decision?.context.grantId).toBe('egr_public_header_2');
    expect(result.requiresOnlineCheck).toBe(false);
  });

  it('evaluates Authorization headers with an explicit verifier', async () => {
    const verifier = vi.fn().mockResolvedValue({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_header_3',
          request_id: 'apr_public_header_3',
          investigation_id: 'inv_service_header_verify',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-header-3'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-header-3',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-18',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    const result = await evaluateDownstreamGrantServiceAuthorizationHeaderWithVerifier({
      authorizationHeader: 'Bearer verified-token',
      verifyToken: verifier,
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      requiredResourceId: 'user-header-3',
      requiredDetailClass: 'profile_export',
      localAuthorization: { allowed: true },
    });

    expect(verifier).toHaveBeenCalledWith('verified-token');
    expect(result.allowed).toBe(true);
    expect(result.requiresOnlineCheck).toBe(true);
    expect(result.failClosed).toBe(true);
  });

  it('evaluates introspection-backed service access and preserves fail-closed policy', () => {
    const result = evaluateDownstreamGrantServiceIntrospection({
      response: {
        active: true,
        authrim_elevation: {
          grant_id: 'egr_public_12',
          request_id: 'apr_public_12',
          investigation_id: 'inv_eval_introspection',
          target_subject_type: 'user',
          target_subject_id: 'user-12',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-17',
          resource_class: 'customer_profile',
          redaction_level: 'raw',
          target_audience: 'svc://customer-portal',
          scope: {
            audience: 'svc://customer-portal',
            resource_ids: ['user-12'],
            detail_classes: ['profile_export'],
            partial_access_allowed: false,
          },
        },
      },
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      localAuthorization: {
        allowed: false,
        reasonCode: 'local_ownership_mismatch',
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.decision?.source).toBe('introspection');
    expect(result.reasonCode).toBe('local_ownership_mismatch');
    expect(result.requiresOnlineCheck).toBe(true);
    expect(result.failClosed).toBe(true);
  });

  it('creates a reusable service authorizer with request-level overrides', async () => {
    const authorizer = createDownstreamGrantServiceAuthorizer({
      expectedAudience: 'svc://customer-portal',
      requiredResourceClass: 'customer_profile',
      requiredDetailClass: 'profile_export',
      localAuthorization: { allowed: true },
    });

    const offlineResult = authorizer.fromAuthorizationHeader({
      authorizationHeader: `Bearer ${createTestJwt({
        authorization_details: [
          {
            type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
            grant_id: 'egr_public_authorizer_1',
            request_id: 'apr_public_authorizer_1',
            investigation_id: 'inv_authorizer_1',
            request_surface: 'service_data',
            requested_action: 'detail_read',
            resource_class: 'customer_profile',
            resource_ids: ['user-authorizer-1'],
            detail_classes: ['profile_export'],
            audience: 'svc://customer-portal',
            redaction_level: 'masked',
            target_subject_type: 'user',
            target_subject_id: 'user-authorizer-1',
            requester_subject_type: 'admin_user',
            requester_subject_id: 'admin-20',
            policy_preset: 'support_case_default',
            reuse_scope: 'request',
            partial_access_allowed: false,
          },
        ],
      })}`,
      override: {
        requiredResourceId: 'user-authorizer-1',
      },
    });

    expect(offlineResult.allowed).toBe(true);
    expect(offlineResult.requiresOnlineCheck).toBe(false);

    const verifier = vi.fn().mockResolvedValue({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_authorizer_2',
          request_id: 'apr_public_authorizer_2',
          investigation_id: 'inv_authorizer_2',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-authorizer-2'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-authorizer-2',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-21',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    });

    const verifiedResult = await authorizer.fromAuthorizationHeaderWithVerifier({
      authorizationHeader: 'Bearer authorizer-token',
      verifyToken: verifier,
      override: {
        requiredResourceId: 'user-authorizer-2',
      },
    });

    expect(verifier).toHaveBeenCalledWith('authorizer-token');
    expect(verifiedResult.allowed).toBe(true);
    expect(verifiedResult.requiresOnlineCheck).toBe(true);
    expect(verifiedResult.failClosed).toBe(true);
  });

  it('recognizes the custom subject token type', () => {
    expect(isElevationGrantSubjectTokenType(ELEVATION_GRANT_SUBJECT_TOKEN_TYPE)).toBe(true);
    expect(isElevationGrantSubjectTokenType('urn:ietf:params:oauth:token-type:access_token')).toBe(
      false
    );
  });

  it('authorizes a low-risk service request through Hono middleware with offline verification', async () => {
    const verifyToken = vi.fn(async () => ({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_mw_1',
          request_id: 'apr_public_mw_1',
          investigation_id: 'inv_mw_1',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-1'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-1',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    }));

    const app = new Hono();
    app.use(
      '/resource/:id',
      downstreamGrantMiddleware({
        authorizer: createDownstreamGrantServiceAuthorizer({
          expectedAudience: 'svc://customer-portal',
          requiredResourceClass: 'customer_profile',
          requiredDetailClass: 'profile_export',
        }),
        verifyToken,
        resolveOverride: (c) => ({
          requiredResourceId: c.req.param('id'),
        }),
      })
    );
    app.get('/resource/:id', (c) => {
      const context = getDownstreamGrantMiddlewareContext(c);
      return c.json({
        allowed: true,
        investigation_id: context?.authorization.correlationId,
      });
    });

    const res = await app.request('/resource/user-1', {
      headers: {
        Authorization: `Bearer ${createTestJwt({ sub: 'ignored' })}`,
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      allowed: true,
      investigation_id: 'inv_mw_1',
    });
    expect(verifyToken).toHaveBeenCalledTimes(1);
  });

  it('requires online introspection for high-risk raw grants in Hono middleware', async () => {
    const verifyToken = vi.fn(async () => ({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_mw_2',
          request_id: 'apr_public_mw_2',
          investigation_id: 'inv_mw_2',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-2'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-2',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    }));
    const introspectToken = vi.fn(async () => ({
      active: true,
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_mw_2',
          request_id: 'apr_public_mw_2',
          investigation_id: 'inv_mw_2',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-2'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-2',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    }));

    const app = new Hono();
    app.use(
      '/resource/:id',
      downstreamGrantMiddleware({
        authorizer: createDownstreamGrantServiceAuthorizer({
          expectedAudience: 'svc://customer-portal',
          requiredResourceClass: 'customer_profile',
          requiredDetailClass: 'profile_export',
        }),
        verifyToken,
        introspectToken,
        resolveOverride: (c) => ({
          requiredResourceId: c.req.param('id'),
        }),
      })
    );
    app.get('/resource/:id', (c) => c.json({ ok: true }));

    const res = await app.request('/resource/user-2', {
      headers: {
        Authorization: `Bearer ${createTestJwt({ sub: 'ignored' })}`,
      },
    });

    expect(res.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(introspectToken).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a high-risk grant cannot be online checked', async () => {
    const verifyToken = vi.fn(async () => ({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_mw_3',
          request_id: 'apr_public_mw_3',
          investigation_id: 'inv_mw_3',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-3'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'raw',
          target_subject_type: 'user',
          target_subject_id: 'user-3',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'technical_debug_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    }));

    const app = new Hono();
    app.use(
      '/resource/:id',
      downstreamGrantMiddleware({
        authorizer: createDownstreamGrantServiceAuthorizer({
          expectedAudience: 'svc://customer-portal',
          requiredResourceClass: 'customer_profile',
          requiredDetailClass: 'profile_export',
        }),
        verifyToken,
        resolveOverride: (c) => ({
          requiredResourceId: c.req.param('id'),
        }),
      })
    );
    app.get('/resource/:id', (c) => c.json({ ok: true }));

    const res = await app.request('/resource/user-3', {
      headers: {
        Authorization: `Bearer ${createTestJwt({ sub: 'ignored' })}`,
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      reason_code: 'grant_online_check_required',
      fail_closed: true,
    });
  });

  it('builds a reusable deny payload for service-side handlers', () => {
    const payload = buildDownstreamGrantDeniedPayload({
      allowed: false,
      reasonCode: 'grant_online_check_failed',
      correlationId: 'inv_service_1',
      redactionLevel: 'raw',
      context: null,
      enforcement: null,
      decision: null,
      requiresOnlineCheck: true,
      failClosed: true,
    });

    expect(payload).toEqual({
      error: 'access_denied',
      error_description: 'Downstream elevation grant authorization failed.',
      reason_code: 'grant_online_check_failed',
      correlation_id: 'inv_service_1',
      redaction_level: 'raw',
      requires_online_check: true,
      fail_closed: true,
    });
  });

  it('applies local authorization after grant evaluation in Hono middleware', async () => {
    const verifyToken = vi.fn(async () => ({
      authorization_details: [
        {
          type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
          grant_id: 'egr_public_mw_4',
          request_id: 'apr_public_mw_4',
          investigation_id: 'inv_mw_4',
          request_surface: 'service_data',
          requested_action: 'detail_read',
          resource_class: 'customer_profile',
          resource_ids: ['user-4'],
          detail_classes: ['profile_export'],
          audience: 'svc://customer-portal',
          redaction_level: 'masked',
          target_subject_type: 'user',
          target_subject_id: 'user-4',
          requester_subject_type: 'admin_user',
          requester_subject_id: 'admin-1',
          policy_preset: 'support_case_default',
          reuse_scope: 'request',
          partial_access_allowed: false,
        },
      ],
    }));

    const app = new Hono();
    app.use(
      '/resource/:id',
      downstreamGrantMiddleware({
        authorizer: createDownstreamGrantServiceAuthorizer({
          expectedAudience: 'svc://customer-portal',
          requiredResourceClass: 'customer_profile',
          requiredDetailClass: 'profile_export',
        }),
        verifyToken,
        resolveOverride: (c) => ({
          requiredResourceId: c.req.param('id'),
        }),
        resolveLocalAuthorization: async () => ({
          allowed: false,
          reasonCode: 'service_acl_denied',
        }),
      })
    );
    app.get('/resource/:id', (c) => c.json({ ok: true }));

    const res = await app.request('/resource/user-4', {
      headers: {
        Authorization: `Bearer ${createTestJwt({ sub: 'ignored' })}`,
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'access_denied',
      reason_code: 'service_acl_denied',
      correlation_id: 'inv_mw_4',
    });
  });
});
