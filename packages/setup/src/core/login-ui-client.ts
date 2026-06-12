/**
 * Login UI Client Auto-Creation Module
 *
 * Creates an OAuth client for the Login UI during deployment.
 * The Login UI needs its own client_id for SDK integration and
 * OAuth callback handling.
 *
 * Flow:
 * 1. After workers are deployed, Admin API is available
 * 2. Request a short-lived setup machine Admin token when setup machine keys exist
 * 3. Check if Login UI client already exists
 * 4. Create client via POST /api/admin/clients with Bearer token
 * 5. Return client_id for inclusion in ui.env
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  fetchWithTimeout,
  readResponseJsonWithLimit,
  readResponseTextWithLimit,
} from './http-limits.js';
import { buildBrowserClientMetadata } from './browser-client-metadata.js';
import {
  requestAdminMachineAccessToken,
  setupMachineKeyFilesExist,
} from './admin-machine-access.js';

// =============================================================================
// Types
// =============================================================================

export interface LoginUiClientConfig {
  /** API base URL (e.g., https://prod-ar-router.workers.dev) */
  apiBaseUrl: string;
  /**
   * Candidate API base URLs for tenant-scoped setup/admin calls.
   * The first reachable candidate that can issue a setup machine token and
   * serve Admin API requests is used for this provisioning operation.
   */
  apiBaseUrls?: string[];
  /** Login UI URL (e.g., https://prod-ar-login-ui.workers.dev) */
  loginUiUrl: string;
  /**
   * Path to admin_api_secret.txt.
   * Used only as a legacy fallback when setup machine keys are absent.
   */
  adminApiSecretPath?: string;
  /** Directory containing setup machine keys. Defaults to dirname(adminApiSecretPath). */
  keysDir?: string;
  /** Progress callback */
  onProgress?: (message: string) => void;
  /** Optional tenant ID for tenant-scoped admin APIs */
  tenantId?: string;
  /** Retry delay override for tests/debugging */
  retryDelayMs?: number;
  /** Retry count override for tests/debugging */
  maxRetries?: number;
}

export interface LoginUiClientResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The client_id of the Login UI client */
  clientId?: string;
  /** Whether the client already existed */
  alreadyExists?: boolean;
  /** Error message if failed */
  error?: string;
}

export function shouldReportLoginUiClientWarning(error?: string | null): boolean {
  const normalized = String(error || '')
    .trim()
    .toLowerCase();
  return normalized.length > 0 && !normalized.includes('fetch failed');
}

const LOGIN_UI_CLIENT_MAX_RETRIES = 8;
const LOGIN_UI_CLIENT_RETRY_BASE_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLoginUiClientError(error?: string | null): boolean {
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

interface AdminClientListResponse {
  clients: Array<{
    client_id: string;
    client_name: string;
    redirect_uris: string[];
    grant_types: string[];
    is_trusted?: boolean;
    skip_consent?: boolean;
    description?: string | null;
    token_endpoint_auth_method?: string;
    require_pkce?: boolean;
    browser_public_client_mode?: string;
    browser_refresh_token_policy?: string;
  }>;
  pagination: {
    total: number;
  };
}

interface AdminClientCreateResponse {
  client: {
    client_id: string;
    client_name: string;
    client_secret?: string;
  };
}

function normalizeApiBaseUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function buildApiBaseUrlCandidates(primary: string, candidates?: string[]): string[] {
  const seen = new Set<string>();
  return [primary, ...(candidates ?? [])].reduce<string[]>((list, candidate) => {
    const normalized = normalizeApiBaseUrl(candidate);
    if (!normalized || seen.has(normalized)) {
      return list;
    }
    seen.add(normalized);
    list.push(normalized);
    return list;
  }, []);
}

// =============================================================================
// Constants
// =============================================================================

/** Client name used for the Login UI */
const LOGIN_UI_CLIENT_NAME = 'Login UI';
const LOGIN_UI_CLIENT_DESCRIPTION =
  'System-managed public OAuth client used by the built-in Authrim Login UI.';

// =============================================================================
// Implementation
// =============================================================================

/**
 * Build the redirect URIs for the Login UI client
 */
function buildRedirectUris(loginUiUrl: string): string[] {
  // Remove trailing slash
  const baseUrl = loginUiUrl.replace(/\/$/, '');

  return [
    `${baseUrl}/callback`,
    `${baseUrl}/reauth/callback`,
    `${baseUrl}/device/callback`,
    `${baseUrl}/ciba/callback`,
  ];
}

/**
 * Read the legacy admin API secret from the keys directory.
 */
async function readAdminApiSecret(secretPath: string): Promise<string> {
  if (!existsSync(secretPath)) {
    throw new Error(`Admin API secret not found: ${secretPath}`);
  }
  const secret = await readFile(secretPath, 'utf-8');
  return secret.trim();
}

async function resolveAdminBearerToken(options: {
  apiBaseUrl: string;
  adminApiSecretPath?: string;
  keysDir?: string;
  tenantId?: string;
  onProgress?: (message: string) => void;
}): Promise<string> {
  const keysDir =
    options.keysDir ??
    (options.adminApiSecretPath ? dirname(options.adminApiSecretPath) : undefined);

  if (keysDir && setupMachineKeyFilesExist(keysDir)) {
    options.onProgress?.('Requesting setup machine Admin token...');
    const token = await requestAdminMachineAccessToken({
      apiBaseUrl: options.apiBaseUrl,
      keysDir,
      tenantId: options.tenantId,
    });
    return token.accessToken;
  }

  if (!options.adminApiSecretPath) {
    throw new Error(
      'Admin API credential not found: setup machine keys or admin_api_secret.txt required'
    );
  }

  options.onProgress?.('Reading legacy admin API secret...');
  return readAdminApiSecret(options.adminApiSecretPath);
}

interface ExistingClientInfo {
  clientId: string;
  needsMigration: boolean;
}

/**
 * Check if a Login UI client already exists.
 * Returns client_id and whether migration to public client is needed.
 */
async function findExistingClient(
  apiBaseUrl: string,
  adminSecret: string,
  tenantId?: string
): Promise<ExistingClientInfo | null> {
  const response = await fetchWithTimeout(
    `${apiBaseUrl}/api/admin/clients?search=${encodeURIComponent(LOGIN_UI_CLIENT_NAME)}&limit=10`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${adminSecret}`,
        Accept: 'application/json',
        ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
      },
    }
  );

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(`Failed to check Login UI client (${response.status}): ${errorBody}`);
  }

  const data = await readResponseJsonWithLimit<AdminClientListResponse>(response);
  const existing = data.clients?.find(
    (c) => c.client_name === LOGIN_UI_CLIENT_NAME && c.is_trusted === true
  );

  if (!existing) return null;

  return {
    clientId: existing.client_id,
    needsMigration:
      existing.token_endpoint_auth_method !== 'none' ||
      existing.require_pkce !== true ||
      existing.browser_refresh_token_policy !== 'disabled' ||
      existing.description !== LOGIN_UI_CLIENT_DESCRIPTION,
  };
}

/**
 * Update an existing Login UI client to use public client configuration.
 * Migrates from client_secret_basic to none + require_pkce.
 */
async function updateClientToPublic(
  apiBaseUrl: string,
  adminSecret: string,
  clientId: string,
  tenantId?: string
): Promise<void> {
  const response = await fetchWithTimeout(`${apiBaseUrl}/api/admin/clients/${clientId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify({
      description: LOGIN_UI_CLIENT_DESCRIPTION,
      token_endpoint_auth_method: 'none',
      require_pkce: true,
      browser_public_client_mode: 'cookie_fallback',
      browser_refresh_token_policy: 'disabled',
    }),
  });

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(
      `Failed to update Login UI client to public client (${response.status}): ${errorBody}`
    );
  }
}

/**
 * Create a new Login UI client via Admin API
 */
async function createClient(
  apiBaseUrl: string,
  adminSecret: string,
  loginUiUrl: string,
  tenantId?: string
): Promise<string> {
  const redirectUris = buildRedirectUris(loginUiUrl);

  const response = await fetchWithTimeout(`${apiBaseUrl}/api/admin/clients`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify(
      buildBrowserClientMetadata({
        clientName: LOGIN_UI_CLIENT_NAME,
        description: LOGIN_UI_CLIENT_DESCRIPTION,
        redirectUris,
        sessionProfile: 'managed_browser_session',
      })
    ),
  });

  if (!response.ok) {
    const errorBody = await readResponseTextWithLimit(response).catch(() => 'Unknown error');
    throw new Error(`Failed to create Login UI client (${response.status}): ${errorBody}`);
  }

  const data = await readResponseJsonWithLimit<AdminClientCreateResponse>(response);
  return data.client.client_id;
}

/**
 * Ensure a Login UI OAuth client exists, creating one if necessary.
 *
 * This is idempotent: if a client named "Login UI" with is_trusted=true
 * already exists, its client_id is returned without creating a new one.
 */
export async function ensureLoginUiClient(
  config: LoginUiClientConfig
): Promise<LoginUiClientResult> {
  const {
    apiBaseUrl,
    apiBaseUrls,
    loginUiUrl,
    adminApiSecretPath,
    keysDir,
    onProgress,
    tenantId,
    retryDelayMs = LOGIN_UI_CLIENT_RETRY_BASE_DELAY_MS,
    maxRetries = LOGIN_UI_CLIENT_MAX_RETRIES,
  } = config;
  const apiCandidates = buildApiBaseUrlCandidates(apiBaseUrl, apiBaseUrls);

  try {
    const adminBearerTokens = new Map<string, string>();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let retryableError: string | null = null;
      let lastError: string | null = null;

      for (const candidateApiBaseUrl of apiCandidates) {
        try {
          let adminBearerToken = adminBearerTokens.get(candidateApiBaseUrl);
          if (!adminBearerToken) {
            adminBearerToken = await resolveAdminBearerToken({
              apiBaseUrl: candidateApiBaseUrl,
              adminApiSecretPath,
              keysDir,
              tenantId,
              onProgress,
            });
            adminBearerTokens.set(candidateApiBaseUrl, adminBearerToken);
          }

          onProgress?.('Checking for existing Login UI client...');
          const existingClient = await findExistingClient(
            candidateApiBaseUrl,
            adminBearerToken,
            tenantId
          );

          if (existingClient) {
            if (existingClient.needsMigration) {
              onProgress?.(
                `Migrating Login UI client to public client: ${existingClient.clientId}`
              );
              await updateClientToPublic(
                candidateApiBaseUrl,
                adminBearerToken,
                existingClient.clientId,
                tenantId
              );
              onProgress?.(
                'Login UI client migrated to public client (token_endpoint_auth_method=none, require_pkce=true)'
              );
            } else {
              onProgress?.(`Login UI client already exists: ${existingClient.clientId}`);
            }
            return {
              success: true,
              clientId: existingClient.clientId,
              alreadyExists: true,
            };
          }

          onProgress?.('Creating Login UI OAuth client...');
          const clientId = await createClient(
            candidateApiBaseUrl,
            adminBearerToken,
            loginUiUrl,
            tenantId
          );

          onProgress?.(`Login UI client created: ${clientId}`);
          return {
            success: true,
            clientId,
            alreadyExists: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = apiCandidates.length > 1 ? `${candidateApiBaseUrl}: ${message}` : message;
          adminBearerTokens.delete(candidateApiBaseUrl);

          if (isRetryableLoginUiClientError(message)) {
            retryableError = lastError;
          }
        }
      }

      const shouldRetry = attempt < maxRetries && retryableError !== null;
      if (!shouldRetry) {
        return {
          success: false,
          error: lastError || 'Login UI client creation failed',
        };
      }

      const delayMs = Math.min(retryDelayMs * attempt, 10000);
      onProgress?.(
        `Login UI client request hit a temporary router readiness error. Retrying in ${Math.ceil(delayMs / 1000)}s...`
      );
      await sleep(delayMs);
    }

    return {
      success: false,
      error: 'Login UI client creation timed out while waiting for the router to become reachable',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
    };
  }
}
