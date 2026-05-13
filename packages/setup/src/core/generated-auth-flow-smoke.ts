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
  type GeneratedSmokeOptions,
  type RegisteredSmokeClient,
  type SmokeCheck,
  type TemporaryDcrEnableState,
  type TemporaryInitialAccessToken,
} from './generated-smoke-common.js';

export type ClientCredentialsMode = 'auto' | 'on' | 'off';

export interface GeneratedAuthFlowSmokeOptions extends GeneratedSmokeOptions {
  redirectUri?: string;
  clientCredentialsMode?: ClientCredentialsMode;
  adminSecret?: string;
  adminSecretPath?: string;
}

export interface GeneratedAuthFlowSmokeResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  configPath: string;
  clientId?: string;
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

async function fetchJsonCheck(options: {
  check: SmokeCheck;
  timeoutMs: number;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  expectedStatus?: number;
  validate?: (payload: unknown, check: SmokeCheck) => void;
}) {
  const response = await fetchJsonWithTimeout(options.url, options.timeoutMs, {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  });
  options.check.httpStatus = response.status;

  if (!response.ok) {
    addFail(
      options.check,
      `${options.method ?? 'GET'} ${options.url} failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
    return response;
  }

  if (options.expectedStatus && response.status !== options.expectedStatus) {
    addFail(
      options.check,
      `HTTP ${options.expectedStatus} expected, actual=${response.status}`
    );
  } else {
    addPass(options.check, `HTTP ${response.status}`);
  }

  options.validate?.(response.payload, options.check);
  return response;
}

function isUnsupportedClientCredentialsResponse(payload: unknown): boolean {
  return (
    isRecord(payload) &&
    (payload.error === 'unsupported_grant_type' || payload.error === 'unauthorized_client')
  );
}

export async function runGeneratedAuthFlowSmoke(
  options: GeneratedAuthFlowSmokeOptions
): Promise<GeneratedAuthFlowSmokeResult> {
  const target = await resolveGeneratedSmokeTarget(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const clientCredentialsMode = options.clientCredentialsMode ?? 'auto';
  const checks: SmokeCheck[] = [];
  const tenantId = target.tenantId;
  const clientRegistrationDefaults = resolveSmokeClientRegistrationDefaults(target.config);
  const { secret: adminSecret } = await readGeneratedAdminApiSecret({
    baseDir: target.baseDir,
    env: target.env,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    baseUrl: target.baseUrl,
    tenantId: target.tenantId,
  });

  let temporaryClient: RegisteredSmokeClient | null = null;
  let temporaryIat: TemporaryInitialAccessToken | null = null;
  let temporaryDcr: TemporaryDcrEnableState | null = null;

  const dcrToggleCheck = makeSmokeCheck(
    'temporary-dcr-enable',
    'temporary DCR enable for auth flow smoke',
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
      dcrToggleCheck,
      temporaryDcr.changed ? 'dcr.enabled を一時的に有効化しました' : 'dcr.enabled は既に有効です'
    );
  } catch (error) {
    addFail(
      dcrToggleCheck,
      `temporary DCR enable failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  checks.push(finalizeCheck(dcrToggleCheck, 'temporary DCR enable を確認しました'));

  if (dcrToggleCheck.status === 'fail') {
    return {
      ok: false,
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      checks,
    };
  }

  const iatCheck = makeSmokeCheck(
    'dcr-initial-access-token',
    'dynamic client registration initial access token',
    `${target.baseUrl}/api/admin/iat-tokens`
  );
  try {
    temporaryIat = await createTemporaryInitialAccessToken({
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      description: 'Portability Auth Flow Smoke Temporary IAT',
    });
    addPass(iatCheck, `tokenHash=${temporaryIat.tokenHash}`);
  } catch (error) {
    addFail(
      iatCheck,
      `initial access token creation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  checks.push(finalizeCheck(iatCheck, 'dynamic client registration initial access token を確認しました'));

  const registerCheck = makeSmokeCheck(
    'dcr-register',
    'dynamic client registration',
    `${target.baseUrl}/register`
  );

  try {
    if (!temporaryIat) {
      throw new Error('temporary_iat_unavailable');
    }
    temporaryClient = await registerTemporarySmokeClient({
      baseUrl: target.baseUrl,
      timeoutMs,
      tenantId,
      initialAccessToken: temporaryIat.token,
      redirectUri: options.redirectUri,
      grantTypes: clientRegistrationDefaults.grantTypes,
      responseTypes: clientRegistrationDefaults.responseTypes,
      clientCredentialsAllowed: clientRegistrationDefaults.supportsClientCredentials,
      clientNamePrefix: 'Portability Auth Flow Smoke Client',
    });
    addPass(registerCheck, `client_id=${temporaryClient.clientId}`);
    addPass(registerCheck, `registration_client_uri=${temporaryClient.registrationClientUri}`);
  } catch (error) {
    addFail(
      registerCheck,
      `dynamic client registration failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  checks.push(finalizeCheck(registerCheck, 'dynamic client registration を確認しました'));

  if (!temporaryClient) {
    if (temporaryIat) {
      await revokeTemporaryInitialAccessToken({
        baseUrl: target.baseUrl,
        timeoutMs,
        adminSecret,
        tokenHash: temporaryIat.tokenHash,
        tenantId,
      });
    }
    if (temporaryDcr) {
      await restoreTemporaryDcrEnabled({
        baseUrl: target.baseUrl,
        timeoutMs,
        adminSecret,
        tenantId,
        state: temporaryDcr,
      });
    }
    return {
      ok: false,
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      checks,
    };
  }

  const configGetCheck = makeSmokeCheck(
    'client-config-get',
    'client configuration GET',
    temporaryClient.registrationClientUri
  );
  await fetchJsonCheck({
    check: configGetCheck,
    timeoutMs,
    url: temporaryClient.registrationClientUri,
    headers: {
      authorization: `Bearer ${temporaryClient.registrationAccessToken}`,
      accept: 'application/json',
    },
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'client config GET response')) {
        return;
      }
      if ((payload as Record<string, unknown>).client_id !== temporaryClient.clientId) {
        addFail(check, `client_id expected=${temporaryClient.clientId}`);
      }
    },
  });
  checks.push(finalizeCheck(configGetCheck, 'client configuration GET を確認しました'));

  const updatedClientName = `${temporaryClient.clientName} Updated`;
  const configUpdateCheck = makeSmokeCheck(
    'client-config-update',
    'client configuration PUT',
    temporaryClient.registrationClientUri
  );
  await fetchJsonCheck({
    check: configUpdateCheck,
    timeoutMs,
    url: temporaryClient.registrationClientUri,
    method: 'PUT',
    headers: {
      authorization: `Bearer ${temporaryClient.registrationAccessToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      client_id: temporaryClient.clientId,
      client_name: updatedClientName,
      redirect_uris: [temporaryClient.redirectUri],
      grant_types: clientRegistrationDefaults.grantTypes,
      response_types: clientRegistrationDefaults.responseTypes,
      token_endpoint_auth_method: 'client_secret_basic',
      scope: 'openid',
    }),
    validate: (payload, check) => {
      if (!validateJsonObject(check, payload, 'client config PUT response')) {
        return;
      }
      if ((payload as Record<string, unknown>).client_name !== updatedClientName) {
        addFail(check, `client_name expected=${updatedClientName}`);
      }
    },
  });
  checks.push(finalizeCheck(configUpdateCheck, 'client configuration PUT を確認しました'));

  if (!clientRegistrationDefaults.supportsClientCredentials) {
    const tokenCheck = makeSmokeCheck(
      'client-credentials-token',
      'client credentials token',
      `${target.baseUrl}/token`
    );
    if (clientCredentialsMode === 'on') {
      addFail(
        tokenCheck,
        'config.json の oidc.grantTypes に client_credentials が含まれていません'
      );
    } else {
      addWarn(
        tokenCheck,
        'config.json の oidc.grantTypes が client_credentials を許可していないため token/introspect/revoke をスキップしました'
      );
    }
    checks.push(finalizeCheck(tokenCheck, 'client credentials token を確認しました'));
  } else if (clientCredentialsMode !== 'off') {
    const tokenCheck = makeSmokeCheck(
      'client-credentials-token',
      'client credentials token',
      `${target.baseUrl}/token`
    );
    const tokenResponse = await fetchJsonWithTimeout(`${target.baseUrl}/token`, timeoutMs, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: temporaryClient.clientId,
        client_secret: temporaryClient.clientSecret,
        scope: 'openid',
      }).toString(),
    });
    tokenCheck.httpStatus = tokenResponse.status;

    let accessToken = '';
    if (!tokenResponse.ok) {
      if (clientCredentialsMode === 'auto' && isUnsupportedClientCredentialsResponse(tokenResponse.payload)) {
        addWarn(
          tokenCheck,
          `client_credentials が無効のため token/introspect/revoke をスキップしました: ${tokenResponse.status}`
        );
      } else {
        addFail(
          tokenCheck,
          `token failed: ${tokenResponse.status} ${tokenResponse.error ?? tokenResponse.bodyText ?? ''}`
        );
      }
    } else if (!isRecord(tokenResponse.payload)) {
      addFail(tokenCheck, 'token payload が object ではありません');
    } else if (typeof tokenResponse.payload.access_token !== 'string') {
      addFail(tokenCheck, 'access_token が返ってきませんでした');
    } else {
      accessToken = tokenResponse.payload.access_token;
      addPass(tokenCheck, `HTTP ${tokenResponse.status}`);
      addPass(tokenCheck, 'access_token を取得しました');
    }
    checks.push(finalizeCheck(tokenCheck, 'client credentials token を確認しました'));

    if (accessToken) {
      const introspectCheck = makeSmokeCheck(
        'token-introspect-before-revoke',
        'token introspection before revoke',
        `${target.baseUrl}/introspect`
      );
      await fetchJsonCheck({
        check: introspectCheck,
        timeoutMs,
        url: `${target.baseUrl}/introspect`,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          token: accessToken,
          token_type_hint: 'access_token',
          client_id: temporaryClient.clientId,
          client_secret: temporaryClient.clientSecret,
        }).toString(),
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'introspect response')) {
            return;
          }
          if ((payload as Record<string, unknown>).active !== true) {
            addFail(check, 'active=true を期待しました');
          }
        },
      });
      checks.push(finalizeCheck(introspectCheck, 'token introspection before revoke を確認しました'));

      const revokeCheck = makeSmokeCheck(
        'token-revoke',
        'token revocation',
        `${target.baseUrl}/revoke`
      );
      await fetchJsonCheck({
        check: revokeCheck,
        timeoutMs,
        url: `${target.baseUrl}/revoke`,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          token: accessToken,
          token_type_hint: 'access_token',
          client_id: temporaryClient.clientId,
          client_secret: temporaryClient.clientSecret,
        }).toString(),
      });
      checks.push(finalizeCheck(revokeCheck, 'token revocation を確認しました'));

      const introspectAfterCheck = makeSmokeCheck(
        'token-introspect-after-revoke',
        'token introspection after revoke',
        `${target.baseUrl}/introspect`
      );
      await fetchJsonCheck({
        check: introspectAfterCheck,
        timeoutMs,
        url: `${target.baseUrl}/introspect`,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          token: accessToken,
          token_type_hint: 'access_token',
          client_id: temporaryClient.clientId,
          client_secret: temporaryClient.clientSecret,
        }).toString(),
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'post-revoke introspect response')) {
            return;
          }
          if ((payload as Record<string, unknown>).active !== false) {
            addFail(check, 'active=false を期待しました');
          }
        },
      });
      checks.push(
        finalizeCheck(introspectAfterCheck, 'token introspection after revoke を確認しました')
      );
    }
  }

  const deleteCheck = makeSmokeCheck(
    'client-config-delete',
    'client configuration DELETE',
    temporaryClient.registrationClientUri
  );
  const deleteResponse = await deleteTemporarySmokeClient(temporaryClient, timeoutMs);
  deleteCheck.httpStatus = deleteResponse.status;
  if (!deleteResponse.ok && deleteResponse.status !== 204) {
    addFail(
      deleteCheck,
      `client delete failed: ${deleteResponse.status} ${deleteResponse.error ?? deleteResponse.bodyText ?? ''}`
    );
  } else {
    addPass(deleteCheck, `HTTP ${deleteResponse.status || 204}`);
  }
  checks.push(finalizeCheck(deleteCheck, 'client configuration DELETE を確認しました'));

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
    clientId: temporaryClient.clientId,
    checks,
  };
}
