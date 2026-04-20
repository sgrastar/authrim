/**
 * Login UI Client Auto-Creation Module
 *
 * Creates an OAuth client for the Login UI during deployment.
 * The Login UI needs its own client_id for SDK integration and
 * OAuth callback handling.
 *
 * Flow:
 * 1. After workers are deployed, Admin API is available
 * 2. Read ADMIN_API_SECRET from keys directory
 * 3. Check if Login UI client already exists
 * 4. Create client via POST /api/admin/clients with Bearer token
 * 5. Return client_id for inclusion in ui.env
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// =============================================================================
// Types
// =============================================================================

export interface LoginUiClientConfig {
  /** API base URL (e.g., https://prod-ar-router.workers.dev) */
  apiBaseUrl: string;
  /** Login UI URL (e.g., https://prod-ar-login-ui.pages.dev) */
  loginUiUrl: string;
  /** Path to admin_api_secret.txt */
  adminApiSecretPath: string;
  /** Progress callback */
  onProgress?: (message: string) => void;
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

function getRetryDelayMs(attempt: number): number {
  return Math.min(LOGIN_UI_CLIENT_RETRY_BASE_DELAY_MS * attempt, 10000);
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
    token_endpoint_auth_method?: string;
    require_pkce?: boolean;
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

// =============================================================================
// Constants
// =============================================================================

/** Client name used for the Login UI */
const LOGIN_UI_CLIENT_NAME = 'Login UI';

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
 * Read the admin API secret from the keys directory
 */
async function readAdminApiSecret(secretPath: string): Promise<string> {
  if (!existsSync(secretPath)) {
    throw new Error(`Admin API secret not found: ${secretPath}`);
  }
  const secret = await readFile(secretPath, 'utf-8');
  return secret.trim();
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
  adminSecret: string
): Promise<ExistingClientInfo | null> {
  const response = await fetch(
    `${apiBaseUrl}/api/admin/clients?search=${encodeURIComponent(LOGIN_UI_CLIENT_NAME)}&limit=10`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${adminSecret}`,
        Accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    throw new Error(`Failed to check Login UI client (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as AdminClientListResponse;
  const existing = data.clients?.find(
    (c) => c.client_name === LOGIN_UI_CLIENT_NAME && c.is_trusted === true
  );

  if (!existing) return null;

  return {
    clientId: existing.client_id,
    needsMigration:
      existing.token_endpoint_auth_method !== 'none' || existing.require_pkce !== true,
  };
}

/**
 * Update an existing Login UI client to use public client configuration.
 * Migrates from client_secret_basic to none + require_pkce.
 */
async function updateClientToPublic(
  apiBaseUrl: string,
  adminSecret: string,
  clientId: string
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/admin/clients/${clientId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      token_endpoint_auth_method: 'none',
      require_pkce: true,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
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
  loginUiUrl: string
): Promise<string> {
  const redirectUris = buildRedirectUris(loginUiUrl);

  const response = await fetch(`${apiBaseUrl}/api/admin/clients`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminSecret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_name: LOGIN_UI_CLIENT_NAME,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'openid profile email',
      is_trusted: true,
      skip_consent: true,
      token_endpoint_auth_method: 'none',
      require_pkce: true,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    throw new Error(`Failed to create Login UI client (${response.status}): ${errorBody}`);
  }

  const data = (await response.json()) as AdminClientCreateResponse;
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
    loginUiUrl,
    adminApiSecretPath,
    onProgress,
    retryDelayMs = LOGIN_UI_CLIENT_RETRY_BASE_DELAY_MS,
    maxRetries = LOGIN_UI_CLIENT_MAX_RETRIES,
  } = config;

  try {
    // Read admin secret
    onProgress?.('Reading admin API secret...');
    const adminSecret = await readAdminApiSecret(adminApiSecretPath);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        onProgress?.('Checking for existing Login UI client...');
        const existingClient = await findExistingClient(apiBaseUrl, adminSecret);

        if (existingClient) {
          if (existingClient.needsMigration) {
            onProgress?.(`Migrating Login UI client to public client: ${existingClient.clientId}`);
            await updateClientToPublic(apiBaseUrl, adminSecret, existingClient.clientId);
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
        const clientId = await createClient(apiBaseUrl, adminSecret, loginUiUrl);

        onProgress?.(`Login UI client created: ${clientId}`);
        return {
          success: true,
          clientId,
          alreadyExists: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const shouldRetry = attempt < maxRetries && isRetryableLoginUiClientError(message);

        if (!shouldRetry) {
          return {
            success: false,
            error: message,
          };
        }

        const delayMs = Math.min(retryDelayMs * attempt, 10000);
        onProgress?.(
          `Login UI client request hit a temporary router readiness error. Retrying in ${Math.ceil(delayMs / 1000)}s...`
        );
        await sleep(delayMs);
      }
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
