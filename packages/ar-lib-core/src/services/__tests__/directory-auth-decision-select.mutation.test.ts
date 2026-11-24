import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter, ExecuteResult } from '../../db';
import {
  resolveDirectoryAuthMigrationDecision,
  type DirectoryAuthMigrationCampaignRow,
  type DirectoryAuthTargetFacts,
} from '../directory-auth';

vi.mock('../log-iceberg-emitter', () => ({ emitLogIcebergRow: vi.fn(async () => ({})) }));

interface Handlers {
  query?: (sql: string, params: unknown[]) => unknown[];
  queryOne?: (sql: string, params: unknown[]) => unknown;
  execute?: (sql: string, params: unknown[]) => ExecuteResult;
}

function makeAdapter(handlers: Handlers = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.query ? handlers.query(sql, params) : []
  );
  const queryOne = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.queryOne ? handlers.queryOne(sql, params) : null
  );
  const execute = vi.fn(async (sql: string, params: unknown[] = []) =>
    handlers.execute ? handlers.execute(sql, params) : { rowsAffected: 1, success: true }
  );
  const adapter = { query, queryOne, execute } as unknown as DatabaseAdapter;
  return { adapter, query, queryOne, execute };
}

function campaign(
  overrides: Partial<DirectoryAuthMigrationCampaignRow> = {}
): DirectoryAuthMigrationCampaignRow {
  return {
    id: 'damc_1',
    tenant_id: 'tenant-a',
    name: 'c',
    description: null,
    status: 'active',
    mode: 'prompt_passkey',
    passkey_prompt_mode: 'campaign_only',
    email_code_fallback_mode: 'tenant_default',
    grace_period_days: 30,
    transaction_ttl_seconds: 600,
    enforcement_start_mode: 'first_directory_login',
    target_policy_json: JSON.stringify({ type: 'all' }),
    is_template: 0,
    created_by: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const baseInput = {
  tenantId: 'tenant-a',
  userId: 'user-1',
  connectorId: 'conn-1',
  directorySubject: 'sub-1',
  now: 5000,
};

function resolveWith(
  campaigns: DirectoryAuthMigrationCampaignRow[],
  existing: unknown,
  input: Partial<Parameters<typeof resolveDirectoryAuthMigrationDecision>[1]> = {}
) {
  const h = makeAdapter({ query: () => campaigns, queryOne: () => existing });
  return {
    ...h,
    run: () => resolveDirectoryAuthMigrationDecision(h.adapter, { ...baseInput, ...input }),
  };
}

describe('resolveDirectoryAuthMigrationDecision: selection', () => {
  it('queries active non-template campaigns for the tenant and returns none when empty', async () => {
    const h = resolveWith([], null);
    const decision = await h.run();
    expect(decision).toStrictEqual({ action: 'none', campaign: null, userState: null });
    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, params] = h.query.mock.calls[0];
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('is_template = 0');
    expect(sql).toContain('LIMIT 20');
    expect(params).toStrictEqual(['tenant-a']);
    expect(h.queryOne).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid json', '{not json'],
    ['json array', '[]'],
    ['json null', 'null'],
    ['json string', '"all"'],
    ['empty object', '{}'],
    ['type other', JSON.stringify({ type: 'template', assignments: [] })],
    ['tenant_default false', JSON.stringify({ tenant_default: false })],
  ])('does not match campaign with target policy: %s', async (_name, raw) => {
    const h = resolveWith([campaign({ target_policy_json: raw })], null);
    expect(await h.run()).toStrictEqual({ action: 'none', campaign: null, userState: null });
  });

  it('matches type=all and tenant_default=true policies', async () => {
    for (const raw of [JSON.stringify({ type: 'all' }), JSON.stringify({ tenant_default: true })]) {
      const c = campaign({ target_policy_json: raw });
      const decision = await resolveWith([c], null).run();
      expect(decision.action).toBe('prompt_passkey');
      expect(decision.campaign).toStrictEqual(c);
    }
  });

  it('matches by user_ids and directory_subjects', async () => {
    const byUser = campaign({ target_policy_json: JSON.stringify({ user_ids: ['x', 'user-1'] }) });
    expect((await resolveWith([byUser], null).run()).action).toBe('prompt_passkey');
    const bySubject = campaign({
      target_policy_json: JSON.stringify({ directory_subjects: ['sub-1'] }),
    });
    expect((await resolveWith([bySubject], null).run()).action).toBe('prompt_passkey');
    const noUser = campaign({ target_policy_json: JSON.stringify({ user_ids: ['x'] }) });
    expect((await resolveWith([noUser], null).run()).action).toBe('none');
    const notArray = campaign({ target_policy_json: JSON.stringify({ user_ids: 'user-1' }) });
    expect((await resolveWith([notArray], null).run()).action).toBe('none');
    const noSubject = campaign({
      target_policy_json: JSON.stringify({ directory_subjects: 'sub-1' }),
    });
    expect((await resolveWith([noSubject], null).run()).action).toBe('none');
  });

  it('picks the first matching campaign in query order', async () => {
    const first = campaign({
      id: 'damc_no',
      target_policy_json: JSON.stringify({ user_ids: ['other'] }),
    });
    const second = campaign({ id: 'damc_yes' });
    const third = campaign({ id: 'damc_third' });
    const decision = await resolveWith([first, second, third], null).run();
    expect(decision.campaign?.id).toBe('damc_yes');
  });

  it.each([
    ['user_id match', { user_id: 'user-1' }, true],
    ['user_id mismatch', { user_id: 'other' }, false],
    ['subject without connector', { directory_subject: 'sub-1' }, true],
    [
      'subject with matching connector',
      { directory_subject: 'sub-1', connector_id: 'conn-1' },
      true,
    ],
    ['subject with other connector', { directory_subject: 'sub-1', connector_id: 'conn-x' }, false],
    ['subject mismatch', { directory_subject: 'sub-x' }, false],
    ['subject mismatch but user mismatch', { user_id: 'o', directory_subject: 'sub-x' }, false],
    ['user mismatch but subject match', { user_id: 'o', directory_subject: 'sub-1' }, true],
    ['numeric user_id ignored', { user_id: 1 }, false],
    ['numeric subject ignored', { directory_subject: 1 }, false],
    ['empty object', {}, false],
    [
      'empty connector string treated as unset',
      { directory_subject: 'sub-1', connector_id: '' },
      true,
    ],
    ['non-string connector ignored', { directory_subject: 'sub-1', connector_id: 5 }, true],
  ])('assignments: %s', async (_name, assignment, expected) => {
    const c = campaign({ target_policy_json: JSON.stringify({ assignments: [assignment] }) });
    const decision = await resolveWith([c], null).run();
    expect(decision.action).toBe(expected ? 'prompt_passkey' : 'none');
  });

  it.each([
    ['string', 'x'],
    ['null', null],
    ['array', ['user-1']],
    ['number', 3],
  ])('ignores %s assignment entries but still evaluates later ones', async (_name, bad) => {
    const c = campaign({
      target_policy_json: JSON.stringify({ assignments: [bad, { user_id: 'user-1' }] }),
    });
    expect((await resolveWith([c], null).run()).action).toBe('prompt_passkey');
    const c2 = campaign({ target_policy_json: JSON.stringify({ assignments: [bad] }) });
    expect((await resolveWith([c2], null).run()).action).toBe('none');
  });

  it('ignores non-array assignments', async () => {
    const c = campaign({
      target_policy_json: JSON.stringify({ assignments: { user_id: 'user-1' } }),
    });
    expect((await resolveWith([c], null).run()).action).toBe('none');
  });
});

describe('resolveDirectoryAuthMigrationDecision: cohort matching', () => {
  async function cohortKeyFor(policy: unknown, facts?: DirectoryAuthTargetFacts) {
    const c = campaign({ target_policy_json: JSON.stringify(policy) });
    const h = resolveWith([c], null, { directoryFacts: facts });
    const decision = await h.run();
    if (decision.action === 'none') return undefined;
    const insert = h.execute.mock.calls.find(([sql]) => sql.includes('INSERT INTO'));
    expect(insert).toBeDefined();
    return (insert as [string, unknown[]])[1][6];
  }

  it('never matches cohorts without directory facts', async () => {
    expect(
      await cohortKeyFor({ cohorts: [{ id: 'c1', group: 'Staff' }], directory_groups: ['Staff'] })
    ).toBeUndefined();
  });

  it('matches a cohort by group, using id or a derived key, trimming whitespace', async () => {
    const facts = { groups: ['Staff'] };
    expect(await cohortKeyFor({ cohorts: [{ id: 'c1', group: 'Staff' }] }, facts)).toBe('c1');
    expect(await cohortKeyFor({ cohorts: [{ group: 'Staff' }] }, facts)).toBe(
      'directory_group:Staff'
    );
    expect(await cohortKeyFor({ cohorts: [{ id: ' c1 ', group: ' Staff ' }] }, facts)).toBe('c1');
    expect(await cohortKeyFor({ cohorts: [{ id: '  ', group: 'Staff' }] }, facts)).toBe(
      'directory_group:Staff'
    );
    expect(await cohortKeyFor({ cohorts: [{ group: 'Other' }] }, facts)).toBeUndefined();
    expect(await cohortKeyFor({ cohorts: [{ group: '   ' }] }, facts)).toBeUndefined();
    expect(await cohortKeyFor({ cohorts: [{ group: 5 }] }, facts)).toBeUndefined();
  });

  it('collects group values from id, name, dn, display and display_name', async () => {
    const groups = [
      { id: 'g-id' },
      { name: 'g-name' },
      { dn: 'g-dn' },
      { display: 'g-display' },
      { display_name: 'g-display-name' },
      { id: '', name: 'g-empty-skipped' },
    ];
    for (const value of ['g-id', 'g-name', 'g-dn', 'g-display', 'g-display-name']) {
      expect(await cohortKeyFor({ cohorts: [{ group: value }] }, { groups })).toBe(
        `directory_group:${value}`
      );
    }
    expect(await cohortKeyFor({ cohorts: [{ group: '' }] }, { groups })).toBeUndefined();
    // facts without groups
    expect(await cohortKeyFor({ cohorts: [{ group: 'x' }] }, {})).toBeUndefined();
  });

  it('matches a directory_group source cohort only with that source', async () => {
    const facts = { groups: ['Eng'] };
    expect(
      await cohortKeyFor({ cohorts: [{ source: 'directory_group', value: 'Eng' }] }, facts)
    ).toBe('directory_group:Eng');
    expect(
      await cohortKeyFor(
        { cohorts: [{ id: 'eng', source: 'directory_group', value: ' Eng ' }] },
        facts
      )
    ).toBe('eng');
    expect(
      await cohortKeyFor({ cohorts: [{ source: 'other', value: 'Eng' }] }, facts)
    ).toBeUndefined();
    expect(await cohortKeyFor({ cohorts: [{ value: 'Eng' }] }, facts)).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [{ source: 'directory_group', value: 'Nope' }] }, facts)
    ).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [{ source: 'directory_group', value: '' }] }, facts)
    ).toBeUndefined();
  });

  it('matches attribute cohorts for string, array and {value} attributes', async () => {
    const cohort = { attribute: 'dept', value: 'x' };
    const expectKey = 'directory_attribute:dept:x';
    expect(await cohortKeyFor({ cohorts: [cohort] }, { attributes: { dept: 'x' } })).toBe(
      expectKey
    );
    expect(await cohortKeyFor({ cohorts: [cohort] }, { attributes: { dept: ['a', 'x'] } })).toBe(
      expectKey
    );
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { attributes: { dept: { value: 'x' } } })
    ).toBe(expectKey);
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { attributes: { dept: { value: ['x', 'y'] } } })
    ).toBe(expectKey);
    expect(
      await cohortKeyFor({ cohorts: [{ ...cohort, id: 'dept-x' }] }, { attributes: { dept: 'x' } })
    ).toBe('dept-x');
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { attributes: { dept: 'y' } })
    ).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { attributes: { dept: ['y'] } })
    ).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { attributes: { dept: 5 as never } })
    ).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { attributes: { other: 'x' } })
    ).toBeUndefined();
    expect(await cohortKeyFor({ cohorts: [cohort] }, {})).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [{ attribute: 'dept' }] }, { attributes: { dept: 'x' } })
    ).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [{ attribute: '', value: 'x' }] }, { attributes: { '': 'x' } })
    ).toBeUndefined();
    expect(
      await cohortKeyFor(
        { cohorts: [{ attribute: ' dept ', value: ' x ' }] },
        { attributes: { dept: 'x' } }
      )
    ).toBe(expectKey);
  });

  it('matches profile attribute cohorts', async () => {
    const cohort = { profile_attribute: 'tier', value: 'gold' };
    expect(await cohortKeyFor({ cohorts: [cohort] }, { profileAttributes: { tier: 'gold' } })).toBe(
      'profile_attribute:tier:gold'
    );
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { profileAttributes: { tier: ['silver', 'gold'] } })
    ).toBe('profile_attribute:tier:gold');
    expect(
      await cohortKeyFor(
        { cohorts: [{ ...cohort, id: 'gold-tier' }] },
        { profileAttributes: { tier: 'gold' } }
      )
    ).toBe('gold-tier');
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { profileAttributes: { tier: 'silver' } })
    ).toBeUndefined();
    expect(
      await cohortKeyFor({ cohorts: [cohort] }, { attributes: { tier: 'gold' } })
    ).toBeUndefined();
    expect(
      await cohortKeyFor(
        { cohorts: [{ profile_attribute: 'tier' }] },
        { profileAttributes: { tier: 'gold' } }
      )
    ).toBeUndefined();
    expect(
      await cohortKeyFor(
        { cohorts: [{ profile_attribute: '', value: 'gold' }] },
        { profileAttributes: { '': 'gold' } }
      )
    ).toBeUndefined();
    expect(
      await cohortKeyFor(
        { cohorts: [{ profile_attribute: 5, value: 'gold' }] },
        { profileAttributes: { tier: 'gold' } }
      )
    ).toBeUndefined();
  });

  it('skips non-object cohorts and uses the first matching one', async () => {
    const facts = { groups: ['Staff', 'Eng'] };
    expect(
      await cohortKeyFor(
        {
          cohorts: [
            'x',
            null,
            ['Staff'],
            { group: 'Nope' },
            { id: 'eng', group: 'Eng' },
            { id: 'staff', group: 'Staff' },
          ],
        },
        facts
      )
    ).toBe('eng');
    expect(await cohortKeyFor({ cohorts: 'Staff' }, facts)).toBeUndefined();
    expect(await cohortKeyFor({ cohorts: { group: 'Staff' } }, facts)).toBeUndefined();
  });

  it('matches directory_groups policy', async () => {
    const facts = { groups: ['Staff', 'Eng'] };
    expect(await cohortKeyFor({ directory_groups: ['Nope', 'Eng', 'Staff'] }, facts)).toBe(
      'directory_group:Eng'
    );
    expect(await cohortKeyFor({ directory_groups: [5, 'Staff'] }, facts)).toBe(
      'directory_group:Staff'
    );
    expect(await cohortKeyFor({ directory_groups: ['Nope'] }, facts)).toBeUndefined();
    expect(await cohortKeyFor({ directory_groups: 'Staff' }, facts)).toBeUndefined();
    expect(await cohortKeyFor({ directory_groups: ['Staff'] }, {})).toBeUndefined();
  });

  it('cohorts take precedence over directory_groups, then attributes, then profile attributes', async () => {
    const facts: DirectoryAuthTargetFacts = {
      groups: ['Staff'],
      attributes: { dept: 'x' },
      profileAttributes: { tier: 'gold' },
    };
    expect(
      await cohortKeyFor(
        {
          cohorts: [{ id: 'c1', group: 'Staff' }],
          directory_groups: ['Staff'],
          directory_attributes: { dept: 'x' },
          profile_attributes: { tier: 'gold' },
        },
        facts
      )
    ).toBe('c1');
    expect(
      await cohortKeyFor(
        {
          directory_groups: ['Staff'],
          directory_attributes: { dept: 'x' },
          profile_attributes: { tier: 'gold' },
        },
        facts
      )
    ).toBe('directory_group:Staff');
    expect(
      await cohortKeyFor(
        { directory_attributes: { dept: 'x' }, profile_attributes: { tier: 'gold' } },
        facts
      )
    ).toBe('directory_attribute:dept:x');
    expect(await cohortKeyFor({ profile_attributes: { tier: 'gold' } }, facts)).toBe(
      'profile_attribute:tier:gold'
    );
  });

  it('matches directory_attributes policy with string, array and mixed expected values', async () => {
    const attrs = { attributes: { dept: ['a', 'x'], role: { value: 'admin' } } };
    expect(await cohortKeyFor({ directory_attributes: { dept: 'x' } }, attrs)).toBe(
      'directory_attribute:dept:x'
    );
    expect(await cohortKeyFor({ directory_attributes: { dept: ['q', 'x', 'a'] } }, attrs)).toBe(
      'directory_attribute:dept:x'
    );
    expect(await cohortKeyFor({ directory_attributes: { dept: [1, 'a'] } }, attrs)).toBe(
      'directory_attribute:dept:a'
    );
    expect(await cohortKeyFor({ directory_attributes: { nope: 'x', role: 'admin' } }, attrs)).toBe(
      'directory_attribute:role:admin'
    );
    expect(await cohortKeyFor({ directory_attributes: { dept: 5 } }, attrs)).toBeUndefined();
    expect(await cohortKeyFor({ directory_attributes: { dept: 'zzz' } }, attrs)).toBeUndefined();
    expect(await cohortKeyFor({ directory_attributes: ['dept'] }, attrs)).toBeUndefined();
    expect(await cohortKeyFor({ directory_attributes: 'dept' }, attrs)).toBeUndefined();
    expect(await cohortKeyFor({ directory_attributes: null }, attrs)).toBeUndefined();
    expect(await cohortKeyFor({ directory_attributes: { dept: 'x' } }, {})).toBeUndefined();
  });
});
