import {
  fetchJsonWithTimeout,
  isRecord,
  resolveGeneratedSmokeTarget,
  type GeneratedSmokeOptions,
} from './generated-smoke-common.js';
import { runGeneratedApprovalsSmoke } from './generated-approvals-smoke.js';
import {
  createGeneratedApprovalLoadContext,
  type GeneratedApprovalLoadContext,
} from './generated-approval-load-context.js';

const ELEVATION_GRANT_SUBJECT_TOKEN_TYPE = 'urn:authrim:token-type:elevation-grant';

export interface GeneratedLoadAbuseOptions extends GeneratedSmokeOptions {
  adminSecret?: string;
  adminSecretPath?: string;
  clientId?: string;
  clientSecret?: string;
  profile?: 'safe' | 'medium';
  timeoutMs?: number;
  subjectTokenExpiresIn?: number;
}

export interface LoadLatencySummary {
  min: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface GeneratedLoadStageResult {
  id: string;
  title: string;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  elapsedMs: number;
  latencyMs: LoadLatencySummary;
  statusCounts: Record<string, number>;
  failureSamples: string[];
  maxRetryAfterSeconds: number;
}

export interface GeneratedLoadAbuseResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  configPath: string;
  profile: 'safe' | 'medium';
  bootstrapChecks: string[];
  stages: GeneratedLoadStageResult[];
  cleanupNotes: string[];
  interStageCooldownsMs: number[];
}

interface IntrospectionValidationSnapshot {
  value: boolean;
  source: string;
}

interface StageRequestResult {
  ok: boolean;
  status: number;
  failureSample?: string;
  retryAfterSeconds?: number;
}

interface StageDefinition {
  id: string;
  title: string;
  concurrency: number;
  iterationsPerWorker: number;
  request: () => Promise<StageRequestResult>;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1)
  );
  return sortedValues[index] ?? 0;
}

export function summarizeLatency(values: number[]): LoadLatencySummary {
  if (values.length === 0) {
    return { min: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0] ?? 0,
    avg: total / values.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export async function runConcurrentStage(stage: StageDefinition): Promise<GeneratedLoadStageResult> {
  const durations: number[] = [];
  const statusCounts = new Map<number, number>();
  const failureSamples: string[] = [];
  let successCount = 0;
  let failureCount = 0;
  let maxRetryAfterSeconds = 0;
  const startedAt = Date.now();

  const workers = Array.from({ length: stage.concurrency }, async () => {
    for (let index = 0; index < stage.iterationsPerWorker; index += 1) {
      const requestStartedAt = Date.now();
      try {
        const result = await stage.request();
        const durationMs = Date.now() - requestStartedAt;
        durations.push(durationMs);
        statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
        if (result.ok) {
          successCount += 1;
        } else {
          failureCount += 1;
          if (result.failureSample && failureSamples.length < 10) {
            failureSamples.push(result.failureSample);
          }
        }
        if ((result.retryAfterSeconds ?? 0) > maxRetryAfterSeconds) {
          maxRetryAfterSeconds = result.retryAfterSeconds ?? 0;
        }
      } catch (error) {
        const durationMs = Date.now() - requestStartedAt;
        durations.push(durationMs);
        failureCount += 1;
        statusCounts.set(0, (statusCounts.get(0) ?? 0) + 1);
        if (failureSamples.length < 10) {
          failureSamples.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  });

  await Promise.all(workers);
  const totalRequests = successCount + failureCount;
  return {
    id: stage.id,
    title: stage.title,
    totalRequests,
    successCount,
    failureCount,
    successRate: totalRequests > 0 ? successCount / totalRequests : 0,
    elapsedMs: Date.now() - startedAt,
    latencyMs: summarizeLatency(durations),
    statusCounts: Object.fromEntries(
      [...statusCounts.entries()].map(([status, count]) => [String(status), count])
    ),
    failureSamples,
    maxRetryAfterSeconds,
  };
}

function extractRetryAfterSeconds(payload: unknown): number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return typeof payload.retry_after === 'number' && payload.retry_after > 0
    ? payload.retry_after
    : undefined;
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function getIntrospectionValidationSnapshot(input: {
  baseUrl: string;
  adminSecret: string;
  tenantId: string;
}): Promise<IntrospectionValidationSnapshot> {
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/settings/introspection-validation`,
    10_000,
    {
      headers: {
        authorization: `Bearer ${input.adminSecret}`,
        accept: 'application/json',
        'X-Tenant-Id': input.tenantId,
      },
    }
  );
  if (!response.ok || !isRecord(response.payload)) {
    throw new Error(
      `load_introspection_validation_get_failed:${response.status}:${response.error ?? response.bodyText ?? ''}`
    );
  }
  const settings = isRecord(response.payload.settings) ? response.payload.settings : null;
  const strictValidation = settings && isRecord(settings.strictValidation) ? settings.strictValidation : null;
  return {
    value: strictValidation?.value === true,
    source: typeof strictValidation?.source === 'string' ? strictValidation.source : 'unknown',
  };
}

async function putIntrospectionValidation(input: {
  baseUrl: string;
  adminSecret: string;
  tenantId: string;
  value: boolean;
}): Promise<void> {
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/settings/introspection-validation`,
    10_000,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${input.adminSecret}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'X-Tenant-Id': input.tenantId,
      },
      body: JSON.stringify({ strictValidation: input.value }),
    }
  );
  if (!response.ok) {
    throw new Error(
      `load_introspection_validation_put_failed:${response.status}:${response.error ?? response.bodyText ?? ''}`
    );
  }
}

function getProfileStages(context: GeneratedApprovalLoadContext, profile: 'safe' | 'medium'): StageDefinition[] {
  const baseUrl = context.baseUrl;
  const adminHeaders = {
    authorization: `Bearer ${context.adminSecret}`,
    accept: 'application/json',
    'X-Tenant-Id': context.tenantId,
  };
  const basicAuthHeader = `Basic ${encodeBasicAuth(context.clientId, context.clientSecret)}`;
  const stageConfig =
    profile === 'medium'
      ? {
          registration: { concurrency: 25, iterations: 40 },
          runtimeProfiles: { concurrency: 10, iterations: 30 },
          tokenExchange: { concurrency: 20, iterations: 25 },
          introspect: { concurrency: 20, iterations: 25 },
          protectedResource: { concurrency: 25, iterations: 40 },
          invalidTokenExchange: { concurrency: 20, iterations: 25 },
          unauthorizedProtectedResource: { concurrency: 25, iterations: 40 },
          approvalFlow: { concurrency: 3, iterations: 2 },
        }
      : {
          registration: { concurrency: 5, iterations: 10 },
          runtimeProfiles: { concurrency: 3, iterations: 10 },
          tokenExchange: { concurrency: 1, iterations: 4 },
          introspect: { concurrency: 1, iterations: 4 },
          protectedResource: { concurrency: 3, iterations: 10 },
          invalidTokenExchange: { concurrency: 1, iterations: 4 },
          unauthorizedProtectedResource: { concurrency: 3, iterations: 10 },
          approvalFlow: { concurrency: 1, iterations: 1 },
        };

  return [
    {
      id: 'registration-fields-read',
      title: 'Registration fields read load',
      concurrency: stageConfig.registration.concurrency,
      iterationsPerWorker: stageConfig.registration.iterations,
      request: async () => {
        const response = await fetchJsonWithTimeout(
          `${baseUrl}/api/v1/registration-fields`,
          10_000,
          { headers: { accept: 'application/json' } }
        );
        return {
          ok: response.ok && response.status === 200,
          status: response.status,
          retryAfterSeconds: extractRetryAfterSeconds(response.payload),
          failureSample: response.ok
            ? undefined
            : `${response.status} ${response.error ?? response.bodyText ?? ''}`,
        };
      },
    },
    {
      id: 'runtime-profile-list-read',
      title: 'Runtime profile list concurrency',
      concurrency: stageConfig.runtimeProfiles.concurrency,
      iterationsPerWorker: stageConfig.runtimeProfiles.iterations,
      request: async () => {
        const response = await fetchJsonWithTimeout(
          `${baseUrl}/api/admin/runtime-profiles?kind=audit`,
          10_000,
          { headers: adminHeaders }
        );
        return {
          ok: response.ok && response.status === 200,
          status: response.status,
          retryAfterSeconds: extractRetryAfterSeconds(response.payload),
          failureSample: response.ok
            ? undefined
            : `${response.status} ${response.error ?? response.bodyText ?? ''}`,
        };
      },
    },
    {
      id: 'approval-flow-concurrency',
      title: 'Approval flow concurrency',
      concurrency: stageConfig.approvalFlow.concurrency,
      iterationsPerWorker: stageConfig.approvalFlow.iterations,
      request: async () => {
        const result = await runGeneratedApprovalsSmoke({
          baseDir: undefined,
          env: context.env,
          configPath: context.configPath,
          timeoutMs: 10_000,
          adminSecret: context.adminSecret,
          clientId: context.clientId,
          clientSecret: context.clientSecret,
          subjectTokenExpiresIn: 180,
        });
        return {
          ok: result.ok,
          status: result.ok ? 200 : 500,
          failureSample: result.ok
            ? undefined
            : result.checks
                .filter((check) => check.status === 'fail')
                .map((check) => `${check.id}: ${check.details.join(' | ')}`)
                .slice(0, 1)[0],
        };
      },
    },
    {
      id: 'token-exchange-load',
      title: 'Token exchange load',
      concurrency: stageConfig.tokenExchange.concurrency,
      iterationsPerWorker: stageConfig.tokenExchange.iterations,
      request: async () => {
        const response = await fetchJsonWithTimeout(`${baseUrl}/token`, 10_000, {
          method: 'POST',
          headers: {
            authorization: basicAuthHeader,
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: context.subjectToken,
            subject_token_type: ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            audience: 'svc://op-userinfo/customer-profile',
          }).toString(),
        });
        const hasToken = isRecord(response.payload) && typeof response.payload.access_token === 'string';
        return {
          ok: response.ok && response.status === 200 && hasToken,
          status: response.status,
          retryAfterSeconds: extractRetryAfterSeconds(response.payload),
          failureSample: response.ok && hasToken
            ? undefined
            : `${response.status} ${response.error ?? response.bodyText ?? ''}`,
        };
      },
    },
    {
      id: 'introspection-load',
      title: 'Introspection load',
      concurrency: stageConfig.introspect.concurrency,
      iterationsPerWorker: stageConfig.introspect.iterations,
      request: async () => {
        const response = await fetchJsonWithTimeout(`${baseUrl}/introspect`, 10_000, {
          method: 'POST',
          headers: {
            authorization: basicAuthHeader,
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            token: context.downstreamAccessToken,
            token_type_hint: 'access_token',
          }).toString(),
        });
        const active = isRecord(response.payload) && response.payload.active === true;
        return {
          ok: response.ok && response.status === 200 && active,
          status: response.status,
          retryAfterSeconds: extractRetryAfterSeconds(response.payload),
          failureSample: response.ok && active
            ? undefined
            : `${response.status} ${response.error ?? response.bodyText ?? ''}`,
        };
      },
    },
    {
      id: 'protected-resource-load',
      title: 'Protected resource load',
      concurrency: stageConfig.protectedResource.concurrency,
      iterationsPerWorker: stageConfig.protectedResource.iterations,
      request: async () => {
        const response = await fetchJsonWithTimeout(
          `${baseUrl}${context.protectedResourcePath}`,
          10_000,
          {
            headers: {
              authorization: `Bearer ${context.downstreamAccessToken}`,
              accept: 'application/json',
            },
          }
        );
        const payload = isRecord(response.payload) ? response.payload : null;
        const profileValue = payload?.profile;
        const profileData = isRecord(profileValue) ? profileValue : null;
        return {
          ok:
            response.ok &&
            response.status === 200 &&
            profileData?.sub === context.userId,
          status: response.status,
          retryAfterSeconds: extractRetryAfterSeconds(response.payload),
          failureSample:
            response.ok && profileData?.sub === context.userId
              ? undefined
              : `${response.status} ${response.error ?? response.bodyText ?? ''}`,
        };
      },
    },
    {
      id: 'abuse-invalid-token-exchange',
      title: 'Abuse invalid token exchange burst',
      concurrency: stageConfig.invalidTokenExchange.concurrency,
      iterationsPerWorker: stageConfig.invalidTokenExchange.iterations,
      request: async () => {
        const response = await fetchJsonWithTimeout(`${baseUrl}/token`, 10_000, {
          method: 'POST',
          headers: {
            authorization: basicAuthHeader,
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            subject_token: `${context.subjectToken}.tampered`,
            subject_token_type: ELEVATION_GRANT_SUBJECT_TOKEN_TYPE,
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            audience: 'svc://op-userinfo/customer-profile',
          }).toString(),
        });
        const ok = [400, 401, 403].includes(response.status);
        const protectedOk = ok || response.status === 429;
        return {
          ok: protectedOk,
          status: response.status,
          retryAfterSeconds: extractRetryAfterSeconds(response.payload),
          failureSample: protectedOk
            ? undefined
            : `${response.status} ${response.error ?? response.bodyText ?? ''}`,
        };
      },
    },
    {
      id: 'abuse-unauthorized-protected-resource',
      title: 'Abuse unauthorized protected resource burst',
      concurrency: stageConfig.unauthorizedProtectedResource.concurrency,
      iterationsPerWorker: stageConfig.unauthorizedProtectedResource.iterations,
      request: async () => {
        const response = await fetchJsonWithTimeout(
          `${baseUrl}${context.protectedResourcePath}`,
          10_000,
          {
            headers: {
              authorization: 'Bearer invalid-token',
              accept: 'application/json',
            },
          }
        );
        const ok = [401, 403, 429].includes(response.status);
        return {
          ok,
          status: response.status,
          retryAfterSeconds: extractRetryAfterSeconds(response.payload),
          failureSample: ok ? undefined : `${response.status} ${response.error ?? response.bodyText ?? ''}`,
        };
      },
    },
  ];
}

export async function runGeneratedLoadAbuse(
  options: GeneratedLoadAbuseOptions
): Promise<GeneratedLoadAbuseResult> {
  const target = await resolveGeneratedSmokeTarget(options);
  const profile = options.profile ?? 'safe';
  const context = await createGeneratedApprovalLoadContext(options);
  const bootstrapChecks = context.checks.flatMap((check) => check.details.map((detail) => `${check.id}: ${detail}`));
  const cleanupNotes: string[] = [];
  const interStageCooldownsMs: number[] = [];
  let restoreStrictValidation = false;

  try {
    const introspectionValidation = await getIntrospectionValidationSnapshot({
      baseUrl: context.baseUrl,
      adminSecret: context.adminSecret,
      tenantId: context.tenantId,
    });
    if (introspectionValidation.value) {
      await putIntrospectionValidation({
        baseUrl: context.baseUrl,
        adminSecret: context.adminSecret,
        tenantId: context.tenantId,
        value: false,
      });
      restoreStrictValidation = true;
    }
    const stages: GeneratedLoadStageResult[] = [];
    for (const stage of getProfileStages(context, profile)) {
      const result = await runConcurrentStage(stage);
      stages.push(result);
      if (result.maxRetryAfterSeconds > 0) {
        const cooldownMs = result.maxRetryAfterSeconds * 1000 + 1000;
        interStageCooldownsMs.push(cooldownMs);
        await new Promise((resolve) => setTimeout(resolve, cooldownMs));
      }
    }
    return {
      ok: stages.every((stage) => stage.failureCount === 0),
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      profile,
      bootstrapChecks,
      stages,
      cleanupNotes,
      interStageCooldownsMs,
    };
  } finally {
    if (restoreStrictValidation) {
      await putIntrospectionValidation({
        baseUrl: context.baseUrl,
        adminSecret: context.adminSecret,
        tenantId: context.tenantId,
        value: true,
      }).catch((error) => {
        cleanupNotes.push(
          `introspection-validation-restore: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }
    const cleanupChecks = await context.cleanup();
    cleanupNotes.push(
      ...cleanupChecks.flatMap((check) => check.details.map((detail) => `${check.id}: ${detail}`))
    );
  }
}
