/**
 * API Routes for Authrim Setup Web UI
 *
 * Provides REST API endpoints for the setup wizard.
 *
 * Security Notes:
 * - This API is designed to be accessed from localhost only
 * - A session token is generated on server start to prevent unauthorized access
 * - Operations are serialized to prevent race conditions
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  isWranglerInstalled,
  checkAuth,
  provisionResources,
  type CloudflareAuth,
} from '../core/cloudflare.js';
import { AuthrimConfigSchema, createDefaultConfig, type AuthrimConfig } from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import { createLockFile, saveLockFile, loadLockFile } from '../core/lock.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';
import { deployAll, uploadSecrets, type DeployResult } from '../core/deploy.js';
import { CORE_WORKER_COMPONENTS, type WorkerComponent } from '../core/naming.js';
import { completeInitialSetup } from '../core/admin.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// =============================================================================
// Session & Security
// =============================================================================

/**
 * Session token for API authentication (generated on server start)
 * This is embedded in the HTML page served to the browser
 */
let sessionToken: string = '';

/**
 * Generate a new session token
 */
export function generateSessionToken(): string {
  sessionToken = randomBytes(32).toString('hex');
  return sessionToken;
}

/**
 * Get current session token (for embedding in HTML)
 */
export function getSessionToken(): string {
  return sessionToken;
}

// =============================================================================
// Operation Lock (prevents concurrent state mutations)
// =============================================================================

let operationLock: Promise<void> = Promise.resolve();

/**
 * Acquire operation lock to serialize state mutations
 */
async function withLock<T>(operation: () => Promise<T>): Promise<T> {
  // Wait for previous operation to complete
  await operationLock;

  // Create new lock for this operation
  let releaseLock: () => void;
  operationLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  try {
    return await operation();
  } finally {
    releaseLock!();
  }
}

// =============================================================================
// State Management
// =============================================================================

interface SetupState {
  status: 'idle' | 'configuring' | 'provisioning' | 'deploying' | 'complete' | 'error';
  config: Partial<AuthrimConfig> | null;
  auth: CloudflareAuth | null;
  progress: string[];
  error: string | null;
  deployResults: DeployResult[];
}

const state: SetupState = {
  status: 'idle',
  config: null,
  auth: null,
  progress: [],
  error: null,
  deployResults: [],
};

function addProgress(message: string): void {
  state.progress.push(message);
}

function clearProgress(): void {
  state.progress = [];
}

/**
 * Sanitize error messages to prevent information leakage
 */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Remove potential file paths and secrets
  return message
    .replace(/\/[^\s:]+/g, '[path]')
    .replace(/\\[^\s:]+/g, '[path]')
    .replace(/[a-f0-9]{32,}/gi, '[redacted]');
}

// =============================================================================
// API Routes
// =============================================================================

export function createApiRoutes(): Hono {
  const api = new Hono();

  // Session token validation middleware for mutating operations
  const validateSession = async (
    c: Parameters<Parameters<typeof api.use>[1]>[0],
    next: () => Promise<void>
  ) => {
    const token = c.req.header('X-Session-Token');
    if (!sessionToken || token !== sessionToken) {
      return c.json({ error: 'Invalid or missing session token' }, 401);
    }
    await next();
  };

  // Apply session validation to all POST/PUT/DELETE routes
  api.use('/config', validateSession);
  api.use('/config/*', validateSession);
  api.use('/keys/*', validateSession);
  api.use('/provision', validateSession);
  api.use('/wrangler/*', validateSession);
  api.use('/deploy', validateSession);
  api.use('/reset', validateSession);
  api.use('/admin/*', validateSession);

  // Get current state (no auth required - read-only)
  api.get('/state', (c) => {
    return c.json(state);
  });

  // Check prerequisites (no auth required - read-only)
  api.get('/prerequisites', async (c) => {
    const wranglerInstalled = await isWranglerInstalled();
    const auth = await checkAuth();

    state.auth = auth;

    return c.json({
      wranglerInstalled,
      auth,
    });
  });

  // Load existing config (no auth required - read-only)
  api.get('/config', async (c) => {
    const configPath = 'authrim-config.json';

    if (!existsSync(configPath)) {
      return c.json({ exists: false, config: null });
    }

    try {
      const content = await readFile(configPath, 'utf-8');
      const config = JSON.parse(content);
      state.config = config;
      return c.json({ exists: true, config });
    } catch (error) {
      return c.json({ exists: false, error: sanitizeError(error) }, 500);
    }
  });

  // Save config (with lock to prevent race conditions)
  api.post('/config', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const config = AuthrimConfigSchema.parse(body);

        await writeFile('authrim-config.json', JSON.stringify(config, null, 2));
        state.config = config;

        return c.json({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return c.json({ success: false, errors: error.errors }, 400);
        }
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Create default config (with lock)
  api.post('/config/default', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env = 'prod', domain } = body;

        const config = createDefaultConfig(env);

        // Update URLs if domain is provided
        if (domain) {
          config.urls = {
            api: { custom: domain, auto: `https://${env}-ar-router.workers.dev` },
            loginUi: { custom: null, auto: `https://${env}-ar-ui.pages.dev` },
            adminUi: { custom: null, auto: `https://${env}-ar-ui.pages.dev/admin` },
          };
        }

        state.config = config;

        return c.json({ success: true, config });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Generate keys (with lock)
  api.post('/keys/generate', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { keyId, keysDir = '.keys' } = body;

        addProgress('Generating cryptographic keys...');
        const secrets = generateAllSecrets(keyId);

        addProgress('Saving keys to directory...');
        await saveKeysToDirectory(secrets, keysDir);

        addProgress('Keys generated successfully');

        // Only return public information
        return c.json({
          success: true,
          keyId: secrets.keyPair.keyId,
          publicKeyJwk: secrets.keyPair.publicKeyJwk,
        });
      } catch (error) {
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Provision Cloudflare resources (with lock)
  api.post('/provision', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env } = body;

        state.status = 'provisioning';
        clearProgress();

        addProgress(`Provisioning Cloudflare resources for ${env}...`);

        const resources = await provisionResources({
          env,
          createD1: true,
          createKV: true,
          createQueues: body.createQueues || false,
          createR2: body.createR2 || false,
          onProgress: addProgress,
        });

        addProgress('Creating lock file...');
        const lock = createLockFile(env, resources);
        await saveLockFile(lock);

        state.status = 'configuring';
        addProgress('Provisioning complete!');

        return c.json({
          success: true,
          resources,
          lock,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Generate wrangler configs (with lock)
  api.post('/wrangler/generate', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env, rootDir = '.' } = body;

        // Load lock file
        const lock = await loadLockFile();
        if (!lock) {
          return c.json({ success: false, error: 'Lock file not found' }, 400);
        }

        // Load config
        let config: AuthrimConfig;
        if (state.config) {
          config = AuthrimConfigSchema.parse(state.config);
        } else {
          config = createDefaultConfig(env);
        }

        addProgress('Generating wrangler.toml files...');

        // Build resource IDs from lock file
        const resourceIds = {
          d1: lock.d1,
          kv: Object.fromEntries(
            Object.entries(lock.kv).map(([k, v]) => [k, { id: v.id, name: v.name }])
          ),
          queues: lock.queues,
          r2: lock.r2,
        };

        // Generate and save wrangler configs for each component
        const generatedComponents: string[] = [];
        for (const component of CORE_WORKER_COMPONENTS) {
          const componentDir = join(rootDir, 'packages', component);
          if (!existsSync(componentDir)) {
            continue;
          }

          const wranglerConfig = generateWranglerConfig(component, config, resourceIds);
          const tomlContent = toToml(wranglerConfig);
          const tomlPath = join(componentDir, `wrangler.${env}.toml`);
          await writeFile(tomlPath, tomlContent, 'utf-8');
          generatedComponents.push(component);
        }

        addProgress('Wrangler configs generated!');

        return c.json({
          success: true,
          components: generatedComponents,
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Deploy (with lock - long-running operation)
  api.post('/deploy', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env, rootDir = '.', dryRun = false, components } = body;

        state.status = 'deploying';
        clearProgress();

        // Upload secrets first (secrets are read but not stored in state)
        if (!dryRun && existsSync('.keys')) {
          addProgress('Uploading secrets...');

          const secrets: Record<string, string> = {};
          const secretFiles = [
            { file: '.keys/private.pem', name: 'PRIVATE_KEY_PEM' },
            { file: '.keys/rp_token_encryption_key.txt', name: 'RP_TOKEN_ENCRYPTION_KEY' },
            { file: '.keys/admin_api_secret.txt', name: 'ADMIN_API_SECRET' },
            { file: '.keys/key_manager_secret.txt', name: 'KEY_MANAGER_SECRET' },
          ];

          for (const { file, name } of secretFiles) {
            if (existsSync(file)) {
              secrets[name] = await readFile(file, 'utf-8');
            }
          }

          if (Object.keys(secrets).length > 0) {
            await uploadSecrets(secrets, {
              env,
              rootDir: resolve(rootDir),
              onProgress: addProgress,
            });
            // Note: secrets object goes out of scope here and will be garbage collected
          }
        }

        addProgress('Deploying workers...');

        const enabledComponents: WorkerComponent[] | undefined = components;

        const summary = await deployAll(
          {
            env,
            rootDir: resolve(rootDir),
            dryRun,
            onProgress: addProgress,
            onError: (comp, error) => {
              addProgress(`Error in ${comp}: ${sanitizeError(error)}`);
            },
          },
          enabledComponents
        );

        state.deployResults = summary.results;

        if (summary.failedCount === 0) {
          state.status = 'complete';
          addProgress('Deployment complete!');
        } else {
          state.status = 'error';
          state.error = `${summary.failedCount} components failed to deploy`;
        }

        return c.json({
          success: summary.failedCount === 0,
          summary,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Get deployment status (no auth required - read-only)
  api.get('/deploy/status', (c) => {
    return c.json({
      status: state.status,
      progress: state.progress,
      error: state.error,
      results: state.deployResults,
    });
  });

  // Reset state (with lock)
  api.post('/reset', async (c) => {
    return withLock(async () => {
      state.status = 'idle';
      state.config = null;
      state.progress = [];
      state.error = null;
      state.deployResults = [];

      return c.json({ success: true });
    });
  });

  // Complete initial admin setup (store setup token in KV)
  api.post('/admin/setup', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env, baseUrl, keysDir = '.keys' } = body;

        if (!env || !baseUrl) {
          return c.json({ success: false, error: 'env and baseUrl are required' }, 400);
        }

        addProgress('Setting up initial admin...');

        const result = await completeInitialSetup({
          env,
          baseUrl,
          keysDir,
          onProgress: addProgress,
        });

        if (result.alreadyCompleted) {
          addProgress('Initial admin setup already completed');
          return c.json({
            success: true,
            alreadyCompleted: true,
            message: 'Initial admin setup was already completed',
          });
        }

        if (result.success && result.setupUrl) {
          addProgress('Setup token stored successfully');
          return c.json({
            success: true,
            setupUrl: result.setupUrl,
            message: 'Visit the setup URL to create the initial administrator',
          });
        }

        return c.json({ success: false, error: result.error }, 500);
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  return api;
}
