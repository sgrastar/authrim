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
    addFail(check, `${label}: payload が object ではありません`);
    return false;
  }
  addPass(check, `${label}: JSON object を確認しました`);
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
    addPass(check, `user_id=${input.userId} を cleanup しました`);
  } else if (response.status === 404) {
    addWarn(check, `user_id=${input.userId} は既に存在しません`);
  } else {
    addWarn(
      check,
      `DELETE /api/admin/users/${encodeURIComponent(input.userId)} failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }

  input.checks.push(finalizeCheck(check, 'approval smoke user cleanup を実行しました'));
}

export async function runGeneratedApprovalsSmoke(
  options: GeneratedApprovalsSmokeOptions
): Promise<GeneratedApprovalsSmokeResult> {
  const target = await resolveGeneratedSmokeTarget(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tenantId = target.tenantId;
  const { secret: adminSecret, path: adminSecretPath } = await readGeneratedAdminApiSecret({
    baseDir: target.baseDir,
    env: target.env,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    baseUrl: target.baseUrl,
    tenantId: target.tenantId,
  });

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
        addFail(check, 'created user id が見つかりませんでした');
      }
    },
  });
  checks.push(finalizeCheck(userCreateCheck, 'approval smoke user create を確認しました'));

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
          addFail(check, 'public_request_id が見つかりませんでした');
        }

        const approvals = firstRecordArray(payload.approvals);
        approvalId = asString(approvals[0]?.id) ?? undefined;
        if (approvalId) {
          addPass(check, `approval_id=${approvalId}`);
        } else {
          addFail(check, 'approval step id が見つかりませんでした');
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
          addWarn(check, 'initial completion artifact path は response に含まれていません');
        }
      },
    });
    checks.push(finalizeCheck(createCheck, 'approval request create を確認しました'));

    if (!requestId || !approvalId) {
      return {
        ok: false,
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
            addFail(check, 'completion_path が見つかりませんでした');
          }
        },
      });
      checks.push(
        finalizeCheck(issueArtifactCheck, 'manual approval artifact issue を確認しました')
      );
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
          addPass(check, 'portal_confirm completion requirements を確認しました');
        } else {
          addWarn(check, `unexpected completion method: ${method ?? 'missing'}`);
        }
      },
    });
    checks.push(finalizeCheck(artifactCheck, 'public approval artifact read を確認しました'));

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
        addPass(portalCheck, 'Content-Type=text/html を確認しました');
      } else {
        addWarn(portalCheck, `portal content-type=${portalResponse.contentType ?? 'missing'}`);
      }
      if (portalResponse.bodyText?.includes(artifactCompletePath)) {
        addPass(portalCheck, `portal に complete path=${artifactCompletePath} を確認しました`);
      } else {
        addWarn(portalCheck, 'portal body に completion path を確認できませんでした');
      }
    }
    checks.push(finalizeCheck(portalCheck, 'public approval artifact portal read を確認しました'));

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
          addWarn(check, 'receipt_path が含まれていませんでした');
        }
        if (grantId) {
          addPass(check, `grant_id=${grantId}`);
        } else {
          addWarn(check, 'grant_ids が含まれていませんでした');
        }
      },
    });
    checks.push(finalizeCheck(completeCheck, 'approval completion を確認しました'));

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
            addPass(check, 'decision=approved を確認しました');
          } else {
            addWarn(check, `receipt decision=${asString(payload.decision) ?? 'missing'}`);
          }
          if (receiptPortalPath && asString(payload.receipt_portal_path) === receiptPortalPath) {
            addPass(check, `receipt_portal_path=${receiptPortalPath}`);
          }
        },
      });
      checks.push(finalizeCheck(receiptCheck, 'approval decision receipt read を確認しました'));
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
          addPass(check, 'request status=approved を確認しました');
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
    checks.push(
      finalizeCheck(requestReadCheck, 'approval request read after completion を確認しました')
    );

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
          addWarn(check, 'decision receipts items が空でした');
        }
      },
    });
    checks.push(
      finalizeCheck(receiptsCheck, 'approval decision receipts admin read を確認しました')
    );

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
            addPass(check, 'subject_token を確認しました');
          } else {
            addFail(check, 'subject_token が見つかりませんでした');
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
            addWarn(check, 'integration_hint.target_audience を解決できませんでした');
          }
          protectedResourcePath =
            resolveProtectedResourcePath(asString(productRoute?.path_template), targetSubjectId!) ??
            undefined;
          if (protectedResourcePath) {
            addPass(check, `protected_resource_path=${protectedResourcePath}`);
          }
        },
      });
      checks.push(
        finalizeCheck(subjectTokenCheck, 'approval grant subject token issue を確認しました')
      );
    } else if (grantId) {
      const subjectTokenWarn = makeSmokeCheck(
        'approval-subject-token',
        'approval grant subject token issue',
        `${target.baseUrl}/api/admin/approvals/${requestId}/grants/${grantId}/subject-token`
      );
      addWarn(
        subjectTokenWarn,
        'service client を解決できないため subject token issue はスキップしました'
      );
      checks.push(
        finalizeCheck(subjectTokenWarn, 'approval grant subject token issue をスキップしました')
      );
    }

    if (subjectToken && resolvedClientId && resolvedClientSecret && targetAudience) {
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
            addPass(tokenExchangeCheck, 'access_token を確認しました');
          } else {
            addFail(tokenExchangeCheck, 'access_token が見つかりませんでした');
          }
        }
      }
      checks.push(
        finalizeCheck(tokenExchangeCheck, 'approval downstream token exchange を確認しました')
      );

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
              addPass(introspectionCheck, 'active=true を確認しました');
            } else {
              addFail(introspectionCheck, 'active=true が返っていません');
            }
            const elevation = isRecord(introspectionResponse.payload.authrim_elevation)
              ? introspectionResponse.payload.authrim_elevation
              : null;
            if (asString(elevation?.resource_class) === 'customer_profile') {
              addPass(
                introspectionCheck,
                'authrim_elevation.resource_class=customer_profile を確認しました'
              );
            } else {
              addWarn(
                introspectionCheck,
                'authrim_elevation.resource_class を確認できませんでした'
              );
            }
          }
        }
        checks.push(
          finalizeCheck(
            introspectionCheck,
            'approval downstream token introspection を確認しました'
          )
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
              `grant_missing を受信したため ${delayMs}ms 後に protected resource read を再試行します (attempt ${protectedResourceAttempt + 1}/${PROTECTED_RESOURCE_GRANT_MAX_RETRIES})`
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
                  `retry 後に protected resource read が成功しました (attempt ${protectedResourceAttempt}/${PROTECTED_RESOURCE_GRANT_MAX_RETRIES})`
                );
              }
              if (asString(protectedResourceResponse.payload.redaction_level) === 'masked') {
                addPass(protectedResourceCheck, 'redaction_level=masked を確認しました');
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
                addFail(protectedResourceCheck, 'protected profile sub が一致しませんでした');
              }
            }
          }
          checks.push(
            finalizeCheck(protectedResourceCheck, 'approval protected resource read を確認しました')
          );
        } else {
          const protectedResourceWarn = makeSmokeCheck(
            'approval-protected-resource-read',
            'approval protected resource read',
            `${target.baseUrl}/api/protected/customer-profiles/${encodeURIComponent(targetSubjectId)}`
          );
          addWarn(
            protectedResourceWarn,
            'integration_hint.product_route が無いため protected resource read はスキップしました'
          );
          checks.push(
            finalizeCheck(
              protectedResourceWarn,
              'approval protected resource read をスキップしました'
            )
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
        'service client secret を解決できないため token exchange / protected resource read はスキップしました'
      );
      checks.push(
        finalizeCheck(protectedResourceWarn, 'approval protected resource read をスキップしました')
      );
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
  }
}
