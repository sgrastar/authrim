import { describe, expect, it } from 'vitest';
import {
  assertLogArchivePhysicalFingerprint,
  assertLogArchiveTableLocations,
  inspectLogArchiveTable,
  logArchivePhysicalFingerprint,
} from '../physical-schema.js';
import { LOG_ARCHIVE_FIELDS } from '../schema.js';
import type { IcebergTableMetadata } from '../types.js';
import { LOCATION, metadata, pipelineMetadata } from './fixtures.js';

const unsupported = 'Unsupported archive Iceberg table';

function scheduled(change: (table: IcebergTableMetadata) => void = () => undefined): unknown {
  const table = metadata();
  change(table);
  return table;
}

function pipeline(
  change: (table: IcebergTableMetadata) => void = () => undefined,
  first = true
): unknown {
  const table = pipelineMetadata(first);
  change(table);
  return table;
}

const messageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return 'ok';
};

describe('inspectLogArchiveTable: the table', () => {
  it('describes a scheduled and a pipeline table by mode, field ids and provider column', () => {
    const plain = inspectLogArchiveTable(metadata());
    expect(plain.mode).toBe('scheduled');
    expect(plain.providerField).toBeUndefined();
    expect(plain).not.toHaveProperty('providerField');
    expect(plain.fieldIds.event_id).toBe(3);
    expect(Object.keys(plain.fieldIds)).toEqual(LOG_ARCHIVE_FIELDS.map((field) => field.name));
    const piped = inspectLogArchiveTable(pipelineMetadata(true));
    expect(piped.mode).toBe('pipeline');
    expect(piped.providerField?.name).toBe('__ingest_ts');
    expect(piped.fieldIds.event_id).toBe(4);
    expect(inspectLogArchiveTable(metadata(), 'scheduled').mode).toBe('scheduled');
    expect(inspectLogArchiveTable(pipelineMetadata(false), 'pipeline').providerField?.id).toBe(21);
  });

  it('refuses a mode other than the one expected', () => {
    expect(messageOf(() => inspectLogArchiveTable(metadata(), 'pipeline'))).toBe(
      'Archive physical mode mismatch'
    );
    expect(messageOf(() => inspectLogArchiveTable(pipelineMetadata(), 'scheduled'))).toBe(
      'Archive physical mode mismatch'
    );
  });

  it('refuses anything that is not a version 2 table with its parts', () => {
    const bad: unknown[] = [
      null,
      undefined,
      5,
      'x',
      [],
      scheduled((t) => void ((t as unknown as Record<string, unknown>)['format-version'] = 1)),
      scheduled((t) => void ((t as unknown as Record<string, unknown>)['table-uuid'] = 5)),
      scheduled((t) => void ((t as unknown as Record<string, unknown>).location = 5)),
      scheduled((t) => void ((t as unknown as Record<string, unknown>).schemas = 'x')),
      scheduled((t) => void ((t as unknown as Record<string, unknown>)['partition-specs'] = 'x')),
      scheduled((t) => void ((t as unknown as Record<string, unknown>)['sort-orders'] = 'x')),
      scheduled(
        (t) => void ((t as unknown as Record<string, unknown>)['last-sequence-number'] = 1.5)
      ),
      scheduled((t) => void ((t as unknown as Record<string, unknown>)['current-schema-id'] = 1.5)),
      scheduled((t) => void ((t as unknown as Record<string, unknown>)['default-spec-id'] = 'x')),
    ];
    for (const value of bad)
      expect(messageOf(() => inspectLogArchiveTable(value))).toBe(unsupported);
  });

  it('refuses a table whose current schema or default spec is missing or malformed', () => {
    const missing = 'Missing archive physical schema or spec';
    expect(
      messageOf(() => inspectLogArchiveTable(scheduled((t) => void (t['current-schema-id'] = 9))))
    ).toBe(missing);
    expect(
      messageOf(() => inspectLogArchiveTable(scheduled((t) => void (t['default-spec-id'] = 9))))
    ).toBe(missing);
    expect(
      messageOf(() =>
        inspectLogArchiveTable(
          scheduled(
            (t) => void ((t.schemas[0] as unknown as Record<string, unknown>).type = 'list')
          )
        )
      )
    ).toBe(missing);
    expect(
      messageOf(() =>
        inspectLogArchiveTable(
          scheduled((t) => void ((t.schemas[0] as unknown as Record<string, unknown>).fields = 'x'))
        )
      )
    ).toBe(missing);
    expect(
      messageOf(() =>
        inspectLogArchiveTable(
          scheduled(
            (t) =>
              void ((t['partition-specs'][0] as unknown as Record<string, unknown>).fields = 'x')
          )
        )
      )
    ).toBe(missing);
    expect(
      messageOf(() =>
        inspectLogArchiveTable(scheduled((t) => void (t.schemas = [null as never, ...t.schemas])))
      )
    ).toBe('ok');
  });
});

describe('inspectLogArchiveTable: the columns', () => {
  const identity = 'Invalid archive physical field identity';
  const field = (table: IcebergTableMetadata, index: number) =>
    table.schemas[0].fields[index] as unknown as Record<string, unknown>;

  it('refuses a column without a usable name, id or required flag, and duplicates', () => {
    const changes: Array<(t: IcebergTableMetadata) => void> = [
      (t) => void (t.schemas[0].fields[0] = null as never),
      (t) => void (field(t, 0).name = 5),
      (t) => void (field(t, 0).id = '1'),
      (t) => void (field(t, 0).id = 1.5),
      (t) => void (field(t, 0).id = 0),
      (t) => void (field(t, 0).id = -1),
      (t) => void (field(t, 0).required = 'yes'),
      (t) => void (field(t, 1).name = field(t, 0).name),
      (t) => void (field(t, 1).id = field(t, 0).id),
    ];
    for (const change of changes)
      expect(messageOf(() => inspectLogArchiveTable(scheduled(change)))).toBe(identity);
  });

  it('refuses extra or missing columns, and columns of another type', () => {
    expect(
      messageOf(() =>
        inspectLogArchiveTable(
          scheduled(
            (t) =>
              void t.schemas[0].fields.push({
                id: 99,
                name: 'extra',
                type: 'string',
                required: false,
              })
          )
        )
      )
    ).toBe('Unexpected archive physical columns');
    expect(
      messageOf(() => inspectLogArchiveTable(scheduled((t) => void t.schemas[0].fields.pop())))
    ).toBe('Unexpected archive physical columns');
    expect(
      messageOf(() => inspectLogArchiveTable(scheduled((t) => void (field(t, 2).name = 'renamed'))))
    ).toBe('Archive Iceberg field identity mismatch');
    expect(
      messageOf(() => inspectLogArchiveTable(scheduled((t) => void (field(t, 2).type = 'long'))))
    ).toBe('Archive Iceberg field identity mismatch');
  });

  it('holds a scheduled table to the exact ids and nullability, and a pipeline table to names and types', () => {
    const mismatch = 'Archive Iceberg field identity mismatch';
    expect(
      messageOf(() => inspectLogArchiveTable(scheduled((t) => void (field(t, 2).id = 77))))
    ).toBe(mismatch);
    expect(
      messageOf(() => inspectLogArchiveTable(scheduled((t) => void (field(t, 2).required = false))))
    ).toBe(mismatch);
    expect(messageOf(() => inspectLogArchiveTable(pipeline()))).toBe('ok');
    expect(
      messageOf(() => inspectLogArchiveTable(pipeline((t) => void (field(t, 3).type = 'long'))))
    ).toBe(mismatch);
  });

  it('accepts a provider column of timestamp or timestamptz only', () => {
    for (const type of ['timestamp', 'timestamptz']) {
      expect(
        messageOf(() => inspectLogArchiveTable(pipeline((t) => void (field(t, 0).type = type))))
      ).toBe('ok');
    }
    for (const type of ['long', 'string', 'date']) {
      expect(
        messageOf(() => inspectLogArchiveTable(pipeline((t) => void (field(t, 0).type = type))))
      ).toBe('Unsupported provider ingest timestamp type');
    }
  });
});

describe('inspectLogArchiveTable: the partitioning', () => {
  it('refuses any partitioning on a scheduled table', () => {
    const table = scheduled((t) => {
      t['partition-specs'][0].fields.push({
        'source-id': 1,
        'field-id': 1000,
        name: 'x',
        transform: 'day',
      });
    });
    expect(messageOf(() => inspectLogArchiveTable(table))).toBe(
      'Scheduled archive requires unpartitioned storage'
    );
    const other = scheduled((t) => {
      t['partition-specs'].push({
        'spec-id': 1,
        fields: [{ 'source-id': 1, 'field-id': 1000, name: 'x', transform: 'day' }],
      });
    });
    expect(messageOf(() => inspectLogArchiveTable(other))).toBe(
      'Scheduled archive requires unpartitioned storage'
    );
  });

  it('refuses a spec that is not a spec', () => {
    const invalid = 'Invalid archive partition spec';
    for (const change of [
      (t: IcebergTableMetadata) => void t['partition-specs'].push(null as never),
      (t: IcebergTableMetadata) => void t['partition-specs'].push({ 'spec-id': 1.5, fields: [] }),
      (t: IcebergTableMetadata) =>
        void t['partition-specs'].push({ 'spec-id': 1, fields: 'x' } as never),
    ]) {
      expect(messageOf(() => inspectLogArchiveTable(scheduled(change)))).toBe(invalid);
    }
  });

  it('holds a pipeline table to a single DAY partition of the provider column', () => {
    const requires = 'Pipeline archive requires provider ingest DAY partition';
    const spec = (t: IcebergTableMetadata) =>
      t['partition-specs'][0].fields[0] as unknown as Record<string, unknown>;
    expect(messageOf(() => inspectLogArchiveTable(pipeline()))).toBe('ok');
    const changes: Array<(t: IcebergTableMetadata) => void> = [
      (t) => void t['partition-specs'][0].fields.push({ ...spec(t) } as never),
      (t) => void (t['partition-specs'][0].fields = []),
      (t) => void (spec(t)['source-id'] = 77),
      (t) => void (spec(t).transform = 'hour'),
      (t) => void (spec(t).name = 5),
      (t) => void (spec(t).name = ''),
      (t) => void (spec(t).name = 'x'.repeat(129)),
      (t) => void (spec(t)['field-id'] = 1.5),
    ];
    for (const change of changes)
      expect(messageOf(() => inspectLogArchiveTable(pipeline(change)))).toBe(requires);
    expect(
      messageOf(() => inspectLogArchiveTable(pipeline((t) => void (spec(t).name = 'x'))))
    ).toBe('ok');
    expect(
      messageOf(() =>
        inspectLogArchiveTable(pipeline((t) => void (spec(t).name = 'x'.repeat(128))))
      )
    ).toBe('ok');
  });

  it('lets an old empty spec stand beside the default one, but not another empty default', () => {
    const withOld = pipeline((t) => {
      t['partition-specs'].push({ 'spec-id': 5, fields: [] });
    });
    expect(messageOf(() => inspectLogArchiveTable(withOld))).toBe('ok');
    const emptyDefault = pipeline((t) => {
      t['partition-specs'][0].fields = [];
    });
    expect(messageOf(() => inspectLogArchiveTable(emptyDefault))).toBe(
      'Pipeline archive requires provider ingest DAY partition'
    );
  });
});

describe('logArchivePhysicalFingerprint', () => {
  it('is a stable SHA-256 of the physical layout', async () => {
    const first = await logArchivePhysicalFingerprint(metadata());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await logArchivePhysicalFingerprint(metadata())).toBe(first);
    expect(await logArchivePhysicalFingerprint(pipelineMetadata())).not.toBe(first);
  });

  it('does not depend on the order schemas, specs or sort orders are listed in', async () => {
    const base = metadata();
    base.schemas.push({ ...structuredClone(base.schemas[0]), 'schema-id': 5 });
    base['partition-specs'].push({ 'spec-id': 4, fields: [] });
    base['sort-orders'].push({ 'order-id': 3, fields: [] });
    const reversed = structuredClone(base);
    reversed.schemas.reverse();
    reversed['partition-specs'].reverse();
    reversed['sort-orders'].reverse();
    expect(await logArchivePhysicalFingerprint(reversed)).toBe(
      await logArchivePhysicalFingerprint(base)
    );
    const identifiers = structuredClone(base);
    identifiers.schemas[0]['identifier-field-ids'] = [5, 4, 3];
    const sorted = structuredClone(base);
    sorted.schemas[0]['identifier-field-ids'] = [3, 4, 5];
    expect(await logArchivePhysicalFingerprint(identifiers)).toBe(
      await logArchivePhysicalFingerprint(sorted)
    );
  });

  it('changes with every part of the layout it pins', async () => {
    const base = await logArchivePhysicalFingerprint(metadata());
    const changes: Array<(t: IcebergTableMetadata) => void> = [
      (t) => void (t.schemas[0]['identifier-field-ids'] = [3, 4]),
      (t) => void t.schemas.push({ ...structuredClone(t.schemas[0]), 'schema-id': 5 }),
      (t) => void t['partition-specs'].push({ 'spec-id': 4, fields: [] }),
      (t) => void (t['default-sort-order-id'] = 3),
      (t) =>
        void t['sort-orders'].push({
          'order-id': 3,
          fields: [
            {
              'source-id': 3,
              transform: 'identity',
              direction: 'asc',
              'null-order': 'nulls-first',
            } as never,
          ],
        }),
      (t) =>
        void (t['sort-orders'][0].fields = [
          {
            'source-id': 3,
            transform: 'identity',
            direction: 'asc',
            'null-order': 'nulls-first',
          } as never,
        ]),
    ];
    for (const change of changes) {
      const table = metadata();
      change(table);
      expect(await logArchivePhysicalFingerprint(table)).not.toBe(base);
    }
    const sortKey = (field: Record<string, unknown>) => {
      const table = metadata();
      table['sort-orders'][0].fields = [field as never];
      return logArchivePhysicalFingerprint(table);
    };
    const reference = {
      'source-id': 3,
      transform: 'identity',
      direction: 'asc',
      'null-order': 'nulls-first',
    };
    const fingerprint = await sortKey(reference);
    for (const change of [
      { 'source-id': 4 },
      { transform: 'bucket' },
      { direction: 'desc' },
      { 'null-order': 'nulls-last' },
    ]) {
      expect(await sortKey({ ...reference, ...change })).not.toBe(fingerprint);
    }
    const pipelineTable = pipelineMetadata();
    const pipelineBase = await logArchivePhysicalFingerprint(pipelineTable);
    const changed = pipelineMetadata();
    changed['partition-specs'][0].fields[0].name = 'renamed_day';
    expect(await logArchivePhysicalFingerprint(changed)).not.toBe(pipelineBase);
    const widened = pipelineMetadata();
    widened['partition-specs'][0].fields[0]['field-id'] = 1001;
    expect(await logArchivePhysicalFingerprint(widened)).not.toBe(pipelineBase);
  });

  it('refuses a table that is not a log archive table', async () => {
    await expect(logArchivePhysicalFingerprint({})).rejects.toThrow(unsupported);
  });
});

describe('assertLogArchivePhysicalFingerprint', () => {
  it('returns the profile of a table that matches, and refuses any other fingerprint', async () => {
    const table = metadata();
    const fingerprint = await logArchivePhysicalFingerprint(table);
    expect((await assertLogArchivePhysicalFingerprint(table, fingerprint)).mode).toBe('scheduled');
    for (const bad of [
      '',
      'x',
      fingerprint.toUpperCase(),
      fingerprint.slice(1),
      `${fingerprint}0`,
      'f'.repeat(64),
    ]) {
      await expect(assertLogArchivePhysicalFingerprint(table, bad)).rejects.toThrow(
        'Archive physical schema fingerprint mismatch'
      );
    }
  });
});

describe('assertLogArchiveTableLocations', () => {
  const table = (location: string, metadataLocation: string) => ({
    metadata: { ...metadata(), location },
    metadataLocation,
  });
  const bucket = 'authrim-test';
  const check = (location: string, metadataLocation: string, name = bucket) =>
    messageOf(() => assertLogArchiveTableLocations(table(location, metadataLocation), name));
  const okMetadata = `${LOCATION}/metadata/v1.json`;

  it('refuses a bucket name that is not a plain R2 bucket name', () => {
    for (const name of [
      '',
      'a',
      'Upper',
      'under_score',
      '-start',
      'end-',
      'a'.repeat(64),
      'dot.name',
    ]) {
      expect(check(LOCATION, okMetadata, name)).toBe('Invalid archive bucket identity');
    }
    expect(check('s3://abc/x', 's3://abc/x/metadata/v.json', 'abc')).toBe('ok');
    expect(
      check(`s3://${'a'.repeat(63)}/x`, `s3://${'a'.repeat(63)}/x/metadata/v.json`, 'a'.repeat(63))
    ).toBe('ok');
    expect(check('s3://a1-b2/x', 's3://a1-b2/x/metadata/v.json', 'a1-b2')).toBe('ok');
  });

  it('accepts a table and its metadata in the configured bucket', () => {
    expect(check(LOCATION, okMetadata)).toBe('ok');
    expect(check(`${LOCATION}/`, okMetadata)).toBe('ok');
    expect(check(LOCATION, `${LOCATION}/metadata/sub/v1.json`)).toBe('ok');
  });

  it('refuses a location outside the bucket or with anything beyond bucket and path', () => {
    const outside = 'Archive catalog location is outside the configured R2 bucket';
    for (const location of [
      'https://authrim-test/logs',
      's3://other-bucket/logs',
      's3://authrim-test:9000/logs',
      's3://user@authrim-test/logs',
      's3://user:pw@authrim-test/logs',
      's3://authrim-test/logs?x=1',
      's3://authrim-test/logs#frag',
      's3://authrim-test',
      's3://authrim-test/',
      's3://authrim-test/a%2Fb',
    ]) {
      expect(check(location, okMetadata)).toBe(outside);
      expect(check(LOCATION, location)).toBe(outside);
    }
    expect(check('s3://authrim-test/x', 's3://authrim-test/x/metadata/v.json')).toBe('ok');
    expect(check('s3://authrim-test/a.b', 's3://authrim-test/a.b/metadata/v.json')).toBe('ok');
  });

  it('refuses metadata that is not under the metadata folder of the table', () => {
    const outside = 'Archive metadata location is outside its table';
    expect(check(LOCATION, `${LOCATION}/metadata/`)).toBe(outside);
    expect(check(LOCATION, `${LOCATION}/data/v1.json`)).toBe(outside);
    expect(check(LOCATION, `${LOCATION}/metadatax/v1.json`)).toBe(outside);
    expect(check(LOCATION, 's3://authrim-test/other/metadata/v1.json')).toBe(outside);
    expect(check(LOCATION, `${LOCATION}/metadata`)).toBe(outside);
    expect(check(`${LOCATION}/`, `${LOCATION}/metadata/`)).toBe(outside);
    expect(check(LOCATION, `${LOCATION}/metadata/v`)).toBe('ok');
  });
});
