import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_NAME } from '../handlers';
import { errorPage, gatePage, LANGS, SITE_CSS, startPage, WAIT_JS, type ErrorKind } from '../html';
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
      expect(copy.notices(7)).toHaveLength(3);
      for (const [key, value] of Object.entries(copy)) {
        if (typeof value === 'string') expect(value.trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });

  it('offers exactly the languages of the admin console, in its order', () => {
    expect([...LANGS]).toEqual(['ja', 'en', 'de', 'ar']);
    expect(Object.keys(COPY)).toEqual(['ja', 'en', 'de', 'ar']);
    const locales = readFileSync(join(ROOT, '../ar-admin-console/src/lib/i18n/locales.ts'), 'utf8');
    expect(locales).toContain("SUPPORTED_LOCALES = ['ja', 'en', 'de', 'ar']");
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
    'start page in %s: three notices, the lifetime, switcher, Turnstile',
    async (lang) => {
      const html = startPage(lang, await configFor(7));
      const copy = COPY[lang];
      for (const notice of copy.notices(7)) expect(html).toContain(notice);
      expect(copy.notices(7)[2]).toContain('7');
      expect(html).toContain(`<html lang="${copy.htmlLang}" dir="${copy.dir}">`);
      expect(html).toContain('data-theme="dark"');
      expect(html).toContain(`data-language="${copy.turnstile}"`);
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain('<button type="submit" class="start-btn">');
      // one translucent window: heading, two intro paragraphs, notices (3), Turnstile, button, language links
      expect(html).toContain('<section class="window">');
      expect(html).not.toContain('class="panel"');
      expect(html.match(/<li>/g)).toHaveLength(3 + LANGS.length);
      expect(html).toContain(`<h2>${copy.noticeTitle}</h2>`);
      expect(html).not.toContain('class="brand"');
      expect(html).toContain(`<h1>${copy.title}</h1>`);
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
    // a second 'open' button in the window, hidden until ready (shown on short screens only)
    expect(html).toContain(
      `<button type="button" id="seal2" class="btn open-btn" hidden>${copy.sealLabel}</button>`
    );
    // the status text is announced once; the dots are a separate, hidden-from-assistive-tech element
    expect(html).toContain(
      `<span id="status-text">${copy.gateChecking}</span><span class="dots" id="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>`
    );
    expect(html).toContain('<button type="button" id="seal" class="seal" hidden>');
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
      expect(target.startsWith('data:image/webp;base64,')).toBe(true);
    }
    expect(SITE_CSS.length).toBeLessThan(20 * 1024);
  });

  it('has no side panel layout and a translucent window', () => {
    expect(SITE_CSS).not.toContain('min-width:960px');
    expect(SITE_CSS).not.toContain('.panel');
    expect(SITE_CSS).toContain('.stage{direction:ltr;position:fixed;inset:0');
    expect(SITE_CSS).toMatch(/\.window\{[^}]*rgba\(8,12,18,\.78\)/);
    expect(SITE_CSS).toContain('backdrop-filter:blur(10px)');
    expect(SITE_CSS).not.toMatch(/@font-face|url\(https?:/);
  });

  it('animates the dots in CSS only, with one gold focus style and Arabic type', () => {
    expect(SITE_CSS).toContain('@keyframes dot2');
    expect(SITE_CSS).toContain('@keyframes dot3');
    expect(SITE_CSS).toContain('.dots i{animation:none}');
    expect(SITE_CSS).not.toMatch(/aurora|#7fe3c4/);
    expect(SITE_CSS).toContain('outline:2px solid var(--gold-2)');
    expect(SITE_CSS).toContain('"Geeza Pro","Noto Naskh Arabic"');
    expect(SITE_CSS).toContain('line-break:strict');
    expect(SITE_CSS).toContain('text-wrap:balance');
    expect(WAIT_JS).not.toMatch(/dots[^;]*setInterval|setInterval[^;]*dots/);
  });

  it('swaps which open button is visible on short screens and in the text-only level', () => {
    expect(SITE_CSS).toContain(
      '@media (max-height:32rem),(max-width:22rem) and (max-height:36rem){'
    );
    expect(SITE_CSS).toContain(
      '.window .open-btn:not([hidden]){display:inline-flex}.seal{visibility:hidden}'
    );
    expect(SITE_CSS).toContain('[data-text-only] .seal{visibility:hidden}');
    expect(SITE_CSS).toContain('.window .open-btn{display:none');
    expect(WAIT_JS).toContain("openBtn.addEventListener('click', onOpen)");
    expect(WAIT_JS).toContain("sealBtn.addEventListener('click', onOpen)");
  });

  it('respects reduced motion in the stylesheet', () => {
    expect(SITE_CSS).toContain('@media (prefers-reduced-motion:reduce)');
    expect(SITE_CSS).toContain('[data-motion=reduced] .seal::before{animation:none');
  });
});
