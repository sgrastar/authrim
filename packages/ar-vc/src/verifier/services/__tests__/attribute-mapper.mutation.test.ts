/**
 * Attribute mapper: exact repository calls and records.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VPRequestState, VPVerificationResult } from '../../../types';

const h = vi.hoisted(() => {
  const logger = { module: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  logger.module.mockReturnValue(logger);
  return { logger };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return { ...actual, createLogger: vi.fn(() => h.logger) };
});

import {
  deleteAllUserVerifiedAttributes,
  deleteUserVerifiedAttribute,
  getUserVerifiedAttributes,
  hasVerifiedAttribute,
  linkVerificationToUser,
  storeUserVerifiedAttributes,
  type AttributePersistencePolicy,
} from '../attribute-mapper';

const loggerModuleNames = h.logger.module.mock.calls.map((call): unknown => call[0]);

const attributeRepo = {
  upsertAttribute: vi.fn(),
  getValidAttributesForUser: vi.fn(),
  hasAttribute: vi.fn(),
  deleteAttribute: vi.fn(),
  deleteAllForUser: vi.fn(),
};
const verificationRepo = { createVerification: vi.fn() };
const attrs = attributeRepo as never;
const verifications = verificationRepo as never;

const policy: AttributePersistencePolicy = {
  attributes: [
    { name: 'age_over_18', value: 'true', originalClaim: 'age' },
    { name: 'country', value: 'JP', originalClaim: 'c' },
  ],
  expiresAt: 2000,
  revalidateAfter: 1500,
  credentialProfileId: 'profile-1',
  credentialProfileVersionId: 'profile-v1',
  mappingVersionId: 'map-v1',
  mappingSnapshotHash: 'hash-1',
  policyVersion: 'policy-1',
  evidenceFingerprint: 'fp-1',
  statusCheckedAt: 1000,
  statusFreshUntil: 1300,
};

const verified: VPVerificationResult = {
  verified: true,
  issuerDid: 'did:web:issuer.example',
  credentialType: 'vct-1',
  format: 'dc+sd-jwt',
  holderBindingVerified: true,
  issuerTrusted: true,
  statusValid: true,
  errors: [],
  warnings: [],
  haipCompliant: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.logger.module.mockReturnValue(h.logger);
  let counter = 0;
  attributeRepo.upsertAttribute.mockImplementation(async () => ({ id: `attr-${++counter}` }));
});

describe('storeUserVerifiedAttributes', () => {
  it('names its logger module', () => {
    expect(loggerModuleNames).toContain('VC-ATTR-MAPPER');
  });

  it('stores nothing without a policy or without mapped attributes', async () => {
    const empty = { success: true, attributeIds: [], attributes: [], errors: [] };
    expect(await storeUserVerifiedAttributes(attrs, 'u', 't', verified, 'v-1')).toEqual(empty);
    expect(
      await storeUserVerifiedAttributes(attrs, 'u', 't', verified, 'v-1', {
        ...policy,
        attributes: [],
      })
    ).toEqual(empty);
    expect(attributeRepo.upsertAttribute).not.toHaveBeenCalled();
  });

  it('upserts every mapped attribute with the issuer, verification and expiry', async () => {
    const result = await storeUserVerifiedAttributes(attrs, 'u-1', 't-1', verified, 'v-1', policy);
    expect(result).toEqual({
      success: true,
      attributeIds: ['attr-1', 'attr-2'],
      attributes: policy.attributes,
      errors: [],
    });
    expect(attributeRepo.upsertAttribute).toHaveBeenNthCalledWith(1, {
      tenant_id: 't-1',
      user_id: 'u-1',
      attribute_name: 'age_over_18',
      attribute_value: 'true',
      source_type: 'vc',
      issuer_did: 'did:web:issuer.example',
      verification_id: 'v-1',
      expires_at: 2000,
      revalidate_after: 1500,
    });
    expect(attributeRepo.upsertAttribute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ attribute_name: 'country', attribute_value: 'JP' })
    );
  });

  it('records an empty issuer and null times when the result and policy have none', async () => {
    await storeUserVerifiedAttributes(attrs, 'u', 't', { ...verified, issuerDid: undefined }, 'v', {
      ...policy,
      expiresAt: undefined,
      revalidateAfter: undefined,
    } as never);
    expect(attributeRepo.upsertAttribute).toHaveBeenCalledWith(
      expect.objectContaining({ issuer_did: '', expires_at: null, revalidate_after: null })
    );
  });

  it('reports a failed attribute by name only and keeps storing the others', async () => {
    attributeRepo.upsertAttribute
      .mockRejectedValueOnce(new Error('db secret detail'))
      .mockResolvedValueOnce({ id: 'attr-9' });
    const result = await storeUserVerifiedAttributes(attrs, 'u', 't', verified, 'v', policy);
    expect(result).toEqual({
      success: false,
      attributeIds: ['attr-9'],
      attributes: policy.attributes,
      errors: ['Failed to store attribute age_over_18'],
    });
    expect(h.logger.error).toHaveBeenCalledWith(
      'Failed to store verified attribute',
      { attributeName: 'age_over_18' },
      expect.objectContaining({ message: 'db secret detail' })
    );
  });
});

describe('repository pass-throughs', () => {
  it('reads valid attributes of the user in the tenant', async () => {
    attributeRepo.getValidAttributesForUser.mockResolvedValue({ a: 'b' });
    expect(await getUserVerifiedAttributes(attrs, 'u', 't')).toEqual({ a: 'b' });
    expect(attributeRepo.getValidAttributesForUser).toHaveBeenCalledWith('t', 'u');
  });

  it('checks one attribute, with and without an expected value', async () => {
    attributeRepo.hasAttribute.mockResolvedValue(true);
    expect(await hasVerifiedAttribute(attrs, 'u', 't', 'age')).toBe(true);
    expect(attributeRepo.hasAttribute).toHaveBeenLastCalledWith('t', 'u', 'age', undefined);
    attributeRepo.hasAttribute.mockResolvedValue(false);
    expect(await hasVerifiedAttribute(attrs, 'u', 't', 'age', 'true')).toBe(false);
    expect(attributeRepo.hasAttribute).toHaveBeenLastCalledWith('t', 'u', 'age', 'true');
  });

  it('deletes one attribute or all attributes of a user in the tenant', async () => {
    await deleteUserVerifiedAttribute(attrs, 'u', 't', 'age');
    expect(attributeRepo.deleteAttribute).toHaveBeenCalledWith('t', 'u', 'age');
    await deleteAllUserVerifiedAttributes(attrs, 'u', 't');
    expect(attributeRepo.deleteAllForUser).toHaveBeenCalledWith('t', 'u');
  });
});

describe('linkVerificationToUser', () => {
  const request = { id: 'vp-1', tenantId: 'tenant-1' } as unknown as VPRequestState;

  beforeEach(() => {
    verificationRepo.createVerification.mockResolvedValue({ id: 'verification-1' });
  });

  it('records the verification with the policy evidence and stores under its id', async () => {
    const result = await linkVerificationToUser(
      verifications,
      attrs,
      request,
      verified,
      'user-1',
      policy
    );
    expect(verificationRepo.createVerification).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      vp_request_id: 'vp-1',
      issuer_did: 'did:web:issuer.example',
      credential_type: 'vct-1',
      format: 'dc+sd-jwt',
      verification_result: 'verified',
      holder_binding_verified: true,
      issuer_trusted: true,
      status_valid: true,
      credential_profile_id: 'profile-1',
      credential_profile_version_id: 'profile-v1',
      mapping_version_id: 'map-v1',
      mapping_snapshot_hash: 'hash-1',
      policy_version: 'policy-1',
      evidence_fingerprint: 'fp-1',
      status_checked_at: 1000,
      status_fresh_until: 1300,
      revalidate_after: 1500,
      expires_at: 2000,
    });
    expect(result.attributeIds).toEqual(['attr-1', 'attr-2']);
    expect(attributeRepo.upsertAttribute).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-1', verification_id: 'verification-1' })
    );
  });

  it('defaults missing facts to failed and false without a policy', async () => {
    const result = await linkVerificationToUser(
      verifications,
      attrs,
      request,
      {
        verified: false,
        errors: [],
        warnings: [],
        haipCompliant: false,
      } as unknown as VPVerificationResult,
      'user-1'
    );
    expect(verificationRepo.createVerification).toHaveBeenCalledWith({
      tenant_id: 'tenant-1',
      user_id: 'user-1',
      vp_request_id: 'vp-1',
      issuer_did: '',
      credential_type: '',
      format: 'dc+sd-jwt',
      verification_result: 'failed',
      holder_binding_verified: false,
      issuer_trusted: false,
      status_valid: false,
      credential_profile_id: undefined,
      credential_profile_version_id: undefined,
      mapping_version_id: undefined,
      mapping_snapshot_hash: undefined,
      policy_version: undefined,
      evidence_fingerprint: undefined,
      status_checked_at: undefined,
      status_fresh_until: undefined,
      revalidate_after: undefined,
      expires_at: undefined,
    });
    expect(result).toEqual({ success: true, attributeIds: [], attributes: [], errors: [] });
  });

  it('records a verified result as failed when a fact is false', async () => {
    await linkVerificationToUser(
      verifications,
      attrs,
      request,
      {
        ...verified,
        verified: false,
        holderBindingVerified: false,
        issuerTrusted: false,
        statusValid: false,
      },
      'user-1'
    );
    expect(verificationRepo.createVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        verification_result: 'failed',
        holder_binding_verified: false,
        issuer_trusted: false,
        status_valid: false,
      })
    );
  });
});
