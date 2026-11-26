/**
 * listFederationTrustProfiles: SQL scoping and the normalisation of every stored payload field.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

vi.mock('../../mapping-set-owner', () => ({
  resolveSAMLMappingSetOwner: vi.fn(async (_adapter: unknown, tenantId: string) => tenantId),
}));

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  require: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    requireDedicatedAdminDatabaseAdapter: mocks.require,
  };
});

import { listFederationTrustProfiles } from '../providers';

interface Row {
  id: string;
  tenant_id: string;
  source_type: string;
  display_name: string;
  lifecycle_state: string;
  protocol_payload_json: string | null;
  created_at: number;
  updated_at: number;
  trust_context_snapshot_hash: string | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'src-1',
    tenant_id: 'tenant-a',
    source_type: 'saml_federation',
    display_name: 'Federation',
    lifecycle_state: 'active',
    protocol_payload_json: JSON.stringify({ metadataUrl: 'https://md.example.test/feed.xml' }),
    created_at: 100,
    updated_at: 200,
    trust_context_snapshot_hash: null,
    ...overrides,
  };
}

const CERT = {
  id: 'cert-1',
  certificate: 'PEM',
  fingerprintSha256: 'ab:cd',
  createdAt: 5,
};

async function list(rows: Row[]) {
  mocks.query.mockResolvedValue(rows);
  return listFederationTrustProfiles({} as Env, 'tenant-a');
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.require.mockReset();
  mocks.require.mockReturnValue({ query: mocks.query });
});

describe('listFederationTrustProfiles query', () => {
  it('asks the dedicated admin database for the tenant active/draft SAML sources, sorted by name', async () => {
    await list([]);

    expect(mocks.require).toHaveBeenCalledWith({}, 'saml-federation-trust');
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['tenant-a']);
    expect(sql).toContain('WHERE source.tenant_id = ?');
    expect(sql).toContain(
      "source.source_type IN ('saml_aggregate', 'saml_metadata', 'saml_federation')"
    );
    expect(sql).toContain("source.lifecycle_state IN ('active', 'draft')");
    expect(sql).toContain('ORDER BY source.display_name ASC');
    expect(sql).toContain("current.lifecycle_state = 'active'");
  });
});

describe('listFederationTrustProfiles mapping', () => {
  it('maps a complete payload field by field', async () => {
    const polling = { enabled: true, intervalSeconds: 3600 };
    const runtimeResolution = { mode: 'on_demand' };
    const [profile] = await list([
      row({
        trust_context_snapshot_hash: 'hash-1',
        protocol_payload_json: JSON.stringify({
          description: 'InCommon',
          metadataUrl: '  https://md.example.test/feed.xml  ',
          metadataUrlPatterns: ['https://md.example.test/*', '  ', 7, 'https://other.test/*'],
          certificates: [CERT, { id: 'x' }, null, 'str'],
          policy: 'strict',
          polling,
          runtimeResolution,
        }),
      }),
    ]);

    expect(profile).toEqual({
      id: 'src-1',
      tenantId: 'tenant-a',
      name: 'Federation',
      description: 'InCommon',
      metadataUrl: 'https://md.example.test/feed.xml',
      metadataUrlPatterns: ['https://md.example.test/*', 'https://other.test/*'],
      certificates: [CERT],
      policy: 'strict',
      polling,
      runtimeResolution,
      trustContextSnapshotHash: 'hash-1',
      enabled: true,
      createdAt: 100,
      updatedAt: 200,
    });
  });

  it('falls back to the trimmed metadataUrl as the only pattern and defaults the other fields', async () => {
    const [profile] = await list([
      row({
        protocol_payload_json: JSON.stringify({ metadataUrl: ' https://md.example.test/a ' }),
      }),
    ]);

    expect(profile).toEqual({
      id: 'src-1',
      tenantId: 'tenant-a',
      name: 'Federation',
      description: '',
      metadataUrl: 'https://md.example.test/a',
      metadataUrlPatterns: ['https://md.example.test/a'],
      certificates: [],
      policy: 'warn',
      trustContextSnapshotHash: undefined,
      enabled: true,
      createdAt: 100,
      updatedAt: 200,
    });
    expect(profile?.polling).toBeUndefined();
    expect(profile?.runtimeResolution).toBeUndefined();
  });

  it('uses configured patterns without a metadataUrl', async () => {
    const [profile] = await list([
      row({ protocol_payload_json: JSON.stringify({ metadataUrlPatterns: ['https://a/*'] }) }),
    ]);

    expect(profile?.metadataUrlPatterns).toEqual(['https://a/*']);
    expect(profile?.metadataUrl).toBeUndefined();
  });

  it.each([
    ['a blank metadataUrl', { metadataUrl: '   ' }],
    ['a non-string metadataUrl', { metadataUrl: 5 }],
    ['an empty payload object', {}],
    ['non-array patterns', { metadataUrlPatterns: 'https://a/*' }],
    ['only blank patterns', { metadataUrlPatterns: ['', '  '] }],
  ])('skips a source without any usable pattern (%s)', async (_label, payload) => {
    expect(await list([row({ protocol_payload_json: JSON.stringify(payload) })])).toEqual([]);
  });

  it('skips a source without a payload', async () => {
    expect(await list([row({ protocol_payload_json: null })])).toEqual([]);
  });

  it.each([
    ['strict', 'strict'],
    ['warn', 'warn'],
    ['disabled', 'disabled'],
    ['permissive', 'warn'],
    [7, 'warn'],
  ])('normalises policy %s to %s', async (stored, expected) => {
    const [profile] = await list([
      row({
        protocol_payload_json: JSON.stringify({ metadataUrl: 'https://a', policy: stored }),
      }),
    ]);

    expect(profile?.policy).toBe(expected);
  });

  it('ignores polling and runtimeResolution values that are not plain objects', async () => {
    const [profile] = await list([
      row({
        protocol_payload_json: JSON.stringify({
          metadataUrl: 'https://a',
          polling: ['x'],
          runtimeResolution: 'on_demand',
          description: 5,
          certificates: 'none',
        }),
      }),
    ]);

    expect(profile?.description).toBe('');
    expect(profile?.certificates).toEqual([]);
    expect(profile?.polling).toBeUndefined();
    expect(profile?.runtimeResolution).toBeUndefined();
  });

  it('drops certificates missing any required typed field', async () => {
    const [profile] = await list([
      row({
        protocol_payload_json: JSON.stringify({
          metadataUrl: 'https://a',
          certificates: [
            { ...CERT, id: 1 },
            { ...CERT, certificate: null },
            { ...CERT, fingerprintSha256: undefined },
            { ...CERT, createdAt: '5' },
            CERT,
          ],
        }),
      }),
    ]);

    expect(profile?.certificates).toEqual([CERT]);
  });

  it('marks only active sources enabled, keeps order, and omits an absent snapshot hash value', async () => {
    const profiles = await list([
      row({ id: 'a', lifecycle_state: 'draft' }),
      row({ id: 'b', lifecycle_state: 'active', trust_context_snapshot_hash: 'h' }),
    ]);

    expect(profiles.map((p) => [p.id, p.enabled, p.trustContextSnapshotHash])).toEqual([
      ['a', false, undefined],
      ['b', true, 'h'],
    ]);
  });
});
