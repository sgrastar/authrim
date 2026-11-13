/**
 * Saving the directory connector settings while the platform has `directory_connectors` off: a
 * tenant administrator may only take connectors away or switch directory sign-in off (nothing new
 * for the platform to call), an unreadable switch refuses every save, and a caller with global
 * platform authority is not affected. The settings API has no such category, so the connector
 * route is the only writer besides a tenant backup restore.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CATEGORY_META } from '@authrim/ar-lib-core';
import {
  onlyReducesDirectoryConnectors,
  updateDirectoryConnectorsHandler,
} from '../routes/directory-connectors';
import { SETTINGS_CATEGORY_CAPABILITY } from '../capability-authorization';

const mocks = vi.hoisted(() => ({
  createAuditLogFromContext: vi.fn(),
  coreAdapter: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuditLogFromContext: mocks.createAuditLogFromContext,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    ensureDatabaseAdapter: vi.fn(() => mocks.coreAdapter),
  };
});

const CAPABILITIES_KEY = 'settings:platform:tenant-capabilities';
const CONFIG_KEY = 'settings:tenant:tenant-a:directory-connectors';

const connector = (overrides: Record<string, unknown> = {}) => ({
  id: 'campus',
  transport: 'direct',
  endpoint_url: 'https://wordwarden.example.com',
  auth_mode: 'hmac',
  connector_id: 'wwcon_8K4M2Q9F7D3H6P1X',
  key_id: 'kid-active',
  secret_ref: 'env:WORDWARDEN_SECRET',
  ...overrides,
});
const second = connector({
  id: 'library',
  endpoint_url: 'https://library.example.com',
  connector_id: 'wwcon_1A2B3C4D5E6F7G8H',
});
const config = (overrides: Record<string, unknown> = {}) => ({
  enabled: false,
  default_connector_id: 'campus',
  auto_provision: false,
  connectors: [connector()],
  ...overrides,
});

type Switch = boolean | 'down' | undefined;

const TENANT_ADMIN = {
  userId: 'admin-1',
  roles: ['ar_tenant_admin'],
  permissions: ['admin:*'],
  tenantScope: ['tenant-a'],
};
const PLATFORM_ADMIN = {
  userId: 'admin-2',
  roles: ['ar_super_admin'],
  globalRoles: ['ar_super_admin'],
  permissions: ['admin:*'],
  globalPermissions: ['admin:*'],
  tenantScope: ['*'],
};

function context(options: {
  persona: Record<string, unknown>;
  switch: Switch;
  stored?: unknown;
  body: unknown;
}) {
  const values = new Map<string, string>();
  if (options.stored !== undefined) values.set(CONFIG_KEY, JSON.stringify(options.stored));
  if (typeof options.switch === 'boolean') {
    values.set(
      CAPABILITIES_KEY,
      JSON.stringify({ 'tenant_capabilities.directory_connectors': options.switch })
    );
  }
  const settings = {
    get: vi.fn(async (key: string) => {
      if (options.switch === 'down' && key === CAPABILITIES_KEY) throw new Error('kv down');
      return values.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  return {
    settings,
    values,
    c: {
      req: {
        param: vi.fn((name: string) => (name === 'tenantId' ? 'tenant-a' : undefined)),
        query: vi.fn(),
        json: vi.fn(async () => options.body),
      },
      env: { SETTINGS: settings },
      get: vi.fn((name: string) => (name === 'adminAuth' ? options.persona : undefined)),
      json: (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
        Response.json(payload, { status, headers }),
    } as never,
  };
}

async function save(options: Parameters<typeof context>[0]) {
  const ctx = context(options);
  const response = await updateDirectoryConnectorsHandler(ctx.c);
  return { response, ...ctx };
}

const wasWritten = (settings: { put: ReturnType<typeof vi.fn> }) =>
  settings.put.mock.calls.some(([key]) => key === CONFIG_KEY);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAuditLogFromContext.mockResolvedValue(undefined);
});

describe('saving directory connector settings while directory_connectors is off', () => {
  it('refuses a tenant admin a new connector with 403 capability_disabled and writes nothing', async () => {
    const { response, settings } = await save({
      persona: TENANT_ADMIN,
      switch: false,
      stored: config(),
      body: config({ connectors: [connector(), second] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'capability_disabled',
      capability: 'directory_connectors',
    });
    expect(wasWritten(settings)).toBe(false);
  });

  it('refuses a tenant admin a first connector when none is stored', async () => {
    const { response, settings } = await save({
      persona: TENANT_ADMIN,
      switch: false,
      body: config(),
    });
    expect(response.status).toBe(403);
    expect(wasWritten(settings)).toBe(false);
  });

  it.each([
    ['another endpoint', { endpoint_url: 'https://elsewhere.example.com' }],
    ['another key', { key_id: 'kid-other' }],
    ['another secret', { secret_ref: 'env:WORDWARDEN_OTHER' }],
    ['another transport', { transport: 'relay', endpoint_url: '' }],
    ['another timeout', { timeouts: { request_ms: 9000 } }],
  ])('refuses a tenant admin a kept connector with %s', async (_name, change) => {
    const { response, settings } = await save({
      persona: TENANT_ADMIN,
      switch: false,
      stored: config(),
      body: config({ connectors: [connector(change)] }),
    });
    expect(response.status).toBe(403);
    expect(wasWritten(settings)).toBe(false);
  });

  it('refuses a tenant admin switching directory sign-in on, or automatic provisioning on', async () => {
    for (const change of [{ enabled: true }, { auto_provision: true }]) {
      const { response, settings } = await save({
        persona: TENANT_ADMIN,
        switch: false,
        stored: config(),
        body: config(change),
      });
      expect(response.status, JSON.stringify(change)).toBe(403);
      expect(wasWritten(settings)).toBe(false);
    }
  });

  it('answers 503 with Retry-After when the switch cannot be read, for every save', async () => {
    for (const body of [
      config({ connectors: [] }),
      config({ connectors: [connector(), second] }),
    ]) {
      const { response, settings } = await save({
        persona: TENANT_ADMIN,
        switch: 'down',
        stored: config(),
        body,
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBeTruthy();
      expect(await response.json()).toMatchObject({
        error: 'temporarily_unavailable',
        capability: 'directory_connectors',
      });
      expect(wasWritten(settings)).toBe(false);
    }
  });

  it('lets a tenant admin remove connectors', async () => {
    const stored = config({ connectors: [connector(), second] });
    const { response, values } = await save({
      persona: TENANT_ADMIN,
      switch: false,
      stored,
      body: config({ connectors: [second], default_connector_id: 'library' }),
    });
    expect(response.status).toBe(200);
    expect(
      (JSON.parse(values.get(CONFIG_KEY)!) as { connectors: { id: string }[] }).connectors.map(
        (entry) => entry.id
      )
    ).toEqual(['library']);
  });

  it('lets a tenant admin switch directory sign-in and automatic provisioning off, keeping the connector', async () => {
    const { response, values } = await save({
      persona: TENANT_ADMIN,
      switch: false,
      stored: config({ enabled: true, auto_provision: true }),
      body: config({ enabled: false, auto_provision: false }),
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(values.get(CONFIG_KEY)!)).toMatchObject({ enabled: false });
  });

  it('allows a save that changes nothing about the connectors', async () => {
    const { response } = await save({
      persona: TENANT_ADMIN,
      switch: false,
      stored: config(),
      body: config({ default_connector_id: 'campus' }),
    });
    expect(response.status).toBe(200);
  });

  it('allows every save while on, and for a caller with global platform authority while off', async () => {
    const add = config({ connectors: [connector(), second] });
    const tenantOn = await save({
      persona: TENANT_ADMIN,
      switch: true,
      stored: config(),
      body: add,
    });
    expect(tenantOn.response.status).toBe(200);
    expect(wasWritten(tenantOn.settings)).toBe(true);
    const tenantDefault = await save({
      persona: TENANT_ADMIN,
      switch: undefined,
      stored: config(),
      body: add,
    });
    expect(tenantDefault.response.status).toBe(200);
    const platformOff = await save({
      persona: PLATFORM_ADMIN,
      switch: false,
      stored: config(),
      body: add,
    });
    expect(platformOff.response.status).toBe(200);
    expect(wasWritten(platformOff.settings)).toBe(true);
    const platformDown = await save({
      persona: PLATFORM_ADMIN,
      switch: 'down',
      stored: config(),
      body: add,
    });
    expect(platformDown.response.status).toBe(200);
  });

  it('does not decide for a caller the tenant access check refuses', async () => {
    const { response, settings } = await save({
      persona: { ...TENANT_ADMIN, tenantScope: ['tenant-b'] },
      switch: false,
      stored: config(),
      body: config({ connectors: [] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).not.toMatchObject({ error: 'capability_disabled' });
    expect(wasWritten(settings)).toBe(false);
  });
});

describe('onlyReducesDirectoryConnectors', () => {
  const stored = {
    enabled: true,
    default_connector_id: 'campus',
    auto_provision: true,
    connectors: [{ id: 'campus', endpoint_url: 'https://a.example' }],
  } as never;
  const next = (change: Record<string, unknown>) => ({ ...(stored as object), ...change }) as never;

  it('accepts the same, fewer, or switched-off', () => {
    expect(onlyReducesDirectoryConnectors(stored, stored)).toBe(true);
    expect(onlyReducesDirectoryConnectors(stored, next({ connectors: [] }))).toBe(true);
    expect(
      onlyReducesDirectoryConnectors(stored, next({ enabled: false, auto_provision: false }))
    ).toBe(true);
  });

  it('refuses a new or changed connector and switching on', () => {
    expect(
      onlyReducesDirectoryConnectors(
        stored,
        next({ connectors: [{ id: 'campus', endpoint_url: 'https://b.example' }] })
      )
    ).toBe(false);
    expect(
      onlyReducesDirectoryConnectors(
        stored,
        next({
          connectors: [
            { id: 'campus', endpoint_url: 'https://a.example' },
            { id: 'x', endpoint_url: 'https://a.example' },
          ],
        })
      )
    ).toBe(false);
    const off = { ...(stored as object), enabled: false, auto_provision: false } as never;
    expect(onlyReducesDirectoryConnectors(off, next({}))).toBe(false);
    expect(onlyReducesDirectoryConnectors(off, next({ enabled: false }))).toBe(false);
  });
});

describe('the settings document of the directory connectors', () => {
  it('belongs to the directory_connectors capability, so a restore is held to it', () => {
    expect(SETTINGS_CATEGORY_CAPABILITY['directory-connectors']).toBe('directory_connectors');
  });

  it('is not a category the generic settings API writes (it answers 404 for it)', () => {
    expect((ALL_CATEGORY_META as Record<string, unknown>)['directory-connectors']).toBeUndefined();
  });
});
