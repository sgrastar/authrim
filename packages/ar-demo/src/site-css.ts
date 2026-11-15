import { GATE_PLACEHOLDER } from './gate-assets';
import { GATE_GEOMETRY } from './gate-geometry';

const n = (value: number): string => value.toFixed(5);

/** Left / top of a point of the near picture, in the stage's container units (cover fit). */
const px = (x: number): string => `calc(50cqw + ${n(x - 0.5)} * var(--iw))`;
const py = (y: number): string => `calc(50cqh + ${n(y - 0.5)} * var(--ih))`;

/** Absolute box of a rectangle of the near picture, given as [x0, y0, x1, y1]. */
function nearBox(x0: number, y0: number, x1: number, y1: number): string {
  return `left:${px(x0)};top:${py(y0)};width:calc(${n(x1 - x0)} * var(--iw));height:calc(${n(y1 - y0)} * var(--ih))`;
}

const [ox0, oy0, ox1, oy1] = GATE_GEOMETRY.near.opening;
const seam = GATE_GEOMETRY.near.seamX;
const vanishing = GATE_GEOMETRY.near.vanishingPoint;
const seal = GATE_GEOMETRY.near.seal;
const sealDiameter = ((ox1 - ox0) / 2) * 0.62;

const BODY_LATIN =
  '"Palatino Linotype",Palatino,"Book Antiqua","Iowan Old Style",Georgia,"Noto Serif",serif';
const HEAD_LATIN = `"Trajan Pro",Trajan,Cinzel,${BODY_LATIN}`;
const JA = '"Hiragino Mincho ProN","Yu Mincho",YuMincho,"Noto Serif CJK JP","MS PMincho",serif';
const AR = '"Geeza Pro","Noto Naskh Arabic","Traditional Arabic","Times New Roman",serif';

/** One file, no inline style anywhere: every state is an attribute, every motion a keyframe. */
export const SITE_CSS = `:root{--night-0:#05070b;--night-1:#0b1017;--stone-2:#151c26;--stone-3:#2a3441;--ink:#eef1f4;--ink-2:#c3cad3;--gold:#c9a45c;--gold-2:#f1d9a0;--ember:#f2a03d;--frost:#9fb6cc;--f-body:${BODY_LATIN};--f-head:${HEAD_LATIN};color-scheme:dark}
html:lang(ja){--f-body:${JA};--f-head:${JA};line-break:strict}
html:lang(ar){--f-body:${AR};--f-head:${AR};font-size:1.125rem}
html:lang(ja){word-break:auto-phrase}
*{box-sizing:border-box}
html{background:var(--night-0)}
body{margin:0;min-height:100vh;background:var(--night-0);color:var(--ink);font:1.0625rem/1.65 var(--f-body);-webkit-text-size-adjust:100%}
h1,h2,p,ul{margin:0}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--gold);text-decoration-thickness:2px;text-underline-offset:.2em}
/* One focus style for the whole site: a thin warm-gold ring. */
a:focus-visible,button:focus-visible{outline:2px solid var(--gold-2);outline-offset:3px;box-shadow:0 0 10px rgba(241,217,160,.4)}
[hidden]{display:none!important}

.scene{position:relative;display:grid;place-items:center;min-height:100vh;min-height:100svh;padding:1rem}
.stage{direction:ltr;position:fixed;inset:0;z-index:1;overflow:hidden;container-type:size;background:var(--night-0) url(data:image/webp;base64,${GATE_PLACEHOLDER.replace(/^data:image\/webp;base64,/, '')}) center/cover no-repeat;--iw:max(100cqw,150cqh);--ih:max(100cqh,66.6667cqw)}
.far-wrap,.near-wrap,.gl{position:absolute;inset:0;width:100%;height:100%}
.near-wrap img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
/* The far picture: cover, but never narrower than 53 % of it is shown (tall screens keep the fires in view). */
.far-wrap img{position:absolute;left:50%;top:50%;width:min(max(100cqw,150cqh),187.5cqw);max-width:none;height:auto;transform:translate(-50%,-50%);display:block}
.far-wrap img.noimg{display:none}
@container (max-aspect-ratio:4/5){.far-wrap img{-webkit-mask-image:linear-gradient(transparent,#000 14%,#000 86%,transparent);mask-image:linear-gradient(transparent,#000 14%,#000 86%,transparent)}}
.gl{display:block;opacity:0}
.gl[data-on]{opacity:1}

.window{position:relative;z-index:2;display:flex;flex-direction:column;gap:1rem;width:100%;max-width:30rem;padding:1.5rem 1.5rem 1.1rem;border:1px solid rgba(201,164,92,.42);border-radius:12px;background:rgba(8,12,18,.78);box-shadow:0 12px 44px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.04);text-align:center}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.window{-webkit-backdrop-filter:blur(10px) saturate(1.1);backdrop-filter:blur(10px) saturate(1.1)}}
h1{position:relative;padding-bottom:1.15rem;font:600 clamp(1.3rem,1.05rem + 1vw,1.7rem)/1.35 var(--f-head);overflow-wrap:anywhere}
h1:lang(en),h1:lang(de){text-transform:uppercase;letter-spacing:.14em;font-size:clamp(1.1rem,.95rem + .8vw,1.4rem)}
h1::after{content:"";position:absolute;left:8%;right:8%;bottom:.35rem;height:1px;background:linear-gradient(90deg,transparent,var(--gold) 22%,var(--gold) 44%,transparent 44%,transparent 56%,var(--gold) 56%,var(--gold) 78%,transparent)}
h1::before{content:"";position:absolute;left:50%;bottom:calc(.35rem - 3.5px);width:7px;height:7px;transform:translateX(-50%) rotate(45deg);background:var(--night-1);border:1px solid var(--gold)}
.notices{padding:.9rem 1rem;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.14);border-radius:8px;text-align:start}
.notices h2{font:700 1rem/1.4 var(--f-head);margin-bottom:.5rem;color:var(--gold-2)}
.notices h2:lang(en),.notices h2:lang(de){text-transform:uppercase;letter-spacing:.14em;font-size:.9rem}
.notices ul{list-style:none;padding:0;display:grid;gap:.5rem}
.notices li{position:relative;padding-inline-start:1.4rem;color:var(--ink)}
.notices li::before{content:"";position:absolute;inset-inline-start:0;top:.55em;width:.55rem;height:.55rem;border-radius:50%;background:radial-gradient(circle at 35% 30%,#d9c08a,#5a4a28 70%);box-shadow:0 0 0 1px rgba(0,0,0,.5)}
.cf-turnstile{min-height:65px;display:flex;justify-content:center}
.btn,.start-btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:.6rem 1.5rem;border:1px solid var(--gold);border-radius:6px;background:linear-gradient(#323843,#171b22);color:var(--gold-2);font:600 1rem/1.3 var(--f-head);text-decoration:none;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.14),inset 0 0 0 1px rgba(0,0,0,.65),0 2px 6px rgba(0,0,0,.5);text-shadow:0 1px 0 rgba(0,0,0,.7)}
.btn:lang(en),.btn:lang(de),.start-btn:lang(en),.start-btn:lang(de){text-transform:uppercase;letter-spacing:.16em}
.btn:hover,.start-btn:hover{border-color:#e6c27a;background:linear-gradient(#3c4350,#1e232c);color:#fff0c8}
.btn:active,.start-btn:active{transform:translateY(1px);background:linear-gradient(#14181f,#232832);box-shadow:inset 0 2px 5px rgba(0,0,0,.7),0 1px 2px rgba(0,0,0,.5)}
.btn:disabled,.start-btn:disabled{border-color:var(--stone-3);background:var(--stone-2);color:#8d96a1;cursor:default;box-shadow:none;text-shadow:none}
.start-btn{width:100%}
form{display:grid;gap:.9rem}
.note{color:var(--ink-2)}
.lang ul{list-style:none;display:flex;flex-wrap:wrap;justify-content:center;gap:.1rem .9rem;margin:0;padding:0}
.lang a{display:inline-block;padding:.35rem 0;font-size:.85rem;color:var(--ink-2);text-decoration:none}
.lang a[aria-current]{color:var(--ink);text-decoration:underline;text-decoration-color:var(--gold);text-decoration-thickness:2px;text-underline-offset:.25em}
.lang a:hover{color:var(--ink)}

.window p{text-wrap:pretty}
.window h1,.window .status,.window .intro{text-wrap:balance}
.notices li{text-wrap:pretty}
.intro{color:var(--ink)}
.status{overflow-wrap:anywhere}
/* Three dots that cycle (one, two, three) while something is in progress; width is reserved. */
.dots{display:inline-block;margin-inline-start:.05em;direction:ltr}
.dots i{font-style:normal}
.dots i:nth-child(2){animation:dot2 1.5s steps(1,end) infinite}
.dots i:nth-child(3){animation:dot3 1.5s steps(1,end) infinite}
@keyframes dot2{0%{opacity:0}33.33%,100%{opacity:1}}
@keyframes dot3{0%,33.33%{opacity:0}66.66%,100%{opacity:1}}
.status.bad::before{content:"";display:inline-block;width:.85em;height:.85em;margin-inline-end:.55em;vertical-align:-.1em;border:2px solid var(--frost);border-radius:50%;background:linear-gradient(135deg,transparent 43%,var(--frost) 43% 57%,transparent 57%)}
.skip{align-self:center;min-height:44px;padding:0;border:0;background:none;color:var(--ink-2);font:inherit;text-decoration:underline;text-decoration-color:var(--gold);text-decoration-thickness:2px;text-underline-offset:.2em;cursor:pointer}
.skip:hover{color:var(--ink)}
/* The in-window open button: only on short screens (the window could cover the door button) and in the text-only level. */
.window .open-btn{display:none;width:100%;margin-top:.4rem}
@media (max-height:32rem),(max-width:22rem) and (max-height:36rem){.window .open-btn:not([hidden]){display:inline-flex}.seal{visibility:hidden}}
[data-text-only] .window .open-btn:not([hidden]){display:inline-flex}
[data-text-only] .seal{visibility:hidden}

/* Gate page: a small window at the top; it becomes the centred window when the run has ended. */
.gate.scene{place-items:start center}
.gate .window{max-width:38rem;gap:.35rem;padding:.8rem 1.25rem .7rem}
.gate .window h1{padding-bottom:.9rem;font-size:1.05rem}
.gate .window h1:lang(en),.gate .window h1:lang(de){font-size:.95rem}
.gate .window .status{font-size:1rem;line-height:1.5}
.gate[data-state=failed],.gate[data-state=timeout],.gate[data-state=lost],.gate[data-state=handedOff],.gate[data-state=sealExpired]{place-items:center}
.gate[data-state=failed] .window,.gate[data-state=timeout] .window,.gate[data-state=lost] .window,.gate[data-state=handedOff] .window,.gate[data-state=sealExpired] .window{max-width:30rem;gap:1rem;padding:1.5rem 1.5rem 1.1rem}

.seal{position:absolute;${`left:${px(seal.x)};top:${py(seal.y)}`};width:max(84px,calc(${n(sealDiameter)} * var(--iw)));min-width:56px;min-height:56px;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;transform:translate(-50%,-50%)}
.seal::before{content:"";position:absolute;left:50%;top:50%;width:260%;aspect-ratio:1;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(242,160,61,.55),rgba(242,160,61,0) 62%);animation:seal-glow 2.4s ease-in-out infinite;pointer-events:none}
.seal img{position:relative;display:block;width:100%;height:auto;aspect-ratio:1;border-radius:50%;filter:drop-shadow(0 4px 6px rgba(0,0,0,.6))}
.seal span{position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);padding:.2rem .6rem;border-radius:6px;background:rgba(11,16,23,.92);color:var(--ink);font-size:.9rem;line-height:1.35;white-space:nowrap}
.seal:hover::before{filter:brightness(1.15)}
.seal:hover span{background:var(--ember);color:var(--ember-ink)}
.seal:focus-visible{outline:2px solid var(--gold-2);outline-offset:6px;box-shadow:0 0 16px rgba(241,217,160,.5);border-radius:50%}
.seal[data-shown]{animation:seal-in .4s ease-out both}
.seal:disabled{cursor:default}

.door{position:absolute;inset:0;visibility:hidden;perspective:calc(1.8333 * var(--iw));perspective-origin:${px(vanishing[0])} ${py(vanishing[1])};pointer-events:none}
.door img{display:block}
.door .passage{position:absolute;${nearBox(ox0, oy0, ox1, oy1)};opacity:.55}
.door .leaf{position:absolute;transform-style:preserve-3d}
.door .leaf img{position:absolute;inset:0;width:100%;height:100%}
.door .leaf.l{${nearBox(ox0, oy0, seam, oy1)};transform-origin:0 50%}
.door .leaf.r{${nearBox(seam, oy0, ox1, oy1)};transform-origin:100% 50%}
.door .dim{position:absolute;inset:0;background:var(--night-0);opacity:0}
.door .edge{position:absolute;top:0;bottom:0;width:7%;background:linear-gradient(90deg,#1c130c,#3a2716)}
.door .l .edge{right:0;transform-origin:100% 50%;transform:rotateY(90deg)}
.door .r .edge{left:0;transform-origin:0 50%;transform:rotateY(-90deg)}
.door .glow{position:absolute;inset:0;opacity:0;background:radial-gradient(circle at ${px(0.5)} ${py(0.6)},#ffd9a0,rgba(255,217,160,.85) 45%,rgba(255,217,160,.6) 100%)}

[data-state=opening] .seal{animation:seal-out .6s ease-in forwards;pointer-events:none}
[data-state=opening] .seal img{animation:seal-turn .4s ease-in forwards}
[data-state=opening] .door{animation:door-show 0s .4s forwards}
[data-state=opening] .passage{animation:passage 3s .4s linear both}
[data-state=opening] .leaf.l{animation:leaf-l 3s cubic-bezier(.5,0,.15,1) .4s both}
[data-state=opening] .leaf.r{animation:leaf-r 3s cubic-bezier(.5,0,.15,1) .54s both}
[data-state=opening] .dim{animation:dim 3s linear .4s both}
[data-state=opening] .glow{animation:warm .6s ease-in 3s both}

/* Image-only picture: the photographs stacked, switched by data-station. */
[data-draw=img] .far-wrap{transform-origin:50% 46.8%;transition:transform 3400ms cubic-bezier(.45,0,.2,1)}
[data-draw=img] .far-wrap .far-lit{opacity:0;transition:opacity 800ms}
[data-draw=img] .near-wrap img{opacity:0;transition:opacity 800ms}
[data-draw=img][data-station="1"] .far-wrap{transform:scale(1.35)}
[data-draw=img][data-station="1"] .far-lit{opacity:.45}
[data-draw=img][data-station="2"] .far-wrap{transform:scale(1.8)}
[data-draw=img][data-station="2"] .far-lit{opacity:.85}
[data-draw=img][data-station="3"] .far-wrap{transform:scale(${GATE_GEOMETRY.camera.stationScales[3]})}
[data-draw=img][data-station="3"] .far-lit{opacity:.85}
[data-draw=img][data-station="3"] .near-dark{opacity:1}
[data-draw=img][data-station="3"] .near-lit{opacity:.35}
[data-draw=img][data-station="3"][data-view=ready] .near-lit,[data-draw=img][data-state=opening] .near-lit{opacity:1}
[data-draw=img][data-state=failed] .far-lit,[data-draw=img][data-state=timeout] .far-lit,[data-draw=img][data-state=lost] .far-lit,[data-draw=img][data-state=handedOff] .far-lit,[data-draw=img][data-state=sealExpired] .far-lit,[data-draw=img][data-state=failed] .near-lit,[data-draw=img][data-state=timeout] .near-lit,[data-draw=img][data-state=lost] .near-lit,[data-draw=img][data-state=handedOff] .near-lit,[data-draw=img][data-state=sealExpired] .near-lit{opacity:0}

@keyframes seal-glow{0%,100%{opacity:.7}50%{opacity:1}}
@keyframes seal-in{from{opacity:0;transform:translate(-50%,-50%) scale(.9)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
@keyframes seal-turn{to{transform:rotate(90deg) scale(.96)}}
@keyframes seal-out{0%,66%{opacity:1}100%{opacity:0}}
@keyframes door-show{to{visibility:visible}}
@keyframes passage{0%,40%{opacity:.55}100%{opacity:1}}
@keyframes leaf-l{to{transform:rotateY(76deg)}}
@keyframes leaf-r{to{transform:rotateY(-74deg)}}
@keyframes dim{to{opacity:.5}}
@keyframes warm{to{opacity:1}}

@media (prefers-reduced-motion:reduce){
.dots i{animation:none}
.seal::before{animation:none;opacity:.9}
.seal[data-shown]{animation:none}
[data-draw=img] .far-wrap,[data-draw=img] .far-lit,[data-draw=img] .near-wrap img{transition:none}
}
[data-motion=reduced] .dots i{animation:none}
[data-motion=reduced] .seal::before{animation:none;opacity:.9}
[data-motion=reduced] .seal[data-shown]{animation:none}
[data-motion=reduced][data-draw=img] .far-wrap,[data-motion=reduced][data-draw=img] .far-lit,[data-motion=reduced][data-draw=img] .near-wrap img{transition:none}

`;
