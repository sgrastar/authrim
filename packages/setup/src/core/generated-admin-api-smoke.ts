import {
  addFail,
  addPass,
  addWarn,
  createTemporaryInitialAccessToken,
  deleteTemporarySmokeClient,
  ensureTemporaryDcrEnabled,
  fetchJsonWithTimeout,
  finalizeCheck,
  isRecord,
  isSmokeSuccessful,
  makeSmokeCheck,
  readGeneratedAdminApiSecret,
  registerTemporarySmokeClient,
  revokeTemporaryInitialAccessToken,
  restoreTemporaryDcrEnabled,
  resolveGeneratedSmokeTarget,
  resolveSmokeClientRegistrationDefaults,
  withTenantHeader,
  type GeneratedSmokeOptions,
  type RegisteredSmokeClient,
  type SmokeCheck,
  type TemporaryDcrEnableState,
  type TemporaryInitialAccessToken,
} from './generated-smoke-common.js';

export interface GeneratedAdminApiSmokeOptions extends GeneratedSmokeOptions {
  adminSecret?: string;
  adminSecretPath?: string;
  clientId?: string;
}

export interface GeneratedAdminApiSmokeResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  configPath: string;
  adminSecretPath: string;
  checks: SmokeCheck[];
}

function validateJsonObject(check: SmokeCheck, payload: unknown, label: string): boolean {
  if (!isRecord(payload)) {
    addFail(check, `${label}: payload が object ではありません`);
    return false;
  }
  addPass(check, `${label}: JSON object を確認しました`);
  return true;
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

async function runAdminJsonRequest(options: {
  check: SmokeCheck;
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  adminSecret: string;
  tenantId?: string;
  timeoutMs: number;
  body?: Record<string, unknown>;
  expectedStatus?: number;
  validate?: (payload: unknown, check: SmokeCheck) => void;
}): Promise<unknown> {
  const response = await fetchJsonWithTimeout(
      `${options.baseUrl}${options.path}`,
      options.timeoutMs,
      {
        method: options.method ?? 'GET',
        headers: getAdminHeaders(options.adminSecret, options.tenantId),
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
    addFail(
      options.check,
      `HTTP ${options.expectedStatus} expected, actual=${response.status}`
    );
    return response.payload;
  }

  addPass(options.check, `HTTP ${response.status}`);
  options.validate?.(response.payload, options.check);
  return response.payload;
}

export async function runGeneratedAdminApiSmoke(
  options: GeneratedAdminApiSmokeOptions
): Promise<GeneratedAdminApiSmokeResult> {
  const target = await resolveGeneratedSmokeTarget(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const { secret: adminSecret, path: adminSecretPath } = await readGeneratedAdminApiSecret({
    baseDir: target.baseDir,
    env: target.env,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
  });
  const tenantId = target.tenantId;
  const clientRegistrationDefaults = resolveSmokeClientRegistrationDefaults(target.config);

  const checks: SmokeCheck[] = [];
  let temporaryClient: RegisteredSmokeClient | null = null;
  let temporaryIat: TemporaryInitialAccessToken | null = null;
  let temporaryDcr: TemporaryDcrEnableState | null = null;

  const statsCheck = makeSmokeCheck(
    'admin-stats',
    'admin stats endpoint',
    `${target.baseUrl}/api/admin/stats`
  );
  await runAdminJsonRequest({
    check: statsCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/stats',
    adminSecret,
    tenantId,
    timeoutMs,
    validate: (payload, check) => {
      validateJsonObject(check, payload, 'admin stats');
    },
  });
  checks.push(finalizeCheck(statsCheck, 'admin stats endpoint を確認しました'));

  const profilesCheck = makeSmokeCheck(
    'runtime-profiles-defaults',
    'runtime profile defaults endpoint',
    `${target.baseUrl}/api/admin/runtime-profiles/defaults`
  );
  await runAdminJsonRequest({
    check: profilesCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/runtime-profiles/defaults',
    adminSecret,
    tenantId,
    timeoutMs,
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'runtime profile defaults')) {
        return;
      }
      if (!('defaults' in (payload as Record<string, unknown>))) {
        addWarn(check, 'defaults field が見つかりませんでした');
      }
    },
  });
  checks.push(finalizeCheck(profilesCheck, 'runtime profile defaults endpoint を確認しました'));

  try {
    if (options.clientId) {
      addPass(
        profilesCheck,
        `check-api-keys 用 client_id として ${options.clientId} を使用します`
      );
    } else {
      const dcrCheck = makeSmokeCheck(
        'temporary-dcr-enable',
        'temporary DCR enable for admin smoke',
        `${target.baseUrl}/api/admin/tenants/${tenantId}/settings/dcr`
      );
      try {
        temporaryDcr = await ensureTemporaryDcrEnabled({
          baseUrl: target.baseUrl,
          timeoutMs,
          adminSecret,
          tenantId,
        });
        addPass(
          dcrCheck,
          temporaryDcr.changed
            ? 'dcr.enabled を一時的に有効化しました'
            : 'dcr.enabled は既に有効です'
        );
      } catch (error) {
        addWarn(
          dcrCheck,
          `temporary DCR enable をスキップしました: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      checks.push(finalizeCheck(dcrCheck, 'temporary DCR enable を確認しました'));

      temporaryIat = await createTemporaryInitialAccessToken({
        baseUrl: target.baseUrl,
        timeoutMs,
        adminSecret,
        tenantId,
        description: 'Portability Admin Smoke Temporary IAT',
      });
      temporaryClient = await registerTemporarySmokeClient({
        baseUrl: target.baseUrl,
        timeoutMs,
        tenantId,
        initialAccessToken: temporaryIat.token,
        grantTypes: clientRegistrationDefaults.grantTypes,
        responseTypes: clientRegistrationDefaults.responseTypes,
        clientCredentialsAllowed: clientRegistrationDefaults.supportsClientCredentials,
        clientNamePrefix: 'Portability Admin Smoke Client',
      });
    }
  } catch (error) {
    const clientWarn = makeSmokeCheck(
      'smoke-client-bootstrap',
      'admin smoke 用 temporary client bootstrap',
      `${target.baseUrl}/register`
    );
    addWarn(
      clientWarn,
      `temporary client bootstrap をスキップしました: ${error instanceof Error ? error.message : String(error)}`
    );
    checks.push(finalizeCheck(clientWarn, 'temporary client bootstrap をスキップしました'));
  }

  const tokenRuleName = `portability-smoke-rule-${Date.now()}`;
  let tokenRuleId = '';
  const tokenRuleCreateCheck = makeSmokeCheck(
    'token-claim-rules-create',
    'token claim rule create',
    `${target.baseUrl}/api/admin/token-claim-rules`
  );
  const tokenRuleCreatePayload = await runAdminJsonRequest({
    check: tokenRuleCreateCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/token-claim-rules',
    method: 'POST',
    adminSecret,
    tenantId,
    timeoutMs,
    expectedStatus: 201,
    body: {
      name: tokenRuleName,
      token_type: 'access',
      condition: { field: 'user_type', operator: 'eq', value: 'end_user' },
      actions: [
        {
          type: 'add_claim',
          claim_name: 'portability_smoke',
          claim_value: 'ok',
        },
      ],
      priority: 1,
      is_active: true,
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'token claim rule create response')) {
        return;
      }
      if (typeof (payload as Record<string, unknown>).id === 'string') {
        tokenRuleId = String((payload as Record<string, unknown>).id);
        addPass(check, `rule id=${tokenRuleId}`);
      } else {
        addFail(check, 'rule id が返ってきませんでした');
      }
    },
  });
  void tokenRuleCreatePayload;
  checks.push(finalizeCheck(tokenRuleCreateCheck, 'token claim rule create を確認しました'));

  if (tokenRuleId) {
    const tokenRuleGetCheck = makeSmokeCheck(
      'token-claim-rules-get',
      'token claim rule get',
      `${target.baseUrl}/api/admin/token-claim-rules/${tokenRuleId}`
    );
    await runAdminJsonRequest({
      check: tokenRuleGetCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/token-claim-rules/${tokenRuleId}`,
      adminSecret,
      tenantId,
      timeoutMs,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'token claim rule get response')) {
          return;
        }
        if ((payload as Record<string, unknown>).name !== tokenRuleName) {
          addFail(check, `name expected=${tokenRuleName}`);
        }
      },
    });
    checks.push(finalizeCheck(tokenRuleGetCheck, 'token claim rule get を確認しました'));
  }

  const permissionResourceId = `smoke-resource-${Date.now()}`;
  let permissionId = '';
  const permissionCreateCheck = makeSmokeCheck(
    'resource-permissions-create',
    'resource permission create',
    `${target.baseUrl}/api/admin/resource-permissions`
  );
  await runAdminJsonRequest({
    check: permissionCreateCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/resource-permissions',
    method: 'POST',
    adminSecret,
    tenantId,
    timeoutMs,
    expectedStatus: 201,
    body: {
      subject_type: 'user',
      subject_id: 'smoke-subject',
      resource_type: 'document',
      resource_id: permissionResourceId,
      actions: ['read'],
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'resource permission create response')) {
        return;
      }
      if (typeof (payload as Record<string, unknown>).id === 'string') {
        permissionId = String((payload as Record<string, unknown>).id);
        addPass(check, `permission id=${permissionId}`);
      } else {
        addFail(check, 'permission id が返ってきませんでした');
      }
    },
  });
  checks.push(finalizeCheck(permissionCreateCheck, 'resource permission create を確認しました'));

  const permissionCheckCheck = makeSmokeCheck(
    'resource-permissions-check',
    'resource permission check',
    `${target.baseUrl}/api/admin/resource-permissions/check`
  );
  await runAdminJsonRequest({
    check: permissionCheckCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/resource-permissions/check',
    method: 'POST',
    adminSecret,
    tenantId,
    timeoutMs,
    body: {
      subject_id: 'smoke-subject',
      resource_type: 'document',
      resource_id: permissionResourceId,
      action: 'read',
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'resource permission check response')) {
        return;
      }
      if ((payload as Record<string, unknown>).allowed !== true) {
        addFail(check, 'allowed=true を期待しました');
      }
    },
  });
  checks.push(finalizeCheck(permissionCheckCheck, 'resource permission check を確認しました'));

  const webhookName = `portability-smoke-webhook-${Date.now()}`;
  let webhookId = '';
  const webhookCreateCheck = makeSmokeCheck(
    'webhooks-create',
    'webhook create',
    `${target.baseUrl}/api/admin/webhooks`
  );
  await runAdminJsonRequest({
    check: webhookCreateCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/webhooks',
    method: 'POST',
    adminSecret,
    tenantId,
    timeoutMs,
    expectedStatus: 201,
    body: {
      name: webhookName,
      url: 'https://example.invalid/authrim-portability-smoke',
      events: ['user.created'],
      secret: '0123456789abcdef0123456789abcdef',
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'webhook create response')) {
        return;
      }
      const webhook = (payload as Record<string, unknown>).webhook;
      if (isRecord(webhook) && typeof webhook.id === 'string') {
        webhookId = webhook.id;
        addPass(check, `webhook id=${webhookId}`);
      } else {
        addFail(check, 'webhook id が返ってきませんでした');
      }
    },
  });
  checks.push(finalizeCheck(webhookCreateCheck, 'webhook create を確認しました'));

  if (webhookId) {
    const webhookGetCheck = makeSmokeCheck(
      'webhooks-get',
      'webhook get',
      `${target.baseUrl}/api/admin/webhooks/${webhookId}`
    );
    await runAdminJsonRequest({
      check: webhookGetCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/webhooks/${webhookId}`,
      adminSecret,
      tenantId,
      timeoutMs,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'webhook get response')) {
          return;
        }
        const webhook = (payload as Record<string, unknown>).webhook;
        if (!isRecord(webhook) || webhook.name !== webhookName) {
          addFail(check, `webhook name expected=${webhookName}`);
        }
      },
    });
    checks.push(finalizeCheck(webhookGetCheck, 'webhook get を確認しました'));
  }

  const checkApiListCheck = makeSmokeCheck(
    'check-api-keys-list',
    'check api keys list',
    `${target.baseUrl}/api/admin/check-api-keys`
  );
  await runAdminJsonRequest({
    check: checkApiListCheck,
    baseUrl: target.baseUrl,
    path: '/api/admin/check-api-keys',
    adminSecret,
    tenantId,
    timeoutMs,
    validate: (payload, check) => {
      validateJsonObject(check, payload, 'check api keys list');
    },
  });
  checks.push(finalizeCheck(checkApiListCheck, 'check api keys list を確認しました'));

  const checkApiClientId = options.clientId || temporaryClient?.clientId;
  let checkApiKeyId = '';
  if (checkApiClientId) {
    const checkApiCreateCheck = makeSmokeCheck(
      'check-api-keys-create',
      'check api key create',
      `${target.baseUrl}/api/admin/check-api-keys`
    );
    await runAdminJsonRequest({
      check: checkApiCreateCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/check-api-keys',
      method: 'POST',
      adminSecret,
      tenantId,
      timeoutMs,
      expectedStatus: 201,
      body: {
        client_id: checkApiClientId,
        name: `Portability Smoke Check API Key ${Date.now()}`,
        allowed_operations: ['check'],
        rate_limit_tier: 'moderate',
      },
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'check api key create response')) {
          return;
        }
        if (typeof (payload as Record<string, unknown>).id === 'string') {
          checkApiKeyId = String((payload as Record<string, unknown>).id);
          addPass(check, `api key id=${checkApiKeyId}`);
        } else {
          addFail(check, 'api key id が返ってきませんでした');
        }
      },
    });
    checks.push(finalizeCheck(checkApiCreateCheck, 'check api key create を確認しました'));

    if (checkApiKeyId) {
      const checkApiGetCheck = makeSmokeCheck(
        'check-api-keys-get',
        'check api key get',
        `${target.baseUrl}/api/admin/check-api-keys/${checkApiKeyId}`
      );
      await runAdminJsonRequest({
        check: checkApiGetCheck,
        baseUrl: target.baseUrl,
        path: `/api/admin/check-api-keys/${checkApiKeyId}`,
        adminSecret,
        tenantId,
        timeoutMs,
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'check api key get response')) {
            return;
          }
          if ((payload as Record<string, unknown>).id !== checkApiKeyId) {
            addFail(check, `id expected=${checkApiKeyId}`);
          }
        },
      });
      checks.push(finalizeCheck(checkApiGetCheck, 'check api key get を確認しました'));

      const checkApiRotateCheck = makeSmokeCheck(
        'check-api-keys-rotate',
        'check api key rotate',
        `${target.baseUrl}/api/admin/check-api-keys/${checkApiKeyId}/rotate`
      );
      let rotatedKeyId = '';
      await runAdminJsonRequest({
        check: checkApiRotateCheck,
        baseUrl: target.baseUrl,
        path: `/api/admin/check-api-keys/${checkApiKeyId}/rotate`,
        method: 'POST',
        adminSecret,
        tenantId,
        timeoutMs,
        expectedStatus: 201,
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'check api key rotate response')) {
            return;
          }
          if (typeof (payload as Record<string, unknown>).id === 'string') {
            rotatedKeyId = String((payload as Record<string, unknown>).id);
            checkApiKeyId = rotatedKeyId;
            addPass(check, `rotated api key id=${rotatedKeyId}`);
          } else {
            addFail(check, 'rotated api key id が返ってきませんでした');
          }
        },
      });
      checks.push(finalizeCheck(checkApiRotateCheck, 'check api key rotate を確認しました'));
    }
  } else {
    const skipCheck = makeSmokeCheck(
      'check-api-keys-create',
      'check api key create',
      `${target.baseUrl}/api/admin/check-api-keys`
    );
    addWarn(skipCheck, 'client_id を用意できなかったため check-api-keys mutation をスキップしました');
    checks.push(finalizeCheck(skipCheck, 'check api key create をスキップしました'));
  }

  if (checkApiKeyId) {
    const checkApiDeleteCheck = makeSmokeCheck(
      'check-api-keys-delete',
      'check api key delete',
      `${target.baseUrl}/api/admin/check-api-keys/${checkApiKeyId}`
    );
    await runAdminJsonRequest({
      check: checkApiDeleteCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/check-api-keys/${checkApiKeyId}`,
      method: 'DELETE',
      adminSecret,
      tenantId,
      timeoutMs,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'check api key delete response')) {
          return;
        }
        if ((payload as Record<string, unknown>).success !== true) {
          addFail(check, 'success=true を期待しました');
        }
      },
    });
    checks.push(finalizeCheck(checkApiDeleteCheck, 'check api key delete を確認しました'));
  }

  if (webhookId) {
    const webhookDeleteCheck = makeSmokeCheck(
      'webhooks-delete',
      'webhook delete',
      `${target.baseUrl}/api/admin/webhooks/${webhookId}`
    );
    await runAdminJsonRequest({
      check: webhookDeleteCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/webhooks/${webhookId}`,
      method: 'DELETE',
      adminSecret,
      tenantId,
      timeoutMs,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'webhook delete response')) {
          return;
        }
        if ((payload as Record<string, unknown>).deleted !== webhookId) {
          addFail(check, `deleted expected=${webhookId}`);
        }
      },
    });
    checks.push(finalizeCheck(webhookDeleteCheck, 'webhook delete を確認しました'));
  }

  if (permissionId) {
    const permissionDeleteCheck = makeSmokeCheck(
      'resource-permissions-delete',
      'resource permission delete',
      `${target.baseUrl}/api/admin/resource-permissions/${permissionId}`
    );
    await runAdminJsonRequest({
      check: permissionDeleteCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/resource-permissions/${permissionId}`,
      method: 'DELETE',
      adminSecret,
      tenantId,
      timeoutMs,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'resource permission delete response')) {
          return;
        }
      },
    });
    checks.push(finalizeCheck(permissionDeleteCheck, 'resource permission delete を確認しました'));
  }

  if (tokenRuleId) {
    const tokenRuleDeleteCheck = makeSmokeCheck(
      'token-claim-rules-delete',
      'token claim rule delete',
      `${target.baseUrl}/api/admin/token-claim-rules/${tokenRuleId}`
    );
    await runAdminJsonRequest({
      check: tokenRuleDeleteCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/token-claim-rules/${tokenRuleId}`,
      method: 'DELETE',
      adminSecret,
      tenantId,
      timeoutMs,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'token claim rule delete response')) {
          return;
        }
      },
    });
    checks.push(finalizeCheck(tokenRuleDeleteCheck, 'token claim rule delete を確認しました'));
  }

  if (temporaryClient) {
    const cleanupCheck = makeSmokeCheck(
      'temporary-client-cleanup',
      'temporary smoke client cleanup',
      temporaryClient.registrationClientUri
    );
    const cleanupResponse = await deleteTemporarySmokeClient(temporaryClient, timeoutMs);
    cleanupCheck.httpStatus = cleanupResponse.status;
    if (!cleanupResponse.ok && cleanupResponse.status !== 204) {
      addWarn(
        cleanupCheck,
        `temporary client cleanup failed: ${cleanupResponse.status} ${cleanupResponse.error ?? cleanupResponse.bodyText ?? ''}`
      );
    } else {
      addPass(cleanupCheck, `HTTP ${cleanupResponse.status || 204}`);
    }
    checks.push(finalizeCheck(cleanupCheck, 'temporary smoke client cleanup を確認しました'));
  }

  if (temporaryIat) {
    const cleanupCheck = makeSmokeCheck(
      'temporary-iat-cleanup',
      'temporary initial access token cleanup',
      `${target.baseUrl}/api/admin/iat-tokens/${temporaryIat.tokenHash}`
    );
    const cleanupResponse = await revokeTemporaryInitialAccessToken({
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tokenHash: temporaryIat.tokenHash,
      tenantId,
    });
    cleanupCheck.httpStatus = cleanupResponse.status;
    if (!cleanupResponse.ok && cleanupResponse.status !== 404) {
      addWarn(
        cleanupCheck,
        `temporary IAT cleanup failed: ${cleanupResponse.status} ${cleanupResponse.error ?? cleanupResponse.bodyText ?? ''}`
      );
    } else {
      addPass(cleanupCheck, `HTTP ${cleanupResponse.status || 404}`);
    }
    checks.push(finalizeCheck(cleanupCheck, 'temporary initial access token cleanup を確認しました'));
  }

  if (temporaryDcr) {
    const cleanupCheck = makeSmokeCheck(
      'temporary-dcr-restore',
      'temporary DCR restore',
      `${target.baseUrl}/api/admin/tenants/${tenantId}/settings/dcr`
    );
    try {
      const cleanupResponse = await restoreTemporaryDcrEnabled({
        baseUrl: target.baseUrl,
        timeoutMs,
        adminSecret,
        tenantId,
        state: temporaryDcr,
      });
      cleanupCheck.httpStatus = cleanupResponse.status;
      addPass(
        cleanupCheck,
        temporaryDcr.changed ? 'dcr.enabled を元の状態へ戻しました' : 'restore は不要でした'
      );
    } catch (error) {
      addWarn(
        cleanupCheck,
        `temporary DCR restore failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    checks.push(finalizeCheck(cleanupCheck, 'temporary DCR restore を確認しました'));
  }

  return {
    ok: isSmokeSuccessful(checks),
    env: target.env,
    baseUrl: target.baseUrl,
    configPath: target.configPath,
    adminSecretPath,
    checks,
  };
}
