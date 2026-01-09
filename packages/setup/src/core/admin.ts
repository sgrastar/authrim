/**
 * Initial Admin Setup Module
 *
 * Handles the initial admin creation flow by storing the setup token in KV
 * and providing the setup URL to the user.
 *
 * Supports both legacy (.keys/{env}/) and new (.authrim/{env}/keys/) structures.
 *
 * Flow:
 * 1. Generate setup token (done in keys.ts)
 * 2. Deploy workers
 * 3. Store setup token in KV (AUTHRIM_CONFIG namespace)
 * 4. Display setup URL to user
 * 5. User accesses /admin-init-setup?token=xxx and registers Passkey
 * 6. System creates initial admin and disables setup feature
 */

import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getEnvironmentPaths,
  getLegacyPaths,
  resolvePaths,
  type EnvironmentPaths,
  type LegacyPaths,
} from './paths.js';

// =============================================================================
// Types
// =============================================================================

export interface SetupTokenOptions {
  /** Environment name (e.g., 'prod', 'staging') */
  env: string;
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /**
   * Path to keys directory
   * @deprecated Use baseDir instead. This is for backward compatibility.
   */
  keysDir?: string;
  /** Use legacy structure (.keys/{env}/) */
  legacy?: boolean;
  /** TTL in seconds (default: 3600 = 1 hour) */
  ttlSeconds?: number;
  /** Progress callback */
  onProgress?: (message: string) => void;
}

export interface SetupInfo {
  /** Whether setup token was stored successfully */
  success: boolean;
  /** Setup URL for initial admin creation */
  setupUrl?: string;
  /** Error message if failed */
  error?: string;
  /** Whether setup is already completed */
  alreadyCompleted?: boolean;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate environment name
 */
function validateEnv(env: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(env)) {
    throw new Error('Invalid environment name');
  }
}

/**
 * Validate setup token format (base64url encoded, 32 bytes = 43 characters)
 */
function validateSetupToken(token: string): void {
  // Base64url: A-Z, a-z, 0-9, -, _ (no padding)
  // 32 bytes = 43 characters in base64url
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Invalid setup token format');
  }
}

// =============================================================================
// KV Operations for Setup Token
// =============================================================================

/**
 * Check if setup is already completed
 */
export async function isSetupCompleted(env: string, configPath: string = '.'): Promise<boolean> {
  validateEnv(env);

  try {
    // Check if setup:completed flag exists in KV
    const workerDir = join(configPath, 'packages', 'ar-auth');
    const wranglerConfig = `wrangler.${env}.toml`;

    if (!existsSync(join(workerDir, wranglerConfig))) {
      // Config doesn't exist, setup not completed
      return false;
    }

    const result = await execa(
      'wrangler',
      [
        'kv',
        'key',
        'get',
        'setup:completed',
        '--config',
        wranglerConfig,
        '--binding',
        'AUTHRIM_CONFIG',
      ],
      {
        cwd: workerDir,
        reject: false,
      }
    );

    // If value is 'true', setup is completed
    return result.stdout.trim() === 'true';
  } catch {
    // If we can't check, assume not completed
    return false;
  }
}

/**
 * Resolve setup token path based on options
 * Supports both new (.authrim/{env}/keys/) and legacy (.keys/{env}/) structures
 */
function resolveSetupTokenPath(options: {
  env: string;
  baseDir?: string;
  keysDir?: string;
  legacy?: boolean;
}): string {
  const { env, baseDir = process.cwd(), keysDir, legacy } = options;

  // If explicit keysDir is provided (legacy API), use it directly
  if (keysDir && keysDir !== '.keys') {
    return join(keysDir, env, 'setup_token.txt');
  }

  // If legacy flag is explicitly set, use legacy structure
  if (legacy) {
    return getLegacyPaths(baseDir, env).keyFiles.setupToken;
  }

  // Auto-detect structure
  const resolved = resolvePaths({ baseDir, env });
  if (resolved.type === 'legacy') {
    return (resolved.paths as LegacyPaths).keyFiles.setupToken;
  }

  return (resolved.paths as EnvironmentPaths).keyFiles.setupToken;
}

/**
 * Store setup token in KV for initial admin creation
 */
export async function storeSetupToken(options: SetupTokenOptions): Promise<SetupInfo> {
  const { env, baseDir = process.cwd(), keysDir, legacy, ttlSeconds = 3600, onProgress } = options;

  validateEnv(env);

  // Read setup token from file
  // Supports both new (.authrim/{env}/keys/) and legacy (.keys/{env}/) structures
  const tokenPath = resolveSetupTokenPath({ env, baseDir, keysDir, legacy });
  if (!existsSync(tokenPath)) {
    // Provide helpful error message with both possible locations
    const newPath = getEnvironmentPaths({ baseDir, env }).keyFiles.setupToken;
    const legacyPath = getLegacyPaths(baseDir, env).keyFiles.setupToken;
    return {
      success: false,
      error: `Setup token file not found. Expected at:\n  - ${newPath} (new structure)\n  - ${legacyPath} (legacy structure)\nRun key generation first.`,
    };
  }

  let setupToken: string;
  try {
    setupToken = (await readFile(tokenPath, 'utf-8')).trim();
    validateSetupToken(setupToken);
  } catch (error) {
    return {
      success: false,
      error: `Failed to read setup token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  onProgress?.('Checking if setup is already completed...');

  // Find the ar-auth package directory for wrangler commands
  // We need to use the ar-auth config because it has the AUTHRIM_CONFIG KV binding
  const packageDirs = [
    join('.', 'packages', 'ar-auth'),
    join('..', 'ar-auth'),
    join('.', 'ar-auth'),
  ];

  let workerDir: string | null = null;
  const wranglerConfig = `wrangler.${env}.toml`;

  for (const dir of packageDirs) {
    if (existsSync(join(dir, wranglerConfig))) {
      workerDir = dir;
      break;
    }
  }

  if (!workerDir) {
    return {
      success: false,
      error: `Cannot find ar-auth package with ${wranglerConfig}. Deploy workers first.`,
    };
  }

  // Check if setup is already completed
  try {
    const checkResult = await execa(
      'wrangler',
      [
        'kv',
        'key',
        'get',
        'setup:completed',
        '--config',
        wranglerConfig,
        '--binding',
        'AUTHRIM_CONFIG',
      ],
      {
        cwd: workerDir,
        reject: false,
      }
    );

    if (checkResult.stdout.trim() === 'true') {
      onProgress?.('Setup is already completed. Skipping token storage.');
      return {
        success: true,
        alreadyCompleted: true,
      };
    }
  } catch {
    // Key doesn't exist or can't be read, continue with setup
  }

  onProgress?.('Storing setup token in KV...');

  try {
    // Store the setup token with TTL
    await execa(
      'wrangler',
      [
        'kv',
        'key',
        'put',
        'setup:token',
        setupToken,
        '--config',
        wranglerConfig,
        '--binding',
        'AUTHRIM_CONFIG',
        '--ttl',
        ttlSeconds.toString(),
      ],
      {
        cwd: workerDir,
        reject: true,
      }
    );

    onProgress?.('Setup token stored successfully');

    return {
      success: true,
      setupUrl: `/admin-init-setup?token=${setupToken}`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to store setup token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get the full setup URL with the base URL
 */
export function getFullSetupUrl(baseUrl: string, setupToken: string): string {
  // Validate token
  validateSetupToken(setupToken);

  // Ensure baseUrl doesn't have trailing slash
  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  return `${cleanBaseUrl}/admin-init-setup?token=${setupToken}`;
}

/**
 * Display setup instructions to the user
 */
export function displaySetupInstructions(
  setupUrl: string,
  options: {
    color?: boolean;
    onOutput?: (line: string) => void;
  } = {}
): void {
  const { color = true, onOutput = console.log } = options;

  const lines = [
    '',
    color ? '\x1b[1m━━━ Initial Admin Setup ━━━\x1b[0m' : '━━━ Initial Admin Setup ━━━',
    '',
    'To create the initial administrator account, visit:',
    '',
    color ? `  \x1b[36m${setupUrl}\x1b[0m` : `  ${setupUrl}`,
    '',
    color ? '\x1b[33m⚠️  Important:\x1b[0m' : '⚠️  Important:',
    '  • This link expires in 1 hour',
    '  • Setup can only be completed once',
    '  • You will need to register a Passkey (biometric/security key)',
    '',
    'After completing setup:',
    '  1. Log in with your Passkey',
    '  2. Create your first OAuth client from the Admin UI',
    '',
  ];

  for (const line of lines) {
    onOutput(line);
  }
}

/**
 * Complete the initial admin setup flow after deployment
 * This should be called after all workers are deployed
 */
export async function completeInitialSetup(options: {
  env: string;
  baseUrl: string;
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /**
   * Path to keys directory
   * @deprecated Use baseDir instead. This is for backward compatibility.
   */
  keysDir?: string;
  /** Use legacy structure (.keys/{env}/) */
  legacy?: boolean;
  onProgress?: (message: string) => void;
}): Promise<SetupInfo> {
  const { env, baseUrl, baseDir = process.cwd(), keysDir, legacy, onProgress } = options;

  // Store setup token in KV
  const result = await storeSetupToken({
    env,
    baseDir,
    keysDir,
    legacy,
    onProgress,
  });

  if (!result.success) {
    return result;
  }

  if (result.alreadyCompleted) {
    return {
      success: true,
      alreadyCompleted: true,
    };
  }

  // Read token and generate full URL
  // Supports both new (.authrim/{env}/keys/) and legacy (.keys/{env}/) structures
  const tokenPath = resolveSetupTokenPath({ env, baseDir, keysDir, legacy });
  const setupToken = (await readFile(tokenPath, 'utf-8')).trim();
  const fullSetupUrl = getFullSetupUrl(baseUrl, setupToken);

  return {
    success: true,
    setupUrl: fullSetupUrl,
  };
}
