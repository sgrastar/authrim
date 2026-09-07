import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@cloudflare/workers-types';
import type { CreateCredentialOfferServiceInput } from '@authrim/ar-lib-core';
import { VCIssuerEntrypoint } from '../VCIssuerEntrypoint';
import type { Env } from '../../types';

type GetStore =
  (typeof import('../../utils/credential-offer-sharding'))['getCredentialOfferStoreForNewOffer'];
const mocks = vi.hoisted(() => ({
  createOfferRpc: vi.fn(),
  getStore: vi.fn(),
}));
const createOfferRpc = mocks.createOfferRpc;
const getStore = mocks.getStore as ReturnType<typeof vi.fn<GetStore>>;

vi.mock('../../utils/credential-offer-sharding', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/credential-offer-sharding')>();
  return {
    ...original,
    getCredentialOfferStoreForNewOffer: mocks.getStore,
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
      stub: { createOfferRpc },
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
});
