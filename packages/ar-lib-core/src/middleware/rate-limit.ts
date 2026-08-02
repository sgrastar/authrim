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
let cloudProviderRefreshPromise: Promise<void> | null = null;

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
    cloudProviderRefreshPromise ||
    (cloudProviderCache &&
      cloudProviderCache.source === 'kv' &&
      now - cloudProviderCache.cachedAt < cacheTTL)
  ) {
    return;
  }
  cloudProviderRefreshPromise = refreshCloudProviderFromKV(env)
    .catch(() => {
      cloudProviderCache = {
        provider: DEFAULT_CLOUD_PROVIDER,
        cachedAt: Date.now(),
        source: 'default',
      };
    })
    .finally(() => {
      cloudProviderRefreshPromise = null;
    });
  if (ctx) {
    ctx.waitUntil(cloudProviderRefreshPromise);
    return;
  }
  void cloudProviderRefreshPromise;
}

/**
 * Clear the cloud provider cache
 * Useful for testing or immediate setting changes
 */
export function clearCloudProviderCache(): void {
  cloudProviderCache = null;
  cloudProviderRefreshPromise = null;
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
 * Rate limiting middleware factory
 *
 * @param config - Rate limit configuration
 * @returns Middleware function
 */
export function rateLimitMiddleware(config: RateLimitConfig) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    const timingEnabled = isRateLimitTimingEnabled(c.env, path, c.req.raw);
    const timingSpans: DiagnosticTimingSpan[] | null = timingEnabled ? [] : null;
    const timingStartedAtMs = Date.now();

    // If endpoints filter is specified, only apply to those endpoints
    if (config.endpoints && config.endpoints.length > 0) {
      const shouldApply = config.endpoints.some((endpoint) => path.startsWith(endpoint));

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
   * Can be overridden via KV: rate_limit_loadtest_max_requests, rate_limit_loadtest_window_seconds
   */
  loadTest: {
    maxRequests: 10000,
    windowSeconds: 60,
  },
} as const;

// ============================================================
// KV-based Dynamic Rate Limit Configuration
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
let rateLimitProfileOverrideCache: {
  profile: keyof typeof RateLimitProfiles | null;
  cachedAt: number;
} | null = null;
const rateLimitRefreshPromises = new Map<string, Promise<void>>();
let deniedOverrideRefreshCache: { config: RateLimitConfig | null; checkedAt: number } | null = null;
let deniedOverrideRefreshPromise: Promise<RateLimitConfig | null> | null = null;
const DENIED_OVERRIDE_REFRESH_TTL_MS = 1_000;
const RATE_LIMIT_PROFILE_KV_NAMES: Record<keyof typeof RateLimitProfiles, string> = {
  strict: 'strict',
  moderate: 'moderate',
  lenient: 'lenient',
  publicRead: 'public_read',
  loginStart: 'login_start',
  sendChallenge: 'send_challenge',
  loadTest: 'loadtest',
};

/**
 * KV keys for rate limit configuration
 *
 * KV Key Format:
 * - rate_limit_{profile}_max_requests - Max requests for profile
 * - rate_limit_{profile}_window_seconds - Time window for profile
 *
 * Example:
 * npx wrangler kv key put "rate_limit_loadtest_max_requests" "20000" --namespace-id=... --remote
 * npx wrangler kv key put "rate_limit_loadtest_window_seconds" "60" --namespace-id=... --remote
 */
function getRateLimitKVKeys(profileName: string): {
  maxRequestsKey: string;
  windowSecondsKey: string;
} {
  const normalizedName =
    RATE_LIMIT_PROFILE_KV_NAMES[profileName as keyof typeof RateLimitProfiles] ??
    profileName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return {
    maxRequestsKey: `rate_limit_${normalizedName}_max_requests`,
    windowSecondsKey: `rate_limit_${normalizedName}_window_seconds`,
  };
}

async function readRateLimitConfigFromKV(
  env: Env,
  profileName: keyof typeof RateLimitProfiles
): Promise<RateLimitConfig> {
  const defaultConfig = RateLimitProfiles[profileName];
  let maxRequests: number = defaultConfig.maxRequests;
  let windowSeconds: number = defaultConfig.windowSeconds;

  if (env.AUTHRIM_CONFIG) {
    const { maxRequestsKey, windowSecondsKey } = getRateLimitKVKeys(profileName);

    try {
      const [maxRequestsValue, windowSecondsValue] = await Promise.all([
        env.AUTHRIM_CONFIG.get(maxRequestsKey),
        env.AUTHRIM_CONFIG.get(windowSecondsKey),
      ]);

      if (maxRequestsValue) {
        const parsed = parseInt(maxRequestsValue, 10);
        if (!isNaN(parsed) && parsed > 0) {
          maxRequests = parsed;
        }
      }

      if (windowSecondsValue) {
        const parsed = parseInt(windowSecondsValue, 10);
        if (!isNaN(parsed) && parsed > 0) {
          windowSeconds = parsed;
        }
      }
    } catch (error) {
      log.error('Failed to refresh rate limit config from KV', {}, error as Error);
    }
  }

  return { maxRequests, windowSeconds };
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
    return deniedOverrideRefreshCache.config;
  }
  if (deniedOverrideRefreshPromise) return deniedOverrideRefreshPromise;

  deniedOverrideRefreshPromise = (async () => {
    try {
      const value = await env.AUTHRIM_CONFIG!.get(PROFILE_OVERRIDE_KV_KEY);
      if (!value || !(value in RateLimitProfiles)) return null;
      const profile = value as keyof typeof RateLimitProfiles;
      const refreshed = await readRateLimitConfigFromKV(env, profile);
      rateLimitProfileOverrideCache = { profile, cachedAt: Date.now() };
      rateLimitConfigCache.set(profile, { config: refreshed, cachedAt: Date.now() });
      return refreshed.maxRequests > current.maxRequests ? refreshed : null;
    } catch {
      return null;
    }
  })();
  try {
    const config = await deniedOverrideRefreshPromise;
    deniedOverrideRefreshCache = { config, checkedAt: Date.now() };
    return config;
  } finally {
    deniedOverrideRefreshPromise = null;
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
 * // Or via Admin API: PUT /api/admin/settings/rate-limit/profile-override {"profile": "loadTest"}
 *
 * // Set per-profile settings via KV:
 * // npx wrangler kv key put "rate_limit_loadtest_max_requests" "20000" --namespace-id=... --remote
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
  const cachedOverride =
    rateLimitProfileOverrideCache && now - rateLimitProfileOverrideCache.cachedAt < cacheTTL
      ? rateLimitProfileOverrideCache.profile
      : null;
  const overrideCacheFresh =
    !!rateLimitProfileOverrideCache && now - rateLimitProfileOverrideCache.cachedAt < cacheTTL;
  const effectiveProfile = cachedOverride ?? envProfile ?? profileName;
  const cached = rateLimitConfigCache.get(effectiveProfile);

  if (!overrideCacheFresh || !cached || now - cached.cachedAt >= cacheTTL) {
    scheduleRateLimitProfileRefresh(env, profileName, ctx);
  }

  if (cached && now - cached.cachedAt < cacheTTL) {
    return cached.config;
  }

  const config = RateLimitProfiles[effectiveProfile];
  rateLimitConfigCache.set(effectiveProfile, { config, cachedAt: now });
  return config;
}

async function refreshRateLimitProfileFromKV(
  env: Env,
  profileName: keyof typeof RateLimitProfiles
): Promise<void> {
  const now = Date.now();
  let effectiveProfile: keyof typeof RateLimitProfiles = profileName;

  if (env.AUTHRIM_CONFIG) {
    try {
      const kvProfileOverride = await env.AUTHRIM_CONFIG.get(PROFILE_OVERRIDE_KV_KEY);
      if (kvProfileOverride && kvProfileOverride in RateLimitProfiles) {
        effectiveProfile = kvProfileOverride as keyof typeof RateLimitProfiles;
        rateLimitProfileOverrideCache = { profile: effectiveProfile, cachedAt: now };
      } else {
        rateLimitProfileOverrideCache = { profile: null, cachedAt: now };
      }
    } catch {
      rateLimitProfileOverrideCache = { profile: null, cachedAt: now };
    }
  }

  if (effectiveProfile === profileName) {
    if (env.RATE_LIMIT_PROFILE && env.RATE_LIMIT_PROFILE in RateLimitProfiles) {
      effectiveProfile = env.RATE_LIMIT_PROFILE as keyof typeof RateLimitProfiles;
    }
  }

  const config = await readRateLimitConfigFromKV(env, effectiveProfile);
  rateLimitConfigCache.set(effectiveProfile, { config, cachedAt: Date.now() });
}

function scheduleRateLimitProfileRefresh(
  env: Env,
  profileName: keyof typeof RateLimitProfiles,
  ctx?: HonoExecutionContext
): void {
  if (!env.AUTHRIM_CONFIG) {
    return;
  }
  const refreshKey = profileName;
  const existing = rateLimitRefreshPromises.get(refreshKey);
  if (existing) {
    if (ctx) ctx.waitUntil(existing);
    return;
  }
  const refresh = refreshRateLimitProfileFromKV(env, profileName)
    .catch((error) => {
      log.error('Failed to refresh rate limit profile from KV', {}, error as Error);
    })
    .finally(() => {
      rateLimitRefreshPromises.delete(refreshKey);
    });
  rateLimitRefreshPromises.set(refreshKey, refresh);
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
  rateLimitProfileOverrideCache = null;
  rateLimitRefreshPromises.clear();
  deniedOverrideRefreshCache = null;
  deniedOverrideRefreshPromise = null;
}
