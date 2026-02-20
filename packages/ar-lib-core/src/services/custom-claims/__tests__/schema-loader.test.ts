import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaLoader } from '../schema-loader';

const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn(),
};

const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

describe('SchemaLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.all.mockResolvedValue({ results: [] });
    mockKV.get.mockResolvedValue(null);
    mockKV.put.mockResolvedValue(undefined);
    mockKV.delete.mockResolvedValue(undefined);
  });

  describe('loadActiveSchemas', () => {
    it('returns schemas from DB when no cache', async () => {
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockDb.all.mockResolvedValue({ results: schemas });

      const loader = new SchemaLoader(mockDb as any, null);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('custom_claim_schemas'));
    });

    it('returns cached schemas when available', async () => {
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockKV.get.mockResolvedValue(
        JSON.stringify({ schemas, fetched_at: Date.now(), schema_version_max: 1 })
      );

      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('falls back to DB when cache is corrupted', async () => {
      mockKV.get.mockResolvedValue('not-valid-json{');
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockDb.all.mockResolvedValue({ results: schemas });

      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
    });

    it('falls back to DB when cache data is invalid structure', async () => {
      mockKV.get.mockResolvedValue(JSON.stringify({ invalid: true }));
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 1 }];
      mockDb.all.mockResolvedValue({ results: schemas });

      const loader = new SchemaLoader(mockDb as any, mockKV as any);
      const result = await loader.loadActiveSchemas('default');

      expect(result).toEqual(schemas);
    });

    it('updates cache after DB load', async () => {
      const schemas = [{ id: '1', field_key: 'dept', schema_version: 3 }];
      mockDb.all.mockResolvedValue({ results: schemas });

      const loader = new SchemaLoader(mockDb as any, mockKV as any, 600);
      await loader.loadActiveSchemas('default');

      expect(mockKV.put).toHaveBeenCalledWith('custom_claim_schemas:default', expect.any(String), {
        expirationTtl: 600,
      });
    });

    it('caches empty results to avoid repeated D1 queries', async () => {
      mockDb.all.mockResolvedValue({ results: [] });

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
