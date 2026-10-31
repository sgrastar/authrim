import { afterEach, describe, expect, it, vi } from 'vitest';
import { IcebergRestCatalog } from '../catalog.js';

const options = {
  uri: 'https://catalog.example.test/iceberg',
  warehouse: 'warehouse-test',
  namespace: ['authrim', 'test'],
  table: 'logs_v1_gen',
  token: 'synthetic-test-token',
};

/** workerd rejects `fetch` called as a method of another object ("Illegal invocation"); Node does
 * not, so the stub reproduces the runtime rule that unit tests otherwise cannot see. */
function workersFetch(receivers: unknown[]) {
  return function (this: unknown): Promise<Response> {
    receivers.push(this);
    if (this !== undefined && this !== globalThis)
      throw new TypeError('Illegal invocation: function called with incorrect `this` reference');
    return Promise.resolve(new Response('{}', { status: 404 }));
  };
}

describe('IcebergRestCatalog fetch receiver', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('calls the global fetch as a plain function, as Workers require', async () => {
    const receivers: unknown[] = [];
    vi.stubGlobal('fetch', workersFetch(receivers));
    const error = await new IcebergRestCatalog(options).loadTable().catch((e: unknown) => e);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((r) => r === undefined || r === globalThis)).toBe(true);
  });

  it('calls an injected fetch as a plain function too', async () => {
    const receivers: unknown[] = [];
    const error = await new IcebergRestCatalog({ ...options, fetch: workersFetch(receivers) })
      .loadTable()
      .catch((e: unknown) => e);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((r) => r === undefined || r === globalThis)).toBe(true);
  });
});
