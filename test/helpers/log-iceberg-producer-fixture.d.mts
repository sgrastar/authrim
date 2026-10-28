import type { DatabaseAdapter } from '../../packages/ar-lib-core/dist/db/index.js';
import type {
  LogIcebergConfig,
  LogIcebergRemoteConfig,
} from '../../packages/ar-lib-core/dist/services/log-iceberg-config.js';
import type { LogIcebergRuntimeEnv } from '../../packages/ar-lib-core/dist/services/log-iceberg-runtime.js';
import type { CoreLogPublicationSource } from '../../packages/ar-lib-core/dist/services/log-iceberg-core-publication.js';
import type { SqlLogIcebergRecordStore } from '../../packages/ar-lib-core/dist/services/log-iceberg-store.js';
import type { LogArchiveRecord } from '../../packages/ar-lib-logging/dist/iceberg/schema.js';
interface FixtureSqlite {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: unknown[]): { changes: number | bigint };
    get(...values: unknown[]): Record<string, string | number | null> | undefined;
    all(...values: unknown[]): Array<Record<string, string | number | null>>;
  };
  close(): void;
}
export function logProducerFixture(
  mode: 'scheduled' | 'pipeline',
  options?: { separateAdmin?: boolean; corePublicationAdapter?: DatabaseAdapter; tenantId?: string }
): Promise<{
  db: FixtureSqlite;
  adapter: DatabaseAdapter;
  adminDb: FixtureSqlite;
  adminAdapter: DatabaseAdapter;
  staging: SqlLogIcebergRecordStore;
  keys: { rootKeyHex: string; contentHmacKeyHex: string; keyVersion: number };
  config: LogIcebergConfig;
  env: LogIcebergRuntimeEnv;
  publicationSource: CoreLogPublicationSource;
  now: number;
  close: () => void;
  objects: Map<string, { text: string; metadata: Record<string, string> }>;
  queueMessages: unknown[];
  streamRecords: LogArchiveRecord[];
  rows(
    sourceDataset: string,
    tenantId?: string
  ): Promise<Array<Record<string, string | number | null>>>;
}>;

import type {
  IcebergCatalogPort,
  IcebergCommit,
  IcebergTableMetadata,
  IcebergObjectStore,
} from '../../packages/ar-lib-logging/dist/iceberg/index.js';
export function icebergSnapshotMetadata(pipeline?: boolean): IcebergTableMetadata;
export function icebergSnapshotCoreFixture(): { db: FixtureSqlite; adapter: DatabaseAdapter };
export function icebergSnapshotFixture(): Promise<{
  db: FixtureSqlite;
  adapter: DatabaseAdapter;
  config: LogIcebergRemoteConfig;
  now: number;
  keys: { rootKeyHex: string; contentHmacKeyHex: string; keyVersion: number };
  staging: SqlLogIcebergRecordStore;
  catalog: IcebergCatalogPort & {
    metadata: IcebergTableMetadata;
    beforeCommit?: (() => Promise<void>) | undefined;
    afterCommit?: (() => Promise<void>) | undefined;
  };
  store: IcebergObjectStore & { objects: Map<string, { bytes: Uint8Array; identity: string }> };
  record(
    id?: string,
    options?: {
      tenantId?: string;
      tenantKey?: string;
      sourceDataset?: string;
      expiresAt?: number | null;
      subjectId?: string;
      logType?: string;
      row?: Record<string, string | number | null>;
      protectedDetail?: Record<string, unknown>;
    }
  ): Promise<LogArchiveRecord>;
}>;
