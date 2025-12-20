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

import { DurableObject } from 'cloudflare:workers';
import type { JWK } from 'jose';
import { generateKeySet } from '../utils/keys';
import { generateECKeySet, type ECAlgorithm, type ECCurve } from '../utils/ec-keys';
import { timingSafeEqual } from '../utils/crypto';
import type { Env } from '../types/env';
import type { KeyStatus } from '../types/admin';

/**
 * Stored key metadata (RSA)
 */
interface StoredKey {
  kid: string;
  publicJWK: JWK;
  privatePEM: string;
  createdAt: number;
  status: KeyStatus; // 'active' | 'overlap' | 'revoked'
  expiresAt?: number; // When the key expires (for overlap keys)
  revokedAt?: number; // When the key was revoked (for revoked keys)
  revokedReason?: string; // Reason for revocation (for revoked keys)
}

/**
 * Stored EC key metadata
 * Used for SD-JWT VC signing (Phase 9)
 */
interface StoredECKey {
  kid: string;
  algorithm: ECAlgorithm;
  curve: ECCurve;
  publicJWK: JWK;
  privatePEM: string;
  createdAt: number;
  status: KeyStatus;
  expiresAt?: number;
  revokedAt?: number;
  revokedReason?: string;
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
 * EC Key Manager State (Phase 9)
 * Separate state for EC keys used in VC signing
 */
interface ECKeyManagerState {
  keys: StoredECKey[];
  activeKeyIds: Record<ECAlgorithm, string | null>;
  config: KeyRotationConfig;
  lastRotation: number | null;
}

/**
 * KeyManager Durable Object
 *
 * Manages cryptographic keys for JWT signing with automatic rotation support.
 * Supports both RSA keys (for OIDC tokens) and EC keys (for SD-JWT VC in Phase 9).
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., getActiveKeyRpc, rotateKeysRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 *
 * Key Types:
 * - RSA: RS256 for OIDC ID tokens and access tokens
 * - EC: ES256/ES384/ES512 for SD-JWT VC (HAIP compliance)
 */
export class KeyManager extends DurableObject<Env> {
  private keyManagerState: KeyManagerState | null = null;
  private ecKeyManagerState: ECKeyManagerState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Block all requests until initialization completes
    // This ensures the DO is in a consistent state before processing any requests
    // Critical for cryptographic key management and migration
    ctx.blockConcurrencyWhile(async () => {
      await this.initializeStateBlocking();
    });
  }

  /**
   * Initialize state from Durable Storage
   * Called by blockConcurrencyWhile() in constructor
   */
  private async initializeStateBlocking(): Promise<void> {
    // Initialize RSA key state
    const stored = await this.ctx.storage.get<KeyManagerState>('state');

    if (stored) {
      this.keyManagerState = stored;
      // Run migration if needed
      await this.migrateIsActiveToStatus();
    } else {
      // Initialize with default configuration
      this.keyManagerState = {
        keys: [],
        activeKeyId: null,
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };

      await this.saveState();
    }

    // Initialize EC key state (Phase 9)
    const storedECState = await this.ctx.storage.get<ECKeyManagerState>('ecState');

    if (storedECState) {
      this.ecKeyManagerState = storedECState;
    } else {
      // Initialize with default configuration for EC keys
      this.ecKeyManagerState = {
        keys: [],
        activeKeyIds: {
          ES256: null,
          ES384: null,
          ES512: null,
        },
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };

      await this.saveECState();
    }
  }

  // ==========================================
  // RPC Methods (public, with 'Rpc' suffix)
  // ==========================================

  /**
   * RPC: Get the active signing key (without private key)
   */
  async getActiveKeyRpc(): Promise<Omit<StoredKey, 'privatePEM'> | null> {
    const activeKey = await this.getActiveKey();
    if (!activeKey) return null;
    return this.sanitizeKey(activeKey);
  }

  /**
   * RPC: Get the active signing key with private key (for internal use)
   */
  async getActiveKeyWithPrivateRpc(): Promise<StoredKey | null> {
    return this.getActiveKey();
  }

  /**
   * RPC: Get all public keys (for JWKS endpoint)
   */
  async getAllPublicKeysRpc(): Promise<JWK[]> {
    return this.getAllPublicKeys();
  }

  /**
   * RPC: Rotate keys
   */
  async rotateKeysRpc(): Promise<Omit<StoredKey, 'privatePEM'>> {
    const newKey = await this.rotateKeys();
    return this.sanitizeKey(newKey);
  }

  /**
   * RPC: Rotate keys (with private key for internal use)
   */
  async rotateKeysWithPrivateRpc(): Promise<StoredKey> {
    return this.rotateKeys();
  }

  /**
   * RPC: Emergency key rotation
   */
  async emergencyRotateKeysRpc(reason: string): Promise<{ oldKid: string; newKid: string }> {
    return this.emergencyRotateKeys(reason);
  }

  /**
   * RPC: Check if rotation is needed
   */
  async shouldRotateKeysRpc(): Promise<boolean> {
    return this.shouldRotateKeys();
  }

  /**
   * RPC: Get configuration
   */
  async getConfigRpc(): Promise<KeyRotationConfig> {
    return this.getConfig();
  }

  /**
   * RPC: Update configuration
   */
  async updateConfigRpc(config: Partial<KeyRotationConfig>): Promise<void> {
    return this.updateConfig(config);
  }

  /**
   * RPC: Get status of all keys
   */
  async getStatusRpc(): Promise<{
    keys: Array<{
      kid: string;
      status: KeyStatus;
      createdAt: number;
      expiresAt?: number;
      revokedAt?: number;
      revokedReason?: string;
    }>;
    activeKeyId: string | null;
    lastRotation: number | null;
  }> {
    await this.initializeState();
    const state = this.getState();

    const keys = state.keys.map((k) => ({
      kid: k.kid,
      status: k.status,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      revokedReason: k.revokedReason,
    }));

    return {
      keys,
      activeKeyId: state.activeKeyId,
      lastRotation: state.lastRotation,
    };
  }

  // ==========================================
  // EC Key RPC Methods (Phase 9: SD-JWT VC)
  // ==========================================

  /**
   * RPC: Get the active EC signing key for a specific algorithm (without private key)
   */
  async getActiveECKeyRpc(algorithm: ECAlgorithm): Promise<Omit<StoredECKey, 'privatePEM'> | null> {
    const activeKey = await this.getActiveECKey(algorithm);
    if (!activeKey) return null;
    return this.sanitizeECKey(activeKey);
  }

  /**
   * RPC: Get the active EC signing key with private key (for internal VC signing)
   */
  async getActiveECKeyWithPrivateRpc(algorithm: ECAlgorithm): Promise<StoredECKey | null> {
    return this.getActiveECKey(algorithm);
  }

  /**
   * RPC: Get all EC public keys (for JWKS endpoint)
   */
  async getAllECPublicKeysRpc(): Promise<JWK[]> {
    return this.getAllECPublicKeys();
  }

  /**
   * RPC: Rotate EC keys for a specific algorithm
   */
  async rotateECKeysRpc(algorithm: ECAlgorithm): Promise<Omit<StoredECKey, 'privatePEM'>> {
    const newKey = await this.rotateECKeys(algorithm);
    return this.sanitizeECKey(newKey);
  }

  /**
   * RPC: Rotate EC keys with private key (for internal use)
   */
  async rotateECKeysWithPrivateRpc(algorithm: ECAlgorithm): Promise<StoredECKey> {
    return this.rotateECKeys(algorithm);
  }

  /**
   * RPC: Emergency EC key rotation
   */
  async emergencyRotateECKeysRpc(
    algorithm: ECAlgorithm,
    reason: string
  ): Promise<{ oldKid: string; newKid: string }> {
    return this.emergencyRotateECKeys(algorithm, reason);
  }

  /**
   * RPC: Get EC key status for all algorithms
   */
  async getECStatusRpc(): Promise<{
    keys: Array<{
      kid: string;
      algorithm: ECAlgorithm;
      curve: ECCurve;
      status: KeyStatus;
      createdAt: number;
      expiresAt?: number;
      revokedAt?: number;
      revokedReason?: string;
    }>;
    activeKeyIds: Record<ECAlgorithm, string | null>;
    lastRotation: number | null;
  }> {
    await this.initializeECState();
    const state = this.getECState();

    const keys = state.keys.map((k) => ({
      kid: k.kid,
      algorithm: k.algorithm,
      curve: k.curve,
      status: k.status,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      revokedReason: k.revokedReason,
    }));

    return {
      keys,
      activeKeyIds: state.activeKeyIds,
      lastRotation: state.lastRotation,
    };
  }

  // ==========================================
  // Internal Methods
  // ==========================================

  /**
   * Ensure state is initialized
   * Called by public methods for backward compatibility
   *
   * Note: With blockConcurrencyWhile() in constructor, this is now a no-op guard.
   */
  private async initializeState(): Promise<void> {
    if (this.keyManagerState !== null) {
      return;
    }

    // Safety fallback (should not happen with blockConcurrencyWhile)
    console.warn('KeyManager: initializeState called but not initialized - this should not happen');
    await this.initializeStateBlocking();
  }

  /**
   * Migrate from old isActive field to new status field
   * This is a one-time migration for backward compatibility
   */
  private async migrateIsActiveToStatus(): Promise<void> {
    const state = this.getState();
    let needsMigration = false;

    for (const key of state.keys) {
      if ('isActive' in key && !('status' in key)) {
        needsMigration = true;
        // @ts-expect-error - migration from old schema
        (key as StoredKey).status = key.isActive ? 'active' : 'overlap';
        // @ts-expect-error - migration from old schema
        delete key.isActive;
      }
    }

    if (needsMigration) {
      console.log('[KeyManager] Migrated isActive to status field');
      await this.saveState();
    }
  }

  /**
   * Get state with assertion that it has been initialized
   */
  private getState(): KeyManagerState {
    if (!this.keyManagerState) {
      throw new Error('KeyManager state not initialized');
    }
    return this.keyManagerState;
  }

  /**
   * Save state to durable storage
   */
  private async saveState(): Promise<void> {
    if (this.keyManagerState) {
      await this.ctx.storage.put('state', this.keyManagerState);
    }
  }

  /**
   * Save EC key state to durable storage
   */
  private async saveECState(): Promise<void> {
    if (this.ecKeyManagerState) {
      await this.ctx.storage.put('ecState', this.ecKeyManagerState);
    }
  }

  /**
   * Ensure EC state is initialized
   */
  private async initializeECState(): Promise<void> {
    if (this.ecKeyManagerState !== null) {
      return;
    }

    // Safety fallback (should not happen with blockConcurrencyWhile)
    console.warn(
      'KeyManager: initializeECState called but not initialized - this should not happen'
    );
    const storedECState = await this.ctx.storage.get<ECKeyManagerState>('ecState');

    if (storedECState) {
      this.ecKeyManagerState = storedECState;
    } else {
      this.ecKeyManagerState = {
        keys: [],
        activeKeyIds: {
          ES256: null,
          ES384: null,
          ES512: null,
        },
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };
      await this.saveECState();
    }
  }

  /**
   * Get EC state with assertion that it has been initialized
   */
  private getECState(): ECKeyManagerState {
    if (!this.ecKeyManagerState) {
      throw new Error('EC KeyManager state not initialized');
    }
    return this.ecKeyManagerState;
  }

  /**
   * Generate a new key and add it to the key set
   */
  async generateNewKey(): Promise<StoredKey> {
    await this.initializeState();

    const kid = this.generateKeyId();
    const keySet = await generateKeySet(kid, 2048);

    console.log('KeyManager generateNewKey - keySet:', {
      kid,
      hasPEM: !!keySet.privatePEM,
      pemLength: keySet.privatePEM?.length,
      pemStart: keySet.privatePEM?.substring(0, 50),
    });

    const newKey: StoredKey = {
      kid,
      publicJWK: keySet.publicJWK,
      privatePEM: keySet.privatePEM,
      createdAt: Date.now(),
      status: 'overlap', // New keys start as overlap until set as active
    };

    console.log('KeyManager generateNewKey - newKey:', {
      kid: newKey.kid,
      hasPEM: !!newKey.privatePEM,
      pemLength: newKey.privatePEM?.length,
      keys: Object.keys(newKey),
    });

    const state = this.getState();
    state.keys.push(newKey);
    await this.saveState();

    return newKey;
  }

  /**
   * Set a key as the active signing key
   */
  async setActiveKey(kid: string): Promise<void> {
    await this.initializeState();

    const state = this.getState();
    const key = state.keys.find((k) => k.kid === kid);
    if (!key) {
      throw new Error(`Key with kid ${kid} not found`);
    }

    // Set previous active key to overlap status with expiry
    const previousActiveKey = state.keys.find((k) => k.status === 'active');
    if (previousActiveKey) {
      previousActiveKey.status = 'overlap';
      // Set expiry to 24 hours from now (overlap period)
      previousActiveKey.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    }

    // Set new key as active
    key.status = 'active';
    state.activeKeyId = kid;
    await this.saveState();
  }

  /**
   * Get the active signing key
   */
  async getActiveKey(): Promise<StoredKey | null> {
    await this.initializeState();

    const state = this.getState();
    if (!state.activeKeyId) {
      return null;
    }

    return state.keys.find((k) => k.kid === state.activeKeyId) || null;
  }

  /**
   * Get all public keys (for JWKS endpoint)
   * Excludes revoked keys from JWKS
   */
  async getAllPublicKeys(): Promise<JWK[]> {
    await this.initializeState();

    const state = this.getState();
    // Only return active and overlap keys, exclude revoked keys
    return state.keys.filter((k) => k.status !== 'revoked').map((k) => k.publicJWK);
  }

  /**
   * Get a specific key by kid
   */
  async getKey(kid: string): Promise<StoredKey | null> {
    await this.initializeState();

    const state = this.getState();
    return state.keys.find((k) => k.kid === kid) || null;
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
    const state = this.getState();
    state.lastRotation = Date.now();

    // Clean up expired keys
    await this.cleanupExpiredKeys();

    await this.saveState();

    // Return the key from state.keys to ensure it's the current version after cleanup
    const rotatedKey = state.keys.find((k) => k.kid === newKey.kid);
    if (!rotatedKey) {
      throw new Error('Rotated key not found in state after rotation');
    }

    console.log('KeyManager rotateKeys - returning key:', {
      kid: rotatedKey.kid,
      hasPEM: !!rotatedKey.privatePEM,
      pemLength: rotatedKey.privatePEM?.length,
      keys: Object.keys(rotatedKey),
    });

    // Explicitly reconstruct the object to ensure all properties are enumerable and serializable
    const result: StoredKey = {
      kid: rotatedKey.kid,
      publicJWK: rotatedKey.publicJWK,
      privatePEM: rotatedKey.privatePEM,
      createdAt: rotatedKey.createdAt,
      status: rotatedKey.status,
      expiresAt: rotatedKey.expiresAt,
      revokedAt: rotatedKey.revokedAt,
      revokedReason: rotatedKey.revokedReason,
    };

    console.log('KeyManager rotateKeys - reconstructed result:', {
      kid: result.kid,
      hasPEM: !!result.privatePEM,
      pemLength: result.privatePEM?.length,
      keys: Object.keys(result),
      ownPropertyNames: Object.getOwnPropertyNames(result),
    });

    // Verify JSON serialization works
    const testJson = JSON.stringify(result);
    console.log('KeyManager rotateKeys - test JSON serialization:', {
      jsonLength: testJson.length,
      hasPrivatePEM: testJson.includes('privatePEM'),
    });

    return result;
  }

  /**
   * Emergency key rotation for key compromise scenarios
   * Immediately revokes the current active key and generates a new one
   *
   * @param reason - Reason for emergency rotation (for audit purposes)
   * @returns Object with old and new key IDs
   */
  async emergencyRotateKeys(reason: string): Promise<{ oldKid: string; newKid: string }> {
    await this.initializeState();

    const state = this.getState();
    const now = Date.now();

    // Find current active key
    const currentActiveKey = state.keys.find((k) => k.status === 'active');
    if (!currentActiveKey) {
      throw new Error('No active key found to revoke');
    }

    // Generate new key
    const newKey = await this.generateNewKey();
    newKey.status = 'active';

    // Immediately revoke old key (NO overlap period for security)
    currentActiveKey.status = 'revoked';
    currentActiveKey.revokedAt = now;
    currentActiveKey.revokedReason = reason;

    // Update state
    state.activeKeyId = newKey.kid;
    state.lastRotation = now;
    await this.saveState();

    console.warn('[KeyManager] Emergency rotation executed', {
      oldKid: currentActiveKey.kid,
      newKid: newKey.kid,
      reason,
      timestamp: new Date(now).toISOString(),
    });

    return {
      oldKid: currentActiveKey.kid,
      newKid: newKey.kid,
    };
  }

  /**
   * Clean up expired keys based on retention period
   * - Active keys: never removed
   * - Overlap keys: removed after expiry
   * - Revoked keys: kept for retention period for audit purposes
   */
  private async cleanupExpiredKeys(): Promise<void> {
    const state = this.getState();
    const retentionMillis = state.config.retentionPeriodDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    state.keys = state.keys.filter((k) => {
      // Always keep active keys
      if (k.status === 'active') {
        return true;
      }

      // Remove overlap keys that have expired
      if (k.status === 'overlap' && k.expiresAt && k.expiresAt < now) {
        return false;
      }

      // Remove revoked keys after retention period (for audit purposes)
      if (k.status === 'revoked' && k.revokedAt) {
        const revokedAge = now - k.revokedAt;
        return revokedAge < retentionMillis;
      }

      // Keep everything else
      return true;
    });
  }

  /**
   * Check if key rotation is needed
   */
  async shouldRotateKeys(): Promise<boolean> {
    await this.initializeState();

    const state = this.getState();
    if (!state.lastRotation) {
      return true; // No keys have been generated yet
    }

    const rotationIntervalMillis = state.config.rotationIntervalDays * 24 * 60 * 60 * 1000;
    const timeSinceLastRotation = Date.now() - state.lastRotation;

    return timeSinceLastRotation >= rotationIntervalMillis;
  }

  /**
   * Update key rotation configuration
   */
  async updateConfig(config: Partial<KeyRotationConfig>): Promise<void> {
    await this.initializeState();

    const state = this.getState();
    state.config = {
      ...state.config,
      ...config,
    };

    await this.saveState();
  }

  /**
   * Get current configuration
   */
  async getConfig(): Promise<KeyRotationConfig> {
    await this.initializeState();
    const state = this.getState();
    return state.config;
  }

  /**
   * Generate a unique key ID using cryptographically secure random
   */
  private generateKeyId(): string {
    const timestamp = Date.now();
    const random = crypto.randomUUID();
    return `key-${timestamp}-${random}`;
  }

  // ==========================================
  // EC Key Internal Methods (Phase 9: SD-JWT VC)
  // ==========================================

  /**
   * Generate a new EC key and add it to the key set
   *
   * @param algorithm - EC algorithm (ES256, ES384, ES512)
   */
  async generateNewECKey(algorithm: ECAlgorithm): Promise<StoredECKey> {
    await this.initializeECState();

    const kid = this.generateECKeyId(algorithm);
    const keySet = await generateECKeySet(kid, algorithm);

    console.log('KeyManager generateNewECKey - keySet:', {
      kid,
      algorithm,
      curve: keySet.curve,
      hasPEM: !!keySet.privatePEM,
      pemLength: keySet.privatePEM?.length,
    });

    const newKey: StoredECKey = {
      kid,
      algorithm,
      curve: keySet.curve,
      publicJWK: keySet.publicJWK,
      privatePEM: keySet.privatePEM,
      createdAt: Date.now(),
      status: 'overlap', // New keys start as overlap until set as active
    };

    const state = this.getECState();
    state.keys.push(newKey);
    await this.saveECState();

    return newKey;
  }

  /**
   * Set an EC key as the active signing key for its algorithm
   */
  async setActiveECKey(kid: string): Promise<void> {
    await this.initializeECState();

    const state = this.getECState();
    const key = state.keys.find((k) => k.kid === kid);
    if (!key) {
      throw new Error(`EC key with kid ${kid} not found`);
    }

    const algorithm = key.algorithm;

    // Set previous active key for this algorithm to overlap status with expiry
    const previousActiveKeyId = state.activeKeyIds[algorithm];
    if (previousActiveKeyId) {
      const previousActiveKey = state.keys.find((k) => k.kid === previousActiveKeyId);
      if (previousActiveKey) {
        previousActiveKey.status = 'overlap';
        // Set expiry to 24 hours from now (overlap period)
        previousActiveKey.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      }
    }

    // Set new key as active
    key.status = 'active';
    state.activeKeyIds[algorithm] = kid;
    await this.saveECState();
  }

  /**
   * Get the active EC signing key for a specific algorithm
   */
  async getActiveECKey(algorithm: ECAlgorithm): Promise<StoredECKey | null> {
    await this.initializeECState();

    const state = this.getECState();
    const activeKeyId = state.activeKeyIds[algorithm];
    if (!activeKeyId) {
      return null;
    }

    return state.keys.find((k) => k.kid === activeKeyId) || null;
  }

  /**
   * Get all EC public keys (for JWKS endpoint)
   * Excludes revoked keys from JWKS
   */
  async getAllECPublicKeys(): Promise<JWK[]> {
    await this.initializeECState();

    const state = this.getECState();
    // Only return active and overlap keys, exclude revoked keys
    return state.keys.filter((k) => k.status !== 'revoked').map((k) => k.publicJWK);
  }

  /**
   * Rotate EC keys for a specific algorithm (generate new key and set as active)
   */
  async rotateECKeys(algorithm: ECAlgorithm): Promise<StoredECKey> {
    await this.initializeECState();

    // Generate new key
    const newKey = await this.generateNewECKey(algorithm);

    // Set new key as active
    await this.setActiveECKey(newKey.kid);

    // Update last rotation timestamp
    const state = this.getECState();
    state.lastRotation = Date.now();

    // Clean up expired EC keys
    await this.cleanupExpiredECKeys();

    await this.saveECState();

    // Return the key from state.keys to ensure it's the current version after cleanup
    const rotatedKey = state.keys.find((k) => k.kid === newKey.kid);
    if (!rotatedKey) {
      throw new Error('Rotated EC key not found in state after rotation');
    }

    console.log('KeyManager rotateECKeys - returning key:', {
      kid: rotatedKey.kid,
      algorithm: rotatedKey.algorithm,
      hasPEM: !!rotatedKey.privatePEM,
      pemLength: rotatedKey.privatePEM?.length,
    });

    // Explicitly reconstruct the object to ensure all properties are serializable
    const result: StoredECKey = {
      kid: rotatedKey.kid,
      algorithm: rotatedKey.algorithm,
      curve: rotatedKey.curve,
      publicJWK: rotatedKey.publicJWK,
      privatePEM: rotatedKey.privatePEM,
      createdAt: rotatedKey.createdAt,
      status: rotatedKey.status,
      expiresAt: rotatedKey.expiresAt,
      revokedAt: rotatedKey.revokedAt,
      revokedReason: rotatedKey.revokedReason,
    };

    return result;
  }

  /**
   * Emergency EC key rotation for key compromise scenarios
   * Immediately revokes the current active EC key and generates a new one
   *
   * @param algorithm - EC algorithm (ES256, ES384, ES512)
   * @param reason - Reason for emergency rotation (for audit purposes)
   * @returns Object with old and new key IDs
   */
  async emergencyRotateECKeys(
    algorithm: ECAlgorithm,
    reason: string
  ): Promise<{ oldKid: string; newKid: string }> {
    await this.initializeECState();

    const state = this.getECState();
    const now = Date.now();

    // Find current active key for this algorithm
    const currentActiveKeyId = state.activeKeyIds[algorithm];
    if (!currentActiveKeyId) {
      throw new Error(`No active EC key found for algorithm ${algorithm}`);
    }

    const currentActiveKey = state.keys.find((k) => k.kid === currentActiveKeyId);
    if (!currentActiveKey) {
      throw new Error(`Active EC key with kid ${currentActiveKeyId} not found`);
    }

    // Generate new key
    const newKey = await this.generateNewECKey(algorithm);
    newKey.status = 'active';

    // Immediately revoke old key (NO overlap period for security)
    currentActiveKey.status = 'revoked';
    currentActiveKey.revokedAt = now;
    currentActiveKey.revokedReason = reason;

    // Update state
    state.activeKeyIds[algorithm] = newKey.kid;
    state.lastRotation = now;
    await this.saveECState();

    console.warn('[KeyManager] Emergency EC rotation executed', {
      algorithm,
      oldKid: currentActiveKey.kid,
      newKid: newKey.kid,
      reason,
      timestamp: new Date(now).toISOString(),
    });

    return {
      oldKid: currentActiveKey.kid,
      newKid: newKey.kid,
    };
  }

  /**
   * Clean up expired EC keys based on retention period
   */
  private async cleanupExpiredECKeys(): Promise<void> {
    const state = this.getECState();
    const retentionMillis = state.config.retentionPeriodDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    state.keys = state.keys.filter((k) => {
      // Always keep active keys
      if (k.status === 'active') {
        return true;
      }

      // Remove overlap keys that have expired
      if (k.status === 'overlap' && k.expiresAt && k.expiresAt < now) {
        return false;
      }

      // Remove revoked keys after retention period (for audit purposes)
      if (k.status === 'revoked' && k.revokedAt) {
        const revokedAge = now - k.revokedAt;
        return revokedAge < retentionMillis;
      }

      // Keep everything else
      return true;
    });
  }

  /**
   * Generate a unique EC key ID
   */
  private generateECKeyId(algorithm: ECAlgorithm): string {
    const timestamp = Date.now();
    const random = crypto.randomUUID();
    return `ec-${algorithm.toLowerCase()}-${timestamp}-${random}`;
  }

  /**
   * Sanitize EC key data for safe HTTP response (remove private key material)
   */
  private sanitizeECKey(key: StoredECKey): Omit<StoredECKey, 'privatePEM'> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { privatePEM: _privatePEM, ...safeKey } = key;
    return safeKey;
  }

  // ==========================================
  // Authentication & HTTP Handler
  // ==========================================

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
    return timingSafeEqual(token, secret);
  }

  /**
   * Create an unauthorized response
   */
  private unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid authentication token required',
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="KeyManager"',
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
    const url = new URL(request.url);
    const path = url.pathname;

    // Public endpoints (no authentication required)
    // /jwks is public because it only returns public keys for JWT verification
    const isPublicEndpoint = path === '/jwks' && request.method === 'GET';

    // All other endpoints require authentication (including /internal/* for security)
    if (!isPublicEndpoint && !this.authenticate(request)) {
      return this.unauthorizedResponse();
    }

    try {
      // GET /active - Get active signing key (public endpoints, no private key)
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

      // GET /internal/active-with-private - Get active signing key with private key (for internal use by op-token)
      if (path === '/internal/active-with-private' && request.method === 'GET') {
        const activeKey = await this.getActiveKey();

        if (!activeKey) {
          return new Response(JSON.stringify({ error: 'No active key found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // Explicitly reconstruct the object to ensure all properties are serializable
        const result: StoredKey = {
          kid: activeKey.kid,
          publicJWK: activeKey.publicJWK,
          privatePEM: activeKey.privatePEM,
          createdAt: activeKey.createdAt,
          status: activeKey.status,
          expiresAt: activeKey.expiresAt,
          revokedAt: activeKey.revokedAt,
          revokedReason: activeKey.revokedReason,
        };

        // Return full key data including privatePEM for internal use
        return new Response(JSON.stringify(result), {
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

      // POST /rotate - Trigger key rotation (public endpoint, no private key)
      if (path === '/rotate' && request.method === 'POST') {
        const newKey = await this.rotateKeys();

        // Sanitize key data (remove private key material)
        const safeKey = this.sanitizeKey(newKey);

        return new Response(JSON.stringify({ success: true, key: safeKey }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /internal/rotate - Trigger key rotation and return with private key (for internal use)
      if (path === '/internal/rotate' && request.method === 'POST') {
        const newKey = await this.rotateKeys();

        console.log('KeyManager /internal/rotate - newKey:', {
          kid: newKey.kid,
          hasPEM: !!newKey.privatePEM,
          pemLength: newKey.privatePEM?.length,
          pemStart: newKey.privatePEM?.substring(0, 50),
          keys: Object.keys(newKey),
        });

        // Already reconstructed in rotateKeys(), so newKey should be serializable
        const responseBody = { success: true, key: newKey };
        const jsonString = JSON.stringify(responseBody);

        console.log('KeyManager /internal/rotate - response JSON:', {
          jsonLength: jsonString.length,
          hasPrivatePEM: jsonString.includes('privatePEM'),
          jsonStart: jsonString.substring(0, 200),
        });

        // Return full key data including privatePEM for internal use
        return new Response(jsonString, {
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

      // POST /emergency-rotate - Emergency key rotation (immediate revocation)
      if (path === '/emergency-rotate' && request.method === 'POST') {
        const body = (await request.json()) as { reason: string };

        if (!body.reason || body.reason.length < 10) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'Reason is required (minimum 10 characters)',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const result = await this.emergencyRotateKeys(body.reason);

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /status - Get status of all keys (for admin dashboard)
      if (path === '/status' && request.method === 'GET') {
        await this.initializeState();
        const state = this.getState();

        // Sanitize keys (remove private key material)
        const keys = state.keys.map((k) => ({
          kid: k.kid,
          status: k.status,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt,
          revokedAt: k.revokedAt,
          revokedReason: k.revokedReason,
        }));

        return new Response(
          JSON.stringify({
            keys,
            activeKeyId: state.activeKeyId,
            lastRotation: state.lastRotation,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // ==========================================
      // EC Key HTTP Endpoints (Phase 9: SD-JWT VC)
      // ==========================================

      // GET /ec/active/:algorithm - Get active EC signing key
      if (path.startsWith('/ec/active/') && request.method === 'GET') {
        const algorithm = path.split('/')[3] as ECAlgorithm;
        if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const activeKey = await this.getActiveECKey(algorithm);

        if (!activeKey) {
          return new Response(
            JSON.stringify({ error: `No active EC key found for ${algorithm}` }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // Sanitize key data (remove private key material)
        const safeKey = this.sanitizeECKey(activeKey);

        return new Response(JSON.stringify(safeKey), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /internal/ec/active-with-private/:algorithm - Get active EC key with private key
      if (path.startsWith('/internal/ec/active-with-private/') && request.method === 'GET') {
        const algorithm = path.split('/')[4] as ECAlgorithm;
        if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const activeKey = await this.getActiveECKey(algorithm);

        if (!activeKey) {
          return new Response(
            JSON.stringify({ error: `No active EC key found for ${algorithm}` }),
            {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // Return full key data including privatePEM for internal VC signing
        const result: StoredECKey = {
          kid: activeKey.kid,
          algorithm: activeKey.algorithm,
          curve: activeKey.curve,
          publicJWK: activeKey.publicJWK,
          privatePEM: activeKey.privatePEM,
          createdAt: activeKey.createdAt,
          status: activeKey.status,
          expiresAt: activeKey.expiresAt,
          revokedAt: activeKey.revokedAt,
          revokedReason: activeKey.revokedReason,
        };

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /ec/jwks - Get all EC public keys (JWKS format)
      if (path === '/ec/jwks' && request.method === 'GET') {
        const keys = await this.getAllECPublicKeys();

        return new Response(JSON.stringify({ keys }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /ec/rotate/:algorithm - Rotate EC keys for a specific algorithm
      if (path.startsWith('/ec/rotate/') && request.method === 'POST') {
        const algorithm = path.split('/')[3] as ECAlgorithm;
        if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const newKey = await this.rotateECKeys(algorithm);

        // Sanitize key data (remove private key material)
        const safeKey = this.sanitizeECKey(newKey);

        return new Response(JSON.stringify({ success: true, key: safeKey }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /internal/ec/rotate/:algorithm - Rotate EC keys and return with private key
      if (path.startsWith('/internal/ec/rotate/') && request.method === 'POST') {
        const algorithm = path.split('/')[4] as ECAlgorithm;
        if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const newKey = await this.rotateECKeys(algorithm);

        console.log('KeyManager /internal/ec/rotate - newKey:', {
          kid: newKey.kid,
          algorithm: newKey.algorithm,
          hasPEM: !!newKey.privatePEM,
          pemLength: newKey.privatePEM?.length,
        });

        // Return full key data including privatePEM for internal VC signing
        return new Response(JSON.stringify({ success: true, key: newKey }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // POST /ec/emergency-rotate/:algorithm - Emergency EC key rotation
      if (path.startsWith('/ec/emergency-rotate/') && request.method === 'POST') {
        const algorithm = path.split('/')[3] as ECAlgorithm;
        if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const body = (await request.json()) as { reason: string };

        if (!body.reason || body.reason.length < 10) {
          return new Response(
            JSON.stringify({
              error: 'Bad Request',
              message: 'Reason is required (minimum 10 characters)',
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        const result = await this.emergencyRotateECKeys(algorithm, body.reason);

        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // GET /ec/status - Get status of all EC keys (for admin dashboard)
      if (path === '/ec/status' && request.method === 'GET') {
        await this.initializeECState();
        const state = this.getECState();

        // Sanitize keys (remove private key material)
        const keys = state.keys.map((k) => ({
          kid: k.kid,
          algorithm: k.algorithm,
          curve: k.curve,
          status: k.status,
          createdAt: k.createdAt,
          expiresAt: k.expiresAt,
          revokedAt: k.revokedAt,
          revokedReason: k.revokedReason,
        }));

        return new Response(
          JSON.stringify({
            keys,
            activeKeyIds: state.activeKeyIds,
            lastRotation: state.lastRotation,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          }
        );
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
