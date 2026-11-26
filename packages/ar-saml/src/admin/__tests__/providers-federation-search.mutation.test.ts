/**
 * Federation login helpers: the institution search (paging, escaping, policy filtering), the
 * servable-source lookup and the explicit-provider usage key.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import { createAdapter } from './helpers/provider-handler-harness';

const mocks = vi.hoisted(() => ({
  admin: null as ReturnType<typeof createAdapter> | null,
  core: null as ReturnType<typeof createAdapter> | null,
  dedicatedThrows: false,
}));

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    resolveAuthCorePersistenceAdapterFromEnv: vi.fn(async () => mocks.core),
    requireDedicatedAdminDatabaseAdapter: vi.fn(() => {
      if (mocks.dedicatedThrows) throw new Error('no dedicated adapter');
      return mocks.admin;
    }),
    getLogger: () => ({
      module: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    }),
  };
});

import {
  getFederationSourceForLogin,
  getIdPUsageKeyByEntityId,
  hasExternalDiscoverySource,
  searchFederationIdPs,
  type FederationLoginSource,
} from '../providers';

const env = {} as Env;

function admin() {
  if (!mocks.admin) throw new Error('admin adapter not initialised');
  return mocks.admin;
}

const policy = { mode: 'automatic', roles: ['saml_idp'], idpFieldMappingSetId: 'set-1' };

function source(overrides: Record<string, unknown> = {}): FederationLoginSource {
  return {
    id: 'src-1',
    displayName: 'Federation',
    idpSelection: { mode: 'inventory' },
    policy,
    ...overrides,
  } as unknown as FederationLoginSource;
}

function row(entityId: string, extra: Record<string, unknown> = {}) {
  return { entity_id: entityId, display_name: null, summary_json: null, ...extra };
}

const rows = (count: number, prefix = 'https://idp') =>
  Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin = createAdapter();
  mocks.core = createAdapter();
  mocks.dedicatedThrows = false;
});

describe('searchFederationIdPs query', () => {
  it('reads the source inventory without a text filter by default', async () => {
    admin().query.mockResolvedValue([]);

    const result = await searchFederationIdPs(env, 'tenant-a', source(), { limit: 10 });

    expect(result).toEqual({ items: [], truncated: false });
    const [sql, params] = admin().query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['tenant-a', 'src-1', 150, 0]);
    expect(sql).not.toContain('LIKE');
    expect(sql).toContain("e.entity_role IN ('saml_idp', 'ambiguous')");
    expect(sql).toContain('ORDER BY COALESCE(e.display_name, e.entity_id) ASC, e.entity_id ASC');
  });

  it('trims and truncates the query to 128 characters and escapes LIKE wildcards', async () => {
    admin().query.mockResolvedValue([]);

    await searchFederationIdPs(env, 'tenant-a', source(), {
      q: `  a%b_c\\d${'x'.repeat(200)}  `,
      limit: 10,
    });

    const [sql, params] = admin().query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.display_name LIKE ? ESCAPE '\\' OR e.entity_id LIKE ? ESCAPE '\\'");
    const like = String(params[2]);
    expect(like.startsWith('%a\\%b\\_c\\\\dxxx')).toBe(true);
    expect(like.endsWith('%')).toBe(true);
    expect(like.replace(/\\./g, '_')).toHaveLength(2 + 128);
    expect(params).toEqual(['tenant-a', 'src-1', like, like, 150, 0]);
  });

  it('treats a blank query as no filter', async () => {
    admin().query.mockResolvedValue([]);

    await searchFederationIdPs(env, 'tenant-a', source(), { q: '   ', limit: 10 });

    expect(admin().query).toHaveBeenCalledTimes(1);
    expect(String(admin().query.mock.calls[0]?.[0])).not.toContain('LIKE');
  });
});

describe('searchFederationIdPs results', () => {
  it('maps rows to public facts: name falls back to the entityID, only https logos survive', async () => {
    admin().query.mockResolvedValue([
      row('https://a', {
        display_name: 'Alpha',
        summary_json: JSON.stringify({ logoUrl: 'https://a/logo.png' }),
      }),
      row('https://b', { summary_json: JSON.stringify({ logoUrl: 'http://b/logo.png' }) }),
      row('https://c', { summary_json: JSON.stringify({ logoUrl: 7 }) }),
      row('https://d', { summary_json: '{not json' }),
      row('https://e', { summary_json: JSON.stringify({ logoUrl: 'HTTPS://e/logo.png' }) }),
    ]);

    const result = await searchFederationIdPs(env, 'tenant-a', source(), { limit: 10 });

    expect(result).toEqual({
      items: [
        { entityId: 'https://a', displayName: 'Alpha', logoUrl: 'https://a/logo.png' },
        { entityId: 'https://b', displayName: 'https://b', logoUrl: null },
        { entityId: 'https://c', displayName: 'https://c', logoUrl: null },
        { entityId: 'https://d', displayName: 'https://d', logoUrl: null },
        { entityId: 'https://e', displayName: 'https://e', logoUrl: 'HTTPS://e/logo.png' },
      ],
      truncated: false,
    });
  });

  it('applies the source policy: exclusions, registration authorities and entity categories', async () => {
    admin().query.mockResolvedValue([
      row('https://excluded'),
      row('https://wrong-authority', {
        summary_json: JSON.stringify({ registrationAuthority: 'https://other' }),
      }),
      row('https://denied', {
        summary_json: JSON.stringify({
          registrationAuthority: 'https://ra',
          entityCategories: ['bad', 7],
        }),
      }),
      row('https://ok', {
        summary_json: JSON.stringify({
          registrationAuthority: 'https://ra',
          entityCategories: ['good'],
        }),
      }),
    ]);
    const restricted = source({
      policy: {
        ...policy,
        excludedEntityIds: ['https://excluded'],
        registrationAuthorities: ['https://ra'],
        entityCategoryPolicy: {
          defaultDecision: 'deny',
          rules: [
            { entityCategory: 'good', decision: 'allow' },
            { entityCategory: 'bad', decision: 'deny' },
          ],
        },
      },
    });

    const result = await searchFederationIdPs(env, 'tenant-a', restricted, { limit: 10 });

    expect(result?.items.map((item) => item.entityId)).toEqual(['https://ok']);
  });

  it('stops at the limit and reports truncation only when one more allowed IdP exists', async () => {
    admin().query.mockResolvedValue(rows(3));

    const exact = await searchFederationIdPs(env, 'tenant-a', source(), { limit: 3 });
    const cut = await searchFederationIdPs(env, 'tenant-a', source(), { limit: 2 });

    expect(exact).toEqual({
      items: rows(3).map((r) => ({
        entityId: r.entity_id,
        displayName: r.entity_id,
        logoUrl: null,
      })),
      truncated: false,
    });
    expect(cut?.items).toHaveLength(2);
    expect(cut?.truncated).toBe(true);
  });

  it('keeps reading pages while a full page was returned, with advancing offsets', async () => {
    admin().query.mockResolvedValueOnce(rows(150)).mockResolvedValueOnce(rows(10, 'https://more'));

    const result = await searchFederationIdPs(env, 'tenant-a', source(), { limit: 500 });

    expect(result?.items).toHaveLength(160);
    expect(result?.truncated).toBe(false);
    expect(admin().query.mock.calls.map((call) => (call[1] as number[]).at(-1))).toEqual([0, 150]);
  });

  it('bounds the work at 1500 rows and marks the list as cut', async () => {
    admin().query.mockImplementation(async (_sql: string, params: unknown[]) =>
      rows(150, `https://p${String(params.at(-1))}`)
    );

    const result = await searchFederationIdPs(env, 'tenant-a', source(), { limit: 100000 });

    expect(admin().query).toHaveBeenCalledTimes(10);
    expect(result?.items).toHaveLength(1500);
    expect(result?.truncated).toBe(true);
  });

  it('answers null when the database or its adapter fails', async () => {
    admin().query.mockRejectedValue(new Error('db down'));
    expect(await searchFederationIdPs(env, 'tenant-a', source(), { limit: 5 })).toBeNull();

    mocks.dedicatedThrows = true;
    expect(await searchFederationIdPs(env, 'tenant-a', source(), { limit: 5 })).toBeNull();
  });
});

describe('getFederationSourceForLogin', () => {
  const payload = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      runtimeResolution: { ...policy },
      idpSelection: { mode: 'inventory' },
      ...overrides,
    });

  it('returns a servable active source with its parsed selection and policy', async () => {
    admin().queryOne.mockResolvedValue({
      display_name: 'Federation',
      protocol_payload_json: payload(),
    });

    const result = await getFederationSourceForLogin(env, 'tenant-a', 'src-1');

    expect(result).toMatchObject({ id: 'src-1', displayName: 'Federation' });
    expect(result?.policy).toMatchObject({ mode: 'automatic', roles: ['saml_idp'] });
    expect(admin().queryOne.mock.calls[0]?.[1]).toEqual(['tenant-a', 'src-1']);
  });

  it.each([
    ['no row', null],
    [
      'a payload that cannot serve IdPs',
      { display_name: 'F', protocol_payload_json: JSON.stringify({}) },
    ],
    ['a payload without a payload at all', { display_name: 'F', protocol_payload_json: null }],
    [
      'a source in manual mode',
      {
        display_name: 'F',
        protocol_payload_json: payload({ runtimeResolution: { ...policy, mode: 'manual' } }),
      },
    ],
  ])('answers null for %s', async (_label, queried) => {
    admin().queryOne.mockResolvedValue(queried);

    expect(await getFederationSourceForLogin(env, 'tenant-a', 'src-1')).toBeNull();
  });

  it('answers null when the lookup throws', async () => {
    admin().queryOne.mockRejectedValue(new Error('db down'));

    expect(await getFederationSourceForLogin(env, 'tenant-a', 'src-1')).toBeNull();
  });
});

describe('hasExternalDiscoverySource', () => {
  const sourceRow = (mode: string, runtime: Record<string, unknown> = policy) => ({
    protocol_payload_json: JSON.stringify({
      runtimeResolution: runtime,
      idpSelection: {
        mode,
        ...(mode === 'external_ds' ? { discoveryServiceUrl: 'https://ds.example.test/' } : {}),
      },
    }),
  });

  it('is true when any servable active source uses an external discovery service', async () => {
    admin().query.mockResolvedValue([sourceRow('inventory'), sourceRow('external_ds')]);

    expect(await hasExternalDiscoverySource(env, 'tenant-a')).toBe(true);
    expect(admin().query.mock.calls[0]?.[1]).toEqual(['tenant-a']);
  });

  it('is false for inventory sources, unservable external ones, no rows and errors', async () => {
    admin().query.mockResolvedValue([sourceRow('inventory')]);
    expect(await hasExternalDiscoverySource(env, 'tenant-a')).toBe(false);

    admin().query.mockResolvedValue([sourceRow('external_ds', { ...policy, mode: 'manual' })]);
    expect(await hasExternalDiscoverySource(env, 'tenant-a')).toBe(false);

    admin().query.mockResolvedValue([]);
    expect(await hasExternalDiscoverySource(env, 'tenant-a')).toBe(false);

    admin().query.mockRejectedValue(new Error('db down'));
    expect(await hasExternalDiscoverySource(env, 'tenant-a')).toBe(false);

    mocks.dedicatedThrows = true;
    expect(await hasExternalDiscoverySource(env, 'tenant-a')).toBe(false);
  });
});

describe('getIdPUsageKeyByEntityId', () => {
  const idp = (id: string, config: Record<string, unknown>) => ({
    id,
    config_json: JSON.stringify(config),
  });

  it('returns the provider id and both login ids for one approved explicit provider', async () => {
    mocks.core?.query.mockResolvedValue([
      idp('p-1', { entityId: 'https://idp' }),
      idp('p-2', { entityId: 'https://other' }),
      idp('p-3', { entityId: 'https://idp', trustApproval: { state: 'draft' } }),
    ]);

    expect(await getIdPUsageKeyByEntityId(env, 'tenant-a', 'https://idp')).toEqual({
      providerId: 'p-1',
      ids: ['saml:p-1', 'p-1'],
    });
    expect(mocks.core?.query.mock.calls[0]?.[1]).toEqual(['tenant-a']);
  });

  it('answers null without a match, with an ambiguous match, and for an empty entityID', async () => {
    mocks.core?.query.mockResolvedValue([idp('p-1', { entityId: 'https://idp' })]);
    expect(await getIdPUsageKeyByEntityId(env, 'tenant-a', 'https://none')).toBeNull();

    mocks.core?.query.mockResolvedValue([
      idp('p-1', { entityId: 'https://idp' }),
      idp('p-2', { entityId: 'https://idp' }),
    ]);
    expect(await getIdPUsageKeyByEntityId(env, 'tenant-a', 'https://idp')).toBeNull();

    expect(await getIdPUsageKeyByEntityId(env, 'tenant-a', '')).toBeNull();
    expect(mocks.core?.query).toHaveBeenCalledTimes(2);
  });
});
