import type { Env } from '@authrim/ar-lib-core';
import {
  configureDynamicPluginWithControl,
  DynamicPluginResourcesPendingError,
} from './plugin-dynamic-worker-control';

const PREFIX = 'plugins:dynamic-resource-finalization:';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_ERROR_CODE = /^(?:control_plugin|dynamic_plugin|plugin_resource)_[a-z0-9_]+$/u;

interface PluginResourceFinalizationJob {
  schemaVersion: 1;
  operationId: string;
  tenantId: string;
  pluginId: string;
  createdAt: number;
  attemptCount: number;
  lastErrorCode: string | null;
}

function key(operationId: string): string {
  if (!SAFE_ID.test(operationId)) throw new Error('plugin_resource_finalization_operation_invalid');
  return `${PREFIX}${operationId}`;
}

function parseJob(value: string): PluginResourceFinalizationJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('plugin_resource_finalization_job_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('plugin_resource_finalization_job_invalid');
  }
  const job = parsed as Record<string, unknown>;
  if (
    Object.keys(job).sort().join(',') !==
      'attemptCount,createdAt,lastErrorCode,operationId,pluginId,schemaVersion,tenantId' ||
    job.schemaVersion !== 1 ||
    typeof job.operationId !== 'string' ||
    !SAFE_ID.test(job.operationId) ||
    typeof job.tenantId !== 'string' ||
    !SAFE_ID.test(job.tenantId) ||
    typeof job.pluginId !== 'string' ||
    !SAFE_ID.test(job.pluginId) ||
    !Number.isSafeInteger(job.createdAt) ||
    (job.createdAt as number) < 1 ||
    !Number.isSafeInteger(job.attemptCount) ||
    (job.attemptCount as number) < 0 ||
    (job.lastErrorCode !== null &&
      (typeof job.lastErrorCode !== 'string' || !SAFE_ID.test(job.lastErrorCode)))
  ) {
    throw new Error('plugin_resource_finalization_job_invalid');
  }
  return job as unknown as PluginResourceFinalizationJob;
}

export async function enqueueDynamicPluginResourceFinalization(
  kv: KVNamespace,
  input: { operationId: string; tenantId: string; pluginId: string },
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  if (
    !SAFE_ID.test(input.tenantId) ||
    !SAFE_ID.test(input.pluginId) ||
    !Number.isSafeInteger(now)
  ) {
    throw new Error('plugin_resource_finalization_input_invalid');
  }
  const job: PluginResourceFinalizationJob = {
    schemaVersion: 1,
    operationId: input.operationId,
    tenantId: input.tenantId,
    pluginId: input.pluginId,
    createdAt: now,
    attemptCount: 0,
    lastErrorCode: null,
  };
  await kv.put(key(input.operationId), JSON.stringify(job));
}

export async function cancelDynamicPluginResourceFinalization(
  kv: KVNamespace,
  input: { operationId: string; tenantId: string; pluginId: string }
): Promise<void> {
  if (!SAFE_ID.test(input.tenantId) || !SAFE_ID.test(input.pluginId)) {
    throw new Error('plugin_resource_finalization_input_invalid');
  }
  const jobKey = key(input.operationId);
  const serialized = await kv.get(jobKey);
  if (serialized === null) return;
  const job = parseJob(serialized);
  if (
    job.operationId !== input.operationId ||
    job.tenantId !== input.tenantId ||
    job.pluginId !== input.pluginId
  ) {
    throw new Error('plugin_resource_finalization_cancel_mismatch');
  }
  await kv.delete(jobKey);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return SAFE_ERROR_CODE.test(message) ? message : 'plugin_resource_finalization_failed';
}

export async function processDynamicPluginResourceFinalizations(
  env: Env,
  limit = 10
): Promise<{ inspected: number; finalized: number; pending: number; failed: number }> {
  const kv = env.SETTINGS;
  const control = env.CONTROL;
  const boundedLimit = Math.max(1, Math.min(25, Math.floor(limit)));
  if (!kv || !control?.getPluginDynamicWorkerResourcePreparation || !env.PLUGIN_RUNNER) {
    return { inspected: 0, finalized: 0, pending: 0, failed: 0 };
  }
  const listed = await kv.list({ prefix: PREFIX, limit: boundedLimit });
  const result = { inspected: 0, finalized: 0, pending: 0, failed: 0 };
  for (const item of listed.keys) {
    result.inspected += 1;
    const serialized = await kv.get(item.name);
    if (serialized === null) continue;
    let job: PluginResourceFinalizationJob | null = null;
    try {
      job = parseJob(serialized);
      if (item.name !== key(job.operationId)) {
        throw new Error('plugin_resource_finalization_key_mismatch');
      }
      const preparation = await control.getPluginDynamicWorkerResourcePreparation({
        tenantId: job.tenantId,
        pluginId: job.pluginId,
        enabled: true,
      });
      if (!preparation || preparation.operationId !== job.operationId) {
        throw new Error('plugin_resource_finalization_operation_mismatch');
      }
      if (preparation.readiness !== 'ready') {
        result.pending += 1;
        continue;
      }
      await configureDynamicPluginWithControl(env, {
        tenantId: job.tenantId,
        pluginId: job.pluginId,
        enabled: true,
        activationRequestId: job.operationId,
      });
      await kv.delete(item.name);
      result.finalized += 1;
    } catch (error) {
      if (error instanceof DynamicPluginResourcesPendingError) {
        result.pending += 1;
        continue;
      }
      result.failed += 1;
      if (job) {
        await kv.put(
          item.name,
          JSON.stringify({
            ...job,
            attemptCount: job.attemptCount + 1,
            lastErrorCode: errorCode(error),
          } satisfies PluginResourceFinalizationJob)
        );
      }
    }
  }
  return result;
}
