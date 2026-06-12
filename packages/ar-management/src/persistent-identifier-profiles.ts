import type { Context } from 'hono';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import {
  generatePersistentIdentifier,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  resolveOIDCPairwiseAudience,
  resolveSAMLPersistentIdentifierAudience,
  type PersistentIdentifierAlgorithm as ComputedPersistentIdentifierAlgorithm,
} from '@authrim/ar-lib-core';

type AdminContext = Context<{ Bindings: Env }>;

type PersistentIdentifierMode = 'computed' | 'stored' | 'imported';
type PersistentIdentifierAlgorithm =
  | 'authrim_sha256_base64url'
  | 'shibboleth_sha1_base64'
  | 'stored'
  | 'imported';
type PersistentIdentifierProtocolScope = 'any' | 'saml' | 'oidc' | 'generic';
type PersistentIdentifierAudienceMode = 'runtime' | 'saml_sp_entity_id' | 'oidc_sector_identifier';

interface PersistentIdentifierProfileRow {
  id: string;
  tenant_id: string;
  profile_key: string;
  display_name: string;
  description: string | null;
  mode: PersistentIdentifierMode;
  algorithm: PersistentIdentifierAlgorithm;
  protocol_scope: PersistentIdentifierProtocolScope;
  usage_json: string;
  source_ref_json: string | null;
  secret_ref: string | null;
  issuer_entity_id: string | null;
  audience_mode: PersistentIdentifierAudienceMode;
  format_json: string;
  lifecycle_state: string;
  created_at: number;
  updated_at: number;
}

export interface PersistentIdentifierProfile {
  id: string;
  tenantId: string;
  profileKey: string;
  displayName: string;
  description?: string | null;
  mode: PersistentIdentifierMode;
  algorithm: PersistentIdentifierAlgorithm;
  protocolScope: PersistentIdentifierProtocolScope;
  usage: string[];
  sourceRef?: Record<string, unknown> | null;
  secretRef?: string | null;
  issuerEntityId?: string | null;
  audienceMode: PersistentIdentifierAudienceMode;
  format: Record<string, unknown>;
  lifecycleState: string;
  createdAt: number;
  updatedAt: number;
}

const PROFILE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const VALID_MODES = new Set<PersistentIdentifierMode>(['computed', 'stored', 'imported']);
const VALID_ALGORITHMS = new Set<PersistentIdentifierAlgorithm>([
  'authrim_sha256_base64url',
  'shibboleth_sha1_base64',
  'stored',
  'imported',
]);
const VALID_PROTOCOL_SCOPES = new Set<PersistentIdentifierProtocolScope>([
  'any',
  'saml',
  'oidc',
  'generic',
]);
const VALID_AUDIENCE_MODES = new Set<PersistentIdentifierAudienceMode>([
  'runtime',
  'saml_sp_entity_id',
  'oidc_sector_identifier',
]);

export async function adminPersistentIdentifierProfilesListHandler(
  c: AdminContext
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env);
  const rows = await adapter.query<PersistentIdentifierProfileRow>(
    `SELECT *
       FROM persistent_identifier_profiles
      WHERE tenant_id = ?
      ORDER BY updated_at DESC, display_name ASC`,
    [tenantId]
  );
  return c.json({ profiles: rows.map(toProfile) });
}

export async function adminPersistentIdentifierProfileGetHandler(
  c: AdminContext
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env);
  const profileId = c.req.param('profileId');
  const row = profileId ? await loadProfile(adapter, tenantId, profileId) : null;
  if (!row) {
    return c.json({ error: 'not_found', error_description: 'Profile not found' }, 404);
  }
  return c.json({ result: toProfile(row) });
}

export async function adminPersistentIdentifierProfileCreateHandler(
  c: AdminContext
): Promise<Response> {
  let tenantId: string;
  let adapter: DatabaseAdapter;
  let input: ReturnType<typeof normalizeProfileInput>;
  try {
    tenantId = getTenantIdFromContext(c);
    adapter = requireDedicatedAdminDatabaseAdapter(c.env);
    const body = await readJson(c);
    input = normalizeProfileInput(body, tenantId);
  } catch (error) {
    return invalidRequest(c, errorMessage(error));
  }
  const now = Date.now();
  const row: PersistentIdentifierProfileRow = {
    id: `persistent_identifier_profile_${crypto.randomUUID()}`,
    tenant_id: tenantId,
    profile_key: input.profileKey,
    display_name: input.displayName,
    description: input.description ?? null,
    mode: input.mode,
    algorithm: input.algorithm,
    protocol_scope: input.protocolScope,
    usage_json: JSON.stringify(input.usage),
    source_ref_json: input.sourceRef ? JSON.stringify(input.sourceRef) : null,
    secret_ref: input.secretRef ?? null,
    issuer_entity_id: input.issuerEntityId ?? null,
    audience_mode: input.audienceMode,
    format_json: JSON.stringify(input.format),
    lifecycle_state: input.lifecycleState,
    created_at: now,
    updated_at: now,
  };
  try {
    await adapter.execute(
      `INSERT INTO persistent_identifier_profiles (
         id, tenant_id, profile_key, display_name, description, mode, algorithm, protocol_scope,
         usage_json, source_ref_json, secret_ref, issuer_entity_id, audience_mode, format_json,
         lifecycle_state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenant_id,
        row.profile_key,
        row.display_name,
        row.description,
        row.mode,
        row.algorithm,
        row.protocol_scope,
        row.usage_json,
        row.source_ref_json,
        row.secret_ref,
        row.issuer_entity_id,
        row.audience_mode,
        row.format_json,
        row.lifecycle_state,
        row.created_at,
        row.updated_at,
      ]
    );
    if (row.secret_ref) {
      await ensureProfileSecret(c.env, tenantId, row.secret_ref);
    }
  } catch (error) {
    return writeFailed(c, error);
  }
  return c.json({ result: toProfile(row) }, 201);
}

export async function adminPersistentIdentifierProfileUpdateHandler(
  c: AdminContext
): Promise<Response> {
  let tenantId: string;
  let adapter: DatabaseAdapter;
  let input: ReturnType<typeof normalizeProfileInput>;
  const profileId = c.req.param('profileId');
  if (!profileId) {
    return invalidRequest(c, 'profileId is required');
  }
  try {
    tenantId = getTenantIdFromContext(c);
    adapter = requireDedicatedAdminDatabaseAdapter(c.env);
    const body = await readJson(c);
    input = normalizeProfileInput(body, tenantId);
  } catch (error) {
    return invalidRequest(c, errorMessage(error));
  }
  const now = Date.now();
  try {
    await adapter.execute(
      `UPDATE persistent_identifier_profiles
          SET profile_key = ?,
              display_name = ?,
              description = ?,
              mode = ?,
              algorithm = ?,
              protocol_scope = ?,
              usage_json = ?,
              source_ref_json = ?,
              secret_ref = ?,
              issuer_entity_id = ?,
              audience_mode = ?,
              format_json = ?,
              lifecycle_state = ?,
              updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        input.profileKey,
        input.displayName,
        input.description ?? null,
        input.mode,
        input.algorithm,
        input.protocolScope,
        JSON.stringify(input.usage),
        input.sourceRef ? JSON.stringify(input.sourceRef) : null,
        input.secretRef ?? null,
        input.issuerEntityId ?? null,
        input.audienceMode,
        JSON.stringify(input.format),
        input.lifecycleState,
        now,
        tenantId,
        profileId,
      ]
    );
    if (input.secretRef) {
      await ensureProfileSecret(c.env, tenantId, input.secretRef);
    }
  } catch (error) {
    return writeFailed(c, error);
  }
  const row = await loadProfile(adapter, tenantId, profileId);
  if (!row) return c.json({ error: 'not_found', error_description: 'Profile not found' }, 404);
  return c.json({ result: toProfile(row) });
}

export async function adminPersistentIdentifierProfileDeleteHandler(
  c: AdminContext
): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const profileId = c.req.param('profileId');
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env);
  const references = profileId ? await findProfileReferences(adapter, tenantId, profileId) : [];
  if (references.length > 0) {
    return c.json(
      {
        error: 'conflict',
        error_description: 'Persistent Identifier Profile is used by field mapping versions',
        references,
      },
      409
    );
  }
  await adapter.execute(
    'DELETE FROM persistent_identifier_profiles WHERE tenant_id = ? AND id = ?',
    [tenantId, profileId]
  );
  return c.json({ result: { deleted: true, id: profileId } });
}

export async function adminPersistentIdentifierPreviewHandler(c: AdminContext): Promise<Response> {
  const tenantId = getTenantIdFromContext(c);
  const adapter = requireDedicatedAdminDatabaseAdapter(c.env);
  let body: unknown;
  try {
    body = await readJson(c);
  } catch (error) {
    return invalidRequest(c, errorMessage(error));
  }
  if (!isRecord(body)) {
    return invalidRequest(c, 'Request body must be an object');
  }

  const profileId = readString(body.profileId);
  if (!profileId) {
    return invalidRequest(c, 'profileId is required');
  }
  const subject = readString(body.subject);
  const audience = readString(body.audience);
  if (!subject || !audience) {
    return invalidRequest(c, 'subject and audience are required');
  }

  const profileRow = await loadProfile(adapter, tenantId, profileId);
  if (!profileRow) {
    return c.json({ error: 'not_found', error_description: 'Profile not found' }, 404);
  }
  const profile = toProfile(profileRow);
  if (profile.mode !== 'computed' || !isComputedAlgorithm(profile.algorithm)) {
    return invalidRequest(c, 'Only computed persistent identifier profiles can be previewed');
  }
  let opaque: string;
  try {
    const secret = await resolvePreviewSecret(c, tenantId, profile);
    const resolvedAudience = resolvePreviewAudience({ tenantId, profile, audience });
    opaque = await generatePersistentIdentifier({
      algorithm: profile.algorithm,
      subject,
      audience: resolvedAudience,
      secret,
    });
  } catch (error) {
    return c.json({ error: 'preview_failed', error_description: errorMessage(error) }, 400);
  }
  const issuer = readString(body.issuerEntityId) ?? profile.issuerEntityId ?? null;
  const samlAttributeValue = issuer ? `${issuer}!${audience}!${opaque}` : null;

  return c.json({
    result: {
      profileId: profile.id,
      algorithm: profile.algorithm,
      subject,
      audience,
      opaque,
      samlAttributeValue,
      oidcPairwiseSub: opaque,
      secretRef: profile.secretRef,
      secretMaterialIncluded: false,
    },
  });
}

async function loadProfile(
  adapter: DatabaseAdapter,
  tenantId: string,
  profileId: string
): Promise<PersistentIdentifierProfileRow | null> {
  const rows = await adapter.query<PersistentIdentifierProfileRow>(
    'SELECT * FROM persistent_identifier_profiles WHERE tenant_id = ? AND id = ? LIMIT 1',
    [tenantId, profileId]
  );
  return rows[0] ?? null;
}

async function resolvePreviewSecret(
  c: AdminContext,
  tenantId: string,
  profile: PersistentIdentifierProfile
): Promise<string> {
  if (!profile.secretRef) {
    throw new Error('Persistent identifier profile secretRef is not configured');
  }
  const keyManagerId = c.env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = c.env.KEY_MANAGER.get(keyManagerId);
  const secret = await keyManager.getSecretRpc(profile.secretRef);
  const value = secret?.active?.value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Persistent identifier profile secretRef is not available');
  }
  return value;
}

async function ensureProfileSecret(env: Env, tenantId: string, secretRef: string): Promise<void> {
  const keyManagerId = env.KEY_MANAGER.idFromName(`${tenantId}-v3`);
  const keyManager = env.KEY_MANAGER.get(keyManagerId);
  await keyManager.getOrCreateSecretRpc(secretRef);
}

function resolvePreviewAudience(input: {
  tenantId: string;
  profile: PersistentIdentifierProfile;
  audience: string;
}): string {
  if (
    input.profile.protocolScope === 'saml' ||
    input.profile.algorithm === 'shibboleth_sha1_base64' ||
    input.profile.audienceMode === 'saml_sp_entity_id'
  ) {
    return resolveSAMLPersistentIdentifierAudience({
      tenantId: input.tenantId,
      spEntityId: input.audience,
      algorithm: input.profile.algorithm as ComputedPersistentIdentifierAlgorithm,
      audienceMode: input.profile.audienceMode,
    });
  }
  return resolveOIDCPairwiseAudience({
    clientId: input.audience,
    sectorIdentifier: input.audience,
    audienceMode: input.profile.audienceMode,
  });
}

function isComputedAlgorithm(
  value: PersistentIdentifierAlgorithm
): value is ComputedPersistentIdentifierAlgorithm {
  return value === 'authrim_sha256_base64url' || value === 'shibboleth_sha1_base64';
}

interface ProfileReference {
  fieldMappingSetId: string;
  versionId: string;
  lifecycleState: string;
  transformId: string;
}

async function findProfileReferences(
  adapter: DatabaseAdapter,
  tenantId: string,
  profileId: string
): Promise<ProfileReference[]> {
  const rows = await adapter.query<{
    field_mapping_set_id: string;
    version_id: string;
    lifecycle_state: string;
    transform_id: string;
    parameters_json: string | null;
  }>(
    `SELECT v.field_mapping_set_id,
            v.id AS version_id,
            v.lifecycle_state,
            t.id AS transform_id,
            t.parameters_json
       FROM field_mapping_versions v
       JOIN mapping_rules r
         ON r.tenant_id = v.tenant_id
        AND r.field_mapping_version_id = v.id
       JOIN mapping_transform_steps t
         ON t.tenant_id = r.tenant_id
        AND t.rule_id = r.id
      WHERE v.tenant_id = ?
        AND v.lifecycle_state IN ('draft', 'reviewed', 'published', 'active')
        AND t.operation IN ('oidc_pairwise_sub', 'saml_edu_person_targeted_id')
        AND t.parameters_json LIKE ?`,
    [tenantId, `%${profileId}%`]
  );
  return rows
    .filter((row) => {
      const parameters = parseJsonObject(row.parameters_json, {});
      return parameters?.persistentIdentifierProfileId === profileId;
    })
    .map((row) => ({
      fieldMappingSetId: row.field_mapping_set_id,
      versionId: row.version_id,
      lifecycleState: row.lifecycle_state,
      transformId: row.transform_id,
    }));
}

function normalizeProfileInput(
  value: unknown,
  tenantId: string
): Omit<PersistentIdentifierProfile, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'> {
  if (!isRecord(value)) {
    throw new Error('Request body must be an object');
  }
  const displayName = readString(value.displayName);
  if (!displayName) throw new Error('displayName is required');
  const profileKey = readString(value.profileKey) ?? slugKey(displayName);
  if (!PROFILE_KEY_PATTERN.test(profileKey)) throw new Error('profileKey is invalid');
  const mode = enumValue(value.mode, VALID_MODES, 'computed');
  const algorithm = enumValue(value.algorithm, VALID_ALGORITHMS, 'authrim_sha256_base64url');
  const protocolScope = enumValue(value.protocolScope, VALID_PROTOCOL_SCOPES, 'any');
  const audienceMode = enumValue(value.audienceMode, VALID_AUDIENCE_MODES, 'runtime');
  return {
    profileKey,
    displayName,
    description: readString(value.description) ?? null,
    mode,
    algorithm,
    protocolScope,
    usage: parseStringArray(value.usage),
    sourceRef: isRecord(value.sourceRef) ? value.sourceRef : null,
    secretRef: readString(value.secretRef) ?? defaultSecretRef(tenantId, protocolScope),
    issuerEntityId: readString(value.issuerEntityId) ?? null,
    audienceMode,
    format: isRecord(value.format) ? value.format : {},
    lifecycleState: readString(value.lifecycleState) ?? 'active',
  };
}

function toProfile(row: PersistentIdentifierProfileRow): PersistentIdentifierProfile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    profileKey: row.profile_key,
    displayName: row.display_name,
    description: row.description,
    mode: row.mode,
    algorithm: row.algorithm,
    protocolScope: row.protocol_scope,
    usage: parseJsonStringArray(row.usage_json),
    sourceRef: parseJsonObject(row.source_ref_json),
    secretRef: row.secret_ref,
    issuerEntityId: row.issuer_entity_id,
    audienceMode: row.audience_mode,
    format: parseJsonObject(row.format_json) ?? {},
    lifecycleState: row.lifecycle_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readJson(c: AdminContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function invalidRequest(c: AdminContext, message: string): Response {
  return c.json({ error: 'invalid_request', error_description: message }, 400);
}

function writeFailed(c: AdminContext, error: unknown): Response {
  const message = errorMessage(error);
  if (/unique|constraint|duplicate/i.test(message)) {
    return c.json(
      {
        error: 'conflict',
        error_description: 'Persistent Identifier Profile already exists',
      },
      409
    );
  }
  return c.json({ error: 'internal_error', error_description: message }, 500);
}

function defaultSecretRef(
  tenantId: string,
  protocolScope: PersistentIdentifierProtocolScope
): string {
  return protocolScope === 'oidc'
    ? `tenant:${tenantId}:oidc:pairwise-sub`
    : `tenant:${tenantId}:saml:pairwise-nameid`;
}

function enumValue<T extends string>(value: unknown, valid: Set<T>, fallback: T): T {
  return typeof value === 'string' && valid.has(value as T) ? (value as T) : fallback;
}

function slugKey(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || `profile_${crypto.randomUUID()}`;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string')))
    : [];
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return parseStringArray(parsed);
  } catch {
    return [];
  }
}

function parseJsonObject(
  value: string | null,
  fallback: Record<string, unknown> | null = null
): Record<string, unknown> | null {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}
