/** Configuration the App Attest verifiers are given. Never built from request input. */

import type { Bytes } from './bytes';
import type { Curve, HashName } from './x509';

export type AppAttestEnvironment = 'development' | 'production';

export interface AppAttestPolicy {
  /** Full App IDs: `<appIdPrefix>.<bundleId>`. */
  appIds: readonly string[];
  /** Environments (from the aaguid) this provider accepts. */
  environments: readonly AppAttestEnvironment[];
  /**
   * Allowed `apple_validation_category_01` values (Apple: 2 TestFlight, 3 development, 4 App Store,
   * 5 enterprise).
   */
  allowedCategories: readonly number[];
  /** When true, a missing category is refused (registration and assertion). */
  requireCategory: boolean;
  /** How a 4-byte category byte string is read (to be fixed by the device spike). */
  categoryByteOrder: 'big' | 'little';
  /** Lowest accepted build (compared as dotted integers); undefined means any. */
  minBundleVersion?: string;
  /** Build versions refused outright (a bad release), compared as exact strings. */
  revokedBundleVersions?: readonly string[];
  /** Apple's App Attest root certificate (DER) and its SHA-256 as lower-case hex. */
  appleRootDer: Bytes;
  appleRootSha256: string;
  /** Allowed (issuer curve, hash) per chain edge; defaults to what Apple's published chain uses. */
  credCertSignature?: readonly { curve: Curve; hash: HashName }[];
  intermediateSignature?: readonly { curve: Curve; hash: HashName }[];
}

export const DEFAULT_CRED_CERT_SIGNATURE = [
  { curve: 'P-384', hash: 'SHA-256' },
] as const satisfies readonly { curve: Curve; hash: HashName }[];

export const DEFAULT_INTERMEDIATE_SIGNATURE = [
  { curve: 'P-384', hash: 'SHA-384' },
] as const satisfies readonly { curve: Curve; hash: HashName }[];

/**
 * Compares dotted integer versions ("1.2.10" > "1.2.9"); non-numeric parts make the result `null`.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = a.split('.');
  const right = b.split('.');
  if (![...left, ...right].every((part) => /^\d{1,9}$/u.test(part))) return null;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = Number(left[index] ?? '0') - Number(right[index] ?? '0');
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
