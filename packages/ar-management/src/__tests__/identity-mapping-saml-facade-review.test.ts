import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GLOBAL_SUPER_ADMIN, signIn, TENANT } from './helpers/admin-authority-fixture';
import { seedDestinationProfile } from './helpers/identity-mapping-seed';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';
import { SETS, setup } from './helpers/saml-facade-fixture';

describe('SAML facade review regressions', () => {
  it('binds a platform-owned set and releases its attributes and NameID in the calling tenant', async () => {
    const t = await setup();
    seedDestinationProfile(t.db, {
      owner: 'platform',
      id: 'platform-saml',
      destinationType: 'saml',
      attributes: ['mail', 'subject', 'optional'],
    });
    t.db
      .prepare('UPDATE destination_profile_versions SET schema_json = ? WHERE profile_id = ?')
      .run(
        JSON.stringify({
          destinationType: 'saml',
          nameId: {
            format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
            classification: 'pii',
          },
          attributes: ['mail', 'subject', 'optional'].map((name) => ({
            name,
            classification: 'pii',
          })),
        }),
        'platform-saml'
      );
    const result = await t.callAs(signIn(t.db, GLOBAL_SUPER_ADMIN).cookie, 'POST', SETS, {
      ...t.body(),
      owner_scope_type: 'platform',
      content: {
        catalogVersionId: 'platform_default_canonical_catalog_v1',
        rules: [
          t.copy('mail', 'email', 'saml.attribute', 'platform-saml'),
          t.copy('subject', 'nickname', 'saml.nameid', 'platform-saml'),
        ],
      },
    });
    expect(result.status, JSON.stringify(result.json)).toBe(201);
    const { id } = z.object({ id: z.string() }).parse(result.json);
    const sp = t.bind(id, 'platform-sp');
    expect(await t.validate(sp)).toBeNull();
    const released = await t.explain(sp);
    expect(released.status, JSON.stringify(released.json)).toBe(200);
    expect(released.json.after_consent, JSON.stringify(released.json)).toMatchObject({
      status: 'released',
      attributes: [{ name: 'mail', values: ['fixture@example.test'] }],
      nameid: { status: 'released', value: 'legacy-subject' },
    });
    // An active set belonging to another tenant is unavailable through both entry points.
    t.db.prepare("UPDATE field_mapping_sets SET tenant_id = 'tenant-b' WHERE id = ?").run(id);
    expect(await t.validate(sp)).toEqual({ field: 'identityMapping.fieldMappingSetId' });
    expect((await t.explain(sp)).json.after_consent).toMatchObject({ status: 'failed' });
  });

  it('places custom fixture fields where attribute and NameID sources read them', async () => {
    const t = await setup();
    const source = { side: 'source', namespace: 'authrim.custom_fields', path: 'employee_code' };
    const catalog = await t.repository.createCatalog(TENANT, {
      catalogKey: 'custom-fixture',
      displayName: 'Custom fixture',
      versionLabel: 'v1',
      entries: [
        {
          id: 'custom.employee_code',
          namespace: source.namespace,
          path: source.path,
          targetType: 'canonical',
          valueType: 'string',
          cardinality: 'single',
          classification: 'internal',
        },
      ],
    });
    const rules = [t.copy('mail'), t.copy('subject', 'email', 'saml.nameid')].map((rule) => ({
      ...rule,
      edges: rule.edges.map((edge) => ({ ...edge, sourceRef: source })),
    }));
    const created = await t.create({ catalogVersionId: catalog.activeVersion.id, rules });
    t.db
      .prepare('UPDATE identity_mapping_test_users SET attributes_json = ? WHERE tenant_id = ?')
      .run(JSON.stringify({ employee_code: 'staff-123' }), TENANT);
    const result = await t.explain(t.bind(created.id, 'custom-sp'));
    expect(result.json.after_consent, JSON.stringify(result.json)).toMatchObject({
      status: 'released',
      attributes: [{ name: 'mail', values: ['staff-123'] }],
      nameid: { status: 'released', value: 'staff-123' },
    });
  });

  it('enriches a copied institution NameID and never reads fixture account evidence', async () => {
    const t = await setup();
    t.settings.get.mockImplementation(async (key) =>
      key.endsWith(':institution')
        ? JSON.stringify({ 'institution.scopes': 'example.ac.jp' })
        : null
    );
    const catalog = await t.repository.createCatalog(TENANT, {
      catalogKey: 'institution-fixture',
      displayName: 'Institution fixture',
      versionLabel: 'v1',
      entries: ['email', 'schac_home_organization', 'assurance_ial'].map((path) => ({
        id: `institution.${path}`,
        namespace: 'authrim.profile',
        path,
        targetType: 'canonical',
        valueType: 'string',
        cardinality: 'single',
        classification: 'internal',
      })),
    });
    const created = await t.create({
      catalogVersionId: catalog.activeVersion.id,
      rules: [t.copy('mail'), t.copy('subject', 'schac_home_organization', 'saml.nameid')],
    });
    const sp = t.bind(created.id, 'institution-sp');
    const evidenceRead = vi.spyOn(t.core, 'prepare');
    const result = await t.explain(sp);
    expect(result.json.after_consent, JSON.stringify(result.json)).toMatchObject({
      status: 'released',
      nameid: { value: 'example.ac.jp' },
    });
    const changed = await t.call(
      'PUT',
      `${SETS}/${created.id}`,
      t.body(
        {
          catalogVersionId: catalog.activeVersion.id,
          rules: [t.copy('mail'), t.copy('subject', 'assurance_ial', 'saml.nameid')],
        },
        { confirm_impact: 1 }
      )
    );
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    t.db
      .prepare('UPDATE identity_mapping_test_users SET attributes_json = ? WHERE tenant_id = ?')
      .run(JSON.stringify({ email: 'fixture@example.test', assurance_ial: 'IAL3' }), TENANT);
    // Fixture claims never stand in for trusted account evidence, even for a NameID source.
    expect((await t.explain(sp)).json.after_consent).toMatchObject({
      status: 'failed',
      nameid: { status: 'failed' },
    });
    expect(evidenceRead.mock.calls.some(([sql]) => sql.includes('assurance_evidence'))).toBe(false);
  });

  it('marks federation-resolved SPs as unenumerated even when the reference scan is complete', async () => {
    const t = await setup();
    const created = await t.create();
    t.bind(created.id, 'known-sp');
    t.db
      .prepare(
        `INSERT INTO federation_trust_sources
      (id, tenant_id, source_type, source_key, display_name, lifecycle_state, protocol_payload_json, created_at, updated_at)
      VALUES ('review-federation', ?, 'saml_aggregate', 'review', 'Federation', 'active', ?, 1, 1)`
      )
      .run(
        TENANT,
        JSON.stringify({
          runtimeResolution: {
            mode: 'automatic',
            roles: ['saml_sp'],
            spFieldMappingSetId: created.id,
          },
        })
      );
    const preview = await t.call('POST', `${SETS}/${created.id}/preview-change`, {
      content: t.content([
        t.copy('mail', 'nickname'),
        t.copy('subject', 'nickname', 'saml.nameid'),
      ]),
    });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json).toMatchObject({
      references: { count: 2, scan_complete: true },
      usage_complete: false,
      unresolved_sp_references: [
        {
          tenant_id: TENANT,
          trust_source_id: 'review-federation',
          reason: 'federation_entities_not_enumerated',
        },
      ],
    });
    expect(preview.json.sps).toHaveLength(1);
    const schemas = adminOpenApiSchemas();
    expect(
      shapeErrors(schemas, schemas.IdentityMappingSetChangePreviewResponse, preview.json)
    ).toEqual([]);
  });
});
