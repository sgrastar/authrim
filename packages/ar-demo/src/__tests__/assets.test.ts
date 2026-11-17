import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CITY_SCRIPT, CITY_SCRIPT_BYTES } from '../city-assets';
import { errorPage, gatePage, LANGS, SCENE_JS, SITE_CSS, startPage, WAIT_JS } from '../html';
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
      ['/assets/scene.js', 'javascript'],
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
    expect(await (await get('/assets/scene.js')).text()).toBe(SCENE_JS);
    expect(await (await get('/assets/wait.js')).text()).toBe(WAIT_JS);
  });

  it('answers an unknown path under /assets/ with the Worker 404', async () => {
    const response = await get('/assets/city/nothing-here.js');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('keeps public/ free of anything that would shadow a Worker route', () => {
    const files = walk(PUBLIC).map((file) => relative(PUBLIC, file));
    for (const file of files) {
      expect(
        file === '_headers' || file === 'robots.txt' || file.startsWith('assets/city/'),
        file
      ).toBe(true);
    }
    expect(existsSync(join(PUBLIC, 'assets/site.css'))).toBe(false);
    expect(existsSync(join(PUBLIC, 'assets/scene.js'))).toBe(false);
    expect(existsSync(join(PUBLIC, 'assets/wait.js'))).toBe(false);
  });

  it('asks crawlers to stay away from the whole portal', () => {
    expect(readFileSync(join(PUBLIC, 'robots.txt'), 'utf8')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('declares the static assets directory in the Worker config', () => {
    const config = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
    expect(config).toContain('"assets": { "directory": "./public" }');
  });

  it('caches the hashed scene script for a year and sends nosniff', () => {
    const headers = readFileSync(join(PUBLIC, '_headers'), 'utf8');
    expect(headers).toContain('/assets/city/*');
    expect(headers).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
  });
});

describe('the scene script', () => {
  it('is in public/, named after its own content hash, and is the only file there', () => {
    const path = join(PUBLIC, CITY_SCRIPT);
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path);
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 10);
    expect(CITY_SCRIPT).toBe(`/assets/city/city.${hash}.js`);
    expect(body.length).toBe(CITY_SCRIPT_BYTES);
    expect(walk(join(PUBLIC, 'assets/city'))).toEqual([path]);
  });

  it('stays inside its size: what travels is the compressed file', () => {
    const body = readFileSync(join(PUBLIC, CITY_SCRIPT));
    expect(gzipSync(body).length).toBeLessThan(200 * 1024);
    expect(CITY_SCRIPT_BYTES).toBeLessThan(640 * 1024);
  });

  it('runs under the page policy: no eval, no worker, no request of its own', () => {
    const body = readFileSync(join(PUBLIC, CITY_SCRIPT), 'utf8');
    expect(body).not.toMatch(/\beval\(|new Function\(|new Worker\(|importScripts\(/);
    expect(body).not.toMatch(/\bfetch\(|XMLHttpRequest|innerHTML|document\.write/);
    expect(body).toContain('AuthrimCity');
  });

  it('is loaded by every page, and no page asks for a file that is not there', async () => {
    const config = loadConfig(env);
    if (!config.ok) throw new Error('config');
    const pages = LANGS.flatMap((lang) => [
      startPage(lang, config.config),
      gatePage(lang, config.config),
      errorPage(lang, 'failed'),
    ]);
    for (const page of pages) {
      const urls = [...page.matchAll(/\/assets\/city\/[A-Za-z0-9._-]+/g)].map(([url]) => url);
      expect(urls).toEqual([CITY_SCRIPT]);
    }
    for (const text of [SCENE_JS, WAIT_JS, SITE_CSS]) expect(text).not.toContain('/assets/city/');
  });

  it('ships scripts that parse', () => {
    expect(() => new Function(SCENE_JS)).not.toThrow(); // eslint-disable-line @typescript-eslint/no-implied-eval
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
    expect(SCENE_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|document\.write/);
    expect(SCENE_JS).not.toMatch(/\.style\b|cssText|https?:\/\//);
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
