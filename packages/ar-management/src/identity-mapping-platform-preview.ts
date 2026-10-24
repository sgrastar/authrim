import type { Context } from 'hono';
import {
  IdentityMappingResolutionError,
  loadMappingBindingBySetId,
  oidcDefaultSetValueProblem,
  PLATFORM_MAPPING_TENANT_ID,
  readOidcDefaultSetSelection,
  requireDedicatedAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolvePlatformSettingsWithSources,
  validateOidcMappingSetReference,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
  type RuntimeIdentityMappingBinding,
  type TenantDatabaseRequestCache,
} from '@authrim/ar-lib-core';
import { countClientIdentityMappingChoices } from './identity-mapping-app-choices';
import { claimShapes, diffClaimShapes, readCatalogTypes } from './identity-mapping-content-diff';
import { IdentityMappingControlPlaneRepository } from './identity-mapping-control-plane';
import { readPlatformIdentityMappingRelations } from './identity-mapping-platform-followers';
import { contentFromStoredVersion } from './identity-mapping-set-facade-content';
import { hasPlatformIdentityMappingRead } from './identity-mapping-tenants';
import { mapWithConcurrency } from './map-with-concurrency';
import { getSettingsManager } from './routes/settings-v2/settings-support';

type PreviewContext = Context<{ Bindings: Env; Variables: { adminAuth?: AdminAuthContext } }>;
const KEY = 'identity_mapping.oidc_default_set_id';
export const PLATFORM_MAPPING_APP_GROUP_LIMIT = 100;
export const PLATFORM_MAPPING_SELECTOR_BYTE_LIMIT = 4096;
type BeforeUnavailable =
  | 'default_setting_invalid'
  | 'set_missing'
  | 'set_inactive'
  | 'destination_profile_invalid';

function unavailable(c: PreviewContext) {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The complete impact cannot be confirmed',
    },
    503
  );
}
function invalid(c: PreviewContext) {
  return c.json(
    {
      error: 'invalid_request',
      error_description: 'set_id must name an active platform Mapping Set or be null',
    },
    400
  );
}

/** Legacy scoped activations cannot be represented by one global structural default diff. */
async function assertGlobalActivations(admin: DatabaseAdapter, setId: string) {
  const row = await admin.queryOne<{ invalid: number }>(
    `SELECT 1 AS invalid FROM field_mapping_activations
      WHERE tenant_id = ? AND field_mapping_set_id = ? AND lifecycle_state = 'active'
        AND CASE WHEN json_valid(activation_scope_json)
          THEN CASE WHEN json_type(activation_scope_json) = 'object'
            THEN EXISTS (SELECT 1 FROM json_each(activation_scope_json)) ELSE 1 END
          ELSE 1 END
      LIMIT 1`,
    [PLATFORM_MAPPING_TENANT_ID, setId]
  );
  if (row) throw new Error('platform_mapping_scope_unavailable');
}

async function shapesFor(admin: DatabaseAdapter, value: unknown) {
  const selection = readOidcDefaultSetSelection(value);
  if (selection.kind === 'unset') return new Map<string, never>();
  if (selection.kind !== 'set') throw new Error('platform_mapping_default_invalid');
  const binding: RuntimeIdentityMappingBinding = await loadMappingBindingBySetId({
    adapter: admin,
    tenantId: PLATFORM_MAPPING_TENANT_ID,
    setId: selection.setId,
    tier: 'platform_default',
    protocol: 'oidc',
    role: 'op',
  });
  if (Object.keys(binding.activationScope).length !== 0)
    throw new Error('platform_mapping_scope_unavailable');
  const versions = await new IdentityMappingControlPlaneRepository(admin).listFieldMappingVersions(
    binding.tenantId,
    binding.fieldMappingSetId,
    { versionId: binding.fieldMappingVersionId, claimsPreviewOnly: true }
  );
  if (!versions[0]) throw new Error('platform_mapping_content_unavailable');
  const content = {
    ...contentFromStoredVersion(versions[0]),
    catalogVersionId: binding.catalog.identity.id,
  };
  const namespace = binding.destinationNamespace ?? 'oidc.claim';
  const shapes = claimShapes(
    content,
    await readCatalogTypes(admin, binding.tenantId, content.catalogVersionId)
  );
  return new Map([...shapes].filter(([, shape]) => shape.namespace === namespace));
}

/** Complete, read-only fleet impact. Partial inventory or unreadable state never yields counts. */
export async function adminPlatformIdentityMappingPreviewDefaultHandler(c: PreviewContext) {
  if (!hasPlatformIdentityMappingRead(c.get('adminAuth')))
    return c.json({ error: 'forbidden' }, 403);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalid(c);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, 'set_id')
  )
    return invalid(c);
  const setId = (body as Record<string, unknown>).set_id;
  if (
    setId !== null &&
    (typeof setId !== 'string' || oidcDefaultSetValueProblem(setId, 'platform'))
  )
    return invalid(c);
  try {
    const admin = requireDedicatedAdminDatabaseAdapter(c.env, 'identity-mapping-platform-preview');
    const state = await getSettingsManager(c.env, c, true, true, undefined, {
      readOnly: true,
    }).getAll('identity-mapping', { type: 'platform' });
    const runtime = await resolvePlatformSettingsWithSources(c.env, 'identity-mapping', {
      fresh: true,
    });
    const before = state.values[KEY] ?? null;
    if (JSON.stringify(before) !== JSON.stringify(runtime.values[KEY] ?? null))
      return unavailable(c);
    const after = setId === null ? (state.inherited.values[KEY] ?? null) : setId;
    const afterChoice = readOidcDefaultSetSelection(after);
    if (afterChoice.kind !== 'unset' && afterChoice.kind !== 'set') return unavailable(c);
    const beforeChoice = readOidcDefaultSetSelection(before);
    for (const choice of [beforeChoice, afterChoice])
      if (choice.kind === 'set') await assertGlobalActivations(admin, choice.setId);
    if (afterChoice.kind === 'set') {
      const reference = await validateOidcMappingSetReference({
        adminAdapter: admin,
        contextTenantId: PLATFORM_MAPPING_TENANT_ID,
        scope: 'platform',
        setId: afterChoice.setId,
      });
      if (!reference.ok)
        return reference.code === 'admin_database_unavailable' ? unavailable(c) : invalid(c);
    }
    // Compare a repeated choice against the same runtime snapshot, including a failed read.
    const contents = new Map<string, ReturnType<typeof shapesFor>>();
    const read = (value: unknown) => {
      const key = JSON.stringify(value ?? null);
      let pending = contents.get(key);
      if (!pending) {
        pending = shapesFor(admin, value);
        contents.set(key, pending);
      }
      return pending;
    };
    let beforeUnavailable: BeforeUnavailable | undefined;
    let beforeShapes: Awaited<ReturnType<typeof shapesFor>> = new Map();
    if (beforeChoice.kind === 'invalid' || beforeChoice.kind === 'none') {
      beforeUnavailable = 'default_setting_invalid';
    } else {
      try {
        beforeShapes = await read(before);
      } catch (error) {
        if (
          !(error instanceof IdentityMappingResolutionError) ||
          !['set_missing', 'set_inactive', 'destination_profile_invalid'].includes(error.code)
        )
          throw error;
        beforeUnavailable = error.code as BeforeUnavailable;
      }
    }
    const afterShapes = await read(after);
    const changes = { added: 0, removed: 0, renamed: 0 };
    if (!beforeUnavailable)
      for (const change of diffClaimShapes(beforeShapes, afterShapes))
        if (change.kind === 'added' || change.kind === 'removed' || change.kind === 'renamed')
          changes[change.kind]++;
    const relations = await readPlatformIdentityMappingRelations(c.env);
    const requestCache: TenantDatabaseRequestCache = new Map();
    const rows = await mapWithConcurrency(relations, 4, async (tenant) => {
      const core = await resolveAuthCorePersistenceAdapterFromEnv(
        c.env,
        'identity-mapping-platform-preview',
        {
          tenantId: tenant.tenant_id,
          requestCache,
          sideEffects: 'none',
        }
      );
      const apps = await countClientIdentityMappingChoices(core, tenant.tenant_id, {
        maxGroups: PLATFORM_MAPPING_APP_GROUP_LIMIT,
        maxSelectorBytes: PLATFORM_MAPPING_SELECTOR_BYTE_LIMIT,
      });
      return {
        ...tenant,
        apps_following_default: apps.followingDefault,
        claim_changes:
          tenant.relation === 'following'
            ? beforeUnavailable
              ? null
              : changes
            : { added: 0, removed: 0, renamed: 0 },
        ...(tenant.relation === 'following' && beforeUnavailable
          ? { before_unavailable: beforeUnavailable }
          : {}),
      };
    });
    const tenants = { following: 0, own_default: 0, opted_out: 0 };
    let affected = 0;
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    for (const row of rows) {
      tenants[row.relation]++;
      if (changed && row.relation === 'following') affected += row.apps_following_default;
      if (!Number.isSafeInteger(affected)) throw new Error('platform_mapping_count_unavailable');
    }
    return c.json({
      tenants,
      apps_affected: affected,
      by_tenant: rows,
      expected_version: state.version,
    });
  } catch {
    return unavailable(c);
  }
}
