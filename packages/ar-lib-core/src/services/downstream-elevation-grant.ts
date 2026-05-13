import type { Context, MiddlewareHandler, Next } from 'hono';
import type { DatabaseAdapter } from '../db/adapter';
import type { Env } from '../types/env';
import type { ActClaim, IntrospectionResponse } from '../types/oidc';
import type {
  ApprovalRequest,
  ApprovalRedactionLevel,
  ApprovalScopeDescriptor,
  ApprovalTargetSubjectType,
  ElevationGrant,
  StructuredReference,
} from '../types/approval';
import {
  ApprovalRequestRepository,
  ElevationGrantRepository,
} from '../repositories/admin/admin-approval-request';
import { createAccessToken, importPrivateKeyFromPEM } from '../utils/jwt';
import { parseToken } from '../utils/jwt';

export const ELEVATION_GRANT_SUBJECT_TOKEN_TYPE = 'urn:authrim:token-type:elevation-grant';
export const DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE = 'authrim_break_glass';
export const ELEVATION_GRANT_SUBJECT_TOKEN_USE = 'elevation_grant_subject';

const SIGNING_KEY_CACHE_TTL_MS = 30 * 60 * 1000;

const signingKeyCache = new Map<
  string,
  {
    privateKey: CryptoKey;
    kid: string;
    version: string;
    cachedAt: number;
  }
>();

export interface DownstreamGrantAuthorizationDetail {
  type: typeof DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE;
  grant_id: string;
  request_id: string;
  investigation_id: string;
  request_surface: string;
  requested_action: string;
  resource_class: string;
  resource_ids: string[];
  detail_classes: string[];
  dataset: string | null;
  audience: string | null;
  redaction_level: ApprovalRedactionLevel;
  target_subject_type: ApprovalTargetSubjectType;
  target_subject_id: string;
  requester_subject_type: ApprovalRequest['requester_subject_type'];
  requester_subject_id: string;
  ticket_reference: StructuredReference | null;
  reference: StructuredReference | null;
  policy_preset: string;
  reuse_scope: ApprovalRequest['reuse_scope'];
  partial_access_allowed: boolean;
}

export interface DownstreamGrantDecisionContext {
  grantId: string;
  requestId: string;
  investigationId: string;
  requestSurface: string;
  requestedAction: string;
  resourceClass: string;
  resourceIds: string[];
  detailClasses: string[];
  dataset: string | null;
  audience: string | null;
  redactionLevel: ApprovalRedactionLevel;
  targetSubjectType: ApprovalTargetSubjectType;
  targetSubjectId: string;
  requesterSubjectType: ApprovalRequest['requester_subject_type'];
  requesterSubjectId: string;
  ticketReference: StructuredReference | null;
  reference: StructuredReference | null;
  policyPreset: string;
  reuseScope: ApprovalRequest['reuse_scope'];
  partialAccessAllowed: boolean;
  actorSubject: string | null;
  actorClientId: string | null;
}

export type DownstreamGrantRiskLevel = 'standard' | 'high';
export type DownstreamGrantVerificationMode = 'offline_ok' | 'online_check_required';
export type DownstreamGrantCacheMode = 'short_ttl' | 'no_cache';
export type DownstreamGrantFailureMode = 'policy_controlled' | 'fail_closed';

export interface DownstreamGrantEnforcementProfile {
  riskLevel: DownstreamGrantRiskLevel;
  verificationMode: DownstreamGrantVerificationMode;
  cacheMode: DownstreamGrantCacheMode;
  failureMode: DownstreamGrantFailureMode;
}

export interface DownstreamGrantServiceDecision {
  source: 'jwt' | 'introspection';
  context: DownstreamGrantDecisionContext;
  enforcement: DownstreamGrantEnforcementProfile;
}

export type DownstreamGrantServiceDenyReason =
  | 'grant_missing'
  | 'grant_audience_mismatch'
  | 'grant_resource_class_mismatch'
  | 'grant_resource_scope_mismatch'
  | 'grant_detail_class_mismatch'
  | 'grant_partial_access_not_allowed'
  | 'local_authorization_denied';

export interface DownstreamGrantServiceAuthorizationInput {
  decision: DownstreamGrantServiceDecision | null;
  expectedAudience?: string | string[] | null;
  requiredResourceClass?: string | null;
  requiredResourceId?: string | null;
  requiredResourceIds?: string[] | null;
  requiredDetailClass?: string | null;
  requiredDetailClasses?: string[] | null;
  requireFullAccess?: boolean;
  localAuthorization?: {
    allowed: boolean;
    reasonCode?: string | null;
  } | null;
}

export interface DownstreamGrantServiceAuthorizationResult {
  allowed: boolean;
  reasonCode: DownstreamGrantServiceDenyReason | string | null;
  correlationId: string | null;
  redactionLevel: ApprovalRedactionLevel | null;
  context: DownstreamGrantDecisionContext | null;
  enforcement: DownstreamGrantEnforcementProfile | null;
}

export interface DownstreamGrantServiceEvaluationResult extends DownstreamGrantServiceAuthorizationResult {
  decision: DownstreamGrantServiceDecision | null;
  requiresOnlineCheck: boolean;
  failClosed: boolean;
}

export interface DownstreamGrantDeniedPayload {
  error: 'access_denied';
  error_description: string;
  reason_code: DownstreamGrantServiceDenyReason | string | null;
  correlation_id: string | null;
  redaction_level: ApprovalRedactionLevel | null;
  requires_online_check: boolean;
  fail_closed: boolean;
}

export interface DownstreamGrantMiddlewareContextDecision {
  decision: DownstreamGrantServiceDecision | null;
  authorization: DownstreamGrantServiceEvaluationResult;
}

type DownstreamGrantServiceEvaluationInput = Omit<
  DownstreamGrantServiceAuthorizationInput,
  'decision'
>;

type DownstreamGrantServiceAuthorizerOverride = Partial<
  Omit<DownstreamGrantServiceEvaluationInput, 'localAuthorization'>
> & {
  localAuthorization?: DownstreamGrantServiceAuthorizationInput['localAuthorization'];
};

export interface DownstreamGrantServiceAuthorizer {
  defaults: DownstreamGrantServiceEvaluationInput;
  fromAuthorizationHeader(input: {
    authorizationHeader: string | null | undefined;
    override?: DownstreamGrantServiceAuthorizerOverride;
  }): DownstreamGrantServiceEvaluationResult;
  fromAuthorizationHeaderWithVerifier(input: {
    authorizationHeader: string | null | undefined;
    verifyToken: DownstreamGrantTokenVerifier;
    override?: DownstreamGrantServiceAuthorizerOverride;
  }): Promise<DownstreamGrantServiceEvaluationResult>;
  fromIntrospection(input: {
    response: IntrospectionResponse;
    override?: DownstreamGrantServiceAuthorizerOverride;
  }): DownstreamGrantServiceEvaluationResult;
  fromJwt(input: {
    tokenPayload: JwtLikePayload;
    override?: DownstreamGrantServiceAuthorizerOverride;
  }): DownstreamGrantServiceEvaluationResult;
}

export interface ElevationGrantSubjectTokenIssueResult {
  subjectToken: string;
  subjectTokenType: typeof ELEVATION_GRANT_SUBJECT_TOKEN_TYPE;
  expiresIn: number;
  authorizationDetails: DownstreamGrantAuthorizationDetail[];
  jti: string;
}

export interface ResolvedElevationGrantSubjectToken {
  grant: ElevationGrant;
  request: ApprovalRequest;
  authorizationDetails: DownstreamGrantAuthorizationDetail[];
  actClaim: ActClaim;
  targetSubject: {
    type: ApprovalTargetSubjectType;
    id: string;
  };
}

type JwtLikePayload = Record<string, unknown>;

type DownstreamGrantTokenVerifier = (token: string) => Promise<JwtLikePayload>;

export interface DownstreamGrantHonoMiddlewareOptions {
  authorizer: DownstreamGrantServiceAuthorizer;
  verifyToken?: (input: { token: string; c: Context<any, any, any> }) => Promise<JwtLikePayload>;
  introspectToken?: (input: {
    token: string;
    c: Context<any, any, any>;
  }) => Promise<IntrospectionResponse>;
  resolveOverride?: (
    c: Context<any, any, any>
  ) =>
    | Promise<DownstreamGrantServiceAuthorizerOverride | undefined | null>
    | DownstreamGrantServiceAuthorizerOverride
    | undefined
    | null;
  resolveLocalAuthorization?: (input: {
    c: Context<any, any, any>;
    decision: DownstreamGrantServiceDecision;
  }) =>
    | Promise<DownstreamGrantServiceAuthorizationInput['localAuthorization']>
    | DownstreamGrantServiceAuthorizationInput['localAuthorization'];
  onDeny?: (input: {
    c: Context<any, any, any>;
    authorization: DownstreamGrantServiceEvaluationResult;
  }) => Response | Promise<Response>;
}

const DOWNSTREAM_GRANT_DECISION_CONTEXT_KEY = 'downstreamGrantDecision';

export function buildDownstreamGrantDeniedPayload(
  authorization: DownstreamGrantServiceEvaluationResult
): DownstreamGrantDeniedPayload {
  return {
    error: 'access_denied',
    error_description: 'Downstream elevation grant authorization failed.',
    reason_code: authorization.reasonCode,
    correlation_id: authorization.correlationId,
    redaction_level: authorization.redactionLevel,
    requires_online_check: authorization.requiresOnlineCheck,
    fail_closed: authorization.failClosed,
  };
}

export function createDownstreamGrantDeniedResponse(
  authorization: DownstreamGrantServiceEvaluationResult
): Response {
  return new Response(JSON.stringify(buildDownstreamGrantDeniedPayload(authorization)), {
    status: 403,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toAudienceArray(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean);
  }
  return [];
}

export function extractDownstreamGrantTokenFromAuthorizationHeader(
  authorizationHeader: string | null | undefined
): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  if (!trimmed) {
    return null;
  }

  const [scheme, token] = trimmed.split(/\s+/, 2);
  if (!scheme || !token) {
    return null;
  }

  if (scheme !== 'Bearer' && scheme !== 'DPoP') {
    return null;
  }

  return token;
}

function normalizeAuthorizationDetails(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    );
  }

  if (typeof value === 'object' && value !== null) {
    return [value as Record<string, unknown>];
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function findDownstreamGrantAuthorizationDetail(value: unknown): Record<string, unknown> | null {
  return (
    normalizeAuthorizationDetails(value).find(
      (entry) => entry.type === DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE
    ) ?? null
  );
}

async function getTenantSigningKey(
  env: Env,
  tenantId: string,
  expectedKid?: string
): Promise<{ privateKey: CryptoKey; kid: string }> {
  const now = Date.now();
  const cached = signingKeyCache.get(tenantId);

  if (cached) {
    const ttlValid = now - cached.cachedAt < SIGNING_KEY_CACHE_TTL_MS;
    const currentVersion =
      (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';

    if (expectedKid && cached.kid === expectedKid && currentVersion === cached.version) {
      return { privateKey: cached.privateKey, kid: cached.kid };
    }

    if (!expectedKid && ttlValid && currentVersion === cached.version) {
      return { privateKey: cached.privateKey, kid: cached.kid };
    }
  }

  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }
  if (!env.KEY_MANAGER_SECRET) {
    throw new Error('KEY_MANAGER_SECRET not configured');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  let keyData = await keyManager.getActiveKeyWithPrivateRpc();

  if (!keyData) {
    keyData = await keyManager.rotateKeysWithPrivateRpc();
  }

  const privateKey = await importPrivateKeyFromPEM(keyData.privatePEM);
  const version =
    (await env.AUTHRIM_CONFIG?.get(`v1:key-version:${tenantId}`).catch(() => null)) ?? '';

  signingKeyCache.set(tenantId, {
    privateKey,
    kid: keyData.kid,
    version,
    cachedAt: now,
  });

  return { privateKey, kid: keyData.kid };
}

export function buildDownstreamGrantAuthorizationDetail(
  request: ApprovalRequest,
  grant: ElevationGrant
): DownstreamGrantAuthorizationDetail {
  const scope = grant.scope_json;

  return {
    type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
    grant_id: grant.public_grant_id,
    request_id: request.public_request_id,
    investigation_id: request.investigation_id,
    request_surface: request.request_surface,
    requested_action: request.requested_action,
    resource_class: scope.resource_class,
    resource_ids: scope.resource_ids ?? [],
    detail_classes: scope.detail_classes ?? [],
    dataset: scope.dataset ?? null,
    audience: scope.audience ?? null,
    redaction_level: grant.redaction_level,
    target_subject_type: request.target_subject_type,
    target_subject_id: request.target_subject_id,
    requester_subject_type: request.requester_subject_type,
    requester_subject_id: request.requester_subject_id,
    ticket_reference: request.ticket_reference,
    reference: request.reference,
    policy_preset: request.policy_preset,
    reuse_scope: request.reuse_scope,
    partial_access_allowed: request.partial_access_allowed,
  };
}

function buildElevationGrantSubjectClaims(
  issuer: string,
  clientId: string,
  request: ApprovalRequest,
  grant: ElevationGrant
): Omit<Parameters<typeof createAccessToken>[0], 'iat' | 'exp' | 'jti'> {
  const authorizationDetails = [buildDownstreamGrantAuthorizationDetail(request, grant)];

  return {
    iss: issuer,
    sub: request.target_subject_id,
    aud: clientId,
    scope: 'openid',
    client_id: 'authrim-approval-grant',
    authorization_details: authorizationDetails,
    token_use: ELEVATION_GRANT_SUBJECT_TOKEN_USE,
    authrim_elevation: {
      grant_id: grant.public_grant_id,
      request_id: request.public_request_id,
      investigation_id: request.investigation_id,
      resource_class: grant.resource_class,
      redaction_level: grant.redaction_level,
      target_subject_type: request.target_subject_type,
      target_subject_id: request.target_subject_id,
      requester_subject_type: request.requester_subject_type,
      requester_subject_id: request.requester_subject_id,
      target_audience: grant.target_audience,
      scope: grant.scope_json,
    },
  } as Parameters<typeof createAccessToken>[0];
}

export async function createElevationGrantSubjectToken(input: {
  env: Env;
  tenantId: string;
  issuer: string;
  clientId: string;
  request: ApprovalRequest;
  grant: ElevationGrant;
  expiresInSeconds: number;
}): Promise<ElevationGrantSubjectTokenIssueResult> {
  const { env, tenantId, issuer, clientId, request, grant, expiresInSeconds } = input;
  const { privateKey, kid } = await getTenantSigningKey(env, tenantId);
  const claims = buildElevationGrantSubjectClaims(issuer, clientId, request, grant);
  const { token, jti } = await createAccessToken(claims, privateKey, kid, expiresInSeconds);

  return {
    subjectToken: token,
    subjectTokenType: ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
    expiresIn: expiresInSeconds,
    authorizationDetails: normalizeAuthorizationDetails(
      claims.authorization_details
    ) as unknown as DownstreamGrantAuthorizationDetail[],
    jti,
  };
}

export async function resolveElevationGrantSubjectToken(input: {
  adapter: DatabaseAdapter;
  tenantId: string;
  requestingClientId: string;
  tokenPayload: JwtLikePayload;
}): Promise<ResolvedElevationGrantSubjectToken> {
  const { adapter, tenantId, requestingClientId, tokenPayload } = input;
  const tokenUse = asString(tokenPayload.token_use);
  if (tokenUse !== ELEVATION_GRANT_SUBJECT_TOKEN_USE) {
    throw new Error('Subject token is not an elevation grant subject token');
  }

  const audiences = toAudienceArray(tokenPayload.aud);
  if (!audiences.includes(requestingClientId)) {
    throw new Error('Elevation grant subject token is not audience-bound to the requesting client');
  }

  const authrimElevation =
    typeof tokenPayload.authrim_elevation === 'object' && tokenPayload.authrim_elevation !== null
      ? (tokenPayload.authrim_elevation as Record<string, unknown>)
      : null;
  const fallbackAuthorizationDetail = normalizeAuthorizationDetails(
    tokenPayload.authorization_details
  )[0];
  const publicGrantId =
    asString(authrimElevation?.grant_id) ?? asString(fallbackAuthorizationDetail?.grant_id);
  const publicRequestId =
    asString(authrimElevation?.request_id) ?? asString(fallbackAuthorizationDetail?.request_id);

  if (!publicGrantId) {
    throw new Error('Elevation grant subject token is missing grant_id');
  }

  const grantRepo = new ElevationGrantRepository(adapter);
  const requestRepo = new ApprovalRequestRepository(adapter);
  const grant = await grantRepo.getElevationGrantByPublicId(publicGrantId);
  if (!grant) {
    throw new Error('Elevation grant not found');
  }
  if (grant.tenant_id !== tenantId) {
    throw new Error('Elevation grant tenant mismatch');
  }
  if (grant.status !== 'active' || grant.revoked_at || grant.expires_at <= Date.now()) {
    throw new Error('Elevation grant is inactive or expired');
  }

  const request = await requestRepo.getApprovalRequestById(grant.approval_request_id);
  if (!request) {
    throw new Error('Approval request not found');
  }
  if (request.tenant_id !== tenantId) {
    throw new Error('Approval request tenant mismatch');
  }
  if (publicRequestId && request.public_request_id !== publicRequestId) {
    throw new Error('Elevation grant request mismatch');
  }
  if (request.status !== 'approved') {
    throw new Error('Approval request is not approved');
  }
  if (request.expires_at <= Date.now()) {
    throw new Error('Approval request is expired');
  }

  const subject = asString(tokenPayload.sub);
  if (!subject || subject !== request.target_subject_id) {
    throw new Error('Subject token target subject mismatch');
  }

  return {
    grant,
    request,
    authorizationDetails: [buildDownstreamGrantAuthorizationDetail(request, grant)],
    actClaim: {
      sub: `${grant.actor_subject_type}:${grant.actor_subject_id}`,
      client_id: requestingClientId,
    },
    targetSubject: {
      type: request.target_subject_type,
      id: request.target_subject_id,
    },
  };
}

export function extractDownstreamGrantDecisionContext(
  tokenPayload: JwtLikePayload | IntrospectionResponse
): DownstreamGrantDecisionContext | null {
  const carrier = tokenPayload as Record<string, unknown>;

  if (typeof tokenPayload.active === 'boolean' && tokenPayload.active === false) {
    return null;
  }

  const detail = findDownstreamGrantAuthorizationDetail(carrier.authorization_details);
  const authrimElevation = asRecord(carrier.authrim_elevation);
  const scope = asRecord(authrimElevation?.scope);

  if (!detail && !authrimElevation) {
    return null;
  }

  const source = detail ?? authrimElevation ?? {};
  const act = asRecord(carrier.act);

  return {
    grantId: asString(source.grant_id) ?? '',
    requestId: asString(source.request_id) ?? '',
    investigationId: asString(source.investigation_id) ?? '',
    requestSurface: asString(source.request_surface) ?? '',
    requestedAction: asString(source.requested_action) ?? '',
    resourceClass: asString(source.resource_class) ?? '',
    resourceIds: Array.isArray(source.resource_ids)
      ? source.resource_ids.filter((value): value is string => typeof value === 'string')
      : Array.isArray(scope?.resource_ids)
        ? scope.resource_ids.filter((value): value is string => typeof value === 'string')
        : [],
    detailClasses: Array.isArray(source.detail_classes)
      ? source.detail_classes.filter((value): value is string => typeof value === 'string')
      : Array.isArray(scope?.detail_classes)
        ? scope.detail_classes.filter((value): value is string => typeof value === 'string')
        : [],
    dataset: asString(source.dataset) ?? asString(scope?.dataset),
    audience:
      asString(source.audience) ??
      asString(scope?.audience) ??
      asString(authrimElevation?.target_audience),
    redactionLevel: (asString(source.redaction_level) ?? 'masked') as ApprovalRedactionLevel,
    targetSubjectType: (asString(source.target_subject_type) ??
      'artifact') as ApprovalTargetSubjectType,
    targetSubjectId: asString(source.target_subject_id) ?? '',
    requesterSubjectType: (asString(source.requester_subject_type) ??
      'admin_user') as ApprovalRequest['requester_subject_type'],
    requesterSubjectId: asString(source.requester_subject_id) ?? '',
    ticketReference: asRecord(source.ticket_reference)
      ? (source.ticket_reference as StructuredReference)
      : null,
    reference: asRecord(source.reference) ? (source.reference as StructuredReference) : null,
    policyPreset: asString(source.policy_preset) ?? '',
    reuseScope: (asString(source.reuse_scope) ?? 'request') as ApprovalRequest['reuse_scope'],
    partialAccessAllowed: Boolean(source.partial_access_allowed ?? scope?.partial_access_allowed),
    actorSubject: asString(act?.sub),
    actorClientId: asString(act?.client_id),
  };
}

export function extractDownstreamGrantDecisionContextFromIntrospection(
  response: IntrospectionResponse
): DownstreamGrantDecisionContext | null {
  return extractDownstreamGrantDecisionContext(response);
}

export function buildDownstreamGrantEnforcementProfile(
  context: DownstreamGrantDecisionContext
): DownstreamGrantEnforcementProfile {
  const riskLevel: DownstreamGrantRiskLevel =
    context.redactionLevel === 'raw' ? 'high' : 'standard';

  if (riskLevel === 'high') {
    return {
      riskLevel,
      verificationMode: 'online_check_required',
      cacheMode: 'no_cache',
      failureMode: 'fail_closed',
    };
  }

  return {
    riskLevel,
    verificationMode: 'offline_ok',
    cacheMode: 'short_ttl',
    failureMode: 'policy_controlled',
  };
}

export function resolveDownstreamGrantServiceDecision(
  tokenPayload: JwtLikePayload
): DownstreamGrantServiceDecision | null {
  const context = extractDownstreamGrantDecisionContext(tokenPayload);
  if (!context) {
    return null;
  }

  return {
    source: 'jwt',
    context,
    enforcement: buildDownstreamGrantEnforcementProfile(context),
  };
}

export function resolveDownstreamGrantServiceDecisionFromIntrospection(
  response: IntrospectionResponse
): DownstreamGrantServiceDecision | null {
  const context = extractDownstreamGrantDecisionContextFromIntrospection(response);
  if (!context) {
    return null;
  }

  return {
    source: 'introspection',
    context,
    enforcement: buildDownstreamGrantEnforcementProfile(context),
  };
}

/**
 * Parse an already-issued downstream grant JWT from an Authorization header.
 *
 * WARNING:
 * - This helper does not verify the JWT signature.
 * - Use only after a separate verification step, or prefer
 *   `evaluateDownstreamGrantServiceAuthorizationHeaderWithVerifier(...)`.
 */
export function resolveDownstreamGrantServiceDecisionFromAuthorizationHeader(
  authorizationHeader: string | null | undefined
): DownstreamGrantServiceDecision | null {
  const token = extractDownstreamGrantTokenFromAuthorizationHeader(authorizationHeader);
  if (!token) {
    return null;
  }

  try {
    return resolveDownstreamGrantServiceDecision(parseToken(token) as JwtLikePayload);
  } catch {
    return null;
  }
}

export function authorizeDownstreamGrantServiceAccess(
  input: DownstreamGrantServiceAuthorizationInput
): DownstreamGrantServiceAuthorizationResult {
  const { decision } = input;
  if (!decision) {
    return {
      allowed: false,
      reasonCode: 'grant_missing',
      correlationId: null,
      redactionLevel: null,
      context: null,
      enforcement: null,
    };
  }

  const { context, enforcement } = decision;
  const expectedAudiences = toAudienceArray(input.expectedAudience);
  if (
    expectedAudiences.length > 0 &&
    (!context.audience || !expectedAudiences.includes(context.audience))
  ) {
    return {
      allowed: false,
      reasonCode: 'grant_audience_mismatch',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  if (input.requiredResourceClass && context.resourceClass !== input.requiredResourceClass) {
    return {
      allowed: false,
      reasonCode: 'grant_resource_class_mismatch',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  if (input.requiredResourceId && !context.resourceIds.includes(input.requiredResourceId)) {
    return {
      allowed: false,
      reasonCode: 'grant_resource_scope_mismatch',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  if (
    input.requiredResourceIds?.length &&
    input.requiredResourceIds.some((resourceId) => !context.resourceIds.includes(resourceId))
  ) {
    return {
      allowed: false,
      reasonCode: 'grant_resource_scope_mismatch',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  if (input.requiredDetailClass && !context.detailClasses.includes(input.requiredDetailClass)) {
    return {
      allowed: false,
      reasonCode: 'grant_detail_class_mismatch',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  if (
    input.requiredDetailClasses?.length &&
    input.requiredDetailClasses.some((detailClass) => !context.detailClasses.includes(detailClass))
  ) {
    return {
      allowed: false,
      reasonCode: 'grant_detail_class_mismatch',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  if (input.requireFullAccess && context.partialAccessAllowed) {
    return {
      allowed: false,
      reasonCode: 'grant_partial_access_not_allowed',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  if (input.localAuthorization && !input.localAuthorization.allowed) {
    return {
      allowed: false,
      reasonCode: input.localAuthorization.reasonCode ?? 'local_authorization_denied',
      correlationId: context.investigationId || context.requestId || context.grantId,
      redactionLevel: context.redactionLevel,
      context,
      enforcement,
    };
  }

  return {
    allowed: true,
    reasonCode: null,
    correlationId: context.investigationId || context.requestId || context.grantId,
    redactionLevel: context.redactionLevel,
    context,
    enforcement,
  };
}

function withDecisionMetadata(
  decision: DownstreamGrantServiceDecision | null,
  result: DownstreamGrantServiceAuthorizationResult
): DownstreamGrantServiceEvaluationResult {
  const enforcement = decision?.enforcement ?? result.enforcement;
  return {
    ...result,
    decision,
    requiresOnlineCheck: enforcement ? shouldRequireDownstreamOnlineCheck(enforcement) : false,
    failClosed: enforcement ? shouldFailClosedForDownstreamGrant(enforcement) : false,
  };
}

function mergeServiceEvaluationDefaults(
  defaults: DownstreamGrantServiceEvaluationInput,
  override?: DownstreamGrantServiceAuthorizerOverride
): DownstreamGrantServiceEvaluationInput {
  return {
    ...defaults,
    ...(override ?? {}),
    localAuthorization: override?.localAuthorization ?? defaults.localAuthorization ?? null,
  };
}

export function evaluateDownstreamGrantServiceJwt(
  input: DownstreamGrantServiceEvaluationInput & { tokenPayload: JwtLikePayload }
): DownstreamGrantServiceEvaluationResult {
  const decision = resolveDownstreamGrantServiceDecision(input.tokenPayload);
  const result = authorizeDownstreamGrantServiceAccess({
    ...input,
    decision,
  });
  return withDecisionMetadata(decision, result);
}

/**
 * Convenience wrapper for services that already trust the Authorization header
 * token because signature verification happened upstream.
 */
export function evaluateDownstreamGrantServiceAuthorizationHeader(
  input: DownstreamGrantServiceEvaluationInput & {
    authorizationHeader: string | null | undefined;
  }
): DownstreamGrantServiceEvaluationResult {
  const decision = resolveDownstreamGrantServiceDecisionFromAuthorizationHeader(
    input.authorizationHeader
  );
  const result = authorizeDownstreamGrantServiceAccess({
    ...input,
    decision,
  });
  return withDecisionMetadata(decision, result);
}

export async function evaluateDownstreamGrantServiceAuthorizationHeaderWithVerifier(
  input: DownstreamGrantServiceEvaluationInput & {
    authorizationHeader: string | null | undefined;
    verifyToken: DownstreamGrantTokenVerifier;
  }
): Promise<DownstreamGrantServiceEvaluationResult> {
  const token = extractDownstreamGrantTokenFromAuthorizationHeader(input.authorizationHeader);
  if (!token) {
    const result = authorizeDownstreamGrantServiceAccess({
      ...input,
      decision: null,
    });
    return withDecisionMetadata(null, result);
  }

  try {
    const tokenPayload = await input.verifyToken(token);
    return evaluateDownstreamGrantServiceJwt({
      ...input,
      tokenPayload,
    });
  } catch {
    const result = authorizeDownstreamGrantServiceAccess({
      ...input,
      decision: null,
    });
    return withDecisionMetadata(null, result);
  }
}

export function evaluateDownstreamGrantServiceIntrospection(
  input: DownstreamGrantServiceEvaluationInput & { response: IntrospectionResponse }
): DownstreamGrantServiceEvaluationResult {
  const decision = resolveDownstreamGrantServiceDecisionFromIntrospection(input.response);
  const result = authorizeDownstreamGrantServiceAccess({
    ...input,
    decision,
  });
  return withDecisionMetadata(decision, result);
}

export function createDownstreamGrantServiceAuthorizer(
  defaults: DownstreamGrantServiceEvaluationInput
): DownstreamGrantServiceAuthorizer {
  return {
    defaults,
    fromAuthorizationHeader(input) {
      return evaluateDownstreamGrantServiceAuthorizationHeader({
        ...mergeServiceEvaluationDefaults(defaults, input.override),
        authorizationHeader: input.authorizationHeader,
      });
    },
    async fromAuthorizationHeaderWithVerifier(input) {
      return evaluateDownstreamGrantServiceAuthorizationHeaderWithVerifier({
        ...mergeServiceEvaluationDefaults(defaults, input.override),
        authorizationHeader: input.authorizationHeader,
        verifyToken: input.verifyToken,
      });
    },
    fromIntrospection(input) {
      return evaluateDownstreamGrantServiceIntrospection({
        ...mergeServiceEvaluationDefaults(defaults, input.override),
        response: input.response,
      });
    },
    fromJwt(input) {
      return evaluateDownstreamGrantServiceJwt({
        ...mergeServiceEvaluationDefaults(defaults, input.override),
        tokenPayload: input.tokenPayload,
      });
    },
  };
}

async function evaluateDownstreamGrantMiddlewareAuthorization(
  c: Context<any, any, any>,
  options: DownstreamGrantHonoMiddlewareOptions
): Promise<DownstreamGrantServiceEvaluationResult> {
  const authorizationHeader = c.req.header('authorization');
  const override = (await options.resolveOverride?.(c)) ?? undefined;
  const mergedDefaults = mergeServiceEvaluationDefaults(options.authorizer.defaults, override);
  const token = extractDownstreamGrantTokenFromAuthorizationHeader(authorizationHeader);

  if (!token) {
    const result = authorizeDownstreamGrantServiceAccess({
      ...mergedDefaults,
      decision: null,
    });
    return withDecisionMetadata(null, result);
  }

  let decision: DownstreamGrantServiceDecision | null = null;
  if (options.verifyToken) {
    try {
      const tokenPayload = await options.verifyToken({ token, c });
      decision = resolveDownstreamGrantServiceDecision(tokenPayload);
    } catch {
      decision = null;
    }
  }

  let evaluation = withDecisionMetadata(
    decision,
    authorizeDownstreamGrantServiceAccess({
      ...mergedDefaults,
      decision,
    })
  );

  if (evaluation.requiresOnlineCheck) {
    if (!options.introspectToken) {
      return {
        ...evaluation,
        allowed: false,
        reasonCode: 'grant_online_check_required',
      };
    }

    try {
      const introspection = await options.introspectToken({ token, c });
      decision = resolveDownstreamGrantServiceDecisionFromIntrospection(introspection);
      evaluation = withDecisionMetadata(
        decision,
        authorizeDownstreamGrantServiceAccess({
          ...mergedDefaults,
          decision,
        })
      );
    } catch {
      return {
        ...evaluation,
        allowed: false,
        reasonCode: 'grant_online_check_failed',
      };
    }
  } else if (!decision && options.introspectToken) {
    try {
      const introspection = await options.introspectToken({ token, c });
      decision = resolveDownstreamGrantServiceDecisionFromIntrospection(introspection);
      evaluation = withDecisionMetadata(
        decision,
        authorizeDownstreamGrantServiceAccess({
          ...mergedDefaults,
          decision,
        })
      );
    } catch {
      decision = null;
    }
  }

  if (decision && options.resolveLocalAuthorization) {
    const localAuthorization = await options.resolveLocalAuthorization({ c, decision });
    evaluation = withDecisionMetadata(
      decision,
      authorizeDownstreamGrantServiceAccess({
        ...mergedDefaults,
        decision,
        localAuthorization,
      })
    );
  }

  return evaluation;
}

export function downstreamGrantMiddleware(
  options: DownstreamGrantHonoMiddlewareOptions
): MiddlewareHandler<any> {
  return async (c: Context<any, any, any>, next: Next) => {
    const authorization = await evaluateDownstreamGrantMiddlewareAuthorization(c, options);

    if (!authorization.allowed) {
      const denyResponse = options.onDeny
        ? await options.onDeny({ c, authorization })
        : createDownstreamGrantDeniedResponse(authorization);
      return denyResponse;
    }

    c.set(DOWNSTREAM_GRANT_DECISION_CONTEXT_KEY, {
      decision: authorization.decision,
      authorization,
    } satisfies DownstreamGrantMiddlewareContextDecision);

    await next();
  };
}

export function getDownstreamGrantMiddlewareContext(
  c: Context<any, any, any>
): DownstreamGrantMiddlewareContextDecision | null {
  return (
    (c.get(DOWNSTREAM_GRANT_DECISION_CONTEXT_KEY) as
      | DownstreamGrantMiddlewareContextDecision
      | undefined) ?? null
  );
}

export function shouldRequireDownstreamOnlineCheck(
  profile: DownstreamGrantEnforcementProfile | DownstreamGrantDecisionContext
): boolean {
  const enforcement =
    'verificationMode' in profile ? profile : buildDownstreamGrantEnforcementProfile(profile);
  return enforcement.verificationMode === 'online_check_required';
}

export function shouldFailClosedForDownstreamGrant(
  profile: DownstreamGrantEnforcementProfile | DownstreamGrantDecisionContext
): boolean {
  const enforcement =
    'failureMode' in profile ? profile : buildDownstreamGrantEnforcementProfile(profile);
  return enforcement.failureMode === 'fail_closed';
}

export function isElevationGrantSubjectTokenType(value: string | null | undefined): boolean {
  return value === ELEVATION_GRANT_SUBJECT_TOKEN_TYPE;
}

export function getEffectiveDownstreamGrantScope(scope: ApprovalScopeDescriptor): string {
  const detailPart = scope.detail_classes?.length ? scope.detail_classes.join(':') : 'detail';
  return `${scope.resource_class}:${scope.action}:${detailPart}`;
}
