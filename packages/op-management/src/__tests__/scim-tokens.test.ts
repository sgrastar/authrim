/**
 * SCIM Token Management Endpoint Tests
 *
 * Tests for admin API SCIM token validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/shared/types/env';
import { adminScimTokenCreateHandler } from '../scim-tokens';

// Mock scim-auth module
vi.mock('@authrim/shared/middleware/scim-auth', () => ({
  generateScimToken: vi.fn().mockResolvedValue({
    token: 'scim_test_token_123',
    tokenHash: 'hash_abc123',
  }),
  revokeScimToken: vi.fn().mockResolvedValue(true),
  listScimTokens: vi.fn().mockResolvedValue([]),
}));

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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details).toContain('expiresInDays must be at least 1 day(s)');
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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details).toContain('expiresInDays must be at least 1 day(s)');
    });

    it('should reject expiresInDays exceeding maximum (10 years)', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 3651 }), // > 10 years
        },
        mockEnv as Env
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details).toContain('expiresInDays must not exceed 3650 days (10 years)');
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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details.some((d) => d.includes('exceed'))).toBe(true);
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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details).toContain('expiresInDays must be an integer');
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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details).toContain('expiresInDays must be a valid number');
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

    it('should accept maximum valid expiresInDays (3650 days)', async () => {
      const response = await app.request(
        '/api/admin/scim-tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresInDays: 3650 }),
        },
        mockEnv as Env
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { expiresInDays: number };
      expect(body.expiresInDays).toBe(3650);
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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details).toContain('description must not exceed 256 characters');
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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details).toContain('description must be a string');
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
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('invalid_request');
      expect(body.message).toBe('Invalid JSON in request body');
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
      const body = (await response.json()) as { error: string; details: string[] };
      expect(body.error).toBe('invalid_request');
      expect(body.details.length).toBe(2);
      expect(body.details.some((d) => d.includes('expiresInDays'))).toBe(true);
      expect(body.details.some((d) => d.includes('description'))).toBe(true);
    });
  });
});
