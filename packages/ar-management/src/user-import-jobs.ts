import {
  decryptObjectArtifact,
  type DatabaseAdapter,
  type Env,
  encryptObjectArtifact,
  CanonicalRuntimeUserStore,
  ensureDatabaseAdapter,
  generateUserIdFromSettings,
  invalidateUserCache,
  persistCustomClaimWrite,
  resolveAccountDataContextByIdentifier,
  resolveCustomClaimRuntimeSourcesFromEnv,
  resolveTenantMetadataContext,
  syncUserLifecycleState,
  transitionAccountAuthenticationState,
  validateCustomClaimWrite,
} from '@authrim/ar-lib-core';
import { loadCatalogObjectJson } from '@authrim/ar-lib-core/services/object-artifact-store';
import {
  ADMIN_USER_CREATE_RESERVED_FIELDS,
  extractCustomClaimInput,
  VALID_USER_LIFECYCLE_STATES,
} from './admin-shared';
import { materializeEncryptedObjectArtifact } from './object-artifact-materialization';
import {
  AccountCreationOperationRepository,
  hashAccountCreationRequest,
} from './account-creation-operation';
import { executeDurableInitialAccountDirectoryWrite } from './account-directory-producer';
import { writeCanonicalAccountAuthoritative } from './account-authoritative-write';

export const USER_IMPORT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const USER_IMPORT_BATCH_SIZE = 100;

const USER_IMPORT_MAX_RESULT_ARTIFACT_BYTES = 10 * 1024 * 1024;
const USER_IMPORT_MAX_FAILURE_DETAILS = 1000;
const USER_IMPORT_MAX_LOG_ENTRIES = 2000;
const IMPORT_RESULT_FAILURE_PREVIEW_LIMIT = 25;
const IMPORT_RESULT_LOG_PREVIEW_LIMIT = 40;
const ENCRYPTED_OBJECT_CONTENT_TYPE = 'application/vnd.authrim.object-envelope+json';

const USER_IMPORT_DEFAULT_HEADERS = [
  'email',
  'name',
  'given_name',
  'family_name',
  'nickname',
  'preferred_username',
  'picture',
  'email_verified',
  'phone_number',
  'phone_number_verified',
  'user_type',
  'status',
  'lifecycle_state',
] as const;

const USER_IMPORT_ALLOWED_STATUSES = new Set(['active', 'suspended', 'locked']);
const USER_IMPORT_ALLOWED_TYPES = new Set(['end_user', 'admin', 'm2m', 'anonymous']);
const USER_IMPORT_FORBIDDEN_CREDENTIAL_FIELDS = new Set([
  'password',
  'password_hash',
  'password_hash_envelope',
  'legacy_password_hash',
  'legacy_hash',
  'hash_algorithm',
  'salt',
]);

async function readR2ObjectTextWithLimit(object: R2ObjectBody, maxBytes: number): Promise<string> {
  if (typeof object.size === 'number' && object.size > maxBytes) {
    throw new Error(`Object exceeds maximum size: ${object.size} > ${maxBytes} bytes`);
  }
  if (!object.body) {
    const text = await object.text();
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      throw new Error(`Object exceeds maximum size: ${byteLength} > ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`Object exceeds maximum size: ${totalBytes} > ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

const IMPORT_RESERVED_FIELDS = new Set<string>([
  ...ADMIN_USER_CREATE_RESERVED_FIELDS,
  'status',
  'lifecycle_state',
]);

interface JobProgressState {
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  percentage: number;
  current_item?: string;
  stage: 'queued' | 'processing' | 'completed' | 'validation';
}

export interface ImportJobFailure {
  row?: number;
  error_code: string;
  field?: string;
  message?: string;
  email?: string;
}

export interface ImportJobLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  row?: number;
  email?: string;
}

interface ImportJobArtifact {
  job_id: string;
  tenant_id: string;
  input_r2_key: string;
  options: UserImportJobOptions;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  failures: ImportJobFailure[];
  logs: ImportJobLogEntry[];
  updated_at: string;
  completed_at?: string;
}

interface UserImportJobOptions {
  skip_header: boolean;
  on_duplicate: 'update' | 'skip' | 'error';
  validate_only: boolean;
}

interface UserImportJobRow {
  id: string;
  tenant_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'partial_failure';
  progress: string | null;
  config: string | null;
  input_r2_key: string | null;
  result_r2_key: string | null;
  object_catalog_id: string | null;
  created_at: number;
}

interface ImportedUserRowInput {
  email: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  preferred_username?: string;
  picture?: string;
  email_verified?: boolean;
  phone_number?: string;
  phone_number_verified?: boolean;
  user_type?: 'end_user' | 'admin' | 'm2m' | 'anonymous';
  status?: 'active' | 'suspended' | 'locked';
  lifecycle_state?: string;
  [key: string]: string | boolean | number | null | undefined;
}

interface ImportedUserRowResult {
  outcome: 'created' | 'updated' | 'skipped' | 'validated';
  userId?: string;
  message: string;
}

interface UserImportRuntime {
  tenantId: string;
  env: Env;
  schemaDb: Awaited<ReturnType<typeof resolveTenantMetadataContext>>['coreDb'];
}

interface UserImportAccountRuntime extends UserImportRuntime {
  coreAdapter: DatabaseAdapter;
  piiAdapter: DatabaseAdapter;
  runtimeUsers: CanonicalRuntimeUserStore;
  customClaimSources: {
    schemaDb: Awaited<ReturnType<typeof resolveTenantMetadataContext>>['coreDb'];
    nonPiiDb: Awaited<ReturnType<typeof resolveTenantMetadataContext>>['coreDb'];
    piiDb: Awaited<ReturnType<typeof resolveTenantMetadataContext>>['coreDb'];
  };
}

interface CsvRecordParseResult {
  records: Array<Record<string, string>>;
  headers: string[];
}

function computeProgress(
  progress: Omit<JobProgressState, 'percentage'> & Partial<Pick<JobProgressState, 'percentage'>>
): JobProgressState {
  const percentage =
    progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0;

  return {
    total: progress.total,
    processed: progress.processed,
    succeeded: progress.succeeded,
    failed: progress.failed,
    skipped: progress.skipped,
    percentage,
    current_item: progress.current_item,
    stage: progress.stage,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function toPreviewFailures(failures: ImportJobFailure[]): ImportJobFailure[] {
  return failures.slice(0, IMPORT_RESULT_FAILURE_PREVIEW_LIMIT);
}

function toPreviewLogs(logs: ImportJobLogEntry[]): ImportJobLogEntry[] {
  return logs.slice(-IMPORT_RESULT_LOG_PREVIEW_LIMIT);
}

export function sanitizeUserImportFilename(filename: string): string {
  const trimmed = filename.trim();
  const fallback = 'users-import.csv';
  if (!trimmed) {
    return fallback;
  }

  const safe = trimmed
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return safe || fallback;
}

export function buildUserImportUploadKey(
  tenantId: string,
  uploadId: string,
  filename: string
): string {
  return `imports/${tenantId}/${uploadId}/${sanitizeUserImportFilename(filename)}`;
}

export function buildUserImportResultKey(tenantId: string, jobId: string): string {
  return `exports/${tenantId}/users-import/${jobId}/result.json`;
}

export function assertUserImportJobStorageKeys(job: {
  id: string;
  tenant_id: string;
  input_r2_key: string | null;
  result_r2_key?: string | null;
}): asserts job is {
  id: string;
  tenant_id: string;
  input_r2_key: string;
  result_r2_key?: string | null;
} {
  if (!job.input_r2_key) {
    throw new Error('input_r2_key is missing');
  }

  if (!job.input_r2_key.startsWith(`imports/${job.tenant_id}/`)) {
    throw new Error('input_r2_key does not belong to the job tenant');
  }

  if (job.result_r2_key && !job.result_r2_key.startsWith(`exports/${job.tenant_id}/`)) {
    throw new Error('result_r2_key does not belong to the job tenant');
  }
}

export function parseUserImportCsv(
  csvText: string,
  options: Pick<UserImportJobOptions, 'skip_header'>
): CsvRecordParseResult {
  const rows = parseCsvRows(csvText).filter((row) => row.some((cell) => cell.trim().length > 0));
  if (rows.length === 0) {
    return { records: [], headers: [] };
  }

  let headers: string[];
  let dataRows: string[][];

  if (options.skip_header) {
    headers = rows[0].map((value, index) => normalizeHeader(value, index));
    dataRows = rows.slice(1);
  } else {
    headers = rows[0].map(
      (_, index) => USER_IMPORT_DEFAULT_HEADERS[index] ?? `column_${index + 1}`
    );
    dataRows = rows;
  }

  const records = dataRows.map((row) => {
    const record: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      record[headers[index]] = row[index] ?? '';
    }
    return record;
  });

  return { records, headers };
}

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  const text = csvText.replace(/^\uFEFF/, '');

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          currentCell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentCell);
      currentCell = '';
      continue;
    }

    if (char === '\r') {
      if (next === '\n') {
        index += 1;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      continue;
    }

    if (char === '\n') {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

function normalizeHeader(value: string, index: number): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || `column_${index + 1}`;
}

function parseImportCellValue(value: string): string | boolean | number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed === 'null') {
    return null;
  }

  if (trimmed === 'true') {
    return true;
  }

  if (trimmed === 'false') {
    return false;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed) as string | boolean | number | null;
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}

function parseOptionalBoolean(
  value: string | undefined,
  field: 'email_verified' | 'phone_number_verified'
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value for ${field}: ${value}`);
}

export function normalizeImportRecord(record: Record<string, string>): ImportedUserRowInput {
  const email = record.email?.trim();
  if (!email) {
    throw new Error('Email is required');
  }

  for (const [key, value] of Object.entries(record)) {
    if (USER_IMPORT_FORBIDDEN_CREDENTIAL_FIELDS.has(key.trim().toLowerCase())) {
      throw new Error(`Unsupported credential field in user import: ${key}`);
    }
    if (key.trim().toLowerCase().startsWith('password_') && value.trim()) {
      throw new Error(`Unsupported credential field in user import: ${key}`);
    }
  }

  const result: ImportedUserRowInput = {
    email,
  };

  const reservedStringFields = [
    'name',
    'given_name',
    'family_name',
    'nickname',
    'preferred_username',
    'picture',
    'phone_number',
  ] as const;

  for (const field of reservedStringFields) {
    const raw = record[field]?.trim();
    if (raw) {
      result[field] = raw;
    }
  }

  result.email_verified = parseOptionalBoolean(record.email_verified, 'email_verified');
  result.phone_number_verified = parseOptionalBoolean(
    record.phone_number_verified,
    'phone_number_verified'
  );

  const userType = record.user_type?.trim() as ImportedUserRowInput['user_type'] | undefined;
  if (userType) {
    if (!USER_IMPORT_ALLOWED_TYPES.has(userType)) {
      throw new Error(`Unsupported user_type: ${userType}`);
    }
    result.user_type = userType;
  }

  const status = record.status?.trim() as ImportedUserRowInput['status'] | undefined;
  if (status) {
    if (!USER_IMPORT_ALLOWED_STATUSES.has(status)) {
      throw new Error(`Unsupported status: ${status}`);
    }
    result.status = status;
  }

  const lifecycleState = record.lifecycle_state?.trim();
  if (lifecycleState) {
    if (!VALID_USER_LIFECYCLE_STATES.has(lifecycleState)) {
      throw new Error(`Unsupported lifecycle_state: ${lifecycleState}`);
    }
    result.lifecycle_state = lifecycleState;
  }

  for (const [key, rawValue] of Object.entries(record)) {
    if (IMPORT_RESERVED_FIELDS.has(key) || key === 'email') {
      continue;
    }
    result[key] = parseImportCellValue(rawValue);
  }

  return result;
}

async function createUserImportRuntime(env: Env, tenantId: string): Promise<UserImportRuntime> {
  const tenantMetadata = await resolveTenantMetadataContext(env, tenantId);
  return {
    tenantId,
    env,
    schemaDb: tenantMetadata.coreDb,
  };
}

async function createUserImportAccountRuntime(
  runtime: UserImportRuntime,
  accountId: string
): Promise<UserImportAccountRuntime> {
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(
    runtime.env,
    runtime.tenantId,
    { accountId }
  );
  const coreAdapter = ensureDatabaseAdapter(
    customClaimSources.nonPiiDb,
    'management-user-import-core'
  );
  const piiAdapter = ensureDatabaseAdapter(customClaimSources.piiDb, 'management-user-import-pii');
  return {
    ...runtime,
    coreAdapter,
    piiAdapter,
    runtimeUsers: new CanonicalRuntimeUserStore({
      coreAdapter,
      piiAdapter,
      tenantId: runtime.tenantId,
    }),
    customClaimSources,
  };
}

function isImportedUserActive(input: Pick<ImportedUserRowInput, 'status' | 'lifecycle_state'>) {
  if (input.lifecycle_state) {
    return input.lifecycle_state === 'active';
  }
  if (input.status) {
    return input.status === 'active';
  }
  return true;
}

function importedAccountAuthenticationLifecycle(
  input: Pick<ImportedUserRowInput, 'status' | 'lifecycle_state'>
): 'active' | 'suspended' | 'locked' | 'inactive' | null {
  const state = input.lifecycle_state ?? input.status;
  if (!state) return null;
  if (state === 'active' || state === 'suspended' || state === 'locked') return state;
  return 'inactive';
}

async function createImportedUser(
  runtime: UserImportRuntime,
  input: ImportedUserRowInput,
  validateOnly: boolean
): Promise<ImportedUserRowResult> {
  const customFieldInput = extractCustomClaimInput(input, IMPORT_RESERVED_FIELDS);

  const customFieldValidation = await validateCustomClaimWrite({
    db: runtime.schemaDb,
    dbPii: null,
    piiStorageAvailable: true,
    schemaDb: runtime.schemaDb,
    tenantId: runtime.tenantId,
    submitted: customFieldInput,
    requireCompleteRecord: true,
  });

  if (!customFieldValidation.ok) {
    const detail = customFieldValidation.error ?? 'Invalid custom claim input';
    throw new Error(detail);
  }

  if (validateOnly) {
    return {
      outcome: 'validated',
      message: `Validated create for ${input.email}`,
    };
  }

  const userId = await generateUserIdFromSettings(
    runtime.env.AUTHRIM_CONFIG,
    runtime.tenantId,
    runtime.env
  );
  const requestHash = await hashAccountCreationRequest(input);
  const metadataAdapter = ensureDatabaseAdapter(runtime.schemaDb, 'management-user-import-meta');
  const creation = await executeDurableInitialAccountDirectoryWrite(
    runtime.env,
    {
      tenantId: runtime.tenantId,
      actorId: 'management-user-import',
      idempotencyKey: `user-import:${requestHash}`,
      requestHash,
      candidateOperationId: `user-import-${crypto.randomUUID()}`,
      candidateUserId: userId,
      email: input.email,
      residencyPolicyId: runtime.env.DEFAULT_RESIDENCY_PROFILE_ID ?? 'builtin:residency:default',
      residencyPartition: 'default',
    },
    {
      operationRepository: new AccountCreationOperationRepository(metadataAdapter),
      async writeAuthoritative(context) {
        await writeCanonicalAccountAuthoritative({
          publication: context.publication,
          tenantCoreUsers: context.tenantCoreUsers,
          tenantPii: context.tenantPii,
          runtimeUser: {
            active: isImportedUserActive(input),
            emailVerified: input.email_verified ?? false,
            phoneNumberVerified: input.phone_number_verified ?? false,
            userType: input.user_type ?? 'end_user',
            sourceRef: 'management:user-import',
            piiFields: {
              email: true,
              name: true,
              phone_number: true,
              given_name: true,
              family_name: true,
              nickname: true,
              preferred_username: true,
              picture: true,
            },
            sensitiveValues: {
              email: input.email,
              name: input.name ?? null,
              phone_number: input.phone_number ?? null,
              given_name: input.given_name ?? null,
              family_name: input.family_name ?? null,
              nickname: input.nickname ?? null,
              preferred_username: input.preferred_username ?? null,
              picture: input.picture ?? null,
            },
            inlineProfileFields: {
              ...(input.status ? { 'runtime.status': input.status } : {}),
              ...(input.lifecycle_state
                ? { 'runtime.lifecycle_state': input.lifecycle_state }
                : {}),
            },
          },
        });
        await persistCustomClaimWrite({
          db: context.tenantCoreUsers,
          dbPii: context.tenantPii,
          tenantId: runtime.tenantId,
          userId,
          validation: customFieldValidation,
        });
        await syncUserLifecycleState({
          db: context.tenantCoreUsers,
          dbPii: context.tenantPii,
          schemaDb: runtime.schemaDb,
          stateDb: context.tenantCoreUsers,
          tenantId: runtime.tenantId,
          userId,
          accountAuthenticationEnv: runtime.env,
        });
      },
    }
  );

  return {
    outcome: 'created',
    userId,
    message:
      creation.delivery.status === 202
        ? `Created user ${input.email}; directory publication pending`
        : `Created user ${input.email}`,
  };
}

async function updateImportedUser(
  runtime: UserImportAccountRuntime,
  userId: string,
  input: ImportedUserRowInput,
  validateOnly: boolean
): Promise<ImportedUserRowResult> {
  const existingUser = await runtime.runtimeUsers.findById(userId, { includeInactive: true });
  if (!existingUser) {
    throw new Error(`User ${userId} not found`);
  }

  const customFieldInput = extractCustomClaimInput(input, IMPORT_RESERVED_FIELDS);
  const customFieldValidation = await validateCustomClaimWrite({
    db: runtime.customClaimSources.nonPiiDb,
    dbPii: runtime.customClaimSources.piiDb,
    schemaDb: runtime.customClaimSources.schemaDb,
    tenantId: runtime.tenantId,
    userId,
    submitted: customFieldInput,
    requireCompleteRecord: true,
  });

  if (!customFieldValidation.ok) {
    const detail = customFieldValidation.error ?? 'Invalid custom claim input';
    throw new Error(detail);
  }

  if (validateOnly) {
    return {
      outcome: 'validated',
      userId,
      message: `Validated update for ${input.email}`,
    };
  }

  const targetLifecycle = importedAccountAuthenticationLifecycle(input);
  const lifecycleVersionMs = Date.now();
  if (targetLifecycle && targetLifecycle !== 'active') {
    await transitionAccountAuthenticationState(runtime.env, {
      tenantId: runtime.tenantId,
      userId,
      lifecycle: targetLifecycle,
      sourceVersionMs: lifecycleVersionMs,
      operationId: crypto.randomUUID(),
      revokeSessions: true,
    });
  }

  await runtime.runtimeUsers.syncUser({
    userId,
    email: input.email,
    name: input.name ?? existingUser.name,
    active:
      input.status !== undefined || input.lifecycle_state !== undefined
        ? isImportedUserActive(input)
        : existingUser.active === 1,
    emailVerified: input.email_verified ?? Boolean(existingUser.email_verified),
    phoneNumberVerified: input.phone_number_verified ?? Boolean(existingUser.phone_number_verified),
    userType: input.user_type ?? undefined,
    sourceRef: 'management:user-import',
    piiFields: {
      email: true,
      name: input.name !== undefined,
      phone_number: input.phone_number !== undefined,
      given_name: input.given_name !== undefined,
      family_name: input.family_name !== undefined,
      nickname: input.nickname !== undefined,
      preferred_username: input.preferred_username !== undefined,
      picture: input.picture !== undefined,
    },
    sensitiveValues: {
      email: input.email,
      name: input.name,
      phone_number: input.phone_number,
      given_name: input.given_name,
      family_name: input.family_name,
      nickname: input.nickname,
      preferred_username: input.preferred_username,
      picture: input.picture,
    },
    inlineProfileFields: {
      ...(input.status ? { 'runtime.status': input.status } : {}),
      ...(input.lifecycle_state ? { 'runtime.lifecycle_state': input.lifecycle_state } : {}),
    },
  });
  if (targetLifecycle === 'active') {
    await transitionAccountAuthenticationState(runtime.env, {
      tenantId: runtime.tenantId,
      userId,
      lifecycle: 'active',
      sourceVersionMs: lifecycleVersionMs,
      operationId: crypto.randomUUID(),
      revokeSessions: false,
    });
  }

  const hasCustomFieldChanges =
    Object.keys(customFieldValidation.nonPiiValues).length > 0 ||
    Object.keys(customFieldValidation.piiValues).length > 0 ||
    customFieldValidation.nonPiiKeysToDelete.length > 0 ||
    customFieldValidation.piiKeysToDelete.length > 0;

  if (hasCustomFieldChanges) {
    await persistCustomClaimWrite({
      db: runtime.customClaimSources.nonPiiDb,
      dbPii: runtime.customClaimSources.piiDb,
      tenantId: runtime.tenantId,
      userId,
      validation: customFieldValidation,
    });
    await syncUserLifecycleState({
      db: runtime.customClaimSources.nonPiiDb,
      dbPii: runtime.customClaimSources.piiDb,
      schemaDb: runtime.customClaimSources.schemaDb,
      stateDb: runtime.coreAdapter,
      tenantId: runtime.tenantId,
      userId,
      accountAuthenticationEnv: runtime.env,
    });
  }

  await invalidateUserCache(runtime.env, runtime.tenantId, userId);

  return {
    outcome: 'updated',
    userId,
    message: `Updated user ${input.email}`,
  };
}

async function processImportedRow(
  runtime: UserImportRuntime,
  record: Record<string, string>,
  rowNumber: number,
  options: UserImportJobOptions
): Promise<ImportedUserRowResult> {
  const input = normalizeImportRecord(record);
  let account = null;
  try {
    account = await resolveAccountDataContextByIdentifier(runtime.env, {
      tenantId: runtime.tenantId,
      indexKind: 'email_exact',
      identifier: input.email,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'account_data_route_not_found') throw error;
  }

  if (account) {
    const accountRuntime = await createUserImportAccountRuntime(runtime, account.accountId);
    const existing = await accountRuntime.runtimeUsers.findById(account.legacyUserId, {
      includeInactive: true,
    });
    if (!existing) throw new Error('Imported user route destination is inconsistent');
    if (options.on_duplicate === 'skip') {
      return {
        outcome: 'skipped',
        userId: existing.id,
        message: `Skipped duplicate email ${input.email}`,
      };
    }

    if (options.on_duplicate === 'error') {
      throw new Error(`Duplicate email: ${input.email}`);
    }

    return updateImportedUser(accountRuntime, existing.id, input, options.validate_only);
  }

  return createImportedUser(runtime, input, options.validate_only);
}

function parseJobOptions(config: string | null): UserImportJobOptions {
  if (!config) {
    return {
      skip_header: true,
      on_duplicate: 'skip',
      validate_only: false,
    };
  }

  const parsed = JSON.parse(config) as Partial<UserImportJobOptions>;
  return {
    skip_header: parsed.skip_header ?? true,
    on_duplicate: parsed.on_duplicate ?? 'skip',
    validate_only: parsed.validate_only ?? false,
  };
}

function parseProgress(progress: string | null): JobProgressState {
  if (!progress) {
    return computeProgress({
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      stage: 'queued',
    });
  }

  try {
    const parsed = JSON.parse(progress) as Partial<JobProgressState>;
    return computeProgress({
      total: parsed.total ?? 0,
      processed: parsed.processed ?? 0,
      succeeded: parsed.succeeded ?? 0,
      failed: parsed.failed ?? 0,
      skipped: parsed.skipped ?? 0,
      stage: parsed.stage ?? 'queued',
      current_item: parsed.current_item,
      percentage: parsed.percentage,
    });
  } catch {
    return computeProgress({
      total: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      stage: 'queued',
    });
  }
}

async function loadImportArtifact(
  env: Env,
  adapter: DatabaseAdapter,
  bucket: R2Bucket,
  key: string,
  job: UserImportJobRow,
  options: UserImportJobOptions
): Promise<ImportJobArtifact> {
  if (job.object_catalog_id && env.OBJECT_ENCRYPTION_ROOT_KEY) {
    const loaded = await loadCatalogObjectJson<ImportJobArtifact>(adapter, env, {
      tenantId: job.tenant_id,
      objectCatalogId: job.object_catalog_id,
      expectedClass: 'user_import_result',
      expectedBucketBinding: 'EXPORT_ARTIFACTS',
      allowPlaintextFallback: false,
    });
    if (loaded) {
      return loaded.value;
    }
  }

  const existing = await bucket.get(key);
  if (existing) {
    try {
      const text = await readR2ObjectTextWithLimit(existing, USER_IMPORT_MAX_RESULT_ARTIFACT_BYTES);
      if (text.startsWith('{') && text.includes('"ciphertext"') && env.OBJECT_ENCRYPTION_ROOT_KEY) {
        const envelope = JSON.parse(text) as Parameters<typeof decryptObjectArtifact>[0];
        const decrypted = await decryptObjectArtifact(envelope, {
          rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
          context: {
            tenantId: job.tenant_id,
            objectKey: key,
            objectClass: 'user_import_result',
          },
        });
        return JSON.parse(decrypted) as ImportJobArtifact;
      }
      return JSON.parse(text) as ImportJobArtifact;
    } catch {
      // Fall through and rebuild cleanly.
    }
  }

  return {
    job_id: job.id,
    tenant_id: job.tenant_id,
    input_r2_key: job.input_r2_key ?? '',
    options,
    summary: {
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    },
    failures: [],
    logs: [],
    updated_at: nowIso(),
  };
}

async function saveImportArtifact(
  env: Env,
  adapter: DatabaseAdapter,
  bucket: R2Bucket,
  key: string,
  job: UserImportJobRow,
  artifact: ImportJobArtifact,
  options?: {
    materializeCatalog?: boolean;
  }
): Promise<{ objectCatalogId: string | null; publicArtifactId: string | null }> {
  artifact.updated_at = nowIso();
  const payload = JSON.stringify(artifact, null, 2);

  if (env.OBJECT_ENCRYPTION_ROOT_KEY) {
    const keyVersion = Number.parseInt(env.OBJECT_ENCRYPTION_KEY_VERSION || '1', 10) || 1;
    if (options?.materializeCatalog) {
      const created = await materializeEncryptedObjectArtifact(adapter, bucket, {
        tenantId: job.tenant_id,
        objectClass: 'user_import_result',
        representation: 'canonical_json',
        objectKeyBase: key,
        content: payload,
        contentType: 'application/json',
        rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
        keyVersion,
      });
      return {
        objectCatalogId: created.catalogId,
        publicArtifactId: created.publicArtifactId,
      };
    }

    const envelope = await encryptObjectArtifact(payload, {
      rootKeyHex: env.OBJECT_ENCRYPTION_ROOT_KEY,
      plane: 'EXPORT_ARTIFACTS',
      keyVersion,
      contentType: 'application/json',
      context: {
        tenantId: job.tenant_id,
        objectKey: key,
        objectClass: 'user_import_result',
      },
    });
    const envelopeJson = JSON.stringify(envelope);
    await bucket.put(key, envelopeJson, {
      httpMetadata: {
        contentType: ENCRYPTED_OBJECT_CONTENT_TYPE,
      },
    });

    return {
      objectCatalogId: job.object_catalog_id ?? null,
      publicArtifactId: null,
    };
  }

  await bucket.put(key, payload, {
    httpMetadata: {
      contentType: 'application/json',
    },
  });

  return {
    objectCatalogId: job.object_catalog_id ?? null,
    publicArtifactId: null,
  };
}

function previewResultPayload(artifact: ImportJobArtifact) {
  return {
    summary: {
      total: artifact.summary.total,
      succeeded: artifact.summary.succeeded,
      failed: artifact.summary.failed,
      skipped: artifact.summary.skipped,
    },
    failures: toPreviewFailures(artifact.failures),
    logs: toPreviewLogs(artifact.logs),
  };
}

function pushLog(artifact: ImportJobArtifact, entry: Omit<ImportJobLogEntry, 'timestamp'>) {
  artifact.logs.push({
    timestamp: nowIso(),
    ...entry,
  });
  if (artifact.logs.length > USER_IMPORT_MAX_LOG_ENTRIES) {
    artifact.logs.splice(0, artifact.logs.length - USER_IMPORT_MAX_LOG_ENTRIES);
  }
}

function pushFailure(artifact: ImportJobArtifact, failure: ImportJobFailure): void {
  if (artifact.failures.length < USER_IMPORT_MAX_FAILURE_DETAILS) {
    artifact.failures.push(failure);
  }
}

function createFailureEntry(
  rowNumber: number,
  record: Record<string, string>,
  error: unknown
): ImportJobFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    row: rowNumber,
    email: record.email?.trim() || undefined,
    error_code: 'import_row_failed',
    message,
  };
}

async function processUserImportJob(
  env: Env,
  coreAdapter: DatabaseAdapter,
  inputBucket: R2Bucket,
  resultBucket: R2Bucket,
  job: UserImportJobRow,
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
  }
) {
  assertUserImportJobStorageKeys(job);

  const inputObject = await inputBucket.get(job.input_r2_key);
  if (!inputObject) {
    throw new Error(`Import source not found: ${job.input_r2_key}`);
  }

  const csvText = await readR2ObjectTextWithLimit(inputObject, USER_IMPORT_MAX_UPLOAD_BYTES);
  const options = parseJobOptions(job.config);
  const resultKey = job.result_r2_key ?? buildUserImportResultKey(job.tenant_id, job.id);
  const parsed = parseUserImportCsv(csvText, { skip_header: options.skip_header });
  const progress = parseProgress(job.progress);
  const runtime = await createUserImportRuntime(env, job.tenant_id);
  const artifact = await loadImportArtifact(
    env,
    coreAdapter,
    resultBucket,
    resultKey,
    job,
    options
  );
  let currentObjectCatalogId = job.object_catalog_id;

  const totalRows = parsed.records.length;
  artifact.summary.total = totalRows;

  if (progress.total !== totalRows || progress.stage === 'queued') {
    const initialized = computeProgress({
      total: totalRows,
      processed: progress.processed,
      succeeded: progress.succeeded,
      failed: progress.failed,
      skipped: progress.skipped,
      stage: options.validate_only ? 'validation' : 'processing',
      current_item: progress.current_item,
    });

    await coreAdapter.execute(
      'UPDATE admin_jobs SET progress = ?, result_r2_key = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify(initialized), resultKey, Math.floor(Date.now() / 1000), job.id, job.tenant_id]
    );
  }

  const startIndex = Math.min(progress.processed, totalRows);
  const endIndex = Math.min(startIndex + USER_IMPORT_BATCH_SIZE, totalRows);
  const rowOffset = options.skip_header ? 2 : 1;

  let processed = progress.processed;
  let succeeded = progress.succeeded;
  let failed = progress.failed;
  let skipped = progress.skipped;

  for (let index = startIndex; index < endIndex; index += 1) {
    const record = parsed.records[index];
    const rowNumber = index + rowOffset;
    const currentEmail = record.email?.trim() || `row-${rowNumber}`;

    try {
      const result = await processImportedRow(runtime, record, rowNumber, options);
      processed += 1;

      if (result.outcome === 'skipped') {
        skipped += 1;
        pushLog(artifact, {
          level: 'info',
          code: 'duplicate_skipped',
          row: rowNumber,
          email: record.email?.trim() || undefined,
          message: result.message,
        });
      } else {
        succeeded += 1;
        pushLog(artifact, {
          level: 'info',
          code: result.outcome,
          row: rowNumber,
          email: record.email?.trim() || undefined,
          message: result.message,
        });
      }
    } catch (error) {
      processed += 1;
      failed += 1;
      const failure = createFailureEntry(rowNumber, record, error);
      pushFailure(artifact, failure);
      pushLog(artifact, {
        level: 'error',
        code: failure.error_code,
        row: rowNumber,
        email: failure.email,
        message: failure.message ?? 'Import row failed',
      });
      logger.error(
        'User import row failed',
        { job_id: job.id, tenant_id: job.tenant_id, row: rowNumber, email: currentEmail },
        error as Error
      );
    }
  }

  artifact.summary = {
    total: totalRows,
    succeeded,
    failed,
    skipped,
  };

  const initialPointer = await saveImportArtifact(
    env,
    coreAdapter,
    resultBucket,
    resultKey,
    { ...job, object_catalog_id: currentObjectCatalogId },
    artifact,
    { materializeCatalog: false }
  );
  currentObjectCatalogId = initialPointer.objectCatalogId ?? currentObjectCatalogId;

  if (processed < totalRows) {
    const nextProgress = computeProgress({
      total: totalRows,
      processed,
      succeeded,
      failed,
      skipped,
      stage: options.validate_only ? 'validation' : 'processing',
      current_item: parsed.records[processed]?.email?.trim() || undefined,
    });

    await coreAdapter.execute(
      'UPDATE admin_jobs SET progress = ?, result = ?, result_r2_key = ?, object_catalog_id = COALESCE(?, object_catalog_id), updated_at = ? WHERE id = ? AND tenant_id = ?',
      [
        JSON.stringify(nextProgress),
        JSON.stringify(previewResultPayload(artifact)),
        resultKey,
        currentObjectCatalogId,
        Math.floor(Date.now() / 1000),
        job.id,
        job.tenant_id,
      ]
    );

    logger.info('User import batch processed', {
      job_id: job.id,
      tenant_id: job.tenant_id,
      processed,
      total: totalRows,
    });
    return;
  }

  artifact.completed_at = nowIso();
  const finalPointer = await saveImportArtifact(
    env,
    coreAdapter,
    resultBucket,
    resultKey,
    { ...job, object_catalog_id: currentObjectCatalogId },
    artifact,
    { materializeCatalog: true }
  );
  currentObjectCatalogId = finalPointer.objectCatalogId ?? currentObjectCatalogId;

  const completedTs = Math.floor(Date.now() / 1000);
  const finalProgress = computeProgress({
    total: totalRows,
    processed,
    succeeded,
    failed,
    skipped,
    stage: 'completed',
  });
  const finalStatus = failed > 0 ? 'partial_failure' : 'completed';

  await coreAdapter.execute(
    `UPDATE admin_jobs
     SET status = ?, progress = ?, result = ?, result_r2_key = ?, object_catalog_id = COALESCE(?, object_catalog_id), completed_at = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [
      finalStatus,
      JSON.stringify(finalProgress),
      JSON.stringify(previewResultPayload(artifact)),
      resultKey,
      currentObjectCatalogId,
      completedTs,
      completedTs,
      job.id,
      job.tenant_id,
    ]
  );

  logger.info('User import job completed', {
    job_id: job.id,
    tenant_id: job.tenant_id,
    status: finalStatus,
    summary: artifact.summary,
  });
}

export async function processPendingUserImportJobs(
  env: Env,
  logger: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, err?: Error) => void;
  }
): Promise<void> {
  const inputBucket = env.IMPORT_ARTIFACTS;
  if (!inputBucket) {
    logger.info('Skipping user import jobs because IMPORT_ARTIFACTS is not configured');
    return;
  }
  const resultBucket = env.EXPORT_ARTIFACTS;
  if (!resultBucket) {
    logger.info('Skipping user import jobs because EXPORT_ARTIFACTS is not configured');
    return;
  }

  if (!env.DB_ADMIN) {
    logger.info('Skipping user import jobs because DB_ADMIN is not configured');
    return;
  }
  const coreAdapter = ensureDatabaseAdapter(env.DB_ADMIN, 'management-user-import-jobs');
  const pendingJobs = await coreAdapter.query<UserImportJobRow>(
    `SELECT id, tenant_id, status, progress, config, input_r2_key, result_r2_key, object_catalog_id, created_at
     FROM admin_jobs
     WHERE job_type = 'users/import' AND status IN ('pending', 'processing')
     ORDER BY created_at ASC
     LIMIT 3`
  );

  for (const job of pendingJobs) {
    const startedTs = Math.floor(Date.now() / 1000);

    if (job.status === 'pending') {
      const claimed = await coreAdapter.execute(
        "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'pending'",
        [startedTs, startedTs, job.id, job.tenant_id]
      );
      if ((claimed.rowsAffected ?? 0) === 0) {
        continue;
      }
    }

    try {
      await processUserImportJob(env, coreAdapter, inputBucket, resultBucket, job, logger);
    } catch (error) {
      const failedTs = Math.floor(Date.now() / 1000);
      await coreAdapter.execute(
        "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?",
        [String(error), failedTs, failedTs, job.id, job.tenant_id]
      );
      logger.error(
        'User import job failed',
        { job_id: job.id, tenant_id: job.tenant_id },
        error as Error
      );
    }
  }
}
