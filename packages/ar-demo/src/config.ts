import type { Env } from './types';

export interface Config {
  adminApiOrigin: string;
  consoleOrigin: string;
  portalOrigin: string;
  portalHost: string;
  turnstileSiteKey: string;
  turnstileSecret: string;
  maxActiveTenants: number;
  maxStartsPerIpPerDay: number;
  tenantTtlHours: number;
  development: boolean;
  machineClientId: string;
  machineKeyId: string;
  machinePrivateJwk: JsonWebKey;
  ipHashSecret: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

const LIMITS = {
  MAX_ACTIVE_TENANTS: { min: 1, max: 500, fallback: 50 },
  MAX_STARTS_PER_IP_PER_DAY: { min: 1, max: 20, fallback: 3 },
  TENANT_TTL_HOURS: { min: 1, max: 24, fallback: 12 },
} as const;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** An origin and nothing else: https (http only for loopback in development), no path, no credentials. */
function parseOrigin(value: string | undefined, development: boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const secure = url.protocol === 'https:';
    const loopbackHttp = development && url.protocol === 'http:' && isLoopback(url.hostname);
    if (!secure && !loopbackHttp) return null;
    if (url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Absent: the default. Not an integer: invalid. Outside the range: clamped. */
function parseBounded(
  name: keyof typeof LIMITS,
  value: string | number | undefined,
  problems: string[]
): number {
  const limit = LIMITS[name];
  if (value === undefined || value === '') return limit.fallback;
  const text = String(value).trim();
  if (!/^-?\d{1,9}$/.test(text)) {
    problems.push(name);
    return limit.fallback;
  }
  return Math.min(limit.max, Math.max(limit.min, Number(text)));
}

function parsePrivateJwk(value: string | undefined): JsonWebKey | null {
  if (!value) return null;
  try {
    const jwk = JSON.parse(value) as JsonWebKey;
    // ES256 only: any other key type or curve is a configuration error.
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
    if (jwk.alg !== undefined && jwk.alg !== 'ES256') return null;
    if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      return null;
    }
    return jwk;
  } catch {
    return null;
  }
}

/** Validates every setting at once. The problems name settings, never values. */
export function loadConfig(env: Env): ConfigResult {
  const problems: string[] = [];
  const development = env.ENVIRONMENT === 'development';

  const adminApiOrigin = parseOrigin(env.ADMIN_API_ORIGIN, development);
  if (!adminApiOrigin) problems.push('ADMIN_API_ORIGIN');
  const consoleOrigin = parseOrigin(env.CONSOLE_ORIGIN, development);
  if (!consoleOrigin) problems.push('CONSOLE_ORIGIN');
  const portalOrigin = parseOrigin(env.PORTAL_ORIGIN, development);
  if (!portalOrigin) problems.push('PORTAL_ORIGIN');

  const required = (name: keyof Env, max = 512): string => {
    const value = env[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      problems.push(name);
      return '';
    }
    return value;
  };
  const turnstileSiteKey = required('TURNSTILE_SITE_KEY', 128);
  const turnstileSecret = required('TURNSTILE_SECRET_KEY');
  const machineClientId = required('MACHINE_CLIENT_ID', 256);
  const machineKeyId = required('MACHINE_KEY_ID', 256);
  const ipHashSecret = required('IP_HASH_SECRET');
  if (ipHashSecret && ipHashSecret.length < 16) problems.push('IP_HASH_SECRET');
  const machinePrivateJwk = parsePrivateJwk(env.MACHINE_PRIVATE_JWK);
  if (!machinePrivateJwk) problems.push('MACHINE_PRIVATE_JWK');

  const maxActiveTenants = parseBounded('MAX_ACTIVE_TENANTS', env.MAX_ACTIVE_TENANTS, problems);
  const maxStartsPerIpPerDay = parseBounded(
    'MAX_STARTS_PER_IP_PER_DAY',
    env.MAX_STARTS_PER_IP_PER_DAY,
    problems
  );
  const tenantTtlHours = parseBounded('TENANT_TTL_HOURS', env.TENANT_TTL_HOURS, problems);

  if (problems.length > 0 || !adminApiOrigin || !consoleOrigin || !portalOrigin) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    config: {
      adminApiOrigin,
      consoleOrigin,
      portalOrigin,
      portalHost: new URL(portalOrigin).hostname,
      turnstileSiteKey,
      turnstileSecret,
      maxActiveTenants,
      maxStartsPerIpPerDay,
      tenantTtlHours,
      development,
      machineClientId,
      machineKeyId,
      machinePrivateJwk: machinePrivateJwk as JsonWebKey,
      ipHashSecret,
    },
  };
}
