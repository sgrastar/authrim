import { AsyncLocalStorage } from 'node:async_hooks';

interface WriteEffects {
  active: boolean;
  uncertain: boolean;
  pending: Set<Promise<void>>;
}

const effects = new AsyncLocalStorage<WriteEffects>();

/** No error, SQL, key, or payload is retained in the authority observation. */
export function markUncertainReplicationWrite(): void {
  const current = effects.getStore();
  if (current) current.uncertain = true;
}

/**
 * Observe before application code can catch an error. Without a replication context this returns
 * the original operation promise. A definite rejection is permitted only when the storage
 * protocol proves no write was accepted, never merely because the application caught its error.
 */
export function trackReplicationStorageOperation<T>(
  operation: () => Promise<T>,
  definiteRejection?: (error: unknown) => boolean
): Promise<T> {
  const current = effects.getStore();
  if (!current) return operation();
  if (!current.active) throw new Error('replication_writer_context_closed');
  let promise: Promise<T>;
  try {
    promise = operation();
  } catch (error) {
    current.uncertain = true;
    throw error;
  }
  const observed = Promise.resolve(promise).catch((error: unknown) => {
    let rejected = false;
    try {
      rejected = definiteRejection?.(error) === true;
    } catch {
      // A classifier failure cannot manufacture evidence of a rolled-back mutation.
    }
    if (!rejected) current.uncertain = true;
    throw error;
  });
  // The caller receives the original failure. This separately owned observation both drains
  // fire-and-forget writes and prevents their rejection from becoming unhandled.
  current.pending.add(
    observed.then(
      () => undefined,
      () => undefined
    )
  );
  return observed;
}

/** Drains even on callback failure; uncertainty survives errors caught by application handlers. */
export async function runWithReplicationWriteEffects<T>(run: () => Promise<T>): Promise<T> {
  const current: WriteEffects = { active: true, uncertain: false, pending: new Set() };
  return effects.run(current, async () => {
    let result!: T;
    let failed = false;
    let failure: unknown;
    try {
      result = await run();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      while (current.pending.size) {
        const batch = [...current.pending];
        await Promise.all(batch);
        for (const pending of batch) current.pending.delete(pending);
      }
      if (failed) throw failure;
      if (current.uncertain) throw new Error('replication_writer_outcome_unknown');
      return result;
    } finally {
      current.active = false;
    }
  });
}

/** Promise-mode SQL clients only; observe the physical query even when an adapter catches it. */
export function withReplicationSqlQueries<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, key) {
      const method: unknown = Reflect.get(target, key, target);
      if (typeof method !== 'function') return method;
      if (key === 'query')
        return (...args: unknown[]) =>
          trackReplicationStorageOperation(
            () => Reflect.apply(method, target, args) as Promise<unknown>
          );
      // pg.Pool leases a physical client; pg.Client.connect resolves void. Both production paths
      // use the promise overload, never callbacks. Keep dedicated transactions observed as well.
      if (key === 'connect')
        return (...args: unknown[]) =>
          Promise.resolve(Reflect.apply(method, target, args) as unknown).then((result) =>
            record(result) ? withReplicationSqlQueries(result) : result
          );
      return (...args: unknown[]) => Reflect.apply(method, target, args) as unknown;
    },
  });
}

type Kind = 'd1' | 'statement' | 'session' | 'object-store' | 'multipart';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function callable(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'function';
}

/**
 * Instrument native storage bindings while preserving their receivers and prepared statement
 * identities. Service bindings/DO stubs retain their own guarded RPC admission. KV reads and R2
 * reads stay untouched; D1 first/all/raw are observed because SQL RETURNING can mutate through
 * those methods. Feature-disabled environments keep object identity and native methods intact.
 */
export function withReplicationStorageBindings<T extends object>(env: T): T {
  if (!effects.getStore()) return env;
  const proxies = new WeakMap<object, object>();
  const originals = new WeakMap<object, object>();
  const unwrap = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(unwrap)
      : record(value)
        ? (originals.get(value) ?? value)
        : value;

  function wrap(target: Record<string, unknown>, kind: Kind): object {
    const previous = proxies.get(target);
    if (previous) return previous;
    const proxy = new Proxy(target, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== 'function') return value;
        const key = String(property);
        const invoke = (...args: unknown[]): unknown =>
          Reflect.apply(value, object, args.map(unwrap));
        if (
          ((kind === 'd1' || kind === 'session') && key === 'prepare') ||
          (kind === 'statement' && key === 'bind')
        )
          return (...args: unknown[]) => {
            const result = invoke(...args);
            if (!record(result)) throw new Error('replication_storage_contract_invalid');
            return wrap(result, 'statement');
          };
        if (kind === 'd1' && key === 'withSession')
          return (...args: unknown[]) => {
            const result = invoke(...args);
            if (!record(result)) throw new Error('replication_storage_contract_invalid');
            return wrap(result, 'session');
          };
        if (kind === 'object-store' && key === 'resumeMultipartUpload')
          return (...args: unknown[]) => {
            const result = invoke(...args);
            if (!record(result)) throw new Error('replication_storage_contract_invalid');
            return wrap(result, 'multipart');
          };
        const sql =
          (kind === 'statement' && ['run', 'all', 'first', 'raw'].includes(key)) ||
          (kind === 'd1' && ['batch', 'exec'].includes(key));
        const mutating =
          sql ||
          (kind === 'object-store' && ['put', 'delete', 'createMultipartUpload'].includes(key)) ||
          (kind === 'multipart' && ['uploadPart', 'complete', 'abort'].includes(key));
        if (!mutating) return invoke;
        return (...args: unknown[]) =>
          trackReplicationStorageOperation(async () => {
            const result = await invoke(...args);
            if (sql) {
              const results = Array.isArray(result) ? result : [result];
              if (results.some((item) => record(item) && item.success === false))
                markUncertainReplicationWrite();
            }
            if (key === 'createMultipartUpload') {
              if (!record(result)) throw new Error('replication_storage_contract_invalid');
              return wrap(result, 'multipart');
            }
            return result;
          });
      },
    });
    proxies.set(target, proxy);
    originals.set(proxy, target);
    return proxy;
  }

  return new Proxy(env, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (!record(value)) return value;
      if (callable(value, 'prepare') && callable(value, 'batch')) return wrap(value, 'd1');
      if (callable(value, 'get') && callable(value, 'put') && callable(value, 'delete'))
        return wrap(value, 'object-store');
      return value;
    },
  });
}
