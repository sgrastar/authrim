/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- evaluates the shipped gate logic source as it is */
import { describe, expect, it } from 'vitest';
import { GATE_LOGIC_JS } from '../gate-logic';
import { compactJs, WAIT_JS } from '../gate-client';

// The very source that is shipped in /assets/wait.js (compacted as shipped), evaluated on its own.
const Gate: any = new Function(`${compactJs(GATE_LOGIC_JS)}; return AuthrimGate;`)();
const SCALES = [1, 1.35, 1.8, 3.6];
const CONSOLE = 'https://console.example';

interface Clock {
  now: number;
}

function make(options: Record<string, unknown> = {}) {
  const logic = Gate.create({ scales: SCALES, ...options });
  const time: Clock = { now: 1_000_000 };
  const api = {
    logic,
    time,
    /** Advance by total ms in 50 ms steps, returning every snapshot. */
    run(total: number, step = 50) {
      const out: any[] = [];
      for (let spent = 0; spent < total; spent += step) {
        time.now += step;
        out.push(logic.tick(time.now));
      }
      return out;
    },
    respond(kind: string, extra: Record<string, unknown> = {}, others = 0) {
      logic.onResponse({ kind, ...extra }, time.now, others);
    },
    snap() {
      return logic.tick(time.now);
    },
  };
  api.logic.tick(time.now);
  api.logic.setAssetsReady();
  return api;
}

describe('pure helpers', () => {
  it('accepts only the console origin plus the join path with the code in the fragment', () => {
    const ok = `${CONSOLE}/admin/join#code=a&email=b`;
    expect(Gate.isJoinTarget(CONSOLE, ok)).toBe(true);
    for (const bad of [
      'https://evil.example/admin/join#code=a',
      `${CONSOLE}.evil.example/admin/join#x`,
      `${CONSOLE}/admin/join`,
      `${CONSOLE}/admin/join?x#y`,
      `${CONSOLE}/other#x`,
      'javascript:alert(1)',
      42,
      undefined,
      null,
    ]) {
      expect(Gate.isJoinTarget(CONSOLE, bad)).toBe(false);
    }
    expect(Gate.isJoinTarget('', ok)).toBe(false);
  });

  it('derives the press window from join_expires_in', () => {
    expect(Gate.pressWindow(600)).toBe(300);
    expect(Gate.pressWindow(330)).toBe(300);
    expect(Gate.pressWindow(120)).toBe(90);
    expect(Gate.pressWindow(100)).toBe(70);
    expect(Gate.pressWindow(20)).toBe(0);
    expect(Gate.pressWindow(undefined)).toBe(300);
    expect(Gate.pressWindow(0)).toBe(300);
    expect(Gate.pressWindow('x')).toBe(300);
  });

  it('is part of the shipped script, unchanged', () => {
    expect(WAIT_JS).toContain(compactJs(GATE_LOGIC_JS));
  });
});

describe('the view never runs ahead of the real state', () => {
  it('stays in the first station while the real state is provisioning', () => {
    const g = make();
    g.respond('provisioning');
    const snaps = g.run(61_000);
    for (const s of snaps) {
      expect(s.seal).toBe(false);
      expect(s.skip).toBe(false);
      expect(['arriving', 'creating']).toContain(s.view);
      expect(s.scene.fires.P3.i).toBe(0);
      expect(s.scene.fires.GB.i).toBe(0);
      expect(s.scene.scale).toBeLessThanOrEqual(SCALES[1] + 1e-9);
    }
    const last = snaps[snaps.length - 1];
    expect(last.view).toBe('creating');
    expect(last.station).toBe(1);
    expect(last.status).toBe('gateSlow'); // honest text after a long wait
    expect(last.scene.scale).toBeCloseTo(SCALES[1], 6);
    expect(last.scene.fires.P1.i).toBeGreaterThan(0.9);
    expect(last.scene.fires.P2.i).toBeGreaterThan(0.9);
  });

  it('stops at the middle station while the real state is inviting: no gate fires, no seal', () => {
    const g = make();
    g.respond('inviting');
    const snaps = g.run(60_000);
    for (const s of snaps) {
      expect(s.seal).toBe(false);
      expect(s.scene.fires.GB.i).toBe(0);
      expect(s.scene.fires.GT.i).toBe(0);
      expect(s.scene.scale).toBeLessThanOrEqual(SCALES[2] + 1e-9);
    }
    const last = snaps[snaps.length - 1];
    expect(last.station).toBe(2);
    expect(last.scene.fires.P5.i).toBeGreaterThan(0.9);
  });

  it('plays every stage in order and in full when the first answer is already ready', () => {
    const g = make();
    g.respond('ready', { expiresIn: 600 });
    const names: string[] = [];
    const sealAt: number[] = [];
    let elapsed = 0;
    for (const s of g.run(14_000)) {
      elapsed += 50;
      if (s.anim && names[names.length - 1] !== s.anim) names.push(s.anim);
      if (s.seal) sealAt.push(elapsed);
      // the real state is ready at once: the status text says so immediately, the seal does not
      expect(s.status).toBe(s.seal ? 'gateReady' : 'gateArriving');
    }
    expect(names).toEqual(['depart', 'middle', 'arrive']);
    // 4200 + 4200 + 3400 ms of forced viewing, +- one tick
    expect(sealAt[0]).toBeGreaterThanOrEqual(11_800);
    expect(sealAt[0]).toBeLessThanOrEqual(11_900);
  });

  it('shows the arrival stage in 3.4 s when ready arrives while waiting in the middle', () => {
    const g = make();
    g.respond('inviting');
    g.run(20_000);
    g.respond('ready', { expiresIn: 600 });
    let elapsed = 0;
    let sealAt = -1;
    for (const s of g.run(5_000)) {
      elapsed += 50;
      if (s.seal && sealAt < 0) sealAt = elapsed;
    }
    expect(sealAt).toBeGreaterThanOrEqual(3_400);
    expect(sealAt).toBeLessThanOrEqual(3_500);
  });

  it('never shows the seal without a real ready, whatever time passes', () => {
    const g = make();
    for (const kind of ['provisioning', 'inviting', 'provisioning']) {
      g.respond(kind);
      for (const s of g.run(30_000, 1000)) expect(s.seal).toBe(false);
    }
  });

  it('ignores stages that go backwards', () => {
    const g = make();
    g.respond('inviting');
    g.respond('provisioning');
    expect(g.snap().real).toBe('inviting');
  });

  it('does not wait for images that never come: after 4 s it shows the real state at once', () => {
    const g = Gate.create({ scales: SCALES });
    let now = 5_000;
    g.tick(now);
    g.onResponse({ kind: 'ready', expiresIn: 600 }, now, 0);
    let snap = g.tick((now += 100));
    expect(snap.seal).toBe(false);
    expect(snap.mode).toBe('full');
    for (let i = 0; i < 50; i++) snap = g.tick((now += 100));
    expect(snap.mode).toBe('static');
    expect(snap.seal).toBe(true);
    expect(snap.status).toBe('gateReady');
  });
});

describe('reduced motion / still mode', () => {
  it('has no queue: the picture follows the real state at once, the seal comes with ready', () => {
    const g = Gate.create({ scales: SCALES, mode: 'static' });
    let now = 1000;
    g.tick(now);
    g.onResponse({ kind: 'provisioning' }, now, 0);
    let snap = g.tick((now += 50));
    expect(snap.view).toBe('creating');
    expect(snap.anim).toBeNull();
    expect(snap.skip).toBe(false);
    expect(snap.scene.fires.P2.i).toBeGreaterThan(0.9);
    expect(snap.scene.fires.P3.i).toBe(0);
    g.onResponse({ kind: 'ready', expiresIn: 600 }, now, 0);
    snap = g.tick((now += 50));
    expect(snap.view).toBe('ready');
    expect(snap.seal).toBe(true);
    expect(snap.skip).toBe(false);
    expect(snap.scene.blend).toBe(1);
    expect(snap.scene.fires.GT.i).toBeGreaterThan(0.9);
    expect(snap.status).toBe('gateReady');
  });

  it('puts the fires out and shows the dark picture at once on failure', () => {
    const g = Gate.create({ scales: SCALES, mode: 'static' });
    let now = 1000;
    g.tick(now);
    g.onResponse({ kind: 'inviting' }, now, 0);
    g.tick((now += 50));
    g.onResponse({ kind: 'failed' }, now, 0);
    const snap = g.tick((now += 50));
    expect(snap.terminal).toBe('failed');
    expect(snap.scene.fires.P3.i).toBe(0);
    expect(snap.scene.fires.P1.i).toBe(0);
  });
});

describe('the press deadline counts from the moment ready was received', () => {
  it('expires pressWindow seconds after ready, not after the seal appeared', () => {
    const g = make();
    g.respond('ready', { expiresIn: 130 }); // window 100 s
    let expiredAt = -1;
    let lastMinuteAt = -1;
    let lastStatus = '';
    g.run(110_000, 100).forEach((s, index) => {
      const at = (index + 1) * 100;
      if (s.status === 'gateLastMinute' && lastMinuteAt < 0) lastMinuteAt = at;
      if (s.terminal === 'sealExpired' && expiredAt < 0) expiredAt = at;
      lastStatus = s.status;
    });
    expect(expiredAt).toBeGreaterThanOrEqual(100_000);
    expect(expiredAt).toBeLessThanOrEqual(100_200);
    // the warning comes 60 s before the deadline and only once the seal is visible (11.8 s)
    expect(lastMinuteAt).toBeGreaterThanOrEqual(40_000);
    expect(lastMinuteAt).toBeLessThanOrEqual(40_200);
    expect(lastStatus).toBe('gateExpired');
  });

  it('skips the show by itself when the window is shorter than 90 s', () => {
    const g = make();
    g.respond('ready', { expiresIn: 100 }); // window 70 s
    const s = g.snap();
    expect(s.seal).toBe(true);
    expect(s.view).toBe('ready');
    expect(s.skip).toBe(false);
    // 70 s window: the one-minute warning is due 10 s after ready, always after the seal
    g.run(9_000);
    expect(g.snap().status).toBe('gateReady');
    g.run(1_500);
    expect(g.snap().status).toBe('gateLastMinute');
    const long = make();
    long.respond('ready', { expiresIn: 120 }); // window exactly 90 s: the show plays
    expect(long.snap().seal).toBe(false);
  });

  it('uses 300 s when join_expires_in is missing and stops the clock once the seal is pressed', () => {
    const g = make();
    g.respond('ready', {});
    g.run(12_000);
    expect(g.snap().seal).toBe(true);
    expect(g.logic.press()).toBe(true);
    g.run(400_000, 1000);
    expect(g.snap().terminal).toBeNull();
    expect(g.snap().status).toBe('gateOpening');
  });

  it('shows a fresh retry state after expiry: seal gone, embers on the last pair, others out', () => {
    const g = make();
    g.respond('ready', { expiresIn: 100 });
    const snaps = g.run(75_000, 100);
    const last = snaps[snaps.length - 1];
    expect(last.terminal).toBe('sealExpired');
    expect(last.seal).toBe(false);
    expect(last.scene.fires.GB.i).toBe(0);
    expect(last.scene.fires.P4.i).toBeCloseTo(0.25, 2);
    expect(last.scene.fires.P1.i).toBe(0);
  });
});

describe('the seal and the skip button', () => {
  it('offers the skip only after a real ready and before the seal; skipping shows the seal at once', () => {
    const g = make();
    g.respond('provisioning');
    expect(g.snap().skip).toBe(false);
    expect(g.logic.skip()).toBe(false); // refused: the state it would skip to is not real
    g.respond('ready', { expiresIn: 600 });
    g.run(500);
    expect(g.snap().skip).toBe(true);
    expect(g.snap().seal).toBe(false);
    expect(g.logic.skip()).toBe(true);
    const after = g.snap();
    expect(after.skip).toBe(false);
    expect(after.seal).toBe(true);
    expect(after.view).toBe('ready');
    // the picture moves to the gate within 400 ms
    const done = g.run(450).pop();
    expect(done.scene.scale).toBeCloseTo(SCALES[3], 3);
    expect(done.scene.blend).toBeCloseTo(1, 3);
  });

  it('does not press without a seal', () => {
    const g = make();
    expect(g.logic.press()).toBe(false);
    g.respond('provisioning');
    expect(g.logic.press()).toBe(false);
    g.respond('ready', { expiresIn: 600 });
    expect(g.logic.press()).toBe(false);
  });
});

describe('failures interrupt at once', () => {
  it('stops the show, cancels fires not yet lit and puts the lit ones out in reverse', () => {
    const g = make();
    g.respond('provisioning');
    g.run(1_100); // depart: P1 lit at 300 ms, P2 at 1000 ms
    const before = g.snap();
    expect(before.anim).toBe('depart');
    expect(before.scene.fires.P1.i).toBeGreaterThan(0.5);
    g.respond('failed');
    const snaps = g.run(2_000);
    const first = snaps[0];
    expect(first.terminal).toBe('failed');
    expect(first.anim).toBeNull();
    expect(first.status).toBe('failed');
    expect(first.skip).toBe(false);
    expect(first.seal).toBe(false);
    for (const s of snaps) {
      // never lights anything new, never queues the next sequence
      expect(s.scene.fires.P3.i).toBe(0);
      expect(s.scene.fires.GB.i).toBe(0);
      expect(s.anim).toBeNull();
      expect(s.scene.scale).toBeLessThanOrEqual(SCALES[1] + 1e-9);
    }
    // P2 was lit last, so it goes out first; everything is dark after 1.2 s + the pair offset
    const mid = snaps[Math.round(600 / 50)];
    expect(mid.scene.fires.P2.i).toBeLessThan(mid.scene.fires.P1.i);
    const end = snaps[snaps.length - 1];
    expect(end.scene.fires.P1.i).toBe(0);
    expect(end.scene.fires.P2.i).toBe(0);
  });

  it('stops the camera where it is and never moves it again', () => {
    const g = make();
    g.respond('inviting');
    g.run(2_000); // middle of the first sequence
    const moving = g.snap().scene.scale;
    g.respond('failed');
    const scales = g.run(3_000).map((s) => s.scene.scale);
    const final = scales[scales.length - 1];
    expect(final).toBeGreaterThanOrEqual(moving - 1e-9);
    expect(final).toBeLessThan(SCALES[1] + 1e-9);
    for (let i = 1; i < scales.length; i++)
      expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1] - 1e-9);
    expect(scales[scales.length - 1]).toBeCloseTo(scales[scales.length - 2], 6);
  });

  it('turns a bad join link into a failure', () => {
    const g = make();
    g.respond('badjoin');
    expect(g.snap().terminal).toBe('failed');
  });

  it('ignores everything after the end, including a late ready', () => {
    const g = make();
    g.respond('failed');
    g.respond('ready', { expiresIn: 600 });
    expect(g.snap().terminal).toBe('failed');
    expect(g.snap().seal).toBe(false);
  });

  it('counts 404 and handed_off only once no other request is in flight', () => {
    const lost = make();
    lost.respond('notfound', {}, 2);
    expect(lost.snap().terminal).toBeNull();
    lost.logic.onSettled(lost.time.now, 1);
    expect(lost.snap().terminal).toBeNull();
    lost.logic.onSettled(lost.time.now, 0);
    expect(lost.snap().terminal).toBe('lost');
    expect(lost.snap().status).toBe('lost');

    const raced = make();
    raced.respond('handed_off', {}, 1); // the request that carries ready is still out
    expect(raced.snap().terminal).toBeNull();
    raced.respond('ready', { expiresIn: 600 }, 0);
    expect(raced.snap().terminal).toBeNull();
    expect(raced.snap().real).toBe('ready');

    const reload = make();
    reload.respond('handed_off', {}, 0);
    expect(reload.snap().terminal).toBe('handedOff');
    expect(reload.snap().status).toBe('handedOff');
  });

  it('times out after the limit as a real end state', () => {
    const g = make({ limitMs: 360_000 });
    g.respond('provisioning');
    const snaps = g.run(365_000, 1000);
    const end = snaps[snaps.length - 1];
    expect(end.terminal).toBe('timeout');
    expect(end.status).toBe('timeout');
    expect(snaps.find((s: any) => s.terminal === 'timeout')).toBeDefined();
    const early = make({ limitMs: 360_000 });
    for (const s of early.run(350_000, 1000)) expect(s.terminal).toBeNull();
  });
});

describe('status text follows the real state, not the picture', () => {
  it('changes on the answer, ahead of the picture', () => {
    const g = make();
    expect(g.snap().status).toBe('gateChecking');
    g.respond('provisioning');
    expect(g.snap().status).toBe('gateAccepted');
    g.respond('inviting');
    expect(g.snap().status).toBe('gateInviting');
    expect(g.snap().view).toBe('creating'); // the picture is still on its way
  });

  it('says the connection is unstable after three failed requests and recovers on the next answer', () => {
    const g = make();
    g.respond('provisioning');
    g.respond('error');
    g.respond('error');
    expect(g.snap().status).toBe('gateAccepted');
    g.respond('error');
    expect(g.snap().status).toBe('gateUnstable');
    g.respond('provisioning');
    expect(g.snap().status).toBe('gateAccepted');
  });
});

describe('a hidden tab does not skip a sequence', () => {
  it('resumes the sequence from where it stopped', () => {
    const g = make();
    g.respond('ready', { expiresIn: 600 });
    g.run(1_000);
    g.time.now += 60_000; // the tab was hidden for a minute
    const s = g.snap();
    expect(s.anim).toBe('depart');
    expect(s.animTime).toBeLessThan(1_200);
    expect(s.seal).toBe(false);
  });
});

describe('press is checked against the current time', () => {
  it('refuses a click after the deadline even when no tick ran, and does not redirect', () => {
    const g = make();
    g.respond('ready', { expiresIn: 130 }); // window 100 s
    g.run(12_000, 100);
    expect(g.snap().seal).toBe(true);
    g.time.now += 200_000; // delayed timer: no tick() in between
    expect(g.logic.press(g.time.now)).toBe(false);
    const s = g.snap();
    expect(s.terminal).toBe('sealExpired');
    expect(s.opening).toBe(false);
    expect(s.status).toBe('gateExpired');
  });

  it('still accepts a press just before the deadline', () => {
    const g = make();
    g.respond('ready', { expiresIn: 130 });
    const readyAt = g.time.now;
    g.run(12_000, 100);
    expect(g.logic.press(readyAt + 99_900)).toBe(true);
    expect(g.snap().opening).toBe(true);
  });
});

describe('language links are offered only after a run without a usable join link', () => {
  it('are not available while polling, while ready is delayed, after ready or while opening', () => {
    const g = make();
    expect(g.snap().langLinks).toBe(false);
    g.respond('provisioning');
    for (const s of g.run(20_000, 100)) expect(s.langLinks).toBe(false);
    g.respond('ready', { expiresIn: 600 });
    for (const s of g.run(15_000, 100)) expect(s.langLinks).toBe(false);
    expect(g.logic.press(g.time.now)).toBe(true);
    expect(g.snap().langLinks).toBe(false);
  });

  it.each(['failed', 'notfound', 'handed_off', 'badjoin'])('appear after %s', (kind) => {
    const g = make();
    g.respond(kind);
    expect(g.snap().langLinks).toBe(true);
  });

  it('appear after a timeout and after the deadline expired', () => {
    const t = make({ limitMs: 10_000 });
    t.respond('provisioning');
    t.run(12_000, 100);
    expect(t.snap().terminal).toBe('timeout');
    expect(t.snap().langLinks).toBe(true);
    const e = make();
    e.respond('ready', { expiresIn: 100 });
    e.run(75_000, 100);
    expect(e.snap().terminal).toBe('sealExpired');
    expect(e.snap().langLinks).toBe(true);
  });
});
