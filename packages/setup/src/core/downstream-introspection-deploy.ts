import { join, resolve } from 'node:path';
import { getWorkersSubdomain } from './cloudflare.js';
import { deployWorker, type DeployOptions, type DeployResult } from './deploy.js';
import {
  ensureDownstreamIntrospectionClient,
  loadDownstreamIntrospectionClientSecrets,
} from './downstream-introspection-client.js';
import { waitForRouterWorkerReady } from './worker-readiness.js';
import { findKeysDirectory, getExternalKeysDir, resolvePaths, type LegacyPaths } from './paths.js';

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
  apiBaseUrls?: string[];
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

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

async function resolveDownstreamIntrospectionApiBaseUrlCandidates(
  env: string,
  explicitApiBaseUrl?: string,
  explicitApiBaseUrls?: string[]
): Promise<string[]> {
  const fallbackBaseUrl = await resolveDownstreamIntrospectionApiBaseUrl(env, explicitApiBaseUrl);
  const candidates = [...(explicitApiBaseUrls ?? []), fallbackBaseUrl];
  const seen = new Set<string>();

  return candidates
    .map((candidate) => normalizeBaseUrl(candidate.trim()))
    .filter((candidate) => {
      if (!candidate || seen.has(candidate)) {
        return false;
      }
      seen.add(candidate);
      return true;
    });
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

  const adminApiSecretPath = join(keysDir, 'admin_api_secret.txt');
  const apiBaseUrls = await resolveDownstreamIntrospectionApiBaseUrlCandidates(
    env,
    options.apiBaseUrl,
    options.apiBaseUrls
  );
  const errors: string[] = [];

  for (const apiBaseUrl of apiBaseUrls) {
    onProgress?.(`Preparing downstream introspection client via ${apiBaseUrl}`);

    const readinessResult = await waitForRouterWorkerReady({
      apiBaseUrl,
      maxWaitMs: 300_000,
      requestTimeoutMs: 15_000,
      requiredConsecutiveSuccesses: 3,
      successDelayMs: 1_500,
      onProgress,
    });
    if (!readinessResult.ready) {
      errors.push(
        `${apiBaseUrl}: router readiness failed at ${readinessResult.checkedUrl}: ${readinessResult.error || 'unknown error'}`
      );
      continue;
    }

    const introspectionClientResult = await ensureDownstreamIntrospectionClient({
      apiBaseUrl,
      adminApiSecretPath,
      keysDir,
      tenantId,
      maxRetries: 24,
      onProgress,
    });

    if (!introspectionClientResult.success) {
      errors.push(
        `${apiBaseUrl}: ${introspectionClientResult.error ?? 'Unknown downstream introspection client error'}`
      );
      continue;
    }

    const introspectionSecrets = await loadDownstreamIntrospectionClientSecrets(keysDir);
    if (!introspectionSecrets) {
      return {
        success: false,
        error: 'Downstream introspection client secrets were not written to disk',
        clientId: introspectionClientResult.clientId,
      };
    }

    onProgress?.('Deploying ar-userinfo with downstream introspection secrets...');
    const redeployResult = await deployWorker('ar-userinfo', {
      env,
      rootDir,
      dryRun,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-userinfo'],
      secrets: introspectionSecrets,
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

  return {
    success: false,
    error:
      errors.length > 0
        ? errors.join('; ')
        : 'No API base URL candidates were available for downstream introspection setup',
  };
}
