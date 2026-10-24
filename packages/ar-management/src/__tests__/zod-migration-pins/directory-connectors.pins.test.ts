/**
 * zod 3 -> 4 migration pins for routes/directory-connectors.ts
 * (DirectoryConnectorsUpdateSchema / DirectoryConnectorSchema with nested `.default({...})`
 * objects, DirectoryConnectorsStoredConfigSchema read path, DirectoryPendingActionSchema,
 * DirectoryFleetActionSchema).
 *
 * The REAL `createErrorResponse` is used: schema failures return the masked
 * ADMIN_INVALID_REQUEST body, so the observable outputs are pass/fail plus the normalised
 * (defaulted) config echoed by the handlers and stored in KV.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  coreAdapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: vi.fn(async () => undefined),
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    ensureDatabaseAdapter: vi.fn(() => mocks.coreAdapter),
    bumpAuthenticationMethodsCacheRevision: vi.fn(async () => undefined),
  };
});
vi.mock('../../account-identifier-addition', () => ({
  publishAccountExternalSubjectAddition: vi.fn(async () => ({ status: 201 })),
}));

import {
  getDirectoryConnectorsHandler,
  updateDirectoryConnectorFleetInstanceHandler,
  updateDirectoryConnectorsHandler,
  updateDirectoryPendingUserHandler,
} from '../../routes/directory-connectors';

function createKV(initial: Record<string, unknown> = {}) {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(initial)) values.set(key, JSON.stringify(value));
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function context(options: { body?: unknown; settings?: Record<string, unknown> } = {}) {
  const settings = createKV(options.settings);
  return {
    req: {
      param: vi.fn((name: string) =>
        name === 'tenantId'
          ? 'tenant-a'
          : name === 'pendingId'
            ? 'pending-1'
            : name === 'instanceId'
              ? 'instance-1'
              : undefined
      ),
      query: vi.fn(),
      json: vi.fn(async () => options.body),
    },
    env: { SETTINGS: settings },
    get: vi.fn((name: string) =>
      name === 'adminAuth'
        ? {
            userId: 'admin-1',
            roles: ['system_admin'],
            globalRoles: ['system_admin'],
            permissions: ['admin:settings:read', 'admin:settings:write'],
            globalPermissions: ['admin:settings:read', 'admin:settings:write'],
            tenantScope: ['*'],
          }
        : undefined
    ),
    json: (payload: unknown, status: number = 200) => Response.json(payload, { status }),
    _settings: settings,
  };
}

async function run(handler: (c: never) => Promise<Response>, c: ReturnType<typeof context>) {
  const response = await handler(c as never);
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

const INVALID_REQUEST = {
  status: 400,
  body: {
    error: 'invalid_request',
    error_description: expect.any(String) as unknown,
    error_code: 'AR060003',
  },
};

const WWCON = 'wwcon_8K4M2Q9F7D3H6P1X';
const connector = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'campus',
  connector_id: WWCON,
  key_id: 'kid-1',
  secret_ref: 'env:WORDWARDEN_SECRET',
  endpoint_url: 'https://wordwarden.example.com',
  ...overrides,
});
const config = (
  connectors: unknown[] = [connector()],
  overrides: Record<string, unknown> = {}
) => ({
  enabled: false,
  default_connector_id: 'campus',
  auto_provision: false,
  connectors,
  ...overrides,
});

describe('zod pins: DirectoryConnectorsUpdateSchema (PUT directory connectors)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coreAdapter.query.mockResolvedValue([]);
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
  });
  const update = (body: unknown) => run(updateDirectoryConnectorsHandler, context({ body }));

  it('top level: required (no defaults on the update schema), types, non-objects', async () => {
    expect(await update(null)).toEqual(INVALID_REQUEST);
    expect(await update([])).toEqual(INVALID_REQUEST);
    expect(await update('x')).toEqual(INVALID_REQUEST);
    expect(await update({})).toEqual(INVALID_REQUEST);
    expect(await update({ enabled: false })).toEqual(INVALID_REQUEST);
    expect(await update({ ...config(), enabled: 'false' })).toEqual(INVALID_REQUEST);
    expect(await update({ ...config(), auto_provision: null })).toEqual(INVALID_REQUEST);
    expect(await update({ ...config(), default_connector_id: '' })).toEqual(INVALID_REQUEST);
    expect(await update({ ...config(), default_connector_id: 'has space' })).toEqual(
      INVALID_REQUEST
    );
    expect(await update({ ...config(), default_connector_id: 'x'.repeat(65) })).toEqual(
      INVALID_REQUEST
    );
    expect(await update({ ...config(), connectors: {} })).toEqual(INVALID_REQUEST);
    expect(await update({ ...config(), connectors: null })).toEqual(INVALID_REQUEST);
    const missingConnectors: Record<string, unknown> = config();
    delete missingConnectors.connectors;
    expect(await update(missingConnectors)).toEqual(INVALID_REQUEST);
  });

  it('connector field rules (regex / literal / enum / min / max)', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['id empty', { id: '' }],
      ['id with dot', { id: 'a.b' }],
      ['id 65 chars', { id: 'a'.repeat(65) }],
      ['id missing', { id: undefined }],
      ['transport unknown', { transport: 'tunnel' }],
      ['transport null', { transport: null }],
      ['endpoint_url too long', { endpoint_url: 'https://e.com/' + 'a'.repeat(2048) }],
      ['endpoint_url number', { endpoint_url: 5 }],
      ['endpoint_url null', { endpoint_url: null }],
      ['auth_mode not hmac', { auth_mode: 'basic' }],
      ['auth_mode null', { auth_mode: null }],
      ['connector_id wrong prefix', { connector_id: 'con_8K4M2Q9F7D3H6P1X' }],
      ['connector_id too short', { connector_id: 'wwcon_8K4M2Q9F7D3H6P1' }],
      ['connector_id too long', { connector_id: 'wwcon_8K4M2Q9F7D3H6P1XX' }],
      ['connector_id illegal char', { connector_id: 'wwcon_8K4M2Q9F7D3H6P1-' }],
      ['connector_id missing', { connector_id: undefined }],
      ['key_id empty', { key_id: '' }],
      ['key_id 129 chars', { key_id: 'k'.repeat(129) }],
      ['key_id missing', { key_id: undefined }],
      ['secret_ref other env prefix', { secret_ref: 'env:OTHER_SECRET' }],
      ['secret_ref lower case', { secret_ref: 'env:WORDWARDEN_secret' }],
      ['secret_ref plain', { secret_ref: 'plain-secret' }],
      ['secret_ref empty', { secret_ref: '' }],
      ['secret_ref managed too long', { secret_ref: `managed:${'a'.repeat(65)}` }],
      ['timeouts.request_ms below min', { timeouts: { request_ms: 99 } }],
      ['timeouts.request_ms above max', { timeouts: { request_ms: 30001 } }],
      ['timeouts.request_ms float', { timeouts: { request_ms: 100.5 } }],
      ['timeouts null', { timeouts: null }],
      ['relay.verify_timeout_ms below min', { relay: { verify_timeout_ms: 99 } }],
      ['relay.max_pending_requests 0', { relay: { max_pending_requests: 0 } }],
      ['relay.max_pending_requests 257', { relay: { max_pending_requests: 257 } }],
      ['relay.challenge_ttl_ms 4999', { relay: { challenge_ttl_ms: 4999 } }],
      ['relay.challenge_ttl_ms 300001', { relay: { challenge_ttl_ms: 300001 } }],
      [
        'relay.auth_failure_rate_limit_per_minute 101',
        { relay: { auth_failure_rate_limit_per_minute: 101 } },
      ],
      ['relay.auth_failure_block_ms 999', { relay: { auth_failure_block_ms: 999 } }],
      ['relay.secret_rotation_grace_ms -1', { relay: { secret_rotation_grace_ms: -1 } }],
      ['relay null', { relay: null }],
      ['relay string', { relay: 'x' }],
      ['heartbeat.key_id 129 chars', { heartbeat: { key_id: 'k'.repeat(129) } }],
      [
        'heartbeat.secret_ref managed (union: only env: refs or empty)',
        { heartbeat: { secret_ref: 'managed:abc' } },
      ],
      ['heartbeat.secret_ref other env', { heartbeat: { secret_ref: 'env:OTHER' } }],
      ['heartbeat.previous_secret_ref bad', { heartbeat: { previous_secret_ref: 'x' } }],
      ['heartbeat.interval_ms 29999', { heartbeat: { interval_ms: 29999 } }],
      ['heartbeat.interval_ms 86400001', { heartbeat: { interval_ms: 86400001 } }],
      ['heartbeat.stale_after_ms 59999', { heartbeat: { stale_after_ms: 59999 } }],
      ['heartbeat.stale_after_ms above 7d', { heartbeat: { stale_after_ms: 7 * 86400000 + 1 } }],
      ['heartbeat.retention_days 0', { heartbeat: { retention_days: 0 } }],
      ['heartbeat.retention_days 91', { heartbeat: { retention_days: 91 } }],
      [
        'heartbeat.version_mismatch_policy unknown',
        { heartbeat: { version_mismatch_policy: 'ignore' } },
      ],
      ['heartbeat.expected_version 65 chars', { heartbeat: { expected_version: 'v'.repeat(65) } }],
      ['heartbeat.unhealthy_threshold 0', { heartbeat: { unhealthy_threshold: 0 } }],
      ['heartbeat.unhealthy_threshold 11', { heartbeat: { unhealthy_threshold: 11 } }],
      ['heartbeat.stale_detection_grace_ms -1', { heartbeat: { stale_detection_grace_ms: -1 } }],
      ['heartbeat null', { heartbeat: null }],
      ['attribute_names not array', { attribute_names: 'mail' }],
      ['attribute_names empty entry', { attribute_names: [''] }],
      ['attribute_names 129-char entry', { attribute_names: ['a'.repeat(129)] }],
      [
        'attribute_names 33 entries',
        { attribute_names: Array.from({ length: 33 }, (_, i) => `a${i}`) },
      ],
      ['attribute_names null', { attribute_names: null }],
    ];
    for (const [name, overrides] of bad) {
      expect([name, await update(config([connector(overrides)]))]).toEqual([name, INVALID_REQUEST]);
    }
  });

  it('more than 20 connectors is rejected by the array max()', async () => {
    const many = Array.from({ length: 21 }, (_, i) =>
      connector({ id: `c${i}`, connector_id: `wwcon_${String(i).padStart(16, '0')}` })
    );
    expect(await update(config(many))).toEqual(INVALID_REQUEST);
    expect((await update(config(many.slice(0, 20)))).status).toBe(200);
  });

  it('accepts boundary values (every min/max edge) and echoes them', async () => {
    const edge = connector({
      id: 'a'.repeat(64),
      transport: 'relay',
      endpoint_url: '',
      key_id: 'k'.repeat(128),
      secret_ref: `managed:${'a'.repeat(64)}`,
      timeouts: { request_ms: 30000 },
      relay: {
        verify_timeout_ms: 30000,
        max_pending_requests: 256,
        challenge_ttl_ms: 300000,
        auth_failure_rate_limit_per_minute: 100,
        auth_failure_block_ms: 3600000,
        secret_rotation_grace_ms: 0,
      },
      heartbeat: {
        key_id: 'k'.repeat(128),
        secret_ref: 'env:AUTHRIM_WORDWARDEN_X',
        previous_secret_ref: '',
        interval_ms: 86400000,
        stale_after_ms: 7 * 86400000,
        retention_days: 90,
        version_mismatch_policy: 'block',
        expected_version: 'v'.repeat(64),
        minimum_version: '',
        unhealthy_threshold: 10,
        stale_detection_grace_ms: 86400000,
      },
      attribute_names: Array.from({ length: 32 }, (_, i) => `a${i}`),
    });
    const result = await update(config([edge], { default_connector_id: 'a'.repeat(64) }));
    expect(result.status).toBe(200);
    const echoed = (result.body.connectors as Array<Record<string, unknown>>)[0];
    expect(echoed).toMatchObject({
      id: 'a'.repeat(64),
      transport: 'relay',
      timeouts: { request_ms: 30000 },
      relay: edge.relay,
      heartbeat: edge.heartbeat,
    });
  });

  it('minimal direct connector gets every nested default (.default({...}) objects, strings, arrays)', async () => {
    const result = await update(
      config([
        {
          id: 'campus',
          connector_id: WWCON,
          key_id: 'kid-1',
          secret_ref: 'env:WORDWARDEN_SECRET',
          endpoint_url: ' https://wordwarden.example.com ',
          unknown_key: 'dropped',
        },
      ])
    );
    expect(result).toEqual({
      status: 200,
      body: {
        tenantId: 'tenant-a',
        enabled: false,
        default_connector_id: 'campus',
        auto_provision: false,
        connectors: [
          {
            id: 'campus',
            transport: 'direct',
            endpoint_url: 'https://wordwarden.example.com',
            auth_mode: 'hmac',
            connector_id: WWCON,
            key_id: 'kid-1',
            secret_ref: 'env:WORDWARDEN_SECRET',
            timeouts: { request_ms: 2500 },
            relay: {
              verify_timeout_ms: 5000,
              max_pending_requests: 16,
              challenge_ttl_ms: 30000,
              auth_failure_rate_limit_per_minute: 10,
              auth_failure_block_ms: 300000,
              secret_rotation_grace_ms: 300000,
            },
            heartbeat: {
              key_id: '',
              secret_ref: '',
              previous_key_id: '',
              previous_secret_ref: '',
              interval_ms: 300000,
              stale_after_ms: 900000,
              retention_days: 14,
              version_mismatch_policy: 'warn',
              expected_version: '',
              minimum_version: '',
              unhealthy_threshold: 1,
              stale_detection_grace_ms: 0,
            },
            attribute_names: [],
          },
        ],
      },
    });
  });

  it('relay connector without endpoint_url: optional().default("") and the stored KV document', async () => {
    const c = context({
      body: config(
        [
          {
            id: 'relay-1',
            transport: 'relay',
            connector_id: WWCON,
            key_id: 'kid-1',
            secret_ref: 'managed:relay-1',
          },
        ],
        { default_connector_id: 'relay-1' }
      ),
    });
    const result = await run(updateDirectoryConnectorsHandler, c);
    expect(result.status).toBe(200);
    expect((result.body.connectors as Array<Record<string, unknown>>)[0]).toMatchObject({
      transport: 'relay',
      endpoint_url: '',
      auth_mode: 'hmac',
    });
    const stored: unknown = JSON.parse(
      c._settings.values.get('settings:tenant:tenant-a:directory-connectors') ?? 'null'
    );
    expect(stored).toEqual({
      enabled: false,
      default_connector_id: 'relay-1',
      auto_provision: false,
      connectors: [(result.body.connectors as unknown[])[0]],
    });
  });

  it('partial nested objects are completed with per-field defaults (inner defaults still apply)', async () => {
    const result = await update(
      config([
        connector({
          timeouts: {},
          relay: { verify_timeout_ms: 200 },
          heartbeat: {
            interval_ms: 30000,
            secret_ref: 'env:WORDWARDEN_HB',
            version_mismatch_policy: 'block',
          },
          attribute_names: [' mail ', 'mail', '  ', 'cn'],
        }),
      ])
    );
    expect(result.status).toBe(200);
    const echoed = (result.body.connectors as Array<Record<string, unknown>>)[0];
    expect(echoed.timeouts).toEqual({ request_ms: 2500 });
    expect(echoed.relay).toEqual({
      verify_timeout_ms: 200,
      max_pending_requests: 16,
      challenge_ttl_ms: 30000,
      auth_failure_rate_limit_per_minute: 10,
      auth_failure_block_ms: 300000,
      secret_rotation_grace_ms: 300000,
    });
    expect(echoed.heartbeat).toEqual({
      key_id: '',
      secret_ref: 'env:WORDWARDEN_HB',
      previous_key_id: '',
      previous_secret_ref: '',
      interval_ms: 30000,
      stale_after_ms: 900000,
      retention_days: 14,
      version_mismatch_policy: 'block',
      expected_version: '',
      minimum_version: '',
      unhealthy_threshold: 1,
      stale_detection_grace_ms: 0,
    });
    // `' mail '` is a valid 6-char entry for zod (no trim), the handler trims and de-duplicates after parsing;
    // the whitespace-only entry passes min(1) and is dropped by the handler
    expect(echoed.attribute_names).toEqual(['mail', 'cn']);
  });

  it('hand-written validation after zod keeps its own body', async () => {
    expect(await update(config([], { enabled: true }))).toEqual({
      status: 400,
      body: {
        error: 'invalid_directory_connector_config',
        error_description:
          'at least one connector is required when directory password login is enabled',
      },
    });
    expect(
      await update(config([connector({ endpoint_url: 'http://insecure.example.com' })]))
    ).toEqual({
      status: 400,
      body: {
        error: 'invalid_directory_connector_config',
        error_description:
          'campus: endpoint_url must use https:// except http://localhost for local development',
      },
    });
  });
});

describe('zod pins: DirectoryConnectorsStoredConfigSchema (GET directory connectors, stored defaults)', () => {
  const key = 'settings:tenant:tenant-a:directory-connectors';
  const get = (stored?: unknown) =>
    run(
      getDirectoryConnectorsHandler,
      context({ settings: stored === undefined ? {} : { [key]: stored } })
    );
  const DEFAULTS = {
    tenantId: 'tenant-a',
    enabled: false,
    default_connector_id: 'campus',
    auto_provision: false,
    connectors: [],
  };

  it('missing / empty / invalid stored documents fall back to the default config', async () => {
    expect(await get()).toEqual({ status: 200, body: DEFAULTS });
    // `{}` is valid for the stored schema (all fields default)
    expect(await get({})).toEqual({ status: 200, body: DEFAULTS });
    // schema failure -> whole document ignored (DEFAULT_CONFIG), even when other fields are valid
    expect(await get({ enabled: true, default_connector_id: 'bad id' })).toEqual({
      status: 200,
      body: DEFAULTS,
    });
    expect(await get({ enabled: 'yes' })).toEqual({ status: 200, body: DEFAULTS });
    expect(await get([])).toEqual({ status: 200, body: DEFAULTS });
    expect(await get(null)).toEqual({ status: 200, body: DEFAULTS });
    expect(await get({ connectors: [{ id: 'x' }] })).toEqual({ status: 200, body: DEFAULTS });
  });

  it('partial stored documents are completed with defaults (top level and connector level)', async () => {
    const result = await get({
      enabled: true,
      connectors: [
        {
          id: 'campus',
          connector_id: WWCON,
          key_id: 'kid-1',
          secret_ref: 'managed:campus',
          endpoint_url: ' https://wordwarden.example.com ',
          heartbeat: { retention_days: 30 },
        },
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tenantId: 'tenant-a',
      enabled: true,
      default_connector_id: 'campus',
      auto_provision: false,
    });
    expect((result.body.connectors as Array<Record<string, unknown>>)[0]).toEqual({
      id: 'campus',
      transport: 'direct',
      endpoint_url: 'https://wordwarden.example.com',
      auth_mode: 'hmac',
      connector_id: WWCON,
      key_id: 'kid-1',
      secret_ref: 'managed:campus',
      timeouts: { request_ms: 2500 },
      relay: {
        verify_timeout_ms: 5000,
        max_pending_requests: 16,
        challenge_ttl_ms: 30000,
        auth_failure_rate_limit_per_minute: 10,
        auth_failure_block_ms: 300000,
        secret_rotation_grace_ms: 300000,
      },
      heartbeat: {
        key_id: '',
        secret_ref: '',
        previous_key_id: '',
        previous_secret_ref: '',
        interval_ms: 300000,
        stale_after_ms: 900000,
        retention_days: 30,
        version_mismatch_policy: 'warn',
        expected_version: '',
        minimum_version: '',
        unhealthy_threshold: 1,
        stale_detection_grace_ms: 0,
      },
      attribute_names: [],
    });
  });
});

describe('zod pins: DirectoryPendingActionSchema (PATCH pending user)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coreAdapter.query.mockResolvedValue([]);
    mocks.coreAdapter.queryOne.mockResolvedValue({
      id: 'pending-1',
      tenant_id: 'tenant-a',
      connector_id: 'campus',
      directory_subject: 'subject',
      login_identifier: 'user@example.com',
      status: 'pending',
      directory_facts_json: '{}',
      created_at: 1,
      updated_at: 1,
      decided_at: null,
      decided_by: null,
      decision_reason: null,
      linked_user_id: null,
    });
    mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 1, success: true });
  });
  const patch = (body: unknown) => run(updateDirectoryPendingUserHandler, context({ body }));

  it.each([
    ['null', null],
    ['array', []],
    ['empty', {}],
    ['unknown action', { action: 'delete' }],
    ['action null', { action: null }],
    ['user_id empty', { action: 'link', user_id: '' }],
    ['user_id 257 chars', { action: 'link', user_id: 'u'.repeat(257) }],
    ['user_id number', { action: 'link', user_id: 5 }],
    ['reason 1001 chars', { action: 'reject', reason: 'r'.repeat(1001) }],
    ['reason number', { action: 'reject', reason: 5 }],
  ])('rejects: %s', async (_name, body) => {
    expect(await patch(body)).toEqual(INVALID_REQUEST);
  });

  it('accepted reject: reason is trimmed by the handler, blank reason becomes NULL, unknown keys ignored', async () => {
    expect(await patch({ action: 'reject', reason: '  too risky  ', extra: 1 })).toEqual({
      status: 200,
      body: { ok: true, id: 'pending-1', status: 'rejected' },
    });
    const params = mocks.coreAdapter.execute.mock.calls[0]?.[1] as unknown[];
    expect(params[2]).toBe('admin-1');
    expect(params[3]).toBe('too risky');
    mocks.coreAdapter.execute.mockClear();
    await patch({ action: 'reject', reason: '   ' });
    expect((mocks.coreAdapter.execute.mock.calls[0]?.[1] as unknown[])[3]).toBeNull();
    mocks.coreAdapter.execute.mockClear();
    expect((await patch({ action: 'reject', reason: 'r'.repeat(1000) })).status).toBe(200);
  });
});

describe('zod pins: DirectoryFleetActionSchema (PATCH fleet instance)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.coreAdapter.query.mockResolvedValue([]);
    mocks.coreAdapter.queryOne.mockResolvedValue(null);
    mocks.coreAdapter.execute.mockResolvedValue({ rowsAffected: 0, success: true });
  });
  const patch = (body: unknown) =>
    run(updateDirectoryConnectorFleetInstanceHandler, context({ body }));

  it.each([
    ['null', null],
    ['empty', {}],
    ['unknown action', { action: 'delete', connector_id: WWCON }],
    ['connector_id missing', { action: 'deactivate' }],
    ['connector_id bad pattern', { action: 'deactivate', connector_id: 'campus' }],
    ['reason too long', { action: 'deactivate', connector_id: WWCON, reason: 'r'.repeat(1001) }],
    ['reason number', { action: 'acknowledge', connector_id: WWCON, reason: 1 }],
  ])('rejects: %s', async (_name, body) => {
    expect(await patch(body)).toEqual(INVALID_REQUEST);
  });

  it('accepted bodies pass validation and reach the instance lookup (unknown instance -> 404 body)', async () => {
    for (const action of ['acknowledge', 'deactivate', 'reactivate']) {
      expect(await patch({ action, connector_id: WWCON, reason: ' r ', extra: 1 })).toEqual({
        status: 404,
        body: { error: 'directory_connector_instance_not_found' },
      });
    }
  });
});
