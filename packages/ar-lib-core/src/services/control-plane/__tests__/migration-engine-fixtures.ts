import {
  ApiMigrationEngine,
  type MigrationD1Executor,
  type MigrationD1Query,
} from '../migration-engine.js';
import type { CloudflareD1QueryResult } from '../cloudflare-control-api-client.js';
import {
  MigrationReleaseArtifactReader,
  type LoadedMigrationRelease,
  type MigrationArtifactFile,
  type MigrationReleasePin,
  type ReleaseArtifactStore,
} from '../release-artifact.js';
import { vi } from 'vitest';

export const DB = 'db-1';
export const MIGRATIONS = 'authrim_migrations';
export const STATE = 'tenant_database_migration_state';

export function checksum(n: number): string {
  return n.toString(16).padStart(64, '0');
}

export function file(
  path: string,
  n: number,
  sql = `SELECT ${n};`,
  supersedes?: Array<{ path: string; checksum: string }>
): MigrationArtifactFile {
  return { path, checksum: checksum(n), sql, ...(supersedes ? { supersedes } : {}) };
}

export const PIN: MigrationReleasePin = {
  environmentId: 'env-1',
  streamId: 'core-d1',
  releaseId: '1.2.3',
  manifestDigest: 'd'.repeat(64),
  manifestObjectKey: `releases/1.2.3/${'d'.repeat(64)}/manifest.json`,
};

export function release(
  files: MigrationArtifactFile[],
  extra: Partial<LoadedMigrationRelease> = {}
): LoadedMigrationRelease {
  return {
    pin: PIN,
    productVersion: '1.2.3',
    rollout: {
      databaseExecution: 'setup_then_control',
      workerActivation: 'after_required_databases',
      adminMutationMode: 'read_only',
    },
    files,
    knownHistory: files.map((f) => ({ path: f.path, checksum: f.checksum })),
    ...extra,
  };
}

export type BatchKind = 'infra' | 'migration' | 'sentinel';
export type BatchOutcome = 'throw' | 'unsuccess' | 'short';

export interface BatchFault {
  kind: BatchKind;
  /** Which occurrence (0-based) of that kind of batch fails. */
  occurrence?: number;
  outcome: BatchOutcome;
  /** Whether the write is applied although the caller observes a failure (lost response). */
  apply: boolean;
}

export class FakeD1 implements MigrationD1Executor {
  infra: string[] = [MIGRATIONS, STATE];
  history: Array<Record<string, unknown>> = [];
  sentinel: Record<string, unknown> | undefined;
  queries: Array<{ databaseId: string; sql: string; params?: unknown[] }> = [];
  batches: Array<{ databaseId: string; batch: readonly MigrationD1Query[] }> = [];
  faults: BatchFault[] = [];
  queryFault: ((sql: string, index: number) => CloudflareD1QueryResult[] | undefined) | undefined;
  private readonly seen: Record<BatchKind, number> = { infra: 0, migration: 0, sentinel: 0 };
  private queryIndex = 0;

  addHistory(path: string, n: number, appliedAt = 1): void {
    this.history.push({ filename: path, checksum: checksum(n), applied_at: appliedAt });
  }

  setSentinel(overrides: Record<string, unknown> = {}): void {
    this.sentinel = {
      stream_id: PIN.streamId,
      release_id: PIN.releaseId,
      manifest_digest: PIN.manifestDigest,
      applied_file_count: 1,
      state: 'ready',
      last_filename: null,
      ...overrides,
    };
  }

  queryD1(databaseId: string, sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult[]> {
    this.queries.push({ databaseId, sql, ...(params ? { params } : {}) });
    const injected = this.queryFault?.(sql, this.queryIndex++);
    if (injected) return Promise.resolve(injected);
    if (sql.includes('sqlite_master')) {
      return Promise.resolve([{ success: true, results: this.infra.map((name) => ({ name })) }]);
    }
    if (sql.includes('FROM authrim_migrations')) {
      return Promise.resolve([{ success: true, results: this.history.map((row) => ({ ...row })) }]);
    }
    if (sql.includes('FROM tenant_database_migration_state')) {
      return Promise.resolve([
        { success: true, results: this.sentinel ? [{ ...this.sentinel }] : [] },
      ]);
    }
    return Promise.resolve([{ success: true, results: [] }]);
  }

  queryD1Batch(
    databaseId: string,
    batch: readonly MigrationD1Query[]
  ): Promise<CloudflareD1QueryResult[]> {
    this.batches.push({ databaseId, batch });
    const first = batch[0]?.sql ?? '';
    const kind: BatchKind = first.startsWith('CREATE TABLE')
      ? 'infra'
      : first.includes(`INTO ${STATE}`)
        ? 'sentinel'
        : 'migration';
    const occurrence = this.seen[kind]++;
    const fault = this.faults.find(
      (candidate) => candidate.kind === kind && (candidate.occurrence ?? 0) === occurrence
    );
    if (!fault || fault.apply) this.applyBatch(batch);
    const ok = batch.map(() => ({ success: true }));
    if (!fault) return Promise.resolve(ok);
    if (fault.outcome === 'throw') return Promise.reject(new Error('d1_transport_error'));
    if (fault.outcome === 'short') return Promise.resolve(ok.slice(1));
    return Promise.resolve(ok.map((r, i) => (i === ok.length - 1 ? { success: false } : r)));
  }

  private applyBatch(batch: readonly MigrationD1Query[]): void {
    for (const query of batch) {
      const params = query.params ?? [];
      if (query.sql.startsWith('CREATE TABLE')) {
        this.infra = [MIGRATIONS, STATE];
      } else if (query.sql.includes(`INSERT INTO ${MIGRATIONS}`)) {
        this.history.push({
          filename: params[0],
          checksum: params[1],
          applied_at: params[2],
        });
      } else if (query.sql.includes(`INSERT INTO ${STATE}`)) {
        this.sentinel = {
          stream_id: params[0],
          release_id: params[1],
          manifest_digest: params[2],
          applied_file_count: params[3],
          state: 'ready',
          last_filename: params[4],
        };
      }
    }
  }
}

export function makeEngine(
  loaded: LoadedMigrationRelease,
  d1: FakeD1,
  now: () => number = () => 5000
): ApiMigrationEngine {
  const emptyStore: ReleaseArtifactStore = { get: () => Promise.resolve(null) };
  const reader = new MigrationReleaseArtifactReader(emptyStore);
  vi.spyOn(reader, 'load').mockResolvedValue(loaded);
  return new ApiMigrationEngine(reader, d1, now);
}

export async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  return 'no_error';
}
