/**
 * Cloudflare API Integration Module
 *
 * Provides programmatic access to Cloudflare resources via wrangler CLI.
 * Used for provisioning D1 databases, KV namespaces, and other resources.
 */

import { execa, type ExecaError } from 'execa';
import {
  getD1DatabaseName,
  getKVNamespaceName,
  getQueueName,
  D1_DATABASES,
  KV_NAMESPACES,
} from './naming.js';
import type { D1Location, D1Jurisdiction } from './config.js';

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
}

// =============================================================================
// Wrangler Wrapper
// =============================================================================

/**
 * Execute a wrangler command
 */
async function wrangler(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execa('wrangler', args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      reject: false,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const execaError = error as ExecaError;
    throw new Error(`Wrangler command failed: ${execaError.message}`);
  }
}

/**
 * Check if wrangler is installed
 */
export async function isWranglerInstalled(): Promise<boolean> {
  try {
    await execa('wrangler', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with Cloudflare
 */
export async function checkAuth(): Promise<CloudflareAuth> {
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

    // Consider logged in if: no negative patterns AND (has email OR has logged in message)
    const isLoggedIn = !isNotLoggedIn && (hasEmail || hasLoggedInMessage);

    return {
      isLoggedIn,
      email: emailMatch?.[1],
      accountId: accountMatch?.[1],
    };
  } catch {
    return { isLoggedIn: false };
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

/**
 * Get the workers.dev subdomain for the account
 * This is needed because workers.dev URLs are: {worker}.{subdomain}.workers.dev
 */
export async function getWorkersSubdomain(): Promise<string | null> {
  try {
    const accountId = await getAccountId();
    if (!accountId) return null;

    // Read OAuth token from wrangler config
    const { readFile } = await import('node:fs/promises');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');

    const configPath = join(homedir(), 'Library/Preferences/.wrangler/config/default.toml');
    let oauthToken: string | null = null;

    try {
      const configContent = await readFile(configPath, 'utf-8');
      const tokenMatch = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
      oauthToken = tokenMatch?.[1] || null;
    } catch {
      // Try Linux/Windows path
      const altConfigPath = join(homedir(), '.wrangler/config/default.toml');
      try {
        const configContent = await readFile(altConfigPath, 'utf-8');
        const tokenMatch = configContent.match(/oauth_token\s*=\s*"([^"]+)"/);
        oauthToken = tokenMatch?.[1] || null;
      } catch {
        return null;
      }
    }

    if (!oauthToken) return null;

    // Call Cloudflare API to get subdomain
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {
        headers: {
          Authorization: `Bearer ${oauthToken}`,
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
  try {
    onProgress?.(`  Executing migration: ${sqlFilePath}`);
    await wrangler(['d1', 'execute', dbName, '--remote', '--file', sqlFilePath, '--yes']);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Ignore "already exists" errors - migration may have been partially applied
    if (message.includes('already exists') || message.includes('UNIQUE constraint')) {
      onProgress?.(`  ⚠️ Migration already applied (skipped)`);
      return { success: true };
    }
    return { success: false, error: message };
  }
}

/**
 * Run all D1 migrations for a database
 */
export async function runD1Migrations(
  dbName: string,
  migrationsDir: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; appliedCount: number; error?: string }> {
  const { existsSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');

  if (!existsSync(migrationsDir)) {
    return {
      success: false,
      appliedCount: 0,
      error: `Migrations directory not found: ${migrationsDir}`,
    };
  }

  // Get all SQL files sorted by name (001_, 002_, etc.)
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('.'))
    .sort();

  if (sqlFiles.length === 0) {
    onProgress?.(`  No migration files found in ${migrationsDir}`);
    return { success: true, appliedCount: 0 };
  }

  onProgress?.(`  Found ${sqlFiles.length} migration files`);

  let appliedCount = 0;
  for (const sqlFile of sqlFiles) {
    const result = await executeD1Migration(dbName, join(migrationsDir, sqlFile), onProgress);
    if (!result.success) {
      return { success: false, appliedCount, error: `Failed on ${sqlFile}: ${result.error}` };
    }
    appliedCount++;
  }

  return { success: true, appliedCount };
}

/**
 * Run migrations for an Authrim environment
 *
 * Searches for migrations directory in multiple locations:
 * 1. {rootDir}/migrations
 * 2. {rootDir}/authrim/migrations
 * 3. Relative to current working directory
 *
 * @param env - Environment name
 * @param rootDir - Root directory to search for migrations
 * @param onProgress - Progress callback
 */
export async function runMigrationsForEnvironment(
  env: string,
  rootDir: string,
  onProgress?: (message: string) => void
): Promise<{
  success: boolean;
  core: { success: boolean; appliedCount: number; error?: string };
  pii: { success: boolean; appliedCount: number; error?: string };
}> {
  const { existsSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');

  // Database names for this environment
  const coreDbName = getD1DatabaseName(env, 'core');
  const piiDbName = getD1DatabaseName(env, 'pii');

  // Search for migrations directory in multiple locations
  const searchPaths = [
    resolve(rootDir, 'migrations'),
    resolve(rootDir, 'authrim', 'migrations'),
    resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'authrim', 'migrations'),
  ];

  let migrationsRoot: string | null = null;
  for (const searchPath of searchPaths) {
    onProgress?.(`  Checking for migrations at: ${searchPath}`);
    if (existsSync(searchPath)) {
      migrationsRoot = searchPath;
      onProgress?.(`  ✓ Found migrations directory: ${searchPath}`);
      break;
    }
  }

  if (!migrationsRoot) {
    const errorMsg = `Migrations directory not found. Searched:\n${searchPaths.map((p) => `    - ${p}`).join('\n')}`;
    onProgress?.(`  ❌ ${errorMsg}`);
    return {
      success: false,
      core: { success: false, appliedCount: 0, error: errorMsg },
      pii: { success: false, appliedCount: 0, error: errorMsg },
    };
  }

  // Run core database migrations
  onProgress?.(`📜 Running migrations for ${coreDbName}...`);
  const coreResult = await runD1Migrations(coreDbName, migrationsRoot, onProgress);
  if (!coreResult.success) {
    onProgress?.(`  ❌ Core migration failed: ${coreResult.error}`);
  } else {
    onProgress?.(`  ✅ Applied ${coreResult.appliedCount} core migrations`);
  }

  // Run PII database migrations
  const piiMigrationsDir = join(migrationsRoot, 'pii');
  onProgress?.(`📜 Running migrations for ${piiDbName}...`);

  let piiResult: { success: boolean; appliedCount: number; error?: string };
  if (!existsSync(piiMigrationsDir)) {
    onProgress?.(`  ⚠️ PII migrations directory not found: ${piiMigrationsDir}`);
    piiResult = { success: true, appliedCount: 0 };
  } else {
    piiResult = await runD1Migrations(piiDbName, piiMigrationsDir, onProgress);
    if (!piiResult.success) {
      onProgress?.(`  ❌ PII migration failed: ${piiResult.error}`);
    } else {
      onProgress?.(`  ✅ Applied ${piiResult.appliedCount} PII migrations`);
    }
  }

  return {
    success: coreResult.success && piiResult.success,
    core: coreResult,
    pii: piiResult,
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
): Promise<{ success: boolean; token?: string; error?: string }> {
  try {
    // Generate URL-safe token (32 bytes = 43 characters in base64url)
    const { randomBytes } = await import('node:crypto');
    const token = randomBytes(32).toString('base64url');

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

    return { success: true, token };
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
    await wrangler(['kv', 'namespace', 'delete', '--namespace-id', namespaceId]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put a value in KV
 */
export async function kvPut(
  namespaceId: string,
  key: string,
  value: string,
  options: { expirationTtl?: number } = {}
): Promise<boolean> {
  try {
    const args = ['kv', 'key', 'put', key, value, '--namespace-id', namespaceId, '--remote'];
    if (options.expirationTtl) {
      args.push('--expiration-ttl', options.expirationTtl.toString());
    }
    await wrangler(args);
    return true;
  } catch {
    return false;
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
  } catch {
    // Bucket might already exist
    return { name };
  }
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
    await execa('wrangler', args, {
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
    if (options.runMigrations !== false && options.rootDir) {
      const { join } = await import('node:path');

      // Core database migrations
      const coreDbName = getD1DatabaseName(env, 'core');
      const coreMigrationsDir = join(options.rootDir, 'migrations');
      onProgress(`📜 Running migrations for ${coreDbName}...`);

      const coreResult = await runD1Migrations(coreDbName, coreMigrationsDir, onProgress);
      if (!coreResult.success) {
        onProgress(`  ❌ Migration failed: ${coreResult.error}`);
        throw new Error(`Failed to run migrations for ${coreDbName}: ${coreResult.error}`);
      }
      onProgress(`  ✅ Applied ${coreResult.appliedCount} migrations`);

      // PII database migrations
      const piiDbName = getD1DatabaseName(env, 'pii');
      const piiMigrationsDir = join(options.rootDir, 'migrations', 'pii');
      onProgress(`📜 Running migrations for ${piiDbName}...`);

      const piiResult = await runD1Migrations(piiDbName, piiMigrationsDir, onProgress);
      if (!piiResult.success) {
        onProgress(`  ❌ Migration failed: ${piiResult.error}`);
        throw new Error(`Failed to run migrations for ${piiDbName}: ${piiResult.error}`);
      }
      onProgress(`  ✅ Applied ${piiResult.appliedCount} migrations`);
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
    const queueName = getQueueName(env, 'audit-queue');
    onProgress(`  ⏳ Creating: ${queueName}...`);

    try {
      const result = await createQueue(queueName);
      resources.queues.push({
        binding: 'AUDIT_QUEUE',
        name: result.name,
        id: result.id,
      });
      onProgress(`  ✅ ${queueName} created`);
    } catch (error) {
      onProgress(`  ⚠️ Skipped: ${queueName} - ${sanitizeError(error)}`);
    }
    onProgress('');
  }

  // Provision R2 buckets (optional)
  if (options.createR2) {
    onProgress('📁 R2 Buckets');
    const bucketName = `${env}-authrim-avatars`;
    onProgress(`  ⏳ Creating: ${bucketName}...`);

    try {
      const result = await createR2Bucket(bucketName);
      resources.r2.push({
        binding: 'AVATARS',
        name: result.name,
      });
      onProgress(`  ✅ ${bucketName} created`);
    } catch (error) {
      onProgress(`  ⚠️ Skipped: ${bucketName} - ${sanitizeError(error)}`);
    }
    onProgress('');
  }

  // Summary
  onProgress('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  onProgress(`✅ Provisioning complete!`);
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
    /^([a-z][a-z0-9-]*)-ar-(auth|token|userinfo|discovery|management|router|async|saml|bridge|vc|lib-core|policy)$/,
  d1: /^([a-z][a-z0-9-]*)-authrim-(core|pii)-db$/,
  // KV can have either lowercase or uppercase env prefix (e.g., conformance-CLIENTS_CACHE or TESTENV-CLIENTS_CACHE)
  kv: /^([a-zA-Z][a-zA-Z0-9-]*)-(?:CLIENTS_CACHE|INITIAL_ACCESS_TOKENS|SETTINGS|REBAC_CACHE|USER_CACHE|AUTHRIM_CONFIG|STATE_STORE|CONSENT_CACHE)(?:_preview)?$/i,
  queue: /^([a-z][a-z0-9-]*)-audit-queue$/,
  r2: /^([a-z][a-z0-9-]*)-authrim-avatars$/,
  // Pages projects: {env}-ar-admin-ui, {env}-ar-login-ui
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
  onProgress?: (message: string) => void;
}

/**
 * List all Workers
 */
export async function listWorkers(): Promise<Array<{ name: string; id?: string }>> {
  try {
    const { stdout: _stdout } = await wrangler(['deployments', 'list', '--json']);
    // Note: wrangler deployments list doesn't give us what we need
    // We'll use wrangler whoami to get account and then list workers differently
    // For now, return empty - we'll detect workers from D1/KV patterns
    return [];
  } catch {
    return [];
  }
}

/**
 * List R2 buckets
 */
export async function listR2Buckets(): Promise<Array<{ name: string }>> {
  try {
    const { stdout } = await wrangler(['r2', 'bucket', 'list']);
    // Parse the output - format is "name: bucket-name" per line
    const lines = stdout.split('\n').filter((line) => line.trim());
    const buckets: Array<{ name: string }> = [];

    for (const line of lines) {
      // Parse "name: bucket-name" format
      const match = line.match(/^name:\s+(.+)$/);
      if (match && match[1]) {
        buckets.push({ name: match[1].trim() });
      }
    }
    return buckets;
  } catch {
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
 * List Pages projects
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
 * Delete a Pages project
 */
export async function deletePagesProject(name: string): Promise<boolean> {
  try {
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

  progress('Scanning D1 databases...');
  try {
    const databases = await listD1Databases();
    for (const db of databases) {
      const match = db.name.match(AUTHRIM_PATTERNS.d1);
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
        environments.get(env)!.kv.push({ name: ns.title, id: ns.id });
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
        environments.get(env)!.r2.push({ name: bucket.name });
      }
    }
  } catch (error) {
    progress(`  ⚠️ Could not scan R2: ${error instanceof Error ? error.message : error}`);
  }

  progress('Scanning Pages projects...');
  try {
    const pagesProjects = await listPagesProjects();
    for (const project of pagesProjects) {
      const match = project.name.match(AUTHRIM_PATTERNS.pages);
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
        environments.get(env)!.pages.push({ name: project.name });
      }
    }
  } catch (error) {
    progress(`  ⚠️ Could not scan Pages: ${error instanceof Error ? error.message : error}`);
  }

  // Infer workers from detected environments
  const workerComponents = [
    'ar-lib-core',
    'ar-auth',
    'ar-token',
    'ar-userinfo',
    'ar-discovery',
    'ar-management',
    'ar-router',
    'ar-async',
    'ar-saml',
    'ar-bridge',
    'ar-vc',
    'ar-policy',
  ];

  for (const [env, info] of environments) {
    for (const comp of workerComponents) {
      info.workers.push({ name: `${env}-${comp}` });
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

    // Parse deployment info - get the first (most recent) deployment
    // Format: Created: 2025-12-31T16:05:56.164Z
    const createdMatch = stdout.match(/Created:\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
    const authorMatch = stdout.match(/Author:\s+(\S+)/);
    const versionMatch = stdout.match(/Version\(s\):\s+\(\d+%\)\s+([a-f0-9-]+)/);

    return {
      name,
      exists: true,
      lastDeployedAt: createdMatch?.[1] || null,
      author: authorMatch?.[1] || null,
      versionId: versionMatch?.[1] || null,
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

/**
 * Delete an R2 bucket
 */
export async function deleteR2Bucket(name: string): Promise<boolean> {
  try {
    await wrangler(['r2', 'bucket', 'delete', name]);
    return true;
  } catch {
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
  const envs = await detectEnvironments();
  const envInfo = envs.find((e) => e.env === env);

  if (!envInfo) {
    return {
      success: false,
      deleted,
      errors: [`Environment '${env}' not found`],
    };
  }

  onProgress(`🗑️ Deleting environment: ${env}`);
  onProgress('');

  // Delete Workers (must be done first as they reference D1/KV)
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

  // Delete R2 buckets
  if (deleteR2 && envInfo.r2.length > 0) {
    onProgress(`📁 Deleting R2 Buckets (${envInfo.r2.length})...`);
    for (const bucket of envInfo.r2) {
      onProgress(`  ⏳ Deleting: ${bucket.name}...`);
      const success = await deleteR2Bucket(bucket.name);
      if (success) {
        deleted.r2.push(bucket.name);
        onProgress(`  ✅ ${bucket.name}`);
      } else {
        errors.push(`Failed to delete R2: ${bucket.name}`);
        onProgress(`  ❌ ${bucket.name}`);
      }
    }
    onProgress('');
  }

  // Delete Pages projects
  if (deletePages && envInfo.pages.length > 0) {
    onProgress(`📄 Deleting Pages Projects (${envInfo.pages.length})...`);
    for (const project of envInfo.pages) {
      onProgress(`  ⏳ Deleting: ${project.name}...`);
      const success = await deletePagesProject(project.name);
      if (success) {
        deleted.pages.push(project.name);
        onProgress(`  ✅ ${project.name}`);
      } else {
        errors.push(`Failed to delete Pages: ${project.name}`);
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
