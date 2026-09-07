import {
  CloudflareControlApiClient,
  type CloudflareControlApiClientOptions,
} from '@authrim/ar-lib-core/control-plane';
import type { ControlEnv } from './types';

export type ControlD1ApiClient = Pick<
  CloudflareControlApiClient,
  | 'listD1Databases'
  | 'getD1Database'
  | 'createD1Database'
  | 'updateD1Database'
  | 'deleteD1Database'
  | 'queryD1'
  | 'queryD1Batch'
  | 'rawD1'
  | 'importD1'
>;

export type ControlWorkersApiClient = Pick<
  CloudflareControlApiClient,
  | 'getWorkerSettings'
  | 'listWorkerScripts'
  | 'patchWorkerSettings'
  | 'deleteWorkerScript'
  | 'listWorkerVersions'
  | 'listWorkerDeployments'
  | 'createWorkerDeployment'
>;

export type ControlKvApiClient = Pick<
  CloudflareControlApiClient,
  'listKvNamespaces' | 'createKvNamespace' | 'deleteKvNamespace'
>;

export type ControlR2ApiClient = Pick<
  CloudflareControlApiClient,
  'listR2Buckets' | 'createR2Bucket' | 'deleteR2Bucket'
>;

export interface ControlApiClients {
  d1: ControlD1ApiClient;
  workers: ControlWorkersApiClient;
  kv: ControlKvApiClient;
  r2: ControlR2ApiClient;
}

export function createControlApiClients(
  env: ControlEnv,
  options: { fetcher?: CloudflareControlApiClientOptions['fetcher'] } = {}
): ControlApiClients {
  const common = { accountId: env.CLOUDFLARE_ACCOUNT_ID, fetcher: options.fetcher };
  return {
    d1: new CloudflareControlApiClient({
      ...common,
      tokens: { d1: env.CLOUDFLARE_D1_API_TOKEN },
    }),
    workers: new CloudflareControlApiClient({
      ...common,
      tokens: { workers: env.CLOUDFLARE_WORKERS_API_TOKEN },
    }),
    kv: new CloudflareControlApiClient({
      ...common,
      tokens: { kv: env.CLOUDFLARE_KV_API_TOKEN },
    }),
    r2: new CloudflareControlApiClient({
      ...common,
      tokens: { r2: env.CLOUDFLARE_R2_API_TOKEN },
    }),
  };
}
