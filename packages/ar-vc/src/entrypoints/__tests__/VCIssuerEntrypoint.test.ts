import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@cloudflare/workers-types';
import type { CreateCredentialOfferServiceInput } from '@authrim/ar-lib-core';
import { VCIssuerEntrypoint } from '../VCIssuerEntrypoint';
import { isConfiguredShard } from '../../utils/configured-shard';
import type { Env } from '../../types';

type GetStore =
  (typeof import('../../utils/credential-offer-sharding'))['getCredentialOfferStoreForNewOffer'];
const mocks = vi.hoisted(() => ({
  createOfferRpc: vi.fn(),
  getAdminOfferProgressRpc: vi.fn(),
  getStore: vi.fn(),
  getById: vi.fn(),
}));
const createOfferRpc = mocks.createOfferRpc;

vi.mock('../../utils/configured-shard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/configured-shard')>()),
  isConfiguredShard: vi.fn(async () => true),
}));
const getStore = mocks.getStore as ReturnType<typeof vi.fn<GetStore>>;

vi.mock('../../utils/credential-offer-sharding', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/credential-offer-sharding')>();
  return {
    ...original,
    getCredentialOfferStoreForNewOffer: mocks.getStore,
    getCredentialOfferStoreById: mocks.getById,
  };
});

const validInput = (): CreateCredentialOfferServiceInput => ({
  tenantId: 'tenant-a',
  userId: 'user-a',
  credentialProfileId: 'employee-card',
  credentialProfileVersion: 3,
  credentialProfileSnapshotHash: 'abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890-efgh',
  credentialProfileContractSignature: 'placeholder',
  credentialConfigurationId: 'EmployeeCredential',
  mappingVersionId: 'mapping-v7',
  mappingSnapshotHash: 'abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890-abcd',
  claims: { department: 'security', employee_id: 'E-123' },
  claimManifest: ['employee_id', 'department'],
  credentialIssuer: 'https://issuer.example.com/',
  expiresInSeconds: 120,
});

const CONTRACT_SECRET = 'profile-contract-secret-0123456789abcdef';

async function signedInput(
  overrides: Partial<CreateCredentialOfferServiceInput> = {}
): Promise<CreateCredentialOfferServiceInput> {
  const input = { ...validInput(), ...overrides };
  const manifest = [...new Set(input.claimManifest)].sort();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CONTRACT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(
        JSON.stringify([
          input.tenantId,
          input.credentialProfileId,
          input.credentialProfileVersion,
          input.credentialProfileSnapshotHash,
          input.credentialConfigurationId,
          input.mappingVersionId,
          input.mappingSnapshotHash,
          manifest,
        ])
      )
    )
  );
  input.credentialProfileContractSignature = btoa(String.fromCharCode(...signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
  return input;
}

function createEntrypoint(): VCIssuerEntrypoint {
  const env = {
    VC_TRANSACTION_CODE_HMAC_SECRET: '0123456789abcdef0123456789abcdef',
    VC_PROFILE_CONTRACT_HMAC_SECRET: CONTRACT_SECRET,
  } as Env;
  return new VCIssuerEntrypoint({} as ExecutionContext, env);
}

describe('VCIssuerEntrypoint', () => {
  beforeEach(() => {
    createOfferRpc.mockReset().mockResolvedValue({});
    getStore.mockReset().mockResolvedValue({
      stub: { createOfferRpc, getAdminOfferProgressRpc: mocks.getAdminOfferProgressRpc },
      offerId: 'g1:apac:0:co_12345678-1234-1234-1234-123456789abc',
      resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
      instanceName: 'tenant-a:apac:credoffer:0',
    } as unknown as Awaited<ReturnType<GetStore>>);
  });

  it('pins profile and mapping evidence while storing only hashed one-time secrets', async () => {
    const result = await createEntrypoint().createCredentialOffer(
      await signedInput({ transactionCodeRequired: true })
    );

    expect(result.credentialOfferUri).toMatch(
      /^https:\/\/issuer\.example\.com\/vci\/offers\/g1%3Aapac%3A0%3Aco_/
    );
    expect(result.transactionCode).toMatch(/^\d{6}$/);
    expect(result.claimManifestHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createOfferRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        credentialProfileId: 'employee-card',
        credentialProfileVersion: 3,
        mappingVersionId: 'mapping-v7',
        mappingSnapshotHash: validInput().mappingSnapshotHash,
        claims: { department: 'security', employee_id: 'E-123' },
        claimManifestHash: result.claimManifestHash,
      })
    );
    const stored = createOfferRpc.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(stored.preAuthorizedCodeHash).not.toContain('g1:apac');
    expect(stored.txCodeHash).not.toBe(result.transactionCode);
  });

  it('rejects claims not covered exactly by the pinned manifest', async () => {
    await expect(
      createEntrypoint().createCredentialOffer(
        await signedInput({ claimManifest: ['employee_id'] })
      )
    ).rejects.toThrow('claim_manifest_mismatch');
    expect(getStore).not.toHaveBeenCalled();
  });

  it('rejects insecure issuer URLs before allocating durable state', async () => {
    await expect(
      createEntrypoint().createCredentialOffer(
        await signedInput({ credentialIssuer: 'http://issuer.example.com' })
      )
    ).rejects.toThrow('invalid_credential_issuer');
    expect(getStore).not.toHaveBeenCalled();
  });

  it('rejects a profile or mapping snapshot changed after Management signed it', async () => {
    const input = await signedInput();
    input.credentialProfileSnapshotHash = 'abcdefghijklmnopqrstuvwxyzABCDEFG_1234567890-zzzz';
    await expect(createEntrypoint().createCredentialOffer(input)).rejects.toThrow(
      'invalid_credential_profile_contract'
    );
    expect(getStore).not.toHaveBeenCalled();
  });

  describe('createAdminCredentialOffer', () => {
    const adminInput = () => ({
      tenantId: 'tenant-a',
      adminUserId: 'admin-1',
      credentialIssuer: 'https://tenant-a.example.com/',
    });

    it('forces a transaction code, a 300 s lifetime, the reserved configuration and no claims', async () => {
      const before = Date.now();
      const result = await createEntrypoint().createAdminCredentialOffer(adminInput());

      expect(result.transactionCode).toMatch(/^\d{6}$/);
      expect(result.credentialOfferUri).toMatch(
        /^https:\/\/tenant-a\.example\.com\/vci\/offers\/g1%3Aapac%3A0%3Aco_/
      );
      expect(result.credentialOffer).toBe(
        `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(result.credentialOfferUri)}`
      );
      expect(result.expiresAt - before).toBeGreaterThanOrEqual(300_000);
      expect(result.expiresAt - Date.now()).toBeLessThanOrEqual(300_000);

      const stored = createOfferRpc.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(stored).toMatchObject({
        tenantId: 'tenant-a',
        userId: 'admin-1',
        subjectKind: 'admin',
        credentialConfigurationId: 'AuthrimAdminCredential',
        credentialProfileId: 'admin',
        credentialProfileVersion: 1,
        mappingVersionId: 'admin',
        claims: {},
      });
      // No email or name travels with the offer; only hashes of the one-time secrets are stored.
      expect(JSON.stringify(stored)).not.toMatch(/email|"name"/);
      expect(stored.txCodeHash).toEqual(expect.any(String));
      expect(stored.txCodeHash).not.toBe(result.transactionCode);
      expect(stored.claimManifestHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('rejects an insecure issuer, a bad tenant or an unsafe admin id before storing anything', async () => {
      const entrypoint = createEntrypoint();
      await expect(
        entrypoint.createAdminCredentialOffer({
          ...adminInput(),
          credentialIssuer: 'http://x.example',
        })
      ).rejects.toThrow('invalid_credential_issuer');
      await expect(
        entrypoint.createAdminCredentialOffer({ ...adminInput(), tenantId: '../etc' })
      ).rejects.toThrow('invalid_tenant_id');
      await expect(
        entrypoint.createAdminCredentialOffer({ ...adminInput(), adminUserId: ' ' })
      ).rejects.toThrow('invalid_admin_user_id');
      expect(createOfferRpc).not.toHaveBeenCalled();
    });
  });

  describe('getAdminCredentialOfferStatus', () => {
    const query = {
      tenantId: 'tenant-a',
      adminUserId: 'admin-1',
      offerId: 'g1:apac:0:co_12345678-1234-1234-1234-123456789abc',
    };

    beforeEach(() => {
      mocks.getAdminOfferProgressRpc.mockReset();
      mocks.getById.mockReset().mockReturnValue({
        stub: { getAdminOfferProgressRpc: mocks.getAdminOfferProgressRpc },
        resolution: { generation: 1, regionKey: 'apac', shardIndex: 0 },
      });
    });

    it('asks the offer store for exactly this tenant and admin and relays the state', async () => {
      mocks.getAdminOfferProgressRpc.mockResolvedValue({
        offerId: query.offerId,
        state: 'issued',
        expiresAt: 123,
        holderKeyThumbprint: 'thumb',
      });
      await expect(createEntrypoint().getAdminCredentialOfferStatus(query)).resolves.toEqual({
        offerId: query.offerId,
        state: 'issued',
        expiresAt: 123,
        holderKeyThumbprint: 'thumb',
      });
      expect(mocks.getAdminOfferProgressRpc).toHaveBeenCalledWith({
        id: query.offerId,
        tenantId: 'tenant-a',
        userId: 'admin-1',
        now: expect.any(Number) as number,
      });
    });

    it('returns null for an offer id naming an unconfigured shard without calling a store', async () => {
      vi.mocked(isConfiguredShard).mockResolvedValueOnce(false);
      await expect(createEntrypoint().getAdminCredentialOfferStatus(query)).resolves.toBeNull();
      expect(mocks.getAdminOfferProgressRpc).not.toHaveBeenCalled();
    });

    it('returns null for an offer of another admin or tenant, and for a malformed offer id', async () => {
      mocks.getAdminOfferProgressRpc.mockResolvedValue(null);
      await expect(createEntrypoint().getAdminCredentialOfferStatus(query)).resolves.toBeNull();

      mocks.getById.mockImplementation(() => {
        throw new Error('Invalid region-sharded credential offer ID format');
      });
      await expect(
        createEntrypoint().getAdminCredentialOfferStatus({ ...query, offerId: 'nope' })
      ).resolves.toBeNull();
    });
  });
});

describe('VC issuer RPC source guard', () => {
  it('refuses offer creation before resolving or writing a Durable Object when admission is unavailable', async () => {
    getStore.mockClear();
    createOfferRpc.mockClear();
    const entrypoint = new VCIssuerEntrypoint(
      {} as ExecutionContext,
      { ENABLE_SAML_DR_EXPORT: 'true' } as Env
    );
    await expect(entrypoint.createCredentialOffer(validInput())).rejects.toThrow(
      'saml_dr_writer_unavailable'
    );
    expect(getStore).not.toHaveBeenCalled();
    expect(createOfferRpc).not.toHaveBeenCalled();
  });

  it('applies the same admission guard to the admin offer methods', async () => {
    getStore.mockClear();
    createOfferRpc.mockClear();
    const entrypoint = new VCIssuerEntrypoint(
      {} as ExecutionContext,
      { ENABLE_SAML_DR_EXPORT: 'true' } as Env
    );
    await expect(
      entrypoint.createAdminCredentialOffer({
        tenantId: 'tenant-a',
        adminUserId: 'admin-1',
        credentialIssuer: 'https://tenant-a.example.com',
      })
    ).rejects.toThrow('saml_dr_writer_unavailable');
    await expect(
      entrypoint.getAdminCredentialOfferStatus({
        tenantId: 'tenant-a',
        adminUserId: 'admin-1',
        offerId: 'g1:apac:0:co_12345678-1234-1234-1234-123456789abc',
      })
    ).rejects.toThrow('saml_dr_writer_unavailable');
    expect(getStore).not.toHaveBeenCalled();
    expect(createOfferRpc).not.toHaveBeenCalled();
  });
});
