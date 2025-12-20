/**
 * DID Routes Tests
 *
 * Tests for DID resolution and document endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { didResolveRoute } from '../resolve';
import { didDocumentRoute } from '../document';
import type { Context } from 'hono';
import type { Env } from '../../../types';

// Mock fetch for safeFetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock @authrim/shared
vi.mock('@authrim/shared', () => {
  // Mock repository that returns null by default (no cache)
  const mockCacheRepo = {
    getValidCache: vi.fn().mockResolvedValue(null),
    cacheDocument: vi.fn().mockResolvedValue(undefined),
  };

  // Create a mock safeFetch that uses the global fetch mock
  const mockSafeFetch = vi.fn(async (url: string) => {
    // Use the global fetch mock
    return globalThis.fetch(url);
  });

  return {
    // Include safeFetch in the mock
    safeFetch: mockSafeFetch,
    parseDID: vi.fn((did: string) => {
      if (!did.startsWith('did:')) return null;
      const parts = did.split(':');
      if (parts.length < 3) return null;
      return {
        method: parts[1],
        methodSpecificId: parts.slice(2).join(':'),
      };
    }),
    didWebToUrl: vi.fn((did: string) => {
      if (!did.startsWith('did:web:')) return null;
      const domain = did.replace('did:web:', '').replace(/:/g, '/');
      return `https://${domain}/.well-known/did.json`;
    }),
    isValidDID: vi.fn((did: string) => {
      return did.startsWith('did:') && did.split(':').length >= 3;
    }),
    D1Adapter: class {
      constructor() {}
    },
    DIDDocumentCacheRepository: class {
      constructor() {}
      getValidCache = mockCacheRepo.getValidCache;
      cacheDocument = mockCacheRepo.cacheDocument;
    },
  };
});

// Helper to create mock context
const createMockContext = (
  overrides: Partial<{
    env: Partial<Env>;
    req: Partial<{
      url: string;
      method: string;
      param: (key: string) => string;
    }>;
  }> = {}
): Context<{ Bindings: Env }> => {
  const mockKeyManagerStub = {
    fetch: vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          keys: [
            {
              kty: 'EC',
              crv: 'P-256',
              x: 'base64-x',
              y: 'base64-y',
              kid: 'key-1',
            },
          ],
        })
      )
    ),
  };

  const defaultEnv: Env = {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    } as unknown as D1Database,
    AUTHRIM_CONFIG: {} as KVNamespace,
    VP_REQUEST_STORE: {} as DurableObjectNamespace,
    CREDENTIAL_OFFER_STORE: {} as DurableObjectNamespace,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-km-id' }),
      get: vi.fn().mockReturnValue(mockKeyManagerStub),
    } as unknown as DurableObjectNamespace,
    POLICY_SERVICE: {} as Fetcher,
    VERIFIER_IDENTIFIER: 'did:web:authrim.com',
    HAIP_POLICY_VERSION: 'draft-06',
    VP_REQUEST_EXPIRY_SECONDS: '300',
    NONCE_EXPIRY_SECONDS: '300',
    ISSUER_IDENTIFIER: 'did:web:authrim.com',
    CREDENTIAL_OFFER_EXPIRY_SECONDS: '600',
    C_NONCE_EXPIRY_SECONDS: '300',
    ...overrides.env,
  };

  return {
    env: defaultEnv,
    req: {
      url: 'https://authrim.com/did/test',
      method: 'GET',
      param: vi.fn().mockReturnValue('did:web:example.com'),
      ...overrides.req,
    },
    json: vi.fn((data: unknown, status?: number) => {
      return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  } as unknown as Context<{ Bindings: Env }>;
};

describe('DID Resolve Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('should resolve did:web successfully', async () => {
    const didDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:example.com',
      verificationMethod: [
        {
          id: 'did:web:example.com#key-1',
          type: 'JsonWebKey2020',
          controller: 'did:web:example.com',
        },
      ],
    };

    mockFetch.mockResolvedValue(new Response(JSON.stringify(didDocument)));

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:example.com'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      '@context': string;
      didDocument: object;
      didResolutionMetadata: {
        contentType: string;
      };
    };

    expect(response.status).toBe(200);
    expect(data['@context']).toBe('https://w3id.org/did-resolution/v1');
    expect(data.didDocument).toBeDefined();
    expect(data.didResolutionMetadata.contentType).toBe('application/did+json');
  });

  it('should resolve did:key with Ed25519 successfully', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      '@context': string;
      didDocument: {
        id: string;
        verificationMethod: Array<{
          publicKeyJwk: { kty: string; crv: string; x: string };
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(data.didDocument).toBeDefined();
    expect(data.didDocument.id).toBe('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    expect(data.didDocument.verificationMethod).toBeDefined();
    expect(data.didDocument.verificationMethod[0].publicKeyJwk.kty).toBe('OKP');
    expect(data.didDocument.verificationMethod[0].publicKeyJwk.crv).toBe('Ed25519');
    expect(data.didDocument.verificationMethod[0].publicKeyJwk.x).toBeDefined();
  });

  it('should return 404 for invalid did:key with unrecognized curve', async () => {
    // This tests error handling for did:key that cannot be resolved
    // A random string after the z prefix will fail to decode properly
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:zInvalidKeyData123'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      '@context': string;
      didResolutionMetadata: { error: string };
    };

    expect(response.status).toBe(404);
    expect(data.didResolutionMetadata.error).toBe('notFound');
  });

  it('should handle did:key without z prefix', async () => {
    // Only base58btc (z prefix) is supported
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:f6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should return 400 when DID is missing', async () => {
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue(undefined),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didResolutionMetadata: {
        error: string;
        message: string;
      };
    };

    expect(response.status).toBe(400);
    expect(data.didResolutionMetadata.error).toBe('invalidDid');
    expect(data.didResolutionMetadata.message).toContain('required');
  });

  it('should return 400 for invalid DID format', async () => {
    const { isValidDID } = await import('@authrim/shared');
    (isValidDID as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('invalid-did-format'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didResolutionMetadata: {
        error: string;
        message: string;
      };
    };

    expect(response.status).toBe(400);
    expect(data.didResolutionMetadata.error).toBe('invalidDid');
    expect(data.didResolutionMetadata.message).toContain('Invalid DID format');
  });

  it('should return 400 for unsupported DID method', async () => {
    const { isValidDID, parseDID } = await import('@authrim/shared');
    (isValidDID as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (parseDID as ReturnType<typeof vi.fn>).mockReturnValue({
      method: 'example',
      methodSpecificId: 'abc123',
    });

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:example:abc123'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didResolutionMetadata: {
        error: string;
        message: string;
      };
    };

    expect(response.status).toBe(400);
    expect(data.didResolutionMetadata.error).toBe('methodNotSupported');
    expect(data.didResolutionMetadata.message).toContain('example');
  });

  it('should return 404 when did:web document not found', async () => {
    // Reset mocks for this test
    const { isValidDID, parseDID } = await import('@authrim/shared');
    (isValidDID as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (parseDID as ReturnType<typeof vi.fn>).mockReturnValue({
      method: 'web',
      methodSpecificId: 'nonexistent.com',
    });

    mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:nonexistent.com'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didResolutionMetadata: {
        error: string;
        message: string;
      };
    };

    expect(response.status).toBe(404);
    expect(data.didResolutionMetadata.error).toBe('notFound');
  });

  it('should resolve and cache did:web documents', async () => {
    // This test verifies the resolve flow works with the repository pattern.
    // Cache behavior is tested at the repository unit test level.
    const didDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:example.com',
    };

    mockFetch.mockResolvedValue(new Response(JSON.stringify(didDocument)));

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:example.com'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didDocument: { id: string };
    };

    expect(response.status).toBe(200);
    expect(data.didDocument.id).toBe('did:web:example.com');
  });

  it('should handle URL-encoded DID', async () => {
    // Reset mocks for this test
    const { isValidDID, parseDID } = await import('@authrim/shared');
    (isValidDID as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (parseDID as ReturnType<typeof vi.fn>).mockReturnValue({
      method: 'web',
      methodSpecificId: 'example.com:user:123',
    });

    const didDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:web:example.com:user:123',
    };

    mockFetch.mockResolvedValue(new Response(JSON.stringify(didDocument)));

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did%3Aweb%3Aexample.com%3Auser%3A123'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(200);
  });
});

describe('DID Resolution SSRF Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('should reject resolution to internal IP addresses (169.254.x.x)', async () => {
    // SSRF Attack: Attacker tries to resolve a DID that points to internal metadata service
    // The safeFetch should block requests to internal IPs

    // Mock safeFetch to simulate SSRF protection behavior
    const { safeFetch } = await import('@authrim/shared');
    (safeFetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SSRF protection: blocked request to internal IP')
    );

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:evil.com'), // This would redirect to internal IP
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didResolutionMetadata: { error: string };
    };

    expect(response.status).toBe(404);
    expect(data.didResolutionMetadata.error).toBe('notFound');
  });

  it('should reject resolution to localhost', async () => {
    // SSRF Attack: Attacker tries to access localhost services

    const { safeFetch } = await import('@authrim/shared');
    (safeFetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SSRF protection: blocked request to localhost')
    );

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:localhost'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didResolutionMetadata: { error: string };
    };

    expect(response.status).toBe(404);
    expect(data.didResolutionMetadata.error).toBe('notFound');
  });

  it('should handle timeout for slow-responding servers', async () => {
    // DoS Prevention: Slow server shouldn't block the service

    const { safeFetch } = await import('@authrim/shared');
    (safeFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout exceeded'));

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:slow-server.com'),
      },
    });

    const response = await didResolveRoute(c);
    const data = (await response.json()) as {
      didResolutionMetadata: { error: string };
    };

    expect(response.status).toBe(404);
    expect(data.didResolutionMetadata.error).toBe('notFound');
  });

  it('should reject HTTP (non-HTTPS) for did:web', async () => {
    // Security: did:web MUST use HTTPS

    const { safeFetch } = await import('@authrim/shared');
    (safeFetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('HTTPS required for did:web')
    );

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:http-only-server.com'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should reject oversized DID documents (DoS prevention)', async () => {
    // DoS Prevention: Attacker tries to send huge DID document

    const { safeFetch } = await import('@authrim/shared');
    (safeFetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Response size exceeds maximum allowed')
    );

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:huge-document.com'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should handle redirect to internal network gracefully', async () => {
    // SSRF: Server responds with redirect to internal IP
    // safeFetch should not follow dangerous redirects

    const { safeFetch } = await import('@authrim/shared');
    (safeFetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SSRF protection: redirect to internal network blocked')
    );

    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:web:redirect-to-internal.com'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });
});

describe('did:key Compressed Key Decoding Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  it('should reject did:key with empty multibase key', async () => {
    // Edge Case: Empty key after prefix
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:z'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should reject did:key with invalid base58 characters', async () => {
    // Edge Case: Invalid characters in base58 (0, O, I, l are not valid)
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:z0OIl123'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should reject did:key with very short key (less than multicodec header)', async () => {
    // Edge Case: Key too short to contain valid multicodec prefix + key data
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:z1'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should reject did:key with unknown multicodec prefix', async () => {
    // Edge Case: Valid base58 but unknown key type
    // 0xFF is not a valid multicodec for public keys
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:zUnknownCodecPrefix'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should reject did:key with truncated compressed EC key', async () => {
    // Edge Case: Compressed key that's too short for the curve
    // P-256 compressed key should be 33 bytes but this is shorter
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:zDnTruncatedKey'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  it('should reject did:key with invalid compression prefix (not 0x02 or 0x03)', async () => {
    // Edge Case: EC key with invalid compression byte
    // Valid compressed keys start with 0x02 (even y) or 0x03 (odd y)
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:zInvalidCompressionPrefix'),
      },
    });

    const response = await didResolveRoute(c);
    expect(response.status).toBe(404);
  });

  // Note: Valid Ed25519 did:key success test is covered in "DID Resolve Route" describe block
  // ("should resolve did:key with Ed25519 successfully")

  it('should handle leading zeros in base58 correctly', async () => {
    // Edge Case: Leading '1' characters in base58 represent leading zero bytes
    // This tests the padding logic
    const c = createMockContext({
      req: {
        // '111' prefix = 3 leading zero bytes in decoded data
        // This should still be handled gracefully (likely invalid key)
        param: vi.fn().mockReturnValue('did:key:z111SomeKeyData'),
      },
    });

    const response = await didResolveRoute(c);
    // Should not crash, may return 404 for invalid key
    expect([200, 404]).toContain(response.status);
  });

  it('should handle very large hex values in base58 decoding', async () => {
    // Edge Case: Large number that produces odd-length hex string
    // The fix ensures hex strings are padded to even length
    const c = createMockContext({
      req: {
        param: vi.fn().mockReturnValue('did:key:zVeryLongBase58StringThatMightCauseOddHex'),
      },
    });

    const response = await didResolveRoute(c);
    // Should not crash due to odd hex length
    expect([200, 404]).toContain(response.status);
  });
});

describe('DID Document Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return DID document with public key', async () => {
    const mockKeyManagerStub = {
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            keys: [
              {
                kty: 'EC',
                crv: 'P-256',
                x: 'base64-x-value',
                y: 'base64-y-value',
                kid: 'key-1',
              },
            ],
          })
        )
      ),
    };

    const c = createMockContext({
      env: {
        KEY_MANAGER: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-km-id' }),
          get: vi.fn().mockReturnValue(mockKeyManagerStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await didDocumentRoute(c);
    const data = (await response.json()) as {
      '@context': string[];
      id: string;
      verificationMethod: Array<{
        id: string;
        type: string;
        controller: string;
        publicKeyJwk: object;
      }>;
      assertionMethod: string[];
      authentication: string[];
      service: Array<{ id: string; type: string; serviceEndpoint: string }>;
    };

    expect(response.status).toBe(200);
    expect(data['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(data.id).toBe('did:web:authrim.com');
    expect(data.verificationMethod).toBeDefined();
    expect(data.verificationMethod.length).toBe(1);
    expect(data.verificationMethod[0].type).toBe('JsonWebKey2020');
    expect(data.verificationMethod[0].publicKeyJwk).toBeDefined();
    expect(data.assertionMethod).toContain('did:web:authrim.com#key-1');
    expect(data.authentication).toContain('did:web:authrim.com#key-1');
  });

  it('should include service endpoints', async () => {
    const c = createMockContext();

    const response = await didDocumentRoute(c);
    const data = (await response.json()) as {
      service: Array<{
        id: string;
        type: string;
        serviceEndpoint: string;
      }>;
    };

    expect(data.service).toBeDefined();
    expect(data.service.length).toBe(2);

    const issuerService = data.service.find((s) => s.type === 'OpenID4VCIssuer');
    expect(issuerService).toBeDefined();
    expect(issuerService?.serviceEndpoint).toContain('openid-credential-issuer');

    const verifierService = data.service.find((s) => s.type === 'OpenID4VPVerifier');
    expect(verifierService).toBeDefined();
    expect(verifierService?.serviceEndpoint).toContain('openid-credential-verifier');
  });

  it('should use custom ISSUER_IDENTIFIER', async () => {
    const c = createMockContext({
      env: {
        ISSUER_IDENTIFIER: 'did:web:custom.example.com',
      },
    });

    const response = await didDocumentRoute(c);
    const data = (await response.json()) as { id: string };

    expect(data.id).toBe('did:web:custom.example.com');
  });

  it('should handle KeyManager error gracefully', async () => {
    const mockKeyManagerStub = {
      fetch: vi.fn().mockResolvedValue(new Response('Error', { status: 500 })),
    };

    const c = createMockContext({
      env: {
        KEY_MANAGER: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-km-id' }),
          get: vi.fn().mockReturnValue(mockKeyManagerStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await didDocumentRoute(c);
    const data = (await response.json()) as {
      id: string;
      verificationMethod?: object[];
    };

    // Should still return a valid document, just without verification methods
    expect(response.status).toBe(200);
    expect(data.id).toBe('did:web:authrim.com');
    expect(data.verificationMethod).toBeUndefined();
  });

  it('should handle KeyManager exception gracefully', async () => {
    const mockKeyManagerStub = {
      fetch: vi.fn().mockRejectedValue(new Error('KeyManager unavailable')),
    };

    const c = createMockContext({
      env: {
        KEY_MANAGER: {
          idFromName: vi.fn().mockReturnValue({ toString: () => 'mock-km-id' }),
          get: vi.fn().mockReturnValue(mockKeyManagerStub),
        } as unknown as DurableObjectNamespace,
      },
    });

    const response = await didDocumentRoute(c);
    const data = (await response.json()) as {
      id: string;
      verificationMethod?: object[];
    };

    // Should still return a valid document, just without verification methods
    expect(response.status).toBe(200);
    expect(data.id).toBe('did:web:authrim.com');
    expect(data.verificationMethod).toBeUndefined();
  });
});
