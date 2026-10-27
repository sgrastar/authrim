import { createArchiveTestConfig, generateArchiveTestWrangler } from './fixtures/log-archive.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { D1_DATABASES, KV_NAMESPACES, getBuiltinD1BindingsForComponent } from '../core/naming.js';
import { loadWorkerCapabilityManifests } from '../core/worker-capabilities.js';
import type { WorkerComponent } from '../core/naming.js';

/**
 * A Worker that resolves the identity mapping reads it from the Admin database (DB_ADMIN) and
 * decides which mapping applies from the tenant's settings (SETTINGS, KV). A Worker that resolves
 * it without DB_ADMIN used to swallow the failure and answer without the mapping (UserInfo did, so
 * its claims differed from the ID token's); now a selection that names a set fails without
 * DB_ADMIN. This fixes, against the source, the capability manifests and the generated Wrangler
 * configuration, that every Worker which calls the resolution declares and receives both.
 */

const ROOT_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGES_DIR = join(ROOT_DIR, 'packages');

/**
 * The shared entry points that reach `resolveRuntimeIdentityMappingBinding`: the resolver itself,
 * the OIDC mapping (`applyOIDCIdentityMapping`, `deriveOIDCSubject`) and the ID token release that
 * calls it (`mapIDTokenClaims`, `releaseIDTokenClaims`), and the Introspection mapping. And the
 * selection of the Mapping Set (`selectIdentityMapping`: the app, the tenant default, the platform
 * default, which are read from SETTINGS) and the reading of the chosen set
 * (`loadMappingBindingBySetId`, `resolveOidcIdentityMappingBinding`: read from DB_ADMIN), which the
 * release of claims and the consent screen call.
 */
const RESOLUTION_ENTRY_POINTS =
  /\b(resolveRuntimeIdentityMappingBinding|applyOIDCIdentityMapping|deriveOIDCSubject|mapIDTokenClaims|releaseIDTokenClaims|applyIntrospectionIdentityMapping|selectIdentityMapping|resolveOidcIdentityMappingBinding|loadMappingBindingBySetId)\b/;

/**
 * The Workers whose source calls the resolution. Adding a caller fails the test below until it is
 * listed here, which is the moment to give it DB_ADMIN and SETTINGS. `ar-lib-core` is the library
 * these entry points live in, not a caller.
 */
const RESOLVING_WORKERS = [
  'ar-auth',
  'ar-management',
  'ar-saml',
  'ar-token',
  'ar-userinfo',
  'ar-vc',
] as const satisfies readonly WorkerComponent[];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function runtimeSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist') return [];
    if (entry.name === '__tests__' || entry.name === '__fixtures__') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return runtimeSourceFiles(path);
    return /\.(ts|js|svelte)$/.test(entry.name) && !/\.(test|spec|stories)\./.test(entry.name)
      ? [path]
      : [];
  });
}

/** The packages (other than the library) with a runtime source file that reaches the resolution. */
function packagesCallingTheResolution(): Map<string, string[]> {
  const callers = new Map<string, string[]>();
  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'ar-lib-core') continue;
    const sourceDirectory = join(PACKAGES_DIR, entry.name, 'src');
    let files: string[];
    try {
      files = runtimeSourceFiles(sourceDirectory);
    } catch {
      continue;
    }
    const matching = files.filter((file) =>
      RESOLUTION_ENTRY_POINTS.test(withoutComments(readFileSync(file, 'utf8')))
    );
    if (matching.length > 0) {
      callers.set(
        entry.name,
        matching.map((file) => file.slice(PACKAGES_DIR.length + 1))
      );
    }
  }
  return callers;
}

function resourceIds() {
  return {
    d1: Object.fromEntries(
      D1_DATABASES.map((database) => [
        database.binding,
        { id: `id-${database.binding.toLowerCase()}`, name: `test-${database.dbType}` },
      ])
    ),
    kv: Object.fromEntries(
      KV_NAMESPACES.map((binding) => [
        binding,
        { id: `id-${binding.toLowerCase()}`, name: `TEST-${binding}` },
      ])
    ),
  };
}

describe('the entry points this test looks for', () => {
  it('include the selection and the reading of the chosen set, so a Worker that calls them is listed', () => {
    for (const name of [
      'selectIdentityMapping',
      'resolveOidcIdentityMappingBinding',
      'loadMappingBindingBySetId',
    ]) {
      expect(RESOLUTION_ENTRY_POINTS.test(`await ${name}(input)`), name).toBe(true);
    }
    // A name that only contains one of them is not a call.
    expect(RESOLUTION_ENTRY_POINTS.test('myselectIdentityMapping2')).toBe(false);
  });
});

describe('Workers that resolve the identity mapping', () => {
  it('are exactly the Workers this test lists (a new caller must be reviewed here)', () => {
    const callers = packagesCallingTheResolution();

    expect(
      [...callers.keys()].sort(),
      JSON.stringify(Object.fromEntries(callers), null, 2)
    ).toEqual([...RESOLVING_WORKERS].sort());
  });

  it.each(RESOLVING_WORKERS)(
    '%s declares DB_ADMIN and SETTINGS as required bindings',
    async (component) => {
      const [compiled] = await loadWorkerCapabilityManifests({
        baseDir: ROOT_DIR,
        components: [component],
      });

      expect(compiled?.manifest.bindings).toContainEqual(
        expect.objectContaining({ name: 'DB_ADMIN', kind: 'd1', required: true })
      );
      expect(compiled?.manifest.bindings).toContainEqual(
        expect.objectContaining({ name: 'SETTINGS', kind: 'kv_namespace', required: true })
      );
    }
  );

  it.each(RESOLVING_WORKERS)('%s is allowed the Admin database in setup', (component) => {
    expect(getBuiltinD1BindingsForComponent(component)).toContain('DB_ADMIN');
  });

  it.each(RESOLVING_WORKERS)(
    '%s receives DB_ADMIN and SETTINGS in its generated Wrangler configuration',
    (component) => {
      const config = createArchiveTestConfig('test');
      config.components.adminUi = false;

      const generated = generateArchiveTestWrangler(component, config, resourceIds());

      expect(generated.d1_databases).toContainEqual(
        expect.objectContaining({ binding: 'DB_ADMIN', database_id: 'id-db_admin' })
      );
      expect(generated.kv_namespaces).toContainEqual({
        binding: 'SETTINGS',
        id: 'id-settings',
      });
    }
  );
});
