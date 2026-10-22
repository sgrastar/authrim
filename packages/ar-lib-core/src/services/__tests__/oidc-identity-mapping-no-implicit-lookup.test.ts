/**
 * The OIDC release of claims binds an app to a Mapping Set only by a name (the app's own choice,
 * the tenant's default, the platform's default), never by looking for an activation whose scope
 * fits (the lookup `resolveRuntimeIdentityMappingBinding` makes when it is given no Mapping Set).
 * The lookup stays for Introspection, VC and the SAML paths that have not moved; this fixes where
 * it may be called without a Mapping Set, so a new caller, or an OIDC path that slips back, fails
 * here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const FUNCTION_NAME = 'resolveRuntimeIdentityMappingBinding';

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '__tests__', '__fixtures__', '.svelte-kit'].includes(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|js|svelte)$/.test(entry.name) && !/\.(test|spec|stories)\./.test(entry.name)
      ? [path]
      : [];
  });
}

interface CallSite {
  file: string;
  /** The text of the context object the call passes. */
  context: string;
}

function allRuntimeFiles(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    try {
      return sourceFiles(join(PACKAGES_DIR, entry.name, 'src'));
    } catch {
      return [];
    }
  });
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

function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of allRuntimeFiles()) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    const name = relative(PACKAGES_DIR, file);
    if (name.endsWith('identity-mapping-runtime-resolver.ts')) continue;
    for (const match of source.matchAll(new RegExp(`\\b${FUNCTION_NAME}\\(`, 'g'))) {
      // The context object is the first `{` after the call opens (the adapter argument has none).
      const open = source.indexOf('{', match.index + match[0].length);
      sites.push({ file: name, context: balancedFrom(source, open) });
    }
  }
  return sites;
}

/** The context names the property, written `key: value` or as the shorthand `key,`. */
const hasSetId = (context: string) => /\bfieldMappingSetId(?=\s*[:,}])/.test(context);

describe('the lookup of an activation by its scope (no Mapping Set named)', () => {
  it('finds the call sites (so the checks below are not empty)', () => {
    expect(callSites().length).toBeGreaterThan(8);
  });

  it('is never made for OIDC without a Mapping Set', () => {
    const oidc = callSites().filter(
      (site) =>
        /protocol:\s*'oidc'/.test(site.context) || /protocol:\s*input\.protocol/.test(site.context)
    );
    expect(oidc.length).toBeGreaterThan(0);
    expect(
      oidc.filter((site) => !hasSetId(site.context)).map((site) => site.file),
      'an OIDC call that names no Mapping Set'
    ).toEqual([]);
  });

  it('is made without a Mapping Set only by Introspection and VC', () => {
    const without = callSites()
      .filter((site) => !hasSetId(site.context))
      .map((site) => site.file)
      .sort();

    expect(without).toEqual([
      'ar-lib-core/src/services/introspection-identity-mapping.ts',
      'ar-vc/src/verifier/routes/attribute-verify.ts',
      'ar-vc/src/verifier/routes/attribute-verify.ts',
    ]);
  });

  it.each([
    'ar-lib-core/src/services/oidc-identity-mapping.ts',
    'ar-lib-core/src/services/oidc-id-token-release.ts',
    'ar-lib-core/src/services/identity-mapping-resolution.ts',
    'ar-lib-core/src/services/identity-mapping-selection.ts',
    'ar-auth/src/authorize.ts',
    'ar-token/src/token.ts',
    'ar-userinfo/src/userinfo.ts',
  ])('is not reached from %s at all', (file) => {
    const source = withoutComments(readFileSync(join(PACKAGES_DIR, file), 'utf8'));

    expect(source).not.toContain(FUNCTION_NAME);
  });

  it('is reached from the sign-in flow only for SAML, with a Mapping Set', () => {
    const sites = callSites().filter((site) => site.file === 'ar-auth/src/login-runtime-flow.ts');

    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site.context).toMatch(/protocol:\s*'saml'/);
      expect(hasSetId(site.context)).toBe(true);
    }
  });
});
