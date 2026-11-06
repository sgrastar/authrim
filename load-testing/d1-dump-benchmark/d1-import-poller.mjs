// Keep an already-started D1 import alive. This module never initializes or ingests a file.
// The poll callback must honor signal, including before beginning its HTTP request.
export const DEFAULT_IMPORT_POLL_TIMEOUT_MS = 5000;

export function sanitizeImportError(value) {
  return String(value?.message ?? value)
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
}

export class D1ImportPollingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'D1ImportPollingError';
    this.code = code;
    Object.assign(this, details);
  }
}

function transient(error) {
  return (
    [408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(error?.status) ||
    ['TimeoutError', 'AbortError', 'TypeError'].includes(error?.name)
  );
}

async function requestWithDeadline(poll, currentBookmark, timeoutMs, outerSignal) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => {
        const reason =
          outerSignal.reason ?? new DOMException('Import polling was aborted', 'AbortError');
        controller.abort(reason);
        reject(reason);
      };
      if (outerSignal?.aborted) {
        onAbort();
        return;
      }
      outerSignal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        const error = new DOMException(
          'D1 import poll exceeded its request deadline',
          'TimeoutError'
        );
        controller.abort(error);
        reject(error);
      }, timeoutMs);
      // Rejections after a deadline are handled here too; stale responses are never accepted.
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return poll({ currentBookmark, signal: controller.signal, timeoutMs });
        })
        .then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onAbort);
  }
}

async function pause(ms, signal) {
  if (ms === 0) return;
  await new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Import polling was aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
  });
}

export async function pollD1Import({
  initial,
  poll,
  onCheckpoint = () => {},
  onEvent = () => {},
  timeoutMs = DEFAULT_IMPORT_POLL_TIMEOUT_MS,
  maxElapsedMs = 4 * 60 * 60 * 1000,
  maxConsecutiveErrors = 12,
  maxPolls = 100000,
  retryDelayMs = 100,
  signal,
  now = () => performance.now(),
}) {
  for (const [name, value] of Object.entries({
    timeoutMs,
    maxElapsedMs,
    maxConsecutiveErrors,
    maxPolls,
  })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new TypeError(`${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1000) {
    throw new TypeError('retryDelayMs must be an integer from 0 to 1000');
  }
  if (typeof poll !== 'function') throw new TypeError('poll must be a function');
  const started = now();
  const stats = { polls: 0, successfulPolls: 0, transientErrors: 0, timeouts: 0 };
  let response = initial;
  let currentBookmark;
  let consecutiveErrors = 0;
  const snapshot = () => ({ ...stats, elapsedMs: now() - started });
  for (;;) {
    signal?.throwIfAborted();
    if (!response || typeof response !== 'object') {
      throw new D1ImportPollingError(
        'D1_IMPORT_INVALID_RESPONSE',
        'D1 import returned an invalid response',
        { stats: snapshot() }
      );
    }
    if (response.success === false || response.status === 'error') {
      await onCheckpoint({ response, currentBookmark, stats: snapshot(), terminal: true });
      throw new D1ImportPollingError(
        'D1_IMPORT_FAILED',
        `D1 import error: ${sanitizeImportError(response.error ?? response.errors ?? 'Import failed')}`,
        { stats: snapshot(), currentBookmark }
      );
    }
    if (response.status === 'complete') {
      await onCheckpoint({ response, currentBookmark, stats: snapshot(), terminal: true });
      return { response, stats: snapshot() };
    }
    if (typeof response.at_bookmark !== 'string' || !response.at_bookmark.trim()) {
      throw new D1ImportPollingError(
        'D1_IMPORT_MISSING_BOOKMARK',
        'Running D1 import has no bookmark',
        { stats: snapshot() }
      );
    }
    if (currentBookmark === undefined) currentBookmark = response.at_bookmark;
    else if (response.at_bookmark !== currentBookmark) {
      throw new D1ImportPollingError(
        'D1_IMPORT_BOOKMARK_CHANGED',
        'D1 import bookmark changed unexpectedly',
        { stats: snapshot() }
      );
    }
    await onCheckpoint({ response, currentBookmark, stats: snapshot(), terminal: false });
    for (;;) {
      signal?.throwIfAborted();
      const remainingMs = maxElapsedMs - (now() - started);
      if (remainingMs <= 0 || stats.polls >= maxPolls) {
        throw new D1ImportPollingError(
          'D1_IMPORT_POLL_LIMIT',
          'D1 import exceeded its polling limit',
          { stats: snapshot(), currentBookmark }
        );
      }
      stats.polls++;
      const attemptStartedAtMs = Date.now();
      try {
        response = await requestWithDeadline(
          poll,
          currentBookmark,
          Math.min(timeoutMs, Math.max(1, Math.ceil(remainingMs))),
          signal
        );
        stats.successfulPolls++;
        consecutiveErrors = 0;
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (!transient(error)) {
          throw new D1ImportPollingError(
            'D1_IMPORT_POLL_REQUEST_FAILED',
            `D1 import polling failed: ${sanitizeImportError(error)}`,
            { stats: snapshot(), currentBookmark }
          );
        }
        consecutiveErrors++;
        stats.transientErrors++;
        if (error.name === 'TimeoutError') stats.timeouts++;
        await onEvent({
          type: 'poll-retry',
          error: sanitizeImportError(error),
          errorName: error.name,
          attemptStartedAtMs,
          attemptFinishedAtMs: Date.now(),
          consecutiveErrors,
          currentBookmark,
          stats: snapshot(),
        });
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new D1ImportPollingError(
            'D1_IMPORT_POLL_RETRY_LIMIT',
            'D1 import polling exhausted consecutive request retries',
            { stats: snapshot(), currentBookmark }
          );
        }
        await pause(retryDelayMs, signal);
      }
    }
  }
}
