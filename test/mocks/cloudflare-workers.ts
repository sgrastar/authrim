/**
 * Mock for cloudflare:workers module
 *
 * This mock provides stub implementations of Cloudflare Workers-specific
 * classes that are not available in the Node.js test environment.
 *
 * Used by vitest.config.ts resolve.alias to replace 'cloudflare:workers' imports.
 */

/**
 * Mock DurableObject base class
 * Provides minimal implementation for testing purposes
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * Mock DurableObjectState
 */
export interface DurableObjectState {
  id: DurableObjectId;
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Mock DurableObjectId
 */
export interface DurableObjectId {
  toString(): string;
  equals(other: DurableObjectId): boolean;
}

/**
 * Mock DurableObjectStorage
 */
export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  deleteAll(): Promise<void>;
  list<T = unknown>(options?: DurableObjectStorageListOptions): Promise<Map<string, T>>;
}

/**
 * Mock DurableObjectStorageListOptions
 */
export interface DurableObjectStorageListOptions {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
}

/**
 * Mock WorkerEntrypoint base class
 */
export class WorkerEntrypoint<Env = unknown> {
  protected env: Env;
  protected ctx: ExecutionContext;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/**
 * Mock ExecutionContext
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/**
 * Mock RpcTarget
 */
export class RpcTarget {}
