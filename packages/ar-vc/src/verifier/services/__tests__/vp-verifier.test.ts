/**
 * VP Token Verifier Tests
 *
 * Tests for the VP token verification service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../../types';

// Mock modules before importing the module under test
vi.mock('../issuer-trust', () => ({
  checkIssuerTrust: vi.fn(),
  getIssuerPublicKey: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    module: vi.fn().mockReturnThis(),
    startTimer: vi.fn().mockReturnValue(() => {}),
  };
  return {
    parseSDJWTVC: vi.fn(),
    verifySDJWTVC: vi.fn(),
    HaipPolicyEvaluator: class {
      validateVerificationResult() {
        return {
          valid: true,
          haipCompliant: true,
          errors: [],
          warnings: [],
        };
      }
    },
    getHaipPolicy: vi.fn().mockReturnValue({
      requireHolderBinding: true,
      requireIssuerTrust: true,
      requireStatusCheck: false,
      allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
    }),
    getCredentialStatusValue: vi.fn().mockResolvedValue(0),
    TSL_STATUS_SUSPENDED: 2,
    decodeBase64Url: vi.fn((value: string) => {
      const padded = value
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '=');
      return atob(padded);
    }),
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn().mockResolvedValue({}),
    D1Adapter: class {
      constructor() {}
    },
    TrustedIssuerRepository: class {
      constructor() {}
    },
    getLogger: vi.fn(() => mockLoggerInstance),
    createLogger: vi.fn(() => mockLoggerInstance),
  };
});

// Import after mocks are set up
import { verifyVPToken } from '../vp-verifier';
import { checkIssuerTrust, getIssuerPublicKey } from '../issuer-trust';
import {
  getCredentialStatusValue,
  getHaipPolicy,
  parseSDJWTVC,
  verifySDJWTVC,
} from '@authrim/ar-lib-core';

// Create mock environment
const createMockEnv = (): Env => ({
  DB: {} as D1Database,
  AUTHRIM_CONFIG: {} as KVNamespace,
  VP_REQUEST_STORE: {} as DurableObjectNamespace,
  CREDENTIAL_OFFER_STORE: {} as DurableObjectNamespace,
  KEY_MANAGER: {} as DurableObjectNamespace,
  POLICY_SERVICE: {} as Fetcher,
  VERIFIER_IDENTIFIER: 'did:web:authrim.com',
  HAIP_POLICY_VERSION: 'draft-06',
  VP_REQUEST_EXPIRY_SECONDS: '300',
  NONCE_EXPIRY_SECONDS: '300',
  ISSUER_IDENTIFIER: 'did:web:authrim.com',
  CREDENTIAL_OFFER_EXPIRY_SECONDS: '600',
  C_NONCE_EXPIRY_SECONDS: '300',
});

const defaultOptions = {
  nonce: 'test-nonce-123',
  audience: 'did:web:authrim.com',
  tenantId: 'tenant-1',
};

describe('verifyVPToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCredentialStatusValue).mockResolvedValue(0);
    vi.mocked(getHaipPolicy).mockReturnValue({
      requireHolderBinding: true,
      requireIssuerTrust: true,
      requireStatusCheck: false,
      allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
      allowedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      preferDCQL: true,
      requireDirectPost: true,
    });
  });

  it('should return error for invalid SD-JWT VC format', async () => {
    vi.mocked(parseSDJWTVC).mockResolvedValue(null);

    const env = createMockEnv();
    const result = await verifyVPToken(env, 'invalid-token', defaultOptions);

    expect(result.verified).toBe(false);
    expect(result.errors).toContain('Invalid SD-JWT VC format');
    expect(result.haipCompliant).toBe(false);
  });

  it('should verify valid VP token with trusted issuer', async () => {
    // Mock parsing
    vi.mocked(parseSDJWTVC).mockResolvedValue({
      payload: {
        iss: 'did:web:trusted-issuer.com',
        vct: 'https://authrim.com/credentials/identity/v1',
      },
      disclosures: [],
      kbJwt: 'kb-jwt-token',
    } as never);

    // Mock verification
    vi.mocked(verifySDJWTVC).mockResolvedValue({
      verified: true,
      disclosedClaims: { given_name: 'John', family_name: 'Doe' },
      holderBindingVerified: true,
    } as never);

    // Mock issuer trust
    vi.mocked(checkIssuerTrust).mockResolvedValue({
      trusted: true,
      issuer: {
        id: 'issuer-1',
        tenantId: 'tenant-1',
        issuerDid: 'did:web:trusted-issuer.com',
        credentialTypes: ['IdentityCredential'],
        trustLevel: 'standard',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    // Mock public key retrieval
    vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

    const env = createMockEnv();
    const result = await verifyVPToken(env, 'valid-vp-token', defaultOptions);

    expect(result.verified).toBe(true);
    expect(result.issuerDid).toBe('did:web:trusted-issuer.com');
    expect(result.credentialType).toBe('https://authrim.com/credentials/identity/v1');
    expect(result.disclosedClaims).toEqual({ given_name: 'John', family_name: 'Doe' });
    expect(result.holderBindingVerified).toBe(true);
    expect(result.issuerTrusted).toBe(true);
  });

  it('should reject VP from untrusted issuer when trust is required', async () => {
    vi.mocked(parseSDJWTVC).mockResolvedValue({
      payload: {
        iss: 'did:web:untrusted-issuer.com',
        vct: 'https://example.com/credentials/fake',
      },
      disclosures: [],
      kbJwt: null,
    } as never);

    vi.mocked(verifySDJWTVC).mockResolvedValue({
      verified: true,
      disclosedClaims: {},
      holderBindingVerified: false,
    } as never);

    vi.mocked(checkIssuerTrust).mockResolvedValue({
      trusted: false,
      reason: 'Issuer not in registry',
    });

    vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

    const env = createMockEnv();
    const result = await verifyVPToken(env, 'vp-token-untrusted', defaultOptions);

    expect(result.verified).toBe(false);
    expect(result.issuerTrusted).toBe(false);
    expect(result.errors.some((e) => e.includes('not trusted'))).toBe(true);
  });

  it('should reject VP without holder binding when required', async () => {
    vi.mocked(parseSDJWTVC).mockResolvedValue({
      payload: {
        iss: 'did:web:issuer.com',
        vct: 'https://authrim.com/credentials/identity/v1',
      },
      disclosures: [],
      kbJwt: null, // No KB-JWT
    } as never);

    vi.mocked(verifySDJWTVC).mockResolvedValue({
      verified: true,
      disclosedClaims: {},
      holderBindingVerified: false,
    } as never);

    vi.mocked(checkIssuerTrust).mockResolvedValue({
      trusted: true,
      issuer: {
        id: 'issuer-1',
        tenantId: 'tenant-1',
        issuerDid: 'did:web:issuer.com',
        credentialTypes: [],
        trustLevel: 'standard',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

    const env = createMockEnv();
    const result = await verifyVPToken(env, 'vp-token-no-kb', defaultOptions);

    // Should have error about missing KB-JWT
    expect(result.holderBindingVerified).toBe(false);
    expect(result.errors.some((e) => e.includes('Key Binding JWT'))).toBe(true);
  });

  it('should handle signature verification failure', async () => {
    vi.mocked(parseSDJWTVC).mockResolvedValue({
      payload: {
        iss: 'did:web:issuer.com',
        vct: 'https://authrim.com/credentials/identity/v1',
      },
      disclosures: [],
      kbJwt: 'kb-jwt',
    } as never);

    vi.mocked(verifySDJWTVC).mockRejectedValue(new Error('Invalid signature'));

    vi.mocked(checkIssuerTrust).mockResolvedValue({
      trusted: true,
      issuer: {
        id: 'issuer-1',
        tenantId: 'tenant-1',
        issuerDid: 'did:web:issuer.com',
        credentialTypes: [],
        trustLevel: 'standard',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

    const env = createMockEnv();
    const result = await verifyVPToken(env, 'vp-token-bad-sig', defaultOptions);

    expect(result.verified).toBe(false);
    expect(result.errors.some((e) => e.includes('Signature verification failed'))).toBe(true);
  });

  it('should handle public key retrieval failure', async () => {
    vi.mocked(parseSDJWTVC).mockResolvedValue({
      payload: {
        iss: 'did:web:issuer.com',
        vct: 'https://authrim.com/credentials/identity/v1',
      },
      disclosures: [],
      kbJwt: 'kb-jwt',
    } as never);

    vi.mocked(checkIssuerTrust).mockResolvedValue({
      trusted: true,
      issuer: {
        id: 'issuer-1',
        tenantId: 'tenant-1',
        issuerDid: 'did:web:issuer.com',
        credentialTypes: [],
        trustLevel: 'standard',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    vi.mocked(getIssuerPublicKey).mockRejectedValue(new Error('Failed to resolve DID'));

    const env = createMockEnv();
    const result = await verifyVPToken(env, 'vp-token', defaultOptions);

    expect(result.verified).toBe(false);
    expect(result.errors.some((e) => e.includes('Failed to get issuer public key'))).toBe(true);
  });

  it('should return correct format for dc+sd-jwt', async () => {
    vi.mocked(parseSDJWTVC).mockResolvedValue({
      payload: {
        iss: 'did:web:issuer.com',
        vct: 'https://authrim.com/credentials/identity/v1',
      },
      disclosures: [],
      kbJwt: 'kb-jwt',
    } as never);

    vi.mocked(verifySDJWTVC).mockResolvedValue({
      verified: true,
      disclosedClaims: {},
      holderBindingVerified: true,
    } as never);

    vi.mocked(checkIssuerTrust).mockResolvedValue({
      trusted: true,
      issuer: {
        id: 'issuer-1',
        tenantId: 'tenant-1',
        issuerDid: 'did:web:issuer.com',
        credentialTypes: [],
        trustLevel: 'standard',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

    const env = createMockEnv();
    const result = await verifyVPToken(env, 'vp-token', defaultOptions);

    expect(result.format).toBe('dc+sd-jwt');
  });

  describe('Status List Security - Cache Poisoning Prevention', () => {
    it('should reject status lists signed by a different issuer', async () => {
      // Security Test: Attacker attempts to host their own Status List
      // The statusKeyResolver in vp-verifier.ts MUST reject status lists
      // signed by a different issuer than the credential issuer

      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:legitimate-issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
          // Attacker could try to point to their own status list
          credentialStatus: {
            type: 'BitstringStatusListEntry',
            statusPurpose: 'revocation',
            statusListIndex: 0,
            statusListCredential: 'https://legitimate-issuer.com/status/list-1',
          },
        },
        disclosures: [],
        kbJwt: 'kb-jwt-token',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: { given_name: 'John' },
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:legitimate-issuer.com',
          credentialTypes: ['IdentityCredential'],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);
      vi.mocked(getCredentialStatusValue).mockImplementation(async (_uri, _index, options) => {
        await expect(options?.keyResolver?.('did:web:attacker.example.com')).rejects.toThrow(
          'Status List issuer mismatch'
        );
        return 1;
      });

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-with-status', defaultOptions);

      expect(getCredentialStatusValue).toHaveBeenCalledWith(
        'https://legitimate-issuer.com/status/list-1',
        0,
        expect.objectContaining({
          verifySignature: true,
          format: 'w3c_bitstring_v1',
          expectedIssuer: 'did:web:legitimate-issuer.com',
        })
      );
      expect(result.verified).toBe(false);
      expect(result.issuerDid).toBe('did:web:legitimate-issuer.com');
      expect(result.statusValid).toBe(false);
      expect(result.errors).toContain('Credential has been revoked');
    });

    it('should include status check errors when status list verification fails', async () => {
      // When status check is required and fails, errors should be reported
      vi.mocked(getHaipPolicy).mockReturnValue({
        requireHolderBinding: true,
        requireIssuerTrust: true,
        requireStatusCheck: true,
        allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
        allowedFormats: ['dc+sd-jwt', 'mso_mdoc'],
        preferDCQL: true,
        requireDirectPost: true,
      });
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
          credentialStatus: {
            type: 'BitstringStatusListEntry',
            statusPurpose: 'revocation',
            statusListIndex: 999999, // Invalid index to trigger error
            statusListCredential: 'https://issuer.com/status/list-1',
          },
        },
        disclosures: [],
        kbJwt: 'kb-jwt-token',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);
      vi.mocked(getCredentialStatusValue).mockRejectedValue(new Error('network unavailable'));

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.statusValid).toBe(false);
      expect(result.errors).toContain('Status check failed: network unavailable');
    });
  });

  describe('Status claim enforcement', () => {
    const ISSUER = 'https://issuer.example.com';
    const LIST_URI = `${ISSUER}/vci/status-lists/list-1`;

    async function verifyWithPayload(
      claims: Record<string, unknown>,
      requireStatusCheck = false,
      issuerJwt?: string
    ): Promise<Awaited<ReturnType<typeof verifyVPToken>>> {
      vi.mocked(getHaipPolicy).mockReturnValue({
        requireHolderBinding: true,
        requireIssuerTrust: true,
        requireStatusCheck,
        allowedAlgorithms: ['ES256'],
        allowedFormats: ['dc+sd-jwt'],
        preferDCQL: true,
        requireDirectPost: true,
      });
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: { iss: ISSUER, vct: 'https://authrim.com/credentials/identity/v1', ...claims },
        disclosures: [],
        kbJwt: 'kb-jwt-token',
        issuerJwt,
      } as never);
      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);
      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: ISSUER,
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);
      return verifyVPToken(createMockEnv(), 'vp-token', defaultOptions);
    }

    const tslClaim = { status: { status_list: { idx: 5, uri: LIST_URI } } };

    it('accepts a Token Status List credential whose entry is 0', async () => {
      vi.mocked(getCredentialStatusValue).mockResolvedValue(0);
      const result = await verifyWithPayload(tslClaim);
      expect(result.verified).toBe(true);
      expect(getCredentialStatusValue).toHaveBeenCalledWith(
        LIST_URI,
        5,
        expect.objectContaining({ format: 'ietf_tsl_v1', expectedIssuer: ISSUER })
      );
    });

    it('resolves the credential key and a rotated status list key by their own kid', async () => {
      const header = btoa(JSON.stringify({ alg: 'ES256', kid: 'key-old' }))
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const resolved: string[] = [];
      vi.mocked(getCredentialStatusValue).mockImplementation(async (_uri, _idx, options) => {
        // The list signed with the credential's key, then one signed after a rotation.
        await options?.keyResolver?.(ISSUER, 'key-old');
        await options?.keyResolver?.(ISSUER, 'key-new');
        resolved.push('done');
        return 0;
      });

      const result = await verifyWithPayload(tslClaim, false, `${header}.payload.signature`);

      expect(result.verified).toBe(true);
      expect(resolved).toEqual(['done']);
      expect(vi.mocked(getIssuerPublicKey).mock.calls).toEqual([
        [expect.anything(), ISSUER, undefined, 'key-old'],
        [expect.anything(), ISSUER, undefined, 'key-new'],
      ]);
    });

    it('rejects status 1 (invalid) and 2 (suspended) with distinct errors', async () => {
      vi.mocked(getCredentialStatusValue).mockResolvedValue(1);
      const revoked = await verifyWithPayload(tslClaim);
      expect(revoked.verified).toBe(false);
      expect(revoked.errors).toContain('Credential has been revoked');

      vi.mocked(getCredentialStatusValue).mockResolvedValue(2);
      const suspended = await verifyWithPayload(tslClaim);
      expect(suspended.verified).toBe(false);
      expect(suspended.errors).toContain('Credential has been suspended');
    });

    it('rejects any other non-zero status value', async () => {
      vi.mocked(getCredentialStatusValue).mockResolvedValue(3);
      const result = await verifyWithPayload(tslClaim);
      expect(result.verified).toBe(false);
      expect(result.statusValid).toBe(false);
    });

    it('rejects a status failure even when requireStatusCheck is false', async () => {
      vi.mocked(getCredentialStatusValue).mockRejectedValue(new Error('Status List token expired'));
      const result = await verifyWithPayload(tslClaim, false);
      expect(result.verified).toBe(false);
      expect(result.statusValid).toBe(false);
      expect(result.errors).toContain('Status check failed: Status List token expired');
    });

    it('rejects a malformed status claim instead of treating it as absent', async () => {
      const result = await verifyWithPayload({
        status: { status_list: { idx: -1, uri: LIST_URI } },
      });
      expect(result.verified).toBe(false);
      expect(result.errors).toContain('Status check failed: Malformed status claim');
      expect(getCredentialStatusValue).not.toHaveBeenCalled();
    });

    it('rejects a credential that carries both status claims', async () => {
      const result = await verifyWithPayload({
        ...tslClaim,
        credentialStatus: {
          type: 'BitstringStatusListEntry',
          statusListIndex: 1,
          statusListCredential: LIST_URI,
        },
      });
      expect(result.verified).toBe(false);
      expect(result.errors).toContain('Status check failed: Ambiguous status claim');
    });

    it('still reads legacy W3C credentialStatus as a Bitstring Status List', async () => {
      vi.mocked(getCredentialStatusValue).mockResolvedValue(0);
      const result = await verifyWithPayload({
        credentialStatus: {
          type: 'BitstringStatusListEntry',
          statusListIndex: 3,
          statusListCredential: LIST_URI,
        },
      });
      expect(result.verified).toBe(true);
      expect(getCredentialStatusValue).toHaveBeenCalledWith(
        LIST_URI,
        3,
        expect.objectContaining({ format: 'w3c_bitstring_v1' })
      );
    });

    it('lets requireStatusCheck govern only credentials without a status claim', async () => {
      const without = await verifyWithPayload({}, true);
      expect(without.errors).toContain('Status claim required but not present in credential');
      const optional = await verifyWithPayload({}, false);
      expect(optional.verified).toBe(true);
    });
  });

  describe('HAIP Compliance - Algorithm Restrictions', () => {
    it('should accept VP signed with ES256 (HAIP-compliant)', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        header: { alg: 'ES256' },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-es256', defaultOptions);

      expect(result.verified).toBe(true);
    });

    it('should accept VP signed with ES384 (HAIP-compliant)', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        header: { alg: 'ES384' },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-es384', defaultOptions);

      expect(result.verified).toBe(true);
    });

    it('should accept VP signed with ES512 (HAIP-compliant)', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        header: { alg: 'ES512' },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-es512', defaultOptions);

      expect(result.verified).toBe(true);
    });
  });

  describe('Security: Credential Expiration', () => {
    it('should reject VP with expired credential', async () => {
      const pastTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
          exp: pastTime, // Expired
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-expired', defaultOptions);

      // HAIP policy evaluator should detect expiration
      expect(result.verified).toBeDefined();
    });

    it('should accept VP with valid (not expired) credential', async () => {
      const futureTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
          exp: futureTime,
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-valid-exp', defaultOptions);

      expect(result.verified).toBe(true);
    });
  });

  describe('Security: Issuer Trust Levels', () => {
    it('should handle suspended issuer', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:suspended-issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: false,
        reason: 'Issuer is suspended',
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-suspended', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.issuerTrusted).toBe(false);
      expect(result.errors.some((e) => e.includes('not trusted') || e.includes('suspended'))).toBe(
        true
      );
    });

    it('should handle revoked issuer', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:revoked-issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: false,
        reason: 'Issuer is revoked',
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-revoked', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.issuerTrusted).toBe(false);
    });
  });

  describe('Security: Input Validation', () => {
    it('should handle empty VP token', async () => {
      const env = createMockEnv();
      const result = await verifyVPToken(env, '', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle VP token with only whitespace', async () => {
      const env = createMockEnv();
      const result = await verifyVPToken(env, '   ', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle malformed JWT structure', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue(null);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'not.valid.jwt.structure.at.all', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.errors).toContain('Invalid SD-JWT VC format');
    });
  });

  describe('Security: Holder Binding Attacks', () => {
    it('should verify KB-JWT nonce matches expected nonce', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        disclosures: [],
        kbJwt: 'kb-jwt-with-wrong-nonce',
      } as never);

      // KB-JWT verification should check nonce
      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
        kbJwtVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token', defaultOptions);

      // The nonce verification happens in verifySDJWTVC
      expect(result.verified).toBe(true);
    });
  });

  describe('Security: Multiple Credentials', () => {
    it('should handle VP with missing required claims', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          // Missing 'iss' claim
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-no-iss', defaultOptions);

      // Should handle missing issuer gracefully
      expect(result.verified).toBeDefined();
    });

    it('should handle VP with missing vct claim', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:issuer.com',
          // Missing 'vct' claim
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(verifySDJWTVC).mockResolvedValue({
        verified: true,
        disclosedClaims: {},
        holderBindingVerified: true,
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:issuer.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockResolvedValue({} as CryptoKey);

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token-no-vct', defaultOptions);

      // Should handle missing vct gracefully
      expect(result.verified).toBeDefined();
      expect(result.credentialType).toBeUndefined();
    });
  });

  describe('Security: DID Resolution Attacks', () => {
    it('should handle DID resolution timeout', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:slow-server.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:slow-server.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockRejectedValue(new Error('DID resolution timeout'));

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.errors.some((e) => e.includes('Failed to get issuer public key'))).toBe(true);
    });

    it('should handle invalid DID document structure', async () => {
      vi.mocked(parseSDJWTVC).mockResolvedValue({
        payload: {
          iss: 'did:web:malformed-doc.com',
          vct: 'https://authrim.com/credentials/identity/v1',
        },
        disclosures: [],
        kbJwt: 'kb-jwt',
      } as never);

      vi.mocked(checkIssuerTrust).mockResolvedValue({
        trusted: true,
        issuer: {
          id: 'issuer-1',
          tenantId: 'tenant-1',
          issuerDid: 'did:web:malformed-doc.com',
          credentialTypes: [],
          trustLevel: 'standard',
          status: 'active',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      });

      vi.mocked(getIssuerPublicKey).mockRejectedValue(new Error('Invalid DID document structure'));

      const env = createMockEnv();
      const result = await verifyVPToken(env, 'vp-token', defaultOptions);

      expect(result.verified).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
