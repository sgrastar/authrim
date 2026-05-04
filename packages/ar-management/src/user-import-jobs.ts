import {
  decryptObjectArtifact,
  type DatabaseAdapter,
  type Env,
  encryptObjectArtifact,
  type UpdateUserCoreInput,
  type UpdateUserPIIInput,
  UserCoreRepository,
  UserPIIRepository,
  ensureDatabaseAdapter,
  generateUserIdFromSettings,
  invalidateUserCache,
  persistCustomClaimWrite,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveCustomClaimRuntimeSourcesFromEnv,
  syncUserLifecycleState,
  validateCustomClaimWrite,
} from '@authrim/ar-lib-core';
import { loadCatalogObjectJson } from '@authrim/ar-lib-core/services/object-artifact-store';
import {
  ADMIN_USER_CREATE_RESERVED_FIELDS,
  extractCustomClaimInput,
  VALID_USER_LIFECYCLE_STATES,
} from './admin-shared';
import { materializeEncryptedObjectArtifact } from './object-artifact-materialization';

export const USER_IMPORT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const USER_IMPORT_BATCH_SIZE = 100;

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
  coreAdapter: DatabaseAdapter;
  userCoreRepo: UserCoreRepository;
  piiAdapter: DatabaseAdapter;
  piiRepo: UserPIIRepository;
  customClaimSources: Awaited<ReturnType<typeof resolveCustomClaimRuntimeSourcesFromEnv>>;
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
    headers = rows[0].map((_, index) => USER_IMPORT_DEFAULT_HEADERS[index] ?? `column_${index + 1}`);
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

function normalizeImportRecord(
  record: Record<string, string>
): ImportedUserRowInput {
  const email = record.email?.trim();
  if (!email) {
    throw new Error('Email is required');
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
  const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(env, 'management-user-import');
  const customClaimSources = await resolveCustomClaimRuntimeSourcesFromEnv(env, tenantId);
  const piiAdapter = ensureDatabaseAdapter(
    customClaimSources.piiDb ?? customClaimSources.nonPiiDb,
    'management-user-import-pii'
  );

  return {
    tenantId,
    env,
    coreAdapter,
    userCoreRepo: new UserCoreRepository(coreAdapter),
    piiAdapter,
    piiRepo: new UserPIIRepository(piiAdapter),
    customClaimSources,
  };
}

async function createImportedUser(
  runtime: UserImportRuntime,
  input: ImportedUserRowInput,
  validateOnly: boolean
): Promise<ImportedUserRowResult> {
  const customFieldInput = extractCustomClaimInput(input, IMPORT_RESERVED_FIELDS);

  const customFieldValidation = await validateCustomClaimWrite({
    db: runtime.customClaimSources.nonPiiDb,
    dbPii: runtime.customClaimSources.piiDb,
    schemaDb: runtime.customClaimSources.schemaDb,
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

  const userId = await generateUserIdFromSettings(runtime.env.AUTHRIM_CONFIG, runtime.tenantId);

  await runtime.userCoreRepo.createUser({
    id: userId,
    tenant_id: runtime.tenantId,
    email_verified: input.email_verified ?? false,
    phone_number_verified: input.phone_number_verified ?? false,
    user_type: input.user_type ?? 'end_user',
    pii_partition: 'default',
    pii_status: 'pending',
    lifecycle_state: input.lifecycle_state as UpdateUserCoreInput['lifecycle_state'],
  });

  if (input.status) {
    await runtime.userCoreRepo.update(userId, { status: input.status });
  }

  try {
    await runtime.piiRepo.createPII(
      {
        id: userId,
        tenant_id: runtime.tenantId,
        pii_class: 'PROFILE',
        email: input.email,
        phone_number: input.phone_number ?? null,
        name: input.name ?? null,
        given_name: input.given_name ?? null,
        family_name: input.family_name ?? null,
        nickname: input.nickname ?? null,
        preferred_username: input.preferred_username ?? null,
        picture: input.picture ?? null,
      },
      runtime.piiAdapter
    );
    await runtime.userCoreRepo.updatePIIStatus(userId, 'active');
  } catch (piiError) {
    await runtime.userCoreRepo.updatePIIStatus(userId, 'failed');
    throw piiError;
  }

  try {
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
    });
  } catch (customFieldError) {
    try {
      await ensureDatabaseAdapter(
        runtime.customClaimSources.nonPiiDb,
        'user-import-create-rollback-fields'
      ).execute('DELETE FROM user_custom_fields WHERE user_id = ? AND tenant_id = ?', [
        userId,
        runtime.tenantId,
      ]);
      await runtime.piiAdapter.execute('DELETE FROM users_pii WHERE id = ? AND tenant_id = ?', [
        userId,
        runtime.tenantId,
      ]);
      await runtime.coreAdapter.execute('DELETE FROM users_core WHERE id = ? AND tenant_id = ?', [
        userId,
        runtime.tenantId,
      ]);
    } catch {
      // Best effort rollback only.
    }
    throw customFieldError;
  }

  return {
    outcome: 'created',
    userId,
    message: `Created user ${input.email}`,
  };
}

async function updateImportedUser(
  runtime: UserImportRuntime,
  userId: string,
  input: ImportedUserRowInput,
  validateOnly: boolean
): Promise<ImportedUserRowResult> {
  const userCore = await runtime.userCoreRepo.findById(userId);
  if (!userCore) {
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

  const coreUpdateData: UpdateUserCoreInput = {};
  const piiUpdateData: UpdateUserPIIInput = {};

  if (input.email_verified !== undefined) {
    coreUpdateData.email_verified = input.email_verified;
  }
  if (input.phone_number_verified !== undefined) {
    coreUpdateData.phone_number_verified = input.phone_number_verified;
  }
  if (input.user_type !== undefined) {
    coreUpdateData.user_type = input.user_type;
  }
  if (input.status !== undefined) {
    coreUpdateData.status = input.status;
  }
  if (input.lifecycle_state !== undefined) {
    coreUpdateData.lifecycle_state = input.lifecycle_state as UpdateUserCoreInput['lifecycle_state'];
  }

  const piiFields: Array<keyof UpdateUserPIIInput> = [
    'name',
    'given_name',
    'family_name',
    'nickname',
    'preferred_username',
    'picture',
    'phone_number',
  ];
  for (const field of piiFields) {
    if (field in input && input[field] !== undefined) {
      piiUpdateData[field] = input[field] as never;
    }
  }

  if (validateOnly) {
    return {
      outcome: 'validated',
      userId,
      message: `Validated update for ${input.email}`,
    };
  }

  if (Object.keys(coreUpdateData).length > 0) {
    await runtime.userCoreRepo.update(userId, coreUpdateData);
  }
  if (Object.keys(piiUpdateData).length > 0) {
    await runtime.piiRepo.updatePII(userId, piiUpdateData, runtime.piiAdapter);
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
    });
  }

  await invalidateUserCache(runtime.env, userId);

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
  const existing = await runtime.piiRepo.findByTenantAndEmail(
    runtime.tenantId,
    input.email,
    runtime.piiAdapter
  );

  if (existing) {
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

    return updateImportedUser(runtime, existing.id, input, options.validate_only);
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
    const loaded = await loadCatalogObjectJson<ImportJobArtifact>(
      adapter,
      env,
      {
        tenantId: job.tenant_id,
        objectCatalogId: job.object_catalog_id,
        expectedClass: 'user_import_result',
        expectedBucketBinding: 'EXPORT_ARTIFACTS',
        allowPlaintextFallback: false,
      }
    );
    if (loaded) {
      return loaded.value;
    }
  }

  const existing = await bucket.get(key);
  if (existing) {
    try {
      const text = await existing.text();
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

function pushLog(
  artifact: ImportJobArtifact,
  entry: Omit<ImportJobLogEntry, 'timestamp'>
) {
  artifact.logs.push({
    timestamp: nowIso(),
    ...entry,
  });
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
  if (!job.input_r2_key) {
    throw new Error('input_r2_key is missing');
  }

  const inputObject = await inputBucket.get(job.input_r2_key);
  if (!inputObject) {
    throw new Error(`Import source not found: ${job.input_r2_key}`);
  }

  const csvText = await inputObject.text();
  const options = parseJobOptions(job.config);
  const resultKey = job.result_r2_key ?? buildUserImportResultKey(job.tenant_id, job.id);
  const parsed = parseUserImportCsv(csvText, { skip_header: options.skip_header });
  const progress = parseProgress(job.progress);
  const runtime = await createUserImportRuntime(env, job.tenant_id);
  const artifact = await loadImportArtifact(env, coreAdapter, resultBucket, resultKey, job, options);
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
      'UPDATE admin_jobs SET progress = ?, result_r2_key = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(initialized), resultKey, Math.floor(Date.now() / 1000), job.id]
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
      artifact.failures.push(failure);
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
      'UPDATE admin_jobs SET progress = ?, result = ?, result_r2_key = ?, object_catalog_id = COALESCE(?, object_catalog_id), updated_at = ? WHERE id = ?',
      [
        JSON.stringify(nextProgress),
        JSON.stringify(previewResultPayload(artifact)),
        resultKey,
        currentObjectCatalogId,
        Math.floor(Date.now() / 1000),
        job.id,
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
     WHERE id = ?`,
    [
      finalStatus,
      JSON.stringify(finalProgress),
      JSON.stringify(previewResultPayload(artifact)),
      resultKey,
      currentObjectCatalogId,
      completedTs,
      completedTs,
      job.id,
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

  const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
    env,
    'management-user-import-jobs'
  );
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
        "UPDATE admin_jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        [startedTs, startedTs, job.id]
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
        "UPDATE admin_jobs SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ?",
        [String(error), failedTs, failedTs, job.id]
      );
      logger.error('User import job failed', { job_id: job.id, tenant_id: job.tenant_id }, error as Error);
    }
  }
}
