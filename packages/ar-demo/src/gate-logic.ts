/**
 * The gate's state machine as plain JavaScript source (no DOM, no timers, time is passed in).
 * It is shipped inside /assets/wait.js and evaluated unchanged by the unit tests.
 *
 * Invariant: the picture (`view`) may lag the real state but never runs ahead of it. Every stage
 * sequence plays in full, in order; the seal appears only after a real `ready`.
 *
 * No backticks, no dollar-brace and no backslashes in here: this is a template literal.
 */
export const GATE_LOGIC_JS = `var AuthrimGate = (function () {
  var LEVEL = { arriving: 0, provisioning: 1, inviting: 2, ready: 3 };
  var FIRES = ['P1', 'P2', 'P3', 'P4', 'P5', 'GB', 'GT'];
  var TARGET_ID = { failed: 'failed', timeout: 'timeout', lost: 'lost', handedOff: 'handedOff', sealExpired: 'gateExpired' };
  var STEADY = 0.92;

  /** Stage sequences. 'cam' is [from ms, to ms, from scale index, to scale index]. */
  var ANIMS = [
    { name: 'depart', dur: 4200, level: 1, view: 'creating', lights: [['P1', 300], ['P2', 1000]], cam: [400, 3800, 0, 1] },
    { name: 'middle', dur: 4200, level: 2, view: 'inviting', lights: [['P3', 300], ['P4', 800], ['P5', 1300]], cam: [400, 3800, 1, 2] },
    { name: 'arrive', dur: 3400, level: 3, view: 'approaching', lights: [['GB', 2800], ['GT', 3100]], cam: [0, 3000, 2, 3], blend: [1000, 2300] }
  ];
  var LIGHT_LEVEL = { P1: 1, P2: 1, P3: 2, P4: 2, P5: 2, GB: 3, GT: 3 };

  function easeInOut(u) { u = u < 0 ? 0 : u > 1 ? 1 : u; return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; }
  function easeOut(u) { u = u < 0 ? 0 : u > 1 ? 1 : u; return 1 - Math.pow(1 - u, 3); }

  /** Intensity of a fire that was lit age ms ago (0 -> 1.15 in 220 ms, then down to the steady value). */
  function ignite(age) {
    if (age <= 0) return 0;
    if (age < 220) return 1.15 * easeOut(age / 220);
    if (age < 700) return 1.15 + (STEADY - 1.15) * easeOut((age - 220) / 480);
    return STEADY;
  }

  /** The join link must be the console origin plus the join path, with the code only in the fragment. */
  function isJoinTarget(origin, join) {
    return !!origin && typeof join === 'string' && join.indexOf(origin + '/admin/join#') === 0;
  }

  /** Press deadline in seconds after the moment ready was received. */
  function pressWindow(expiresIn) {
    var seconds = typeof expiresIn === 'number' && isFinite(expiresIn) && expiresIn > 0 ? expiresIn - 30 : 300;
    if (seconds > 300) seconds = 300;
    return seconds < 0 ? 0 : seconds;
  }

  function create(options) {
    var opts = options || {};
    var scales = opts.scales || [1, 1.35, 1.8, 3.6];
    var limitMs = opts.limitMs || 360000;
    var s = {
      mode: opts.mode === 'static' ? 'static' : 'full',
      assets: false,
      real: 'arriving',
      level: 0,
      levelSince: null,
      startedAt: null,
      firstAt: null,
      last: null,
      clock: 0,
      finished: 0,
      cur: null,
      lit: {},
      skipped: false,
      skip: null,
      readyAt: null,
      deadlineAt: null,
      warnAt: null,
      opening: false,
      terminal: null,
      pending: null,
      fails: 0
    };

    function stationScale(i) { return scales[i]; }

    function lightsFor(level, at) {
      for (var i = 0; i < FIRES.length; i++) {
        if (LIGHT_LEVEL[FIRES[i]] <= level && s.lit[FIRES[i]] === undefined) s.lit[FIRES[i]] = at;
      }
    }

    function sealVisible() {
      if (s.terminal || s.opening || s.level < 3) return false;
      return s.mode === 'static' || s.skipped || s.finished >= 3;
    }

    function recordLights(i, t, start) {
      var list = ANIMS[i].lights;
      for (var k = 0; k < list.length; k++) {
        if (t >= list[k][1] && s.lit[list[k][0]] === undefined) s.lit[list[k][0]] = start + list[k][1];
      }
    }

    function advance() {
      if (s.terminal) return;
      if (s.mode === 'static' || s.skipped) {
        s.cur = null;
        s.finished = s.level;
        lightsFor(s.level, s.clock - 1000);
        return;
      }
      if (!s.assets) return;
      for (var guard = 0; guard < 8; guard++) {
        if (!s.cur) {
          if (s.finished < ANIMS.length && ANIMS[s.finished].level <= s.level) s.cur = { i: s.finished, start: s.clock };
          else return;
        }
        var a = ANIMS[s.cur.i];
        var t = s.clock - s.cur.start;
        recordLights(s.cur.i, Math.min(t, a.dur), s.cur.start);
        if (t < a.dur) return;
        // The next sequence follows at once, continuing from where this one ended.
        var carried = s.cur.start + a.dur;
        s.finished = s.cur.i + 1;
        s.cur = null;
        if (s.finished < ANIMS.length && ANIMS[s.finished].level <= s.level) s.cur = { i: s.finished, start: carried };
        else return;
      }
    }

    function camera(at) {
      // returns { scale, blend } of the picture at clock time 'at' (not including the failure stop)
      var scale = stationScale(s.finished > 3 ? 3 : s.finished);
      var blend = s.finished >= 3 ? 1 : 0;
      if (s.cur) {
        var a = ANIMS[s.cur.i];
        var t = at - s.cur.start;
        var e = easeInOut((t - a.cam[0]) / (a.cam[1] - a.cam[0]));
        var s0 = stationScale(a.cam[2]);
        var s1 = stationScale(a.cam[3]);
        scale = s0 * Math.pow(s1 / s0, e);
        blend = a.blend ? easeInOut((t - a.blend[0]) / (a.blend[1] - a.blend[0])) : 0;
      }
      if (s.skip) {
        var u = easeInOut((at - s.skip.at) / 400);
        scale = s.skip.scale * Math.pow(stationScale(3) / s.skip.scale, u);
        blend = s.skip.blend + (1 - s.skip.blend) * u;
      }
      return { scale: scale, blend: blend };
    }

    function intensities() {
      var out = {};
      var i;
      var t = s.terminal;
      var order = null;
      if (t) {
        order = [];
        var seen = {};
        var litIds = [];
        for (i = 0; i < FIRES.length; i++) if (t.from.fires[FIRES[i]] > 0.05) litIds.push(FIRES[i]);
        litIds.sort(function (x, y) { return s.lit[y] - s.lit[x]; });
        for (i = 0; i < litIds.length; i++) if (!seen[litIds[i]]) { seen[litIds[i]] = order.length; order.push(litIds[i]); }
      }
      for (i = 0; i < FIRES.length; i++) {
        var id = FIRES[i];
        var v = 0;
        var sprite = 1;
        if (!t) {
          if (s.lit[id] !== undefined) {
            var age = s.clock - s.lit[id];
            v = ignite(age);
            sprite = age < 300 ? 0.4 + 0.6 * (age / 300) : 1;
          }
        } else {
          var from = t.from.fires[id] || 0;
          var target = t.kind === 'sealExpired' && (id === 'P4' || id === 'P5') ? 0.25 : 0;
          if (from <= 0.05) { v = 0; sprite = 0; }
          else {
            var u = s.clock - t.at - order.indexOf(id) * 180;
            sprite = u <= 0 ? 1 : Math.max(0, 1 - u / 300);
            if (u <= 0) v = from;
            else if (target > 0) v = from + (target - from) * easeOut(u / 700);
            else if (u < 500) v = from + (0.12 - from) * (u / 500);
            else if (u < 1200) v = 0.12 * (1 - (u - 500) / 700);
            else v = 0;
          }
        }
        out[id] = { i: v, sprite: sprite };
      }
      return out;
    }

    function scene() {
      var c;
      if (s.terminal) {
        var from = s.terminal.from;
        c = { scale: from.scale, blend: from.blend };
        var u = (s.clock - s.terminal.at) / 600;
        if (s.terminal.v && u > 0) {
          var run = Math.log(from.scale) + s.terminal.v * 200 * easeOut(u);
          c.scale = Math.min(Math.exp(run), s.terminal.cap);
        }
      } else {
        c = camera(s.clock);
      }
      return { scale: c.scale, blend: c.blend, fires: intensities() };
    }

    function stationNow() {
      if (s.terminal) return s.terminal.station;
      if (s.mode === 'static' || s.skipped) return s.level;
      return s.cur ? ANIMS[s.cur.i].cam[3] : s.finished;
    }

    function viewName() {
      if (s.terminal) return s.terminal.view;
      if (s.opening) return 'ready';
      if (s.mode === 'static' || s.skipped) return ['arriving', 'creating', 'inviting', 'ready'][s.level];
      if (s.cur) return ANIMS[s.cur.i].view;
      return ['arriving', 'creating', 'inviting', 'ready'][s.finished > 3 ? 3 : s.finished];
    }

    function end(kind) {
      if (s.terminal || s.opening) return;
      var now = camera(s.clock);
      var v = 0;
      if (s.cur && s.mode === 'full') {
        var back = camera(s.clock - 10);
        v = (Math.log(now.scale) - Math.log(back.scale)) / 10;
      }
      var base = {};
      var current = intensities();
      for (var i = 0; i < FIRES.length; i++) base[FIRES[i]] = current[FIRES[i]].i;
      var viewNow = viewName();
      s.terminal = { kind: kind, station: stationNow(), cap: s.cur ? stationScale(ANIMS[s.cur.i].cam[3]) : now.scale, at: s.mode === 'static' ? s.clock - 5000 : s.clock, view: viewNow, v: s.mode === 'static' ? 0 : v, from: { scale: now.scale, blend: now.blend, fires: base } };
      s.cur = null;
      s.pending = null;
    }

    function statusKey(now) {
      if (s.terminal) return TARGET_ID[s.terminal.kind];
      if (s.opening) return 'gateOpening';
      if (s.level >= 3) {
        if (!sealVisible()) return 'gateArriving';
        return s.warnAt !== null && now >= s.warnAt ? 'gateLastMinute' : 'gateReady';
      }
      if (s.fails >= 3) return 'gateUnstable';
      if (s.levelSince !== null && now - s.levelSince > 60000) return 'gateSlow';
      return ['gateChecking', 'gateAccepted', 'gateInviting'][s.level];
    }

    var api = {
      /** Visual time only moves in steps of at most 100 ms, so a hidden tab resumes where it stopped. */
      tick: function (now) {
        if (s.startedAt === null) { s.startedAt = now; s.last = now; }
        var dt = now - s.last;
        s.last = now;
        s.clock += dt < 0 ? 0 : dt > 100 ? 100 : dt;
        if (s.mode === 'full' && !s.assets && s.firstAt !== null && now - s.firstAt > 4000) s.mode = 'static';
        if (!s.terminal && !s.opening) {
          if (s.level < 3 && now - s.startedAt > limitMs) end('timeout');
          else if (s.level >= 3 && s.deadlineAt !== null && now >= s.deadlineAt) end('sealExpired');
        }
        advance();
        return api.snapshot(now);
      },
      snapshot: function (now) {
        var visible = sealVisible();
        return {
          real: s.real,
          level: s.level,
          terminal: s.terminal ? s.terminal.kind : null,
          opening: s.opening,
          view: viewName(),
          station: stationNow(),
          anim: s.cur ? ANIMS[s.cur.i].name : null,
          animTime: s.cur ? s.clock - s.cur.start : 0,
          status: statusKey(now),
          seal: visible,
          skip: s.level >= 3 && !visible && !s.terminal && !s.opening && s.mode === 'full' && !s.skipped,
          mode: s.mode,
          // Language links only once the run ended without a usable join link: a reload would lose it.
          langLinks: !!s.terminal,
          scene: scene(),
          clock: s.clock,
          terminalAge: s.terminal ? s.clock - s.terminal.at : -1,
          deadlineAt: s.deadlineAt
        };
      },
      setAssetsReady: function () { s.assets = true; },
      /** Canvas missing or the composition images failed: the still / image-only path. */
      setStatic: function () { s.mode = 'static'; },
      /** An answer arrived. 'others' is the number of requests still in flight. */
      onResponse: function (r, now, others) {
        if (s.terminal || s.opening || s.level >= 3) return;
        if (s.firstAt === null && r.kind !== 'error') s.firstAt = now;
        if (r.kind === 'error') { s.fails += 1; return api.onSettled(now, others); }
        s.fails = 0;
        if (r.kind === 'notfound') { s.pending = 'lost'; return api.onSettled(now, others); }
        if (r.kind === 'handed_off') { s.pending = 'handedOff'; return api.onSettled(now, others); }
        if (r.kind === 'failed' || r.kind === 'badjoin') return end('failed');
        var level = r.kind === 'ready' ? 3 : r.kind === 'inviting' ? 2 : 1;
        if (level <= s.level) return api.onSettled(now, others);
        s.level = level;
        s.real = level === 3 ? 'ready' : level === 2 ? 'inviting' : 'provisioning';
        s.levelSince = now;
        s.pending = null;
        if (level === 3) {
          var seconds = pressWindow(r.expiresIn);
          s.readyAt = now;
          s.deadlineAt = now + seconds * 1000;
          s.warnAt = s.deadlineAt - 60000;
          if (seconds < 90 && s.mode === 'full') api.skip(now);
        }
        if (s.mode === 'static') advance();
      },
      /** A request finished; a handed_off / 404 only counts once nothing else is still in flight. */
      onSettled: function (now, others) {
        if (s.pending && others === 0 && !s.terminal && s.level < 3) end(s.pending);
      },
      /** The 'go to the gate' button: only after a real ready, only before the seal shows. */
      skip: function () {
        if (s.level < 3 || s.terminal || s.opening || s.skipped || sealVisible() || s.mode !== 'full') return false;
        var from = camera(s.clock);
        s.skip = { at: s.clock, scale: from.scale, blend: from.blend };
        s.skipped = true;
        s.cur = null;
        s.finished = 3;
        lightsFor(3, s.clock);
        return true;
      },
      /** The deadline is checked at 'now' itself: a click can arrive before the next tick. */
      press: function (now) {
        if (!s.terminal && !s.opening && s.deadlineAt !== null && typeof now === 'number' && now >= s.deadlineAt) {
          end('sealExpired');
          return false;
        }
        if (!sealVisible()) return false;
        s.opening = true;
        s.real = 'opening';
        return true;
      },
      terminate: function (kind) { end(kind); },
      isDone: function () { return !!s.terminal || s.opening || s.level >= 3; }
    };
    return api;
  }

  return { create: create, isJoinTarget: isJoinTarget, pressWindow: pressWindow, ignite: ignite, FIRES: FIRES, ANIMS: ANIMS };
})();
`;
