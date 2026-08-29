import { readResponseTextWithLimit, safeFetch } from '../../utils/url-security';
import {
  createWorkerSettingsFormData,
  selectCloudflareControlToken,
  type CloudflareControlOperation,
  type CloudflareControlTokens,
  type CloudflareWorkerSettings,
} from './cloudflare-worker-settings';

const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
const CLOUDFLARE_API_PREFIX = '/client/v4/accounts';
const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const JSON_REQUEST_LIMIT_BYTES = 4 * 1024 * 1024;
const D1_LIST_PAGE_SIZE = 1_000;
const D1_LIST_MAX_PAGES = 1_000;
const D1_LOCATION_HINTS = new Set(['wnam', 'enam', 'weur', 'eeur', 'apac', 'oc']);
const D1_JURISDICTIONS = new Set(['eu', 'fedramp']);

export interface CloudflareApiErrorDetail {
  code?: number;
  message?: string;
}

interface CloudflareApiEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: CloudflareApiErrorDetail[];
  messages?: CloudflareApiErrorDetail[];
  result_info?: {
    page?: number;
    per_page?: number;
    count?: number;
    total_count?: number;
    total_pages?: number;
  };
}

interface CloudflareApiResult<T> {
  result: T;
  resultInfo: CloudflareApiEnvelope<T>['result_info'];
}

export interface CloudflareD1Database {
  uuid: string;
  name: string;
  created_at?: string;
  file_size?: number;
  num_tables?: number;
  jurisdiction?: string;
  version?: string;
  read_replication?: { mode: 'auto' | 'disabled' };
}

export interface CloudflareD1QueryResult {
  success?: boolean;
  results?: unknown[];
  meta?: Record<string, unknown>;
}

export interface CloudflareD1Query {
  sql: string;
  params?: unknown[];
}

export interface CloudflareD1RawResult {
  success?: boolean;
  results?: { columns?: string[]; rows?: unknown[][] };
  meta?: Record<string, unknown>;
}

export interface CloudflareD1ImportResult {
  at_bookmark?: string;
  error?: string;
  filename?: string;
  messages?: string[];
  result?: Record<string, unknown>;
  status?: 'complete' | 'error';
  success?: boolean;
  type?: 'import';
  upload_url?: string;
}

export type CloudflareD1ImportRequest =
  | { action: 'init'; etag: string }
  | { action: 'ingest'; etag: string; filename: string }
  | { action: 'poll'; current_bookmark: string };

export interface CloudflareWorkerVersion {
  id?: string;
  number?: number;
  metadata?: Record<string, unknown>;
}

export interface CloudflareWorkerScript {
  id: string;
  created_on?: string;
  etag?: string;
  modified_on?: string;
  tags?: string[];
}

export interface CloudflareWorkerDeployment {
  id: string;
  created_on: string;
  source: string;
  strategy: 'percentage';
  versions: Array<{ percentage: number; version_id: string }>;
  annotations?: Record<string, unknown>;
}

export interface CloudflareKvNamespace {
  id: string;
  title: string;
}

export interface CloudflareR2Bucket {
  name: string;
  creation_date?: string;
  location?: string;
  jurisdiction?: string;
}

export interface CloudflareWorkersSubdomain {
  subdomain: string;
}

export interface CloudflareWorkerSubdomainState {
  enabled: boolean;
  previews_enabled: boolean;
}

type ControlRequestInit = NonNullable<Parameters<typeof fetch>[1]>;
type ControlHeadersInit = ConstructorParameters<typeof Headers>[0];
type ControlFetch = (url: string, init: ControlRequestInit) => Promise<Response>;

export interface CloudflareControlApiClientOptions {
  accountId: string;
  tokens: CloudflareControlTokens;
  fetcher?: ControlFetch;
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}_required`);
  return normalized;
}

function encodePathComponent(value: string, label: string): string {
  return encodeURIComponent(normalizeRequired(value, label));
}

function serializeJsonBody(body: unknown): string {
  const serialized = JSON.stringify(body);
  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > JSON_REQUEST_LIMIT_BYTES) {
    throw new Error(`cloudflare_api_request_too_large:${size}:${JSON_REQUEST_LIMIT_BYTES}`);
  }
  return serialized;
}

function validateD1CreateInput(input: {
  name: string;
  primary_location_hint?: string;
  jurisdiction?: string;
}): void {
  normalizeRequired(input.name, 'database_name');
  if (
    input.primary_location_hint !== undefined &&
    !D1_LOCATION_HINTS.has(input.primary_location_hint)
  ) {
    throw new Error(`invalid_d1_primary_location_hint:${input.primary_location_hint}`);
  }
  if (input.jurisdiction !== undefined && !D1_JURISDICTIONS.has(input.jurisdiction)) {
    throw new Error(`invalid_d1_jurisdiction:${input.jurisdiction}`);
  }
  if (input.jurisdiction && input.primary_location_hint) {
    throw new Error('d1_jurisdiction_and_location_hint_are_mutually_exclusive');
  }
}

function parseD1ListDatabase(value: unknown): CloudflareD1Database {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('cloudflare_d1_list_invalid_result');
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.uuid !== 'string' ||
    row.uuid.length === 0 ||
    typeof row.name !== 'string' ||
    row.name.length === 0 ||
    (row.created_at !== undefined && typeof row.created_at !== 'string') ||
    (row.file_size !== undefined &&
      (!Number.isSafeInteger(row.file_size) || Number(row.file_size) < 0)) ||
    (row.num_tables !== undefined &&
      (!Number.isSafeInteger(row.num_tables) || Number(row.num_tables) < 0)) ||
    (row.jurisdiction !== undefined && typeof row.jurisdiction !== 'string') ||
    (row.version !== undefined && typeof row.version !== 'string') ||
    (row.read_replication !== undefined &&
      (!row.read_replication ||
        typeof row.read_replication !== 'object' ||
        Array.isArray(row.read_replication) ||
        !['auto', 'disabled'].includes(
          String((row.read_replication as Record<string, unknown>).mode)
        )))
  ) {
    throw new Error('cloudflare_d1_list_invalid_result');
  }
  return {
    uuid: row.uuid,
    name: row.name,
    ...(row.created_at === undefined ? {} : { created_at: row.created_at }),
    ...(row.file_size === undefined ? {} : { file_size: Number(row.file_size) }),
    ...(row.num_tables === undefined ? {} : { num_tables: Number(row.num_tables) }),
    ...(row.jurisdiction === undefined ? {} : { jurisdiction: row.jurisdiction }),
    ...(row.version === undefined ? {} : { version: row.version }),
    ...(row.read_replication === undefined
      ? {}
      : {
          read_replication: {
            mode: (row.read_replication as { mode: 'auto' | 'disabled' }).mode,
          },
        }),
  };
}

export class CloudflareControlApiError extends Error {
  readonly operation: CloudflareControlOperation;
  readonly status: number;
  readonly providerCodes: readonly number[];

  constructor(
    operation: CloudflareControlOperation,
    status: number,
    providerCodes: readonly number[] = []
  ) {
    const codes = providerCodes.length > 0 ? `:${providerCodes.join(',')}` : '';
    super(`cloudflare_api_error:${operation}:${status}${codes}`);
    this.name = 'CloudflareControlApiError';
    this.operation = operation;
    this.status = status;
    this.providerCodes = [...providerCodes];
  }
}

export class CloudflareControlApiClient {
  private readonly accountId: string;
  private readonly tokens: CloudflareControlTokens;
  private readonly fetcher: ControlFetch;

  constructor(options: CloudflareControlApiClientOptions) {
    this.accountId = encodePathComponent(options.accountId, 'cloudflare_account_id');
    this.tokens = { ...options.tokens };
    this.fetcher =
      options.fetcher ??
      ((url, init) =>
        safeFetch(url, {
          ...init,
          maxResponseSize: RESPONSE_LIMIT_BYTES,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }));
  }

  private async requestEnvelope<T>(
    operation: CloudflareControlOperation,
    path: string,
    init: Omit<ControlRequestInit, 'headers'> & { headers?: ControlHeadersInit } = {}
  ): Promise<CloudflareApiResult<T>> {
    const token = selectCloudflareControlToken(operation, this.tokens);
    const url = `${CLOUDFLARE_API_ORIGIN}${CLOUDFLARE_API_PREFIX}/${this.accountId}${path}`;
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);
    const response = await this.fetcher(url, {
      ...init,
      headers,
      redirect: 'error',
    });
    const text = await readResponseTextWithLimit(response, RESPONSE_LIMIT_BYTES);
    let envelope: CloudflareApiEnvelope<T> | null = null;
    try {
      envelope = text ? (JSON.parse(text) as CloudflareApiEnvelope<T>) : null;
    } catch {
      throw new Error(`cloudflare_api_invalid_json:${operation}:${response.status}`);
    }
    if (!response.ok || envelope?.success !== true || envelope.result === undefined) {
      const providerCodes =
        envelope?.errors?.flatMap((error) =>
          typeof error.code === 'number' ? [error.code] : []
        ) ?? [];
      throw new CloudflareControlApiError(operation, response.status, providerCodes);
    }
    return { result: envelope.result, resultInfo: envelope.result_info };
  }

  private async request<T>(
    operation: CloudflareControlOperation,
    path: string,
    init: Omit<ControlRequestInit, 'headers'> & { headers?: ControlHeadersInit } = {}
  ): Promise<T> {
    return (await this.requestEnvelope<T>(operation, path, init)).result;
  }

  private requestJson<T>(
    operation: CloudflareControlOperation,
    path: string,
    method: 'POST' | 'PUT' | 'PATCH',
    body: unknown
  ): Promise<T> {
    return this.request<T>(operation, path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: serializeJsonBody(body),
    });
  }

  async listD1Databases(): Promise<CloudflareD1Database[]> {
    const databases: CloudflareD1Database[] = [];
    const seen = new Map<string, string>();
    for (let page = 1; page <= D1_LIST_MAX_PAGES; page += 1) {
      const { result, resultInfo } = await this.requestEnvelope<unknown>(
        'd1.list',
        `/d1/database?page=${page}&per_page=${D1_LIST_PAGE_SIZE}`
      );
      if (!Array.isArray(result)) throw new Error('cloudflare_d1_list_invalid_result');
      for (const candidate of result) {
        const database = parseD1ListDatabase(candidate);
        const previousName = seen.get(database.uuid);
        if (previousName !== undefined && previousName !== database.name) {
          throw new Error('cloudflare_d1_list_duplicate_conflict');
        }
        if (previousName === undefined) {
          seen.set(database.uuid, database.name);
          databases.push(database);
        }
      }

      const totalPages = resultInfo?.total_pages;
      const totalCount = resultInfo?.total_count;
      const reportedPage = resultInfo?.page;
      const reportedCount = resultInfo?.count;
      const effectivePageSize = resultInfo?.per_page ?? D1_LIST_PAGE_SIZE;
      if (
        (reportedPage !== undefined &&
          (!Number.isSafeInteger(reportedPage) || reportedPage !== page)) ||
        (reportedCount !== undefined &&
          (!Number.isSafeInteger(reportedCount) || reportedCount !== result.length)) ||
        (totalPages !== undefined &&
          (!Number.isSafeInteger(totalPages) ||
            totalPages < 0 ||
            totalPages > D1_LIST_MAX_PAGES)) ||
        (totalCount !== undefined && (!Number.isSafeInteger(totalCount) || totalCount < 0)) ||
        !Number.isSafeInteger(effectivePageSize) ||
        effectivePageSize < 1 ||
        effectivePageSize > D1_LIST_PAGE_SIZE
      ) {
        throw new Error('cloudflare_d1_list_pagination_invalid');
      }
      if (totalCount !== undefined && totalCount < databases.length) {
        throw new Error('cloudflare_d1_list_pagination_invalid');
      }
      if (
        result.length === 0 ||
        (totalPages !== undefined && page >= totalPages) ||
        (totalCount !== undefined && databases.length >= totalCount) ||
        (totalPages === undefined && totalCount === undefined && result.length < effectivePageSize)
      ) {
        return databases;
      }
    }
    throw new Error('cloudflare_d1_list_pagination_limit');
  }

  getD1Database(databaseId: string): Promise<CloudflareD1Database> {
    return this.request('d1.get', `/d1/database/${encodePathComponent(databaseId, 'database_id')}`);
  }

  createD1Database(input: {
    name: string;
    primary_location_hint?: string;
    jurisdiction?: string;
  }): Promise<CloudflareD1Database> {
    validateD1CreateInput(input);
    return this.requestJson('d1.create', '/d1/database', 'POST', input);
  }

  updateD1Database(
    databaseId: string,
    input: { read_replication: { mode: 'auto' | 'disabled' } }
  ): Promise<CloudflareD1Database> {
    return this.requestJson(
      'd1.update',
      `/d1/database/${encodePathComponent(databaseId, 'database_id')}`,
      'PUT',
      input
    );
  }

  async deleteD1Database(databaseId: string): Promise<void> {
    await this.request(
      'd1.delete',
      `/d1/database/${encodePathComponent(databaseId, 'database_id')}`,
      { method: 'DELETE' }
    );
  }

  queryD1(
    databaseId: string,
    sql: string,
    params: unknown[] = []
  ): Promise<CloudflareD1QueryResult[]> {
    return this.requestJson(
      'd1.query',
      `/d1/database/${encodePathComponent(databaseId, 'database_id')}/query`,
      'POST',
      { sql, params }
    );
  }

  queryD1Batch(
    databaseId: string,
    batch: readonly CloudflareD1Query[]
  ): Promise<CloudflareD1QueryResult[]> {
    if (batch.length === 0) throw new Error('cloudflare_d1_query_batch_empty');
    return this.requestJson(
      'd1.query',
      `/d1/database/${encodePathComponent(databaseId, 'database_id')}/query`,
      'POST',
      {
        batch: batch.map((query) => ({
          sql: normalizeRequired(query.sql, 'd1_query_sql'),
          ...(query.params === undefined ? {} : { params: [...query.params] }),
        })),
      }
    );
  }

  rawD1(databaseId: string, sql: string, params: unknown[] = []): Promise<CloudflareD1RawResult[]> {
    return this.requestJson(
      'd1.raw',
      `/d1/database/${encodePathComponent(databaseId, 'database_id')}/raw`,
      'POST',
      { sql, params }
    );
  }

  importD1(
    databaseId: string,
    input: CloudflareD1ImportRequest
  ): Promise<CloudflareD1ImportResult> {
    return this.requestJson(
      'd1.import',
      `/d1/database/${encodePathComponent(databaseId, 'database_id')}/import`,
      'POST',
      input
    );
  }

  getWorkerSettings(scriptName: string): Promise<CloudflareWorkerSettings> {
    return this.request(
      'workers.settings.get',
      `/workers/scripts/${encodePathComponent(scriptName, 'script_name')}/settings`
    );
  }

  async listWorkerScripts(): Promise<CloudflareWorkerScript[]> {
    const result = await this.request<CloudflareWorkerScript[]>(
      'workers.script.list',
      '/workers/scripts'
    );
    if (!Array.isArray(result)) {
      throw new Error('cloudflare_workers_script_list_invalid_result');
    }
    return result.filter(
      (script): script is CloudflareWorkerScript =>
        !!script && typeof script.id === 'string' && script.id.trim().length > 0
    );
  }

  getWorkersSubdomain(): Promise<CloudflareWorkersSubdomain> {
    return this.request('workers.subdomain.get', '/workers/subdomain');
  }

  getWorkerSubdomain(scriptName: string): Promise<CloudflareWorkerSubdomainState> {
    return this.request(
      'workers.script.subdomain.get',
      `/workers/scripts/${encodePathComponent(scriptName, 'script_name')}/subdomain`
    );
  }

  patchWorkerSettings(
    scriptName: string,
    settings: CloudflareWorkerSettings
  ): Promise<CloudflareWorkerSettings> {
    return this.request(
      'workers.settings.patch',
      `/workers/scripts/${encodePathComponent(scriptName, 'script_name')}/settings`,
      { method: 'PATCH', body: createWorkerSettingsFormData(settings) }
    );
  }

  async deleteWorkerScript(scriptName: string): Promise<void> {
    await this.request(
      'workers.script.delete',
      `/workers/scripts/${encodePathComponent(scriptName, 'script_name')}`,
      { method: 'DELETE' }
    );
  }

  async listWorkerVersions(scriptName: string): Promise<CloudflareWorkerVersion[]> {
    const result = await this.request<{ items?: CloudflareWorkerVersion[] }>(
      'workers.version.list',
      `/workers/scripts/${encodePathComponent(scriptName, 'script_name')}/versions?deployable=true`
    );
    return result.items ?? [];
  }

  async listWorkerDeployments(scriptName: string): Promise<CloudflareWorkerDeployment[]> {
    const result = await this.request<{ deployments: CloudflareWorkerDeployment[] }>(
      'workers.deployment.list',
      `/workers/scripts/${encodePathComponent(scriptName, 'script_name')}/deployments`
    );
    return result.deployments;
  }

  createWorkerDeployment(
    scriptName: string,
    versionId: string,
    message: string
  ): Promise<CloudflareWorkerDeployment> {
    return this.requestJson(
      'workers.deployment.create',
      `/workers/scripts/${encodePathComponent(scriptName, 'script_name')}/deployments`,
      'POST',
      {
        strategy: 'percentage',
        versions: [{ version_id: normalizeRequired(versionId, 'version_id'), percentage: 100 }],
        annotations: { 'workers/message': message.slice(0, 1000) },
      }
    );
  }

  listKvNamespaces(): Promise<CloudflareKvNamespace[]> {
    return this.request('kv.namespace.list', '/storage/kv/namespaces?per_page=1000');
  }

  createKvNamespace(title: string): Promise<CloudflareKvNamespace> {
    return this.requestJson('kv.namespace.create', '/storage/kv/namespaces', 'POST', { title });
  }

  async deleteKvNamespace(namespaceId: string): Promise<void> {
    await this.request(
      'kv.namespace.delete',
      `/storage/kv/namespaces/${encodePathComponent(namespaceId, 'namespace_id')}`,
      { method: 'DELETE' }
    );
  }

  async listR2Buckets(): Promise<CloudflareR2Bucket[]> {
    const result = await this.request<{ buckets?: CloudflareR2Bucket[] }>(
      'r2.bucket.list',
      '/r2/buckets?per_page=1000'
    );
    return result.buckets ?? [];
  }

  createR2Bucket(name: string): Promise<CloudflareR2Bucket> {
    return this.requestJson('r2.bucket.create', '/r2/buckets', 'POST', { name });
  }

  async deleteR2Bucket(name: string): Promise<void> {
    await this.request(
      'r2.bucket.delete',
      `/r2/buckets/${encodePathComponent(name, 'bucket_name')}`,
      { method: 'DELETE' }
    );
  }
}
