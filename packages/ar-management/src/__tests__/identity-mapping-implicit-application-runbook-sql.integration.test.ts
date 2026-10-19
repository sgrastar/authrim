import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeIdentityMappingBinding, type DatabaseAdapter } from '@authrim/ar-lib-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The statements of docs/operations/identity-mapping-implicit-application.md, taken from the
 * document itself and run on the real Admin and Core baselines. They must find the activations the
 * runtime resolver would apply to an app that names no Mapping Set, pick the same winner, describe
 * the Destination Profile it brings, and count the apps that are exposed; and they must write
 * nothing.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DOCUMENT = readFileSync(
  resolve(REPO_ROOT, 'docs/operations/identity-mapping-implicit-application.md'),
  'utf8'
);

function runbook(name: string): string {
  const match = new RegExp('^```sql\\n(-- runbook: ' + name + '\\n[\\s\\S]*?)\\n```', 'm').exec(
    DOCUMENT
  );
  if (!match) throw new Error(`runbook statement missing: ${name}`);
  return match[1];
}

function baseline(path: string): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(':memory:');
  db.exec(
    readFileSync(resolve(REPO_ROOT, path), 'utf8')
      .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
      .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
  );
  return db;
}

type Row = Record<string, unknown>;

const STANDARD_OPTIONAL_USERINFO_ONLY = [
  { claimName: 'sub', required: true, surfaces: ['id_token', 'userinfo'] },
  ...['name', 'email', 'email_verified', 'phone_number', 'phone_number_verified', 'address'].map(
    (claimName) => ({ claimName, surfaces: ['userinfo'], requiredScopes: ['profile'] })
  ),
];

interface MappingInput {
  id: string;
  tenant?: string;
  scope?: unknown;
  activatedAt?: number;
  activationState?: string;
  snapshot?: 'active' | 'draft' | 'no_catalog' | 'none';
  /** The Destination Profile the mapping's edge names; null: the mapping has no edge at all. */
  profile?: {
    id: string;
    type?: string;
    schema?: unknown;
    owner?: string;
    ref?: string;
    /** The edge names it, and no Destination Profile exists. */
    missing?: boolean;
  } | null;
}

/** Puts the apps that client-scoped activations name into the `named` list of a Core statement. */
function withNamed(sql: string, pairs: Array<[string, string]>): string {
  const values = (pairs.length > 0 ? pairs : [['<tenant>', '<client id>']])
    .map(([tenant, client]) => `('${tenant}', '${client}')`)
    .join(', ');
  expect(sql).toContain("VALUES ('<tenant>', '<client id>')");
  return sql.replace("VALUES ('<tenant>', '<client id>')", `VALUES ${values}`);
}

describe('identity mapping implicit-application runbook SQL', () => {
  let admin: InstanceType<typeof DatabaseSync>;
  let core: InstanceType<typeof DatabaseSync>;

  beforeEach(() => {
    admin = baseline('migrations/admin/d1/001_0_4_0_admin_baseline.sql');
    core = baseline('migrations/core/d1/001_0_4_0_core_baseline.sql');
  });

  afterEach(() => {
    admin.close();
    core.close();
  });

  const all = (db: InstanceType<typeof DatabaseSync>, sql: string) =>
    db.prepare(sql).all() as Row[];
  const reachable = () => all(admin, runbook('reachable-activations'));

  function addProfile(input: {
    id: string;
    tenant: string;
    type: string;
    schema: unknown;
    state?: string;
  }): void {
    admin
      .prepare(
        `INSERT INTO destination_profiles
           (id, tenant_id, destination_type, profile_key, display_name, lifecycle_state,
            active_version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
      )
      .run(
        input.id,
        input.tenant,
        input.type,
        `key-${input.id}`,
        input.id,
        input.state ?? 'active',
        `ver-${input.id}`
      );
    admin
      .prepare(
        `INSERT INTO destination_profile_versions
           (id, tenant_id, profile_id, version_label, lifecycle_state, schema_hash, schema_json,
            validation_summary_json, warning_summary_json, release_impact_json, created_at, updated_at)
         VALUES (?, ?, ?, 'v1', 'active', 'hash', ?, '{}', '{}', '{}', 1, 1)`
      )
      .run(
        `ver-${input.id}`,
        input.tenant,
        input.id,
        typeof input.schema === 'string' ? input.schema : JSON.stringify(input.schema)
      );
  }

  /** A Mapping Set with one version, one rule and one edge, activated under `scope`. */
  function addMapping(input: MappingInput): void {
    const tenant = input.tenant ?? 'tenant-a';
    const id = input.id;
    admin
      .prepare(
        `INSERT INTO field_mapping_sets
           (id, tenant_id, field_mapping_key, display_name, lifecycle_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 1, 1)`
      )
      .run(`set-${id}`, tenant, `key-${id}`, `Set ${id}`);
    admin
      .prepare(
        `INSERT INTO field_mapping_versions
           (id, tenant_id, field_mapping_set_id, version_label, lifecycle_state, field_mapping_hash,
            created_at, updated_at)
         VALUES (?, ?, ?, 'v1', 'active', 'hash', 1, 1)`
      )
      .run(`ver-${id}`, tenant, `set-${id}`);
    admin
      .prepare(
        `INSERT INTO field_mapping_activations
           (id, tenant_id, field_mapping_set_id, field_mapping_version_id, activation_scope_json,
            lifecycle_state, activated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `act-${id}`,
        tenant,
        `set-${id}`,
        `ver-${id}`,
        typeof input.scope === 'string'
          ? input.scope
          : JSON.stringify(input.scope ?? { kind: 'tenant' }),
        input.activationState ?? 'active',
        input.activatedAt ?? 100,
        input.activatedAt ?? 100,
        input.activatedAt ?? 100
      );
    const snapshot = input.snapshot ?? 'active';
    if (snapshot !== 'none') {
      admin
        .prepare(
          `INSERT INTO compiled_mapping_snapshots
             (id, tenant_id, field_mapping_version_id, catalog_version_id, snapshot_hash,
              lifecycle_state, compiled_at)
           VALUES (?, ?, ?, ?, 'snapshot-hash', ?, 1)`
        )
        .run(
          `snap-${id}`,
          tenant,
          `ver-${id}`,
          snapshot === 'no_catalog' ? null : 'catalog-1',
          snapshot === 'draft' ? 'draft' : 'active'
        );
    }
    const profile = input.profile === undefined ? { id: `profile-${id}` } : input.profile;
    if (profile) {
      if (
        !profile.missing &&
        !admin.prepare('SELECT 1 FROM destination_profiles WHERE id = ?').get(profile.id)
      ) {
        addProfile({
          id: profile.id,
          tenant: profile.owner ?? tenant,
          type: profile.type ?? 'oidc',
          schema: profile.schema ?? { claims: STANDARD_OPTIONAL_USERINFO_ONLY },
        });
      }
      admin
        .prepare(
          `INSERT INTO mapping_rules
             (id, tenant_id, field_mapping_version_id, rule_key, rule_kind, action, priority,
              created_at, updated_at)
           VALUES (?, ?, ?, 'rule', 'direct', 'allow', 0, 1, 1)`
        )
        .run(`rule-${id}`, tenant, `ver-${id}`);
      admin
        .prepare(
          `INSERT INTO mapping_rule_edges
             (id, tenant_id, rule_id, source_ref_json, target_ref_json, edge_kind, display_order,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'direct', 0, 1, 1)`
        )
        .run(
          `edge-${id}`,
          tenant,
          `rule-${id}`,
          JSON.stringify({ side: 'source', namespace: 'authrim.profile', path: 'email' }),
          JSON.stringify({
            side: 'destination',
            profileId: profile.ref ?? profile.id,
            namespace: 'oidc.claim',
            path: 'email',
          })
        );
    }
  }

  /** The real resolver, on the same database: which activation does an app with no choice get? */
  async function runtimeWinner(clientId: string, tenant = 'tenant-a'): Promise<string | null> {
    const bind = (params: unknown[] = []) => params.map((value) => value ?? null);
    const adapter = {
      query: async (sql: string, params?: unknown[]) => admin.prepare(sql).all(...bind(params)),
      queryOne: async (sql: string, params?: unknown[]) =>
        admin.prepare(sql).get(...bind(params)) ?? null,
    } as unknown as DatabaseAdapter;
    const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
      tenantId: tenant,
      protocol: 'oidc',
      role: 'op',
      partnerEntityId: clientId,
      clientId,
    });
    return binding?.id ?? null;
  }

  describe('reachable-activations', () => {
    it('describes the tenant-wide activation of the 2026-10-10 shape', () => {
      addMapping({ id: 'wide', scope: { kind: 'tenant' } });

      expect(reachable()).toEqual([
        expect.objectContaining({
          tenant_id: 'tenant-a',
          activation_id: 'act-wide',
          set_id: 'set-wide',
          set_key: 'key-wide',
          set_name: 'Set wide',
          set_state: 'active',
          version_label: 'v1',
          scope_kind: 'tenant',
          reach: 'every_client',
          target_client_id: null,
          wins_for_apps_without_a_choice: 1,
          snapshot_ready: 1,
          profile_types: 'oidc',
          unresolved_profile_refs: 0,
          has_non_oidc_profile: 0,
          // sub and six standard claims; the six are optional and listed for UserInfo only.
          field_count: 7,
          optional_field_count: 6,
          claims_not_in_id_token: 6,
          optional_standard_claims:
            'address,email,email_verified,name,phone_number,phone_number_verified',
        }),
      ]);
    });

    it('reports the scope it read, so an operator can see why', () => {
      addMapping({ id: 'wide', scope: { kind: 'tenant', note: 'x' } });

      expect(reachable()[0].scope_json).toBe(JSON.stringify({ kind: 'tenant', note: 'x' }));
    });

    it.each([
      ['an empty scope', {}, 'every_client'],
      ['kind tenant only', { kind: 'tenant' }, 'every_client'],
      ['this tenant by id', { kind: 'tenant', id: 'tenant-a' }, 'every_client'],
      ['this tenant by tenantId', { tenantId: 'tenant-a' }, 'every_client'],
      ['protocol oidc', { kind: 'tenant', protocol: 'oidc' }, 'every_client'],
      ['protocol oidc, role op', { protocol: 'oidc', role: 'op' }, 'every_client'],
      ['empty strings', { protocol: '', role: '', clientId: '' }, 'every_client'],
      ['an invalid scope', 'not json', 'every_client'],
      ['another protocol', { kind: 'tenant', protocol: 'saml' }, 'never'],
      ['a SAML IdP', { protocol: 'saml', role: 'idp' }, 'never'],
      ['another role', { protocol: 'oidc', role: 'rp' }, 'never'],
      ['another tenant', { kind: 'tenant', id: 'tenant-b' }, 'never'],
      ['a local entity', { localEntityId: 'https://idp.example' }, 'never'],
      ['a provider', { provider_id: 'google' }, 'never'],
      ['a credential profile', { credentialProfileId: 'cred' }, 'never'],
      ['a credential configuration', { credential_configuration_id: 'cred' }, 'never'],
      ['a direction', { direction: 'inbound' }, 'never'],
      ['two different clients', { clientId: 'a', partnerEntityId: 'b' }, 'never'],
      ['a client id', { kind: 'tenant', clientId: 'client-a' }, 'one_client'],
      ['a client id in snake case', { client_id: 'client-a' }, 'one_client'],
      ['a partner entity', { partnerEntityId: 'client-a' }, 'one_client'],
      ['a partner entity in snake case', { partner_entity_id: 'client-a' }, 'one_client'],
      ['an sp entity', { spEntityId: 'client-a' }, 'one_client'],
      ['an rp client', { rpClientId: 'client-a' }, 'one_client'],
      [
        'the same client twice',
        { clientId: 'client-a', partnerEntityId: 'client-a' },
        'one_client',
      ],
    ])('classifies %s as %s', (_name, scope, reach) => {
      addMapping({ id: 'one', scope });

      expect(reachable()[0].reach).toBe(reach);
    });

    it('names the client a one_client activation is bound to, and never lets it win for the others', () => {
      addMapping({ id: 'client', scope: { clientId: 'client-a' } });

      expect(reachable()[0]).toMatchObject({
        reach: 'one_client',
        target_client_id: 'client-a',
        wins_for_apps_without_a_choice: 0,
        wins_for_named_app: 1,
      });
    });

    it('lists only active activations', () => {
      addMapping({ id: 'active' });
      addMapping({ id: 'draft', activationState: 'scheduled' });
      addMapping({ id: 'old', activationState: 'inactive' });

      expect(reachable().map((row) => row.activation_id)).toEqual(['act-active']);
    });

    it('lists every tenant, each with its own winner', () => {
      addMapping({ id: 'a', tenant: 'tenant-a' });
      addMapping({ id: 'b', tenant: 'tenant-b' });

      expect(reachable().map((row) => [row.tenant_id, row.wins_for_apps_without_a_choice])).toEqual(
        [
          ['tenant-a', 1],
          ['tenant-b', 1],
        ]
      );
    });

    describe('which activation wins for an app that names no Mapping Set (checked against the resolver)', () => {
      const winnerOfStatement = (tenant = 'tenant-a') =>
        reachable().find(
          (row) => row.tenant_id === tenant && row.wins_for_apps_without_a_choice === 1
        )?.activation_id ?? null;

      it('is the one with the most specific scope, then the one activated last', async () => {
        addMapping({ id: 'bare', scope: { kind: 'tenant' }, activatedAt: 300 });
        addMapping({ id: 'oidc', scope: { kind: 'tenant', protocol: 'oidc' }, activatedAt: 200 });
        addMapping({
          id: 'oidc-op',
          scope: { kind: 'tenant', protocol: 'oidc', role: 'op' },
          activatedAt: 100,
        });
        addMapping({ id: 'saml', scope: { kind: 'tenant', protocol: 'saml' }, activatedAt: 900 });
        addMapping({ id: 'other', scope: { clientId: 'client-x' }, activatedAt: 900 });

        expect(winnerOfStatement()).toBe('act-oidc-op');
        expect(await runtimeWinner('client-a')).toBe('act-oidc-op');
      });

      it('weighs the role above the protocol, and the tenant least', async () => {
        addMapping({ id: 'role', scope: { role: 'op' }, activatedAt: 100 });
        addMapping({ id: 'protocol', scope: { protocol: 'oidc' }, activatedAt: 200 });
        addMapping({ id: 'tenant', scope: { tenantId: 'tenant-a' }, activatedAt: 300 });

        expect(winnerOfStatement()).toBe('act-role');
        expect(await runtimeWinner('client-a')).toBe('act-role');
      });

      it('weighs the protocol above the tenant', async () => {
        addMapping({ id: 'protocol', scope: { protocol: 'oidc' }, activatedAt: 100 });
        addMapping({ id: 'tenant', scope: { tenantId: 'tenant-a' }, activatedAt: 200 });

        expect(winnerOfStatement()).toBe('act-protocol');
        expect(await runtimeWinner('client-a')).toBe('act-protocol');
      });

      it('goes to the later activation when the scopes score the same', async () => {
        addMapping({ id: 'first', scope: { kind: 'tenant' }, activatedAt: 100 });
        addMapping({ id: 'second', scope: { kind: 'tenant' }, activatedAt: 200 });

        expect(winnerOfStatement()).toBe('act-second');
        expect(await runtimeWinner('client-a')).toBe('act-second');
      });

      it('is none when only other protocols, clients or tenants are activated', async () => {
        addMapping({ id: 'saml', scope: { protocol: 'saml', role: 'idp' } });
        addMapping({ id: 'client', scope: { clientId: 'client-x' } });
        addMapping({ id: 'elsewhere', tenant: 'tenant-b' });

        expect(winnerOfStatement()).toBeNull();
        expect(await runtimeWinner('client-a')).toBeNull();
        expect(winnerOfStatement('tenant-b')).toBe('act-elsewhere');
        expect(await runtimeWinner('client-a', 'tenant-b')).toBe('act-elsewhere');
      });

      it('is the activation the runtime names for an app that a one_client activation does not name', async () => {
        addMapping({ id: 'wide', scope: { kind: 'tenant' }, activatedAt: 100 });
        addMapping({
          id: 'client',
          scope: { kind: 'tenant', clientId: 'client-a' },
          activatedAt: 50,
        });

        expect(winnerOfStatement()).toBe('act-wide');
        expect(await runtimeWinner('client-b')).toBe('act-wide');
        // The named app is bound to its own activation, which the statement lists as one_client.
        expect(await runtimeWinner('client-a')).toBe('act-client');
      });
    });

    describe('snapshot_ready', () => {
      it.each([
        ['an active snapshot', 'active', 1],
        ['a snapshot that is not active', 'draft', 0],
        ['a snapshot with no catalog', 'no_catalog', 0],
        ['no snapshot', 'none', 0],
      ] as const)('is %s: %s', async (_name, snapshot, ready) => {
        addMapping({ id: 'wide', snapshot });

        expect(reachable()[0].snapshot_ready).toBe(ready);
        // What the runtime does with a winner that has no usable snapshot: no mapping at all.
        expect(await runtimeWinner('client-a')).toBe(ready ? 'act-wide' : null);
      });
    });

    describe('the Destination Profile it brings', () => {
      it('reports a SAML profile on a tenant-wide activation as a mismatch', () => {
        addMapping({
          id: 'wide',
          profile: {
            id: 'saml-profile',
            type: 'saml',
            schema: { attributes: [{ name: 'mail' }, { name: 'uid' }] },
          },
        });

        expect(reachable()[0]).toMatchObject({
          reach: 'every_client',
          profile_types: 'saml',
          has_non_oidc_profile: 1,
          field_count: 2,
          optional_field_count: 2,
          optional_standard_claims: null,
        });
      });

      it('reports a profile the mapping names and no Destination Profile matches', () => {
        addMapping({ id: 'wide', profile: { id: 'missing-profile', missing: true } });

        expect(reachable()[0]).toMatchObject({
          unresolved_profile_refs: 1,
          profile_types: null,
          field_count: 0,
        });
      });

      it('resolves a reference written with the destination-profile- prefix', () => {
        addProfile({ id: 'p1', tenant: 'tenant-a', type: 'oidc', schema: { claims: [] } });
        addMapping({ id: 'wide', profile: { id: 'p1', ref: 'destination-profile-p1' } });

        expect(reachable()[0]).toMatchObject({
          unresolved_profile_refs: 0,
          profile_types: 'oidc',
        });
      });

      it('resolves a profile that the platform owns', () => {
        addProfile({ id: 'shared', tenant: 'platform', type: 'oidc', schema: { claims: [] } });
        addMapping({ id: 'wide', profile: { id: 'shared' } });

        expect(reachable()[0]).toMatchObject({ unresolved_profile_refs: 0, profile_types: 'oidc' });
      });

      it('does not resolve a profile that another tenant owns', () => {
        addProfile({ id: 'theirs', tenant: 'tenant-b', type: 'oidc', schema: { claims: [] } });
        addMapping({ id: 'wide', profile: { id: 'theirs' } });

        expect(reachable()[0]).toMatchObject({ unresolved_profile_refs: 1, profile_types: null });
      });

      it('adds the profile the activation scope names', () => {
        addProfile({
          id: 'scoped',
          tenant: 'tenant-a',
          type: 'oidc',
          schema: { claims: [{ claimName: 'sub' }] },
        });
        addMapping({
          id: 'wide',
          scope: { kind: 'tenant', destinationProfileId: 'scoped' },
          profile: null,
        });

        expect(reachable()[0]).toMatchObject({ profile_types: 'oidc', field_count: 1 });
      });

      it('counts a claim as required only when it is required: true (or sub)', () => {
        addMapping({
          id: 'wide',
          profile: {
            id: 'mixed',
            schema: {
              claims: [
                { claimName: 'sub' },
                { claimName: 'email', required: true, surfaces: ['id_token'] },
                { claimName: 'name', required: 'true' },
                { claimName: 'locale', required: false, surfaces: ['userinfo', 'id_token'] },
                'not an object',
              ],
            },
          },
        });

        expect(reachable()[0]).toMatchObject({
          field_count: 4,
          optional_field_count: 2,
          claims_not_in_id_token: 0,
          optional_standard_claims: 'locale,name',
        });
      });

      it('does not fail on a schema that is not JSON', () => {
        addMapping({ id: 'wide', profile: { id: 'broken', schema: 'not json' } });

        expect(reachable()[0]).toMatchObject({ field_count: 0, profile_types: 'oidc' });
      });

      it('reports a mapping with no edge and no profile', () => {
        addMapping({ id: 'wide', profile: null });

        expect(reachable()[0]).toMatchObject({
          profile_types: null,
          unresolved_profile_refs: 0,
          field_count: 0,
        });
      });
    });
  });

  describe('apps-per-tenant and apps-without-mapping-set', () => {
    function addClient(tenant: string, id: string, identityMapping: string | null): void {
      core
        .prepare(
          `INSERT INTO oauth_clients
             (client_id, client_name, redirect_uris, grant_types, response_types, created_at,
              updated_at, tenant_id, identity_mapping)
           VALUES (?, ?, '[]', '[]', '[]', 1, 1, ?, ?)`
        )
        .run(id, `App ${id}`, tenant, identityMapping);
    }

    beforeEach(() => {
      addClient('tenant-a', 'null', null);
      addClient('tenant-a', 'empty-string', '');
      addClient('tenant-a', 'empty-object', '{}');
      addClient('tenant-a', 'not-json', 'not json');
      addClient('tenant-a', 'json-null', 'null');
      addClient('tenant-a', 'legacy-profile', '{"destinationProfileId":"p"}');
      addClient('tenant-a', 'empty-set', '{"fieldMappingSetId":""}');
      addClient('tenant-a', 'numeric-set', '{"fieldMappingSetId":5}');
      addClient('tenant-a', 'chosen', '{"fieldMappingSetId":"set-1"}');
      addClient(
        'tenant-a',
        'chosen-with-version',
        '{"fieldMappingSetId":"set-1","fieldMappingVersionId":"v"}'
      );
      addClient('tenant-b', 'b-null', null);
      addClient('tenant-b', 'b-chosen', '{"fieldMappingSetId":"set-2"}');
      addClient('tenant-c', 'c-chosen', '{"fieldMappingSetId":"set-3"}');
    });

    it('counts, per tenant, the apps and those that name no Mapping Set (no app is named by an activation)', () => {
      expect(all(core, runbook('apps-per-tenant'))).toEqual([
        {
          tenant_id: 'tenant-a',
          oidc_apps: 10,
          identity_mapping_null: 1,
          without_mapping_set: 8,
          bound_by_client_activation: 0,
          left_to_tenant_wide_activation: 8,
        },
        {
          tenant_id: 'tenant-b',
          oidc_apps: 2,
          identity_mapping_null: 1,
          without_mapping_set: 1,
          bound_by_client_activation: 0,
          left_to_tenant_wide_activation: 1,
        },
        {
          tenant_id: 'tenant-c',
          oidc_apps: 1,
          identity_mapping_null: 0,
          without_mapping_set: 0,
          bound_by_client_activation: 0,
          left_to_tenant_wide_activation: 0,
        },
      ]);
    });

    it('splits the apps by the list of apps that client-scoped activations name', () => {
      const pairs: Array<[string, string]> = [
        ['tenant-a', 'null'],
        ['tenant-a', 'chosen'],
        ['tenant-b', 'b-null'],
        ['tenant-b', 'unknown-app'],
      ];
      // The same client id in another tenant is not named by the pair of tenant-a.
      addClient('tenant-c', 'null', null);

      expect(all(core, withNamed(runbook('apps-per-tenant'), pairs))).toEqual([
        expect.objectContaining({
          tenant_id: 'tenant-a',
          without_mapping_set: 8,
          // 'chosen' names a Mapping Set: it is not looked up by activation, listed or not.
          bound_by_client_activation: 1,
          left_to_tenant_wide_activation: 7,
        }),
        expect.objectContaining({
          tenant_id: 'tenant-b',
          without_mapping_set: 1,
          bound_by_client_activation: 1,
          left_to_tenant_wide_activation: 0,
        }),
        expect.objectContaining({
          tenant_id: 'tenant-c',
          without_mapping_set: 1,
          bound_by_client_activation: 0,
          left_to_tenant_wide_activation: 1,
        }),
      ]);
      expect(
        all(core, withNamed(runbook('apps-without-mapping-set'), pairs)).filter(
          (row) => row.applied_by === 'client_activation'
        )
      ).toEqual([
        expect.objectContaining({ tenant_id: 'tenant-a', client_id: 'null' }),
        expect.objectContaining({ tenant_id: 'tenant-b', client_id: 'b-null' }),
      ]);
    });

    it('lists the apps that name no Mapping Set', () => {
      expect(
        all(core, runbook('apps-without-mapping-set'))
          .filter((row) => row.tenant_id === 'tenant-a')
          .map((row) => row.client_id)
      ).toEqual([
        'empty-object',
        'empty-set',
        'empty-string',
        'json-null',
        'legacy-profile',
        'not-json',
        'null',
        'numeric-set',
      ]);
      expect(all(core, runbook('apps-without-mapping-set')).map((row) => row.client_id)).toContain(
        'b-null'
      );
      expect(
        all(core, runbook('apps-without-mapping-set')).map((row) => row.client_id)
      ).not.toContain('b-chosen');
    });

    it('marks every app tenant-wide when no activation names an app', () => {
      expect(
        new Set(all(core, runbook('apps-without-mapping-set')).map((row) => row.applied_by))
      ).toEqual(new Set(['tenant_wide_activation']));
    });

    describe('with client-scoped and tenant-wide activations (checked against the resolver)', () => {
      const names = (tenant = 'tenant-a'): Array<[string, string]> =>
        reachable()
          .filter((row) => row.tenant_id === tenant && row.wins_for_named_app === 1)
          .map((row) => [tenant, String(row.target_client_id)]);

      /** What the runbook says applies to each app that names no Mapping Set, against the resolver. */
      async function expectRunbookToMatchRuntime(tenant: string): Promise<Record<string, unknown>> {
        const rows = reachable().filter((row) => row.tenant_id === tenant);
        const wide = rows.find((row) => row.wins_for_apps_without_a_choice === 1)?.activation_id;
        const applied: Record<string, unknown> = {};
        const apps = all(
          core,
          withNamed(runbook('apps-without-mapping-set'), names(tenant))
        ).filter((row) => row.tenant_id === tenant);
        expect(apps.length).toBeGreaterThan(0);
        for (const app of apps) {
          const named = rows.find(
            (row) => row.wins_for_named_app === 1 && row.target_client_id === app.client_id
          );
          const expected =
            app.applied_by === 'client_activation' ? named?.activation_id : (wide ?? null);
          expect(app.applied_by, String(app.client_id)).toBe(
            named ? 'client_activation' : 'tenant_wide_activation'
          );
          expect(await runtimeWinner(String(app.client_id), tenant), String(app.client_id)).toBe(
            expected ?? null
          );
          applied[String(app.client_id)] = expected ?? null;
        }
        return applied;
      }

      it('applies a client-scoped activation to its app when it is the only activation', async () => {
        addMapping({ id: 'client-a', scope: { clientId: 'null' } });

        expect(reachable()[0]).toMatchObject({
          reach: 'one_client',
          wins_for_apps_without_a_choice: 0,
          wins_for_named_app: 1,
          target_client_id: 'null',
        });
        expect(names()).toEqual([['tenant-a', 'null']]);
        expect(await expectRunbookToMatchRuntime('tenant-a')).toMatchObject({
          null: 'act-client-a',
          'empty-string': null,
          'not-json': null,
        });
        expect(all(core, withNamed(runbook('apps-per-tenant'), names()))[0]).toMatchObject({
          tenant_id: 'tenant-a',
          bound_by_client_activation: 1,
          left_to_tenant_wide_activation: 7,
        });
      });

      it('applies the tenant-wide activation only to the apps no client-scoped activation names', async () => {
        addMapping({ id: 'wide', scope: { kind: 'tenant' }, activatedAt: 300 });
        addMapping({ id: 'client-a', scope: { clientId: 'null' }, activatedAt: 100 });

        expect(
          reachable().map((row) => [
            row.activation_id,
            row.wins_for_apps_without_a_choice,
            row.wins_for_named_app,
          ])
        ).toEqual([
          ['act-wide', 1, 0],
          ['act-client-a', 0, 1],
        ]);
        expect(await expectRunbookToMatchRuntime('tenant-a')).toMatchObject({
          null: 'act-client-a',
          'empty-string': 'act-wide',
          'not-json': 'act-wide',
        });
        expect(all(core, withNamed(runbook('apps-per-tenant'), names()))[0]).toMatchObject({
          bound_by_client_activation: 1,
          left_to_tenant_wide_activation: 7,
        });
      });

      it('lets a client-scoped activation win over a tenant-wide one of a far higher score', async () => {
        addMapping({ id: 'wide', scope: { protocol: 'oidc', role: 'op', tenantId: 'tenant-a' } });
        addMapping({ id: 'client-a', scope: { clientId: 'null' } });

        expect(await expectRunbookToMatchRuntime('tenant-a')).toMatchObject({
          null: 'act-client-a',
          'not-json': 'act-wide',
        });
      });

      it('picks, for an app several activations name, the best scored then the latest', async () => {
        addMapping({ id: 'plain', scope: { clientId: 'null' }, activatedAt: 300 });
        addMapping({ id: 'oidc', scope: { clientId: 'null', protocol: 'oidc' }, activatedAt: 100 });
        addMapping({ id: 'saml', scope: { clientId: 'null', protocol: 'saml' }, activatedAt: 900 });
        addMapping({ id: 'other', scope: { clientId: 'json-null' }, activatedAt: 50 });
        addMapping({ id: 'other-late', scope: { clientId: 'json-null' }, activatedAt: 60 });

        expect(
          reachable()
            .filter((row) => row.wins_for_named_app === 1)
            .map((row) => row.activation_id)
            .sort()
        ).toEqual(['act-oidc', 'act-other-late']);
        expect(await expectRunbookToMatchRuntime('tenant-a')).toMatchObject({
          null: 'act-oidc',
          'json-null': 'act-other-late',
          'not-json': null,
        });
      });

      it('scores naming the app twice (client and partner) above naming it once', async () => {
        addMapping({
          id: 'both',
          scope: { clientId: 'null', partnerEntityId: 'null' },
          activatedAt: 100,
        });
        addMapping({ id: 'once', scope: { clientId: 'null', protocol: 'oidc' }, activatedAt: 200 });

        expect(await expectRunbookToMatchRuntime('tenant-a')).toMatchObject({ null: 'act-both' });
      });

      it('takes the partner and sp entity names as naming the app too', async () => {
        addMapping({ id: 'partner', scope: { partnerEntityId: 'null' } });
        addMapping({ id: 'sp', scope: { spEntityId: 'json-null' } });

        expect(await expectRunbookToMatchRuntime('tenant-a')).toMatchObject({
          null: 'act-partner',
          'json-null': 'act-sp',
        });
      });

      it('does not apply a client-scoped activation of another tenant', async () => {
        addMapping({ id: 'elsewhere', tenant: 'tenant-b', scope: { clientId: 'null' } });

        expect(names('tenant-a')).toEqual([]);
        expect(Object.values(await expectRunbookToMatchRuntime('tenant-a'))).toEqual(
          Array(8).fill(null)
        );
        expect(await runtimeWinner('null', 'tenant-a')).toBeNull();
        expect(names('tenant-b')).toEqual([['tenant-b', 'null']]);
      });
    });

    it('agrees with the runtime: an app counts as naming a Mapping Set exactly when the selector has a non-empty fieldMappingSetId', () => {
      const listed = new Set(
        all(core, runbook('apps-without-mapping-set')).map((row) => row.client_id)
      );
      for (const row of all(core, 'SELECT client_id, identity_mapping FROM oauth_clients')) {
        let setId: unknown;
        try {
          setId = JSON.parse(String(row.identity_mapping ?? 'null'))?.fieldMappingSetId;
        } catch {
          setId = undefined;
        }
        const names = typeof setId === 'string' && setId.length > 0;
        expect(listed.has(row.client_id), String(row.client_id)).toBe(!names);
      }
    });
  });

  describe('they only read', () => {
    const NAMES = ['reachable-activations', 'apps-per-tenant', 'apps-without-mapping-set'];

    it.each(NAMES)('%s is a single SELECT with no write keyword', (name) => {
      const sql = runbook(name);

      expect(sql.replace(/^-- .*$/gm, '').trim()).toMatch(/^(WITH|SELECT)\b/i);
      expect(sql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|ATTACH|VACUUM)\b/i
      );
      expect(sql.trim().endsWith(';')).toBe(true);
      expect(sql.trim().slice(0, -1)).not.toContain(';');
    });

    it('run on a database that refuses every write', () => {
      addMapping({ id: 'wide' });
      admin.exec('PRAGMA query_only = ON');
      core.exec('PRAGMA query_only = ON');

      expect(() => all(admin, runbook('reachable-activations'))).not.toThrow();
      expect(() => all(core, runbook('apps-per-tenant'))).not.toThrow();
      expect(() => all(core, runbook('apps-without-mapping-set'))).not.toThrow();
      expect(() => admin.exec('DELETE FROM field_mapping_sets')).toThrow(/readonly/i);
    });

    it('keep the document in step: every sql block of it is one of the tested statements', () => {
      const blocks = [...DOCUMENT.matchAll(/^```sql\n(-- runbook: ([a-z-]+)\n[\s\S]*?)\n```/gm)];

      expect(blocks.map((block) => block[2]).sort()).toEqual([...NAMES].sort());
    });
  });
});
