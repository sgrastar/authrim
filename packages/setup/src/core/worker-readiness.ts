import { fetchWithTimeout, readResponseTextWithLimit } from './http-limits.js';
import { getWorkerDeployments } from './cloudflare.js';

export const DEFAULT_ROUTER_READINESS_MAX_WAIT_MS = 180_000;
export const DEFAULT_ROUTER_READINESS_INITIAL_DELAY_MS = 2_000;
export const DEFAULT_ROUTER_READINESS_MAX_DELAY_MS = 30_000;
export const DEFAULT_ROUTER_READINESS_REQUEST_TIMEOUT_MS = 10_000;

export interface RouterReadinessOptions {
  apiBaseUrl: string;
  path?: string;
  maxWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  requestTimeoutMs?: number;
  requiredConsecutiveSuccesses?: number;
  successDelayMs?: number;
  onProgress?: (message: string) => void;
}

export interface RouterReadinessResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  checkedUrl: string;
  error?: string;
}

export interface WorkerDeploymentReadinessTarget {
  workerName: string;
  deployedAt?: string | null;
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
  const requiredConsecutiveSuccesses = Math.max(options.requiredConsecutiveSuccesses ?? 1, 1);
  const successDelayMs = Math.max(options.successDelayMs ?? 1_000, 0);
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  let attempts = 0;
  let delayMs = initialDelayMs;
  let lastError = 'not checked';
  let consecutiveSuccesses = 0;

  options.onProgress?.(
    `Waiting for API router to become reachable: ${checkedUrl} (timeout ${formatElapsed(maxWaitMs)})`
  );

  while (true) {
    attempts += 1;
    try {
      const response = await fetchWithTimeout(
        checkedUrl,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Cache-Control': 'no-cache',
          },
        },
        requestTimeoutMs
      );

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
        await sleep(Math.min(successDelayMs, remainingMs));
        delayMs = initialDelayMs;
        continue;
      }

      consecutiveSuccesses = 0;
      lastError = await describeReadinessFailure(response);
    } catch (error) {
      consecutiveSuccesses = 0;
      lastError = describeFetchError(error);
    }

    const now = Date.now();
    if (now >= deadline || maxWaitMs <= 0) {
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
      `API router is not reachable yet (${lastError}). Retrying in ${formatElapsed(nextDelayMs)}...`
    );
    await sleep(nextDelayMs);
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

export async function waitForWorkerDeploymentsReady(options: {
  targets: WorkerDeploymentReadinessTarget[];
  requireFreshDeployment?: boolean;
  maxWaitMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  onProgress?: (message: string) => void;
}): Promise<WorkerDeploymentReadinessResult> {
  const targets = options.targets.filter((target) => target.workerName);
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
          options.requireFreshDeployment === true &&
          result.deployment.exists &&
          !deploymentIsAtLeast(result.deployment.lastDeployedAt, result.target.deployedAt)
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
          const response = await fetchWithTimeout(
            target.url,
            {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'Cache-Control': 'no-cache',
              },
            },
            requestTimeoutMs
          );
          if (response.ok) {
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
