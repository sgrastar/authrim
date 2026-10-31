import type { stageSnapshotForAppend } from 'icebird/src/write/stage.js';

export type IcebergTableMetadata = Parameters<typeof stageSnapshotForAppend>[0]['metadata'];
export type IcebergStagedUpdate = Awaited<ReturnType<typeof stageSnapshotForAppend>>;
export type IcebergCommit = {
  requirements: IcebergStagedUpdate['requirements'];
  // The REST specification includes remove-snapshot-ref, which icebird 0.9.2
  // accepts at runtime but omits from its TableUpdate declaration.
  updates: (
    | IcebergStagedUpdate['updates'][number]
    | { action: 'remove-snapshot-ref'; 'ref-name': string }
  )[];
};
export interface IcebergLoadedTable {
  metadata: IcebergTableMetadata;
  metadataLocation: string;
}
export interface IcebergCatalogPort {
  loadTable(): Promise<IcebergLoadedTable>;
  commit(update: IcebergCommit): Promise<IcebergLoadedTable>;
}
export class IcebergCatalogConflictError extends Error {}
export class IcebergCommitUnknownError extends Error {}
export class IcebergBatchCollisionError extends Error {}
export class IcebergBudgetError extends Error {}

/** Conditional put must never replace an existing object. */
export interface IcebergObjectStore {
  read(path: string, maximumBytes: number): Promise<Uint8Array>;
  size?(path: string): Promise<number>;
  readRange?(path: string, offset: number, length: number): Promise<Uint8Array>;
  putImmutable(path: string, bytes: Uint8Array, identity: string): Promise<void>;
}
