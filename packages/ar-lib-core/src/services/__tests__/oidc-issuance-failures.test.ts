import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types/env';
import type { ClientMetadata } from '../../types/oidc';
import { applyOIDCIdentityMapping } from '../oidc-identity-mapping';
import { mapIDTokenClaims, type IDTokenReleaseContext } from '../oidc-id-token-release';
import type { IdentityMappingFailureContext } from '../identity-mapping-failures';
import { issuanceFailureDatabase } from './identity-mapping-issuance-fixture';

let store: ReturnType<typeof issuanceFailureDatabase>;
let pending: Promise<unknown>[];
const context = (tenantId = 'tenant-a'): IDTokenReleaseContext => ({
  env: { DB_ADMIN: store.adapter } as unknown as Env,
  adapter: store.adapter,
  tenantId,
  clientId: 'app-a',
  clientMetadata: {
    client_id: 'app-a',
    identity_mapping: { fieldMappingSetId: 'set-a' },
  } as ClientMetadata,
  loadUserAttributes: async () => ({ email: 'client:private-value-canary' }),
  log: { warn: vi.fn(), error: vi.fn() },
  waitUntil: (work) => {
    pending.push(work);
  },
});
const claims = { sub: 'private-user-canary', email: 'private-claim-canary' };
const flush = async () => {
  await Promise.all(pending.splice(0));
};

function seedReservedSubjectMapping() {
  store.db.exec(`
    INSERT INTO field_mapping_sets(id,tenant_id,field_mapping_key,display_name,lifecycle_state,created_at,updated_at)
      VALUES('set-a','tenant-a','key-a','Set A','active',1,1);
    INSERT INTO field_mapping_versions(id,tenant_id,field_mapping_set_id,version_label,lifecycle_state,field_mapping_hash,created_at,updated_at)
      VALUES('version-a','tenant-a','set-a','v1','active','hash',1,1);
    INSERT INTO field_mapping_activations(id,tenant_id,field_mapping_set_id,field_mapping_version_id,activation_scope_json,lifecycle_state,activated_at,created_at,updated_at)
      VALUES('act-a','tenant-a','set-a','version-a','{}','active',1,1,1);
    INSERT INTO field_catalogs(id,tenant_id,catalog_key,display_name,lifecycle_state,created_at,updated_at)
      VALUES('catalog-def','tenant-a','catalog','Catalog','active',1,1);
    INSERT INTO field_catalog_versions(id,tenant_id,catalog_id,version_label,bundle_hash,lifecycle_state,created_at,updated_at)
      VALUES('catalog-a','tenant-a','catalog-def','v1','bundle','active',1,1);
    INSERT INTO compiled_mapping_snapshots(id,tenant_id,field_mapping_version_id,catalog_version_id,snapshot_hash,lifecycle_state,compiled_at)
      VALUES('snapshot-a','tenant-a','version-a','catalog-a','snapshot','active',1);
    INSERT INTO field_catalog_entries(id,tenant_id,catalog_version_id,stable_field_id,namespace,path,target_taxonomy,value_type,classification,created_at,updated_at)
      VALUES('source-email','tenant-a','catalog-a','source-email','authrim.profile','email','canonical','string','internal',1,1),
            ('destination-sub','tenant-a','catalog-a','destination-sub','oidc.claim','sub','canonical','string','internal',1,1);
    INSERT INTO mapping_rules(id,tenant_id,field_mapping_version_id,rule_key,rule_kind,action,priority,created_at,updated_at)
      VALUES('rule-a','tenant-a','version-a','rule','direct','allow',0,1,1);
    INSERT INTO mapping_rule_edges(id,tenant_id,rule_id,source_ref_json,target_ref_json,edge_kind,display_order,created_at,updated_at)
      VALUES('edge-a','tenant-a','rule-a','{"side":"source","namespace":"authrim.profile","path":"email"}','{"side":"destination","profileId":"profile-a","namespace":"oidc.claim","path":"sub"}','direct',0,1,1);
    INSERT INTO destination_profiles(id,tenant_id,destination_type,profile_key,display_name,owner_scope_type,lifecycle_state,active_version_id,created_at,updated_at)
      VALUES('profile-a','tenant-a','oidc','profile','Profile','tenant','active','profile-version',1,1);
    INSERT INTO destination_profile_versions(id,tenant_id,profile_id,version_label,lifecycle_state,schema_hash,schema_json,validation_summary_json,warning_summary_json,release_impact_json,created_at,updated_at)
      VALUES('profile-version','tenant-a','profile-a','v1','active','schema','{"claims":[{"claimName":"sub","required":true,"surfaces":["id_token","userinfo"]}]}','{}','{}','{}',1,1);
  `);
}

describe('issuance failure counters on the real Admin boundary', () => {
  beforeEach(() => {
    store = issuanceFailureDatabase();
    pending = [];
  });
  afterEach(async () => {
    await flush();
    store.db.close();
    vi.restoreAllMocks();
  });

  it('records one original resolution code with only tenant/client/set coordinates', async () => {
    const result = await mapIDTokenClaims(context(), claims, ['openid']);
    expect(result).toMatchObject({ ok: false, failure: { error: 'invalid_client', status: 400 } });
    await flush();
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]).toMatchObject({
      tenant_id: 'tenant-a',
      client_id: 'app-a',
      code: 'set_missing',
      tier: 'client',
      set_id: 'set-a',
      count: 1,
    });
    expect(JSON.stringify(store.rows())).not.toMatch(
      /private-user-canary|private-claim-canary|private-value-canary|sourceAttributes|claims|selector|stack/
    );
  });

  it('retains a bound selection for a later runtime failure without enabling trace', async () => {
    seedReservedSubjectMapping();
    const result = await mapIDTokenClaims(context(), { sub: claims.sub }, ['openid']);
    expect(result).toMatchObject({ ok: false, failure: { status: 400 } });
    await flush();
    expect(store.rows()[0]).toMatchObject({
      code: 'policy.identity_mapping_reserved_subject',
      tier: 'client',
      set_id: 'set-a',
      count: 1,
    });
    expect(JSON.stringify(store.rows())).not.toContain('private-');
  });

  it('preserves selection failure codes without saving invalid selector values', async () => {
    const ctx = context();
    ctx.clientMetadata.identity_mapping = {
      mode: 'none',
      fieldMappingSetId: 'private-invalid-selector',
    };
    await mapIDTokenClaims(ctx, claims);
    await flush();
    expect(store.rows()[0]).toMatchObject({
      code: 'client_selector_invalid',
      tier: 'client',
      set_id: null,
      count: 1,
    });
    expect(JSON.stringify(store.rows())).not.toContain('private-invalid-selector');
  });

  it('keeps an Admin lookup outage a 500 and records the original fixed code', async () => {
    const query = store.adapter.queryOne.bind(store.adapter);
    store.adapter.queryOne = async (sql, params, options) => {
      if (sql.includes('FROM field_mapping_sets')) throw new Error('private-database-error-canary');
      return query(sql, params, options);
    };
    const result = await mapIDTokenClaims(context(), claims);
    expect(result).toMatchObject({ ok: false, failure: { status: 500, error: 'server_error' } });
    await flush();
    expect(store.rows()[0]).toMatchObject({
      code: 'admin_database_unavailable',
      tier: 'client',
      set_id: 'set-a',
    });
    expect(JSON.stringify(store.rows())).not.toContain('private-database-error-canary');
  });

  it('preserves the exact protocol failure when the counter write fails', async () => {
    const first = await mapIDTokenClaims(context(), claims);
    await flush();
    store.db.exec(
      "CREATE TRIGGER reject_counter BEFORE INSERT ON identity_mapping_failures BEGIN SELECT RAISE(ABORT,'injected'); END"
    );
    expect(await mapIDTokenClaims(context(), claims)).toEqual(first);
    await flush();
    expect(store.rows()[0].count).toBe(1);
  });

  it.each(['missing', 'throwing'] as const)(
    'performs no counter IO with a %s waitUntil',
    async (mode) => {
      const ctx = context();
      const writes = vi.spyOn(store.adapter, 'execute');
      ctx.waitUntil =
        mode === 'missing'
          ? undefined
          : (work) => {
              pending.push(work);
              throw new Error('unavailable lifetime');
            };
      expect(await mapIDTokenClaims(ctx, claims)).toMatchObject({
        ok: false,
        failure: { status: 400 },
      });
      await flush();
      expect(writes).not.toHaveBeenCalled();
      expect(store.rows()).toHaveLength(0);
    }
  );

  it('keeps each tenant separate and never records successful mapping or explanation calls', async () => {
    await mapIDTokenClaims(context('tenant-a'), claims);
    await mapIDTokenClaims(context('tenant-b'), claims);
    await flush();
    expect(store.rows().map((row) => row.tenant_id)).toEqual(['tenant-a', 'tenant-b']);
    const ctx = context();
    ctx.clientMetadata.identity_mapping = { mode: 'none' };
    expect(await mapIDTokenClaims(ctx, claims)).toMatchObject({ ok: true });
    const failure: IdentityMappingFailureContext = {};
    await expect(
      applyOIDCIdentityMapping({
        adapter: store.adapter,
        env: ctx.env,
        tenantId: 'tenant-a',
        clientId: 'app-a',
        selector: { fieldMappingSetId: 'set-a' },
        claims,
        trace: {},
        failureContext: failure,
      })
    ).rejects.toBeDefined();
    expect(failure).toEqual({ code: 'set_missing', tier: 'client', setId: 'set-a' });
    await flush();
    expect(store.rows()).toHaveLength(2);
    expect(store.rows().every((row) => row.count === 1)).toBe(true);
  });
});
