import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';
import type { ClientMetadata } from '../../types/oidc';

const mockApplyOIDCIdentityMapping = vi.hoisted(() => vi.fn());
const mockEnforceOIDCAttributeReleaseConsent = vi.hoisted(() => vi.fn());

vi.mock('../oidc-identity-mapping', async () => ({
  ...(await vi.importActual<typeof import('../oidc-identity-mapping')>('../oidc-identity-mapping')),
  applyOIDCIdentityMapping: mockApplyOIDCIdentityMapping,
}));
vi.mock('../oidc-attribute-release-consent', async () => ({
  ...(await vi.importActual<typeof import('../oidc-attribute-release-consent')>(
    '../oidc-attribute-release-consent'
  )),
  enforceOIDCAttributeReleaseConsent: mockEnforceOIDCAttributeReleaseConsent,
}));

import { OIDCIdentityMappingRuntimeError } from '../oidc-identity-mapping';
import { OIDCAttributeReleaseConsentRequiredError } from '../oidc-attribute-release-consent';
import { openSubjectReference } from '../subject-reference';
import {
  enforceIDTokenAttributeRelease,
  idTokenGrantClaims,
  mapIDTokenClaims,
  releaseIDTokenClaims,
  type IDTokenReleaseContext,
} from '../oidc-id-token-release';

const ROOT_KEY = 'cd'.repeat(32);

function context(env: Partial<Env> = { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY }) {
  const log = { warn: vi.fn(), error: vi.fn() };
  const loadUserAttributes = vi.fn(async (_userId: string, _names: readonly string[]) => ({
    preferred_username: 'alice',
  }));
  const ctx: IDTokenReleaseContext = {
    env: env as Env,
    adapter: {} as DatabaseAdapter,
    tenantId: 'tenant-a',
    clientId: 'client-a',
    clientMetadata: {
      client_id: 'client-a',
      sector_identifier_uri: 'https://sector.example.com/uris.json',
      identity_mapping: { fieldMappingSetId: 'set-1' },
    } as unknown as ClientMetadata,
    loadUserAttributes,
    log,
  };
  return { ctx, log, loadUserAttributes };
}

const baseClaims = {
  iss: 'https://op.example.com',
  sub: 'user-1',
  aud: 'client-a',
  nonce: 'n',
  at_hash: 'ah',
};

describe('ID token release', () => {
  beforeEach(() => {
    mockApplyOIDCIdentityMapping.mockReset();
    mockEnforceOIDCAttributeReleaseConsent.mockReset();
  });

  describe('mapIDTokenClaims', () => {
    it("applies the app's identity mapping for the ID token surface", async () => {
      const { ctx, loadUserAttributes } = context();
      mockApplyOIDCIdentityMapping.mockResolvedValue({
        claims: { ...baseClaims, sub: 'pairwise' },
        binding: null,
      });

      const result = await mapIDTokenClaims(ctx, baseClaims, ['openid']);

      expect(result).toEqual({ ok: true, claims: { ...baseClaims, sub: 'pairwise' } });
      expect(mockApplyOIDCIdentityMapping).toHaveBeenCalledWith({
        adapter: ctx.adapter,
        env: ctx.env,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        sectorIdentifier: 'https://sector.example.com/uris.json',
        selector: { fieldMappingSetId: 'set-1' },
        destinationSurface: 'id_token',
        grantedScopes: ['openid'],
        claims: baseClaims,
        sourceAttributes: expect.any(Function),
      });
      // The user's attributes are the mapping's source, loaded for the user, and only on demand.
      expect(loadUserAttributes).not.toHaveBeenCalled();
      const { sourceAttributes } = mockApplyOIDCIdentityMapping.mock.calls[0][0] as {
        sourceAttributes: (names: string[]) => Promise<unknown>;
      };
      await expect(sourceAttributes(['preferred_username', 'employee_id'])).resolves.toEqual({
        preferred_username: 'alice',
      });
      // The names the mapping reads go to the loader, which reads only the standard ones.
      expect(loadUserAttributes).toHaveBeenCalledWith('user-1', [
        'preferred_username',
        'employee_id',
      ]);
    });

    it('tells the mapping which claims the endpoint authorized and that the ID token is the only carrier', async () => {
      const { ctx } = context();
      mockApplyOIDCIdentityMapping.mockResolvedValue({ claims: baseClaims, binding: null });

      await mapIDTokenClaims(ctx, baseClaims, ['openid'], {
        authorizedByRequest: true,
        userInfoClaims: true,
      });

      expect(mockApplyOIDCIdentityMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationSurface: 'id_token',
          claimsAuthorizedByRequest: true,
          userInfoClaimsInIdToken: true,
        })
      );
    });

    it('reports a mapping the configuration makes unusable as invalid_client', async () => {
      const { ctx, log } = context();
      mockApplyOIDCIdentityMapping.mockRejectedValue(
        new OIDCIdentityMappingRuntimeError('reserved', {
          code: 'policy.identity_mapping_reserved_subject',
        })
      );

      const result = await mapIDTokenClaims(ctx, baseClaims);

      expect(result).toMatchObject({
        ok: false,
        failure: { kind: 'invalid_mapping', error: 'invalid_client', status: 400 },
      });
      expect(log.error).toHaveBeenCalled();
    });

    it('reports an unexpected failure as server_error', async () => {
      const { ctx } = context();
      mockApplyOIDCIdentityMapping.mockRejectedValue(new Error('db down'));

      await expect(mapIDTokenClaims(ctx, baseClaims)).resolves.toMatchObject({
        ok: false,
        failure: { kind: 'mapping_failed', error: 'server_error', status: 500 },
      });
    });
  });

  describe('enforceIDTokenAttributeRelease', () => {
    it("checks the consent of the user, not of the ID token's sub", async () => {
      const { ctx } = context();
      mockEnforceOIDCAttributeReleaseConsent.mockResolvedValue({ action: 'release' });
      const claims = { ...baseClaims, sub: 'pairwise', email: 'a@example.com' };

      await expect(enforceIDTokenAttributeRelease(ctx, 'user-1', claims)).resolves.toEqual({
        ok: true,
        claims,
      });
      expect(mockEnforceOIDCAttributeReleaseConsent).toHaveBeenCalledWith({
        env: ctx.env,
        tenantId: 'tenant-a',
        subjectId: 'user-1',
        clientMetadata: ctx.clientMetadata,
        claims,
        target: 'id_token',
      });
    });

    it('asks for consent when the claim set needs it', async () => {
      const { ctx } = context();
      mockEnforceOIDCAttributeReleaseConsent.mockRejectedValue(
        new OIDCAttributeReleaseConsentRequiredError({
          claimSetHash: 'h',
          reasonCodes: ['release.attribute_consent.every_time'],
          consentMode: 'every_time',
          claimNames: ['email'],
        })
      );

      await expect(
        enforceIDTokenAttributeRelease(ctx, 'user-1', baseClaims)
      ).resolves.toMatchObject({
        ok: false,
        failure: {
          error: 'consent_required',
          status: 400,
          description: 'User consent is required for this ID token claim release',
        },
      });
    });

    it('reports a failed consent check as server_error', async () => {
      const { ctx } = context();
      mockEnforceOIDCAttributeReleaseConsent.mockRejectedValue(new Error('db down'));

      await expect(
        enforceIDTokenAttributeRelease(ctx, 'user-1', baseClaims)
      ).resolves.toMatchObject({ ok: false, failure: { error: 'server_error', status: 500 } });
    });

    it('releases without a consent check when no user is named', async () => {
      const { ctx } = context();

      await expect(enforceIDTokenAttributeRelease(ctx, '', baseClaims)).resolves.toEqual({
        ok: true,
        claims: baseClaims,
      });
      expect(mockEnforceOIDCAttributeReleaseConsent).not.toHaveBeenCalled();
    });
  });

  describe('idTokenGrantClaims', () => {
    const grant = { userId: 'user-1', consentGeneration: 3 };

    it('carries only the consent generation while the sub is the user id', async () => {
      const claims = await idTokenGrantClaims(
        { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY } as Env,
        'tenant-a',
        'client-a',
        baseClaims,
        grant
      );

      expect(claims.authrim_consent_generation).toBe(3);
      expect(claims.authrim_subject_ref).toBeUndefined();
    });

    it("seals the user's account when the sub is another identifier", async () => {
      const env = { OBJECT_ENCRYPTION_ROOT_KEY: ROOT_KEY } as Env;
      const claims = await idTokenGrantClaims(
        env,
        'tenant-a',
        'client-a',
        { ...baseClaims, sub: 'pairwise' },
        grant
      );

      expect(claims.authrim_consent_generation).toBe(3);
      await expect(
        openSubjectReference(
          env,
          { tenantId: 'tenant-a', clientId: 'client-a' },
          claims.authrim_subject_ref as string
        )
      ).resolves.toBe('user-1');
    });

    it('leaves the reference out without the key to seal one', async () => {
      const claims = await idTokenGrantClaims(
        {} as Env,
        'tenant-a',
        'client-a',
        { ...baseClaims, sub: 'pairwise' },
        grant
      );

      expect(claims.authrim_consent_generation).toBe(3);
      expect(claims.authrim_subject_ref).toBeUndefined();
    });
  });

  describe('releaseIDTokenClaims', () => {
    it('maps, checks consent, then adds the grant claims over anything the mapping wrote', async () => {
      const { ctx } = context();
      mockApplyOIDCIdentityMapping.mockResolvedValue({
        claims: {
          ...baseClaims,
          sub: 'pairwise',
          department: 'research',
          authrim_consent_generation: 99,
          authrim_subject_ref: 'forged',
        },
        binding: null,
      });
      mockEnforceOIDCAttributeReleaseConsent.mockResolvedValue({ action: 'release' });

      const result = await releaseIDTokenClaims(ctx, {
        claims: baseClaims,
        grantedScopes: ['openid'],
        grant: { userId: 'user-1', consentGeneration: 4 },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.claims).toMatchObject({
        sub: 'pairwise',
        department: 'research',
        nonce: 'n',
        at_hash: 'ah',
        authrim_consent_generation: 4,
      });
      expect(result.claims.authrim_subject_ref).not.toBe('forged');
      await expect(
        openSubjectReference(
          ctx.env,
          { tenantId: 'tenant-a', clientId: 'client-a' },
          result.claims.authrim_subject_ref as string
        )
      ).resolves.toBe('user-1');
    });

    it('stops at the first refusal', async () => {
      const { ctx } = context();
      mockApplyOIDCIdentityMapping.mockRejectedValue(new Error('db down'));

      await expect(
        releaseIDTokenClaims(ctx, {
          claims: baseClaims,
          grant: { userId: 'user-1', consentGeneration: 1 },
        })
      ).resolves.toMatchObject({ ok: false });
      expect(mockEnforceOIDCAttributeReleaseConsent).not.toHaveBeenCalled();
    });
  });
});
