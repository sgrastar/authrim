/**
 * KV TTL limits
 *
 * Workers KV rejects an `expirationTtl` below 60 seconds (the put throws) and a `cacheTtl` below
 * 30 seconds. 60 satisfies both. A value that must lapse sooner keeps its own expiry inside the
 * value and is refused on read.
 */

/** The shortest `expirationTtl` KV accepts, in seconds (also a valid `cacheTtl`). */
export const KV_MIN_TTL_SECONDS = 60;

/** A TTL in seconds that KV accepts: rounded up, and never below its 60-second minimum. */
export function kvTtlSeconds(seconds: number): number {
  return Number.isFinite(seconds)
    ? Math.max(KV_MIN_TTL_SECONDS, Math.ceil(seconds))
    : KV_MIN_TTL_SECONDS;
}
