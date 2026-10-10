/**
 * SCIM Token Management Endpoint Tests
 *
 * Tests for admin API SCIM token validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { generateScimToken } from '@authrim/ar-lib-scim';
import { adminScimTokenCreateHandler } from '../scim-tokens';

// Mock scim-auth module (now from @authrim/ar-lib-scim package)
vi.mock('@authrim/ar-lib-scim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-scim')>();
  return {
    ...actual,
    generateScimToken: vi.fn().mockResolvedValue({
      token: 'scim_test_token_123',
      tokenHash: 'hash_abc123',
    }),
    revokeScimToken: vi.fn().mockResolvedValue(true),
    listScimTokens: vi.fn().mockResolvedValue([]),
  };
});

// Mock audit writes from ar-lib-core
// Uses spyOn to avoid ESM import issues while preserving other exports
import * as arLibCore from '@authrim/ar-lib-core';
vi.spyOn(arLibCore, 'scheduleAuditLogFromContext').mockImplementation(() => {});
vi.spyOn(arLibCore, 'createAuditLogFromContext').mockResolvedValue(undefined);

describe('SCIM Token Create Handler - Input Validation', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();

    app = new Hono<{ Bindings: Env }>();
    app.post('/api/admin/scim-tokens', adminScimTokenCreateHandler);

    mockEnv = {
      DB: {} as D1Database,
      INITIAL_ACCESS_TOKENS: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [] }),
      } as unknown as KVNamespace,
    };
  });

  describe('expiresInDays validation', () => {
    it('should accept valid expiresInDays within range', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 30 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { expiresInDays: number };
      expect(body.expiresInDays).toBe(30);
    });

    it('should use default expiresInDays when not provided', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { expiresInDays: number };
      expect(body.expiresInDays).toBe(365); // Default: 1 year
    });

    it('should reject negative expiresInDays', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: -1 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject zero expiresInDays', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 0 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject expiresInDays exceeding maximum (1 year)', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 366 }), // > 1 year
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject extremely large expiresInDays', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 999999999 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject non-integer expiresInDays (float)', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 30.5 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should reject non-number expiresInDays (string)', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: '30' }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    // Note: Infinity and NaN cannot be represented in JSON
    // - JSON.stringify({ expiresInDays: Infinity }) omits the property
    // - JSON.stringify({ expiresInDays: NaN }) converts to null
    // These are handled as "not provided" (uses default) or null (accepted)

    it('should accept minimum valid expiresInDays (1 day)', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 1 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { expiresInDays: number };
      expect(body.expiresInDays).toBe(1);
    });

    it('should accept maximum valid expiresInDays (365 days)', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 365 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { expiresInDays: number };
      expect(body.expiresInDays).toBe(365);
    });

    it('should no longer accept the old 10 year maximum', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 3650 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
    });
  });

  describe('expiry settings of the tenant (federation.scim_token_*_expiry)', () => {
    const DAY = 86400;
    const withSettings = (values: Record<string, unknown> | null) =>
      ({
        SETTINGS: {
          get: vi.fn(async (key: string) =>
            values && key === 'settings:tenant:default:federation' ? JSON.stringify(values) : null
          ),
        } as unknown as KVNamespace,
      }) as Partial<Env>;
    const create = (body: Record<string, unknown>, settings: Record<string, unknown> | null) =>
      app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { ...mockEnv, ...withSettings(settings) } as Env
      );

    it("gives a token the tenant's default lifetime when the request names none", async () => {
      const response = await create({}, { 'federation.scim_token_default_expiry': 30 * DAY });

      expect(response.status).toBe(201);
      expect(((await response.json()) as { expiresInDays: number }).expiresInDays).toBe(30);
      expect(vi.mocked(generateScimToken)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ expiresInDays: 30 })
      );
    });

    it("refuses a lifetime past the tenant's maximum and accepts one at it", async () => {
      const settings = { 'federation.scim_token_max_expiry': 30 * DAY };

      expect((await create({ expiresInDays: 31 }, settings)).status).toBe(400);
      expect(vi.mocked(generateScimToken)).not.toHaveBeenCalled();
      const atMax = await create({ expiresInDays: 30 }, settings);
      expect(atMax.status).toBe(201);
      expect(((await atMax.json()) as { expiresInDays: number }).expiresInDays).toBe(30);
    });

    it('keeps the default within a lower maximum', async () => {
      const response = await create({}, { 'federation.scim_token_max_expiry': 30 * DAY });

      expect(((await response.json()) as { expiresInDays: number }).expiresInDays).toBe(30);
    });

    it('uses a year for values out of range', async () => {
      const response = await create(
        { expiresInDays: 366 },
        {
          'federation.scim_token_max_expiry': 10 * 365 * DAY,
          'federation.scim_token_default_expiry': 5,
        }
      );
      expect(response.status).toBe(400);

      const byDefault = await create(
        {},
        { 'federation.scim_token_default_expiry': 5, 'federation.scim_token_max_expiry': 5 }
      );
      expect(((await byDefault.json()) as { expiresInDays: number }).expiresInDays).toBe(365);
    });

    it('issues nothing when the tenant settings cannot be read', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 30 }),
        },
        {
          ...mockEnv,
          SETTINGS: {
            get: vi.fn(async () => '{not json'),
          } as unknown as KVNamespace,
        } as Env
      );

      expect(response.status).toBe(500);
      expect(vi.mocked(generateScimToken)).not.toHaveBeenCalled();
    });
  });

  describe('description validation', () => {
    it('should accept valid description', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 'Production SCIM token' }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { description: string };
      expect(body.description).toBe('Production SCIM token');
    });

    it('should use default description when not provided', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { description: string };
      expect(body.description).toBe('SCIM provisioning token');
    });

    it('should use default description for empty string', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: '' }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { description: string };
      expect(body.description).toBe('SCIM provisioning token');
    });

    it('should reject description exceeding 256 characters', async () => {
      const longDescription = 'A'.repeat(257);
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: longDescription }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should accept description at exactly 256 characters', async () => {
      const maxDescription = 'A'.repeat(256);
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: maxDescription }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { description: string };
      expect(body.description).toBe(maxDescription);
    });

    it('should reject non-string description', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 12345 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });

    it('should trim whitespace from description', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: '  Production token  ' }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { description: string };
      expect(body.description).toBe('Production token');
    });

    it('should sanitize control characters from description', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 'Token\x00with\x1Fcontrol\x7Fchars' }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { description: string };
      expect(body.description).toBe('Tokenwithcontrolchars');
    });

    it('should allow Unicode characters in description', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 'トークン 🔑 Token' }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { description: string };
      expect(body.description).toBe('トークン 🔑 Token');
    });
  });

  describe('JSON parsing', () => {
    it('should reject invalid JSON', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not valid json',
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // AR_ERROR_CODES.VALIDATION_INVALID_VALUE uses standardized message
      expect(body.error_description).toContain('invalid');
    });
  });

  describe('multiple validation errors', () => {
    it('should return all validation errors at once', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expiresInDays: -100,
            description: 'A'.repeat(300),
          }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; error_description?: string };
      expect(body.error).toBe('invalid_request');
      // ErrorFactory returns combined error description
      expect(body.error_description).toBeDefined();
    });
  });
});
