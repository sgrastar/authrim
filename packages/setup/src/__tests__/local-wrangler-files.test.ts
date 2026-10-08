import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateAllSecrets, saveKeysToDirectory } from '../core/keys.js';
import { CORE_WORKER_COMPONENTS, type WorkerComponent } from '../core/naming.js';
import { SECRET_UPLOAD_PLAN } from '../core/secrets.js';
import {
  LOCAL_LOG_NOTIFIER_ENV,
  buildResourceIdsFromLock,
  generateEnvVars,
  generateWranglerConfig,
  toToml,
} from '../core/wrangler.js';
import {
  buildLocalConfig,
  buildLocalLock,
  selectLocalComponents,
} from '../core/local/environment.js';
import {
  buildLocalSeedConfigToml,
  buildLocalWorkerFiles,
  formatDevVars,
  formatDevVarsValue,
  loadLocalSecretsForComponent,
} from '../core/local/wrangler-files.js';

describe('dev vars formatting', () => {
  it('single-quotes single-line values so dotenv leaves them untouched', () => {
    expect(formatDevVarsValue('abc_DEF-123\n')).toBe("'abc_DEF-123'");
  });

  it('compacts pretty-printed JSON onto one line', () => {
    expect(formatDevVarsValue(JSON.stringify({ kty: 'OKP', crv: 'Ed25519' }, null, 2))).toBe(
      `'{"kty":"OKP","crv":"Ed25519"}'`
    );
  });

  it('escapes newlines in multi-line values such as PEM keys', () => {
    expect(formatDevVarsValue('-----BEGIN KEY-----\nAAAA\n-----END KEY-----\n')).toBe(
      '"-----BEGIN KEY-----\\nAAAA\\n-----END KEY-----"'
    );
  });

  it('refuses a multi-line value that cannot be quoted safely', () => {
    expect(() => formatDevVarsValue('a "quoted"\nvalue')).toThrow();
  });

  it('sorts keys and marks the file as generated', () => {
    const text = formatDevVars({ B: '2', A: '1' });
    expect(text.split('\n').slice(1, 3)).toEqual(["A='1'", "B='2'"]);
    expect(text.startsWith('# Generated')).toBe(true);
  });
});

describe('generated local files', () => {
  const root = join(process.cwd(), `.test-local-${Date.now()}`);
  const keysDir = join(root, 'keys');
  const config = buildLocalConfig({ env: 'local' });
  const lock = buildLocalLock('local');
  const everything = selectLocalComponents();
  let files: Awaited<ReturnType<typeof buildLocalWorkerFiles>>;

  beforeAll(async () => {
    mkdirSync(root, { recursive: true });
    await saveKeysToDirectory(generateAllSecrets('local-key'), { targetDir: keysDir });
    files = await buildLocalWorkerFiles({
      config,
      lock,
      keysDir,
      running: everything.running,
      excluded: everything.excluded,
    });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const toml = (component: WorkerComponent): string =>
    files.find((file) => file.component === component)!.toml;

  it('produces a config and secrets file for every Worker', () => {
    expect(files.map((file) => file.component).sort()).toEqual([...CORE_WORKER_COMPONENTS].sort());
  });

  it('drops everything that only exists for Cloudflare deployments', () => {
    for (const file of files) {
      expect(file.toml, file.component).not.toContain('[build]');
      expect(file.toml, file.component).not.toContain('guard-managed-worker-deploy');
      expect(file.toml, file.component).not.toContain('.triggers]');
      expect(file.toml, file.component).not.toContain('.placement]');
      expect(file.toml, file.component).not.toContain('login-ui');
      expect(file.toml, file.component).not.toContain('admin-ui');
    }
  });

  it('wires the router to the Workers that run, including Control', () => {
    const router = toml('ar-router');
    expect(router).toContain('service = "local-ar-control"');
    expect(router).toContain('service = "local-ar-auth"');
    expect(router).toContain('http://localhost:8787');
  });

  it('removes bindings to Workers left out with --only', () => {
    const narrowed = selectLocalComponents(['auth', 'token']);
    const generated = generateWranglerConfig(
      'ar-router',
      config,
      buildResourceIdsFromLock(lock, config),
      undefined,
      { local: { excludedComponents: narrowed.excluded } }
    );
    const services = (generated.services ?? []).map((service) => service.service);
    expect(services).toContain('local-ar-auth');
    expect(services).toContain('local-ar-token');
    expect(services).not.toContain('local-ar-saml');
    expect(services).not.toContain('local-ar-control');
  });

  it('treats the API and both UIs on localhost ports as one site, with Lax cookies', () => {
    for (const component of ['ar-auth', 'ar-management'] as const) {
      const text = toml(component);
      expect(text, component).toContain('ADMIN_UI_URL = "http://localhost:5174"');
      expect(text, component).toContain('ADMIN_UI_API_MODE = "same-site-cross-origin"');
      expect(text, component).toContain('ADMIN_COOKIE_SAME_SITE = "Lax"');
    }
    expect(toml('ar-auth')).toContain('COOKIE_SAME_SITE = "Lax"');
    expect(toml('ar-auth')).not.toContain('COOKIE_SAME_SITE = "None"');
  });

  it('allows the API origin and both UI origins to call the API with credentials', () => {
    const origins =
      'ALLOWED_ORIGINS = "http://localhost:8787,http://localhost:5173,http://localhost:5174"';
    for (const component of ['ar-router', 'ar-auth', 'ar-management'] as const) {
      expect(toml(component), component).toContain(origins);
    }
  });

  it('allows the http loopback redirect URIs the Login UI client registers', () => {
    for (const file of files) expect(file.toml).toContain('HTTPS_REDIRECT_ONLY = "false"');
  });

  it('enables the local log notifier on the plugin runner only', () => {
    for (const file of files) {
      const enabled = file.toml.includes(`${LOCAL_LOG_NOTIFIER_ENV} = "true"`);
      expect(enabled, file.component).toBe(file.component === 'ar-plugin-runner');
    }
  });

  it('never emits the local-only variables for a Cloudflare deployment', () => {
    const resourceIds = buildResourceIdsFromLock(lock, config);
    for (const component of CORE_WORKER_COMPONENTS) {
      const cloud = generateWranglerConfig(component, config, resourceIds);
      expect(cloud.vars[LOCAL_LOG_NOTIFIER_ENV], component).toBeUndefined();
      expect(cloud.vars['HTTPS_REDIRECT_ONLY'], component).toBeUndefined();
      expect(toToml(cloud, 'prod')).not.toContain(LOCAL_LOG_NOTIFIER_ENV);
      expect(generateEnvVars(component, config)[LOCAL_LOG_NOTIFIER_ENV], component).toBeUndefined();
    }
  });

  it('does not turn localhost ports into one site for a Cloudflare-shaped config', () => {
    // The same-site shortcut for localhost is opt-in and only the local shape asks for it.
    const resourceIds = buildResourceIdsFromLock(lock, config);
    const cloud = generateWranglerConfig('ar-auth', config, resourceIds);
    expect(cloud.vars['ADMIN_UI_API_MODE']).not.toBe('same-site-cross-origin');
    expect(cloud.vars['COOKIE_SAME_SITE']).not.toBe('Lax');
    expect(generateEnvVars('ar-auth', config)['ADMIN_UI_API_MODE']).not.toBe(
      'same-site-cross-origin'
    );
    expect(
      generateEnvVars('ar-auth', config, undefined, { allowLocalhostSameSite: true })[
        'ADMIN_UI_API_MODE'
      ]
    ).toBe('same-site-cross-origin');
  });

  it('gives each Worker exactly the secrets its upload plan lists', async () => {
    const auth = await loadLocalSecretsForComponent(keysDir, 'ar-auth');
    expect(Object.keys(auth).sort()).toEqual(
      [...SECRET_UPLOAD_PLAN['ar-auth']].filter((name) => name in auth).sort()
    );
    expect(auth['PRIVATE_KEY_PEM']).toContain('BEGIN');
    expect(auth['TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS']).toContain('Ed25519');
    expect(auth['LOOKUP_HMAC_KEY_SLOT_A']).toBeTruthy();
  });

  it('keeps Cloudflare credentials and the backup key out of every secrets file', async () => {
    // With a backup wrapping key set, every settings write needs a Control permit for backups.
    for (const component of CORE_WORKER_COMPONENTS) {
      const secrets = await loadLocalSecretsForComponent(keysDir, component);
      expect(Object.keys(secrets).filter((name) => name.startsWith('CLOUDFLARE_'))).toEqual([]);
      expect(secrets).not.toHaveProperty('TENANT_BACKUP_WRAPPING_KEY');
      expect(secrets).not.toHaveProperty('RESEND_API_KEY');
    }
  });

  it('writes the local registry verification key and the signing key to the matching Workers', async () => {
    const control = await loadLocalSecretsForComponent(keysDir, 'ar-control');
    expect(control['RUNTIME_REGISTRY_SIGNING_JWK_SLOT_A']).toContain('"d"');
    const router = await loadLocalSecretsForComponent(keysDir, 'ar-router');
    expect(router).toEqual({});
  });
});

describe('local generation follows the shared Worker contracts', () => {
  const config = buildLocalConfig({ env: 'local' });
  const lock = buildLocalLock('local');
  const resourceIds = buildResourceIdsFromLock(lock, config);
  const local = { local: { excludedComponents: [] } };

  it('gives ar-async the Lookup database, the session store and the user-code rate limiter', () => {
    const asyncConfig = toToml(
      generateWranglerConfig('ar-async', config, resourceIds, undefined, local),
      'local'
    );
    expect(asyncConfig).toContain('binding = "LOOKUP_DB"');
    expect(asyncConfig).toMatch(/name = "SESSION_STORE"[^[]*script_name = "local-ar-lib-core"/u);
    expect(asyncConfig).toMatch(
      /name = "USER_CODE_RATE_LIMITER"[^[]*script_name = "local-ar-lib-core"/u
    );
  });

  it('hosts UserCodeRateLimiter in ar-lib-core with its Durable Object migration', () => {
    const core = toToml(
      generateWranglerConfig('ar-lib-core', config, resourceIds, undefined, local),
      'local'
    );
    expect(core).toContain('name = "USER_CODE_RATE_LIMITER"');
    expect(core).toContain('"UserCodeRateLimiter"');
  });

  it('writes the Lookup HMAC key to ar-async like every other Lookup user', async () => {
    const root = join(process.cwd(), `.test-local-async-${Date.now()}`);
    try {
      mkdirSync(root, { recursive: true });
      await saveKeysToDirectory(generateAllSecrets('local-key'), { targetDir: join(root, 'keys') });
      const secrets = await loadLocalSecretsForComponent(join(root, 'keys'), 'ar-async');
      expect(secrets['LOOKUP_HMAC_KEY_SLOT_A']).toBeTruthy();
      expect(secrets['OBJECT_ENCRYPTION_ROOT_KEY']).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never goes through the Cloudflare deploy secret gate', () => {
    // deployAll's assertRequiredWorkerSecrets guards first deployments; local mode writes every
    // secret itself and must not depend on (or trip) that check.
    for (const file of [
      'data.ts',
      'init.ts',
      'runtime.ts',
      'wrangler-files.ts',
      'admin-session.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), 'src/core/local', file), 'utf8');
      expect(source, file).not.toMatch(
        /assertRequiredWorkerSecrets|deployAll|core\/deploy\.js|\.\/deploy\.js/u
      );
    }
  });
});

describe('seed config', () => {
  it('declares every binding the seeding commands address, with the lock identifiers', () => {
    const text = buildLocalSeedConfigToml('local');
    const lock = buildLocalLock('local');
    for (const [binding, database] of Object.entries(lock.d1)) {
      expect(text).toContain(`binding = "${binding}"`);
      expect(text).toContain(`database_id = "${database.id}"`);
    }
    for (const [binding, namespace] of Object.entries(lock.kv)) {
      expect(text).toContain(`binding = "${binding}"`);
      expect(text).toContain(`id = "${namespace.id}"`);
    }
  });
});
