import type { CallLedger } from './call-ledger';
import type { Env } from '../../../packages/ar-lib-core/src/types/env';
import { createMemoryDurableObjectState, MemoryDurableObjectStorage } from './durable-storage';

export interface DurableObjectConstructor<TInstance> {
  new (state: DurableObjectState, env: Env): TInstance;
}

/**
 * Fake `DurableObjectNamespace` that maps instance names to real production Durable Object
 * instances running over shared memory storage. `get(id)` returns a stub that proxies RPC
 * method calls and `fetch` to the real instance. Instance identity is the idFromName string,
 * so two lookups of the same instance name observe the same persisted state.
 */
export class MemoryDurableObjectNamespace<TInstance extends object> {
  private instances = new Map<string, TInstance>();
  private storages = new Map<string, MemoryDurableObjectStorage>();
  private env: Env;

  constructor(
    private readonly ctor: DurableObjectConstructor<TInstance>,
    env: unknown,
    private readonly ledger?: CallLedger,
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
      storage = new MemoryDurableObjectStorage(this.ledger, `${this.label}:${name}`);
      this.storages.set(name, storage);
    }
    let instance = this.instances.get(name);
    if (!instance) {
      const state = createMemoryDurableObjectState({ idName: name, storage });
      instance = new this.ctor(state, this.env);
      this.instances.set(name, instance);
    }
    return createProxiedStub(name, instance, this.ledger, this.label);
  }

  jurisdiction(_jurisdiction: string): MemoryDurableObjectNamespace<TInstance> {
    return this;
  }

  hasInstance(name: string): boolean {
    return this.instances.has(name);
  }

  /**
   * Seed a value directly into the memory storage of the DO instance with the given name
   * WITHOUT instantiating the real Durable Object (avoids constructor side effects such as
   * timers when the instance is only needed for pre-seeded reads). The instance storage is
   * lazily materialized exactly like the runtime lookup path, so a later `get()` observes it.
   */
  async seedStorage(instanceName: string, key: string, value: unknown): Promise<void> {
    let storage = this.storages.get(instanceName);
    if (!storage) {
      storage = new MemoryDurableObjectStorage(this.ledger, `${this.label}:${instanceName}`);
      this.storages.set(instanceName, storage);
    }
    await storage.put(key, value);
  }

  getStorage(instanceName: string): MemoryDurableObjectStorage {
    let storage = this.storages.get(instanceName);
    if (!storage) {
      storage = new MemoryDurableObjectStorage(this.ledger, `${this.label}:${instanceName}`);
      this.storages.set(instanceName, storage);
    }
    return storage;
  }

  /**
   * Copy of the persisted storage for a named instance (materialized lazily without
   * instantiating the real Durable Object, exactly like the runtime lookup path).
   */
  snapshotStorage(instanceName: string): Map<string, unknown> {
    return this.getStorage(instanceName).snapshot();
  }

  /**
   * Copies of every materialized instance storage keyed by instance name. Used by
   * test oracles to assert durable side effects (code/challenge/PAR writes) and
   * their confirmed absence without replicating production routing logic.
   */
  allStorageSnapshots(): Map<string, Map<string, unknown>> {
    const snapshots = new Map<string, Map<string, unknown>>();
    for (const [name, storage] of this.storages) {
      snapshots.set(name, storage.snapshot());
    }
    return snapshots;
  }
}

function createProxiedStub<TInstance extends object>(
  name: string,
  instance: TInstance,
  ledger: CallLedger | undefined,
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
