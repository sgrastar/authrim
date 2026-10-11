/**
 * UserInfo: eduperson_assurance (identity assurance).
 *
 * The evidence the claims come from is read when UserInfo answers, never cached, and only when
 * the request asks for a claim and the tenant has something to release.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const mockIntrospectTokenFromContext = vi.hoisted(() => vi.fn());
const mockGetClientCached = vi.hoisted(() => vi.fn());
const mockCanonicalFindByLegacyUserId = vi.hoisted(() => vi.fn());
const mockResolveEffectiveSettings = vi.hoisted(() => vi.fn());
const mockApplyOIDCIdentityMapping = vi.hoisted(() => vi.fn());
const mockEnforceOIDCAttributeReleaseConsent = vi.hoisted(() => vi.fn());
const mockCreatePIIContextFromHono = vi.hoisted(() => vi.fn());

vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    introspectTokenFromContext: mockIntrospectTokenFromContext,
    getClientCached: mockGetClientCached,
    CanonicalRuntimeUserProjectionRepository: vi.fn().mockImplementation(function () {
      return { findByLegacyUserId: mockCanonicalFindByLegacyUserId };
    }),
    CanonicalSensitiveValueResolver: vi.fn(),
    resolveEffectiveSettings: mockResolveEffectiveSettings,
    applyOIDCIdentityMapping: mockApplyOIDCIdentityMapping,
    enforceOIDCAttributeReleaseConsent: mockEnforceOIDCAttributeReleaseConsent,
    resolveAccountDataContextFromHono: vi.fn().mockResolvedValue(undefined),
    createPIIContextFromHono: mockCreatePIIContextFromHono,
    isUserInfoEncryptionRequired: () => false,
  };
});

import { userinfoHandler } from '../userinfo';

const NOW = Date.now();
const IAL1_URI = 'https://example.org/assurance/IAL1';
const IAL2_URI = 'https://example.org/assurance/IAL2';

const ASSURANCE_SETTINGS = {
  'assurance.enabled': true,
  'assurance.ial_assurance_values': JSON.stringify({ IAL1: [IAL1_URI], IAL2: [IAL2_URI] }),
};

function evidenceRow(level: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `ev-${level}`,
    assurance_framework: 'nist_800_63',
    assurance_level: level,
    verified_at: NOW - 86_400_000,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function projection() {
  return {
    id: 'user-123',
    tenant_id: 'default',
    subject_id: 'subject:user-123',
    account_id: 'account:user-123',
    email: 'test@example.com',
    email_verified: 1,
    name: 'Test User',
    given_name: 'Test',
    family_name: 'User',
    middle_name: null,
    nickname: null,
    preferred_username: null,
    profile: null,
    picture: null,
    website: null,
    gender: null,
    birthdate: null,
    zoneinfo: null,
    locale: null,
    phone_number: null,
    phone_number_verified: 0,
    address_json: null,
    password_hash: null,
    external_id: null,
    active: 1,
    custom_attributes_json: null,
    created_at: new Date(1_700_000_000_000).toISOString(),
    updated_at: new Date(1_700_000_000_000).toISOString(),
  };
}

function createContext() {
  const logger = {
    module: () => logger,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const c = {
    req: { header: (name: string) => (name === 'Authorization' ? 'Bearer t' : undefined) },
    env: { ISSUER_URL: 'https://op.example.com' } as unknown as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn(),
    body: vi.fn(),
    get: vi.fn((key: string) => {
      if (key === 'logger') return logger;
      if (key === 'tenantId') return 'default';
      if (key === 'tenantMetadataContext') return { tenantId: 'default', coreDb: {} };
      return undefined;
    }),
  };
  return { c: c as any, logger };
}

describe('UserInfo identity assurance claims', () => {
  let evidence: Array<Record<string, unknown>> | 'fail';
  let evidenceReads: number;
  let settings: Record<string, unknown>;
  let assuranceSettingReads: number;

  beforeEach(() => {
    vi.clearAllMocks();
    evidence = [];
    evidenceReads = 0;
    assuranceSettingReads = 0;
    settings = { ...ASSURANCE_SETTINGS };
    mockResolveEffectiveSettings.mockImplementation(async (_env: unknown, category: string) => {
      if (category === 'assurance') {
        assuranceSettingReads += 1;
        return settings;
      }
      return { 'oauth.userinfo_require_openid': false };
    });
    mockGetClientCached.mockResolvedValue({ client_id: 'client-1' });
    mockCanonicalFindByLegacyUserId.mockResolvedValue(projection());
    mockApplyOIDCIdentityMapping.mockImplementation(async (input: { claims: unknown }) => ({
      claims: input.claims,
    }));
    mockEnforceOIDCAttributeReleaseConsent.mockResolvedValue(undefined);
    mockCreatePIIContextFromHono.mockReturnValue({
      coreAdapter: {
        query: vi.fn(async (sql: string) => {
          if (!sql.includes('assurance_evidence')) return [];
          evidenceReads += 1;
          if (evidence === 'fail') throw new Error('account database is down');
          return evidence;
        }),
      },
      defaultPiiAdapter: {},
    });
  });

  async function userinfo(token: { scope: string; claims?: unknown }) {
    mockIntrospectTokenFromContext.mockResolvedValue({
      valid: true,
      claims: {
        sub: 'user-123',
        client_id: 'client-1',
        scope: token.scope,
        ...(token.claims ? { claims: JSON.stringify(token.claims) } : {}),
      },
    });
    const { c, logger } = createContext();
    await userinfoHandler(c);
    const call = vi.mocked(c.json).mock.calls[0];
    return { body: call[0] as Record<string, unknown>, status: call[1] ?? 200, logger };
  }

  describe('eduperson_assurance', () => {
    it('releases the values of every IAL up to the person’s to the eduperson_assurance scope', async () => {
      evidence = [evidenceRow('IAL2')];
      const { body } = await userinfo({ scope: 'openid eduperson_assurance' });
      expect(body.eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(evidenceReads).toBe(1);
    });

    it('releases only the IAL1 values to a person without evidence', async () => {
      const { body } = await userinfo({ scope: 'openid eduperson_assurance' });
      expect(body.eduperson_assurance).toEqual([IAL1_URI]);
    });

    it('stops releasing evidence that was revoked, from the next request', async () => {
      evidence = [evidenceRow('IAL2')];
      expect(
        (await userinfo({ scope: 'openid eduperson_assurance' })).body.eduperson_assurance
      ).toEqual([IAL1_URI, IAL2_URI]);
      evidence = [evidenceRow('IAL2', { revoked_at: NOW })];
      expect(
        (await userinfo({ scope: 'openid eduperson_assurance' })).body.eduperson_assurance
      ).toEqual([IAL1_URI]);
      expect(evidenceReads).toBe(2);
    });

    it('releases to a claims parameter request only when the scope allows it', async () => {
      evidence = [evidenceRow('IAL2')];
      const claims = { userinfo: { eduperson_assurance: null } };
      expect((await userinfo({ scope: 'openid', claims })).body).not.toHaveProperty(
        'eduperson_assurance'
      );
      expect(
        (await userinfo({ scope: 'openid eduperson_assurance', claims })).body.eduperson_assurance
      ).toEqual([IAL1_URI, IAL2_URI]);
    });

    it('releases nothing, and says so in the log, when the evidence cannot be read', async () => {
      evidence = 'fail';
      const { body, status, logger } = await userinfo({ scope: 'openid eduperson_assurance' });
      expect(status).toBe(200);
      expect(body).toEqual({ sub: 'user-123' });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('identity assurance'),
        expect.anything(),
        expect.any(Error)
      );
    });
  });

  describe('for an access token whose client no longer exists', () => {
    it('does not release it, by scope or by claims parameter, and reads no evidence', async () => {
      evidence = [evidenceRow('IAL2')];
      mockGetClientCached.mockResolvedValue(null);

      const byScope = await userinfo({ scope: 'openid eduperson_assurance' });
      expect(byScope.status).toBe(200);
      expect(byScope.body).toEqual({ sub: 'user-123' });
      expect(byScope.logger.warn).toHaveBeenCalled();

      const byClaims = await userinfo({
        scope: 'openid eduperson_assurance',
        claims: { userinfo: { eduperson_assurance: null } },
      });
      expect(byClaims.body).not.toHaveProperty('eduperson_assurance');
      expect(evidenceReads).toBe(0);
    });

    it('says so in the log for a claims parameter request that has no assurance scope', async () => {
      evidence = [evidenceRow('IAL2')];
      mockGetClientCached.mockResolvedValue(null);

      const { body, status, logger } = await userinfo({
        scope: 'openid',
        claims: { userinfo: { eduperson_assurance: null } },
      });

      expect(status).toBe(200);
      expect(body).not.toHaveProperty('eduperson_assurance');
      expect(logger.warn).toHaveBeenCalled();
      expect(evidenceReads).toBe(0);
    });

    it('still answers the request that asks for nothing about assurance', async () => {
      mockGetClientCached.mockResolvedValue(null);
      const { body, status, logger } = await userinfo({ scope: 'openid profile' });
      expect(status).toBe(200);
      expect(body.given_name).toBe('Test');
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('when nothing is to be released it reads no evidence', () => {
    it('for a request that asks for neither claim', async () => {
      evidence = [evidenceRow('IAL2')];
      const { body } = await userinfo({ scope: 'openid profile email' });
      expect(body).not.toHaveProperty('eduperson_assurance');
      expect(evidenceReads).toBe(0);
      expect(assuranceSettingReads).toBe(0);
    });

    it('while assurance is off', async () => {
      settings['assurance.enabled'] = false;
      const { body } = await userinfo({ scope: 'openid eduperson_assurance' });
      expect(body).toEqual({ sub: 'user-123' });
      expect(evidenceReads).toBe(0);
    });

    it('when no assurance values are configured', async () => {
      settings = { 'assurance.enabled': true, 'assurance.ial_assurance_values': '{}' };
      const { body } = await userinfo({ scope: 'openid eduperson_assurance' });
      expect(body).toEqual({ sub: 'user-123' });
      expect(evidenceReads).toBe(0);
    });
  });

  describe('through the identity mapping', () => {
    it('hands the claims to the mapping with the others, so a Destination Profile holds them', async () => {
      evidence = [evidenceRow('IAL2')];
      let handedToMapping: Record<string, unknown> = {};
      mockApplyOIDCIdentityMapping.mockImplementation(
        async (input: { claims: Record<string, unknown> }) => {
          handedToMapping = { ...input.claims };
          // An app whose profile does not list the claims does not get them.
          const rest = { ...input.claims };
          delete rest.eduperson_assurance;
          return { claims: rest };
        }
      );
      const { body } = await userinfo({
        scope: 'openid profile eduperson_assurance',
        claims: {
          userinfo: {},
        },
      });
      expect(handedToMapping.eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
      expect(body).not.toHaveProperty('eduperson_assurance');
    });

    it('holds them to the attribute release consent', async () => {
      evidence = [evidenceRow('IAL2')];
      let consented: Record<string, unknown> = {};
      mockEnforceOIDCAttributeReleaseConsent.mockImplementation(
        async (input: { claims: Record<string, unknown> }) => {
          consented = { ...input.claims };
        }
      );
      await userinfo({ scope: 'openid eduperson_assurance' });
      expect(consented.eduperson_assurance).toEqual([IAL1_URI, IAL2_URI]);
    });
  });
});
