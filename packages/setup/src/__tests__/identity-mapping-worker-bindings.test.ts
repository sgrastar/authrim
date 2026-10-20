import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../core/config.js';
import { D1_DATABASES, KV_NAMESPACES, getBuiltinD1BindingsForComponent } from '../core/naming.js';
import { loadWorkerCapabilityManifests } from '../core/worker-capabilities.js';
import { generateWranglerConfig } from '../core/wrangler.js';
import type { WorkerComponent } from '../core/naming.js';

/**
 * A Worker that resolves the identity mapping reads it from the Admin database (DB_ADMIN) and
 * decides which mapping applies from the tenant's settings (SETTINGS, KV). A Worker that resolves
 * it without DB_ADMIN used to swallow the failure and answer without the mapping (UserInfo did, so
 * its claims differed from the ID token's). This fixes, against the source, the capability
 * manifests and the generated Wrangler configuration, that every Worker which calls the
 * resolution declares and receives both.
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
 * release of claims will move to.
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
      const config = createDefaultConfig('test');
      config.components.adminUi = false;

      const generated = generateWranglerConfig(component, config, resourceIds());

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

/**
 * The shadow comparison of the Mapping Set selection runs after the current resolution, off the
 * request's path. A Worker that does not hand it to `waitUntil` lets the runtime cut it off when
 * the response is sent (an early answer, such as login_required, included). So every place in a
 * Worker that starts an OIDC resolution passes `waitUntil`: the direct calls
 * (`applyOIDCIdentityMapping`, `deriveOIDCSubject`) and the contexts the ID token release is run
 * with (the object that carries `loadUserAttributes`).
 */
describe('Workers that resolve the OIDC identity mapping hand the shadow comparison to waitUntil', () => {
  /** The `{ ... }` that encloses `index`, balanced, or the argument object that starts at it. */
  function enclosingObject(source: string, index: number): string {
    let depth = 0;
    let start = index;
    for (; start >= 0; start -= 1) {
      const char = source[start];
      if (char === '}') depth += 1;
      if (char === '{') {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    return balancedFrom(source, start);
  }
  function balancedFrom(source: string, start: number): string {
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    return source.slice(start);
  }

  function sites(): Array<{ file: string; kind: string; text: string }> {
    const found: Array<{ file: string; kind: string; text: string }> = [];
    for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'ar-lib-core') continue;
      let files: string[];
      try {
        files = runtimeSourceFiles(join(PACKAGES_DIR, entry.name, 'src'));
      } catch {
        continue;
      }
      for (const file of files) {
        const source = withoutComments(readFileSync(file, 'utf8'));
        const name = file.slice(PACKAGES_DIR.length + 1);
        for (const match of source.matchAll(
          /\b(applyOIDCIdentityMapping|deriveOIDCSubject)\(\s*\{/g
        )) {
          found.push({
            file: name,
            kind: match[1],
            text: balancedFrom(source, match.index + match[0].length - 1),
          });
        }
        for (const match of source.matchAll(/\bloadUserAttributes:/g)) {
          found.push({
            file: name,
            kind: 'IDTokenReleaseContext',
            text: enclosingObject(source, match.index),
          });
        }
      }
    }
    return found;
  }

  it('finds the places that start a resolution (so the check below is not empty)', () => {
    const kinds = new Set(sites().map((site) => `${site.file.split('/')[0]}:${site.kind}`));
    expect(kinds).toEqual(
      new Set([
        'ar-userinfo:applyOIDCIdentityMapping',
        'ar-auth:deriveOIDCSubject',
        'ar-auth:IDTokenReleaseContext',
        'ar-token:IDTokenReleaseContext',
      ])
    );
  });

  it('passes waitUntil at every one of them', () => {
    const without = sites().filter((site) => !/\bwaitUntil\b/.test(site.text));
    expect(without.map((site) => `${site.file} (${site.kind})`)).toEqual([]);
  });
});
