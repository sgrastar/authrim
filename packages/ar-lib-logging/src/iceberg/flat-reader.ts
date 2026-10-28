import { prepareParquetRead } from 'hyparquet/src/scan.js';
import { readOffsetIndex } from 'hyparquet/src/indexes.js';
import { safeParquetHeader } from './read-safety.js';
import {
  decodeFlatPage,
  selectFlatPagePositions,
  type FlatProbe,
  type FlatValue,
} from './flat-page.js';
import { LOG_ARCHIVE_FIELDS } from './schema.js';
import type { LogArchivePhysicalProfile } from './physical-schema.js';
import type { ArchiveParquetFilter, SafeParquetFile } from './read-buffer.js';
import { IcebergBudgetError } from './types.js';

export interface FlatColumnCursor {
  fieldId: number;
  groupIndex: number;
  byteOffset: number;
  firstRow: number;
}
export interface FlatFileWindow {
  rows: { position: bigint; values: Record<string, unknown> }[];
  nextColumns: FlatColumnCursor[];
  nextRow: number;
}

/** Native page-index planner, followed by selected-value decoding. Unlike the
 * upstream full-page row reader this never expands a huge constant RLE page. */
export async function readFlatFileWindow(options: {
  file: SafeParquetFile;
  profile: LogArchivePhysicalProfile;
  rowStart: number;
  rowEnd: number;
  filter?: ArchiveParquetFilter;
  columns?: readonly FlatColumnCursor[];
  projection?: readonly string[];
  select?: {
    field: 'event_id' | 'tenant_key' | 'subject_id';
    matches: (value: FlatProbe) => boolean;
    maxMatches: number;
  };
}): Promise<FlatFileWindow> {
  const { file, profile } = options;
  if (
    !Number.isSafeInteger(options.rowStart) ||
    !Number.isSafeInteger(options.rowEnd) ||
    options.rowStart < 0 ||
    options.rowEnd < options.rowStart ||
    (!options.select && options.rowEnd - options.rowStart > 10_000)
  )
    throw new IcebergBudgetError('Invalid flat file row window');
  const requested = [
    ...LOG_ARCHIVE_FIELDS.map((field) => ({ ...field, physicalId: profile.fieldIds[field.name] })),
    ...(profile.providerField
      ? [
          {
            name: profile.providerField.name,
            type: 'long' as const,
            required: false,
            physicalId: profile.providerField.id,
          },
        ]
      : []),
  ];
  const logical = requested
    .filter(
      (field) =>
        (!options.select || field.name === options.select.field) &&
        (!options.projection || options.projection.includes(field.name))
    )
    .map((field) => {
      const physical = file.metadata.schema.find(
        (element) => element.field_id === field.physicalId
      );
      if (!physical) {
        if (field.required) throw new Error('Required archive physical field is missing');
        return { field, physical: undefined };
      }
      const expected =
        field.type === 'long' ? 'INT64' : field.type === 'int' ? 'INT32' : 'BYTE_ARRAY';
      if (
        physical.type !== expected ||
        !['OPTIONAL', 'REQUIRED'].includes(physical.repetition_type ?? '')
      )
        throw new Error('Unsupported flat physical column type');
      return { field, physical };
    });
  const physicalNames = logical.flatMap((column) =>
    column.physical ? [column.physical.name] : []
  );
  const indexRanges = file.metadata.row_groups.flatMap((group) =>
    group.columns.flatMap((column) => [
      ...(column.column_index_offset && column.column_index_length
        ? [{ start: Number(column.column_index_offset), length: column.column_index_length }]
        : []),
      ...(column.offset_index_offset && column.offset_index_length
        ? [{ start: Number(column.offset_index_offset), length: column.offset_index_length }]
        : []),
    ])
  );
  const indexBuffer = {
    byteLength: file.byteLength,
    async slice(start: number, end = file.byteLength) {
      const ranges = indexRanges
        .filter((range) => range.start >= start && range.start + range.length <= end)
        .sort((a, b) => a.start - b.start);
      if (
        !ranges.length ||
        ranges[0].start !== start ||
        ranges[ranges.length - 1].start + ranges[ranges.length - 1].length !== end
      )
        throw new Error('Unexpected Parquet planning range');
      const bytes = await file.readRange(start, end);
      for (const range of ranges) await file.readIndex(range.start, range.length);
      return Uint8Array.from(bytes).buffer;
    },
  };
  const physicalFilter = options.filter;
  const { plan } = await prepareParquetRead({
    file: indexBuffer,
    metadata: file.metadata,
    columns: physicalNames,
    rowStart: options.rowStart,
    rowEnd: options.rowEnd,
    filter: physicalFilter,
    filterStrict: false,
    useBloomFilters: false,
    usePageIndex: true,
    useOffsetIndex: true,
    utf8: false,
  });
  const rows = new Map<number, Record<string, unknown>>();
  const nextColumns: FlatColumnCursor[] = [];
  let nextRow = options.rowEnd;
  let selectionComplete = false;
  const headerAt = async (offset: number, end: number) => {
    let length = Math.min(256, end - offset);
    while (length > 0 && length <= 64 * 1024) {
      const bytes = await file.readRange(offset, offset + length);
      try {
        return safeParquetHeader(bytes);
      } catch (error) {
        if (
          !(error instanceof RangeError) &&
          !(
            error instanceof Error &&
            /Invalid bounded binary length|Parquet metadata string budget exceeded/.test(
              error.message
            )
          )
        )
          throw error;
        if (offset + length >= end || length === 64 * 1024) throw error;
        length = Math.min(length * 2, 64 * 1024, end - offset);
      }
    }
    throw new Error('Parquet page header exceeds budget');
  };
  for (const group of plan.groups) {
    file.check();
    const groupIndex = file.metadata.row_groups.indexOf(group.rowGroup);
    const count = group.selectEnd - group.selectStart;
    if (count < 0 || (!options.select && count > 10_000))
      throw new IcebergBudgetError('Flat planned row window exceeds budget');
    if (!options.select)
      for (let row = group.selectStart; row < group.selectEnd; row++) {
        const position = group.groupStart + row;
        if (!rows.has(position)) {
          file.reserveValues(64);
          rows.set(position, {});
        }
      }
    for (const column of logical) {
      if (!column.physical) {
        for (let row = group.selectStart; row < group.selectEnd; row++) {
          const value = rows.get(group.groupStart + row);
          if (value) value[column.field.name] = null;
        }
        continue;
      }
      const chunk = group.chunks.find(
        (item) => item.columnMetadata.path_in_schema.join('.') === column.physical?.name
      );
      if (!chunk) throw new Error('Selected Parquet column is missing from plan');
      const meta = chunk.columnMetadata;
      const chunkStart = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
      const chunkEnd = chunkStart + Number(meta.total_compressed_size);
      if (
        !Number.isSafeInteger(chunkStart) ||
        !Number.isSafeInteger(chunkEnd) ||
        chunkStart < 4 ||
        chunkEnd > file.footerStart
      )
        throw new Error('Invalid Parquet column range');
      const descriptor = {
        type: meta.type,
        optional: column.physical.repetition_type === 'OPTIONAL',
      };
      let dictionary: FlatValue[] | undefined;
      const page = async (offset: number) => {
        const parsed = await headerAt(offset, chunkEnd);
        const end = offset + parsed.headerBytes + parsed.header.compressed_page_size;
        if (end > chunkEnd) throw new Error('Parquet page extends outside its column');
        return { ...parsed, offset, end };
      };
      const decode = async (
        parsed: Awaited<ReturnType<typeof page>>,
        firstRow: number,
        start: number,
        end: number
      ) => {
        const bytes = await file.readRange(parsed.offset, parsed.end);
        file.validatePage(
          bytes,
          Math.max(
            Number(group.rowGroup.num_rows),
            parsed.header.dictionary_page_header?.num_values ?? 0
          ),
          meta.codec,
          { ...descriptor, ...(dictionary ? { dictionaryValues: dictionary.length } : {}) }
        );
        if (options.select && !parsed.header.dictionary_page_header) {
          const output = selectFlatPagePositions({
            page: bytes,
            codec: meta.codec,
            column: descriptor,
            rowStart: start,
            rowEnd: end,
            dictionary,
            matches: options.select.matches,
            maxMatches: options.select.maxMatches - rows.size,
            check: file.check,
          });
          for (const position of output.positions) {
            file.reserveValues(64);
            rows.set(group.groupStart + firstRow + position, {});
          }
          if (rows.size >= options.select.maxMatches) {
            nextRow = group.groupStart + firstRow + output.nextRow;
            selectionComplete = true;
          }
          return;
        }
        const output = decodeFlatPage({
          page: bytes,
          codec: meta.codec,
          column: descriptor,
          rowStart: start,
          rowEnd: end,
          dictionary,
          reserve: (amount) => file.reserveValues(amount),
        });
        if (output.dictionary) dictionary = output.dictionary;
        if (output.values)
          for (let i = 0; i < output.values.length; i++) {
            const target = rows.get(group.groupStart + firstRow + start + i);
            if (target) {
              let value = output.values[i];
              if (column.field.name === profile.providerField?.name && value !== null) {
                if (typeof value !== 'bigint') throw new Error('Invalid provider timestamp value');
                const annotation = column.physical?.logical_type;
                const unit =
                  annotation?.type === 'TIMESTAMP'
                    ? annotation.unit
                    : column.physical?.converted_type === 'TIMESTAMP_MILLIS'
                      ? 'MILLIS'
                      : column.physical?.converted_type === 'TIMESTAMP_MICROS'
                        ? 'MICROS'
                        : undefined;
                if (!unit) throw new Error('Provider timestamp annotation is missing');
                value =
                  unit === 'MILLIS' ? value * 1000n : unit === 'NANOS' ? value / 1000n : value;
              }
              target[column.field.name] = value;
            }
          }
      };
      if (meta.dictionary_page_offset !== undefined && meta.dictionary_page_offset !== null) {
        const parsed = await page(Number(meta.dictionary_page_offset));
        if (!parsed.header.dictionary_page_header)
          throw new Error('Parquet dictionary offset is invalid');
        await decode(parsed, 0, 0, 0);
      }
      let locations = 'pageLocations' in chunk ? chunk.pageLocations : undefined;
      if (!locations && 'offsetIndex' in chunk) {
        const bytes = await file.readIndex(
          chunk.offsetIndex.startByte,
          chunk.offsetIndex.endByte - chunk.offsetIndex.startByte
        );
        locations = readOffsetIndex({
          view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          offset: 0,
        }).page_locations;
      }
      if (locations) {
        let previousRow = -1;
        let previousOffset = -1;
        for (let index = 0; index < locations.length; index++) {
          const location = locations[index];
          const first = Number(location.first_row_index);
          const end =
            index + 1 < locations.length
              ? Number(locations[index + 1].first_row_index)
              : Number(group.rowGroup.num_rows);
          const offset = Number(location.offset);
          if (
            !Number.isSafeInteger(first) ||
            first <= previousRow ||
            !Number.isSafeInteger(offset) ||
            offset <= previousOffset ||
            offset < chunkStart ||
            offset + location.compressed_page_size > chunkEnd ||
            end < first
          )
            throw new Error('Invalid Parquet page locations');
          previousRow = first;
          previousOffset = offset;
          if (first >= group.selectEnd || end <= group.selectStart) continue;
          const parsed = await page(offset);
          const pageRows =
            parsed.header.data_page_header?.num_values ??
            parsed.header.data_page_header_v2?.num_rows;
          if (pageRows !== end - first || parsed.end - offset !== location.compressed_page_size)
            throw new Error('Parquet page location differs from header');
          await decode(
            parsed,
            first,
            Math.max(0, group.selectStart - first),
            Math.min(end - first, group.selectEnd - first)
          );
          nextColumns.push({
            fieldId: column.field.physicalId,
            groupIndex,
            byteOffset: offset,
            firstRow: first,
          });
          if (selectionComplete) break;
        }
      } else {
        const seed = options.columns?.find(
          (candidate) =>
            candidate.fieldId === column.field.physicalId && candidate.groupIndex === groupIndex
        );
        let offset = seed?.byteOffset ?? Number(meta.data_page_offset);
        let first = seed?.firstRow ?? 0;
        if (
          !Number.isSafeInteger(offset) ||
          offset < Number(meta.data_page_offset) ||
          offset >= chunkEnd ||
          !Number.isSafeInteger(first) ||
          first < 0 ||
          first > group.selectStart
        )
          throw new Error('Invalid flat column cursor');
        while (first < group.selectEnd) {
          file.check();
          const parsed = await page(offset);
          const pageRows =
            parsed.header.data_page_header?.num_values ??
            parsed.header.data_page_header_v2?.num_rows;
          if (
            !Number.isSafeInteger(pageRows) ||
            pageRows === undefined ||
            pageRows < 1 ||
            first + pageRows > Number(group.rowGroup.num_rows)
          )
            throw new Error('Invalid flat data page row count');
          if (first + pageRows > group.selectStart) {
            await decode(
              parsed,
              first,
              Math.max(0, group.selectStart - first),
              Math.min(pageRows, group.selectEnd - first)
            );
            nextColumns.push({
              fieldId: column.field.physicalId,
              groupIndex,
              byteOffset: offset,
              firstRow: first,
            });
          }
          if (selectionComplete) break;
          first += pageRows;
          offset = parsed.end;
          if (offset >= chunkEnd && first < group.selectEnd)
            throw new Error('Flat column ends before selected rows');
        }
      }
    }
    if (selectionComplete) break;
  }
  return {
    nextRow,
    rows: [...rows]
      .sort(([a], [b]) => a - b)
      .map(([position, values]) => ({ position: BigInt(position), values })),
    nextColumns: [
      ...new Map(
        nextColumns.map((cursor) => [`${cursor.groupIndex}:${cursor.fieldId}`, cursor])
      ).values(),
    ],
  };
}
