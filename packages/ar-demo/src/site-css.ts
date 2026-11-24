const SANS =
  'system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP","Yu Gothic UI",sans-serif';
const AR = '"Geeza Pro","Noto Sans Arabic","Segoe UI",Tahoma,sans-serif';

/** Night: the page's own default, and what a visitor without the script and with a dark system sees. */
const NIGHT =
  '--bg:#05080f;--ink:#edf2ff;--ink-soft:#c3cadb;--ink-muted:#96a0b8;--accent:#8e9cff;--lamp:#ffc98a;--bad:#ffb4a8;--glass:rgba(9,13,24,.34);--glass-solid:rgba(9,13,24,.9);--line:rgba(170,182,255,.22);--shadow:rgba(0,0,0,.36);--btn-ink:#0b1020;--btn-hover:#fff;--edge:3,5,10;--flash:#eef2ff;color-scheme:dark';
const DAY =
  '--bg:#e6eaf3;--ink:#131b33;--ink-soft:#3c4662;--ink-muted:#5d6783;--accent:#3f4fc4;--lamp:#a85f0c;--bad:#a3271a;--glass:rgba(250,251,255,.46);--glass-solid:rgba(250,251,255,.94);--line:rgba(63,79,196,.2);--shadow:rgba(40,52,96,.14);--btn-ink:#fff;--btn-hover:#26315a;--edge:236,239,246;--flash:#fff;color-scheme:light';

/** One file, no inline style anywhere: every state is an attribute or a class. */
export const SITE_CSS = `:root{${NIGHT};--f:${SANS}}
@media (prefers-color-scheme:light){:root:not([data-theme]){${DAY}}}
:root[data-theme=day]{${DAY}}
/* Japanese breaks only at the marked phrase boundaries (U+200B in the texts) and after punctuation. */
html:lang(ja){line-break:strict;word-break:keep-all;overflow-wrap:anywhere}
html:lang(ar){--f:${AR};font-size:1.0625rem}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:1rem/1.7 var(--f);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
h1,h2,p,ul{margin:0}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--accent);text-decoration-thickness:2px;text-underline-offset:.2em}
/* One focus style for the whole site. */
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
[hidden]{display:none!important}

/* The city: behind everything, always left to right. Without it the plain sheet stays. */
.backdrop{direction:ltr;position:fixed;inset:0;z-index:0;overflow:hidden}
.city{display:block;width:100%;height:100%;cursor:grab;touch-action:pan-y}
.city.turning{cursor:grabbing}
/* The table's edge: the model fades out rather than ends. */
.backdrop::after{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 90% at 50% 38%,transparent 44%,rgba(var(--edge),.76) 100%),linear-gradient(to bottom,transparent 56%,rgba(var(--edge),.55) 100%)}
.flash{position:fixed;inset:0;z-index:5;background:var(--flash);opacity:0;pointer-events:none;transition:opacity 1.5s ease-in}
.flash.on{opacity:1}

.scene{position:relative;z-index:2;display:grid;min-height:100vh;min-height:100svh;padding:4.5rem 1.25rem 2rem;pointer-events:none}
.scene a,.scene button,.scene form,.window{pointer-events:auto}

/* The first page: words on the empty sheet, no window. */
.start.scene,.error.scene{place-items:center}
.hero{width:min(100%,45rem);text-align:center}
.start .hero{width:min(100%,60rem)}
.hero h1{font-size:clamp(2.8rem,8.4vw,5.6rem);font-weight:640;letter-spacing:-.035em;line-height:1.02;direction:ltr}
.hero h1 span{color:var(--ink-muted);font-weight:420}
.hero .intro{max-width:31em;margin:0 auto;color:var(--ink-soft);font-size:clamp(.98rem,1.5vw,1.12rem);line-height:1.85;text-wrap:balance}
.hero h1+.intro{margin-top:1.6rem}
.notices{max-width:34rem;margin:1.5rem auto 0;color:var(--ink-muted);font-size:.88rem;line-height:1.7}
.notices h2{font-size:.88rem;font-weight:620;color:var(--ink-soft)}
.notices ul{list-style:none;padding:0;margin-top:.3rem;display:grid;gap:.15rem}
.notices li{text-wrap:pretty}
/* Two columns: the rules, the buttons and the numbers on one side, the fine print on the other. */
.columns{display:grid;gap:2rem 3.5rem;margin-top:.5rem}
.notices.fine{max-width:34rem;margin:1.4rem auto 0;font-size:.82rem;line-height:1.7;text-align:start}
.columns{padding:1.6rem 1.75rem;border:1px solid var(--line);border-radius:14px;background:color-mix(in srgb,var(--glass) 15%,transparent);box-shadow:0 18px 48px var(--shadow)}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.columns{-webkit-backdrop-filter:blur(3px) saturate(1.15);backdrop-filter:blur(3px) saturate(1.15)}}
.columns>.notices ul{gap:.7rem;list-style:disc;padding-inline-start:1.2rem}
.admin{margin-top:2rem}
.admin p{max-width:22rem;margin:0 auto .7rem;color:var(--ink-soft);font-size:.88rem;line-height:1.6;text-wrap:balance}
.admin .btn{width:min(100%,300px);background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--ink)}
.admin .btn:hover{background:var(--ink);color:var(--btn-ink)}
.columns>.notices{margin:0 auto;text-align:start}
@media (min-width:56rem){.columns{grid-template-columns:minmax(0,20rem) minmax(0,1fr);grid-template-rows:auto 1fr;align-items:start}.columns>.main{grid-column:1;grid-row:1 / span 2}.columns>.notices{grid-column:2;grid-row:1;margin:1.5rem 0 0}.columns>.notices.fine{grid-row:2;margin-top:.9rem}.columns{row-gap:0}}
/* The check, when it shows, and the button are one block: same width, same corners. */
form{display:grid;width:min(100%,300px);margin:2rem auto 0}
/* The check takes no room until it has something to ask. */
.check{border-radius:12px;overflow:hidden}
.check.asking{margin-bottom:.75rem}
.btn,.start-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:.8rem 1.9rem;border:0;border-radius:12px;background:var(--ink);color:var(--btn-ink);font:640 1rem/1.3 var(--f);text-align:center;text-decoration:none;cursor:pointer;transition:transform .15s ease,background-color .2s}
.start-btn{width:100%}
.btn:hover,.start-btn:hover{background:var(--btn-hover)}
.btn:active,.start-btn:active{transform:translateY(1px)}
.btn:disabled,.start-btn:disabled{cursor:default;opacity:.6}
/* Two numbers as a footnote: label, then figure, in the size of the language links. */
.tally{display:flex;flex-wrap:wrap;justify-content:center;gap:.1rem 1.5rem;margin:1.4rem 0 0;color:var(--ink-muted);font-size:.8rem;line-height:1.6}
.tally div{display:flex;align-items:baseline;gap:.45em}
.tally dd{margin:0;color:var(--ink-soft);font-weight:620;font-variant-numeric:tabular-nums;direction:ltr}
.tally dd span{color:var(--ink-muted);font-weight:420}
.note{color:var(--ink-soft)}
.lang{margin-top:1.6rem}
.tally+.lang{margin-top:.7rem}
.lang ul{list-style:none;display:flex;flex-wrap:wrap;justify-content:center;gap:.1rem .9rem;margin:0;padding:0}
.lang a{display:inline-block;padding:.35rem 0;font-size:.85rem;color:var(--ink-muted);text-decoration:none}
.lang a[aria-current]{color:var(--ink);text-decoration:underline;text-decoration-color:var(--accent);text-decoration-thickness:2px;text-underline-offset:.25em}
.lang a:hover{color:var(--ink)}

/* The window: only once there is something to report. Glass over the city, solid without it. */
.window{width:min(100%,27rem);padding:1.6rem 1.75rem 1.4rem;border:1px solid var(--line);border-radius:14px;background:var(--glass-solid);box-shadow:0 24px 60px var(--shadow);text-align:start}
[data-scene=city] .window{background:var(--glass)}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){[data-scene=city] .window{-webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2)}}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){[data-scene=city] .window{background:var(--glass-solid)}}
.window h1{font-size:1.32rem;font-weight:620;line-height:1.35;overflow-wrap:anywhere;text-wrap:balance}
.window .status{min-height:1.7em;font-size:.94rem;overflow-wrap:anywhere}
.window .lang{margin-top:1rem}
.gate.scene{place-items:end center;padding-bottom:max(7vh,1.75rem)}
.gate .window{animation:rise .7s ease-out .25s backwards}
.leaving .window{opacity:0;transform:translateY(10px);transition:opacity .6s ease,transform .6s ease;pointer-events:none}
/* Four parts of the work: plan, detail, surfaces, lights. */
.steps{direction:ltr;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:1.3rem 0 .75rem}
.steps i{height:2px;border-radius:2px;background:var(--line);transition:background-color .6s}
.steps[data-step="1"] i:nth-child(-n+1),.steps[data-step="2"] i:nth-child(-n+2),.steps[data-step="3"] i:nth-child(-n+3),.steps[data-step="4"] i{background:var(--accent)}
.steps[data-ready] i{background:var(--lamp)}
[dir=rtl] .steps{direction:rtl}
/* Three dots that cycle (one, two, three) while something is in progress; width is reserved. */
.dots{display:inline-block;margin-inline-start:.05em;direction:ltr;color:var(--ink-muted)}
.dots i{font-style:normal}
.dots i:nth-child(2){animation:dot2 1.5s steps(1,end) infinite}
.dots i:nth-child(3){animation:dot3 1.5s steps(1,end) infinite}
@keyframes dot2{0%{opacity:0}33.33%,100%{opacity:1}}
@keyframes dot3{0%,33.33%{opacity:0}66.66%,100%{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(12px)}}
.status.bad{color:var(--bad)}
.skip{display:block;min-height:44px;margin:.2rem auto 0;padding:0;border:0;background:none;color:var(--ink-muted);font:inherit;font-size:.88rem;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:.2em;cursor:pointer}
.skip:hover{color:var(--ink)}
.open-btn{width:100%;margin-top:1.1rem;animation:rise .6s ease-out backwards}
.retry{margin-top:1.1rem}
.retry .btn{width:100%}
.error .window h1+.status{margin-top:.6rem}
.error .window .btn{margin-top:1.2rem}

/* Day or night: the one that is up sets, the other rises. */
.theme{position:fixed;z-index:4;top:max(14px,env(safe-area-inset-top));inset-inline-end:16px;width:44px;height:44px;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--glass);color:var(--ink);cursor:pointer;overflow:hidden}
.theme svg{position:absolute;inset:11px;width:20px;height:20px;transition:transform .9s cubic-bezier(.5,0,.2,1),opacity .6s ease}
.theme .sun{color:var(--lamp);transform:translateY(34px) rotate(-90deg);opacity:0}
[data-theme=day] .theme .moon{transform:translateY(34px) rotate(60deg);opacity:0}
[data-theme=day] .theme .sun{transform:none;opacity:1}
html,body,.window,.theme{transition:background-color .8s,color .8s,border-color .8s}

@media (max-width:30rem){.window{padding:1.25rem 1.25rem 1.1rem}.gate.scene{padding-bottom:1.25rem}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;
