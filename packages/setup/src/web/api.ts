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
  detectEnvironments,
  deleteEnvironment,
  getWorkersSubdomain,
  checkAdminSetupStatus,
  generateAndStoreSetupToken,
  type CloudflareAuth,
} from '../core/cloudflare.js';
import {
  AuthrimConfigSchema,
  createDefaultConfig,
  D1LocationSchema,
  D1JurisdictionSchema,
  type AuthrimConfig,
} from '../core/config.js';
import { generateAllSecrets, saveKeysToDirectory, keysExistForEnvironment } from '../core/keys.js';
import { createLockFile, saveLockFile, loadLockFile } from '../core/lock.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';
import {
  deployAll,
  uploadSecrets,
  buildApiPackages,
  deployPages,
  type DeployResult,
} from '../core/deploy.js';
import { getEnabledComponents, type WorkerComponent } from '../core/naming.js';
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
    const workersSubdomain = auth.isLoggedIn ? await getWorkersSubdomain() : null;

    state.auth = auth;

    return c.json({
      wranglerInstalled,
      auth,
      workersSubdomain,
      cwd: process.cwd(),
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
      const rawConfig = JSON.parse(content);

      // Validate with Zod schema
      const parseResult = AuthrimConfigSchema.safeParse(rawConfig);
      if (!parseResult.success) {
        return c.json({
          exists: true,
          config: rawConfig,
          valid: false,
          errors: parseResult.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }

      state.config = parseResult.data;
      return c.json({ exists: true, config: parseResult.data, valid: true });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ exists: true, valid: false, error: 'Invalid JSON syntax' }, 400);
      }
      return c.json({ exists: false, error: sanitizeError(error) }, 500);
    }
  });

  // Validate config (POST - accepts config in body)
  api.post('/config/validate', async (c) => {
    try {
      const body = await c.req.json();

      const parseResult = AuthrimConfigSchema.safeParse(body);
      if (!parseResult.success) {
        return c.json({
          valid: false,
          errors: parseResult.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }

      return c.json({ valid: true, config: parseResult.data });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return c.json({ valid: false, error: 'Invalid JSON syntax' }, 400);
      }
      return c.json({ valid: false, error: sanitizeError(error) }, 500);
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
        const { env = 'prod', apiDomain, loginUiDomain, adminUiDomain, tenant, components } = body;

        const config = createDefaultConfig(env);

        // Update tenant configuration
        if (tenant) {
          config.tenant = {
            name: tenant.name || 'default',
            displayName: tenant.displayName || 'Default Tenant',
            multiTenant: tenant.multiTenant || false,
            baseDomain: tenant.baseDomain,
          };
        }

        // Update URLs with domain configuration
        config.urls = {
          api: {
            custom: apiDomain || null,
            auto: `https://${env}-ar-router.workers.dev`,
          },
          loginUi: {
            custom: loginUiDomain || null,
            auto: `https://${env}-ar-ui.pages.dev`,
          },
          adminUi: {
            custom: adminUiDomain || null,
            auto: `https://${env}-ar-ui.pages.dev/admin`,
          },
        };

        // Update components if provided
        if (components) {
          config.components = {
            ...config.components,
            ...components,
          };
        }

        state.config = config;

        return c.json({ success: true, config });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Check if keys exist for an environment
  api.get('/keys/check/:env', async (c) => {
    try {
      const env = c.req.param('env');
      const exists = keysExistForEnvironment(process.cwd(), env);
      return c.json({ exists, env });
    } catch (error) {
      return c.json({ exists: false, error: sanitizeError(error) });
    }
  });

  // Generate keys (with lock)
  api.post('/keys/generate', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { keyId, keysDir = '.keys', env } = body;

        addProgress('Generating cryptographic keys...');
        const secrets = generateAllSecrets(keyId);

        addProgress(`Saving keys to directory: .keys/${env || 'default'}/`);
        await saveKeysToDirectory(secrets, keysDir, env);

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

  // Save email provider configuration (with lock)
  const EmailConfigSchema = z.object({
    env: z.string().min(1).max(32),
    provider: z.enum(['resend', 'sendgrid', 'ses']),
    apiKey: z.string().min(1),
    fromAddress: z.string().email(),
    fromName: z.string().optional(),
  });

  api.post('/email/configure', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();

        // Validate request body
        const parseResult = EmailConfigSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json(
            {
              success: false,
              error:
                'Invalid request: ' + parseResult.error.issues.map((i) => i.message).join(', '),
            },
            400
          );
        }

        const { env, provider, apiKey, fromAddress, fromName } = parseResult.data;

        // Validate Resend API key format
        if (provider === 'resend' && !apiKey.startsWith('re_')) {
          // Warning but not an error - just log it
          addProgress('Warning: Resend API key should start with "re_"');
        }

        // Save secrets to keys directory
        const keysDir = `.keys/${env}`;

        // Ensure directory exists
        const { mkdir } = await import('node:fs/promises');
        await mkdir(keysDir, { recursive: true });

        // Save API key
        const apiKeyFile = join(keysDir, 'resend_api_key.txt');
        await writeFile(apiKeyFile, apiKey.trim());
        addProgress(`Saved ${provider} API key to ${apiKeyFile}`);

        // Save from address
        const fromAddressFile = join(keysDir, 'email_from.txt');
        await writeFile(fromAddressFile, fromAddress.trim());
        addProgress(`Saved email from address to ${fromAddressFile}`);

        // Save from name if provided
        if (fromName) {
          const fromNameFile = join(keysDir, 'email_from_name.txt');
          await writeFile(fromNameFile, fromName.trim());
          addProgress(`Saved email from name to ${fromNameFile}`);
        }

        addProgress('Email configuration saved successfully');

        return c.json({
          success: true,
          provider,
          fromAddress,
          message: 'Email configuration saved. Secrets will be uploaded during deployment.',
        });
      } catch (error) {
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Provision request schema (with database config validation)
  const ProvisionRequestSchema = z.object({
    env: z
      .string()
      .min(1)
      .max(32)
      .regex(
        /^[a-z][a-z0-9-]*$/,
        'Environment name must start with lowercase letter and contain only lowercase alphanumeric and hyphens'
      ),
    databaseConfig: z
      .object({
        core: z
          .object({
            location: D1LocationSchema.optional(),
            jurisdiction: D1JurisdictionSchema.optional(),
          })
          .optional(),
        pii: z
          .object({
            location: D1LocationSchema.optional(),
            jurisdiction: D1JurisdictionSchema.optional(),
          })
          .optional(),
      })
      .optional(),
    createQueues: z.boolean().optional(),
    createR2: z.boolean().optional(),
  });

  // Provision Cloudflare resources (with lock)
  api.post('/provision', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();

        // Validate request body
        const parseResult = ProvisionRequestSchema.safeParse(body);
        if (!parseResult.success) {
          return c.json(
            {
              success: false,
              error:
                'Invalid request: ' + parseResult.error.issues.map((i) => i.message).join(', '),
            },
            400
          );
        }

        const { env, databaseConfig, createQueues, createR2 } = parseResult.data;

        state.status = 'provisioning';
        clearProgress();

        addProgress(`Provisioning Cloudflare resources for ${env}...`);

        const resources = await provisionResources({
          env,
          rootDir: process.cwd(),
          createD1: true,
          createKV: true,
          createQueues: createQueues || false,
          createR2: createR2 || false,
          runMigrations: true,
          onProgress: addProgress,
          databaseConfig,
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
        // Include optional components (ar-policy, ar-bridge, etc.) based on config
        const enabledComponents = getEnabledComponents({
          saml: config.components?.saml,
          async: config.components?.async,
          vc: config.components?.vc,
          bridge: config.components?.bridge,
          policy: config.components?.policy,
        });

        const generatedComponents: string[] = [];
        for (const component of enabledComponents) {
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
        const { env, rootDir = '.', dryRun = false, components, skipBuild = false } = body;

        state.status = 'deploying';
        clearProgress();

        // Build packages first (unless dry-run or skipped)
        if (!dryRun && !skipBuild) {
          const buildResult = await buildApiPackages({
            rootDir: resolve(rootDir),
            onProgress: addProgress,
          });

          if (!buildResult.success) {
            state.status = 'error';
            state.error = `Build failed: ${buildResult.error}`;
            return c.json(
              {
                success: false,
                error: `Build failed: ${sanitizeError(new Error(buildResult.error))}`,
              },
              500
            );
          }
          addProgress('Packages built successfully');
        }

        // Upload secrets first (secrets are read but not stored in state)
        // Keys are stored in .keys/{env}/ directory
        const keysDir = `.keys/${env}`;
        if (!dryRun && existsSync(keysDir)) {
          addProgress(`Uploading secrets from ${keysDir}...`);

          const secrets: Record<string, string> = {};
          const secretFiles = [
            { file: `${keysDir}/private.pem`, name: 'PRIVATE_KEY_PEM' },
            { file: `${keysDir}/rp_token_encryption_key.txt`, name: 'RP_TOKEN_ENCRYPTION_KEY' },
            { file: `${keysDir}/admin_api_secret.txt`, name: 'ADMIN_API_SECRET' },
            { file: `${keysDir}/key_manager_secret.txt`, name: 'KEY_MANAGER_SECRET' },
            // Email provider secrets (optional)
            { file: `${keysDir}/resend_api_key.txt`, name: 'RESEND_API_KEY' },
            { file: `${keysDir}/email_from.txt`, name: 'EMAIL_FROM' },
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
        } else if (!dryRun) {
          addProgress(`Warning: Keys directory not found at ${keysDir}`);
        }

        addProgress('Deploying workers...');

        // Determine enabled components from config (same logic as CLI)
        let enabledComponents: WorkerComponent[] | undefined = components;
        if (!enabledComponents && state.config) {
          const cfg = state.config;
          enabledComponents = [
            'ar-lib-core',
            'ar-discovery',
            'ar-auth',
            'ar-token',
            'ar-userinfo',
            'ar-management',
          ];
          // Add optional components based on config
          if (cfg.components?.saml) enabledComponents.push('ar-saml');
          if (cfg.components?.async) enabledComponents.push('ar-async');
          if (cfg.components?.vc) enabledComponents.push('ar-vc');
          if (cfg.components?.bridge) enabledComponents.push('ar-bridge');
          if (cfg.components?.policy) enabledComponents.push('ar-policy');
          // Router is always last
          enabledComponents.push('ar-router');
        }

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

        // Deploy Pages (ar-ui) if loginUi or adminUi is enabled
        let pagesDeployResult = null;
        const cfg = state.config;
        if (cfg?.components?.loginUi || cfg?.components?.adminUi) {
          addProgress('Deploying Login/Admin UI to Cloudflare Pages...');
          pagesDeployResult = await deployPages({
            env,
            rootDir: resolve(rootDir),
            dryRun,
            onProgress: addProgress,
            projectName: `${env}-ar-ui`,
          });

          if (pagesDeployResult.success) {
            addProgress(`✓ UI deployed to Pages: ${pagesDeployResult.projectName}`);
          } else {
            addProgress(`✗ Pages deployment failed: ${pagesDeployResult.error}`);
          }
        }

        const workersSuccess = summary.failedCount === 0;
        const pagesSuccess = pagesDeployResult ? pagesDeployResult.success : true;

        if (workersSuccess && pagesSuccess) {
          state.status = 'complete';
          addProgress('Deployment complete!');
        } else {
          state.status = 'error';
          if (!workersSuccess) {
            state.error = `${summary.failedCount} components failed to deploy`;
          } else if (!pagesSuccess) {
            state.error = `Pages deployment failed: ${pagesDeployResult?.error}`;
          }
        }

        return c.json({
          success: workersSuccess && pagesSuccess,
          summary,
          pagesResult: pagesDeployResult,
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

        addProgress(`Admin setup request: env=${env}, baseUrl=${baseUrl}, keysDir=${keysDir}`);

        if (!env || !baseUrl) {
          addProgress('Error: env and baseUrl are required');
          return c.json({ success: false, error: 'env and baseUrl are required' }, 400);
        }

        addProgress('Setting up initial admin...');
        addProgress(`Looking for setup token at: ${keysDir}/${env}/setup_token.txt`);

        const result = await completeInitialSetup({
          env,
          baseUrl,
          keysDir,
          onProgress: addProgress,
        });

        addProgress(`completeInitialSetup result: ${JSON.stringify(result)}`);

        if (result.alreadyCompleted) {
          addProgress('Initial admin setup already completed');
          return c.json({
            success: true,
            alreadyCompleted: true,
            message: 'Initial admin setup was already completed',
          });
        }

        if (result.success && result.setupUrl) {
          addProgress(`Setup token stored successfully. URL: ${result.setupUrl}`);
          return c.json({
            success: true,
            setupUrl: result.setupUrl,
            message: 'Visit the setup URL to create the initial administrator',
          });
        }

        addProgress(`Admin setup failed: ${result.error}`);
        return c.json({ success: false, error: result.error }, 500);
      } catch (error) {
        addProgress(`Admin setup exception: ${sanitizeError(error)}`);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Check admin setup status for an environment (no auth required - read-only)
  api.get('/admin/status/:kvNamespaceId', async (c) => {
    try {
      const kvNamespaceId = c.req.param('kvNamespaceId');
      if (!kvNamespaceId || !/^[a-f0-9]{32}$/i.test(kvNamespaceId)) {
        return c.json({ success: false, error: 'Invalid KV namespace ID' }, 400);
      }

      const status = await checkAdminSetupStatus(kvNamespaceId);
      return c.json({
        success: true,
        adminSetupCompleted: status.completed,
        error: status.error,
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Generate and store a new setup token (requires session validation)
  api.use('/admin/generate-token', validateSession);
  api.post('/admin/generate-token', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { kvNamespaceId, baseUrl } = body;

        if (!kvNamespaceId || !/^[a-f0-9]{32}$/i.test(kvNamespaceId)) {
          return c.json({ success: false, error: 'Invalid KV namespace ID' }, 400);
        }

        if (!baseUrl) {
          return c.json({ success: false, error: 'baseUrl is required' }, 400);
        }

        // Check if admin setup is already completed
        const status = await checkAdminSetupStatus(kvNamespaceId);
        if (status.completed) {
          return c.json({
            success: false,
            error: 'Admin setup has already been completed for this environment',
            alreadyCompleted: true,
          }, 400);
        }

        // Generate and store new token
        const result = await generateAndStoreSetupToken(kvNamespaceId);
        if (!result.success || !result.token) {
          return c.json({ success: false, error: result.error || 'Failed to generate token' }, 500);
        }

        // Construct setup URL
        const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
        const setupUrl = `${cleanBaseUrl}/admin-init-setup?token=${result.token}`;

        return c.json({
          success: true,
          setupUrl,
          message: 'Setup token generated. Visit the URL to create the initial administrator.',
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // =============================================================================
  // Environment Management
  // =============================================================================

  // List all detected Authrim environments (no auth required - read-only)
  api.get('/environments', async (c) => {
    try {
      clearProgress();
      addProgress('Scanning Cloudflare account for Authrim environments...');

      const environments = await detectEnvironments(addProgress);

      return c.json({
        success: true,
        environments,
        progress: state.progress,
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Apply session validation to environment delete
  api.use('/environments/*/delete', validateSession);

  // Delete an environment (with lock)
  api.post('/environments/:env/delete', async (c) => {
    return withLock(async () => {
      try {
        const env = c.req.param('env');
        const body = await c.req.json();
        const {
          deleteWorkers = true,
          deleteD1 = true,
          deleteKV = true,
          deleteQueues = true,
          deleteR2 = true,
          deletePages = true,
        } = body;

        state.status = 'provisioning'; // Reuse provisioning status
        clearProgress();

        const result = await deleteEnvironment({
          env,
          deleteWorkers,
          deleteD1,
          deleteKV,
          deleteQueues,
          deleteR2,
          deletePages,
          onProgress: addProgress,
        });

        state.status = result.success ? 'complete' : 'error';
        if (!result.success) {
          state.error = result.errors.join(', ');
        }

        return c.json({
          success: result.success,
          deleted: result.deleted,
          errors: result.errors,
          progress: state.progress,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Get D1 database details (no auth required - read-only)
  api.get('/d1/:name/info', async (c) => {
    try {
      const name = c.req.param('name');
      const { getD1Info } = await import('../core/cloudflare.js');
      const info = await getD1Info(name);
      return c.json({ success: true, info });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Get Worker deployment info (no auth required - read-only)
  api.get('/worker/:name/deployments', async (c) => {
    try {
      const name = c.req.param('name');
      const { getWorkerDeployments } = await import('../core/cloudflare.js');
      const deployments = await getWorkerDeployments(name);
      return c.json({ success: true, deployments });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  return api;
}
