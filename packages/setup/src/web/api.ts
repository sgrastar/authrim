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
  runMigrationsForEnvironment,
  getWorkerDeployments,
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
import { createLockFile, saveLockFile } from '../core/lock.js';
import {
  getEnvironmentPaths,
  getExternalKeysDir,
  findKeysDirectory,
  resolvePaths,
  listEnvironments,
  findAuthrimBaseDir,
  type EnvironmentPaths,
  type LegacyPaths,
} from '../core/paths.js';
import { generateWranglerConfig, toToml } from '../core/wrangler.js';
import { syncWranglerConfigs } from '../core/wrangler-sync.js';
import {
  deployAll,
  uploadSecrets,
  buildApiPackages,
  deployAllPages,
  deployPagesComponent,
  deployWorker,
  PAGES_COMPONENTS,
  type DeployResult,
  type PagesComponent,
} from '../core/deploy.js';
import { getEnabledComponents, WORKER_COMPONENTS, type WorkerComponent } from '../core/naming.js';
import {
  getLocalPackageVersions,
  compareVersions,
  getComponentsToUpdate,
} from '../core/version.js';
import { completeInitialSetup } from '../core/admin.js';
import { writeFile, chmod } from 'node:fs/promises';
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
  // Supports both new (.authrim/{env}/config.json) and legacy (authrim-config.json) structures
  api.get('/config', async (c) => {
    const envParam = c.req.query('env');
    const baseDir = findAuthrimBaseDir(process.cwd());

    // Find config file
    let configPath: string | null = null;
    let structureType: 'new' | 'legacy' = 'legacy';

    if (envParam) {
      // Specific environment requested
      const resolved = resolvePaths({ baseDir, env: envParam });
      if (resolved.type === 'new') {
        configPath = (resolved.paths as EnvironmentPaths).config;
        structureType = 'new';
      } else {
        configPath = (resolved.paths as LegacyPaths).config;
        structureType = 'legacy';
      }
    } else {
      // Auto-detect: try new structure first, then legacy
      const environments = listEnvironments(baseDir);
      if (environments.length > 0) {
        const envPaths = getEnvironmentPaths({ baseDir, env: environments[0] });
        if (existsSync(envPaths.config)) {
          configPath = envPaths.config;
          structureType = 'new';
        }
      }
      if (!configPath || !existsSync(configPath)) {
        configPath = 'authrim-config.json';
        structureType = 'legacy';
      }
    }

    if (!existsSync(configPath)) {
      return c.json({
        exists: false,
        config: null,
        structure: structureType,
        environments: listEnvironments(baseDir),
      });
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
          structure: structureType,
          configPath,
          environments: listEnvironments(baseDir),
          errors: parseResult.error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }

      state.config = parseResult.data;
      return c.json({
        exists: true,
        config: parseResult.data,
        valid: true,
        structure: structureType,
        configPath,
        environments: listEnvironments(baseDir),
      });
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
  // Saves to new structure: .authrim/{env}/config.json
  api.post('/config', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const config = AuthrimConfigSchema.parse(body);
        const baseDir = findAuthrimBaseDir(process.cwd());
        const env = config.environment.prefix;

        // Use new structure for saving
        const envPaths = getEnvironmentPaths({ baseDir, env });

        // Ensure directory exists
        const { mkdir } = await import('node:fs/promises');
        await mkdir(envPaths.root, { recursive: true });

        // Save config
        await writeFile(envPaths.config, JSON.stringify(config, null, 2));
        state.config = config;

        return c.json({ success: true, configPath: envPaths.config, structure: 'new' });
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
            auto: `https://${env}-ar-login-ui.pages.dev`,
            sameAsApi: false,
          },
          adminUi: {
            custom: adminUiDomain || null,
            auto: `https://${env}-ar-admin-ui.pages.dev`,
            sameAsApi: false,
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
      const baseDir = findAuthrimBaseDir(process.cwd());
      const exists = keysExistForEnvironment(baseDir, env, process.cwd());
      return c.json({ exists, env });
    } catch (error) {
      return c.json({ exists: false, error: sanitizeError(error) });
    }
  });

  // Generate keys (with lock)
  // Saves to external structure: {cwd}/.authrim-keys/{env}/
  api.post('/keys/generate', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { keyId, env } = body;
        const envName = env || 'default';
        const keysBaseDir = process.cwd();

        addProgress('Generating cryptographic keys...');
        const secrets = generateAllSecrets(keyId);

        // Save to external keys directory: {cwd}/.authrim-keys/{env}/
        const externalKeysDir = getExternalKeysDir(envName, keysBaseDir);
        addProgress(`Saving keys to directory: ${externalKeysDir}/`);
        await saveKeysToDirectory(secrets, { keysBaseDir, env: envName });

        addProgress('Keys generated successfully');

        // Only return public information
        return c.json({
          success: true,
          keyId: secrets.keyPair.keyId,
          publicKeyJwk: secrets.keyPair.publicKeyJwk,
          keysPath: externalKeysDir,
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

        // Save secrets to external keys directory: {cwd}/.authrim-keys/{env}/
        const keysBaseDir = process.cwd();
        const keysDir = getExternalKeysDir(env, keysBaseDir);
        const baseDir = findAuthrimBaseDir(keysBaseDir);
        const envPaths = getEnvironmentPaths({ baseDir, env, keysBaseDir });

        // Ensure directory exists with restrictive permissions
        const { mkdir } = await import('node:fs/promises');
        await mkdir(keysDir, { recursive: true, mode: 0o700 });

        // Save API key with restrictive permissions
        await writeFile(envPaths.keyFiles.resendApiKey, apiKey.trim());
        await chmod(envPaths.keyFiles.resendApiKey, 0o600);
        addProgress(`Saved ${provider} API key to ${envPaths.keyFiles.resendApiKey}`);

        // Save from address with restrictive permissions
        await writeFile(envPaths.keyFiles.emailFrom, fromAddress.trim());
        await chmod(envPaths.keyFiles.emailFrom, 0o600);
        addProgress(`Saved email from address to ${envPaths.keyFiles.emailFrom}`);

        // Save from name if provided
        if (fromName) {
          const fromNameFile = join(keysDir, 'email_from_name.txt');
          await writeFile(fromNameFile, fromName.trim());
          await chmod(fromNameFile, 0o600);
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

  // Common environment name validation schema
  const EnvNameSchema = z
    .string()
    .min(1)
    .max(32)
    .regex(
      /^[a-z][a-z0-9-]*$/,
      'Environment name must start with lowercase letter and contain only lowercase alphanumeric and hyphens'
    );

  // Provision request schema (with database config validation)
  const ProvisionRequestSchema = z.object({
    env: EnvNameSchema,
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
        const rootDir = findAuthrimBaseDir(process.cwd());
        await saveLockFile(lock, { env, baseDir: rootDir });

        // Save config.json
        addProgress('Saving config.json...');
        // Use existing state.config if available (from /config/default), otherwise create new
        // Merge with default config to ensure all required fields are present
        const baseConfig = createDefaultConfig(env);
        const config = state.config
          ? {
              ...baseConfig,
              ...state.config,
              // Preserve components from state.config
              components: { ...baseConfig.components, ...state.config.components },
            }
          : baseConfig;
        config.createdAt = new Date().toISOString();
        config.updatedAt = new Date().toISOString();

        // Get workers subdomain and set auto-detected URLs
        const workersSubdomain = await getWorkersSubdomain();
        // Always set URLs - use workersSubdomain if available, otherwise use default workers.dev pattern
        const apiUrl = workersSubdomain
          ? `https://${env}-ar-router.${workersSubdomain}.workers.dev`
          : `https://${env}-ar-router.workers.dev`;
        const loginUiUrl = `https://${env}-ar-login-ui.pages.dev`;
        const adminUiUrl = `https://${env}-ar-admin-ui.pages.dev`;

        config.urls = {
          api: { auto: apiUrl },
          loginUi: { sameAsApi: false, auto: loginUiUrl },
          adminUi: { sameAsApi: false, auto: adminUiUrl },
        };
        addProgress(`Configured URLs: API=${apiUrl}`);

        const envPaths = getEnvironmentPaths({ baseDir: rootDir, env });
        await writeFile(envPaths.config, JSON.stringify(config, null, 2), 'utf-8');
        state.config = config;

        // Generate wrangler.toml files
        addProgress('Generating wrangler.toml files...');
        const resourceIds = {
          d1: lock.d1,
          kv: Object.fromEntries(
            Object.entries(lock.kv).map(([k, v]) => [k, { id: v.id, name: v.name }])
          ),
          queues: lock.queues,
          r2: lock.r2,
        };

        const enabledComponents = getEnabledComponents({
          saml: config.components?.saml,
          async: config.components?.async,
          vc: config.components?.vc,
          bridge: config.components?.bridge,
          policy: config.components?.policy,
        });

        for (const component of enabledComponents) {
          const componentDir = join(rootDir, 'packages', component);
          if (!existsSync(componentDir)) {
            continue;
          }

          const wranglerConfig = generateWranglerConfig(
            component,
            config,
            resourceIds,
            workersSubdomain ?? undefined
          );
          const tomlContent = toToml(wranglerConfig, env);
          const tomlPath = join(componentDir, 'wrangler.toml');
          await writeFile(tomlPath, tomlContent, 'utf-8');
        }

        state.status = 'configuring';
        addProgress('Provisioning complete!');

        return c.json({
          success: true,
          resources,
          lock,
          config,
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

        // Load lock file (use loadLockFileAuto to correctly resolve new structure path)
        const { loadLockFileAuto } = await import('../core/lock.js');
        const { lock } = await loadLockFileAuto(rootDir, env);
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

        // Get workers.dev subdomain for CORS configuration
        // Workers.dev URLs must be in format: {name}.{subdomain}.workers.dev
        const workersSubdomain = await getWorkersSubdomain();

        const generatedComponents: string[] = [];
        for (const component of enabledComponents) {
          const componentDir = join(rootDir, 'packages', component);
          if (!existsSync(componentDir)) {
            continue;
          }

          const wranglerConfig = generateWranglerConfig(
            component,
            config,
            resourceIds,
            workersSubdomain ?? undefined
          );
          // Generate TOML with [env.{env}] section format
          const tomlContent = toToml(wranglerConfig, env);
          const tomlPath = join(componentDir, 'wrangler.toml');
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
        const {
          env,
          rootDir = process.cwd(),
          dryRun = false,
          components,
          skipBuild = false,
          runMigrations = true,
        } = body;

        state.status = 'deploying';
        clearProgress();

        // Debug: Log the resolved rootDir for migrations
        addProgress(`📂 Working directory: ${resolve(rootDir)}`);

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
        // Check external (.authrim-keys/), new (.authrim/{env}/keys/), and legacy (.keys/{env}/) structures
        const baseDir = findAuthrimBaseDir(process.cwd());
        const resolved = resolvePaths({ baseDir, env });
        let keysDir: string;
        const foundKeys = findKeysDirectory({
          env,
          sourceDir: baseDir,
          keysBaseDir: process.cwd(),
        });
        if (foundKeys) {
          keysDir = foundKeys.path;
        } else if (resolved.type === 'new') {
          keysDir = (resolved.paths as EnvironmentPaths).keys;
        } else {
          keysDir = (resolved.paths as LegacyPaths).keys;
        }

        if (!dryRun && existsSync(keysDir)) {
          addProgress(`Uploading secrets from ${keysDir}...`);

          const secrets: Record<string, string> = {};
          const secretFiles = [
            { file: join(keysDir, 'private.pem'), name: 'PRIVATE_KEY_PEM' },
            { file: join(keysDir, 'rp_token_encryption_key.txt'), name: 'RP_TOKEN_ENCRYPTION_KEY' },
            { file: join(keysDir, 'admin_api_secret.txt'), name: 'ADMIN_API_SECRET' },
            { file: join(keysDir, 'key_manager_secret.txt'), name: 'KEY_MANAGER_SECRET' },
            // Email provider secrets (optional)
            { file: join(keysDir, 'resend_api_key.txt'), name: 'RESEND_API_KEY' },
            { file: join(keysDir, 'email_from.txt'), name: 'EMAIL_FROM' },
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

        // Validate wrangler.toml files against lock file before deploying
        // This prevents deployment failures due to stale resource IDs
        if (!dryRun) {
          const { loadLockFileAuto } = await import('../core/lock.js');
          const { lock } = await loadLockFileAuto(rootDir, env);

          if (lock) {
            const { validateWranglerConfigs, generateWranglerConfig, toToml } =
              await import('../core/wrangler.js');
            const { getEnabledComponents } = await import('../core/naming.js');
            const { getWorkersSubdomain } = await import('../core/cloudflare.js');

            // Build resource IDs from lock file
            const lockResourceIds = {
              d1: lock.d1,
              kv: Object.fromEntries(
                Object.entries(lock.kv).map(([k, v]) => [k, { id: v.id, name: v.name }])
              ),
              queues: lock.queues,
              r2: lock.r2,
            };

            // Get enabled components
            const cfg = state.config || {};
            const enabledForValidation = getEnabledComponents({
              saml: cfg.components?.saml,
              async: cfg.components?.async,
              vc: cfg.components?.vc,
              bridge: cfg.components?.bridge,
              policy: cfg.components?.policy,
            });

            // Validate wrangler.toml files
            const enabledComponentsArray = [...enabledForValidation];
            const validation = await validateWranglerConfigs(
              resolve(rootDir),
              env,
              lockResourceIds,
              enabledComponentsArray
            );

            if (!validation.valid) {
              addProgress(
                `⚠️ Detected outdated wrangler.toml files (${validation.mismatches.length} mismatches)`
              );
              addProgress('Regenerating wrangler.toml files with correct resource IDs...');

              // Regenerate wrangler.toml files
              const workersSubdomain = await getWorkersSubdomain();
              let config: AuthrimConfig;
              if (state.config) {
                config = AuthrimConfigSchema.parse(state.config);
              } else {
                config = createDefaultConfig(env);
              }

              for (const component of enabledForValidation) {
                const componentDir = join(resolve(rootDir), 'packages', component);
                if (!existsSync(componentDir)) {
                  continue;
                }

                const wranglerConfig = generateWranglerConfig(
                  component,
                  config,
                  lockResourceIds,
                  workersSubdomain ?? undefined
                );
                const tomlContent = toToml(wranglerConfig, env);
                const tomlPath = join(componentDir, 'wrangler.toml');
                await writeFile(tomlPath, tomlContent, 'utf-8');
              }

              addProgress('✓ wrangler.toml files regenerated');
            }
          }
        }

        addProgress('Deploying workers...');

        // Determine enabled components from config (same logic as CLI)
        // Load config from file if state.config is not set (e.g., after page reload)
        let enabledComponents: WorkerComponent[] | undefined = components;
        let cfg = state.config;

        if (!enabledComponents && !cfg) {
          // Try to load config.json from disk
          try {
            const configPath =
              resolved.type === 'new'
                ? (resolved.paths as EnvironmentPaths).config
                : (resolved.paths as LegacyPaths).config;

            if (existsSync(configPath)) {
              const configContent = await readFile(configPath, 'utf-8');
              cfg = JSON.parse(configContent);
              state.config = cfg; // Cache for later use
              addProgress(`Loaded config from ${configPath}`);
            }
          } catch (configErr) {
            addProgress(`Warning: Could not load config.json: ${sanitizeError(configErr)}`);
          }
        }

        if (!enabledComponents && cfg) {
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

        // Deploy Pages (ar-login-ui, ar-admin-ui) if loginUi or adminUi is enabled
        let pagesSummary = null;
        // Note: cfg is already loaded above (from state.config or config.json file)
        if (cfg?.components?.loginUi || cfg?.components?.adminUi) {
          addProgress('Deploying Login/Admin UI to Cloudflare Pages...');

          // Determine the API base URL for the UI to connect to
          // Priority: custom API domain > workers.dev domain
          const apiBaseUrl =
            cfg?.urls?.api?.custom ||
            cfg?.urls?.api?.auto ||
            `https://${env}-ar-router.workers.dev`;

          // Get ui.env path for Vite builds (new structure only)
          // Always regenerate ui.env from config to ensure sync
          let uiEnvPath: string | undefined;
          if (resolved.type === 'new') {
            uiEnvPath = (resolved.paths as EnvironmentPaths).uiEnv;

            // Regenerate ui.env from config.json to ensure they are in sync
            // Detect if custom domains are used (same registrable domain = no need for proxy)
            const apiHasCustomDomain = !!cfg?.urls?.api?.custom;
            const adminUiHasCustomDomain = !!cfg?.urls?.adminUi?.custom;
            const useDirectMode = apiHasCustomDomain && adminUiHasCustomDomain;

            const { saveUiEnv } = await import('../core/ui-env.js');
            try {
              if (useDirectMode) {
                await saveUiEnv(uiEnvPath, {
                  PUBLIC_API_BASE_URL: apiBaseUrl, // Frontend sends directly to backend
                  API_BACKEND_URL: '', // Proxy disabled
                });
                addProgress(`ui.env synced (direct mode: ${apiBaseUrl})`);
                addProgress(`Custom domains detected - Safari ITP proxy disabled`);
              } else {
                await saveUiEnv(uiEnvPath, {
                  PUBLIC_API_BASE_URL: '', // Empty for proxy mode (same-origin)
                  API_BACKEND_URL: apiBaseUrl, // Server-side proxy target
                });
                addProgress(`ui.env synced (proxy mode: ${apiBaseUrl})`);
              }
            } catch (syncError) {
              addProgress(`⚠️  Could not sync ui.env: ${syncError}`);
            }
          }

          pagesSummary = await deployAllPages(
            {
              env,
              rootDir: resolve(rootDir),
              dryRun,
              onProgress: addProgress,
              apiBaseUrl,
              uiEnvPath,
            },
            {
              loginUi: cfg?.components?.loginUi ?? true,
              adminUi: cfg?.components?.adminUi ?? true,
            }
          );

          if (pagesSummary.failedCount === 0) {
            addProgress('✓ All UI packages deployed to Pages');
            for (const result of pagesSummary.results) {
              addProgress(`  • ${result.component}: ${result.projectName}`);
            }
          } else {
            addProgress(
              `✗ Pages deployment: ${pagesSummary.successCount}/${pagesSummary.results.length} succeeded`
            );
            for (const result of pagesSummary.results) {
              if (!result.success) {
                addProgress(`  ✗ ${result.component}: ${result.error}`);
              }
            }
          }
        }

        const workersSuccess = summary.failedCount === 0;
        const pagesSuccess = pagesSummary ? pagesSummary.failedCount === 0 : true;

        // Update lock file with deployed workers information
        if (workersSuccess && !dryRun && summary.successCount > 0) {
          try {
            const { loadLockFileAuto, saveLockFile: saveLock } = await import('../core/lock.js');
            const { lock: currentLock, path: lockPath } = await loadLockFileAuto(rootDir, env);

            if (currentLock && lockPath) {
              const workers: Record<
                string,
                { name: string; deployedAt?: string; version?: string }
              > = { ...currentLock.workers };

              for (const result of summary.results) {
                if (result.success && result.deployedAt) {
                  workers[result.component] = {
                    name: result.workerName,
                    deployedAt: result.deployedAt,
                    version: result.version,
                  };
                }
              }

              const updatedLock = {
                ...currentLock,
                workers,
                updatedAt: new Date().toISOString(),
              };

              await saveLock(updatedLock, lockPath);
              addProgress('Lock file updated with deployment info');
            }
          } catch (lockError) {
            // Non-fatal: log but continue
            addProgress(`Warning: Could not update lock file: ${sanitizeError(lockError)}`);
          }
        }

        // Run D1 migrations after deployment (if enabled and not dry-run)
        let migrationsResult = null;
        if (runMigrations && !dryRun && workersSuccess) {
          addProgress('📜 Running D1 database migrations...');
          migrationsResult = await runMigrationsForEnvironment(env, resolve(rootDir), addProgress);

          if (migrationsResult.success) {
            addProgress('✅ Database migrations completed successfully');
          } else {
            addProgress(
              `⚠️ Some migrations failed - core: ${migrationsResult.core.error || 'ok'}, pii: ${migrationsResult.pii.error || 'ok'}, admin: ${migrationsResult.admin.error || 'ok'}`
            );
          }
        }

        const migrationsSuccess = migrationsResult ? migrationsResult.success : true;

        if (workersSuccess && pagesSuccess && migrationsSuccess) {
          state.status = 'complete';
          addProgress('Deployment complete!');
        } else {
          state.status = 'error';
          if (!workersSuccess) {
            state.error = `${summary.failedCount} components failed to deploy`;
          } else if (!pagesSuccess) {
            const failedPages = pagesSummary?.results.filter((r) => !r.success) ?? [];
            state.error = `Pages deployment failed: ${failedPages.map((r) => `${r.component}: ${r.error}`).join(', ')}`;
          } else if (!migrationsSuccess) {
            const errors = [];
            if (migrationsResult?.core.error) errors.push(`core: ${migrationsResult.core.error}`);
            if (migrationsResult?.pii.error) errors.push(`pii: ${migrationsResult.pii.error}`);
            if (migrationsResult?.admin.error)
              errors.push(`admin: ${migrationsResult.admin.error}`);
            state.error = `Migrations failed: ${errors.join(', ')}`;
          }
        }

        return c.json({
          success: workersSuccess && pagesSuccess && migrationsSuccess,
          summary,
          pagesResult: pagesSummary,
          migrationsResult,
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
  // Supports external (.authrim-keys/), internal (.authrim/{env}/keys/), and legacy (.keys/{env}/) structures
  api.post('/admin/setup', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env, baseUrl } = body;
        const baseDir = findAuthrimBaseDir(process.cwd());

        // Determine structure type
        const resolved = resolvePaths({ baseDir, env });
        const isLegacy = resolved.type === 'legacy';

        // Detect actual token path using 3-tier fallback (external → internal → legacy)
        const foundKeys = findKeysDirectory({
          env,
          sourceDir: baseDir,
          keysBaseDir: process.cwd(),
        });
        const tokenPath = foundKeys
          ? join(foundKeys.path, 'setup_token.txt')
          : isLegacy
            ? (resolved.paths as LegacyPaths).keyFiles.setupToken
            : (resolved.paths as EnvironmentPaths).keyFiles.setupToken;

        addProgress(
          `Admin setup request: env=${env}, baseUrl=${baseUrl}, structure=${resolved.type}`
        );

        if (!env || !baseUrl) {
          addProgress('Error: env and baseUrl are required');
          return c.json({ success: false, error: 'env and baseUrl are required' }, 400);
        }

        addProgress('Setting up initial admin...');
        addProgress(`Looking for setup token at: ${tokenPath}`);

        const result = await completeInitialSetup({
          env,
          baseUrl,
          baseDir,
          keysBaseDir: process.cwd(),
          legacy: isLegacy,
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
            expiresAt: result.expiresAt,
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
          return c.json(
            {
              success: false,
              error: 'Admin setup has already been completed for this environment',
              alreadyCompleted: true,
            },
            400
          );
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
          expiresAt: result.expiresAt,
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

  // =============================================================================
  // Worker Update
  // =============================================================================

  // Get version comparison for an environment (no auth required - read-only, localhost only)
  api.get('/update/compare/:env', async (c) => {
    try {
      const envParam = c.req.param('env');

      // Validate environment name to prevent path traversal
      const parseResult = EnvNameSchema.safeParse(envParam);
      if (!parseResult.success) {
        return c.json({ success: false, error: 'Invalid environment name' }, 400);
      }
      const env = parseResult.data;
      const rootDir = process.cwd();

      // Load lock file to get deployed versions
      const { loadLockFileAuto } = await import('../core/lock.js');
      const { lock } = await loadLockFileAuto(rootDir, env);

      // Build deployed versions from lock file or fallback to wrangler check
      const deployedVersions: Record<string, { version?: string; deployedAt?: string }> = {};
      let hasLockWorkers = false;

      if (lock?.workers && Object.keys(lock.workers).length > 0) {
        // Use lock file data if available
        hasLockWorkers = true;
        for (const [component, info] of Object.entries(lock.workers)) {
          deployedVersions[component] = {
            version: info.version,
            deployedAt: info.deployedAt,
          };
        }
      }

      // Get local package versions
      const localVersions = await getLocalPackageVersions(rootDir);

      // If no lock file or no workers in lock, check wrangler for deployment status
      // Use parallel requests with timeout to avoid slow sequential API calls
      if (!hasLockWorkers) {
        const { WORKER_COMPONENTS } = await import('../core/naming.js');
        // Check core workers first (in parallel) to determine if environment is deployed
        const coreWorkers: WorkerComponent[] = ['ar-lib-core', 'ar-router', 'ar-auth'];

        const coreResults = await Promise.allSettled(
          coreWorkers.map(async (component) => {
            const workerName = `${env}-${component}`;
            const deployInfo = await getWorkerDeployments(workerName);
            return { component, deployInfo };
          })
        );

        for (const result of coreResults) {
          if (result.status === 'fulfilled' && result.value.deployInfo.exists) {
            deployedVersions[result.value.component] = {
              version: undefined,
              deployedAt: result.value.deployInfo.lastDeployedAt || undefined,
            };
          }
        }

        // If core workers are deployed, check remaining workers in parallel
        if (Object.keys(deployedVersions).length > 0) {
          const remainingComponents = WORKER_COMPONENTS.filter(
            (c) => !deployedVersions[c] && !coreWorkers.includes(c)
          );

          const remainingResults = await Promise.allSettled(
            remainingComponents.map(async (component) => {
              const workerName = `${env}-${component}`;
              const deployInfo = await getWorkerDeployments(workerName);
              return { component, deployInfo };
            })
          );

          for (const result of remainingResults) {
            if (result.status === 'fulfilled' && result.value.deployInfo.exists) {
              deployedVersions[result.value.component] = {
                version: undefined,
                deployedAt: result.value.deployInfo.lastDeployedAt || undefined,
              };
            }
          }
        }
      }

      // Compare versions
      const comparison = compareVersions(localVersions, deployedVersions);

      return c.json({
        success: true,
        env,
        comparison,
        hasLockFile: !!lock,
        hasLockWorkers,
        summary: {
          total: comparison.length,
          needsUpdate: comparison.filter((c) => c.needsUpdate).length,
          upToDate: comparison.filter((c) => !c.needsUpdate).length,
        },
      });
    } catch (error) {
      return c.json({ success: false, error: sanitizeError(error) }, 500);
    }
  });

  // Apply session validation to update endpoint
  api.use('/update/workers', validateSession);

  // Update workers for an environment (with lock)
  api.post('/update/workers', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env: envParam, onlyChanged = true } = body;
        const rootDir = process.cwd();

        // Validate environment name to prevent path traversal
        const parseResult = EnvNameSchema.safeParse(envParam);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = parseResult.data;

        state.status = 'deploying';
        clearProgress();
        addProgress(`Starting worker update for environment: ${env}`);

        // Load lock file
        const { loadLockFileAuto, saveLockFile: saveLock } = await import('../core/lock.js');
        const { lock, path: lockPath } = await loadLockFileAuto(rootDir, env);

        if (!lock) {
          state.status = 'error';
          return c.json(
            {
              success: false,
              error: `Environment "${env}" not found.`,
            },
            404
          );
        }

        // Build deployed versions from lock file
        const deployedVersions: Record<string, { version?: string; deployedAt?: string }> = {};
        if (lock.workers) {
          for (const [component, info] of Object.entries(lock.workers)) {
            deployedVersions[component] = {
              version: info.version,
              deployedAt: info.deployedAt,
            };
          }
        }

        // Get local package versions
        const localVersions = await getLocalPackageVersions(rootDir);

        // Compare and get components to update
        const comparison = compareVersions(localVersions, deployedVersions);
        const componentsToUpdate = getComponentsToUpdate(comparison, !onlyChanged);

        if (componentsToUpdate.length === 0) {
          state.status = 'complete';
          addProgress('All workers are up to date. No updates needed.');
          return c.json({
            success: true,
            message: 'All workers are up to date',
            summary: { totalComponents: 0, successCount: 0, failedCount: 0 },
          });
        }

        addProgress(`${componentsToUpdate.length} worker(s) need updating`);

        // Sync wrangler configs before building (copies from .authrim/{env}/wrangler/ to packages/)
        addProgress('Syncing wrangler configs...');
        const syncResult = await syncWranglerConfigs({
          baseDir: rootDir,
          env,
          packagesDir: join(rootDir, 'packages'),
          force: true, // Overwrite any changes in packages/
          dryRun: false,
          onProgress: addProgress,
        });

        if (!syncResult.success && syncResult.errors.length > 0) {
          // If master wrangler configs don't exist, we can't proceed
          state.status = 'error';
          state.error = `Wrangler config sync failed: ${syncResult.errors.join(', ')}`;
          return c.json({ success: false, error: state.error }, 500);
        }

        addProgress(`Synced ${syncResult.synced.length} wrangler config(s)`);

        // Build packages
        addProgress('Building packages...');
        const buildResult = await buildApiPackages({
          rootDir: resolve(rootDir),
          onProgress: addProgress,
        });

        if (!buildResult.success) {
          state.status = 'error';
          state.error = `Build failed: ${buildResult.error}`;
          return c.json({ success: false, error: state.error }, 500);
        }

        // Deploy workers
        addProgress('Deploying workers...');
        const summary = await deployAll(
          {
            env,
            rootDir: resolve(rootDir),
            onProgress: addProgress,
            onError: (comp, error) => {
              addProgress(`Error in ${comp}: ${sanitizeError(error)}`);
            },
          },
          componentsToUpdate
        );

        // Update lock file with new versions
        if (summary.successCount > 0) {
          const workers = { ...lock.workers };
          for (const result of summary.results) {
            if (result.success && result.deployedAt) {
              workers[result.component] = {
                name: result.workerName,
                deployedAt: result.deployedAt,
                version: localVersions[result.component] || result.version,
              };
            }
          }

          const updatedLock = {
            ...lock,
            workers,
            updatedAt: new Date().toISOString(),
          };

          await saveLock(updatedLock, lockPath);
          addProgress(`Lock file updated: ${lockPath}`);
        }

        state.status = summary.failedCount === 0 ? 'complete' : 'error';

        if (summary.failedCount === 0) {
          addProgress(`Successfully updated ${summary.successCount} worker(s)`);
        } else {
          addProgress(
            `Updated ${summary.successCount}/${summary.totalComponents}, ${summary.failedCount} failed`
          );
        }

        return c.json({
          success: summary.failedCount === 0,
          summary,
          updatedComponents: componentsToUpdate,
          progress: state.progress,
        });
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // =============================================================================
  // Resource Details
  // =============================================================================

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

  // =============================================================================
  // Individual Component Deployment
  // =============================================================================

  // Apply session validation to component deploy
  api.use('/deploy/component/*', validateSession);

  // Deploy a single component (worker or Pages UI)
  api.post('/deploy/component/:name', async (c) => {
    return withLock(async () => {
      try {
        const componentName = c.req.param('name');
        const body = await c.req.json();
        const { env: envParam, skipBuild = false, dryRun = false } = body;
        const rootDir = process.cwd();

        // Validate environment name
        const parseResult = EnvNameSchema.safeParse(envParam);
        if (!parseResult.success) {
          return c.json({ success: false, error: 'Invalid environment name' }, 400);
        }
        const env = parseResult.data;

        state.status = 'deploying';
        clearProgress();
        addProgress(`Deploying component: ${componentName}`);

        // Check if it's a Pages component (UI) or Worker component
        const isPagesComponent = PAGES_COMPONENTS.includes(componentName as PagesComponent);
        const isWorkerComponent = WORKER_COMPONENTS.includes(componentName as WorkerComponent);

        if (!isPagesComponent && !isWorkerComponent) {
          state.status = 'error';
          return c.json(
            {
              success: false,
              error: `Unknown component: ${componentName}. Valid components: ${[...WORKER_COMPONENTS, ...PAGES_COMPONENTS].join(', ')}`,
            },
            400
          );
        }

        // Load config for API URL (needed for Pages deployment)
        const baseDir = findAuthrimBaseDir(process.cwd());
        const resolved = resolvePaths({ baseDir, env });
        let cfg = state.config;
        if (!cfg) {
          try {
            const configPath =
              resolved.type === 'new'
                ? (resolved.paths as EnvironmentPaths).config
                : (resolved.paths as LegacyPaths).config;
            if (existsSync(configPath)) {
              const configContent = await readFile(configPath, 'utf-8');
              cfg = JSON.parse(configContent);
              state.config = cfg;
            }
          } catch {
            // Config is optional for worker deployment
          }
        }

        if (isPagesComponent) {
          // Deploy Pages component (ar-admin-ui or ar-login-ui)
          // deployPagesComponent is already imported at the top

          // Build first (unless skipped)
          if (!skipBuild && !dryRun) {
            addProgress(`Building ${componentName}...`);
            const { execa } = await import('execa');
            const uiDir = join(rootDir, 'packages', componentName);

            if (!existsSync(uiDir)) {
              state.status = 'error';
              return c.json({ success: false, error: `Package not found: ${componentName}` }, 404);
            }

            // Get API base URL
            const apiBaseUrl =
              cfg?.urls?.api?.custom ||
              cfg?.urls?.api?.auto ||
              `https://${env}-ar-router.workers.dev`;

            // Get ui.env path for new structure
            let uiEnvPath: string | undefined;
            if (resolved.type === 'new') {
              uiEnvPath = (resolved.paths as EnvironmentPaths).uiEnv;

              // Sync ui.env before build
              const apiHasCustomDomain = !!cfg?.urls?.api?.custom;
              const adminUiHasCustomDomain = !!cfg?.urls?.adminUi?.custom;
              const useDirectMode = apiHasCustomDomain && adminUiHasCustomDomain;

              const { saveUiEnv } = await import('../core/ui-env.js');
              try {
                if (useDirectMode) {
                  await saveUiEnv(uiEnvPath, {
                    PUBLIC_API_BASE_URL: apiBaseUrl,
                    API_BACKEND_URL: '',
                  });
                } else {
                  await saveUiEnv(uiEnvPath, {
                    PUBLIC_API_BASE_URL: '',
                    API_BACKEND_URL: apiBaseUrl,
                  });
                }
                addProgress(`ui.env synced for ${componentName}`);
              } catch {
                addProgress(`Warning: Could not sync ui.env`);
              }
            }

            const result = await deployPagesComponent(componentName as PagesComponent, {
              env,
              rootDir,
              dryRun,
              apiBaseUrl,
              uiEnvPath,
              onProgress: addProgress,
            });

            if (result.success) {
              state.status = 'complete';
              addProgress(`✓ ${componentName} deployed successfully`);
              return c.json({
                success: true,
                component: componentName,
                type: 'pages',
                projectName: result.projectName,
                deployedAt: result.deployedAt,
              });
            } else {
              state.status = 'error';
              return c.json(
                {
                  success: false,
                  component: componentName,
                  type: 'pages',
                  error: result.error,
                },
                500
              );
            }
          }

          // Dry run for Pages
          state.status = 'complete';
          return c.json({
            success: true,
            component: componentName,
            type: 'pages',
            dryRun: true,
            message: `Would deploy ${componentName} to Pages`,
          });
        } else {
          // Deploy Worker component
          // deployWorker and buildApiPackages are already imported at the top

          // Sync wrangler configs before deploying (required for the environment to exist)
          addProgress('Syncing wrangler configs...');
          try {
            const { syncWranglerConfigs } = await import('../core/wrangler-sync.js');
            const { generateWranglerConfig, toToml } = await import('../core/wrangler.js');
            const { loadLockFileAuto } = await import('../core/lock.js');
            const { getEnvironmentPaths } = await import('../core/paths.js');
            const { getWorkersSubdomain } = await import('../core/cloudflare.js');
            const { AuthrimConfigSchema } = await import('../core/config.js');

            const envPaths = getEnvironmentPaths({ baseDir: rootDir, env });

            // Try to sync from master wrangler configs first
            if (existsSync(envPaths.wrangler)) {
              const syncResult = await syncWranglerConfigs({
                baseDir: rootDir,
                env,
                packagesDir: join(rootDir, 'packages'),
                force: true,
                dryRun: false,
                onProgress: addProgress,
              });

              if (syncResult.success) {
                addProgress(`Synced ${syncResult.synced.length} wrangler config(s)`);
              } else if (syncResult.errors.length > 0) {
                addProgress(`Warning: Sync had errors: ${syncResult.errors.join(', ')}`);
              }
            } else {
              // No master configs, try to generate from lock file
              const { lock: currentLock } = await loadLockFileAuto(rootDir, env);

              if (currentLock && cfg) {
                addProgress('Generating wrangler config from lock file...');

                // Build resource IDs from lock file
                const resourceIds: {
                  d1: Record<string, { id: string; name: string }>;
                  kv: Record<string, { id: string; name: string }>;
                } = {
                  d1: {},
                  kv: {},
                };

                for (const [key, value] of Object.entries(currentLock.d1 || {})) {
                  resourceIds.d1[key] = { id: value.id, name: value.name };
                }
                for (const [key, value] of Object.entries(currentLock.kv || {})) {
                  resourceIds.kv[key] = { id: value.id, name: value.name };
                }

                // Get workers subdomain
                const workersSubdomain = await getWorkersSubdomain();

                // Parse config
                const parsedConfig = AuthrimConfigSchema.parse(cfg);

                // Generate wrangler config for this component
                const componentDir = join(rootDir, 'packages', componentName);
                if (existsSync(componentDir)) {
                  const wranglerConfig = generateWranglerConfig(
                    componentName as WorkerComponent,
                    parsedConfig,
                    resourceIds,
                    workersSubdomain ?? undefined
                  );
                  const tomlContent = toToml(wranglerConfig, env);
                  const tomlPath = join(componentDir, 'wrangler.toml');

                  await writeFile(tomlPath, tomlContent, 'utf-8');
                  addProgress(`Generated wrangler.toml for ${componentName}`);
                }
              } else {
                addProgress(
                  'Warning: No lock file or config found, wrangler config may be missing'
                );
              }
            }
          } catch (syncError) {
            addProgress(`Warning: Could not sync wrangler configs: ${sanitizeError(syncError)}`);
            // Continue anyway - the config might already exist
          }

          // Build first (unless skipped)
          if (!skipBuild && !dryRun) {
            addProgress('Building packages...');
            const buildResult = await buildApiPackages({
              rootDir,
              onProgress: addProgress,
            });

            if (!buildResult.success) {
              state.status = 'error';
              return c.json({ success: false, error: `Build failed: ${buildResult.error}` }, 500);
            }
          }

          // Deploy the worker
          const result = await deployWorker(componentName as WorkerComponent, {
            env,
            rootDir,
            dryRun,
            onProgress: addProgress,
          });

          // Update lock file if successful
          if (result.success && !dryRun) {
            try {
              const { loadLockFileAuto, saveLockFile: saveLock } = await import('../core/lock.js');
              const { lock: currentLock, path: lockPath } = await loadLockFileAuto(rootDir, env);

              if (currentLock && lockPath) {
                const workers = { ...currentLock.workers };
                workers[componentName] = {
                  name: result.workerName,
                  deployedAt: result.deployedAt,
                  version: result.version,
                };

                const updatedLock = {
                  ...currentLock,
                  workers,
                  updatedAt: new Date().toISOString(),
                };

                await saveLock(updatedLock, lockPath);
                addProgress('Lock file updated');
              }
            } catch (lockError) {
              addProgress(`Warning: Could not update lock file: ${sanitizeError(lockError)}`);
            }
          }

          if (result.success) {
            state.status = 'complete';
            addProgress(`✓ ${componentName} deployed successfully`);
            return c.json({
              success: true,
              component: componentName,
              type: 'worker',
              workerName: result.workerName,
              deployedAt: result.deployedAt,
              version: result.version,
            });
          } else {
            state.status = 'error';
            return c.json(
              {
                success: false,
                component: componentName,
                type: 'worker',
                error: result.error,
              },
              500
            );
          }
        }
      } catch (error) {
        state.status = 'error';
        state.error = sanitizeError(error);
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  // Get list of all deployable components
  api.get('/components', async (c) => {
    const { WORKER_COMPONENTS } = await import('../core/naming.js');
    const { PAGES_COMPONENTS } = await import('../core/deploy.js');

    return c.json({
      workers: WORKER_COMPONENTS,
      pages: PAGES_COMPONENTS,
      all: [...WORKER_COMPONENTS, ...PAGES_COMPONENTS],
    });
  });

  // =============================================================================
  // D1 Migration Management
  // =============================================================================

  // Apply session validation to migrations
  api.use('/migrations/*', validateSession);

  // Run D1 migrations for an environment
  api.post('/migrations/run', async (c) => {
    return withLock(async () => {
      try {
        const body = await c.req.json();
        const { env, rootDir = process.cwd() } = body;

        if (!env) {
          return c.json({ success: false, error: 'env is required' }, 400);
        }

        clearProgress();
        addProgress(`📜 Running D1 migrations for environment: ${env}`);

        const result = await runMigrationsForEnvironment(env, rootDir, addProgress);

        if (result.success) {
          addProgress('✅ All migrations completed successfully');
        } else {
          addProgress('❌ Some migrations failed');
        }

        return c.json({
          success: result.success,
          core: result.core,
          pii: result.pii,
          progress: state.progress,
        });
      } catch (error) {
        return c.json({ success: false, error: sanitizeError(error) }, 500);
      }
    });
  });

  return api;
}
