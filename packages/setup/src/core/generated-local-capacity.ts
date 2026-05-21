import {
  fetchJsonWithTimeout,
  isRecord,
  resolveGeneratedSmokeTarget,
  type GeneratedSmokeOptions,
} from './generated-smoke-common.js';
import {
  createGeneratedApprovalLoadContext,
  type GeneratedApprovalLoadContext,
} from './generated-approval-load-context.js';
import { summarizeLatency, type LoadLatencySummary } from './generated-load-abuse.js';

const ELEVATION_GRANT_SUBJECT_TOKEN_TYPE = 'urn:authrim:token-type:elevation-grant';

export type GeneratedLocalCapacityScenario =
  | 'registration-fields'
  | 'protected-resource'
  | 'token-exchange'
  | 'introspection'
  | 'mixed';

export interface GeneratedLocalCapacityOptions extends GeneratedSmokeOptions {
  adminSecret?: string;
  adminSecretPath?: string;
  clientId?: string;
  clientSecret?: string;
  subjectTokenExpiresIn?: number;
  timeoutMs?: number;
  scenario?: GeneratedLocalCapacityScenario;
  lps?: number;
  durationSeconds?: number;
  maxInFlight?: number;
}

export interface GeneratedLocalCapacityResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  configPath: string;
  scenario: GeneratedLocalCapacityScenario;
  requestedLps: number;
  achievedLps: number;
  durationSeconds: number;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  elapsedMs: number;
  latencyMs: LoadLatencySummary;
  statusCounts: Record<string, number>;
  failureSamples: string[];
  bootstrapChecks: string[];
  cleanupNotes: string[];
  localCapacityNotes: string[];
}

interface RequestResult {
  ok: boolean;
  status: number;
  failureSample?: string;
}

interface LocalCapacityPlan {
  scenario: GeneratedLocalCapacityScenario;
  lps: number;
  durationSeconds: number;
  maxInFlight: number;
}

const SCENARIOS: readonly GeneratedLocalCapacityScenario[] = [
  'registration-fields',
  'protected-resource',
  'token-exchange',
  'introspection',
  'mixed',
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeBasicAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function extractError(response: { status: number; error?: string; bodyText?: string }): string {
  return `${response.status} ${response.error ?? response.bodyText ?? ''}`.trim();
}

export function resolveGeneratedLocalCapacityPlan(
  options: GeneratedLocalCapacityOptions
): LocalCapacityPlan {
  const scenario = options.scenario ?? 'mixed';
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`invalid_local_capacity_scenario:${scenario}`);
  }

  const lps = options.lps ?? 25;
  if (!Number.isFinite(lps) || lps <= 0 || lps > 500) {
    throw new Error('invalid_local_capacity_lps');
  }

  const durationSeconds = options.durationSeconds ?? 30;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300) {
    throw new Error('invalid_local_capacity_duration');
  }

  const maxInFlight = options.maxInFlight ?? Math.max(50, Math.ceil(lps * 4));
  if (!Number.isFinite(maxInFlight) || maxInFlight <= 0 || maxInFlight > 2000) {
    throw new Error('invalid_local_capacity_max_in_flight');
  }

  return {
    scenario,
    lps,
    durationSeconds,
    maxInFlight,
  };
}

function createRequestFactory(input: {
  context: GeneratedApprovalLoadContext;
  scenario: GeneratedLocalCapacityScenario;
  timeoutMs: number;
}): (index: number) => Promise<RequestResult> {
  const { context, timeoutMs } = input;
  const basicAuthHeader = `Basic ${encodeBasicAuth(context.clientId, context.clientSecret)}`;

  const requests: Record<
    Exclude<GeneratedLocalCapacityScenario, 'mixed'>,
    () => Promise<RequestResult>
  > = {
    'registration-fields': async () => {
      const response = await fetchJsonWithTimeout(
        `${context.baseUrl}/api/v1/registration-fields`,
        timeoutMs,
        { headers: { accept: 'application/json' } }
      );
      return {
        ok: response.ok && response.status === 200,
        status: response.status,
        failureSample: response.ok ? undefined : extractError(response),
      };
    },
    'protected-resource': async () => {
      const response = await fetchJsonWithTimeout(
        `${context.baseUrl}${context.protectedResourcePath}`,
        timeoutMs,
        {
          headers: {
            authorization: `Bearer ${context.downstreamAccessToken}`,
            accept: 'application/json',
          },
        }
      );
      const payload = isRecord(response.payload) ? response.payload : null;
      const profile = isRecord(payload?.profile) ? payload.profile : null;
      return {
        ok: response.ok && response.status === 200 && profile?.sub === context.userId,
        status: response.status,
        failureSample:
          response.ok && profile?.sub === context.userId ? undefined : extractError(response),
      };
    },
    'token-exchange': async () => {
      const response = await fetchJsonWithTimeout(`${context.baseUrl}/token`, timeoutMs, {
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
      const hasToken =
        isRecord(response.payload) && typeof response.payload.access_token === 'string';
      return {
        ok: response.ok && response.status === 200 && hasToken,
        status: response.status,
        failureSample: response.ok && hasToken ? undefined : extractError(response),
      };
    },
    introspection: async () => {
      const response = await fetchJsonWithTimeout(`${context.baseUrl}/introspect`, timeoutMs, {
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
        failureSample: response.ok && active ? undefined : extractError(response),
      };
    },
  };

  if (input.scenario !== 'mixed') {
    const scenario = input.scenario as Exclude<GeneratedLocalCapacityScenario, 'mixed'>;
    return () => requests[scenario]();
  }

  const mixedOrder: readonly Exclude<GeneratedLocalCapacityScenario, 'mixed'>[] = [
    'protected-resource',
    'token-exchange',
    'introspection',
    'registration-fields',
  ];
  return (index) => requests[mixedOrder[index % mixedOrder.length]]();
}

function createRegistrationFieldsRequest(input: {
  baseUrl: string;
  timeoutMs: number;
}): () => Promise<RequestResult> {
  return async () => {
    const response = await fetchJsonWithTimeout(
      `${input.baseUrl}/api/v1/registration-fields`,
      input.timeoutMs,
      { headers: { accept: 'application/json' } }
    );
    return {
      ok: response.ok && response.status === 200,
      status: response.status,
      failureSample: response.ok ? undefined : extractError(response),
    };
  };
}

async function runFixedRate(input: {
  plan: LocalCapacityPlan;
  request: (index: number) => Promise<RequestResult>;
}): Promise<{
  elapsedMs: number;
  durations: number[];
  successCount: number;
  failureCount: number;
  statusCounts: Record<string, number>;
  failureSamples: string[];
}> {
  const totalRequests = Math.ceil(input.plan.lps * input.plan.durationSeconds);
  const intervalMs = 1000 / input.plan.lps;
  const durations: number[] = [];
  const statusCounts = new Map<number, number>();
  const failureSamples: string[] = [];
  let successCount = 0;
  let failureCount = 0;
  const inFlight = new Set<Promise<void>>();
  const startedAt = Date.now();

  async function launch(index: number): Promise<void> {
    const requestStartedAt = Date.now();
    try {
      const result = await input.request(index);
      durations.push(Date.now() - requestStartedAt);
      statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
      if (result.ok) {
        successCount += 1;
      } else {
        failureCount += 1;
        if (result.failureSample && failureSamples.length < 10) {
          failureSamples.push(result.failureSample);
        }
      }
    } catch (error) {
      durations.push(Date.now() - requestStartedAt);
      statusCounts.set(0, (statusCounts.get(0) ?? 0) + 1);
      failureCount += 1;
      if (failureSamples.length < 10) {
        failureSamples.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  for (let index = 0; index < totalRequests; index += 1) {
    const scheduledAt = startedAt + Math.floor(index * intervalMs);
    const waitMs = scheduledAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    while (inFlight.size >= input.plan.maxInFlight) {
      await Promise.race(inFlight);
    }

    const promise = launch(index);
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  }

  await Promise.all(inFlight);

  return {
    elapsedMs: Date.now() - startedAt,
    durations,
    successCount,
    failureCount,
    statusCounts: Object.fromEntries(
      [...statusCounts.entries()].map(([status, count]) => [String(status), count])
    ),
    failureSamples,
  };
}

export async function runGeneratedLocalCapacity(
  options: GeneratedLocalCapacityOptions
): Promise<GeneratedLocalCapacityResult> {
  const plan = resolveGeneratedLocalCapacityPlan(options);
  const target = await resolveGeneratedSmokeTarget(options);
  const context =
    plan.scenario === 'registration-fields'
      ? null
      : await createGeneratedApprovalLoadContext(options);
  const cleanupNotes: string[] = [];

  try {
    const request = context
      ? createRequestFactory({
          context,
          scenario: plan.scenario,
          timeoutMs: options.timeoutMs ?? 10_000,
        })
      : createRegistrationFieldsRequest({
          baseUrl: target.baseUrl,
          timeoutMs: options.timeoutMs ?? 10_000,
        });
    const run = await runFixedRate({ plan, request });
    const totalRequests = run.successCount + run.failureCount;
    const achievedLps = totalRequests > 0 ? totalRequests / (run.elapsedMs / 1000) : 0;
    const latencyMs = summarizeLatency(run.durations);
    const localCapacityNotes = [
      'This is a local open-loop generator. It validates one Mac plus one target environment, not distributed Cloudflare edge capacity.',
      'If the target is local Wrangler/Miniflare on the same Mac, results include local runtime and SQLite/D1 emulation overhead.',
      'Use Cloudflare analytics or service logs to attribute server-side D1, Durable Object, and Worker latency.',
    ];

    return {
      ok: run.failureCount === 0,
      env: target.env,
      baseUrl: target.baseUrl,
      configPath: target.configPath,
      scenario: plan.scenario,
      requestedLps: plan.lps,
      achievedLps,
      durationSeconds: plan.durationSeconds,
      totalRequests,
      successCount: run.successCount,
      failureCount: run.failureCount,
      successRate: totalRequests > 0 ? run.successCount / totalRequests : 0,
      elapsedMs: run.elapsedMs,
      latencyMs,
      statusCounts: run.statusCounts,
      failureSamples: run.failureSamples,
      bootstrapChecks: context
        ? context.checks.flatMap((check) => check.details.map((detail) => `${check.id}: ${detail}`))
        : [],
      cleanupNotes,
      localCapacityNotes,
    };
  } finally {
    if (context) {
      const cleanupChecks = await context.cleanup();
      cleanupNotes.push(
        ...cleanupChecks.flatMap((check) => check.details.map((detail) => `${check.id}: ${detail}`))
      );
    }
  }
}
