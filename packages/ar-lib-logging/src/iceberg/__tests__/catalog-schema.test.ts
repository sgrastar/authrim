import { describe, expect, it, vi } from 'vitest';
import { IcebergRestCatalog } from '../catalog.js';
import { LOG_ARCHIVE_IMPLEMENTED_MODES } from '../capabilities.js';
import {
  assertLogArchiveRecord,
  LOG_ARCHIVE_FIELDS,
  LOG_ARCHIVE_STREAM_SCHEMA,
  logArchiveSchemaDigest,
} from '../schema.js';
import { IcebergCatalogConflictError, IcebergCommitUnknownError } from '../types.js';
import { metadata, record } from './fixtures.js';
function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
const options = {
  uri: 'https://catalog.example.test/iceberg',
  warehouse: 'warehouse-test',
  namespace: ['authrim', 'test'],
  table: 'logs_v1_gen',
  token: 'synthetic-test-token',
};
function tableResponse() {
  return {
    'metadata-location': 's3://authrim-test/logs/events/metadata/catalog.json',
    metadata: metadata(),
  };
}
describe('archive schema and REST catalog', () => {
  it('publishes both storage modes and fixes compatible stream/Iceberg field identities', async () => {
    expect(LOG_ARCHIVE_IMPLEMENTED_MODES).toEqual(['pipeline', 'scheduled']);
    expect(LOG_ARCHIVE_FIELDS.map((field) => field.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    );
    expect(LOG_ARCHIVE_STREAM_SCHEMA.fields.find((field) => field.name === 'event_at')).toEqual({
      name: 'event_at',
      type: 'int64',
      required: true,
    });
    expect(
      LOG_ARCHIVE_STREAM_SCHEMA.fields.find((field) => field.name === 'expires_at')?.required
    ).toBe(false);
    expect(await logArchiveSchemaDigest()).toMatch(/^[a-f0-9]{64}$/);
    assertLogArchiveRecord(record());
    expect(() =>
      assertLogArchiveRecord(record({ event_at: Number.MAX_SAFE_INTEGER + 1 }))
    ).toThrow();
  });
  it('negotiates the prefix and preserves 64bit catalog snapshot literals', async () => {
    const requests: string[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(requestUrl(input));
      expect(init?.redirect).toBe('manual');
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer synthetic-test-token'
      );
      if (requestUrl(input).includes('/config?'))
        return Response.json({
          defaults: { prefix: 'ignored' },
          overrides: { prefix: 'r2/warehouse' },
        });
      return new Response(
        JSON.stringify(tableResponse()).replace(
          '"last-column-id":20',
          '"current-snapshot-id":9223372036854775807,"last-column-id":20'
        )
      );
    });
    const catalog = new IcebergRestCatalog({ ...options, fetch: request });
    const loaded = await catalog.loadTable();
    expect(loaded.metadata['current-snapshot-id']).toBe(9223372036854775807n);
    expect(requests[1]).toBe(
      'https://catalog.example.test/iceberg/v1/r2/warehouse/namespaces/authrim%1Ftest/tables/logs_v1_gen'
    );
    await catalog.loadTable();
    expect(request.mock.calls).toHaveLength(3);
  });
  it('distinguishes CAS conflict from an unknown commit and refuses oversized catalog reads', async () => {
    let status = 409;
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).includes('/config?')) return Response.json({});
      if (init?.method === 'POST') return new Response('{}', { status });
      return Response.json(tableResponse());
    });
    const catalog = new IcebergRestCatalog({ ...options, fetch: request });
    await expect(catalog.commit({ requirements: [], updates: [] })).rejects.toBeInstanceOf(
      IcebergCatalogConflictError
    );
    status = 503;
    await expect(catalog.commit({ requirements: [], updates: [] })).rejects.toBeInstanceOf(
      IcebergCommitUnknownError
    );
    const limited = new IcebergRestCatalog({ ...options, maxResponseBytes: 128, fetch: request });
    await expect(limited.loadTable()).rejects.toThrow('read failed');
  });
  it('never adopts an existing table without its generation/schema ownership', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) =>
      requestUrl(input).includes('/config?') ? Response.json({}) : Response.json(tableResponse())
    );
    const catalog = new IcebergRestCatalog({ ...options, fetch: request });
    await expect(
      catalog.prepareScheduledTable('new-generation', await logArchiveSchemaDigest())
    ).rejects.toThrow('ownership');
    expect(request.mock.calls).toHaveLength(2);
  });
  it('creates the table through standard REST requests and validates returned schema ownership', async () => {
    const schemaDigest = await logArchiveSchemaDigest();
    let created = false;
    const requests: { url: string; method: string }[] = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method });
      if (url.includes('/config?')) return Response.json({});
      if (method === 'GET' && !created) return new Response('{}', { status: 404 });
      if (method === 'POST' && url.endsWith('/namespaces'))
        return Response.json({ namespace: ['authrim', 'test'], properties: {} });
      if (method === 'POST') {
        if (typeof init?.body !== 'string') throw new Error('Expected catalog JSON string');
        const body: unknown = JSON.parse(init.body);
        expect(body).toMatchObject({
          name: options.table,
          schema: { type: 'struct', fields: LOG_ARCHIVE_FIELDS },
          'partition-spec': { 'spec-id': 0, fields: [] },
        });
        created = true;
      }
      const result = tableResponse();
      result.metadata.properties = {
        'authrim.storage-generation': 'new-generation',
        'authrim.schema-digest': schemaDigest,
      };
      return Response.json(result);
    });
    const catalog = new IcebergRestCatalog({ ...options, fetch: request });
    expect(
      (await catalog.prepareScheduledTable('new-generation', schemaDigest)).metadata['table-uuid']
    ).toBe(metadata()['table-uuid']);
    expect(requests.map((r) => r.method)).toEqual(['GET', 'GET', 'POST', 'POST']);
  });
});

it('rejects oversized or malformed archive strings before writer JSON allocation', async () => {
  const invalid: Partial<ReturnType<typeof record>>[] = [
    { detail_ciphertext: 'x'.repeat(4 * 1024 * 1024 + 1) },
    { storage_generation: 'g'.repeat(97) },
    { event_id: 'e'.repeat(257) },
    { tenant_key: 't'.repeat(257) },
    { source_dataset: 'd'.repeat(257) },
    { log_type: 'l'.repeat(257) },
    { action: 'a'.repeat(513) },
    { detail_key_version: '0' },
    { detail_key_version: '01' },
    { detail_key_version: '1000000000' },
    { payload_hmac: 'A'.repeat(64) },
    { payload_hmac: 'a'.repeat(63) },
  ];
  for (const fields of invalid) expect(() => assertLogArchiveRecord(record(fields))).toThrow();
  assertLogArchiveRecord(
    record({
      detail_ciphertext: 'x'.repeat(4 * 1024 * 1024),
      storage_generation: 'g'.repeat(96),
      event_id: 'e'.repeat(256),
      tenant_key: 't'.repeat(256),
      source_dataset: 'd'.repeat(256),
      log_type: 'l'.repeat(256),
      action: 'a'.repeat(512),
      detail_key_version: '999999999',
      payload_hmac: 'f'.repeat(64),
    })
  );
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    expect(() =>
      assertLogArchiveRecord(record({ detail_ciphertext: 'x'.repeat(4 * 1024 * 1024 + 1) }))
    ).toThrow('Invalid archive field detail_ciphertext');
    expect(stringify).not.toHaveBeenCalled();
  } finally {
    stringify.mockRestore();
  }
});
