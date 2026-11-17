/**
 * The waiting page's browser code (DOM, timers, network) as JavaScript source. The decisions live
 * in gate-logic.ts; this part only feeds it real answers and the clock, and shows its result: in
 * words, and in the city behind them, which is told how far the logic's own sequences have got
 * and never anything more. Plain text only (textContent): nothing from the network is ever
 * written as HTML. No backticks, dollar-brace or backslashes in here.
 */
export const GATE_UI_JS = `var root = document.getElementById('gate');
if (root) {
  var scene = window.AuthrimScene || {};
  var city = null;
  var metaTag = document.querySelector('meta[name="console-origin"]');
  var origin = metaTag ? metaTag.getAttribute('content') || '' : '';
  var texts = {};
  try { texts = JSON.parse(root.getAttribute('data-texts') || '{}'); } catch (e) { texts = {}; }
  var statusEl = document.getElementById('status');
  var retryEl = document.getElementById('retry');
  var skipBtn = document.getElementById('skip');
  var openBtn = document.getElementById('open');
  var titleEl = document.getElementById('title');
  var statusText = document.getElementById('status-text');
  var dotsEl = document.getElementById('dots');
  var stepsEl = root.querySelector('.steps');
  var flash = document.querySelector('.flash');
  // In-progress lines get animated dots (CSS only, aria-hidden); finished and failed ones do not.
  var DOTTED = { gateChecking: 1, gateAccepted: 1, gateInviting: 1, gateSlow: 1, gateUnstable: 1, gateOpening: 1 };
  var langNav = root.querySelector('nav.lang');
  var reduced = !!scene.reduced;
  // The city may come later or never, and nothing here waits for it: the logic plays its
  // sequences only once it is told the picture is there, and gives up on it by itself.
  var logic = AuthrimGate.create({ mode: reduced ? 'static' : 'full', limitMs: 360000 });
  var shown = {};
  var joinUrl = null;
  var inflight = 0;
  var controllers = [];
  var pollTimer = 0;
  var ended = false;
  var leaving = false;
  var departed = false;
  // When each of the logic's sequences began, on its own clock.
  var began = { depart: null, middle: null, arrive: null };
  var held = false;

  root.setAttribute('data-motion', reduced ? 'reduced' : 'full');

  function setAttr(el, name, value) {
    var key = name + (el === root ? '' : '#');
    if (shown[key] === value) return;
    shown[key] = value;
    el.setAttribute(name, value);
  }

  function unit(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  // The city's stage (1 plan, 2 detail, 3 surfaces, 4 lights) and how far into it, read off the
  // logic: its sequences are the only clock. Detail goes on being added for as long as the real
  // creation takes, and is only finished when the next real state has arrived.
  function picture(snap) {
    var clock = snap.clock;
    if (snap.mode === 'static' || (!snap.anim && snap.station >= 3)) {
      return snap.station >= 3 ? [4, 1] : snap.station === 2 ? [3, 1] : snap.station === 1 ? [2, 0.9] : [1, 1];
    }
    if (snap.anim === 'depart' && began.depart === null) began.depart = clock - snap.animTime;
    if (snap.anim === 'middle' && began.middle === null) began.middle = clock - snap.animTime;
    if (snap.anim === 'arrive' && began.arrive === null) began.arrive = clock - snap.animTime;
    if (snap.station >= 1 && began.depart === null) began.depart = clock;
    if (snap.station >= 2 && began.middle === null) began.middle = clock;
    if (snap.station >= 3 && began.arrive === null) began.arrive = clock;
    if (began.arrive !== null) return [4, unit((clock - began.arrive) / 3000)];
    if (began.middle !== null) {
      var m = (clock - began.middle) / 4200;
      var reached = 0.9 * (1 - Math.exp(-(began.middle - began.depart) / 7000));
      return m < 0.2 ? [2, reached + (1 - reached) * unit(m / 0.2)] : [3, unit((m - 0.2) / 0.8)];
    }
    if (began.depart !== null) return [2, 0.9 * (1 - Math.exp(-(clock - began.depart) / 7000))];
    return [1, unit(clock / 3200)];
  }

  function paint(snap) {
    if (snap.terminal) {
      // The picture stops where it was and goes quiet.
      if (city && !held) { held = true; city.setMuted(true); }
      return;
    }
    if (snap.opening) return;
    var at = picture(snap);
    setAttr(stepsEl, 'data-step', String(at[0]));
    if (city) city.setStage(at[0], at[1]);
  }

  function attach(made) {
    if (city || departed || !made) return;
    city = made;
    logic.setAssetsReady();
    step();
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

  function apply(snap) {
    setAttr(root, 'data-state', snap.terminal ? snap.terminal : snap.opening ? 'opening' : snap.real);
    setAttr(root, 'data-view', snap.view);
    var line = texts[snap.status] || '';
    if (statusText.textContent !== line) statusText.textContent = line;
    dotsEl.hidden = !DOTTED[snap.status];
    statusEl.classList.toggle('bad', !!snap.terminal);
    var heading = snap.level >= 3 && !snap.terminal ? texts.gateTitleReady : texts.gateTitle;
    if (heading && titleEl.textContent !== heading) titleEl.textContent = heading;
    skipBtn.hidden = !snap.skip;
    if (langNav) langNav.hidden = !snap.langLinks;
    if (snap.seal && openBtn.hidden) {
      openBtn.hidden = false;
      setAttr(stepsEl, 'data-ready', '1');
      var active = document.activeElement;
      if (!active || active === document.body || active === skipBtn) openBtn.focus();
      if (document.hidden && texts.gateTitleReady) document.title = texts.gateTitleReady.split(String.fromCharCode(8203)).join('');
    }
    if (!snap.seal && !openBtn.hidden && !snap.opening) openBtn.hidden = true;
    if (snap.terminal) {
      retryEl.hidden = false;
      joinUrl = null;
      if (!ended) {
        ended = true;
        stopPolling();
        var a = document.activeElement;
        if (!a || a === document.body || a === skipBtn || a === openBtn) retryEl.querySelector('a').focus();
        openBtn.hidden = true;
      }
    }
    if (snap.level >= 3 && !snap.terminal) stopPolling();
  }

  /** One tick of the logic, the words and the picture. */
  function step() {
    var snap = logic.tick(Date.now());
    apply(snap);
    paint(snap);
    return snap;
  }

  function handle(res) {
    var now = Date.now();
    if (res.kind === 'ok') {
      var data = res.data || {};
      var state = data.state;
      if (state === 'ready') {
        if (AuthrimGate.isJoinTarget(origin, data.join)) {
          joinUrl = data.join;
          logic.onResponse({ kind: 'ready', expiresIn: data.join_expires_in }, now, inflight);
        } else {
          logic.onResponse({ kind: 'badjoin' }, now, inflight);
        }
      } else if (state === 'handed_off') logic.onResponse({ kind: 'handed_off' }, now, inflight);
      else if (state === 'failed') logic.onResponse({ kind: 'failed' }, now, inflight);
      else logic.onResponse({ kind: data.stage === 'inviting' ? 'inviting' : 'provisioning' }, now, inflight);
    } else if (res.kind === 'notfound') {
      logic.onResponse({ kind: 'notfound' }, now, inflight);
    } else {
      logic.onResponse({ kind: 'error' }, now, inflight);
    }
    step();
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

  /** The way out: down onto the avenue and along it into the light, then the console. */
  function leave() {
    departed = true;
    document.body.classList.add('leaving');
    function light() { if (flash) flash.classList.add('on'); }
    if (!city || reduced) {
      light();
      setTimeout(go, 300);
      return;
    }
    city.leave({ onFlash: light, onDone: go });
    // Whatever happens to the picture, the console is opened.
    setTimeout(light, 11000);
    setTimeout(go, 13000);
  }

  function onOpen() {
    if (!logic.press(Date.now())) return;
    openBtn.disabled = true;
    step();
    leave();
  }
  openBtn.addEventListener('click', onOpen);
  skipBtn.addEventListener('click', function () {
    if (!logic.skip()) return;
    step();
    openBtn.focus();
  });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) step(); });
  window.addEventListener('pageshow', function (event) { if (event.persisted && !ended && !logic.isDone()) poll(); });

  step();
  if (scene.city) attach(scene.city);
  else scene.onCity = attach;
  poll();
  pollTimer = setInterval(poll, 2000);
  setInterval(step, 50);
}
`;
