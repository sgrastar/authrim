import {
  addFail,
  addPass,
  addWarn,
  fetchJsonWithTimeout,
  finalizeCheck,
  isRecord,
  makeSmokeCheck,
  readGeneratedAdminApiSecret,
  resolveGeneratedSmokeTarget,
  withTenantHeader,
  type GeneratedSmokeOptions,
  type SmokeCheck,
} from './generated-smoke-common.js';
import {
  cleanupGeneratedApprovalSmokeClient,
  resolveGeneratedApprovalSmokeClient,
} from './generated-approvals-smoke-client.js';

const ELEVATION_GRANT_SUBJECT_TOKEN_TYPE = 'urn:authrim:token-type:elevation-grant';
const PROTECTED_RESOURCE_GRANT_RETRY_DELAY_MS = 750;
const PROTECTED_RESOURCE_GRANT_MAX_RETRIES = 5;

export interface GeneratedApprovalLoadContextOptions extends GeneratedSmokeOptions {
  adminSecret?: string;
  adminSecretPath?: string;
  clientId?: string;
  clientSecret?: string;
  subjectTokenExpiresIn?: number;
}

export interface GeneratedApprovalLoadContext {
  env: string;
  baseUrl: string;
  configPath: string;
  adminSecretPath: string;
  adminSecret: string;
  tenantId: string;
  userId: string;
  requestId: string;
  grantId: string;
  clientId: string;
  clientSecret: string;
  subjectToken: string;
  downstreamAccessToken: string;
  protectedResourcePath: string;
  checks: SmokeCheck[];
  cleanup: () => Promise<SmokeCheck[]>;
}

function getAdminHeaders(secret: string, tenantId?: string): Record<string, string> {
  return withTenantHeader(
    {
      authorization: `Bearer ${secret}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    tenantId
  );
}

function validateJsonObject(
  check: SmokeCheck,
  payload: unknown,
  label: string
): payload is Record<string, unknown> {
  if (!isRecord(payload)) {
    addFail(check, `${label}: payload is not a JSON object`);
    return false;
  }
  addPass(check, `${label}: confirmed JSON object payload`);
  return true;
}

async function runJsonRequest(options: {
  check: SmokeCheck;
  baseUrl: string;
  path: string;
  timeoutMs: number;
  tenantId?: string;
  adminSecret?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  expectedStatus?: number;
  validate?: (payload: unknown, check: SmokeCheck) => void;
}): Promise<unknown> {
  const headers =
    options.headers ??
    (options.adminSecret ? getAdminHeaders(options.adminSecret, options.tenantId) : { accept: 'application/json' });
  const response = await fetchJsonWithTimeout(`${options.baseUrl}${options.path}`, options.timeoutMs, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  options.check.httpStatus = response.status;

  if (!response.ok) {
    addFail(
      options.check,
      `${options.method ?? 'GET'} ${options.path} failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
    return null;
  }

  if (options.expectedStatus && response.status !== options.expectedStatus) {
    addFail(options.check, `HTTP ${options.expectedStatus} expected, actual=${response.status}`);
  } else {
    addPass(options.check, `HTTP ${response.status}`);
  }

  options.validate?.(response.payload, options.check);
  return response.payload;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function firstRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => isRecord(item)) : [];
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function resolveProtectedResourcePath(pathTemplate: string | null, userId: string): string | null {
  if (!pathTemplate?.trim()) {
    return null;
  }
  return pathTemplate.replace(':userId', encodeURIComponent(userId));
}

function resolveApprovalArtifactPaths(path: string): {
  artifactApiPath: string;
  artifactPortalPath: string;
  artifactCompletePath: string;
} {
  const normalizedPath = path.replace(/\/+$/, '');
  if (normalizedPath.endsWith('/portal')) {
    const artifactApiPath = normalizedPath.slice(0, -'/portal'.length);
    return {
      artifactApiPath,
      artifactPortalPath: normalizedPath,
      artifactCompletePath: `${artifactApiPath}/complete`,
    };
  }

  return {
    artifactApiPath: normalizedPath,
    artifactPortalPath: `${normalizedPath}/portal`,
    artifactCompletePath: `${normalizedPath}/complete`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryAfterSeconds(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return typeof payload.retry_after === 'number' && payload.retry_after > 0
    ? payload.retry_after
    : undefined;
}

async function cleanupSmokeUser(input: {
  checks: SmokeCheck[];
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  userId?: string;
}): Promise<void> {
  if (!input.userId) {
    return;
  }

  const check = makeSmokeCheck(
    'approval-load-user-delete',
    'approval load user cleanup',
    `${input.baseUrl}/api/admin/users/${encodeURIComponent(input.userId)}`
  );
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/users/${encodeURIComponent(input.userId)}`,
    input.timeoutMs,
    {
      method: 'DELETE',
      headers: getAdminHeaders(input.adminSecret, input.tenantId),
    }
  );
  check.httpStatus = response.status;

  if (response.ok) {
    addPass(check, `HTTP ${response.status}`);
    addPass(check, `cleaned up user_id=${input.userId}`);
  } else if (response.status === 404) {
    addWarn(check, `user_id=${input.userId} no longer exists`);
  } else {
    addWarn(
      check,
      `DELETE /api/admin/users/${encodeURIComponent(input.userId)} failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }

  input.checks.push(finalizeCheck(check, 'Executed approval-load user cleanup'));
}

export async function createGeneratedApprovalLoadContext(
  options: GeneratedApprovalLoadContextOptions
): Promise<GeneratedApprovalLoadContext> {
  const target = await resolveGeneratedSmokeTarget(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tenantId = target.tenantId;
  const { secret: adminSecret, path: adminSecretPath } = await readGeneratedAdminApiSecret({
    baseDir: target.baseDir,
    env: target.env,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
  });

  const checks: SmokeCheck[] = [];
  const smokeRunId = Date.now();
  const smokeEmail = `approval-load-${smokeRunId}@example.test`;
  let targetSubjectId: string | undefined;
  let requestId: string | undefined;
  let approvalId: string | undefined;
  let artifactApiPath: string | undefined;
  let artifactPortalPath: string | undefined;
  let artifactCompletePath: string | undefined;
  let grantId: string | undefined;
  let resolvedClientId: string | undefined;
  let resolvedClientSecret: string | undefined;
  let temporaryClientId: string | undefined;
  let subjectToken: string | undefined;
  let targetAudience: string | undefined;
  let protectedResourcePath: string | undefined;
  let downstreamAccessToken: string | undefined;

  const userCreateCheck = makeSmokeCheck(
    'approval-load-user-create',
    'approval load user create',
    `${target.baseUrl}/api/admin/users`
  );
  await runJsonRequest({
    check: userCreateCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/users',
    method: 'POST',
    adminSecret,
    tenantId,
    timeoutMs,
    expectedStatus: 201,
    body: {
      email: smokeEmail,
      name: 'Approval Load User',
      given_name: 'Approval',
      family_name: 'Load',
      preferred_username: `approval-load-${smokeRunId}`,
      phone_number: '+819000001234',
      email_verified: true,
      phone_number_verified: true,
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'approval load user')) {
        return;
      }
      const user = isRecord(payload.user) ? payload.user : null;
      targetSubjectId = asString(user?.id) ?? undefined;
      if (targetSubjectId) {
        addPass(check, `user_id=${targetSubjectId}`);
      } else {
        addFail(check, 'created user id was not returned');
      }
    },
  });
  checks.push(finalizeCheck(userCreateCheck, 'Verified approval-load user creation'));

  if (!targetSubjectId) {
    throw new Error('approval_load_user_create_failed');
  }

  const resolvedClient = await resolveGeneratedApprovalSmokeClient({
    baseUrl: target.baseUrl,
    timeoutMs,
    adminSecret,
    tenantId,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    defaultAudience: 'svc://op-userinfo/customer-profile',
  });
  resolvedClientId = resolvedClient.clientId;
  resolvedClientSecret = resolvedClient.clientSecret;
  temporaryClientId = resolvedClient.temporaryClientId;
  checks.push(...resolvedClient.checks);

  if (!resolvedClientId || !resolvedClientSecret) {
    throw new Error('approval_load_client_unavailable');
  }

  const createCheck = makeSmokeCheck(
    'approval-load-request-create',
    'approval load request create',
    `${target.baseUrl}/api/admin/approvals`
  );
  await runJsonRequest({
    check: createCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/approvals',
    method: 'POST',
    adminSecret,
    tenantId,
    timeoutMs,
    expectedStatus: 201,
    body: {
      target_subject_type: 'user',
      target_subject_id: targetSubjectId,
      request_surface: 'service_data',
      requested_action: 'detail_read',
      resource_class: 'customer_profile',
      resource_ids: [targetSubjectId],
      detail_classes: ['profile_export'],
      audience: 'svc://op-userinfo/customer-profile',
      redaction_level: 'masked',
      reason_code: 'technical_debug',
      policy_preset: 'technical_debug_default',
      approvals: [
        {
          step_key: 'operator-1',
          side: 'admin_operator',
          subject_type: 'admin_user',
          subject_id: 'load-approver',
          method: 'portal_confirm',
        },
      ],
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'approval load request')) {
        return;
      }
      requestId = asString(payload.public_request_id) ?? undefined;
      const approvals = firstRecordArray(payload.approvals);
      approvalId = asString(approvals[0]?.id) ?? undefined;
      const notificationResults = firstRecordArray(payload.notification_results);
      const completionArtifact = isRecord(notificationResults[0]?.completion_artifact)
        ? notificationResults[0]?.completion_artifact
        : null;
      const artifactPath = asString(completionArtifact?.path) ?? undefined;
      if (requestId) {
        addPass(check, `request_id=${requestId}`);
      } else {
        addFail(check, 'public_request_id was not returned');
      }
      if (approvalId) {
        addPass(check, `approval_id=${approvalId}`);
      } else {
        addFail(check, 'approval step id was not returned');
      }
      if (artifactPath) {
        const resolvedPaths = resolveApprovalArtifactPaths(artifactPath);
        artifactApiPath = resolvedPaths.artifactApiPath;
        artifactPortalPath = resolvedPaths.artifactPortalPath;
        artifactCompletePath = resolvedPaths.artifactCompletePath;
        addPass(check, `artifact_path=${artifactPath}`);
      }
    },
  });
  checks.push(finalizeCheck(createCheck, 'Verified approval-load request creation'));

  if (!requestId || !approvalId) {
    throw new Error('approval_load_request_create_failed');
  }

  if (!artifactApiPath || !artifactPortalPath || !artifactCompletePath) {
    const issueArtifactCheck = makeSmokeCheck(
      'approval-load-artifact-issue',
      'approval load manual artifact issue',
      `${target.baseUrl}/api/admin/approvals/${requestId}/steps/${approvalId}/artifacts`
    );
    await runJsonRequest({
      check: issueArtifactCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/approvals/${encodeURIComponent(requestId)}/steps/${encodeURIComponent(approvalId)}/artifacts`,
      method: 'POST',
      adminSecret,
      tenantId,
      timeoutMs,
      expectedStatus: 200,
      body: { method: 'portal_confirm' },
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'approval load artifact')) {
          return;
        }
        const artifactPath = asString(payload.completion_path) ?? undefined;
        if (!artifactPath) {
          addFail(check, 'completion_path was not returned');
          return;
        }
        const resolvedPaths = resolveApprovalArtifactPaths(artifactPath);
        artifactApiPath = resolvedPaths.artifactApiPath;
        artifactPortalPath = resolvedPaths.artifactPortalPath;
        artifactCompletePath = resolvedPaths.artifactCompletePath;
      },
    });
    checks.push(
      finalizeCheck(issueArtifactCheck, 'Verified approval-load manual artifact issuance')
    );
  }

  if (!artifactApiPath || !artifactPortalPath || !artifactCompletePath) {
    throw new Error('approval_load_artifact_unavailable');
  }

  const completeCheck = makeSmokeCheck(
    'approval-load-complete',
    'approval load completion',
    `${target.baseUrl}${artifactCompletePath}`
  );
  await runJsonRequest({
    check: completeCheck,
    baseUrl: target.baseUrl,
    path: artifactCompletePath,
    method: 'POST',
    timeoutMs,
    expectedStatus: 200,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: target.baseUrl,
      referer: `${target.baseUrl}${artifactPortalPath}`,
    },
    body: { decision: 'approved' },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'approval load completion')) {
        return;
      }
      const grantIds = asStringArray(payload.grant_ids);
      grantId = grantIds[0];
      if (grantId) {
        addPass(check, `grant_id=${grantId}`);
      } else {
        addFail(check, 'grant_ids were not returned');
      }
    },
  });
  checks.push(finalizeCheck(completeCheck, 'Verified approval-load completion'));

  if (!grantId) {
    throw new Error('approval_load_grant_missing');
  }

  const subjectTokenCheck = makeSmokeCheck(
    'approval-load-subject-token',
    'approval load subject token issue',
    `${target.baseUrl}/api/admin/approvals/${requestId}/grants/${grantId}/subject-token`
  );
  await runJsonRequest({
    check: subjectTokenCheck,
    baseUrl: target.baseUrl,
    path: `/api/admin/approvals/${encodeURIComponent(requestId)}/grants/${encodeURIComponent(grantId)}/subject-token`,
    method: 'POST',
    adminSecret,
    tenantId,
    timeoutMs,
    expectedStatus: 200,
    body: {
      client_id: resolvedClientId,
      expires_in: options.subjectTokenExpiresIn ?? 900,
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'approval load subject token')) {
        return;
      }
      subjectToken = asString(payload.subject_token) ?? undefined;
      const integrationHint = isRecord(payload.integration_hint) ? payload.integration_hint : null;
      const productRoute = isRecord(integrationHint?.product_route) ? integrationHint.product_route : null;
      const productRouteDefaultAudience = asString(productRoute?.default_audience) ?? undefined;
      const hintedTargetAudience = asString(integrationHint?.target_audience) ?? undefined;
      targetAudience =
        hintedTargetAudience && hintedTargetAudience !== 'admin_api'
          ? hintedTargetAudience
          : productRouteDefaultAudience ?? hintedTargetAudience;
      protectedResourcePath =
        resolveProtectedResourcePath(asString(productRoute?.path_template), targetSubjectId!) ?? undefined;

      if (subjectToken) {
        addPass(check, 'confirmed subject_token');
      } else {
        addFail(check, 'subject_token was not returned');
      }
    },
  });
  checks.push(
    finalizeCheck(subjectTokenCheck, 'Verified approval-load subject-token issuance')
  );

  if (!subjectToken || !targetAudience || !protectedResourcePath) {
    throw new Error('approval_load_subject_context_incomplete');
  }

  const tokenExchangeCheck = makeSmokeCheck(
    'approval-load-token-exchange',
    'approval load downstream token exchange',
    `${target.baseUrl}/token`
  );
  let tokenExchangeResponse = await fetchJsonWithTimeout(`${target.baseUrl}/token`, timeoutMs, {
    method: 'POST',
    headers: {
      authorization: `Basic ${encodeBasicAuth(resolvedClientId, resolvedClientSecret)}`,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      audience: targetAudience,
    }).toString(),
  });
  let tokenExchangeAttempt = 1;
  while (
    !tokenExchangeResponse.ok &&
    tokenExchangeResponse.status === 429 &&
    tokenExchangeAttempt < 5
  ) {
    const retryAfterSeconds = extractRetryAfterSeconds(tokenExchangeResponse.payload) ?? 2;
    addWarn(
      tokenExchangeCheck,
      `bootstrap token exchange was rate-limited; retrying in ${retryAfterSeconds}s (attempt ${tokenExchangeAttempt + 1}/5)`
    );
    await sleep(retryAfterSeconds * 1000 + 1000);
    tokenExchangeResponse = await fetchJsonWithTimeout(`${target.baseUrl}/token`, timeoutMs, {
      method: 'POST',
      headers: {
        authorization: `Basic ${encodeBasicAuth(resolvedClientId, resolvedClientSecret)}`,
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: subjectToken,
        subject_token_type: ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: targetAudience,
      }).toString(),
    });
    tokenExchangeAttempt += 1;
  }
  tokenExchangeCheck.httpStatus = tokenExchangeResponse.status;
  if (!tokenExchangeResponse.ok) {
    addFail(
      tokenExchangeCheck,
      `POST /token failed: ${tokenExchangeResponse.status} ${tokenExchangeResponse.error ?? tokenExchangeResponse.bodyText ?? ''}`
    );
  } else {
    addPass(tokenExchangeCheck, `HTTP ${tokenExchangeResponse.status}`);
    if (validateJsonObject(tokenExchangeCheck, tokenExchangeResponse.payload, 'approval load token exchange')) {
      downstreamAccessToken = asString(tokenExchangeResponse.payload.access_token) ?? undefined;
      if (downstreamAccessToken) {
        addPass(tokenExchangeCheck, 'confirmed access_token');
      } else {
        addFail(tokenExchangeCheck, 'access_token was not returned');
      }
    }
  }
  checks.push(
    finalizeCheck(tokenExchangeCheck, 'Verified approval-load downstream token exchange')
  );

  if (!downstreamAccessToken) {
    throw new Error('approval_load_downstream_access_token_missing');
  }

  const protectedResourceCheck = makeSmokeCheck(
    'approval-load-protected-resource',
    'approval load protected resource bootstrap read',
    `${target.baseUrl}${protectedResourcePath}`
  );
  let protectedResourceResponse = await fetchJsonWithTimeout(
    `${target.baseUrl}${protectedResourcePath}`,
    timeoutMs,
    {
      headers: {
        authorization: `Bearer ${downstreamAccessToken}`,
        accept: 'application/json',
      },
    }
  );
  let attempt = 1;
  while (
    attempt < PROTECTED_RESOURCE_GRANT_MAX_RETRIES &&
    !protectedResourceResponse.ok &&
    protectedResourceResponse.status === 403 &&
    isRecord(protectedResourceResponse.payload) &&
    asString(protectedResourceResponse.payload.reason_code) === 'grant_missing'
  ) {
    await sleep(PROTECTED_RESOURCE_GRANT_RETRY_DELAY_MS * attempt);
    protectedResourceResponse = await fetchJsonWithTimeout(
      `${target.baseUrl}${protectedResourcePath}`,
      timeoutMs,
      {
        headers: {
          authorization: `Bearer ${downstreamAccessToken}`,
          accept: 'application/json',
        },
      }
    );
    attempt += 1;
  }
  protectedResourceCheck.httpStatus = protectedResourceResponse.status;
  if (!protectedResourceResponse.ok) {
    addFail(
      protectedResourceCheck,
      `GET ${protectedResourcePath} failed: ${protectedResourceResponse.status} ${protectedResourceResponse.error ?? protectedResourceResponse.bodyText ?? ''}`
    );
  } else {
    addPass(protectedResourceCheck, `HTTP ${protectedResourceResponse.status}`);
  }
  checks.push(
    finalizeCheck(
      protectedResourceCheck,
      'Verified approval-load protected-resource bootstrap read'
    )
  );

  if (!protectedResourceResponse.ok) {
    throw new Error('approval_load_protected_resource_bootstrap_failed');
  }

  const cleanup = async (): Promise<SmokeCheck[]> => {
    const cleanupChecks: SmokeCheck[] = [];
    await cleanupGeneratedApprovalSmokeClient({
      checks: cleanupChecks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      clientId: temporaryClientId,
    });
    await cleanupSmokeUser({
      checks: cleanupChecks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      userId: targetSubjectId,
    });
    return cleanupChecks;
  };

  return {
    env: target.env,
    baseUrl: target.baseUrl,
    configPath: target.configPath,
    adminSecretPath,
    adminSecret,
    tenantId,
    userId: targetSubjectId,
    requestId,
    grantId,
    clientId: resolvedClientId,
    clientSecret: resolvedClientSecret,
    subjectToken,
    downstreamAccessToken,
    protectedResourcePath,
    checks,
    cleanup,
  };
}
