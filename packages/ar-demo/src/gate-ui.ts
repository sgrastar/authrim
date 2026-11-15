/**
 * The gate page's browser code (DOM, timers, network) as JavaScript source. The decisions live in
 * gate-logic.ts; this part only feeds it real answers and the clock, and shows its result. Plain
 * text only (textContent): nothing from the network is ever written as HTML. No backticks,
 * dollar-brace or backslashes in here.
 */
export const GATE_UI_JS = `var root = document.getElementById('gate');
if (root) {
  var metaTag = document.querySelector('meta[name="console-origin"]');
  var origin = metaTag ? metaTag.getAttribute('content') || '' : '';
  var texts = {};
  try { texts = JSON.parse(root.getAttribute('data-texts') || '{}'); } catch (e) { texts = {}; }
  var stage = root.querySelector('.stage');
  var statusEl = document.getElementById('status');
  var retryEl = document.getElementById('retry');
  var skipBtn = document.getElementById('skip');
  var sealBtn = document.getElementById('seal');
  var openBtn = document.getElementById('seal2');
  var titleEl = document.getElementById('title');
  var statusText = document.getElementById('status-text');
  var dotsEl = document.getElementById('dots');
  // In-progress lines get animated dots (CSS only, aria-hidden); finished and failed ones do not.
  var DOTTED = { gateChecking: 1, gateAccepted: 1, gateInviting: 1, gateSlow: 1, gateUnstable: 1, gateOpening: 1 };
  var langNav = root.querySelector('nav.lang');
  var canvas = root.querySelector('canvas.gl');
  var glow = root.querySelector('.glow');
  var farWrap = root.querySelector('.far-wrap');
  var nearWrap = root.querySelector('.near-wrap');
  var baseImg = root.querySelector('img.far');
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var logic = AuthrimGate.create({ scales: GEO.camera.stationScales, mode: reduced ? 'static' : 'full', limitMs: 360000 });
  var shown = {};
  var joinUrl = null;
  var inflight = 0;
  var controllers = [];
  var pollTimer = 0;
  var ended = false;
  var firstAnswerAt = 0;
  var drawMode = 'canvas';
  var imgs = { dark: null, farLit: null, flame: null, nearDark: null, nearLit: null };
  var group1Done = false;
  var group2Started = false;
  var doorsLoaded = false;
  var renderer = null;
  var rafId = 0;
  var lastFrame = 0;
  var stillKey = '';
  var leaving = false;
  var holder = document.createElement('div');
  holder.hidden = true;
  root.appendChild(holder);

  root.setAttribute('data-motion', reduced ? 'reduced' : 'full');

  function setAttr(el, name, value) {
    var key = name + (el === root ? '' : '#');
    if (shown[key] === value) return;
    shown[key] = value;
    el.setAttribute(name, value);
  }

  /** A hidden picture element with AVIF and WebP sources; resolves with the loaded img. */
  function loadPicture(stem, size) {
    return new Promise(function (resolve, reject) {
      var picture = document.createElement('picture');
      var avif = document.createElement('source');
      avif.type = 'image/avif';
      avif.srcset = ASSETS[stem + '-' + size + '.avif'];
      var webp = document.createElement('source');
      webp.type = 'image/webp';
      webp.srcset = ASSETS[stem + '-' + size + '.webp'];
      var img = document.createElement('img');
      img.alt = '';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error(stem)); };
      picture.appendChild(avif);
      picture.appendChild(webp);
      picture.appendChild(img);
      holder.appendChild(picture);
      img.src = ASSETS[stem + '-' + size + '.webp'];
    });
  }

  function loadFlat(name, target) {
    return new Promise(function (resolve, reject) {
      var img = target || new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error(name)); };
      img.src = ASSETS[name];
    });
  }

  function sizes() {
    var small = stage.clientWidth <= 700;
    return { far: small ? 1600 : 2400, near: small ? 1200 : 2400 };
  }

  /** Image-only picture: the four photographs stacked, switched by data-station in CSS. */
  function useFallback() {
    if (drawMode === 'img') return;
    drawMode = 'img';
    renderer = null;
    setAttr(root, 'data-draw', 'img');
    canvas.hidden = true;
    var sz = sizes();
    function layer(parent, cls, stem, size) {
      loadPicture(stem, size).then(function (img) {
        holder.removeChild(img.parentNode);
        img.className = cls;
        parent.appendChild(img);
      }, function () {});
    }
    layer(farWrap, 'far-lit', 'far-lit', sz.far);
    layer(nearWrap, 'near-dark', 'near-dark', sz.near);
    layer(nearWrap, 'near-lit', 'near-lit', sz.near);
    logic.setAssetsReady();
    startGroup2();
  }

  function startGroup2() {
    if (group2Started) return;
    group2Started = true;
    var sz = sizes();
    var pending = [
      loadFlat('seal.webp', sealBtn.querySelector('img')),
      loadFlat('near-passage.webp', root.querySelector('img.passage')),
      loadFlat('near-leaf-l.webp', root.querySelector('.leaf.l img')),
      loadFlat('near-leaf-r.webp', root.querySelector('.leaf.r img'))
    ];
    Promise.all(pending).then(function () { doorsLoaded = true; }, function () {});
    if (drawMode === 'canvas') {
      loadPicture('near-dark', sz.near).then(function (img) { imgs.nearDark = img; scheduleDraw(); }, function () {});
      loadPicture('near-lit', sz.near).then(function (img) { imgs.nearLit = img; scheduleDraw(); }, function () {});
    }
  }

  function startGroup1() {
    var sz = sizes();
    Promise.all([loadPicture('far-lit', sz.far), loadFlat('flame-flipbook.webp')]).then(function (done) {
      imgs.farLit = done[0];
      imgs.flame = done[1];
      group1Done = true;
      logic.setAssetsReady();
      if (shown.firstAnswer) startGroup2();
      scheduleDraw();
    }, function () {
      useFallback();
    });
  }

  // The base photograph failed: text-only level. The in-window button is then the one to use.
  function noImages() {
    setAttr(root, 'data-text-only', '1');
    useFallback();
  }

  function initRenderer() {
    var base = baseImg;
    function ready() {
      imgs.dark = base;
      try {
        renderer = createRenderer(canvas, GEO, imgs);
      } catch (e) {
        renderer = null;
      }
      if (!renderer) { useFallback(); return; }
      startGroup1();
    }
    if (!base) { useFallback(); return; }
    if (base.complete && base.naturalWidth) ready();
    else if (base.complete) noImages();
    else { base.addEventListener('load', ready); base.addEventListener('error', noImages); }
  }

  function draw(snap) {
    if (drawMode !== 'canvas' || !renderer || document.hidden) return;
    var scene = snap.scene;
    var idle = !snap.anim && !snap.terminal && !snap.opening && snap.mode === 'full';
    var breathing = idle ? 1 + 0.002 * Math.sin((2 * Math.PI * snap.clock) / 7000) : 1;
    var view = { scale: scene.scale * breathing, blend: scene.blend, fires: scene.fires };
    if (renderer.draw(view, snap.clock, snap.mode === 'static')) canvas.setAttribute('data-on', '1');
  }

  function scheduleDraw() {
    if (drawMode !== 'canvas' || !renderer) return;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function needsLoop(snap) {
    if (drawMode !== 'canvas' || !renderer || snap.mode === 'static') return false;
    return !(snap.terminal && snap.terminalAge > 1500);
  }

  function frame(ts) {
    rafId = 0;
    if (!document.hidden && ts - lastFrame < 30) { rafId = requestAnimationFrame(frame); return; }
    lastFrame = ts;
    var snap = step(true);
    if (needsLoop(snap) && !document.hidden) rafId = requestAnimationFrame(frame);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
    for (var i = 0; i < controllers.length; i++) { try { controllers[i].abort(); } catch (e) {} }
    controllers = [];
  }

  function go() {
    if (leaving || !joinUrl) return;
    leaving = true;
    location.replace(joinUrl);
  }

  /** The visible 'open' control: the door button, or the one in the window on short screens. */
  function openControl() {
    return getComputedStyle(sealBtn).visibility === 'hidden' ? openBtn : sealBtn;
  }

  function apply(snap) {
    setAttr(root, 'data-state', snap.terminal ? snap.terminal : snap.opening ? 'opening' : snap.real);
    setAttr(root, 'data-view', snap.view);
    setAttr(root, 'data-station', String(snap.station));
    var line = texts[snap.status] || '';
    if (statusText.textContent !== line) statusText.textContent = line;
    dotsEl.hidden = !DOTTED[snap.status];
    statusEl.classList.toggle('bad', !!snap.terminal);
    var heading = snap.level >= 3 && !snap.terminal ? texts.gateTitleReady : texts.gateTitle;
    if (heading && titleEl.textContent !== heading) titleEl.textContent = heading;
    skipBtn.hidden = !snap.skip;
    if (langNav) langNav.hidden = !snap.langLinks;
    var sealNow = snap.seal;
    if (sealNow && sealBtn.hidden) {
      sealBtn.hidden = false;
      openBtn.hidden = false;
      sealBtn.removeAttribute('data-shown');
      void sealBtn.offsetWidth;
      sealBtn.setAttribute('data-shown', '1');
      var active = document.activeElement;
      if (!active || active === document.body || active === skipBtn) openControl().focus();
      if (document.hidden && texts.gateTitleReady) document.title = texts.gateTitleReady;
      if (stage.scrollIntoView) stage.scrollIntoView({ block: 'nearest' });
    }
    if (!sealNow && !sealBtn.hidden && !snap.opening) {
      sealBtn.hidden = true;
      openBtn.hidden = true;
    }
    if (snap.terminal) {
      retryEl.hidden = false;
      joinUrl = null;
      if (!ended) {
        ended = true;
        stopPolling();
        var a = document.activeElement;
        if (!a || a === document.body || a === skipBtn || a === sealBtn || a === openBtn) retryEl.querySelector('a').focus();
        sealBtn.hidden = true;
        openBtn.hidden = true;
      }
    }
    if (snap.level >= 3 && !snap.terminal) stopPolling();
    if (snap.mode === 'static' && drawMode === 'canvas' && !group1Done && shown.firstAnswer && Date.now() - firstAnswerAt > 4000) useFallback();
  }

  /** One tick of the logic and the DOM; 'looping' is true when called from the animation frame. */
  function step(looping) {
    var snap = logic.tick(Date.now());
    apply(snap);
    var key = [snap.real, snap.view, snap.station, snap.terminal, snap.opening, group1Done, !!imgs.nearLit].join('|');
    if (needsLoop(snap)) {
      if (looping) draw(snap);
    } else if (key !== stillKey) {
      stillKey = key;
      draw(snap);
    }
    return snap;
  }

  function handle(res) {
    var now = Date.now();
    if (res.kind === 'ok') {
      var data = res.data || {};
      shown.firstAnswer = true;
      if (!firstAnswerAt) firstAnswerAt = now;
      var state = data.state;
      if (state === 'ready') {
        if (AuthrimGate.isJoinTarget(origin, data.join)) {
          joinUrl = data.join;
          logic.onResponse({ kind: 'ready', expiresIn: data.join_expires_in }, now, inflight);
          startGroup2();
        } else {
          logic.onResponse({ kind: 'badjoin' }, now, inflight);
        }
      } else if (state === 'handed_off') logic.onResponse({ kind: 'handed_off' }, now, inflight);
      else if (state === 'failed') logic.onResponse({ kind: 'failed' }, now, inflight);
      else logic.onResponse({ kind: data.stage === 'inviting' ? 'inviting' : 'provisioning' }, now, inflight);
    } else if (res.kind === 'notfound') {
      shown.firstAnswer = true;
      if (!firstAnswerAt) firstAnswerAt = now;
      logic.onResponse({ kind: 'notfound' }, now, inflight);
    } else {
      logic.onResponse({ kind: 'error' }, now, inflight);
    }
    if (shown.firstAnswer && group1Done) startGroup2();
    step();
    scheduleDraw();
  }

  /** Independent requests every 2 s: the one that carries the creation may take a long time. */
  function poll() {
    if (ended || inflight >= 12) return;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctl) controllers.push(ctl);
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 130000);
    inflight += 1;
    var init = { credentials: 'same-origin', cache: 'no-store' };
    if (ctl) init.signal = ctl.signal;
    fetch('/status', init)
      .then(function (response) {
        if (response.status === 404) return { kind: 'notfound' };
        if (!response.ok) return { kind: 'error' };
        return response.json().then(function (data) { return { kind: 'ok', data: data }; });
      })
      .catch(function () { return { kind: 'error' }; })
      .then(function (res) {
        clearTimeout(timer);
        inflight -= 1;
        var at = controllers.indexOf(ctl);
        if (at >= 0) controllers.splice(at, 1);
        handle(res);
      });
  }

  function openGate() {
    var animated = !reduced && drawMode === 'canvas' && doorsLoaded && glow && typeof glow.addEventListener === 'function';
    if (!animated) { setTimeout(go, 300); return; }
    glow.addEventListener('animationend', go);
    setTimeout(go, 4500);
  }

  function onOpen() {
    if (!logic.press(Date.now())) return;
    sealBtn.disabled = true;
    openBtn.disabled = true;
    step();
    openGate();
  }
  sealBtn.addEventListener('click', onOpen);
  openBtn.addEventListener('click', onOpen);
  skipBtn.addEventListener('click', function () {
    if (!logic.skip()) return;
    step();
    scheduleDraw();
    openControl().focus();
  });
  function redraw() { stillKey = ''; step(); scheduleDraw(); }
  window.addEventListener('resize', redraw);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) redraw(); });
  window.addEventListener('pageshow', function (event) { if (event.persisted && !ended && !logic.isDone()) poll(); });

  initRenderer();
  step();
  poll();
  pollTimer = setInterval(poll, 2000);
  setInterval(step, 100);
  scheduleDraw();
}
`;
