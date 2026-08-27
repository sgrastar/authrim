#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CloudflareControlApiClient } from '../../packages/ar-lib-core/src/services/control-plane/index.js';
import {
  PHASE1_SCHEMA_VERSION,
  assertPhase1EvidenceIsSecretFree,
  deriveLogicalAccountIdentity,
  parsePhase1HarnessConfig,
  redactPhase1Config,
  resolvePhase1Secret,
  sha256,
  stableJson,
  type LogicalAccountIdentity,
  type Phase1Baseline,
  type Phase1ControlSnapshot,
  type Phase1HarnessConfig,
  type Phase1RequestEvent,
} from './schemas.js';
import {
  collectControlSnapshot,
  collectProviderSnapshot,
  observePhase1,
  type Phase1ObservationClient,
} from './observe.js';
import { evaluatePhase1Preflight } from './preflight.js';
import {
  verifyPhase1Run,
  waitForPhase1Quiescence,
  collectLookupBucketSnapshot,
  type Phase1VerificationClient,
} from './verify.js';
import { buildPhase1Report, buildPhase1TimelineSvg } from './report.js';
import { createPhase1AdminTokenProvider } from './admin-token.js';

const DEFAULT_RUNS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), 'runs');
const CAPACITY_ERROR = 'temporarily_unavailable';

export interface Phase1AccountResult {
  accountIndex: number;
  emailDigest: string;
  requestDigest: string;
  userId: string | null;
  operationId: string | null;
  firstResponseStatus: number | null;
  attempts: number;
  retries: number;
  capacity503: number;
  terminalErrorCode: string | null;
  completedAt: string | null;
}

export interface Phase1RunnerResult {
  startedAt: string;
  finishedAt: string;
  accounts: Phase1AccountResult[];
  metrics: {
    scheduled: number;
    attempts: number;
    accepted201: number;
    accepted202: number;
    capacity503: number;
    server5xx: number;
    retries: number;
    terminalFailures: number;
  };
}

interface QueueItem {
  identity: LogicalAccountIdentity;
  dueAt: number;
  firstAttemptAt: number | null;
  attempt: number;
  retries: number;
  capacity503: number;
  pollCount: number;
  firstResponseStatus: number | null;
  mode: 'create' | 'poll';
  operationId: string | null;
  statusPath: string | null;
}

interface AttemptOutcome {
  kind: 'success' | 'retry' | 'terminal';
  userId?: string;
  operationId?: string;
  statusPath?: string;
  status?: number;
  retryAfterMs?: number;
  errorCode?: string;
  accepted202?: boolean;
}

export interface Phase1RunnerDependencies {
  fetcher?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  writeEvent: (event: Phase1RequestEvent) => Promise<void>;
  writeCheckpoint?: (result: Phase1AccountResult) => Promise<void>;
}

class MinQueue {
  private readonly values: QueueItem[] = [];

  get size(): number {
    return this.values.length;
  }

  peek(): QueueItem | undefined {
    return this.values[0];
  }

  push(value: QueueItem): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent], value) <= 0) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): QueueItem | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const smaller =
        right < this.values.length && this.compare(this.values[right], this.values[left]) < 0
          ? right
          : left;
      if (this.compare(last, this.values[smaller]) <= 0) break;
      this.values[index] = this.values[smaller];
      index = smaller;
    }
    this.values[index] = last;
    return first;
  }

  shiftDueAt(offsetMs: number): void {
    for (const value of this.values) value.dueAt += offsetMs;
  }

  private compare(left: QueueItem, right: QueueItem): number {
    return left.dueAt - right.dueAt || left.identity.accountIndex - right.identity.accountIndex;
  }
}

export class JsonlWriter {
  private readonly buffer: string[] = [];
  private pending = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly flushSize = 256
  ) {}

  async write(value: unknown): Promise<void> {
    assertPhase1EvidenceIsSecretFree(value);
    this.buffer.push(`${stableJson(value)}\n`);
    if (this.buffer.length >= this.flushSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return this.pending;
    const chunk = this.buffer.splice(0).join('');
    this.pending = this.pending.then(async () => {
      const handle = await open(this.path, 'a', 0o600);
      try {
        await handle.writeFile(chunk);
      } finally {
        await handle.close();
      }
    });
    return this.pending;
  }
}

async function readJsonlEvidence(path: string): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(path, 'utf8');
  return source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('phase1_evidence_jsonl_invalid');
      }
      return value as Record<string, unknown>;
    });
}

interface Phase1RunnerCheckpoint {
  schemaVersion: 1;
  runId: string;
  updatedAt: string;
  accounts: Phase1AccountResult[];
}

class RunnerCheckpointWriter {
  private readonly accounts = new Map<number, Phase1AccountResult>();
  private pending = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly runId: string,
    initial: Phase1AccountResult[] = []
  ) {
    for (const result of initial) this.accounts.set(result.accountIndex, result);
  }

  values(): Phase1AccountResult[] {
    return [...this.accounts.values()].sort(
      (left, right) => left.accountIndex - right.accountIndex
    );
  }

  record(result: Phase1AccountResult): Promise<void> {
    this.accounts.set(result.accountIndex, result);
    return this.flush();
  }

  flush(): Promise<void> {
    const checkpoint: Phase1RunnerCheckpoint = {
      schemaVersion: PHASE1_SCHEMA_VERSION,
      runId: this.runId,
      updatedAt: new Date().toISOString(),
      accounts: this.values(),
    };
    assertPhase1EvidenceIsSecretFree(checkpoint);
    const temporaryPath = `${this.path}.tmp`;
    this.pending = this.pending.then(async () => {
      await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.path);
    });
    return this.pending;
  }
}

function runnerFromEvidence(input: {
  config: Phase1HarnessConfig;
  accounts: Phase1AccountResult[];
  events: Array<Record<string, unknown>>;
}): Phase1RunnerResult {
  const eventEpochs = input.events.flatMap((event) => {
    const epoch = typeof event.at === 'string' ? Date.parse(event.at) : Number.NaN;
    return Number.isFinite(epoch) ? [epoch] : [];
  });
  const completedEpochs = input.accounts.flatMap((account) => {
    const epoch = account.completedAt ? Date.parse(account.completedAt) : Number.NaN;
    return Number.isFinite(epoch) ? [epoch] : [];
  });
  const uniqueAccepted202 = new Set(
    input.events
      .filter((event) => event.kind === 'accepted_202' && Number.isSafeInteger(event.accountIndex))
      .map((event) => Number(event.accountIndex))
  );
  return {
    startedAt: new Date(Math.min(...eventEpochs)).toISOString(),
    finishedAt: new Date(Math.max(...completedEpochs, ...eventEpochs)).toISOString(),
    accounts: [...input.accounts].sort((left, right) => left.accountIndex - right.accountIndex),
    metrics: {
      scheduled: input.config.load.accountCount,
      attempts: input.events.filter(
        (event) => event.kind === 'attempt' || event.kind === 'operation_poll'
      ).length,
      accepted201: input.events.filter((event) => event.kind === 'accepted_201').length,
      accepted202: uniqueAccepted202.size,
      capacity503: input.events.filter((event) => event.kind === 'capacity_503').length,
      server5xx: input.events.filter((event) => event.kind === 'server_5xx').length,
      retries: input.events.filter((event) => event.kind === 'retry_scheduled').length,
      terminalFailures: input.accounts.filter((account) => account.userId === null).length,
    },
  };
}

function parseJson(payload: string): Record<string, unknown> {
  try {
    const value = payload ? (JSON.parse(payload) as unknown) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeErrorCode(payload: Record<string, unknown>, fallback: string): string {
  const value = payload.error;
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value) ? value : fallback;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('Retry-After');
  if (!header || !/^\d{1,5}$/u.test(header)) return null;
  return Math.min(Number(header) * 1_000, 60_000);
}

function safeStatusPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  if (!/^\/api\/admin\/users\/operations\/[a-zA-Z0-9._:-]+$/u.test(value)) return null;
  return value;
}

async function requestOnce(input: {
  config: Phase1HarnessConfig;
  token: string;
  item: QueueItem;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}): Promise<AttemptOutcome> {
  const body =
    input.item.mode === 'create'
      ? JSON.stringify({
          email: input.item.identity.email,
          preferred_username: `phase1-${input.item.identity.emailDigest.slice(0, 24)}`,
          email_verified: true,
          user_type: 'end_user',
        })
      : undefined;
  const path = input.item.mode === 'create' ? '/api/admin/users' : input.item.statusPath;
  if (!path) return { kind: 'terminal', errorCode: 'operation_status_path_missing' };
  let response: Response;
  try {
    response = await input.fetcher(new URL(path, input.config.environment.baseUrl), {
      method: input.item.mode === 'create' ? 'POST' : 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.token}`,
        'X-Tenant-Id': input.config.environment.tenantId,
        ...(input.item.mode === 'create'
          ? {
              'Content-Type': 'application/json',
              'Idempotency-Key': input.item.identity.idempotencyKey,
            }
          : {}),
      },
      body,
      redirect: 'error',
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(input.config.load.requestTimeoutMs)])
        : AbortSignal.timeout(input.config.load.requestTimeoutMs),
    });
  } catch {
    return { kind: 'retry', errorCode: 'transport_error' };
  }
  const payload = parseJson(await response.text());
  if (input.item.mode === 'create' && response.status === 201) {
    const user = payload.user;
    const userRecord =
      user && typeof user === 'object' && !Array.isArray(user)
        ? (user as Record<string, unknown>)
        : null;
    const userId = userRecord && typeof userRecord.id === 'string' ? userRecord.id : null;
    return userId
      ? { kind: 'success', userId, status: 201 }
      : { kind: 'terminal', status: 201, errorCode: 'created_user_id_missing' };
  }
  if (input.item.mode === 'create' && response.status === 202) {
    const statusPath = safeStatusPath(payload.status_url);
    const operationId =
      typeof payload.operation_id === 'string' &&
      /^[a-zA-Z0-9._:-]{1,128}$/u.test(payload.operation_id)
        ? payload.operation_id
        : null;
    if (!statusPath || !operationId) {
      return { kind: 'terminal', status: 202, errorCode: 'pending_operation_invalid' };
    }
    if (input.item.operationId && input.item.operationId !== operationId) {
      return { kind: 'terminal', status: 202, errorCode: 'pending_operation_idempotency_mismatch' };
    }
    return {
      kind: 'retry',
      status: 202,
      statusPath,
      operationId,
      accepted202: input.item.operationId === null,
      retryAfterMs: 250,
      errorCode: 'operation_pending',
    };
  }
  if (input.item.mode === 'create' && response.status === 503) {
    const code = safeErrorCode(payload, 'http_503');
    return code === CAPACITY_ERROR
      ? {
          kind: 'retry',
          status: 503,
          retryAfterMs: retryAfterMs(response) ?? undefined,
          errorCode: code,
        }
      : { kind: 'terminal', status: 503, errorCode: code };
  }
  if (input.item.mode === 'create' && response.status >= 500) {
    return {
      kind: 'retry',
      status: response.status,
      retryAfterMs: retryAfterMs(response) ?? undefined,
      errorCode: safeErrorCode(payload, `http_${response.status}`),
    };
  }
  if (input.item.mode === 'poll' && response.ok) {
    if (payload.state === 'succeeded' && typeof payload.user_id === 'string') {
      return { kind: 'success', userId: payload.user_id, status: response.status };
    }
    if (payload.state === 'failed' || payload.state === 'blocked' || payload.state === 'canceled') {
      return {
        kind: 'terminal',
        status: response.status,
        errorCode: `operation_${String(payload.state)}`,
      };
    }
    return {
      kind: 'retry',
      status: response.status,
      retryAfterMs: 250,
      errorCode: 'operation_pending',
    };
  }
  if (input.item.mode === 'poll' && response.status >= 500) {
    return {
      kind: 'retry',
      status: response.status,
      errorCode: `operation_http_${response.status}`,
    };
  }
  return {
    kind: 'terminal',
    status: response.status,
    errorCode: safeErrorCode(payload, `http_${response.status}`),
  };
}

function backoffMs(item: QueueItem, random: () => number): number {
  const exponent = Math.min(item.retries, 8);
  const base = Math.min(30_000, 250 * 2 ** exponent);
  return Math.round(base * (0.75 + Math.max(0, Math.min(1, random())) * 0.5));
}

export async function runAccountCreation(input: {
  config: Phase1HarnessConfig;
  runId: string;
  seed: string;
  adminToken?: string;
  getAdminToken?: () => Promise<string>;
  startIndex?: number;
  count?: number;
  accountIndices?: number[];
  dependencies: Phase1RunnerDependencies;
}): Promise<Phase1RunnerResult> {
  const nowMs = input.dependencies.nowMs ?? Date.now;
  const sleep =
    input.dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = input.dependencies.random ?? Math.random;
  const fetcher = input.dependencies.fetcher ?? fetch;
  const getAdminToken =
    input.getAdminToken ??
    (async () => {
      if (!input.adminToken) throw new Error('phase1_admin_token_missing');
      return input.adminToken;
    });
  const startIndex = input.startIndex ?? 0;
  const accountIndices =
    input.accountIndices ??
    Array.from(
      { length: input.count ?? input.config.load.accountCount },
      (_, offset) => Number(startIndex) + offset
    );
  if (
    accountIndices.length !== new Set(accountIndices).size ||
    accountIndices.some(
      (accountIndex) =>
        !Number.isSafeInteger(accountIndex) ||
        accountIndex < 0 ||
        accountIndex >= input.config.load.accountCount
    )
  ) {
    throw new Error('phase1_account_indices_invalid');
  }
  const count = accountIndices.length;
  const queue = new MinQueue();
  const results = new Map<number, Phase1AccountResult>();
  const metrics = {
    scheduled: count,
    attempts: 0,
    accepted201: 0,
    accepted202: 0,
    capacity503: 0,
    server5xx: 0,
    retries: 0,
    terminalFailures: 0,
  };
  for (let offset = 0; offset < accountIndices.length; offset += 1) {
    const accountIndex = accountIndices[offset];
    const identity = deriveLogicalAccountIdentity({
      seed: input.seed,
      runId: input.runId,
      accountIndex,
      emailDomain: input.config.environment.emailDomain,
    });
    queue.push({
      identity,
      dueAt: Math.floor((offset * 1_000) / input.config.load.ratePerSecond),
      firstAttemptAt: null,
      attempt: 0,
      retries: 0,
      capacity503: 0,
      pollCount: 0,
      firstResponseStatus: null,
      mode: 'create',
      operationId: null,
      statusPath: null,
    });
  }
  const startedAtMs = nowMs();
  const startedAt = new Date(startedAtMs).toISOString();
  queue.shiftDueAt(startedAtMs);
  let capacityBlockedUntil = 0;

  const active = new Set<Promise<void>>();
  const launch = (item: QueueItem): void => {
    const task = (async () => {
      if (input.dependencies.signal?.aborted) {
        throw input.dependencies.signal.reason instanceof Error
          ? input.dependencies.signal.reason
          : new Error('phase1_runner_aborted');
      }
      const attemptStartedAt = nowMs();
      if (item.attempt === 0) {
        await input.dependencies.writeEvent({
          schemaVersion: PHASE1_SCHEMA_VERSION,
          kind: 'scheduled',
          at: new Date(item.dueAt).toISOString(),
          runId: input.runId,
          accountIndex: item.identity.accountIndex,
          emailDigest: item.identity.emailDigest,
          requestDigest: item.identity.requestDigest,
          attempt: 0,
        });
      }
      item.firstAttemptAt ??= attemptStartedAt;
      item.attempt += 1;
      metrics.attempts += 1;
      await input.dependencies.writeEvent({
        schemaVersion: PHASE1_SCHEMA_VERSION,
        kind: item.mode === 'create' ? 'attempt' : 'operation_poll',
        at: new Date(attemptStartedAt).toISOString(),
        runId: input.runId,
        accountIndex: item.identity.accountIndex,
        emailDigest: item.identity.emailDigest,
        requestDigest: item.identity.requestDigest,
        attempt: item.attempt,
        ...(item.operationId ? { operationId: item.operationId } : {}),
      });
      const outcome = await requestOnce({
        config: input.config,
        token: await getAdminToken(),
        item,
        fetcher,
        signal: input.dependencies.signal,
      });
      if (input.dependencies.signal?.aborted) {
        throw input.dependencies.signal.reason instanceof Error
          ? input.dependencies.signal.reason
          : new Error('phase1_runner_aborted');
      }
      const completedAtMs = nowMs();
      item.firstResponseStatus ??= outcome.status ?? null;
      if (outcome.kind === 'success' && outcome.userId) {
        if (outcome.status === 201) metrics.accepted201 += 1;
        const completedAt = new Date(completedAtMs).toISOString();
        const result: Phase1AccountResult = {
          accountIndex: item.identity.accountIndex,
          emailDigest: item.identity.emailDigest,
          requestDigest: item.identity.requestDigest,
          userId: outcome.userId,
          operationId: item.operationId,
          firstResponseStatus: item.firstResponseStatus,
          attempts: item.attempt,
          retries: item.retries,
          capacity503: item.capacity503,
          terminalErrorCode: null,
          completedAt,
        };
        results.set(item.identity.accountIndex, result);
        await input.dependencies.writeEvent({
          schemaVersion: PHASE1_SCHEMA_VERSION,
          kind: outcome.status === 201 ? 'accepted_201' : 'succeeded',
          at: completedAt,
          runId: input.runId,
          accountIndex: item.identity.accountIndex,
          emailDigest: item.identity.emailDigest,
          requestDigest: item.identity.requestDigest,
          attempt: item.attempt,
          status: outcome.status,
          latencyMs: completedAtMs - attemptStartedAt,
          ...(item.operationId ? { operationId: item.operationId } : {}),
          userId: outcome.userId,
        });
        await input.dependencies.writeCheckpoint?.(result);
        return;
      }
      if (outcome.kind === 'retry') {
        if (outcome.status === 202) {
          const firstAcceptance = outcome.accepted202 === true;
          item.mode = 'poll';
          item.operationId = outcome.operationId ?? item.operationId;
          item.statusPath = outcome.statusPath ?? item.statusPath;
          if (firstAcceptance) {
            metrics.accepted202 += 1;
          }
          if (firstAcceptance) {
            await input.dependencies.writeEvent({
              schemaVersion: PHASE1_SCHEMA_VERSION,
              kind: 'accepted_202',
              at: new Date(completedAtMs).toISOString(),
              runId: input.runId,
              accountIndex: item.identity.accountIndex,
              emailDigest: item.identity.emailDigest,
              requestDigest: item.identity.requestDigest,
              attempt: item.attempt,
              status: 202,
              latencyMs: completedAtMs - attemptStartedAt,
              operationId: item.operationId ?? undefined,
              statusPathDigest: item.statusPath ? sha256(item.statusPath) : undefined,
            });
          }
        } else if (item.mode === 'poll' && outcome.errorCode === 'operation_pending') {
          item.pollCount += 1;
          if (item.pollCount >= 20) {
            item.pollCount = 0;
            item.mode = 'create';
          }
        }
        if (outcome.status === 503 && outcome.errorCode === CAPACITY_ERROR) {
          metrics.capacity503 += 1;
          item.capacity503 += 1;
          await input.dependencies.writeEvent({
            schemaVersion: PHASE1_SCHEMA_VERSION,
            kind: 'capacity_503',
            at: new Date(completedAtMs).toISOString(),
            runId: input.runId,
            accountIndex: item.identity.accountIndex,
            emailDigest: item.identity.emailDigest,
            requestDigest: item.identity.requestDigest,
            attempt: item.attempt,
            status: 503,
            latencyMs: completedAtMs - attemptStartedAt,
            errorCode: CAPACITY_ERROR,
          });
        } else if (outcome.status !== undefined && outcome.status >= 500) {
          metrics.server5xx += 1;
          await input.dependencies.writeEvent({
            schemaVersion: PHASE1_SCHEMA_VERSION,
            kind: 'server_5xx',
            at: new Date(completedAtMs).toISOString(),
            runId: input.runId,
            accountIndex: item.identity.accountIndex,
            emailDigest: item.identity.emailDigest,
            requestDigest: item.identity.requestDigest,
            attempt: item.attempt,
            status: outcome.status,
            latencyMs: completedAtMs - attemptStartedAt,
            ...(item.operationId ? { operationId: item.operationId } : {}),
            errorCode: outcome.errorCode,
          });
        }
        const retryWindowMs = input.config.load.retryWindowSeconds * 1_000;
        if (completedAtMs - (item.firstAttemptAt ?? completedAtMs) <= retryWindowMs) {
          item.retries += 1;
          metrics.retries += 1;
          const delay = outcome.retryAfterMs ?? backoffMs(item, random);
          if (outcome.status === 503 && outcome.errorCode === CAPACITY_ERROR) {
            capacityBlockedUntil = Math.max(capacityBlockedUntil, completedAtMs + delay);
          }
          item.dueAt = completedAtMs + delay;
          queue.push(item);
          await input.dependencies.writeEvent({
            schemaVersion: PHASE1_SCHEMA_VERSION,
            kind: 'retry_scheduled',
            at: new Date(completedAtMs).toISOString(),
            runId: input.runId,
            accountIndex: item.identity.accountIndex,
            emailDigest: item.identity.emailDigest,
            requestDigest: item.identity.requestDigest,
            attempt: item.attempt,
            retryAt: new Date(item.dueAt).toISOString(),
            ...(item.operationId ? { operationId: item.operationId } : {}),
            errorCode: outcome.errorCode,
          });
          return;
        }
      }
      metrics.terminalFailures += 1;
      const errorCode = outcome.errorCode ?? 'retry_window_exhausted';
      const completedAt = new Date(completedAtMs).toISOString();
      const result: Phase1AccountResult = {
        accountIndex: item.identity.accountIndex,
        emailDigest: item.identity.emailDigest,
        requestDigest: item.identity.requestDigest,
        userId: null,
        operationId: item.operationId,
        firstResponseStatus: item.firstResponseStatus,
        attempts: item.attempt,
        retries: item.retries,
        capacity503: item.capacity503,
        terminalErrorCode: errorCode,
        completedAt,
      };
      results.set(item.identity.accountIndex, result);
      await input.dependencies.writeEvent({
        schemaVersion: PHASE1_SCHEMA_VERSION,
        kind: 'terminal_failure',
        at: completedAt,
        runId: input.runId,
        accountIndex: item.identity.accountIndex,
        emailDigest: item.identity.emailDigest,
        requestDigest: item.identity.requestDigest,
        attempt: item.attempt,
        status: outcome.status,
        ...(item.operationId ? { operationId: item.operationId } : {}),
        errorCode,
      });
      await input.dependencies.writeCheckpoint?.(result);
    })();
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task)
    );
  };

  while (queue.size > 0 || active.size > 0) {
    if (input.dependencies.signal?.aborted) {
      throw input.dependencies.signal.reason instanceof Error
        ? input.dependencies.signal.reason
        : new Error('phase1_runner_aborted');
    }
    const current = nowMs();
    if (current < capacityBlockedUntil) {
      if (active.size > 0) await Promise.race(active);
      else await sleep(capacityBlockedUntil - current);
      continue;
    }
    while (
      active.size < input.config.load.maximumInFlight &&
      queue.peek() &&
      (queue.peek()?.dueAt ?? Infinity) <= current
    ) {
      const item = queue.pop();
      if (item) launch(item);
    }
    if (active.size >= input.config.load.maximumInFlight || queue.size === 0) {
      if (active.size > 0) await Promise.race(active);
      continue;
    }
    const delay = Math.max(0, (queue.peek()?.dueAt ?? current) - nowMs());
    if (active.size === 0) await sleep(delay);
    else await Promise.race([...active, sleep(delay)]);
  }
  const finishedAt = new Date(nowMs()).toISOString();
  return {
    startedAt,
    finishedAt,
    accounts: [...results.values()].sort((left, right) => left.accountIndex - right.accountIndex),
    metrics,
  };
}

function runId(now = new Date(), uuid = randomUUID()): string {
  return `phase1-${now
    .toISOString()
    .replace(/[-:.TZ]/gu, '')
    .slice(0, 14)}-${uuid.replace(/-/gu, '').slice(0, 8)}`;
}

function parseArgs(argv: string[]): {
  configPath: string;
  execute: boolean;
  outputDirectory: string;
  resumeRunDirectory?: string;
} {
  let configPath = '';
  let execute = false;
  let outputDirectory = DEFAULT_RUNS_DIRECTORY;
  let resumeRunDirectory: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--config') configPath = argv[++index] ?? '';
    else if (argument === '--output-directory') {
      const value = argv[++index];
      if (!value) throw new Error('phase1_output_directory_required');
      outputDirectory = resolve(value);
    } else if (argument === '--execute') execute = true;
    else if (argument === '--resume-run-directory') {
      const value = argv[++index];
      if (!value) throw new Error('phase1_resume_run_directory_required');
      resumeRunDirectory = resolve(value);
    } else throw new Error(`phase1_unknown_argument:${argument}`);
  }
  if (!configPath) throw new Error('phase1_config_path_required');
  if (outputDirectory === '/' || outputDirectory === resolve('/tmp')) {
    throw new Error('phase1_output_directory_unsafe');
  }
  if (resumeRunDirectory && !execute) throw new Error('phase1_resume_execute_flag_required');
  return { configPath, execute, outputDirectory, resumeRunDirectory };
}

export async function executePhase1Harness(input: {
  config: Phase1HarnessConfig;
  outputDirectory: string;
  execute: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  runId?: string;
  resumeRunDirectory?: string;
  client?: Phase1ObservationClient & Phase1VerificationClient;
  fetcher?: typeof fetch;
}): Promise<{ runDirectory: string; passed: boolean | null }> {
  const environment = input.environment ?? process.env;
  const outputRoot = resolve(input.outputDirectory);
  if (outputRoot === '/' || outputRoot === resolve('/tmp')) {
    throw new Error('phase1_output_directory_unsafe');
  }
  const resumeRunDirectory = input.resumeRunDirectory
    ? resolve(input.resumeRunDirectory)
    : undefined;
  if (resumeRunDirectory && !resumeRunDirectory.startsWith(`${outputRoot}${sep}`)) {
    throw new Error('phase1_resume_run_directory_unsafe');
  }
  const id = input.runId ?? (resumeRunDirectory ? basename(resumeRunDirectory) : runId());
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(id)) {
    throw new Error('phase1_run_id_invalid');
  }
  const runDirectory = resumeRunDirectory ?? resolve(outputRoot, id);
  if (!runDirectory.startsWith(`${outputRoot}${sep}`))
    throw new Error('phase1_run_directory_unsafe');
  const configPath = resolve(runDirectory, 'config.redacted.json');
  const redactedConfig = redactPhase1Config(input.config);
  if (resumeRunDirectory) {
    const persistedConfig: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (stableJson(persistedConfig) !== stableJson(redactedConfig)) {
      throw new Error('phase1_resume_config_mismatch');
    }
  } else {
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await mkdir(runDirectory, { recursive: false, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(redactedConfig, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  if (!input.execute) return { runDirectory, passed: null };

  const accountId = resolvePhase1Secret(
    environment,
    input.config.credentials.cloudflareAccountIdEnv
  );
  const d1Token = resolvePhase1Secret(
    environment,
    input.config.credentials.cloudflareD1ReadTokenEnv
  );
  const seed = resolvePhase1Secret(environment, input.config.credentials.seedEnv);
  const adminTokenProvider = createPhase1AdminTokenProvider({
    config: input.config,
    environment,
    fetcher: input.fetcher,
  });
  const client =
    input.client ??
    (new CloudflareControlApiClient({
      accountId,
      tokens: { d1: d1Token, workers: d1Token },
    }) as Phase1ObservationClient & Phase1VerificationClient);

  const [control, provider] = await Promise.all([
    collectControlSnapshot({ config: input.config, client }),
    collectProviderSnapshot({ client }),
  ]);
  let baseline: Phase1Baseline;
  if (resumeRunDirectory) {
    baseline = JSON.parse(
      await readFile(resolve(runDirectory, 'baseline.json'), 'utf8')
    ) as Phase1Baseline;
    if (
      baseline.schemaVersion !== PHASE1_SCHEMA_VERSION ||
      baseline.runId !== id ||
      baseline.sourceCommit !== input.config.environment.sourceCommit ||
      baseline.control.environment?.environment_id !== input.config.environment.environmentId ||
      baseline.lookupBuckets.length !== 4_096
    ) {
      throw new Error('phase1_resume_baseline_mismatch');
    }
  } else {
    const preflightBaseline = evaluatePhase1Preflight({
      config: input.config,
      control,
      provider,
      runId: id,
    });
    baseline = {
      ...preflightBaseline,
      lookupBuckets: preflightBaseline.preflight.passed
        ? await collectLookupBucketSnapshot({ client, control })
        : [],
    };
    assertPhase1EvidenceIsSecretFree(baseline);
    await writeFile(
      resolve(runDirectory, 'baseline.json'),
      `${JSON.stringify(baseline, null, 2)}\n`,
      {
        mode: 0o600,
        flag: 'wx',
      }
    );
  }
  if (!baseline.preflight.passed) throw new Error('phase1_preflight_failed');

  const requestsPath = resolve(runDirectory, 'requests.jsonl');
  const controlEventsPath = resolve(runDirectory, 'control-events.jsonl');
  const providerEventsPath = resolve(runDirectory, 'provider-events.jsonl');
  if (!resumeRunDirectory) {
    await Promise.all(
      [requestsPath, controlEventsPath, providerEventsPath].map((path) =>
        writeFile(path, '', { mode: 0o600, flag: 'wx' })
      )
    );
  }
  const checkpointPath = resolve(runDirectory, 'runner-checkpoint.json');
  let checkpointAccounts: Phase1AccountResult[] = [];
  if (resumeRunDirectory) {
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as Phase1RunnerCheckpoint;
    if (checkpoint.schemaVersion !== PHASE1_SCHEMA_VERSION || checkpoint.runId !== id) {
      throw new Error('phase1_resume_checkpoint_mismatch');
    }
    checkpointAccounts = checkpoint.accounts;
  }
  const checkpointWriter = new RunnerCheckpointWriter(checkpointPath, id, checkpointAccounts);
  await checkpointWriter.flush();
  const requestWriter = new JsonlWriter(requestsPath);
  const observerController = new AbortController();
  const runnerController = new AbortController();
  let observationError: Error | null = null;
  const observation = observePhase1({
    config: input.config,
    client,
    initialControl: control,
    initialProvider: provider,
    controlEventsPath,
    providerEventsPath,
    signal: observerController.signal,
  }).catch((error: unknown) => {
    observationError = error instanceof Error ? error : new Error('phase1_observer_failed');
    runnerController.abort(observationError);
    return { latestControl: control, latestProvider: provider };
  });
  try {
    const dependencies: Phase1RunnerDependencies = {
      fetcher: input.fetcher,
      signal: runnerController.signal,
      writeEvent: (event) => requestWriter.write(event),
      writeCheckpoint: (result) => checkpointWriter.record(result),
    };
    if (resumeRunDirectory) {
      const completed = new Set(checkpointWriter.values().map((result) => result.accountIndex));
      const missing = Array.from(
        { length: input.config.load.accountCount },
        (_, index) => index
      ).filter((index) => !completed.has(index));
      await runAccountCreation({
        config: input.config,
        runId: id,
        seed,
        getAdminToken: () => adminTokenProvider.getToken(),
        accountIndices: missing,
        dependencies,
      });
    } else {
      const canary = await runAccountCreation({
        config: input.config,
        runId: id,
        seed,
        getAdminToken: () => adminTokenProvider.getToken(),
        count: 1,
        dependencies,
      });
      if (canary.metrics.terminalFailures !== 0) throw new Error('phase1_canary_failed');
      await runAccountCreation({
        config: input.config,
        runId: id,
        seed,
        getAdminToken: () => adminTokenProvider.getToken(),
        startIndex: 1,
        count: input.config.load.accountCount - 1,
        dependencies,
      });
    }
  } catch (error) {
    observerController.abort();
    await observation;
    throw error;
  } finally {
    await requestWriter.flush();
    await checkpointWriter.flush();
  }

  const requestEvents = await readJsonlEvidence(requestsPath);
  const runner = runnerFromEvidence({
    config: input.config,
    accounts: checkpointWriter.values(),
    events: requestEvents,
  });

  const preQuiescenceObservationError: unknown = observationError;
  if (preQuiescenceObservationError instanceof Error) throw preQuiescenceObservationError;
  let finalControl: Phase1ControlSnapshot;
  try {
    finalControl = await waitForPhase1Quiescence({ config: input.config, client });
  } finally {
    observerController.abort();
    await observation;
  }
  const finalObservationError: unknown = observationError;
  if (finalObservationError instanceof Error) throw finalObservationError;
  const integrity = await verifyPhase1Run({
    config: input.config,
    runId: id,
    seed,
    adminToken: await adminTokenProvider.getToken(),
    baseline,
    runner,
    client,
    fetcher: input.fetcher,
    finalControl,
    controlEventsPath,
  });
  await writeFile(
    resolve(runDirectory, 'integrity.json'),
    `${JSON.stringify(integrity, null, 2)}\n`,
    {
      mode: 0o600,
      flag: 'wx',
    }
  );
  const controlEvents = await readJsonlEvidence(controlEventsPath);
  const report = buildPhase1Report({
    config: input.config,
    runner,
    integrity,
    runId: id,
    baseline,
    controlEvents,
  });
  const timelineSvg = buildPhase1TimelineSvg({
    baseline,
    controlEvents,
    requestEvents,
    totalAccounts: runner.metrics.scheduled,
  });
  await Promise.all([
    writeFile(
      resolve(runDirectory, 'summary.json'),
      `${JSON.stringify(report.summary, null, 2)}\n`,
      {
        mode: 0o600,
        flag: 'wx',
      }
    ),
    writeFile(resolve(runDirectory, 'summary.md'), report.markdown, { mode: 0o600, flag: 'wx' }),
    writeFile(
      resolve(runDirectory, 'provisioning-evidence.json'),
      `${JSON.stringify(report.summary.provisioning, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' }
    ),
    writeFile(resolve(runDirectory, 'timeline.svg'), timelineSvg, { mode: 0o600, flag: 'wx' }),
    writeFile(
      resolve(runDirectory, 'cleanup.json'),
      `${JSON.stringify(
        {
          schemaVersion: PHASE1_SCHEMA_VERSION,
          runId: id,
          status: 'not_run',
          reason: 'separate_operator_action_required',
        },
        null,
        2
      )}\n`,
      { mode: 0o600, flag: 'wx' }
    ),
  ]);
  return { runDirectory, passed: report.summary.passed };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = parsePhase1HarnessConfig(JSON.parse(await readFile(options.configPath, 'utf8')));
  const result = await executePhase1Harness({
    config,
    outputDirectory: options.outputDirectory,
    execute: options.execute,
    resumeRunDirectory: options.resumeRunDirectory,
  });
  process.stdout.write(
    `${options.execute ? 'Phase 1 evidence' : 'Phase 1 validated config'}: ${result.runDirectory}\n`
  );
  if (result.passed === false) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'phase1_harness_failed'}\n`);
    process.exitCode = 1;
  });
}
