/**
 * Issuer Trust Service Tests
 *
 * Tests for the trusted issuer registry and DID resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkIssuerTrust, checkSelfIssuance } from '../issuer-trust';
import type { Env } from '../../../types';
import type { TrustedIssuerRepository, TrustedIssuerRecord } from '@authrim/shared';

// Create mock repository
const createMockRepo = (
  dbResult?: Partial<TrustedIssuerRecord> | null
): TrustedIssuerRepository => {
  const mockRecord: TrustedIssuerRecord | null = dbResult
    ? {
        id: dbResult.id || 'issuer-1',
        tenant_id: dbResult.tenant_id || 'tenant-1',
        issuer_did: dbResult.issuer_did || 'did:web:example.com',
        display_name: dbResult.display_name || 'Example Issuer',
        credential_types: dbResult.credential_types || '["IdentityCredential"]',
        trust_level: dbResult.trust_level || 'standard',
        jwks_uri: dbResult.jwks_uri || null,
        status: dbResult.status || 'active',
        created_at: dbResult.created_at || Date.now(),
        updated_at: dbResult.updated_at || Date.now(),
      }
    : null;

  return {
    findActiveTrustedIssuer: vi.fn().mockResolvedValue(mockRecord),
    parseCredentialTypes: vi.fn().mockImplementation((issuer: TrustedIssuerRecord): string[] => {
      try {
        return JSON.parse(issuer.credential_types || '[]') as string[];
      } catch {
        return [];
      }
    }),
    createTrustedIssuer: vi.fn(),
    findById: vi.fn(),
    isTrusted: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
  } as unknown as TrustedIssuerRepository;
};

// Mock environment for checkSelfIssuance
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

describe('checkIssuerTrust', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return trusted for registered issuer', async () => {
    const repo = createMockRepo({
      issuer_did: 'did:web:trusted-issuer.com',
      trust_level: 'high',
      status: 'active',
    });

    const result = await checkIssuerTrust(repo, 'did:web:trusted-issuer.com', 'tenant-1');

    expect(result.trusted).toBe(true);
    expect(result.issuer).toBeDefined();
    expect(result.issuer?.issuerDid).toBe('did:web:trusted-issuer.com');
    expect(result.issuer?.trustLevel).toBe('high');
  });

  it('should return not trusted for unregistered issuer', async () => {
    const repo = createMockRepo(null);

    const result = await checkIssuerTrust(repo, 'did:web:unknown-issuer.com', 'tenant-1');

    expect(result.trusted).toBe(false);
    expect(result.reason).toContain('not found');
    expect(result.issuer).toBeUndefined();
  });

  it('should include JWKS URI if available', async () => {
    const repo = createMockRepo({
      issuer_did: 'did:web:issuer.com',
      jwks_uri: 'https://issuer.com/.well-known/jwks.json',
    });

    const result = await checkIssuerTrust(repo, 'did:web:issuer.com', 'tenant-1');

    expect(result.trusted).toBe(true);
    expect(result.jwksUri).toBe('https://issuer.com/.well-known/jwks.json');
  });

  it('should parse credential types from JSON', async () => {
    const repo = createMockRepo({
      issuer_did: 'did:web:issuer.com',
      credential_types: '["IdentityCredential", "AgeVerification"]',
    });

    const result = await checkIssuerTrust(repo, 'did:web:issuer.com', 'tenant-1');

    expect(result.trusted).toBe(true);
    expect(result.issuer?.credentialTypes).toEqual(['IdentityCredential', 'AgeVerification']);
  });

  it('should handle repository errors gracefully', async () => {
    const repo = createMockRepo();
    (repo.findActiveTrustedIssuer as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Database connection failed')
    );

    const result = await checkIssuerTrust(repo, 'did:web:issuer.com', 'tenant-1');

    expect(result.trusted).toBe(false);
    expect(result.reason).toContain('Database error');
  });
});

describe('checkSelfIssuance', () => {
  it('should reject self-issued credentials', async () => {
    const env = createMockEnv();
    env.VERIFIER_IDENTIFIER = 'did:web:authrim.com';

    const result = await checkSelfIssuance(env, 'did:web:authrim.com', 'tenant-1');

    expect(result).toBe(false);
  });

  it('should accept credentials from different issuers', async () => {
    const env = createMockEnv();
    env.VERIFIER_IDENTIFIER = 'did:web:authrim.com';

    const result = await checkSelfIssuance(env, 'did:web:external-issuer.com', 'tenant-1');

    expect(result).toBe(true);
  });

  it('should use default DID when VERIFIER_IDENTIFIER is not set', async () => {
    const env = createMockEnv();
    // @ts-expect-error - Testing undefined case
    env.VERIFIER_IDENTIFIER = undefined;

    // Default is 'did:web:authrim.com'
    const result = await checkSelfIssuance(env, 'did:web:authrim.com', 'tenant-1');

    expect(result).toBe(false);
  });
});
