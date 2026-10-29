import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Legacy settings endpoints that change or list what the whole installation shares (shard counts,
 * hash keys, cache mode, the rate-limit profile, other tenants' logging). The declared access table
 * lets `admin:settings:write` through for every tenant administrator, and these handlers check
 * nothing themselves, so the route has to carry the platform gate.
 */

const PLATFORM_ONLY_PREFIXES = [
  '/api/admin/settings/code-shards',
  '/api/admin/settings/revocation-shards',
  '/api/admin/settings/region-shards',
  '/api/admin/settings/session-shards',
  '/api/admin/settings/challenge-shards',
  '/api/admin/settings/pii-partitions',
  '/api/admin/settings/encryption/status',
  '/api/admin/settings/cache-mode',
  '/api/admin/settings/refresh-token-sharding',
  '/api/admin/settings/domain-hash-keys',
  '/api/admin/settings/native-sso',
  '/api/admin/settings/ip-security',
  '/api/admin/settings/logging',
  '/api/admin/settings/audit-storage',
  '/api/admin/rate-limits/profile-override',
  '/api/admin/external-token-refresh/config',
  '/api/admin/logout-failures',
  '/api/admin/iat-tokens',
  '/api/admin/clients/:clientId/cache-mode',
];

const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf8');
const registrations = [
  ...source.matchAll(/app\.(get|put|post|patch|delete)\(\s*'([^']+)',([^;]*?)\);/gs),
].map((match) => ({ method: match[1], path: match[2], rest: match[3] }));

describe('platform-wide legacy settings routes', () => {
  const platform = registrations.filter(
    ({ method, path }) =>
      // A client's mode can be read by its own tenant; only setting it is the platform's.
      !(path === '/api/admin/clients/:clientId/cache-mode' && method === 'get') &&
      PLATFORM_ONLY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  );

  it('finds the routes it is meant to guard', () => {
    expect(platform.length).toBeGreaterThanOrEqual(40);
  });

  for (const route of platform) {
    it(`${route.method.toUpperCase()} ${route.path} is behind requireSystemAdmin()`, () => {
      expect(route.rest).toContain('requireSystemAdmin()');
    });
  }
});

describe('test endpoints', () => {
  it('require the platform gate after the feature switch', () => {
    const guard = source.indexOf("app.use('/api/admin/test/*', async");
    const platformGate = source.indexOf("app.use('/api/admin/test/*', requireSystemAdmin())");
    expect(guard).toBeGreaterThan(-1);
    expect(platformGate).toBeGreaterThan(guard);
  });
});

describe('settings history on the shared KV', () => {
  const history = readFileSync(resolve(__dirname, '../routes/settings-v2/index.ts'), 'utf8');

  it.each([
    "settingsV2.post('/settings/:category/rollback', requireSystemAdmin()",
    "settingsV2.get('/settings/:category/current', requireSystemAdmin()",
  ])('%s', (registration) => {
    expect(history).toContain(registration);
  });
});
