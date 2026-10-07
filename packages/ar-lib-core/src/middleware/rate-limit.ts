/**
 * Rate Limiting Middleware
 *
 * Provides per-IP rate limiting to protect against abuse and DDoS attacks.
 * Uses the RateLimiterCounter Durable Object for atomic tracking, with KV only
 * as a fallback when atomic enforcement is not required.
 *
 * Configuration design:
 * - Cold isolates return safe built-in defaults immediately.
 * - KV overrides are refreshed asynchronously via waitUntil when available.
 * - Admin writes clear the current isolate cache immediately, while other
 *   isolates converge on the next refresh window.
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env';
import { publishEvent } from '../utils/event-dispatcher-factory';
import { SECURITY_EVENTS, type SecurityEventData } from '../types/events';
import { getTenantIdFromContext } from './request-context';
import { createLogger } from '../utils/logger';
import { resolvePlatformSettingsWithSources } from '../services/effective-settings';
import { rateLimitProfileKeys } from '../types/settings/rate-limit';

const log = createLogger().module('RATE-LIMIT');

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  // Maximum number of requests allowed in the window
  maxRequests: number;
  // Time window in seconds
  windowSeconds: number;
  // Endpoints to apply rate limiting to (empty means all endpoints)
  endpoints?: string[];
  // Skip rate limiting for these IPs (e.g., trusted proxies, health checks)
  skipIPs?: string[];
  // For low-risk read-only endpoints, allow low-volume GET requests without
  // waiting for the RateLimiter DO. The DO is still incremented via waitUntil.
  nonBlockingRead?: boolean;
  // Whether the caller can safely receive a separate counter per tenant. Public
  // capability endpoints should use global so changing tenant context cannot
  // multiply brute-force attempts from the same client IP.
  keyScope?: 'tenant' | 'global';
  // Optional bucket class. Use this to keep read-only bootstrap traffic from
  // consuming the same shared-IP bucket as login/token/credential actions.
  endpointClass?: string;
  // Fail closed instead of falling back to eventually consistent KV when the
  // atomic RateLimiter Durable Object is unavailable.
  requireAtomic?: boolean;
}

/**
 * Rate limit record stored in KV
 */
interface RateLimitRecord {
  count: number;
  resetAt: number; // Unix timestamp when the window resets
}

interface LocalFastPathRecord {
  count: number;
  resetAt: number;
}

interface DiagnosticTimingSpan {
  name: string;
  durationMs: number;
}

type HonoExecutionContext = Context<{ Bindings: Env }>['executionCtx'];

const fastPathRecords = new Map<string, LocalFastPathRecord>();
const FAST_PATH_MAX_RECORDS = 10000;
const DIAGNOSTIC_SESSION_ID_HEADER = 'X-Diagnostic-Session-Id';
const MAX_DIAGNOSTIC_SESSION_ID_LENGTH = 128;
const DIAGNOSTIC_TIMING_PATHS = new Set([
  '/api/auth/authentication-methods',
  '/api/v1/login/interactions/start',
]);

function sanitizeDiagnosticSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, MAX_DIAGNOSTIC_SESSION_ID_LENGTH);
}

function isRateLimitTimingEnabled(env: Env, path: string, request: Request): boolean {
  if (
    DIAGNOSTIC_TIMING_PATHS.has(path) &&
    isDiagnosticTimingEnabled(env) &&
    sanitizeDiagnosticSessionId(request.headers.get(DIAGNOSTIC_SESSION_ID_HEADER))
  ) {
    return true;
  }
  if (path !== '/api/v1/login/interactions/start') {
    return false;
  }
  const value = env.AUTHRIM_FLOW_RUNTIME_TIMING?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function isDiagnosticTimingEnabled(env: Env): boolean {
  const value = env.AUTHRIM_DIAGNOSTIC_TIMING_ENABLED?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

function roundDiagnosticDurationMs(value: number): number {
  return Math.round(value * 10) / 10;
}

async function timeDiagnosticSpan<T>(
  spans: DiagnosticTimingSpan[] | null,
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  if (!spans) {
    return operation();
  }

  const startedAtMs = Date.now();
  try {
    return await operation();
  } finally {
    spans.push({
      name,
      durationMs: roundDiagnosticDurationMs(Date.now() - startedAtMs),
    });
  }
}

function appendServerTiming(c: Context<{ Bindings: Env }>, spans: DiagnosticTimingSpan[]): void {
  if (spans.length === 0) {
    return;
  }

  const value = spans.map((span) => `${span.name};dur=${span.durationMs.toFixed(1)}`).join(', ');
  const existing = c.res.headers.get('Server-Timing');
  c.res.headers.set('Server-Timing', existing ? `${existing}, ${value}` : value);
}

function finishRateLimitTiming(
  c: Context<{ Bindings: Env }>,
  spans: DiagnosticTimingSpan[] | null,
  startedAtMs: number,
  metadata: {
    mode: 'skipped_endpoint' | 'skipped_ip' | 'fast_path' | 'sync' | 'denied' | 'error';
    tenantId?: string;
    endpointClass?: string | undefined;
    cloudProvider?: CloudProvider;
    allowed?: boolean;
  }
): void {
  if (!spans) {
    return;
  }

  spans.push({
    name: 'rl_total',
    durationMs: roundDiagnosticDurationMs(Date.now() - startedAtMs),
  });
  appendServerTiming(c, spans);
  log.info('Rate limit timing', {
    diagnosticSessionId: sanitizeDiagnosticSessionId(
      c.req.raw.headers.get(DIAGNOSTIC_SESSION_ID_HEADER)
    ),
    path: c.req.path,
    mode: metadata.mode,
    tenantId: metadata.tenantId,
    endpointClass: metadata.endpointClass,
    cloud_provider: metadata.cloudProvider,
    allowed: metadata.allowed,
    duration_ms: roundDiagnosticDurationMs(Date.now() - startedAtMs),
    spans_ms: Object.fromEntries(spans.map((span) => [span.name, span.durationMs])),
  });
}

// ============================================================
// Cloud Provider IP Extraction
// ============================================================

/**
 * Supported cloud providers for trusted IP extraction
 *
 * Each provider has different mechanisms for providing the real client IP:
 * - cloudflare: Uses CF-Connecting-IP header (most secure, single IP)
 * - aws: Uses X-Forwarded-For, ALB adds client IP at the end
 * - azure: Uses X-Forwarded-For, App Gateway adds client IP at the end
 * - gcp: Uses X-Forwarded-For, adds client IP + LB IP (2nd from end is client)
 * - none: No trusted proxy, uses X-Forwarded-For first IP (WARNING: spoofable!)
 */
export type CloudProvider = 'cloudflare' | 'aws' | 'azure' | 'gcp' | 'none';

/**
 * KV key for cloud provider setting
 */
const CLOUD_PROVIDER_KV_KEY = 'security_cloud_provider';

/**
 * Default cloud provider (Cloudflare - most secure)
 */
const DEFAULT_CLOUD_PROVIDER: CloudProvider = 'cloudflare';

/**
 * Cached cloud provider setting
 */
interface CachedCloudProviderSetting {
  provider: CloudProvider;
  cachedAt: number;
  source: 'default' | 'kv';
}
let cloudProviderCache: CachedCloudProviderSetting | null = null;

/**
 * Default cache TTL in milliseconds (5 minutes)
 * Can be overridden via SETTINGS_CACHE_TTL environment variable
 *
 * Design note: Runtime paths prefer default-first reads and refresh KV overrides
 * asynchronously. Admin API clears the current isolate cache immediately; other
 * isolates converge within this TTL.
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get cache TTL from environment variable or use default
 * @param env - Environment bindings
 * @returns Cache TTL in milliseconds
 */
function getCacheTTLMs(env: Env): number {
  if (env.SETTINGS_CACHE_TTL) {
    const seconds = parseInt(env.SETTINGS_CACHE_TTL, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * Get the KV key for cloud provider setting
 * Exported for use in Admin API
 */
export function getCloudProviderKVKey(): string {
  return CLOUD_PROVIDER_KV_KEY;
}

/**
 * Get the default cloud provider
 * Exported for use in Admin API
 */
export function getDefaultCloudProvider(): CloudProvider {
  return DEFAULT_CLOUD_PROVIDER;
}

/**
 * Valid cloud provider values
 */
export const VALID_CLOUD_PROVIDERS: CloudProvider[] = ['cloudflare', 'aws', 'azure', 'gcp', 'none'];

/**
 * Get the configured cloud provider.
 *
 * Runtime paths default to Cloudflare immediately to avoid a cold-isolate KV
 * read before IP extraction. KV overrides are refreshed out of band by
 * rateLimitMiddleware().
 *
 * @param env - Environment with KV bindings
 * @returns Cloud provider setting
 */
export async function getCloudProvider(env: Env): Promise<CloudProvider> {
  const now = Date.now();
  const cacheTTL = getCacheTTLMs(env);

  // Check cache first
  if (cloudProviderCache && now - cloudProviderCache.cachedAt < cacheTTL) {
    return cloudProviderCache.provider;
  }

  // The Authrim runtime is normally served by Cloudflare Workers. Do not block
  // the first request in a cold isolate just to confirm the default from KV.
  cloudProviderCache = { provider: DEFAULT_CLOUD_PROVIDER, cachedAt: now, source: 'default' };
  return DEFAULT_CLOUD_PROVIDER;
}

async function refreshCloudProviderFromKV(env: Env): Promise<void> {
  // Default: cloudflare (most secure)
  let provider: CloudProvider = DEFAULT_CLOUD_PROVIDER;

  // Check KV for setting
  if (env.AUTHRIM_CONFIG) {
    try {
      const kvValue = await env.AUTHRIM_CONFIG.get(CLOUD_PROVIDER_KV_KEY);
      if (kvValue && VALID_CLOUD_PROVIDERS.includes(kvValue as CloudProvider)) {
        provider = kvValue as CloudProvider;
      }
    } catch {
      // KV read error - use default
    }
  }

  // Update cache
  cloudProviderCache = { provider, cachedAt: Date.now(), source: 'kv' };
}

function scheduleCloudProviderRefresh(env: Env, ctx?: HonoExecutionContext): void {
  const now = Date.now();
  const cacheTTL = getCacheTTLMs(env);
  if (
    !env.AUTHRIM_CONFIG ||
    (cloudProviderCache &&
      cloudProviderCache.source === 'kv' &&
      now - cloudProviderCache.cachedAt < cacheTTL)
  ) {
    return;
  }
  const refresh = refreshCloudProviderFromKV(env).catch(() => {
    cloudProviderCache = {
      provider: DEFAULT_CLOUD_PROVIDER,
      cachedAt: Date.now(),
      source: 'default',
    };
  });
  if (ctx) {
    ctx.waitUntil(refresh);
    return;
  }
  void refresh;
}

/**
 * Clear the cloud provider cache
 * Useful for testing or immediate setting changes
 */
export function clearCloudProviderCache(): void {
  cloudProviderCache = null;
}

// Legacy export for backward compatibility
export function clearTrustCfIpCache(): void {
  clearCloudProviderCache();
}

// Legacy export for backward compatibility
export function getTrustCfIpHeaderKVKey(): string {
  return CLOUD_PROVIDER_KV_KEY;
}

/**
 * Get fallback IP from X-Forwarded-For or X-Real-IP
 * WARNING: These can be spoofed! Only used as fallback when primary method fails.
 *
 * @param c - Hono context
 * @returns IP address or 'unknown'
 */
function getFallbackIP(c: Context): string {
  const xff = c.req.header('X-Forwarded-For');
  if (xff) {
    return xff.split(',')[0]?.trim() || 'unknown';
  }
  const xRealIP = c.req.header('X-Real-IP');
  if (xRealIP) {
    return xRealIP;
  }
  return 'unknown';
}

/**
 * Get client IP address from request based on cloud provider
 *
 * IP Extraction Methods by Provider:
 *
 * **Cloudflare** (Default, Most Secure):
 * - Uses CF-Connecting-IP header which cannot be spoofed
 * - Falls back to X-Forwarded-For if CF header is missing (with warning)
 *
 * **AWS ALB**:
 * - Uses X-Forwarded-For, takes the LAST IP (ALB appends client IP)
 * - Ref: https://docs.aws.amazon.com/elasticloadbalancing/
 *
 * **Azure Application Gateway**:
 * - Uses X-Forwarded-For, takes the LAST IP (Gateway appends client IP)
 * - Ref: https://learn.microsoft.com/azure/application-gateway/
 *
 * **GCP Load Balancer**:
 * - Uses X-Forwarded-For, takes the 2nd from LAST IP
 * - GCP appends [client_ip, lb_ip] to the header
 * - Ref: https://cloud.google.com/load-balancing/docs/https/
 *
 * **None** (No Cloud/Direct):
 * - Uses X-Forwarded-For first IP or X-Real-IP
 * - WARNING: Can be spoofed! Recommend using WAF
 *
 * Security Note: When primary IP extraction fails, the system falls back to
 * X-Forwarded-For first IP which can be spoofed. This is preferable to returning
 * 'unknown' because 'unknown' causes all requests to share a single rate limit
 * bucket, which is a larger security issue.
 *
 * @param c - Hono context
 * @param provider - Cloud provider
 */
export function getClientIP(c: Context, provider: CloudProvider): string {
  switch (provider) {
    case 'cloudflare': {
      // Cloudflare provides the client IP in CF-Connecting-IP header
      // This header cannot be spoofed when traffic goes through Cloudflare
      const cfIP = c.req.header('CF-Connecting-IP');
      if (cfIP) {
        return cfIP;
      }
      // Also check True-Client-IP (Cloudflare Enterprise feature)
      const trueClientIP = c.req.header('True-Client-IP');
      if (trueClientIP) {
        return trueClientIP;
      }
      // Not behind Cloudflare - fallback to X-Forwarded-For
      // Security: Log warning because this may indicate misconfiguration or bypass attempt
      const fallbackIP = getFallbackIP(c);
      if (fallbackIP !== 'unknown') {
        log.warn('CF-Connecting-IP header missing, falling back to X-Forwarded-For', {
          ip: fallbackIP.substring(0, 10) + '...',
        });
      }
      return fallbackIP;
    }

    case 'aws': {
      // AWS ALB appends client IP to the END of X-Forwarded-For
      // Format: "original_xff, client_ip" or just "client_ip"
      const xff = c.req.header('X-Forwarded-For');
      if (xff) {
        const ips = xff.split(',').map((ip) => ip.trim());
        // Take the last IP (added by ALB)
        const ip = ips[ips.length - 1];
        if (ip) return ip;
      }
      // No X-Forwarded-For - may be direct connection, use fallback
      return getFallbackIP(c);
    }

    case 'azure': {
      // Azure Application Gateway appends client IP to the END of X-Forwarded-For
      // Similar to AWS ALB behavior
      const xff = c.req.header('X-Forwarded-For');
      if (xff) {
        const ips = xff.split(',').map((ip) => ip.trim());
        // Take the last IP (added by App Gateway)
        const ip = ips[ips.length - 1];
        if (ip) return ip;
      }
      // No X-Forwarded-For - may be direct connection, use fallback
      return getFallbackIP(c);
    }

    case 'gcp': {
      // GCP Load Balancer appends TWO IPs: [client_ip, lb_ip]
      // So we need the 2nd from last IP
      const xff = c.req.header('X-Forwarded-For');
      if (xff) {
        const ips = xff.split(',').map((ip) => ip.trim());
        if (ips.length >= 2) {
          // Take the 2nd from last IP (client IP before LB IP)
          const ip = ips[ips.length - 2];
          if (ip) return ip;
        } else if (ips.length === 1 && ips[0]) {
          // Only one IP - use it (direct connection to LB)
          return ips[0];
        }
      }
      // No X-Forwarded-For - may be direct connection, use fallback
      return getFallbackIP(c);
    }

    case 'none':
    default: {
      // No trusted proxy - use first IP from X-Forwarded-For
      // WARNING: This can be spoofed by clients!
      // Users should configure WAF for additional protection
      return getFallbackIP(c);
    }
  }
}

function normalizeEndpointClass(value: string | undefined): string | null {
  const normalized = value
    ?.trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64);
  return normalized || null;
}

function buildRateLimitKey(clientIP: string, tenantId?: string, endpointClass?: string): string {
  const normalizedClass = normalizeEndpointClass(endpointClass);
  if (tenantId?.trim()) {
    const prefix = `tenant:${tenantId.trim()}:rate-limit`;
    return normalizedClass ? `${prefix}:${normalizedClass}:${clientIP}` : `${prefix}:${clientIP}`;
  }
  return normalizedClass ? `rate-limit:${normalizedClass}:${clientIP}` : clientIP;
}

function cleanupFastPathRecords(now: number): void {
  if (fastPathRecords.size <= FAST_PATH_MAX_RECORDS) {
    return;
  }

  for (const [key, record] of fastPathRecords.entries()) {
    if (now >= record.resetAt) {
      fastPathRecords.delete(key);
    }
  }

  for (const key of fastPathRecords.keys()) {
    if (fastPathRecords.size <= FAST_PATH_MAX_RECORDS) {
      break;
    }
    fastPathRecords.delete(key);
  }
}

function consumeFastPathRecord(
  rateLimitKey: string,
  config: RateLimitConfig
): { allowed: true; remaining: number; resetAt: number } | { allowed: false } {
  const now = Math.floor(Date.now() / 1000);
  let record = fastPathRecords.get(rateLimitKey);

  if (!record || now >= record.resetAt) {
    record = {
      count: 0,
      resetAt: now + config.windowSeconds,
    };
  }

  if (record.count >= config.maxRequests) {
    fastPathRecords.set(rateLimitKey, record);
    return { allowed: false };
  }

  record.count++;
  fastPathRecords.set(rateLimitKey, record);
  cleanupFastPathRecords(now);

  return {
    allowed: true,
    remaining: Math.max(0, config.maxRequests - record.count),
    resetAt: record.resetAt,
  };
}

function shouldUseNonBlockingReadRateLimit(
  c: Context<{ Bindings: Env }>,
  env: Env,
  config: RateLimitConfig,
  clientIP: string,
  cloudProvider: CloudProvider
): boolean {
  if (!config.nonBlockingRead || c.req.method !== 'GET') {
    return false;
  }

  if (!env.RATE_LIMITER || clientIP === 'unknown') {
    return false;
  }

  // A "none" provider uses spoofable forwarding headers. Keep the precise
  // synchronous limiter in that topology.
  return cloudProvider !== 'none';
}

function getExecutionContext(c: Context<{ Bindings: Env }>): HonoExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

function scheduleNonBlockingRateLimit(
  c: Context<{ Bindings: Env }>,
  clientIP: string,
  config: RateLimitConfig,
  tenantId?: string
): void {
  const promise = checkRateLimit(c.env, clientIP, config, tenantId)
    .then((result) => {
      if (!result.allowed) {
        log.warn('Non-blocking read rate limit exceeded after response', {
          path: c.req.path,
          tenantId,
          endpointClass: config.endpointClass,
          resetAt: result.resetAt,
        });
      }
    })
    .catch((error: unknown) => {
      log.error('Non-blocking read rate limiting error', {}, error as Error);
    });

  const executionCtx = getExecutionContext(c);
  if (executionCtx) {
    executionCtx.waitUntil(promise);
    return;
  }

  void promise;
}

export function clearRateLimitFastPathCache(): void {
  fastPathRecords.clear();
}

/**
 * Check if rate limit is exceeded
 *
 * Uses RateLimiterCounter DO for atomic, precise rate limiting (issue #6).
 * Falls back to KV-based rate limiting if DO is unavailable.
 *
 * @param env - Environment bindings with RATE_LIMITER DO and STATE_STORE KV
 * @param clientIP - Client IP address (used as rate limit key)
 * @param config - Rate limit configuration
 * @returns Rate limit check result with allowed flag, remaining requests, and reset timestamp
 */
export async function checkRateLimit(
  env: Env,
  clientIP: string,
  config: RateLimitConfig,
  tenantId?: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const rateLimitKey = buildRateLimitKey(clientIP, tenantId, config.endpointClass);

  // Try DO-based rate limiting first
  try {
    if (env.RATE_LIMITER) {
      // Use DO ID based on IP to shard load
      const id = env.RATE_LIMITER.idFromName(rateLimitKey);
      const stub = env.RATE_LIMITER.get(id);

      // RPC call to increment counter atomically
      const result = await stub.incrementRpc(rateLimitKey, {
        windowSeconds: config.windowSeconds,
        maxRequests: config.maxRequests,
      });

      return {
        allowed: result.allowed,
        remaining: Math.max(0, result.limit - result.current),
        resetAt: result.resetAt,
      };
    }
  } catch (error) {
    if (config.requireAtomic) {
      throw error;
    }
    log.error('Rate limiting DO error, falling back to KV', {}, error as Error);
  }

  if (config.requireAtomic) {
    throw new Error('Atomic rate limiter is unavailable');
  }

  // Fallback to KV-based rate limiting
  return await checkRateLimitKV(env, rateLimitKey, config);
}

/**
 * KV-based rate limiting (fallback)
 * Used when RateLimiterCounter DO is unavailable
 */
async function checkRateLimitKV(
  env: Env,
  clientIP: string,
  config: RateLimitConfig
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const key = `ratelimit:${clientIP}`;

  // Get current rate limit record
  const recordJson = await env.STATE_STORE.get(key);
  let record: RateLimitRecord;

  if (recordJson) {
    record = JSON.parse(recordJson) as RateLimitRecord;

    // Check if window has expired
    if (now >= record.resetAt) {
      // Window expired, reset counter
      record = {
        count: 1,
        resetAt: now + config.windowSeconds,
      };
    } else {
      // Window still active, increment counter
      record.count++;
    }
  } else {
    // First request from this IP
    record = {
      count: 1,
      resetAt: now + config.windowSeconds,
    };
  }

  // Store updated record with TTL
  await env.STATE_STORE.put(key, JSON.stringify(record), {
    expirationTtl: config.windowSeconds + 60, // Extra 60s grace period
  });

  const allowed = record.count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - record.count);

  return { allowed, remaining, resetAt: record.resetAt };
}

/**
 * Whether a request path falls under one `endpoints` entry.
 *
 * - A plain entry is a string prefix of the path (`/token` also covers `/token/x`).
 * - `:name` matches exactly one non-empty path segment (`/api/users/:id/lock`).
 * - A trailing `/*` matches the child routes below the base (`/api/items/*` covers
 *   `/api/items/a/download`, not `/api/items` itself and not `/api/items-other`). Pair it with the
 *   plain base entry to cover both without counting a request twice.
 *
 * Entries containing `*` or `:` used to be compared as literal text, which silently disabled the
 * limiter on every route they were meant to cover.
 */
export function matchesRateLimitEndpoint(path: string, endpoint: string): boolean {
  if (!endpoint.includes('*') && !endpoint.includes(':')) {
    return path.startsWith(endpoint);
  }

  const patternSegments = endpoint.split('/');
  const pathSegments = path.split('/');
  for (let index = 0; index < patternSegments.length; index++) {
    const pattern = patternSegments[index];
    const segment = pathSegments[index];
    if (pattern === '*') {
      // The wildcard stands for one or more remaining segments.
      return index === patternSegments.length - 1 && segment !== undefined && segment !== '';
    }
    if (segment === undefined) return false;
    if (pattern.startsWith(':')) {
      if (segment === '') return false;
      continue;
    }
    const isLast = index === patternSegments.length - 1;
    if (isLast ? !segment.startsWith(pattern) : segment !== pattern) return false;
  }
  return true;
}

/**
 * Rate limiting middleware factory
 *
 * @param config - Rate limit configuration
 * @returns Middleware function
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    // The path Hono routes on (percent-decoded). The raw URL pathname would let an encoded request
    // such as /api/%75ser/consents reach the same handler while escaping the endpoints filter.
    const path = c.req.path;
    const timingEnabled = isRateLimitTimingEnabled(c.env, path, c.req.raw);
    const timingSpans: DiagnosticTimingSpan[] | null = timingEnabled ? [] : null;
    const timingStartedAtMs = Date.now();

    // If endpoints filter is specified, only apply to those endpoints
    if (config.endpoints && config.endpoints.length > 0) {
      const shouldApply = config.endpoints.some((endpoint) =>
        matchesRateLimitEndpoint(path, endpoint)
      );

      if (!shouldApply) {
        await next();
        finishRateLimitTiming(c, timingSpans, timingStartedAtMs, {
          mode: 'skipped_endpoint',
          endpointClass: config.endpointClass,
        });
        return;
      }
    }

    // Get cloud provider setting for IP extraction
    const cloudProvider = await timeDiagnosticSpan(timingSpans, 'rl_cloud_provider', () =>
      getCloudProvider(c.env)
    );
    scheduleCloudProviderRefresh(c.env, getExecutionContext(c));
    const clientIP = getClientIP(c, cloudProvider);

    // Skip rate limiting for whitelisted IPs
    if (config.skipIPs && config.skipIPs.includes(clientIP)) {
      await next();
      finishRateLimitTiming(c, timingSpans, timingStartedAtMs, {
        mode: 'skipped_ip',
        endpointClass: config.endpointClass,
        cloudProvider,
      });
      return;
    }

    try {
      const tenantId = config.keyScope === 'global' ? undefined : getTenantIdFromContext(c);
      const rateLimitKey = buildRateLimitKey(clientIP, tenantId, config.endpointClass);

      if (shouldUseNonBlockingReadRateLimit(c, c.env, config, clientIP, cloudProvider)) {
        const fastPath = consumeFastPathRecord(rateLimitKey, config);
        if (fastPath.allowed) {
          c.header('X-RateLimit-Limit', config.maxRequests.toString());
          c.header('X-RateLimit-Remaining', fastPath.remaining.toString());
          c.header('X-RateLimit-Reset', fastPath.resetAt.toString());

          scheduleNonBlockingRateLimit(c, clientIP, config, tenantId);
          await next();
          finishRateLimitTiming(c, timingSpans, timingStartedAtMs, {
            mode: 'fast_path',
            tenantId,
            endpointClass: config.endpointClass,
            cloudProvider,
            allowed: true,
          });
          return;
        }
      }

      let activeConfig = config;
      let result = await timeDiagnosticSpan(timingSpans, 'rl_check', () =>
        checkRateLimit(c.env, clientIP, config, tenantId)
      );

      if (!result.allowed) {
        const relaxedOverride = await timeDiagnosticSpan(
          timingSpans,
          'rl_denied_override_refresh',
          () => refreshRelaxedRateLimitOverrideAfterDenial(c.env, config)
        );
        if (relaxedOverride) {
          activeConfig = { ...config, ...relaxedOverride };
          result = await timeDiagnosticSpan(timingSpans, 'rl_override_recheck', () =>
            checkRateLimit(c.env, clientIP, activeConfig, tenantId)
          );
        }
      }

      const { allowed, remaining, resetAt } = result;

      // Add rate limit headers to response
      c.header('X-RateLimit-Limit', activeConfig.maxRequests.toString());
      c.header('X-RateLimit-Remaining', remaining.toString());
      c.header('X-RateLimit-Reset', resetAt.toString());

      if (!allowed) {
        const retryAfter = resetAt - Math.floor(Date.now() / 1000);

        c.header('Retry-After', retryAfter.toString());
        finishRateLimitTiming(c, timingSpans, timingStartedAtMs, {
          mode: 'denied',
          tenantId,
          endpointClass: config.endpointClass,
          cloudProvider,
          allowed: false,
        });

        // Publish rate limit exceeded event (non-blocking)
        // Hash client IP for privacy (simple hash, not cryptographically secure)
        const ipHash = await crypto.subtle
          .digest('SHA-256', new TextEncoder().encode(clientIP))
          .then((buf) =>
            Array.from(new Uint8Array(buf).slice(0, 8))
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('')
          )
          .catch(() => 'unknown');

        publishEvent(c, {
          type: SECURITY_EVENTS.RATE_LIMIT_EXCEEDED,
          tenantId: getTenantIdFromContext(c),
          data: {
            endpoint: c.req.path,
            clientIpHash: ipHash,
            rateLimit: {
              maxRequests: activeConfig.maxRequests,
              windowSeconds: activeConfig.windowSeconds,
              retryAfter,
              endpointClass: config.endpointClass,
            },
          } satisfies SecurityEventData,
        }).catch((err: unknown) => {
          log.error('Failed to publish security.rate_limit.exceeded event', {}, err as Error);
        });

        return c.json(
          {
            error: 'rate_limit_exceeded',
            error_description: 'Too many requests. Please try again later.',
            retry_after: retryAfter,
          },
          429
        );
      }

      await next();
      finishRateLimitTiming(c, timingSpans, timingStartedAtMs, {
        mode: 'sync',
        tenantId,
        endpointClass: config.endpointClass,
        cloudProvider,
        allowed: true,
      });
      return;
    } catch (error) {
      log.error('Rate limiting error', {}, error as Error);
      finishRateLimitTiming(c, timingSpans, timingStartedAtMs, {
        mode: 'error',
        endpointClass: config.endpointClass,
      });
      // Security: Fail-close - deny request on error to prevent bypass attacks
      // RFC 6749 5.2: Use 'temporarily_unavailable' for 503 responses
      // RFC 6749: All error responses MUST include Cache-Control: no-store
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The service is temporarily unavailable. Please try again later.',
        },
        503
      );
    }
  };
}

/**
 * Pre-configured rate limit profiles (defaults)
 */
export const RateLimitProfiles = {
  /**
   * Strict rate limiting for sensitive endpoints (e.g., token, register)
   * 10 requests per minute
   */
  strict: {
    maxRequests: 10,
    windowSeconds: 60,
  },

  /**
   * Moderate rate limiting for API endpoints
   * 60 requests per minute
   */
  moderate: {
    maxRequests: 60,
    windowSeconds: 60,
  },

  /**
   * Lenient rate limiting for public endpoints (e.g., discovery, JWKS)
   * 300 requests per minute
   */
  lenient: {
    maxRequests: 300,
    windowSeconds: 60,
  },

  /**
   * Public read-only bootstrap endpoints. Kept intentionally loose for school,
   * corporate, dormitory, and library NATs where many users share one IP.
   */
  publicRead: {
    maxRequests: 600,
    windowSeconds: 60,
  },

  /**
   * Login runtime interaction start. This writes flow state, but shared-IP
   * environments can legitimately generate bursts during class or event logins.
   */
  loginStart: {
    maxRequests: 300,
    windowSeconds: 60,
  },

  /**
   * Challenge sending endpoints such as email OTP. Keep tighter because they
   * can create cost, inbox noise, or account probing pressure.
   */
  sendChallenge: {
    maxRequests: 30,
    windowSeconds: 60,
  },

  /**
   * Load testing profile - very high limits
   * Default: 10000 requests per minute
   * Set through the Settings API: rate_limit.loadtest, rate_limit.loadtest_window_seconds
   */
  loadTest: {
    maxRequests: 10000,
    windowSeconds: 60,
  },
} as const;

// ============================================================
// Dynamic Rate Limit Configuration (Settings API, profile override)
// ============================================================

/**
 * Cached rate limit config to avoid repeated KV lookups.
 * Cache duration controlled by SETTINGS_CACHE_TTL env var (default: 5 minutes)
 */
interface CachedRateLimitConfig {
  config: RateLimitConfig;
  cachedAt: number;
}
const rateLimitConfigCache = new Map<string, CachedRateLimitConfig>();
/**
 * The profile override last read (null: none), and when it was last checked. A failed check keeps
 * the override last read and only moves `checkedAt`, so a store that cannot be read neither drops
 * an override (loosening or tightening limits) nor is re-read on each request.
 */
let rateLimitProfileOverrideCache: {
  profile: keyof typeof RateLimitProfiles | null;
  /** When the override stops applying (null: it does not expire). */
  expiresAt: number | null;
  cachedAt: number;
} | null = null;

/** The override in the cache, while it applies (an expired one is never applied). */
function cachedProfileOverride(now: number): keyof typeof RateLimitProfiles | null {
  const cached = rateLimitProfileOverrideCache;
  if (!cached?.profile) return null;
  return cached.expiresAt === null || now < cached.expiresAt ? cached.profile : null;
}
/** The relaxed limits a denial's check found, until when that override applies, and when checked. */
let deniedOverrideRefreshCache: {
  config: RateLimitConfig | null;
  expiresAt: number | null;
  checkedAt: number;
} | null = null;
const DENIED_OVERRIDE_REFRESH_TTL_MS = 1_000;

/** A resolved limit as the rate limiter applies it: a positive integer, else unset. */
function positiveLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * A profile's limits, for the whole platform: the Settings API values
 * (`rate_limit.<profile>`, `rate_limit.<profile>_window_seconds`), else env, else the defaults.
 * Throws when they cannot be read, so the caller keeps the limits it has.
 */
export async function readRateLimitProfileConfig(
  env: Env,
  profileName: keyof typeof RateLimitProfiles
): Promise<RateLimitConfig> {
  const keys = rateLimitProfileKeys(profileName);
  const { values } = await resolvePlatformSettingsWithSources(env, 'rate-limit', {});
  const defaults = RateLimitProfiles[profileName];
  return {
    maxRequests: positiveLimit(values[keys.maxRequests]) ?? defaults.maxRequests,
    windowSeconds: positiveLimit(values[keys.windowSeconds]) ?? defaults.windowSeconds,
  };
}

async function refreshRelaxedRateLimitOverrideAfterDenial(
  env: Env,
  current: RateLimitConfig
): Promise<RateLimitConfig | null> {
  if (!env.AUTHRIM_CONFIG) return null;
  const now = Date.now();
  if (
    deniedOverrideRefreshCache &&
    now - deniedOverrideRefreshCache.checkedAt < DENIED_OVERRIDE_REFRESH_TTL_MS
  ) {
    const { config, expiresAt } = deniedOverrideRefreshCache;
    return expiresAt !== null && now >= expiresAt ? null : config;
  }
  try {
    const override = parseRateLimitProfileOverride(
      await env.AUTHRIM_CONFIG.get(PROFILE_OVERRIDE_KV_KEY)
    );
    const profile = override?.profile ?? null;
    if (!override || !profile) {
      // A removed override is published by the background check, with the limits it needs.
      deniedOverrideRefreshCache = { config: null, expiresAt: null, checkedAt: Date.now() };
      return null;
    }
    // Publish the override only with its limits read. An expiring one is published by the
    // background check, with the limits that apply once it ends; until then it only answers this
    // denial check.
    const refreshed = await readRateLimitProfileConfig(env, profile);
    rateLimitConfigCache.set(profile, { config: refreshed, cachedAt: Date.now() });
    if (override.expiresAt === null) {
      rateLimitProfileOverrideCache = { profile, expiresAt: null, cachedAt: Date.now() };
    }
    // An override that expired while its limits were read no longer relaxes anything.
    const applies = override.expiresAt === null || Date.now() < override.expiresAt;
    const config = applies && refreshed.maxRequests > current.maxRequests ? refreshed : null;
    deniedOverrideRefreshCache = { config, expiresAt: override.expiresAt, checkedAt: Date.now() };
    return config;
  } catch {
    deniedOverrideRefreshCache = { config: null, expiresAt: null, checkedAt: Date.now() };
    return null;
  }
}

/**
 * Get rate limit profile with environment variable override (synchronous version)
 *
 * @param env - Environment bindings
 * @param profileName - Profile name (strict, moderate, lenient, loadTest)
 * @returns Rate limit config (may be overridden by RATE_LIMIT_PROFILE env var)
 * @deprecated Use getRateLimitProfileAsync for KV-based dynamic configuration
 */
export function getRateLimitProfile(
  env: { RATE_LIMIT_PROFILE?: string },
  profileName: keyof typeof RateLimitProfiles
): RateLimitConfig {
  // Check if load testing mode is enabled via environment variable
  if (env.RATE_LIMIT_PROFILE === 'loadTest') {
    return RateLimitProfiles.loadTest;
  }

  return RateLimitProfiles[profileName];
}

/**
 * KV key for global profile override
 * When set, all rate limiting uses this profile instead of endpoint-specific profiles
 */
const PROFILE_OVERRIDE_KV_KEY = 'rate_limit_profile_override';

/** The longest a loadTest override applies (the override API's limit, in seconds). */
export const LOAD_TEST_OVERRIDE_MAX_SECONDS = 3600;

/** A profile override, and when it stops applying (null: it does not expire). */
export interface RateLimitProfileOverride {
  profile: keyof typeof RateLimitProfiles;
  expiresAt: number | null;
}

function isRateLimitProfile(value: unknown): value is keyof typeof RateLimitProfiles {
  return (
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(RateLimitProfiles, value)
  );
}

/**
 * The stored profile override: `{"profile", "expires_at"}` (milliseconds), or a profile name as
 * the older API stored it. A loadTest override always expires: without an expiry, at most
 * LOAD_TEST_OVERRIDE_MAX_SECONDS after it was read. Null when none is set, the profile is unknown,
 * or it has expired.
 */
export function parseRateLimitProfileOverride(
  raw: string | null | undefined,
  now: number = Date.now()
): RateLimitProfileOverride | null {
  if (!raw) return null;
  let profile: unknown = raw;
  let expiresAt: unknown = null;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { profile?: unknown; expires_at?: unknown };
      profile = parsed.profile;
      expiresAt = parsed.expires_at ?? null;
    } catch {
      return null;
    }
  }
  if (!isRateLimitProfile(profile)) return null;
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    return null;
  }
  let until = expiresAt as number | null;
  if (profile === 'loadTest') {
    const latest = now + LOAD_TEST_OVERRIDE_MAX_SECONDS * 1000;
    until = until === null ? latest : Math.min(until, latest);
  }
  if (until !== null && now >= until) return null;
  return { profile, expiresAt: until };
}

/** The stored form of a profile override. */
export function formatRateLimitProfileOverride(
  profile: keyof typeof RateLimitProfiles,
  expiresAt: number | null
): string {
  return JSON.stringify(expiresAt === null ? { profile } : { profile, expires_at: expiresAt });
}

/**
 * Get rate limit profile with KV override support (async version)
 *
 * Runtime priority:
 * 1. Fresh in-memory cache, when present
 * 2. RATE_LIMIT_PROFILE environment override, when present
 * 3. Built-in default profile values
 *
 * KV profile overrides and per-profile settings are refreshed asynchronously.
 * This keeps the login cold path from blocking on SETTINGS/AUTHRIM_CONFIG KV
 * while preserving eventual Admin-driven runtime changes.
 *
 * @param env - Environment bindings with AUTHRIM_CONFIG KV
 * @param profileName - Profile name (strict, moderate, lenient, loadTest)
 * @returns Rate limit config with KV overrides applied
 *
 * @example
 * // Set global profile override via KV (no deployment required):
 * // npx wrangler kv key put "rate_limit_profile_override" "loadTest" --namespace-id=... --remote
 * // Or via Admin API: PUT /api/admin/rate-limits/profile-override {"profile": "loadTest"}
 *
 * // Set per-profile limits through the Settings API (platform):
 * // PATCH /api/admin/platform/settings/rate-limit {"set": {"rate_limit.loadtest": 20000}}
 *
 * const config = await getRateLimitProfileAsync(env, 'strict');
 * // If rate_limit_profile_override=loadTest, returns loadTest config instead of strict
 */
export async function getRateLimitProfileAsync(
  env: Env,
  profileName: keyof typeof RateLimitProfiles,
  ctx?: HonoExecutionContext
): Promise<RateLimitConfig> {
  const now = Date.now();
  const cacheTTL = getCacheTTLMs(env);
  const envProfile =
    env.RATE_LIMIT_PROFILE && env.RATE_LIMIT_PROFILE in RateLimitProfiles
      ? (env.RATE_LIMIT_PROFILE as keyof typeof RateLimitProfiles)
      : null;

  // The override last read applies until a later check replaces it (not when it goes stale).
  if (!rateLimitProfileOverrideCache || now - rateLimitProfileOverrideCache.cachedAt >= cacheTTL) {
    scheduleRateLimitRefresh('override', () => refreshRateLimitProfileOverride(env), ctx);
  }
  const effectiveProfile = cachedProfileOverride(now) ?? envProfile ?? profileName;
  // Under an override, keep the limits that apply after it read too (RATE_LIMIT_PROFILE, else the
  // endpoint's own), so they apply as soon as the override ends (an expiring one in particular)
  // instead of the defaults.
  const fallbackProfile = envProfile ?? profileName;
  if (effectiveProfile !== fallbackProfile) {
    const fallback = rateLimitConfigCache.get(fallbackProfile);
    if (!fallback || now - fallback.cachedAt >= cacheTTL) {
      scheduleRateLimitRefresh(
        fallbackProfile,
        () => refreshRateLimitProfileConfig(env, fallbackProfile),
        ctx
      );
    }
  }

  const cached = rateLimitConfigCache.get(effectiveProfile);
  if (!cached || now - cached.cachedAt >= cacheTTL) {
    scheduleRateLimitRefresh(
      effectiveProfile,
      () => refreshRateLimitProfileConfig(env, effectiveProfile),
      ctx
    );
  }

  // The last limits read, even past their refresh time: while a refresh runs or fails, limits set
  // through the Settings API must not fall back to the (looser) defaults.
  if (cached) {
    return cached.config;
  }

  const config = RateLimitProfiles[effectiveProfile];
  rateLimitConfigCache.set(effectiveProfile, { config, cachedAt: now });
  return config;
}

/**
 * Check the profile override. A changed override is published only together with the limits of
 * every profile it makes apply, so a switch never runs on a profile's defaults; a failed check
 * (of the override or of those limits) keeps the override and limits last read.
 */
async function refreshRateLimitProfileOverride(env: Env): Promise<void> {
  // Keeps the override last read, with its expiry: an expired one stops applying all the same.
  const keepCurrent = () => {
    rateLimitProfileOverrideCache = {
      profile: rateLimitProfileOverrideCache?.profile ?? null,
      expiresAt: rateLimitProfileOverrideCache?.expiresAt ?? null,
      cachedAt: Date.now(),
    };
  };
  let override: RateLimitProfileOverride | null = null;
  if (env.AUTHRIM_CONFIG) {
    try {
      override = parseRateLimitProfileOverride(
        await env.AUTHRIM_CONFIG.get(PROFILE_OVERRIDE_KV_KEY)
      );
    } catch (error) {
      keepCurrent();
      throw error;
    }
  }
  const profile = override?.profile ?? null;
  const expiresAt = override?.expiresAt ?? null;
  // Against the override last read, expired or not: one that ended is replaced only once the
  // limits that apply after it are read.
  if (rateLimitProfileOverrideCache && rateLimitProfileOverrideCache.profile === profile) {
    rateLimitProfileOverrideCache = { profile, expiresAt, cachedAt: Date.now() };
    return;
  }

  // The profiles that apply after the change: the override, else RATE_LIMIT_PROFILE, else each
  // caller's own profile (any of them).
  const envProfile =
    env.RATE_LIMIT_PROFILE && env.RATE_LIMIT_PROFILE in RateLimitProfiles
      ? (env.RATE_LIMIT_PROFILE as keyof typeof RateLimitProfiles)
      : null;
  const afterOverride = envProfile
    ? [envProfile]
    : (Object.keys(RateLimitProfiles) as Array<keyof typeof RateLimitProfiles>);
  // An expiring override is published with the limits that apply once it ends, too.
  const targets = profile
    ? [...new Set(expiresAt === null ? [profile] : [profile, ...afterOverride])]
    : afterOverride;
  let configs: RateLimitConfig[];
  try {
    configs = await Promise.all(targets.map((target) => readRateLimitProfileConfig(env, target)));
  } catch (error) {
    keepCurrent();
    throw error;
  }
  const now = Date.now();
  targets.forEach((target, index) =>
    rateLimitConfigCache.set(target, { config: configs[index], cachedAt: now })
  );
  rateLimitProfileOverrideCache = { profile, expiresAt, cachedAt: now };
}

/** Read a profile's limits. A failed read keeps the limits last read, until the next cache time. */
async function refreshRateLimitProfileConfig(
  env: Env,
  profileName: keyof typeof RateLimitProfiles
): Promise<void> {
  let config: RateLimitConfig;
  try {
    config = await readRateLimitProfileConfig(env, profileName);
  } catch (error) {
    const previous = rateLimitConfigCache.get(profileName);
    if (previous) rateLimitConfigCache.set(profileName, { ...previous, cachedAt: Date.now() });
    throw error;
  }
  rateLimitConfigCache.set(profileName, { config, cachedAt: Date.now() });
}

/**
 * Refreshes in flight, by what they read (the override, or a profile's limits as applied), so
 * concurrent requests share one read instead of each starting one.
 */
const refreshesInFlight = new Map<string, Promise<void>>();

function scheduleRateLimitRefresh(
  key: string,
  run: () => Promise<void>,
  ctx?: HonoExecutionContext
): void {
  const inFlight = refreshesInFlight.get(key);
  if (inFlight) {
    ctx?.waitUntil(inFlight);
    return;
  }
  const refresh = run()
    .catch((error) => {
      log.error('Failed to refresh rate limit settings', { key }, error as Error);
    })
    .finally(() => refreshesInFlight.delete(key));
  refreshesInFlight.set(key, refresh);
  if (ctx) {
    ctx.waitUntil(refresh);
    return;
  }
  void refresh;
}

/**
 * Get the KV key for profile override
 * Exported for use in Admin API
 */
export function getProfileOverrideKVKey(): string {
  return PROFILE_OVERRIDE_KV_KEY;
}

/**
 * Clear rate limit config cache.
 * Useful for testing or when immediate KV changes are needed.
 */
export function clearRateLimitConfigCache(): void {
  rateLimitConfigCache.clear();
  refreshesInFlight.clear();
  rateLimitProfileOverrideCache = null;
  deniedOverrideRefreshCache = null;
}
