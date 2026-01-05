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
  type KVNamespace,
} from './naming.js';

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

export interface ProvisionOptions {
  env: string;
  createD1?: boolean;
  createKV?: boolean;
  createQueues?: boolean;
  createR2?: boolean;
  onProgress?: (message: string) => void;
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
    const { stdout } = await wrangler(['whoami']);

    // Parse output to extract account info
    const emailMatch = stdout.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const accountMatch = stdout.match(/account ID[:\s]+([a-f0-9]{32})/i);

    return {
      isLoggedIn: !stdout.includes('not logged in'),
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
export async function createD1Database(name: string): Promise<{ id: string; name: string }> {
  // Check if already exists
  const existing = await d1DatabaseExists(name);
  if (existing.exists && existing.id) {
    return { id: existing.id, name };
  }

  // Create new database
  const { stdout, stderr } = await wrangler(['d1', 'create', name]);

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
    const args = ['kv', 'key', 'put', key, value, '--namespace-id', namespaceId];
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
  } catch (error) {
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
  } catch (error) {
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

  // Provision D1 databases
  if (options.createD1 !== false) {
    for (const db of D1_DATABASES) {
      const dbName = getD1DatabaseName(env, db.dbType);
      onProgress(`Creating D1 database: ${dbName}`);

      try {
        const result = await createD1Database(dbName);
        resources.d1.push({
          binding: db.binding,
          name: result.name,
          id: result.id,
        });
        onProgress(`  ✓ ${dbName} created`);
      } catch (error) {
        onProgress(`  ✗ Failed to create ${dbName}: ${sanitizeError(error)}`);
        throw new Error(`Failed to create D1 database ${dbName}`);
      }
    }
  }

  // Provision KV namespaces
  if (options.createKV !== false) {
    for (const kvName of KV_NAMESPACES) {
      const nsName = getKVNamespaceName(env, kvName);
      onProgress(`Creating KV namespace: ${nsName}`);

      try {
        const result = await createKVNamespace(nsName);
        const previewResult = await createKVNamespace(nsName, true);

        resources.kv.push({
          binding: kvName,
          name: result.name,
          id: result.id,
          previewId: previewResult.id,
        });
        onProgress(`  ✓ ${nsName} created`);
      } catch (error) {
        onProgress(`  ✗ Failed to create ${nsName}: ${sanitizeError(error)}`);
        throw new Error(`Failed to create KV namespace ${nsName}`);
      }
    }
  }

  // Provision Queues (optional)
  if (options.createQueues) {
    const queueName = getQueueName(env, 'audit-queue');
    onProgress(`Creating Queue: ${queueName}`);

    try {
      const result = await createQueue(queueName);
      resources.queues.push({
        binding: 'AUDIT_QUEUE',
        name: result.name,
        id: result.id,
      });
      onProgress(`  ✓ ${queueName} created`);
    } catch (error) {
      onProgress(`  ✗ Failed to create ${queueName}: ${sanitizeError(error)}`);
    }
  }

  // Provision R2 buckets (optional)
  if (options.createR2) {
    const bucketName = `${env}-authrim-avatars`;
    onProgress(`Creating R2 bucket: ${bucketName}`);

    try {
      const result = await createR2Bucket(bucketName);
      resources.r2.push({
        binding: 'AVATARS',
        name: result.name,
      });
      onProgress(`  ✓ ${bucketName} created`);
    } catch (error) {
      onProgress(`  ✗ Failed to create ${bucketName}: ${sanitizeError(error)}`);
    }
  }

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
