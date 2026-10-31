/**
 * The Mapping Set facade: a set is read and written as one thing, not as the five steps (create,
 * version, publish, compile, activate) the control plane keeps underneath.
 *
 *   GET    /api/admin/identity-mapping/sets          the sets, with whether each is in use
 *   GET    /api/admin/identity-mapping/sets/{id}     one set with its content, in the form of a PUT
 *   POST   /api/admin/identity-mapping/sets          create a set and give it content
 *   PUT    /api/admin/identity-mapping/sets/{id}     replace the content of a set
 *   DELETE /api/admin/identity-mapping/sets/{id}     delete a set (switched off first, if it is on)
 *
 * A save runs the control plane's own steps in order, and nothing in them is judged again here:
 * validation (the checks the version create and the compile make, plus the release safety check
 * the activation makes, which is run now so that nothing is saved that cannot be switched on),
 * a new version, its publication and compile, and the activation of that version in place of the
 * one in use (or, for `enabled: false`, the end of the activation). The switch is the control
 * plane's one transaction and it is the last step, so the version that was in use stays in use
 * until the new one is in place. When a step fails, the version this save created is removed (and
 * a set it created), and the answer says which step it was.
 */
import type { Context } from 'hono';
import {
  getTenantIdFromContext,
  mappingDestinationProfileIds,
  PLATFORM_MAPPING_TENANT_ID,
  BodyLimitExceededError,
  createAuditLogFromContext,
  createLogger,
  isUniqueConstraintError,
  readRequestBytesWithLimit,
  type Env,
  type MappingSetReferenceSummary,
} from '@authrim/ar-lib-core';
import { MAPPING_SET_REQUEST_BODY_LIMIT_BYTES } from './admin-body-limit';
import { createReplayIdempotency, sweepExpiredReplayRecords } from './admin-replay-idempotency';
import {
  assertPlatformOwnerScopeAllowed,
  badRequest,
  conflict,
  controlPlaneErrorResponse,
  createId,
  createRepository,
  forbidden,
  hasPlatformOwnerScopeAuthority,
  IdentityMappingControlPlaneError,
  MappingSaveOutcomeUnknownError,
  notFound,
  refuseIfInUse,
  requiredParam,
  resolveFieldMappingSetOwner,
  type AdminContext,
  type IdentityMappingControlPlaneRepository,
} from './identity-mapping-control-plane';
import {
  contentFromStoredVersion,
  diffMappingSetContent,
  parseMappingSetSaveRequest,
  summarizeMappingSetContent,
  toVersionInput,
  type MappingSetContent,
  type MappingSetSaveRequest,
} from './identity-mapping-set-facade-content';
import {
  checkMappingSetUnreferenced,
  checkMappingVersionDeactivation,
  checkMappingVersionSwap,
  scanMappingSetReferences,
  summarizeForRequest,
} from './identity-mapping-set-reference-guard';

const log = createLogger().module('IDENTITY_MAPPING_SET_FACADE');

/** The context variable a save sets when it is about to write: from then on its key is held. */
export const MAPPING_SET_SAVE_STARTED = 'identityMappingSetSaveStarted';
/** The records of the saves have an operation key that starts with this. */
export const MAPPING_SET_SAVE_OPERATION_PREFIX = 'identity_mapping.set.save:';
export const MAPPING_SET_SAVE_RECORD_TTL_MS = 15 * 60 * 1000;
/** A set's content is at most 128 KiB (the version create's budget); the rest is the envelope. */
const REQUEST_BODY_LIMIT_BYTES = MAPPING_SET_REQUEST_BODY_LIMIT_BYTES;
const SET_ID_MAX_LENGTH = 200;
/** What a set that has no version is called in `content_version`. */
const NO_CONTENT_VERSION = 'none';

/** What the activation of a set the facade saves is scoped to: OIDC, the OP role. */
const OIDC_ACTIVATION_SCOPE = { protocol: 'oidc', role: 'op' } as const;

export type MappingSetSaveStage =
  | 'validate'
  | 'create_version'
  | 'publish'
  | 'compile'
  | 'activate';

/**
 * Replay protection of the saves and deletes, in the Admin database (the answer holds the
 * definition of a set, so it is kept out of the tenants' Core databases). A preview writes
 * nothing, so it has no key and leaves no record.
 */
export function createMappingSetSaveIdempotency(overrides: { bindToAuthority?: boolean } = {}) {
  return createReplayIdempotency({
    partition: 'identity-mapping-set-idempotency',
    logModule: 'IDENTITY_MAPPING_SET_FACADE',
    subject: 'Mapping Set save',
    operation: (principal) => `${MAPPING_SET_SAVE_OPERATION_PREFIX}${principal}`,
    tenantId: (c) => getTenantIdFromContext(c as AdminContext),
    // The path says which set, the method what is done to it, and the precondition what it expects.
    requestScope: (c) => `${c.req.method} ${c.req.path} if-match=${c.req.header('If-Match') ?? ''}`,
    bindToAuthority: overrides.bindToAuthority ?? true,
    ttlMs: MAPPING_SET_SAVE_RECORD_TTL_MS,
    bodyLimitBytes: REQUEST_BODY_LIMIT_BYTES,
    startedKey: MAPPING_SET_SAVE_STARTED,
    unknownMessage:
      'A request with this Idempotency-Key was run, but its result was not kept; it is not run again. Read the Mapping Set, and use another key to run it again',
    bypass: (c) => c.req.method !== 'DELETE' && c.req.query('preview') === 'true',
    // A stored answer is never given to a caller who could not have made the request now: who may
    // change the set (and the platform's namespace) is judged again as for a first request.
    authorizeReplay: async (c, body, stored) => {
      const context = c as unknown as AdminContext;
      try {
        if (context.req.method === 'POST') {
          let ownerScopeType: unknown;
          try {
            ownerScopeType = (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>)
              ?.owner_scope_type;
          } catch {
            return null;
          }
          assertPlatformOwnerScopeAllowed(context, { ownerScopeType });
          return null;
        }
        const setId = context.req.param('id');
        if (!setId) return null;
        if (context.req.method === 'DELETE') {
          // A deleted set is no longer there to ask: a finished request keeps the owner in its
          // answer, and a repeat of it is judged by that (a platform set's needs platform
          // authority). A request with no finished answer holds nothing to give.
          const owner = await createRepository(context).findFieldMappingSetOwner(
            getTenantIdFromContext(context),
            setId
          );
          if (!owner) {
            const storedOwner = (stored?.body as { owner?: unknown } | undefined)?.owner;
            if (storedOwner === 'platform' && !hasPlatformOwnerScopeAuthority(context)) {
              throw forbidden('platform field mapping set requires platform admin authority');
            }
            return null;
          }
        }
        await resolveFieldMappingSetOwner(
          context,
          createRepository(context),
          getTenantIdFromContext(context),
          setId,
          'write'
        );
        return null;
      } catch (error) {
        return controlPlaneErrorResponse(context, error);
      }
    },
  });
}

export const mappingSetSaveIdempotency = createMappingSetSaveIdempotency();

/** Removes the stored answers of the saves that have run out. */
export async function sweepExpiredMappingSetSaveRecords(
  env: Env,
  options: { limit?: number; now?: number } = {}
): Promise<number> {
  return sweepExpiredReplayRecords(env, {
    partition: 'identity-mapping-set-idempotency-sweep',
    prefix: MAPPING_SET_SAVE_OPERATION_PREFIX,
    ...options,
  });
}

// ---------------------------------------------------------------------------------------------
// Reading

type SetState = NonNullable<
  Awaited<ReturnType<IdentityMappingControlPlaneRepository['findFieldMappingSetState']>>
>;

function ownerLabel(ownerTenantId: string): 'tenant' | 'platform' {
  return ownerTenantId === PLATFORM_MAPPING_TENANT_ID ? 'platform' : 'tenant';
}

/** What a set is now: the version in use, else the one saved last. Changes with every save. */
function contentVersionOf(state: Pick<SetState, 'current_version_id'> | null): string {
  return state?.current_version_id ?? NO_CONTENT_VERSION;
}

function etag(contentVersion: string): string {
  return `"${contentVersion}"`;
}

function setSummary(state: SetState) {
  return {
    id: state.id,
    owner: ownerLabel(state.tenant_id),
    field_mapping_key: state.field_mapping_key,
    display_name: state.display_name,
    description: state.description,
    enabled: state.active_version_id !== null,
    active_version_id: state.active_version_id,
    version_label: state.current_version_label,
    content_version: contentVersionOf(state),
    created_at: state.created_at,
    updated_at: state.updated_at,
  };
}

export function validSetId(c: AdminContext): string {
  const setId = requiredParam(c, 'id');
  if (setId !== setId.trim() || setId.length > SET_ID_MAX_LENGTH) {
    throw badRequest('id must be a Mapping Set ID');
  }
  return setId;
}

export async function readCurrentContent(
  repository: IdentityMappingControlPlaneRepository,
  ownerTenantId: string,
  state: SetState
): Promise<MappingSetContent | null> {
  if (!state.current_version_id) return null;
  const [version] = await repository.listFieldMappingVersions(ownerTenantId, state.id, {
    versionId: state.current_version_id,
  });
  return version ? contentFromStoredVersion(version) : null;
}

export function referenceCount(summary: MappingSetReferenceSummary) {
  return {
    count: summary.count,
    count_is_lower_bound: summary.countIsLowerBound,
    scan_complete: summary.scanComplete,
  };
}

export async function adminIdentityMappingSetsListHandler(c: AdminContext) {
  try {
    const repository = createRepository(c);
    const states = await repository.listFieldMappingSetStates(getTenantIdFromContext(c));
    return c.json({ sets: states.map(setSummary) });
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}

export async function adminIdentityMappingSetGetHandler(c: AdminContext) {
  try {
    const setId = validSetId(c);
    const repository = createRepository(c);
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      getTenantIdFromContext(c),
      setId,
      'read'
    );
    const state = await repository.findFieldMappingSetState(ownerTenantId, setId);
    if (!state) throw notFound('field mapping set not found');
    const content = await readCurrentContent(repository, ownerTenantId, state);
    let references: ReturnType<typeof referenceCount> | null = null;
    try {
      // The platform's sets are used across the tenants; reading each tenant's database for a
      // GET is the usage endpoint's job, so only what the Admin database knows is counted here.
      const scan = await scanMappingSetReferences(c, {
        setId,
        ownerTenantId,
        purpose: 'change',
        scanOtherTenants: false,
      });
      references = referenceCount(summarizeForRequest(c, scan));
    } catch {
      log.warn('The references of a Mapping Set could not be counted');
    }
    c.header('ETag', etag(contentVersionOf(state)));
    return c.json({ ...setSummary(state), content, references });
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}

// ---------------------------------------------------------------------------------------------
// Saving

/** A step of a save that failed, with the error the control plane gave. */
class SaveStageError extends Error {
  constructor(
    readonly stage: MappingSetSaveStage,
    readonly cause: unknown,
    /** The version this save created before it failed, and whether it was removed. */
    readonly versionId: string | null,
    readonly versionDiscarded: boolean,
    /** Whether the write that failed may have been applied: nothing was cleaned up. */
    readonly outcomeUnknown: boolean = false
  ) {
    super(`Mapping Set save failed at ${stage}`);
  }
}

function errorBody(error: unknown): { status: 400 | 403 | 404 | 409 | 500; body: object } {
  if (isUniqueConstraintError(error)) {
    return {
      status: 409,
      body: { error: 'conflict', error_description: 'field_mapping_key already exists' },
    };
  }
  if (error instanceof IdentityMappingControlPlaneError) {
    return {
      status: error.status as 400 | 403 | 404 | 409 | 500,
      body: { error: error.code, error_description: error.message, ...error.extra },
    };
  }
  return {
    status: 500,
    body: { error: 'internal_error', error_description: 'The Mapping Set could not be saved' },
  };
}

function unsupportedDestination(message: string): IdentityMappingControlPlaneError {
  return new IdentityMappingControlPlaneError(
    `${message}; use the field mapping version and activation endpoints for this set`,
    400,
    'unsupported_destination'
  );
}

/**
 * The facade switches on sets that release OIDC claims. A set that releases into any other kind
 * of Destination Profile (SAML, a resource server, CSV) is for the activation endpoints, which
 * take the scope the protocol needs; a scope written here would be broader than a SAML provider,
 * a credential or SCIM expects.
 */
async function assertOidcDestination(
  repository: IdentityMappingControlPlaneRepository,
  ownerTenantId: string,
  content: MappingSetContent
): Promise<void> {
  const profileIds = mappingDestinationProfileIds(
    content.rules.flatMap((rule) => (rule.edges ?? []).map((edge) => edge.targetRef))
  );
  if (profileIds.length === 0) {
    throw unsupportedDestination('The content releases into no OIDC Destination Profile');
  }
  const types = await repository.findDestinationProfileTypes(ownerTenantId, profileIds);
  for (const profileId of profileIds) {
    if (types.get(profileId) !== 'oidc') {
      throw unsupportedDestination(
        types.get(profileId)
          ? 'The content releases into a Destination Profile that is not an OIDC one'
          : `The Destination Profile the content releases into was not found: ${profileId}`
      );
    }
  }
  if (profileIds.length !== 1) {
    throw badRequest('The content must release into exactly one OIDC Destination Profile');
  }
}

/**
 * The checks a version goes through before it can be in use, run on the content before anything
 * is written: the version create's, the compile's and the activation's release safety.
 */
export async function validateContent(
  repository: IdentityMappingControlPlaneRepository,
  ownerTenantId: string,
  content: MappingSetContent,
  /** Judged as the version create will see it, the author included (it counts toward the limits). */
  authorId?: string
): Promise<{ catalogVersionId: string }> {
  await assertOidcDestination(repository, ownerTenantId, content);
  const input = toVersionInput(content, 'validation', authorId);
  await repository.assertFieldMappingVersionShape(ownerTenantId, input);
  const catalogVersion = await repository.getCatalogVersion(
    ownerTenantId,
    content.catalogVersionId
  );
  if (!catalogVersion) throw badRequest('content.catalogVersionId was not found');
  await repository.assertMappingRequiredSourceFieldsConnected(ownerTenantId, input);
  const edges = content.rules.flatMap((rule) =>
    (rule.edges ?? []).map((edge) => ({ sourceRef: edge.sourceRef, targetRef: edge.targetRef }))
  );
  if (ownerTenantId === PLATFORM_MAPPING_TENANT_ID) {
    await repository.assertPlatformMappingContentCompilable(
      ownerTenantId,
      {
        edges,
        validationRules: content.rules.flatMap((rule) => rule.validationRules ?? []),
        transforms: content.rules.flatMap((rule) =>
          (rule.transforms ?? []).map((transform) => ({
            operation: transform.operation,
            parameters: transform.parameters ?? {},
          }))
        ),
      },
      catalogVersion.id
    );
  }
  await repository.assertSensitiveEdgesReleaseSafety(ownerTenantId, edges, catalogVersion.id);
  return { catalogVersionId: catalogVersion.id };
}

/** The tokens of an `If-Match` header, without the quotes and the weak marker. */
function ifMatchTokens(header: string | undefined): string[] | null {
  if (header === undefined) return null;
  return header
    .split(',')
    .map((token) =>
      token
        .trim()
        .replace(/^W\//, '')
        .replace(/^"(.*)"$/, '$1')
    )
    .filter((token) => token.length > 0);
}

function assertPrecondition(
  headers: { ifMatch: string | undefined; ifNoneMatch: string | undefined },
  state: SetState | null
): void {
  if (state && headers.ifNoneMatch?.trim() === '*') {
    throw conflict('The Mapping Set already exists (If-None-Match: *)');
  }
  const tokens = ifMatchTokens(headers.ifMatch);
  if (tokens === null) return;
  if (tokens.includes('*') && state) return;
  if (!state || !tokens.includes(contentVersionOf(state))) {
    throw conflict('The Mapping Set was changed since it was read (If-Match does not match)');
  }
}

/** The number of the references the caller saw has to be the number there is now. */
function assertImpactConfirmed(
  request: MappingSetSaveRequest,
  references: MappingSetReferenceSummary | null
): void {
  if (!references || references.count === 0) return;
  if (request.confirmImpact === references.count) return;
  throw new IdentityMappingControlPlaneError(
    `The Mapping Set is in use (${references.count} references); send confirm_impact with that number to change it`,
    409,
    'impact_confirmation_required',
    { references }
  );
}

export function requestAuthorId(c: AdminContext): string | undefined {
  return (c as unknown as { get(key: string): { userId?: string } | undefined }).get('adminAuth')
    ?.userId;
}

interface SaveTarget {
  ownerTenantId: string;
  /** The set being replaced; null when the save creates it. */
  state: SetState | null;
}

/** How many things name the set now (a set that is being created is named by nothing). */
async function loadReferences(
  c: AdminContext,
  target: SaveTarget
): Promise<MappingSetReferenceSummary | null> {
  const { state, ownerTenantId } = target;
  if (!state) return null;
  return summarizeForRequest(
    c,
    await scanMappingSetReferences(c, { setId: state.id, ownerTenantId, purpose: 'change' })
  );
}

async function runPreview(
  c: AdminContext,
  repository: IdentityMappingControlPlaneRepository,
  target: SaveTarget,
  request: MappingSetSaveRequest
): Promise<Response> {
  const { state, ownerTenantId } = target;
  const base = {
    preview: true,
    id: state?.id ?? null,
    owner: ownerLabel(ownerTenantId),
    would_create: state === null,
    enabled: request.enabled,
    content_version: contentVersionOf(state),
  };
  let catalogVersionId: string;
  try {
    ({ catalogVersionId } = await validateContent(
      repository,
      ownerTenantId,
      request.content,
      requestAuthorId(c)
    ));
  } catch (error) {
    const { body } = errorBody(error);
    return c.json({ ...base, valid: false, stage_failed: 'validate', ...body });
  }
  const references = await loadReferences(c, target);
  const current = state ? await readCurrentContent(repository, ownerTenantId, state) : null;
  let deactivationRefusal: object | null = null;
  if (!request.enabled && state?.active_version_id) {
    const refused = await checkMappingVersionDeactivation(c, {
      setId: state.id,
      ownerTenantId,
      versionId: state.active_version_id,
    });
    if (refused) {
      deactivationRefusal = {
        error: 'conflict',
        error_description: refused.message,
        ...refused.extra,
      };
    }
  }
  return c.json({
    ...base,
    valid: true,
    validation: { ok: true },
    compile: { ok: true, catalog_version_id: catalogVersionId },
    activation: {
      scope: request.enabled
        ? ownerTenantId === PLATFORM_MAPPING_TENANT_ID
          ? {}
          : OIDC_ACTIVATION_SCOPE
        : null,
      // Whether the version can replace the one in use is judged when it has a compiled snapshot,
      // that is on the save; switching off is judged here.
      deactivation_refusal: deactivationRefusal,
    },
    diff: diffMappingSetContent(current, request.content),
    references: references ? referenceCount(references) : { count: 0 },
    confirm_impact_required: (references?.count ?? 0) > 0,
  });
}

async function writeSet(
  c: AdminContext,
  repository: IdentityMappingControlPlaneRepository,
  target: SaveTarget,
  request: MappingSetSaveRequest,
  references: MappingSetReferenceSummary | null,
  catalogVersionId: string
) {
  const { ownerTenantId } = target;
  const previous = target.state;
  let setId = previous?.id ?? null;
  let createdSetId: string | null = null;
  let createdVersionId: string | null = null;
  let stage: MappingSetSaveStage = 'create_version';
  const holderId = createId('activation_holder');
  let leaseTaken = false;
  const scope = ownerTenantId === PLATFORM_MAPPING_TENANT_ID ? {} : { ...OIDC_ACTIVATION_SCOPE };

  (c as unknown as { set(key: string, value: unknown): void }).set(MAPPING_SET_SAVE_STARTED, true);
  try {
    if (!previous) {
      const created = await repository.createFieldMappingSet(ownerTenantId, {
        fieldMappingKey: request.fieldMappingKey ?? '',
        displayName: request.displayName,
        ...(request.description !== null ? { description: request.description } : {}),
        ownerScopeType: ownerLabel(ownerTenantId),
      });
      setId = created.id;
      createdSetId = created.id;
    }
    // The name and description are written by the batch that confirms the save, never earlier: a
    // save that fails (or loses to another) has not touched them, so there is nothing to put back
    // that could undo someone else's save.
    const setDetails =
      previous &&
      (previous.display_name !== request.displayName ||
        previous.description !== request.description)
        ? { displayName: request.displayName, description: request.description }
        : undefined;
    const targetSetId = setId as string;
    // A name no earlier save has, so two saves at once cannot both take it.
    const versionLabel = `save-${Date.now().toString(36)}-${createId('v').slice(-8)}`;
    // Known before the first row is written, so that a failure part-way through (the rows are
    // written one by one) can still remove what was written.
    createdVersionId = createId('field_mapping_version');
    const version = await repository.createFieldMappingVersion(
      ownerTenantId,
      targetSetId,
      toVersionInput(request.content, versionLabel, requestAuthorId(c)),
      { versionId: createdVersionId }
    );

    stage = 'publish';
    await repository.publishFieldMappingVersion(ownerTenantId, targetSetId, version.id);

    stage = 'compile';
    const compiled = await repository.compileFieldMappingVersion(
      ownerTenantId,
      targetSetId,
      version.id,
      { catalogVersionId }
    );

    stage = 'activate';
    if (previous) {
      // Someone else saved the set while this one was being built: theirs is not to be replaced
      // on the strength of a read that is no longer true.
      const latest = await repository.findFieldMappingSetState(ownerTenantId, previous.id, {
        excludingVersionId: version.id,
      });
      if (contentVersionOf(latest) !== contentVersionOf(previous)) {
        throw conflict('The Mapping Set was changed while it was being saved');
      }
    }
    if (previous) {
      // What named the set when the number was confirmed is not necessarily what names it now:
      // the number has to hold at the moment of the switch. (An app that names the set after this
      // look cannot be excluded: the references live in other databases.)
      assertImpactConfirmed(request, await loadReferences(c, target));
    }
    if (request.enabled) {
      refuseIfInUse(
        await checkMappingVersionSwap(c, {
          mode: 'activate',
          setId: targetSetId,
          ownerTenantId,
          versionId: version.id,
          snapshotId: compiled.id,
          activationScope: scope,
        })
      );
      leaseTaken = true;
      await repository.activateFieldMappingVersion(
        ownerTenantId,
        targetSetId,
        version.id,
        { snapshotId: compiled.id, activationScope: scope, holderId },
        {
          // The version in use that this save was decided against: checked again under the lock
          // and inside the switch itself.
          expectedActiveVersionId: previous?.active_version_id ?? null,
          setDetails,
        }
      );
    } else if (previous?.active_version_id) {
      refuseIfInUse(
        await checkMappingVersionDeactivation(c, {
          setId: targetSetId,
          ownerTenantId,
          versionId: previous.active_version_id,
        })
      );
      await repository.deactivateFieldMappingVersion(
        ownerTenantId,
        targetSetId,
        previous.active_version_id,
        { requireActive: true, setDetails }
      );
    } else if (previous) {
      // The set stays off. It is confirmed by one batch that checks that nothing else was saved or
      // switched on since this save looked (else this save does not stand), and writes the name.
      await repository.confirmUnchangedOffSet(ownerTenantId, targetSetId, {
        ownVersionId: version.id,
        expectedCurrentVersionId: previous.current_version_id,
        setDetails,
      });
    }
    return {
      setId: targetSetId,
      versionId: version.id,
      versionLabel,
      snapshotId: compiled.id,
      created: createdSetId !== null,
      previousVersionId: previous?.current_version_id ?? null,
      referenceCount: references?.count ?? 0,
    };
  } catch (error) {
    if (error instanceof MappingSaveOutcomeUnknownError) {
      // What the last write did could not be found out: the version and the set are left as they
      // are (removing them could remove what is now in use), and the caller is told.
      throw new SaveStageError(stage, error, createdVersionId, false, true);
    }
    let versionDiscarded = false;
    try {
      if (createdSetId) {
        await repository.deleteFieldMappingSet(ownerTenantId, createdSetId);
        versionDiscarded = createdVersionId !== null;
      } else {
        if (createdVersionId && setId) {
          versionDiscarded = await repository.discardUnusedFieldMappingVersion(
            ownerTenantId,
            setId,
            createdVersionId
          );
        }
      }
    } catch {
      log.error('The leftovers of a failed Mapping Set save could not be removed');
    }
    throw new SaveStageError(stage, error, createdVersionId, versionDiscarded);
  } finally {
    if (leaseTaken && setId) {
      try {
        await repository.releaseActivationLease(ownerTenantId, setId, holderId);
      } catch {
        log.warn('The activation lock of a Mapping Set save could not be released');
      }
    }
  }
}

async function recordSaveAudit(
  c: AdminContext,
  fields: {
    setId: string | null;
    ownerTenantId: string;
    versionId: string | null;
    enabled: boolean;
    created: boolean;
    result: 'saved' | 'failed';
    stageFailed?: MappingSetSaveStage;
    ruleCount: number;
  }
): Promise<void> {
  try {
    await createAuditLogFromContext(
      c as unknown as Parameters<typeof createAuditLogFromContext>[0],
      'identity_mapping.set.saved',
      'field_mapping_set',
      fields.setId ?? 'none',
      {
        set_id: fields.setId,
        owner: ownerLabel(fields.ownerTenantId),
        version_id: fields.versionId,
        enabled: fields.enabled,
        created: fields.created,
        result: fields.result,
        ...(fields.stageFailed ? { stage_failed: fields.stageFailed } : {}),
        rule_count: fields.ruleCount,
      },
      fields.result === 'saved' ? 'info' : 'warning'
    );
  } catch {
    log.warn('The audit record of a Mapping Set save could not be written');
  }
}

async function executeSave(
  c: AdminContext,
  repository: IdentityMappingControlPlaneRepository,
  target: SaveTarget,
  request: MappingSetSaveRequest,
  preview: boolean
): Promise<Response> {
  const { state, ownerTenantId } = target;
  assertPrecondition(
    { ifMatch: c.req.header('If-Match'), ifNoneMatch: c.req.header('If-None-Match') },
    state
  );
  if (preview) return runPreview(c, repository, target, request);

  const ruleCount = request.content.rules.length;
  let catalogVersionId: string;
  try {
    ({ catalogVersionId } = await validateContent(
      repository,
      ownerTenantId,
      request.content,
      requestAuthorId(c)
    ));
  } catch (error) {
    await recordSaveAudit(c, {
      setId: state?.id ?? null,
      ownerTenantId,
      versionId: null,
      enabled: request.enabled,
      created: false,
      result: 'failed',
      stageFailed: 'validate',
      ruleCount,
    });
    const { status, body } = errorBody(error);
    return c.json({ ...body, stage_failed: 'validate' satisfies MappingSetSaveStage }, status);
  }

  // What the caller saw of the use of the set has to be what there is now.
  const references = await loadReferences(c, target);
  assertImpactConfirmed(request, references);

  try {
    const saved = await writeSet(c, repository, target, request, references, catalogVersionId);
    await recordSaveAudit(c, {
      setId: saved.setId,
      ownerTenantId,
      versionId: saved.versionId,
      enabled: request.enabled,
      created: saved.created,
      result: 'saved',
      ruleCount,
    });
    const after = await repository.findFieldMappingSetState(ownerTenantId, saved.setId);
    c.header('ETag', etag(contentVersionOf(after)));
    return c.json(
      {
        ...(after ? setSummary(after) : { id: saved.setId }),
        created: saved.created,
        version_id: saved.versionId,
        snapshot_id: saved.snapshotId,
        previous_content_version: saved.previousVersionId ?? NO_CONTENT_VERSION,
        summary: summarizeMappingSetContent(request.content),
      },
      saved.created ? 201 : 200
    );
  } catch (error) {
    if (!(error instanceof SaveStageError)) throw error;
    const detail = error;
    await recordSaveAudit(c, {
      setId: state?.id ?? null,
      ownerTenantId,
      versionId: detail.versionId,
      enabled: request.enabled,
      created: false,
      result: 'failed',
      stageFailed: detail.stage,
      ruleCount,
    });
    const { status, body } = detail.outcomeUnknown
      ? {
          status: 500 as const,
          body: {
            error: 'outcome_unknown',
            error_description:
              'It is not known whether the Mapping Set was changed; read it before saving again',
          },
        }
      : errorBody(detail.cause);
    if (status === 500) log.error('A Mapping Set save failed', { stage: detail.stage });
    return c.json(
      {
        ...body,
        stage_failed: detail.stage,
        version_id: detail.versionId,
        version_discarded: detail.versionDiscarded,
      },
      status
    );
  }
}

export async function readSaveBody(c: AdminContext): Promise<unknown> {
  let text: string;
  try {
    const bytes = await readRequestBytesWithLimit(c.req.raw, REQUEST_BODY_LIMIT_BYTES);
    text = new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof BodyLimitExceededError) throw badRequest('Request body is too large');
    throw badRequest('Request body is unreadable');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

function previewRequested(c: Context): boolean {
  const value = c.req.query('preview');
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw badRequest('preview must be true or false');
}

/** PUT /api/admin/identity-mapping/sets/{id}: replace the content of a set. */
export async function adminIdentityMappingSetPutHandler(c: AdminContext) {
  try {
    const setId = validSetId(c);
    const preview = previewRequested(c);
    const repository = createRepository(c);
    // Who may change the set is settled before the body is looked at.
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      getTenantIdFromContext(c),
      setId,
      'write'
    );
    const state = await repository.findFieldMappingSetState(ownerTenantId, setId);
    if (!state) throw notFound('field mapping set not found');
    const request = parseMappingSetSaveRequest(await readSaveBody(c));
    if (request.fieldMappingKey !== null && request.fieldMappingKey !== state.field_mapping_key) {
      throw badRequest('field_mapping_key cannot be changed');
    }
    if (request.ownerScopeType !== null && request.ownerScopeType !== ownerLabel(ownerTenantId)) {
      throw badRequest('owner_scope_type cannot be changed');
    }
    return await executeSave(c, repository, { ownerTenantId, state }, request, preview);
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}

/** POST /api/admin/identity-mapping/sets: create a set and save its content. */
export async function adminIdentityMappingSetCreateHandler(c: AdminContext) {
  try {
    const preview = previewRequested(c);
    const request = parseMappingSetSaveRequest(await readSaveBody(c));
    if (request.fieldMappingKey === null) throw badRequest('field_mapping_key is required');
    // The platform's namespace is for platform authority; anything else is the caller's tenant's.
    assertPlatformOwnerScopeAllowed(c, { ownerScopeType: request.ownerScopeType });
    const ownerTenantId =
      request.ownerScopeType === 'platform'
        ? PLATFORM_MAPPING_TENANT_ID
        : getTenantIdFromContext(c);
    const repository = createRepository(c);
    if (await repository.fieldMappingKeyExists(ownerTenantId, request.fieldMappingKey)) {
      throw conflict('field_mapping_key already exists');
    }
    return await executeSave(c, repository, { ownerTenantId, state: null }, request, preview);
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}

/**
 * DELETE /api/admin/identity-mapping/sets/{id}: a set that is switched on is switched off and
 * deleted in one batch. It is refused (409) while anything names the set, and when `If-Match`
 * does not match the content version the caller read; a save or switch that lands between the
 * read here and the batch fails the batch's own check (also 409) and deletes nothing.
 */
export async function adminIdentityMappingSetDeleteHandler(c: AdminContext) {
  try {
    const setId = validSetId(c);
    const repository = createRepository(c);
    const ownerTenantId = await resolveFieldMappingSetOwner(
      c,
      repository,
      getTenantIdFromContext(c),
      setId,
      'write'
    );
    const state = await repository.findFieldMappingSetState(ownerTenantId, setId);
    if (!state) throw notFound('field mapping set not found');
    assertPrecondition({ ifMatch: c.req.header('If-Match'), ifNoneMatch: undefined }, state);
    refuseIfInUse(
      await checkMappingSetUnreferenced(c, { setId, ownerTenantId, action: 'deleted' })
    );
    (c as unknown as { set(key: string, value: unknown): void }).set(
      MAPPING_SET_SAVE_STARTED,
      true
    );
    const deleted = await repository.deleteFieldMappingSetEndingActivation(ownerTenantId, setId, {
      expectedCurrentVersionId: state.current_version_id,
      expectedActiveVersionId: state.active_version_id,
    });
    try {
      await createAuditLogFromContext(
        c as unknown as Parameters<typeof createAuditLogFromContext>[0],
        'identity_mapping.set.deleted',
        'field_mapping_set',
        setId,
        {
          set_id: setId,
          owner: ownerLabel(ownerTenantId),
          was_enabled: deleted.endedActiveVersionId !== null,
        }
      );
    } catch {
      log.warn('The audit record of a Mapping Set deletion could not be written');
    }
    return c.json({ id: deleted.id, owner: ownerLabel(ownerTenantId), deleted: true });
  } catch (error) {
    return controlPlaneErrorResponse(c, error);
  }
}
