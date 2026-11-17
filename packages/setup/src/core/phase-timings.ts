/**
 * How long each step of a setup command took (deploy, update, init): every spinner step, the
 * Worker deployment as a whole and each Worker in it, and the UI Workers. Printed when the
 * command ends, whichever way it ends (also after `process.exit`), and appended as one JSON line
 * to `.authrim/<env>/deploy-timings.jsonl` so that runs can be compared.
 *
 * One recorder per process: the commands that use it run one per process.
 */
import { appendFileSync, existsSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export type PhaseOutcome = 'ok' | 'warning' | 'failed' | 'unfinished';

export interface PhaseTiming {
  name: string;
  /** Milliseconds from the start of the command. */
  startMs: number;
  durationMs: number;
  outcome: PhaseOutcome;
}

export interface WorkerTiming {
  component: string;
  durationMs: number;
  /** Null until the deployment's result is known (a command stopped part way leaves it null). */
  success: boolean | null;
}

export interface PhaseTimingReport {
  command: string;
  env: string | null;
  startedAt: string;
  totalMs: number;
  /** Time not inside any timed step (the steps may overlap; this counts their union). */
  untimedMs: number;
  phases: PhaseTiming[];
  workers: WorkerTiming[];
  exitCode: number | null;
}

export interface PhaseHandle {
  end(outcome?: Exclude<PhaseOutcome, 'unfinished'>): void;
}

interface OpenPhase {
  name: string;
  startMs: number;
  durationMs: number | null;
  outcome: PhaseOutcome;
}

const NO_PHASE: PhaseHandle = { end: () => undefined };

/** File the reports are appended to, under `.authrim/<env>/`. */
export const PHASE_TIMINGS_FILE = 'deploy-timings.jsonl';

export class PhaseTimingRecorder {
  readonly startedAt: Date;
  private readonly origin: number;
  private readonly phases: OpenPhase[] = [];
  private readonly workers = new Map<string, WorkerTiming>();
  /** Workers with a step running now: how many, and since when (by this recorder's clock). */
  private readonly runningWorkers = new Map<string, { depth: number; since: number }>();

  constructor(
    readonly command: string,
    public env: string | null,
    private readonly now: () => number = () => performance.now(),
    startedAt = new Date()
  ) {
    this.origin = now();
    this.startedAt = startedAt;
  }

  begin(name: string): PhaseHandle {
    const phase: OpenPhase = {
      name: phaseName(name),
      startMs: this.now() - this.origin,
      durationMs: null,
      outcome: 'unfinished',
    };
    this.phases.push(phase);
    return {
      end: (outcome = 'ok') => {
        if (phase.durationMs !== null) return;
        phase.durationMs = this.now() - this.origin - phase.startMs;
        phase.outcome = outcome;
      },
    };
  }

  /**
   * Adds time to a Worker: its steps are recorded one by one as they end, so a command that
   * stops part way still reports them. The result is said apart (`setWorkerResult`) once known.
   */
  recordWorker(component: string, durationMs: number | undefined, success?: boolean): void {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return;
    const seen = this.workers.get(component);
    this.workers.set(component, {
      component,
      durationMs: (seen?.durationMs ?? 0) + durationMs,
      success: success ?? seen?.success ?? null,
    });
  }

  /**
   * A Worker step starts; its time is added when the last running step of that Worker ends, or
   * up to the report when the command stops first. Nested steps count once.
   */
  beginWorker(component: string): { end: () => void } {
    const running = this.runningWorkers.get(component) ?? { depth: 0, since: this.now() };
    running.depth++;
    this.runningWorkers.set(component, running);
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        running.depth--;
        if (running.depth > 0 || this.runningWorkers.get(component) !== running) return;
        this.runningWorkers.delete(component);
        this.recordWorker(component, this.now() - running.since);
      },
    };
  }

  /** Says how a Worker's deployment ended (its time stays as recorded). */
  setWorkerResult(component: string, success: boolean): void {
    const seen = this.workers.get(component);
    if (seen) seen.success = success;
  }

  /** The Workers' times, with the steps still running counted up to now. */
  private workerTimings(): WorkerTiming[] {
    const workers = new Map(
      [...this.workers].map(([component, worker]) => [component, { ...worker }])
    );
    const now = this.now();
    for (const [component, running] of this.runningWorkers) {
      const seen = workers.get(component);
      workers.set(component, {
        component,
        durationMs: (seen?.durationMs ?? 0) + (now - running.since),
        success: seen?.success ?? null,
      });
    }
    return [...workers.values()];
  }

  report(exitCode: number | null = null): PhaseTimingReport {
    const totalMs = this.now() - this.origin;
    const phases = this.phases.map((phase) => ({
      name: phase.name,
      startMs: phase.startMs,
      durationMs: phase.durationMs ?? totalMs - phase.startMs,
      outcome: phase.outcome,
    }));
    return {
      command: this.command,
      env: this.env,
      startedAt: this.startedAt.toISOString(),
      totalMs,
      untimedMs: Math.max(0, totalMs - unionMs(phases)),
      phases,
      workers: this.workerTimings(),
      exitCode,
    };
  }
}

/** A spinner text as a step name: one line, without the trailing ellipsis. */
function phaseName(text: string): string {
  const line = text.split('\n').find((part) => part.trim().length > 0) ?? '';
  return (
    line
      .trim()
      .replace(/(?:\.{3}|…)$/u, '')
      .trim() || '(unnamed step)'
  );
}

function unionMs(phases: readonly PhaseTiming[]): number {
  const spans = phases
    .map((phase) => [phase.startMs, phase.startMs + phase.durationMs] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const [start, end] of spans) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else if (end > current[1]) {
      current[1] = end;
    }
  }
  if (current) total += current[1] - current[0];
  return total;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, '0')}s`;
}

const OUTCOME_MARK: Record<PhaseOutcome, string> = {
  ok: '',
  warning: ' (warning)',
  failed: ' (failed)',
  unfinished: ' (not finished)',
};

/** The report as lines for the terminal: the steps in order, then the Workers slowest first. */
export function formatPhaseTimingReport(report: PhaseTimingReport): string[] {
  const width = Math.min(
    64,
    Math.max(24, ...report.phases.map((phase) => phase.name.length + 2), 'Workers'.length)
  );
  const row = (label: string, ms: number, mark = '') =>
    `  ${label.padEnd(width)} ${formatDuration(ms).padStart(8)}${mark}`;
  const lines = [
    `━━━ Timings: ${report.command}${report.env ? ` --env ${report.env}` : ''} ━━━`,
    row('Total', report.totalMs),
  ];
  for (const phase of report.phases) {
    lines.push(row(phase.name.slice(0, width), phase.durationMs, OUTCOME_MARK[phase.outcome]));
  }
  lines.push(row('Not inside a timed step', report.untimedMs));
  if (report.workers.length > 0) {
    lines.push('  Workers (slowest first):');
    for (const worker of [...report.workers].sort((a, b) => b.durationMs - a.durationMs)) {
      lines.push(
        `  ${`  ${worker.component}`.padEnd(width)} ${formatDuration(worker.durationMs).padStart(8)}${worker.success === null ? ' (no result)' : worker.success ? '' : ' (failed)'}`
      );
    }
  }
  return lines;
}

let current: PhaseTimingRecorder | null = null;
let currentTarget: { baseDir?: string } = {};
let currentCancel: (() => void) | null = null;

/**
 * Says which environment the running command works on, once the command has resolved it (from
 * `--env`, the config or the folder): the report is saved under `<baseDir>/.authrim/<env>/`.
 */
export function setPhaseTimingTarget(target: { env: string; baseDir?: string }): void {
  if (!current) return;
  current.env = target.env;
  if (target.baseDir) currentTarget.baseDir = target.baseDir;
}

/**
 * Stops timing without a report: the command hands over to something that outlives it (the
 * setup Web UI), whose own work is not one command's steps.
 */
export function cancelPhaseTimings(): void {
  currentCancel?.();
}

/** Begins a timed step of the running command (nothing when no command is being timed). */
export function beginPhase(name: string): PhaseHandle {
  return current ? current.begin(name) : NO_PHASE;
}

/** Times `run` as one step of the running command. */
export async function timePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const phase = beginPhase(name);
  try {
    const result = await run();
    phase.end('ok');
    return result;
  } catch (error) {
    phase.end('failed');
    throw error;
  }
}

export function recordWorkerTiming(
  component: string,
  durationMs: number | undefined,
  success?: boolean
): void {
  current?.recordWorker(component, durationMs, success);
}

const NO_WORKER = { end: () => undefined };

/** A Worker step of the running command (nothing when no command is being timed). */
export function beginWorkerTiming(component: string): { end: () => void } {
  return current ? current.beginWorker(component) : NO_WORKER;
}

export function setWorkerTimingResult(component: string, success: boolean): void {
  current?.setWorkerResult(component, success);
}

export interface PhaseTimingOptions {
  command: string;
  env?: string | null;
  /** Folder whose `.authrim/<env>/` receives the report (default: the working directory). */
  baseDir?: string;
  write?: (line: string) => void;
}

/**
 * Starts timing a command. The report is printed and saved once, when the process exits (a
 * command may end with `process.exit`, so `finally` would not be enough); `finish` does it
 * earlier.
 */
export function startPhaseTimings(options: PhaseTimingOptions): {
  recorder: PhaseTimingRecorder;
  finish: (exitCode?: number | null) => void;
} {
  currentCancel?.();
  const recorder = new PhaseTimingRecorder(options.command, options.env ?? null);
  const target: { baseDir?: string } = { baseDir: options.baseDir };
  current = recorder;
  currentTarget = target;
  // Written at once, also from the exit handler (where an asynchronous write may be lost).
  const write = options.write ?? ((line: string) => writeSync(1, `${line}\n`));
  let finished = false;
  const release = () => {
    finished = true;
    process.off('exit', onExit);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (current === recorder) {
      current = null;
      currentCancel = null;
    }
  };
  const finish = (exitCode: number | null = null) => {
    if (finished) return;
    release();
    const report = recorder.report(exitCode);
    // Timings never change how a command ends: printing and saving each fail on their own.
    let saved: string | null = null;
    try {
      saved = saveReport(report, target.baseDir ?? process.cwd());
    } catch {
      saved = null;
    }
    try {
      write('');
      for (const line of formatPhaseTimingReport(report)) write(line);
      if (saved) write(`  Saved to ${saved}`);
    } catch {
      // The terminal or pipe is gone; the saved report stays.
    }
  };
  const onExit = (code: number) => finish(code);
  process.on('exit', onExit);
  // A signal that ends the process skips 'exit': report, then end as the signal would have
  // (when nothing else handles it; a handler that does, such as the Web UI's, keeps its say).
  // One listener per signal: a caller may emit it without the name (ora's stdin handling does).
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    finish(128 + (signal === 'SIGINT' ? 2 : 15));
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  currentCancel = () => {
    if (!finished) release();
  };
  return { recorder, finish };
}

function saveReport(report: PhaseTimingReport, baseDir: string): string | null {
  // An environment name is a folder name; anything else is not written anywhere.
  if (!report.env || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(report.env)) return null;
  const dir = join(baseDir, '.authrim', report.env);
  if (!existsSync(dir)) return null;
  const file = join(dir, PHASE_TIMINGS_FILE);
  appendFileSync(file, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  return file;
}
