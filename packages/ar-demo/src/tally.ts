import { logError } from './log';
import * as registry from './registry';
import type { Deps, Env } from './types';

/** The two numbers of the start page. */
export interface Tally {
  /** Rows that take a place under the capacity limit: the same count the start decision uses. */
  active: number;
  /** Creations the Admin API accepted, since the counter exists. */
  created: number;
}

/**
 * The start page is public and uncached, so the numbers are read at most once per interval and
 * isolate: a flood of page views costs the database nothing extra.
 */
export const TALLY_TTL_MS = 60_000;
/** After a failed read the page goes without fresh numbers for a while instead of asking again. */
export const TALLY_RETRY_MS = 15_000;
/** The longest the page itself waits for the numbers; a slower read finishes behind it. */
export const TALLY_WAIT_MS = 400;
/** A read that has not ended after this long is given up: a later request may start another. */
export const TALLY_ABANDON_MS = 30_000;

let cached: { value: Tally; until: number } | null = null;
let failedUntil = 0;
/** The read in flight. Only the newest one may write its result. */
let refresh: { id: number; startedAt: number } | null = null;
let generation = 0;

export function resetTallyCache(): void {
  cached = null;
  failedUntil = 0;
  refresh = null;
  generation += 1;
}

/**
 * Never throws and never holds the page for longer than TALLY_WAIT_MS: null means "show no
 * numbers". One request at a time reads; the others, and the reader itself once it has waited long
 * enough, take the previous value. No promise is shared between requests. The intervals are counted
 * from the END of a read.
 */
export async function readTally(
  env: Env,
  deps: Deps,
  keepAlive?: (work: Promise<unknown>) => void
): Promise<Tally | null> {
  const now = deps.now();
  if (cached && now < cached.until) return cached.value;
  const stale = cached?.value ?? null;
  if (now < failedUntil) return stale;
  if (refresh && now - refresh.startedAt < TALLY_ABANDON_MS) return stale;

  generation += 1;
  const id = generation;
  refresh = { id, startedAt: now };
  const read = registry
    .readTally(env.DB)
    .then(
      (value): Tally | null => {
        if (generation === id) cached = { value, until: deps.now() + TALLY_TTL_MS };
        return value;
      },
      (): Tally | null => {
        if (generation === id) failedUntil = deps.now() + TALLY_RETRY_MS;
        logError('tally_read_failed');
        return stale;
      }
    )
    .finally(() => {
      if (refresh?.id === id) refresh = null;
    });

  // The page may be answered before the read ends: the platform is asked to let it finish, so its
  // result still serves the next visitor. It never rejects.
  keepAlive?.(read);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<Tally | null>((resolve) => {
    timer = setTimeout(() => resolve(stale), TALLY_WAIT_MS);
  });
  try {
    return await Promise.race([read, waited]);
  } finally {
    clearTimeout(timer);
  }
}
