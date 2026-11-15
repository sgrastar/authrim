import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_ASSETS } from '../gate-assets';
import { errorPage, gatePage, LANGS, SITE_CSS, startPage, WAIT_JS } from '../html';
import { loadConfig } from '../config';
import { handleRequest } from '../index';
import { CSP } from '../respond';
import {
  createTestDb,
  createUpstream,
  makeEnv,
  PORTAL,
  type TestDb,
  type Upstream,
} from './helpers';
import type { Env } from '../types';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = join(ROOT, 'public');

let testDb: TestDb;
let upstream: Upstream;
let env: Env;

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  testDb = createTestDb();
  upstream = createUpstream();
  env = await makeEnv(testDb);
});

const get = (path: string) => handleRequest(new Request(`${PORTAL}${path}`), env, upstream.deps);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('/assets/ routing', () => {
  it('still answers the Worker-served stylesheet and script, with the security headers', async () => {
    for (const [path, type] of [
      ['/assets/site.css', 'text/css'],
      ['/assets/wait.js', 'javascript'],
    ] as const) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      expect(response.headers.get('content-security-policy')).toBe(CSP);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(await (await get('/assets/site.css')).text()).toBe(SITE_CSS);
    expect(await (await get('/assets/wait.js')).text()).toBe(WAIT_JS);
  });

  it('answers an unknown path under /assets/ with the Worker 404, not with an image', async () => {
    const response = await get('/assets/gate/nothing-here.avif');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('keeps public/ free of anything that would shadow a Worker route', () => {
    const files = walk(PUBLIC).map((file) => relative(PUBLIC, file));
    for (const file of files) {
      expect(file === '_headers' || file.startsWith('assets/gate/'), file).toBe(true);
    }
    expect(existsSync(join(PUBLIC, 'assets/site.css'))).toBe(false);
    expect(existsSync(join(PUBLIC, 'assets/wait.js'))).toBe(false);
  });

  it('declares the static assets directory in the Worker config', () => {
    const config = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"assets": { "directory": "./public" }');
  });

  it('caches the hashed images for a year and sends nosniff', () => {
    const headers = readFileSync(join(PUBLIC, '_headers'), 'utf8');
    expect(headers).toContain('/assets/gate/*');
    expect(headers).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
  });
});

describe('the gate images', () => {
  it('has every manifest file in public/, named after its own content hash', () => {
    for (const [logical, url] of Object.entries(GATE_ASSETS)) {
      const path = join(PUBLIC, url);
      expect(existsSync(path), logical).toBe(true);
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10);
      expect(url).toContain(`.${hash}.`);
    }
  });

  it('ships nothing else: no sky, no mask, no preview or master', () => {
    const shipped = new Set(Object.values(GATE_ASSETS).map((url) => join(PUBLIC, url)));
    const files = walk(join(PUBLIC, 'assets/gate'));
    expect(files.length).toBe(shipped.size);
    for (const file of files) {
      expect(shipped.has(file), file).toBe(true);
      expect(file).not.toMatch(/sky|mask|preview|master|placeholder/);
    }
  });

  it('only references image files that exist, from every page and from the script', async () => {
    const config = loadConfig(env);
    if (!config.ok) throw new Error('config');
    const pages = LANGS.flatMap((lang) => [
      startPage(lang, config.config),
      gatePage(lang, config.config),
      errorPage(lang, 'failed'),
    ]);
    const urls = new Set<string>();
    for (const text of [...pages, WAIT_JS, SITE_CSS]) {
      for (const [url] of text.matchAll(/\/assets\/gate\/[A-Za-z0-9._-]+/g)) urls.add(url);
    }
    expect(urls.size).toBeGreaterThan(0);
    for (const url of urls) expect(existsSync(join(PUBLIC, url)), url).toBe(true);
    // the start page loads the far view and nothing else
    const start = startPage('en', config.config);
    for (const [url] of start.matchAll(/\/assets\/gate\/[A-Za-z0-9._-]+/g)) {
      expect(url).toContain('far-dark');
    }
  });

  it('ships a script that parses', () => {
    expect(() => new Function(WAIT_JS)).not.toThrow(); // eslint-disable-line @typescript-eslint/no-implied-eval
  });

  it('keeps the script free of inline style writes, HTML injection and external hosts', () => {
    expect(WAIT_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|document\.write/);
    expect(WAIT_JS).not.toMatch(/\.style\b|cssText|setAttribute\('style'/);
    expect(WAIT_JS).not.toMatch(/https?:\/\//);
    expect(WAIT_JS).toContain("fetch('/status'");
    expect(WAIT_JS.length).toBeLessThan(40 * 1024);
  });
});

describe('the policy is exactly as strict as before', () => {
  it('keeps the CSP header text', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
  });

  it('sends it on every page, with no-store HTML', async () => {
    for (const path of ['/', '/wait', '/nope']) {
      const response = await get(path);
      expect(response.headers.get('content-security-policy')).toBe(CSP);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});
