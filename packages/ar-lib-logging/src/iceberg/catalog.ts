import { parseIcebergJson, stringifyIcebergJson } from 'icebird/src/json.js';
import { LOG_ARCHIVE_ICEBERG_SCHEMA } from './schema.js';
import {
  IcebergCatalogConflictError,
  IcebergCommitUnknownError,
  type IcebergCatalogPort,
  type IcebergCommit,
  type IcebergLoadedTable,
  type IcebergTableMetadata,
} from './types.js';

import { inspectLogArchiveTable, assertLogArchiveTableLocations } from './physical-schema.js';

class IcebergCatalogHttpError extends Error {
  constructor(readonly status: number) {
    super(`Iceberg catalog HTTP ${status}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertLogArchiveTable(value: unknown): asserts value is IcebergTableMetadata {
  inspectLogArchiveTable(value);
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit)
    throw new Error('Catalog response exceeds limit');
  if (!response.body) throw new Error('Empty catalog response');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk: unknown = result.value;
      if (!(chunk instanceof Uint8Array)) throw new Error('Invalid catalog response chunk');
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error('Catalog response exceeds limit');
      }
      parts.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export interface IcebergRestCatalogOptions {
  bucketName?: string;
  uri: string;
  warehouse: string;
  namespace: readonly string[];
  table: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** REST CAS commits, with no storage credential vending or unbounded HTTP retries. */
export class IcebergRestCatalog implements IcebergCatalogPort {
  private readonly base: string;
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maximumBytes: number;
  private prefix: string | undefined;

  constructor(private readonly options: IcebergRestCatalogOptions) {
    const url = new URL(options.uri);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !options.token ||
      !options.warehouse ||
      options.namespace.length === 0 ||
      !options.table
    )
      throw new Error('Invalid archive catalog configuration');
    this.base = url.href.replace(/\/$/, '');
    // Workers throw "Illegal invocation" when `fetch` is called as a method of another object, so
    // keep it behind a plain call instead of storing it as a field.
    const send = options.fetch ?? fetch;
    this.request = (input, init) => send(input, init);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30_000 ||
      !Number.isSafeInteger(this.maximumBytes) ||
      this.maximumBytes < 1 ||
      this.maximumBytes > 8 * 1024 * 1024
    ) {
      throw new Error('Invalid archive catalog limits');
    }
  }

  private async json(path: string, commit?: object): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.request(`${this.base}${path}`, {
        method: commit ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: 'application/json',
          ...(commit ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(commit ? { body: stringifyIcebergJson(commit) } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
      if (commit && response.status === 409) {
        await response.body?.cancel();
        throw new IcebergCatalogConflictError('Iceberg catalog CAS conflict');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new IcebergCatalogHttpError(response.status);
      }
      const parsed: unknown = parseIcebergJson(await boundedText(response, this.maximumBytes));
      return parsed;
    } catch (error) {
      if (
        error instanceof IcebergCatalogConflictError ||
        (!commit && error instanceof IcebergCatalogHttpError)
      )
        throw error;
      if (commit) throw new IcebergCommitUnknownError('Iceberg commit outcome must be reconciled');
      throw new Error('Iceberg catalog read failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async tablePath(): Promise<string> {
    if (this.prefix === undefined) {
      const config = await this.json(
        `/v1/config?warehouse=${encodeURIComponent(this.options.warehouse)}`
      );
      if (!isRecord(config)) throw new Error('Invalid Iceberg catalog config');
      const defaults = isRecord(config.defaults) ? config.defaults : {};
      const overrides = isRecord(config.overrides) ? config.overrides : {};
      const prefix: unknown = overrides.prefix ?? defaults.prefix ?? '';
      if (
        typeof prefix !== 'string' ||
        prefix.length > 1024 ||
        prefix.split('/').some((segment) => segment === '..' || segment === '.')
      ) {
        throw new Error('Invalid Iceberg catalog prefix');
      }
      this.prefix = prefix.split('/').map(encodeURIComponent).join('/');
    }
    const namespace = encodeURIComponent(this.options.namespace.join('\u001f'));
    return `/v1/${this.prefix ? `${this.prefix}/` : ''}namespaces/${namespace}/tables/${encodeURIComponent(this.options.table)}`;
  }

  private loaded(value: unknown): IcebergLoadedTable {
    if (!isRecord(value) || typeof value['metadata-location'] !== 'string')
      throw new Error('Invalid catalog table response');
    assertLogArchiveTable(value.metadata);
    const table = { metadata: value.metadata, metadataLocation: value['metadata-location'] };
    if (this.options.bucketName) assertLogArchiveTableLocations(table, this.options.bucketName);
    return table;
  }

  /** Setup-only, called after the shared activation gate and resource ownership
   * checks. No file-catalog metadata is invented by the setup tool. */
  async prepareScheduledTable(
    storageGeneration: string,
    schemaDigest: string
  ): Promise<IcebergLoadedTable> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(storageGeneration) || !/^[a-f0-9]{64}$/.test(schemaDigest)) {
      throw new Error('Invalid archive table ownership');
    }
    const path = await this.tablePath();
    const owned = (table: IcebergLoadedTable): IcebergLoadedTable => {
      const properties = table.metadata.properties;
      if (
        properties?.['authrim.storage-generation'] !== storageGeneration ||
        properties?.['authrim.schema-digest'] !== schemaDigest
      ) {
        throw new Error('Archive table ownership or schema digest mismatch');
      }
      return table;
    };
    try {
      return owned(await this.loadTable());
    } catch (error) {
      if (!(error instanceof IcebergCatalogHttpError) || error.status !== 404) throw error;
    }
    const tablesPath = path.slice(0, path.lastIndexOf('/'));
    const namespacePath =
      tablesPath.slice(0, tablesPath.lastIndexOf('/namespaces/')) + '/namespaces';
    try {
      await this.json(namespacePath, { namespace: [...this.options.namespace], properties: {} });
    } catch (error) {
      if (!(error instanceof IcebergCatalogConflictError)) throw error;
    }
    try {
      return owned(
        this.loaded(
          await this.json(tablesPath, {
            name: this.options.table,
            schema: LOG_ARCHIVE_ICEBERG_SCHEMA,
            'partition-spec': { 'spec-id': 0, fields: [] },
            'write-order': { 'order-id': 0, fields: [] },
            properties: {
              'format-version': '2',
              'write.format.default': 'parquet',
              'write.parquet.compression-codec': 'snappy',
              'authrim.storage-generation': storageGeneration,
              'authrim.schema-digest': schemaDigest,
            },
          })
        )
      );
    } catch (error) {
      if (
        !(error instanceof IcebergCatalogConflictError) &&
        !(error instanceof IcebergCommitUnknownError)
      )
        throw error;
      // Creation response loss is reconciled only against our exact owner/schema.
      return owned(await this.loadTable());
    }
  }

  async loadTable(): Promise<IcebergLoadedTable> {
    return this.loaded(await this.json(await this.tablePath()));
  }

  async commit(update: IcebergCommit): Promise<IcebergLoadedTable> {
    // Config and path discovery precede the request: failures here are safe reads.
    const path = await this.tablePath();
    try {
      return this.loaded(await this.json(path, update));
    } catch (error) {
      if (
        error instanceof IcebergCatalogConflictError ||
        error instanceof IcebergCommitUnknownError
      )
        throw error;
      throw new IcebergCommitUnknownError('Iceberg commit response must be reconciled');
    }
  }
}

export async function prepareScheduledTable(
  options: IcebergRestCatalogOptions & {
    storageGeneration: string;
    schemaDigest: string;
  }
): Promise<IcebergLoadedTable> {
  const catalog = new IcebergRestCatalog(options);
  return catalog.prepareScheduledTable(options.storageGeneration, options.schemaDigest);
}
