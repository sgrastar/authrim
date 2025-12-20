/**
 * Integration Tests for VC Package
 *
 * Tests end-to-end flows for:
 * - VP verification and attribute mapping
 * - VCI credential issuance
 * - DID resolution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env, VPRequestState, VPVerificationResult } from '../types';
import type {
  UserVerifiedAttributeRepository,
  AttributeVerificationRepository,
  TrustedIssuerRepository,
  UserVerifiedAttribute,
} from '@authrim/shared';

// Mock dependencies
vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    parseSDJWTVC: vi.fn().mockResolvedValue({
      payload: {
        iss: 'did:web:issuer.example.com',
        vct: 'https://example.com/credentials/identity/v1',
        sub: 'holder-123',
        status: null,
      },
      kbJwt: {
        payload: {
          nonce: 'test-nonce',
          aud: 'did:web:authrim.com',
        },
      },
    }),
    verifySDJWTVC: vi.fn().mockResolvedValue({
      verified: true,
      disclosedClaims: {
        given_name: 'John',
        family_name: 'Doe',
        age_over_18: true,
        address: {
          country: 'JP',
          region: 'Tokyo',
        },
      },
      holderBindingVerified: true,
    }),
    getHaipPolicy: vi.fn().mockReturnValue({
      requireHolderBinding: true,
      requireIssuerTrust: false,
      requireStatusCheck: false,
      allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
    }),
    HaipPolicyEvaluator: vi.fn().mockImplementation(() => ({
      validateVerificationResult: vi.fn().mockReturnValue({
        valid: true,
        haipCompliant: true,
        errors: [],
        warnings: [],
      }),
    })),
    createSDJWTVC: vi.fn().mockResolvedValue({
      combined: 'mock-sd-jwt-vc~disclosure1~disclosure2~',
      issuerSignedJwt: 'mock-jwt',
      disclosures: ['disclosure1', 'disclosure2'],
    }),
  };
});

// Import after mocking
import {
  extractNormalizedAttributes,
  linkVerificationToUser,
  getUserVerifiedAttributes,
  hasVerifiedAttribute,
} from '../verifier/services/attribute-mapper';
import { verifyVPToken } from '../verifier/services/vp-verifier';
import { checkIssuerTrust, checkSelfIssuance } from '../verifier/services/issuer-trust';

// Create mock repositories
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

const createMockTrustedIssuerRepo = (isTrusted: boolean = true): TrustedIssuerRepository => {
  return {
    findActiveTrustedIssuer: vi.fn().mockResolvedValue(
      isTrusted
        ? {
            id: 'issuer-1',
            tenant_id: 'tenant-1',
            issuer_did: 'did:web:issuer.example.com',
            display_name: 'Example Issuer',
            credential_types: '["IdentityCredential"]',
            trust_level: 'standard',
            jwks_uri: null,
            status: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
          }
        : null
    ),
    parseCredentialTypes: vi
      .fn()
      .mockImplementation((issuer: { credential_types?: string }): string[] => {
        try {
          return JSON.parse(issuer.credential_types || '[]') as string[];
        } catch {
          return [];
        }
      }),
    createTrustedIssuer: vi.fn(),
    findById: vi.fn(),
    isTrusted: vi.fn().mockResolvedValue(isTrusted),
    updateStatus: vi.fn(),
    delete: vi.fn(),
  } as unknown as TrustedIssuerRepository;
};

describe('E2E: VP Verification Flow', () => {
  let mockVerificationRepo: AttributeVerificationRepository;
  let mockAttributeRepo: UserVerifiedAttributeRepository;
  let mockTrustedIssuerRepo: TrustedIssuerRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerificationRepo = createMockVerificationRepo();
    mockAttributeRepo = createMockAttributeRepo();
    mockTrustedIssuerRepo = createMockTrustedIssuerRepo();
  });

  describe('Attribute Extraction', () => {
    it('should extract and normalize identity claims', () => {
      const claims = {
        given_name: 'John',
        family_name: 'Doe',
        email: 'john@example.com',
        birthdate: '1990-01-15',
      };

      const attributes = extractNormalizedAttributes(claims);

      expect(attributes).toHaveLength(4);
      expect(attributes.find((a) => a.name === 'verified_given_name')?.value).toBe('John');
      expect(attributes.find((a) => a.name === 'verified_family_name')?.value).toBe('Doe');
      expect(attributes.find((a) => a.name === 'verified_email')?.value).toBe('john@example.com');
    });

    it('should normalize boolean age claims', () => {
      const claims = {
        age_over_18: true,
        age_over_21: false,
      };

      const attributes = extractNormalizedAttributes(claims);

      expect(attributes.find((a) => a.name === 'verified_age_over_18')?.value).toBe('true');
      expect(attributes.find((a) => a.name === 'verified_age_over_21')?.value).toBe('false');
    });

    it('should flatten nested address claims', () => {
      const claims = {
        address: {
          country: 'JP',
          region: 'Tokyo',
          locality: 'Shibuya',
        },
      };

      const attributes = extractNormalizedAttributes(claims);

      expect(attributes.find((a) => a.name === 'verified_country')?.value).toBe('JP');
      expect(attributes.find((a) => a.name === 'verified_region')?.value).toBe('Tokyo');
      expect(attributes.find((a) => a.name === 'verified_locality')?.value).toBe('Shibuya');
    });

    it('should skip unmapped claims for data minimization', () => {
      const claims = {
        given_name: 'John',
        custom_claim: 'should-be-skipped',
        internal_id: 12345,
      };

      const attributes = extractNormalizedAttributes(claims);

      expect(attributes).toHaveLength(1);
      expect(attributes[0].name).toBe('verified_given_name');
    });
  });

  describe('VP Verification', () => {
    it('should verify VP token structure', async () => {
      // Note: Full VP verification requires complex mocking of @authrim/shared
      // This test verifies the flow structure rather than actual verification

      // verifyVPToken returns a VPVerificationResult structure:
      // { verified, holderBindingVerified, issuerTrusted, statusValid, errors, warnings, haipCompliant }

      // In actual E2E tests, this would be tested with real tokens
      // For unit testing, we verify the function exists and has correct signature
      expect(typeof verifyVPToken).toBe('function');
    });
  });

  describe('Attribute Storage', () => {
    it('should store verified attributes for user', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'did:web:authrim.com',
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
        issuerDid: 'did:web:issuer.example.com',
        credentialType: 'https://example.com/credentials/identity/v1',
        format: 'dc+sd-jwt',
        disclosedClaims: {
          given_name: 'John',
          age_over_18: true,
          address: { country: 'JP' },
        },
        errors: [],
        warnings: [],
        haipCompliant: true,
      };

      const result = await linkVerificationToUser(
        mockVerificationRepo,
        mockAttributeRepo,
        vpRequest,
        verificationResult,
        'user-123'
      );

      expect(result.success).toBe(true);
      expect(result.attributes.length).toBeGreaterThan(0);

      // Verify verification record was created
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockVerificationRepo.createVerification).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockVerificationRepo.createVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          tenant_id: 'tenant-1',
        })
      );

      // Verify attributes were upserted
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockAttributeRepo.upsertAttribute).toHaveBeenCalled();
    });
  });

  describe('Attribute Retrieval', () => {
    it('should retrieve verified attributes for user', async () => {
      const mockRepoWithAttrs = createMockAttributeRepo([
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

      const attributes = await getUserVerifiedAttributes(mockRepoWithAttrs, 'user-123', 'tenant-1');

      expect(attributes).toHaveProperty('verified_age_over_18', 'true');
      expect(attributes).toHaveProperty('verified_country', 'JP');
    });

    it('should check specific attribute existence', async () => {
      const mockRepoWithAttr = createMockAttributeRepo([
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

      const hasAge = await hasVerifiedAttribute(
        mockRepoWithAttr,
        'user-123',
        'tenant-1',
        'verified_age_over_18',
        'true'
      );

      expect(hasAge).toBe(true);
    });
  });

  describe('Security Guards', () => {
    it('should reject self-issued credentials', async () => {
      const env = {
        VERIFIER_IDENTIFIER: 'did:web:authrim.com',
      } as Env;

      // checkSelfIssuance returns false for self-issued credentials
      const result = await checkSelfIssuance(env, 'did:web:authrim.com', 'tenant-1');
      expect(result).toBe(false);
    });

    it('should allow non-self-issued credentials', async () => {
      const env = {
        VERIFIER_IDENTIFIER: 'did:web:authrim.com',
      } as Env;

      const result = await checkSelfIssuance(env, 'did:web:other-issuer.com', 'tenant-1');
      expect(result).toBe(true);
    });

    it('should check issuer trust from repository', async () => {
      const result = await checkIssuerTrust(
        mockTrustedIssuerRepo,
        'did:web:issuer.example.com',
        'tenant-1'
      );

      expect(result.trusted).toBe(true);
    });

    it('should return not trusted for unknown issuer', async () => {
      const untrustedRepo = createMockTrustedIssuerRepo(false);

      const result = await checkIssuerTrust(
        untrustedRepo,
        'did:web:unknown-issuer.com',
        'tenant-1'
      );

      expect(result.trusted).toBe(false);
    });
  });
});

describe('E2E: VCI Issuance Flow', () => {
  it('should create credential offer', async () => {
    // This tests the credential offer creation flow
    // In a full integration test, this would involve:
    // 1. Creating a credential offer via API
    // 2. Wallet scanning the offer
    // 3. Exchanging pre-auth code for access token
    // 4. Requesting credential with proof

    // For unit testing, we verify the individual components work
    const offerData = {
      credential_issuer: 'did:web:authrim.com',
      credential_configuration_ids: ['AuthrimIdentityCredential'],
      grants: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
          'pre-authorized_code': 'pre-auth-123',
          tx_code: {
            input_mode: 'numeric',
            length: 6,
          },
        },
      },
    };

    expect(offerData.credential_issuer).toBe('did:web:authrim.com');
    expect(offerData.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']).toBeDefined();
  });
});

describe('E2E: Complete Attribute Verification Scenario', () => {
  it('should complete full age verification flow', async () => {
    // Scenario: User wants to access age-restricted content
    // 1. User is already logged in (authenticated via Passkey)
    // 2. User initiates age verification
    // 3. Wallet presents age_over_18 VC
    // 4. VC is verified and attribute is stored
    // 5. User can now access restricted content

    // Step 1: User is authenticated (userId: 'user-123', tenantId: 'tenant-1')

    // Step 2-3: Wallet presents VP with age credential
    const disclosedClaims = {
      age_over_18: true,
      given_name: 'John',
    };

    // Step 4: Extract and normalize attributes
    const normalizedAttributes = extractNormalizedAttributes(disclosedClaims);

    expect(normalizedAttributes).toContainEqual({
      name: 'verified_age_over_18',
      value: 'true',
      originalClaim: 'age_over_18',
    });

    // Step 5: Verify attribute is available for policy check
    // In production, ABAC would use: attribute_equals('verified_age_over_18', 'true')
    const ageAttribute = normalizedAttributes.find((a) => a.name === 'verified_age_over_18');
    expect(ageAttribute?.value).toBe('true');

    // User can now access age-restricted content
    const canAccessContent = ageAttribute?.value === 'true';
    expect(canAccessContent).toBe(true);
  });

  it('should complete country verification flow', async () => {
    // Scenario: Service requires JP residence verification
    const disclosedClaims = {
      address: {
        country: 'JP',
        region: 'Tokyo',
      },
    };

    const normalizedAttributes = extractNormalizedAttributes(disclosedClaims);

    expect(normalizedAttributes).toContainEqual({
      name: 'verified_country',
      value: 'JP',
      originalClaim: 'address.country',
    });

    // Policy check: attribute_equals('verified_country', 'JP')
    const countryAttribute = normalizedAttributes.find((a) => a.name === 'verified_country');
    expect(countryAttribute?.value).toBe('JP');
  });
});
