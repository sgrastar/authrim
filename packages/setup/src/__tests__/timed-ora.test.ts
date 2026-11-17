import { describe, expect, it, vi } from 'vitest';

const spinner = vi.hoisted(() => {
  class FakeSpinner {
    #text = '';
    constructor(text: string) {
      this.#text = text;
    }
    get text() {
      return this.#text;
    }
    set text(value: string) {
      this.#text = value;
    }
    start = vi.fn(function (this: FakeSpinner, text?: string) {
      if (text) this.text = text;
      return this;
    });
    succeed = vi.fn(function (this: FakeSpinner) {
      return this.stopAndPersist();
    });
    fail = vi.fn(function (this: FakeSpinner) {
      return this.stopAndPersist();
    });
    warn = vi.fn(function (this: FakeSpinner) {
      return this.stopAndPersist();
    });
    stopAndPersist = vi.fn(function (this: FakeSpinner) {
      return this;
    });
    render() {
      return this.#text;
    }
  }
  return { FakeSpinner };
});

vi.mock('ora', () => ({
  default: vi.fn(
    (options?: string | { text?: string }) =>
      new spinner.FakeSpinner(typeof options === 'string' ? options : (options?.text ?? ''))
  ),
}));

import ora from '../cli/timed-ora.js';
import { PhaseTimingRecorder, startPhaseTimings } from '../core/phase-timings.js';

function timed() {
  const lines: string[] = [];
  const { recorder, finish } = startPhaseTimings({
    command: 'update',
    env: null,
    write: (line) => lines.push(line),
  });
  return { recorder: recorder as PhaseTimingRecorder, finish };
}

describe('timed ora', () => {
  it('times each spinner from start to its end, by its text', () => {
    const { recorder, finish } = timed();
    const one = ora('Building packages...');
    expect(one.start()).toBe(one);
    one.text = 'Building packages... 3/5';
    expect(one.text).toBe('Building packages... 3/5');
    one.succeed('Built');
    const two = ora({ text: 'ignored' }).start('Verifying Worker deployments...');
    two.fail('nope');
    const three = ora('Publishing presets...').start();
    three.warn('later');
    three.start('Publishing presets again...');
    const phases = recorder.report().phases;
    finish(0);
    expect(phases.map((phase) => [phase.name, phase.outcome])).toEqual([
      ['Building packages', 'ok'],
      ['Verifying Worker deployments', 'failed'],
      ['Publishing presets', 'warning'],
      ['Publishing presets again', 'unfinished'],
    ]);
  });

  it('leaves the spinner itself as it was and works with no timing running', () => {
    const spin = ora('Checking prerequisites...');
    spin.start();
    spin.succeed();
    const target = (spin as unknown as { render: () => string }).render();
    expect(target).toBe('Checking prerequisites...');
  });
});
