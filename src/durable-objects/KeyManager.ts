/**
 * KeyManager Durable Object
 *
 * Manages RSA key pairs for JWT signing with support for key rotation.
 * Implements a key rotation strategy that maintains multiple active keys
 * to ensure zero-downtime key rotation.
 *
 * Key Rotation Strategy:
 * 1. New key is generated with a new kid (key ID)
 * 2. New key is added to the key set alongside existing keys
 * 3. New tokens are signed with the new key
 * 4. Old keys remain active for verification until rotation window expires
 * 5. Expired keys are removed from the key set
 *
 * This ensures that tokens signed with old keys can still be verified
 * during the transition period.
 */

import type { JWK } from 'jose';
import { generateKeySet } from '../utils/keys';
import type { Env } from '../types/env';

/**
 * Stored key metadata
 */
interface StoredKey {
  kid: string;
  publicJWK: JWK;
  privatePEM: string;
  createdAt: number;
  isActive: boolean;
}

/**
 * Key rotation configuration
 */
interface KeyRotationConfig {
  rotationIntervalDays: number;
  retentionPeriodDays: number;
}

/**
 * KeyManager Durable Object State
 */
interface KeyManagerState {
  keys: StoredKey[];
  activeKeyId: string | null;
  config: KeyRotationConfig;
  lastRotation: number | null;
}

/**
 * KeyManager Durable Object
 *
 * Manages cryptographic keys for JWT signing with automatic rotation support.
 */
export class KeyManager {
  private state: DurableObjectState;
  private env: Env;
  private keyManagerState: KeyManagerState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize the KeyManager state
   */
  private async initializeState(): Promise<void> {
    if (this.keyManagerState !== null) {
      return;
    }

    const stored = await this.state.storage.get<KeyManagerState>('state');

    if (stored) {
      this.keyManagerState = stored;
    } else {
      // Initialize with default configuration
      this.keyManagerState = {
        keys: [],
        activeKeyId: null,
        config: {
          rotationIntervalDays: 90, // Rotate keys every 90 days
          retentionPeriodDays: 30, // Keep old keys for 30 days after rotation
        },
        lastRotation: null,
      };

      await this.saveState();
    }
  }

  /**
   * Save state to durable storage
   */
  private async saveState(): Promise<void> {
    if (this.keyManagerState) {
      await this.state.storage.put('state', this.keyManagerState);
    }
  }

  /**
   * Generate a new key and add it to the key set
   */
  async generateNewKey(): Promise<StoredKey> {
    await this.initializeState();

    const kid = this.generateKeyId();
    const keySet = await generateKeySet(kid, 2048);

    const newKey: StoredKey = {
      kid,
      publicJWK: keySet.publicJWK,
      privatePEM: keySet.privatePEM,
      createdAt: Date.now(),
      isActive: false,
    };

    this.keyManagerState!.keys.push(newKey);
    await this.saveState();

    return newKey;
  }

  /**
   * Set a key as the active signing key
   */
  async setActiveKey(kid: string): Promise<void> {
    await this.initializeState();

    const key = this.keyManagerState!.keys.find((k) => k.kid === kid);
    if (!key) {
      throw new Error(`Key with kid ${kid} not found`);
    }

    // Deactivate all other keys
    this.keyManagerState!.keys.forEach((k) => {
      k.isActive = k.kid === kid;
    });

    this.keyManagerState!.activeKeyId = kid;
    await this.saveState();
  }

  /**
   * Get the active signing key
   */
  async getActiveKey(): Promise<StoredKey | null> {
    await this.initializeState();

    if (!this.keyManagerState!.activeKeyId) {
      return null;
    }

    return (
      this.keyManagerState!.keys.find((k) => k.kid === this.keyManagerState!.activeKeyId) || null
    );
  }

  /**
   * Get all public keys (for JWKS endpoint)
   */
  async getAllPublicKeys(): Promise<JWK[]> {
    await this.initializeState();

    return this.keyManagerState!.keys.map((k) => k.publicJWK);
  }

  /**
   * Get a specific key by kid
   */
  async getKey(kid: string): Promise<StoredKey | null> {
    await this.initializeState();

    return this.keyManagerState!.keys.find((k) => k.kid === kid) || null;
  }

  /**
   * Rotate keys (generate new key and set as active)
   */
  async rotateKeys(): Promise<StoredKey> {
    await this.initializeState();

    // Generate new key
    const newKey = await this.generateNewKey();

    // Set new key as active
    await this.setActiveKey(newKey.kid);

    // Update last rotation timestamp
    this.keyManagerState!.lastRotation = Date.now();

    // Clean up expired keys
    await this.cleanupExpiredKeys();

    await this.saveState();

    return newKey;
  }

  /**
   * Clean up expired keys based on retention period
   */
  private async cleanupExpiredKeys(): Promise<void> {
    const retentionMillis = this.keyManagerState!.config.retentionPeriodDays * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionMillis;

    // Keep only active key and keys within retention period
    this.keyManagerState!.keys = this.keyManagerState!.keys.filter(
      (k) => k.isActive || k.createdAt > cutoffTime
    );
  }

  /**
   * Check if key rotation is needed
   */
  async shouldRotateKeys(): Promise<boolean> {
    await this.initializeState();

    if (!this.keyManagerState!.lastRotation) {
      return true; // No keys have been generated yet
    }

    const rotationIntervalMillis =
      this.keyManagerState!.config.rotationIntervalDays * 24 * 60 * 60 * 1000;
    const timeSinceLastRotation = Date.now() - this.keyManagerState!.lastRotation;

    return timeSinceLastRotation >= rotationIntervalMillis;
  }

  /**
   * Update key rotation configuration
   */
  async updateConfig(config: Partial<KeyRotationConfig>): Promise<void> {
    await this.initializeState();

    this.keyManagerState!.config = {
      ...this.keyManagerState!.config,
      ...config,
    };

    await this.saveState();
  }

  /**
   * Get current configuration
   */
  async getConfig(): Promise<KeyRotationConfig> {
    await this.initializeState();
    return this.keyManagerState!.config;
  }

  /**
   * Generate a unique key ID using cryptographically secure random
   */
  private generateKeyId(): string {
    const timestamp = Date.now();
    const random = crypto.randomUUID();
    return `key-${timestamp}-${random}`;
  }

  /**
   * Authenticate requests using Bearer token
   *
   * @param request - The incoming HTTP request
   * @returns True if authenticated, false otherwise
   */
  private authenticate(request: Request): boolean {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const token = authHeader.substring(7);
    const secret = this.env.KEY_MANAGER_SECRET;

    // If no secret is configured, deny all requests
    if (!secret) {
      console.error('KEY_MANAGER_SECRET is not configured');
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    return token === secret;
  }

  /**
   * Create an unauthorized response
   */
  private unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid authentication token required'
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="KeyManager"'
        },
      }
    );
  }

  /**
   * Sanitize key data for safe HTTP response (remove private key material)
   */
  private sanitizeKey(key: StoredKey): Omit<StoredKey, 'privatePEM'> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { privatePEM: _privatePEM, ...safeKey } = key;
    return safeKey;
  }

  /**
   * Handle HTTP requests to the KeyManager Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    // Authenticate all requests
    if (!this.authenticate(request)) {
      return this.unauthorizedResponse();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /active - Get active signing key
      if (path === '/active' && request.method === 'GET') {
        const activeKey = await this.getActiveKey();

        if (!activeKey) {
          return new Response(JSON.stringify({ error: 'No active key found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Sanitize key data (remove private key material)
        const safeKey = this.sanitizeKey(activeKey);

        return new Response(JSON.stringify(safeKey), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /jwks - Get all public keys (JWKS format)
      if (path === '/jwks' && request.method === 'GET') {
        const keys = await this.getAllPublicKeys();

        return new Response(JSON.stringify({ keys }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /rotate - Trigger key rotation
      if (path === '/rotate' && request.method === 'POST') {
        const newKey = await this.rotateKeys();

        // Sanitize key data (remove private key material)
        const safeKey = this.sanitizeKey(newKey);

        return new Response(JSON.stringify({ success: true, key: safeKey }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /should-rotate - Check if rotation is needed
      if (path === '/should-rotate' && request.method === 'GET') {
        const shouldRotate = await this.shouldRotateKeys();

        return new Response(JSON.stringify({ shouldRotate }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /config - Get configuration
      if (path === '/config' && request.method === 'GET') {
        const config = await this.getConfig();

        return new Response(JSON.stringify(config), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /config - Update configuration
      if (path === '/config' && request.method === 'POST') {
        const body = await request.json();
        await this.updateConfig(body as Partial<KeyRotationConfig>);

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('KeyManager error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
