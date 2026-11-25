/**
 * Reads the Apple extension fields shared by attestation and assertion and applies the build
 * policy.
 */

import type { CborValue } from './cbor';
import { compareVersions, type AppAttestPolicy } from './app-attest-policy';
import type { Bytes } from './bytes';

export const CATEGORY_KEY = 'apple_validation_category_01';
export const BUNDLE_VERSION_KEY = 'apple_bundle_version_01';
/** Confirmed on a device (iOS 27.3, dev spike): assertions use the same keys as attestation. */
export const ASSERTION_CATEGORY_KEY = CATEGORY_KEY;
export const ASSERTION_BUNDLE_VERSION_KEY = BUNDLE_VERSION_KEY;

export interface BuildInfo {
  validationCategory?: number;
  bundleVersion?: string;
}

function readCategory(value: CborValue, order: 'big' | 'little'): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (value instanceof Uint8Array && value.length === 4) {
    const bytes: Bytes = order === 'big' ? value : Uint8Array.from(value).reverse();
    return bytes[0] * 0x1000000 + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  }
  return null;
}

/** Returns the build info, or `'invalid'` for a present-but-malformed field. */
export function readBuildInfo(
  extensions: Map<string | number, CborValue> | null,
  keys: { category: string; bundleVersion: string },
  order: 'big' | 'little'
): BuildInfo | 'invalid' {
  const info: BuildInfo = {};
  if (!extensions) return info;
  const rawCategory = extensions.get(keys.category);
  if (rawCategory !== undefined) {
    const category = readCategory(rawCategory, order);
    if (category === null) return 'invalid';
    info.validationCategory = category;
  }
  const rawVersion = extensions.get(keys.bundleVersion);
  if (rawVersion !== undefined) {
    if (typeof rawVersion !== 'string' || rawVersion.length === 0 || rawVersion.length > 64)
      return 'invalid';
    info.bundleVersion = rawVersion;
  }
  return info;
}

/** The build policy: category allow-list and requirement, minimum version. */
export function buildAllowed(info: BuildInfo, policy: AppAttestPolicy): boolean {
  if (info.validationCategory === undefined) {
    if (policy.requireCategory) return false;
  } else if (!policy.allowedCategories.includes(info.validationCategory)) {
    return false;
  }
  if (
    info.bundleVersion !== undefined &&
    policy.revokedBundleVersions?.includes(info.bundleVersion)
  ) {
    return false;
  }
  if (policy.minBundleVersion !== undefined) {
    // A configured minimum cannot be met by a build that does not state its version.
    if (info.bundleVersion === undefined) return false;
    const order = compareVersions(info.bundleVersion, policy.minBundleVersion);
    if (order === null || order < 0) return false;
  }
  return true;
}
