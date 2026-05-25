import {
  addFail,
  addPass,
  addWarn,
  fetchJsonWithTimeout,
  finalizeCheck,
  isRecord,
  isSmokeSuccessful,
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
import { ensureGeneratedTokenExchangeEnabled } from './generated-token-exchange-settings.js';

const ELEVATION_GRANT_SUBJECT_TOKEN_TYPE = 'urn:authrim:token-type:elevation-grant';
const PROTECTED_RESOURCE_GRANT_RETRY_DELAY_MS = 750;
const PROTECTED_RESOURCE_GRANT_MAX_RETRIES = 5;

export interface GeneratedApprovalsSmokeOptions extends GeneratedSmokeOptions {
  adminSecret?: string;
  adminSecretPath?: string;
  clientId?: string;
  clientSecret?: string;
  subjectTokenExpiresIn?: number;
}

export interface GeneratedApprovalsSmokeResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  configPath: string;
  adminSecretPath: string;
  userId?: string;
  requestId?: string;
  grantId?: string;
  checks: SmokeCheck[];
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
    addFail(check, `${label}: payload is not an object`);
    return false;
  }
  addPass(check, `${label}: JSON object verified`);
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
    (options.adminSecret
      ? getAdminHeaders(options.adminSecret, options.tenantId)
      : { accept: 'application/json' });
  const response = await fetchJsonWithTimeout(
    `${options.baseUrl}${options.path}`,
    options.timeoutMs,
    {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }
  );
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
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function firstRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
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
    'approval-smoke-user-delete',
    'approval smoke user cleanup',
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
    addPass(check, `user_id=${input.userId} cleaned up`);
  } else if (response.status === 404) {
    addWarn(check, `user_id=${input.userId} does not exist anymore`);
  } else {
    addWarn(
      check,
      `DELETE /api/admin/users/${encodeURIComponent(input.userId)} failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }

  input.checks.push(finalizeCheck(check, 'approval smoke user cleanup executed'));
}

export async function runGeneratedApprovalsSmoke(
  options: GeneratedApprovalsSmokeOptions
): Promise<GeneratedApprovalsSmokeResult> {
  const target = await resolveGeneratedSmokeTarget(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tenantId = target.tenantId;
  const adminAccess = await readGeneratedAdminApiSecret({
    baseDir: target.baseDir,
    env: target.env,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    baseUrl: target.baseUrl,
    tenantId: target.tenantId,
    config: target.config,
  });
  const adminSecret = adminAccess.secret;
  const adminSecretPath = adminAccess.path;

  const checks: SmokeCheck[] = [];
  const smokeRunId = Date.now();
  const smokeEmail = `approval-smoke-${smokeRunId}@example.test`;
  let targetSubjectId: string | undefined;
  let requestId: string | undefined;
  let approvalId: string | undefined;
  let artifactPath: string | undefined;
  let artifactApiPath: string | undefined;
  let artifactPortalPath: string | undefined;
  let artifactCompletePath: string | undefined;
  let receiptPath: string | undefined;
  let receiptPortalPath: string | undefined;
  let grantId: string | undefined;
  let resolvedClientId: string | undefined;
  let resolvedClientSecret: string | undefined;
  let temporaryClientId: string | undefined;
  let subjectToken: string | undefined;
  let targetAudience: string | undefined;
  let protectedResourcePath: string | undefined;
  let restoreTokenExchangeSettings: (() => Promise<SmokeCheck | null>) | undefined;

  const userCreateCheck = makeSmokeCheck(
    'approval-smoke-user-create',
    'approval smoke user create',
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
      name: 'Approval Smoke User',
      given_name: 'Approval',
      family_name: 'Smoke',
      preferred_username: `approval-smoke-${smokeRunId}`,
      phone_number: '+819000001234',
      email_verified: true,
      phone_number_verified: true,
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'approval smoke user')) {
        return;
      }
      const user = isRecord(payload.user) ? payload.user : null;
      targetSubjectId = asString(user?.id) ?? undefined;
      if (targetSubjectId) {
        addPass(check, `user_id=${targetSubjectId}`);
      } else {
        addFail(check, 'created user id was not found');
      }
    },
  });
  checks.push(finalizeCheck(userCreateCheck, 'approval smoke user create verified'));

  if (!targetSubjectId) {
    return {
      ok: false,
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      adminSecretPath,
      checks,
    };
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

  try {
    const createCheck = makeSmokeCheck(
      'approval-request-create',
      'approval request create',
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
            subject_id: 'smoke-approver',
            method: 'portal_confirm',
          },
        ],
      },
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'approval request')) {
          return;
        }
        requestId = asString(payload.public_request_id) ?? undefined;
        if (requestId) {
          addPass(check, `request_id=${requestId}`);
        } else {
          addFail(check, 'public_request_id was not found');
        }

        const approvals = firstRecordArray(payload.approvals);
        approvalId = asString(approvals[0]?.id) ?? undefined;
        if (approvalId) {
          addPass(check, `approval_id=${approvalId}`);
        } else {
          addFail(check, 'approval step id was not found');
        }

        const notificationResults = firstRecordArray(payload.notification_results);
        const completionArtifact = isRecord(notificationResults[0]?.completion_artifact)
          ? notificationResults[0]?.completion_artifact
          : null;
        artifactPath = asString(completionArtifact?.path) ?? undefined;
        if (artifactPath) {
          const resolvedPaths = resolveApprovalArtifactPaths(artifactPath);
          artifactApiPath = resolvedPaths.artifactApiPath;
          artifactPortalPath = resolvedPaths.artifactPortalPath;
          artifactCompletePath = resolvedPaths.artifactCompletePath;
          addPass(check, `artifact_path=${artifactPath}`);
          addPass(check, `artifact_api_path=${artifactApiPath}`);
        } else {
          addWarn(check, 'initial completion artifact path was not included in the response');
        }
      },
    });
    if (createCheck.status === 'fail' && createCheck.httpStatus === 403) {
      createCheck.status = 'warn';
      addWarn(
        createCheck,
        'Admin Machine Access token cannot access approval operations; skipping approval flow smoke'
      );
    }
    checks.push(finalizeCheck(createCheck, 'approval request create verified'));

    if (!requestId || !approvalId) {
      return {
        ok: isSmokeSuccessful(checks),
        env: target.env,
        baseUrl: target.baseUrl,
        configPath: target.configPath,
        adminSecretPath,
        userId: targetSubjectId,
        checks,
      };
    }

    if (!artifactPath) {
      const issueArtifactCheck = makeSmokeCheck(
        'approval-artifact-issue',
        'manual approval artifact issue',
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
        body: {
          method: 'portal_confirm',
        },
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'approval artifact')) {
            return;
          }
          artifactPath = asString(payload.completion_path) ?? undefined;
          if (artifactPath) {
            const resolvedPaths = resolveApprovalArtifactPaths(artifactPath);
            artifactApiPath = resolvedPaths.artifactApiPath;
            artifactPortalPath = resolvedPaths.artifactPortalPath;
            artifactCompletePath = resolvedPaths.artifactCompletePath;
            addPass(check, `artifact_path=${artifactPath}`);
            addPass(check, `artifact_api_path=${artifactApiPath}`);
          } else {
            addFail(check, 'completion_path was not found');
          }
        },
      });
      checks.push(finalizeCheck(issueArtifactCheck, 'manual approval artifact issue verified'));
    }

    if (!artifactPath) {
      return {
        ok: false,
        env: target.env,
        baseUrl: target.baseUrl,
        configPath: target.configPath,
        adminSecretPath,
        userId: targetSubjectId,
        requestId,
        checks,
      };
    }

    if (!artifactApiPath || !artifactPortalPath || !artifactCompletePath) {
      return {
        ok: false,
        env: target.env,
        baseUrl: target.baseUrl,
        configPath: target.configPath,
        adminSecretPath,
        userId: targetSubjectId,
        requestId,
        checks,
      };
    }

    const artifactCheck = makeSmokeCheck(
      'approval-artifact-read',
      'public approval artifact read',
      `${target.baseUrl}${artifactApiPath}`
    );
    await runJsonRequest({
      check: artifactCheck,
      baseUrl: target.baseUrl,
      path: artifactApiPath,
      timeoutMs,
      expectedStatus: 200,
      headers: { accept: 'application/json' },
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'approval artifact')) {
          return;
        }
        const requirements = isRecord(payload.completion_requirements)
          ? payload.completion_requirements
          : null;
        const method = asString(requirements?.method);
        if (method === 'portal_confirm') {
          addPass(check, 'portal_confirm completion requirements verified');
        } else {
          addWarn(check, `unexpected completion method: ${method ?? 'missing'}`);
        }
      },
    });
    checks.push(finalizeCheck(artifactCheck, 'public approval artifact read verified'));

    const portalCheck = makeSmokeCheck(
      'approval-artifact-portal-read',
      'public approval artifact portal read',
      `${target.baseUrl}${artifactPortalPath}`
    );
    const portalResponse = await fetchJsonWithTimeout(
      `${target.baseUrl}${artifactPortalPath}`,
      timeoutMs,
      {
        headers: { accept: 'text/html' },
      }
    );
    portalCheck.httpStatus = portalResponse.status;
    if (!portalResponse.ok) {
      addFail(
        portalCheck,
        `GET ${artifactPortalPath} failed: ${portalResponse.status} ${portalResponse.error ?? portalResponse.bodyText ?? ''}`
      );
    } else {
      addPass(portalCheck, `HTTP ${portalResponse.status}`);
      if ((portalResponse.contentType ?? '').includes('text/html')) {
        addPass(portalCheck, 'Content-Type=text/html verified');
      } else {
        addWarn(portalCheck, `portal content-type=${portalResponse.contentType ?? 'missing'}`);
      }
      if (portalResponse.bodyText?.includes(artifactCompletePath)) {
        addPass(portalCheck, `portal contains complete path=${artifactCompletePath}`);
      } else {
        addWarn(portalCheck, 'portal body did not contain the completion path');
      }
    }
    checks.push(finalizeCheck(portalCheck, 'public approval artifact portal read verified'));

    const completeCheck = makeSmokeCheck(
      'approval-complete',
      'approval completion',
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
      body: {
        decision: 'approved',
      },
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'approval completion')) {
          return;
        }
        receiptPath = asString(payload.receipt_path) ?? undefined;
        receiptPortalPath = asString(payload.receipt_portal_path) ?? undefined;
        const grantIds = asStringArray(payload.grant_ids);
        grantId = grantIds[0];
        if (receiptPath) {
          addPass(check, `receipt_path=${receiptPath}`);
        } else {
          addWarn(check, 'receipt_path was not included');
        }
        if (grantId) {
          addPass(check, `grant_id=${grantId}`);
        } else {
          addWarn(check, 'grant_ids was not included');
        }
      },
    });
    checks.push(finalizeCheck(completeCheck, 'approval completion verified'));

    if (receiptPath) {
      const receiptCheck = makeSmokeCheck(
        'approval-receipt-read',
        'approval decision receipt read',
        `${target.baseUrl}${receiptPath}`
      );
      await runJsonRequest({
        check: receiptCheck,
        baseUrl: target.baseUrl,
        path: receiptPath,
        timeoutMs,
        expectedStatus: 200,
        headers: { accept: 'application/json' },
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'approval receipt')) {
            return;
          }
          if (asString(payload.decision) === 'approved') {
            addPass(check, 'decision=approved verified');
          } else {
            addWarn(check, `receipt decision=${asString(payload.decision) ?? 'missing'}`);
          }
          if (receiptPortalPath && asString(payload.receipt_portal_path) === receiptPortalPath) {
            addPass(check, `receipt_portal_path=${receiptPortalPath}`);
          }
        },
      });
      checks.push(finalizeCheck(receiptCheck, 'approval decision receipt read verified'));
    }

    const requestReadCheck = makeSmokeCheck(
      'approval-request-read',
      'approval request read after completion',
      `${target.baseUrl}/api/admin/approvals/${requestId}`
    );
    await runJsonRequest({
      check: requestReadCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/approvals/${encodeURIComponent(requestId)}`,
      adminSecret,
      tenantId,
      timeoutMs,
      expectedStatus: 200,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'approval request read')) {
          return;
        }
        const status = asString(payload.status);
        if (status === 'approved') {
          addPass(check, 'request status=approved verified');
        } else {
          addWarn(check, `request status=${status ?? 'missing'}`);
        }
        const grants = firstRecordArray(payload.grants);
        grantId = grantId ?? asString(grants[0]?.public_grant_id) ?? undefined;
        if (grantId) {
          addPass(check, `grant_id=${grantId}`);
        }
      },
    });
    checks.push(finalizeCheck(requestReadCheck, 'approval request read after completion verified'));

    const receiptsCheck = makeSmokeCheck(
      'approval-receipts-admin-read',
      'approval decision receipts admin read',
      `${target.baseUrl}/api/admin/approvals/${requestId}/receipts`
    );
    await runJsonRequest({
      check: receiptsCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/approvals/${encodeURIComponent(requestId)}/receipts`,
      adminSecret,
      tenantId,
      timeoutMs,
      expectedStatus: 200,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'approval receipts')) {
          return;
        }
        const items = firstRecordArray(payload.items);
        if (items.length > 0) {
          addPass(check, `receipt_count=${items.length}`);
        } else {
          addWarn(check, 'decision receipt items were empty');
        }
      },
    });
    checks.push(finalizeCheck(receiptsCheck, 'approval decision receipts admin read verified'));

    if (grantId && resolvedClientId) {
      const subjectTokenCheck = makeSmokeCheck(
        'approval-subject-token',
        'approval grant subject token issue',
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
          expires_in: options.subjectTokenExpiresIn ?? 180,
        },
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'subject token')) {
            return;
          }
          subjectToken = asString(payload.subject_token) ?? undefined;
          if (subjectToken) {
            addPass(check, 'subject_token verified');
          } else {
            addFail(check, 'subject_token was not found');
          }
          const integrationHint = isRecord(payload.integration_hint)
            ? payload.integration_hint
            : null;
          if (
            integrationHint &&
            asString(integrationHint.subject_token_client_id) === resolvedClientId
          ) {
            addPass(check, `client_id=${resolvedClientId}`);
          }
          const productRoute = isRecord(integrationHint?.product_route)
            ? integrationHint.product_route
            : null;
          const productRouteDefaultAudience = asString(productRoute?.default_audience) ?? undefined;
          const hintedTargetAudience = asString(integrationHint?.target_audience) ?? undefined;
          targetAudience =
            hintedTargetAudience && hintedTargetAudience !== 'admin_api'
              ? hintedTargetAudience
              : (productRouteDefaultAudience ?? hintedTargetAudience);
          if (targetAudience) {
            addPass(check, `target_audience=${targetAudience}`);
          } else {
            addWarn(check, 'integration_hint.target_audience could not be resolved');
          }
          protectedResourcePath =
            resolveProtectedResourcePath(asString(productRoute?.path_template), targetSubjectId!) ??
            undefined;
          if (protectedResourcePath) {
            addPass(check, `protected_resource_path=${protectedResourcePath}`);
          }
        },
      });
      checks.push(finalizeCheck(subjectTokenCheck, 'approval grant subject token issue verified'));
    } else if (grantId) {
      const subjectTokenWarn = makeSmokeCheck(
        'approval-subject-token',
        'approval grant subject token issue',
        `${target.baseUrl}/api/admin/approvals/${requestId}/grants/${grantId}/subject-token`
      );
      addWarn(
        subjectTokenWarn,
        'service client could not be resolved, so subject token issue was skipped'
      );
      checks.push(finalizeCheck(subjectTokenWarn, 'approval grant subject token issue skipped'));
    }

    if (subjectToken && resolvedClientId && resolvedClientSecret && targetAudience) {
      const tokenExchangeEnable = await ensureGeneratedTokenExchangeEnabled({
        baseUrl: target.baseUrl,
        timeoutMs,
        adminSecret,
        tenantId,
        checkId: 'approval-token-exchange-settings',
        title: 'approval token exchange settings',
      });
      checks.push(tokenExchangeEnable.check);
      restoreTokenExchangeSettings = tokenExchangeEnable.restore;

      const tokenExchangeCheck = makeSmokeCheck(
        'approval-downstream-token-exchange',
        'approval downstream token exchange',
        `${target.baseUrl}/token`
      );
      let downstreamAccessToken: string | undefined;
      const tokenExchangeResponse = await fetchJsonWithTimeout(
        `${target.baseUrl}/token`,
        timeoutMs,
        {
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
        }
      );
      tokenExchangeCheck.httpStatus = tokenExchangeResponse.status;

      if (!tokenExchangeResponse.ok) {
        addFail(
          tokenExchangeCheck,
          `POST /token failed: ${tokenExchangeResponse.status} ${tokenExchangeResponse.error ?? tokenExchangeResponse.bodyText ?? ''}`
        );
      } else {
        addPass(tokenExchangeCheck, `HTTP ${tokenExchangeResponse.status}`);
        if (
          validateJsonObject(
            tokenExchangeCheck,
            tokenExchangeResponse.payload,
            'token exchange response'
          )
        ) {
          downstreamAccessToken = asString(tokenExchangeResponse.payload.access_token) ?? undefined;
          if (downstreamAccessToken) {
            addPass(tokenExchangeCheck, 'access_token verified');
          } else {
            addFail(tokenExchangeCheck, 'access_token was not found');
          }
        }
      }
      checks.push(finalizeCheck(tokenExchangeCheck, 'approval downstream token exchange verified'));

      if (downstreamAccessToken) {
        const introspectionCheck = makeSmokeCheck(
          'approval-downstream-token-introspection',
          'approval downstream token introspection',
          `${target.baseUrl}/introspect`
        );
        const introspectionResponse = await fetchJsonWithTimeout(
          `${target.baseUrl}/introspect`,
          timeoutMs,
          {
            method: 'POST',
            headers: {
              authorization: `Basic ${encodeBasicAuth(resolvedClientId, resolvedClientSecret)}`,
              accept: 'application/json',
              'content-type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              token: downstreamAccessToken,
              token_type_hint: 'access_token',
            }).toString(),
          }
        );
        introspectionCheck.httpStatus = introspectionResponse.status;

        if (!introspectionResponse.ok) {
          addFail(
            introspectionCheck,
            `POST /introspect failed: ${introspectionResponse.status} ${introspectionResponse.error ?? introspectionResponse.bodyText ?? ''}`
          );
        } else {
          addPass(introspectionCheck, `HTTP ${introspectionResponse.status}`);
          if (
            validateJsonObject(
              introspectionCheck,
              introspectionResponse.payload,
              'token introspection'
            )
          ) {
            if (introspectionResponse.payload.active === true) {
              addPass(introspectionCheck, 'active=true verified');
            } else {
              addFail(introspectionCheck, 'active=true was not returned');
            }
            const elevation = isRecord(introspectionResponse.payload.authrim_elevation)
              ? introspectionResponse.payload.authrim_elevation
              : null;
            if (asString(elevation?.resource_class) === 'customer_profile') {
              addPass(
                introspectionCheck,
                'authrim_elevation.resource_class=customer_profile verified'
              );
            } else {
              addWarn(introspectionCheck, 'authrim_elevation.resource_class could not be verified');
            }
          }
        }
        checks.push(
          finalizeCheck(introspectionCheck, 'approval downstream token introspection verified')
        );

        if (protectedResourcePath) {
          const protectedResourceCheck = makeSmokeCheck(
            'approval-protected-resource-read',
            'approval protected resource read',
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
          let protectedResourceAttempt = 1;
          let retriedProtectedResourceRead = false;

          while (protectedResourceAttempt < PROTECTED_RESOURCE_GRANT_MAX_RETRIES) {
            const protectedResourcePayload = isRecord(protectedResourceResponse.payload)
              ? protectedResourceResponse.payload
              : null;
            const shouldRetryProtectedResourceRead =
              !protectedResourceResponse.ok &&
              protectedResourceResponse.status === 403 &&
              asString(protectedResourcePayload?.reason_code) === 'grant_missing';

            if (!shouldRetryProtectedResourceRead) {
              break;
            }

            retriedProtectedResourceRead = true;
            const delayMs = PROTECTED_RESOURCE_GRANT_RETRY_DELAY_MS * protectedResourceAttempt;
            addWarn(
              protectedResourceCheck,
              `grant_missing received; retrying protected resource read after ${delayMs}ms (attempt ${protectedResourceAttempt + 1}/${PROTECTED_RESOURCE_GRANT_MAX_RETRIES})`
            );
            await sleep(delayMs);
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
            protectedResourceAttempt += 1;
          }

          protectedResourceCheck.httpStatus = protectedResourceResponse.status;

          if (!protectedResourceResponse.ok) {
            addFail(
              protectedResourceCheck,
              `GET ${protectedResourcePath} failed: ${protectedResourceResponse.status} ${protectedResourceResponse.error ?? protectedResourceResponse.bodyText ?? ''}`
            );
          } else {
            addPass(protectedResourceCheck, `HTTP ${protectedResourceResponse.status}`);
            if (
              validateJsonObject(
                protectedResourceCheck,
                protectedResourceResponse.payload,
                'protected resource'
              )
            ) {
              if (retriedProtectedResourceRead) {
                addPass(
                  protectedResourceCheck,
                  `protected resource read succeeded after retry (attempt ${protectedResourceAttempt}/${PROTECTED_RESOURCE_GRANT_MAX_RETRIES})`
                );
              }
              if (asString(protectedResourceResponse.payload.redaction_level) === 'masked') {
                addPass(protectedResourceCheck, 'redaction_level=masked verified');
              } else {
                addWarn(
                  protectedResourceCheck,
                  `redaction_level=${asString(protectedResourceResponse.payload.redaction_level) ?? 'missing'}`
                );
              }
              const profile = isRecord(protectedResourceResponse.payload.profile)
                ? protectedResourceResponse.payload.profile
                : null;
              if (asString(profile?.sub) === targetSubjectId) {
                addPass(protectedResourceCheck, `profile.sub=${targetSubjectId}`);
              } else {
                addFail(protectedResourceCheck, 'protected profile sub did not match');
              }
            }
          }
          checks.push(
            finalizeCheck(protectedResourceCheck, 'approval protected resource read verified')
          );
        } else {
          const protectedResourceWarn = makeSmokeCheck(
            'approval-protected-resource-read',
            'approval protected resource read',
            `${target.baseUrl}/api/protected/customer-profiles/${encodeURIComponent(targetSubjectId)}`
          );
          addWarn(
            protectedResourceWarn,
            'integration_hint.product_route is missing, so protected resource read was skipped'
          );
          checks.push(
            finalizeCheck(protectedResourceWarn, 'approval protected resource read skipped')
          );
        }
      }
    } else if (subjectToken && resolvedClientId) {
      const protectedResourceWarn = makeSmokeCheck(
        'approval-protected-resource-read',
        'approval protected resource read',
        `${target.baseUrl}/api/protected/customer-profiles/${encodeURIComponent(targetSubjectId)}`
      );
      addWarn(
        protectedResourceWarn,
        'service client secret could not be resolved, so token exchange and protected resource read were skipped'
      );
      checks.push(finalizeCheck(protectedResourceWarn, 'approval protected resource read skipped'));
    }

    return {
      ok: isSmokeSuccessful(checks),
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      adminSecretPath,
      userId: targetSubjectId,
      requestId,
      grantId,
      checks,
    };
  } finally {
    if (restoreTokenExchangeSettings) {
      const restoreCheck = await restoreTokenExchangeSettings();
      if (restoreCheck) {
        checks.push(restoreCheck);
      }
    }
    await cleanupGeneratedApprovalSmokeClient({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      clientId: temporaryClientId,
    });
    await cleanupSmokeUser({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      userId: targetSubjectId,
    });
    await adminAccess.cleanup?.();
  }
}
