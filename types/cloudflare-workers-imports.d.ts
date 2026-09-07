// @cloudflare/workers-types v5 publishes both index.ts and index.d.ts without a package-level
// `types` entry. With TypeScript's bundler resolution, type-only package imports otherwise resolve
// to the 17,000+ line index.ts source and make declaration builds pathologically slow. The ambient
// runtime declarations still come from compilerOptions.types; this module only exposes the subset
// Authrim imports explicitly without compiling the generated TypeScript source.

type AuthrimWorkersD1Database = D1Database;
type AuthrimWorkersD1DatabaseSession = D1DatabaseSession;
type AuthrimWorkersD1PreparedStatement = D1PreparedStatement;
type AuthrimWorkersD1Result<T = unknown> = D1Result<T>;
type AuthrimWorkersD1SessionBookmark = D1SessionBookmark;
type AuthrimWorkersD1SessionConstraint = D1SessionConstraint;
type AuthrimWorkersDurableObjectNamespace<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> = DurableObjectNamespace<T>;
type AuthrimWorkersDurableObjectState<Props = unknown> = DurableObjectState<Props>;
type AuthrimWorkersDurableObjectStorage = DurableObjectStorage;
type AuthrimWorkersDurableObjectStub<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
> = DurableObjectStub<T>;
type AuthrimWorkersExecutionContext<Props = unknown> = ExecutionContext<Props>;
type AuthrimWorkersFetcher<
  T extends Rpc.EntrypointBranded | undefined = undefined,
  Reserved extends string = never,
> = Fetcher<T, Reserved>;
type AuthrimWorkersKVNamespace<Key extends string = string> = KVNamespace<Key>;
type AuthrimWorkersMessage<Body = unknown> = Message<Body>;
type AuthrimWorkersMessageBatch<Body = unknown> = MessageBatch<Body>;
type AuthrimWorkersQueue<Body = unknown> = Queue<Body>;
type AuthrimWorkersR2Bucket = R2Bucket;
type AuthrimWorkersSqlStorageCursor<
  T extends Record<string, SqlStorageValue>,
> = SqlStorageCursor<T>;
type AuthrimWorkersSqlStorageValue = SqlStorageValue;
type AuthrimWorkersWorkerLoader = WorkerLoader;
type AuthrimWorkersWorkerLoaderWorkerCode = WorkerLoaderWorkerCode;
type AuthrimWorkersWorkerVersionMetadata = WorkerVersionMetadata;

declare module '@cloudflare/workers-types' {
  export type D1Database = AuthrimWorkersD1Database;
  export type D1DatabaseSession = AuthrimWorkersD1DatabaseSession;
  export type D1PreparedStatement = AuthrimWorkersD1PreparedStatement;
  export type D1Result<T = unknown> = AuthrimWorkersD1Result<T>;
  export type D1SessionBookmark = AuthrimWorkersD1SessionBookmark;
  export type D1SessionConstraint = AuthrimWorkersD1SessionConstraint;
  export type DurableObjectNamespace<
    T extends Rpc.DurableObjectBranded | undefined = undefined,
  > = AuthrimWorkersDurableObjectNamespace<T>;
  export type DurableObjectState<Props = unknown> = AuthrimWorkersDurableObjectState<Props>;
  export type DurableObjectStorage = AuthrimWorkersDurableObjectStorage;
  export type DurableObjectStub<
    T extends Rpc.DurableObjectBranded | undefined = undefined,
  > = AuthrimWorkersDurableObjectStub<T>;
  export type ExecutionContext<Props = unknown> = AuthrimWorkersExecutionContext<Props>;
  export type Fetcher<
    T extends Rpc.EntrypointBranded | undefined = undefined,
    Reserved extends string = never,
  > = AuthrimWorkersFetcher<T, Reserved>;
  export type KVNamespace<Key extends string = string> = AuthrimWorkersKVNamespace<Key>;
  export type Message<Body = unknown> = AuthrimWorkersMessage<Body>;
  export type MessageBatch<Body = unknown> = AuthrimWorkersMessageBatch<Body>;
  export type Queue<Body = unknown> = AuthrimWorkersQueue<Body>;
  export type R2Bucket = AuthrimWorkersR2Bucket;
  export type SqlStorageCursor<
    T extends Record<string, SqlStorageValue>,
  > = AuthrimWorkersSqlStorageCursor<T>;
  export type SqlStorageValue = AuthrimWorkersSqlStorageValue;
  export type WorkerLoader = AuthrimWorkersWorkerLoader;
  export type WorkerLoaderWorkerCode = AuthrimWorkersWorkerLoaderWorkerCode;
  export type WorkerVersionMetadata = AuthrimWorkersWorkerVersionMetadata;
}
