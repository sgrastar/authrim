/**
 * State-transition suite harness: failure-injectable Durable Object storage, DO state with
 * ledger-captured waitUntil, a local namespace factory that runs the REAL production
 * Durable Object classes (RefreshTokenRotator / DeviceCodeStore / CIBARequestStore) over
 * that storage, and a Queue MessageBatch fake with per-message ack/retry ledger records.
 *
 * This helper module is intentionally not collected as a test.
 */
import {
  createMemoryDurableObjectState,
  MemoryDurableObjectStorage,
} from '../fixtures/durable-storage';
import type { CallLedger } from '../fixtures/call-ledger';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';

// =============================================================================
// Failure-injectable storage
// =============================================================================

export type StorageFailureKind = 'get' | 'put' | 'delete' | 'alarm' | 'list' | 'transaction';

export interface StorageFailureSpec {
  kind: StorageFailureKind;
  keyPrefix: string;
}

/**
 * Wraps the shared MemoryDurableObjectStorage and adds per-operation failure injection
 * (get/put/delete/alarm/list). Every call is delegated and recorded in the ledger exactly
 * like the shared fake; a matching failure throws with a deterministic message.
 */
export class StateTransitionStorage {
  private failures: StorageFailureSpec[] = [];

  constructor(
    private readonly delegate: MemoryDurableObjectStorage,
    private readonly ledger?: CallLedger
  ) {}

  injectFailure(kind: StorageFailureKind, keyPrefix: string): void {
    this.failures.push({ kind, keyPrefix });
  }

  clearFailures(): void {
    this.failures = [];
  }

  private throwIfFailing(kind: StorageFailureKind, key: string): void {
    const failing = this.failures.find(
      (spec) => spec.kind === kind && key.startsWith(spec.keyPrefix)
    );
    if (failing) {
      this.ledger?.record('do.fetch', `storage:${kind}:${key}:failed`, { failed: true });
      throw new Error(`Durable storage ${kind} failed for ${key}`);
    }
  }

  async get<T = unknown>(key: string): Promise<T | undefined>;
  async get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  async get<T = unknown>(keyOrKeys: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(keyOrKeys)) {
      for (const key of keyOrKeys) this.throwIfFailing('get', key);
    } else {
      this.throwIfFailing('get', keyOrKeys);
    }
    return this.delegate.get(keyOrKeys as never) as Promise<T | undefined | Map<string, T>>;
  }

  async put<T>(key: string, value: T): Promise<void>;
  async put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === 'string') {
      this.throwIfFailing('put', keyOrEntries);
    } else {
      for (const key of Object.keys(keyOrEntries)) this.throwIfFailing('put', key);
    }
    return this.delegate.put(keyOrEntries as never, value as never) as Promise<void>;
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      for (const key of keyOrKeys) this.throwIfFailing('delete', key);
    } else {
      this.throwIfFailing('delete', keyOrKeys);
    }
    return this.delegate.delete(keyOrKeys as never) as Promise<boolean | number>;
  }

  async deleteAll(): Promise<void> {
    this.throwIfFailing('delete', '');
    return this.delegate.deleteAll();
  }

  async deleteMany(keys: string[]): Promise<number> {
    for (const key of keys) this.throwIfFailing('delete', key);
    return this.delegate.deleteMany(keys);
  }

  async transaction<T>(
    callback: (txn: {
      get<TVal = unknown>(key: string): Promise<TVal | undefined>;
      put<TVal>(key: string, value: TVal): Promise<void>;
      delete(key: string): Promise<boolean>;
    }) => Promise<T>
  ): Promise<T> {
    return this.delegate.transaction(callback);
  }

  async list<T = unknown>(options?: {
    prefix?: string;
    start?: string;
    startAfter?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    this.throwIfFailing('list', options?.prefix ?? '');
    return this.delegate.list<T>(options as never);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.throwIfFailing('alarm', '');
    return this.delegate.setAlarm(scheduledTime);
  }

  async getAlarm(): Promise<number | null> {
    this.throwIfFailing('alarm', '');
    return this.delegate.getAlarm();
  }

  async deleteAlarm(): Promise<void> {
    this.throwIfFailing('alarm', '');
    return this.delegate.deleteAlarm();
  }

  snapshot(): Map<string, unknown> {
    return this.delegate.snapshot();
  }

  restore(snapshot: Map<string, unknown>): void {
    this.delegate.restore(snapshot);
  }
}

// =============================================================================
// DO state with ledger-captured waitUntil
// =============================================================================

export interface StateDoStateOptions {
  idName?: string;
  storage?: StateTransitionStorage;
  ledger?: CallLedger;
  blockConcurrencyWhile?: (callback: () => Promise<unknown>) => Promise<unknown>;
}

/**
 * DurableObjectState with `waitUntil` captured into the call ledger so tests can drain
 * every background task (audit flushes) before asserting side effects.
 */
export function createStateDoState(options: StateDoStateOptions): {
  state: DurableObjectState;
  drain: () => Promise<void>;
} {
  const ledger = options.ledger;
  const storage =
    options.storage ?? new StateTransitionStorage(new MemoryDurableObjectStorage(ledger));
  const idName = options.idName ?? 'state-do';
  const waitUntilPromises: Promise<unknown>[] = [];
  const state = createMemoryDurableObjectState({
    idName,
    storage: storage as unknown as MemoryDurableObjectStorage,
    blockConcurrencyWhile: options.blockConcurrencyWhile,
    waitUntil: (promise) => {
      waitUntilPromises.push(promise);
      ledger?.record('waitUntil', `state-do:${idName}:waitUntil`);
    },
  }) as DurableObjectState;
  const drain = async (): Promise<void> => {
    const pending = waitUntilPromises.splice(0);
    await Promise.allSettled(pending);
  };
  return { state, drain };
}

// =============================================================================
// Local namespace: real production DO classes over the local storage
// =============================================================================

export interface StateDoConstructor<TInstance> {
  new (state: DurableObjectState, env: Env): TInstance;
}

/**
 * Local DurableObjectNamespace factory that instantiates the REAL production class over
 * per-instance StateTransitionStorage with a fresh instance cache. Unlike the shared
 * namespace, the storage is failure-injectable and waitUntil is captured per instance.
 */
export class StateTransitionNamespace<TInstance extends object> {
  private instances = new Map<string, TInstance>();
  private storages = new Map<string, StateTransitionStorage>();
  private drains = new Map<string, () => Promise<void>>();
  private env: Env;

  constructor(
    private readonly ctor: StateDoConstructor<TInstance>,
    env: unknown,
    private readonly ledger: CallLedger,
    private readonly label = 'do'
  ) {
    this.env = env as Env;
  }

  setEnv(env: unknown): void {
    this.env = env as Env;
  }

  idFromName(name: string): DurableObjectId {
    return {
      toString: () => name,
      equals: (other) => other.toString() === name,
      name,
    } as DurableObjectId;
  }

  idFromString(id: string): DurableObjectId {
    return this.idFromName(id);
  }

  newUniqueId(): DurableObjectId {
    return this.idFromName(`${this.label}:${crypto.randomUUID()}`);
  }

  get(id: DurableObjectId, _options?: { locationHint?: string }): DurableObjectStub {
    const name = id.toString();
    let storage = this.storages.get(name);
    if (!storage) {
      storage = new StateTransitionStorage(
        new MemoryDurableObjectStorage(this.ledger, `${this.label}:${name}`),
        this.ledger
      );
      this.storages.set(name, storage);
    }
    let instance = this.instances.get(name);
    if (!instance) {
      const created = createStateDoState({ idName: name, storage });
      this.drains.set(name, created.drain);
      instance = new this.ctor(created.state, this.env);
      this.instances.set(name, instance);
    }
    return createStateProxiedStub(name, instance, this.ledger, this.label);
  }

  jurisdiction(_jurisdiction: string): StateTransitionNamespace<TInstance> {
    return this;
  }

  getStorage(instanceName: string): StateTransitionStorage {
    let storage = this.storages.get(instanceName);
    if (!storage) {
      storage = new StateTransitionStorage(
        new MemoryDurableObjectStorage(this.ledger, `${this.label}:${instanceName}`),
        this.ledger
      );
      this.storages.set(instanceName, storage);
    }
    return storage;
  }

  /** Seed a value directly into an instance's storage without constructing the DO. */
  async seedStorage(instanceName: string, key: string, value: unknown): Promise<void> {
    await this.getStorage(instanceName).put(key, value);
  }

  snapshotStorage(instanceName: string): Map<string, unknown> {
    return this.getStorage(instanceName).snapshot();
  }

  allStorageSnapshots(): Map<string, Map<string, unknown>> {
    const snapshots = new Map<string, Map<string, unknown>>();
    for (const [name, storage] of this.storages) {
      snapshots.set(name, storage.snapshot());
    }
    return snapshots;
  }

  async drainAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.drains.values()).map((drain) => drain()));
  }
}

function createStateProxiedStub<TInstance extends object>(
  name: string,
  instance: TInstance,
  ledger: CallLedger,
  label: string
): DurableObjectStub {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, property, receiver) {
      if (property === 'id') {
        return {
          toString: () => name,
          equals: (other: { toString(): string }) => other.toString() === name,
          name,
        };
      }
      const value = Reflect.get(instance, property, receiver);
      if (typeof value === 'function') {
        const methodName = String(property);
        return (...args: unknown[]) => {
          ledger?.record('do.rpc', `${label}:${name}:${methodName}`);
          return (value as (...a: unknown[]) => unknown).apply(instance, args);
        };
      }
      return value;
    },
  };
  return new Proxy({}, handler) as unknown as DurableObjectStub;
}

// =============================================================================
// D1Database-like wrapper (queue consumers expect D1-shaped bindings)
// =============================================================================

import type { MemoryDatabaseAdapter, ExecuteResult } from '../fixtures/d1-adapter';

export interface D1StatementLike {
  bind(...params: unknown[]): D1StatementLike;
  first<T = unknown>(options?: unknown): Promise<T | null>;
  all<T = unknown>(options?: unknown): Promise<{ results: T[]; success: boolean; meta?: unknown }>;
  run(options?: unknown): Promise<ExecuteResult>;
  raw<T = unknown>(options?: unknown): Promise<T[]>;
}

interface D1PreparedLike {
  sql: string;
  params: unknown[];
}

/**
 * D1Database-shaped wrapper around a MemoryDatabaseAdapter. Production D1 consumers call
 * `prepare(sql).bind(...).first()/all()/run()` and `batch([...])`; this wrapper routes
 * those calls to the adapter so every durable side effect stays on the same memory
 * adapter + ledger.
 */
export class D1DatabaseLike {
  constructor(
    private readonly adapter: MemoryDatabaseAdapter,
    private readonly recordParams = false,
    private readonly ledger?: CallLedger
  ) {}

  prepare(query: string): D1StatementLike {
    let params: unknown[] = [];
    const self = this;
    const statement = {
      _sql: query,
      _params: params,
      bind: (...bound: unknown[]) => {
        params = bound;
        (statement as unknown as { _params: unknown[] })._params = params;
        return statement;
      },
      first: async <T = unknown>() => {
        if (self.recordParams) {
          self.ledger?.record('d1.queryOne', `params:${query.replace(/\s+/g, ' ').slice(0, 120)}`, {
            params: safeSerializableParams(params),
          });
        }
        return self.adapter.queryOne<T>(query, params);
      },
      all: async <T = unknown>() => {
        if (self.recordParams) {
          self.ledger?.record('d1.query', `params:${query.replace(/\s+/g, ' ').slice(0, 120)}`, {
            params: safeSerializableParams(params),
          });
        }
        const results = await self.adapter.query<T>(query, params);
        return { results, success: true };
      },
      run: async () => {
        if (self.recordParams) {
          self.ledger?.record('d1.execute', `params:${query.replace(/\s+/g, ' ').slice(0, 120)}`, {
            params: safeSerializableParams(params),
          });
        }
        return self.adapter.execute(query, params);
      },
      raw: async <T = unknown>() => self.adapter.query<T>(query, params),
    };
    return statement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<ExecuteResult[]> {
    const prepared: Array<{ sql: string; params?: unknown[] }> = [];
    for (const statement of statements) {
      const params = (statement as unknown as { _params?: unknown[] })._params ?? [];
      prepared.push({ sql: (statement as unknown as { _sql: string })._sql ?? '', params });
      if (this.recordParams) {
        this.ledger?.record(
          'd1.execute',
          `params:${((statement as unknown as { _sql: string })._sql ?? '').replace(/\s+/g, ' ').slice(0, 120)}`,
          {
            params: safeSerializableParams(params),
          }
        );
      }
    }
    return this.adapter.batch(prepared);
  }

  async dump(): Promise<unknown> {
    return null;
  }

  async exec(_query: string): Promise<void> {
    return undefined;
  }
}

/**
 * Params reduced to a safe serializable subset: strings/numbers/booleans/null plus
 * shallow objects/arrays of those. Anything else (Buffer, unknown classes) is replaced
 * with a stable placeholder so no private detail ever leaves the fake.
 */
function safeSerializableParams(params: unknown[]): unknown[] {
  const safe = (value: unknown): unknown => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(safe);
    }
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = safe(entry);
      }
      return out;
    }
    return '<unsafe-param>';
  };
  return params.map(safe);
}

/**
 * Capturing structured logger for queue consumers: every info/warn/error/debug call is
 * recorded in the ledger (kind 'audit', target 'log:<level>:<message>') with the
 * structured context as detail, so tests can assert message/field redaction and attempt
 * values without touching the production logger.
 */
export function createCapturingLogger(ledger: CallLedger): {
  logger: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>, error?: Error): void;
    error(message: string, context?: Record<string, unknown>, error?: Error): void;
    debug(message: string, context?: Record<string, unknown>): void;
    child(context?: Record<string, unknown>): unknown;
    module(name: string): unknown;
    startTimer(label: string): () => void;
  };
  entries: Array<{ level: string; message: string; context: Record<string, unknown> }>;
} {
  const entries: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
  const record = (level: string, message: string, context?: Record<string, unknown>): void => {
    const ctx = context ?? {};
    entries.push({ level, message, context: ctx });
    ledger.record('audit', `log:${level}:${message}`, { context: ctx });
  };
  const logger = {
    info: (message: string, context?: Record<string, unknown>) => record('info', message, context),
    warn: (message: string, context?: Record<string, unknown>, error?: Error) => {
      record('warn', message, { ...(context ?? {}), ...(error ? { error: error.message } : {}) });
    },
    error: (message: string, context?: Record<string, unknown>, error?: Error) => {
      record('error', message, { ...(context ?? {}), ...(error ? { error: error.message } : {}) });
    },
    debug: (message: string, context?: Record<string, unknown>) =>
      record('debug', message, context),
    child: () => logger,
    module: () => logger,
    startTimer: () => () => undefined,
  };
  return { logger, entries };
}

// =============================================================================
// Queue MessageBatch fake
// =============================================================================

export interface BatchMessageFake<T> {
  id: string;
  body: T;
  attempts: number;
  timestamp: Date;
}

export class MessageBatchFake<T> {
  messages: BatchMessageFake<T>[];
  constructor(entries: Array<BatchMessageFake<T>>) {
    this.messages = entries;
  }
}

export interface MessageDisposition {
  acked: boolean;
  retried: boolean;
}

export interface MessageCallStats {
  ackCalls: number;
  retryCalls: number;
  effective: 'ack' | 'retry' | null;
}

/**
 * Message fake with a two-layer ack()/retry() record:
 *
 * - `ackCalls` / `retryCalls` count EVERY production call (never silently dropped);
 *   the second call of the same kind still increments its counter.
 * - `effective` applies Cloudflare's first-call-wins semantics for the final
 *   disposition (the first ack/retry wins; later calls are ignored for disposition
 *   but still counted).
 *
 * Every call is recorded in the ledger with kind 'ack'/'retry' and a per-call detail so
 * tests can assert both the total call counts and the effective disposition.
 */
export class MessageFake<T> {
  readonly id: string;
  readonly body: T;
  attempts: number;
  readonly timestamp: Date;
  ackCalls = 0;
  retryCalls = 0;
  private disposed: 'ack' | 'retry' | null = null;

  constructor(
    input: { id: string; body: T; attempts?: number },
    private readonly ledger?: CallLedger
  ) {
    this.id = input.id;
    this.body = input.body;
    this.attempts = input.attempts ?? 1;
    this.timestamp = new Date(0);
  }

  ack(): void {
    this.ackCalls += 1;
    if (this.disposed === null) {
      this.disposed = 'ack';
    }
    this.ledger?.record('ack', this.id, { call: this.ackCalls, effective: this.disposed });
  }

  retry(): void {
    this.retryCalls += 1;
    if (this.disposed === null) {
      this.disposed = 'retry';
    }
    this.ledger?.record('retry', this.id, { call: this.retryCalls, effective: this.disposed });
  }

  get effective(): 'ack' | 'retry' | null {
    return this.disposed;
  }

  stats(): MessageCallStats {
    return {
      ackCalls: this.ackCalls,
      retryCalls: this.retryCalls,
      effective: this.disposed,
    };
  }
}

export function makeMessage<T>(
  input: { id: string; body: T; attempts?: number },
  ledger: CallLedger
): MessageFake<T> {
  return new MessageFake(input, ledger);
}

export function messageDispositions(
  ledger: CallLedger,
  ids: string[]
): Record<string, MessageDisposition> {
  const result: Record<string, MessageDisposition> = {};
  for (const id of ids) {
    result[id] = { acked: false, retried: false };
  }
  for (const entry of ledger.all()) {
    if (entry.kind === 'ack' && result[entry.target]) result[entry.target].acked = true;
    if (entry.kind === 'retry' && result[entry.target]) result[entry.target].retried = true;
  }
  return result;
}

/**
 * Effective dispositions only (first-call-wins): the FIRST ack/retry recorded for a
 * message id wins; every later call is ignored for the disposition. Distinct from the
 * raw call counts in `messageCallCounts`.
 */
export function effectiveMessageDispositions(
  ledger: CallLedger,
  ids: string[]
): Record<string, MessageDisposition> {
  const result: Record<string, MessageDisposition> = {};
  for (const id of ids) {
    result[id] = { acked: false, retried: false };
  }
  const decided = new Set<string>();
  for (const entry of ledger.all()) {
    if (
      (entry.kind === 'ack' || entry.kind === 'retry') &&
      result[entry.target] &&
      !decided.has(entry.target)
    ) {
      decided.add(entry.target);
      if (entry.kind === 'ack') result[entry.target].acked = true;
      if (entry.kind === 'retry') result[entry.target].retried = true;
    }
  }
  return result;
}

/** Raw ack/retry CALL COUNTS per message id (every production call, not just the first). */
export function messageCallCounts(
  ledger: CallLedger,
  ids: string[]
): Record<string, MessageCallStats> {
  const result: Record<string, MessageCallStats> = {};
  for (const id of ids) {
    result[id] = { ackCalls: 0, retryCalls: 0, effective: null };
  }
  for (const entry of ledger.all()) {
    if (entry.kind === 'ack' && result[entry.target]) {
      result[entry.target].ackCalls += 1;
      if (result[entry.target].effective === null) result[entry.target].effective = 'ack';
    }
    if (entry.kind === 'retry' && result[entry.target]) {
      result[entry.target].retryCalls += 1;
      if (result[entry.target].effective === null) result[entry.target].effective = 'retry';
    }
  }
  return result;
}
