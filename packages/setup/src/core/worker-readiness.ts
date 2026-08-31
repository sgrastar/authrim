import { fetchWithTimeout, readResponseTextWithLimit } from './http-limits.js';
import { getWorkerDeployments } from './cloudflare.js';
import { fetchWithPublicDns, isDnsResolutionError } from './public-dns-fetch.js';

export const DEFAULT_ROUTER_READINESS_MAX_WAIT_MS = 180_000;
export const DEFAULT_ROUTER_READINESS_INITIAL_DELAY_MS = 2_000;
export const DEFAULT_ROUTER_READINESS_MAX_DELAY_MS = 30_000;
export const DEFAULT_ROUTER_READINESS_REQUEST_TIMEOUT_MS = 10_000;

export interface RouterReadinessOptions {
  apiBaseUrl: string;
  path?: string;
  maxWaitMs?: number;
  /** Absolute shared deadline used when several readiness probes run as one operation. */
  deadlineAt?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  requiredConsecutiveSuccesses?: number;
  successDelayMs?: number;
  /** Retry DNS misses through Cloudflare public DNS while preserving TLS hostname validation. */
  allowPublicDnsFallback?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Raw readiness failures for persisted detailed logs only. */
  onDetail?: (message: string) => void;
}

export interface RouterReadinessResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  checkedUrl: string;
  error?: string;
}

export interface TenantRoutingReadinessOptions {
  apiBaseUrl: string;
  maxWaitMs?: number;
  /** Absolute shared deadline used when several readiness probes run as one operation. */
  deadlineAt?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  /** Retry DNS misses through Cloudflare public DNS while preserving TLS hostname validation. */
  allowPublicDnsFallback?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Raw readiness failures for persisted detailed logs only. */
  onDetail?: (message: string) => void;
}

export interface TenantRoutingReadinessResult extends RouterReadinessResult {
  issuer?: string;
}

export interface WorkerDeploymentReadinessTarget {
  workerName: string;
  deployedAt?: string | null;
  expectedVersionId?: string | null;
}

export interface WorkerDeploymentReadinessResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  checkedWorkers: string[];
  missingWorkers: string[];
  staleWorkers: string[];
  error?: string;
}

export interface WorkerHttpReadinessTarget {
  workerName: string;
  url: string;
}

export interface WorkerHttpReadinessResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  checkedWorkers: string[];
  failedWorkers: Array<{ workerName: string; url: string; error: string }>;
  error?: string;
}

const APP_WORKER_HEALTH_PATHS: Record<string, string> = {
  'ar-auth': '/api/auth/health',
  'ar-token': '/api/health',
  'ar-userinfo': '/api/health',
  'ar-discovery': '/api/health',
  'ar-management': '/api/health',
  'ar-router': '/api/health',
  'ar-bridge': '/api/health',
  'ar-vc': '/api/health',
  'ar-policy': '/api/check/health',
  'ar-saml': '/saml/health',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntilRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!signal) {
    await sleep(ms);
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, ms);
    const abort = () => {
      clearTimeout(timeoutId);
      resolve(false);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function buildReadinessUrl(apiBaseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeBaseUrl(apiBaseUrl)}${normalizedPath}`;
}

function formatElapsed(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`;
}

function getComponentSuffix(workerName: string): string | null {
  for (const suffix of Object.keys(APP_WORKER_HEALTH_PATHS)) {
    if (workerName.endsWith(`-${suffix}`)) {
      return suffix;
    }
  }
  return null;
}

export function buildWorkerHttpReadinessTargets(
  workers: Array<{ workerName: string }>,
  workersSubdomain: string | null | undefined,
  options: { workersDevEnabled?: boolean } = {}
): WorkerHttpReadinessTarget[] {
  if (options.workersDevEnabled === false) return [];
  if (!workersSubdomain) return [];
  return workers.flatMap((worker) => {
    const suffix = getComponentSuffix(worker.workerName);
    if (!suffix) return [];
    return [
      {
        workerName: worker.workerName,
        url: `https://${worker.workerName}.${workersSubdomain}.workers.dev${APP_WORKER_HEALTH_PATHS[suffix]}`,
      },
    ];
  });
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const record = cause as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const syscall = typeof record.syscall === 'string' ? record.syscall : undefined;
    const hostname = typeof record.hostname === 'string' ? record.hostname : undefined;
    const message = cause instanceof Error ? cause.message : undefined;
    const details = [code, syscall, hostname, message].filter(Boolean).join(' ');
    if (details) {
      return `${error.message}: ${details}`;
    }
  }

  return error.message;
}

async function describeReadinessFailure(response: Response): Promise<string> {
  const body = await readResponseTextWithLimit(response, 2048).catch(() => '');
  const compactBody = body.replace(/\s+/g, ' ').trim();
  return compactBody ? `HTTP ${response.status}: ${compactBody}` : `HTTP ${response.status}`;
}

async function fetchReadinessResponse(options: {
  checkedUrl: string;
  requestTimeoutMs: number;
  allowPublicDnsFallback: boolean;
  signal?: AbortSignal;
  onDetail?: (message: string) => void;
}): Promise<Response> {
  const init: globalThis.RequestInit = {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
    },
    signal: options.signal,
  };

  try {
    return await fetchWithTimeout(options.checkedUrl, init, options.requestTimeoutMs);
  } catch (error) {
    if (
      !options.allowPublicDnsFallback ||
      options.signal?.aborted ||
      !isDnsResolutionError(error)
    ) {
      throw error;
    }

    options.onDetail?.(
      `System DNS could not resolve ${new URL(options.checkedUrl).hostname}; retrying through Cloudflare public DNS.`
    );
    return await fetchWithPublicDns(options.checkedUrl, init, options.requestTimeoutMs);
  }
}

async function hasExpectedTenantRegistryBootstrapGap(
  response: Response,
  workerName: string,
  allowTenantRegistryBootstrapGap: boolean
): Promise<boolean> {
  if (
    !allowTenantRegistryBootstrapGap ||
    response.status !== 409 ||
    (!workerName.endsWith('-ar-auth') &&
      !workerName.endsWith('-ar-policy') &&
      !workerName.endsWith('-ar-saml'))
  ) {
    return false;
  }

  const body = await readResponseTextWithLimit(response, 2048).catch(() => '');
  try {
    const payload = JSON.parse(body) as { error?: unknown };
    return payload.error === 'missing_snapshot' || payload.error === 'missing_generation';
  } catch {
    return false;
  }
}

/**
 * Wait until the API router Worker is actually reachable through its public route.
 *
 * Wrangler can report a successful deploy before workers.dev/custom-hostname routing has propagated
 * to the edge. The router health endpoint is intentionally used because it is served by ar-router
 * itself and does not require D1 migrations, KV, or downstream service bindings to be ready.
 */
export async function waitForRouterWorkerReady(
  options: RouterReadinessOptions
): Promise<RouterReadinessResult> {
  const path = options.path ?? '/api/health';
  const checkedUrl = buildReadinessUrl(options.apiBaseUrl, path);
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_ROUTER_READINESS_MAX_WAIT_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_ROUTER_READINESS_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_ROUTER_READINESS_MAX_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ROUTER_READINESS_REQUEST_TIMEOUT_MS;
  const allowPublicDnsFallback = options.allowPublicDnsFallback ?? true;
  const requiredConsecutiveSuccesses = Math.max(options.requiredConsecutiveSuccesses ?? 1, 1);
  const successDelayMs = Math.max(options.successDelayMs ?? 1_000, 0);
  const startedAt = Date.now();
  const deadline = Math.min(startedAt + maxWaitMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);
  const effectiveMaxWaitMs = Math.max(deadline - startedAt, 0);
  let attempts = 0;
  let delayMs = initialDelayMs;
  let lastError = 'not checked';
  let consecutiveSuccesses = 0;

  options.onProgress?.(
    `Waiting for API router to become reachable: ${checkedUrl} (timeout ${formatElapsed(effectiveMaxWaitMs)})`
  );

  while (true) {
    if (options.signal?.aborted) {
      return {
        ready: false,
        attempts,
        elapsedMs: Date.now() - startedAt,
        checkedUrl,
        error: 'readiness_check_aborted',
      };
    }
    attempts += 1;
    try {
      const attemptTimeoutMs = Math.max(Math.min(requestTimeoutMs, deadline - Date.now()), 1);
      const response = await fetchReadinessResponse({
        checkedUrl,
        requestTimeoutMs: attemptTimeoutMs,
        allowPublicDnsFallback,
        signal: options.signal,
        onDetail: options.onDetail,
      });

      if (response.ok) {
        consecutiveSuccesses += 1;
        const elapsedMs = Date.now() - startedAt;
        if (consecutiveSuccesses >= requiredConsecutiveSuccesses) {
          options.onProgress?.(
            `API router is reachable after ${formatElapsed(elapsedMs)} (${attempts} attempt${attempts === 1 ? '' : 's'})`
          );
          return {
            ready: true,
            attempts,
            elapsedMs,
            checkedUrl,
          };
        }

        options.onProgress?.(
          `API router responded successfully (${consecutiveSuccesses}/${requiredConsecutiveSuccesses}); confirming route stability...`
        );
        const remainingMs = Math.max(deadline - Date.now(), 0);
        if (!(await sleepUntilRetry(Math.min(successDelayMs, remainingMs), options.signal))) {
          continue;
        }
        delayMs = initialDelayMs;
        continue;
      }

      consecutiveSuccesses = 0;
      lastError = await describeReadinessFailure(response);
    } catch (error) {
      consecutiveSuccesses = 0;
      lastError = describeFetchError(error);
    }

    options.onDetail?.(`API router readiness attempt ${attempts} failed: ${lastError}`);

    const now = Date.now();
    if (now >= deadline || effectiveMaxWaitMs <= 0 || options.signal?.aborted) {
      const elapsedMs = now - startedAt;
      return {
        ready: false,
        attempts,
        elapsedMs,
        checkedUrl,
        error: lastError,
      };
    }

    const remainingMs = Math.max(deadline - now, 0);
    const nextDelayMs = Math.min(delayMs, maxDelayMs, remainingMs);
    options.onProgress?.(
      `Waiting for API routing to propagate (${formatElapsed(now - startedAt)} elapsed, attempt ${attempts}). Retrying in ${formatElapsed(nextDelayMs)}...`
    );
    await sleepUntilRetry(nextDelayMs, options.signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

/**
 * Wait for tenant-aware routing and discovery metadata, not only the router health endpoint.
 * A successful Worker deployment can precede tenant directory and runtime snapshot propagation.
 */
export async function waitForTenantRoutingReady(
  options: TenantRoutingReadinessOptions
): Promise<TenantRoutingReadinessResult> {
  const checkedUrl = buildReadinessUrl(options.apiBaseUrl, '/.well-known/openid-configuration');
  const expectedIssuer = normalizeBaseUrl(options.apiBaseUrl);
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_ROUTER_READINESS_MAX_WAIT_MS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_ROUTER_READINESS_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_ROUTER_READINESS_MAX_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ROUTER_READINESS_REQUEST_TIMEOUT_MS;
  const allowPublicDnsFallback = options.allowPublicDnsFallback ?? true;
  const startedAt = Date.now();
  const deadline = Math.min(startedAt + maxWaitMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);
  const effectiveMaxWaitMs = Math.max(deadline - startedAt, 0);
  let attempts = 0;
  let delayMs = initialDelayMs;
  let lastError = 'not checked';

  options.onProgress?.(
    `Checking tenant routing and runtime discovery (timeout ${formatElapsed(effectiveMaxWaitMs)})...`
  );

  while (true) {
    if (options.signal?.aborted) {
      return {
        ready: false,
        attempts,
        elapsedMs: Date.now() - startedAt,
        checkedUrl,
        error: 'readiness_check_aborted',
      };
    }
    attempts += 1;
    try {
      const attemptTimeoutMs = Math.max(Math.min(requestTimeoutMs, deadline - Date.now()), 1);
      const response = await fetchReadinessResponse({
        checkedUrl,
        requestTimeoutMs: attemptTimeoutMs,
        allowPublicDnsFallback,
        signal: options.signal,
        onDetail: options.onDetail,
      });

      if (response.ok) {
        const body = await readResponseTextWithLimit(response, 16_384);
        let issuer = '';
        try {
          const parsed = JSON.parse(body) as { issuer?: unknown };
          if (typeof parsed.issuer === 'string') {
            issuer = parsed.issuer.replace(/\/+$/, '');
          } else {
            lastError = 'Discovery metadata did not contain a string issuer';
          }
        } catch {
          lastError = 'Discovery metadata was not valid JSON';
        }

        if (issuer === expectedIssuer) {
          const elapsedMs = Date.now() - startedAt;
          options.onProgress?.(
            `Tenant routing and runtime discovery are ready after ${formatElapsed(elapsedMs)} (${attempts} attempt${attempts === 1 ? '' : 's'})`
          );
          return {
            ready: true,
            attempts,
            elapsedMs,
            checkedUrl,
            issuer,
          };
        }

        if (issuer) {
          lastError = `Unexpected issuer: ${issuer}`;
        }
      } else {
        lastError = await describeReadinessFailure(response);
      }
    } catch (error) {
      lastError = describeFetchError(error);
    }

    options.onDetail?.(`Tenant routing readiness attempt ${attempts} failed: ${lastError}`);
    const now = Date.now();
    if (now >= deadline || effectiveMaxWaitMs <= 0 || options.signal?.aborted) {
      return {
        ready: false,
        attempts,
        elapsedMs: now - startedAt,
        checkedUrl,
        error: lastError,
      };
    }

    const remainingMs = Math.max(deadline - now, 0);
    const nextDelayMs = Math.min(delayMs, maxDelayMs, remainingMs);
    options.onProgress?.(
      `Waiting for tenant routing and runtime discovery (${formatElapsed(now - startedAt)} elapsed, attempt ${attempts}). Retrying in ${formatElapsed(nextDelayMs)}...`
    );
    await sleepUntilRetry(nextDelayMs, options.signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

function deploymentIsAtLeast(
  actualIso: string | null,
  expectedIso: string | null | undefined
): boolean {
  if (!expectedIso) {
    return actualIso !== null;
  }
  if (!actualIso) {
    return false;
  }
  const actual = Date.parse(actualIso);
  const expected = Date.parse(expectedIso);
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
    return true;
  }
  // Cloudflare deployment timestamps can differ by small clock/skew/rounding windows.
  return actual + 60_000 >= expected;
}

function deploymentMatchesTarget(
  deployment: Awaited<ReturnType<typeof getWorkerDeployments>>,
  target: WorkerDeploymentReadinessTarget
): boolean {
  if (target.expectedVersionId) {
    return deployment.versionId === target.expectedVersionId;
  }
  return deploymentIsAtLeast(deployment.lastDeployedAt, target.deployedAt);
}

export async function waitForWorkerDeploymentsReady(options: {
  targets: WorkerDeploymentReadinessTarget[];
  requireFreshDeployment?: boolean;
  maxWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onProgress?: (message: string) => void;
}): Promise<WorkerDeploymentReadinessResult> {
  const targets = options.targets.filter((target) => target.workerName);
  const requireFreshDeployment =
    options.requireFreshDeployment ??
    targets.some((target) => Boolean(target.deployedAt || target.expectedVersionId));
  const checkedWorkers = targets.map((target) => target.workerName);
  const startedAt = Date.now();
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const deadline = startedAt + maxWaitMs;
  let delayMs = options.initialDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  let attempts = 0;
  let lastMissing: string[] = [];
  let lastStale: string[] = [];

  if (targets.length === 0) {
    return {
      ready: true,
      attempts: 0,
      elapsedMs: 0,
      checkedWorkers,
      missingWorkers: [],
      staleWorkers: [],
    };
  }

  options.onProgress?.(
    `Verifying Worker deployments are visible (${targets.length} worker${targets.length === 1 ? '' : 's'})...`
  );

  while (true) {
    attempts += 1;
    const results = await Promise.all(
      targets.map(async (target) => ({
        target,
        deployment: await getWorkerDeployments(target.workerName),
      }))
    );
    lastMissing = results
      .filter((result) => !result.deployment.exists)
      .map((result) => result.target.workerName);
    lastStale = results
      .filter(
        (result) =>
          requireFreshDeployment &&
          result.deployment.exists &&
          !deploymentMatchesTarget(result.deployment, result.target)
      )
      .map((result) => result.target.workerName);

    if (lastMissing.length === 0 && lastStale.length === 0) {
      const elapsedMs = Date.now() - startedAt;
      options.onProgress?.(
        `Worker deployments are visible after ${formatElapsed(elapsedMs)} (${attempts} attempt${attempts === 1 ? '' : 's'})`
      );
      return {
        ready: true,
        attempts,
        elapsedMs,
        checkedWorkers,
        missingWorkers: [],
        staleWorkers: [],
      };
    }

    const now = Date.now();
    if (now >= deadline || maxWaitMs <= 0) {
      const details = [
        lastMissing.length > 0 ? `missing: ${lastMissing.join(', ')}` : null,
        lastStale.length > 0 ? `stale: ${lastStale.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('; ');
      return {
        ready: false,
        attempts,
        elapsedMs: now - startedAt,
        checkedWorkers,
        missingWorkers: lastMissing,
        staleWorkers: lastStale,
        error: details || 'worker deployment verification failed',
      };
    }

    const remainingMs = Math.max(deadline - now, 0);
    const nextDelayMs = Math.min(delayMs, maxDelayMs, remainingMs);
    options.onProgress?.(
      `Worker deployment visibility pending (${[
        lastMissing.length > 0 ? `${lastMissing.length} missing` : null,
        lastStale.length > 0 ? `${lastStale.length} stale` : null,
      ]
        .filter(Boolean)
        .join(', ')}). Retrying in ${formatElapsed(nextDelayMs)}...`
    );
    await sleep(nextDelayMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

export async function waitForWorkerHttpReady(options: {
  targets: WorkerHttpReadinessTarget[];
  maxWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  /** Initial tenant-D1 deploys may not have a Runtime Registry snapshot or generation yet. */
  allowTenantRegistryBootstrapGap?: boolean;
  /** Retry a newly created HTTPS custom domain through public DNS after a system DNS miss. */
  allowPublicDnsFallback?: boolean;
  onProgress?: (message: string) => void;
}): Promise<WorkerHttpReadinessResult> {
  const targets = options.targets.filter((target) => target.workerName && target.url);
  const checkedWorkers = targets.map((target) => target.workerName);
  const startedAt = Date.now();
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const deadline = startedAt + maxWaitMs;
  let delayMs = options.initialDelayMs ?? 2_000;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_ROUTER_READINESS_REQUEST_TIMEOUT_MS;
  let attempts = 0;
  let failedWorkers: Array<{ workerName: string; url: string; error: string }> = [];

  if (targets.length === 0) {
    return {
      ready: true,
      attempts: 0,
      elapsedMs: 0,
      checkedWorkers,
      failedWorkers: [],
    };
  }

  options.onProgress?.(
    `Verifying Worker HTTP health (${targets.length} worker${targets.length === 1 ? '' : 's'})...`
  );

  while (true) {
    attempts += 1;
    const results = await Promise.all(
      targets.map(async (target) => {
        try {
          const requestInit = {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'Cache-Control': 'no-cache',
            },
          } satisfies globalThis.RequestInit;
          let response: Response;
          try {
            response = await fetchWithTimeout(target.url, requestInit, requestTimeoutMs);
          } catch (error) {
            if (!options.allowPublicDnsFallback || !isDnsResolutionError(error)) throw error;
            response = await fetchWithPublicDns(target.url, requestInit, requestTimeoutMs);
          }
          if (response.ok) {
            return null;
          }
          if (
            await hasExpectedTenantRegistryBootstrapGap(
              response.clone(),
              target.workerName,
              options.allowTenantRegistryBootstrapGap === true
            )
          ) {
            return null;
          }
          return {
            workerName: target.workerName,
            url: target.url,
            error: await describeReadinessFailure(response),
          };
        } catch (error) {
          return {
            workerName: target.workerName,
            url: target.url,
            error: describeFetchError(error),
          };
        }
      })
    );
    failedWorkers = results.filter(
      (result): result is { workerName: string; url: string; error: string } => result !== null
    );

    if (failedWorkers.length === 0) {
      const elapsedMs = Date.now() - startedAt;
      options.onProgress?.(
        `Worker HTTP health checks passed after ${formatElapsed(elapsedMs)} (${attempts} attempt${attempts === 1 ? '' : 's'})`
      );
      return {
        ready: true,
        attempts,
        elapsedMs,
        checkedWorkers,
        failedWorkers: [],
      };
    }

    const now = Date.now();
    if (now >= deadline || maxWaitMs <= 0) {
      const details = failedWorkers
        .map((failure) => `${failure.workerName}: ${failure.error}`)
        .join('; ');
      return {
        ready: false,
        attempts,
        elapsedMs: now - startedAt,
        checkedWorkers,
        failedWorkers,
        error: details || 'worker HTTP health verification failed',
      };
    }

    const remainingMs = Math.max(deadline - now, 0);
    const nextDelayMs = Math.min(delayMs, maxDelayMs, remainingMs);
    options.onProgress?.(
      `Worker HTTP health pending (${failedWorkers.length} failed). Retrying in ${formatElapsed(nextDelayMs)}...`
    );
    await sleep(nextDelayMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}
