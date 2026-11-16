import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TENANT } from './helpers/admin-authority-fixture';
import { adminOpenApiSchemas, shapeErrors } from './helpers/openapi-shape';
import { SETS, setup } from './helpers/saml-facade-fixture';

const consentPreview = z.object({
  nameid: z.object({ status: z.string() }).optional(),
  items: z.array(z.unknown()),
  deferred_attributes: z.array(z.string()).optional(),
});
const releasedAttributes = z.object({
  attributes: z.array(z.object({ values: z.array(z.string()) })),
});

describe('SAML Mapping Set facade and release explanation', () => {
  it('creates, reads, updates and deletes a SAML set with one shared IdP activation', async () => {
    const t = await setup();
    const created = await t.create();
    const read = await t.call('GET', `${SETS}/${created.id}`);
    expect(read.status).toBe(200);
    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.MappingSetDetailResponse, read.json)).toEqual([]);
    expect(read.json).toMatchObject({
      protocol: 'saml',
      destination_profile_id: 'saml-profile',
      destination_profile: {
        destinationType: 'saml',
      },
    });
    expect(
      z
        .object({ fields: z.array(z.object({ key: z.string() })) })
        .parse(read.json.destination_profile)
        .fields.map((field) => field.key)
    ).toContain('mail');
    const updated = await t.call(
      'PUT',
      `${SETS}/${created.id}`,
      t.body(t.content([t.copy('mail', 'nickname')])),
      { 'If-Match': `"${z.string().parse(read.json.content_version)}"` }
    );
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);
    const active = await t.adapter.query<{ activation_scope_json: string }>(
      "SELECT activation_scope_json FROM field_mapping_activations WHERE field_mapping_set_id = ? AND lifecycle_state = 'active'",
      [created.id]
    );
    expect(active.map((row) => z.unknown().parse(JSON.parse(row.activation_scope_json)))).toEqual([
      { protocol: 'saml', role: 'idp' },
    ]);
    expect((await t.call('DELETE', `${SETS}/${created.id}`)).status).toBe(200);
    expect((await t.call('GET', `${SETS}/${created.id}`)).status).toBe(404);
  });

  it('rejects mixed profiles and cross-protocol targets before writing', async () => {
    const t = await setup();
    for (const rules of [
      [t.copy('mail'), t.copy('optional', 'nickname', 'saml.attribute', 'saml-other')],
      [t.copy('mail', 'email', 'oidc.claim')],
      [t.copy('email', 'email', 'saml.attribute', 'oidc-profile')],
      [
        {
          ...t.copy('mail'),
          edges: [
            {
              sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'email' },
              targetRef: { side: 'destination', namespace: 'saml.attribute', path: 'mail' },
            },
          ],
        },
      ],
    ]) {
      expect((await t.call('POST', SETS, t.body(t.content(rules)))).status).toBe(400);
    }
    expect(await t.adapter.query('SELECT id FROM field_mapping_sets')).toEqual([]);
  });

  it('confirms two SP references and saves once for both, refusing profile/protocol changes', async () => {
    const t = await setup();
    const created = await t.create();
    t.bind(created.id, 'sp-a');
    t.bind(created.id, 'sp-b');
    const draft = t.content([
      t.copy('mail', 'nickname'),
      t.copy('subject', 'nickname', 'saml.nameid'),
    ]);
    const refused = await t.call('PUT', `${SETS}/${created.id}`, t.body(draft));
    expect(refused.status).toBe(409);
    expect(refused.json.references).toMatchObject({ count: 2 });
    expect(
      (await t.call('PUT', `${SETS}/${created.id}`, t.body(draft, { confirm_impact: 2 }))).status
    ).toBe(200);
    for (const rules of [
      [t.copy('mail', 'email', 'saml.attribute', 'saml-other')],
      [t.copy('email', 'email', 'oidc.claim', 'oidc-profile')],
    ]) {
      const changed = await t.call(
        'PUT',
        `${SETS}/${created.id}`,
        t.body(t.content(rules), { confirm_impact: 2 })
      );
      expect(changed.status, JSON.stringify(changed.json)).toBe(409);
      expect(
        z
          .object({ items: z.array(z.object({ providerId: z.string() })) })
          .parse(changed.json.references)
          .items.map((item) => item.providerId)
          .sort()
      ).toEqual(['sp-a', 'sp-b']);
    }
    const a = await t.explain(t.config(created.id, 'https://sp-a.example.test'));
    const b = await t.explain(t.config(created.id, 'https://sp-b.example.test'));
    const attributesA = releasedAttributes.parse(a.json.after_consent).attributes;
    const attributesB = releasedAttributes.parse(b.json.after_consent).attributes;
    expect(attributesA).toEqual(attributesB);
    expect(attributesA[0].values).toEqual(['legacy-subject']);
  });

  it('validates active compiled SAML bindings and exact field policy coverage', async () => {
    const t = await setup();
    const created = await t.create();
    expect(await t.validate(t.config(created.id))).toBeNull();
    const missing = t.config(created.id);
    missing.identityMapping = {
      fieldMappingSetId: created.id,
      destinationFieldPolicies: { mail: 'required' },
    };
    expect(await t.validate(missing)).toEqual({
      field: 'identityMapping.destinationFieldPolicies',
    });
    t.db
      .prepare(
        "UPDATE compiled_mapping_snapshots SET lifecycle_state = 'draft' WHERE field_mapping_version_id = ?"
      )
      .run(created.version_id);
    expect(await t.validate(t.config(created.id))).toEqual({
      field: 'identityMapping.fieldMappingSetId',
    });
  });

  it.each([
    ['fieldKey', 'catalogEntryId'],
    ['nodeId', 'catalog_entry_id'],
  ])('normalizes %s and %s for SP binding and release', async (pathKey, catalogKey) => {
    const t = await setup();
    const created = await t.create();
    const target = JSON.stringify({
      side: 'destination',
      namespace: 'saml.attribute',
      profileId: 'saml-profile',
      [pathKey]: 'mail',
      [catalogKey]: 'dest.saml.mail',
    });
    t.db
      .prepare(
        `UPDATE mapping_rule_edges SET target_ref_json = ? WHERE rule_id IN
         (SELECT id FROM mapping_rules WHERE field_mapping_version_id = ? AND rule_key = 'rule-mail')`
      )
      .run(target, created.version_id);
    t.db
      .prepare(
        "UPDATE mapping_rules SET target_ref_json = ? WHERE field_mapping_version_id = ? AND rule_key = 'rule-mail'"
      )
      .run(target, created.version_id);
    const config = t.bind(created.id, 'alias-sp');
    if (!config.identityMapping) throw new Error('Missing fixture identity mapping');
    config.identityMapping.attributeDescriptors = { 'dest.saml.mail': { name: 'mail' } };
    t.core
      .prepare('UPDATE identity_providers SET config_json = ? WHERE id = ?')
      .run(JSON.stringify(config), 'alias-sp');
    expect(await t.validate(config)).toBeNull();
    const explained = await t.explain(config);
    expect(explained.status, JSON.stringify(explained.json)).toBe(200);
    expect(explained.json.after_consent, JSON.stringify(explained.json)).toMatchObject({
      attributes: [{ name: 'mail', values: ['fixture@example.test'] }],
    });
    config.identityMapping.attributeDescriptors = { 'dest.saml.mail': { name: 'renamed-mail' } };
    expect(await t.validate(config)).toEqual({ field: 'identityMapping.attributeDescriptors' });
    t.db
      .prepare("UPDATE field_catalog_entries SET classification = 'pii' WHERE path = 'email'")
      .run();
    const snapshot = await t.adapter.queryOne<{ id: string }>(
      'SELECT id FROM compiled_mapping_snapshots WHERE field_mapping_version_id = ?',
      [created.version_id]
    );
    if (!snapshot) throw new Error('Missing fixture snapshot');
    await expect(
      t.repository.activateFieldMappingVersion(TENANT, created.id, created.version_id, {
        snapshotId: snapshot.id,
        activationScope: { protocol: 'saml', role: 'idp' },
      })
    ).rejects.toThrow('cannot lower classification');
  });

  it('explains plain-copy NameID, hidden fields and consent before/after approval', async () => {
    const t = await setup();
    const created = await t.create();
    const sp = t.bind(created.id, 'sp');
    const result = await t.explain(sp);
    expect(result.status).toBe(200);
    const schemas = adminOpenApiSchemas();
    expect(shapeErrors(schemas, schemas.IdentityMappingExplainResponse, result.json)).toEqual([]);
    const before = consentPreview.parse(result.json.before_consent);
    expect(before.nameid?.status).toBe('deferred');
    expect(before.items[0]).toMatchObject({
      kind: 'nameid',
      required: true,
      deferred: true,
    });
    expect(result.json.after_consent).toMatchObject({
      status: 'released',
      nameid: {
        status: 'released',
        value: 'legacy-subject',
        format: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      },
      attributes: [{ name: 'mail', values: ['fixture@example.test'] }],
    });
    expect(result.json.fields).toContainEqual({ field: 'subject', policy: 'hidden' });
    const denied = await t.explain(sp, 'none');
    expect(denied.json.after_consent).toMatchObject({
      status: 'awaiting_consent',
      attributes: [],
      nameid: { status: 'suppressed', reasons: ['consent_missing'] },
    });
  });

  it('copies a sensitive NameID using the native profile subject definition without an attribute policy', async () => {
    const t = await setup();
    t.db
      .prepare(
        "UPDATE field_catalog_entries SET classification = 'pii' WHERE tenant_id = ? AND path = 'email'"
      )
      .run(TENANT);
    t.db
      .prepare(
        "UPDATE destination_profile_versions SET schema_json = json_remove(schema_json, '$.attributes[1]') WHERE profile_id = ?"
      )
      .run('saml-profile');
    const draft = t.content([
      t.copy('mail', 'nickname'),
      t.copy('subject', 'email', 'saml.nameid'),
    ]);
    const refused = await t.call('POST', SETS, t.body(draft));
    expect(refused.status, JSON.stringify(refused.json)).toBe(400);
    expect(refused.json.error_description).toContain('cannot lower classification');
    t.db
      .prepare(
        "UPDATE destination_profile_versions SET schema_json = json_set(schema_json, '$.nameId.classification', 'pii') WHERE profile_id = ?"
      )
      .run('saml-profile');
    const created = await t.create(draft);
    const sp = t.bind(created.id, 'native-nameid');
    sp.identityMapping = {
      fieldMappingSetId: created.id,
      destinationFieldPolicies: { mail: 'required', optional: 'hidden' },
    };
    t.core
      .prepare('UPDATE identity_providers SET config_json = ? WHERE id = ?')
      .run(JSON.stringify(sp), 'native-nameid');
    expect(await t.validate(sp)).toBeNull();
    const read = await t.call('GET', `${SETS}/${created.id}`);
    expect(read.json.destination_profile).toMatchObject({ nameId: { classification: 'pii' } });
    const released = await t.explain(sp);
    expect(released.json.after_consent, JSON.stringify(released.json)).toMatchObject({
      status: 'released',
      nameid: { status: 'released', value: 'fixture@example.test' },
    });
  });

  it('rejects binding an OIDC release set to a SAML SP', async () => {
    const t = await setup();
    const created = await t.create(
      t.content([t.copy('email', 'email', 'oidc.claim', 'oidc-profile')])
    );
    expect(await t.validate(t.config(created.id))).toEqual({
      field: 'identityMapping.fieldMappingSetId',
    });
  });

  it('reports required missing attributes using the release pipeline', async () => {
    const t = await setup();
    const created = await t.create();
    const sp = t.bind(created.id, 'sp');
    t.db
      .prepare('UPDATE identity_mapping_test_users SET attributes_json = ?')
      .run(JSON.stringify({ nickname: 'legacy-subject' }));
    const result = await t.explain(sp);
    expect(result.json.after_consent).toMatchObject({
      status: 'failed',
      attributes: [],
      error: { code: 'required_field_missing', fields: ['mail'] },
    });
  });

  it('defers identifier attributes and suppresses fixture identifiers after consent', async () => {
    const t = await setup();
    const created = await t.create(
      t.content([
        t.copy('mail'),
        t.identifier('subject'),
        t.identifier('optional', 'saml.attribute'),
      ])
    );
    const sp = t.bind(created.id, 'sp');
    sp.identityMapping = {
      ...sp.identityMapping,
      destinationFieldPolicies: { mail: 'required', subject: 'hidden', optional: 'optional' },
    };
    t.core
      .prepare('UPDATE identity_providers SET config_json = ? WHERE id = ?')
      .run(JSON.stringify(sp), 'sp');
    const result = await t.explain(sp);
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    const before = consentPreview.parse(result.json.before_consent);
    expect(before.deferred_attributes).toEqual(['optional']);
    expect(before.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'attribute', deferred: true })])
    );
    expect(JSON.stringify(result.json)).not.toContain('authrim-deferred-identifier');
    expect(result.json.after_consent).toMatchObject({
      status: 'failed',
      attributes: [],
      nameid: { status: 'suppressed', reasons: ['policy.test_user_identifier_not_evaluated'] },
    });
  });

  it('rejects sector audiences, framed NameIDs and transformed NameID copies', async () => {
    const t = await setup();
    const transformedCopy = {
      ...t.copy('subject', 'nickname', 'saml.nameid'),
      transforms: [{ operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
      output: { stepIndex: 0 },
    };
    for (const rule of [
      t.identifier('subject', 'saml.nameid', { audience: 'sector' }),
      t.identifier('subject', 'saml.nameid', { format: 'saml_targeted_id' }),
      transformedCopy,
    ]) {
      const result = await t.call('POST', SETS, t.body(t.content([t.copy('mail'), rule])));
      expect(result.status, JSON.stringify(result.json)).toBe(400);
    }
  });

  it('previews a changed identifier graph with no source edges', async () => {
    const t = await setup();
    const created = await t.create(t.content([t.copy('mail'), t.identifier('subject')]));
    t.bind(created.id, 'sp');
    const result = await t.call('POST', `${SETS}/${created.id}/preview-change`, {
      content: t.content([
        t.copy('mail'),
        t.identifier('subject', 'saml.nameid', { algorithm: 'keycloak_sha256' }),
      ]),
    });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    const providers = z
      .array(
        z.object({
          changes: z.array(
            z.object({
              namespace: z.string(),
              claim: z.string(),
              kind: z.string(),
            })
          ),
        })
      )
      .parse(result.json.sps);
    expect(providers[0].changes).toContainEqual(
      expect.objectContaining({
        namespace: 'saml.nameid',
        claim: 'subject',
        kind: 'transform_changed',
      })
    );
  });

  it('previews graph dependency changes for each shared SP including NameID', async () => {
    const t = await setup();
    const created = await t.create();
    t.bind(created.id, 'sp-a');
    t.bind(created.id, 'sp-b');
    const draft = t.content([
      t.copy('mail', 'nickname'),
      t.copy('subject', 'email', 'saml.nameid'),
    ]);
    const result = await t.call('POST', `${SETS}/${created.id}/preview-change`, { content: draft });
    expect(result.status, JSON.stringify(result.json)).toBe(200);
    expect(result.json).toMatchObject({
      protocol: 'saml',
      references: { count: 2 },
      usage_complete: true,
    });
    const schemas = adminOpenApiSchemas();
    expect(
      shapeErrors(schemas, schemas.IdentityMappingSetChangePreviewResponse, result.json)
    ).toEqual([]);
    expect(result.json.sps).toHaveLength(2);
    for (const sp of z.array(z.object({ changes: z.array(z.unknown()) })).parse(result.json.sps)) {
      expect(sp.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claim: 'mail',
            kind: 'source_changed',
            namespace: 'saml.attribute',
          }),
          expect.objectContaining({
            claim: 'subject',
            kind: 'source_changed',
            namespace: 'saml.nameid',
          }),
        ])
      );
    }
  });
});
