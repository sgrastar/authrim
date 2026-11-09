import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../../db';
import { SavedGroupInputReader, loadGroupFields } from '../inputs';
import { BUILTIN_GROUP_FIELDS, type GroupPlan } from '../model';

const account = {
  id: 'account-a',
  account_type: 'user',
  registration_state: 'complete',
  directory_publication_state: 'active',
  lifecycle_state: 'active',
};
const schemas = [
  {
    id: 'schema-score',
    field_key: 'score',
    field_type: 'number',
    cardinality: 'single',
    is_pii: 0,
    schema_version: 2,
  },
  {
    id: 'schema-flag',
    field_key: 'flag',
    field_type: 'boolean',
    cardinality: 'single',
    is_pii: 0,
    schema_version: 1,
  },
  {
    id: 'schema-secret',
    field_key: 'secret',
    field_type: 'string',
    cardinality: 'single',
    is_pii: 1,
    schema_version: 1,
  },
];

function database() {
  const query = vi.fn();
  const queryOne = vi.fn();
  const batch = vi.fn();
  return {
    adapter: { query, queryOne, batch } as unknown as DatabaseAdapter,
    query,
    queryOne,
    batch,
  };
}

function plan(keys: string[], groups: GroupPlan['groups'] = []): GroupPlan {
  return {
    tenantId: 'tenant-a',
    groups,
    fields: {
      ...BUILTIN_GROUP_FIELDS,
      'custom.score': { type: 'number', schemaId: 'schema-score', schemaVersion: 2, pii: false },
      'custom.flag': { type: 'boolean', schemaId: 'schema-flag', schemaVersion: 1, pii: false },
      'custom.secret': { type: 'string', schemaId: 'schema-secret', schemaVersion: 1, pii: true },
    },
    nodes: {},
    order: [],
    roots: {},
    attributes: Object.fromEntries(keys.map((key) => [key, []])),
    dependents: {},
    dependencies: {},
  };
}

function reader() {
  const metadata = database();
  const core = database();
  const pii = database();
  const instance = new SavedGroupInputReader(
    metadata.adapter,
    core.adapter,
    pii.adapter,
    'tenant-a',
    'user-a'
  );
  return { instance, metadata, core, pii };
}

describe('dynamic group field catalog', () => {
  it('loads only supported active custom schemas and retains PII and version metadata', async () => {
    const metadata = database();
    metadata.query.mockResolvedValue([
      ...schemas,
      {
        id: 'schema-enum',
        field_key: 'tags',
        field_type: 'enum',
        cardinality: 'multi',
        is_pii: 0,
        schema_version: 3,
      },
      { ...schemas[0], field_key: 'untrusted', field_type: 'object' },
    ]);

    const fields = await loadGroupFields(metadata.adapter, 'tenant-a');

    expect(fields.email).toEqual(BUILTIN_GROUP_FIELDS.email);
    expect(fields['custom.score']).toEqual({
      type: 'number',
      schemaId: 'schema-score',
      schemaVersion: 2,
      pii: false,
    });
    expect(fields['custom.secret']).toMatchObject({ type: 'string', pii: true });
    expect(fields['custom.tags']).toMatchObject({ type: 'string[]', schemaVersion: 3 });
    expect(fields).not.toHaveProperty('custom.untrusted');
    expect(metadata.query).toHaveBeenCalledWith(
      expect.stringContaining("operation_status = 'active' ORDER BY field_key LIMIT 1000"),
      ['tenant-a'],
      { consistencyClass: 'primary_required' }
    );
  });
});

describe('SavedGroupInputReader version fence', () => {
  it('verifies the resolved account route before reading primary revisions', async () => {
    const metadata = database();
    const core = database();
    const pii = database();
    const verify = vi.fn(async () => undefined);
    const instance = new SavedGroupInputReader(
      metadata.adapter,
      core.adapter,
      pii.adapter,
      'tenant-a',
      'user-a',
      { stamp: 'route-42', verify }
    );
    core.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('service_group_write_boundaries') ? null : { revision: 5 }
    );
    pii.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('service_group_write_boundaries') ? null : { revision: 6 }
    );
    metadata.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('service_group_epoch') ? { revision: 8 } : { revision: 7 }
    );

    await expect(instance.version()).resolves.toEqual({
      route: 'route-42',
      core: 5,
      pii: 6,
      metadata: 7,
      epoch: 8,
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(core.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('service_group_write_boundaries'),
      ['tenant-a', 'user-a'],
      { consistencyClass: 'primary_required' }
    );
  });

  it('blocks evaluation while either database has an unsettled write', async () => {
    const { instance, core, pii, metadata } = reader();
    core.queryOne.mockResolvedValue(null);
    pii.queryOne.mockResolvedValue({ id: 'boundary-1' });

    await expect(instance.version()).rejects.toThrow('group_input_write_unsettled');
    expect(metadata.queryOne).not.toHaveBeenCalled();
  });
});

describe('SavedGroupInputReader attribute loading', () => {
  it('rejects a cross-tenant plan before any database query', async () => {
    const { instance, metadata, core, pii } = reader();
    await expect(instance.load({ ...plan(['email']), tenantId: 'tenant-b' })).rejects.toThrow(
      'group_tenant_mismatch'
    );
    expect(metadata.query).not.toHaveBeenCalled();
    expect(core.queryOne).not.toHaveBeenCalled();
    expect(pii.query).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'group_subject_unavailable'],
    [{ ...account, account_type: 'service' }, 'group_subject_unavailable'],
    [{ ...account, lifecycle_state: 'suspended' }, 'group_subject_not_active'],
    [{ ...account, directory_publication_state: 'pending' }, 'group_subject_not_active'],
  ])(
    'rejects an unavailable or inactive account before reading attributes: %#',
    async (row, error) => {
      const { instance, metadata, core, pii } = reader();
      core.queryOne.mockResolvedValue(row);

      await expect(instance.load(plan(['email']))).rejects.toThrow(error);
      expect(metadata.query).not.toHaveBeenCalled();
      expect(pii.query).not.toHaveBeenCalled();
    }
  );

  it('rejects a changed custom schema before reading private values', async () => {
    const { instance, metadata, core, pii } = reader();
    core.queryOne.mockResolvedValue(account);
    metadata.query.mockResolvedValue([{ ...schemas[0], schema_version: 3 }]);

    await expect(instance.load(plan(['custom.score']))).rejects.toThrow(
      'group_attribute_schema_changed'
    );
    expect(pii.query).not.toHaveBeenCalled();
    expect(core.query).not.toHaveBeenCalled();
  });

  it('does not read an unverified email from PII storage', async () => {
    const { instance, metadata, core, pii } = reader();
    core.queryOne.mockResolvedValue(account);
    core.query.mockResolvedValue([{ verification_state: 'unverified', value_storage_ref: 'ref' }]);
    metadata.query.mockResolvedValue([]);

    const result = await instance.load(plan(['email', 'email_domain', 'email_verified']));

    expect(result.attributes).toEqual({ registration_state: 'complete', email_verified: false });
    expect(pii.query).not.toHaveBeenCalled();
    expect(core.query).toHaveBeenCalledWith(
      expect.stringContaining("contact_type = 'email'"),
      ['tenant-a', 'account-a'],
      { consistencyClass: 'primary_required' }
    );
  });

  it('loads a verified email and strictly decodes custom fields from their storage boundaries', async () => {
    const { instance, metadata, core, pii } = reader();
    core.queryOne.mockResolvedValue(account);
    core.query.mockImplementation(async (sql: string) => {
      if (sql.includes('contact_points'))
        return [{ verification_state: 'verified', value_storage_ref: 'ref' }];
      return [
        { field_name: 'score', field_value: '12.5' },
        { field_name: 'flag', field_value: 'yes' },
      ];
    });
    pii.query.mockResolvedValue([
      { value_key: 'email', value_json: JSON.stringify('person@example.test') },
      { value_key: 'address_country', value_json: JSON.stringify('JP') },
      { value_key: 'custom_attribute:secret', value_json: JSON.stringify('sensitive') },
    ]);
    metadata.query.mockImplementation(async (sql: string) =>
      sql.includes('custom_claim_schemas') ? schemas : []
    );

    const result = await instance.load(
      plan([
        'email',
        'email_domain',
        'email_verified',
        'country',
        'custom.score',
        'custom.flag',
        'custom.secret',
      ])
    );

    expect(result.attributes).toEqual({
      registration_state: 'complete',
      email_verified: true,
      email: 'person@example.test',
      email_domain: 'example.test',
      country: 'JP',
      'custom.score': 12.5,
      'custom.flag': undefined,
      'custom.secret': 'sensitive',
    });
    expect(pii.query).toHaveBeenCalledWith(
      expect.stringContaining("owner_type = 'runtime_user'"),
      expect.arrayContaining([
        'tenant-a',
        'user-a',
        'email',
        'address_country',
        'custom_attribute:secret',
      ]),
      { consistencyClass: 'primary_required' }
    );
    expect(
      core.query.mock.calls.find((call) => String(call[0]).includes('user_custom_fields'))?.[1]
    ).toEqual(['tenant-a', 'user-a', 'score', 'flag']);
  });

  it('marks an unknown SCIM role as unknown instead of inferring a membership', async () => {
    const { instance, metadata, core } = reader();
    core.queryOne.mockResolvedValue(account);
    metadata.query.mockImplementation(async (sql: string) => {
      if (sql.includes('service_group_manual')) return [{ group_id: 'manual-group' }];
      return [];
    });
    const groups = [
      { id: 'manual-group', scimRoleId: undefined },
      { id: 'scim-group', scimRoleId: 'missing-role' },
    ] as GroupPlan['groups'];

    const result = await instance.load(plan([], groups));

    expect(result.sources).toEqual({
      'manual-group': { manual: true, scim: false },
      'scim-group': { manual: false, scim: 'unknown' },
    });
  });
});

describe('SavedGroupInputReader recovery validation', () => {
  it('refuses duplicate or non-failed boundaries without publishing an audit event', async () => {
    const { instance, core, pii } = reader();
    await expect(instance.acceptFailedWrites([], 'admin-a')).rejects.toThrow(
      'group_recovery_invalid'
    );
    await expect(
      instance.acceptFailedWrites(['boundary-1', 'boundary-1'], 'admin-a')
    ).rejects.toThrow('group_recovery_invalid');
    core.query.mockResolvedValue([
      { id: 'boundary-1', operation: 'update', status: 'running', created_at: 1 },
    ]);
    pii.query.mockResolvedValue([]);
    await expect(instance.acceptFailedWrites(['boundary-1'], 'admin-a')).rejects.toThrow(
      'group_recovery_conflict'
    );
    expect(core.batch).not.toHaveBeenCalled();
    expect(pii.batch).not.toHaveBeenCalled();
  });
});
