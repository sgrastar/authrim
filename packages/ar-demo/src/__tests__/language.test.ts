import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_NAME } from '../handlers';
import { CITY_SCRIPT } from '../city-assets';
import {
  ASSET_VERSION,
  errorPage,
  gatePage,
  LANGS,
  SCENE_JS,
  SITE_CSS,
  startPage,
  WAIT_JS,
  type ErrorKind,
} from '../html';
import { COPY, chooseLang, pickLang, plain } from '../i18n';
import { handleRequest } from '../index';
import { CSP } from '../respond';
import { loadConfig } from '../config';
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

const get = (path: string, headers: Record<string, string> = {}) =>
  handleRequest(new Request(`${PORTAL}${path}`, { headers }), env, upstream.deps);

const ERROR_KINDS: ErrorKind[] = [
  'forbidden',
  'bad_request',
  'verification',
  'ip_limit',
  'capacity',
  'failed',
  'config',
  'not_found',
  'method',
];

async function configFor(hours: number) {
  const result = loadConfig(await makeEnv(testDb, { TENANT_TTL_HOURS: String(hours) }));
  if (!result.ok) throw new Error('config');
  return result.config;
}

describe('Accept-Language', () => {
  it('picks the best supported language, English otherwise', () => {
    expect(pickLang(null)).toBe('en');
    expect(pickLang('ja-JP,ja;q=0.9,en;q=0.8')).toBe('ja');
    expect(pickLang('en-US,en;q=0.9,ja;q=0.8')).toBe('en');
    expect(pickLang('en;q=0.5,ja;q=0.9')).toBe('ja');
    expect(pickLang('de-AT')).toBe('de');
    expect(pickLang('ar-SA,ar;q=0.9')).toBe('ar');
    expect(pickLang('ar-EG')).toBe('ar');
    // removed languages are not offered: they fall back like any unknown value
    for (const gone of ['fr-CA,fr;q=0.9', 'es-419', 'zh-CN', 'zh-TW', 'ko-KR']) {
      expect(pickLang(gone)).toBe('en');
    }
    expect(pickLang('ko-KR,de;q=0.5')).toBe('de');
    expect(pickLang('it,pt;q=0.9,de;q=0.1')).toBe('de');
    expect(pickLang('it,pt')).toBe('en');
    expect(pickLang('de;q=0')).toBe('en');
  });
});

describe('precedence: ?lang, then cookie, then Accept-Language, then English', () => {
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${PORTAL}${path}`, { headers });

  it('uses a valid query over everything', () => {
    const result = chooseLang(
      request('/?lang=de', { Cookie: 'demo_lang=ar', 'Accept-Language': 'ja' })
    );
    expect(result).toEqual({ lang: 'de', remember: true });
  });

  it('uses the cookie over Accept-Language', () => {
    expect(chooseLang(request('/', { Cookie: 'demo_lang=ar', 'Accept-Language': 'ja' }))).toEqual({
      lang: 'ar',
      remember: false,
    });
  });

  it('uses Accept-Language, then English', () => {
    expect(chooseLang(request('/', { 'Accept-Language': 'ar' })).lang).toBe('ar');
    expect(chooseLang(request('/')).lang).toBe('en');
  });

  it('does not ask to remember a language the cookie already holds', () => {
    expect(chooseLang(request('/?lang=ar', { Cookie: 'demo_lang=ar' })).remember).toBe(false);
  });

  it('ignores anything that is not on the allowlist', () => {
    for (const bad of [
      'fr',
      'es',
      'zh',
      'ko',
      'xx',
      'EN',
      'en-US',
      '',
      '%3Cscript%3E',
      'de%00',
      'toString',
      '__proto__',
    ]) {
      const result = chooseLang(request(`/?lang=${bad}`, { 'Accept-Language': 'ja' }));
      expect(result).toEqual({ lang: 'ja', remember: false });
    }
    for (const bad of ['fr', 'ko', 'xx', 'DE', '<b>', 'constructor', '']) {
      const result = chooseLang(request('/', { Cookie: `demo_lang=${bad}` }));
      expect(result).toEqual({ lang: 'en', remember: false });
    }
  });
});

describe('the language cookie', () => {
  it('is set for a valid ?lang with only allowlisted, safe attributes', async () => {
    const response = await get('/?lang=de');
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toBe('demo_lang=de; Path=/; SameSite=Lax; Max-Age=31536000; Secure');
    expect(await response.text()).toContain('lang="de"');
  });

  it('is set on the wait page too, and is not Secure only in development', async () => {
    expect((await get('/wait?lang=ar')).headers.get('set-cookie')).toContain('demo_lang=ar;');
    env = await makeEnv(testDb, {
      ENVIRONMENT: 'development',
      ADMIN_API_ORIGIN: 'http://localhost:8787',
      PORTAL_ORIGIN: 'http://127.0.0.1:8788',
    });
    const response = await handleRequest(
      new Request('http://127.0.0.1:8788/?lang=ar'),
      env,
      upstream.deps
    );
    expect(response.headers.get('set-cookie')).toBe(
      'demo_lang=ar; Path=/; SameSite=Lax; Max-Age=31536000'
    );
  });

  it('is never set for an invalid value, and never reflects the input', async () => {
    for (const bad of [
      'xx',
      '"><script>alert(1)</script>',
      'de;Path=/evil',
      'en%0d%0aSet-Cookie:x=1',
    ]) {
      const response = await get(`/?lang=${encodeURIComponent(bad)}`);
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      expect(html).not.toContain('alert(1)');
      expect(html).not.toContain('/evil');
    }
  });

  it('is not set again when the cookie already holds the language', async () => {
    const response = await get('/?lang=ar', { Cookie: 'demo_lang=ar' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('is applied by later requests, also by error pages', async () => {
    const page = await get('/wait', { Cookie: 'demo_lang=ar', 'Accept-Language': 'ja' });
    expect(await page.text()).toContain('lang="ar" dir="rtl"');
    const missing = await get('/nope', { Cookie: 'demo_lang=de' });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('lang="de"');
    const wrongMethod = await handleRequest(
      new Request(`${PORTAL}/start`, { headers: { Cookie: 'demo_lang=de' } }),
      env,
      upstream.deps
    );
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.text()).toContain('lang="de"');
  });

  it('leaves the ticket cookie alone and never exposes it', async () => {
    const ticket = `${COOKIE_NAME}=${'a'.repeat(40)}`;
    const response = await get('/wait?lang=ja', { Cookie: ticket });
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain(COOKIE_NAME);
    const html = await response.text();
    expect(html).not.toContain('a'.repeat(40));
    expect(html).not.toContain(COOKIE_NAME);
  });
});

describe('headers of the localized pages', () => {
  it('stay no-store, vary on the inputs of the language and keep the CSP', async () => {
    for (const path of ['/', '/wait', '/?lang=de', '/nope']) {
      const response = await get(path);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Accept-Language, Cookie');
      expect(response.headers.get('content-security-policy')).toBe(CSP);
    }
  });

  it('keeps the CSP exactly as specified', () => {
    expect(CSP).toBe(
      "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
  });
});

describe('every language renders every page', () => {
  it('has a complete table for all languages', () => {
    expect(Object.keys(COPY).sort()).toEqual([...LANGS].sort());
    for (const lang of LANGS) {
      const copy = COPY[lang];
      expect(Object.keys(copy.errors).sort()).toEqual([...ERROR_KINDS].sort());
      expect(copy.notices(7)).toHaveLength(5);
      for (const [key, value] of Object.entries(copy)) {
        if (typeof value === 'string') expect(value.trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('offers exactly the languages of the admin console, English (the default) first', () => {
    expect([...LANGS]).toEqual(['en', 'ja', 'de', 'ar']);
    expect(Object.keys(COPY).sort()).toEqual([...LANGS].sort());
    const locales = readFileSync(join(ROOT, '../ar-admin-console/src/lib/i18n/locales.ts'), 'utf8');
    const listed = /SUPPORTED_LOCALES = \[([^\]]*)\]/.exec(locales)?.[1] ?? '';
    expect(listed.replace(/['\s]/g, '').split(',').sort()).toEqual([...LANGS].sort());
  });

  it('fixes the English and Japanese wording', () => {
    expect(COPY.en.title).toBe('Authrim Demo');
    expect(COPY.en.sealLabel).toBe('Open the admin console');
    expect(COPY.en.skipLabel).toBe('Skip the animation');
    expect(COPY.ja.title).toBe('Authrim デモ環境');
    expect(plain(COPY.ja.noticeTitle)).toBe('注意');
    expect(plain(COPY.ja.start)).toBe('開始する');
    expect(plain(COPY.ja.gateTitle)).toBe('デモ環境を準備しています');
    expect(plain(COPY.ja.gateTitleReady)).toBe('デモ環境の準備ができました');
    expect(plain(COPY.ja.gateReady)).toBe(
      '準備ができました。下のボタンで管理コンソールを開きます。'
    );
    expect(plain(COPY.ja.sealLabel)).toBe('管理コンソールを開く');
    expect(plain(COPY.ja.skipLabel)).toBe('演出を省略');
    expect(plain(COPY.ja.retry)).toBe('最初からやり直す');
    expect(COPY.ja.notices(3).map(plain)).toEqual([
      'これは動作確認のためのデモ環境です。',
      '実際の個人情報や本物の認証情報は入力しないでください。',
      '作成したものはすべて、約3時間後に自動で削除されます。',
      '本マルチテナント環境では、データベースがAPAC(アジア地域)となっています。使用環境によっては通信が遅い場合があります。',
      '重要な操作を行う場合、２つの要素で認証を行うステップアップ認証を採用しています。本来、２つ目の認証ではYubikeyなどのハードウェアを使用した許可か専用スマホアプリでの許可が推奨されますが、このデモ環境では利便性を考慮し、6桁のコードを利用するTOTP形式でも登録可能です。',
    ]);
  });

  it('marks Japanese phrase boundaries with zero width spaces, not inside words or numbers', () => {
    const ja = COPY.ja;
    const strings: string[] = [...ja.notices(24), ...Object.values(ja.errors)];
    for (const value of Object.values(ja)) if (typeof value === 'string') strings.push(value);
    for (const text of strings) {
      if (plain(text).length > 12 && !/ /.test(text)) {
        expect(text, text).toContain('\u200b');
      }
      // never inside an ASCII word, never between a number and its unit
      expect(text, text).not.toMatch(/[A-Za-z0-9]\u200b[A-Za-z0-9]/);
      expect(text, text).not.toMatch(/[0-9]\u200b[時分日]/);
      // never at the very start or end, never doubled
      expect(text, text).not.toMatch(/^\u200b|\u200b$|\u200b\u200b/);
    }
    // the lifetime keeps its unit: "約24時間後に" stays in one piece
    expect(ja.notices(24)[2]).toContain('約24時間後に');
    // other languages carry no marks
    for (const lang of LANGS.filter((code) => code !== 'ja')) {
      expect(JSON.stringify(COPY[lang].notices(2))).not.toContain('\u200b');
      expect(COPY[lang].intro1).not.toContain('\u200b');
    }
  });

  it('keeps the marks out of <title> and attribute values but lets them through in the body', async () => {
    const config = await configFor(24);
    const gate = gatePage('ja', config);
    expect(/<title>([^<]*)<\/title>/.exec(gate)?.[1]).toBe(plain(COPY.ja.gateTitle));
    expect(gate).toContain(COPY.ja.gateTitle); // the h1 keeps its break point
    const start = startPage('ja', config);
    expect(start).toContain('\u200b');
    for (const [, value] of start.matchAll(/="([^"]*)"/g)) expect(value).not.toContain('\u200b');
  });

  it('says demo environment everywhere, never trial', () => {
    const gone = /体験|trial|Testumgebung|Test-Umgebung|تجريب(?!ية)/i;
    for (const lang of LANGS) {
      const copy = COPY[lang];
      const parts: string[] = [...copy.notices(3), ...Object.values(copy.errors)];
      for (const value of Object.values(copy)) if (typeof value === 'string') parts.push(value);
      const text = parts.join('\n');
      if (lang !== 'ar') expect(text, lang).not.toMatch(gone);
    }
    expect(COPY.ar.gateTitle).toContain('التجريبية'); // Arabic: "demo" is the word for trial/demo
  });

  it('writes in-progress lines without a final full stop (the page adds the dots)', () => {
    for (const lang of LANGS) {
      for (const key of [
        'gateChecking',
        'gateAccepted',
        'gateInviting',
        'gateSlow',
        'gateUnstable',
        'gateOpening',
      ] as const) {
        expect(COPY[lang][key], `${lang}.${key}`).not.toMatch(/[.。…]$/);
      }
      for (const key of ['gateReady', 'gateArriving', 'failed', 'gateExpired'] as const) {
        expect(COPY[lang][key], `${lang}.${key}`).toMatch(/[.。]$/);
      }
    }
  });

  it('uses no in-world words in any text', () => {
    const world: Record<string, RegExp> = {
      en: /\b(gate|seal|fires?|road|causeway|torch|beacon)\b/i,
      ja: /門|封印|火|参道|灯/,
      de: /\b(Tor|Siegel|Feuer|Weg)\b/,
      ar: /بوابة|ختم|حريق/,
    };
    for (const lang of LANGS) {
      const copy = COPY[lang];
      const parts: string[] = [...copy.notices(3), ...Object.values(copy.errors)];
      for (const value of Object.values(copy)) if (typeof value === 'string') parts.push(value);
      const text = parts.join('\n');
      expect(text, lang).not.toMatch(world[lang]);
    }
  });

  it('has no key the pages never use', () => {
    const sources = ['html.ts', 'gate-ui.ts', 'gate-logic.ts']
      .map((file) => readFileSync(join(ROOT, 'src', file), 'utf8'))
      .join('\n');
    for (const key of Object.keys(COPY.en)) {
      if (['name', 'htmlLang', 'dir', 'turnstile'].includes(key)) continue;
      expect(sources, key).toContain(key);
    }
    expect(Object.keys(COPY.en).filter((key) => key.startsWith('caption'))).toEqual([]);
  });

  it.each([...LANGS])(
    'start page in %s: five notices, the lifetime, switcher, Turnstile',
    async (lang) => {
      const html = startPage(lang, await configFor(7));
      const copy = COPY[lang];
      for (const notice of copy.notices(7)) expect(html).toContain(notice);
      expect(copy.notices(7)[2]).toContain('7');
      expect(html).toContain(`<html lang="${copy.htmlLang}" dir="${copy.dir}">`);
      // the check follows the visitor's system; the page's own day or night is the script's
      // the check is drawn by the script, unseen unless it has to ask
      expect(html).toContain('turnstile/v0/api.js?render=explicit" id="check-js" async defer>');
      expect(html).toContain('<div class="check"><div id="check" class="cf-turnstile"');
      expect(html).toContain(`data-wait="${plain(copy.startChecking)}"`);
      expect(SCENE_JS).toContain("appearance: 'interaction-only'");
      expect(html).toContain(`data-language="${copy.turnstile}"`);
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain('<button type="submit" class="start-btn" data-wait=');
      // words on the empty sheet, no window: name, two intro paragraphs, notices (5), Turnstile, button, language links
      expect(html).toContain('<section class="hero">');
      expect(html).not.toContain('class="window"');
      expect(html).not.toContain('class="panel"');
      expect(html.match(/<li>/g)).toHaveLength(5 + LANGS.length);
      expect(html).toContain(`<h2>${copy.noticeTitle}</h2>`);
      // The database and second-factor notes are fine print, below the language links.
      const [, , , regionNote, stepUpNote] = copy.notices(7);
      expect(html.indexOf(regionNote)).toBeGreaterThan(html.indexOf('class="lang"'));
      expect(html.indexOf(stepUpNote)).toBeGreaterThan(html.indexOf(regionNote));
      expect(html).toContain('class="notices fine"');
      expect(html).not.toContain('class="brand"');
      expect(html).toContain('<h1 lang="en">Authrim <span>Demo</span></h1>');
      expect(html).toContain(`<p class="intro">${copy.intro1}</p>`);
      expect(html).toContain(`<p class="intro">${copy.intro2}</p>`);
      expect(html).toContain(`<title>${copy.title}</title>`);
      expect(html).toContain(`dir="${copy.dir}"`);
      expect(html).toContain(`>${copy.start}</button>`);
      for (const code of LANGS) expect(html).toContain(`href="/?lang=${code}"`);
      expect(html).toContain('aria-current="true"');
      expect(html).not.toContain('href="/wait?lang=');
    }
  );

  it.each([...LANGS])('gate page in %s', async (lang) => {
    const html = gatePage(lang, await configFor(12));
    const copy = COPY[lang];
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain(`<html lang="${copy.htmlLang}" dir="${copy.dir}">`);
    expect(html).toContain('id="status" class="status" role="status"');
    expect(html).toContain(`<h1 id="title">${copy.gateTitle}</h1>`);
    expect(html).not.toContain('caption');
    // the one way out, hidden until ready
    expect(html).toContain(
      `<button type="button" id="open" class="btn open-btn" hidden>${copy.sealLabel}</button>`
    );
    expect(
      html.match(/<button[^>]*>[^<]*<\/button>/g)?.filter((b) => b.includes(copy.sealLabel))
    ).toHaveLength(1);
    // four parts of the work, for the eye only
    expect(html).toContain(
      '<div class="steps" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'
    );
    // the status text is announced once; the dots are a separate, hidden-from-assistive-tech element
    expect(html).toContain(
      `<span id="status-text">${copy.gateChecking}</span><span class="dots" id="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>`
    );
    expect(html).toContain(copy.sealLabel);
    expect(html).toContain(copy.skipLabel);
    expect(html).toContain(copy.noscript);
    for (const code of LANGS) expect(html).toContain(`href="/wait?lang=${code}"`);
    // while a run is in progress the links are not reachable (a reload would lose the join link):
    // hidden in the HTML, shown by the script after an end state, and offered under <noscript>
    expect(html).toContain('<nav class="lang" aria-label="' + copy.languageLabel + '" hidden>');
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(html)?.[1] ?? '';
    expect(noscript).toContain(`href="/wait?lang=${lang}"`);
    expect(noscript).not.toContain(' hidden');
    // the texts the script shows travel as data, escaped
    const attr = /data-texts="([^"]*)"/.exec(html)?.[1] ?? '';
    const texts = JSON.parse(attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'")) as Record<
      string,
      string
    >;
    expect(texts.gateAccepted).toBe(copy.gateAccepted);
    expect(texts.gateExpired).toBe(copy.gateExpired);
  });

  it.each([...LANGS])('error pages in %s', (lang) => {
    for (const kind of ERROR_KINDS) {
      const html = errorPage(lang, kind);
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain(COPY[lang].errors[kind]);
      expect(html).toContain(`href="/?lang=${lang}"`);
      expect(html).toContain(`<html lang="${COPY[lang].htmlLang}" dir="${COPY[lang].dir}">`);
    }
  });

  it('shows the configured lifetime, not a fixed one', async () => {
    for (const hours of [2, 12, 24]) {
      const html = startPage('en', await configFor(hours));
      expect(html).toContain(`after about ${hours} hours`);
    }
    expect(startPage('en', await configFor(1))).toContain('after about 1 hour.');
    expect(startPage('ja', await configFor(3))).toContain('約3時間後');
  });

  it('renders no inline style, handler or inline script anywhere', async () => {
    const config = await configFor(12);
    const pages = LANGS.flatMap((lang) => [
      startPage(lang, config),
      gatePage(lang, config),
      ...ERROR_KINDS.map((kind) => errorPage(lang, kind)),
    ]);
    for (const html of pages) {
      const lower = html.toLowerCase();
      expect(lower).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=|javascript:/);
      expect(lower.split('<script').length).toBe(lower.split('<script src=').length);
    }
  });

  it('keeps the stylesheet free of external requests and of @import', () => {
    expect(SITE_CSS).not.toMatch(/@import|https?:\/\//);
    for (const [, target] of SITE_CSS.matchAll(/url\(([^)]*)\)/g)) {
      expect(target, 'the stylesheet loads nothing').toBe('');
    }
    expect(SITE_CSS.length).toBeLessThan(20 * 1024);
  });

  it('has no side panel layout and a translucent window over the city only', () => {
    expect(SITE_CSS).not.toContain('min-width:960px');
    expect(SITE_CSS).not.toContain('.panel');
    expect(SITE_CSS).toContain('.backdrop{direction:ltr;position:fixed;inset:0');
    // solid by default (no script, no WebGL), glass once the city is behind it
    expect(SITE_CSS).toMatch(/\.window\{[^}]*background:var\(--glass-solid\)/);
    expect(SITE_CSS).toContain('[data-scene=city] .window{background:var(--glass)}');
    expect(SITE_CSS).toContain('backdrop-filter:blur(16px)');
    expect(SITE_CSS).not.toMatch(/@font-face|url\(/);
  });

  it('follows the system for day or night until the visitor chooses', () => {
    expect(SITE_CSS).toContain('@media (prefers-color-scheme:light){:root:not([data-theme]){');
    expect(SITE_CSS).toContain(':root[data-theme=day]{');
    expect(SCENE_JS).toContain("window.localStorage.getItem('authrim-theme')");
    expect(SCENE_JS).toContain("'(prefers-color-scheme: light)'");
  });

  it('shows every page with the theme button hidden until the script runs, and the scene scripts in order', async () => {
    const config = await configFor(12);
    for (const lang of LANGS) {
      for (const html of [
        startPage(lang, config),
        gatePage(lang, config),
        errorPage(lang, 'failed'),
      ]) {
        expect(html).toContain(
          `aria-label="${COPY[lang].themeLabel}" aria-pressed="false" hidden>`
        );
        expect(html).toContain('<canvas class="city"></canvas>');
        // the picture never holds up the page's own scripts: it is async, they are deferred
        expect(html).toContain(`<script src="${CITY_SCRIPT}" id="city-js" async>`);
        expect(html).not.toContain(`src="${CITY_SCRIPT}" defer`);
      }
      // the waiting page asks for one script of its own: nothing else can hold up the status
      const gate = gatePage(lang, config);
      expect(gate).toContain(`<script src="/assets/wait.js?v=${ASSET_VERSION}" defer>`);
      expect(gate).not.toContain('/assets/scene.js');
      expect(gate.match(/<script /g)).toHaveLength(2);
      expect(startPage(lang, config)).toContain(
        `<script src="/assets/scene.js?v=${ASSET_VERSION}" defer>`
      );
      expect(errorPage(lang, 'failed')).toContain(
        `<script src="/assets/scene.js?v=${ASSET_VERSION}" defer>`
      );
    }
    expect(WAIT_JS.startsWith(SCENE_JS)).toBe(true);
    // the cached files carry a mark of their content, so a new page never runs an old script
    expect(ASSET_VERSION).toMatch(/^[0-9a-f]{8}$/);
    expect(startPage('en', config)).toContain(`href="/assets/site.css?v=${ASSET_VERSION}"`);
  });

  it('asks for the status at once, with no city and before any other script has come', () => {
    const calls: string[] = [];
    const element = (attrs: Record<string, string> = {}): Record<string, unknown> => {
      const self: Record<string, unknown> = {
        hidden: false,
        textContent: '',
        classList: { add: () => undefined, toggle: () => undefined },
        getAttribute: (name: string) => attrs[name] ?? null,
        setAttribute: (name: string, value: string) => {
          attrs[name] = value;
        },
        addEventListener: () => undefined,
        focus: () => undefined,
        querySelector: () => element(),
      };
      return self;
    };
    const gate = element({ 'data-texts': '{}' });
    const document = {
      documentElement: element(),
      body: element(),
      hidden: false,
      activeElement: null,
      getElementById: (id: string) => (id === 'gate' ? gate : id === 'city-js' ? null : element()),
      querySelector: () => element(),
      addEventListener: () => undefined,
    };
    const window = { addEventListener: () => undefined } as Record<string, unknown>;
    const fetch = (url: string) => {
      calls.push(url);
      return new Promise(() => undefined);
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(
      'window',
      'document',
      'fetch',
      'setInterval',
      'setTimeout',
      'location',
      WAIT_JS
    ) as (...args: unknown[]) => void;
    run(
      window,
      document,
      fetch,
      () => 0,
      () => 0,
      { replace: () => undefined }
    );
    expect(calls).toEqual(['/status']);
    expect((window.AuthrimScene as { city: unknown }).city).toBeNull();
  });

  it('holds the start button only while the check is still answering, then sends the form', () => {
    type Options = Record<string, unknown> & { callback: () => void };
    const listeners: Record<string, (event: { preventDefault: () => void }) => void> = {};
    const attrs: Record<string, string> = { 'data-wait': 'Checking…' };
    const button = {
      textContent: 'Start',
      disabled: false,
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
    };
    let sent = 0;
    const form = {
      querySelector: () => button,
      addEventListener: (name: string, fn: (typeof listeners)[string]) => {
        listeners[name] = fn;
      },
      submit: () => {
        sent += 1;
      },
    };
    const check = {
      getAttribute: (name: string) => (name === 'data-sitekey' ? 'key' : 'en'),
      parentNode: { classList: { add: () => undefined, remove: () => undefined } },
    };
    const root = { setAttribute: () => undefined };
    const document = {
      documentElement: root,
      querySelector: () => null,
      getElementById: (id: string) => (id === 'start-form' ? form : id === 'check' ? check : null),
    };
    let options: Options | null = null;
    const window: Record<string, unknown> = {
      turnstile: {
        render: (_el: unknown, given: Options) => {
          options = given;
          return 'w1';
        },
        remove: () => undefined,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('window', 'document', SCENE_JS) as (...args: unknown[]) => void;
    run(window, document);
    const drawn = options as Options | null;
    if (!drawn) throw new Error('the check was not drawn');
    expect(drawn.appearance).toBe('interaction-only');
    expect(drawn.sitekey).toBe('key');

    // pressed before the check has answered: held, and said so
    let prevented = 0;
    listeners.submit({ preventDefault: () => (prevented += 1) });
    expect(prevented).toBe(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Checking…');
    expect(sent).toBe(0);

    // the answer comes: the form goes, once
    drawn.callback();
    expect(sent).toBe(1);

    // pressed after the answer: nothing is held
    listeners.submit({ preventDefault: () => (prevented += 1) });
    expect(prevented).toBe(1);
  });

  it('animates the dots in CSS only, with one focus style and Arabic type', () => {
    expect(SITE_CSS).toContain('@keyframes dot2');
    expect(SITE_CSS).toContain('@keyframes dot3');
    expect(SITE_CSS.match(/outline:2px solid/g)).toHaveLength(1);
    expect(SITE_CSS).toContain('outline:2px solid var(--accent)');
    expect(SITE_CSS).toContain('"Geeza Pro","Noto Sans Arabic"');
    expect(SITE_CSS).not.toMatch(/serif(?<!sans-serif)/);
    expect(SITE_CSS).toContain('line-break:strict');
    expect(SITE_CSS).toContain('text-wrap:balance');
    expect(WAIT_JS).not.toMatch(/dots[^;]*setInterval|setInterval[^;]*dots/);
  });

  it('has one open button, and the page leaves even if the picture never finishes', () => {
    expect(WAIT_JS).toContain("openBtn.addEventListener('click', onOpen)");
    expect(WAIT_JS).not.toContain('sealBtn');
    expect(WAIT_JS).toContain('city.leave({ onFlash: light, onDone: go })');
    expect(WAIT_JS).toContain('setTimeout(go, 13000)');
  });

  it('respects reduced motion in the stylesheet and in the scripts', () => {
    expect(SITE_CSS).toContain(
      '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}'
    );
    expect(SCENE_JS).toContain("'(prefers-reduced-motion: reduce)'");
    expect(WAIT_JS).toContain("mode: reduced ? 'static' : 'full'");
    // the city is taken when it comes; polling starts whether or not it has
    expect(WAIT_JS).toContain('else scene.onCity = attach;');
    expect(SCENE_JS).toContain("loader.addEventListener('load', build)");
  });
});
