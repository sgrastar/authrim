import {
  addFail,
  addPass,
  finalizeCheck,
  fetchJsonWithTimeout,
  isRecord,
  makeSmokeCheck,
  withTenantHeader,
  type SmokeCheck,
} from './generated-smoke-common.js';

export interface GeneratedApprovalSmokeClientOptions {
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  clientId?: string;
  clientSecret?: string;
  defaultAudience: string;
}

export interface ResolvedApprovalSmokeClient {
  clientId?: string;
  clientSecret?: string;
  temporaryClientId?: string;
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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export async function resolveGeneratedApprovalSmokeClient(
  options: GeneratedApprovalSmokeClientOptions
): Promise<ResolvedApprovalSmokeClient> {
  if (options.clientId?.trim() && options.clientSecret?.trim()) {
    const check = makeSmokeCheck(
      'approval-smoke-client-bootstrap',
      'approval smoke service client bootstrap',
      `${options.baseUrl}/api/admin/clients`
    );
    addPass(check, 'provided client credentials を使用します');
    addPass(check, `client_id=${options.clientId.trim()}`);
    return {
      clientId: options.clientId.trim(),
      clientSecret: options.clientSecret.trim(),
      checks: [finalizeCheck(check, 'provided client credentials を確認しました')],
    };
  }

  const check = makeSmokeCheck(
    'approval-smoke-client-bootstrap',
    'approval smoke service client bootstrap',
    `${options.baseUrl}/api/admin/clients`
  );
  const response = await fetchJsonWithTimeout(
    `${options.baseUrl}/api/admin/clients`,
    options.timeoutMs,
    {
      method: 'POST',
      headers: getAdminHeaders(options.adminSecret, options.tenantId),
      body: JSON.stringify({
        client_name: `Approval Smoke Service Client ${Date.now()}`,
        redirect_uris: ['https://approval-smoke.example.invalid/callback'],
        grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
        token_exchange_allowed: true,
        delegation_mode: 'delegation',
        client_credentials_allowed: true,
        allowed_scopes: ['openid', 'profile'],
        default_scope: 'openid profile',
        default_audience: options.defaultAudience,
      }),
    }
  );
  check.httpStatus = response.status;

  if (!response.ok || !isRecord(response.payload)) {
    addFail(
      check,
      `temporary service client create failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
    return {
      checks: [finalizeCheck(check, 'temporary service client create を確認しました')],
    };
  }

  addPass(check, `HTTP ${response.status}`);
  const client = isRecord(response.payload.client) ? response.payload.client : null;
  const clientId = asString(client?.client_id) ?? undefined;
  const clientSecret = asString(client?.client_secret) ?? undefined;

  if (!clientId || !clientSecret) {
    addFail(check, 'temporary service client credentials が response に含まれていませんでした');
    return {
      checks: [finalizeCheck(check, 'temporary service client create を確認しました')],
    };
  }

  addPass(check, `temporary client_id=${clientId}`);
  if (options.clientId?.trim() && !options.clientSecret?.trim()) {
    addPass(
      check,
      `provided client_id=${options.clientId.trim()} は secret 未指定のため使用しません`
    );
  } else {
    addPass(check, 'temporary service client を使用します');
  }

  return {
    clientId,
    clientSecret,
    temporaryClientId: clientId,
    checks: [finalizeCheck(check, 'temporary service client create を確認しました')],
  };
}

export async function cleanupGeneratedApprovalSmokeClient(options: {
  checks: SmokeCheck[];
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  clientId?: string;
}): Promise<void> {
  if (!options.clientId) {
    return;
  }

  const check = makeSmokeCheck(
    'approval-smoke-client-delete',
    'approval smoke service client cleanup',
    `${options.baseUrl}/api/admin/clients/${encodeURIComponent(options.clientId)}`
  );
  const response = await fetchJsonWithTimeout(
    `${options.baseUrl}/api/admin/clients/${encodeURIComponent(options.clientId)}`,
    options.timeoutMs,
    {
      method: 'DELETE',
      headers: getAdminHeaders(options.adminSecret, options.tenantId),
    }
  );
  check.httpStatus = response.status;

  if (response.ok) {
    addPass(check, `HTTP ${response.status}`);
    addPass(check, `client_id=${options.clientId} を cleanup しました`);
  } else if (response.status === 404) {
    addPass(check, `client_id=${options.clientId} は既に存在しません`);
  } else {
    addFail(
      check,
      `DELETE /api/admin/clients/${encodeURIComponent(options.clientId)} failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }

  options.checks.push(finalizeCheck(check, 'approval smoke service client cleanup を実行しました'));
}
