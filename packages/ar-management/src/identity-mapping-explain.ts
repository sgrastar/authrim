/**
 * POST /api/admin/identity-mapping/explain
 *
 * Why an app of the calling tenant gets, or does not get, each claim: which Mapping Set the
 * selection names and where that was decided, whether the set can be used, and for each claim
 * whether its value is there, whether the scopes and the user's consent let it through, and the
 * final answer with a fixed reason code. For a test user only (a made-up set of attributes, see
 * identity-mapping-test-users.ts): looking at a real person is the investigations' entrance.
 *
 * Nothing is worked out here: the claims are built and released by the functions the token
 * endpoint (ID token) and UserInfo run — `evaluateClaimsForTarget`, then `applyOIDCIdentityMapping`
 * with the same surface, scopes, claims and source attributes — told only that the subject is a
 * test user (so nothing is looked up by its ID, and its consent is the one asked for) and asked
 * to record what each step decided (`trace`). The answer says what was decided, never a value.
 *
 * Covered: the code flow's ID token from the token endpoint (no claims parameter) and UserInfo.
 * Not covered: the attribute release consent screen's own record, which a test user never has.
 */
import type { Context } from 'hono';
import {
  applyOIDCIdentityMapping,
  buildStandardUserClaims,
  createAuthContextFromHono,
  DestinationProfileReleaseValidationError,
  ensureAdminDatabaseAdapter,
  evaluateClaimsForTarget,
  getClient,
  getTenantIdFromContext,
  IdentityMappingSelectionError,
  OIDC_STANDARD_CLAIM_SCOPE,
  OIDCIdentityMappingRuntimeError,
  RuntimeIdentityMappingReleaseSafetyError,
  selectIdentityMapping,
  type Env,
  type IdentityMappingSelection,
  type OIDCReleaseTrace,
  withStandardUserAttributeNames,
} from '@authrim/ar-lib-core';
import {
  describeChain,
  describeSelection,
  describeSelectionFailure,
  readImplicitActivationWarnings,
  readSetFactsForTenants,
} from './identity-mapping-effective';
import { OIDC_CLAIM_NAME_PATTERN } from './identity-mapping-control-plane';
import { findTestUser, type TestUser } from './identity-mapping-test-users';

type ExplainContext = Context<{ Bindings: Env }>;

const PARTITION = 'identity-mapping-explain';
const CLIENT_ID_MAX_LENGTH = 256;
const MAX_SCOPES = 50;
const MAX_ASKED_CLAIMS = 50;
/** A scope name: printable ASCII but space, quote and backslash (RFC 6749 3.3). */
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;

/** Why a claim is not released. A fixed list; never a value. */
export type ClaimDropReason =
  | 'issuance_stopped'
  | 'mapping_not_applied'
  | 'not_in_set'
  | 'surface_not_listed'
  | 'scope_not_granted'
  | 'value_missing'
  | 'value_empty'
  | 'consent_missing';

type Surface = 'id_token' | 'userinfo';

interface ExplainRequest {
  clientId: string;
  testUserId: string;
  surface: Surface;
  scopes: string[] | null;
  consent: 'all' | 'none';
  askedClaims: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNames(value: unknown, max: number, pattern: RegExp): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((item) => typeof item === 'string' && pattern.test(item))) return null;
  return [...new Set(value as string[])];
}

function parseRequest(body: unknown): ExplainRequest | string {
  const known = ['client_id', 'subject', 'surface', 'scopes', 'consent', 'claims'];
  if (!isRecord(body) || Object.keys(body).some((key) => !known.includes(key))) {
    return `The body is an object of ${known.join(', ')}`;
  }
  const clientId = body.client_id;
  if (
    typeof clientId !== 'string' ||
    clientId.length === 0 ||
    clientId.length > CLIENT_ID_MAX_LENGTH ||
    clientId !== clientId.trim()
  ) {
    return 'client_id must be an app (client) ID';
  }
  const subject = body.subject;
  if (
    !isRecord(subject) ||
    Object.keys(subject).some((key) => key !== 'kind' && key !== 'id') ||
    subject.kind !== 'test_user' ||
    typeof subject.id !== 'string' ||
    subject.id.length === 0 ||
    subject.id.length > 64
  ) {
    // A real user is the investigations' entrance: a reason is recorded for looking at one.
    return 'subject must be { kind: "test_user", id }';
  }
  if (body.surface !== 'id_token' && body.surface !== 'userinfo') {
    return 'surface must be id_token or userinfo';
  }
  let scopes: string[] | null = null;
  if (body.scopes !== undefined) {
    scopes = readNames(body.scopes, MAX_SCOPES, SCOPE_PATTERN);
    if (!scopes) return `scopes must be at most ${MAX_SCOPES} scope names`;
  }
  const consent = body.consent ?? 'all';
  if (consent !== 'all' && consent !== 'none') return 'consent must be all or none';
  let askedClaims: string[] = [];
  if (body.claims !== undefined) {
    const names = readNames(body.claims, MAX_ASKED_CLAIMS, OIDC_CLAIM_NAME_PATTERN);
    if (!names) return `claims must be at most ${MAX_ASKED_CLAIMS} claim names`;
    askedClaims = names;
  }
  return {
    clientId,
    testUserId: subject.id,
    surface: body.surface,
    scopes,
    consent,
    askedClaims,
  };
}

/** The claims Authrim gives from the user's own standard attributes (OIDC Core 5.1), and `sub`. */
const STANDARD_USER_CLAIMS = new Set(['sub', ...Object.keys(OIDC_STANDARD_CLAIM_SCOPE)]);

type Outcome =
  | { kind: 'issued' }
  | { kind: 'stopped'; code: string; tier?: string; claim?: string };

/** Why the release stopped, as a fixed code (and the claim, for a value the profile refused). */
function stoppedOutcome(error: unknown, trace: OIDCReleaseTrace): Outcome | null {
  if (trace.resolutionFailure) {
    return {
      kind: 'stopped',
      code: trace.resolutionFailure.code,
      ...(trace.resolutionFailure.tier ? { tier: trace.resolutionFailure.tier } : {}),
    };
  }
  if (error instanceof DestinationProfileReleaseValidationError) {
    return {
      kind: 'stopped',
      code: error.code,
      ...(error.field ? { claim: error.field } : {}),
    };
  }
  if (error instanceof RuntimeIdentityMappingReleaseSafetyError) {
    return { kind: 'stopped', code: `release_safety.${error.reason}`, claim: error.field };
  }
  if (error instanceof OIDCIdentityMappingRuntimeError) {
    return { kind: 'stopped', code: error.details.code };
  }
  return null;
}

interface ClaimLine {
  claim: string;
  field: string | null;
  sources: string[];
  origin: 'standard' | 'mapping' | 'requested';
  value: 'present' | 'missing' | 'empty' | 'not_read' | 'not_evaluated';
  scope: string | null;
  scope_granted: boolean;
  consent: 'not_required' | 'granted' | 'missing';
  released: boolean | null;
  reason?: ClaimDropReason;
}

function isEmptyValue(value: unknown): boolean {
  return value === '' || value === null || (Array.isArray(value) && value.length === 0);
}

/** Composes one line per claim from what each step recorded. */
function explainClaims(input: {
  surface: Surface;
  scopes: readonly string[];
  testUser: TestUser;
  claimsIn: Record<string, unknown>;
  trace: OIDCReleaseTrace;
  released: Record<string, unknown> | null;
  stopped: boolean;
  askedClaims: readonly string[];
}): ClaimLine[] {
  const { trace } = input;
  const granted = new Set(input.scopes);
  // Under the standard names too, as the claims were built from them.
  const attributes = withStandardUserAttributeNames(input.testUser.attributes);
  const mapping = new Map((trace.mapping ?? []).map((entry) => [entry.claim, entry]));
  // A profile may list a claim more than once; the release judges each entry. The entry that
  // decides is one in play on this call, else one this surface lists (the scopes held it), else
  // any.
  type FieldEntry = NonNullable<OIDCReleaseTrace['release']>['fields'][number];
  const rank = (field: FieldEntry) =>
    field.excludedBy === undefined ? 0 : field.excludedBy === 'scope' ? 1 : 2;
  const fields = new Map<string, FieldEntry>();
  for (const field of trace.release?.fields ?? []) {
    const kept = fields.get(field.claim);
    if (!kept || rank(field) < rank(kept)) {
      fields.set(field.claim, field);
    } else if (rank(field) === 0 && rank(kept) === 0) {
      // Two entries in play: any optional one without consent removes the claim.
      const consents = [kept.consent, field.consent];
      fields.set(field.claim, {
        ...kept,
        required: kept.required && field.required,
        consent: consents.includes('missing')
          ? 'missing'
          : consents.includes('granted')
            ? 'granted'
            : 'not_required',
      });
    }
  }
  const bound = Boolean(trace.binding);
  const before = trace.beforeRelease ?? {};

  // Every claim the steps looked at, the standard claims these scopes reach, and those asked about.
  const names = new Set<string>([
    'sub',
    ...fields.keys(),
    ...mapping.keys(),
    ...Object.keys(input.claimsIn),
    ...Object.keys(before),
    ...Object.entries(OIDC_STANDARD_CLAIM_SCOPE)
      .filter(([, scope]) => granted.has(scope))
      .map(([claim]) => claim),
    ...input.askedClaims,
  ]);

  return [...names].sort().map((claim): ClaimLine => {
    const target = mapping.get(claim);
    const field = fields.get(claim);
    const origin = target ? 'mapping' : STANDARD_USER_CLAIMS.has(claim) ? 'standard' : 'requested';
    const sources = target?.sources ?? (origin === 'standard' && claim !== 'sub' ? [claim] : []);
    const standardScope = Object.hasOwn(OIDC_STANDARD_CLAIM_SCOPE, claim)
      ? OIDC_STANDARD_CLAIM_SCOPE[claim]
      : undefined;
    const requiredScopes = field?.requiredScopes ?? (standardScope ? [standardScope] : []);
    const scopeGranted =
      requiredScopes.length === 0 || requiredScopes.some((scope) => granted.has(scope));

    // The value as the release saw it; for a claim it never got, whether the test user's
    // attribute it reads is there but empty.
    let value: ClaimLine['value'];
    if (input.stopped && !trace.beforeRelease) value = 'not_read';
    else if (target?.notEvaluated) value = 'not_evaluated';
    else if (Object.hasOwn(before, claim)) value = before[claim];
    else if (claim === 'sub') value = 'present';
    else {
      value = sources.some(
        (source) => Object.hasOwn(attributes, source) && isEmptyValue(attributes[source])
      )
        ? 'empty'
        : 'missing';
    }

    const consent = field?.consent ?? 'not_required';
    const releasedNow = input.released ? Object.hasOwn(input.released, claim) : false;
    const line: ClaimLine = {
      claim,
      field: sources[0] ?? null,
      sources,
      origin,
      value,
      scope: requiredScopes[0] ?? null,
      scope_granted: scopeGranted,
      consent,
      released: releasedNow && value === 'not_evaluated' ? null : releasedNow,
    };
    if (releasedNow) return line;

    let reason: ClaimDropReason;
    if (input.stopped) reason = 'issuance_stopped';
    else if (!bound && origin !== 'standard') reason = 'mapping_not_applied';
    else if (bound && !field) reason = 'not_in_set';
    else if (field?.excludedBy === 'surface') reason = 'surface_not_listed';
    else if (field?.excludedBy === 'scope' || !scopeGranted) reason = 'scope_not_granted';
    else if (!bound && input.surface === 'id_token') {
      // Without a mapping, the token endpoint's ID token carries the protocol claims; the scope
      // claims are UserInfo's.
      reason = 'surface_not_listed';
    } else if (value === 'missing') reason = 'value_missing';
    else if (value === 'empty') reason = 'value_empty';
    else if (consent === 'missing') reason = 'consent_missing';
    else reason = 'not_in_set';
    return { ...line, reason };
  });
}

function scopesOf(raw: string | null | undefined): string[] {
  const scopes = (raw ?? '').split(/\s+/).filter((scope) => scope.length > 0);
  return scopes.includes('openid') ? scopes : ['openid', ...scopes];
}

export async function adminIdentityMappingExplainHandler(c: ExplainContext) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_request', error_description: 'Invalid JSON body' }, 400);
  }
  const request = parseRequest(body);
  if (typeof request === 'string') {
    return c.json({ error: 'invalid_request', error_description: request }, 400);
  }

  const tenantId = getTenantIdFromContext(c);
  const admin = ensureAdminDatabaseAdapter(c.env, PARTITION);
  if (!admin) {
    return c.json(
      { error: 'temporarily_unavailable', error_description: 'The Admin database is not bound' },
      503
    );
  }

  try {
    const { coreAdapter } = createAuthContextFromHono(c, tenantId);
    // The app as the issuing endpoints read it: the tenant's row alone.
    const client = await getClient(c.env, tenantId, request.clientId, coreAdapter);
    if (!client) {
      return c.json({ error: 'not_found', error_description: 'client not found' }, 404);
    }
    const testUser = await findTestUser(admin, tenantId, request.testUserId);
    if (!testUser) {
      return c.json({ error: 'not_found', error_description: 'test user not found' }, 404);
    }
    const scopes = request.scopes ?? scopesOf(client.scope);

    // Which set is named and where that was decided, every level shown (as the effective view).
    let selection: IdentityMappingSelection | null = null;
    let selectionFailure: IdentityMappingSelectionError | null = null;
    try {
      selection = await selectIdentityMapping({
        env: c.env,
        tenantId,
        protocol: 'oidc',
        clientSelector: client.identity_mapping ?? null,
        inspectDefaults: true,
        fresh: true,
      });
    } catch (error) {
      if (!(error instanceof IdentityMappingSelectionError)) throw error;
      selectionFailure = error;
    }
    const chain = selection?.chain ?? selectionFailure?.chain ?? [];
    const facts =
      (
        await readSetFactsForTenants(
          c.env,
          PARTITION,
          new Map([[tenantId, chain.flatMap((entry) => (entry.setId ? [entry.setId] : []))]])
        )
      )?.get(tenantId) ?? null;
    const warnings =
      selection?.kind === 'none' && selection.reason === 'no_default'
        ? await readImplicitActivationWarnings(c.env, tenantId, request.clientId)
        : { warnings: [] };

    // The claims the endpoint starts from: the token endpoint's ID token carries the protocol
    // claims (no claims parameter here), UserInfo the scope claims.
    const sub = testUser.userId;
    // The test user's attributes are named as the field catalog names them; the standard claims
    // are built from them as the endpoints build them from an account's.
    const userData = {
      ...buildStandardUserClaims(
        withStandardUserAttributeNames(testUser.attributes) as Parameters<
          typeof buildStandardUserClaims
        >[0]
      ),
      sub,
    };
    const evaluated = evaluateClaimsForTarget({
      target: request.surface,
      initialClaims: { sub },
      availableClaims: userData,
      grantedScopes: scopes,
      clientPolicy: client,
      includeScopeClaims: request.surface === 'userinfo',
    });
    if (!evaluated.ok) {
      return c.json(
        { error: 'invalid_request', error_description: 'The scopes cannot be used' },
        400
      );
    }

    const trace: OIDCReleaseTrace = {};
    let released: Record<string, unknown> | null = null;
    let outcome: Outcome = { kind: 'issued' };
    try {
      const mapped = await applyOIDCIdentityMapping({
        adapter: coreAdapter,
        env: c.env,
        tenantId,
        clientId: request.clientId,
        sectorIdentifier: client.sector_identifier_uri,
        selector: client.identity_mapping,
        destinationSurface: request.surface,
        grantedScopes: scopes,
        claims: { ...evaluated.claims },
        // The test user's attributes, standard ones as the endpoints build them.
        sourceAttributes: { ...testUser.attributes, ...userData },
        trace,
        fixture: { consent: request.consent },
        // The settings as just saved, as the selection shown is read.
        fresh: true,
      });
      released = mapped.claims;
    } catch (error) {
      const stopped = stoppedOutcome(error, trace);
      if (!stopped) throw error;
      outcome = stopped;
    }

    return c.json({
      tenantId,
      clientId: request.clientId,
      surface: request.surface,
      subject: { kind: 'test_user', user_id: testUser.userId },
      scopes,
      consent: request.consent,
      // The selection the release made, which the claims follow; the levels are the view's.
      selection: trace.selection
        ? describeSelection(trace.selection, facts)
        : selectionFailure
          ? describeSelectionFailure(selectionFailure)
          : describeSelection(selection as IdentityMappingSelection, facts),
      chain: describeChain(chain, facts),
      ...warnings,
      outcome,
      claims: explainClaims({
        surface: request.surface,
        scopes,
        testUser,
        claimsIn: evaluated.claims,
        trace,
        released,
        stopped: outcome.kind === 'stopped',
        askedClaims: request.askedClaims,
      }),
    });
  } catch {
    return c.json(
      { error: 'internal_error', error_description: 'The release could not be explained' },
      500
    );
  }
}
