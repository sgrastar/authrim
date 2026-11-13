import type { Config } from './config';

export type Lang = 'en' | 'ja';

/** The one place where a dynamic value becomes HTML text or an attribute value. */
export function esc(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** `ja` when the visitor prefers Japanese over English, otherwise `en`. */
export function pickLang(header: string | null): Lang {
  if (!header) return 'en';
  const ranked = header
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) {
    const primary = entry.tag.split('-')[0];
    if (primary === 'ja') return 'ja';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

interface Copy {
  title: string;
  lead: string;
  notices: (hours: number) => string[];
  start: string;
  waitTitle: string;
  waiting: string;
  timeout: string;
  failed: string;
  handedOff: string;
  lost: string;
  retry: string;
  errorTitle: string;
  errors: Record<ErrorKind, string>;
  back: string;
}

export type ErrorKind =
  | 'forbidden'
  | 'bad_request'
  | 'verification'
  | 'ip_limit'
  | 'capacity'
  | 'failed'
  | 'config'
  | 'not_found'
  | 'method';

const COPY: Record<Lang, Copy> = {
  en: {
    title: 'Try Authrim',
    lead: 'Start your own temporary demo tenant.',
    notices: (hours) => [
      'This is a demo environment.',
      'Do not enter real personal data or real credentials.',
      `Everything you create is deleted automatically after about ${hours} hours.`,
    ],
    start: 'Start',
    waitTitle: 'Preparing your tenant',
    waiting: 'Preparing your demo tenant. This takes a short while.',
    timeout: 'It is taking longer than expected.',
    failed: 'Something went wrong while preparing the tenant.',
    handedOff: 'Your tenant was already opened. If you lost that page, start again.',
    lost: 'This session was not found. Please start again.',
    retry: 'Start again',
    errorTitle: 'Could not continue',
    errors: {
      forbidden: 'The request was not accepted.',
      bad_request: 'The request could not be read.',
      verification: 'The verification failed. Please go back and try again.',
      ip_limit: 'You have reached the daily limit of demo tenants. Please try again tomorrow.',
      capacity: 'The demo is full right now. Please try again later.',
      failed: 'The demo tenant could not be created. Please try again later.',
      config: 'The demo is not available right now.',
      not_found: 'Page not found.',
      method: 'This method is not allowed.',
    },
    back: 'Back to the start page',
  },
  ja: {
    title: 'Authrim を試す',
    lead: 'あなた専用の一時的なデモテナントを作成します。',
    notices: (hours) => [
      'これはデモ環境です。',
      '実際の個人情報や本物の認証情報は入力しないでください。',
      `作成したものは約${hours}時間後にすべて自動で削除されます。`,
    ],
    start: '開始',
    waitTitle: 'テナントを準備しています',
    waiting: 'デモテナントを準備しています。しばらくお待ちください。',
    timeout: '予定より時間がかかっています。',
    failed: 'テナントの準備中に問題が発生しました。',
    handedOff:
      'このテナントはすでに開かれています。ページを失った場合は、もう一度開始してください。',
    lost: 'このセッションが見つかりません。もう一度開始してください。',
    retry: 'もう一度開始',
    errorTitle: '続行できません',
    errors: {
      forbidden: 'リクエストは受け付けられませんでした。',
      bad_request: 'リクエストを読み取れませんでした。',
      verification: '確認に失敗しました。戻ってもう一度お試しください。',
      ip_limit: '1日に作成できるデモテナントの上限に達しました。明日もう一度お試しください。',
      capacity: '現在デモは満員です。しばらくしてからお試しください。',
      failed: 'デモテナントを作成できませんでした。しばらくしてからお試しください。',
      config: '現在デモはご利用いただけません。',
      not_found: 'ページが見つかりません。',
      method: 'このメソッドは使用できません。',
    },
    back: '開始ページへ戻る',
  },
};

function layout(lang: Lang, title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/site.css">
${head}</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>
`;
}

export function startPage(lang: Lang, config: Config): string {
  const copy = COPY[lang];
  const notices = copy
    .notices(config.tenantTtlHours)
    .map((line) => `<li>${esc(line)}</li>`)
    .join('\n');
  return layout(
    lang,
    copy.title,
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>\n',
    `<h1>${esc(copy.title)}</h1>
<p>${esc(copy.lead)}</p>
<ul class="notices">
${notices}
</ul>
<form method="post" action="/start">
<div class="cf-turnstile" data-sitekey="${esc(config.turnstileSiteKey)}"></div>
<button type="submit">${esc(copy.start)}</button>
</form>`
  );
}

export function waitPage(lang: Lang, config: Config): string {
  const copy = COPY[lang];
  return layout(
    lang,
    copy.waitTitle,
    `<meta name="console-origin" content="${esc(config.consoleOrigin)}">\n<script src="/assets/wait.js" defer></script>\n`,
    `<h1>${esc(copy.waitTitle)}</h1>
<p id="status" role="status" data-waiting="${esc(copy.waiting)}" data-timeout="${esc(copy.timeout)}" data-failed="${esc(copy.failed)}" data-handed="${esc(copy.handedOff)}" data-lost="${esc(copy.lost)}">${esc(copy.waiting)}</p>
<p><a id="retry" href="/" hidden>${esc(copy.retry)}</a></p>
<noscript><p>JavaScript is required. / JavaScript が必要です。</p></noscript>`
  );
}

export function errorPage(lang: Lang, kind: ErrorKind): string {
  const copy = COPY[lang];
  return layout(
    lang,
    copy.errorTitle,
    '',
    `<h1>${esc(copy.errorTitle)}</h1>
<p>${esc(copy.errors[kind])}</p>
<p><a href="/">${esc(copy.back)}</a></p>`
  );
}

export const SITE_CSS = `*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f7;color:#1c2024;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif}
.card{width:100%;max-width:34rem;margin:1.5rem;padding:2rem;background:#fff;border:1px solid #d9dde3;border-radius:12px}
h1{margin:0 0 .75rem;font-size:1.5rem;line-height:1.3}
p{margin:.5rem 0}
.notices{margin:1rem 0 1.5rem;padding-left:1.25rem}
.notices li{margin:.25rem 0}
form{margin-top:1rem}
button{margin-top:1rem;padding:.65rem 1.5rem;font:inherit;font-weight:600;color:#fff;background:#2f5fd0;border:0;border-radius:8px;cursor:pointer}
button:hover{background:#2850b3}
button:focus-visible,a:focus-visible{outline:3px solid #9db7f5;outline-offset:2px}
a{color:#2f5fd0}
`;

/**
 * Polls /status and follows the link only when it starts with the console origin and the join
 * path. Plain text only (textContent): nothing from the network is ever written as HTML.
 */
export const WAIT_JS = `(function () {
  'use strict';
  var meta = document.querySelector('meta[name="console-origin"]');
  var origin = meta ? meta.getAttribute('content') || '' : '';
  var box = document.getElementById('status');
  var retry = document.getElementById('retry');
  if (!box) return;
  var started = Date.now();
  var LIMIT_MS = 180000;
  function say(key) {
    var text = box.getAttribute('data-' + key);
    if (text) box.textContent = text;
  }
  function finish(key) {
    say(key);
    if (retry) retry.removeAttribute('hidden');
  }
  function next() {
    if (Date.now() - started > LIMIT_MS) return finish('timeout');
    setTimeout(poll, 2000);
  }
  function poll() {
    fetch('/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) {
        if (response.status === 404) return { state: 'lost' };
        if (!response.ok) return { state: 'provisioning' };
        return response.json();
      })
      .then(function (data) {
        var state = data && data.state;
        if (state === 'ready') {
          var join = data.join;
          if (origin && typeof join === 'string' && join.indexOf(origin + '/admin/join#') === 0) {
            location.replace(join);
            return;
          }
          return finish('failed');
        }
        if (state === 'handed_off') return finish('handed');
        if (state === 'failed') return finish('failed');
        if (state === 'lost') return finish('lost');
        next();
      })
      .catch(next);
  }
  poll();
})();
`;
