/**
 * Health Check Utilities
 *
 * Provides standardized health check handlers for Kubernetes liveness and readiness probes.
 *
 * @packageDocumentation
 */

import type { Context } from 'hono';
import type { Env } from '../types/env.js';
import { getTenantIdFromContext } from '../middleware/request-context.js';

// =============================================================================
// Types
// =============================================================================

export interface HealthCheckResult {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

export interface ReadinessCheckResult {
  status: 'ready' | 'not_ready';
  checks: Record<string, HealthCheckResult>;
  timestamp: string;
}

export interface LivenessCheckResult {
  status: 'ok';
  timestamp: string;
}

export interface HealthCheckOptions {
  /** Service name for logging */
  serviceName: string;
  /** Service version */
  version?: string;
  /** Whether to check database connectivity */
  checkDatabase?: boolean;
  /** Whether to check KV connectivity */
  checkKV?: boolean;
  /** Whether to check KeyManager DO */
  checkKeyManager?: boolean;
}

// =============================================================================
// Health Check Functions
// =============================================================================

/**
 * Check database (D1) connectivity
 */
async function checkDatabase(env: Env): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    // Simple query to verify database connectivity
    await env.DB.prepare('SELECT 1').first();
    return {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}

/**
 * Check KV connectivity
 */
async function checkKV(kv: KVNamespace): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    // Try to get a non-existent key (fast operation)
    await kv.get('__health_check__');
    return {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown KV error',
    };
  }
}

/**
 * Check KeyManager Durable Object
 */
async function checkKeyManager(env: Env, tenantId: string): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    if (env.KEY_MANAGER_PUBLIC) {
      await env.KEY_MANAGER_PUBLIC.getAllPublicKeys(tenantId);
      return {
        status: 'ok',
        latencyMs: Date.now() - start,
      };
    }
    if (!env.KEY_MANAGER) {
      return {
        status: 'ok',
        latencyMs: Date.now() - start,
      };
    }
    const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
    const keyManager = env.KEY_MANAGER.get(keyManagerId);
    // Get public keys to verify DO is responsive
    await keyManager.getAllPublicKeysRpc();
    return {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown KeyManager error',
    };
  }
}

// =============================================================================
// Handler Factories
// =============================================================================

/**
 * Create liveness probe handler
 *
 * Liveness probe checks if the service is running.
 * Should always return 200 if the process is alive.
 */
export function createLivenessHandler() {
  return (c: Context): Response => {
    const result: LivenessCheckResult = {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
    return c.json(result, 200);
  };
}

/**
 * Create readiness probe handler
 *
 * Readiness probe checks if the service is ready to accept traffic.
 * Checks database, KV, and other dependencies.
 */
export function createReadinessHandler(options: HealthCheckOptions) {
  return async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    const env = c.env;
    const checks: Record<string, HealthCheckResult> = {};
    let allHealthy = true;

    // Run health checks in parallel
    const checkPromises: Promise<void>[] = [];

    if (options.checkDatabase !== false && env.DB) {
      checkPromises.push(
        checkDatabase(env).then((result) => {
          checks.database = result;
          if (result.status === 'error') allHealthy = false;
        })
      );
    }

    if (options.checkKV !== false && env.KV) {
      checkPromises.push(
        checkKV(env.KV).then((result) => {
          checks.kv = result;
          if (result.status === 'error') allHealthy = false;
        })
      );
    }

    if (options.checkKeyManager && (env.KEY_MANAGER_PUBLIC || env.KEY_MANAGER)) {
      checkPromises.push(
        checkKeyManager(env, getTenantIdFromContext(c)).then((result) => {
          checks.keyManager = result;
          if (result.status === 'error') allHealthy = false;
        })
      );
    }

    await Promise.all(checkPromises);

    const result: ReadinessCheckResult = {
      status: allHealthy ? 'ready' : 'not_ready',
      checks,
      timestamp: new Date().toISOString(),
    };

    // Return 503 if not ready
    return c.json(result, allHealthy ? 200 : 503);
  };
}

/**
 * Create all health check handlers for a service
 */
export function createHealthCheckHandlers(options: HealthCheckOptions) {
  return {
    liveness: createLivenessHandler(),
    readiness: createReadinessHandler(options),
  };
}
