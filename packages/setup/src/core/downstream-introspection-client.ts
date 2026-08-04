import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  fetchWithTimeout,
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
} from './http-limits.js';
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
  retryDelayMs?: number;
  maxRetries?: number;
}

export interface DownstreamIntrospectionClientResult {
  success: boolean;
  clientId?: string;
  clientSecret?: string;
  alreadyExists?: boolean;
  rotatedSecret?: boolean;
  error?: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    normalized.includes('connection reset') ||
    normalized.includes('econnreset') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again') ||
    normalized.includes('network connection lost')
  );
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
  tenantId?: string
): Promise<{ clientId: string; needsDescriptionUpdate: boolean } | null> {
  const response = await fetchWithTimeout(
    `${apiBaseUrl}/api/admin/clients?search=${encodeURIComponent(DOWNSTREAM_INTROSPECTION_CLIENT_NAME)}&limit=10`,
    {
      method: 'GET',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
    }
  );

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(
      `Failed to check downstream introspection client (${response.status}): ${errorBody}`
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
  tenantId?: string
): Promise<void> {
  const response = await fetchWithTimeout(
    `${apiBaseUrl}/api/admin/clients/${encodeURIComponent(clientId)}`,
    {
      method: 'PUT',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
      body: JSON.stringify({
        description: DOWNSTREAM_INTROSPECTION_CLIENT_DESCRIPTION,
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(
      `Failed to update downstream introspection client description (${response.status}): ${errorBody}`
    );
  }
}

async function getClientById(
  apiBaseUrl: string,
  adminBearerToken: string,
  clientId: string,
  tenantId?: string
): Promise<boolean> {
  const response = await fetchWithTimeout(
    `${apiBaseUrl}/api/admin/clients/${encodeURIComponent(clientId)}`,
    {
      method: 'GET',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
    }
  );

  if (response.status === 404) {
    return false;
  }

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(
      `Failed to read downstream introspection client (${response.status}): ${errorBody}`
    );
  }

  return true;
}

async function regenerateClientSecret(
  apiBaseUrl: string,
  adminBearerToken: string,
  clientId: string,
  tenantId?: string
): Promise<string> {
  const response = await fetchWithTimeout(
    `${apiBaseUrl}/api/admin/clients/${encodeURIComponent(clientId)}/regenerate-secret`,
    {
      method: 'POST',
      headers: buildAdminHeaders(adminBearerToken, tenantId),
      body: JSON.stringify({ revoke_existing_tokens: false }),
    }
  );

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(
      `Failed to regenerate downstream introspection client secret (${response.status}): ${errorBody}`
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
  idempotencyKey: string
): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const response = await fetchWithTimeout(`${apiBaseUrl}/api/admin/clients`, {
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
  });

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(
      `Failed to create downstream introspection client (${response.status}): ${errorBody}`
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
    retryDelayMs = DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_BASE_DELAY_MS,
    maxRetries = DOWNSTREAM_INTROSPECTION_CLIENT_MAX_RETRIES,
  } = input;

  try {
    let adminBearerToken: string | null = providedAdminBearerToken?.trim() || null;
    const createIdempotencyKey = `setup-downstream-client-${randomBytes(18).toString('base64url')}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (!adminBearerToken) {
          if (setupMachineKeyFilesExist(keysDir)) {
            onProgress?.('Requesting Admin API access token with setup machine private_key_jwt');
            adminBearerToken = (
              await requestAdminMachineAccessToken({
                apiBaseUrl,
                keysDir,
                tenantId,
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
            tenantId
          ).catch(() => false);
          if (exists) {
            onProgress?.(`Downstream introspection client exists: ${stored.clientId}`);
            return {
              success: true,
              clientId: stored.clientId,
              clientSecret: stored.clientSecret,
              alreadyExists: true,
            };
          }
        }

        const existing = await findClientByName(apiBaseUrl, adminBearerToken, tenantId);

        if (existing) {
          if (existing.needsDescriptionUpdate) {
            await updateClientDescription(
              apiBaseUrl,
              adminBearerToken,
              existing.clientId,
              tenantId
            );
          }
          onProgress?.(`Regenerating downstream introspection client secret: ${existing.clientId}`);
          const clientSecret = await regenerateClientSecret(
            apiBaseUrl,
            adminBearerToken,
            existing.clientId,
            tenantId
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
          createIdempotencyKey
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
        const shouldRetry =
          attempt < maxRetries && isRetryableDownstreamIntrospectionError(message);

        if (!shouldRetry) {
          return {
            success: false,
            error: message,
          };
        }

        adminBearerToken = providedAdminBearerToken?.trim() || null;
        const delayMs = Math.min(
          retryDelayMs * attempt,
          DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_MAX_DELAY_MS
        );
        onProgress?.(
          `Downstream introspection client request hit a temporary router readiness error (${message}). Retrying in ${Math.ceil(delayMs / 1000)}s...`
        );
        await sleep(delayMs);
      }
    }

    return {
      success: false,
      error:
        'Downstream introspection client setup timed out while waiting for the router to become reachable',
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
