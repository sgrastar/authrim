import { describe, expect, it, vi } from 'vitest';
import { BuiltinPolicyInfra } from '../infra/policy/builtin';
import type { IStorageInfra, InfraEnv, RuleEvaluationContext } from '../infra/types';

const context: RuleEvaluationContext = {
  tenant_id: 'tenant-a',
  email_domain_hash: 'company-hash',
  email_verified: true,
  idp_claims: {
    department: { name: 'Engineering' },
    groups: ['staff', 'on-call'],
  },
  provider_id: 'idp-a',
  user_type: 'employee',
};

interface RuleRow {
  id: string;
  tenant_id: string;
  priority: number;
  conditions: string | null;
  action: string;
  roles_to_assign: string | null;
  orgs_to_join: string | null;
  attributes_to_set: string | null;
  deny_reason: string | null;
}

function row(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: 'rule-a',
    tenant_id: 'tenant-a',
    priority: 10,
    conditions: JSON.stringify([{ field: 'provider_id', operator: 'eq', value: 'idp-a' }]),
    action: 'allow',
    roles_to_assign: JSON.stringify(['reader']),
    orgs_to_join: JSON.stringify(['engineering']),
    attributes_to_set: JSON.stringify([{ key: 'source', value: 'sso' }]),
    deny_reason: null,
    ...overrides,
  };
}

function storage(rows: RuleRow[]) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => rows);
  return { adapter: { query } } as unknown as IStorageInfra & {
    adapter: { query: typeof query };
  };
}

async function evaluate(rows: RuleRow[], env: InfraEnv = {} as InfraEnv) {
  const db = storage(rows);
  const policy = new BuiltinPolicyInfra();
  await policy.initialize(env, db);
  return { result: await policy.evaluateRules(context), db };
}

describe('BuiltinPolicyInfra role assignment rules', () => {
  it('applies actions only from matching rules and stops at the first deny', async () => {
    const { result, db } = await evaluate([
      row({
        id: 'nonmatch',
        priority: 1,
        conditions: JSON.stringify([{ field: 'provider_id', operator: 'eq', value: 'other' }]),
      }),
      row({ id: 'allow', priority: 2 }),
      row({
        id: 'deny',
        priority: 3,
        action: 'deny',
        deny_reason: 'blocked by policy',
      }),
      row({ id: 'never-evaluated', priority: 4, roles_to_assign: JSON.stringify(['admin']) }),
    ]);

    expect(result).toEqual({
      matched_rules: ['allow', 'deny'],
      roles_to_assign: ['reader'],
      orgs_to_join: ['engineering'],
      attributes_to_set: [{ key: 'source', value: 'sso' }],
      denied: true,
      deny_reason: 'blocked by policy',
    });
    expect(db.adapter.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM role_assignment_rules'),
      ['tenant-a', expect.any(Number), expect.any(Number)]
    );
  });

  it('requires every condition to match and reads nested identity-provider claims', async () => {
    const passing = row({
      conditions: JSON.stringify([
        { field: 'email_verified', operator: 'eq', value: true },
        { field: 'idp_claims.department.name', operator: 'eq', value: 'Engineering' },
        { field: 'idp_claims.groups', operator: 'contains', value: 'on-call' },
      ]),
    });
    const failing = row({
      id: 'failing',
      conditions: JSON.stringify([
        { field: 'email_verified', operator: 'eq', value: true },
        { field: 'idp_claims.department.name', operator: 'eq', value: 'Finance' },
      ]),
    });

    const { result } = await evaluate([passing, failing]);
    expect(result.matched_rules).toEqual(['rule-a']);
    expect(result.roles_to_assign).toEqual(['reader']);
  });

  it.each([
    ['eq', 'provider_id', 'idp-a', true],
    ['eq', 'provider_id', 'other', false],
    ['neq', 'provider_id', 'other', true],
    ['neq', 'provider_id', 'idp-a', false],
    ['contains', 'email_domain_hash', 'company', true],
    ['contains', 'email_domain_hash', 'unknown', false],
    ['contains', 'idp_claims.groups', 'staff', true],
    ['contains', 'idp_claims.groups', 'admin', false],
    ['starts_with', 'email_domain_hash', 'company', true],
    ['starts_with', 'email_domain_hash', 'hash', false],
    ['ends_with', 'email_domain_hash', '-hash', true],
    ['ends_with', 'email_domain_hash', 'company', false],
    ['matches', 'email_domain_hash', '^company-[a-z]+$', true],
    ['matches', 'email_domain_hash', '^other', false],
    ['matches', 'email_domain_hash', '[', false],
    ['in', 'user_type', ['employee', 'contractor'], true],
    ['in', 'user_type', ['partner'], false],
    ['exists', 'email_domain_hash', null, true],
    ['exists', 'idp_claims.missing', null, false],
    ['exists', 'unknown_field', null, false],
  ] as const)(
    '%s condition on %s with %o yields match=%s',
    async (operator, field, value, matched) => {
      const { result } = await evaluate([
        row({ conditions: JSON.stringify([{ field, operator, value }]) }),
      ]);
      expect(result.matched_rules).toEqual(matched ? ['rule-a'] : []);
      expect(result.roles_to_assign).toEqual(matched ? ['reader'] : []);
    }
  );

  it('reloads rules from storage when cached JSON is corrupted and refreshes the cache', async () => {
    const cache = {
      get: vi.fn(async () => '{invalid'),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const { result, db } = await evaluate([row()], { REBAC_CACHE: cache } as InfraEnv);

    expect(result.matched_rules).toEqual(['rule-a']);
    expect(db.adapter.query).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledWith('rules:tenant-a', expect.stringContaining('rule-a'), {
      expirationTtl: 300,
    });
  });

  it('uses cached rules without reading storage when the cached payload is valid', async () => {
    const cachedRule = {
      id: 'cached',
      tenant_id: 'tenant-a',
      priority: 1,
      conditions: [{ field: 'email_verified', operator: 'eq', value: true }],
      action: 'allow',
      roles_to_assign: ['cached-role'],
      orgs_to_join: [],
      attributes_to_set: [],
    };
    const cache = {
      get: vi.fn(async () => JSON.stringify([cachedRule])),
      put: vi.fn(),
    } as unknown as KVNamespace;
    const { result, db } = await evaluate([row()], { REBAC_CACHE: cache } as InfraEnv);

    expect(result.matched_rules).toEqual(['cached']);
    expect(result.roles_to_assign).toEqual(['cached-role']);
    expect(db.adapter.query).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
