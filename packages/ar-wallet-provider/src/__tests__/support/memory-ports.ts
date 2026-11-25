/** Test helper: in-memory ports with the same observable behaviour as the D1 adapters. */
import type { DeviceRecord, DeviceRegistry, WalletProviderRateLimiter } from '@authrim/ar-lib-core';
import { compareVersions } from '../../domain/app-attest-policy';

export function createMemoryRegistry(): DeviceRegistry {
  const devices = new Map<string, DeviceRecord>();
  const challenges = new Set<string>();
  return {
    async register(record) {
      const existing = devices.get(record.keyId);
      if (existing) {
        return existing.attestationSha256 === record.attestationSha256 &&
          existing.challengeSha256 === record.challengeSha256
          ? 'same'
          : 'conflict';
      }
      if (challenges.has(record.challengeSha256)) return 'challenge_used';
      challenges.add(record.challengeSha256);
      devices.set(record.keyId, {
        ...record,
        lastBundleVersion: record.bundleVersion,
        lastValidationCategory: record.validationCategory,
      });
      return 'created';
    },
    async get(keyId) {
      const record = devices.get(keyId);
      return record ? { ...record } : null;
    },
    async advanceCounter(keyId, next, seen, at) {
      const record = devices.get(keyId);
      if (!record) return 'unknown';
      if (record.revokedAt !== undefined) return 'revoked';
      if (!(record.counter < next)) return 'not_greater';
      record.counter = next;
      record.lastSeenAt = at;
      record.lastBundleVersion = seen.bundleVersion ?? record.lastBundleVersion;
      record.lastValidationCategory = seen.validationCategory ?? record.lastValidationCategory;
      return 'advanced';
    },
    async revoke(keyId, reason, at) {
      const record = devices.get(keyId);
      if (!record) return 'unknown';
      if (record.revokedAt !== undefined) return 'already';
      record.revokedAt = at;
      record.revokeReason = reason;
      return 'revoked';
    },
    async revokeWhere(filter, reason, at) {
      let count = 0;
      for (const record of devices.values()) {
        if (record.revokedAt !== undefined) continue;
        const known =
          record.lastBundleVersion !== undefined || record.lastValidationCategory !== undefined;
        if (!known && !filter.includeUnknownBuild) continue;
        if (filter.createdBefore !== undefined && !(record.createdAt < filter.createdBefore))
          continue;
        if (
          filter.lastValidationCategory !== undefined &&
          record.lastValidationCategory !== filter.lastValidationCategory
        ) {
          continue;
        }
        if (filter.lastBundleVersionLt !== undefined) {
          const order = record.lastBundleVersion
            ? compareVersions(record.lastBundleVersion, filter.lastBundleVersionLt)
            : null;
          if (order === null ? !filter.includeUnknownBuild : order >= 0) continue;
        }
        record.revokedAt = at;
        record.revokeReason = reason;
        count += 1;
      }
      return count;
    },
    async touch(keyId, at) {
      const record = devices.get(keyId);
      if (record) record.lastSeenAt = at;
    },
  };
}

export function createMemoryRateLimiter(now: () => number): WalletProviderRateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  const verdict = (
    entry: { start: number; count: number } | undefined,
    input: { windowSeconds: number; maxRequests: number }
  ) => {
    const live = entry !== undefined && entry.start + input.windowSeconds > now();
    const count = live ? entry.count : 0;
    return {
      allowed: count <= input.maxRequests,
      remaining: Math.max(0, input.maxRequests - count),
      resetAt: (live ? entry.start : now()) + input.windowSeconds,
    };
  };
  return {
    async check(input) {
      const entry = windows.get(input.key);
      const live = entry !== undefined && entry.start + input.windowSeconds > now();
      const next = live
        ? { start: entry.start, count: entry.count + 1 }
        : { start: now(), count: 1 };
      windows.set(input.key, next);
      return verdict(next, input);
    },
    async peek(input) {
      return verdict(windows.get(input.key), input);
    },
  };
}
