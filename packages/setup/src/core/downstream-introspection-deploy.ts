import { resolve } from 'node:path';
import { getWorkersSubdomain } from './cloudflare.js';
import { deployWorker, type DeployOptions, type DeployResult } from './deploy.js';
import type { WorkerScriptOwnershipGuard } from './worker-script-ownership.js';
import type { DeployConfigLockProof } from './lock.js';
import {
  ensureDownstreamIntrospectionClient,
  loadDownstreamIntrospectionClientSecrets,
} from './downstream-introspection-client.js';
import { waitForRouterWorkerReady, waitForTenantRoutingReady } from './worker-readiness.js';
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
  /** Router origins already verified earlier in this deployment operation. */
  knownRouterReadyBaseUrls?: string[];
  /** One shared budget for every optional-integration readiness candidate and phase. */
  readinessBudgetMs?: number;
  tenantId?: string;
  dryRun?: boolean;
  deployConfigLockProof?: DeployConfigLockProof;
  workerScriptOwnership?: WorkerScriptOwnershipGuard;
  onProgress?: (message: string) => void;
  /** Raw readiness and provider errors for persisted detailed logs only. */
  onDetail?: (message: string) => void;
}

export interface ConfigureDownstreamIntrospectionDeploymentResult {
  success: boolean;
  skipped?: boolean;
  deferred?: boolean;
  error?: string;
  clientId?: string;
  secretUploadErrors?: string[];
  redeployResult?: DeployResult;
  impact?: string;
  retryable?: boolean;
  nextAction?: string;
}

const DOWNSTREAM_INTROSPECTION_IMPACT =
  'Core login, Admin UI, and token issuance are available, but downstream grant introspection is not configured.';
const DOWNSTREAM_INTROSPECTION_NEXT_ACTION =
  'Rerun deploy to retry the optional integration after routing propagation completes.';
const DEFAULT_DOWNSTREAM_READINESS_BUDGET_MS = 60_000;

export function createDownstreamIntrospectionFailure(
  error: string,
  details: Omit<ConfigureDownstreamIntrospectionDeploymentResult, 'success' | 'error'> = {}
): ConfigureDownstreamIntrospectionDeploymentResult {
  return {
    success: false,
    deferred: true,
    error,
    impact: DOWNSTREAM_INTROSPECTION_IMPACT,
    retryable: true,
    nextAction: DOWNSTREAM_INTROSPECTION_NEXT_ACTION,
    ...details,
  };
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
  const { env, rootDir, keysDir, tenantId, dryRun, onProgress, onDetail } = options;

  if (dryRun) {
    return {
      success: true,
      skipped: true,
    };
  }

  const apiBaseUrls = await resolveDownstreamIntrospectionApiBaseUrlCandidates(
    env,
    options.apiBaseUrl,
    options.apiBaseUrls
  );
  const errors: string[] = [];
  const knownRouterReadyBaseUrls = new Set(
    (options.knownRouterReadyBaseUrls ?? []).map(normalizeBaseUrl)
  );
  const readinessBudgetMs = Math.max(
    options.readinessBudgetMs ?? DEFAULT_DOWNSTREAM_READINESS_BUDGET_MS,
    0
  );
  const readinessDeadlineAt = Date.now() + readinessBudgetMs;
  const readinessController = new AbortController();

  onProgress?.(
    `Checking tenant routing for optional integrations (shared timeout ${Math.ceil(readinessBudgetMs / 1000)}s)...`
  );

  const readyApiBaseUrl = await new Promise<string | undefined>((resolveReady) => {
    if (apiBaseUrls.length === 0) {
      resolveReady(undefined);
      return;
    }

    let remaining = apiBaseUrls.length;
    let settled = false;
    const finishCandidate = (apiBaseUrl?: string) => {
      if (settled) return;
      if (apiBaseUrl) {
        settled = true;
        readinessController.abort();
        resolveReady(apiBaseUrl);
        return;
      }
      remaining -= 1;
      if (remaining === 0) {
        settled = true;
        resolveReady(undefined);
      }
    };

    for (const apiBaseUrl of apiBaseUrls) {
      void (async () => {
        onDetail?.(`Downstream introspection API candidate: ${apiBaseUrl}`);

        if (knownRouterReadyBaseUrls.has(apiBaseUrl)) {
          onDetail?.(`Reusing successful API router readiness check: ${apiBaseUrl}`);
        } else {
          const readinessResult = await waitForRouterWorkerReady({
            apiBaseUrl,
            maxWaitMs: readinessBudgetMs,
            deadlineAt: readinessDeadlineAt,
            requestTimeoutMs: 15_000,
            requiredConsecutiveSuccesses: 3,
            successDelayMs: 1_500,
            allowPublicDnsFallback: true,
            signal: readinessController.signal,
            onProgress,
            onDetail,
          });
          if (!readinessResult.ready) {
            if (readinessController.signal.aborted) return;
            const detail = `${apiBaseUrl}: router readiness failed at ${readinessResult.checkedUrl}: ${readinessResult.error || 'unknown error'}`;
            errors.push(detail);
            onDetail?.(detail);
            finishCandidate();
            return;
          }
        }

        const tenantRoutingResult = await waitForTenantRoutingReady({
          apiBaseUrl,
          maxWaitMs: readinessBudgetMs,
          deadlineAt: readinessDeadlineAt,
          requestTimeoutMs: 15_000,
          allowPublicDnsFallback: true,
          signal: readinessController.signal,
          onProgress,
          onDetail,
        });
        if (!tenantRoutingResult.ready) {
          if (readinessController.signal.aborted) return;
          const detail = `${apiBaseUrl}: tenant routing readiness failed at ${tenantRoutingResult.checkedUrl}: ${tenantRoutingResult.error || 'unknown error'}`;
          errors.push(detail);
          onDetail?.(detail);
          finishCandidate();
          return;
        }

        finishCandidate(apiBaseUrl);
      })().catch((error) => {
        if (readinessController.signal.aborted) return;
        const detail = `${apiBaseUrl}: readiness check failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(detail);
        onDetail?.(detail);
        finishCandidate();
      });
    }
  });

  if (readyApiBaseUrl) {
    const apiBaseUrl = readyApiBaseUrl;
    onProgress?.('Configuring downstream grant introspection...');
    const introspectionClientResult = await ensureDownstreamIntrospectionClient({
      apiBaseUrl,
      keysDir,
      tenantId,
      maxRetries: 24,
      deadlineAt: readinessDeadlineAt,
      allowPublicDnsFallback: true,
      onProgress,
      onDetail,
    });

    if (!introspectionClientResult.success) {
      const detail = `${apiBaseUrl}: ${introspectionClientResult.error ?? 'Unknown downstream introspection client error'}`;
      errors.push(detail);
      onDetail?.(detail);
      return createDownstreamIntrospectionFailure(detail);
    }

    const introspectionSecrets = await loadDownstreamIntrospectionClientSecrets(keysDir);
    if (!introspectionSecrets) {
      return createDownstreamIntrospectionFailure(
        'Downstream introspection client secrets were not written to disk',
        {
          clientId: introspectionClientResult.clientId,
        }
      );
    }

    onProgress?.('Deploying ar-userinfo with downstream introspection secrets...');
    const redeployResult = await deployWorker('ar-userinfo', {
      env,
      rootDir,
      dryRun,
      deploymentStrategy: 'staged',
      existingComponents: ['ar-userinfo'],
      secrets: introspectionSecrets,
      deployConfigLockProof: options.deployConfigLockProof,
      workerScriptOwnership: options.workerScriptOwnership,
      onProgress,
    } satisfies DeployOptions);

    if (!redeployResult.success) {
      return createDownstreamIntrospectionFailure(
        redeployResult.error ?? 'Failed to redeploy ar-userinfo',
        {
          clientId: introspectionClientResult.clientId,
          redeployResult,
        }
      );
    }

    return {
      success: true,
      clientId: introspectionClientResult.clientId,
      redeployResult,
    };
  }

  return createDownstreamIntrospectionFailure(
    errors.length > 0
      ? errors.join('; ')
      : 'No API base URL candidates were available for downstream introspection setup'
  );
}
