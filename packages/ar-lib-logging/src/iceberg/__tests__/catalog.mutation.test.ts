import { afterEach, describe, expect, it, vi } from 'vitest';
import { IcebergRestCatalog, prepareScheduledTable } from '../catalog.js';
import { LOG_ARCHIVE_ICEBERG_SCHEMA } from '../schema.js';
import { IcebergCatalogConflictError, IcebergCommitUnknownError } from '../types.js';
import { metadata } from './fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

function bodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a text body');
  return body;
}

const GENERATION = 'gen-1';
const DIGEST = 'd'.repeat(64);
const options = {
  uri: 'https://catalog.example.test/iceberg',
  warehouse: 'ware house',
  namespace: ['authrim', 'test'],
  table: 'logs v1',
  token: 'tok',
};

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function catalogWith(
  handler: Handler,
  extra: Partial<ConstructorParameters<typeof IcebergRestCatalog>[0]> = {}
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return {
    catalog: new IcebergRestCatalog({ ...options, fetch: fetcher, ...extra }),
    calls,
    fetcher,
  };
}

const table = (properties?: Record<string, string>) => ({
  'metadata-location': 's3://authrim-test/logs/events/metadata/catalog.json',
  metadata: { ...metadata(), ...(properties ? { properties } : {}) },
});

const owned = { 'authrim.storage-generation': GENERATION, 'authrim.schema-digest': DIGEST };

/** A response with exactly the parts the catalog reads, for cases a real Response cannot make. */
function fake(options: {
  status?: number;
  ok?: boolean;
  length?: string;
  chunks?: unknown[];
  noBody?: boolean;
}) {
  const reads = [
    ...(options.chunks ?? []).map((value) => ({ done: false, value })),
    { done: true },
  ];
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  return {
    response: {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      headers: new Headers(
        options.length === undefined ? {} : { 'content-length': options.length }
      ),
      body: options.noBody
        ? null
        : {
            getReader: () => ({
              read: async () => reads.shift() ?? { done: true },
              cancel,
              releaseLock,
            }),
            cancel,
          },
    } as unknown as Response,
    cancel,
    releaseLock,
  };
}

describe('configuration', () => {
  it('refuses a catalog that is not a plain HTTPS URL with credentials and names', () => {
    const bad = [
      { uri: 'http://catalog.example.test/x' },
      { uri: 'https://user@catalog.example.test/x' },
      { uri: 'https://user:pw@catalog.example.test/x' },
      { uri: 'https://catalog.example.test/x?a=1' },
      { uri: 'https://catalog.example.test/x#frag' },
      { token: '' },
      { warehouse: '' },
      { namespace: [] },
      { table: '' },
    ];
    for (const change of bad) {
      expect(() => new IcebergRestCatalog({ ...options, ...change })).toThrow(
        'Invalid archive catalog configuration'
      );
    }
    expect(
      () => new IcebergRestCatalog({ ...options, uri: 'https://catalog.example.test/x/' })
    ).not.toThrow();
  });

  it('accepts timeouts and response limits from one up to the maximum', () => {
    for (const change of [
      { timeoutMs: 0 },
      { timeoutMs: -1 },
      { timeoutMs: 1.5 },
      { timeoutMs: Number.NaN },
      { timeoutMs: 30_001 },
      { maxResponseBytes: 0 },
      { maxResponseBytes: 1.5 },
      { maxResponseBytes: 8 * 1024 * 1024 + 1 },
    ]) {
      expect(() => new IcebergRestCatalog({ ...options, ...change })).toThrow(
        'Invalid archive catalog limits'
      );
    }
    for (const change of [
      { timeoutMs: 1 },
      { timeoutMs: 30_000 },
      { maxResponseBytes: 1 },
      { maxResponseBytes: 8 * 1024 * 1024 },
    ]) {
      expect(() => new IcebergRestCatalog({ ...options, ...change })).not.toThrow();
    }
  });
});

describe('finding the table', () => {
  const config =
    (body: unknown) =>
    (url: string): Response =>
      url.includes('/v1/config?') ? Response.json(body) : Response.json(table());

  it('reads the catalog configuration, then the table, with the credentials it was given', async () => {
    const { catalog, calls } = catalogWith(config({ overrides: { prefix: 'r2/ware house' } }));
    const loaded = await catalog.loadTable();
    expect(loaded.metadataLocation).toBe('s3://authrim-test/logs/events/metadata/catalog.json');
    expect(calls.map((call) => call.url)).toEqual([
      'https://catalog.example.test/iceberg/v1/config?warehouse=ware%20house',
      'https://catalog.example.test/iceberg/v1/r2/ware%20house/namespaces/authrim%1Ftest/tables/logs%20v1',
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('manual');
      expect(init.headers).toStrictEqual({
        Authorization: 'Bearer tok',
        Accept: 'application/json',
      });
      expect(init.body).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('strips a trailing slash from the base and asks for the prefix once', async () => {
    const { catalog, calls } = catalogWith(config({}), {
      uri: 'https://catalog.example.test/iceberg/',
    });
    await catalog.loadTable();
    await catalog.loadTable();
    expect(calls.filter((call) => call.url.includes('/v1/config?'))).toHaveLength(1);
    expect(calls[0]?.url.startsWith('https://catalog.example.test/iceberg/v1/config')).toBe(true);
    expect(calls[1]?.url).toBe(
      'https://catalog.example.test/iceberg/v1/namespaces/authrim%1Ftest/tables/logs%20v1'
    );
  });

  it('prefers the override prefix, then the default one, then none', async () => {
    const urlFor = async (body: unknown): Promise<string | undefined> => {
      const { catalog, calls } = catalogWith(config(body));
      await catalog.loadTable();
      return calls[1]?.url;
    };
    expect(await urlFor({ defaults: { prefix: 'd' }, overrides: { prefix: 'o' } })).toContain(
      '/v1/o/namespaces/'
    );
    expect(await urlFor({ defaults: { prefix: 'd' } })).toContain('/v1/d/namespaces/');
    expect(await urlFor({ defaults: { prefix: 'd' }, overrides: {} })).toContain(
      '/v1/d/namespaces/'
    );
    expect(await urlFor({ overrides: { prefix: '' }, defaults: { prefix: 'd' } })).toContain(
      '/v1/namespaces/'
    );
    expect(await urlFor({ defaults: 5, overrides: [] })).toContain('/v1/namespaces/');
    expect(await urlFor({ overrides: { prefix: 'a/b c' } })).toContain('/v1/a/b%20c/namespaces/');
  });

  it('refuses a configuration or prefix it cannot trust', async () => {
    for (const body of [null, 5, 'x', []]) {
      await expect(catalogWith(config(body)).catalog.loadTable()).rejects.toThrow(
        'Invalid Iceberg catalog config'
      );
    }
    for (const prefix of [5, '..', '.', 'a/../b', 'a/./b', '../x', 'x'.repeat(1025)]) {
      await expect(
        catalogWith(config({ overrides: { prefix } })).catalog.loadTable()
      ).rejects.toThrow('Invalid Iceberg catalog prefix');
    }
    await expect(
      catalogWith(config({ overrides: { prefix: 'x'.repeat(1024) } })).catalog.loadTable()
    ).resolves.toBeDefined();
    await expect(
      catalogWith(config({ overrides: { prefix: 'a..b/c.d' } })).catalog.loadTable()
    ).resolves.toBeDefined();
  });

  it('refuses a table response that is not a table of the log archive', async () => {
    for (const body of [
      null,
      5,
      [],
      {},
      { 'metadata-location': 5, metadata: metadata() },
      { 'metadata-location': 's3://x' },
    ]) {
      const { catalog } = catalogWith((url) =>
        url.includes('/v1/config?') ? Response.json({}) : Response.json(body)
      );
      await expect(catalog.loadTable()).rejects.toThrow();
    }
    const { catalog } = catalogWith((url) =>
      url.includes('/v1/config?')
        ? Response.json({})
        : Response.json({ 'metadata-location': 's3://x/y', metadata: { nope: true } })
    );
    await expect(catalog.loadTable()).rejects.toThrow();
  });

  it('checks the bucket of the table when one is configured', async () => {
    const handler = (url: string): Response =>
      url.includes('/v1/config?') ? Response.json({}) : Response.json(table());
    await expect(
      catalogWith(handler, { bucketName: 'authrim-test' }).catalog.loadTable()
    ).resolves.toBeDefined();
    await expect(
      catalogWith(handler, { bucketName: 'other-bucket' }).catalog.loadTable()
    ).rejects.toThrow('bucket');
  });
});

describe('reading responses', () => {
  const prefixed =
    (response: () => Response | Promise<Response>) =>
    (url: string): Response | Promise<Response> =>
      url.includes('/v1/config?') ? Response.json({}) : response();

  it('names the status of a failed read', async () => {
    for (const status of [401, 404, 500]) {
      const { catalog } = catalogWith(prefixed(() => new Response('no', { status })));
      await expect(catalog.loadTable()).rejects.toThrow(`Iceberg catalog HTTP ${status}`);
    }
  });

  it('wraps a failed request with its cause', async () => {
    const cause = new Error('network down');
    const { catalog } = catalogWith(() => Promise.reject(cause));
    const failure = await catalog.loadTable().catch((error: unknown) => error);
    expect((failure as Error).message).toBe('Iceberg catalog read failed');
    expect((failure as Error).cause).toBe(cause);
  });

  it('refuses a response over its limit, by declared length or by what it streams', async () => {
    const limit = 100;
    const encode = (text: string) => new TextEncoder().encode(text);
    const exceeds = { message: 'Catalog response exceeds limit' };
    const exact = JSON.stringify({ defaults: {}, pad: 'x'.repeat(limit - 24) });
    expect(encode(exact).byteLength).toBe(limit);
    const read = (response: Response) =>
      catalogWith((url) => (url.includes('/v1/config?') ? response : Response.json({})), {
        maxResponseBytes: limit,
      }).catalog.loadTable();
    const declared = async (length: string, chunks: Uint8Array[]) =>
      read(fake({ length, chunks }).response).then(
        () => 'accepted',
        (error: Error) =>
          error.message === 'Invalid catalog table response'
            ? 'accepted'
            : ((error.cause as Error | undefined)?.message ?? error.message)
      );
    expect(await declared('101', [encode('{}')])).toBe(exceeds.message);
    expect(await declared('100', [encode('{}')])).toBe('accepted');
    expect(await declared('99999', [encode('{}')])).toBe(exceeds.message);
    expect(await declared('100', [encode(exact)])).toBe('accepted');
    const streamed = fake({ chunks: [encode(exact.slice(0, 60)), encode(`${exact.slice(60)} `)] });
    const failure = await read(streamed.response).catch((error: unknown) => error);
    expect((failure as Error).cause).toMatchObject(exceeds);
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
    expect(streamed.releaseLock).toHaveBeenCalledTimes(1);
    const fine = fake({ chunks: [encode(exact.slice(0, 60)), encode(exact.slice(60))] });
    await expect(read(fine.response)).rejects.toThrow('Invalid catalog table response');
    expect(fine.cancel).not.toHaveBeenCalled();
    expect(fine.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('refuses text that is not strict UTF-8, and keeps a byte order mark that JSON cannot parse', async () => {
    const config = (bytes: Uint8Array) =>
      catalogWith((url) =>
        url.includes('/v1/config?') ? fake({ chunks: [bytes] }).response : Response.json(table())
      );
    const invalid = new Uint8Array([
      ...new TextEncoder().encode('{"a":"'),
      0xff,
      ...new TextEncoder().encode('"}'),
    ]);
    const failure = await config(invalid)
      .catalog.loadTable()
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe('Iceberg catalog read failed');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{}')]);
    const bomFailure = await config(bom)
      .catalog.loadTable()
      .catch((error: unknown) => error);
    expect((bomFailure as Error).message).toBe('Iceberg catalog read failed');
  });

  it('leaves no timer behind once a request is done, or has failed', async () => {
    vi.useFakeTimers();
    const ok = catalogWith((url) =>
      url.includes('/v1/config?') ? Response.json({}) : Response.json(table())
    );
    await ok.catalog.loadTable();
    expect(vi.getTimerCount()).toBe(0);
    const failed = catalogWith(() => new Response('', { status: 500 }));
    await expect(failed.catalog.loadTable()).rejects.toThrow('Iceberg catalog HTTP 500');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses an empty body and chunks that are not bytes', async () => {
    const empty = catalogWith(prefixed(() => fake({ noBody: true }).response));
    expect(
      ((await empty.catalog.loadTable().catch((e: unknown) => e)) as Error).cause
    ).toMatchObject({
      message: 'Empty catalog response',
    });
    const text = catalogWith(prefixed(() => fake({ chunks: ['text'] }).response));
    expect(
      ((await text.catalog.loadTable().catch((e: unknown) => e)) as Error).cause
    ).toMatchObject({
      message: 'Invalid catalog response chunk',
    });
    const bad = catalogWith(
      prefixed(() => fake({ chunks: [new Uint8Array([0xff, 0xfe])] }).response)
    );
    expect(((await bad.catalog.loadTable().catch((e: unknown) => e)) as Error).message).toBe(
      'Iceberg catalog read failed'
    );
  });

  it('reads a response in several chunks', async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const json = JSON.stringify(table());
    const half = Math.floor(json.length / 2);
    const { catalog } = catalogWith(
      prefixed(
        () => fake({ chunks: [encode(json.slice(0, half)), encode(json.slice(half))] }).response
      )
    );
    await expect(catalog.loadTable()).resolves.toBeDefined();
  });

  it('gives up on a request that outlasts the timeout', async () => {
    vi.useFakeTimers();
    const { catalog } = catalogWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 50 }
    );
    const pending = catalog.loadTable().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(49);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await pending) as Error).message).toBe('Iceberg catalog read failed');
  });
});

describe('committing', () => {
  const update = { requirements: [{ type: 'assert-table-uuid', uuid: 'u' }], updates: [] } as never;
  const handler =
    (commit: () => Response | Promise<Response>) => (url: string, init: RequestInit) =>
      url.includes('/v1/config?')
        ? Response.json({})
        : init.method === 'POST'
          ? commit()
          : Response.json(table());

  it('posts the update as JSON and returns the table it answers with', async () => {
    const { catalog, calls } = catalogWith(handler(() => Response.json(table())));
    const result = await catalog.commit(update);
    expect(result.metadataLocation).toBe('s3://authrim-test/logs/events/metadata/catalog.json');
    const post = calls.find((call) => call.init.method === 'POST');
    expect(post?.init.headers).toStrictEqual({
      Authorization: 'Bearer tok',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(bodyText(post?.init))).toEqual(update);
    expect(post?.init.redirect).toBe('manual');
  });

  it('reports a conflict as a conflict, and any other failure as unknown', async () => {
    const conflict = catalogWith(handler(() => new Response('', { status: 409 })));
    await expect(conflict.catalog.commit(update)).rejects.toBeInstanceOf(
      IcebergCatalogConflictError
    );
    await expect(conflict.catalog.commit(update)).rejects.toThrow('Iceberg catalog CAS conflict');
    for (const make of [
      () => new Response('', { status: 500 }),
      () => new Response('', { status: 400 }),
      () => Promise.reject(new Error('reset')),
    ]) {
      const { catalog } = catalogWith(handler(make));
      const failure = await catalog.commit(update).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(IcebergCommitUnknownError);
      expect((failure as Error).message).toBe('Iceberg commit outcome must be reconciled');
    }
    const invalid = catalogWith(handler(() => Response.json({ nope: true })));
    const failure = await invalid.catalog.commit(update).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IcebergCommitUnknownError);
    expect((failure as Error).message).toBe('Iceberg commit response must be reconciled');
  });

  it('does not treat a failure to discover the path as an unknown commit', async () => {
    const { catalog } = catalogWith(() => new Response('', { status: 500 }));
    const failure = await catalog.commit(update).catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(IcebergCommitUnknownError);
    expect((failure as Error).message).toBe('Iceberg catalog HTTP 500');
  });
});

describe('prepareScheduledTable', () => {
  function server(state: { exists: boolean; table?: unknown }) {
    const log: string[] = [];
    const handler: Handler = (url, init) => {
      const method = init.method ?? 'GET';
      const path = url.replace('https://catalog.example.test/iceberg', '');
      log.push(`${method} ${path}`);
      if (path.startsWith('/v1/config')) return Response.json({});
      if (method === 'GET')
        return state.exists
          ? Response.json(state.table ?? table(owned))
          : new Response('', { status: 404 });
      if (path.endsWith('/namespaces')) return Response.json({});
      state.exists = true;
      return Response.json(state.table ?? table(owned));
    };
    return { log, handler };
  }

  it('refuses ownership values of the wrong shape before asking anything', async () => {
    const { handler } = server({ exists: true });
    const { catalog, calls } = catalogWith(handler);
    for (const [generation, digest] of [
      ['', DIGEST],
      ['x'.repeat(129), DIGEST],
      ['bad gen', DIGEST],
      [GENERATION, 'D'.repeat(64)],
      [GENERATION, 'd'.repeat(63)],
      [GENERATION, 'd'.repeat(65)],
      [GENERATION, 'g'.repeat(64)],
    ]) {
      await expect(catalog.prepareScheduledTable(generation, digest)).rejects.toThrow(
        'Invalid archive table ownership'
      );
    }
    expect(calls).toHaveLength(0);
    await expect(catalog.prepareScheduledTable('x'.repeat(128), DIGEST)).rejects.toThrow(
      'Archive table ownership or schema digest mismatch'
    );
  });

  it('returns a table that exists and is owned by this generation and schema', async () => {
    const { handler, log } = server({ exists: true });
    const { catalog } = catalogWith(handler);
    await expect(catalog.prepareScheduledTable(GENERATION, DIGEST)).resolves.toMatchObject({
      metadataLocation: 's3://authrim-test/logs/events/metadata/catalog.json',
    });
    expect(log.filter((line) => line.startsWith('POST'))).toEqual([]);
  });

  it('refuses a table owned by another generation or schema', async () => {
    for (const properties of [
      { ...owned, 'authrim.storage-generation': 'other' },
      { ...owned, 'authrim.schema-digest': 'e'.repeat(64) },
      { 'authrim.storage-generation': GENERATION },
      { 'authrim.schema-digest': DIGEST },
      undefined,
    ]) {
      const { handler } = server({ exists: true, table: table(properties) });
      await expect(
        catalogWith(handler).catalog.prepareScheduledTable(GENERATION, DIGEST)
      ).rejects.toThrow('Archive table ownership or schema digest mismatch');
    }
  });

  it('creates the namespace and the table when the table is missing', async () => {
    const { handler, log } = server({ exists: false });
    const { catalog, calls } = catalogWith(handler);
    await expect(catalog.prepareScheduledTable(GENERATION, DIGEST)).resolves.toBeDefined();
    expect(log.filter((line) => line.startsWith('POST'))).toEqual([
      'POST /v1/namespaces',
      'POST /v1/namespaces/authrim%1Ftest/tables',
    ]);
    const namespace = calls.find((call) => call.url.endsWith('/v1/namespaces'));
    expect(JSON.parse(bodyText(namespace?.init))).toEqual({
      namespace: ['authrim', 'test'],
      properties: {},
    });
    const create = calls.find(
      (call) => call.url.endsWith('/tables') && call.init.method === 'POST'
    );
    expect(JSON.parse(bodyText(create?.init))).toEqual({
      name: 'logs v1',
      schema: LOG_ARCHIVE_ICEBERG_SCHEMA,
      'partition-spec': { 'spec-id': 0, fields: [] },
      'write-order': { 'order-id': 0, fields: [] },
      properties: {
        'format-version': '2',
        'write.format.default': 'parquet',
        'write.parquet.compression-codec': 'snappy',
        'authrim.storage-generation': GENERATION,
        'authrim.schema-digest': DIGEST,
      },
    });
  });

  it('puts the namespace under the prefix and carries on when it already exists', async () => {
    const log: string[] = [];
    const handler: Handler = (url, init) => {
      const method = init.method ?? 'GET';
      const path = url.replace('https://catalog.example.test/iceberg', '');
      log.push(`${method} ${path}`);
      if (path.startsWith('/v1/config')) return Response.json({ overrides: { prefix: 'pre' } });
      if (method === 'GET')
        return log.filter((l) => l.startsWith('GET /v1/pre/ns')).length > 1
          ? Response.json(table(owned))
          : new Response('', { status: 404 });
      if (path.endsWith('/namespaces')) return new Response('', { status: 409 });
      return Response.json(table(owned));
    };
    await expect(
      catalogWith(handler).catalog.prepareScheduledTable(GENERATION, DIGEST)
    ).resolves.toBeDefined();
    expect(log).toContain('POST /v1/pre/namespaces');
    expect(log.some((line) => line === 'POST /v1/pre/namespaces/authrim%1Ftest/tables')).toBe(true);
  });

  it('stops on a namespace failure that is not a conflict, and on a load failure that is not a 404', async () => {
    const failing: Handler = (url, init) => {
      if (url.includes('/v1/config')) return Response.json({});
      if ((init.method ?? 'GET') === 'GET') return new Response('', { status: 404 });
      return new Response('', { status: 500 });
    };
    await expect(
      catalogWith(failing).catalog.prepareScheduledTable(GENERATION, DIGEST)
    ).rejects.toBeInstanceOf(IcebergCommitUnknownError);
    const broken: Handler = (url) =>
      url.includes('/v1/config') ? Response.json({}) : new Response('', { status: 500 });
    await expect(
      catalogWith(broken).catalog.prepareScheduledTable(GENERATION, DIGEST)
    ).rejects.toThrow('Iceberg catalog HTTP 500');
  });

  it('reconciles a table creation whose response was lost against its own ownership', async () => {
    for (const status of [409, 500]) {
      let created = false;
      const handler: Handler = (url, init) => {
        const method = init.method ?? 'GET';
        if (url.includes('/v1/config')) return Response.json({});
        if (method === 'GET')
          return created ? Response.json(table(owned)) : new Response('', { status: 404 });
        if (url.endsWith('/namespaces')) return Response.json({});
        created = true;
        return new Response('', { status });
      };
      await expect(
        catalogWith(handler).catalog.prepareScheduledTable(GENERATION, DIGEST)
      ).resolves.toBeDefined();
    }
    const invalid: Handler = (url, init) => {
      if (url.includes('/v1/config')) return Response.json({});
      if ((init.method ?? 'GET') === 'GET') return new Response('', { status: 404 });
      if (url.endsWith('/namespaces')) return Response.json({});
      return Response.json({ nope: true });
    };
    await expect(
      catalogWith(invalid).catalog.prepareScheduledTable(GENERATION, DIGEST)
    ).rejects.toThrow('Invalid catalog table response');
  });

  it('is also offered as a function over the options', async () => {
    const { handler } = server({ exists: true });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        init ?? {}
      )
    );
    await expect(
      prepareScheduledTable({
        ...options,
        fetch: fetcher,
        storageGeneration: GENERATION,
        schemaDigest: DIGEST,
      })
    ).resolves.toBeDefined();
  });
});
