import { describe, expect, it, vi } from 'vitest';
import { avroWrite } from 'icebird/avro';
import { fetchAvroRecords } from 'icebird/src/fetch.js';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { AVRO_READ_LIMITS, safeReadResolver } from '../read-buffer.js';
import { safeAvro } from '../read-safety.js';
import { IcebergBudgetError } from '../types.js';

async function avro(
  schema: Parameters<typeof avroWrite>[0]['schema'],
  records: Record<string, unknown>[]
): Promise<Uint8Array> {
  const writer = new ByteWriter();
  await avroWrite({ writer, schema, records });
  return Uint8Array.from(writer.getBytes());
}

async function concurrentDecode(data: Uint8Array, count: number) {
  const read = vi.fn(async (_path: string, maximum: number) => {
    if (data.byteLength > maximum) throw new IcebergBudgetError('Fixture read bound');
    return Uint8Array.from(data);
  });
  const resolver = safeReadResolver({
    store: { read, putImmutable: async () => undefined },
    maxFiles: 128,
    maxBytes: 32 * 1024 * 1024,
    maxFileBytes: 1024 * 1024,
    maxRows: 10_000,
    deadline: Date.now() + 10_000,
    filters: new Map(),
  });
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, index) =>
      fetchAvroRecords(`manifest-${index}.avro`, resolver)
    )
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(rejected.length).toBeGreaterThan(0);
  for (const result of rejected) {
    const error: unknown = result.reason;
    expect(error).toBeInstanceOf(IcebergBudgetError);
    expect(error instanceof Error ? error.message : '').toBe(
      'Archive metadata allocation budget exceeded'
    );
  }
  // Rejected manifests never reach fetchAvroRecords' upstream decoder; future
  // queued IO also stops once the request's shared metadata allowance is spent.
  expect(read.mock.calls.length).toBeLessThan(count);
  return fulfilled;
}

describe('request-wide Avro decoded allocation budget', () => {
  it('bounds zero-byte record fields across concurrent manifest decodes', async () => {
    const data = await avro(
      {
        type: 'record',
        name: 'zero_byte_fields',
        fields: Array.from({ length: 32 }, (_, index) => ({
          name: `field_${index}`,
          type: 'null' as const,
        })),
      },
      Array.from({ length: 1000 }, () => ({}))
    );
    const metrics = safeAvro(data);
    expect(metrics.rows).toBe(1000);
    expect(metrics.nodes).toBe(33_000);
    expect(metrics.nodes).toBeLessThan(AVRO_READ_LIMITS.maxNodes);
    expect(metrics.estimatedDecodedBytes).toBeLessThan(AVRO_READ_LIMITS.maxDecodedBytes);
    expect(data.byteLength * 32).toBeLessThan(32 * 1024 * 1024);
    const accepted = await concurrentDecode(data, 32);
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length * metrics.rows).toBeLessThanOrEqual(AVRO_READ_LIMITS.maxRows);
    expect(accepted.length * metrics.nodes).toBeLessThanOrEqual(AVRO_READ_LIMITS.maxNodes);
    expect(accepted.length * metrics.estimatedDecodedBytes).toBeLessThanOrEqual(
      AVRO_READ_LIMITS.maxDecodedBytes
    );
    expect((accepted.length + 1) * metrics.estimatedDecodedBytes).toBeGreaterThan(
      AVRO_READ_LIMITS.maxDecodedBytes
    );
    for (const result of accepted) expect(result.value).toHaveLength(1000);
  });

  it('counts UTF-8 payload strings cumulatively before upstream creates UTF-16 strings', async () => {
    const data = await avro(
      { type: 'record', name: 'text_payload', fields: [{ name: 'text', type: 'string' }] },
      [{ text: 'x'.repeat(150 * 1024) }]
    );
    const metrics = safeAvro(data);
    expect(metrics.stringBytes).toBeGreaterThan(150 * 1024);
    expect(metrics.stringBytes).toBeLessThan(AVRO_READ_LIMITS.maxStringBytes);
    const accepted = await concurrentDecode(data, 32);
    expect(accepted.length * metrics.stringBytes).toBeLessThanOrEqual(
      AVRO_READ_LIMITS.maxStringBytes
    );
    expect((accepted.length + 1) * metrics.stringBytes).toBeGreaterThan(
      AVRO_READ_LIMITS.maxStringBytes
    );
  });

  it('counts per-manifest schema parsing and decoder structures even for zero-byte payloads', async () => {
    const schema: Parameters<typeof avroWrite>[0]['schema'] & { doc: string } = {
      type: 'record',
      name: 'schema_payload',
      doc: 'x'.repeat(62 * 1024),
      fields: [{ name: 'nothing', type: 'null' }],
    };
    const data = await avro(schema, [{}]);
    const metrics = safeAvro(data);
    expect(metrics.schemaBytes).toBeGreaterThan(62 * 1024);
    expect(metrics.schemaBytes).toBeLessThanOrEqual(64 * 1024);
    expect(metrics.rows).toBe(1);
    expect(metrics.nodes).toBe(2);
    const accepted = await concurrentDecode(data, 16);
    expect(accepted.length * metrics.stringBytes).toBeLessThan(AVRO_READ_LIMITS.maxStringBytes);
    expect(accepted.length * metrics.estimatedDecodedBytes).toBeLessThanOrEqual(
      AVRO_READ_LIMITS.maxDecodedBytes
    );
    expect((accepted.length + 1) * metrics.estimatedDecodedBytes).toBeGreaterThan(
      AVRO_READ_LIMITS.maxDecodedBytes
    );
  });

  it('includes collection slots and binary data in preflight metrics', async () => {
    const data = await avro(
      {
        type: 'record',
        name: 'collection_payload',
        fields: [
          { name: 'empty_values', type: { type: 'array', items: 'null' } },
          { name: 'binary', type: 'bytes' },
        ],
      },
      [{ empty_values: Array.from({ length: 4096 }, () => null), binary: new Uint8Array(1024) }]
    );
    const metrics = safeAvro(data);
    expect(metrics.containerEntries).toBe(4096);
    expect(metrics.binaryBytes).toBe(1024);
    expect(metrics.nodes).toBeGreaterThan(4096);
    expect(metrics.estimatedDecodedBytes).toBeGreaterThan(metrics.nodes * 64 + 1024);
  });
});
