import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, IntrospectionResponse } from '@authrim/ar-lib-core';
import {
  createProtectedCustomerProfileRouter,
  createCustomerProfileDelegatedWriteOperation,
  DEFAULT_USERINFO_PROTECTED_AUDIENCE,
  type CustomerProfileUpdateInput,
  type ProtectedCustomerProfileResource,
} from '../protected-customer-profile';
import {
  completeStepUpAction,
  createStepUpOperationHash,
  DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
  issueStepUpToken,
  startStepUpAction,
  type Challenge,
  type ConsumeChallengeRequest,
  type StoreChallengeRequest,
} from '@authrim/ar-lib-core';

function createTestJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })}.${encode(payload)}.signature`;
}

function createGrantToken(input?: {
  redactionLevel?: 'summary_only' | 'masked' | 'raw';
  resourceIds?: string[];
  detailClasses?: string[];
  targetSubjectId?: string;
  audience?: string;
}) {
  return createTestJwt({
    authorization_details: [
      {
        type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
        grant_id: 'egr_public_1',
        request_id: 'apr_public_1',
        investigation_id: 'inv_123',
        request_surface: 'service_data',
        requested_action: 'detail_read',
        resource_class: 'customer_profile',
        resource_ids: input?.resourceIds ?? ['user-1'],
        detail_classes: input?.detailClasses ?? ['profile_export'],
        audience: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
        redaction_level: input?.redactionLevel ?? 'masked',
        target_subject_type: 'user',
        target_subject_id: input?.targetSubjectId ?? 'user-1',
        requester_subject_type: 'admin_user',
        requester_subject_id: 'admin-1',
        policy_preset: 'technical_debug_default',
        reuse_scope: 'request',
        partial_access_allowed: false,
      },
    ],
    authrim_elevation: {
      grant_id: 'egr_public_1',
      request_id: 'apr_public_1',
      investigation_id: 'inv_123',
      resource_class: 'customer_profile',
      redaction_level: input?.redactionLevel ?? 'masked',
      target_subject_type: 'user',
      target_subject_id: input?.targetSubjectId ?? 'user-1',
      requester_subject_type: 'admin_user',
      requester_subject_id: 'admin-1',
      target_audience: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      scope: {
        resource_class: 'customer_profile',
        resource_ids: input?.resourceIds ?? ['user-1'],
        detail_classes: input?.detailClasses ?? ['profile_export'],
        audience: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
      },
    },
    act: {
      sub: 'admin_user:admin-1',
      client_id: 'svc-client-1',
    },
    sub: input?.targetSubjectId ?? 'user-1',
    aud: input?.audience ?? DEFAULT_USERINFO_PROTECTED_AUDIENCE,
  });
}

class InMemoryChallengeStore {
  readonly challenges = new Map<string, Challenge>();

  async storeChallengeRpc(request: StoreChallengeRequest): Promise<{ success: boolean }> {
    const now = Date.now();
    this.challenges.set(request.id, {
      id: request.id,
      tenantId: request.tenantId,
      type: request.type,
      userId: request.userId,
      challenge: request.challenge,
      email: request.email,
      redirectUri: request.redirectUri,
      metadata: request.metadata,
      createdAt: now,
      expiresAt: now + request.ttl * 1000,
      consumed: false,
    });
    return { success: true };
  }

  async getChallengeRpc(id: string): Promise<Challenge | null> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      return null;
    }
    return challenge;
  }

  async consumeChallengeRpc(request: ConsumeChallengeRequest) {
    const challenge = await this.getChallengeRpc(request.id);
    if (!challenge || challenge.consumed) {
      throw new Error('Challenge not found or already consumed');
    }
    if (challenge.type !== request.type) {
      throw new Error('Challenge type mismatch');
    }
    if (challenge.tenantId !== request.tenantId) {
      throw new Error('Challenge tenant mismatch');
    }
    if (request.challenge && challenge.challenge !== request.challenge) {
      throw new Error('Challenge value mismatch');
    }
    challenge.consumed = true;
    this.challenges.set(request.id, challenge);
    return {
      challenge: challenge.challenge,
      userId: challenge.userId,
      email: challenge.email,
      redirectUri: challenge.redirectUri,
      metadata: challenge.metadata,
    };
  }
}

function createMockKV(data: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(data));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: Array.from(store.keys())
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name })),
    }),
  } as unknown as KVNamespace;
}

function createIdempotencyD1(): D1Database {
  const entries = new Map<string, Record<string, unknown>>();
  return {
    prepare: (sql: string) => {
      let params: unknown[] = [];
      const statement = {
        bind: (...bound: unknown[]) => {
          params = bound;
          return statement;
        },
        first: async () => {
          if (sql.includes('FROM idempotency_keys')) {
            const id = String(params[0]);
            const now = Number(params[1]);
            const entry = entries.get(id);
            if (entry && Number(entry.expires_at) > now) {
              return entry;
            }
          }
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.trim().startsWith('UPDATE idempotency_keys')) {
            const id = String(params[3]);
            const entry = entries.get(id);
            if (!entry) {
              return { success: true, meta: { changes: 0 } };
            }
            entries.set(id, {
              ...entry,
              response_status: params[0],
              response_body: params[1],
              expires_at: params[2],
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.trim().startsWith('INSERT INTO idempotency_keys')) {
            const id = String(params[0]);
            if (entries.has(id)) {
              throw new Error('UNIQUE constraint failed: idempotency_keys.id');
            }
            entries.set(id, {
              id: params[0],
              tenant_id: params[1],
              actor_id: params[2],
              method: params[3],
              path: params[4],
              resource_id: params[5],
              idempotency_key: params[6],
              body_hash: params[7],
              response_status: params[8],
              response_body: params[9],
              created_at: params[10],
              expires_at: params[11],
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
    batch: async () => [],
  } as unknown as D1Database;
}

function createDelegatedWriteEnv() {
  const challengeStore = new InMemoryChallengeStore();
  const env = {
    DEFAULT_TENANT_ID: 'tenant-a',
    DB: createIdempotencyD1(),
    AUTHRIM_CONFIG: createMockKV(),
    SETTINGS: createMockKV(),
    CHALLENGE_STORE: {
      idFromName: (name: string) => name,
      get: () => challengeStore,
    },
  } as unknown as Env;
  return { env, challengeStore };
}

function createApp(options?: {
  introspectionResponse?: IntrospectionResponse;
  verifyTokenImpl?: (token: string) => Promise<Record<string, unknown>>;
  delegatedActorClaims?: Record<string, unknown>;
  updateProfileImpl?: (input: {
    subjectUserId: string;
    update: CustomerProfileUpdateInput;
  }) => Promise<ProtectedCustomerProfileResource | null>;
  profileOverrides?: Partial<ProtectedCustomerProfileResource>;
  validateDelegatedWriteActorImpl?: () => Promise<
    { actorId: string; claims: Record<string, unknown> } | Response
  >;
}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as any).set('tenantId', 'tenant-a');
    return next();
  });
  const sampleProfile = {
    id: 'user-1',
    tenantId: 'tenant-a',
    name: 'Alice Example',
    familyName: 'Example',
    givenName: 'Alice',
    middleName: null,
    nickname: 'Ali',
    preferredUsername: 'alice',
    picture: null,
    locale: 'en-US',
    zoneinfo: 'Asia/Tokyo',
    profile: 'https://example.com/alice',
    website: null,
    birthdate: '2000-01-01',
    gender: 'female',
    email: 'alice@example.com',
    emailVerified: true,
    phoneNumber: '+819012345678',
    phoneNumberVerified: true,
    address: {
      formatted: '1 Example Street',
      street_address: '1 Example Street',
      locality: 'Tokyo',
      region: 'Tokyo',
      postal_code: '100-0001',
      country: 'JP',
    },
    updatedAt: 1700000000,
    ...options?.profileOverrides,
  };

  app.route(
    '/api/protected/customer-profiles',
    createProtectedCustomerProfileRouter({
      verifyToken: async ({ token }) => {
        if (options?.verifyTokenImpl) {
          return options.verifyTokenImpl(token);
        }
        const [, payload] = token.split('.');
        return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
          string,
          unknown
        >;
      },
      introspectToken: options?.introspectionResponse
        ? async () => options.introspectionResponse as IntrospectionResponse
        : undefined,
      async loadProfile({ userId }) {
        if (userId !== 'user-1') {
          return null;
        }
        return sampleProfile;
      },
      validateDelegatedWriteActor: async () =>
        options?.validateDelegatedWriteActorImpl
          ? options.validateDelegatedWriteActorImpl()
          : {
              actorId:
                typeof options?.delegatedActorClaims?.sub === 'string'
                  ? options.delegatedActorClaims.sub
                  : 'actor-1',
              claims: options?.delegatedActorClaims ?? { sub: 'actor-1' },
            },
      async updateProfile({ subjectUserId, update }) {
        if (options?.updateProfileImpl) {
          return options.updateProfileImpl({ subjectUserId, update });
        }
        if (subjectUserId !== 'user-1') {
          return null;
        }
        return {
          ...sampleProfile,
          name: typeof update.name === 'string' ? update.name : sampleProfile.name,
          locale: typeof update.locale === 'string' ? update.locale : sampleProfile.locale,
          updatedAt: 1700000100,
        };
      },
    })
  );

  return app;
}

const sampleProfileForTest = {
  id: 'user-1',
  tenantId: 'tenant-a',
  name: 'Alice Example',
  familyName: 'Example',
  givenName: 'Alice',
  middleName: null,
  nickname: 'Ali',
  preferredUsername: 'alice',
  picture: null,
  locale: 'en-US',
  zoneinfo: 'Asia/Tokyo',
  profile: 'https://example.com/alice',
  website: null,
  birthdate: '2000-01-01',
  gender: 'female',
  email: 'alice@example.com',
  emailVerified: true,
  phoneNumber: '+819012345678',
  phoneNumberVerified: true,
  address: {
    formatted: '1 Example Street',
    street_address: '1 Example Street',
    locality: 'Tokyo',
    region: 'Tokyo',
    postal_code: '100-0001',
    country: 'JP',
  },
  updatedAt: 1700000000,
};

async function issueDelegatedWriteReceipt(input: {
  env: Env;
  subjectUserId: string;
  idempotencyKey: string;
  bodyInput: Record<string, unknown>;
  audit?: Record<string, unknown>;
}): Promise<string> {
  const operationHash = await createStepUpOperationHash(
    createCustomerProfileDelegatedWriteOperation({
      subjectUserId: input.subjectUserId,
      input: input.bodyInput,
      audit: input.audit,
    })
  );
  const requirement = await issueStepUpToken(input.env, {
    tenantId: 'tenant-a',
    actorId: 'actor-1',
    subjectId: input.subjectUserId,
    operationHash,
    idempotencyKey: input.idempotencyKey,
    acceptableMethods: { methods: ['portal_confirm'] },
  });
  const action = await startStepUpAction(input.env, {
    stepUpToken: requirement.step_up_token,
    tenantId: 'tenant-a',
  });
  const completed = await completeStepUpAction(input.env, {
    actionId: action.action_id,
    tenantId: 'tenant-a',
    method: 'portal_confirm',
    input: { confirmed: true },
  });
  if (!completed.step_up_receipt) {
    throw new Error('expected receipt');
  }
  return completed.step_up_receipt;
}

describe('protected customer profile route', () => {
  it('returns a masked customer profile for low-risk access', async () => {
    const app = createApp();
    const token = createGrantToken({ redactionLevel: 'masked' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redaction_level: 'masked',
      profile: {
        sub: 'user-1',
        email: 'al***@example.com',
        phone_number: '*********5678',
        address: {
          locality: 'Tokyo',
          region: 'Tokyo',
          country: 'JP',
        },
      },
    });
  });

  it('returns a summary profile when summary_only is granted', async () => {
    const app = createApp();
    const token = createGrantToken({ redactionLevel: 'summary_only' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      profile: {
        sub: 'user-1',
        tenant_id: 'tenant-a',
        email_verified: true,
        phone_number_verified: true,
        updated_at: 1700000000,
      },
      correlation_id: 'inv_123',
      redaction_level: 'summary_only',
      requires_online_check: false,
      fail_closed: false,
    });
  });

  it('fails closed for raw access when online introspection is unavailable', async () => {
    const app = createApp();
    const token = createGrantToken({ redactionLevel: 'raw' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      reason_code: 'grant_online_check_required',
      requires_online_check: true,
      fail_closed: true,
    });
  });

  it('returns the raw customer profile after a successful online check', async () => {
    const token = createGrantToken({ redactionLevel: 'raw' });
    const app = createApp({
      introspectionResponse: {
        active: true,
        authorization_details: [
          {
            type: DOWNSTREAM_GRANT_AUTHORIZATION_DETAIL_TYPE,
            grant_id: 'egr_public_1',
            request_id: 'apr_public_1',
            investigation_id: 'inv_123',
            request_surface: 'service_data',
            requested_action: 'detail_read',
            resource_class: 'customer_profile',
            resource_ids: ['user-1'],
            detail_classes: ['profile_export'],
            audience: DEFAULT_USERINFO_PROTECTED_AUDIENCE,
            redaction_level: 'raw',
            target_subject_type: 'user',
            target_subject_id: 'user-1',
            requester_subject_type: 'admin_user',
            requester_subject_id: 'admin-1',
            policy_preset: 'technical_debug_default',
            reuse_scope: 'request',
            partial_access_allowed: false,
          },
        ],
        act: {
          sub: 'admin_user:admin-1',
          client_id: 'svc-client-1',
        },
      } as IntrospectionResponse,
    });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      redaction_level: 'raw',
      requires_online_check: true,
      fail_closed: true,
      profile: {
        sub: 'user-1',
        email: 'alice@example.com',
        phone_number: '+819012345678',
        address: {
          locality: 'Tokyo',
          street_address: '1 Example Street',
        },
      },
    });
  });

  it('denies when the target subject does not match the loaded profile', async () => {
    const app = createApp();
    const token = createGrantToken({ targetSubjectId: 'user-999' });

    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      reason_code: 'subject_mismatch',
    });
  });

  it('rejects delegated writes without input before consuming Step-Up', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp().request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-1',
        },
        body: JSON.stringify({
          audit: { reason_code: 'admin_repair' },
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Delegated write body must include input',
    });
  });

  it('rejects delegated writes that put the Step-Up receipt in the body', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp().request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-2',
        },
        body: JSON.stringify({
          input: { name: 'Alice Updated' },
          step_up_receipt: 'sur_body',
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'step_up_receipt must be sent with the Authrim-Step-Up-Receipt header',
    });
  });

  it('rejects delegated writes with unknown audit fields before Step-Up', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp().request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-unknown-audit',
        },
        body: JSON.stringify({
          input: { name: 'Alice Updated' },
          audit: {
            reason_code: 'admin_repair',
            unexpected: 'not-supported',
          },
        }),
      },
      env
    );
    const payload = (await response.json()) as {
      error?: string;
      error_details?: {
        code?: string;
        field?: string;
        severity?: string;
        retryable?: boolean;
      };
    };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('unknown_audit_field');
    expect(payload.error_details).toMatchObject({
      code: 'unknown_audit_field',
      field: 'audit.unexpected',
      severity: 'error',
      retryable: false,
    });
  });

  it('rejects delegated writes with unknown input fields before Step-Up', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp().request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-unknown-input',
        },
        body: JSON.stringify({
          input: {
            name: 'Alice Updated',
            role: 'admin',
          },
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Unknown input field: role',
      field: 'input.role',
    });
  });

  it('rejects delegated writes with unknown address fields before Step-Up', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp().request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-unknown-address',
        },
        body: JSON.stringify({
          input: {
            address: {
              locality: 'Tokyo',
              room_number: '101',
            },
          },
        }),
      },
      env
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Unknown input.address field: room_number',
      field: 'input.address.room_number',
    });
  });

  it('returns a Step-Up requirement when delegated write receipt is missing', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp().request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-3',
        },
        body: JSON.stringify({
          input: { name: 'Alice Updated' },
        }),
      },
      env
    );
    const payload = (await response.json()) as {
      error: string;
      error_details?: { code?: string };
      step_up?: { step_up_token?: string };
    };

    expect(response.status).toBe(403);
    expect(payload.error).toBe('step_up_required');
    expect(payload.error_details?.code).toBe('step_up_required');
    expect(payload.step_up?.step_up_token).toMatch(/^stu_/);
  });

  it('accepts a valid Step-Up receipt once and returns delegated include fields', async () => {
    const { env } = createDelegatedWriteEnv();
    const input = { name: 'Alice Updated', locale: 'ja-JP' };
    const audit = { reason_code: 'admin_repair', reference_id: 'CASE-123' };
    const receipt = await issueDelegatedWriteReceipt({
      env,
      subjectUserId: 'user-1',
      idempotencyKey: 'delegated-key-4',
      bodyInput: input,
      audit,
    });
    const app = createApp();

    const response = await app.request(
      'http://localhost/api/protected/customer-profiles/users/user-1?include=actor,subject,audit',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-4',
          'Authrim-Step-Up-Receipt': receipt,
        },
        body: JSON.stringify({ input, audit }),
      },
      env
    );
    const payload = (await response.json()) as {
      customer_profile?: { sub?: string; name?: string; locale?: string };
      actor?: { id?: string };
      subject?: { id?: string };
      audit?: { reason_code?: string; reference_id?: string };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(payload.customer_profile).toMatchObject({
      sub: 'user-1',
      name: 'Alice Updated',
      locale: 'ja-JP',
    });
    expect(payload.actor).toEqual({ id: 'actor-1' });
    expect(payload.subject).toEqual({ id: 'user-1' });
    expect(payload.audit).toEqual(audit);

    const replay = await app.request(
      'http://localhost/api/protected/customer-profiles/users/user-1?include=actor,subject,audit',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-4',
          'Authrim-Step-Up-Receipt': receipt,
        },
        body: JSON.stringify({ input, audit }),
      },
      env
    );
    await expect(replay.json()).resolves.toEqual(payload);

    const secondUse = await app.request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-5',
          'Authrim-Step-Up-Receipt': receipt,
        },
        body: JSON.stringify({ input }),
      },
      env
    );
    expect(secondUse.status).toBe(403);
    await expect(secondUse.json()).resolves.toMatchObject({
      error: 'step_up_required',
    });
  });

  it('normalizes nullable delegated write fields before updating PII', async () => {
    const { env } = createDelegatedWriteEnv();
    const input = {
      email: 'alice+updated@example.com',
      nickname: null,
      address: null,
    };
    const receipt = await issueDelegatedWriteReceipt({
      env,
      subjectUserId: 'user-1',
      idempotencyKey: 'delegated-key-nullable-update',
      bodyInput: input,
    });
    let capturedUpdate: CustomerProfileUpdateInput | undefined;
    const app = createApp({
      updateProfileImpl: async ({ update }) => {
        capturedUpdate = update;
        return {
          ...sampleProfileForTest,
          email: update.email ?? sampleProfileForTest.email,
          nickname: update.nickname ?? sampleProfileForTest.nickname,
          address: null,
          updatedAt: 1700000200,
        };
      },
    });

    const response = await app.request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-nullable-update',
          'Authrim-Step-Up-Receipt': receipt,
        },
        body: JSON.stringify({ input }),
      },
      env
    );

    expect(response.status).toBe(200);
    expect(capturedUpdate).toMatchObject({
      email: 'alice+updated@example.com',
      nickname: null,
      address_formatted: null,
      address_street_address: null,
      address_locality: null,
      address_region: null,
      address_postal_code: null,
      address_country: null,
    });
    await expect(response.json()).resolves.toMatchObject({
      customer_profile: {
        sub: 'user-1',
        email: 'alice+updated@example.com',
        address: null,
      },
    });
  });

  it('rejects product-specific elevation tokens as standard delegated write credentials', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp({
      delegatedActorClaims: {
        sub: 'user-1',
        authrim_elevation: { resource_class: 'customer_profile' },
      },
    }).request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer elevation-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'delegated-key-6',
        },
        body: JSON.stringify({ input: { name: 'Alice Updated' } }),
      },
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'access_denied',
      error_description:
        'Product-specific downstream elevation grant tokens are not accepted for standard delegated write.',
    });
  });

  it('masks malformed, short, and absent PII without leaking profile structure', async () => {
    const app = createApp({
      profileOverrides: {
        name: '',
        givenName: 'A',
        familyName: null,
        preferredUsername: null,
        email: 'not-an-email',
        phoneNumber: '1234',
        address: null,
      },
    });
    const response = await app.request('http://localhost/api/protected/customer-profiles/user-1', {
      headers: { Authorization: `Bearer ${createGrantToken()}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      profile: {
        name: null,
        given_name: '*',
        family_name: null,
        preferred_username: null,
        email: '***',
        phone_number: '****',
        address: null,
      },
    });
  });

  it.each([
    ['non-object input', null, 'input must be an object', 'input'],
    ['array input', [], 'input must be an object', 'input'],
    ['empty input', {}, 'input must include at least one profile field', 'input'],
    ['null email', { email: null }, 'input.email must be a non-empty string', 'input.email'],
    ['blank email', { email: '   ' }, 'input.email must be a non-empty string', 'input.email'],
    [
      'non-string profile field',
      { phone_number: 123 },
      'input.phone_number must be a string or null',
      'input.phone_number',
    ],
    [
      'non-object address',
      { address: 'Tokyo' },
      'input.address must be an object or null',
      'input.address',
    ],
    [
      'non-string address field',
      { address: { locality: 123 } },
      'input.locality must be a string or null',
      'input.locality',
    ],
  ])('rejects %s before issuing Step-Up', async (_label, input, message, field) => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp().request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': `invalid-${String(_label).replaceAll(' ', '-')}`,
        },
        body: JSON.stringify({ input }),
      },
      env
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: message,
      field,
    });
  });

  it('normalizes every supported delegated profile field and address member', async () => {
    const { env } = createDelegatedWriteEnv();
    const input = {
      email: 'new@example.com',
      phone_number: '+819011112222',
      name: 'New Name',
      given_name: 'New',
      family_name: 'Name',
      middle_name: 'Middle',
      nickname: 'NN',
      preferred_username: 'new-user',
      picture: 'https://example.com/picture.png',
      website: 'https://example.com',
      gender: 'unspecified',
      birthdate: '2001-02-03',
      locale: 'ja-JP',
      zoneinfo: 'Asia/Tokyo',
      address: {
        formatted: '1 Test Street',
        street_address: '1 Test Street',
        locality: 'Tokyo',
        region: 'Tokyo',
        postal_code: '100-0001',
        country: 'JP',
      },
    };
    const receipt = await issueDelegatedWriteReceipt({
      env,
      subjectUserId: 'user-1',
      idempotencyKey: 'all-fields',
      bodyInput: input,
    });
    let captured: CustomerProfileUpdateInput | undefined;
    const response = await createApp({
      updateProfileImpl: async ({ update }) => {
        captured = update;
        return sampleProfileForTest;
      },
    }).request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'all-fields',
          'Authrim-Step-Up-Receipt': receipt,
        },
        body: JSON.stringify({ input }),
      },
      env
    );

    expect(response.status).toBe(200);
    const { address, ...directFields } = input;
    expect(captured).toEqual({
      ...directFields,
      address_formatted: input.address.formatted,
      address_street_address: input.address.street_address,
      address_locality: input.address.locality,
      address_region: input.address.region,
      address_postal_code: input.address.postal_code,
      address_country: address.country,
    });
  });

  it('returns not_found without exposing whether a delegated subject exists', async () => {
    const { env } = createDelegatedWriteEnv();
    const input = { name: 'Updated' };
    const receipt = await issueDelegatedWriteReceipt({
      env,
      subjectUserId: 'user-404',
      idempotencyKey: 'missing-profile',
      bodyInput: input,
    });
    const response = await createApp({ updateProfileImpl: async () => null }).request(
      'http://localhost/api/protected/customer-profiles/users/user-404',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer actor-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'missing-profile',
          'Authrim-Step-Up-Receipt': receipt,
        },
        body: JSON.stringify({ input }),
      },
      env
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'not_found' });
  });

  it('propagates delegated actor authentication failures before Step-Up', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp({
      validateDelegatedWriteActorImpl: async () =>
        new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 }),
    }).request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer invalid',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'invalid-actor',
        },
        body: JSON.stringify({ input: { name: 'Updated' } }),
      },
      env
    );
    expect(response.status).toBe(401);
  });

  it('rejects token_use elevation credentials as delegated actor tokens', async () => {
    const { env } = createDelegatedWriteEnv();
    const response = await createApp({
      delegatedActorClaims: { sub: 'actor-1', token_use: 'elevation_grant_subject' },
    }).request(
      'http://localhost/api/protected/customer-profiles/users/user-1',
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer elevation-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'token-use-elevation',
        },
        body: JSON.stringify({ input: { name: 'Updated' } }),
      },
      env
    );
    expect(response.status).toBe(403);
  });
});
