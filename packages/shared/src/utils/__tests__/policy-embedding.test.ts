/**
 * Tests for Policy Embedding Utility
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseScopeToActions, isPolicyEmbeddingEnabled } from '../policy-embedding';
import type { KVNamespace } from '@cloudflare/workers-types';

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
