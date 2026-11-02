import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudClient } from './cloud-client.mjs';

async function fakeClient(fetchMock, callback, log = () => {}) {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'test-only-api-token';
  globalThis.fetch = fetchMock;
  try {
    const client = await createCloudClient({ accountId: '0'.repeat(32), runDir: '/tmp', log });
    await callback(client);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = oldToken;
  }
}

const success = () => Response.json({ success: true, result: { status: 'complete' } });

test('an already-aborted API operation never reaches authentication or fetch', async () => {
  const controller = new AbortController();
  controller.abort(new Error('operator stopped'));
  await fakeClient(
    async () => {
      assert.fail('must not fetch');
    },
    async ({ api }) => {
      await assert.rejects(
        api('d1/database/test/import', { signal: controller.signal }),
        /operator stopped/
      );
    }
  );
});

test('a caller signal reaches in-flight fetch and stops without API retries', async () => {
  const controller = new AbortController();
  let calls = 0;
  await fakeClient(
    (_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        setTimeout(() => controller.abort(new Error('poll deadline')), 5);
      });
    },
    async ({ api }) => {
      await assert.rejects(
        api('d1/database/test/import', { method: 'POST', signal: controller.signal, retry: false }),
        /poll deadline/
      );
      assert.equal(calls, 1);
    }
  );
});

test('a caller can abort during API throttling without beginning the next request', async () => {
  let calls = 0;
  await fakeClient(
    async () => {
      calls++;
      return success();
    },
    async ({ api }) => {
      await api('d1/database/test');
      const controller = new AbortController();
      const pending = api('d1/database/test/import', { signal: controller.signal });
      setTimeout(() => controller.abort(new Error('throttle deadline')), 5);
      await assert.rejects(
        pending,
        (error) => error.name === 'AbortError' || error.message === 'throttle deadline'
      );
      assert.equal(calls, 1);
    }
  );
});

test('a caller can abort retry backoff without a delayed retry escaping later', async () => {
  const controller = new AbortController();
  let calls = 0;
  await fakeClient(
    async () => {
      calls++;
      return Response.json({ success: false, errors: [{ message: 'busy' }] }, { status: 503 });
    },
    async ({ api }) => {
      await assert.rejects(
        api('d1/database/test/import', { signal: controller.signal, retry: true }),
        (error) => error.name === 'AbortError' || error.message === 'backoff deadline'
      );
      assert.equal(calls, 1);
    },
    () => controller.abort(new Error('backoff deadline'))
  );
});

test('a caller can abort waiting for a response body', async () => {
  const controller = new AbortController();
  await fakeClient(
    async () => {
      setTimeout(() => controller.abort(new Error('body deadline')), 5);
      return new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
        })
      );
    },
    async ({ api }) => {
      await assert.rejects(
        api('d1/database/test/import', { signal: controller.signal, retry: false }),
        /body deadline/
      );
    }
  );
});
