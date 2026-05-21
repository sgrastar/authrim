import {
  addFail,
  addPass,
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
    addFail(options.check, `HTTP ${options.expectedStatus} expected, actual=${response.status}`);
    return response.payload;
  }

  addPass(options.check, `HTTP ${response.status}`);
  options.validate?.(response.payload, options.check);
  return response.payload;
}

function getClientFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.client)) {
    return null;
  }
  return payload.client;
}

export async function runGeneratedAdminApiSmoke(
  options: GeneratedAdminApiSmokeOptions
): Promise<GeneratedAdminApiSmokeResult> {
  const target = await resolveGeneratedSmokeTarget(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
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
  const tenantId = target.tenantId;

  try {
    const checks: SmokeCheck[] = [];
    const smokeRunId = Date.now();
    const clientName = `Generated Admin Smoke Client ${smokeRunId}`;
    const updatedDescription = `Generated environment validation smoke ${smokeRunId}`;
    let createdClientId = '';

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
    checks.push(finalizeCheck(statsCheck, 'admin stats endpoint verified'));

    const clientsListCheck = makeSmokeCheck(
      'admin-clients-list',
      'admin clients list',
      `${target.baseUrl}/api/admin/clients`
    );
    await runAdminJsonRequest({
      check: clientsListCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/clients',
      adminSecret,
      tenantId,
      timeoutMs,
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'admin clients list')) {
          return;
        }
        if (!Array.isArray((payload as Record<string, unknown>).clients)) {
          addFail(check, 'clients is not an array');
        }
      },
    });
    checks.push(finalizeCheck(clientsListCheck, 'admin clients list verified'));

    const clientCreateCheck = makeSmokeCheck(
      'admin-client-create',
      'admin client create',
      `${target.baseUrl}/api/admin/clients`
    );
    await runAdminJsonRequest({
      check: clientCreateCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/clients',
      method: 'POST',
      adminSecret,
      tenantId,
      timeoutMs,
      expectedStatus: 201,
      body: {
        client_name: clientName,
        description: 'Generated environment validation smoke client',
        redirect_uris: ['https://example.invalid/authrim/generated-admin-smoke/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
        require_pkce: true,
      },
      validate: (payload, check) => {
        if (!validateJsonObject(check, payload, 'admin client create response')) {
          return;
        }
        const client = getClientFromPayload(payload);
        const clientId = typeof client?.client_id === 'string' ? client.client_id : '';
        if (!clientId) {
          addFail(check, 'client.client_id was not returned');
          return;
        }
        createdClientId = clientId;
        addPass(check, `client_id=${createdClientId}`);
      },
    });
    checks.push(finalizeCheck(clientCreateCheck, 'admin client create verified'));

    if (createdClientId) {
      const clientGetCheck = makeSmokeCheck(
        'admin-client-get',
        'admin client get',
        `${target.baseUrl}/api/admin/clients/${encodeURIComponent(createdClientId)}`
      );
      await runAdminJsonRequest({
        check: clientGetCheck,
        baseUrl: target.baseUrl,
        path: `/api/admin/clients/${encodeURIComponent(createdClientId)}`,
        adminSecret,
        tenantId,
        timeoutMs,
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'admin client get response')) {
            return;
          }
          const client = getClientFromPayload(payload);
          if (client?.client_id !== createdClientId) {
            addFail(check, `client_id expected=${createdClientId}`);
          }
        },
      });
      checks.push(finalizeCheck(clientGetCheck, 'admin client get verified'));

      const clientUpdateCheck = makeSmokeCheck(
        'admin-client-update',
        'admin client update',
        `${target.baseUrl}/api/admin/clients/${encodeURIComponent(createdClientId)}`
      );
      await runAdminJsonRequest({
        check: clientUpdateCheck,
        baseUrl: target.baseUrl,
        path: `/api/admin/clients/${encodeURIComponent(createdClientId)}`,
        method: 'PUT',
        adminSecret,
        tenantId,
        timeoutMs,
        body: {
          description: updatedDescription,
        },
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'admin client update response')) {
            return;
          }
          const client = getClientFromPayload(payload);
          if (client?.description !== updatedDescription) {
            addFail(check, `description expected=${updatedDescription}`);
          }
        },
      });
      checks.push(finalizeCheck(clientUpdateCheck, 'admin client update verified'));

      const clientDeleteCheck = makeSmokeCheck(
        'admin-client-delete',
        'admin client delete',
        `${target.baseUrl}/api/admin/clients/${encodeURIComponent(createdClientId)}`
      );
      await runAdminJsonRequest({
        check: clientDeleteCheck,
        baseUrl: target.baseUrl,
        path: `/api/admin/clients/${encodeURIComponent(createdClientId)}`,
        method: 'DELETE',
        adminSecret,
        tenantId,
        timeoutMs,
        validate: (payload, check) => {
          if (!validateJsonObject(check, payload, 'admin client delete response')) {
            return;
          }
          if ((payload as Record<string, unknown>).success !== true) {
            addFail(check, 'success=true was expected');
          }
        },
      });
      checks.push(finalizeCheck(clientDeleteCheck, 'admin client delete verified'));
    }

    return {
      ok: isSmokeSuccessful(checks),
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      adminSecretPath,
      checks,
    };
  } finally {
    await adminAccess.cleanup?.();
  }
}
