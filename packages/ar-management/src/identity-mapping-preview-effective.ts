/**
 * POST /api/admin/identity-mapping/preview-effective
 *   What an app (or the tenant's view) would be bound to if a choice were saved, before it is:
 *   an app's own choice (`proposal.client`: a set, `{ "mode": "none" }`, or null to follow the
 *   defaults) and/or the tenant's default (`proposal.tenant_default`: a set ID, `none`, or null to
 *   have none of its own). The answer is the effective endpoint's, `before` (what is saved) and
 *   `after` (with the proposal), from the same selection (`selectIdentityMapping`, told the
 *   proposed tenant level). Nothing is written.
 *
 *   A proposal is checked as a save checks it: its form as the client PUT and the settings PATCH
 *   read it (a malformed one is the save's 400), and the set it names with the save's own check
 *   (`validateOidcMappingSetReference`). A set a save would refuse gives
 *   `after.selection = { kind: "failed", code: "proposal_refused", tier, reason }`.
 *
 * GET /api/admin/identity-mapping/sets/compare?a=&b=
 *   How the claims of set `b` differ from those of set `a` (each the caller's tenant's or the
 *   platform's): the same changes a change preview gives (identity-mapping-content-diff.ts).
 */
import type { Context } from 'hono';
import {
  ADMIN_PERMISSIONS,
  createAuthContextFromHono,
  ensureAdminDatabaseAdapter,
  getTenantIdFromContext,
  hasAdminPermission,
  IDENTITY_MAPPING_NONE,
  oidcDefaultSetValueProblem,
  PLATFORM_MAPPING_TENANT_ID,
  validateOidcMappingSetReference,
  type AdminAuthContext,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { validateOptionalIdentityMappingSelectorField } from './admin-clients';
import {
  claimShapes,
  contentProfile,
  diffClaimShapes,
  diffValidationRules,
  readCatalogTypes,
} from './identity-mapping-content-diff';
import { readProfileFields, profileFieldChanges } from './identity-mapping-set-change-preview';
import {
  badRequest,
  controlPlaneErrorResponse,
  createRepository,
  notFound,
  resolveFieldMappingSetOwner,
  type AdminContext,
} from './identity-mapping-control-plane';
import { effectiveMappingView } from './identity-mapping-effective';
import { readCurrentContent } from './identity-mapping-set-facade';

type PreviewContext = Context<{ Bindings: Env }>;

const CLIENT_ID_MAX_LENGTH = 256;
const SET_ID_MAX_LENGTH = 200;

function invalid(c: PreviewContext, description: string) {
  return c.json({ error: 'invalid_request', error_description: description }, 400);
}

function unavailable(c: PreviewContext) {
  return c.json(
    {
      error: 'temporarily_unavailable',
      error_description: 'The settings or the Mapping Sets cannot be read right now',
    },
    503
  );
}

type Refusal = { tier: 'client' | 'tenant_default'; reason: string; message: string };

/** The save's own check of the set a proposal names; null when it may be saved. */
async function referenceRefusal(
  admin: DatabaseAdapter | null,
  tenantId: string,
  tier: Refusal['tier'],
  setId: string,
  versionId?: string
): Promise<Refusal | 'unavailable' | null> {
  const result = await validateOidcMappingSetReference({
    adminAdapter: admin,
    contextTenantId: tenantId,
    scope: tier === 'client' ? 'client' : 'tenant',
    setId,
    ...(versionId ? { versionId } : {}),
  });
  if (result.ok) return null;
  if (result.code === 'admin_database_unavailable') return 'unavailable';
  return { tier, reason: result.code, message: result.message };
}

export async function adminIdentityMappingPreviewEffectiveHandler(c: PreviewContext) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return invalid(c, 'Invalid JSON body');
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== 'client_id' && key !== 'proposal')
  ) {
    return invalid(c, 'The body is { client_id?, proposal }');
  }
  const { client_id: clientId, proposal } = body as Record<string, unknown>;
  if (
    clientId !== undefined &&
    (typeof clientId !== 'string' ||
      clientId.length === 0 ||
      clientId.length > CLIENT_ID_MAX_LENGTH ||
      clientId !== clientId.trim())
  ) {
    return invalid(c, 'client_id must be an app (client) ID');
  }
  if (
    !proposal ||
    typeof proposal !== 'object' ||
    Array.isArray(proposal) ||
    Object.keys(proposal).length === 0 ||
    Object.keys(proposal).some((key) => key !== 'client' && key !== 'tenant_default')
  ) {
    return invalid(c, 'proposal is { client?, tenant_default? }, with at least one of them');
  }
  const proposed = proposal as Record<string, unknown>;
  const proposesClient = Object.hasOwn(proposed, 'client');
  const proposesTenant = Object.hasOwn(proposed, 'tenant_default');
  if (proposesClient && clientId === undefined) {
    return invalid(c, 'proposal.client is for an app: give client_id');
  }

  // The form of each proposal, as the save reads it.
  let clientChoice: Record<string, unknown> | null = null;
  if (proposesClient) {
    const read = validateOptionalIdentityMappingSelectorField(proposed.client, 'proposal.client');
    if (!read.ok) return invalid(c, read.error);
    clientChoice = (read.value ?? null) as Record<string, unknown> | null;
    // The client save refuses a nonempty selector without a set (for example a pin alone).
    if (clientChoice && clientChoice.mode !== 'none' && !clientChoice.fieldMappingSetId) {
      return invalid(c, 'proposal.client.fieldMappingSetId is required');
    }
  }
  const tenantValue = proposed.tenant_default;
  if (proposesTenant && tenantValue !== null) {
    const problem = oidcDefaultSetValueProblem(tenantValue, 'tenant');
    if (problem)
      return invalid(
        c,
        problem.replace('identity_mapping.oidc_default_set_id', 'proposal.tenant_default')
      );
  }

  // An app's choice is the app's: the apps' read too.
  const adminAuth = (c as unknown as { get(key: string): AdminAuthContext | undefined }).get(
    'adminAuth'
  );
  if (
    clientId !== undefined &&
    !hasAdminPermission(adminAuth?.permissions ?? [], ADMIN_PERMISSIONS.CLIENTS_READ)
  ) {
    return c.json(
      {
        error: 'forbidden',
        error_description: 'An app’s choice needs the clients read permission',
      },
      403
    );
  }

  try {
    const tenantId = getTenantIdFromContext(c);
    let storedSelector: unknown = null;
    if (clientId !== undefined) {
      const { coreAdapter } = createAuthContextFromHono(c, tenantId);
      const row = await coreAdapter.queryOne<{ identity_mapping: string | null }>(
        'SELECT identity_mapping FROM oauth_clients WHERE tenant_id = ? AND client_id = ?',
        [tenantId, clientId]
      );
      if (!row) return c.json({ error: 'not_found', error_description: 'client not found' }, 404);
      storedSelector = row.identity_mapping;
    }

    // The set a proposal names, with the save's own check.
    const admin = ensureAdminDatabaseAdapter(c.env, 'identity-mapping-preview-effective');
    const refusals: Refusal[] = [];
    if (clientChoice && typeof clientChoice.fieldMappingSetId === 'string') {
      const refusal = await referenceRefusal(
        admin,
        tenantId,
        'client',
        clientChoice.fieldMappingSetId,
        typeof clientChoice.fieldMappingVersionId === 'string'
          ? clientChoice.fieldMappingVersionId
          : undefined
      );
      if (refusal === 'unavailable') return unavailable(c);
      if (refusal) refusals.push(refusal);
    }
    if (
      proposesTenant &&
      typeof tenantValue === 'string' &&
      tenantValue !== IDENTITY_MAPPING_NONE
    ) {
      const refusal = await referenceRefusal(admin, tenantId, 'tenant_default', tenantValue);
      if (refusal === 'unavailable') return unavailable(c);
      if (refusal) refusals.push(refusal);
    }

    const before = await effectiveMappingView(c.env, tenantId, {
      clientId: clientId ?? null,
      clientSelector: storedSelector,
    });
    const after = await effectiveMappingView(c.env, tenantId, {
      clientId: clientId ?? null,
      clientSelector: proposesClient ? clientChoice : storedSelector,
      ...(proposesTenant ? { tenantDefaultProposal: { value: tenantValue } } : {}),
    });
    if (!before || !after) return unavailable(c);
    return c.json({
      tenantId,
      clientId: clientId ?? null,
      before,
      after:
        refusals.length > 0
          ? {
              ...after,
              // A save would refuse it: the proposal binds nothing, whatever the levels say.
              selection: {
                kind: 'failed' as const,
                code: 'proposal_refused',
                tier: refusals[0].tier,
                reason: refusals[0].reason,
              },
            }
          : after,
      ...(refusals.length > 0
        ? { refusals: refusals.map(({ tier, reason, message }) => ({ tier, reason, message })) }
        : {}),
    });
  } catch {
    return c.json(
      { error: 'internal_error', error_description: 'The proposal could not be previewed' },
      500
    );
  }
}

function setIdParam(c: PreviewContext, name: string): string {
  const value = c.req.query(name);
  if (!value || value !== value.trim() || value.length > SET_ID_MAX_LENGTH) {
    throw badRequest(`${name} must be a Mapping Set ID`);
  }
  return value;
}

export async function adminIdentityMappingCompareSetsHandler(c: AdminContext) {
  try {
    const ids = { a: setIdParam(c, 'a'), b: setIdParam(c, 'b') };
    const repository = createRepository(c);
    const tenantId = getTenantIdFromContext(c);
    const admin = ensureAdminDatabaseAdapter(c.env, 'identity-mapping-compare-sets');
    if (!admin) throw new Error('admin_database_unavailable');
    const read = async (setId: string) => {
      // The caller's tenant's set or the platform's; another tenant's is not found.
      const owner = await resolveFieldMappingSetOwner(c, repository, tenantId, setId, 'read');
      const state = await repository.findFieldMappingSetState(owner, setId);
      if (!state) throw notFound('field mapping set not found');
      const content = await readCurrentContent(repository, owner, state);
      const catalog = await readCatalogTypes(admin, owner, content?.catalogVersionId ?? null);
      return {
        summary: { setId, owner: owner === PLATFORM_MAPPING_TENANT_ID ? 'platform' : 'tenant' },
        owner,
        content,
        shapes: content ? claimShapes(content, catalog) : new Map(),
      };
    };
    const [a, b] = [await read(ids.a), await read(ids.b)];
    const profileBefore = contentProfile(a.shapes);
    const profileAfter = contentProfile(b.shapes);
    const [profilesBefore, profilesAfter] = await Promise.all([
      readProfileFields(admin, a.owner, [profileBefore]),
      readProfileFields(admin, b.owner, [profileAfter]),
    ]);
    const changes = [
      ...diffClaimShapes(a.shapes, b.shapes),
      ...diffValidationRules(a.content, b.content ?? { rules: [] }, profileBefore, profileAfter),
      ...profileFieldChanges(profilesBefore, profileBefore, profileAfter, profilesAfter),
    ].sort(
      (left, right) => left.claim.localeCompare(right.claim) || left.kind.localeCompare(right.kind)
    );
    return c.json({ a: a.summary, b: b.summary, changes });
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}
