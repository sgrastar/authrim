import type { Config } from './config';
import { CITY_SCRIPT } from './city-assets';
import { COPY, LANGS, plain, type Copy, type ErrorKind, type GateTexts, type Lang } from './i18n';

import { SCENE_JS, WAIT_JS } from './gate-client';
import { SITE_CSS } from './site-css';
import type { Tally } from './tally';

export { SCENE_JS, SITE_CSS, WAIT_JS };
export { LANGS };
export type { ErrorKind, Lang };

/**
 * A short mark of what the stylesheet and the scripts contain now, put in their addresses. They
 * are cached for a few minutes: without it, a page made after a release could be shown with the
 * files of the release before. Not a secret and not a check, only a name that changes.
 */
function mark(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export const ASSET_VERSION = mark(SITE_CSS + SCENE_JS + WAIT_JS);

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

/** The city's canvas, and the light the way out ends in. Empty without the script. */
const BACKDROP = `<div class="backdrop" aria-hidden="true"><canvas class="city"></canvas></div>
<div class="flash" aria-hidden="true"></div>`;

const MOON =
  '<svg class="moon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 14.6A8.6 8.6 0 0 1 9.4 3.7a.7.7 0 0 0-.9-.9 9.9 9.9 0 1 0 12.7 12.7.7.7 0 0 0-.9-.9Z"/></svg>';
const SUN =
  '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';

/**
 * The scene and the script that starts it (the waiting page carries that script inside its own). The scene is \`async\`: it is large and only a picture,
 * so nothing waits for it. The page's own scripts run without it and take the city when it comes.
 */
const CITY_TAG = `<script src="${CITY_SCRIPT}" id="city-js" async></script>\n`;
const SCENE_TAG = `<script src="/assets/scene.js?v=${ASSET_VERSION}" defer></script>\n`;

/** Language links: the same page in each language; the current one is marked. */
function langNav(current: Lang, path: string, hidden = false): string {
  const items = LANGS.map((code) => {
    const label = COPY[code].name;
    const mark = code === current ? ' aria-current="true"' : '';
    return `<li><a href="${path}?lang=${code}" lang="${COPY[code].htmlLang}"${mark}>${esc(label)}</a></li>`;
  }).join('\n');
  return `<nav class="lang" aria-label="${esc(plain(COPY[current].languageLabel))}"${hidden ? ' hidden' : ''}>
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
  // The button is shown by the script: without it there is nothing to switch.
  return `<!doctype html>
<html lang="${esc(copy.htmlLang)}" dir="${copy.dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark light">
<title>${esc(plain(title))}</title>
<link rel="stylesheet" href="/assets/site.css?v=${ASSET_VERSION}">
${CITY_TAG}${head}</head>
<body class="${bodyClass}">
${BACKDROP}
<button type="button" id="theme" class="theme" aria-label="${esc(plain(copy.themeLabel))}" aria-pressed="false" hidden>${MOON}${SUN}</button>
<main class="scene ${bodyClass}"${attrs}>
${body}
</main>
</body>
</html>
`;
}

/** Whole numbers in the page's language, always with Western digits like the rest of the page. */
function count(lang: Lang, value: number): string {
  return new Intl.NumberFormat(`${lang}-u-nu-latn`, { maximumFractionDigits: 0 }).format(value);
}

/** The two numbers under the start button; nothing at all when they could not be read. */
function tallyBlock(lang: Lang, config: Config, tally: Tally | null): string {
  if (!tally) return '';
  const copy = COPY[lang];
  return `<dl class="tally">
<div><dt>${esc(copy.tallyActive)}</dt><dd>${esc(count(lang, tally.active))}<span> / ${esc(count(lang, config.maxActiveTenants))}</span></dd></div>
<div><dt>${esc(copy.tallyCreated)}</dt><dd>${esc(count(lang, tally.created))}</dd></div>
</dl>
`;
}

export function startPage(lang: Lang, config: Config, tally: Tally | null = null): string {
  const copy = COPY[lang];
  const all = copy.notices(config.tenantTtlHours);
  const items = (lines: string[]): string =>
    lines.map((line) => `<li>${esc(line)}</li>`).join('\n');
  // The first four are the plain rules, set under the heading; the rest (where the database is,
  // the second factor) are fine print. Both sit in the right column on a wide screen (the rules
  // first, then the fine print), beside the start button, the admin link and the counts; on a
  // narrow one the rules come first, then those, then the fine print.
  const notices = items(all.slice(0, 4));
  const finePrint = items(all.slice(4));
  // The admin console's own sign-in page, for a tenant that already exists. It takes no parameters.
  const adminHref = `${config.consoleOrigin}/admin/login`;
  return layout(
    lang,
    copy.title,
    'start',
    `${SCENE_TAG}<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" id="check-js" async defer></script>\n`,
    `<section class="hero">
<h1 lang="en">Authrim <span>Demo</span></h1>
<p class="intro">${esc(copy.intro1)}</p>
<p class="intro">${esc(copy.intro2)}</p>
<div class="columns">
<div class="notices">
<h2>${esc(copy.noticeTitle)}</h2>
<ul>
${notices}
</ul>
</div>
<div class="main">
<form id="start-form" method="post" action="/start">
<div class="check"><div id="check" class="cf-turnstile" data-sitekey="${esc(config.turnstileSiteKey)}" data-language="${esc(copy.turnstile)}"></div></div>
<button type="submit" class="start-btn" data-wait="${esc(plain(copy.startChecking))}">${esc(copy.start)}</button>
</form>
<div class="admin">
<p>${esc(copy.adminLead)}</p>
<a class="btn" href="${esc(adminHref)}">${esc(copy.adminConsole)}</a>
</div>
${tallyBlock(lang, config, tally)}${langNav(lang, '/')}
</div>
<div class="notices fine">
<ul>
${finePrint}
</ul>
</div>
</div>
</section>`
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
    `<meta name="console-origin" content="${esc(config.consoleOrigin)}">\n<script src="/assets/wait.js?v=${ASSET_VERSION}" defer></script>\n`,
    `<section class="window">
<h1 id="title">${esc(copy.gateTitle)}</h1>
<div class="steps" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<p id="status" class="status" role="status" aria-atomic="true"><span id="status-text">${esc(copy.gateChecking)}</span><span class="dots" id="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></p>
<button type="button" id="skip" class="skip" hidden>${esc(copy.skipLabel)}</button>
<button type="button" id="open" class="btn open-btn" hidden>${esc(copy.sealLabel)}</button>
<p id="retry" class="retry" hidden><a class="btn" href="/?lang=${lang}">${esc(copy.retry)}</a></p>
<noscript><p class="note">${esc(copy.noscript)}</p>
${langNav(lang, '/wait')}</noscript>
${langNav(lang, '/wait', true)}
</section>`,
    ` id="gate" data-state="arriving" data-view="arriving" data-texts="${esc(JSON.stringify(gateTexts(copy)))}"`
  );
}

export function errorPage(lang: Lang, kind: ErrorKind): string {
  const copy = COPY[lang];
  return layout(
    lang,
    copy.errorTitle,
    'error',
    SCENE_TAG,
    `<section class="window">
<h1>${esc(copy.errorTitle)}</h1>
<p class="status">${esc(copy.errors[kind])}</p>
<p><a class="btn" href="/?lang=${lang}">${esc(copy.back)}</a></p>
${langNav(lang, '/')}
</section>`
  );
}
