import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  adminApiSecretPath?: string;
  keysDir: string;
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
const DOWNSTREAM_INTROSPECTION_CLIENT_MAX_RETRIES = 8;
const DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_BASE_DELAY_MS = 2000;

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
    normalized.includes('no workers script was found') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('bad gateway') ||
    normalized.includes('service unavailable') ||
    normalized.includes('gateway timeout') ||
    normalized.includes('connection reset') ||
    normalized.includes('econnreset') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again')
  );
}

function getClientIdPath(keysDir: string): string {
  return join(keysDir, CLIENT_ID_FILE);
}

function getClientSecretPath(keysDir: string): string {
  return join(keysDir, CLIENT_SECRET_FILE);
}

async function readAdminApiSecret(secretPath: string): Promise<string> {
  const secret = await readFile(secretPath, 'utf-8');
  return secret.trim();
}

function buildAdminHeaders(adminBearerToken: string, tenantId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${adminBearerToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
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
  tenantId?: string
): Promise<{
  clientId: string;
  clientSecret: string;
}> {
  const response = await fetchWithTimeout(`${apiBaseUrl}/api/admin/clients`, {
    method: 'POST',
    headers: buildAdminHeaders(adminBearerToken, tenantId),
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
  await mkdir(keysDir, { recursive: true });
  await writeFile(getClientIdPath(keysDir), `${clientId}\n`, 'utf-8');
  await writeFile(getClientSecretPath(keysDir), `${clientSecret}\n`, 'utf-8');
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
    adminApiSecretPath,
    keysDir,
    tenantId,
    onProgress,
    retryDelayMs = DOWNSTREAM_INTROSPECTION_CLIENT_RETRY_BASE_DELAY_MS,
    maxRetries = DOWNSTREAM_INTROSPECTION_CLIENT_MAX_RETRIES,
  } = input;

  try {
    let adminBearerToken: string;
    if (setupMachineKeyFilesExist(keysDir)) {
      onProgress?.('Requesting Admin API access token with setup machine private_key_jwt');
      adminBearerToken = (
        await requestAdminMachineAccessToken({
          apiBaseUrl,
          keysDir,
          tenantId,
        })
      ).accessToken;
    } else if (adminApiSecretPath && existsSync(adminApiSecretPath)) {
      adminBearerToken = await readAdminApiSecret(adminApiSecretPath);
    } else {
      return {
        success: false,
        error: adminApiSecretPath
          ? `Admin API credential not found: ${adminApiSecretPath}`
          : 'Admin API credential not found',
      };
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

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
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
        const created = await createClient(apiBaseUrl, adminBearerToken, tenantId);
        await writeClientCredentials(keysDir, created.clientId, created.clientSecret);

        return {
          success: true,
          clientId: created.clientId,
          clientSecret: created.clientSecret,
          alreadyExists: false,
          rotatedSecret: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry =
          attempt < maxRetries && isRetryableDownstreamIntrospectionError(message);

        if (!shouldRetry) {
          return {
            success: false,
            error: message,
          };
        }

        const delayMs = Math.min(retryDelayMs * attempt, 10000);
        onProgress?.(
          `Downstream introspection client request hit a temporary router readiness error. Retrying in ${Math.ceil(delayMs / 1000)}s...`
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
