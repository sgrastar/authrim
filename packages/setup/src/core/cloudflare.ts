/**
 * Cloudflare API Integration Module
 *
 * Provides programmatic access to Cloudflare resources via wrangler CLI.
 * Used for provisioning D1 databases, KV namespaces, and other resources.
 */

import { execa, type ExecaError } from 'execa';
import { resolve4, resolve6, resolveCname } from 'node:dns/promises';
import { basename, join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import {
  getD1DatabaseName,
  getKVNamespaceName,
  getQueueName,
  D1_DATABASES,
  KV_NAMESPACES,
} from './naming.js';
import type { AuthrimConfig, D1Location, D1Jurisdiction } from './config.js';
import { getPortableSqlExpressions, renderPortableMigrationSql } from './sql-portability.js';
import {
  buildAdminUiBffMachineAccessBootstrapSql,
  buildSetupMachineAccessCleanupSql,
  buildSetupMachineAccessBootstrapSql,
  deleteSetupMachineKeyFiles,
  ensureSetupMachineKeyFiles,
  loadAdminUiBffPublicJwk,
  loadSetupMachinePublicJwk,
} from './admin-machine-access.js';

const D1_MIGRATION_EXECUTE_TIMEOUT_MS = 180_000;
const D1_MIGRATION_MAX_ATTEMPTS = 4;
const QUEUE_PROVISIONING_DEFINITIONS = [
  { binding: 'AUDIT_QUEUE', nameSuffix: 'audit-queue' },
  { binding: 'LOGGING_DELIVERY_CRITICAL_QUEUE', nameSuffix: 'logging-delivery-critical-queue' },
  { binding: 'LOGGING_DELIVERY_QUEUE', nameSuffix: 'logging-delivery-queue' },
  { binding: 'LOGGING_DELIVERY_BULK_QUEUE', nameSuffix: 'logging-delivery-bulk-queue' },
] as const;

// =============================================================================
// Types
// =============================================================================

export interface CloudflareAuth {
  isLoggedIn: boolean;
  accountId?: string;
  email?: string;
}

export interface D1DatabaseInfo {
  binding: string;
  name: string;
  id: string;
}

export interface KVNamespaceInfo {
  binding: string;
  name: string;
  id: string;
  previewId?: string;
}

export interface QueueInfo {
  binding: string;
  name: string;
  id: string;
}

export interface R2BucketInfo {
  binding: string;
  name: string;
}

export type R2BucketProvisioningState = 'configured' | 'recorded_but_missing' | 'missing';

export interface R2BucketProvisioningStatus extends R2BucketInfo {
  recorded: boolean;
  exists: boolean;
  configured: boolean;
  state: R2BucketProvisioningState;
}

export interface ProvisionedResources {
  d1: D1DatabaseInfo[];
  kv: KVNamespaceInfo[];
  queues: QueueInfo[];
  r2: R2BucketInfo[];
}

/** Options for creating a D1 database with location/jurisdiction */
export interface D1CreateOptions {
  /** D1 location hint - geographic preference */
  location?: D1Location;
  /** D1 jurisdiction - overrides location if set */
  jurisdiction?: D1Jurisdiction;
}

/** Database configuration for provisioning */
export interface DatabaseProvisionConfig {
  core?: D1CreateOptions;
  /** PII database config - also used for admin-db (both contain sensitive data) */
  pii?: D1CreateOptions;
}

export interface ProvisionOptions {
  env: string;
  rootDir?: string;
  createD1?: boolean;
  createKV?: boolean;
  createQueues?: boolean;
  createR2?: boolean;
  runMigrations?: boolean;
  onProgress?: (message: string) => void;
  /** Database location configuration */
  databaseConfig?: DatabaseProvisionConfig;
  /** Runtime profile defaults used for migration layout decisions */
  config?: MigrationProfileConfig;
}

export interface MigrationProfileConfig {
  profiles?: {
    defaults?: {
      storage?: string;
    };
  };
}

export const R2_BUCKETS = [
  { binding: 'AVATARS', suffix: 'authrim-avatars' },
  { binding: 'DIAGNOSTIC_LOGS', suffix: 'diagnostic-logs' },
  { binding: 'AUDIT_ARCHIVE', suffix: 'audit-archive' },
  { binding: 'IMPORT_ARTIFACTS', suffix: 'import-artifacts' },
  { binding: 'EXPORT_ARTIFACTS', suffix: 'export-artifacts' },
  { binding: 'SENSITIVE_DETAILS', suffix: 'sensitive-details' },
] as const;

export type R2BucketBinding = (typeof R2_BUCKETS)[number]['binding'];

export function getR2BucketName(env: string, binding: R2BucketBinding): string {
  const bucket = R2_BUCKETS.find((candidate) => candidate.binding === binding);
  if (!bucket) {
    throw new Error(`Unknown R2 bucket binding: ${binding}`);
  }
  return `${env}-${bucket.suffix}`;
}

export function getRequiredR2Buckets(env: string): R2BucketInfo[] {
  return R2_BUCKETS.map((bucket) => ({
    binding: bucket.binding,
    name: `${env}-${bucket.suffix}`,
  }));
}

export function buildR2BucketProvisioningStatus(
  env: string,
  recordedBuckets: Record<string, { name: string }> | null | undefined,
  cloudflareBucketNames: Iterable<string>
): {
  env: string;
  enabled: boolean;
  required: number;
  configured: number;
  missing: R2BucketProvisioningStatus[];
  buckets: R2BucketProvisioningStatus[];
} {
  const existingNames = new Set(cloudflareBucketNames);
  const buckets = getRequiredR2Buckets(env).map((bucket) => {
    const recordedName = recordedBuckets?.[bucket.binding]?.name;
    const name = recordedName ?? bucket.name;
    const recorded = Boolean(recordedName);
    const exists = existingNames.has(name);
    const configured = recorded && exists;
    const state: R2BucketProvisioningState = recorded
      ? exists
        ? 'configured'
        : 'recorded_but_missing'
      : 'missing';

    return {
      ...bucket,
      name,
      recorded,
      exists,
      configured,
      state,
    };
  });

  return {
    env,
    enabled: buckets.every((bucket) => bucket.configured),
    required: buckets.length,
    configured: buckets.filter((bucket) => bucket.configured).length,
    missing: buckets.filter((bucket) => !bucket.configured),
    buckets,
  };
}

export function shouldMirrorPiiMigrationsToCore(config?: MigrationProfileConfig | null): boolean {
  return config?.profiles?.defaults?.storage === 'builtin:storage:single-db';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Wrangler Wrapper
// =============================================================================

/**
 * Execute a wrangler command
 */
async function wrangler(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
    // Default timeout: 30 seconds (wrangler API calls can be slow)
    const result = await execa('npx', ['wrangler', ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      reject: false,
      timeout: options.timeout ?? 30000,
    });

    if (result.exitCode !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n');
      throw new Error(`Wrangler command failed (${result.exitCode}): ${detail || args.join(' ')}`);
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const execaError = error as ExecaError;
    // Handle timeout specifically
    if (execaError.timedOut) {
      throw new Error(`Wrangler command timed out: ${args.join(' ')}`);
    }
    throw new Error(`Wrangler command failed: ${execaError.message}`);
  }
}

/**
 * Check if wrangler is installed
 */
export async function isWranglerInstalled(): Promise<boolean> {
  try {
    // Use npx to check for wrangler availability
    await execa('npx', ['wrangler', '--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with Cloudflare
 */
export async function checkAuth(): Promise<CloudflareAuth> {
  const apiTokenAuth = async (): Promise<CloudflareAuth | null> => {
    const envToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
    const tokenInfo = envToken
      ? ({ token: envToken, source: 'env' } satisfies CloudflareApiToken)
      : await getCloudflareApiToken();
    if (!tokenInfo?.token) {
      return null;
    }

    if (!(await verifyCloudflareApiToken(tokenInfo.token))) {
      return null;
    }

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;
    return {
      isLoggedIn: true,
      accountId,
      email: tokenInfo.source === 'env' ? 'api-token' : undefined,
    };
  };

  try {
    const { stdout, stderr } = await wrangler(['whoami']);
    const combinedOutput = (stdout + '\n' + stderr).toLowerCase();

    // Check for various "not logged in" patterns (case-insensitive)
    const notLoggedInPatterns = [
      'not logged in',
      'not authenticated',
      'error: not logged',
      '[error] not logged',
      'you are not logged',
      'login as: unknown',
      'unknown user',
    ];

    const isNotLoggedIn = notLoggedInPatterns.some((pattern) => combinedOutput.includes(pattern));

    // Also check for positive login indicators
    const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(stdout);
    const hasLoggedInMessage = stdout.toLowerCase().includes('you are logged in');

    // Parse output to extract account info
    const emailMatch = stdout.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const accountMatch = stdout.match(/([a-f0-9]{32})/);
    const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || undefined;

    // Consider logged in if: no negative patterns AND (has email OR has logged in message)
    const isLoggedIn = !isNotLoggedIn && (hasEmail || hasLoggedInMessage);
    if (!isLoggedIn) {
      const tokenAuth = await apiTokenAuth();
      if (tokenAuth) {
        return tokenAuth;
      }
    }

    return {
      isLoggedIn,
      email: emailMatch?.[1],
      accountId: accountMatch?.[1] ?? envAccountId,
    };
  } catch {
    const tokenAuth = await apiTokenAuth();
    if (tokenAuth) {
      return tokenAuth;
    }
    return { isLoggedIn: false };
  }
}

async function verifyCloudflareApiToken(token: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      return false;
    }

    try {
      const data = (await response.json()) as { success?: boolean };
      return data.success !== false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Get account ID from wrangler
 */
export async function getAccountId(): Promise<string | null> {
  const auth = await checkAuth();
  if (auth.accountId) return auth.accountId;

  // Try to get from wrangler.toml or env
  try {
    const { stdout } = await wrangler(['whoami', '--verbose']);
    const match = stdout.match(/([a-f0-9]{32})/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

// =============================================================================
// Cloudflare API Token
// =============================================================================

export interface CloudflareApiToken {
  token: string;
  source: 'oauth' | 'env';
}

/**
 * Get Cloudflare API token from wrangler config or environment variable.
 * Searches platform-specific paths for OAuth token, falls back to CLOUDFLARE_API_TOKEN env var.
 */
export async function getCloudflareApiToken(): Promise<CloudflareApiToken | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { homedir, platform } = await import('node:os');
    const { join } = await import('node:path');
    const { existsSync } = await import('node:fs');

    // Build list of possible config paths based on platform
    const home = homedir();
    const configPaths: string[] = [];

    if (platform() === 'darwin') {
      configPaths.push(join(home, 'Library/Preferences/.wrangler/config/default.toml'));
      configPaths.push(join(home, '.wrangler/config/default.toml'));
    } else if (platform() === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        configPaths.push(join(appData, 'xdg.config/.wrangler/config/default.toml'));
        configPaths.push(join(appData, '.wrangler/config/default.toml'));
      }
      configPaths.push(join(home, '.wrangler/config/default.toml'));
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        configPaths.push(join(localAppData, 'xdg.config/.wrangler/config/default.toml'));
        configPaths.push(join(localAppData, '.wrangler/config/default.toml'));
      }
    } else {
      const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(home, '.config');
      configPaths.push(join(xdgConfigHome, '.wrangler/config/default.toml'));
      configPaths.push(join(home, '.wrangler/config/default.toml'));
    }

    for (const configPath of configPaths) {
      if (!existsSync(configPath)) continue;
      try {
        const configContent = await readFile(configPath, 'utf-8');
        const tokenMatch = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
        if (tokenMatch?.[1]) {
          return { token: tokenMatch[1], source: 'oauth' };
        }
      } catch {
        // Continue to next path
      }
    }

    // Fallback to CLOUDFLARE_API_TOKEN environment variable
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (apiToken) {
      return { token: apiToken, source: 'env' };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Get the workers.dev subdomain for the account
 * This is needed because workers.dev URLs are: {worker}.{subdomain}.workers.dev
 */
export async function getWorkersSubdomain(): Promise<string | null> {
  try {
    const accountId = await getAccountId();
    if (!accountId) return null;

    const tokenInfo = await getCloudflareApiToken();
    if (!tokenInfo) return null;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
        },
      }
    );

    if (!response.ok) return null;

    const data = (await response.json()) as { result?: { subdomain?: string }; success?: boolean };
    return data.result?.subdomain || null;
  } catch {
    return null;
  }
}

export interface SetupCapabilityDiagnostics {
  wranglerInstalled: boolean;
  loggedIn: boolean;
  tokenAvailable: boolean;
  workersSubdomainAvailable: boolean;
  zoneReadAvailable: boolean;
  accessibleZoneCount: number;
  dnsReadAvailable: boolean;
  uiWorkersApiAvailable: boolean;
}

export interface SetupCapabilityEstimate {
  workersDeploy: boolean;
  customDomain: boolean;
  multiTenant: boolean;
  nakedDomain: boolean;
  pages: boolean;
}

export type SetupCapabilityStatus = 'ok' | 'review' | 'ng';

export interface SetupCapabilityStatuses {
  workersDeploy: SetupCapabilityStatus;
  customDomain: SetupCapabilityStatus;
  multiTenant: SetupCapabilityStatus;
  nakedDomain: SetupCapabilityStatus;
  pages: SetupCapabilityStatus;
}

export function deriveSetupCapabilityEstimate(
  diagnostics: SetupCapabilityDiagnostics
): SetupCapabilityEstimate {
  const workersDeploy = diagnostics.wranglerInstalled && diagnostics.loggedIn;
  const customDomain =
    workersDeploy &&
    diagnostics.tokenAvailable &&
    diagnostics.zoneReadAvailable &&
    diagnostics.accessibleZoneCount > 0;
  const multiTenant = customDomain && diagnostics.dnsReadAvailable;
  const nakedDomain = multiTenant;
  const pages = workersDeploy && diagnostics.tokenAvailable && diagnostics.uiWorkersApiAvailable;

  return {
    workersDeploy,
    customDomain,
    multiTenant,
    nakedDomain,
    pages,
  };
}

export function deriveSetupCapabilityStatuses(
  diagnostics: SetupCapabilityDiagnostics
): SetupCapabilityStatuses {
  const workersDeploy: SetupCapabilityStatus =
    diagnostics.wranglerInstalled && diagnostics.loggedIn ? 'ok' : 'ng';

  let customDomain: SetupCapabilityStatus;
  if (workersDeploy === 'ng') {
    customDomain = 'ng';
  } else if (diagnostics.zoneReadAvailable && diagnostics.accessibleZoneCount > 0) {
    customDomain = 'ok';
  } else if (diagnostics.zoneReadAvailable && diagnostics.accessibleZoneCount === 0) {
    customDomain = 'ng';
  } else {
    customDomain = 'review';
  }

  let multiTenant: SetupCapabilityStatus;
  if (customDomain === 'ng') {
    multiTenant = 'ng';
  } else if (diagnostics.dnsReadAvailable) {
    multiTenant = 'ok';
  } else {
    multiTenant = 'review';
  }

  const nakedDomain: SetupCapabilityStatus =
    multiTenant === 'ok' ? 'ok' : multiTenant === 'review' ? 'review' : 'ng';

  let pages: SetupCapabilityStatus;
  if (workersDeploy === 'ng') {
    pages = 'ng';
  } else if (diagnostics.uiWorkersApiAvailable) {
    pages = 'ok';
  } else {
    pages = 'review';
  }

  return {
    workersDeploy,
    customDomain,
    multiTenant,
    nakedDomain,
    pages,
  };
}

export async function getSetupCapabilityDiagnostics(
  auth: CloudflareAuth,
  wranglerInstalled: boolean,
  workersSubdomain?: string | null
): Promise<SetupCapabilityDiagnostics> {
  const baseDiagnostics: SetupCapabilityDiagnostics = {
    wranglerInstalled,
    loggedIn: auth.isLoggedIn,
    tokenAvailable: false,
    workersSubdomainAvailable: !!workersSubdomain,
    zoneReadAvailable: false,
    accessibleZoneCount: 0,
    dnsReadAvailable: false,
    uiWorkersApiAvailable: false,
  };

  if (!wranglerInstalled || !auth.isLoggedIn) {
    return baseDiagnostics;
  }

  const tokenInfo = await getCloudflareApiToken();
  if (!tokenInfo?.token) {
    return baseDiagnostics;
  }

  baseDiagnostics.tokenAvailable = true;

  try {
    const zoneResponse = await fetch('https://api.cloudflare.com/client/v4/zones?per_page=1', {
      headers: {
        Authorization: `Bearer ${tokenInfo.token}`,
      },
    });

    if (zoneResponse.ok) {
      const zoneData = (await zoneResponse.json()) as {
        success?: boolean;
        result?: Array<{ id?: string }>;
      };
      if (zoneData.success) {
        baseDiagnostics.zoneReadAvailable = true;
        baseDiagnostics.accessibleZoneCount = zoneData.result?.length ?? 0;

        const sampleZoneId = zoneData.result?.[0]?.id;
        if (sampleZoneId) {
          const dnsResponse = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${sampleZoneId}/dns_records?per_page=1`,
            {
              headers: {
                Authorization: `Bearer ${tokenInfo.token}`,
              },
            }
          );
          baseDiagnostics.dnsReadAvailable = dnsResponse.ok;
        }
      }
    }
  } catch {
    // Keep defaults; this is an estimate only.
  }

  if (auth.accountId) {
    try {
      const workersResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/workers/scripts`,
        {
          headers: {
            Authorization: `Bearer ${tokenInfo.token}`,
          },
        }
      );
      baseDiagnostics.uiWorkersApiAvailable = workersResponse.ok;
    } catch {
      // Keep default false; this is an estimate only.
    }
  }

  return baseDiagnostics;
}

// =============================================================================
// Zone Check
// =============================================================================

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
}

export type ZoneCheckDiagnosticCode =
  | 'zone_found'
  | 'not_logged_in'
  | 'token_unavailable'
  | 'zone_read_forbidden'
  | 'zone_not_found'
  | 'api_error'
  | 'network_error';

export type ZoneCheckDiagnosticSeverity = 'success' | 'warning' | 'error';

export type ZoneCheckAction =
  | 'retry_check'
  | 'reload_page'
  | 'run_wrangler_login'
  | 'check_cloudflare_permissions'
  | 'open_cloudflare_dashboard';

export interface ZoneCheckDiagnostic {
  code: ZoneCheckDiagnosticCode;
  severity: ZoneCheckDiagnosticSeverity;
  allowBinding: boolean;
  actions: ZoneCheckAction[];
}

export interface ZoneCheckResult {
  found: boolean;
  zone?: ZoneInfo;
  zoneName?: string;
  error?: string;
  diagnostic?: ZoneCheckDiagnostic;
}

function createZoneDiagnostic(
  code: ZoneCheckDiagnosticCode,
  overrides: Partial<ZoneCheckDiagnostic> = {}
): ZoneCheckDiagnostic {
  const defaults: Record<ZoneCheckDiagnosticCode, ZoneCheckDiagnostic> = {
    zone_found: {
      code: 'zone_found',
      severity: 'success',
      allowBinding: true,
      actions: [],
    },
    not_logged_in: {
      code: 'not_logged_in',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page', 'run_wrangler_login'],
    },
    token_unavailable: {
      code: 'token_unavailable',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page', 'run_wrangler_login'],
    },
    zone_read_forbidden: {
      code: 'zone_read_forbidden',
      severity: 'warning',
      allowBinding: true,
      actions: ['retry_check', 'reload_page', 'run_wrangler_login', 'check_cloudflare_permissions'],
    },
    zone_not_found: {
      code: 'zone_not_found',
      severity: 'warning',
      allowBinding: false,
      actions: ['retry_check', 'open_cloudflare_dashboard'],
    },
    api_error: {
      code: 'api_error',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page'],
    },
    network_error: {
      code: 'network_error',
      severity: 'error',
      allowBinding: false,
      actions: ['retry_check', 'reload_page'],
    },
  };

  return {
    ...defaults[code],
    ...overrides,
    actions: overrides.actions ?? defaults[code].actions,
  };
}

function createZoneCheckResult(
  code: ZoneCheckDiagnosticCode,
  options: {
    found?: boolean;
    zone?: ZoneInfo;
    zoneName?: string;
    error?: string;
  } = {}
): ZoneCheckResult {
  return {
    found: options.found ?? code === 'zone_found',
    zone: options.zone,
    zoneName: options.zoneName,
    error: options.error,
    diagnostic: createZoneDiagnostic(code),
  };
}

export function isZoneReadPermissionError(
  errorOrResult?: string | ZoneCheckResult | ZoneCheckDiagnostic | null
): boolean {
  if (!errorOrResult) {
    return false;
  }
  if (typeof errorOrResult === 'string') {
    return errorOrResult.includes('zone:read');
  }
  if ('diagnostic' in errorOrResult) {
    return (
      errorOrResult.diagnostic?.code === 'zone_read_forbidden' ||
      (errorOrResult.error ?? '').includes('zone:read')
    );
  }
  if ('code' in errorOrResult) {
    return errorOrResult.code === 'zone_read_forbidden';
  }
  return false;
}

/**
 * Extract zone name (registrable domain) from a hostname.
 * e.g., "auth.example.com" → "example.com"
 *       "example.co.jp" → "example.co.jp"
 */
export function extractZoneName(hostname: string): string {
  const parts = hostname.split('.');
  // Comprehensive two-part TLD list based on the Public Suffix List (PSL).
  // Only includes patterns commonly used for web hosting on Cloudflare.
  // Sorted alphabetically by country code.
  const twoPartTlds = new Set([
    // ae - United Arab Emirates
    'ac.ae',
    'co.ae',
    'net.ae',
    'org.ae',
    // ar - Argentina
    'com.ar',
    'net.ar',
    'org.ar',
    // at - Austria
    'co.at',
    'or.at',
    // au - Australia
    'com.au',
    'net.au',
    'org.au',
    // bd - Bangladesh
    'com.bd',
    'net.bd',
    'org.bd',
    // bh - Bahrain
    'com.bh',
    'net.bh',
    'org.bh',
    // bn - Brunei
    'com.bn',
    'net.bn',
    'org.bn',
    // bo - Bolivia
    'com.bo',
    'net.bo',
    'org.bo',
    // br - Brazil
    'com.br',
    'net.br',
    'org.br',
    // bw - Botswana
    'co.bw',
    'org.bw',
    // bz - Belize
    'co.bz',
    'com.bz',
    'net.bz',
    'org.bz',
    // cn - China
    'com.cn',
    'net.cn',
    'org.cn',
    // co - Colombia
    'com.co',
    'net.co',
    'org.co',
    // cr - Costa Rica
    'co.cr',
    'or.cr',
    // cu - Cuba
    'com.cu',
    'net.cu',
    'org.cu',
    // cy - Cyprus
    'com.cy',
    'net.cy',
    'org.cy',
    // do - Dominican Republic
    'com.do',
    'net.do',
    'org.do',
    // dz - Algeria
    'com.dz',
    'net.dz',
    'org.dz',
    // ec - Ecuador
    'com.ec',
    'net.ec',
    'org.ec',
    // eg - Egypt
    'com.eg',
    'net.eg',
    'org.eg',
    // et - Ethiopia
    'com.et',
    'net.et',
    'org.et',
    // fj - Fiji
    'com.fj',
    'net.fj',
    'org.fj',
    // ge - Georgia
    'com.ge',
    'net.ge',
    'org.ge',
    // gh - Ghana
    'com.gh',
    'net.gh',
    'org.gh',
    // gr - Greece
    'com.gr',
    'net.gr',
    'org.gr',
    // gt - Guatemala
    'com.gt',
    'net.gt',
    'org.gt',
    // gy - Guyana
    'co.gy',
    'com.gy',
    'net.gy',
    'org.gy',
    // hk - Hong Kong
    'com.hk',
    'net.hk',
    'org.hk',
    // hn - Honduras
    'com.hn',
    'net.hn',
    'org.hn',
    // hr - Croatia
    'com.hr',
    // id - Indonesia
    'co.id',
    'or.id',
    'web.id',
    'net.id',
    // il - Israel
    'co.il',
    'net.il',
    'org.il',
    // im - Isle of Man
    'co.im',
    'com.im',
    'net.im',
    'org.im',
    // in - India
    'co.in',
    'net.in',
    'org.in',
    // io - British Indian Ocean Territory
    'com.io',
    'net.io',
    'org.io',
    // iq - Iraq
    'com.iq',
    'net.iq',
    'org.iq',
    // ir - Iran
    'co.ir',
    'net.ir',
    'org.ir',
    // je - Jersey
    'co.je',
    'net.je',
    'org.je',
    // jo - Jordan
    'com.jo',
    'net.jo',
    'org.jo',
    // jp - Japan
    'co.jp',
    'ne.jp',
    'or.jp',
    'ac.jp',
    'go.jp',
    'gr.jp',
    'ed.jp',
    'ad.jp',
    'lg.jp',
    // ke - Kenya
    'co.ke',
    'or.ke',
    'ne.ke',
    // kh - Cambodia (uses .com.kh etc.)
    'com.kh',
    'net.kh',
    'org.kh',
    // kr - South Korea
    'co.kr',
    'or.kr',
    'ne.kr',
    // kw - Kuwait
    'com.kw',
    'net.kw',
    'org.kw',
    // kz - Kazakhstan
    'com.kz',
    'net.kz',
    'org.kz',
    // lb - Lebanon
    'com.lb',
    'net.lb',
    'org.lb',
    // lc - Saint Lucia
    'co.lc',
    'com.lc',
    'net.lc',
    'org.lc',
    // lk - Sri Lanka
    'com.lk',
    'net.lk',
    'org.lk',
    // ly - Libya
    'com.ly',
    'net.ly',
    'org.ly',
    // ma - Morocco
    'co.ma',
    'net.ma',
    'org.ma',
    // mm - Myanmar
    'com.mm',
    'net.mm',
    'org.mm',
    // mo - Macau
    'com.mo',
    'net.mo',
    'org.mo',
    // mt - Malta
    'com.mt',
    'net.mt',
    'org.mt',
    // mu - Mauritius
    'co.mu',
    'com.mu',
    'net.mu',
    'org.mu',
    // mv - Maldives
    'com.mv',
    'net.mv',
    'org.mv',
    // mx - Mexico
    'com.mx',
    'net.mx',
    'org.mx',
    // my - Malaysia
    'com.my',
    'net.my',
    'org.my',
    // mz - Mozambique
    'co.mz',
    'net.mz',
    'org.mz',
    // na - Namibia
    'co.na',
    'com.na',
    'net.na',
    'org.na',
    // ng - Nigeria
    'com.ng',
    'net.ng',
    'org.ng',
    // ni - Nicaragua
    'com.ni',
    'net.ni',
    'org.ni',
    // np - Nepal
    'com.np',
    'net.np',
    'org.np',
    // nz - New Zealand
    'co.nz',
    'net.nz',
    'org.nz',
    // om - Oman
    'com.om',
    'net.om',
    'org.om',
    // pa - Panama
    'com.pa',
    'net.pa',
    'org.pa',
    // pe - Peru
    'com.pe',
    'net.pe',
    'org.pe',
    // pg - Papua New Guinea
    'com.pg',
    'net.pg',
    'org.pg',
    // ph - Philippines
    'com.ph',
    'net.ph',
    'org.ph',
    // pk - Pakistan
    'com.pk',
    'net.pk',
    'org.pk',
    // pr - Puerto Rico
    'com.pr',
    'net.pr',
    'org.pr',
    // ps - Palestine
    'com.ps',
    'net.ps',
    'org.ps',
    // pt - Portugal
    'com.pt',
    'net.pt',
    'org.pt',
    // py - Paraguay
    'com.py',
    'net.py',
    'org.py',
    // qa - Qatar
    'com.qa',
    'net.qa',
    'org.qa',
    // ro - Romania
    'com.ro',
    'net.ro',
    'org.ro',
    // rs - Serbia
    'co.rs',
    'org.rs',
    // ru - Russia (ru uses direct TLD, but also has some patterns)
    'com.ru',
    'net.ru',
    'org.ru',
    // rw - Rwanda
    'co.rw',
    'net.rw',
    'org.rw',
    // sa - Saudi Arabia
    'com.sa',
    'net.sa',
    'org.sa',
    // sb - Solomon Islands
    'com.sb',
    'net.sb',
    'org.sb',
    // sc - Seychelles
    'com.sc',
    'net.sc',
    'org.sc',
    // sd - Sudan
    'com.sd',
    'net.sd',
    'org.sd',
    // sg - Singapore
    'com.sg',
    'net.sg',
    'org.sg',
    // sl - Sierra Leone
    'com.sl',
    'net.sl',
    'org.sl',
    // sv - El Salvador
    'com.sv',
    'org.sv',
    // sy - Syria
    'com.sy',
    'net.sy',
    'org.sy',
    // th - Thailand
    'co.th',
    'in.th',
    'ac.th',
    'or.th',
    'net.th',
    // tn - Tunisia
    'com.tn',
    'net.tn',
    'org.tn',
    // tr - Turkey
    'com.tr',
    'net.tr',
    'org.tr',
    // tt - Trinidad and Tobago
    'co.tt',
    'com.tt',
    'net.tt',
    'org.tt',
    // tw - Taiwan
    'com.tw',
    'net.tw',
    'org.tw',
    // tz - Tanzania
    'co.tz',
    'or.tz',
    'ne.tz',
    // ua - Ukraine
    'com.ua',
    'net.ua',
    'org.ua',
    // ug - Uganda
    'co.ug',
    'or.ug',
    'ne.ug',
    // uk - United Kingdom
    'co.uk',
    'org.uk',
    'me.uk',
    'net.uk',
    // uy - Uruguay
    'com.uy',
    'net.uy',
    'org.uy',
    // uz - Uzbekistan
    'co.uz',
    'com.uz',
    'net.uz',
    'org.uz',
    // vc - Saint Vincent and the Grenadines
    'com.vc',
    'net.vc',
    'org.vc',
    // ve - Venezuela
    'co.ve',
    'com.ve',
    'net.ve',
    'org.ve',
    // vn - Vietnam
    'com.vn',
    'net.vn',
    'org.vn',
    // za - South Africa
    'co.za',
    'net.za',
    'org.za',
    // zm - Zambia
    'co.zm',
    'com.zm',
    'net.zm',
    'org.zm',
    // zw - Zimbabwe
    'co.zw',
    'org.zw',
  ]);
  const lastTwo = parts.slice(-2).join('.');
  if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
}

/**
 * Check if a Cloudflare zone exists for the given domain.
 * Gracefully handles authentication failures and network errors.
 */
export async function checkZoneExists(domain: string): Promise<ZoneCheckResult> {
  try {
    const zoneName = extractZoneName(domain);
    const tokenInfo = await getCloudflareApiToken();
    if (!tokenInfo) {
      const auth = await checkAuth();
      if (!auth.isLoggedIn) {
        return createZoneCheckResult('not_logged_in', {
          zoneName,
          error: 'Not logged in to Cloudflare (run: wrangler login)',
        });
      }
      return createZoneCheckResult('token_unavailable', {
        zoneName,
        error: 'Cloudflare API token is unavailable',
      });
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}`,
      {
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
        },
      }
    );

    if (!response.ok) {
      if (response.status === 403) {
        return createZoneCheckResult('zone_read_forbidden', {
          zoneName,
          error: 'Token lacks zone:read permission',
        });
      }
      return createZoneCheckResult('api_error', {
        zoneName,
        error: `Cloudflare API returned ${response.status}`,
      });
    }

    const data = (await response.json()) as {
      success: boolean;
      result: Array<{ id: string; name: string; status: string }>;
      errors?: CloudflareApiMessage[];
    };

    if (!data.success) {
      const apiMessage = data.errors?.find((item) => item.message)?.message;
      return createZoneCheckResult('api_error', {
        zoneName,
        error: apiMessage || 'Cloudflare API returned an unsuccessful response',
      });
    }

    if (!data.result || data.result.length === 0) {
      return createZoneCheckResult('zone_not_found', { zoneName });
    }

    const zone = data.result[0];
    return createZoneCheckResult('zone_found', {
      found: true,
      zone: { id: zone.id, name: zone.name, status: zone.status },
      zoneName,
    });
  } catch (error) {
    return createZoneCheckResult('network_error', {
      zoneName: extractZoneName(domain),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export interface EnsureWildcardDnsResult {
  created: boolean;
  updated: boolean;
  recordId?: string;
  name: string;
  target: string;
  verificationLimited?: boolean;
}

interface CloudflareApiMessage {
  code?: number;
  message?: string;
}

interface CloudflareDnsRecordResponse {
  success?: boolean;
  result?: Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
  }>;
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

interface CloudflareDnsMutationResponse {
  success?: boolean;
  result?: { id?: string };
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

interface CloudflareR2ObjectListResponse {
  success?: boolean;
  result?: Array<{ key?: string }>;
  result_info?: {
    cursor?: string;
    is_truncated?: boolean;
  };
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

interface CloudflareAccountsResponse {
  success?: boolean;
  result?: Array<{ id?: string }>;
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}

function hasCloudflareAlreadyExistsError(payload: {
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}): boolean {
  const entries = [...(payload.errors ?? []), ...(payload.messages ?? [])];
  return entries.some(
    (entry) =>
      entry.code === 81057 || entry.code === 81058 || /already exists/i.test(entry.message ?? '')
  );
}

/**
 * Ensure a proxied wildcard DNS record exists for tenant subdomains.
 *
 * Creates or updates `*.{baseDomain}` as a proxied CNAME pointing to `{baseDomain}`.
 * This allows wildcard tenant hosts to resolve through Cloudflare so Worker routes can match.
 */
export async function ensureWildcardDnsRecord(
  baseDomain: string,
  zoneId?: string | null
): Promise<EnsureWildcardDnsResult> {
  const tokenInfo = await getCloudflareApiToken();
  if (!tokenInfo) {
    throw new Error('Not logged in to Cloudflare (run: wrangler login)');
  }

  const recordName = `*.${baseDomain}`;
  const recordTarget = baseDomain;

  let resolvedZoneId = zoneId || undefined;
  if (!resolvedZoneId) {
    const zoneResult = await checkZoneExists(baseDomain);
    if (!zoneResult.found || !zoneResult.zone?.id) {
      if (zoneResult.diagnostic?.code === 'zone_read_forbidden') {
        return {
          created: false,
          updated: false,
          name: recordName,
          target: recordTarget,
          verificationLimited: true,
        };
      }
      throw new Error(`Cloudflare zone not found for ${baseDomain}`);
    }
    resolvedZoneId = zoneResult.zone.id;
  }

  const recordResponse = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records?name=${encodeURIComponent(recordName)}`,
    {
      headers: {
        Authorization: `Bearer ${tokenInfo.token}`,
      },
    }
  );

  const payload = {
    type: 'CNAME',
    name: recordName,
    content: recordTarget,
    proxied: true,
    ttl: 1,
  };

  const createWildcardRecord = async (
    assumeExistingOnForbidden: boolean
  ): Promise<EnsureWildcardDnsResult> => {
    const createResponse = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    const createdData = (await createResponse
      .json()
      .catch(() => ({}))) as CloudflareDnsMutationResponse;

    if (!createResponse.ok || createdData.success === false) {
      if (hasCloudflareAlreadyExistsError(createdData) || createResponse.status === 409) {
        return {
          created: false,
          updated: false,
          name: recordName,
          target: recordTarget,
        };
      }

      if (createResponse.status === 403) {
        if (assumeExistingOnForbidden) {
          return {
            created: false,
            updated: false,
            name: recordName,
            target: recordTarget,
            verificationLimited: true,
          };
        }
        throw new Error('Token lacks dns:edit permission to create wildcard DNS record');
      }

      throw new Error(`Failed to create wildcard DNS record (${createResponse.status})`);
    }

    return {
      created: true,
      updated: false,
      recordId: createdData.result?.id,
      name: recordName,
      target: recordTarget,
    };
  };

  if (!recordResponse.ok) {
    if (recordResponse.status === 403) {
      return createWildcardRecord(true);
    }
    throw new Error(`Failed to query DNS records (${recordResponse.status})`);
  }

  const recordData = (await recordResponse.json()) as CloudflareDnsRecordResponse;

  if (!recordData.success) {
    throw new Error('Cloudflare DNS query failed');
  }

  const existingRecord = recordData.result?.find((record) => record.name === recordName);

  if (existingRecord) {
    if (existingRecord.content === recordTarget && existingRecord.proxied === true) {
      return {
        created: false,
        updated: false,
        recordId: existingRecord.id,
        name: recordName,
        target: recordTarget,
      };
    }

    const updateResponse = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${resolvedZoneId}/dns_records/${existingRecord.id}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenInfo.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!updateResponse.ok) {
      throw new Error(`Failed to update wildcard DNS record (${updateResponse.status})`);
    }

    return {
      created: false,
      updated: true,
      recordId: existingRecord.id,
      name: recordName,
      target: recordTarget,
    };
  }

  return createWildcardRecord(false);
}

export async function ensureWildcardDnsForMultiTenant(
  cfg: Partial<AuthrimConfig> | null | undefined,
  onProgress?: (message: string) => void,
  verifyPublicDns: (baseDomain: string) => Promise<boolean> = verifyWildcardDnsPublicResolution
): Promise<void> {
  const baseDomain = cfg?.tenant?.multiTenant === true ? cfg.tenant.baseDomain?.trim() : undefined;
  if (!baseDomain) {
    return;
  }

  onProgress?.(`Ensuring wildcard DNS for *.${baseDomain}...`);

  const result = await ensureWildcardDnsRecord(baseDomain, cfg?.urls?.api?.zoneId ?? null);
  if (result.created) {
    onProgress?.(`✓ Wildcard DNS created: ${result.name} -> ${result.target}`);
  } else if (result.updated) {
    onProgress?.(`✓ Wildcard DNS updated: ${result.name} -> ${result.target}`);
  } else if (result.verificationLimited) {
    if (await verifyPublicDns(baseDomain)) {
      onProgress?.(`✓ Wildcard DNS resolves publicly: ${result.name} -> ${result.target}`);
      return;
    }
    throw new Error(
      `Token lacks zone:read or dns:edit permission to verify/create wildcard DNS record for ${result.name}`
    );
  } else {
    onProgress?.(`✓ Wildcard DNS already present: ${result.name} -> ${result.target}`);
  }
}

export async function verifyWildcardDnsPublicResolution(baseDomain: string): Promise<boolean> {
  const hostname = `authrim-wildcard-check-${Date.now()}.${baseDomain}`;

  const attempts = [
    () => resolveCname(hostname),
    () => resolve4(hostname),
    () => resolve6(hostname),
  ] as const;

  for (const attempt of attempts) {
    try {
      const records = await attempt();
      if (records.length > 0) {
        return true;
      }
    } catch {
      // Try the next record type.
    }
  }

  return false;
}

// =============================================================================
// D1 Database Operations
// =============================================================================

/**
 * List all D1 databases
 * @throws Error if wrangler command fails (caller should handle)
 */
export async function listD1Databases(): Promise<Array<{ name: string; uuid: string }>> {
  try {
    const { stdout, stderr } = await wrangler(['d1', 'list', '--json']);

    // Check for auth errors
    if (stderr && stderr.includes('not logged in')) {
      throw new Error('Not logged in to Cloudflare. Run: wrangler login');
    }

    const databases = JSON.parse(stdout);
    return databases.map((db: { name: string; uuid: string }) => ({
      name: db.name,
      uuid: db.uuid,
    }));
  } catch (error) {
    // Re-throw with context
    if (error instanceof SyntaxError) {
      throw new Error('Failed to parse D1 database list - wrangler output was not valid JSON');
    }
    throw error;
  }
}

/**
 * Check if a D1 database exists
 */
export async function d1DatabaseExists(name: string): Promise<{ exists: boolean; id?: string }> {
  const databases = await listD1Databases();
  const db = databases.find((d) => d.name === name);
  return { exists: !!db, id: db?.uuid };
}

/**
 * Create a D1 database
 */
/** Valid D1 location values (whitelist for security) */
const VALID_D1_LOCATIONS = ['auto', 'wnam', 'enam', 'weur', 'eeur', 'apac', 'oc'] as const;
/** Valid D1 jurisdiction values (whitelist for security) */
const VALID_D1_JURISDICTIONS = ['none', 'eu'] as const;

/**
 * Validate D1 location value against whitelist
 */
function isValidD1Location(value: unknown): value is D1Location {
  return typeof value === 'string' && VALID_D1_LOCATIONS.includes(value as D1Location);
}

/**
 * Validate D1 jurisdiction value against whitelist
 */
function isValidD1Jurisdiction(value: unknown): value is D1Jurisdiction {
  return typeof value === 'string' && VALID_D1_JURISDICTIONS.includes(value as D1Jurisdiction);
}

export async function createD1Database(
  name: string,
  options?: D1CreateOptions
): Promise<{ id: string; name: string }> {
  // Check if already exists
  const existing = await d1DatabaseExists(name);
  if (existing.exists && existing.id) {
    return { id: existing.id, name };
  }

  // Build command args with optional location/jurisdiction
  const args = ['d1', 'create', name];

  // Jurisdiction takes precedence over location (per Cloudflare docs)
  // Security: Validate against whitelist before passing to wrangler
  if (
    options?.jurisdiction &&
    isValidD1Jurisdiction(options.jurisdiction) &&
    options.jurisdiction !== 'none'
  ) {
    args.push(`--jurisdiction=${options.jurisdiction}`);
  } else if (
    options?.location &&
    isValidD1Location(options.location) &&
    options.location !== 'auto'
  ) {
    args.push(`--location=${options.location}`);
  }

  // Create new database
  const { stdout, stderr } = await wrangler(args);

  // Extract database ID from output
  const idMatch = stdout.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);

  if (!idMatch) {
    // Try to get ID from list (in case creation message format changed)
    const databases = await listD1Databases();
    const db = databases.find((d) => d.name === name);
    if (db) {
      return { id: db.uuid, name };
    }
    throw new Error(`Failed to create D1 database: ${stderr || stdout}`);
  }

  return { id: idMatch[1], name };
}

export async function putKVKeyByNamespaceId(
  namespaceId: string,
  key: string,
  value: string,
  options: { expirationTtl?: number } = {}
): Promise<void> {
  const args = ['kv', 'key', 'put', key, value, '--namespace-id', namespaceId, '--remote'];
  if (options.expirationTtl !== undefined) {
    args.push('--ttl', String(options.expirationTtl));
  }
  await wrangler(args, { timeout: 60000 });
}

export async function getKVKeyByNamespaceId(namespaceId: string, key: string): Promise<string> {
  const { stdout } = await wrangler(
    ['kv', 'key', 'get', key, '--namespace-id', namespaceId, '--remote'],
    {
      timeout: 60000,
    }
  );
  return stdout;
}

/**
 * Delete a D1 database
 */
export async function deleteD1Database(name: string): Promise<boolean> {
  try {
    await wrangler(['d1', 'delete', name, '--skip-confirmation']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get D1 database info (size, tables, region, etc.)
 */
export interface D1Info {
  name: string;
  createdAt: string | null;
  databaseSize: string | null;
  numTables: number | null;
  region: string | null;
}

export async function getD1Info(name: string): Promise<D1Info> {
  try {
    const { stdout } = await wrangler(['d1', 'info', name]);

    // Parse the table output
    const createdAtMatch = stdout.match(/created_at\s*│\s*(\S+)/u);
    const sizeMatch = stdout.match(/database_size\s*│\s*([^\n│]+)/u);
    const tablesMatch = stdout.match(/num_tables\s*│\s*(\d+)/u);
    const regionMatch = stdout.match(/running_in_region\s*│\s*(\S+)/u);

    return {
      name,
      createdAt: createdAtMatch?.[1]?.trim() || null,
      databaseSize: sizeMatch?.[1]?.trim() || null,
      numTables: tablesMatch ? parseInt(tablesMatch[1], 10) : null,
      region: regionMatch?.[1]?.trim() || null,
    };
  } catch {
    return {
      name,
      createdAt: null,
      databaseSize: null,
      numTables: null,
      region: null,
    };
  }
}

/**
 * Execute D1 migration SQL file
 */
export async function executeD1Migration(
  dbName: string,
  sqlFilePath: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; error?: string }> {
  const isTransientD1MigrationError = (message: string): boolean => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('file could not be uploaded') ||
      normalized.includes('internalerror') ||
      normalized.includes('please retry') ||
      normalized.includes('we encountered an internal error') ||
      normalized.includes('internal server error') ||
      normalized.includes('bad gateway') ||
      normalized.includes('service unavailable') ||
      normalized.includes('gateway timeout') ||
      normalized.includes('fetch failed') ||
      normalized.includes('econnreset') ||
      normalized.includes('etimedout') ||
      normalized.includes('timed out')
    );
  };

  const retryDelayMs = (attempt: number): number => {
    if (process.env.NODE_ENV === 'test') {
      return 0;
    }
    return Math.min(2_000 * 2 ** (attempt - 1), 15_000);
  };

  try {
    onProgress?.(`  Executing migration: ${sqlFilePath}`);
    const { readFileSync } = await import('node:fs');
    const renderedSql = renderPortableMigrationSql(readFileSync(sqlFilePath, 'utf-8'), 'sqlite');
    const tempSqlPath = pathJoin(
      tmpdir(),
      `authrim-migration-${Date.now()}-${Math.random().toString(16).slice(2)}.sql`
    );
    await writeFile(tempSqlPath, renderedSql, 'utf-8');
    try {
      for (let attempt = 1; attempt <= D1_MIGRATION_MAX_ATTEMPTS; attempt++) {
        try {
          await wrangler(['d1', 'execute', dbName, '--remote', '--file', tempSqlPath, '--yes'], {
            timeout: D1_MIGRATION_EXECUTE_TIMEOUT_MS,
          });
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const canRetry =
            attempt < D1_MIGRATION_MAX_ATTEMPTS && isTransientD1MigrationError(message);
          if (!canRetry) {
            return { success: false, error: message };
          }

          const delayMs = retryDelayMs(attempt);
          onProgress?.(
            `  ⚠️ Transient D1 migration failure for ${basename(sqlFilePath)} ` +
              `(attempt ${attempt}/${D1_MIGRATION_MAX_ATTEMPTS}); retrying in ${Math.round(delayMs / 1000)}s`
          );
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }
      }
    } finally {
      await unlink(tempSqlPath).catch(() => {});
    }
    return { success: false, error: 'D1 migration retry loop exited unexpectedly' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

export interface D1ExecuteCommandResult {
  stdout: string;
  stderr: string;
}

export async function executeD1Command(
  dbName: string,
  sql: string,
  options: { json?: boolean; timeout?: number } = {}
): Promise<D1ExecuteCommandResult> {
  return wrangler(
    [
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      sql,
      ...(options.json ? ['--json'] : []),
    ],
    { timeout: options.timeout ?? D1_MIGRATION_EXECUTE_TIMEOUT_MS }
  );
}

export function parseD1RowsFromWranglerJson<T extends Record<string, unknown>>(
  stdout: string
): T[] {
  const payload = JSON.parse(stdout) as Array<{ results?: T[] }> | { results?: T[] };
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => entry.results ?? []);
  }
  return payload.results ?? [];
}

export async function queryD1Rows<T extends Record<string, unknown>>(
  dbName: string,
  sql: string
): Promise<T[]> {
  const { stdout } = await executeD1Command(dbName, sql, { json: true });
  return parseD1RowsFromWranglerJson<T>(stdout);
}

/** SQL to create the migration tracking table (idempotent) */
const CREATE_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS authrim_migrations (
  filename TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`.trim();

/**
 * Ensure the authrim_migrations tracking table exists in the target database.
 * Returns true on success, false on failure.
 */
async function ensureMigrationsTable(
  dbName: string,
  onProgress?: (message: string) => void
): Promise<boolean> {
  try {
    await wrangler([
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      CREATE_MIGRATIONS_TABLE_SQL,
    ]);
    return true;
  } catch (error) {
    onProgress?.(
      `  ⚠️  Could not create migrations table: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Return the set of migration filenames already recorded in authrim_migrations.
 * Falls back to an empty set on error so we never skip migrations when unsure.
 */
async function getAppliedMigrations(dbName: string): Promise<Set<string>> {
  try {
    const { stdout } = await wrangler([
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      'SELECT filename FROM authrim_migrations;',
      '--json',
    ]);
    const rows = JSON.parse(stdout);
    const results: Array<{ filename: string }> = rows?.[0]?.results ?? [];
    return new Set(results.map((r) => r.filename));
  } catch {
    return new Set();
  }
}

function extractMigrationVersion(filename: string): number {
  const match = filename.match(/^(\d+)_/u);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export async function validateD1MigrationVersion(
  dbName: string,
  expectedVersion: number
): Promise<{ success: boolean; latestVersion: number; error?: string }> {
  try {
    const applied = await getAppliedMigrations(dbName);
    const latestVersion = Math.max(0, ...Array.from(applied).map(extractMigrationVersion));
    if (latestVersion < expectedVersion) {
      return {
        success: false,
        latestVersion,
        error: `D1 database ${dbName} migration version ${latestVersion} is below expected ${expectedVersion}`,
      };
    }
    return { success: true, latestVersion };
  } catch (error) {
    return {
      success: false,
      latestVersion: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Record a migration filename as applied.
 */
export function buildRecordMigrationSql(filename: string, appliedAt = Date.now()): string {
  const escapedFilename = filename.replace(/'/g, "''");
  return `INSERT INTO authrim_migrations (filename, applied_at)
SELECT '${escapedFilename}', ${appliedAt}
WHERE NOT EXISTS (
  SELECT 1
  FROM authrim_migrations
  WHERE filename = '${escapedFilename}'
);`;
}

const CORE_DB_EXCLUDED_MIGRATION_DIRS = new Set(['admin', 'archive', 'external', 'pii']);

interface ListD1MigrationOptions {
  excludeTopLevelDirectories?: ReadonlySet<string>;
}

interface RunD1MigrationOptions extends ListD1MigrationOptions {
  logSummaryLimit?: number;
}

export function listD1MigrationSqlFiles(
  migrationsDir: string,
  options: ListD1MigrationOptions = {}
): string[] {
  const files: string[] = [];

  function walk(relativeDir: string): void {
    const absoluteDir = relativeDir ? pathJoin(migrationsDir, relativeDir) : migrationsDir;
    for (const entry of readdirSync(absoluteDir).sort()) {
      if (entry.startsWith('.')) {
        continue;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
      const absolutePath = pathJoin(migrationsDir, relativePath);
      const stat = statSync(absolutePath);
      if (stat.isDirectory()) {
        if (!relativeDir && options.excludeTopLevelDirectories?.has(entry)) {
          continue;
        }
        walk(relativePath);
        continue;
      }
      if (stat.isFile() && entry.endsWith('.sql')) {
        files.push(relativePath);
      }
    }
  }

  walk('');
  return files.sort();
}

function formatMigrationFileSummary(files: string[], limit = 8): string {
  if (files.length === 0) {
    return '';
  }

  const visible = files.slice(0, limit).join(', ');
  const remaining = files.length - limit;
  return remaining > 0 ? `${visible}, +${remaining} more` : visible;
}

async function recordMigration(dbName: string, filename: string): Promise<void> {
  const sql = buildRecordMigrationSql(filename);
  try {
    await wrangler(['d1', 'execute', dbName, '--remote', '--yes', '--command', sql]);
  } catch {
    // Non-fatal: tracking failure should not abort the migration run
  }
}

/**
 * Run all D1 migrations for a database.
 *
 * Uses an `authrim_migrations` tracking table inside the D1 database to skip
 * files that have already been applied, making repeated runs idempotent.
 */
export async function runD1Migrations(
  dbName: string,
  migrationsDir: string,
  onProgress?: (message: string) => void,
  options: RunD1MigrationOptions = {}
): Promise<{ success: boolean; appliedCount: number; skippedCount: number; error?: string }> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  if (!existsSync(migrationsDir)) {
    return {
      success: false,
      appliedCount: 0,
      skippedCount: 0,
      error: `Migrations directory not found: ${migrationsDir}`,
    };
  }

  const sqlFiles = listD1MigrationSqlFiles(migrationsDir, options);

  if (sqlFiles.length === 0) {
    onProgress?.(`  No migration files found in ${migrationsDir}`);
    return { success: true, appliedCount: 0, skippedCount: 0 };
  }

  onProgress?.(`  Found ${sqlFiles.length} migration files`);

  // Ensure tracking table exists; if it fails we continue without tracking
  await ensureMigrationsTable(dbName, onProgress);
  const applied = await getAppliedMigrations(dbName);
  onProgress?.(`  ${applied.size} migration(s) already recorded as applied`);

  let appliedCount = 0;
  let skippedCount = 0;
  const alreadyAppliedFiles: string[] = [];
  const summaryLimit = options.logSummaryLimit ?? 8;

  for (const sqlFile of sqlFiles) {
    if (applied.has(sqlFile)) {
      alreadyAppliedFiles.push(sqlFile);
      skippedCount++;
      continue;
    }

    const result = await executeD1Migration(dbName, join(migrationsDir, sqlFile), onProgress);
    if (!result.success) {
      return {
        success: false,
        appliedCount,
        skippedCount,
        error: `Failed on ${sqlFile}: ${result.error}`,
      };
    }

    await recordMigration(dbName, sqlFile);
    appliedCount++;
  }

  if (alreadyAppliedFiles.length > 0) {
    onProgress?.(
      `  ⏭  Skipping ${alreadyAppliedFiles.length} already-applied migration(s): ${formatMigrationFileSummary(
        alreadyAppliedFiles,
        summaryLimit
      )}`
    );
  }

  return { success: true, appliedCount, skippedCount };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Build idempotent SQL that guarantees the configured initial tenant exists.
 *
 * Fresh databases currently start with a hard-coded `default` row. When setup
 * configures a different initial tenant ID, that row must be renamed or a new
 * tenant must be inserted so host-based tenant resolution succeeds.
 */
export function buildInitialTenantBootstrapSql(config: AuthrimConfig): string {
  const sqlExpr = getPortableSqlExpressions('sqlite');
  const tenantId = config.tenant?.name?.trim() || 'default';
  const tenantCode = tenantId;
  const displayName = config.tenant?.displayName?.trim() || 'Initial Tenant';

  const tenantIdSql = sqlString(tenantId);
  const tenantCodeSql = sqlString(tenantCode);
  const displayNameSql = sqlString(displayName);

  // Note: D1's HTTP API (used by `wrangler d1 execute --command`) does not support
  // explicit BEGIN TRANSACTION / COMMIT statements. Each statement runs as its own
  // implicit transaction, which is safe here because this bootstrap runs once during
  // deployment with no concurrent writes.
  return `
UPDATE tenants
SET id = ${tenantIdSql},
    tenant_code = ${tenantCodeSql},
    name = ${displayNameSql},
    tenant_key = COALESCE(tenant_key, 't_' || lower(hex(randomblob(18)))),
    lifecycle_state = 'active',
    updated_at = ${sqlExpr.nowEpochSeconds}
WHERE id = 'default'
  AND ${tenantIdSql} <> 'default'
  AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql})
  AND (SELECT COUNT(*) FROM tenants) = 1;

INSERT INTO tenants (
  id, tenant_code, tenant_key, name, description, lifecycle_state, is_default,
  default_tenant_guard, created_at, updated_at
)
SELECT ${tenantIdSql}, ${tenantCodeSql}, 't_' || lower(hex(randomblob(18))), ${displayNameSql}, NULL, 'active',
       CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE is_default = 1) THEN 0 ELSE 1 END,
       CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE is_default = 1) THEN NULL ELSE 'default' END,
       ${sqlExpr.nowEpochSeconds}, ${sqlExpr.nowEpochSeconds}
WHERE NOT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantIdSql});

UPDATE tenants
SET tenant_code = ${tenantCodeSql},
    name = ${displayNameSql},
    tenant_key = COALESCE(tenant_key, 't_' || lower(hex(randomblob(18)))),
    lifecycle_state = 'active',
    updated_at = ${sqlExpr.nowEpochSeconds}
WHERE id = ${tenantIdSql};
`.trim();
}

/**
 * Build idempotent SQL that canonicalizes built-in admin roles in DB_ADMIN.
 *
 * System roles are global templates and must exist only under tenant `default`.
 * Older setup versions copied them into the initial tenant; this rewrites any
 * assignments to the canonical default roles and deletes those stale copies.
 */
export function buildInitialAdminRolesBootstrapSql(config: AuthrimConfig): string {
  const tenantId = config.tenant?.name?.trim() || 'default';
  const tenantIdSql = sqlString(tenantId);

  return `
DELETE FROM admin_role_assignments
WHERE admin_role_id IN (
  SELECT copy.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.tenant_id = ${tenantIdSql}
    AND copy.tenant_id <> 'default'
    AND copy.is_system = 1
)
AND EXISTS (
  SELECT 1
  FROM admin_role_assignments existing
  JOIN admin_roles copy
    ON copy.id = admin_role_assignments.admin_role_id
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE existing.tenant_id = admin_role_assignments.tenant_id
    AND existing.admin_user_id = admin_role_assignments.admin_user_id
    AND existing.admin_role_id = canonical.id
    AND existing.scope_type = admin_role_assignments.scope_type
    AND COALESCE(existing.scope_id, '') = COALESCE(admin_role_assignments.scope_id, '')
);

UPDATE admin_role_assignments
SET admin_role_id = (
  SELECT canonical.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.id = admin_role_assignments.admin_role_id
  LIMIT 1
)
WHERE admin_role_id IN (
  SELECT copy.id
  FROM admin_roles copy
  JOIN admin_roles canonical
    ON canonical.tenant_id = 'default'
   AND canonical.is_system = 1
   AND canonical.name = copy.name
  WHERE copy.tenant_id = ${tenantIdSql}
    AND copy.tenant_id <> 'default'
    AND copy.is_system = 1
);

DELETE FROM admin_roles
WHERE tenant_id = ${tenantIdSql}
  AND ${tenantIdSql} <> 'default'
  AND is_system = 1
  AND EXISTS (
    SELECT 1
    FROM admin_roles canonical
    WHERE canonical.tenant_id = 'default'
      AND canonical.is_system = 1
      AND canonical.name = admin_roles.name
  );
`.trim();
}

export interface InitialTenantBootstrapResult {
  success: boolean;
  error?: string;
}

export interface InitialAdminRolesBootstrapResult {
  success: boolean;
  error?: string;
}

export interface SetupMachineAccessBootstrapResult {
  success: boolean;
  error?: string;
}

export interface RuntimeProfileSeedResult {
  success: boolean;
  seededCount: number;
  backend: 'kv' | 'database';
  error?: string;
}

/**
 * Ensure the configured initial tenant exists in the core D1 database.
 *
 * This runs after migrations so host-based tenant validation can find the
 * configured tenant immediately after deployment.
 */
export async function ensureInitialTenantInD1(
  env: string,
  config: AuthrimConfig,
  onProgress?: (message: string) => void
): Promise<InitialTenantBootstrapResult> {
  const dbName = getD1DatabaseName(env, 'core-db');
  const tenantId = config.tenant?.name?.trim() || 'default';
  const sql = buildInitialTenantBootstrapSql(config);

  try {
    onProgress?.(`🔧 Ensuring initial tenant exists in ${dbName} (${tenantId})...`);
    const { stdout, stderr } = await wrangler([
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      sql,
    ]);
    // wrangler uses reject:false so errors appear in output rather than thrown
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Initial tenant bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }
    onProgress?.(`  ✅ Initial tenant ready: ${tenantId}`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Initial tenant bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Ensure built-in admin roles exist for the configured initial tenant.
 */
export async function ensureInitialAdminRolesInD1(
  env: string,
  config: AuthrimConfig,
  onProgress?: (message: string) => void
): Promise<InitialAdminRolesBootstrapResult> {
  const dbName = getD1DatabaseName(env, 'admin-db');
  const tenantId = config.tenant?.name?.trim() || 'default';
  const sql = buildInitialAdminRolesBootstrapSql(config);

  try {
    onProgress?.(`🔧 Ensuring admin roles exist in ${dbName} (${tenantId})...`);
    const { stdout, stderr } = await wrangler([
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      sql,
    ]);
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Admin role bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }
    onProgress?.(`  ✅ Admin roles ready: ${tenantId}`);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Admin role bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Ensure the setup tool machine principal and public JWK credential exist in DB_ADMIN.
 */
export async function ensureSetupMachineAccessInD1(
  env: string,
  config: AuthrimConfig,
  keysDir: string,
  onProgress?: (message: string) => void
): Promise<SetupMachineAccessBootstrapResult> {
  const dbName = getD1DatabaseName(env, 'admin-db');

  try {
    await ensureSetupMachineKeyFiles(keysDir);
    const publicJwk = await loadSetupMachinePublicJwk(keysDir);
    const sql = buildSetupMachineAccessBootstrapSql(config, publicJwk);

    onProgress?.(`🔧 Ensuring setup machine access exists in ${dbName}...`);
    const { stdout, stderr } = await wrangler([
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      sql,
    ]);
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Setup machine access bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }

    onProgress?.('  ✅ Setup machine access ready');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Setup machine access bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Remove the deploy-only setup machine principal and its local private key.
 *
 * The initial admin setup token is managed separately and is intentionally not
 * touched here.
 */
export async function cleanupSetupMachineAccessInD1(
  env: string,
  keysDir: string,
  onProgress?: (message: string) => void
): Promise<SetupMachineAccessBootstrapResult> {
  const dbName = getD1DatabaseName(env, 'admin-db');

  try {
    const sql = buildSetupMachineAccessCleanupSql();

    onProgress?.(`🧹 Removing setup machine access from ${dbName}...`);
    const { stdout, stderr } = await wrangler([
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      sql,
    ]);
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Setup machine access cleanup failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }

    await deleteSetupMachineKeyFiles(keysDir);
    onProgress?.('  ✅ Setup machine access removed');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Setup machine access cleanup failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Ensure the Admin UI BFF machine principal and public JWK credential exist in DB_ADMIN.
 */
export async function ensureAdminUiBffMachineAccessInD1(
  env: string,
  config: AuthrimConfig,
  keysDir: string,
  onProgress?: (message: string) => void
): Promise<SetupMachineAccessBootstrapResult> {
  const dbName = getD1DatabaseName(env, 'admin-db');

  try {
    const publicJwk = await loadAdminUiBffPublicJwk(keysDir);
    const sql = buildAdminUiBffMachineAccessBootstrapSql(config, publicJwk);

    onProgress?.(`🔧 Ensuring Admin UI BFF machine access exists in ${dbName}...`);
    const { stdout, stderr } = await wrangler([
      'd1',
      'execute',
      dbName,
      '--remote',
      '--yes',
      '--command',
      sql,
    ]);
    const combined = (stdout + '\n' + stderr).toLowerCase();
    if (combined.includes('[error]') || combined.includes('✘ [error]')) {
      const errorDetail = stderr || stdout;
      onProgress?.(`  ❌ Admin UI BFF machine access bootstrap failed: ${errorDetail}`);
      return { success: false, error: errorDetail };
    }

    onProgress?.('  ✅ Admin UI BFF machine access ready');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Admin UI BFF machine access bootstrap failed: ${message}`);
    return { success: false, error: message };
  }
}

type SeededRuntimeProfile = {
  kind: 'storage' | 'audit' | 'residency';
  id: string;
  payload: Record<string, unknown>;
};

function collectSeededRuntimeProfiles(config: AuthrimConfig): SeededRuntimeProfile[] {
  const seeded: SeededRuntimeProfile[] = [];
  for (const profile of config.profiles?.seed?.storage ?? []) {
    seeded.push({
      kind: 'storage',
      id: profile.id,
      payload: {
        ...profile,
        kind: 'storage',
        builtin: false,
      },
    });
  }
  for (const profile of config.profiles?.seed?.audit ?? []) {
    seeded.push({
      kind: 'audit',
      id: profile.id,
      payload: {
        ...profile,
        kind: 'audit',
        builtin: false,
      },
    });
  }
  for (const profile of config.profiles?.seed?.residency ?? []) {
    seeded.push({
      kind: 'residency',
      id: profile.id,
      payload: {
        ...profile,
        kind: 'residency',
        builtin: false,
      },
    });
  }
  return seeded;
}

export function buildRuntimeProfileSeedSql(config: AuthrimConfig): string | null {
  const seeded = collectSeededRuntimeProfiles(config);
  if (seeded.length === 0) {
    return null;
  }

  return seeded
    .map((profile) => {
      const payloadSql = sqlString(JSON.stringify(profile.payload));
      const kindSql = sqlString(profile.kind);
      const idSql = sqlString(profile.id);
      return `
UPDATE profile_registry
SET payload_json = ${payloadSql},
    updated_at = CURRENT_TIMESTAMP
WHERE kind = ${kindSql}
  AND id = ${idSql};

INSERT INTO profile_registry (id, kind, payload_json, created_at, updated_at)
SELECT ${idSql}, ${kindSql}, ${payloadSql}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM profile_registry
  WHERE kind = ${kindSql}
    AND id = ${idSql}
);`.trim();
    })
    .join('\n\n');
}

export async function seedRuntimeProfiles(
  env: string,
  config: AuthrimConfig,
  onProgress?: (message: string) => void
): Promise<RuntimeProfileSeedResult> {
  const seeded = collectSeededRuntimeProfiles(config);
  if (seeded.length === 0) {
    return {
      success: true,
      seededCount: 0,
      backend: config.profiles?.registry?.backend ?? 'kv',
    };
  }

  const backend = config.profiles?.registry?.backend ?? 'kv';

  try {
    if (backend === 'database') {
      const dbName = getD1DatabaseName(env, 'core-db');
      const sql = buildRuntimeProfileSeedSql(config);
      if (!sql) {
        return { success: true, seededCount: 0, backend };
      }

      onProgress?.(`🔧 Seeding ${seeded.length} runtime profile(s) into ${dbName}...`);
      const { stdout, stderr } = await wrangler([
        'd1',
        'execute',
        dbName,
        '--remote',
        '--yes',
        '--command',
        sql,
      ]);

      const combined = (stdout + '\n' + stderr).toLowerCase();
      if (combined.includes('[error]') || combined.includes('✘ [error]')) {
        const errorDetail = stderr || stdout;
        onProgress?.(`  ❌ Runtime profile seed failed: ${errorDetail}`);
        return { success: false, seededCount: 0, backend, error: errorDetail };
      }

      onProgress?.(`  ✅ Seeded ${seeded.length} runtime profile(s)`);
      return { success: true, seededCount: seeded.length, backend };
    }

    onProgress?.(`🔧 Seeding ${seeded.length} runtime profile(s) into AUTHRIM_CONFIG KV...`);
    for (const profile of seeded) {
      await wrangler([
        'kv',
        'key',
        'put',
        `profile-registry:${profile.kind}:${profile.id}`,
        JSON.stringify(profile.payload),
        '--env',
        env,
        '--binding',
        'AUTHRIM_CONFIG',
      ]);
    }

    onProgress?.(`  ✅ Seeded ${seeded.length} runtime profile(s)`);
    return { success: true, seededCount: seeded.length, backend };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.(`  ❌ Runtime profile seed failed: ${message}`);
    return { success: false, seededCount: 0, backend, error: message };
  }
}

/**
 * Locate the migrations root used by setup commands.
 *
 * Priority: local project > authrim subdir > cwd.
 */
export async function findMigrationsRoot(
  rootDir: string,
  onProgress?: (message: string) => void
): Promise<{ path: string | null; searchPaths: string[] }> {
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const searchPaths = [
    resolve(rootDir, 'migrations'),
    resolve(rootDir, 'authrim', 'migrations'),
    resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'authrim', 'migrations'),
  ];

  for (const searchPath of searchPaths) {
    onProgress?.(`  Checking for migrations at: ${searchPath}`);
    if (existsSync(searchPath)) {
      onProgress?.(`  ✓ Found migrations directory: ${searchPath}`);
      return { path: searchPath, searchPaths };
    }
  }

  return { path: null, searchPaths };
}

/**
 * Run migrations for an Authrim environment
 *
 * Searches for migrations directory in source-code locations:
 * 1. {rootDir}/migrations
 * 2. {rootDir}/authrim/migrations
 * 3. process.cwd()/migrations
 * 4. process.cwd()/authrim/migrations
 *
 * @param env - Environment name
 * @param rootDir - Root directory to search for migrations
 * @param onProgress - Progress callback
 */
export async function runMigrationsForEnvironment(
  env: string,
  rootDir: string,
  onProgress?: (message: string) => void,
  config?: MigrationProfileConfig
): Promise<{
  success: boolean;
  core: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  pii: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  admin: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
}> {
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');

  // Database names for this environment
  const coreDbName = getD1DatabaseName(env, 'core-db');
  const piiDbName = getD1DatabaseName(env, 'pii-db');
  const adminDbName = getD1DatabaseName(env, 'admin-db');

  const migrationSearch = await findMigrationsRoot(rootDir, onProgress);
  const migrationsRoot = migrationSearch.path;

  if (!migrationsRoot) {
    const errorMsg = `Migrations directory not found. Searched:\n${migrationSearch.searchPaths.map((p) => `    - ${p}`).join('\n')}`;
    onProgress?.(`  ❌ ${errorMsg}`);
    return {
      success: false,
      core: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
      pii: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
      admin: { success: false, appliedCount: 0, skippedCount: 0, error: errorMsg },
    };
  }

  // Run core database migrations
  onProgress?.(`📜 Running migrations for ${coreDbName}...`);
  const coreResult = await runD1Migrations(coreDbName, migrationsRoot, onProgress, {
    excludeTopLevelDirectories: CORE_DB_EXCLUDED_MIGRATION_DIRS,
  });
  if (!coreResult.success) {
    onProgress?.(`  ❌ Core migration failed: ${coreResult.error}`);
  } else {
    onProgress?.(
      `  ✅ Applied ${coreResult.appliedCount} core migrations (${coreResult.skippedCount} skipped)`
    );
  }

  // Run PII database migrations
  const piiMigrationsDir = join(migrationsRoot, 'pii');
  onProgress?.(`📜 Running migrations for ${piiDbName}...`);

  let piiResult: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  if (!existsSync(piiMigrationsDir)) {
    onProgress?.(`  ⚠️ PII migrations directory not found: ${piiMigrationsDir}`);
    piiResult = { success: true, appliedCount: 0, skippedCount: 0 };
  } else {
    piiResult = await runD1Migrations(piiDbName, piiMigrationsDir, onProgress);
    if (!piiResult.success) {
      onProgress?.(`  ❌ PII migration failed: ${piiResult.error}`);
    } else {
      onProgress?.(
        `  ✅ Applied ${piiResult.appliedCount} PII migrations (${piiResult.skippedCount} skipped)`
      );
    }
  }

  let coreMirrorResult: {
    success: boolean;
    appliedCount: number;
    skippedCount: number;
    error?: string;
  } | null = null;

  if (shouldMirrorPiiMigrationsToCore(config) && existsSync(piiMigrationsDir)) {
    onProgress?.(`📜 Mirroring PII migrations into ${coreDbName} for single-db profile...`);
    coreMirrorResult = await runD1Migrations(coreDbName, piiMigrationsDir, onProgress);
    if (!coreMirrorResult.success) {
      onProgress?.(`  ❌ Core mirror migration failed: ${coreMirrorResult.error}`);
    } else {
      coreResult.appliedCount += coreMirrorResult.appliedCount;
      coreResult.skippedCount += coreMirrorResult.skippedCount;
      onProgress?.(
        `  ✅ Mirrored ${coreMirrorResult.appliedCount} PII migrations into core (${coreMirrorResult.skippedCount} skipped)`
      );
    }
  }

  // Run Admin database migrations
  const adminMigrationsDir = join(migrationsRoot, 'admin');
  onProgress?.(`📜 Running migrations for ${adminDbName}...`);

  let adminResult: { success: boolean; appliedCount: number; skippedCount: number; error?: string };
  if (!existsSync(adminMigrationsDir)) {
    onProgress?.(`  ⚠️ Admin migrations directory not found: ${adminMigrationsDir}`);
    adminResult = { success: true, appliedCount: 0, skippedCount: 0 };
  } else {
    adminResult = await runD1Migrations(adminDbName, adminMigrationsDir, onProgress);
    if (!adminResult.success) {
      onProgress?.(`  ❌ Admin migration failed: ${adminResult.error}`);
    } else {
      onProgress?.(
        `  ✅ Applied ${adminResult.appliedCount} admin migrations (${adminResult.skippedCount} skipped)`
      );
    }
  }

  return {
    success:
      coreResult.success &&
      (coreMirrorResult?.success ?? true) &&
      piiResult.success &&
      adminResult.success,
    core: {
      ...coreResult,
      success: coreResult.success && (coreMirrorResult?.success ?? true),
      error: coreMirrorResult?.error ?? coreResult.error,
    },
    pii: piiResult,
    admin: adminResult,
  };
}

// =============================================================================
// KV Namespace Operations
// =============================================================================

/**
 * List all KV namespaces
 * @throws Error if wrangler command fails (caller should handle)
 */
export async function listKVNamespaces(): Promise<Array<{ title: string; id: string }>> {
  try {
    const { stdout, stderr } = await wrangler(['kv', 'namespace', 'list']);

    // Check for auth errors
    if (stderr && stderr.includes('not logged in')) {
      throw new Error('Not logged in to Cloudflare. Run: wrangler login');
    }

    // wrangler kv namespace list outputs JSON
    const namespaces = JSON.parse(stdout);
    return namespaces.map((ns: { title: string; id: string }) => ({
      title: ns.title,
      id: ns.id,
    }));
  } catch (error) {
    // Re-throw with context
    if (error instanceof SyntaxError) {
      throw new Error('Failed to parse KV namespace list - wrangler output was not valid JSON');
    }
    throw error;
  }
}

/**
 * Check if a KV namespace exists
 */
export async function kvNamespaceExists(title: string): Promise<{ exists: boolean; id?: string }> {
  const namespaces = await listKVNamespaces();
  const ns = namespaces.find((n) => n.title === title);
  return { exists: !!ns, id: ns?.id };
}

/**
 * Check if admin setup is completed for an environment
 * Uses the KV namespace ID to read the setup:completed flag directly
 */
export async function checkAdminSetupStatus(
  kvNamespaceId: string
): Promise<{ completed: boolean; error?: string }> {
  try {
    const { stdout } = await wrangler([
      'kv',
      'key',
      'get',
      'setup:completed',
      '--namespace-id',
      kvNamespaceId,
      '--remote',
    ]);

    return { completed: stdout.trim() === 'true' };
  } catch (error) {
    // Key not found or other error - assume not completed
    const message = error instanceof Error ? error.message : String(error);
    // "key not found" is expected when setup hasn't been completed
    if (message.includes('key') && message.includes('not found')) {
      return { completed: false };
    }
    return { completed: false, error: message };
  }
}

/**
 * Generate and store a setup token directly to KV namespace
 * Returns the token for constructing the setup URL
 */
export async function generateAndStoreSetupToken(
  kvNamespaceId: string,
  ttlSeconds: number = 3600
): Promise<{ success: boolean; token?: string; expiresAt?: string; error?: string }> {
  try {
    // Generate URL-safe token (32 bytes = 43 characters in base64url)
    const { randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');

    // Calculate expiration time
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // Store token in KV with TTL
    await wrangler([
      'kv',
      'key',
      'put',
      'setup:token',
      token,
      '--namespace-id',
      kvNamespaceId,
      '--ttl',
      ttlSeconds.toString(),
      '--remote',
    ]);

    return { success: true, token, expiresAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Create a KV namespace
 */
export async function createKVNamespace(
  name: string,
  preview: boolean = false
): Promise<{ id: string; name: string }> {
  const args = ['kv', 'namespace', 'create', name];
  if (preview) {
    args.push('--preview');
  }

  const { stdout, stderr } = await wrangler(args);

  // Extract ID from output
  // Format: "id": "abc123..." or "preview_id": "abc123..."
  const idKey = preview ? 'preview_id' : 'id';
  const idMatch = stdout.match(new RegExp(`"${idKey}"\\s*:\\s*"([a-f0-9]{32})"`));

  if (!idMatch) {
    // Check if namespace already exists
    const existing = await kvNamespaceExists(name);
    if (existing.exists && existing.id) {
      return { id: existing.id, name };
    }

    // Try preview namespace name format
    if (preview) {
      const previewExisting = await kvNamespaceExists(`${name}_preview`);
      if (previewExisting.exists && previewExisting.id) {
        return { id: previewExisting.id, name: `${name}_preview` };
      }
    }

    throw new Error(`Failed to create KV namespace: ${stderr || stdout}`);
  }

  return { id: idMatch[1], name };
}

/**
 * Delete a KV namespace
 */
export async function deleteKVNamespace(namespaceId: string): Promise<boolean> {
  try {
    await wrangler([
      'kv',
      'namespace',
      'delete',
      '--namespace-id',
      namespaceId,
      '--skip-confirmation',
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a value in KV
 *
 * NOTE: Values are written via a temporary file using --path instead of being
 * passed as a positional CLI argument. This avoids a wrangler parsing bug where
 * values starting with '-' (valid in base64url tokens) are misinterpreted as flags.
 */
export async function kvPut(
  namespaceId: string,
  key: string,
  value: string,
  options: { expirationTtl?: number } = {}
): Promise<boolean> {
  const tmpFile = pathJoin(
    tmpdir(),
    `authrim-kv-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  try {
    await writeFile(tmpFile, value, 'utf-8');
    const args = [
      'kv',
      'key',
      'put',
      key,
      '--path',
      tmpFile,
      '--namespace-id',
      namespaceId,
      '--remote',
    ];
    if (options.expirationTtl) {
      args.push('--expiration-ttl', options.expirationTtl.toString());
    }
    await wrangler(args);
    return true;
  } catch {
    return false;
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

// =============================================================================
// Queue Operations
// =============================================================================

/**
 * Create a Queue
 */
export async function createQueue(name: string): Promise<{ id: string; name: string }> {
  try {
    const { stdout } = await wrangler(['queues', 'create', name]);

    // Extract queue ID (format varies)
    const idMatch = stdout.match(/"id"\s*:\s*"([^"]+)"/);

    return {
      id: idMatch?.[1] || name, // Use name as fallback ID
      name,
    };
  } catch {
    // Queue might already exist
    return { id: name, name };
  }
}

export function getQueueConsumerWorkerNamesForDeletion(
  env: string,
  workers: Array<{ name: string }>
): string[] {
  const workerNames = Array.from(new Set(workers.map((worker) => worker.name))).sort();
  const managementWorkerName = `${env}-ar-management`;
  if (workerNames.includes(managementWorkerName)) {
    return [managementWorkerName];
  }
  return workerNames.filter(
    (workerName) => workerName.startsWith(`${env}-`) && workerName.endsWith('-ar-management')
  );
}

export async function deleteQueueConsumer(queueName: string, workerName: string): Promise<boolean> {
  try {
    await wrangler(['queues', 'consumer', 'remove', queueName, workerName]);
    return true;
  } catch {
    return false;
  }
}

export async function deleteQueueConsumersForWorkers(
  queues: Array<{ name: string }>,
  workerNames: string[],
  onProgress?: (message: string) => void
): Promise<Array<{ queueName: string; workerName: string }>> {
  const removed: Array<{ queueName: string; workerName: string }> = [];
  for (const workerName of workerNames) {
    for (const queue of queues) {
      onProgress?.(`  ⏳ Detaching ${workerName} from ${queue.name}...`);
      const success = await deleteQueueConsumer(queue.name, workerName);
      if (success) {
        removed.push({ queueName: queue.name, workerName });
        onProgress?.(`  ✅ ${queue.name} -> ${workerName}`);
      } else {
        onProgress?.(`  ⚠️ ${queue.name} -> ${workerName} (not attached or already removed)`);
      }
    }
  }
  return removed;
}

// =============================================================================
// R2 Bucket Operations
// =============================================================================

/**
 * Create an R2 bucket
 */
export async function createR2Bucket(name: string): Promise<{ name: string }> {
  try {
    await wrangler(['r2', 'bucket', 'create', name]);
    return { name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isAlreadyExistsError(message)) {
      throw error;
    }
    return { name };
  }
}

function isAlreadyExistsError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('already exists') ||
    normalized.includes('already in use') ||
    normalized.includes('conflict') ||
    normalized.includes('409')
  );
}

export function parseR2BucketRows(stdout: string): Array<{ name: string }> {
  try {
    const parsed = JSON.parse(stdout) as
      | Array<{ name?: unknown }>
      | { buckets?: Array<{ name?: unknown }>; result?: Array<{ name?: unknown }> };
    const rows = Array.isArray(parsed) ? parsed : (parsed.buckets ?? parsed.result ?? []);
    return rows
      .map((row) => (typeof row.name === 'string' ? row.name.trim() : ''))
      .filter((name) => name.length > 0)
      .map((name) => ({ name }));
  } catch {
    // Wrangler has emitted plain text in older versions. Keep a conservative fallback.
  }

  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const nameMatch = line.match(/^name:\s+(.+)$/i);
      if (nameMatch?.[1]) {
        return [{ name: nameMatch[1].trim() }];
      }
      if (/^[a-z0-9][a-z0-9-]*$/i.test(line)) {
        return [{ name: line }];
      }
      return [];
    });
}

async function listR2BucketNamesStrict(): Promise<Set<string>> {
  return new Set((await listR2Buckets({ throwOnError: true })).map((bucket) => bucket.name));
}

async function waitForR2BucketVisible(name: string): Promise<void> {
  const maxAttempts = process.env.NODE_ENV === 'test' ? 1 : 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const names = await listR2BucketNamesStrict();
      if (names.has(name)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < maxAttempts && process.env.NODE_ENV !== 'test') {
      await sleep(Math.min(1_000 * 2 ** (attempt - 1), 5_000));
    }
  }

  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`R2 bucket ${name} was not visible after creation${suffix}`);
}

export async function provisionR2Buckets(
  env: string,
  options: {
    existing?: Record<string, { name: string }> | null;
    onProgress?: (message: string) => void;
  } = {}
): Promise<R2BucketInfo[]> {
  const onProgress = options.onProgress ?? (() => undefined);
  const existing = options.existing ?? {};
  const provisioned: R2BucketInfo[] = [];
  let bucketNames = await listR2BucketNamesStrict();

  for (const bucket of getRequiredR2Buckets(env)) {
    const bucketName = existing[bucket.binding]?.name ?? bucket.name;
    if (bucketNames.has(bucketName)) {
      provisioned.push({
        binding: bucket.binding,
        name: bucketName,
      });
      onProgress(`  ✓ Existing: ${bucketName}`);
      continue;
    }

    onProgress(`  ⏳ Creating: ${bucketName}...`);
    const result = await createR2Bucket(bucketName);
    await waitForR2BucketVisible(result.name);
    bucketNames = await listR2BucketNamesStrict();
    provisioned.push({
      binding: bucket.binding,
      name: result.name,
    });
    onProgress(`  ✅ ${bucketName} created`);
  }

  return provisioned;
}

// =============================================================================
// Secrets Operations
// =============================================================================

/**
 * Upload a secret to Cloudflare
 */
export async function uploadSecret(
  workerName: string,
  secretName: string,
  secretValue: string,
  env?: string
): Promise<boolean> {
  try {
    const args = ['secret', 'put', secretName, '--name', workerName];
    if (env) {
      args.push('--env', env);
    }

    // Use stdin to pass the secret value
    // Use npx to ensure wrangler is found regardless of Volta/npm/pnpm environment
    await execa('npx', ['wrangler', ...args], {
      input: secretValue,
    });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate environment name to prevent injection attacks
 */
function validateEnvName(env: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(env)) {
    throw new Error(
      'Invalid environment name: must start with lowercase letter and contain only lowercase alphanumeric and hyphens'
    );
  }
  if (env.length > 32) {
    throw new Error('Invalid environment name: must be 32 characters or less');
  }
}

/**
 * Sanitize error message to prevent path/secret exposure
 */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remove potential file paths
  return message
    .replace(/\/[^\s:]+/g, '[path]')
    .replace(/\\[^\s:]+/g, '[path]')
    .replace(/[a-f0-9]{32,}/gi, '[id]'); // Obscure long hex strings that might be IDs/secrets
}

// =============================================================================
// Provisioning
// =============================================================================

/**
 * Provision all required Cloudflare resources for an environment
 */
export async function provisionResources(options: ProvisionOptions): Promise<ProvisionedResources> {
  const { env, onProgress = console.log } = options;

  // Security: Validate environment name
  validateEnvName(env);
  const resources: ProvisionedResources = {
    d1: [],
    kv: [],
    queues: [],
    r2: [],
  };

  // Calculate totals for progress tracking
  const d1Count = D1_DATABASES.length;
  const kvCount = KV_NAMESPACES.length;
  const totalResources = d1Count + kvCount;
  let _completedResources = 0;

  onProgress(`📦 Provisioning ${totalResources} resources...`);
  onProgress('');

  // Provision D1 databases
  if (options.createD1 !== false) {
    onProgress(`📊 D1 Databases (0/${d1Count})`);
    for (const db of D1_DATABASES) {
      const dbName = getD1DatabaseName(env, db.dbType);
      onProgress(`  ⏳ Creating: ${dbName}...`);

      // Get location options for this database type
      // Note: admin-db uses the same region as pii-db (both contain sensitive data)
      const dbLocationKey = db.dbType === 'core-db' ? 'core' : 'pii';
      const dbOptions = options.databaseConfig?.[dbLocationKey];

      try {
        const result = await createD1Database(dbName, dbOptions);
        resources.d1.push({
          binding: db.binding,
          name: result.name,
          id: result.id,
        });
        _completedResources++;

        // Show location info if specified
        let locationInfo = '';
        if (dbOptions?.jurisdiction && dbOptions.jurisdiction !== 'none') {
          locationInfo = ` [jurisdiction: ${dbOptions.jurisdiction}]`;
        } else if (dbOptions?.location && dbOptions.location !== 'auto') {
          locationInfo = ` [location: ${dbOptions.location}]`;
        }
        onProgress(`  ✅ ${dbName} (ID: ${result.id.substring(0, 8)}...)${locationInfo}`);
      } catch (error) {
        onProgress(`  ❌ Failed: ${dbName} - ${sanitizeError(error)}`);
        throw new Error(`Failed to create D1 database ${dbName}`);
      }
    }
    onProgress(`📊 D1 Databases (${d1Count}/${d1Count}) ✓`);
    onProgress('');

    // Run migrations if rootDir is provided
    // Use runMigrationsForEnvironment which supports searching multiple paths
    if (options.runMigrations !== false && options.rootDir) {
      onProgress('📜 Running database migrations...');

      const migrationsResult = await runMigrationsForEnvironment(
        env,
        options.rootDir,
        onProgress,
        options.config
      );

      if (!migrationsResult.success) {
        const errors = [];
        if (!migrationsResult.core.success) errors.push(`core: ${migrationsResult.core.error}`);
        if (!migrationsResult.pii.success) errors.push(`pii: ${migrationsResult.pii.error}`);
        if (!migrationsResult.admin.success) errors.push(`admin: ${migrationsResult.admin.error}`);
        throw new Error(`Failed to run migrations: ${errors.join(', ')}`);
      }

      onProgress('');
    }
  }

  // Provision KV namespaces
  if (options.createKV !== false) {
    onProgress(`🗄️ KV Namespaces (0/${kvCount})`);
    for (const kvName of KV_NAMESPACES) {
      const nsName = getKVNamespaceName(env, kvName);
      onProgress(`  ⏳ Creating: ${nsName}...`);

      try {
        const result = await createKVNamespace(nsName);
        // Preview namespaces are auto-created by wrangler dev when needed
        // const previewResult = await createKVNamespace(nsName, true);

        resources.kv.push({
          binding: kvName,
          name: result.name,
          id: result.id,
          // previewId: previewResult.id,
        });
        _completedResources++;
        onProgress(`  ✅ ${nsName} (ID: ${result.id.substring(0, 8)}...)`);
      } catch (error) {
        onProgress(`  ❌ Failed: ${nsName} - ${sanitizeError(error)}`);
        throw new Error(`Failed to create KV namespace ${nsName}`);
      }
    }
    onProgress(`🗄️ KV Namespaces (${kvCount}/${kvCount}) ✓`);
    onProgress('');
  }

  // Provision Queues (optional)
  if (options.createQueues) {
    onProgress('📨 Queues');
    for (const definition of QUEUE_PROVISIONING_DEFINITIONS) {
      const queueName = getQueueName(env, definition.nameSuffix);
      onProgress(`  ⏳ Creating: ${queueName}...`);

      try {
        const result = await createQueue(queueName);
        resources.queues.push({
          binding: definition.binding,
          name: result.name,
          id: result.id,
        });
        onProgress(`  ✅ ${queueName} created`);
      } catch (error) {
        onProgress(`  ⚠️ Skipped: ${queueName} - ${sanitizeError(error)}`);
      }
    }
    onProgress('');
  }

  // Provision R2 buckets (optional)
  if (options.createR2) {
    onProgress('📁 R2 Buckets');
    try {
      resources.r2.push(...(await provisionR2Buckets(env, { onProgress })));
    } catch (error) {
      onProgress(`  ⚠️ R2 provisioning skipped: ${sanitizeError(error)}`);
    }
    onProgress('');
  }

  // Summary
  onProgress('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  onProgress('✅ Provisioning complete!');
  onProgress(
    `   D1: ${resources.d1.length}, KV: ${resources.kv.length}, Queues: ${resources.queues.length}, R2: ${resources.r2.length}`
  );

  return resources;
}

/**
 * Convert provisioned resources to ResourceIds format for wrangler.ts
 */
export function toResourceIds(resources: ProvisionedResources): {
  d1: Record<string, { id: string; name: string }>;
  kv: Record<string, { id: string; name: string }>;
  queues?: Record<string, { id: string; name: string }>;
  r2?: Record<string, { name: string }>;
} {
  const result: ReturnType<typeof toResourceIds> = {
    d1: {},
    kv: {},
  };

  for (const db of resources.d1) {
    result.d1[db.binding] = { id: db.id, name: db.name };
  }

  for (const kv of resources.kv) {
    result.kv[kv.binding] = { id: kv.id, name: kv.name };
  }

  if (resources.queues.length > 0) {
    result.queues = {};
    for (const q of resources.queues) {
      result.queues[q.binding] = { id: q.id, name: q.name };
    }
  }

  if (resources.r2.length > 0) {
    result.r2 = {};
    for (const r of resources.r2) {
      result.r2[r.binding] = { name: r.name };
    }
  }

  return result;
}

// =============================================================================
// Environment Detection & Deletion
// =============================================================================

/**
 * Pattern to detect Authrim resources by name
 */
const AUTHRIM_PATTERNS = {
  worker:
    /^([a-z][a-z0-9-]*)-ar-(auth|token|userinfo|discovery|management|router|async|saml|bridge|vc|lib-core|policy|admin-ui|login-ui)$/,
  d1: /^(?:([a-z][a-z0-9-]*)-authrim-(core|pii|admin)-db|authrim-([a-z][a-z0-9-]*)-(?:tdb-slot-[0-9]{4}-(?:core|pii)|[a-z0-9-]+-(?:core|pii)))$/,
  // KV can have either lowercase or uppercase env prefix (e.g., conformance-CLIENTS_CACHE or TESTENV-CLIENTS_CACHE)
  kv: /^([a-zA-Z][a-zA-Z0-9-]*)-(?:CLIENTS_CACHE|INITIAL_ACCESS_TOKENS|SETTINGS|REBAC_CACHE|USER_CACHE|AUTHRIM_CONFIG|TENANT_RUNTIME_REGISTRY|STATE_STORE|CONSENT_CACHE)(?:_preview)?$/i,
  queue:
    /^([a-z][a-z0-9-]*)-(audit-queue|logging-delivery-critical-queue|logging-delivery-queue|logging-delivery-bulk-queue)$/,
  r2: /^([a-z][a-z0-9-]*)-(authrim-avatars|diagnostic-logs|audit-archive|import-artifacts|export-artifacts|sensitive-details)$/,
  // Legacy Pages projects kept only for cleanup of older installations.
  pages: /^([a-z][a-z0-9-]*)-(ar-admin-ui|ar-login-ui)$/,
};

export interface EnvironmentInfo {
  env: string;
  workers: Array<{ name: string; id?: string }>;
  d1: Array<{ name: string; id: string }>;
  kv: Array<{ name: string; id: string }>;
  queues: Array<{ name: string; id?: string }>;
  r2: Array<{ name: string }>;
  pages: Array<{ name: string }>;
}

export interface DeleteOptions {
  env: string;
  deleteWorkers?: boolean;
  deleteD1?: boolean;
  deleteKV?: boolean;
  deleteQueues?: boolean;
  deleteR2?: boolean;
  deletePages?: boolean;
  knownD1Names?: string[];
  knownQueueNames?: string[];
  onProgress?: (message: string) => void;
}

export function filterKnownD1NamesForEnvironment(env: string, names: string[]): string[] {
  return Array.from(
    new Set(
      names.filter(
        (name) => name.startsWith(`${env}-authrim-`) || name.startsWith(`authrim-${env}-`)
      )
    )
  );
}

export function filterKnownQueueNamesForEnvironment(env: string, names: string[]): string[] {
  return Array.from(
    new Set(
      names.filter((name) =>
        [
          `${env}-audit-queue`,
          `${env}-logging-delivery-critical-queue`,
          `${env}-logging-delivery-queue`,
          `${env}-logging-delivery-bulk-queue`,
        ].includes(name)
      )
    )
  );
}

/**
 * List all Workers
 */
export async function listWorkers(): Promise<Array<{ name: string; id?: string }>> {
  try {
    const accountId = await getAccountId();
    if (!accountId) return [];
    const tokenInfo = await getCloudflareApiToken();
    if (!tokenInfo) return [];

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
      { headers: { Authorization: `Bearer ${tokenInfo.token}` } }
    );
    if (!response.ok) return [];

    const data = (await response.json()) as { result?: Array<{ id: string }> };
    return (data.result || []).map((w) => ({ name: w.id }));
  } catch {
    return [];
  }
}

/**
 * List R2 buckets
 */
export async function listR2Buckets(
  options: { throwOnError?: boolean } = {}
): Promise<Array<{ name: string }>> {
  try {
    const { stdout } = await wrangler(['r2', 'bucket', 'list']);
    return parseR2BucketRows(stdout);
  } catch (error) {
    if (options.throwOnError) {
      throw error;
    }
    return [];
  }
}

/**
 * List Queues
 */
export async function listQueues(): Promise<Array<{ name: string; id?: string }>> {
  try {
    const { stdout } = await wrangler(['queues', 'list']);
    // Parse JSON output
    const queues = JSON.parse(stdout);
    return queues.map((q: { queue_name?: string; queue_id?: string }) => ({
      name: q.queue_name || '',
      id: q.queue_id,
    }));
  } catch {
    return [];
  }
}

/**
 * List legacy Pages projects
 */
export async function listPagesProjects(): Promise<Array<{ name: string }>> {
  try {
    const { stdout } = await wrangler(['pages', 'project', 'list']);
    // Parse the output - each project is listed with its name
    const lines = stdout.split('\n').filter((line) => line.trim());
    const projects: Array<{ name: string }> = [];

    for (const line of lines) {
      // Skip header lines and empty lines
      if (
        line.startsWith('│') ||
        line.startsWith('┌') ||
        line.startsWith('└') ||
        line.startsWith('├')
      ) {
        // Table format - extract project name from table row
        const cells = line
          .split('│')
          .map((s) => s.trim())
          .filter(Boolean);
        if (cells.length > 0 && cells[0] && !cells[0].includes('Name') && !cells[0].includes('─')) {
          projects.push({ name: cells[0] });
        }
      } else if (line.trim() && !line.includes('Projects') && !line.includes('Name')) {
        // Plain text format
        projects.push({ name: line.trim() });
      }
    }
    return projects;
  } catch {
    return [];
  }
}

/**
 * Delete a legacy Pages project
 */
export async function deletePagesProject(name: string): Promise<boolean> {
  try {
    // First, remove all custom domains from the Pages project
    // This is required before the project can be deleted
    const token = await getCloudflareApiToken();
    if (token) {
      try {
        const accountId = await getAccountId();
        // Get project details to list custom domains
        const projectResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${name}`,
          {
            headers: {
              Authorization: `Bearer ${token.token}`,
            },
          }
        );

        if (projectResponse.ok) {
          const projectData = (await projectResponse.json()) as {
            result?: { domains?: string[] };
          };
          const domains = projectData.result?.domains || [];

          // Remove each custom domain (skip *.pages.dev domains)
          for (const domain of domains) {
            if (!domain.endsWith('.pages.dev')) {
              try {
                await fetch(
                  `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${name}/domains/${domain}`,
                  {
                    method: 'DELETE',
                    headers: {
                      Authorization: `Bearer ${token.token}`,
                    },
                  }
                );
                // Small delay to let Cloudflare process the deletion
                await new Promise((resolve) => setTimeout(resolve, 1000));
              } catch {
                // Continue even if domain deletion fails
              }
            }
          }
        }
      } catch {
        // Continue even if custom domain cleanup fails
      }
    }

    // Now delete the Pages project
    await wrangler(['pages', 'project', 'delete', name, '--yes']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect all Authrim environments from existing resources
 */
export async function detectEnvironments(
  onProgress?: (message: string) => void
): Promise<EnvironmentInfo[]> {
  const environments = new Map<string, EnvironmentInfo>();

  const progress = onProgress || (() => {});

  // Scan Workers first — environments are only valid if Workers or D1 exist
  progress('Scanning Workers...');
  const workerEnvs = new Set<string>();
  try {
    const workers = await listWorkers();
    for (const w of workers) {
      const match = w.name.match(AUTHRIM_PATTERNS.worker);
      if (match) {
        const env = match[1].toLowerCase();
        workerEnvs.add(env);
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.workers.push({ name: w.name });
      }
    }
  } catch (error) {
    progress(`  ⚠️ Could not scan Workers: ${error instanceof Error ? error.message : error}`);
  }

  progress('Scanning D1 databases...');
  const d1Envs = new Set<string>();
  try {
    const databases = await listD1Databases();
    for (const db of databases) {
      const match = db.name.match(AUTHRIM_PATTERNS.d1);
      if (match) {
        const env = (match[1] ?? match[3]).toLowerCase();
        d1Envs.add(env);
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.d1.push({ name: db.name, id: db.uuid });
      }
    }
  } catch (error) {
    progress(`  ⚠️ Could not scan D1: ${error instanceof Error ? error.message : error}`);
  }

  progress('Scanning KV namespaces...');
  try {
    const namespaces = await listKVNamespaces();
    for (const ns of namespaces) {
      const match = ns.title.match(AUTHRIM_PATTERNS.kv);
      if (match) {
        const env = match[1].toLowerCase();
        // Only attach KV to environments that already have Workers or D1
        if (environments.has(env)) {
          environments.get(env)!.kv.push({ name: ns.title, id: ns.id });
        }
      }
    }
  } catch (error) {
    progress(`  ⚠️ Could not scan KV: ${error instanceof Error ? error.message : error}`);
  }

  progress('Scanning Queues...');
  try {
    const queues = await listQueues();
    for (const q of queues) {
      const match = q.name.match(AUTHRIM_PATTERNS.queue);
      if (match) {
        const env = match[1].toLowerCase();
        if (!environments.has(env)) {
          environments.set(env, {
            env,
            workers: [],
            d1: [],
            kv: [],
            queues: [],
            r2: [],
            pages: [],
          });
        }
        environments.get(env)!.queues.push({ name: q.name, id: q.id });
      }
    }
  } catch (error) {
    progress(`  ⚠️ Could not scan Queues: ${error instanceof Error ? error.message : error}`);
  }

  progress('Scanning R2 buckets...');
  try {
    const buckets = await listR2Buckets();
    for (const bucket of buckets) {
      const match = bucket.name.match(AUTHRIM_PATTERNS.r2);
      if (match) {
        const env = match[1].toLowerCase();
        // Only attach R2 to environments that already have Workers or D1
        if (environments.has(env)) {
          environments.get(env)!.r2.push({ name: bucket.name });
        }
      }
    }
  } catch (error) {
    progress(`  ⚠️ Could not scan R2: ${error instanceof Error ? error.message : error}`);
  }

  progress('Scanning legacy Pages projects...');
  try {
    const pagesProjects = await listPagesProjects();
    for (const project of pagesProjects) {
      const match = project.name.match(AUTHRIM_PATTERNS.pages);
      if (match) {
        const env = match[1].toLowerCase();
        // Only attach legacy Pages projects to environments that already have Workers or D1
        if (environments.has(env)) {
          environments.get(env)!.pages.push({ name: project.name });
        }
      }
    }
  } catch (error) {
    progress(
      `  ⚠️ Could not scan legacy Pages projects: ${error instanceof Error ? error.message : error}`
    );
  }

  // Filter out empty placeholders while keeping queue-only environments for cleanup.
  for (const [env, info] of environments) {
    if (info.workers.length === 0 && info.d1.length === 0 && info.queues.length === 0) {
      environments.delete(env);
    }
  }

  progress(`Found ${environments.size} environment(s)`);

  return Array.from(environments.values()).sort((a, b) => a.env.localeCompare(b.env));
}

/**
 * Delete a Worker
 */
export async function deleteWorker(name: string): Promise<boolean> {
  try {
    await wrangler(['delete', '--name', name, '--force']);
    return true;
  } catch {
    // Worker might not exist
    return false;
  }
}

/**
 * Get Worker deployment info (last deployed, author, version)
 */
export interface WorkerDeploymentInfo {
  name: string;
  exists: boolean;
  lastDeployedAt: string | null;
  author: string | null;
  versionId: string | null;
}

function parseLatestWorkerDeployment(stdout: string): {
  createdAt: string | null;
  author: string | null;
  versionId: string | null;
} {
  const deploymentStarts = Array.from(
    stdout.matchAll(/^Created:\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*$/gm)
  );

  let latest: {
    createdAt: string;
    index: number;
    nextIndex: number;
  } | null = null;

  for (let index = 0; index < deploymentStarts.length; index++) {
    const match = deploymentStarts[index];
    const createdAt = match[1];
    if (!createdAt || match.index === undefined) {
      continue;
    }
    const parsed = Date.parse(createdAt);
    const latestParsed = latest ? Date.parse(latest.createdAt) : Number.NEGATIVE_INFINITY;
    if (!latest || parsed > latestParsed) {
      latest = {
        createdAt,
        index: match.index,
        nextIndex: deploymentStarts[index + 1]?.index ?? stdout.length,
      };
    }
  }

  if (!latest) {
    return {
      createdAt: null,
      author: null,
      versionId: null,
    };
  }

  const block = stdout.slice(latest.index, latest.nextIndex);
  const authorMatch = block.match(/^Author:\s+(\S+)/m);
  const versionMatch = block.match(/^Version\(s\):\s+\(\d+%\)\s+([a-f0-9-]+)/m);
  return {
    createdAt: latest.createdAt,
    author: authorMatch?.[1] || null,
    versionId: versionMatch?.[1] || null,
  };
}

export async function getWorkerDeployments(name: string): Promise<WorkerDeploymentInfo> {
  try {
    const { stdout, stderr } = await wrangler(['deployments', 'list', '--name', name]);

    // Check if worker doesn't exist
    if (stderr?.includes('does not exist') || stderr?.includes('10007')) {
      return {
        name,
        exists: false,
        lastDeployedAt: null,
        author: null,
        versionId: null,
      };
    }

    // Wrangler does not guarantee newest-first output here; secret changes can appear before
    // the upload deployment. Use the max top-level Created timestamp instead of the first one.
    const deployment = parseLatestWorkerDeployment(stdout);

    return {
      name,
      exists: true,
      lastDeployedAt: deployment.createdAt,
      author: deployment.author,
      versionId: deployment.versionId,
    };
  } catch {
    return {
      name,
      exists: false,
      lastDeployedAt: null,
      author: null,
      versionId: null,
    };
  }
}

/**
 * Delete a Queue
 */
export async function deleteQueue(name: string): Promise<boolean> {
  try {
    await wrangler(['queues', 'delete', name]);
    return true;
  } catch {
    return false;
  }
}

const OBJECT_CATALOG_R2_BUCKET_SUFFIX_BY_BINDING: Record<string, string> = Object.fromEntries(
  R2_BUCKETS.map((bucket) => [bucket.binding, bucket.suffix])
);

interface ObjectCatalogR2Row {
  bucket_binding?: unknown;
  object_key?: unknown;
}

export function getObjectCatalogR2BucketName(env: string, bucketBinding: string): string | null {
  const suffix = OBJECT_CATALOG_R2_BUCKET_SUFFIX_BY_BINDING[bucketBinding];
  return suffix ? `${env}-${suffix}` : null;
}

export function parseObjectCatalogR2RowsFromWranglerJson(
  stdout: string
): Array<{ bucketBinding: string; objectKey: string }> {
  const payload = JSON.parse(stdout) as Array<{ results?: ObjectCatalogR2Row[] }>;
  const rows = payload?.[0]?.results ?? [];
  return rows.flatMap((row) => {
    if (typeof row.bucket_binding !== 'string' || typeof row.object_key !== 'string') {
      return [];
    }
    return [{ bucketBinding: row.bucket_binding, objectKey: row.object_key }];
  });
}

function formatCloudflareApiMessages(payload: {
  errors?: CloudflareApiMessage[];
  messages?: CloudflareApiMessage[];
}): string {
  const entries = [...(payload.errors ?? []), ...(payload.messages ?? [])];
  return entries
    .map((entry) => [entry.code, entry.message].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('; ');
}

async function queryObjectCatalogR2Objects(
  dbName: string
): Promise<Array<{ bucketBinding: string; objectKey: string }>> {
  const { stdout } = await wrangler([
    'd1',
    'execute',
    dbName,
    '--remote',
    '--yes',
    '--command',
    'SELECT bucket_binding, object_key FROM object_catalog_objects WHERE deleted_at IS NULL;',
    '--json',
  ]);
  return parseObjectCatalogR2RowsFromWranglerJson(stdout);
}

async function collectKnownR2ObjectsByBucket(
  env: string,
  buckets: Array<{ name: string }>,
  onProgress?: (message: string) => void
): Promise<Map<string, string[]>> {
  const targetBuckets = new Set(buckets.map((bucket) => bucket.name));
  const objectsByBucket = new Map<string, Set<string>>();
  const dbNames = [getD1DatabaseName(env, 'core-db'), getD1DatabaseName(env, 'admin-db')];

  for (const dbName of dbNames) {
    try {
      const rows = await queryObjectCatalogR2Objects(dbName);
      for (const row of rows) {
        const bucketName = getObjectCatalogR2BucketName(env, row.bucketBinding);
        if (!bucketName || !targetBuckets.has(bucketName)) {
          continue;
        }
        const keys = objectsByBucket.get(bucketName) ?? new Set<string>();
        keys.add(row.objectKey);
        objectsByBucket.set(bucketName, keys);
      }
    } catch (error) {
      onProgress?.(`  ⚠️ Could not read object catalog from ${dbName}: ${sanitizeError(error)}`);
    }
  }

  return new Map(
    [...objectsByBucket.entries()].map(([bucketName, keys]) => [bucketName, [...keys]])
  );
}

async function removeKnownR2Objects(
  bucketName: string,
  objectKeys: string[],
  onProgress?: (message: string) => void
): Promise<void> {
  if (objectKeys.length === 0) {
    return;
  }

  onProgress?.(`  🧹 Emptying known R2 objects: ${bucketName} (${objectKeys.length})...`);
  const concurrency = 5;
  let removed = 0;
  let completed = 0;
  let nextIndex = 0;

  const workerCount = Math.min(concurrency, objectKeys.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < objectKeys.length) {
        const objectKey = objectKeys[nextIndex];
        nextIndex += 1;
        try {
          await wrangler(['r2', 'object', 'delete', `${bucketName}/${objectKey}`, '--remote']);
          removed += 1;
        } catch (error) {
          onProgress?.(`  ⚠️ R2 object cleanup skipped for ${bucketName}: ${sanitizeError(error)}`);
        } finally {
          completed += 1;
          if (completed % 50 === 0 || completed === objectKeys.length) {
            onProgress?.(
              `  R2 object cleanup progress for ${bucketName}: ${completed}/${objectKeys.length}`
            );
          }
        }
      }
    })
  );
  onProgress?.(`  R2 objects removed for ${bucketName}: ${removed}/${objectKeys.length}`);
}

async function getR2ApiCredentials(): Promise<{ accountId: string; token: string } | null> {
  const tokenInfo = await getCloudflareApiToken();
  if (!tokenInfo?.token) {
    return null;
  }

  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    (await getAccountId()) ||
    (await getSingleAccountIdViaApi(tokenInfo.token));
  if (!accountId) {
    return null;
  }

  return { accountId, token: tokenInfo.token };
}

async function getSingleAccountIdViaApi(token: string): Promise<string | null> {
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts?per_page=2', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = (await response.json().catch(() => ({}))) as CloudflareAccountsResponse;
    if (!response.ok || data.success === false) {
      return null;
    }

    const accounts = (data.result ?? []).flatMap((account) =>
      typeof account.id === 'string' ? [account.id] : []
    );
    return accounts.length === 1 ? accounts[0] : null;
  } catch {
    return null;
  }
}

async function listAllR2ObjectKeysViaApi(
  bucketName: string,
  credentials: { accountId: string; token: string }
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ per_page: '1000' });
    if (cursor) {
      params.set('cursor', cursor);
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
        },
      }
    );

    const data = (await response.json().catch(() => ({}))) as CloudflareR2ObjectListResponse;
    if (!response.ok || data.success === false) {
      const detail = formatCloudflareApiMessages(data);
      throw new Error(
        `Cloudflare R2 object list failed (${response.status})${detail ? `: ${detail}` : ''}`
      );
    }

    for (const object of data.result ?? []) {
      if (typeof object.key === 'string') {
        keys.push(object.key);
      }
    }

    cursor = data.result_info?.is_truncated ? data.result_info.cursor : undefined;
  } while (cursor);

  return keys;
}

async function deleteR2ObjectViaApi(
  bucketName: string,
  objectKey: string,
  credentials: { accountId: string; token: string }
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeURIComponent(objectKey)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
      },
    }
  );

  if (response.status === 404) {
    return;
  }

  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: CloudflareApiMessage[];
    messages?: CloudflareApiMessage[];
  };
  if (!response.ok || data.success === false) {
    const detail = formatCloudflareApiMessages(data);
    throw new Error(
      `Cloudflare R2 object delete failed (${response.status})${detail ? `: ${detail}` : ''}`
    );
  }
}

async function deleteR2BucketViaApi(
  bucketName: string,
  credentials: { accountId: string; token: string }
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/r2/buckets/${encodeURIComponent(bucketName)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
      },
    }
  );

  if (response.status === 404) {
    return;
  }

  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: CloudflareApiMessage[];
    messages?: CloudflareApiMessage[];
  };
  if (!response.ok || data.success === false) {
    const detail = formatCloudflareApiMessages(data);
    throw new Error(
      `Cloudflare R2 bucket delete failed (${response.status})${detail ? `: ${detail}` : ''}`
    );
  }
}

async function removeAllR2ObjectsViaApi(
  bucketName: string,
  onProgress?: (message: string) => void
): Promise<void> {
  const credentials = await getR2ApiCredentials();
  if (!credentials) {
    onProgress?.(
      `  ⚠️ R2 full object cleanup skipped for ${bucketName}: API token/account unavailable`
    );
    return;
  }

  const objectKeys = await listAllR2ObjectKeysViaApi(bucketName, credentials);
  if (objectKeys.length === 0) {
    return;
  }

  onProgress?.(`  🧹 Emptying all R2 objects: ${bucketName} (${objectKeys.length})...`);
  const concurrency = 5;
  let removed = 0;
  let completed = 0;
  let nextIndex = 0;

  const workerCount = Math.min(concurrency, objectKeys.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < objectKeys.length) {
        const objectKey = objectKeys[nextIndex];
        nextIndex += 1;
        try {
          await deleteR2ObjectViaApi(bucketName, objectKey, credentials);
          removed += 1;
        } catch (error) {
          onProgress?.(`  ⚠️ R2 object cleanup failed for ${bucketName}: ${sanitizeError(error)}`);
        } finally {
          completed += 1;
          if (completed % 50 === 0 || completed === objectKeys.length) {
            onProgress?.(
              `  R2 full object cleanup progress for ${bucketName}: ${completed}/${objectKeys.length}`
            );
          }
        }
      }
    })
  );
  onProgress?.(
    `  R2 full object cleanup removed for ${bucketName}: ${removed}/${objectKeys.length}`
  );
}

/**
 * Delete an R2 bucket
 */
export async function deleteR2Bucket(
  name: string,
  options: { objectKeys?: string[]; onProgress?: (message: string) => void } = {}
): Promise<boolean> {
  try {
    await removeKnownR2Objects(name, options.objectKeys ?? [], options.onProgress);
    await removeAllR2ObjectsViaApi(name, options.onProgress);
    const credentials = await getR2ApiCredentials();
    if (credentials) {
      await deleteR2BucketViaApi(name, credentials);
    } else {
      await wrangler(['r2', 'bucket', 'delete', name]);
    }
    return true;
  } catch (error) {
    options.onProgress?.(`  ⚠️ R2 bucket delete failed for ${name}: ${sanitizeError(error)}`);
    return false;
  }
}

/**
 * Delete an environment and its resources
 */
export async function deleteEnvironment(options: DeleteOptions): Promise<{
  success: boolean;
  deleted: {
    workers: string[];
    d1: string[];
    kv: string[];
    queues: string[];
    r2: string[];
    pages: string[];
  };
  errors: string[];
}> {
  const {
    env,
    deleteWorkers = true,
    deleteD1 = true,
    deleteKV = true,
    deleteQueues = true,
    deleteR2 = true,
    deletePages = true,
    knownD1Names = [],
    knownQueueNames = [],
    onProgress = console.log,
  } = options;

  validateEnvName(env);

  const deleted = {
    workers: [] as string[],
    d1: [] as string[],
    kv: [] as string[],
    queues: [] as string[],
    r2: [] as string[],
    pages: [] as string[],
  };
  const errors: string[] = [];

  // Get environment info first
  const envs = await detectEnvironments(onProgress);
  let envInfo = envs.find((e) => e.env === env);
  const safeKnownD1Names = filterKnownD1NamesForEnvironment(env, knownD1Names);
  const safeKnownQueueNames = filterKnownQueueNamesForEnvironment(env, knownQueueNames);

  if (!envInfo && safeKnownD1Names.length === 0 && safeKnownQueueNames.length === 0) {
    return {
      success: false,
      deleted,
      errors: [`Environment '${env}' not found`],
    };
  }
  if (!envInfo) {
    envInfo = {
      env,
      workers: [],
      d1: [],
      kv: [],
      queues: [],
      r2: [],
      pages: [],
    };
  }

  const knownD1Set = new Set(envInfo.d1.map((db) => db.name));
  for (const name of safeKnownD1Names) {
    if (!knownD1Set.has(name)) {
      envInfo.d1.push({ name, id: '' });
      knownD1Set.add(name);
    }
  }
  const knownQueueSet = new Set(envInfo.queues.map((queue) => queue.name));
  for (const name of safeKnownQueueNames) {
    if (!knownQueueSet.has(name)) {
      envInfo.queues.push({ name });
      knownQueueSet.add(name);
    }
  }

  onProgress(`🗑️ Deleting environment: ${env}`);
  onProgress('');

  // Queue consumers must be detached before Cloudflare allows the Worker script to be deleted.
  if (deleteWorkers && envInfo.workers.length > 0 && envInfo.queues.length > 0) {
    const queueConsumerWorkerNames = getQueueConsumerWorkerNamesForDeletion(env, envInfo.workers);
    if (queueConsumerWorkerNames.length > 0) {
      onProgress(`📨 Detaching Queue Consumers (${envInfo.queues.length})...`);
      await deleteQueueConsumersForWorkers(envInfo.queues, queueConsumerWorkerNames, onProgress);
      onProgress('');
    }
  }

  // Delete Workers before D1/KV because they reference runtime bindings.
  if (deleteWorkers && envInfo.workers.length > 0) {
    onProgress(`🔧 Deleting Workers (${envInfo.workers.length})...`);
    for (const worker of envInfo.workers) {
      onProgress(`  ⏳ Deleting: ${worker.name}...`);
      const success = await deleteWorker(worker.name);
      if (success) {
        deleted.workers.push(worker.name);
        onProgress(`  ✅ ${worker.name}`);
      } else {
        onProgress(`  ⚠️ ${worker.name} (not found or already deleted)`);
      }
    }
    onProgress('');
  }

  // Delete R2 buckets before D1 so object_catalog_objects can still identify stored objects.
  if (deleteR2 && envInfo.r2.length > 0) {
    const knownR2ObjectsByBucket = await collectKnownR2ObjectsByBucket(env, envInfo.r2, onProgress);
    onProgress(`📁 Deleting R2 Buckets (${envInfo.r2.length})...`);
    for (const bucket of envInfo.r2) {
      onProgress(`  ⏳ Deleting: ${bucket.name}...`);
      const success = await deleteR2Bucket(bucket.name, {
        objectKeys: knownR2ObjectsByBucket.get(bucket.name) ?? [],
        onProgress,
      });
      if (success) {
        deleted.r2.push(bucket.name);
        onProgress(`  ✅ ${bucket.name}`);
      } else {
        errors.push(
          `Failed to delete R2: ${bucket.name} (bucket may still contain objects or require manual cleanup)`
        );
        onProgress(`  ❌ ${bucket.name}`);
      }
    }
    onProgress('');
  }

  // Delete D1 databases
  if (deleteD1 && envInfo.d1.length > 0) {
    onProgress(`📊 Deleting D1 Databases (${envInfo.d1.length})...`);
    for (const db of envInfo.d1) {
      onProgress(`  ⏳ Deleting: ${db.name}...`);
      const success = await deleteD1Database(db.name);
      if (success) {
        deleted.d1.push(db.name);
        onProgress(`  ✅ ${db.name}`);
      } else {
        errors.push(`Failed to delete D1: ${db.name}`);
        onProgress(`  ❌ ${db.name}`);
      }
    }
    onProgress('');
  }

  // Delete KV namespaces
  if (deleteKV && envInfo.kv.length > 0) {
    onProgress(`🗄️ Deleting KV Namespaces (${envInfo.kv.length})...`);
    for (const kv of envInfo.kv) {
      onProgress(`  ⏳ Deleting: ${kv.name}...`);
      const success = await deleteKVNamespace(kv.id);
      if (success) {
        deleted.kv.push(kv.name);
        onProgress(`  ✅ ${kv.name}`);
      } else {
        errors.push(`Failed to delete KV: ${kv.name}`);
        onProgress(`  ❌ ${kv.name}`);
      }
    }
    onProgress('');
  }

  // Delete Queues
  if (deleteQueues && envInfo.queues.length > 0) {
    onProgress(`📨 Deleting Queues (${envInfo.queues.length})...`);
    for (const queue of envInfo.queues) {
      onProgress(`  ⏳ Deleting: ${queue.name}...`);
      const success = await deleteQueue(queue.name);
      if (success) {
        deleted.queues.push(queue.name);
        onProgress(`  ✅ ${queue.name}`);
      } else {
        errors.push(`Failed to delete Queue: ${queue.name}`);
        onProgress(`  ❌ ${queue.name}`);
      }
    }
    onProgress('');
  }

  // Delete legacy Pages projects
  if (deletePages && envInfo.pages.length > 0) {
    onProgress(`📄 Deleting legacy Pages Projects (${envInfo.pages.length})...`);
    for (const project of envInfo.pages) {
      onProgress(`  ⏳ Deleting: ${project.name}...`);
      const success = await deletePagesProject(project.name);
      if (success) {
        deleted.pages.push(project.name);
        onProgress(`  ✅ ${project.name}`);
      } else {
        errors.push(`Failed to delete legacy Pages project: ${project.name}`);
        onProgress(`  ❌ ${project.name}`);
      }
    }
    onProgress('');
  }

  // Summary
  const totalDeleted =
    deleted.workers.length +
    deleted.d1.length +
    deleted.kv.length +
    deleted.queues.length +
    deleted.r2.length +
    deleted.pages.length;

  onProgress('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (errors.length === 0) {
    onProgress(`✅ Environment '${env}' deleted successfully!`);
  } else {
    onProgress(`⚠️ Environment '${env}' partially deleted`);
  }
  onProgress(`   Deleted: ${totalDeleted} resources`);
  if (errors.length > 0) {
    onProgress(`   Errors: ${errors.length}`);
  }

  return {
    success: errors.length === 0,
    deleted,
    errors,
  };
}
