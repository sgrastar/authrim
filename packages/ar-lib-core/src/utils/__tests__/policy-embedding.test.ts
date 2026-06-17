/**
 * Tests for Policy Embedding Utility
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluatePermissionEmbeddingForScope,
  evaluatePermissionsForScope,
  parseScopeToActions,
  isPolicyEmbeddingEnabled,
} from '../policy-embedding';
import type { KVNamespace } from '@cloudflare/workers-types';
import type {
  DatabaseAdapter,
  ExecuteResult,
  HealthStatus,
  TransactionContext,
} from '../../db/adapter';

class PolicyEmbeddingAdapter implements DatabaseAdapter {
  constructor(
    private readonly rows: Array<{
      permissions_json: string;
      scope_type: 'global' | 'org' | 'resource';
      scope_target: string;
    }>
  ) {}

  async query<T>(): Promise<T[]> {
    return this.rows as T[];
  }

  async queryOne<T>(): Promise<T | null> {
    return null;
  }

  async execute(): Promise<ExecuteResult> {
    return { success: true, rowsAffected: 0 };
  }

  async transaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx: TransactionContext = {
      query: this.query.bind(this),
      queryOne: this.queryOne.bind(this),
      execute: this.execute.bind(this),
    };
    return fn(tx);
  }

  async batch(): Promise<ExecuteResult[]> {
    return [];
  }

  async isHealthy(): Promise<HealthStatus> {
    return { healthy: true, latencyMs: 0, type: 'memory' };
  }

  getType(): string {
    return 'memory';
  }

  async close(): Promise<void> {}
}

describe('parseScopeToActions', () => {
  it('should return empty array for empty scope', () => {
    expect(parseScopeToActions('')).toEqual([]);
    expect(parseScopeToActions('  ')).toEqual([]);
  });

  it('should skip standard OIDC scopes', () => {
    const result = parseScopeToActions('openid profile email address phone offline_access');
    expect(result).toEqual([]);
  });

  it('should parse resource:action format', () => {
    const result = parseScopeToActions('documents:read');
    expect(result).toEqual([{ resource: 'documents', action: 'read', original: 'documents:read' }]);
  });

  it('should parse multiple resource:action pairs', () => {
    const result = parseScopeToActions('documents:read users:write files:delete');
    expect(result).toEqual([
      { resource: 'documents', action: 'read', original: 'documents:read' },
      { resource: 'users', action: 'write', original: 'users:write' },
      { resource: 'files', action: 'delete', original: 'files:delete' },
    ]);
  });

  it('should filter out standard scopes and keep custom scopes', () => {
    const result = parseScopeToActions('openid profile documents:read email users:manage');
    expect(result).toEqual([
      { resource: 'documents', action: 'read', original: 'documents:read' },
      { resource: 'users', action: 'manage', original: 'users:manage' },
    ]);
  });

  it('should skip scopes without colon', () => {
    const result = parseScopeToActions('openid custom_scope documents:read');
    expect(result).toEqual([{ resource: 'documents', action: 'read', original: 'documents:read' }]);
  });

  it('should handle scope with only colon at start', () => {
    const result = parseScopeToActions(':read documents:write');
    // ':read' has colonIndex = 0, which is not > 0, so it's skipped
    expect(result).toEqual([
      { resource: 'documents', action: 'write', original: 'documents:write' },
    ]);
  });

  it('should handle scope with only colon at end', () => {
    const result = parseScopeToActions('documents: files:read');
    // 'documents:' has colonIndex = 9 and length = 10, so colonIndex < length - 1 is false
    expect(result).toEqual([{ resource: 'files', action: 'read', original: 'files:read' }]);
  });

  it('should handle multiple colons in scope', () => {
    const result = parseScopeToActions('api:resource:read');
    // First colon at index 3, so resource = 'api', action = 'resource:read'
    expect(result).toEqual([
      { resource: 'api', action: 'resource:read', original: 'api:resource:read' },
    ]);
  });

  it('should be case-insensitive for standard scopes', () => {
    const result = parseScopeToActions('OpenID Profile documents:read EMAIL');
    expect(result).toEqual([{ resource: 'documents', action: 'read', original: 'documents:read' }]);
  });

  it('should handle extra whitespace', () => {
    const result = parseScopeToActions('  documents:read   users:write  ');
    expect(result).toEqual([
      { resource: 'documents', action: 'read', original: 'documents:read' },
      { resource: 'users', action: 'write', original: 'users:write' },
    ]);
  });
});

describe('isPolicyEmbeddingEnabled', () => {
  let mockSettings: Partial<KVNamespace>;

  beforeEach(() => {
    mockSettings = {
      get: vi.fn(),
    };
  });

  it('should return false when SETTINGS is not configured', async () => {
    const result = await isPolicyEmbeddingEnabled({});
    expect(result).toBe(false);
  });

  it('should return false when env variable is not set', async () => {
    (mockSettings.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await isPolicyEmbeddingEnabled({
      SETTINGS: mockSettings as KVNamespace,
    });

    expect(result).toBe(false);
    expect(mockSettings.get).toHaveBeenCalledWith('policy:flags:ENABLE_POLICY_EMBEDDING');
  });

  it('should return true when KV value is "true"', async () => {
    (mockSettings.get as ReturnType<typeof vi.fn>).mockResolvedValue('true');

    const result = await isPolicyEmbeddingEnabled({
      SETTINGS: mockSettings as KVNamespace,
    });

    expect(result).toBe(true);
  });

  it('should return true when KV value is "1"', async () => {
    (mockSettings.get as ReturnType<typeof vi.fn>).mockResolvedValue('1');

    const result = await isPolicyEmbeddingEnabled({
      SETTINGS: mockSettings as KVNamespace,
    });

    expect(result).toBe(true);
  });

  it('should return false when KV value is "false"', async () => {
    (mockSettings.get as ReturnType<typeof vi.fn>).mockResolvedValue('false');

    const result = await isPolicyEmbeddingEnabled({
      SETTINGS: mockSettings as KVNamespace,
    });

    expect(result).toBe(false);
  });

  it('should fall back to env variable when KV returns null', async () => {
    (mockSettings.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await isPolicyEmbeddingEnabled({
      SETTINGS: mockSettings as KVNamespace,
      ENABLE_POLICY_EMBEDDING: 'true',
    });

    expect(result).toBe(true);
  });

  it('should fall back to env variable when KV throws error', async () => {
    (mockSettings.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('KV error'));

    const result = await isPolicyEmbeddingEnabled({
      SETTINGS: mockSettings as KVNamespace,
      ENABLE_POLICY_EMBEDDING: 'true',
    });

    expect(result).toBe(true);
  });

  it('should handle case-insensitive KV value', async () => {
    (mockSettings.get as ReturnType<typeof vi.fn>).mockResolvedValue('TRUE');

    const result = await isPolicyEmbeddingEnabled({
      SETTINGS: mockSettings as KVNamespace,
    });

    expect(result).toBe(true);
  });
});

describe('evaluatePermissionEmbeddingForScope', () => {
  it('keeps resource-scoped permissions out of tenant-wide authrim_permissions', async () => {
    const db = new PolicyEmbeddingAdapter([
      {
        permissions_json: JSON.stringify(['documents:read']),
        scope_type: 'resource',
        scope_target: 'document:doc_123',
      },
    ]);

    const embedding = await evaluatePermissionEmbeddingForScope(
      db,
      'user_123',
      'openid documents:read',
      { tenantId: 'tenant-a' }
    );

    expect(embedding.permissions).toEqual([]);
    expect(embedding.scopedPermissions).toEqual([
      {
        permission: 'documents:read',
        scope_type: 'resource',
        scope_target: 'document:doc_123',
      },
    ]);
  });

  it('continues returning tenant-wide permissions through the legacy helper', async () => {
    const db = new PolicyEmbeddingAdapter([
      {
        permissions_json: JSON.stringify(['documents:*']),
        scope_type: 'global',
        scope_target: '',
      },
    ]);

    await expect(
      evaluatePermissionsForScope(db, 'user_123', 'documents:read documents:write', {
        tenantId: 'tenant-a',
      })
    ).resolves.toEqual(['documents:read', 'documents:write']);
  });
});
