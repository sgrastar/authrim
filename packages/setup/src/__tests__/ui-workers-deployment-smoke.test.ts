import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKER_COMPONENTS } from '../core/naming.js';

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
    '%s uses the Cloudflare adapter and the shared staged deployment entry point',
    async (component) => {
      const pkg = await readPackageJson(component);
      const svelteConfig = await readSvelteConfig(component);

      expect(pkg.devDependencies).toHaveProperty('@sveltejs/adapter-cloudflare');
      expect(pkg.scripts?.['deploy:preview']).toContain('scripts/deploy-ui.ts');
      expect(pkg.scripts?.['deploy:production']).toContain('scripts/deploy-ui.ts');
      expect(pkg.scripts?.['deploy:preview']).toContain(`--package=${component}`);
      expect(pkg.scripts?.['deploy:production']).toContain(`--package=${component}`);
      expect(pkg.scripts?.['deploy:preview']).not.toContain('wrangler deploy');
      expect(pkg.scripts?.['deploy:production']).not.toContain('wrangler deploy');
      expect(pkg.scripts?.['deploy:preview']).not.toContain('wrangler pages');
      expect(pkg.scripts?.['deploy:production']).not.toContain('wrangler pages');
      expect(svelteConfig).toContain('@sveltejs/adapter-cloudflare');
      expect(svelteConfig).toContain('routes:');
    }
  );

  it.each(WORKER_COMPONENTS)(
    '%s package deploy command uses the shared dependency-aware deployer',
    async (component) => {
      const content = await readFile(resolve(repoRoot, component, 'package.json'), 'utf-8');
      const pkg = JSON.parse(content) as { scripts?: Record<string, string> };

      expect(pkg.scripts?.deploy).toContain('scripts/deploy-api.ts');
      expect(pkg.scripts?.deploy).toContain(`--component=${component}`);
      expect(pkg.scripts?.deploy).not.toContain('wrangler deploy');
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
