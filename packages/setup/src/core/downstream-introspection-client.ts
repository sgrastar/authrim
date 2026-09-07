import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readResponseJsonWithLimit } from './http-limits.js';
import { fetchWithDnsFallback, getRemainingDeadlineMs } from './dns-aware-fetch.js';
import {
  requestAdminMachineAccessToken,
  setupMachineKeyFilesExist,
} from './admin-machine-access.js';

export interface DownstreamIntrospectionClientConfig {
  apiBaseUrl: string;
  keysDir: string;
  /** Optional short-lived scoped Admin Machine Access token. */
  adminBearerToken?: string;
  tenantId?: string;
  onProgress?: (message: string) => void;
  /** Secret-free provider/router diagnostics for persisted detailed logs only. */
  onDetail?: (message: string) => void;
  retryDelayMs?: number;
  maxRetries?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
  allowPublicDnsFallback?: boolean;
}

export interface DownstreamIntrospectionClientResult {
  success: boolean;
  clientId?: string;
  clientSecret?: string;
  alreadyExists?: boolean;
  rotatedSecret?: boolean;
  error?: string;
  /** Stable, secret-free reason retained when a retry window expires. */
  diagnosticCode?: string;
  /** Whether retrying the same logical operation may succeed. */
  retryable?: boolean;
}

interface AdminClientListResponse {
  clients: Array<{
    client_id: string;
    client_name: string;
    description?: string | null;
  }>;
}

interface AdminClientCreateResponse {
  client: {
    client_id: string;
    client_name: string;
    client_secret?: string;
  };
}

interface AdminClientRegenerateSecretResponse {
  client_id: string;
  client_secret: string;
}

const DOWNSTREAM_INTROSPECTION_CLIENT_NAME = 'Downstream Grant Introspection';
const DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION =
  'System-managed confidential client used by Authrim for downstream grant introspection.';
const CLIENT_ID_FILE = 'downstream_grant_introspection_client_id.txt';
const CLIENT_SECRET_FILE = 'downstream_grant_introspection_client_secret.txt';
const DOWNSTREAM_INTROSPECTION_CLIENT_MAX_RETRIES = 24;
const DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_BASE_DELAY_MS = 2000;
const DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_MAX_DELAY_MS = 15000;
const SAFE_API_ERROR_DIAGNOSTIC = /^[a-z][a-z0-9_:-]{0,127}$/u;

async function safeApiFailureDiagnostic(response: Response): Promise<string | null> {
  const body = await readResponseJsonWithLimit<unknown>(response, 4096).catch(() => null);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    for (const key of ['error_name', 'error', 'error_code'] as const) {
      const value = record[key];
      if (typeof value === 'number' && Number.isSafeInteger(value)) return `error_${value}`;
      if (typeof value !== 'string') continue;
      const normalized = value.trim().toLowerCase().replaceAll(' ', '_');
      if (SAFE_API_ERROR_DIAGNOSTIC.test(normalized)) return normalized;
    }
  }
  if (response.status === 502) return 'bad_gateway';
  if (response.status === 503) return 'service_unavailable';
  if (response.status === 504) return 'gateway_timeout';
  return null;
}

async function apiFailureMessage(label: string, response: Response): Promise<string> {
  const diagnostic = await safeApiFailureDiagnostic(response);
  return `${label} (${response.status})${diagnostic ? `: ${diagnostic}` : ''}`;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timeoutId);
      resolve(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

interface DownstreamIntrospectionHttpOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
  allowPublicDnsFallback?: boolean;
  onDnsFallback?: (message: string) => void;
}

function fetchDownstreamIntrospectionApi(
  input: string | URL,
  init: globalThis.RequestInit,
  options: DownstreamIntrospectionHttpOptions
): Promise<Response> {
  return fetchWithDnsFallback(
    input,
    { ...init, signal: options.signal },
    {
      deadlineAt: options.deadlineAt,
      allowPublicDnsFallback: options.allowPublicDnsFallback,
      onDnsFallback: options.onDnsFallback,
    }
  );
}

function isRetryableDownstreamIntrospectionError(error?: string | null): boolean {
  const normalized = String(error || '')
    .trim()
    .toLowerCase();

  if (!normalized) return false;

  return (
    normalized.includes('fetch failed') ||
    normalized.includes('workers_dev_script_not_found') ||
    normalized.includes('error 1042') ||
    normalized.includes('error 1016') ||
    normalized.includes('origin dns') ||
    normalized.includes('dns error') ||
    normalized.includes('admin_machine_token_failed:530') ||
    normalized.includes('(530)') ||
    normalized.includes('no workers script was found') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('bad gateway') ||
    normalized.includes('service unavailable') ||
    normalized.includes('gateway timeout') ||
    normalized.includes('admin_machine_token_failed:404') ||
    normalized.includes('tenant not found') ||
    normalized.includes('tenant_not_found') ||
    normalized.includes('lookup_registry_snapshot_unavailable') ||
    normalized.includes('missing_snapshot') ||
    normalized.includes('missing_generation') ||
    normalized.includes('connection reset') ||
    normalized.includes('econnreset') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again') ||
    normalized.includes('network connection lost')
  );
}

function toSafeDownstreamIntrospectionDiagnostic(error: string): string {
  const normalized = error.trim().toLowerCase();
  const adminMachineStatus = normalized.match(/admin_machine_token_failed:(\d{3})/u)?.[1];
  if (adminMachineStatus) {
    if (normalized.includes('tenant not found') || normalized.includes('tenant_not_found')) {
      return `admin_machine_token_failed:${adminMachineStatus}:tenant_not_found`;
    }
    if (normalized.includes('workers_dev_script_not_found')) {
      return `admin_machine_token_failed:${adminMachineStatus}:workers_dev_script_not_found`;
    }
    return `admin_machine_token_failed:${adminMachineStatus}`;
  }

  const httpStatus = normalized.match(/\((\d{3})\)/u)?.[1];
  if (httpStatus) {
    if (normalized.includes('tenant_not_found') || normalized.includes('tenant not found')) {
      return `http_${httpStatus}:tenant_not_found`;
    }
    if (normalized.includes('lookup_registry_snapshot_unavailable')) {
      return `http_${httpStatus}:lookup_registry_snapshot_unavailable`;
    }
    if (normalized.includes('workers_dev_script_not_found')) {
      return `http_${httpStatus}:workers_dev_script_not_found`;
    }
    return `http_${httpStatus}`;
  }

  if (
    normalized.includes('fetch failed') ||
    normalized.includes('connection reset') ||
    normalized.includes('econnreset') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again') ||
    normalized.includes('network connection lost')
  ) {
    return 'network_error';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'request_timeout';
  }
  if (normalized.includes('lookup_registry_snapshot_unavailable')) {
    return 'lookup_registry_snapshot_unavailable';
  }
  return 'downstream_introspection_operation_failed';
}

function describeReadinessWait(error: string): string {
  const normalized = error.toLowerCase();
  if (
    normalized.includes('tenant not found') ||
    normalized.includes('admin_machine_token_failed:404')
  ) {
    return 'Waiting for tenant routing to propagate';
  }
  if (
    normalized.includes('lookup_registry_snapshot_unavailable') ||
    normalized.includes('missing_snapshot') ||
    normalized.includes('missing_generation')
  ) {
    return 'Waiting for the runtime directory snapshot to propagate';
  }
  if (normalized.includes('admin_machine_token_failed')) {
    return 'Waiting for setup machine access to become available';
  }
  return 'Waiting for the deployed API route to propagate';
}

function describeOperationError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    const details = [
      typeof record.code === 'string' ? record.code : undefined,
      typeof record.syscall === 'string' ? record.syscall : undefined,
      typeof record.hostname === 'string' ? record.hostname : undefined,
      cause instanceof Error ? cause.message : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    if (details) {
      return `${error.message}: ${details}`;
    }
  }

  return error.message;
}

function getClientIdPath(keysDir: string): string {
  return join(keysDir, CLIENT_ID_FILE);
}

function getClientSecretPath(keysDir: string): string {
  return join(keysDir, CLIENT_SECRET_FILE);
}

function buildAdminHeaders(adminBearerToken: string, tenantId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${adminBearerToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
  };
}

async function findClientByName(
  apiBaseUrl: string,
  adminBearerToken: string,
  tenantId: string | undefined,
  httpOptions: DownstreamIntrospectionHttpOptions
): Promise<{ clientId: string; needsDescriptionUpdate: boolean } | null> {
  const response = await fetchDownstreamIntrospectionApi(
    `${apiBaseUrl}/api/admin/clients?search=${encodeURIComponent(DOWNSTREAM_INTROSPECTION_CLIENT_NAME)}&limit=10`,
    {
      method: 'GET',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
    },
    httpOptions
  );

  if (!response.ok) {
    throw new Error(
      await apiFailureMessage('Failed to check downstream introspection client', response)
    );
  }

  const data = await readResponseJsonWithLimit<AdminClientListResponse>(response);
  const existing = data.clients?.find(
    (client) => client.client_name === DOWNSTREAM_INTROSPECTION_CLIENT_NAME
  );

  if (!existing) {
    return null;
  }

  return {
    clientId: existing.client_id,
    needsDescriptionUpdate: existing.description !== DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION,
  };
}

async function updateClientDescription(
  apiBaseUrl: string,
  adminBearerToken: string,
  clientId: string,
  tenantId: string | undefined,
  httpOptions: DownstreamIntrospectionHttpOptions
): Promise<void> {
  const response = await fetchDownstreamIntrospectionApi(
    `${apiBaseUrl}/api/admin/clients/${encodeURIComponent(clientId)}`,
    {
      method: 'PUT',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
      body: JSON.stringify({
        description: DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION,
      }),
    },
    httpOptions
  );

  if (!response.ok) {
    throw new Error(
      await apiFailureMessage(
        'Failed to update downstream introspection client description',
        response
      )
    );
  }
}

async function getClientById(
  apiBaseUrl: string,
  adminBearerToken: string,
  clientId: string,
  tenantId: string | undefined,
  httpOptions: DownstreamIntrospectionHttpOptions
): Promise<boolean> {
  const response = await fetchDownstreamIntrospectionApi(
    `${apiBaseUrl}/api/admin/clients/${encodeURIComponent(clientId)}`,
    {
      method: 'GET',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
    },
    httpOptions
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    throw new Error(
      await apiFailureMessage('Failed to read downstream introspection client', response)
    );
  }

  return true;
}

async function regenerateClientSecret(
  apiBaseUrl: string,
  adminBearerToken: string,
  clientId: string,
  tenantId: string | undefined,
  httpOptions: DownstreamIntrospectionHttpOptions
): Promise<string> {
  const response = await fetchDownstreamIntrospectionApi(
    `${apiBaseUrl}/api/admin/clients/${encodeURIComponent(clientId)}/regenerate-secret`,
    {
      method: 'POST',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
      body: JSON.stringify({ revoke_existing_tokens: false }),
    },
    httpOptions
  );

  if (!response.ok) {
    throw new Error(
      await apiFailureMessage(
        'Failed to regenerate downstream introspection client secret',
        response
      )
    );
  }

  const data = await readResponseJsonWithLimit<AdminClientRegenerateSecretResponse>(response);
  if (!data.client_secret) {
    throw new Error('Downstream introspection client secret regeneration returned no secret');
  }

  return data.client_secret;
}

async function createClient(
  apiBaseUrl: string,
  adminBearerToken: string,
  tenantId: string | undefined,
  idempotencyKey: string,
  httpOptions: DownstreamIntrospectionHttpOptions
): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const response = await fetchDownstreamIntrospectionApi(
    `${apiBaseUrl}/api/admin/clients`,
    {
      method: 'POST',
      headers: {
        ...buildAdminHeaders(adminBearerToken, tenantId),
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        client_name: DOWNSTREAM_INTROSPECTION_CLIENT_NAME,
        description: DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION,
        application_type: 'service',
        token_endpoint_auth_method: 'client_secret_basic',
        redirect_uris: ['https://downstream-introspection.authrim.invalid/callback'],
        grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
        response_types: ['code'],
        scope: 'openid',
        is_trusted: true,
        skip_consent: true,
        client_credentials_allowed: true,
      }),
    },
    httpOptions
  );

  if (!response.ok) {
    throw new Error(
      await apiFailureMessage('Failed to create downstream introspection client', response)
    );
  }

  const data = await readResponseJsonWithLimit<AdminClientCreateResponse>(response);
  const clientId = data.client?.client_id;
  const clientSecret = data.client?.client_secret;

  if (!clientId || !clientSecret) {
    throw new Error('Downstream introspection client create response missing credentials');
  }

  return {
    clientId,
    clientSecret,
  };
}

async function writeClientCredentials(
  keysDir: string,
  clientId: string,
  clientSecret: string
): Promise<void> {
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  await chmod(keysDir, 0o700);

  const clientIdPath = getClientIdPath(keysDir);
  const clientSecretPath = getClientSecretPath(keysDir);
  await writeFile(clientIdPath, `${clientId}\n`, { encoding: 'utf-8', mode: 0o600 });
  await chmod(clientIdPath, 0o600);
  await writeFile(clientSecretPath, `${clientSecret}\n`, { encoding: 'utf-8', mode: 0o600 });
  await chmod(clientSecretPath, 0o600);
}

async function readStoredCredentials(keysDir: string): Promise<{
  clientId: string | null;
  clientSecret: string | null;
}> {
  const clientIdPath = getClientIdPath(keysDir);
  const clientSecretPath = getClientSecretPath(keysDir);

  const clientId = existsSync(clientIdPath)
    ? (await readFile(clientIdPath, 'utf-8')).trim() || null
    : null;
  const clientSecret = existsSync(clientSecretPath)
    ? (await readFile(clientSecretPath, 'utf-8')).trim() || null
    : null;

  return {
    clientId,
    clientSecret,
  };
}

export async function ensureDownstreamIntrospectionClient(
  input: DownstreamIntrospectionClientConfig
): Promise<DownstreamIntrospectionClientResult> {
  const {
    apiBaseUrl,
    keysDir,
    adminBearerToken: providedAdminBearerToken,
    tenantId,
    onProgress,
    onDetail,
    retryDelayMs = DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_BASE_DELAY_MS,
    maxRetries = DOWNSTREAM_INTROSPECTION_CLIENT_MAX_RETRIES,
    deadlineAt,
    signal,
    allowPublicDnsFallback,
  } = input;

  try {
    const startedAt = Date.now();
    let adminBearerToken: string | null = providedAdminBearerToken?.trim() || null;
    let lastDiagnosticCode: string | undefined;
    const createIdempotencyKey = `setup-downstream-client-${randomBytes(18).toString('base64url')}`;
    const httpOptions: DownstreamIntrospectionHttpOptions = {
      deadlineAt,
      signal,
      allowPublicDnsFallback,
      onDnsFallback: onDetail,
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (getRemainingDeadlineMs(deadlineAt) <= 0 || signal?.aborted) {
        return {
          success: false,
          error: 'optional_integration_deadline_exceeded',
          ...(lastDiagnosticCode ? { diagnosticCode: lastDiagnosticCode, retryable: true } : {}),
        };
      }
      try {
        if (!adminBearerToken) {
          if (setupMachineKeyFilesExist(keysDir)) {
            onProgress?.('Requesting Admin API access token with setup machine private_key_jwt');
            adminBearerToken = (
              await requestAdminMachineAccessToken({
                apiBaseUrl,
                keysDir,
                tenantId,
                deadlineAt,
                signal,
                allowPublicDnsFallback,
                onDnsFallback: onDetail,
              })
            ).accessToken;
          } else {
            return {
              success: false,
              error: `Setup machine keys not found: ${keysDir}`,
            };
          }
        }

        const stored = await readStoredCredentials(keysDir);

        if (stored.clientId && stored.clientSecret) {
          const exists = await getClientById(
            apiBaseUrl,
            adminBearerToken,
            stored.clientId,
            tenantId,
            httpOptions
          ).catch(() => false);
          if (exists) {
            onProgress?.('Downstream introspection client exists');
            return {
              success: true,
              clientId: stored.clientId,
              clientSecret: stored.clientSecret,
              alreadyExists: true,
            };
          }
        }

        const existing = await findClientByName(
          apiBaseUrl,
          adminBearerToken,
          tenantId,
          httpOptions
        );

        if (existing) {
          if (existing.needsDescriptionUpdate) {
            await updateClientDescription(
              apiBaseUrl,
              adminBearerToken,
              existing.clientId,
              tenantId,
              httpOptions
            );
          }
          onProgress?.('Regenerating downstream introspection client secret');
          const clientSecret = await regenerateClientSecret(
            apiBaseUrl,
            adminBearerToken,
            existing.clientId,
            tenantId,
            httpOptions
          );
          await writeClientCredentials(keysDir, existing.clientId, clientSecret);
          return {
            success: true,
            clientId: existing.clientId,
            clientSecret,
            alreadyExists: true,
            rotatedSecret: true,
          };
        }

        onProgress?.('Creating downstream introspection client');
        const created = await createClient(
          apiBaseUrl,
          adminBearerToken,
          tenantId,
          createIdempotencyKey,
          httpOptions
        );
        await writeClientCredentials(keysDir, created.clientId, created.clientSecret);

        return {
          success: true,
          clientId: created.clientId,
          clientSecret: created.clientSecret,
          alreadyExists: false,
          rotatedSecret: false,
        };
      } catch (error) {
        const message = describeOperationError(error);
        const retryable = isRetryableDownstreamIntrospectionError(message);
        lastDiagnosticCode = toSafeDownstreamIntrospectionDiagnostic(message);
        if (getRemainingDeadlineMs(deadlineAt) <= 0 || signal?.aborted) {
          onDetail?.(`Downstream introspection setup deadline reached: ${lastDiagnosticCode}`);
          return {
            success: false,
            error: 'optional_integration_deadline_exceeded',
            diagnosticCode: lastDiagnosticCode,
            retryable,
          };
        }
        const shouldRetry = attempt < maxRetries && retryable;

        if (!shouldRetry) {
          onDetail?.(`Downstream introspection setup failed: ${lastDiagnosticCode}`);
          return {
            success: false,
            error: message.startsWith('admin_machine_token_failed:') ? lastDiagnosticCode : message,
            diagnosticCode: lastDiagnosticCode,
            retryable,
          };
        }

        adminBearerToken = providedAdminBearerToken?.trim() || null;
        const delayMs = Math.min(
          retryDelayMs * attempt,
          DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_MAX_DELAY_MS,
          getRemainingDeadlineMs(deadlineAt)
        );
        const elapsedSeconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000));
        onDetail?.(
          `Downstream introspection readiness attempt ${attempt}/${maxRetries} failed: ${lastDiagnosticCode}`
        );
        onProgress?.(
          `${describeReadinessWait(message)} (${elapsedSeconds}s elapsed, attempt ${attempt}/${maxRetries}). Retrying in ${Math.ceil(delayMs / 1000)}s...`
        );
        if (delayMs <= 0 || !(await sleep(delayMs, signal))) {
          return {
            success: false,
            error: 'optional_integration_deadline_exceeded',
            diagnosticCode: lastDiagnosticCode,
            retryable: true,
          };
        }
      }
    }

    return {
      success: false,
      error:
        'Downstream introspection client setup timed out while waiting for the router to become reachable',
      diagnosticCode: lastDiagnosticCode,
      retryable: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function loadDownstreamIntrospectionClientSecrets(
  keysDir: string
): Promise<Record<
  'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID' | 'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET',
  string
> | null> {
  const clientIdPath = getClientIdPath(keysDir);
  const clientSecretPath = getClientSecretPath(keysDir);

  if (!existsSync(clientIdPath) || !existsSync(clientSecretPath)) {
    return null;
  }

  const clientId = (await readFile(clientIdPath, 'utf-8')).trim();
  const clientSecret = (await readFile(clientSecretPath, 'utf-8')).trim();

  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID: clientId,
    DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET: clientSecret,
  };
}
