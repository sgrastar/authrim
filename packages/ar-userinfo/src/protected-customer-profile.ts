import { Hono } from 'hono';
import type { Context } from 'hono';
import type {
  Env,
  CachedUser,
  IntrospectionResponse,
  DelegatedWriteAudit,
  UpdateUserPIIInput,
} from '@authrim/ar-lib-core';
import {
  buildRequestIssuerUrl,
  consumeStepUpReceipt,
  createDelegatedWriteEnvelopeErrorResponse,
  createDownstreamGrantProtectedResourceMiddleware,
  createDownstreamGrantServiceAuthorizer,
  createPIIContextFromHono,
  createStepUpErrorResponse,
  createStepUpOperationHash,
  getCachedUser,
  getDownstreamGrantProtectedResourceContext,
  getDownstreamGrantRedactionLevel,
  getPublicKeyByKid,
  getProductProtectedResourceDefinition,
  introspectTokenFromContext,
  invalidateUserCache,
  issueStepUpToken,
  parseDelegatedWriteEnvelope,
  projectDownstreamGrantProtectedResource,
  readResponseTextWithLimit,
  requiredIdempotencyMiddleware,
  resolveProductProtectedResourceAudience,
  StepUpFlowError,
  UserPIIRepository,
  DelegatedWriteEnvelopeError,
  type DownstreamGrantProtectedResourceProjector,
  type DownstreamGrantServiceAuthorizer,
  type ApprovalRedactionLevel,
  verifyToken,
} from '@authrim/ar-lib-core';
import { getTenantIdFromContext } from '@authrim/ar-lib-core';

export const USERINFO_CUSTOMER_PROFILE_RESOURCE_CLASS = 'customer_profile';
export const USERINFO_CUSTOMER_PROFILE_DETAIL_CLASS = 'profile_export';
export const DEFAULT_USERINFO_PROTECTED_AUDIENCE =
  getProductProtectedResourceDefinition(USERINFO_CUSTOMER_PROFILE_RESOURCE_CLASS)
    ?.defaultAudience ?? 'svc://op-userinfo/customer-profile';

export interface ProtectedCustomerProfileResource {
  id: string;
  tenantId: string;
  name: string | null;
  familyName: string | null;
  givenName: string | null;
  middleName: string | null;
  nickname: string | null;
  preferredUsername: string | null;
  picture: string | null;
  locale: string | null;
  zoneinfo: string | null;
  profile: string | null;
  website: string | null;
  birthdate: string | null;
  gender: string | null;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  address: {
    formatted: string | null;
    street_address: string | null;
    locality: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
  } | null;
  updatedAt: number;
}

export interface ProtectedCustomerProfileSummaryView {
  sub: string;
  tenant_id: string;
  email_verified: boolean;
  phone_number_verified: boolean;
  updated_at: number;
}

export interface ProtectedCustomerProfileMaskedView extends ProtectedCustomerProfileSummaryView {
  name: string | null;
  given_name: string | null;
  family_name: string | null;
  preferred_username: string | null;
  email: string | null;
  phone_number: string | null;
  locale: string | null;
  zoneinfo: string | null;
  address: {
    locality: string | null;
    region: string | null;
    country: string | null;
  } | null;
}

export interface ProtectedCustomerProfileRawView extends ProtectedCustomerProfileSummaryView {
  name: string | null;
  family_name: string | null;
  given_name: string | null;
  middle_name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  picture: string | null;
  profile: string | null;
  website: string | null;
  gender: string | null;
  birthdate: string | null;
  zoneinfo: string | null;
  locale: string | null;
  email: string | null;
  phone_number: string | null;
  address: ProtectedCustomerProfileResource['address'];
}

export interface ProtectedCustomerProfileRouteOptions {
  audience?: string;
  verifyToken?: (input: {
    token: string;
    c: Context<{ Bindings: Env }>;
  }) => Promise<Record<string, unknown>>;
  introspectToken?: (input: {
    token: string;
    c: Context<{ Bindings: Env }>;
  }) => Promise<IntrospectionResponse>;
  loadProfile?: (input: {
    c: Context<{ Bindings: Env }>;
    tenantId: string;
    userId: string;
  }) => Promise<ProtectedCustomerProfileResource | null>;
  validateDelegatedWriteActor?: (input: {
    c: Context<{ Bindings: Env }>;
    subjectUserId: string;
  }) => Promise<DelegatedWriteActorContext | Response>;
  updateProfile?: (input: {
    c: Context<{ Bindings: Env }>;
    tenantId: string;
    subjectUserId: string;
    actor: DelegatedWriteActorContext;
    update: UpdateUserPIIInput;
    audit?: DelegatedWriteAudit;
  }) => Promise<ProtectedCustomerProfileResource | null>;
}

export interface DelegatedWriteActorContext {
  actorId: string;
  claims: Record<string, unknown>;
}

export interface CustomerProfileDelegatedWriteOperationInput {
  subjectUserId: string;
  input: unknown;
  audit?: DelegatedWriteAudit;
}

function decodeJwtHeader(token: string): { kid?: string } | null {
  try {
    const [header] = token.split('.');
    if (!header) {
      return null;
    }
    const base64 = header.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)) as { kid?: string };
  } catch {
    return null;
  }
}

function resolveProtectedCustomerProfileAudience(
  env: Pick<Env, 'USERINFO_PROTECTED_RESOURCE_AUDIENCE'> | undefined,
  override?: string
): string {
  return (
    resolveProductProtectedResourceAudience({
      resourceClass: USERINFO_CUSTOMER_PROFILE_RESOURCE_CLASS,
      requestedAudience: override ?? env?.USERINFO_PROTECTED_RESOURCE_AUDIENCE,
    }) ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE
  );
}

function resolveProtectedCustomerProfileIntrospectionClient(
  env:
    | Pick<
        Env,
        'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID' | 'DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET'
      >
    | undefined
): { clientId: string; clientSecret: string } | null {
  const clientId = env?.DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_ID?.trim();
  const clientSecret = env?.DOWNSTREAM_GRANT_INTROSPECTION_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return {
    clientId,
    clientSecret,
  };
}

function parseAddress(addressJson: string | null): ProtectedCustomerProfileResource['address'] {
  if (!addressJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(addressJson) as Record<string, unknown>;
    return {
      formatted: typeof parsed.formatted === 'string' ? parsed.formatted : null,
      street_address: typeof parsed.street_address === 'string' ? parsed.street_address : null,
      locality: typeof parsed.locality === 'string' ? parsed.locality : null,
      region: typeof parsed.region === 'string' ? parsed.region : null,
      postal_code: typeof parsed.postal_code === 'string' ? parsed.postal_code : null,
      country: typeof parsed.country === 'string' ? parsed.country : null,
    };
  } catch {
    return null;
  }
}

function mapCachedUserToProtectedCustomerProfile(
  user: CachedUser,
  tenantId: string
): ProtectedCustomerProfileResource {
  return {
    id: user.id,
    tenantId,
    name: user.name ?? null,
    familyName: user.family_name ?? null,
    givenName: user.given_name ?? null,
    middleName: user.middle_name ?? null,
    nickname: user.nickname ?? null,
    preferredUsername: user.preferred_username ?? null,
    picture: user.picture ?? null,
    locale: user.locale ?? null,
    zoneinfo: user.zoneinfo ?? null,
    profile: user.profile ?? null,
    website: user.website ?? null,
    birthdate: user.birthdate ?? null,
    gender: user.gender ?? null,
    email: user.email ?? null,
    emailVerified: Boolean(user.email_verified),
    phoneNumber: user.phone_number ?? null,
    phoneNumberVerified: Boolean(user.phone_number_verified),
    address: parseAddress(user.address),
    updatedAt: user.updated_at,
  };
}

async function loadProtectedCustomerProfileFromEnv(input: {
  c: Context<{ Bindings: Env }>;
  tenantId: string;
  userId: string;
}): Promise<ProtectedCustomerProfileResource | null> {
  const piiCtx = createPIIContextFromHono(input.c, input.tenantId);
  const cachedUser = await getCachedUser(input.c.env, input.tenantId, input.userId, {
    coreDb: piiCtx.coreAdapter,
    piiDb: piiCtx.defaultPiiAdapter,
  });
  if (!cachedUser) {
    return null;
  }
  return mapCachedUserToProtectedCustomerProfile(cachedUser, input.tenantId);
}

function noStoreJson(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidDelegatedWriteRequest(message: string, field?: string): Response {
  return noStoreJson(
    {
      error: 'invalid_request',
      error_description: message,
      ...(field ? { field } : {}),
    },
    400
  );
}

function readNullableString(
  input: Record<string, unknown>,
  field: string
): string | null | undefined | Response {
  if (!Object.prototype.hasOwnProperty.call(input, field)) {
    return undefined;
  }
  const value = input[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return invalidDelegatedWriteRequest(
      `input.${field} must be a string or null`,
      `input.${field}`
    );
  }
  return value;
}

function readRequiredString(
  input: Record<string, unknown>,
  field: string
): string | undefined | Response {
  if (!Object.prototype.hasOwnProperty.call(input, field)) {
    return undefined;
  }
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalidDelegatedWriteRequest(
      `input.${field} must be a non-empty string`,
      `input.${field}`
    );
  }
  return value;
}

function normalizeAddressUpdate(value: unknown): Partial<UpdateUserPIIInput> | Response {
  if (value === undefined) {
    return {};
  }
  if (value === null) {
    return {
      address_formatted: null,
      address_street_address: null,
      address_locality: null,
      address_region: null,
      address_postal_code: null,
      address_country: null,
    };
  }
  if (!isRecord(value)) {
    return invalidDelegatedWriteRequest('input.address must be an object or null', 'input.address');
  }

  const allowed = new Set([
    'formatted',
    'street_address',
    'locality',
    'region',
    'postal_code',
    'country',
  ]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      return invalidDelegatedWriteRequest(
        `Unknown input.address field: ${field}`,
        `input.address.${field}`
      );
    }
  }

  const update: Partial<UpdateUserPIIInput> = {};
  type NullableStringUpdateField = Exclude<keyof UpdateUserPIIInput, 'pii_class'>;
  const mapping: Array<[string, NullableStringUpdateField]> = [
    ['formatted', 'address_formatted'],
    ['street_address', 'address_street_address'],
    ['locality', 'address_locality'],
    ['region', 'address_region'],
    ['postal_code', 'address_postal_code'],
    ['country', 'address_country'],
  ];
  for (const [source, target] of mapping) {
    const normalized = readNullableString(value, source);
    if (normalized instanceof Response) {
      return normalized;
    }
    if (normalized !== undefined) {
      (update as Record<string, string | null>)[target] = normalized;
    }
  }
  return update;
}

function normalizeCustomerProfileUpdateInput(input: unknown): UpdateUserPIIInput | Response {
  if (!isRecord(input)) {
    return invalidDelegatedWriteRequest('input must be an object', 'input');
  }

  const allowed = new Set([
    'email',
    'phone_number',
    'name',
    'given_name',
    'family_name',
    'nickname',
    'preferred_username',
    'picture',
    'website',
    'gender',
    'birthdate',
    'locale',
    'zoneinfo',
    'address',
  ]);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      return invalidDelegatedWriteRequest(`Unknown input field: ${field}`, `input.${field}`);
    }
  }

  const update: UpdateUserPIIInput = {};
  const email = readRequiredString(input, 'email');
  if (email instanceof Response) return email;
  if (email !== undefined) update.email = email;

  type NullableStringUpdateField = Exclude<keyof UpdateUserPIIInput, 'pii_class'>;
  const directStringFields: Array<[string, NullableStringUpdateField]> = [
    ['phone_number', 'phone_number'],
    ['name', 'name'],
    ['given_name', 'given_name'],
    ['family_name', 'family_name'],
    ['nickname', 'nickname'],
    ['preferred_username', 'preferred_username'],
    ['picture', 'picture'],
    ['website', 'website'],
    ['gender', 'gender'],
    ['birthdate', 'birthdate'],
    ['locale', 'locale'],
    ['zoneinfo', 'zoneinfo'],
  ];
  for (const [source, target] of directStringFields) {
    const normalized = readNullableString(input, source);
    if (normalized instanceof Response) {
      return normalized;
    }
    if (normalized !== undefined) {
      (update as Record<string, string | null>)[target] = normalized;
    }
  }

  const addressUpdate = normalizeAddressUpdate(input.address);
  if (addressUpdate instanceof Response) {
    return addressUpdate;
  }
  Object.assign(update, addressUpdate);

  if (Object.keys(update).length === 0) {
    return invalidDelegatedWriteRequest('input must include at least one profile field', 'input');
  }
  return update;
}

export function createCustomerProfileDelegatedWriteOperation(
  input: CustomerProfileDelegatedWriteOperationInput
): Record<string, unknown> {
  return {
    resource: 'customer_profile',
    action: 'update',
    method: 'PATCH',
    path: '/api/protected/customer-profiles/users/{subject_user_id}',
    subject_user_id: input.subjectUserId,
    input: input.input,
    audit: input.audit ?? null,
  };
}

async function validateDelegatedWriteActorFromContext(input: {
  c: Context<{ Bindings: Env }>;
}): Promise<DelegatedWriteActorContext | Response> {
  const introspection = await introspectTokenFromContext(input.c);
  if (!introspection.valid) {
    const error = introspection.error;
    if (error?.wwwAuthenticate) {
      input.c.header('WWW-Authenticate', error.wwwAuthenticate);
    }
    return noStoreJson(
      {
        error: error?.error ?? 'invalid_token',
        error_description: error?.error_description ?? 'The access token is invalid',
      },
      error?.statusCode ?? 401
    );
  }

  const claims = (introspection.claims ?? {}) as Record<string, unknown>;
  const actorId = typeof claims.sub === 'string' ? claims.sub : '';
  if (!actorId) {
    return noStoreJson(
      {
        error: 'invalid_token',
        error_description: 'Access token must contain an actor subject',
      },
      401
    );
  }
  return { actorId, claims };
}

function rejectProductElevationToken(actor: DelegatedWriteActorContext): Response | null {
  if (
    actor.claims.authrim_elevation !== undefined ||
    actor.claims.token_use === 'elevation_grant_subject'
  ) {
    return noStoreJson(
      {
        error: 'access_denied',
        error_description:
          'Product-specific downstream elevation grant tokens are not accepted for standard delegated write.',
      },
      403
    );
  }
  return null;
}

async function updateProtectedCustomerProfileFromEnv(input: {
  c: Context<{ Bindings: Env }>;
  tenantId: string;
  subjectUserId: string;
  update: UpdateUserPIIInput;
}): Promise<ProtectedCustomerProfileResource | null> {
  const piiCtx = createPIIContextFromHono(input.c, input.tenantId);
  const repository = new UserPIIRepository(piiCtx.defaultPiiAdapter, input.tenantId);
  const updated = await repository.updatePII(
    input.subjectUserId,
    input.update,
    piiCtx.defaultPiiAdapter
  );
  if (!updated) {
    return null;
  }
  await invalidateUserCache(input.c.env, input.tenantId, input.subjectUserId);
  return loadProtectedCustomerProfileFromEnv({
    c: input.c,
    tenantId: input.tenantId,
    userId: input.subjectUserId,
  });
}

function stepUpFlowErrorToResponse(error: StepUpFlowError): Response {
  if (!error.detailCode) {
    return noStoreJson(
      {
        error: error.error,
        error_description: error.message,
      },
      error.httpStatus
    );
  }
  return createStepUpErrorResponse(
    {
      error: error.error,
      error_description: error.message,
      code: error.detailCode,
      ...(error.statusObject ? { status: error.statusObject } : {}),
      ...(error.inputState ? { input_state: error.inputState } : {}),
      ...(error.stepUp ? { step_up: error.stepUp } : {}),
      ...(error.nextAction ? { next_action: error.nextAction } : {}),
    },
    error.httpStatus === 404 ? 400 : error.httpStatus
  );
}

function maskEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) {
    return '***';
  }
  const visibleLocal = localPart.slice(0, 2);
  return `${visibleLocal}${'*'.repeat(Math.max(1, localPart.length - visibleLocal.length))}@${domain}`;
}

function maskPhone(phoneNumber: string | null): string | null {
  if (!phoneNumber) {
    return null;
  }
  const trimmed = phoneNumber.trim();
  if (trimmed.length <= 4) {
    return '*'.repeat(trimmed.length);
  }
  return `${'*'.repeat(trimmed.length - 4)}${trimmed.slice(-4)}`;
}

function maskDisplayName(name: string | null): string | null {
  if (!name) {
    return null;
  }
  const chars = Array.from(name.trim());
  if (chars.length <= 1) {
    return '*';
  }
  return `${chars[0]}${'*'.repeat(Math.max(1, chars.length - 1))}`;
}

function buildSummaryProfile(
  resource: ProtectedCustomerProfileResource
): ProtectedCustomerProfileSummaryView {
  return {
    sub: resource.id,
    tenant_id: resource.tenantId,
    email_verified: resource.emailVerified,
    phone_number_verified: resource.phoneNumberVerified,
    updated_at: resource.updatedAt,
  };
}

function buildMaskedProfile(
  resource: ProtectedCustomerProfileResource
): ProtectedCustomerProfileMaskedView {
  return {
    ...buildSummaryProfile(resource),
    name: maskDisplayName(resource.name),
    given_name: maskDisplayName(resource.givenName),
    family_name: maskDisplayName(resource.familyName),
    preferred_username: maskDisplayName(resource.preferredUsername),
    email: maskEmail(resource.email),
    phone_number: maskPhone(resource.phoneNumber),
    locale: resource.locale,
    zoneinfo: resource.zoneinfo,
    address: resource.address
      ? {
          locality: resource.address.locality,
          region: resource.address.region,
          country: resource.address.country,
        }
      : null,
  };
}

function buildRawProfile(
  resource: ProtectedCustomerProfileResource
): ProtectedCustomerProfileRawView {
  return {
    ...buildSummaryProfile(resource),
    name: resource.name,
    family_name: resource.familyName,
    given_name: resource.givenName,
    middle_name: resource.middleName,
    nickname: resource.nickname,
    preferred_username: resource.preferredUsername,
    picture: resource.picture,
    profile: resource.profile,
    website: resource.website,
    gender: resource.gender,
    birthdate: resource.birthdate,
    zoneinfo: resource.zoneinfo,
    locale: resource.locale,
    email: resource.email,
    phone_number: resource.phoneNumber,
    address: resource.address,
  };
}

const protectedCustomerProfileProjector: DownstreamGrantProtectedResourceProjector<
  ProtectedCustomerProfileResource,
  ProtectedCustomerProfileSummaryView,
  ProtectedCustomerProfileMaskedView,
  ProtectedCustomerProfileRawView
> = {
  summary: buildSummaryProfile,
  masked: buildMaskedProfile,
  raw: buildRawProfile,
};

async function verifyProtectedCustomerProfileToken(input: {
  token: string;
  c: Context<{ Bindings: Env }>;
  audience: string;
}): Promise<Record<string, unknown>> {
  const tenantId = getTenantIdFromContext(input.c);
  const header = decodeJwtHeader(input.token);
  const kid = header?.kid;
  if (!kid) {
    throw new Error('Missing token kid');
  }

  const publicKey = await getPublicKeyByKid(input.c.env, tenantId, kid);
  if (!publicKey) {
    throw new Error('No public key for downstream grant token');
  }

  const issuer = buildRequestIssuerUrl(input.c.req.raw, input.c.env, tenantId);
  const payload = await verifyToken(input.token, publicKey, issuer, {
    audience: input.audience,
  });
  return payload as Record<string, unknown>;
}

async function introspectProtectedCustomerProfileToken(input: {
  token: string;
  c: Context<{ Bindings: Env }>;
}): Promise<IntrospectionResponse> {
  const introspectionClient = resolveProtectedCustomerProfileIntrospectionClient(input.c.env);
  if (!introspectionClient) {
    throw new Error('Introspection client is not configured');
  }

  const tenantId = getTenantIdFromContext(input.c);
  const issuer = buildRequestIssuerUrl(input.c.req.raw, input.c.env, tenantId);
  const response = await fetch(`${issuer}/introspect`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(
        `${introspectionClient.clientId}:${introspectionClient.clientSecret}`
      )}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      token: input.token,
      token_type_hint: 'access_token',
    }).toString(),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Introspection failed with status ${response.status}`);
  }

  return JSON.parse(await readResponseTextWithLimit(response, 16 * 1024)) as IntrospectionResponse;
}

export function createProtectedCustomerProfileAuthorizer(
  expectedAudience: string
): DownstreamGrantServiceAuthorizer {
  return createDownstreamGrantServiceAuthorizer({
    expectedAudience,
    requiredResourceClass: USERINFO_CUSTOMER_PROFILE_RESOURCE_CLASS,
    requiredDetailClasses: [USERINFO_CUSTOMER_PROFILE_DETAIL_CLASS],
    requireFullAccess: false,
  });
}

export function createProtectedCustomerProfileRouter(
  options: ProtectedCustomerProfileRouteOptions = {}
) {
  const router = new Hono<{ Bindings: Env }>();

  router.use('/users/:userId', async (c, next) => {
    if (c.req.method !== 'PATCH') {
      return next();
    }
    const validator = options.validateDelegatedWriteActor ?? validateDelegatedWriteActorFromContext;
    const actorResult = await validator({
      c,
      subjectUserId: c.req.param('userId')!,
    });
    if (actorResult instanceof Response) {
      return actorResult;
    }
    const elevationRejection = rejectProductElevationToken(actorResult);
    if (elevationRejection) {
      return elevationRejection;
    }
    (c as any).set('delegatedWriteActor', actorResult);
    (c as any).set('adminAuth', { userId: actorResult.actorId });
    return next();
  });

  router.patch(
    '/users/:userId',
    requiredIdempotencyMiddleware({ ttlSeconds: 300, redactFields: [] }),
    async (c) => {
      const actor = (c as any).get('delegatedWriteActor') as DelegatedWriteActorContext | undefined;
      if (!actor) {
        return noStoreJson(
          {
            error: 'server_error',
            error_description: 'Delegated write actor context is unavailable.',
          },
          500
        );
      }

      const subjectUserId = c.req.param('userId')!;
      const body = await c.req.json().catch(() => null);
      let envelope;
      try {
        envelope = parseDelegatedWriteEnvelope(body);
      } catch (error) {
        if (error instanceof DelegatedWriteEnvelopeError) {
          return createDelegatedWriteEnvelopeErrorResponse(error);
        }
        return invalidDelegatedWriteRequest('Delegated write body is invalid');
      }

      const update = normalizeCustomerProfileUpdateInput(envelope.input);
      if (update instanceof Response) {
        return update;
      }

      const idempotencyKey = c.req.header('Idempotency-Key') ?? undefined;
      const operationHash = await createStepUpOperationHash(
        createCustomerProfileDelegatedWriteOperation({
          subjectUserId,
          input: envelope.input,
          audit: envelope.audit,
        })
      );
      const tenantId = getTenantIdFromContext(c);
      const receipt = c.req.header('Authrim-Step-Up-Receipt');
      if (!receipt) {
        const stepUp = await issueStepUpToken(c.env, {
          tenantId,
          actorId: actor.actorId,
          subjectId: subjectUserId,
          operationHash,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        return createStepUpErrorResponse(
          {
            error: 'step_up_required',
            error_description: 'Step-up is required for this delegated write.',
            code: 'step_up_required',
            step_up: stepUp,
          },
          403
        );
      }

      try {
        await consumeStepUpReceipt(c.env, {
          tenantId,
          actorId: actor.actorId,
          subjectId: subjectUserId,
          operationHash,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          receipt,
        });
      } catch (error) {
        if (error instanceof StepUpFlowError) {
          return stepUpFlowErrorToResponse(error);
        }
        return createStepUpErrorResponse(
          {
            error: 'step_up_required',
            error_description: 'Step-up receipt is invalid or expired.',
            code: 'step_up_required',
          },
          403
        );
      }

      const updater = options.updateProfile ?? updateProtectedCustomerProfileFromEnv;
      const updated = await updater({
        c,
        tenantId,
        subjectUserId,
        actor,
        update,
        audit: envelope.audit,
      });
      if (!updated) {
        return noStoreJson(
          {
            error: 'not_found',
            error_description: 'Customer profile was not found.',
          },
          404
        );
      }

      const include = new Set(
        (c.req.query('include') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      );

      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json({
        customer_profile: buildRawProfile(updated),
        ...(include.has('actor') ? { actor: { id: actor.actorId } } : {}),
        ...(include.has('subject') ? { subject: { id: subjectUserId } } : {}),
        ...(include.has('audit') && envelope.audit ? { audit: envelope.audit } : {}),
      });
    }
  );

  router.use('/:userId', async (c, next) => {
    const env = c.env as Env | undefined;
    const expectedAudience = resolveProtectedCustomerProfileAudience(env, options.audience);
    const authorizer = createProtectedCustomerProfileAuthorizer(expectedAudience);
    const verifyTokenImpl =
      options.verifyToken ??
      (async ({ token, c: context }: { token: string; c: Context<{ Bindings: Env }> }) =>
        verifyProtectedCustomerProfileToken({
          token,
          c: context,
          audience: expectedAudience,
        }));
    const introspectTokenImpl =
      options.introspectToken ??
      (resolveProtectedCustomerProfileIntrospectionClient(env as Env)
        ? async ({ token, c: context }: { token: string; c: Context<{ Bindings: Env }> }) =>
            introspectProtectedCustomerProfileToken({ token, c: context })
        : undefined);

    const middleware =
      createDownstreamGrantProtectedResourceMiddleware<ProtectedCustomerProfileResource>({
        authorizer,
        verifyToken: verifyTokenImpl,
        introspectToken: introspectTokenImpl,
        resolveResourceId(context) {
          return context.req.param('userId')!;
        },
        async loadResource({ c: context, resourceId }) {
          const tenantId = getTenantIdFromContext(context);
          const loader = options.loadProfile ?? loadProtectedCustomerProfileFromEnv;
          return loader({
            c: context,
            tenantId,
            userId: resourceId,
          });
        },
        async resolveRequiredResourceIds({ resourceId }) {
          return [resourceId];
        },
        async resolveRequiredDetailClasses() {
          return [USERINFO_CUSTOMER_PROFILE_DETAIL_CLASS];
        },
        async resolveLocalAuthorization({ decision, resourceId, resource }) {
          return {
            allowed:
              decision.context.targetSubjectId === resource.id &&
              decision.context.targetSubjectId === resourceId,
            reasonCode: 'subject_mismatch',
          };
        },
      });

    return middleware(c, next);
  });

  router.get('/:userId', (c) => {
    const context = getDownstreamGrantProtectedResourceContext<ProtectedCustomerProfileResource>(c);
    if (!context || !context.resource) {
      return c.json(
        {
          error: 'missing_context',
          error_description: 'Protected resource authorization context is unavailable.',
        },
        500
      );
    }

    const redactionLevel = getDownstreamGrantRedactionLevel({
      authorization: context.authorization,
      decision: context.decision,
      fallback: 'masked',
    });
    const profile = projectDownstreamGrantProtectedResource(
      {
        resource: context.resource,
        redactionLevel,
      },
      protectedCustomerProfileProjector
    );

    return c.json({
      profile,
      correlation_id: context.authorization.correlationId,
      redaction_level: redactionLevel satisfies ApprovalRedactionLevel,
      requires_online_check: context.authorization.requiresOnlineCheck,
      fail_closed: context.authorization.failClosed,
    });
  });

  return router;
}
