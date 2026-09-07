import { fetchWithTimeout } from './http-limits.js';
import { fetchWithPublicDns, isDnsResolutionError } from './public-dns-fetch.js';

const DEFAULT_DNS_AWARE_FETCH_TIMEOUT_MS = 30_000;

export interface DnsAwareFetchOptions {
  timeoutMs?: number;
  deadlineAt?: number;
  allowPublicDnsFallback?: boolean;
  onDnsFallback?: (message: string) => void;
}

export function getRemainingDeadlineMs(deadlineAt?: number): number {
  return deadlineAt === undefined ? Number.POSITIVE_INFINITY : Math.max(deadlineAt - Date.now(), 0);
}

export async function fetchWithDnsFallback(
  input: string | URL,
  init: globalThis.RequestInit = {},
  options: DnsAwareFetchOptions = {}
): Promise<Response> {
  const remainingMs = getRemainingDeadlineMs(options.deadlineAt);
  if (remainingMs <= 0 || init.signal?.aborted) {
    throw new Error('request_deadline_exceeded');
  }

  const timeoutMs = Math.max(
    Math.min(options.timeoutMs ?? DEFAULT_DNS_AWARE_FETCH_TIMEOUT_MS, remainingMs),
    1
  );
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  init.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const requestInit = { ...init, signal: controller.signal };

  try {
    try {
      return await fetchWithTimeout(input, requestInit, timeoutMs);
    } catch (error) {
      if (timedOut || getRemainingDeadlineMs(options.deadlineAt) <= 0) {
        throw new Error('request_deadline_exceeded');
      }
      if (
        options.allowPublicDnsFallback !== true ||
        controller.signal.aborted ||
        !isDnsResolutionError(error)
      ) {
        throw error;
      }

      const url = input instanceof URL ? input : new URL(input);
      options.onDnsFallback?.(
        `System DNS could not resolve ${url.hostname}; retrying through Cloudflare public DNS.`
      );
      return await fetchWithPublicDns(url, requestInit, timeoutMs);
    }
  } finally {
    clearTimeout(timeoutId);
    init.signal?.removeEventListener('abort', abortFromCaller);
  }
}
