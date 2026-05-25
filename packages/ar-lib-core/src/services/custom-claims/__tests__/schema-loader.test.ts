import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaLoader } from '../schema-loader';

const mockDb = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn().mockReturnValue('mock'),
  close: vi.fn(),
};

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

describe('SchemaLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockResolvedValue([]);
    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);
    mockKV.delete.mockResolvedValue(undefined);
  });

  describe('loadActiveSchemas', () => {
    it('returns schemas from DB when no cache', async () => {
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockDb.query.mockResolvedValue(schemas);

      const loader = new SchemaLoader(mockDb as any, null);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
      expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('custom_claim_schemas'), [
        'default',
      ]);
    });

    it('returns cached schemas when available', async () => {
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockKV.get.mockResolvedValue(
        JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
      );

      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('falls back to DB when cache is corrupted', async () => {
      mockKV.get.mockResolvedValue('not-valid-json{');
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockDb.query.mockResolvedValue(schemas);

      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
    });

    it('falls back to DB when cache data is invalid structure', async () => {
      mockKV.get.mockResolvedValue(JSON.stringify({ invalid: true }));
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockDb.query.mockResolvedValue(schemas);

      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
    });

    it('updates cache after DB load', async () => {
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 3 }];
      mockDb.query.mockResolvedValue(schemas);

      const loader = new SchemaLoader(mockDb as any, mockKV as any, 600);
      await loader.loadActiveSchemas('default');

      expect(mockKV.put).toHaveBeenCalledWith('custom_claim_schemas:default', expect.any(String), {
        expirationTtl: 600,
      });
    });

    it('caches empty results to avoid repeated D1 queries', async () => {
      mockDb.query.mockResolvedValue([]);

      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      await loader.loadActiveSchemas('default');

      expect(mockKV.put).toHaveBeenCalledWith(
        'custom_claim_schemas:default',
        expect.stringContaining('"schemas":[]'),
        { expirationTtl: 300 }
      );
    });
  });

  describe('invalidateCache', () => {
    it('deletes the cache key', async () => {
      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      await loader.invalidateCache('default');

      expect(mockKV.delete).toHaveBeenCalledWith('custom_claim_schemas:default');
    });

    it('is no-op when no cache', async () => {
      const loader = new SchemaLoader(mockDb as any, null);
      await loader.invalidateCache('default');
      // Should not throw
    });
  });
});
