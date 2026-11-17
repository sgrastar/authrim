import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginPhase,
  formatDuration,
  formatPhaseTimingReport,
  PHASE_TIMINGS_FILE,
  cancelPhaseTimings,
  PhaseTimingRecorder,
  recordWorkerTiming,
  setPhaseTimingTarget,
  startPhaseTimings,
  timePhase,
} from '../core/phase-timings.js';

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('PhaseTimingRecorder', () => {
  it('records steps, their outcome, the workers and the time outside any step', () => {
    const time = clock(1000);
    const recorder = new PhaseTimingRecorder('update', 'test', time.now);
    time.advance(500);
    const build = recorder.begin('Building packages...');
    time.advance(4000);
    build.end('ok');
    const deploy = recorder.begin('Deploying API Workers');
    const verify = recorder.begin('Verifying\nmore');
    time.advance(1000);
    verify.end('warning');
    time.advance(2000);
    deploy.end('failed');
    deploy.end('ok');
    recorder.recordWorker('ar-auth', 1500, true);
    recorder.recordWorker('ar-token', Number.NaN, true);
    time.advance(500);
    const open = recorder.begin('Deploying ar-login-ui');
    time.advance(250);

    const report = recorder.report(1);
    expect(report.totalMs).toBe(8250);
    expect(report.phases).toEqual([
      { name: 'Building packages', startMs: 500, durationMs: 4000, outcome: 'ok' },
      { name: 'Deploying API Workers', startMs: 4500, durationMs: 3000, outcome: 'failed' },
      { name: 'Verifying', startMs: 4500, durationMs: 1000, outcome: 'warning' },
      { name: 'Deploying ar-login-ui', startMs: 8000, durationMs: 250, outcome: 'unfinished' },
    ]);
    // 500 before the build and 500 between the Workers and the UI.
    expect(report.untimedMs).toBe(1000);
    expect(report.workers).toEqual([{ component: 'ar-auth', durationMs: 1500, success: true }]);
    expect(report.exitCode).toBe(1);
    open.end();
  });

  it('adds the steps of a Worker as they end and says its result only once known', () => {
    const recorder = new PhaseTimingRecorder('update', 'test', clock().now);
    recorder.recordWorker('ar-auth', 1000);
    recorder.recordWorker('ar-auth', 500);
    recorder.recordWorker('ar-vc', 200);
    recorder.setWorkerResult('ar-vc', false);
    recorder.recordWorker('ar-vc', 100);
    recorder.recordWorker('ar-token', 50);
    recorder.setWorkerResult('ar-token', true);
    recorder.setWorkerResult('ar-absent', false);
    const report = recorder.report();
    expect(report.workers).toEqual([
      { component: 'ar-auth', durationMs: 1500, success: null },
      { component: 'ar-vc', durationMs: 300, success: false },
      { component: 'ar-token', durationMs: 50, success: true },
    ]);
    expect(formatPhaseTimingReport(report).join('\n')).toMatch(/ar-auth\s+1\.5s \(no result\)/u);
  });

  it('counts a running Worker step up to the report, and nested steps once', () => {
    const time = clock();
    const recorder = new PhaseTimingRecorder('update', 'test', time.now);
    const outer = recorder.begin('Deploying API Workers');
    const upload = recorder.beginWorker('ar-auth');
    time.advance(1000);
    const nested = recorder.beginWorker('ar-auth');
    time.advance(500);
    nested.end();
    nested.end();
    time.advance(500);
    upload.end();
    const stuck = recorder.beginWorker('ar-vc');
    time.advance(3000);
    // The command stops here: ar-vc is still uploading.
    expect(recorder.report().workers).toEqual([
      { component: 'ar-auth', durationMs: 2000, success: null },
      { component: 'ar-vc', durationMs: 3000, success: null },
    ]);
    stuck.end();
    outer.end();
    expect(recorder.report().workers.find((w) => w.component === 'ar-vc')?.durationMs).toBe(3000);
  });

  it('formats durations and the report', () => {
    expect(formatDuration(42)).toBe('42ms');
    expect(formatDuration(12_345)).toBe('12.3s');
    expect(formatDuration(125_000)).toBe('2m 05s');

    const time = clock();
    const recorder = new PhaseTimingRecorder('deploy', 'demo', time.now);
    const step = recorder.begin('Checking prerequisites...');
    time.advance(2000);
    step.end();
    recorder.recordWorker('ar-auth', 3000, true);
    recorder.recordWorker('ar-router', 9000, false);
    const lines = formatPhaseTimingReport(recorder.report(0));
    expect(lines[0]).toBe('━━━ Timings: deploy --env demo ━━━');
    expect(lines.join('\n')).toContain('Checking prerequisites');
    const workers = lines.slice(lines.indexOf('  Workers (slowest first):') + 1);
    expect(workers[0]).toMatch(/ar-router\s+9\.0s \(failed\)$/u);
    expect(workers[1]).toMatch(/ar-auth\s+3\.0s$/u);
  });
});

describe('startPhaseTimings', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('prints once, saves one JSON line under .authrim/<env>, and stops timing', async () => {
    const base = mkdtempSync(join(tmpdir(), 'phase-timings-'));
    dirs.push(base);
    mkdirSync(join(base, '.authrim', 'test'), { recursive: true });
    const lines: string[] = [];
    const { finish } = startPhaseTimings({
      command: 'update',
      env: 'test',
      baseDir: base,
      write: (line) => lines.push(line),
    });
    await timePhase('Building packages...', async () => undefined);
    await expect(
      timePhase('Applying schema', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    recordWorkerTiming('ar-auth', 10, true);
    finish(0);
    finish(1);

    const file = join(base, '.authrim', 'test', PHASE_TIMINGS_FILE);
    const saved = readFileSync(file, 'utf8').trim().split('\n');
    expect(saved).toHaveLength(1);
    const report = JSON.parse(saved[0]);
    expect(report.command).toBe('update');
    expect(report.exitCode).toBe(0);
    expect(
      report.phases.map((phase: { name: string; outcome: string }) => [phase.name, phase.outcome])
    ).toEqual([
      ['Building packages', 'ok'],
      ['Applying schema', 'failed'],
    ]);
    expect(report.workers).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('━━━ Timings'))).toHaveLength(1);
    expect(lines.at(-1)).toBe(`  Saved to ${file}`);

    // After finish nothing is timed.
    const after = beginPhase('later');
    after.end();
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('prints at process exit when the command ends with process.exit', () => {
    const lines: string[] = [];
    const before = process.listenerCount('exit');
    startPhaseTimings({ command: 'deploy', env: null, write: (line) => lines.push(line) });
    expect(process.listenerCount('exit')).toBe(before + 1);
    process.emit('exit', 3);
    expect(process.listenerCount('exit')).toBe(before);
    expect(lines.some((line) => line.startsWith('━━━ Timings: deploy'))).toBe(true);
  });

  it('writes nothing for a missing environment folder or an environment that is not a name', () => {
    const base = mkdtempSync(join(tmpdir(), 'phase-timings-'));
    dirs.push(base);
    mkdirSync(join(base, '.authrim'), { recursive: true });
    for (const env of ['absent', '../escape', '.']) {
      const lines: string[] = [];
      startPhaseTimings({
        command: 'update',
        env,
        baseDir: base,
        write: (line) => lines.push(line),
      }).finish(0);
      expect(lines.some((line) => line.includes('Saved to'))).toBe(false);
    }
    expect(existsSync(join(base, 'escape'))).toBe(false);
  });

  it('reports on SIGINT and leaves the signal to a handler that takes it', () => {
    const lines: string[] = [];
    const other = vi.fn();
    process.on('SIGINT', other);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      startPhaseTimings({ command: 'update', env: null, write: (line) => lines.push(line) });
      // Emitted without the signal name, as ora's stdin handling does on Ctrl+C.
      (process.emit as (event: string) => boolean)('SIGINT');
      expect(lines.some((line) => line.startsWith('━━━ Timings: update'))).toBe(true);
      expect(other).toHaveBeenCalledOnce();
      // Another handler takes the signal: it is not raised again.
      expect(kill).not.toHaveBeenCalled();
    } finally {
      process.off('SIGINT', other);
      kill.mockRestore();
    }
  });

  it('ends the process as the signal would when nothing else handles it', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const before = process.listenerCount('SIGTERM');
    try {
      const lines: string[] = [];
      startPhaseTimings({ command: 'deploy', env: null, write: (line) => lines.push(line) });
      process.emit('SIGTERM', 'SIGTERM');
      expect(lines).toContain('━━━ Timings: deploy ━━━');
      expect(process.listenerCount('SIGTERM')).toBe(before);
      if (before === 0) expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('saves the report even when printing fails, and never throws', () => {
    const base = mkdtempSync(join(tmpdir(), 'phase-timings-'));
    dirs.push(base);
    mkdirSync(join(base, '.authrim', 'test'), { recursive: true });
    const write = vi.fn(() => {
      throw new Error('EPIPE');
    });
    const { finish } = startPhaseTimings({ command: 'update', env: 'test', baseDir: base, write });
    expect(() => finish(0)).not.toThrow();
    expect(existsSync(join(base, '.authrim', 'test', PHASE_TIMINGS_FILE))).toBe(true);
  });

  it('saves under the environment and folder the command resolved', () => {
    const base = mkdtempSync(join(tmpdir(), 'phase-timings-'));
    dirs.push(base);
    mkdirSync(join(base, '.authrim', 'demo'), { recursive: true });
    const lines: string[] = [];
    const { finish } = startPhaseTimings({
      command: 'deploy',
      env: null,
      baseDir: join(base, 'elsewhere'),
      write: (line) => lines.push(line),
    });
    setPhaseTimingTarget({ env: 'demo', baseDir: base });
    finish(0);
    expect(lines[1]).toBe('━━━ Timings: deploy --env demo ━━━');
    expect(existsSync(join(base, '.authrim', 'demo', PHASE_TIMINGS_FILE))).toBe(true);
  });

  it('stops without a report when the command hands over to the Web UI', () => {
    const lines: string[] = [];
    const before = process.listenerCount('exit');
    const { finish } = startPhaseTimings({
      command: 'init',
      env: null,
      write: (line) => lines.push(line),
    });
    cancelPhaseTimings();
    expect(process.listenerCount('exit')).toBe(before);
    const later = beginPhase('Deploying API Workers');
    later.end();
    finish(0);
    expect(lines).toEqual([]);
  });
});
