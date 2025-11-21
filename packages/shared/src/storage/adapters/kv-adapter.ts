/**
 * KV Storage Adapter
 *
 * Implements the storage abstraction layer using Cloudflare KV
 * This is the current storage backend for Authrim (Phase 1-5)
 */

import type {
  IStorage,
  IClientRepository,
  StorageOptions,
  ListOptions,
  ListResult,
  ClientData,
} from '../interfaces';

/**
 * KV-based storage implementation
 */
export class KVStorage implements IStorage {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return await this.kv.get(key);
  }

  async put(key: string, value: string, options?: StorageOptions): Promise<void> {
    const kvOptions: {
      expirationTtl?: number;
      expiration?: number;
      metadata?: Record<string, string>;
    } = {};

    if (options?.expirationTtl) {
      kvOptions.expirationTtl = options.expirationTtl;
    }

    if (options?.expiration) {
      kvOptions.expiration = options.expiration;
    }

    if (options?.metadata) {
      kvOptions.metadata = options.metadata;
    }

    await this.kv.put(key, value, kvOptions);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(options?: ListOptions): Promise<ListResult> {
    const result = await this.kv.list({
      prefix: options?.prefix,
      limit: options?.limit,
      cursor: options?.cursor,
    });

    return {
      keys: result.keys.map((key) => ({
        name: key.name,
        expiration: key.expiration,
        metadata: key.metadata as Record<string, string> | undefined,
      })),
      cursor: 'cursor' in result ? (result.cursor as string | undefined) : undefined,
      list_complete: result.list_complete,
    };
  }
}

/**
 * KV-based client repository implementation
 */
export class KVClientRepository implements IClientRepository {
  private storage: KVStorage;
  private prefix = 'client:';

  constructor(kv: KVNamespace) {
    this.storage = new KVStorage(kv);
  }

  async getById(clientId: string): Promise<ClientData | null> {
    const key = `${this.prefix}${clientId}`;
    const data = await this.storage.get(key);

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as ClientData;
    } catch {
      return null;
    }
  }

  async create(client: Omit<ClientData, 'created_at' | 'updated_at'>): Promise<ClientData> {
    const now = Math.floor(Date.now() / 1000);
    const clientData: ClientData = {
      ...(client as ClientData),
      created_at: now,
      updated_at: now,
    };

    const key = `${this.prefix}${String(client.client_id)}`;
    await this.storage.put(key, JSON.stringify(clientData));

    return clientData;
  }

  async update(clientId: string, updates: Partial<ClientData>): Promise<ClientData> {
    const existing = await this.getById(clientId);

    if (!existing) {
      throw new Error(`Client not found: ${clientId}`);
    }

    const updated: ClientData = {
      ...existing,
      ...updates,
      client_id: clientId, // Prevent changing client_id
      updated_at: Math.floor(Date.now() / 1000),
    };

    const key = `${this.prefix}${clientId}`;
    await this.storage.put(key, JSON.stringify(updated));

    return updated;
  }

  async delete(clientId: string): Promise<void> {
    const key = `${this.prefix}${clientId}`;
    await this.storage.delete(key);
  }

  async list(options?: { limit?: number; offset?: number }): Promise<ClientData[]> {
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;

    // KV list doesn't support offset directly, so we need to fetch more and slice
    const result = await this.storage.list({
      prefix: this.prefix,
      limit: limit + offset,
    });

    const clients: ClientData[] = [];

    for (const key of result.keys.slice(offset)) {
      const data = await this.storage.get(key.name);
      if (data) {
        try {
          clients.push(JSON.parse(data) as ClientData);
        } catch {
          // Skip invalid data
        }
      }
    }

    return clients;
  }
}

/**
 * Example: How to use KV adapters
 *
 * ```typescript
 * // In your handler
 * const clientRepo = new KVClientRepository(c.env.CLIENTS);
 * const client = await clientRepo.getById('client_123');
 * ```
 */
