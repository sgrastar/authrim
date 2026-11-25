/** Provider configuration: built once from the environment, never from request input. */

import type { AppAttestPolicy } from '../domain/app-attest-policy';
import type { Bytes } from '../domain/bytes';

export type ProviderEnvironment = 'staging' | 'production';

export interface RateLimitRule {
  windowSeconds: number;
  maxRequests: number;
}

export interface RateLimits {
  challengePerSource: RateLimitRule;
  registerPerSource: RateLimitRule;
  registerGlobal: RateLimitRule;
  attestPerKey: RateLimitRule;
  attestPerSource: RateLimitRule;
  /** Failed assertions per key; reaching it answers 429 until the window ends. */
  failuresPerKey: RateLimitRule;
  /** How long a key is locked once `failuresPerKey` is reached. */
  failureLockoutSeconds: number;
}

export interface WalletProviderConfig {
  environment: ProviderEnvironment;
  /** Label mixed into challenge MACs so the two environments never accept each other's. */
  challengeLabel: string;
  /** Current key first, previous generation second. */
  challengeSecrets: readonly Bytes[];
  challengeTtlSeconds: number;
  /** `iss` of wallet attestations (the provider issuer the wallet pins). */
  issuer: string;
  /** `sub` of wallet attestations. */
  clientId: string;
  walletTtlSeconds: number;
  keyTtlSeconds: number;
  /** Provider policy for `key_storage` (never taken from a request). */
  keyStorage: readonly string[];
  policy: AppAttestPolicy;
  limits: RateLimits;
  /** Largest accepted request body in bytes. */
  maxBodyBytes: number;
}

export const DEFAULT_LIMITS: RateLimits = {
  challengePerSource: { windowSeconds: 60, maxRequests: 60 },
  registerPerSource: { windowSeconds: 3600, maxRequests: 10 },
  registerGlobal: { windowSeconds: 60, maxRequests: 30 },
  attestPerKey: { windowSeconds: 3600, maxRequests: 30 },
  attestPerSource: { windowSeconds: 3600, maxRequests: 120 },
  failuresPerKey: { windowSeconds: 3600, maxRequests: 5 },
  failureLockoutSeconds: 900,
};

/**
 * Environment profiles (device spike, 2026-11-25). A development-signed build with the production
 * entitlement reports aaguid `appattest` but category 3, so production refuses 3 and requires the
 * category; staging accepts TestFlight (2) and development (3) builds of its own bundle ID.
 */
export function profileFor(
  environment: ProviderEnvironment
): Pick<
  AppAttestPolicy,
  'environments' | 'allowedCategories' | 'requireCategory' | 'categoryByteOrder'
> {
  return environment === 'production'
    ? {
        environments: ['production'],
        allowedCategories: [4],
        requireCategory: true,
        categoryByteOrder: 'little',
      }
    : {
        environments: ['development', 'production'],
        allowedCategories: [2, 3],
        requireCategory: true,
        categoryByteOrder: 'little',
      };
}
