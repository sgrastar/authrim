import { describe, expect, it } from 'vitest';
import { BuiltinPolicyInfra } from '../infra/policy/builtin';
import type { InfraEnv, IStorageInfra } from '../infra/types';

function createStorageWithRule(condition: Record<string, unknown>): IStorageInfra {
  return {
    adapter: {
      query: async () => [
        {
          id: 'rule-regex',
          tenant_id: 'tenant-a',
          priority: 10,
          conditions: JSON.stringify([condition]),
          action: 'allow',
          roles_to_assign: JSON.stringify(['matched-role']),
          orgs_to_join: JSON.stringify([]),
          attributes_to_set: JSON.stringify([]),
          deny_reason: null,
        },
      ],
      queryOne: async () => null,
    },
  } as unknown as IStorageInfra;
}

async function evaluateRegexCondition(condition: Record<string, unknown>, emailDomainHash: string) {
  const policy = new BuiltinPolicyInfra();
  await policy.initialize({} as InfraEnv, createStorageWithRule(condition));

  return policy.evaluateRules({
    tenant_id: 'tenant-a',
    email_domain_hash: emailDomainHash,
    email_verified: true,
    idp_claims: {},
    provider_id: 'idp-a',
  });
}

describe('BuiltinPolicyInfra regex conditions', () => {
  it('does not truncate long regex input into a match', async () => {
    const result = await evaluateRegexCondition(
      {
        field: 'email_domain_hash',
        operator: 'matches',
        value: '^a+$',
      },
      `${'a'.repeat(10000)}b`
    );

    expect(result.matched_rules).toEqual([]);
    expect(result.roles_to_assign).toEqual([]);
  });

  it('rejects oversized regex patterns instead of truncating them', async () => {
    const result = await evaluateRegexCondition(
      {
        field: 'email_domain_hash',
        operator: 'matches',
        value: `${'a'.repeat(1000)}b`,
      },
      'a'.repeat(1000)
    );

    expect(result.matched_rules).toEqual([]);
    expect(result.roles_to_assign).toEqual([]);
  });
});
