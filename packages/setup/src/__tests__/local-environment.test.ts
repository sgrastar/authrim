import { describe, expect, it } from 'vitest';
import {
  buildLocalConfig,
  buildLocalLock,
  listLocalD1Databases,
  listLocalKvNamespaces,
  selectLocalComponents,
} from '../core/local/environment.js';
import {
  assertValidLocalEnvironmentName,
  getLocalEnvironmentPaths,
  getLocalWorkerConfigPath,
  getLocalWorkerDevVarsPath,
} from '../core/local/paths.js';
import { AuthrimConfigSchema } from '../core/config.js';
import { CORE_WORKER_COMPONENTS, D1_DATABASES, KV_NAMESPACES } from '../core/naming.js';

describe('local configuration', () => {
  it('serves the API and each UI from its own http://localhost port without Cloudflare features', () => {
    const config = buildLocalConfig({ env: 'local' });

    expect(config.urls?.api?.auto).toBe('http://localhost:8787');
    // Each Vite dev server needs its own origin: both serve their modules from the same
    // root-relative paths, so they cannot share the router's origin.
    expect(config.urls?.loginUi).toEqual({ auto: 'http://localhost:5173', sameAsApi: false });
    expect(config.urls?.adminUi).toEqual({ auto: 'http://localhost:5174', sameAsApi: false });
    expect(config.features.r2.enabled).toBe(false);
    expect(config.features.queue.enabled).toBe(false);
    expect(config.controlPlane.automaticProvisioning).toBe(false);
  });

  it('never selects a real email provider in the stored config', () => {
    // The log notifier is wired by local seeding, not through the shared provider enum.
    expect(buildLocalConfig({ env: 'local' }).features.email.provider).toBe('none');
    expect(
      AuthrimConfigSchema.safeParse({
        environment: { prefix: 'prod' },
        features: { email: { provider: 'log' } },
      }).success
    ).toBe(false);
  });

  it('honours the router port and the admin UI variant', () => {
    const config = buildLocalConfig({ env: 'dev1', routerPort: 9000, adminUiVariant: 'console' });
    expect(config.urls?.api?.auto).toBe('http://localhost:9000');
    expect(config.components.adminUiVariant).toBe('console');
    expect(config.environment.prefix).toBe('dev1');
  });

  it('refuses to put two servers on one port', () => {
    expect(() => buildLocalConfig({ env: 'local', loginUiPort: 8787 })).toThrow(/three different/);
    expect(() => buildLocalConfig({ env: 'local', loginUiPort: 5000, adminUiPort: 5000 })).toThrow(
      /three different/
    );
  });

  it('rejects environment names that could escape the state directory', () => {
    for (const name of ['', 'Local', '../x', 'a/b', '1abc', 'a'.repeat(25)]) {
      expect(() => assertValidLocalEnvironmentName(name)).toThrow();
    }
    expect(() => assertValidLocalEnvironmentName('local')).not.toThrow();
  });
});

describe('local lock', () => {
  const lock = buildLocalLock('local');

  it('uses the database name as its identifier so Wrangler resolves it in every command', () => {
    for (const [binding, resource] of Object.entries(lock.d1)) {
      expect(resource.id, binding).toBe(resource.name);
    }
  });

  it('declares every fixed database and the three bootstrap tenant shards', () => {
    expect(Object.keys(lock.d1).sort()).toEqual(
      [
        ...D1_DATABASES.map((database) => database.binding),
        'LOCAL_TDB_DEFAULT_BOOTSTRAP_CORE',
        'LOCAL_TDB_USERS_BOOTSTRAP_CORE',
        'LOCAL_TDB_PII_BOOTSTRAP_PII',
      ].sort()
    );
    expect(listLocalD1Databases('local').map((database) => database.binding)).toEqual(
      Object.keys(lock.d1)
    );
  });

  it('declares every KV namespace and no queue or R2 bucket', () => {
    expect(Object.keys(lock.kv).sort()).toEqual([...KV_NAMESPACES].sort());
    expect(listLocalKvNamespaces('local')).toHaveLength(KV_NAMESPACES.length);
    expect(lock.queues).toBeUndefined();
    expect(lock.r2).toBeUndefined();
  });
});

describe('component selection', () => {
  it('runs every Worker by default, router first', () => {
    const selection = selectLocalComponents();
    expect(selection.running[0]).toBe('ar-router');
    expect([...selection.running].sort()).toEqual([...CORE_WORKER_COMPONENTS].sort());
    expect(selection.excluded).toEqual([]);
  });

  it('keeps the Durable Object host and the router when narrowed', () => {
    const selection = selectLocalComponents(['auth', 'ar-token']);
    expect(selection.running).toEqual(['ar-router', 'ar-lib-core', 'ar-auth', 'ar-token']);
    expect(selection.excluded).toContain('ar-saml');
  });

  it('adds ar-control whenever management runs, because admin writes ask it first', () => {
    expect(selectLocalComponents(['management']).running).toContain('ar-control');
    expect(selectLocalComponents(['token']).running).not.toContain('ar-control');
  });

  it('rejects unknown components', () => {
    expect(() => selectLocalComponents(['nope'])).toThrow(/Unknown component/);
  });
});

describe('local paths', () => {
  it('keeps local state apart from Cloudflare environments', () => {
    const paths = getLocalEnvironmentPaths('/repo', 'local');
    expect(paths.root).toBe('/repo/.authrim-local/local');
    expect(paths.root).not.toContain('/.authrim/');
    expect(paths.state).toBe('/repo/.authrim-local/local/state');
    expect(paths.lock).toBe('/repo/.authrim-local/local.lock');
  });

  it('writes per-package files under names that never collide with deploy output', () => {
    expect(getLocalWorkerConfigPath('/repo', 'ar-auth', 'local')).toBe(
      '/repo/packages/ar-auth/wrangler.local.local.toml'
    );
    // Two environments never share a file, so one cannot overwrite or reset the other.
    expect(getLocalWorkerConfigPath('/repo', 'ar-auth', 'dev1')).toBe(
      '/repo/packages/ar-auth/wrangler.local.dev1.toml'
    );
    expect(getLocalWorkerDevVarsPath('/repo', 'ar-auth', 'local')).toBe(
      '/repo/packages/ar-auth/.dev.vars.local'
    );
  });
});
