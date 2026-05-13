import type { ApprovalRequest, ElevationGrant } from '@authrim/ar-lib-core';
import { getProductProtectedResourceDefinition } from '@authrim/ar-lib-core';

export interface ApprovalGrantIntegrationHint {
  token_endpoint: string;
  introspection_endpoint: string;
  target_audience: string | null;
  resource_class: string;
  resource_ids: string[];
  detail_classes: string[];
  requires_online_check: boolean;
  fail_closed: boolean;
  subject_token_client_id: string;
  authorization_defaults: {
    expected_audience: string | null;
    required_resource_class: string;
    required_resource_ids: string[];
    required_detail_classes: string[];
    require_full_access: boolean;
  };
  service_sdk: {
    exchange_helper: 'exchangeAndEvaluateDownstreamGrant';
    resource_fetch_helper: 'fetchProtectedResourceWithDownstreamGrant';
    projection_helper: 'projectDownstreamGrantProtectedResource';
    introspection_mode: 'if_required' | 'always';
    authorizer_factory: 'createDownstreamGrantServiceAuthorizer';
    middleware: 'downstreamGrantMiddleware';
    protected_resource_middleware: 'createDownstreamGrantProtectedResourceMiddleware';
  };
  product_route?: {
    service_package: string;
    path_template: string;
    default_audience: string;
  } | null;
}

export function buildApprovalGrantIntegrationHint(input: {
  issuer: string;
  clientId: string;
  request: Pick<ApprovalRequest, 'scope_json' | 'partial_access_allowed'>;
  grant: Pick<ElevationGrant, 'redaction_level' | 'resource_class' | 'target_audience'>;
}): ApprovalGrantIntegrationHint {
  const resourceIds = Array.isArray(input.request.scope_json?.resource_ids)
    ? input.request.scope_json.resource_ids.filter(
        (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
      )
    : [];
  const detailClasses = Array.isArray(input.request.scope_json?.detail_classes)
    ? input.request.scope_json.detail_classes.filter(
        (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
      )
    : [];
  const requiresOnlineCheck = input.grant.redaction_level === 'raw';
  const productRoute = getProductProtectedResourceDefinition(input.grant.resource_class);
  const targetAudience =
    (typeof input.request.scope_json?.audience === 'string' &&
    input.request.scope_json.audience.trim().length > 0
      ? input.request.scope_json.audience.trim()
      : null) ??
    productRoute?.defaultAudience ??
    input.grant.target_audience ??
    null;

  return {
    token_endpoint: `${input.issuer}/token`,
    introspection_endpoint: `${input.issuer}/introspect`,
    target_audience: targetAudience,
    resource_class: input.grant.resource_class,
    resource_ids: resourceIds,
    detail_classes: detailClasses,
    requires_online_check: requiresOnlineCheck,
    fail_closed: requiresOnlineCheck,
    subject_token_client_id: input.clientId,
    authorization_defaults: {
      expected_audience: targetAudience,
      required_resource_class: input.grant.resource_class,
      required_resource_ids: resourceIds,
      required_detail_classes: detailClasses,
      require_full_access: !input.request.partial_access_allowed,
    },
    service_sdk: {
      exchange_helper: 'exchangeAndEvaluateDownstreamGrant',
      resource_fetch_helper: 'fetchProtectedResourceWithDownstreamGrant',
      projection_helper: 'projectDownstreamGrantProtectedResource',
      introspection_mode: requiresOnlineCheck ? 'always' : 'if_required',
      authorizer_factory: 'createDownstreamGrantServiceAuthorizer',
      middleware: 'downstreamGrantMiddleware',
      protected_resource_middleware: 'createDownstreamGrantProtectedResourceMiddleware',
    },
    product_route: productRoute
      ? {
          service_package: productRoute.servicePackage,
          path_template: productRoute.routePathTemplate,
          default_audience: productRoute.defaultAudience,
        }
      : null,
  };
}
