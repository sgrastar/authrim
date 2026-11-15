import type { Config } from './config';
import { GATE_ASSETS } from './gate-assets';
import { COPY, LANGS, type Copy, type ErrorKind, type GateTexts, type Lang } from './i18n';

export { SITE_CSS } from './site-css';
export { WAIT_JS } from './gate-client';
export { LANGS };
export type { ErrorKind, Lang };

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

function asset(name: string): string {
  const url = GATE_ASSETS[name];
  if (!url) throw new Error(`missing gate asset ${name}`);
  return url;
}

/**
 * The far view (dark): the base of every page. AVIF, then WebP; the large file from a wide stage
 * on. Selected by media query (no `w` descriptors) so that the canvas can read the true pixel
 * size of this very element.
 */
function farPicture(): string {
  const wide = 'media="(min-width:1084px)"';
  return `<picture>
<source type="image/avif" ${wide} srcset="${asset('far-dark-2400.avif')}">
<source type="image/webp" ${wide} srcset="${asset('far-dark-2400.webp')}">
<source type="image/avif" srcset="${asset('far-dark-1600.avif')}">
<source type="image/webp" srcset="${asset('far-dark-1600.webp')}">
<img class="far" src="${asset('far-dark-1600.webp')}" alt="" width="1600" height="1067" fetchpriority="high" decoding="async">
</picture>`;
}

/** Language links: the same page in each language; the current one is marked. */
function langNav(current: Lang, path: string, hidden = false): string {
  const items = LANGS.map((code) => {
    const label = COPY[code].name;
    const mark = code === current ? ' aria-current="true"' : '';
    return `<li><a href="${path}?lang=${code}" lang="${COPY[code].htmlLang}"${mark}>${esc(label)}</a></li>`;
  }).join('\n');
  return `<nav class="lang" aria-label="${esc(COPY[current].languageLabel)}"${hidden ? ' hidden' : ''}>
<ul>
${items}
</ul>
</nav>`;
}

function layout(
  lang: Lang,
  title: string,
  bodyClass: string,
  head: string,
  body: string,
  attrs = ''
): string {
  const copy = COPY[lang];
  return `<!doctype html>
<html lang="${esc(copy.htmlLang)}" dir="${copy.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#05070b">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/site.css">
${head}</head>
<body class="${bodyClass}">
<main class="scene ${bodyClass}"${attrs}>
${body}
</main>
</body>
</html>
`;
}

/** Far view only: the stage of the start and error pages (no script, no canvas). */
function stillStage(): string {
  return `<div class="stage" aria-hidden="true">
<div class="far-wrap">
${farPicture()}
</div>
</div>`;
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
    'start',
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>\n',
    `<section class="window">
<h1>${esc(copy.title)}</h1>
<p class="intro">${esc(copy.intro1)}</p>
<p class="intro">${esc(copy.intro2)}</p>
<div class="notices">
<h2>${esc(copy.noticeTitle)}</h2>
<ul>
${notices}
</ul>
</div>
<form method="post" action="/start">
<div class="cf-turnstile" data-sitekey="${esc(config.turnstileSiteKey)}" data-theme="dark" data-language="${esc(copy.turnstile)}"></div>
<button type="submit" class="start-btn">${esc(copy.start)}</button>
</form>
${langNav(lang, '/')}
</section>
${stillStage()}`
  );
}

function gateTexts(copy: Copy): GateTexts {
  return {
    gateTitle: copy.gateTitle,
    gateTitleReady: copy.gateTitleReady,
    gateChecking: copy.gateChecking,
    gateAccepted: copy.gateAccepted,
    gateInviting: copy.gateInviting,
    gateSlow: copy.gateSlow,
    gateUnstable: copy.gateUnstable,
    gateArriving: copy.gateArriving,
    gateReady: copy.gateReady,
    gateLastMinute: copy.gateLastMinute,
    gateOpening: copy.gateOpening,
    gateExpired: copy.gateExpired,
    timeout: copy.timeout,
    failed: copy.failed,
    handedOff: copy.handedOff,
    lost: copy.lost,
  };
}

export function gatePage(lang: Lang, config: Config): string {
  const copy = COPY[lang];
  return layout(
    lang,
    copy.gateTitle,
    'gate',
    `<meta name="console-origin" content="${esc(config.consoleOrigin)}">\n<script src="/assets/wait.js" defer></script>\n`,
    `<section class="window">
<h1 id="title">${esc(copy.gateTitle)}</h1>
<p id="status" class="status" role="status" aria-atomic="true"><span id="status-text">${esc(copy.gateChecking)}</span><span class="dots" id="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></p>
<button type="button" id="skip" class="skip" hidden>${esc(copy.skipLabel)}</button>
<button type="button" id="seal2" class="btn open-btn" hidden>${esc(copy.sealLabel)}</button>
<p id="retry" class="retry" hidden><a class="btn" href="/?lang=${lang}">${esc(copy.retry)}</a></p>
<noscript><p class="note">${esc(copy.noscript)}</p>
${langNav(lang, '/wait')}</noscript>
${langNav(lang, '/wait', true)}
</section>
<div class="stage">
<div class="far-wrap" aria-hidden="true">
${farPicture()}
</div>
<div class="near-wrap" aria-hidden="true"></div>
<canvas class="gl" aria-hidden="true"></canvas>
<div class="door" aria-hidden="true">
<img class="passage" alt="">
<div class="leaf l"><img alt=""><i class="dim"></i><i class="edge"></i></div>
<div class="leaf r"><img alt=""><i class="dim"></i><i class="edge"></i></div>
<div class="glow"></div>
</div>
<button type="button" id="seal" class="seal" hidden><img alt="" width="256" height="256"><span>${esc(copy.sealLabel)}</span></button>
</div>`,
    ` id="gate" data-state="arriving" data-view="arriving" data-station="0" data-texts="${esc(JSON.stringify(gateTexts(copy)))}"`
  );
}

export function errorPage(lang: Lang, kind: ErrorKind): string {
  const copy = COPY[lang];
  return layout(
    lang,
    copy.errorTitle,
    'error',
    '',
    `<section class="window">
<h1>${esc(copy.errorTitle)}</h1>
<p class="status">${esc(copy.errors[kind])}</p>
<p><a class="btn" href="/?lang=${lang}">${esc(copy.back)}</a></p>
${langNav(lang, '/')}
</section>
${stillStage()}`
  );
}
