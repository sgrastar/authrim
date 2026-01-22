/**
 * Mock Wallet Simulator
 *
 * Simulates a digital wallet for testing VP/VCI flows.
 * Supports constraint modes to emulate real wallet behaviors and restrictions.
 *
 * Features:
 * - DID creation (did:key)
 * - Credential storage
 * - VP generation with Key Binding JWT
 * - VCI credential request flow
 * - Constraint modes for compatibility testing
 */

import { SignJWT, exportJWK, generateKeyPair, decodeJwt, type JWK } from 'jose';
import type {
  PresentationDefinition,
  InputDescriptor,
  VPAuthorizationResponse,
} from '@authrim/ar-lib-core';

/**
 * Mock Wallet configuration options
 */
export interface MockWalletOptions {
  /** DID method to use for holder (default: 'key') */
  didMethod: 'key' | 'web';

  /** Strict mode - enforces algorithm restrictions and strict claim validation */
  strict?: boolean;

  /** When true, only discloses explicitly requested claims (no implicit disclosure) */
  noImplicitDisclosure?: boolean;

  /** Restrict allowed algorithms (default: all ES256/ES384/ES512) */
  allowedAlgorithms?: string[];

  /** Custom holder DID (for did:web method) */
  holderDid?: string;
}

/**
 * Stored credential in the wallet
 */
export interface StoredCredential {
  /** Raw SD-JWT VC string */
  raw: string;

  /** Decoded payload (for matching) */
  payload: Record<string, unknown>;

  /** Credential type (vct) */
  type: string;

  /** Issuer DID */
  issuer: string;

  /** Stored at timestamp */
  storedAt: number;
}

/**
 * VP creation request
 */
export interface CreateVPRequest {
  /** Presentation definition from verifier */
  presentationDefinition: PresentationDefinition;

  /** Nonce from verifier */
  nonce: string;

  /** Audience (verifier URL) */
  audience: string;

  /** Client ID */
  clientId: string;

  /** Response mode */
  responseMode?: 'direct_post' | 'fragment';
}

/**
 * Mock Wallet for testing VP/VCI flows
 */
export class MockWallet {
  private privateKey: CryptoKey | null = null;
  private publicKeyJwk: JWK | null = null;
  private did: string = '';
  private credentials: Map<string, StoredCredential> = new Map();
  private options: MockWalletOptions;

  /** Default allowed algorithms per HAIP */
  private static readonly HAIP_ALLOWED_ALGORITHMS = ['ES256', 'ES384', 'ES512'];

  constructor(options: MockWalletOptions) {
    this.options = {
      strict: false,
      noImplicitDisclosure: false,
      allowedAlgorithms: MockWallet.HAIP_ALLOWED_ALGORITHMS,
      ...options,
    };
  }

  /**
   * Initialize the wallet with a new key pair
   */
  async initialize(): Promise<void> {
    // Generate ES256 key pair
    const keyPair = await generateKeyPair('ES256', { extractable: true });
    this.privateKey = keyPair.privateKey;

    // Export public key to JWK
    const publicJwk = await exportJWK(keyPair.publicKey);
    this.publicKeyJwk = publicJwk;

    // Create did:key from public key
    if (this.options.didMethod === 'key') {
      this.did = await this.createDidKey(publicJwk);
    } else if (this.options.holderDid) {
      this.did = this.options.holderDid;
    } else {
      throw new Error('holderDid is required for did:web method');
    }
  }

  /**
   * Get the wallet's DID
   */
  getDid(): string {
    return this.did;
  }

  /**
   * Get the wallet's public key JWK
   */
  getPublicKeyJwk(): JWK | null {
    return this.publicKeyJwk;
  }

  /**
   * Store a credential in the wallet
   */
  async storeCredential(credential: string): Promise<string> {
    // Parse the SD-JWT VC
    const parts = credential.split('~');
    const issuerJwt = parts[0];

    // Decode payload (without verification - mock wallet trusts issuer for storage)
    const payload = decodeJwt(issuerJwt);

    // In strict mode, validate algorithm
    if (this.options.strict) {
      await this.validateCredentialStrict(credential);
    }

    const credentialId = crypto.randomUUID();
    const stored: StoredCredential = {
      raw: credential,
      payload: payload as Record<string, unknown>,
      type: (payload.vct as string) || 'unknown',
      issuer: (payload.iss as string) || 'unknown',
      storedAt: Date.now(),
    };

    this.credentials.set(credentialId, stored);
    return credentialId;
  }

  /**
   * Get all stored credentials
   */
  getCredentials(): StoredCredential[] {
    return Array.from(this.credentials.values());
  }

  /**
   * Create a Verifiable Presentation
   */
  async createPresentation(request: CreateVPRequest): Promise<VPAuthorizationResponse> {
    if (!this.privateKey || !this.publicKeyJwk) {
      throw new Error('Wallet not initialized');
    }

    // Find matching credentials
    const matchingCredentials = this.findMatchingCredentials(request.presentationDefinition);

    if (matchingCredentials.length === 0) {
      throw new Error('No matching credentials found');
    }

    // For each matched credential, create disclosure and Key Binding JWT
    const vpTokens: string[] = [];
    const descriptorMap: Array<{
      id: string;
      format: string;
      path: string;
    }> = [];

    for (let i = 0; i < matchingCredentials.length; i++) {
      const { credential, inputDescriptor, disclosures } = matchingCredentials[i];

      // Create SD-JWT VC with selected disclosures
      const sdJwtVc = await this.createSDJWTVCWithDisclosures(
        credential,
        disclosures,
        request.nonce,
        request.audience
      );

      vpTokens.push(sdJwtVc);
      descriptorMap.push({
        id: inputDescriptor.id,
        format: 'vc+sd-jwt',
        path: `$[${i}]`,
      });
    }

    // Create presentation submission
    const presentationSubmission = {
      id: crypto.randomUUID(),
      definition_id: request.presentationDefinition.id,
      descriptor_map: descriptorMap,
    };

    return {
      vp_token: vpTokens.length === 1 ? vpTokens[0] : vpTokens,
      presentation_submission: presentationSubmission,
    };
  }

  /**
   * Request a credential from a VCI endpoint
   */
  async requestCredential(
    tokenEndpoint: string,
    credentialEndpoint: string,
    preAuthorizedCode: string,
    credentialType: string
  ): Promise<string> {
    if (!this.privateKey || !this.publicKeyJwk) {
      throw new Error('Wallet not initialized');
    }

    // 1. Exchange pre-authorized code for access token
    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
        'pre-authorized_code': preAuthorizedCode,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Token request failed: ${error}`);
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string; c_nonce?: string };
    const accessToken = tokenData.access_token;
    const cNonce = tokenData.c_nonce;

    // 2. Create proof of possession
    const proof = await this.createKeyProof(credentialEndpoint, cNonce || '');

    // 3. Request credential
    const credentialResponse = await fetch(credentialEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        format: 'vc+sd-jwt',
        credential_definition: {
          type: [credentialType],
        },
        proof: {
          proof_type: 'jwt',
          jwt: proof,
        },
      }),
    });

    if (!credentialResponse.ok) {
      const error = await credentialResponse.text();
      throw new Error(`Credential request failed: ${error}`);
    }

    const credentialData = (await credentialResponse.json()) as { credential: string };
    const credential = credentialData.credential;

    // Store the credential
    await this.storeCredential(credential);

    return credential;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Create a did:key from a JWK
   */
  private async createDidKey(jwk: JWK): Promise<string> {
    // Simplified did:key creation for ES256 (P-256)
    // In production, this would use multibase/multicodec encoding
    const keyId = this.hashJwk(jwk);
    return `did:key:z${keyId}`;
  }

  /**
   * Hash a JWK for key ID generation
   */
  private hashJwk(jwk: JWK): string {
    const sorted = JSON.stringify(jwk, Object.keys(jwk).sort());
    // Simple hash for testing - in production use proper multicodec
    let hash = 0;
    for (let i = 0; i < sorted.length; i++) {
      const char = sorted.charCodeAt(i);
      hash = ((hash << 5) - hash + char) & 0xffffffff;
    }
    return Math.abs(hash).toString(36) + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  }

  /**
   * Validate credential in strict mode
   */
  private async validateCredentialStrict(credential: string): Promise<void> {
    const parts = credential.split('~');
    const issuerJwt = parts[0];

    // Decode header to check algorithm
    const [headerB64] = issuerJwt.split('.');
    const headerJson = atob(headerB64.replace(/-/g, '+').replace(/_/g, '/'));
    const header = JSON.parse(headerJson) as { alg: string };

    if (this.options.allowedAlgorithms && !this.options.allowedAlgorithms.includes(header.alg)) {
      throw new Error(`Unsupported algorithm: ${header.alg}`);
    }
  }

  /**
   * Find credentials matching a presentation definition
   */
  private findMatchingCredentials(presentationDefinition: PresentationDefinition): Array<{
    credential: StoredCredential;
    inputDescriptor: InputDescriptor;
    disclosures: string[];
  }> {
    const results: Array<{
      credential: StoredCredential;
      inputDescriptor: InputDescriptor;
      disclosures: string[];
    }> = [];

    for (const inputDescriptor of presentationDefinition.input_descriptors) {
      // Find a credential matching this input descriptor
      for (const credential of this.credentials.values()) {
        if (this.matchesInputDescriptor(credential, inputDescriptor)) {
          // Determine which disclosures to include
          const disclosures = this.selectDisclosures(credential, inputDescriptor);
          results.push({
            credential,
            inputDescriptor,
            disclosures,
          });
          break; // Use first matching credential
        }
      }
    }

    return results;
  }

  /**
   * Check if a credential matches an input descriptor
   */
  private matchesInputDescriptor(
    credential: StoredCredential,
    inputDescriptor: InputDescriptor
  ): boolean {
    // Check format constraint
    if (inputDescriptor.format) {
      const hasVcSdJwt = 'vc+sd-jwt' in inputDescriptor.format;
      if (!hasVcSdJwt) return false;
    }

    // Check constraints
    if (inputDescriptor.constraints?.fields) {
      for (const field of inputDescriptor.constraints.fields) {
        // Extract value using path
        const path = field.path[0];
        const value = this.extractValueByPath(credential.payload, path);

        if (value === undefined && !field.optional) {
          return false;
        }

        // Check filter
        if (field.filter && value !== undefined) {
          if (!this.matchesFilter(value, field.filter)) {
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Extract value from object using JSONPath-like syntax
   */
  private extractValueByPath(obj: Record<string, unknown>, path: string): unknown {
    // Simple path extraction (e.g., $.vct, $.credentialSubject.age_over_18)
    const parts = path.replace(/^\$\.?/, '').split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Check if value matches a filter
   */
  private matchesFilter(value: unknown, filter: Record<string, unknown>): boolean {
    if (filter.type && typeof value !== filter.type) {
      return false;
    }
    if (filter.const !== undefined && value !== filter.const) {
      return false;
    }
    if (filter.enum && !Array.isArray(filter.enum)) {
      return false;
    }
    if (filter.enum && Array.isArray(filter.enum) && !filter.enum.includes(value)) {
      return false;
    }
    return true;
  }

  /**
   * Select disclosures based on input descriptor requirements
   */
  private selectDisclosures(
    credential: StoredCredential,
    inputDescriptor: InputDescriptor
  ): string[] {
    const parts = credential.raw.split('~');
    const disclosures = parts.slice(1, -1); // Exclude issuer JWT and KB-JWT placeholder

    if (this.options.noImplicitDisclosure) {
      // Only include disclosures for explicitly requested fields
      const requestedPaths = new Set<string>();
      if (inputDescriptor.constraints?.fields) {
        for (const field of inputDescriptor.constraints.fields) {
          for (const path of field.path) {
            requestedPaths.add(path.replace(/^\$\.?/, ''));
          }
        }
      }

      // Filter disclosures to only those requested
      return disclosures.filter((disclosure) => {
        try {
          const decoded = JSON.parse(atob(disclosure.replace(/-/g, '+').replace(/_/g, '/')));
          const claimName = decoded[1]; // [salt, claim_name, claim_value]
          return (
            requestedPaths.has(claimName) || requestedPaths.has(`credentialSubject.${claimName}`)
          );
        } catch {
          return false;
        }
      });
    }

    // Include all disclosures by default
    return disclosures;
  }

  /**
   * Create SD-JWT VC with selected disclosures and Key Binding JWT
   */
  private async createSDJWTVCWithDisclosures(
    credential: StoredCredential,
    disclosures: string[],
    nonce: string,
    audience: string
  ): Promise<string> {
    if (!this.privateKey || !this.publicKeyJwk) {
      throw new Error('Wallet not initialized');
    }

    const parts = credential.raw.split('~');
    const issuerJwt = parts[0];

    // Create Key Binding JWT
    const kbJwt = await new SignJWT({
      nonce,
      aud: audience,
      iat: Math.floor(Date.now() / 1000),
      sd_hash: await this.computeSdHash(issuerJwt, disclosures),
    })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'kb+jwt',
        kid: `${this.did}#key-1`,
      })
      .sign(this.privateKey);

    // Combine: issuer_jwt~disclosure1~disclosure2~...~kb_jwt
    return [issuerJwt, ...disclosures, kbJwt].join('~');
  }

  /**
   * Compute sd_hash for Key Binding JWT
   */
  private async computeSdHash(issuerJwt: string, disclosures: string[]): Promise<string> {
    // Hash of issuer JWT + disclosures
    const toHash = [issuerJwt, ...disclosures].join('~');
    const encoder = new TextEncoder();
    const data = encoder.encode(toHash);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    return btoa(String.fromCharCode(...hashArray))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/[=]+$/, '');
  }

  /**
   * Create a key proof for credential request
   */
  private async createKeyProof(audience: string, nonce: string): Promise<string> {
    if (!this.privateKey) {
      throw new Error('Wallet not initialized');
    }

    return new SignJWT({
      nonce,
    })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'openid4vci-proof+jwt',
        kid: `${this.did}#key-1`,
      })
      .setAudience(audience)
      .setIssuer(this.did)
      .setIssuedAt()
      .sign(this.privateKey);
  }
}

/**
 * Create a configured mock wallet for testing
 */
export async function createMockWallet(options?: Partial<MockWalletOptions>): Promise<MockWallet> {
  const wallet = new MockWallet({
    didMethod: 'key',
    ...options,
  });
  await wallet.initialize();
  return wallet;
}

/**
 * Create a strict HAIP-compliant mock wallet
 */
export async function createHAIPCompliantWallet(): Promise<MockWallet> {
  return createMockWallet({
    didMethod: 'key',
    strict: true,
    noImplicitDisclosure: false,
    allowedAlgorithms: ['ES256', 'ES384', 'ES512'],
  });
}

/**
 * Create a restrictive mock wallet for negative testing
 */
export async function createRestrictiveWallet(): Promise<MockWallet> {
  return createMockWallet({
    didMethod: 'key',
    strict: true,
    noImplicitDisclosure: true,
    allowedAlgorithms: ['ES256'], // Only ES256
  });
}
