import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { applyOIDCIdentityMapping } from '../oidc-identity-mapping';
import { resetSwallowedIdentityMappingFailureThrottle } from '../identity-mapping-swallowed-failure';

/**
 * CURRENT BEHAVIOR, documented as it is (field mapping tiers, stage 0). It is not the intended
 * behavior: stage 2 of docs/design "field mapping tiers" reverses these assertions.
 *
 * An app whose `identity_mapping` is NULL names no Mapping Set, yet a Mapping Set activated for
 * the whole tenant (`{ kind: 'tenant' }`: no protocol, no role, no client) applies to it. The
 * resolver ranks an activation by the scope fields that are present and keeps one whose scope
 * has none at score 0, so the activation matches every OIDC call. If its Destination Profile
 * lists the standard claims as optional, or only for UserInfo, the ID token loses name, email,
 * phone and address although the app never chose that mapping. The real resolver, mapping
 * runtime and Destination Profile release filter run here; only the databases are fakes.
 *
 * The 2026-10-10 environment had exactly this shape.
 */

type Row = Record<string, unknown>;

const STANDARD_CLAIMS = [
  ['name', 'profile'],
  ['email', 'email'],
  ['email_verified', 'email'],
  ['phone_number', 'phone'],
  ['phone_number_verified', 'phone'],
  ['address', 'address'],
] as const;

const fixture = {
  activations: [] as Row[],
  profileType: 'oidc' as 'oidc' | 'saml',
  /** The profile's claims; by default the standard claims, all optional, for UserInfo only. */
  claims: undefined as Array<Record<string, unknown>> | undefined,
  /** Whether the user already agreed to release the profile's fields. */
  selection: 'none' as 'none' | 'all',
  lookups: [] as string[],
};

function oidcProfileClaims() {
  return (
    fixture.claims ?? [
      { claimName: 'sub', required: true, surfaces: ['id_token', 'userinfo'] },
      ...STANDARD_CLAIMS.map(([claimName, scope]) => ({
        claimName,
        surfaces: ['userinfo'],
        requiredScopes: [scope],
        classification: 'pii',
      })),
    ]
  );
}

function activation(scope: Record<string, unknown>): Row {
  return {
    activation_id: 'activation-1',
    tenant_id: 'tenant-a',
    field_mapping_set_id: 'set-1',
    field_mapping_version_id: 'version-1',
    activation_scope_json: JSON.stringify(scope),
    version_label: 'v1',
    field_mapping_hash: 'hash-1',
    field_mapping_compatibility_range: '^0.3.0',
    catalog_version_id: 'catalog-1',
    snapshot_hash: 'snapshot-1',
    catalog_version_label: 'c1',
    catalog_bundle_hash: 'catalog-hash',
    catalog_compatibility_range: '^0.3.0',
  };
}

/** One database standing for both the Admin and the tenant database; it answers by statement. */
function database(): DatabaseAdapter {
  const answer = async (sql: string): Promise<Row[]> => {
    fixture.lookups.push(sql);
    if (sql.includes('FROM field_mapping_activations')) return fixture.activations;
    if (sql.includes('FROM field_catalog_entries')) {
      return [
        {
          id: 'entry-source-email',
          stable_field_id: 'field.profile.email',
          namespace: 'authrim.profile',
          path: 'email',
          target_taxonomy: 'canonical',
          value_type: 'string',
          cardinality: 'single',
          classification: 'pii',
          aliases_json: null,
          validation_json: '{}',
        },
        {
          id: 'entry-claim-email',
          stable_field_id: 'field.oidc.email',
          namespace: 'oidc.claim',
          path: 'email',
          target_taxonomy: 'destination',
          value_type: 'string',
          cardinality: 'single',
          classification: 'pii',
          aliases_json: null,
          validation_json: '{}',
        },
      ];
    }
    if (sql.includes('JOIN mapping_rule_edges')) {
      return [
        {
          id: 'edge-email',
          source_ref_json: JSON.stringify({
            side: 'source',
            namespace: 'authrim.profile',
            path: 'email',
            catalogEntryId: 'field.profile.email',
          }),
          target_ref_json: JSON.stringify({
            side: 'destination',
            profileId: 'profile-1',
            namespace: 'oidc.claim',
            path: 'email',
            catalogEntryId: 'field.oidc.email',
          }),
          edge_kind: 'direct',
          display_order: 0,
        },
      ];
    }
    return [];
  };
  const adapter = {
    query: answer,
    async queryOne(sql: string) {
      fixture.lookups.push(sql);
      if (sql.includes('destination_profiles')) {
        return {
          profile_id: 'profile-1',
          destination_type: fixture.profileType,
          version_id: 'profile-version-1',
          schema_json: JSON.stringify(
            fixture.profileType === 'oidc'
              ? { claims: oidcProfileClaims() }
              : { attributes: [{ name: 'mail' }] }
          ),
        };
      }
      if (sql.includes('FROM consent_records') && fixture.selection === 'all') {
        return {
          id: 'consent-1',
          released_claims_json: JSON.stringify(oidcProfileClaims().map((c) => c.claimName)),
          released_attributes_json: null,
          evidence_json: '{}',
          created_at: 1,
        };
      }
      return null;
    },
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(adapter),
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
    getType: () => 'test',
    close: async () => undefined,
  };
  return adapter as unknown as DatabaseAdapter;
}

const USER_CLAIMS = {
  sub: 'user-1',
  name: 'Alice Example',
  email: 'alice@example.com',
  email_verified: true,
  phone_number: '+8100000000',
  phone_number_verified: false,
  address: { country: 'JP' },
};

function issue(
  overrides: Partial<Parameters<typeof applyOIDCIdentityMapping>[0]> = {}
): ReturnType<typeof applyOIDCIdentityMapping> {
  const db = database();
  return applyOIDCIdentityMapping({
    adapter: db,
    env: { DB_ADMIN: db as never },
    tenantId: 'tenant-a',
    clientId: 'client-a',
    // The app's `identity_mapping` is NULL.
    selector: null,
    destinationSurface: 'id_token',
    grantedScopes: ['openid', 'profile', 'email', 'phone', 'address'],
    claims: { ...USER_CLAIMS },
    ...overrides,
  });
}

describe('[current behavior] a tenant-wide activation applies to an app with no Mapping Set', () => {
  beforeEach(() => {
    fixture.activations = [activation({ kind: 'tenant' })];
    fixture.profileType = 'oidc';
    fixture.claims = undefined;
    fixture.selection = 'none';
    fixture.lookups = [];
    resetSwallowedIdentityMappingFailureThrottle();
  });

  it('binds the app to the tenant-wide activation although it chose none (stage 2 reverses this)', async () => {
    const { binding } = await issue();

    expect(binding).toMatchObject({
      fieldMappingSetId: 'set-1',
      destinationProfileId: 'profile-1',
      activationScope: { kind: 'tenant' },
    });
    // The lookup named no Mapping Set: nothing but the activation's scope matched.
    const activationLookup = fixture.lookups.find((sql) =>
      sql.includes('FROM field_mapping_activations')
    );
    expect(activationLookup).not.toContain('field_mapping_set_id = ?');
  });

  it('drops name, email, phone and address from the ID token (stage 2 reverses this)', async () => {
    const { claims } = await issue();

    // The profile lists the standard claims for UserInfo and as optional: none of them is
    // released in the ID token, and the user's claims the profile does not list go too.
    expect(claims).toEqual({ sub: 'user-1' });
  });

  it('drops the optional claims from UserInfo too until the user has selected them (stage 2 reverses this)', async () => {
    const { claims } = await issue({ destinationSurface: 'userinfo' });

    expect(claims).toEqual({ sub: 'user-1' });
  });

  it('releases them in UserInfo once the user has agreed to release the profile’s fields', async () => {
    fixture.selection = 'all';

    const { claims } = await issue({ destinationSurface: 'userinfo' });

    expect(claims).toMatchObject({
      sub: 'user-1',
      name: 'Alice Example',
      email: 'alice@example.com',
      phone_number: '+8100000000',
    });
  });

  it('applies the same to the claims a scope releases when only some claims are optional', async () => {
    fixture.claims = [
      { claimName: 'sub', required: true, surfaces: ['id_token', 'userinfo'] },
      {
        claimName: 'email',
        surfaces: ['id_token', 'userinfo'],
        requiredScopes: ['email'],
        classification: 'pii',
      },
      { claimName: 'name', required: true, surfaces: ['id_token', 'userinfo'] },
    ];

    const { claims } = await issue();

    // Required `name` is released; optional `email` waits for the user's selection.
    expect(claims).toEqual({ sub: 'user-1', name: 'Alice Example' });
  });

  it('keeps the standard claims when the tenant has no activation (the contrast)', async () => {
    fixture.activations = [];

    const { claims, binding } = await issue();

    expect(binding).toBeNull();
    expect(claims).toMatchObject({
      sub: 'user-1',
      name: 'Alice Example',
      email: 'alice@example.com',
      phone_number: '+8100000000',
      address: { country: 'JP' },
    });
  });

  it('is not changed by what else the activation scope carries, as long as it names no protocol or client', async () => {
    for (const scope of [
      { kind: 'tenant', id: 'tenant-a' },
      { kind: 'tenant', protocol: 'oidc' },
      {},
    ]) {
      fixture.activations = [activation(scope)];
      const { binding } = await issue();
      expect(binding?.fieldMappingSetId).toBe('set-1');
    }
  });

  it('does not reach an app from an activation scoped to another protocol, role or client', async () => {
    for (const scope of [
      { kind: 'tenant', protocol: 'saml' },
      { kind: 'tenant', protocol: 'oidc', role: 'rp' },
      { kind: 'tenant', clientId: 'client-b' },
      { kind: 'tenant', id: 'tenant-b' },
    ]) {
      fixture.activations = [activation(scope)];
      const { binding } = await issue();
      expect(binding).toBeNull();
    }
  });

  it('reaches an app that an activation names by client id, with no Mapping Set of its own', async () => {
    fixture.activations = [activation({ kind: 'tenant', clientId: 'client-a' })];

    const { binding } = await issue();

    expect(binding?.fieldMappingSetId).toBe('set-1');
  });

  it('fails issuance when the tenant-wide activation is a SAML mapping set (a SAML set is a candidate for OIDC)', async () => {
    fixture.profileType = 'saml';

    await expect(issue()).rejects.toMatchObject({
      name: 'DestinationProfileReleaseValidationError',
      code: 'destination_profile_type_mismatch',
    });
  });

  describe('when the lookup fails', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => errorSpy.mockRestore());

    it('goes on with the unmapped claims (an unreadable tenant-wide mapping is not an error of the request)', async () => {
      const db = database();
      (db as unknown as { query: () => Promise<never> }).query = async () => {
        throw new Error('no such table: field_mapping_activations');
      };

      const { claims, binding } = await applyOIDCIdentityMapping({
        adapter: db,
        env: { DB_ADMIN: db as never },
        tenantId: 'tenant-a',
        clientId: 'client-a',
        selector: null,
        destinationSurface: 'id_token',
        claims: { ...USER_CLAIMS },
      });

      expect(binding).toBeNull();
      expect(claims).toMatchObject({ email: 'alice@example.com', name: 'Alice Example' });
      expect(
        errorSpy.mock.calls
          .map(([line]) => JSON.parse(String(line)))
          .map((entry) => entry.reason_code)
      ).toEqual(['no_such_table']);
    });
  });
});
