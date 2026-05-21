import { describe, expect, it } from 'vitest';
import { SAMLAggregateMetadataStore } from '../SAMLAggregateMetadataStore';
import type { Env } from '../../types/env';

class MockDurableObjectState implements Partial<DurableObjectState> {
  private readonly values = new Map<string, unknown>();

  storage: DurableObjectStorage = {
    get: async <T>(keyOrKeys: string | string[]): Promise<T | Map<string, T> | undefined> => {
      if (Array.isArray(keyOrKeys)) {
        const result = new Map<string, T>();
        for (const key of keyOrKeys) {
          if (this.values.has(key)) {
            result.set(key, this.values.get(key) as T);
          }
        }
        return result;
      }
      return this.values.get(keyOrKeys) as T | undefined;
    },
    put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> => {
      if (typeof keyOrEntries === 'string') {
        this.values.set(keyOrEntries, value);
        return;
      }
      for (const [key, entryValue] of Object.entries(keyOrEntries)) {
        this.values.set(key, entryValue);
      }
    },
    delete: async (keyOrKeys: string | string[]): Promise<boolean | number> => {
      if (typeof keyOrKeys === 'string') {
        const existed = this.values.has(keyOrKeys);
        this.values.delete(keyOrKeys);
        return existed;
      }
      let deleted = 0;
      for (const key of keyOrKeys) {
        if (this.values.delete(key)) {
          deleted++;
        }
      }
      return deleted;
    },
    deleteAll: async (): Promise<void> => {
      this.values.clear();
    },
    list: async <T>(): Promise<Map<string, T>> => new Map(this.values as Map<string, T>),
    transaction: async <T>(closure: (txn: DurableObjectStorage) => Promise<T>): Promise<T> =>
      closure(this.storage),
    getAlarm: async (): Promise<number | null> => null,
    setAlarm: async (): Promise<void> => {},
    deleteAlarm: async (): Promise<void> => {},
    sync: async (): Promise<void> => {},
    transactionSync: <T>(closure: () => T): T => closure(),
    sql: {} as SqlStorage,
    kv: {} as KVNamespace,
    getCurrentBookmark: (): string => '',
    getBookmarkForTime: (): string => '',
    onNextSessionRestoreBookmark: (): void => {},
  } as unknown as DurableObjectStorage;

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  waitUntil(): void {
    // No-op for testing.
  }
}

function createStore(): SAMLAggregateMetadataStore {
  return new SAMLAggregateMetadataStore(
    new MockDurableObjectState() as unknown as DurableObjectState,
    {} as Env
  );
}

describe('SAMLAggregateMetadataStore', () => {
  it('stores preview XML in chunks and serves paged searchable entities', async () => {
    const store = createStore();
    const metadataXml = `<md:EntitiesDescriptor ID="_a">${'x'.repeat(130 * 1024)}</md:EntitiesDescriptor>`;

    const previewResponse = await store.fetch(
      new Request('https://saml-aggregate-metadata.local/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          previewId: 'preview-1',
          tenantId: 'tenant-a',
          metadataXml,
          metadataUrl: 'https://metadata.example.test/aggregate.xml',
          entities: [
            {
              entityId: 'https://idp.example.test/idp',
              role: 'saml_idp',
              displayName: 'Example IdP',
              keywords: ['category:location:tohoku'],
              certificateCount: 1,
            },
            {
              entityId: 'https://sp.example.test/sp',
              role: 'saml_sp',
              acsUrl: 'https://sp.example.test/acs',
              keywords: ['category:location:kanto'],
              certificateCount: 0,
            },
          ],
          verification: { status: 'verified', policy: 'strict' },
        }),
      })
    );

    expect(previewResponse.status).toBe(200);

    const storedResponse = await store.fetch(
      new Request('https://saml-aggregate-metadata.local/preview/preview-1')
    );
    const stored = (await storedResponse.json()) as { metadataXml: string; tenantId: string };
    expect(stored.tenantId).toBe('tenant-a');
    expect(stored.metadataXml).toBe(metadataXml);

    const entitiesResponse = await store.fetch(
      new Request(
        'https://saml-aggregate-metadata.local/preview/preview-1/entities?query=sp&offset=0&limit=1'
      )
    );
    const entities = (await entitiesResponse.json()) as {
      total: number;
      entities: Array<{ entityId: string }>;
      keywordFacets: Array<{ category: string; values: Array<{ keyword: string; count: number }> }>;
    };

    expect(entities.total).toBe(1);
    expect(entities.entities).toEqual([
      {
        entityId: 'https://sp.example.test/sp',
        role: 'saml_sp',
        acsUrl: 'https://sp.example.test/acs',
        keywords: ['category:location:kanto'],
        certificateCount: 0,
      },
    ]);
    expect(entities.keywordFacets).toEqual([
      {
        category: 'location',
        label: 'location',
        values: [{ keyword: 'category:location:kanto', label: 'kanto', count: 1 }],
      },
    ]);

    const filteredResponse = await store.fetch(
      new Request(
        'https://saml-aggregate-metadata.local/preview/preview-1/entities?keyword=category%3Alocation%3Atohoku'
      )
    );
    const filtered = (await filteredResponse.json()) as {
      total: number;
      entities: Array<{ entityId: string }>;
    };
    expect(filtered.total).toBe(1);
    expect(filtered.entities[0].entityId).toBe('https://idp.example.test/idp');
  });

  it('tracks batch progress and per-entity results', async () => {
    const store = createStore();

    const startResponse = await store.fetch(
      new Request('https://saml-aggregate-metadata.local/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId: 'batch-1', tenantId: 'tenant-a', total: 2 }),
      })
    );
    expect(startResponse.status).toBe(200);

    await store.fetch(
      new Request('https://saml-aggregate-metadata.local/batch/batch-1/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: 'https://idp.example.test/idp',
          success: true,
          providerId: 'provider-1',
        }),
      })
    );
    await store.fetch(
      new Request('https://saml-aggregate-metadata.local/batch/batch-1/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId: 'https://sp.example.test/sp',
          success: false,
          error: 'Provider already exists',
        }),
      })
    );
    await store.fetch(
      new Request('https://saml-aggregate-metadata.local/batch/batch-1/complete', {
        method: 'POST',
      })
    );

    const statusResponse = await store.fetch(
      new Request('https://saml-aggregate-metadata.local/batch/batch-1')
    );
    const status = (await statusResponse.json()) as {
      tenantId: string;
      status: string;
      processed: number;
      succeeded: number;
      failed: number;
      results: unknown[];
    };

    expect(status.tenantId).toBe('tenant-a');
    expect(status.status).toBe('completed');
    expect(status.processed).toBe(2);
    expect(status.succeeded).toBe(1);
    expect(status.failed).toBe(1);
    expect(status.results).toHaveLength(2);
  });
});
