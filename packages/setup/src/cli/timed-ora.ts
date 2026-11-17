/**
 * `ora`, with each spinner timed as one step of the running command (see
 * `core/phase-timings.ts`): from `start()` to `succeed()` / `fail()` / `warn()` / `info()` /
 * `stop()`. A spinner started again after it stopped is another step.
 */
import realOra, { type Ora, type Options } from 'ora';
import { beginPhase, type PhaseHandle } from '../core/phase-timings.js';

export type { Ora, Options };

type EndOutcome = 'ok' | 'warning' | 'failed';

const ENDING: Readonly<Record<string, EndOutcome>> = {
  succeed: 'ok',
  fail: 'failed',
  warn: 'warning',
  info: 'ok',
  stop: 'ok',
  stopAndPersist: 'ok',
};

/** The spinner itself is not changed: a view of it times the calls (tests may share one). */
export default function ora(options?: string | Options): Ora {
  const spinner = realOra(options);
  let phase: PhaseHandle | null = null;
  return new Proxy(spinner, {
    set(target, property, value) {
      return Reflect.set(target, property, value);
    },
    get(target, property, receiver) {
      // ora keeps its state in private fields: read and call on the spinner itself.
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (typeof property !== 'string') return (value as () => unknown).bind(target);
      if (property === 'start') {
        return (text?: string) => {
          if (!phase) phase = beginPhase(text ?? target.text ?? '');
          const result = (value as (text?: string) => Ora).call(target, text);
          return result === target ? receiver : result;
        };
      }
      const outcome = ENDING[property];
      if (!outcome) {
        return (...args: unknown[]) => {
          const result = (value as (...args: unknown[]) => unknown).apply(target, args);
          return result === target ? receiver : result;
        };
      }
      return (...args: unknown[]) => {
        // succeed / fail / warn / info end through stopAndPersist: the first one says how.
        phase?.end(outcome);
        phase = null;
        const result = (value as (...args: unknown[]) => Ora).apply(target, args);
        return result === target ? receiver : result;
      };
    },
  });
}
