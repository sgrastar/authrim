/**
 * An in-memory stand-in for the RATE_LIMITER Durable Object namespace: counts per key, in
 * fixed windows, as RateLimiterCounter does.
 */
export function createRateLimiterStub() {
  const records = new Map<string, { count: number; resetAt: number }>();
  const incrementRpc = async (
    key: string,
    config: { windowSeconds: number; maxRequests: number }
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const existing = records.get(key);
    const record =
      existing && now < existing.resetAt
        ? { ...existing, count: existing.count + 1 }
        : { count: 1, resetAt: now + config.windowSeconds };
    records.set(key, record);
    const allowed = record.count <= config.maxRequests;
    return {
      allowed,
      current: record.count,
      limit: config.maxRequests,
      resetAt: record.resetAt,
      retryAfter: allowed ? 0 : record.resetAt - now,
    };
  };
  return {
    idFromName: (name: string) => name,
    get: () => ({ incrementRpc }),
    records,
  };
}
