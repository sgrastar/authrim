import assert from 'node:assert/strict';
import test from 'node:test';
import { pollD1Import, DEFAULT_IMPORT_POLL_TIMEOUT_MS } from './d1-import-poller.mjs';

const bookmark = 'test-import-bookmark';
const running = { status: 'active', success: true, at_bookmark: bookmark, messages: [] };
const complete = {
  status: 'complete',
  success: true,
  at_bookmark: bookmark,
  result: { final_bookmark: 'committed' },
};

test('a complete cached-init result needs no poll and preserves the final commit evidence', async () => {
  const checkpoints = [];
  const result = await pollD1Import({
    initial: complete,
    poll() {
      assert.fail('already complete');
    },
    onCheckpoint(value) {
      checkpoints.push(value);
    },
  });
  assert.equal(result.response, complete);
  assert.equal(result.stats.polls, 0);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].terminal, true);
});

test('polls serially with the unchanged import bookmark and the default five-second deadline', async () => {
  const calls = [];
  const checkpoints = [];
  const result = await pollD1Import({
    initial: running,
    async poll(options) {
      assert.equal(options.currentBookmark, bookmark);
      assert.equal(options.timeoutMs, DEFAULT_IMPORT_POLL_TIMEOUT_MS);
      assert.equal(options.signal.aborted, false);
      calls.push(options);
      return calls.length === 1 ? { ...running, messages: ['progress'] } : complete;
    },
    onCheckpoint(checkpoint) {
      checkpoints.push(checkpoint);
    },
  });
  assert.equal(result.response, complete);
  assert.equal(result.stats.polls, 2);
  assert.equal(result.stats.successfulPolls, 2);
  assert.equal(checkpoints.at(-1).terminal, true);
  assert.equal(checkpoints.at(-1).response.result.final_bookmark, 'committed');
});

test('a slow request is aborted before retrying the same bookmark without a concurrent live request', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const events = [];
  const result = await pollD1Import({
    initial: running,
    timeoutMs: 10,
    retryDelayMs: 0,
    poll({ signal, currentBookmark }) {
      assert.equal(currentBookmark, bookmark);
      calls++;
      if (calls === 2) return Promise.resolve(complete);
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            active--;
            reject(signal.reason);
          },
          { once: true }
        );
      });
    },
    onEvent(event) {
      events.push(event);
    },
  });
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(result.stats.timeouts, 1);
  assert.equal(events[0].errorName, 'TimeoutError');
});

test('network and retryable HTTP failures retry briefly and redact URLs and bearer values', async () => {
  let calls = 0;
  const events = [];
  const result = await pollD1Import({
    initial: running,
    retryDelayMs: 0,
    async poll() {
      calls++;
      if (calls === 1)
        throw new TypeError('fetch https://private.invalid/?signature=secret Bearer credential');
      if (calls === 2) throw Object.assign(new Error('upstream busy'), { status: 503 });
      return complete;
    },
    onEvent(event) {
      events.push(event);
    },
  });
  assert.equal(result.stats.transientErrors, 2);
  assert.equal(JSON.stringify(events).includes('signature=secret'), false);
  assert.equal(JSON.stringify(events).includes('Bearer credential'), false);
});

test('terminal D1 cancellation fails immediately and never restarts ingestion', async () => {
  let polls = 0;
  await assert.rejects(
    pollD1Import({
      initial: running,
      async poll() {
        polls++;
        return {
          status: 'error',
          error:
            'Cancelled due to no poll() received in 15000ms. https://private.invalid/?token=secret',
          at_bookmark: bookmark,
        };
      },
    }),
    (error) => {
      assert.equal(error.code, 'D1_IMPORT_FAILED');
      assert.match(error.message, /15000ms/);
      assert.equal(error.message.includes('token=secret'), false);
      return true;
    }
  );
  assert.equal(polls, 1);
});

test('invalid, missing, and changed import bookmarks do not follow a different import', async () => {
  for (const [initial, code] of [
    [null, 'D1_IMPORT_INVALID_RESPONSE'],
    [{ status: 'active' }, 'D1_IMPORT_MISSING_BOOKMARK'],
  ]) {
    await assert.rejects(
      pollD1Import({
        initial,
        poll() {
          assert.fail('invalid initial state');
        },
      }),
      { code }
    );
  }
  await assert.rejects(
    pollD1Import({
      initial: running,
      async poll() {
        return { ...running, at_bookmark: 'another-import' };
      },
    }),
    { code: 'D1_IMPORT_BOOKMARK_CHANGED' }
  );
});

test('auth errors and retry limits stop with structured errors', async () => {
  let calls = 0;
  await assert.rejects(
    pollD1Import({
      initial: running,
      async poll() {
        calls++;
        throw Object.assign(new Error('unauthorized'), { status: 401 });
      },
    }),
    { code: 'D1_IMPORT_POLL_REQUEST_FAILED' }
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    pollD1Import({
      initial: running,
      maxConsecutiveErrors: 2,
      retryDelayMs: 0,
      async poll() {
        calls++;
        throw new TypeError('offline');
      },
    }),
    { code: 'D1_IMPORT_POLL_RETRY_LIMIT' }
  );
  assert.equal(calls, 2);
});

test('poll count and elapsed-time bounds prevent unlimited work', async () => {
  let calls = 0;
  await assert.rejects(
    pollD1Import({
      initial: running,
      maxPolls: 2,
      async poll() {
        calls++;
        return running;
      },
    }),
    { code: 'D1_IMPORT_POLL_LIMIT' }
  );
  assert.equal(calls, 2);
  let time = 0;
  await assert.rejects(
    pollD1Import({
      initial: running,
      maxElapsedMs: 10,
      now() {
        return time;
      },
      async poll() {
        time += 11;
        return running;
      },
    }),
    { code: 'D1_IMPORT_POLL_LIMIT' }
  );
});

test('an explicit caller abort cancels the current request and prevents retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    pollD1Import({
      initial: running,
      signal: controller.signal,
      poll({ signal }) {
        calls++;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          controller.abort(new Error('operator stopped'));
        });
      },
    }),
    /operator stopped/
  );
  assert.equal(calls, 1);
});
