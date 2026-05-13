import { join, resolve } from 'node:path';
import { getWorkersSubdomain } from './cloudflare.js';
import { deployWorker, uploadSecrets, type DeployOptions, type DeployResult } from './deploy.js';
import {
  ensureDownstreamIntrospectionClient,
  loadDownstreamIntrospectionClientSecrets,
} from './downstream-introspection-client.js';
import {
  findKeysDirectory,
  getExternalKeysDir,
  resolvePaths,
  type EnvironmentPaths,
  type LegacyPaths,
} from './paths.js';

export interface ResolveDownstreamIntrospectionKeysDirOptions {
  env: string;
  rootDir: string;
  keysDir?: string;
  keysBaseDir?: string;
}

export interface ConfigureDownstreamIntrospectionDeploymentOptions {
  env: string;
  rootDir: string;
  keysDir: string;
  apiBaseUrl?: string;
  tenantId?: string;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

export interface ConfigureDownstreamIntrospectionDeploymentResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
  clientId?: string;
  secretUploadErrors?: string[];
  redeployResult?: DeployResult;
}

export function resolveDownstreamIntrospectionKeysDir(
  options: ResolveDownstreamIntrospectionKeysDirOptions
): string {
  const { env, rootDir, keysDir, keysBaseDir } = options;
  if (keysDir) {
    return resolve(keysDir);
  }

  const foundKeys = findKeysDirectory({
    env,
    sourceDir: rootDir,
    keysBaseDir,
  });
  if (foundKeys) {
    return foundKeys.path;
  }

  const resolved = resolvePaths({ baseDir: rootDir, env });
  if (resolved.type === 'legacy') {
    return (resolved.paths as LegacyPaths).keys;
  }

  return getExternalKeysDir(env, keysBaseDir ?? process.cwd());
}

export async function resolveDownstreamIntrospectionApiBaseUrl(
  env: string,
  explicitApiBaseUrl?: string
): Promise<string> {
  if (explicitApiBaseUrl) {
    return explicitApiBaseUrl;
  }

  const subdomain = await getWorkersSubdomain();
  if (subdomain) {
    return `https://${env}-ar-router.${subdomain}.workers.dev`;
  }

  return `https://${env}-ar-router.workers.dev`;
}

export async function configureDownstreamIntrospectionDeployment(
  options: ConfigureDownstreamIntrospectionDeploymentOptions
): Promise<ConfigureDownstreamIntrospectionDeploymentResult> {
  const { env, rootDir, keysDir, tenantId, dryRun, onProgress } = options;

  if (dryRun) {
    return {
      success: true,
      skipped: true,
    };
  }

  const apiBaseUrl = await resolveDownstreamIntrospectionApiBaseUrl(env, options.apiBaseUrl);
  const adminApiSecretPath = join(keysDir, 'admin_api_secret.txt');

  const introspectionClientResult = await ensureDownstreamIntrospectionClient({
    apiBaseUrl,
    adminApiSecretPath,
    keysDir,
    tenantId,
    onProgress,
  });

  if (!introspectionClientResult.success) {
    return {
      success: false,
      error: introspectionClientResult.error ?? 'Unknown downstream introspection client error',
    };
  }

  const introspectionSecrets = await loadDownstreamIntrospectionClientSecrets(keysDir);
  if (!introspectionSecrets) {
    return {
      success: false,
      error: 'Downstream introspection client secrets were not written to disk',
      clientId: introspectionClientResult.clientId,
    };
  }

  onProgress?.('Uploading downstream introspection secrets...');
  const secretResult = await uploadSecrets(
    introspectionSecrets,
    {
      env,
      rootDir,
      dryRun,
      onProgress,
    },
    ['ar-userinfo']
  );

  if (!secretResult.success) {
    return {
      success: false,
      error: 'Failed to upload downstream introspection secrets',
      clientId: introspectionClientResult.clientId,
      secretUploadErrors: secretResult.errors,
    };
  }

  onProgress?.('Redeploying ar-userinfo after downstream introspection setup...');
  const redeployResult = await deployWorker('ar-userinfo', {
    env,
    rootDir,
    dryRun,
    onProgress,
  } satisfies DeployOptions);

  if (!redeployResult.success) {
    return {
      success: false,
      error: redeployResult.error ?? 'Failed to redeploy ar-userinfo',
      clientId: introspectionClientResult.clientId,
      redeployResult,
    };
  }

  return {
    success: true,
    clientId: introspectionClientResult.clientId,
    redeployResult,
  };
}
