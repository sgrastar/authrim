import { fetchWithTimeout, readResponseTextWithLimit } from './http-limits.js';

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
  onProgress?: (message: string) => void;
}

export interface RouterReadinessResult {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  checkedUrl: string;
  error?: string;
}

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

async function describeReadinessFailure(response: Response): Promise<string> {
  const body = await readResponseTextWithLimit(response, 2048).catch(() => '');
  const compactBody = body.replace(/\s+/g, ' ').trim();
  return compactBody
    ? `HTTP ${response.status}: ${compactBody}`
    : `HTTP ${response.status}`;
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
  const initialDelayMs =
    options.initialDelayMs ?? DEFAULT_ROUTER_READINESS_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_ROUTER_READINESS_MAX_DELAY_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_ROUTER_READINESS_REQUEST_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  let attempts = 0;
  let delayMs = initialDelayMs;
  let lastError = 'not checked';

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
        const elapsedMs = Date.now() - startedAt;
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

      lastError = await describeReadinessFailure(response);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
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
