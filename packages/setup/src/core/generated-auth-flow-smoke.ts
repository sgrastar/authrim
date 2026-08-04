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
  resolveSmokeClientRegistrationDefaults,
  withTenantHeader,
  type GeneratedSmokeOptions,
  type SmokeCheck,
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

interface SmokeClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  clientName: string;
}

function validateJsonObject(check: SmokeCheck, payload: unknown, label: string): boolean {
  if (!isRecord(payload)) {
    addFail(check, `${label}: payload is not an object`);
    return false;
  }
  addPass(check, `${label}: JSON object verified`);
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
    addFail(options.check, `HTTP ${options.expectedStatus} expected, actual=${response.status}`);
  } else {
    addPass(options.check, `HTTP ${response.status}`);
  }

  options.validate?.(response.payload, options.check);
  return response;
}

function getClientFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.client)) {
    return null;
  }
  return payload.client;
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

  try {
    const redirectUri =
      options.redirectUri ?? 'https://example.invalid/authrim/generated-auth-flow/callback';
    const smokeRunId = Date.now();
    const clientName = `Generated Auth Flow Smoke Client ${smokeRunId}`;
    const grantTypes = clientRegistrationDefaults.supportsClientCredentials
      ? ['client_credentials']
      : ['authorization_code'];
    const responseTypes = clientRegistrationDefaults.supportsClientCredentials ? [] : ['code'];
    let temporaryClient: SmokeClient | null = null;

    const clientCreateCheck = makeSmokeCheck(
      'admin-client-create',
      'admin client create for auth flow smoke',
      `${target.baseUrl}/api/admin/clients`
    );
    const createResponse = await fetchJsonWithTimeout(
      `${target.baseUrl}/api/admin/clients`,
      timeoutMs,
      {
        method: 'POST',
        headers: {
          ...getAdminHeaders(adminSecret, tenantId),
          'Idempotency-Key': `setup-auth-flow-smoke-client-${smokeRunId}`,
        },
        body: JSON.stringify({
          client_name: clientName,
          description: 'Generated auth flow smoke client',
          redirect_uris: [redirectUri],
          grant_types: grantTypes,
          response_types: responseTypes,
          token_endpoint_auth_method: 'client_secret_basic',
          client_credentials_allowed: clientRegistrationDefaults.supportsClientCredentials,
          allowed_scopes: ['openid'],
          default_scope: 'openid',
          require_pkce: true,
        }),
      }
    );
    clientCreateCheck.httpStatus = createResponse.status;
    if (!createResponse.ok) {
      addFail(
        clientCreateCheck,
        `POST /api/admin/clients failed: ${createResponse.status} ${createResponse.error ?? createResponse.bodyText ?? ''}`
      );
    } else if (
      !validateJsonObject(clientCreateCheck, createResponse.payload, 'admin client create')
    ) {
      // The validation helper records the failure.
    } else {
      const client = getClientFromPayload(createResponse.payload);
      const clientId = typeof client?.client_id === 'string' ? client.client_id : '';
      const clientSecret = typeof client?.client_secret === 'string' ? client.client_secret : '';
      if (!clientId || !clientSecret) {
        addFail(clientCreateCheck, 'client_id or client_secret was not returned');
      } else {
        temporaryClient = {
          clientId,
          clientSecret,
          redirectUri,
          clientName,
        };
        addPass(clientCreateCheck, `HTTP ${createResponse.status}`);
        addPass(clientCreateCheck, `client_id=${clientId}`);
      }
    }
    checks.push(finalizeCheck(clientCreateCheck, 'admin client create verified'));

    if (!temporaryClient) {
      return {
        ok: false,
        env: target.env,
        baseUrl: target.baseUrl,
        configPath: target.configPath,
        checks,
      };
    }

    const clientGetCheck = makeSmokeCheck(
      'admin-client-get',
      'admin client GET',
      `${target.baseUrl}/api/admin/clients/${encodeURIComponent(temporaryClient.clientId)}`
    );
    await fetchJsonCheck({
      check: clientGetCheck,
      timeoutMs,
      url: `${target.baseUrl}/api/admin/clients/${encodeURIComponent(temporaryClient.clientId)}`,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'client GET response')) {
          return;
        }
        const client = getClientFromPayload(payload);
        if (client?.client_id !== temporaryClient?.clientId) {
          addFail(check, `client_id expected=${temporaryClient?.clientId}`);
        }
      },
    });
    checks.push(finalizeCheck(clientGetCheck, 'admin client GET verified'));

    const updatedClientName = `${temporaryClient.clientName} Updated`;
    const clientUpdateCheck = makeSmokeCheck(
      'admin-client-update',
      'admin client PUT',
      `${target.baseUrl}/api/admin/clients/${encodeURIComponent(temporaryClient.clientId)}`
    );
    await fetchJsonCheck({
      check: clientUpdateCheck,
      timeoutMs,
      url: `${target.baseUrl}/api/admin/clients/${encodeURIComponent(temporaryClient.clientId)}`,
      method: 'PUT',
      headers: getAdminHeaders(adminSecret, tenantId),
      body: JSON.stringify({
        client_name: updatedClientName,
      }),
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'client PUT response')) {
          return;
        }
        const client = getClientFromPayload(payload);
        if (client?.client_name !== updatedClientName) {
          addFail(check, `client_name expected=${updatedClientName}`);
        }
      },
    });
    checks.push(finalizeCheck(clientUpdateCheck, 'admin client PUT verified'));

    if (!clientRegistrationDefaults.supportsClientCredentials) {
      const tokenCheck = makeSmokeCheck(
        'client-credentials-token',
        'client credentials token',
        `${target.baseUrl}/token`
      );
      if (clientCredentialsMode === 'on') {
        addFail(tokenCheck, 'config.json oidc.grantTypes does not include client_credentials');
      } else {
        addWarn(
          tokenCheck,
          'config.json oidc.grantTypes does not allow client_credentials; token/introspect/revoke checks were skipped'
        );
      }
      checks.push(finalizeCheck(tokenCheck, 'client credentials token verified'));
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
        if (
          clientCredentialsMode === 'auto' &&
          isUnsupportedClientCredentialsResponse(tokenResponse.payload)
        ) {
          addWarn(
            tokenCheck,
            `client_credentials is disabled; token/introspect/revoke checks were skipped: ${tokenResponse.status}`
          );
        } else {
          addFail(
            tokenCheck,
            `token failed: ${tokenResponse.status} ${tokenResponse.error ?? tokenResponse.bodyText ?? ''}`
          );
        }
      } else if (!isRecord(tokenResponse.payload)) {
        addFail(tokenCheck, 'token payload is not an object');
      } else if (typeof tokenResponse.payload.access_token !== 'string') {
        addFail(tokenCheck, 'access_token was not returned');
      } else {
        accessToken = tokenResponse.payload.access_token;
        addPass(tokenCheck, `HTTP ${tokenResponse.status}`);
        addPass(tokenCheck, 'access_token obtained');
      }
      checks.push(finalizeCheck(tokenCheck, 'client credentials token verified'));

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
              addFail(check, 'active=true was expected');
            }
          },
        });
        checks.push(finalizeCheck(introspectCheck, 'token introspection before revoke verified'));

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
        checks.push(finalizeCheck(revokeCheck, 'token revocation verified'));

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
              addFail(check, 'active=false was expected');
            }
          },
        });
        checks.push(
          finalizeCheck(introspectAfterCheck, 'token introspection after revoke verified')
        );
      }
    }

    const deleteCheck = makeSmokeCheck(
      'admin-client-delete',
      'admin client DELETE',
      `${target.baseUrl}/api/admin/clients/${encodeURIComponent(temporaryClient.clientId)}`
    );
    await fetchJsonCheck({
      check: deleteCheck,
      timeoutMs,
      url: `${target.baseUrl}/api/admin/clients/${encodeURIComponent(temporaryClient.clientId)}`,
      method: 'DELETE',
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'client DELETE response')) {
          return;
        }
        if ((payload as Record<string, unknown>).success !== true) {
          addFail(check, 'success=true was expected');
        }
      },
    });
    checks.push(finalizeCheck(deleteCheck, 'admin client DELETE verified'));

    return {
      ok: isSmokeSuccessful(checks),
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      clientId: temporaryClient.clientId,
      checks,
    };
  } finally {
    await adminAccess.cleanup?.();
  }
}
