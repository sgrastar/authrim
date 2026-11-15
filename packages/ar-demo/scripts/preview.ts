/**
 * Builds a static preview of every page in every language into `preview/` (git-ignored), with a
 * tiny fake of `/status` so the gate page can be driven through its states from any static file
 * server. The fake is a separate file (`preview-shim.js`) that only the preview HTML loads; the
 * Worker's pages and scripts carry no test hook.
 *
 *   pnpm exec tsx scripts/preview.ts && python3 -m http.server 8799 --directory preview
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../src/config';
import {
  errorPage,
  gatePage,
  LANGS,
  SITE_CSS,
  startPage,
  WAIT_JS,
  type ErrorKind,
} from '../src/html';
import { COPY, type Lang } from '../src/i18n';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'preview');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const config = {
  consoleOrigin: 'https://console.preview.invalid',
  turnstileSiteKey: '1x00000000000000000000AA', // Cloudflare's published always-pass test key
  tenantTtlHours: 12,
} as unknown as Config;

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

const SHIM = `(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var demo = params.get('demo') || 'staged';
  var started = Date.now();
  var calls = 0;
  var meta = document.querySelector('meta[name="console-origin"]');
  if (meta) meta.setAttribute('content', location.origin);
  var join = location.origin + '/admin/join#code=preview-code&email=demo%40example.com';
  function answer(status, body) {
    return Promise.resolve({ status: status, ok: status >= 200 && status < 300, json: function () { return Promise.resolve(body); } });
  }
  var provisioning = { state: 'provisioning', stage: 'provisioning' };
  var inviting = { state: 'provisioning', stage: 'inviting' };
  function ready(expires) { return { state: 'ready', stage: 'ready', join: join, join_expires_in: expires }; }
  function scenario(age, index) {
    switch (demo) {
      case 'instant': case 'reduced': return answer(200, ready(600));
      case 'real':
        if (index === 0) return new Promise(function (resolve) { setTimeout(function () { resolve({ status: 200, ok: true, json: function () { return Promise.resolve(ready(600)); } }); }, 16000); });
        return answer(200, provisioning);
      case 'slow': return answer(200, provisioning);
      case 'fail': return answer(200, age < 7000 ? provisioning : age < 9000 ? inviting : { state: 'failed' });
      case 'failearly': return answer(200, age < 1500 ? provisioning : { state: 'failed' });
      case 'expire': return answer(200, age < 2000 ? provisioning : ready(45));
      case 'lost': return answer(404, { error: 'not_found' });
      case 'handed': return answer(200, { state: 'handed_off' });
      case 'unstable': return answer(503, {});
      default: return answer(200, age < 4000 ? provisioning : age < 9000 ? inviting : ready(600));
    }
  }
  var realFetch = window.fetch;
  window.fetch = function (url) {
    if (String(url).split('?')[0] !== '/status') return realFetch.apply(this, arguments);
    var index = calls;
    calls += 1;
    return scenario(Date.now() - started, index);
  };
  if (params.get('canvas') === 'off') {
    HTMLCanvasElement.prototype.getContext = function () { return null; };
  }
  if (demo === 'reduced') {
    var original = window.matchMedia;
    window.matchMedia = function (query) {
      if (String(query).indexOf('prefers-reduced-motion') >= 0) {
        return { matches: true, media: String(query), addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} };
      }
      return original.call(window, query);
    };
  }
  document.addEventListener('DOMContentLoaded', function () {
    var links = document.querySelectorAll('nav.lang a');
    for (var i = 0; i < links.length; i++) {
      if (location.search) links[i].setAttribute('href', links[i].getAttribute('href') + location.search);
    }
    var form = document.querySelector('form[action="/start"]');
    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        location.href = document.documentElement.getAttribute('data-wait') + '?demo=real';
      });
    }
  });
})();
`;

function write(path: string, content: string): void {
  const file = join(out, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

/** Query-string language links become folders; the fake /status shim loads before the gate script. */
function localise(html: string, lang: Lang): string {
  let result = html
    .replace(/href="\/wait\?lang=([a-z]+)"/g, 'href="/$1/wait/"')
    .replace(/href="\/\?lang=([a-z]+)"/g, 'href="/$1/"');
  result = result.replace(
    '<script src="/assets/wait.js" defer></script>',
    '<script src="/preview-shim.js"></script>\n<script src="/assets/wait.js" defer></script>'
  );
  result = result.replace('<html ', `<html data-wait="/${lang}/wait/" `);
  if (result.includes('action="/start"')) {
    result = result.replace('</head>', '<script src="/preview-shim.js"></script>\n</head>');
  }
  return result;
}

for (const lang of LANGS) {
  write(`${lang}/index.html`, localise(startPage(lang, config), lang));
  write(`${lang}/wait/index.html`, localise(gatePage(lang, config), lang));
  for (const kind of ERROR_KINDS) {
    write(`${lang}/error/${kind}/index.html`, localise(errorPage(lang, kind), lang));
  }
}
write('assets/site.css', SITE_CSS);
write('assets/wait.js', WAIT_JS);
write('preview-shim.js', SHIM);
cpSync(join(root, 'public/assets/gate'), join(out, 'assets/gate'), { recursive: true });
write(
  'admin/join/index.html',
  '<!doctype html><meta charset="utf-8"><title>Console (stand-in)</title><body style="font:16px system-ui;padding:2rem;background:#05070b;color:#eef1f4"><h1>Stand-in for the admin console</h1><p>The gate page reached its redirect target. In the real portal the console opens here.</p><p><a style="color:#f2a03d" href="javascript:history.back()">Back</a></p>'
);

const scenarios: Array<[string, string, string]> = [
  ['staged', 'Normal run: provisioning, inviting after 4 s, ready after 9 s', ''],
  [
    'instant',
    'Full run with instant ready (the show plays in full, about 11.8 s, skip button)',
    '',
  ],
  [
    'real',
    'Real timing: first request carries the creation (16 s), other polls say provisioning',
    '',
  ],
  [
    'slow',
    'Slow run: stays in provisioning for ever (use it to check the idle state, the slow text, the 360 s timeout)',
    '',
  ],
  ['fail', 'Failure mid-way (provisioning, inviting, then failed at 9 s)', ''],
  ['failearly', 'Failure during the first sequence (1.5 s)', ''],
  [
    'expire',
    'Press deadline expiry: ready after 2 s with join_expires_in 45 (window 15 s, auto-skip, warning, expiry)',
    '',
  ],
  ['reduced', 'Reduced motion: instant ready, no travel, states switch at once', ''],
  [
    'instant&canvas=off',
    'Image-only picture: canvas unavailable, four stacked photographs switched by data-station',
    '',
  ],
  ['lost', 'Session not found (404)', ''],
  ['handed', 'Already opened (handed_off)', ''],
  ['unstable', 'Server errors (503): the unstable text, then timeout after 360 s', ''],
];
const lines: string[] = [
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gate preview</title>',
  '<body style="font:16px/1.6 system-ui;max-width:60rem;margin:2rem auto;padding:0 1rem">',
  '<h1>Trial start portal: static preview</h1>',
  '<p>Served from a static file server. The fake /status lives in preview-shim.js and is loaded only by these files.</p>',
  '<h2>Gate page scenarios (English; swap /en/ for another language)</h2><ul>',
];
for (const [name, text] of scenarios) {
  lines.push(
    `<li><a href="/en/wait/?demo=${name}">${name}</a> (<a href="/ja/wait/?demo=${name}">ja</a>): ${text}</li>`
  );
}
lines.push(
  '</ul><h2>Every page, every language</h2><table><tr><th>Language</th><th>Start</th><th>Gate</th><th>Errors</th></tr>'
);
for (const lang of LANGS) {
  const errors = ERROR_KINDS.map((k) => `<a href="/${lang}/error/${k}/">${k}</a>`).join(' ');
  lines.push(
    `<tr><td>${COPY[lang].name}</td><td><a href="/${lang}/">start</a></td><td><a href="/${lang}/wait/">gate</a></td><td>${errors}</td></tr>`
  );
}
lines.push('</table>');
write('index.html', lines.join('\n'));
console.log(`preview written to ${out}`);
