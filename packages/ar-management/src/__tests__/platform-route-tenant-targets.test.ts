import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A drift guard for `machine_access.all_scope_excluded_tenants`.
 *
 * The Admin API authentication judges the tenant of the request, the tenant a path names, and the
 * tenants a request names in its query string or top-level JSON body. What it cannot see is a
 * tenant that a handler takes from a stored row, a nested field, or a cross-tenant list, and what
 * a platform route does to every tenant. So that a NEW route of the platform or inventory classes,
 * or a NEW handler that reads a tenant from the query or the body, cannot arrive unreviewed, both
 * are listed here with how they are protected. A route or file that is not in the table fails
 * this test: review it, then add it with its classification.
 *
 * What this guard does and does not do: it forces review of NEW files and NEW route prefixes. A new
 * child route under an already listed prefix, or a new tenant-resolving line in an already listed
 * file, is NOT caught by the tables; the one exception is the call-site count below for the two
 * files that resolve a tenant in many places (plugins, tombstones): every resolution there must be
 * followed by the helper, so a new unguarded resolution fails.
 *
 * - `platform-wide`: acts on the platform, or on every tenant, by its nature; the setting does not
 *   limit it (a machine holding the platform-wide permission is a platform administrator for it).
 * - `human-only`: the handler asks for a platform role through a global assignment, which no
 *   machine token has.
 * - `guarded`: it takes a tenant from the request and calls the shared helper
 *   (`refuseMachineOnExcludedTenant`, `filterTenantsReachableByMachine` or the middleware).
 */

type Classification = 'platform-wide' | 'human-only' | 'guarded';

const SRC = join(__dirname, '..');

/** Route prefixes of `/api/admin/platform/*` and the other platform-class paths. */
const REVIEWED_PLATFORM_ROUTES: Array<[prefix: string, kind: Classification, note: string]> = [
  ['/api/admin/platform/authentication-method-profiles', 'platform-wide', 'profile definitions'],
  [
    '/api/admin/platform/control-plane',
    'platform-wide',
    'control plane; a body tenantId is judged by the authentication',
  ],
  ['/api/admin/platform/identity-mapping/preview-default', 'platform-wide', 'the platform default'],
  [
    '/api/admin/platform/identity-mapping/tenants',
    'guarded',
    'cross-tenant list, filtered in the query',
  ],
  [
    '/api/admin/platform/last-resort-recovery',
    'guarded',
    'targets are filtered to reachable tenants',
  ],
  [
    '/api/admin/platform/launchers',
    'platform-wide',
    'shared launcher definitions; the top-level body tenant_ids is judged by the authentication',
  ],
  ['/api/admin/platform/plugins', 'guarded', 'tenant from body, query or header'],
  ['/api/admin/platform/read-replication', 'platform-wide', 'environment replication'],
  ['/api/admin/platform/service-site', 'platform-wide', 'the platform service site'],
  ['/api/admin/platform/session-profiles', 'platform-wide', 'profile definitions'],
  [
    '/api/admin/platform/settings',
    'platform-wide',
    'platform settings; PII partition stats judge a tenant_id',
  ],
  [
    '/api/admin/platform/tenant-domain-mappings',
    'guarded',
    'create by body, others by the stored row, lists filtered',
  ],
  [
    '/api/admin/platform/tenant-vanity-domains',
    'human-only',
    'a platform role through a global assignment',
  ],
  ['/api/admin/platform/tombstones', 'guarded', 'tenant from the query or the body'],
  ['/api/admin/runtime-profiles', 'platform-wide', 'runtime profile definitions'],
];

/** Source files that read a tenant from the query string or the body, and how that is covered. */
const REVIEWED_TENANT_READERS: Record<string, string> = {
  'admin-tenant-domain-mappings.ts': 'helper on body, stored rows and lists',
  'admin-tenant-vanity-domains.ts':
    'platform handlers are human-only; tenant handlers use the request tenant',
  'identity-mapping-set-change-preview.ts': 'helper on the tenant_id query',
  'launchers.ts':
    'tenant handlers use the request tenant; tenant_ids is only dropped from a platform launcher',
  'routes/admin-management/admin-last-resort-recovery.ts': 'targets filtered',
  'platform-launchers-store.ts': 'stores a platform launcher’s tenant list; reads no request',
  'routes/admin-management/agent-baselines.ts':
    'target tenants judged by actorReachesTenants with the exclusion',
  'routes/admin-management/control-plane-operations.ts':
    'platform control plane; body tenantId judged by the authentication',
  'routes/admin-management/logging-control.ts':
    'query filters judged by the authentication; with platform authority and no filter it is platform-wide',
  'routes/diagnostic-logging/ingest.ts':
    'ingest endpoint with its own credential, not the Admin API machine token',
  'routes/platform-launchers.ts':
    'platform-wide; the top-level body tenant_ids is judged by the authentication',
  'routes/settings-v2/bulk-apply-request.ts': 'bulk apply targets judged by canReachTenant',
  'routes/settings/pii-partitions.ts': 'helper on the tenant_id query',
  'routes/settings/plugins.ts': 'helper after every tenant resolution',
  'routes/settings/tombstones.ts': 'helper after every tenant resolution',
};

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' || name === 'node_modules' ? [] : walk(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

const FILES = walk(SRC).map((path) => ({
  name: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

describe('routes that are not tenant-scoped and not the inventory root', () => {
  it('lists every platform-class route with its review', () => {
    const seen = new Set<string>();
    for (const file of FILES) {
      for (const match of file.text.matchAll(
        /'(\/api\/admin\/(?:platform|runtime-profiles)[^']*)'/gu
      )) {
        seen.add(match[1].replace(/\/+$/u, ''));
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    const unreviewed = [...seen].filter(
      (path) => !REVIEWED_PLATFORM_ROUTES.some(([prefix]) => path.startsWith(prefix))
    );
    expect(unreviewed, 'review these routes and add them to REVIEWED_PLATFORM_ROUTES').toEqual([]);
  });

  it('keeps no reviewed prefix that no route has any more', () => {
    const paths = FILES.flatMap((file) =>
      [...file.text.matchAll(/'(\/api\/admin\/(?:platform|runtime-profiles)[^']*)'/gu)].map(
        (match) => match[1]
      )
    );
    const stale = REVIEWED_PLATFORM_ROUTES.filter(
      ([prefix]) => !paths.some((path) => path.startsWith(prefix))
    ).map(([prefix]) => prefix);
    expect(stale).toEqual([]);
  });
});

describe('handlers that read a tenant from the query string or the body', () => {
  const pattern =
    /query\(['"](?:tenant_id|tenantId|tenant|filter\[tenant_id\])['"]\)|body\??\.(?:tenant_id|tenantId|tenant_ids|tenantIds)\b|tenant_ids\b/u;

  it('are all reviewed', () => {
    const readers = FILES.filter((file) => pattern.test(file.text)).map((file) => file.name);
    const unreviewed = readers.filter((name) => !(name in REVIEWED_TENANT_READERS));
    expect(unreviewed, 'review these files and add them to REVIEWED_TENANT_READERS').toEqual([]);
    const stale = Object.keys(REVIEWED_TENANT_READERS).filter((name) => !readers.includes(name));
    expect(stale).toEqual([]);
  });

  it('call the shared helper where the review says they do', () => {
    const helper =
      /refuseMachineOnExcludedTenant|filterTenantsReachableByMachine|machineTenantSqlCondition|machineExcludedTenantsOf|resolvedMachineExcluded|canReachTenant/u;
    for (const name of [
      'admin-tenant-domain-mappings.ts',
      'identity-mapping-set-change-preview.ts',
      'routes/admin-management/admin-last-resort-recovery.ts',
      'routes/admin-management/agent-baselines.ts',
      'routes/settings/pii-partitions.ts',
      'routes/settings/plugins.ts',
      'routes/settings/tombstones.ts',
      'routes/settings-v2/bulk-apply-request.ts',
      'identity-mapping-tenants.ts',
    ]) {
      const file = FILES.find((candidate) => candidate.name === name);
      // bulk-apply-request only parses the body; the handler that uses it judges each tenant.
      const text =
        name === 'routes/settings-v2/bulk-apply-request.ts'
          ? (FILES.find((candidate) => candidate.name === 'routes/settings-v2/bulk-apply.ts')
              ?.text ?? '')
          : (file?.text ?? '');
      expect(helper.test(text), name).toBe(true);
    }
  });
});

describe('files that resolve a tenant in many places', () => {
  const count = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;
  it.each([
    ['routes/settings/plugins.ts', /getRequestTenantId\(/gu, 1],
    ['routes/settings/tombstones.ts', /resolveTombstoneTenantId\(/gu, 1],
  ])(
    '%s: every resolution of the tenant is followed by the helper',
    (name, pattern, declarations) => {
      const text = FILES.find((file) => file.name === name)?.text ?? '';
      // The declaration is not a call site; the one in a catch fallback is covered by the guard that
      // follows its try.
      const resolutions = count(text, pattern) - declarations;
      const fallbacks = name.endsWith('plugins.ts') ? 1 : 0;
      const guards = count(text, /refuseMachineOnExcludedTenant\(/gu);
      expect(guards, name).toBeGreaterThanOrEqual(resolutions - fallbacks);
    }
  );
});
