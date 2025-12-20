/**
 * Attribute Mapper Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractNormalizedAttributes,
  storeUserVerifiedAttributes,
  getUserVerifiedAttributes,
  hasVerifiedAttribute,
  linkVerificationToUser,
} from '../attribute-mapper';
import type { VPVerificationResult, VPRequestState } from '../../../types';
import type {
  UserVerifiedAttributeRepository,
  AttributeVerificationRepository,
  UserVerifiedAttribute,
} from '@authrim/shared';

// Create mock UserVerifiedAttributeRepository
const createMockAttributeRepo = (
  existingAttributes?: UserVerifiedAttribute[]
): UserVerifiedAttributeRepository => {
  // Convert array to Record<string, string> for getValidAttributesForUser
  const attributesRecord: Record<string, string> = {};
  if (existingAttributes) {
    for (const attr of existingAttributes) {
      attributesRecord[attr.attribute_name] = attr.attribute_value;
    }
  }

  return {
    upsertAttribute: vi
      .fn()
      .mockImplementation(async (data: { id?: string; [key: string]: unknown }) => {
        const id = data.id || crypto.randomUUID();
        return { id, ...data } as UserVerifiedAttribute;
      }),
    getValidAttributesForUser: vi.fn().mockImplementation(async () => {
      return attributesRecord;
    }),
    getAttribute: vi.fn().mockImplementation(async (_tenantId, _userId, attrName) => {
      const found = existingAttributes?.find((a) => a.attribute_name === attrName);
      return found || null;
    }),
    hasAttribute: vi
      .fn()
      .mockImplementation(async (_tenantId, _userId, attrName, expectedValue) => {
        const found = existingAttributes?.find((a) => a.attribute_name === attrName);
        if (!found) return false;
        if (expectedValue !== undefined) {
          return found.attribute_value === expectedValue;
        }
        return true;
      }),
    deleteAttribute: vi.fn().mockResolvedValue(undefined),
    deleteAllForUser: vi.fn().mockResolvedValue(undefined),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as UserVerifiedAttributeRepository;
};

// Create mock AttributeVerificationRepository
const createMockVerificationRepo = (): AttributeVerificationRepository => {
  return {
    createVerification: vi
      .fn()
      .mockImplementation(async (data: { id?: string; [key: string]: unknown }) => {
        const id = data.id || crypto.randomUUID();
        return { id, ...data };
      }),
    findByUser: vi.fn().mockResolvedValue([]),
    linkToUser: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({ total: 0, verified: 0, failed: 0 }),
    findById: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as AttributeVerificationRepository;
};

describe('extractNormalizedAttributes', () => {
  it('should extract and normalize simple claims', () => {
    const claims = {
      given_name: 'John',
      family_name: 'Doe',
      email: 'john@example.com',
    };

    const attributes = extractNormalizedAttributes(claims);

    expect(attributes).toHaveLength(3);
    expect(attributes).toContainEqual({
      name: 'verified_given_name',
      value: 'John',
      originalClaim: 'given_name',
    });
    expect(attributes).toContainEqual({
      name: 'verified_family_name',
      value: 'Doe',
      originalClaim: 'family_name',
    });
    expect(attributes).toContainEqual({
      name: 'verified_email',
      value: 'john@example.com',
      originalClaim: 'email',
    });
  });

  it('should normalize boolean age claims', () => {
    const claims = {
      age_over_18: true,
      age_over_21: false,
    };

    const attributes = extractNormalizedAttributes(claims);

    expect(attributes).toHaveLength(2);
    expect(attributes).toContainEqual({
      name: 'verified_age_over_18',
      value: 'true',
      originalClaim: 'age_over_18',
    });
    expect(attributes).toContainEqual({
      name: 'verified_age_over_21',
      value: 'false',
      originalClaim: 'age_over_21',
    });
  });

  it('should handle string boolean values', () => {
    const claims = {
      age_over_18: 'true',
      age_over_21: 'false',
    };

    const attributes = extractNormalizedAttributes(claims);

    expect(attributes).toContainEqual({
      name: 'verified_age_over_18',
      value: 'true',
      originalClaim: 'age_over_18',
    });
    expect(attributes).toContainEqual({
      name: 'verified_age_over_21',
      value: 'false',
      originalClaim: 'age_over_21',
    });
  });

  it('should extract nested address claims', () => {
    const claims = {
      address: {
        country: 'JP',
        region: 'Tokyo',
        locality: 'Shibuya',
      },
    };

    const attributes = extractNormalizedAttributes(claims);

    expect(attributes).toHaveLength(3);
    expect(attributes).toContainEqual({
      name: 'verified_country',
      value: 'JP',
      originalClaim: 'address.country',
    });
    expect(attributes).toContainEqual({
      name: 'verified_region',
      value: 'Tokyo',
      originalClaim: 'address.region',
    });
    expect(attributes).toContainEqual({
      name: 'verified_locality',
      value: 'Shibuya',
      originalClaim: 'address.locality',
    });
  });

  it('should skip null and undefined values', () => {
    const claims = {
      given_name: 'John',
      family_name: null,
      email: undefined,
    };

    const attributes = extractNormalizedAttributes(claims);

    expect(attributes).toHaveLength(1);
    expect(attributes[0].name).toBe('verified_given_name');
  });

  it('should skip unmapped claims (data minimization)', () => {
    const claims = {
      given_name: 'John',
      unknown_claim: 'should be skipped',
      random_data: 12345,
    };

    const attributes = extractNormalizedAttributes(claims);

    expect(attributes).toHaveLength(1);
    expect(attributes[0].name).toBe('verified_given_name');
  });

  it('should handle flat country claim', () => {
    const claims = {
      country: 'US',
    };

    const attributes = extractNormalizedAttributes(claims);

    expect(attributes).toHaveLength(1);
    expect(attributes).toContainEqual({
      name: 'verified_country',
      value: 'US',
      originalClaim: 'country',
    });
  });

  it('should return empty array for empty claims', () => {
    const attributes = extractNormalizedAttributes({});
    expect(attributes).toHaveLength(0);
  });
});

describe('storeUserVerifiedAttributes', () => {
  let mockAttributeRepo: UserVerifiedAttributeRepository;

  beforeEach(() => {
    mockAttributeRepo = createMockAttributeRepo();
  });

  it('should store extracted attributes to database', async () => {
    const verificationResult: VPVerificationResult = {
      verified: true,
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
      errors: [],
      warnings: [],
      haipCompliant: true,
      issuerDid: 'did:web:issuer.example.com',
      disclosedClaims: {
        given_name: 'John',
        family_name: 'Doe',
        age_over_18: true,
      },
    };

    const result = await storeUserVerifiedAttributes(
      mockAttributeRepo,
      'user-123',
      'tenant-1',
      verificationResult,
      'verification-id-1'
    );

    expect(result.success).toBe(true);
    expect(result.attributes).toHaveLength(3);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockAttributeRepo.upsertAttribute).toHaveBeenCalledTimes(3);
  });

  it('should return empty result for empty claims', async () => {
    const verificationResult: VPVerificationResult = {
      verified: true,
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
      errors: [],
      warnings: [],
      haipCompliant: true,
      disclosedClaims: {},
    };

    const result = await storeUserVerifiedAttributes(
      mockAttributeRepo,
      'user-123',
      'tenant-1',
      verificationResult,
      'verification-id-1'
    );

    expect(result.success).toBe(true);
    expect(result.attributes).toHaveLength(0);
    expect(result.attributeIds).toHaveLength(0);
  });

  it('should handle repository errors gracefully', async () => {
    (mockAttributeRepo.upsertAttribute as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database error')
    );

    const verificationResult: VPVerificationResult = {
      verified: true,
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
      errors: [],
      warnings: [],
      haipCompliant: true,
      disclosedClaims: {
        given_name: 'John',
      },
    };

    const result = await storeUserVerifiedAttributes(
      mockAttributeRepo,
      'user-123',
      'tenant-1',
      verificationResult,
      'verification-id-1'
    );

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Database error');
  });
});

describe('getUserVerifiedAttributes', () => {
  it('should return attributes from database', async () => {
    const mockAttributeRepo = createMockAttributeRepo([
      {
        id: 'attr-1',
        tenant_id: 'tenant-1',
        user_id: 'user-123',
        attribute_name: 'verified_age_over_18',
        attribute_value: 'true',
        source_type: 'vc',
        issuer_did: 'did:web:issuer.com',
        verification_id: 'ver-1',
        verified_at: Date.now(),
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
      {
        id: 'attr-2',
        tenant_id: 'tenant-1',
        user_id: 'user-123',
        attribute_name: 'verified_country',
        attribute_value: 'JP',
        source_type: 'vc',
        issuer_did: 'did:web:issuer.com',
        verification_id: 'ver-1',
        verified_at: Date.now(),
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);

    const attributes = await getUserVerifiedAttributes(mockAttributeRepo, 'user-123', 'tenant-1');

    expect(attributes).toEqual({
      verified_age_over_18: 'true',
      verified_country: 'JP',
    });
  });

  it('should return empty object when no attributes found', async () => {
    const mockAttributeRepo = createMockAttributeRepo([]);

    const attributes = await getUserVerifiedAttributes(mockAttributeRepo, 'user-123', 'tenant-1');

    expect(attributes).toEqual({});
  });
});

describe('hasVerifiedAttribute', () => {
  it('should return true when attribute exists', async () => {
    const mockAttributeRepo = createMockAttributeRepo([
      {
        id: 'attr-1',
        tenant_id: 'tenant-1',
        user_id: 'user-123',
        attribute_name: 'verified_age_over_18',
        attribute_value: 'true',
        source_type: 'vc',
        issuer_did: null,
        verification_id: null,
        verified_at: Date.now(),
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);

    const result = await hasVerifiedAttribute(
      mockAttributeRepo,
      'user-123',
      'tenant-1',
      'verified_age_over_18'
    );

    expect(result).toBe(true);
  });

  it('should return false when attribute does not exist', async () => {
    const mockAttributeRepo = createMockAttributeRepo([]);

    const result = await hasVerifiedAttribute(
      mockAttributeRepo,
      'user-123',
      'tenant-1',
      'verified_age_over_18'
    );

    expect(result).toBe(false);
  });

  it('should check expected value when provided', async () => {
    const mockAttributeRepo = createMockAttributeRepo([
      {
        id: 'attr-1',
        tenant_id: 'tenant-1',
        user_id: 'user-123',
        attribute_name: 'verified_age_over_18',
        attribute_value: 'true',
        source_type: 'vc',
        issuer_did: null,
        verification_id: null,
        verified_at: Date.now(),
        expires_at: null,
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    ]);

    const resultMatch = await hasVerifiedAttribute(
      mockAttributeRepo,
      'user-123',
      'tenant-1',
      'verified_age_over_18',
      'true'
    );
    expect(resultMatch).toBe(true);

    const resultNoMatch = await hasVerifiedAttribute(
      mockAttributeRepo,
      'user-123',
      'tenant-1',
      'verified_age_over_18',
      'false'
    );
    expect(resultNoMatch).toBe(false);
  });
});

describe('linkVerificationToUser', () => {
  let mockVerificationRepo: AttributeVerificationRepository;
  let mockAttributeRepo: UserVerifiedAttributeRepository;

  beforeEach(() => {
    mockVerificationRepo = createMockVerificationRepo();
    mockAttributeRepo = createMockAttributeRepo();
  });

  it('should store verification record and attributes', async () => {
    const vpRequest: VPRequestState = {
      id: 'vp-request-1',
      clientId: 'client-1',
      tenantId: 'tenant-1',
      nonce: 'nonce-123',
      status: 'pending',
      responseUri: 'https://example.com/response',
      responseMode: 'direct_post',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    const verificationResult: VPVerificationResult = {
      verified: true,
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
      errors: [],
      warnings: [],
      haipCompliant: true,
      issuerDid: 'did:web:issuer.example.com',
      credentialType: 'https://example.com/credentials/identity/v1',
      format: 'dc+sd-jwt',
      disclosedClaims: {
        age_over_18: true,
        country: 'JP',
      },
    };

    const result = await linkVerificationToUser(
      mockVerificationRepo,
      mockAttributeRepo,
      vpRequest,
      verificationResult,
      'user-123'
    );

    expect(result.success).toBe(true);
    expect(result.attributes).toHaveLength(2);
    // Verification record created once
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockVerificationRepo.createVerification).toHaveBeenCalledTimes(1);
    // Two attributes upserted
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockAttributeRepo.upsertAttribute).toHaveBeenCalledTimes(2);
  });

  it('should store verification record even with no claims', async () => {
    const vpRequest: VPRequestState = {
      id: 'vp-request-1',
      clientId: 'client-1',
      tenantId: 'tenant-1',
      nonce: 'nonce-123',
      status: 'pending',
      responseUri: 'https://example.com/response',
      responseMode: 'direct_post',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    const verificationResult: VPVerificationResult = {
      verified: true,
      holderBindingVerified: true,
      issuerTrusted: true,
      statusValid: true,
      errors: [],
      warnings: [],
      haipCompliant: true,
      disclosedClaims: {},
    };

    const result = await linkVerificationToUser(
      mockVerificationRepo,
      mockAttributeRepo,
      vpRequest,
      verificationResult,
      'user-123'
    );

    expect(result.success).toBe(true);
    expect(result.attributes).toHaveLength(0);
    // Only verification record is stored
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockVerificationRepo.createVerification).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(mockAttributeRepo.upsertAttribute).not.toHaveBeenCalled();
  });
});
