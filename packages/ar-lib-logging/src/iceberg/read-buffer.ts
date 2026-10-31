import { avroMetadata } from 'icebird/src/avro/avro.metadata.js';
import { avroRead } from 'icebird/src/avro/avro.read.js';
import { avroRecordBatches } from './avro-batches.js';
import { canSkipRowGroup } from 'hyparquet/src/filter.js';
import { safeAvro, safeParquetFooter, safeParquetPages, safeParquetIndex } from './read-safety.js';
import { IcebergBudgetError, type IcebergObjectStore } from './types.js';
export const AVRO_READ_LIMITS = Object.freeze({
  maxRows: 10_000,
  maxNodes: 200_000,
  maxStringBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 8 * 1024 * 1024,
});

export type ArchiveParquetFilter = Parameters<typeof canSkipRowGroup>[0]['filter'];

/** A request-local range cache and allocation guard. IO is serialized before
 * checking/reserving shared budgets, including upstream Promise.all callers. */
export function safeReadResolver(options: {
  store: IcebergObjectStore;
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxRows: number;
  deadline: number;
  filters: Map<string, ArchiveParquetFilter>;
}) {
  let tail = Promise.resolve();
  let bytes = 0;
  let requests = 0;
  let files = 0;
  let decoded = 0;
  let rows = 0;
  let metadataRows = 0;
  let metadataNodes = 0;
  let metadataStringBytes = 0;
  let metadataDecodedBytes = 0;
  let metadataFailure: IcebergBudgetError | undefined;
  const maximumDecoded = Math.min(8 * 1024 * 1024, options.maxBytes);
  const check = () => {
    if (metadataFailure) throw metadataFailure;
    if (Date.now() >= options.deadline)
      throw new IcebergBudgetError('Archive read deadline exceeded');
  };
  const serial = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release: () => void = () => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      check();
      if (++requests > 256) throw new IcebergBudgetError('Archive read request budget exceeded');
      return await fn();
    } finally {
      release();
    }
  };
  const transfer = (fn: (limit: number) => Promise<Uint8Array>, length?: number) =>
    serial(async () => {
      const remaining = options.maxBytes - bytes;
      const reservation = length ?? Math.min(1024 * 1024, remaining);
      if (
        !Number.isSafeInteger(reservation) ||
        reservation < 1 ||
        reservation > remaining ||
        reservation > options.maxFileBytes
      )
        throw new IcebergBudgetError('Archive byte reservation exceeded');
      bytes += reservation;
      // Failed reads retain their reservation, bounding retries.
      const data = await fn(reservation);
      if (data.byteLength > reservation || (length !== undefined && data.byteLength !== length))
        throw new IcebergBudgetError('Archive range exceeded reservation');
      bytes -= reservation - data.byteLength;
      check();
      return data;
    });
  let retained = 0;
  const reserveMetadata = (amount: number): void => {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      metadataDecodedBytes + amount > AVRO_READ_LIMITS.maxDecodedBytes
    ) {
      metadataFailure = new IcebergBudgetError('Archive metadata allocation budget exceeded');
      throw metadataFailure;
    }
    metadataDecodedBytes += amount;
  };
  const countFile = (): void => {
    check();
    if (++files > options.maxFiles)
      throw new IcebergBudgetError('Archive file read budget exceeded');
  };
  const openParquet = async (path: string) => {
    const ranged =
      typeof options.store.size === 'function' && typeof options.store.readRange === 'function';
    const whole = ranged ? undefined : await transfer((limit) => options.store.read(path, limit));
    const sizeValue =
      whole?.byteLength ??
      (await serial(() =>
        options.store.size
          ? options.store.size(path)
          : Promise.reject(new Error('Archive size port missing'))
      ));
    if (typeof sizeValue !== 'number' || !Number.isSafeInteger(sizeValue) || sizeValue < 12)
      throw new Error('Invalid Parquet object size');
    const size = sizeValue;
    const cached: { start: number; end: number; data: Uint8Array }[] = [];
    if (whole) cached.push({ start: 0, end: size, data: whole });
    const range = async (start: number, end: number): Promise<Uint8Array> => {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > size
      )
        throw new Error('Invalid bounded Parquet range');
      if (end === start) return new Uint8Array();
      const hit = cached.find((item) => start >= item.start && end <= item.end);
      if (hit) return hit.data.subarray(start - hit.start, end - hit.start);
      const data = await transfer(
        () =>
          options.store.readRange
            ? options.store.readRange(path, start, end - start)
            : Promise.reject(new Error('Archive range port missing')),
        end - start
      );
      cached.push({ start, end, data });
      return data;
    };
    const last = await range(size - 8, size);
    const metadataLength = new DataView(last.buffer, last.byteOffset, last.byteLength).getUint32(
      0,
      true
    );
    if (metadataLength > 256 * 1024 || metadataLength + 8 > size)
      throw new IcebergBudgetError('Parquet footer budget exceeded');
    const footerStart = size - 8 - metadataLength;
    const footer = await range(footerStart, size);
    reserveMetadata(footer.byteLength * 32);
    const metadata = safeParquetFooter(footer);
    const chargedIndexes = new Set<string>();
    const validatedPages = new WeakMap<ArrayBufferLike, Set<string>>();
    return {
      byteLength: size,
      footerStart,
      metadata,
      readRange: range,
      check,
      async readIndex(start: number, length: number) {
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(length) ||
          start < 4 ||
          length < 1 ||
          start + length > footerStart ||
          length > 256 * 1024
        )
          throw new Error('Invalid Parquet index range');
        const data = await range(start, start + length);
        const nodes = safeParquetIndex(data);
        const key = `${start}:${length}`;
        if (!chargedIndexes.has(key)) {
          reserveMetadata(data.byteLength * 32 + nodes * 32);
          chargedIndexes.add(key);
        }
        return data;
      },
      validatePage(
        data: Uint8Array,
        rowLimit: number,
        codec: string,
        column: { type: string; optional: boolean; dictionaryValues?: number }
      ) {
        const key = `${data.byteOffset}:${data.byteLength}:${codec}:${column.type}:${column.optional}:${column.dictionaryValues ?? ''}`;
        const cached = validatedPages.get(data.buffer);
        if (cached?.has(key)) {
          check();
          return;
        }
        const charge = safeParquetPages(data, rowLimit, maximumDecoded - decoded, codec, column);
        const seen = cached ?? new Set<string>();
        seen.add(key);
        validatedPages.set(data.buffer, seen);
        decoded += charge;
        check();
      },
      reserveValues(amount: number) {
        if (!Number.isSafeInteger(amount) || amount < 0 || retained + amount > 8 * 1024 * 1024)
          throw new IcebergBudgetError('Archive retained value budget exceeded');
        retained += amount;
      },
    };
  };
  const parquetFiles = new Map<string, ReturnType<typeof openParquet>>();
  return {
    check,
    reserveMetadata,
    async *avroBatches(path: string) {
      countFile();
      const sizeReader = options.store.size?.bind(options.store);
      const length = sizeReader ? await serial(() => sizeReader(path)) : undefined;
      const data = await transfer((limit) => options.store.read(path, limit), length);
      for await (const batch of avroRecordBatches(data, check)) {
        const metrics = safeAvro(batch);
        reserveMetadata(metrics.estimatedDecodedBytes);
        try {
          const reader = {
            view: new DataView(batch.buffer, batch.byteOffset, batch.byteLength),
            offset: 0,
          };
          const { metadata, syncMarker } = avroMetadata(reader);
          const records: unknown[] = avroRead({ reader, metadata, syncMarker });
          yield { records, bytes: batch, metrics };
        } finally {
          metadataDecodedBytes -= metrics.estimatedDecodedBytes;
        }
      }
    },
    async openParquet(path: string) {
      let file = parquetFiles.get(path);
      if (!file) {
        countFile();
        file = openParquet(path);
        parquetFiles.set(path, file);
      }
      return file;
    },
    async reader(path: string) {
      countFile();
      if (!path.endsWith('.parquet')) {
        let data = await transfer((limit) => options.store.read(path, limit));
        try {
          safeAvro(data);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'Compressed Avro manifest is not supported by the bounded reader'
          )
            throw error;
        }
        // Keep complete helpers bounded and preserve integer DAY partition
        // tuples when a provider annotates Avro ints as logical dates.
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const batch of avroRecordBatches(data, check)) {
          safeAvro(batch);
          const reader = {
            view: new DataView(batch.buffer, batch.byteOffset, batch.byteLength),
            offset: 0,
          };
          avroMetadata(reader);
          const part = chunks.length ? Uint8Array.from(batch.subarray(reader.offset)) : batch;
          if (part.length > options.maxFileBytes - length)
            throw new IcebergBudgetError('Avro normalized object budget exceeded');
          chunks.push(part);
          length += part.length;
        }
        // A valid OCF may contain the header and no data blocks. Preserve its
        // original header when the streaming normalizer yields no record batch.
        if (chunks.length) {
          data = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
          }
        }
        const metrics = safeAvro(data);
        // No await between this shared reservation and handing bytes to the
        // upstream Avro decoder. Promise.all callers cannot each reuse the
        // same remaining allowance and retain an unbounded decoded graph.
        if (
          metadataRows + metrics.rows > AVRO_READ_LIMITS.maxRows ||
          metadataNodes + metrics.nodes > AVRO_READ_LIMITS.maxNodes ||
          metadataStringBytes + metrics.stringBytes > AVRO_READ_LIMITS.maxStringBytes ||
          metadataDecodedBytes + metrics.estimatedDecodedBytes > AVRO_READ_LIMITS.maxDecodedBytes
        ) {
          metadataFailure = new IcebergBudgetError('Archive metadata allocation budget exceeded');
          throw metadataFailure;
        }
        metadataRows += metrics.rows;
        metadataNodes += metrics.nodes;
        metadataStringBytes += metrics.stringBytes;
        metadataDecodedBytes += metrics.estimatedDecodedBytes;
        return {
          byteLength: data.byteLength,
          slice: (start: number, end?: number) => Uint8Array.from(data.subarray(start, end)).buffer,
        };
      }
      const opened = await openParquet(path);
      const { byteLength: size, footerStart, metadata, readRange: range } = opened;
      const filter = options.filters.get(path);
      for (const group of metadata.row_groups) {
        const physicalColumns = group.columns.map(
          (column) => column.meta_data?.path_in_schema.join('.') ?? ''
        );
        if (canSkipRowGroup({ rowGroup: group, physicalColumns, filter })) continue;
        const count = Number(group.num_rows);
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          count > options.maxRows ||
          (rows += count) > options.maxRows
        )
          throw new IcebergBudgetError('Archive candidate row budget exceeded');
        for (const column of group.columns) {
          const meta = column.meta_data;
          if (
            !meta ||
            meta.path_in_schema.length !== 1 ||
            !['SNAPPY', 'UNCOMPRESSED', 'ZSTD'].includes(meta.codec)
          )
            throw new Error('Unsupported bounded Parquet column');
          const start = Number(meta.dictionary_page_offset ?? meta.data_page_offset);
          const length = Number(meta.total_compressed_size);
          const uncompressed = Number(meta.total_uncompressed_size);
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(length) ||
            !Number.isSafeInteger(uncompressed) ||
            start < 4 ||
            length < 1 ||
            start + length > footerStart ||
            uncompressed > maximumDecoded - decoded
          )
            throw new IcebergBudgetError('Parquet column allocation budget exceeded');
          const data = await range(start, start + length);
          const element = metadata.schema.find((field) => field.name === meta.path_in_schema[0]);
          if (!element || !['REQUIRED', 'OPTIONAL'].includes(element.repetition_type ?? ''))
            throw new Error('Unsupported repeated Parquet column');
          const actual = safeParquetPages(
            data,
            options.maxRows,
            maximumDecoded - decoded,
            meta.codec,
            { type: meta.type, optional: element.repetition_type === 'OPTIONAL' }
          );
          decoded += actual;
        }
      }
      return {
        byteLength: size,
        async slice(start: number, end = size) {
          return Uint8Array.from(await range(start, end)).buffer;
        },
      };
    },
  };
}

export type SafeParquetFile = Awaited<
  ReturnType<ReturnType<typeof safeReadResolver>['openParquet']>
>;
