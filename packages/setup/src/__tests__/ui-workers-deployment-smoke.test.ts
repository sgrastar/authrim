import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');

async function readPackageJson(component: 'ar-admin-ui' | 'ar-login-ui') {
  const content = await readFile(resolve(repoRoot, component, 'package.json'), 'utf-8');
  return JSON.parse(content) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

async function readSvelteConfig(component: 'ar-admin-ui' | 'ar-login-ui') {
  return readFile(resolve(repoRoot, component, 'svelte.config.js'), 'utf-8');
}

describe('UI Workers deployment smoke tests', () => {
  it.each(['ar-admin-ui', 'ar-login-ui'] as const)(
    '%s uses Cloudflare adapter and wrangler deploy scripts',
    async (component) => {
      const pkg = await readPackageJson(component);
      const svelteConfig = await readSvelteConfig(component);

      expect(pkg.devDependencies).toHaveProperty('@sveltejs/adapter-cloudflare');
      expect(pkg.scripts?.['deploy:preview']).toContain('wrangler deploy');
      expect(pkg.scripts?.['deploy:production']).toContain('wrangler deploy');
      expect(pkg.scripts?.['deploy:preview']).not.toContain('wrangler pages');
      expect(pkg.scripts?.['deploy:production']).not.toContain('wrangler pages');
      expect(svelteConfig).toContain('@sveltejs/adapter-cloudflare');
      expect(svelteConfig).toContain('routes:');
    }
  );

  it('keeps LoginUI OAuth endpoints excluded from the UI Worker route handler', async () => {
    const svelteConfig = await readSvelteConfig('ar-login-ui');

    for (const path of ['/authorize', '/token', '/userinfo', '/introspect', '/revoke']) {
      expect(svelteConfig).toContain(`'${path}'`);
    }
    expect(svelteConfig).toContain("'/api/device/*'");
  });

  it('keeps LoginUI session, callback, and proxy routes on the UI Worker', async () => {
    const svelteConfig = await readSvelteConfig('ar-login-ui');

    for (const path of [
      '/callback',
      '/api/auth/authentication-methods',
      '/api/v1/auth/direct/session',
      '/handoff/finalize',
      '/logout',
    ]) {
      expect(svelteConfig).not.toContain(`'${path}'`);
      expect(svelteConfig).not.toContain(`'${path}/*'`);
    }
  });
});
