import {
  addFail,
  addPass,
  addWarn,
  fetchJsonWithTimeout,
  finalizeCheck,
  isRecord,
  isSmokeSuccessful,
  makeSmokeCheck,
  readGeneratedAdminApiSecret,
  resolveGeneratedSmokeTarget,
  withTenantHeader,
  type GeneratedSmokeOptions,
  type SmokeCheck,
} from './generated-smoke-common.js';

export interface GeneratedServerSurfacesSmokeOptions extends GeneratedSmokeOptions {
  adminSecret?: string;
  adminSecretPath?: string;
}

export interface GeneratedServerSurfacesSmokeResult {
  ok: boolean;
  env: string;
  baseUrl: string;
  configPath: string;
  adminSecretPath: string;
  checks: SmokeCheck[];
}

interface CustomClaimSchemaSummary {
  id: string;
  fieldKey: string;
  displayLabel: string;
  fieldType: string;
  isRequired: boolean;
  isActive: boolean;
  showOnRegistration: boolean;
  validationRules: Record<string, unknown> | null;
}

interface ScimTokenSnapshot {
  token: string;
  tokenHash: string;
}

const SCIM_EXTENSION_URN = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const SCIM_SUPPORTED_REQUIRED_KEYS = ['department', 'division', 'organization', 'manager'] as const;

function getAdminHeaders(secret: string, tenantId?: string): Record<string, string> {
  return withTenantHeader(
    {
      authorization: `Bearer ${secret}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    tenantId
  );
}

function getScimHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/scim+json',
    'content-type': 'application/scim+json',
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function getRuntimeProfileListItems(
  payload: unknown,
  kind: 'storage' | 'audit' | 'residency'
): Record<string, unknown>[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (Array.isArray(payload.items)) {
    return asRecordArray(payload.items);
  }

  if (isRecord(payload.profiles)) {
    return asRecordArray(payload.profiles[kind]);
  }

  return [];
}

function parseJsonLikePayload(snapshot: Awaited<ReturnType<typeof fetchJsonWithTimeout>>): unknown {
  if (snapshot.payload !== undefined) {
    return snapshot.payload;
  }
  if (!snapshot.bodyText) {
    return undefined;
  }
  try {
    return JSON.parse(snapshot.bodyText);
  } catch {
    return undefined;
  }
}

async function runJsonRequest(options: {
  check: SmokeCheck;
  baseUrl: string;
  path: string;
  timeoutMs: number;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers: Record<string, string>;
  body?: unknown;
  expectedStatus?: number;
  validate?: (payload: unknown, check: SmokeCheck) => void;
}): Promise<unknown> {
  const response = await fetchJsonWithTimeout(
    `${options.baseUrl}${options.path}`,
    options.timeoutMs,
    {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }
  );
  options.check.httpStatus = response.status;
  const payload = parseJsonLikePayload(response);

  if (options.expectedStatus && response.status === options.expectedStatus) {
    addPass(options.check, `HTTP ${response.status}`);
    options.validate?.(payload, options.check);
    return payload;
  }

  if (!response.ok) {
    addFail(
      options.check,
      `${options.method ?? 'GET'} ${options.path} failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
    return payload;
  }

  if (options.expectedStatus && response.status !== options.expectedStatus) {
    addFail(options.check, `HTTP ${options.expectedStatus} expected, actual=${response.status}`);
  } else {
    addPass(options.check, `HTTP ${response.status}`);
  }

  options.validate?.(payload, options.check);
  return payload;
}

function parseSchemaSummaries(payload: unknown): CustomClaimSchemaSummary[] {
  if (!isRecord(payload)) {
    return [];
  }
  const schemas = asRecordArray(payload.schemas);
  return schemas
    .map((schema) => {
      const id = asString(schema.id);
      const fieldKey = asString(schema.field_key);
      const displayLabel = asString(schema.display_label) ?? fieldKey;
      const fieldType = asString(schema.field_type) ?? 'string';
      if (!id || !fieldKey) {
        return null;
      }
      return {
        id,
        fieldKey,
        displayLabel: displayLabel ?? fieldKey,
        fieldType,
        isRequired: asBoolean(schema.is_required),
        isActive: !('is_active' in schema) || asBoolean(schema.is_active),
        showOnRegistration: asBoolean(schema.show_on_registration),
        validationRules: isRecord(schema.validation_rules) ? schema.validation_rules : null,
      } satisfies CustomClaimSchemaSummary;
    })
    .filter((schema): schema is CustomClaimSchemaSummary => schema !== null);
}

function buildExampleValue(schema: CustomClaimSchemaSummary): unknown {
  if (schema.fieldType === 'boolean') {
    return true;
  }
  if (schema.fieldType === 'number') {
    return 7;
  }
  if (schema.fieldType === 'date') {
    return '2026-05-04';
  }
  if (schema.fieldType === 'enum') {
    const values = Array.isArray(schema.validationRules?.enum_values)
      ? schema.validationRules?.enum_values.filter(
          (value): value is string => typeof value === 'string'
        )
      : [];
    return values[0] ?? 'smoke-enum';
  }
  if (schema.fieldKey === 'department') {
    return 'Engineering';
  }
  if (schema.fieldKey === 'division') {
    return 'Platform';
  }
  if (schema.fieldKey === 'organization') {
    return 'Authrim';
  }
  if (schema.fieldKey === 'manager') {
    return 'mgr-smoke';
  }
  return `smoke-${schema.fieldKey}`;
}

function buildAdminCustomFieldPayload(
  schemas: CustomClaimSchemaSummary[],
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const schema of schemas) {
    payload[schema.fieldKey] = buildExampleValue(schema);
  }
  return { ...payload, ...(overrides ?? {}) };
}

function buildScimUserBody(
  email: string,
  requiredSchemas: CustomClaimSchemaSummary[]
): Record<string, unknown> {
  const enterpriseExtension: Record<string, unknown> = {};
  for (const schema of requiredSchemas) {
    enterpriseExtension[schema.fieldKey] = buildExampleValue(schema);
  }

  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', SCIM_EXTENSION_URN],
    userName: email,
    displayName: 'Server Surface Smoke SCIM User',
    active: true,
    emails: [{ value: email, primary: true }],
    [SCIM_EXTENSION_URN]: enterpriseExtension,
  };
}

function findMissingRequiredField(payload: unknown, fieldKey: string): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return asRecordArray(payload.missing_required_fields).some(
    (field) => asString(field.field_key) === fieldKey
  );
}

function pickSupportedScimField(schemas: CustomClaimSchemaSummary[]): string | null {
  const activeKeys = new Set(
    schemas.filter((schema) => schema.isActive).map((schema) => schema.fieldKey)
  );
  for (const key of SCIM_SUPPORTED_REQUIRED_KEYS) {
    if (!activeKeys.has(key)) {
      return key;
    }
  }
  return null;
}

function canSatisfyRequiredSchemasViaScim(schemas: CustomClaimSchemaSummary[]): boolean {
  return schemas.every(
    (schema) =>
      SCIM_SUPPORTED_REQUIRED_KEYS.includes(
        schema.fieldKey as (typeof SCIM_SUPPORTED_REQUIRED_KEYS)[number]
      ) &&
      (schema.fieldType === 'string' || schema.fieldType === 'enum')
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMilliseconds(response: {
  headers?: Record<string, string | undefined>;
  bodyText?: string;
}): number | null {
  const retryAfterHeader =
    response.headers?.['retry-after'] ??
    response.headers?.['Retry-After'] ??
    response.headers?.['RETRY-AFTER'];
  const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const match = response.bodyText?.match(/try again in (\d+) seconds/i);
  if (match) {
    const parsed = parseInt(match[1] ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1000;
    }
  }

  return null;
}

async function deleteAdminUser(input: {
  checks: SmokeCheck[];
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  userId?: string;
}): Promise<void> {
  if (!input.userId) {
    return;
  }
  const check = makeSmokeCheck(
    `cleanup-user-${input.userId}`,
    'cleanup temporary user',
    `${input.baseUrl}/api/admin/users/${encodeURIComponent(input.userId)}`
  );
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/users/${encodeURIComponent(input.userId)}`,
    input.timeoutMs,
    {
      method: 'DELETE',
      headers: getAdminHeaders(input.adminSecret, input.tenantId),
    }
  );
  check.httpStatus = response.status;
  if (response.ok) {
    addPass(check, `user_id=${input.userId} cleaned up`);
  } else if (response.status === 404) {
    addWarn(check, `user_id=${input.userId} has already been deleted`);
  } else {
    addWarn(
      check,
      `user cleanup failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }
  input.checks.push(finalizeCheck(check, 'cleanup temporary user executed'));
}

async function deleteCustomClaimSchema(input: {
  checks: SmokeCheck[];
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  schemaId?: string;
}): Promise<void> {
  if (!input.schemaId) {
    return;
  }
  const check = makeSmokeCheck(
    `cleanup-custom-claim-${input.schemaId}`,
    'cleanup temporary custom claim schema',
    `${input.baseUrl}/api/admin/custom-claims/${encodeURIComponent(input.schemaId)}`
  );
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/custom-claims/${encodeURIComponent(input.schemaId)}`,
    input.timeoutMs,
    {
      method: 'DELETE',
      headers: getAdminHeaders(input.adminSecret, input.tenantId),
    }
  );
  check.httpStatus = response.status;
  if (response.ok) {
    addPass(check, `schema_id=${input.schemaId} cleaned up`);
  } else if (response.status === 404) {
    addWarn(check, `schema_id=${input.schemaId} does not exist anymore`);
  } else {
    addWarn(
      check,
      `schema cleanup failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }
  input.checks.push(finalizeCheck(check, 'cleanup temporary custom claim schema executed'));
}

async function deleteRuntimeProfile(input: {
  checks: SmokeCheck[];
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  kind: 'storage' | 'audit' | 'residency';
  profileId?: string;
}): Promise<void> {
  if (!input.profileId) {
    return;
  }
  const check = makeSmokeCheck(
    `cleanup-runtime-profile-${input.profileId}`,
    'cleanup temporary runtime profile',
    `${input.baseUrl}/api/admin/runtime-profiles/${input.kind}/${encodeURIComponent(input.profileId)}`
  );
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/runtime-profiles/${input.kind}/${encodeURIComponent(input.profileId)}`,
    input.timeoutMs,
    {
      method: 'DELETE',
      headers: getAdminHeaders(input.adminSecret, input.tenantId),
    }
  );
  check.httpStatus = response.status;
  if (response.ok) {
    addPass(check, `profile_id=${input.profileId} cleaned up`);
  } else if (response.status === 404) {
    addWarn(check, `profile_id=${input.profileId} does not exist anymore`);
  } else {
    addWarn(
      check,
      `runtime profile cleanup failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }
  input.checks.push(finalizeCheck(check, 'cleanup temporary runtime profile executed'));
}

async function deleteRoutingRule(input: {
  checks: SmokeCheck[];
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  ruleName?: string;
}): Promise<void> {
  if (!input.ruleName) {
    return;
  }
  const check = makeSmokeCheck(
    `cleanup-routing-rule-${input.ruleName}`,
    'cleanup temporary audit routing rule',
    `${input.baseUrl}/api/admin/settings/audit-storage/routing-rules/${encodeURIComponent(input.ruleName)}`
  );
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/settings/audit-storage/routing-rules/${encodeURIComponent(input.ruleName)}`,
    input.timeoutMs,
    {
      method: 'DELETE',
      headers: getAdminHeaders(input.adminSecret, input.tenantId),
    }
  );
  check.httpStatus = response.status;
  if (response.ok) {
    addPass(check, `routing rule ${input.ruleName} cleaned up`);
  } else if (response.status === 404) {
    addWarn(check, `routing rule ${input.ruleName} does not exist anymore`);
  } else {
    addWarn(
      check,
      `routing rule cleanup failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }
  input.checks.push(finalizeCheck(check, 'cleanup temporary audit routing rule executed'));
}

async function revokeScimToken(input: {
  checks: SmokeCheck[];
  baseUrl: string;
  timeoutMs: number;
  adminSecret: string;
  tenantId: string;
  tokenHash?: string;
}): Promise<void> {
  if (!input.tokenHash) {
    return;
  }
  const check = makeSmokeCheck(
    `cleanup-scim-token-${input.tokenHash.slice(0, 8)}`,
    'cleanup temporary SCIM token',
    `${input.baseUrl}/api/admin/scim-tokens/${encodeURIComponent(input.tokenHash)}`
  );
  const response = await fetchJsonWithTimeout(
    `${input.baseUrl}/api/admin/scim-tokens/${encodeURIComponent(input.tokenHash)}`,
    input.timeoutMs,
    {
      method: 'DELETE',
      headers: getAdminHeaders(input.adminSecret, input.tenantId),
    }
  );
  check.httpStatus = response.status;
  if (response.ok) {
    addPass(check, `token_hash=${input.tokenHash.slice(0, 8)} cleaned up`);
  } else if (response.status === 404) {
    addWarn(check, 'SCIM token has already been deleted');
  } else {
    addWarn(
      check,
      `SCIM token cleanup failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
    );
  }
  input.checks.push(finalizeCheck(check, 'cleanup temporary SCIM token executed'));
}

export async function runGeneratedServerSurfacesSmoke(
  options: GeneratedServerSurfacesSmokeOptions
): Promise<GeneratedServerSurfacesSmokeResult> {
  const target = await resolveGeneratedSmokeTarget(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tenantId = target.tenantId;
  const adminAccess = await readGeneratedAdminApiSecret({
    baseDir: target.baseDir,
    env: target.env,
    adminSecret: options.adminSecret,
    adminSecretPath: options.adminSecretPath,
    baseUrl: target.baseUrl,
    tenantId: target.tenantId,
    config: target.config,
  });
  const adminSecret = adminAccess.secret;
  const adminSecretPath = adminAccess.path;

  const checks: SmokeCheck[] = [];
  const smokeRunId = Date.now();
  let smokeFieldKey = `phase15_smoke_${smokeRunId}`;
  const smokeFieldLabel = 'Server Surface Smoke Field';
  const runtimeProfileId = `phase15-audit-${smokeRunId}`;
  const routingRuleName = `Phase15 Smoke Rule ${smokeRunId}`;
  let createdSmokeSchemaId: string | undefined;
  let createdScimSchemaId: string | undefined;
  let createdUserId: string | undefined;
  let createdScimUserId: string | undefined;
  let scimToken: ScimTokenSnapshot | undefined;
  let createdRoutingRuleName: string | undefined;
  let createdRuntimeProfileId: string | undefined;
  let currentSchemas: CustomClaimSchemaSummary[] = [];

  try {
    const listSchemasCheck = makeSmokeCheck(
      'server-surfaces-custom-claims-list',
      'list custom claim schemas',
      `${target.baseUrl}/api/admin/custom-claims?limit=100`
    );
    const listSchemasPayload = await runJsonRequest({
      check: listSchemasCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/custom-claims?limit=100',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        currentSchemas = parseSchemaSummaries(payload);
        addPass(check, `schemas=${currentSchemas.length}`);
      },
    });
    void listSchemasPayload;
    if (listSchemasCheck.status === 'fail' && listSchemasCheck.httpStatus === 403) {
      listSchemasCheck.status = 'warn';
      addWarn(
        listSchemasCheck,
        'Admin Machine Access token cannot access custom-claims/server-surface operations; skipping server-surface smoke'
      );
      checks.push(finalizeCheck(listSchemasCheck, 'list custom claim schemas verified'));
      return {
        ok: isSmokeSuccessful(checks),
        env: target.env,
        baseUrl: target.baseUrl,
        configPath: target.configPath,
        adminSecretPath,
        checks,
      };
    }
    checks.push(finalizeCheck(listSchemasCheck, 'list custom claim schemas verified'));

    const preferredSmokeFieldKey = pickSupportedScimField(currentSchemas);
    if (preferredSmokeFieldKey) {
      smokeFieldKey = preferredSmokeFieldKey;
    }

    const createSmokeSchemaCheck = makeSmokeCheck(
      'server-surfaces-custom-claim-create',
      'create temporary required registration field',
      `${target.baseUrl}/api/admin/custom-claims`
    );
    await runJsonRequest({
      check: createSmokeSchemaCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/custom-claims',
      method: 'POST',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      expectedStatus: 201,
      body: {
        field_key: smokeFieldKey,
        display_label: smokeFieldLabel,
        field_type: 'string',
        is_pii: false,
        is_required: true,
        show_on_registration: true,
        registration_required: true,
        registration_order: 999,
      },
      validate: (payload, check) => {
        if (!isRecord(payload) || !isRecord(payload.schema)) {
          addFail(check, 'schema response was not found');
          return;
        }
        createdSmokeSchemaId = asString(payload.schema.id) ?? undefined;
        if (createdSmokeSchemaId) {
          addPass(check, `schema_id=${createdSmokeSchemaId}`);
        } else {
          addFail(check, 'created schema id was not found');
        }
      },
    });
    checks.push(
      finalizeCheck(createSmokeSchemaCheck, 'create temporary required registration field verified')
    );

    const registrationFieldsCheck = makeSmokeCheck(
      'server-surfaces-registration-fields',
      'public registration fields includes temporary field',
      `${target.baseUrl}/api/v1/registration-fields`
    );
    await runJsonRequest({
      check: registrationFieldsCheck,
      baseUrl: target.baseUrl,
      path: '/api/v1/registration-fields',
      timeoutMs,
      headers: { accept: 'application/json' },
      validate: (payload, check) => {
        const fields = isRecord(payload) ? asRecordArray(payload.fields) : [];
        if (fields.some((field) => asString(field.field_key) === smokeFieldKey)) {
          addPass(check, `registration field ${smokeFieldKey} verified`);
        } else {
          addFail(check, `registration field ${smokeFieldKey} was not found`);
        }
      },
    });
    checks.push(finalizeCheck(registrationFieldsCheck, 'public registration fields verified'));

    const refreshSchemasCheck = makeSmokeCheck(
      'server-surfaces-custom-claims-refresh',
      'refresh schemas after create',
      `${target.baseUrl}/api/admin/custom-claims?limit=100`
    );
    await runJsonRequest({
      check: refreshSchemasCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/custom-claims?limit=100',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        currentSchemas = parseSchemaSummaries(payload);
        const requiredSchemas = currentSchemas.filter(
          (schema) => schema.isActive && schema.isRequired
        );
        addPass(check, `active required schemas=${requiredSchemas.length}`);
      },
    });
    checks.push(finalizeCheck(refreshSchemasCheck, 'refresh schemas after create verified'));

    const requiredSchemas = currentSchemas.filter((schema) => schema.isActive && schema.isRequired);
    const smokeRequiredSchemas = requiredSchemas.filter(
      (schema) => schema.fieldKey === smokeFieldKey
    );
    if (smokeRequiredSchemas.length === 0) {
      const check = makeSmokeCheck(
        'server-surfaces-required-smoke-schema-missing',
        'temporary required schema missing'
      );
      addFail(check, `${smokeFieldKey} was not included in the required schema list`);
      checks.push(finalizeCheck(check, 'temporary required schema missing'));
      return {
        ok: false,
        env: target.env,
        baseUrl: target.baseUrl,
        configPath: target.configPath,
        adminSecretPath,
        checks,
      };
    }

    const adminMissingPayload = {
      email: `phase15-missing-${smokeRunId}@example.test`,
      name: 'Server Surface Smoke Missing User',
      given_name: 'Phase15',
      family_name: 'Missing',
      preferred_username: `phase15-missing-${smokeRunId}`,
      email_verified: true,
      ...buildAdminCustomFieldPayload(
        requiredSchemas.filter((schema) => schema.fieldKey !== smokeFieldKey)
      ),
    };
    const adminMissingCheck = makeSmokeCheck(
      'server-surfaces-admin-create-required-fail',
      'admin user create fails when required field is missing',
      `${target.baseUrl}/api/admin/users`
    );
    const adminMissingPayloadResponse = await runJsonRequest({
      check: adminMissingCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/users',
      method: 'POST',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      expectedStatus: 400,
      body: adminMissingPayload,
      validate: (payload, check) => {
        if (findMissingRequiredField(payload, smokeFieldKey)) {
          addPass(check, `missing_required_fields includes ${smokeFieldKey}`);
        } else {
          addFail(check, `missing_required_fields does not include ${smokeFieldKey}`);
        }
      },
    });
    void adminMissingPayloadResponse;
    checks.push(finalizeCheck(adminMissingCheck, 'admin required validation verified'));

    const adminCreateCheck = makeSmokeCheck(
      'server-surfaces-admin-create-valid',
      'admin user create succeeds when required fields are present',
      `${target.baseUrl}/api/admin/users`
    );
    await runJsonRequest({
      check: adminCreateCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/users',
      method: 'POST',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      expectedStatus: 201,
      body: {
        email: `phase15-valid-${smokeRunId}@example.test`,
        name: 'Server Surface Smoke Valid User',
        given_name: 'Phase15',
        family_name: 'Valid',
        preferred_username: `phase15-valid-${smokeRunId}`,
        email_verified: true,
        ...buildAdminCustomFieldPayload(requiredSchemas),
      },
      validate: (payload, check) => {
        if (!isRecord(payload) || !isRecord(payload.user)) {
          addFail(check, 'created user response is invalid');
          return;
        }
        createdUserId = asString(payload.user.id) ?? undefined;
        if (createdUserId) {
          addPass(check, `user_id=${createdUserId}`);
        } else {
          addFail(check, 'created user id was not found');
        }
      },
    });
    checks.push(
      finalizeCheck(
        adminCreateCheck,
        'admin user create succeeds when required fields are present verified'
      )
    );

    if (!createdUserId) {
      return {
        ok: false,
        env: target.env,
        baseUrl: target.baseUrl,
        configPath: target.configPath,
        adminSecretPath,
        checks,
      };
    }

    const adminGetCheck = makeSmokeCheck(
      'phase2-admin-user-detail-custom-fields',
      'admin user detail returns persisted custom field',
      `${target.baseUrl}/api/admin/users/${encodeURIComponent(createdUserId)}`
    );
    await runJsonRequest({
      check: adminGetCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/users/${encodeURIComponent(createdUserId)}`,
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        const customFields = isRecord(payload) ? asRecordArray(payload.customFields) : [];
        if (customFields.some((field) => asString(field.field_name) === smokeFieldKey)) {
          addPass(check, `custom field ${smokeFieldKey} persisted verified`);
        } else {
          addFail(check, `custom field ${smokeFieldKey} persisted could not be verified`);
        }
      },
    });
    checks.push(
      finalizeCheck(adminGetCheck, 'admin user detail returns persisted custom field verified')
    );

    const adminUpdateCheck = makeSmokeCheck(
      'server-surfaces-admin-update-required-fail',
      'admin user update fails when clearing required field',
      `${target.baseUrl}/api/admin/users/${encodeURIComponent(createdUserId)}`
    );
    await runJsonRequest({
      check: adminUpdateCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/users/${encodeURIComponent(createdUserId)}`,
      method: 'PUT',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      expectedStatus: 400,
      body: {
        [smokeFieldKey]: null,
      },
      validate: (payload, check) => {
        if (findMissingRequiredField(payload, smokeFieldKey)) {
          addPass(check, `update missing_required_fields includes ${smokeFieldKey}`);
        } else {
          addFail(check, `update missing_required_fields does not include ${smokeFieldKey}`);
        }
      },
    });
    checks.push(finalizeCheck(adminUpdateCheck, 'admin user update required validation verified'));

    const scimSupportedActiveRequired = requiredSchemas.filter((schema) =>
      SCIM_SUPPORTED_REQUIRED_KEYS.includes(
        schema.fieldKey as (typeof SCIM_SUPPORTED_REQUIRED_KEYS)[number]
      )
    );
    let scimTargetField: string | null = scimSupportedActiveRequired[0]?.fieldKey ?? null;
    if (!scimTargetField) {
      scimTargetField = pickSupportedScimField(currentSchemas) ?? null;
      if (scimTargetField) {
        const scimSchemaCheck = makeSmokeCheck(
          'server-surfaces-scim-supported-schema-create',
          'create temporary SCIM-compatible required field',
          `${target.baseUrl}/api/admin/custom-claims`
        );
        await runJsonRequest({
          check: scimSchemaCheck,
          baseUrl: target.baseUrl,
          path: '/api/admin/custom-claims',
          method: 'POST',
          timeoutMs,
          headers: getAdminHeaders(adminSecret, tenantId),
          expectedStatus: 201,
          body: {
            field_key: scimTargetField,
            display_label: `SCIM ${scimTargetField}`,
            field_type: 'string',
            is_pii: false,
            is_required: true,
          },
          validate: (payload, check) => {
            if (!isRecord(payload) || !isRecord(payload.schema)) {
              addFail(check, 'SCIM schema response is invalid');
              return;
            }
            createdScimSchemaId = asString(payload.schema.id) ?? undefined;
            if (createdScimSchemaId) {
              addPass(check, `schema_id=${createdScimSchemaId}`);
            } else {
              addFail(check, 'SCIM schema id was not found');
            }
          },
        });
        checks.push(
          finalizeCheck(scimSchemaCheck, 'create temporary SCIM-compatible required field verified')
        );

        const refreshScimSchemasCheck = makeSmokeCheck(
          'server-surfaces-scim-refresh-schemas',
          'refresh schemas for SCIM checks',
          `${target.baseUrl}/api/admin/custom-claims?limit=100`
        );
        await runJsonRequest({
          check: refreshScimSchemasCheck,
          baseUrl: target.baseUrl,
          path: '/api/admin/custom-claims?limit=100',
          timeoutMs,
          headers: getAdminHeaders(adminSecret, tenantId),
          validate: (payload, check) => {
            currentSchemas = parseSchemaSummaries(payload);
            addPass(check, `schemas=${currentSchemas.length}`);
          },
        });
        checks.push(
          finalizeCheck(refreshScimSchemasCheck, 'refresh schemas for SCIM checks verified')
        );
      }
    }

    const scimTokenCheck = makeSmokeCheck(
      'server-surfaces-scim-token-create',
      'create temporary SCIM token',
      `${target.baseUrl}/api/admin/scim-tokens`
    );
    await runJsonRequest({
      check: scimTokenCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/scim-tokens',
      method: 'POST',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      expectedStatus: 201,
      body: {
        description: `server-surface smoke ${smokeRunId}`,
        expiresInDays: 1,
      },
      validate: (payload, check) => {
        if (!isRecord(payload)) {
          addFail(check, 'SCIM token response is invalid');
          return;
        }
        const token = asString(payload.token);
        const tokenHash = asString(payload.tokenHash);
        if (token && tokenHash) {
          scimToken = { token, tokenHash };
          addPass(check, `token_hash=${tokenHash.slice(0, 8)}`);
        } else {
          addFail(check, 'SCIM token / tokenHash was not found');
        }
      },
    });
    checks.push(finalizeCheck(scimTokenCheck, 'create temporary SCIM token verified'));

    if (scimToken && scimTargetField) {
      const activeRequiredSchemas = currentSchemas.filter(
        (schema) => schema.isActive && schema.isRequired
      );
      const scimMissingCheck = makeSmokeCheck(
        'server-surfaces-scim-create-required-fail',
        'SCIM create fails when required field is missing',
        `${target.baseUrl}/scim/v2/Users`
      );
      await runJsonRequest({
        check: scimMissingCheck,
        baseUrl: target.baseUrl,
        path: '/scim/v2/Users',
        method: 'POST',
        timeoutMs,
        headers: getScimHeaders(scimToken.token),
        expectedStatus: 400,
        body: buildScimUserBody(
          `phase15-scim-missing-${smokeRunId}@example.test`,
          activeRequiredSchemas.filter((schema) => schema.fieldKey !== scimTargetField)
        ),
        validate: (payload, check) => {
          if (findMissingRequiredField(payload, scimTargetField)) {
            addPass(check, `SCIM missing_required_fields includes ${scimTargetField}`);
          } else {
            addFail(check, `SCIM missing_required_fields does not include ${scimTargetField}`);
          }
        },
      });
      checks.push(finalizeCheck(scimMissingCheck, 'SCIM create required validation verified'));

      const scimCreatableRequiredSchemas = activeRequiredSchemas.filter((schema) =>
        SCIM_SUPPORTED_REQUIRED_KEYS.includes(
          schema.fieldKey as (typeof SCIM_SUPPORTED_REQUIRED_KEYS)[number]
        )
      );
      if (canSatisfyRequiredSchemasViaScim(activeRequiredSchemas)) {
        const scimCreateValidCheck = makeSmokeCheck(
          'server-surfaces-scim-create-valid',
          'SCIM create succeeds when required fields are present',
          `${target.baseUrl}/scim/v2/Users`
        );
        const scimValidBody = buildScimUserBody(
          `phase15-scim-valid-${smokeRunId}@example.test`,
          scimCreatableRequiredSchemas
        );
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetchJsonWithTimeout(
            `${target.baseUrl}/scim/v2/Users`,
            timeoutMs,
            {
              method: 'POST',
              headers: getScimHeaders(scimToken.token),
              body: JSON.stringify(scimValidBody),
            }
          );
          scimCreateValidCheck.httpStatus = response.status;
          const payload = parseJsonLikePayload(response);

          if (response.status === 201) {
            addPass(scimCreateValidCheck, 'HTTP 201');
            if (!isRecord(payload)) {
              addFail(scimCreateValidCheck, 'SCIM create response is invalid');
              break;
            }
            createdScimUserId = asString(payload.id) ?? undefined;
            if (createdScimUserId) {
              addPass(scimCreateValidCheck, `scim_user_id=${createdScimUserId}`);
            } else {
              addFail(scimCreateValidCheck, 'SCIM created user id was not found');
            }
            break;
          }

          const retryAfterMs =
            response.status === 401 ? parseRetryAfterMilliseconds(response) : null;
          if (retryAfterMs && attempt === 0) {
            addWarn(
              scimCreateValidCheck,
              `SCIM auth rate limited; waiting ${Math.ceil(retryAfterMs / 1000)}s before retry`
            );
            await wait(retryAfterMs + 1000);
            continue;
          }

          addFail(
            scimCreateValidCheck,
            `POST /scim/v2/Users failed: ${response.status} ${response.error ?? response.bodyText ?? ''}`
          );
          break;
        }
        checks.push(
          finalizeCheck(
            scimCreateValidCheck,
            'SCIM create succeeds when required fields are present verified'
          )
        );
      } else {
        const scimSkipCheck = makeSmokeCheck(
          'server-surfaces-scim-create-valid-skip',
          'SCIM valid create skipped for unsupported required schema set'
        );
        addWarn(
          scimSkipCheck,
          `SCIM success check skipped: unsupported required fields=${activeRequiredSchemas
            .map((schema) => `${schema.fieldKey}:${schema.fieldType}`)
            .join(', ')}`
        );
        checks.push(finalizeCheck(scimSkipCheck, 'SCIM valid create skipped'));
      }
    } else {
      const scimSkipCheck = makeSmokeCheck(
        'server-surfaces-scim-coverage-skip',
        'SCIM coverage skipped'
      );
      addWarn(scimSkipCheck, 'SCIM token or SCIM-compatible required field could not be prepared');
      checks.push(finalizeCheck(scimSkipCheck, 'SCIM coverage skipped'));
    }

    const runtimeDefaultsCheck = makeSmokeCheck(
      'server-surfaces-runtime-profile-defaults',
      'runtime profile defaults',
      `${target.baseUrl}/api/admin/runtime-profiles/defaults`
    );
    await runJsonRequest({
      check: runtimeDefaultsCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/runtime-profiles/defaults',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (!isRecord(payload) || !isRecord(payload.defaults)) {
          addFail(check, 'runtime profile defaults response is invalid');
          return;
        }
        addPass(check, 'defaults object verified');
      },
    });
    checks.push(finalizeCheck(runtimeDefaultsCheck, 'runtime profile defaults verified'));

    const runtimeProfileCreateCheck = makeSmokeCheck(
      'server-surfaces-runtime-profile-create',
      'create temporary audit runtime profile',
      `${target.baseUrl}/api/admin/runtime-profiles/audit/${runtimeProfileId}`
    );
    await runJsonRequest({
      check: runtimeProfileCreateCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/runtime-profiles/audit/${encodeURIComponent(runtimeProfileId)}`,
      method: 'PUT',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      expectedStatus: 201,
      body: {
        label: 'Server Surface Smoke Audit Profile',
        primary: {
          type: 'd1',
          bindingRef: 'DB',
          dataset: 'event_log',
        },
        archive: null,
        sinks: [],
      },
      validate: (payload, check) => {
        if (!isRecord(payload) || !isRecord(payload.profile)) {
          addFail(check, 'runtime profile create response is invalid');
          return;
        }
        createdRuntimeProfileId = asString(payload.profile.id) ?? runtimeProfileId;
        addPass(check, `profile_id=${createdRuntimeProfileId}`);
      },
    });
    checks.push(
      finalizeCheck(runtimeProfileCreateCheck, 'create temporary audit runtime profile verified')
    );

    const runtimeProfileGetCheck = makeSmokeCheck(
      'server-surfaces-runtime-profile-get',
      'get temporary audit runtime profile',
      `${target.baseUrl}/api/admin/runtime-profiles/audit/${runtimeProfileId}`
    );
    await runJsonRequest({
      check: runtimeProfileGetCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/runtime-profiles/audit/${encodeURIComponent(runtimeProfileId)}`,
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (!isRecord(payload) || !isRecord(payload.profile)) {
          addFail(check, 'runtime profile get response is invalid');
          return;
        }
        if (asString(payload.profile.id) === runtimeProfileId) {
          addPass(check, `profile_id=${runtimeProfileId}`);
        } else {
          addFail(check, `profile_id expected=${runtimeProfileId}`);
        }
      },
    });
    checks.push(
      finalizeCheck(runtimeProfileGetCheck, 'get temporary audit runtime profile verified')
    );

    const runtimeProfileListCheck = makeSmokeCheck(
      'server-surfaces-runtime-profile-list',
      'list audit runtime profiles',
      `${target.baseUrl}/api/admin/runtime-profiles?kind=audit`
    );
    let runtimeProfileListFound = false;
    let runtimeProfileListIsKvBackend = false;
    const runtimeProfileListMaxAttempts = 12;
    for (let attempt = 0; attempt < runtimeProfileListMaxAttempts; attempt += 1) {
      await runJsonRequest({
        check: runtimeProfileListCheck,
        baseUrl: target.baseUrl,
        path: '/api/admin/runtime-profiles?kind=audit',
        timeoutMs,
        headers: getAdminHeaders(adminSecret, tenantId),
        validate: (payload, check) => {
          runtimeProfileListIsKvBackend =
            isRecord(payload) && asString(payload.registry_backend) === 'kv';
          const items = getRuntimeProfileListItems(payload, 'audit');
          runtimeProfileListFound = items.some((item) => asString(item.id) === runtimeProfileId);
          if (runtimeProfileListFound) {
            addPass(check, `runtime profile list includes ${runtimeProfileId}`);
            return;
          }
          if (attempt < runtimeProfileListMaxAttempts - 1) {
            addWarn(
              check,
              `runtime profile list retry ${attempt + 1}/${runtimeProfileListMaxAttempts - 1}${runtimeProfileListIsKvBackend ? ' (kv consistency wait)' : ''}`
            );
            return;
          }
          addFail(check, `runtime profile list does not include ${runtimeProfileId}`);
        },
      });
      if (runtimeProfileListFound) {
        break;
      }
      await wait(runtimeProfileListIsKvBackend ? 5000 : 1500);
    }
    checks.push(finalizeCheck(runtimeProfileListCheck, 'list audit runtime profiles verified'));

    const tenantRuntimeProfilesCheck = makeSmokeCheck(
      'server-surfaces-tenant-runtime-profiles',
      'tenant effective runtime profiles',
      `${target.baseUrl}/api/admin/tenants/${encodeURIComponent(tenantId)}/runtime-profiles`
    );
    await runJsonRequest({
      check: tenantRuntimeProfilesCheck,
      baseUrl: target.baseUrl,
      path: `/api/admin/tenants/${encodeURIComponent(tenantId)}/runtime-profiles`,
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (!isRecord(payload) || !isRecord(payload.effective)) {
          addFail(check, 'tenant runtime profiles response is invalid');
          return;
        }
        addPass(check, `tenant_id=${tenantId}`);
      },
    });
    checks.push(
      finalizeCheck(tenantRuntimeProfilesCheck, 'tenant effective runtime profiles verified')
    );

    const auditStorageConfigCheck = makeSmokeCheck(
      'phase4-audit-storage-config',
      'audit storage config',
      `${target.baseUrl}/api/admin/settings/audit-storage`
    );
    await runJsonRequest({
      check: auditStorageConfigCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/settings/audit-storage',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (isRecord(payload)) {
          addPass(check, 'audit storage config object verified');
        } else {
          addFail(check, 'audit storage config response is invalid');
        }
      },
    });
    checks.push(finalizeCheck(auditStorageConfigCheck, 'audit storage config verified'));

    const auditRetentionCheck = makeSmokeCheck(
      'phase4-audit-storage-retention',
      'audit storage retention',
      `${target.baseUrl}/api/admin/settings/audit-storage/retention`
    );
    await runJsonRequest({
      check: auditRetentionCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/settings/audit-storage/retention',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (isRecord(payload)) {
          addPass(check, 'audit retention object verified');
        } else {
          addFail(check, 'audit retention response is invalid');
        }
      },
    });
    checks.push(finalizeCheck(auditRetentionCheck, 'audit storage retention verified'));

    const routingRuleCreateCheck = makeSmokeCheck(
      'phase4-routing-rule-create',
      'create temporary audit routing rule',
      `${target.baseUrl}/api/admin/settings/audit-storage/routing-rules`
    );
    await runJsonRequest({
      check: routingRuleCreateCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/settings/audit-storage/routing-rules',
      method: 'POST',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      body: {
        name: routingRuleName,
        priority: 100,
        enabled: true,
        conditions: { tenantId },
        backend: 'd1-core',
      },
      validate: (payload, check) => {
        if (!isRecord(payload) || !isRecord(payload.rule)) {
          addFail(check, 'routing rule create response is invalid');
          return;
        }
        createdRoutingRuleName = asString(payload.rule.name) ?? routingRuleName;
        addPass(check, `rule_name=${createdRoutingRuleName}`);
      },
    });
    checks.push(
      finalizeCheck(routingRuleCreateCheck, 'create temporary audit routing rule verified')
    );

    const routingRuleListCheck = makeSmokeCheck(
      'phase4-routing-rule-list',
      'list audit routing rules',
      `${target.baseUrl}/api/admin/settings/audit-storage/routing-rules`
    );
    await runJsonRequest({
      check: routingRuleListCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/settings/audit-storage/routing-rules',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        const rules = isRecord(payload) ? asRecordArray(payload.rules) : [];
        if (rules.some((rule) => asString(rule.name) === routingRuleName)) {
          addPass(check, `routing rule ${routingRuleName} verified`);
        } else {
          addFail(check, `routing rule ${routingRuleName} was not found`);
        }
      },
    });
    checks.push(finalizeCheck(routingRuleListCheck, 'list audit routing rules verified'));

    const auditStatsCheck = makeSmokeCheck(
      'phase4-audit-storage-stats',
      'audit storage stats',
      `${target.baseUrl}/api/admin/settings/audit-storage/stats`
    );
    await runJsonRequest({
      check: auditStatsCheck,
      baseUrl: target.baseUrl,
      path: '/api/admin/settings/audit-storage/stats',
      timeoutMs,
      headers: getAdminHeaders(adminSecret, tenantId),
      validate: (payload, check) => {
        if (isRecord(payload)) {
          addPass(check, 'audit storage stats object verified');
        } else {
          addFail(check, 'audit storage stats response is invalid');
        }
      },
    });
    checks.push(finalizeCheck(auditStatsCheck, 'audit storage stats verified'));
  } finally {
    await deleteAdminUser({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      userId: createdScimUserId,
    });
    await deleteAdminUser({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      userId: createdUserId,
    });
    await revokeScimToken({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      tokenHash: scimToken?.tokenHash,
    });
    await deleteRoutingRule({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      ruleName: createdRoutingRuleName,
    });
    await deleteRuntimeProfile({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      kind: 'audit',
      profileId: createdRuntimeProfileId,
    });
    await deleteCustomClaimSchema({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      schemaId: createdScimSchemaId,
    });
    await deleteCustomClaimSchema({
      checks,
      baseUrl: target.baseUrl,
      timeoutMs,
      adminSecret,
      tenantId,
      schemaId: createdSmokeSchemaId,
    });
    await adminAccess.cleanup?.();
  }

  return {
    ok: isSmokeSuccessful(checks),
    env: target.env,
    baseUrl: target.baseUrl,
    configPath: target.configPath,
    adminSecretPath,
    checks,
  };
}
