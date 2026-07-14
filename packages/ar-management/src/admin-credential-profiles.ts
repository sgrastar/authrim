import type { Context } from 'hono';
import type {
  AdminAuthContext,
  DatabaseAdapter,
  Env,
  FlowRuntimeContract,
  FlowRuntimeStep,
} from '@authrim/ar-lib-core';
import {
  CanonicalRuntimeUserProjectionRepository,
  CanonicalSensitiveValueResolver,
  canonicalProjectionToOIDCClaimsUser,
  createAuditLogFromContext,
  createAuthContextFromHono,
  createPIIContextFromHono,
  getLogger,
  getTenantIdFromContext,
  requireDedicatedAdminDatabaseAdapter,
  resolveRuntimeIdentityMappingBinding,
  executeServerFlow,
} from '@authrim/ar-lib-core';
import { executeRuntimeMapping, type SourceValueEnvelope } from '@authrim/ar-lib-field-mapping';
import { getCanonicalTenantBaseUrlAsync } from './request-issuer';

type AdminContext = Context<{ Bindings: Env }>;
type AdminVariableContext = Context<{
  Bindings: Env;
  Variables: { adminAuth?: AdminAuthContext };
}>;

interface ProfileRow {
  id: string;
  tenant_id: string;
  profile_key: string;
  display_name: string;
  description: string | null;
  lifecycle_state: 'draft' | 'published' | 'disabled';
  current_published_version_id: string | null;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  tenant_id: string;
  credential_profile_id: string;
  version_number: number;
  lifecycle_state: 'draft' | 'published' | 'retired';
  credential_configuration_id: string;
  issuance_flow_id: string;
  issuance_flow_version_id: string | null;
  verification_flow_id: string | null;
  verification_flow_version_id: string | null;
  issuance_mapping_set_id: string;
  issuance_mapping_version_id: string | null;
  issuance_mapping_snapshot_hash: string | null;
  verification_mapping_set_id: string | null;
  verification_mapping_version_id: string | null;
  verification_mapping_snapshot_hash: string | null;
  claim_allowlist_json: string;
  offer_ttl_seconds: number;
  maximum_attribute_age_seconds: number;
  transaction_code_required: number;
  snapshot_hash: string | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

interface VersionBody {
  credential_configuration_id?: string;
  issuance_flow_id?: string;
  verification_flow_id?: string | null;
  issuance_mapping_set_id?: string;
  verification_mapping_set_id?: string | null;
  claim_allowlist?: string[];
  offer_ttl_seconds?: number;
  maximum_attribute_age_seconds?: number;
  transaction_code_required?: boolean;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VC_DESTINATION_PREFIX = 'vc.claims.';

function adminDb(c: AdminContext): DatabaseAdapter {
  return requireDedicatedAdminDatabaseAdapter(c.env, 'vc-credential-profiles');
}

function coreDb(c: AdminContext, tenantId: string): DatabaseAdapter {
  return createAuthContextFromHono(c, tenantId).coreAdapter;
}

function actorId(c: AdminContext): string | null {
  return (c as unknown as AdminVariableContext).get('adminAuth')?.userId ?? null;
}

function pathId(c: AdminContext, name: 'id' | 'versionId'): string {
  return c.req.param(name) ?? '';
}

function invalid(c: AdminContext, description: string, status: 400 | 404 | 409 = 400) {
  return c.json(
    { error: status === 404 ? 'not_found' : 'invalid_request', error_description: description },
    status
  );
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_KEY.test(value.trim()))
    throw new Error(`invalid_${field}`);
  return value.trim();
}

function normalizeClaims(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('invalid_claim_allowlist');
  const claims = [...new Set(value.map((item) => requireKey(item, 'claim_name')))].sort();
  if (claims.length === 0 || claims.length > 128) throw new Error('invalid_claim_allowlist');
  return claims;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function hashSnapshot(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

async function signCredentialProfileContract(
  env: Env,
  values: readonly unknown[]
): Promise<string> {
  const secret = env.VC_PROFILE_CONTRACT_HMAC_SECRET;
  if (!secret || secret.length < 32) throw new Error('vc_profile_contract_secret_missing');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(values)))
  );
  return btoa(String.fromCharCode(...signature))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

async function loadProfile(c: AdminContext, id: string): Promise<ProfileRow | null> {
  return adminDb(c).queryOne<ProfileRow>(
    'SELECT * FROM credential_profiles WHERE tenant_id = ? AND id = ?',
    [getTenantIdFromContext(c), id]
  );
}

async function loadVersion(
  c: AdminContext,
  profileId: string,
  versionId: string
): Promise<VersionRow | null> {
  return adminDb(c).queryOne<VersionRow>(
    `SELECT * FROM credential_profile_versions
      WHERE tenant_id = ? AND credential_profile_id = ? AND id = ?`,
    [getTenantIdFromContext(c), profileId, versionId]
  );
}

export async function adminCredentialProfilesListHandler(c: AdminContext) {
  const rows = await adminDb(c).query<ProfileRow>(
    'SELECT * FROM credential_profiles WHERE tenant_id = ? ORDER BY updated_at DESC',
    [getTenantIdFromContext(c)]
  );
  return c.json({ credential_profiles: rows });
}

export async function adminCredentialProfileCreateHandler(c: AdminContext) {
  try {
    const body = await c.req.json<{
      profile_key?: string;
      display_name?: string;
      description?: string;
    }>();
    const tenantId = getTenantIdFromContext(c);
    const profileKey = requireKey(body.profile_key, 'profile_key');
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    if (!displayName || displayName.length > 200) return invalid(c, 'display_name is required');
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await adminDb(c).execute(
      `INSERT INTO credential_profiles
       (id, tenant_id, profile_key, display_name, description, lifecycle_state,
        created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [
        id,
        tenantId,
        profileKey,
        displayName,
        body.description?.slice(0, 2000) ?? null,
        actorId(c),
        now,
        actorId(c),
        now,
      ]
    );
    await createAuditLogFromContext(c, 'credential_profile.created', 'credential_profile', id, {
      profile_key: profileKey,
    });
    return c.json({ credential_profile: await loadProfile(c, id) }, 201);
  } catch (error) {
    getLogger(c)
      .module('VC-PROFILES')
      .warn('Credential profile create rejected', {}, error as Error);
    return invalid(c, 'Credential profile is invalid or already exists', 409);
  }
}

export async function adminCredentialProfileGetHandler(c: AdminContext) {
  const profile = await loadProfile(c, pathId(c, 'id'));
  if (!profile) return invalid(c, 'Credential profile was not found', 404);
  const versions = await adminDb(c).query<VersionRow>(
    `SELECT * FROM credential_profile_versions
      WHERE tenant_id = ? AND credential_profile_id = ? ORDER BY version_number DESC`,
    [profile.tenant_id, profile.id]
  );
  return c.json({ credential_profile: profile, versions });
}

export async function adminCredentialProfileUpdateHandler(c: AdminContext) {
  try {
    const profile = await loadProfile(c, pathId(c, 'id'));
    if (!profile) return invalid(c, 'Credential profile was not found', 404);
    const body = await c.req.json<{
      display_name?: string;
      description?: string | null;
      lifecycle_state?: 'draft' | 'disabled';
    }>();
    if (body.lifecycle_state && !['draft', 'disabled'].includes(body.lifecycle_state)) {
      return invalid(c, 'Only draft or disabled lifecycle state may be set directly');
    }
    const displayName = body.display_name?.trim() ?? profile.display_name;
    if (!displayName || displayName.length > 200) return invalid(c, 'display_name is invalid');
    const now = Math.floor(Date.now() / 1000);
    await adminDb(c).execute(
      `UPDATE credential_profiles
          SET display_name = ?, description = ?, lifecycle_state = ?, updated_by = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`,
      [
        displayName,
        body.description === undefined
          ? profile.description
          : (body.description?.slice(0, 2000) ?? null),
        body.lifecycle_state ?? profile.lifecycle_state,
        actorId(c),
        now,
        profile.tenant_id,
        profile.id,
      ]
    );
    await createAuditLogFromContext(
      c,
      'credential_profile.updated',
      'credential_profile',
      profile.id,
      {
        lifecycle_state: body.lifecycle_state ?? profile.lifecycle_state,
      }
    );
    return c.json({ credential_profile: await loadProfile(c, profile.id) });
  } catch (error) {
    getLogger(c)
      .module('VC-PROFILES')
      .warn('Credential profile update rejected', {}, error as Error);
    return invalid(c, 'Credential profile update is invalid');
  }
}

export async function adminCredentialProfileVersionCreateHandler(c: AdminContext) {
  try {
    const profile = await loadProfile(c, pathId(c, 'id'));
    if (!profile) return invalid(c, 'Credential profile was not found', 404);
    if (profile.lifecycle_state === 'disabled')
      return invalid(c, 'Credential profile is disabled', 409);
    const body = await c.req.json<VersionBody>();
    const configurationId = requireKey(
      body.credential_configuration_id,
      'credential_configuration_id'
    );
    const issuanceFlowId = requireKey(body.issuance_flow_id, 'issuance_flow_id');
    const issuanceMappingSetId = requireKey(
      body.issuance_mapping_set_id,
      'issuance_mapping_set_id'
    );
    const claimAllowlist = normalizeClaims(body.claim_allowlist);
    const ttl = body.offer_ttl_seconds ?? 300;
    const maxAge = body.maximum_attribute_age_seconds ?? 86400;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 900) throw new Error('invalid_offer_ttl');
    if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 2592000)
      throw new Error('invalid_attribute_age');
    const latest = await adminDb(c).queryOne<{ max_version: number | null }>(
      'SELECT MAX(version_number) AS max_version FROM credential_profile_versions WHERE tenant_id = ? AND credential_profile_id = ?',
      [profile.tenant_id, profile.id]
    );
    const id = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    await adminDb(c).execute(
      `INSERT INTO credential_profile_versions
       (id, tenant_id, credential_profile_id, version_number, lifecycle_state,
        credential_configuration_id, issuance_flow_id, verification_flow_id,
        issuance_mapping_set_id, verification_mapping_set_id, claim_allowlist_json,
        offer_ttl_seconds, maximum_attribute_age_seconds, transaction_code_required,
        created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        profile.tenant_id,
        profile.id,
        Number(latest?.max_version ?? 0) + 1,
        configurationId,
        issuanceFlowId,
        body.verification_flow_id
          ? requireKey(body.verification_flow_id, 'verification_flow_id')
          : null,
        issuanceMappingSetId,
        body.verification_mapping_set_id
          ? requireKey(body.verification_mapping_set_id, 'verification_mapping_set_id')
          : null,
        JSON.stringify(claimAllowlist),
        ttl,
        maxAge,
        body.transaction_code_required ? 1 : 0,
        actorId(c),
        now,
        actorId(c),
        now,
      ]
    );
    await createAuditLogFromContext(
      c,
      'credential_profile.version_created',
      'credential_profile',
      profile.id,
      { version_id: id }
    );
    return c.json({ version: await loadVersion(c, profile.id, id) }, 201);
  } catch (error) {
    getLogger(c)
      .module('VC-PROFILES')
      .warn('Credential profile version rejected', {}, error as Error);
    return invalid(c, 'Credential profile version is invalid');
  }
}

async function requirePublishedFlow(
  db: DatabaseAdapter,
  tenantId: string,
  flowId: string,
  kind: string
) {
  const row = await db.queryOne<{
    id: string;
    published_version_id: string | null;
    status: string;
    kind: string;
  }>('SELECT id, published_version_id, status, kind FROM flows WHERE tenant_id = ? AND id = ?', [
    tenantId,
    flowId,
  ]);
  if (!row || row.status !== 'published' || !row.published_version_id || row.kind !== kind) {
    throw new Error(`unpublished_${kind}_flow`);
  }
  return row.published_version_id;
}

async function validatePublishedProfileFlow(
  db: DatabaseAdapter,
  tenantId: string,
  flowVersionId: string,
  kind: 'credential_issuance' | 'attribute_elevation',
  profileId: string
): Promise<void> {
  const row = await db.queryOne<{ runtime_snapshot_json: string }>(
    'SELECT runtime_snapshot_json FROM flow_versions WHERE tenant_id = ? AND id = ?',
    [tenantId, flowVersionId]
  );
  if (!row) throw new Error('profile_flow_version_not_found');
  const state = { firstStepComplete: false, secondStepComplete: false };
  const checkRef = (value: unknown) =>
    value === profileId ||
    (!!value && typeof value === 'object' && (value as { id?: unknown }).id === profileId);
  const first = kind === 'credential_issuance' ? 'credential_claims' : 'credential_presentation';
  const second = kind === 'credential_issuance' ? 'credential_offer' : 'verified_attribute';
  await executeServerFlow({
    contract: JSON.parse(row.runtime_snapshot_json) as FlowRuntimeContract,
    expectedKind: kind,
    state,
    handlers: {
      [first]: ({ step, state: current }: { step: FlowRuntimeStep; state: typeof state }) => {
        if (!checkRef(step.config?.credential_profile_ref))
          throw new Error('profile_flow_ref_mismatch');
        current.firstStepComplete = true;
        return { handle: kind === 'credential_issuance' ? 'resolved' : 'verified' };
      },
      [second]: ({ step, state: current }: { step: FlowRuntimeStep; state: typeof state }) => {
        if (!checkRef(step.config?.credential_profile_ref) || !current.firstStepComplete) {
          throw new Error('profile_flow_order_invalid');
        }
        current.secondStepComplete = true;
        return { handle: kind === 'credential_issuance' ? 'created' : 'committed' };
      },
    },
  });
  if (!state.firstStepComplete || !state.secondStepComplete)
    throw new Error('profile_flow_incomplete');
}

export async function adminCredentialProfilePublishHandler(c: AdminContext) {
  try {
    const profile = await loadProfile(c, pathId(c, 'id'));
    if (!profile) return invalid(c, 'Credential profile was not found', 404);
    const version = await loadVersion(c, profile.id, pathId(c, 'versionId'));
    if (!version || version.lifecycle_state !== 'draft')
      return invalid(c, 'Draft version was not found', 404);
    const core = coreDb(c, profile.tenant_id);
    const configuration = await core.queryOne<{ configuration_id: string; is_active: number }>(
      'SELECT configuration_id, is_active FROM credential_configurations WHERE tenant_id = ? AND configuration_id = ?',
      [profile.tenant_id, version.credential_configuration_id]
    );
    if (!configuration || configuration.is_active !== 1)
      throw new Error('credential_configuration_not_active');
    const issuanceFlowVersionId = await requirePublishedFlow(
      core,
      profile.tenant_id,
      version.issuance_flow_id,
      'credential_issuance'
    );
    const verificationFlowVersionId = version.verification_flow_id
      ? await requirePublishedFlow(
          core,
          profile.tenant_id,
          version.verification_flow_id,
          'attribute_elevation'
        )
      : null;
    await validatePublishedProfileFlow(
      core,
      profile.tenant_id,
      issuanceFlowVersionId,
      'credential_issuance',
      profile.id
    );
    if (verificationFlowVersionId) {
      await validatePublishedProfileFlow(
        core,
        profile.tenant_id,
        verificationFlowVersionId,
        'attribute_elevation',
        profile.id
      );
    }
    const issuance = await resolveRuntimeIdentityMappingBinding(adminDb(c), {
      tenantId: profile.tenant_id,
      protocol: 'vc',
      role: 'issuer',
      direction: 'issuance',
      credentialProfileId: profile.id,
      credentialConfigurationId: version.credential_configuration_id,
      fieldMappingSetId: version.issuance_mapping_set_id,
    });
    if (!issuance) throw new Error('issuance_mapping_not_active');
    const verification = version.verification_mapping_set_id
      ? await resolveRuntimeIdentityMappingBinding(adminDb(c), {
          tenantId: profile.tenant_id,
          protocol: 'vc',
          role: 'verifier',
          direction: 'verification',
          credentialProfileId: profile.id,
          credentialConfigurationId: version.credential_configuration_id,
          fieldMappingSetId: version.verification_mapping_set_id,
        })
      : null;
    if (version.verification_mapping_set_id && !verification)
      throw new Error('verification_mapping_not_active');
    const claimAllowlist = normalizeClaims(JSON.parse(version.claim_allowlist_json));
    const destinationNamespace = `${VC_DESTINATION_PREFIX}${version.credential_configuration_id}`;
    const mappedDestinations = new Set(
      issuance.edges
        .filter(
          (edge) =>
            edge.targetRef.side === 'destination' &&
            edge.targetRef.namespace === destinationNamespace
        )
        .map((edge) => edge.targetRef.path)
    );
    if (claimAllowlist.some((claim) => !mappedDestinations.has(claim)))
      throw new Error('claim_allowlist_not_mapped');
    const snapshot = {
      profileId: profile.id,
      versionNumber: version.version_number,
      credentialConfigurationId: version.credential_configuration_id,
      issuanceFlowVersionId,
      verificationFlowVersionId,
      issuanceMappingVersionId: issuance.fieldMappingVersionId,
      issuanceMappingSnapshotHash: issuance.mappingSnapshotHash,
      verificationMappingVersionId: verification?.fieldMappingVersionId ?? null,
      verificationMappingSnapshotHash: verification?.mappingSnapshotHash ?? null,
      claimAllowlist,
      offerTtlSeconds: version.offer_ttl_seconds,
      maximumAttributeAgeSeconds: version.maximum_attribute_age_seconds,
      transactionCodeRequired: version.transaction_code_required === 1,
    };
    const snapshotHash = await hashSnapshot(snapshot);
    const now = Math.floor(Date.now() / 1000);
    await adminDb(c).transaction(async (tx) => {
      await tx.execute(
        `UPDATE credential_profile_versions SET lifecycle_state = 'retired', updated_at = ? WHERE tenant_id = ? AND credential_profile_id = ? AND lifecycle_state = 'published'`,
        [now, profile.tenant_id, profile.id]
      );
      await tx.execute(
        `UPDATE credential_profile_versions SET lifecycle_state = 'published', issuance_flow_version_id = ?,
         verification_flow_version_id = ?, issuance_mapping_version_id = ?, issuance_mapping_snapshot_hash = ?,
         verification_mapping_version_id = ?, verification_mapping_snapshot_hash = ?, snapshot_hash = ?,
         published_at = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND lifecycle_state = 'draft'`,
        [
          issuanceFlowVersionId,
          verificationFlowVersionId,
          issuance.fieldMappingVersionId,
          issuance.mappingSnapshotHash,
          verification?.fieldMappingVersionId ?? null,
          verification?.mappingSnapshotHash ?? null,
          snapshotHash,
          now,
          actorId(c),
          now,
          profile.tenant_id,
          version.id,
        ]
      );
      await tx.execute(
        `UPDATE credential_profiles SET lifecycle_state = 'published', current_published_version_id = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`,
        [version.id, actorId(c), now, profile.tenant_id, profile.id]
      );
    });
    await createAuditLogFromContext(
      c,
      'credential_profile.published',
      'credential_profile',
      profile.id,
      { version_id: version.id, snapshot_hash: snapshotHash }
    );
    return c.json({ version_id: version.id, snapshot_hash: snapshotHash });
  } catch (error) {
    getLogger(c)
      .module('VC-PROFILES')
      .warn('Credential profile publication rejected', {}, error as Error);
    return invalid(c, 'Profile dependencies are not published, active, or claim-compatible', 409);
  }
}

function sourceValues(
  binding: NonNullable<Awaited<ReturnType<typeof resolveRuntimeIdentityMappingBinding>>>,
  claims: Record<string, unknown>
): SourceValueEnvelope[] {
  const refs = new Map(
    binding.edges
      .filter((edge) => edge.sourceRef.side === 'source')
      .map((edge) => [`${edge.sourceRef.namespace}:${edge.sourceRef.path}`, edge.sourceRef])
  );
  const values: SourceValueEnvelope[] = [];
  for (const ref of refs.values()) {
    const segments = ref.path.split('.');
    let value: unknown = claims[ref.path] ?? claims[segments.at(-1) ?? ref.path];
    if (value === undefined && segments.length > 1) {
      let current: unknown = claims[segments[0] ?? ''];
      if (typeof current === 'string' && current.startsWith('{')) {
        try {
          current = JSON.parse(current) as unknown;
        } catch {
          current = undefined;
        }
      }
      for (const segment of segments.slice(1)) {
        current =
          current && typeof current === 'object'
            ? (current as Record<string, unknown>)[segment]
            : undefined;
      }
      value = current;
    }
    if (value !== null && value !== undefined) values.push({ value, sourceRef: ref });
  }
  return values;
}

async function assertCredentialIssuanceFlowPlan(
  core: DatabaseAdapter,
  tenantId: string,
  flowVersionId: string | null,
  profileId: string
): Promise<void> {
  if (!flowVersionId) throw new Error('issuance_flow_version_missing');
  const row = await core.queryOne<{ runtime_snapshot_json: string }>(
    'SELECT runtime_snapshot_json FROM flow_versions WHERE tenant_id = ? AND id = ?',
    [tenantId, flowVersionId]
  );
  if (!row) throw new Error('issuance_flow_version_not_found');
  const runtime = JSON.parse(row.runtime_snapshot_json) as FlowRuntimeContract;
  const state = { claimsResolved: false, offerCreated: false };
  const matchesProfile = (value: unknown): boolean =>
    value === profileId ||
    (!!value && typeof value === 'object' && (value as { id?: unknown }).id === profileId);
  await executeServerFlow({
    contract: runtime,
    expectedKind: 'credential_issuance',
    state,
    handlers: {
      credential_claims({ step, state: current }) {
        const ref = step.config?.credential_profile_ref;
        if (!matchesProfile(ref)) throw new Error('issuance_flow_profile_mismatch');
        current.claimsResolved = true;
        return { handle: 'resolved' };
      },
      credential_offer({ step, state: current }) {
        const ref = step.config?.credential_profile_ref;
        if (!matchesProfile(ref)) throw new Error('issuance_flow_profile_mismatch');
        if (!current.claimsResolved) throw new Error('issuance_flow_claims_not_resolved');
        current.offerCreated = true;
        return { handle: 'created' };
      },
    },
  });
  if (!state.claimsResolved || !state.offerCreated) throw new Error('invalid_issuance_flow_plan');
}

export async function adminCredentialOfferCreateHandler(c: AdminContext) {
  try {
    const profile = await loadProfile(c, pathId(c, 'id'));
    if (!profile?.current_published_version_id || profile.lifecycle_state !== 'published')
      return invalid(c, 'Published credential profile was not found', 404);
    const version = await loadVersion(c, profile.id, profile.current_published_version_id);
    if (
      !version ||
      version.lifecycle_state !== 'published' ||
      !version.snapshot_hash ||
      !version.issuance_mapping_version_id ||
      !version.issuance_mapping_snapshot_hash
    )
      throw new Error('published_profile_corrupt');
    const body = await c.req.json<{ user_id?: string }>();
    const userId = requireKey(body.user_id, 'user_id');
    const tenantId = profile.tenant_id;
    const auth = createAuthContextFromHono(c, tenantId);
    await assertCredentialIssuanceFlowPlan(
      auth.coreAdapter,
      tenantId,
      version.issuance_flow_version_id,
      profile.id
    );
    const pii = createPIIContextFromHono(c, tenantId);
    const projection = await new CanonicalRuntimeUserProjectionRepository(
      auth.coreAdapter,
      tenantId,
      new CanonicalSensitiveValueResolver(pii.defaultPiiAdapter)
    ).findByLegacyUserId(userId);
    if (!projection) return invalid(c, 'User was not found', 404);
    const binding = await resolveRuntimeIdentityMappingBinding(adminDb(c), {
      tenantId,
      protocol: 'vc',
      role: 'issuer',
      direction: 'issuance',
      credentialProfileId: profile.id,
      credentialConfigurationId: version.credential_configuration_id,
      fieldMappingSetId: version.issuance_mapping_set_id,
      fieldMappingVersionId: version.issuance_mapping_version_id,
    });
    if (!binding || binding.mappingSnapshotHash !== version.issuance_mapping_snapshot_hash)
      throw new Error('mapping_snapshot_changed');
    const canonicalClaims = canonicalProjectionToOIDCClaimsUser(projection) as unknown as Record<
      string,
      unknown
    >;
    const mapped = executeRuntimeMapping({
      catalog: binding.catalog,
      sourceValues: sourceValues(binding, canonicalClaims),
      edges: binding.edges,
      transforms: binding.transforms,
      validationRules: binding.validationRules,
      fieldMappingSet: binding.fieldMappingSet,
    });
    if (mapped.status === 'failed') throw new Error('credential_mapping_failed');
    const namespace = `${VC_DESTINATION_PREFIX}${version.credential_configuration_id}`;
    const claims = Object.fromEntries(
      mapped.values
        .filter(
          (item) => item.sourceRef.side === 'destination' && item.sourceRef.namespace === namespace
        )
        .map((item) => [item.sourceRef.path, item.value])
    );
    const manifest = normalizeClaims(JSON.parse(version.claim_allowlist_json));
    if (Object.keys(claims).sort().join('\0') !== manifest.join('\0'))
      throw new Error('credential_claim_manifest_mismatch');
    if (!c.env.VC_ISSUER) throw new Error('vc_issuer_binding_missing');
    const canonicalIssuer = new URL(await getCanonicalTenantBaseUrlAsync(c.env, tenantId));
    if (canonicalIssuer.protocol !== 'https:') throw new Error('insecure_issuer');
    const issuer = canonicalIssuer.origin;
    const profileContractSignature = await signCredentialProfileContract(c.env, [
      tenantId,
      profile.id,
      version.version_number,
      version.snapshot_hash,
      version.credential_configuration_id,
      version.issuance_mapping_version_id,
      version.issuance_mapping_snapshot_hash,
      manifest,
    ]);
    const offer = await c.env.VC_ISSUER.createCredentialOffer({
      tenantId,
      userId,
      credentialProfileId: profile.id,
      credentialProfileVersion: version.version_number,
      credentialProfileSnapshotHash: version.snapshot_hash,
      credentialProfileContractSignature: profileContractSignature,
      credentialConfigurationId: version.credential_configuration_id,
      mappingVersionId: version.issuance_mapping_version_id,
      mappingSnapshotHash: version.issuance_mapping_snapshot_hash,
      claims,
      claimManifest: manifest,
      credentialIssuer: issuer,
      expiresInSeconds: version.offer_ttl_seconds,
      transactionCodeRequired: version.transaction_code_required === 1,
    });
    await createAuditLogFromContext(
      c,
      'credential_offer.created',
      'credential_profile',
      profile.id,
      { offer_id: offer.offerId, user_id: userId, profile_snapshot_hash: version.snapshot_hash }
    );
    return c.json(offer, 201);
  } catch (error) {
    getLogger(c)
      .module('VC-PROFILES')
      .error('Credential offer creation failed', {}, error as Error);
    return invalid(c, 'Credential offer could not be created', 409);
  }
}
