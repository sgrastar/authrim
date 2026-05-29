import { describe, expect, it } from 'vitest';
import {
  buildSupportOpsRiskSummary,
  compileSupportOpsSelector,
  getSupportOpsResource,
  listSupportOpsResources,
  validateSupportOpsAction,
} from '../support-ops';

describe('support operations registry and selector compiler', () => {
  it('exposes only non-sensitive User fields as filterable in the MVP registry', () => {
    const registry = listSupportOpsResources();
    const user = registry.find((resource) => resource.resource === 'User');

    expect(user).toBeDefined();
    expect(user?.minCount).toBe(10);
    expect(user?.maxSnapshotCount).toBe(10000);
    expect(user?.fields.status.filterable).toBe(true);
    expect(user?.fields.email.sensitive).toBe(true);
    expect(user?.fields.email.filterable).toBe(false);
  });

  it('compiles simple and grouped selectors into parameterized SQL', async () => {
    const user = getSupportOpsResource('User');
    expect(user).toBeTruthy();

    const compiled = await compileSupportOpsSelector(user!, {
      all: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'email_verified', op: 'eq', value: true },
      ],
    });

    expect(compiled.whereSql).toContain("json_extract(metadata_json, '$.status') = ?");
    expect(compiled.whereSql).toContain('EXISTS (SELECT 1 FROM contact_points');
    expect(compiled.whereSql).toContain('= ?)');
    expect(compiled.params).toEqual(['active', 1]);
    expect(compiled.selectorHash).toMatch(/^sha256:/);
  });

  it('normalizes datetime comparisons to milliseconds in SQL', async () => {
    const user = getSupportOpsResource('User');
    expect(user).toBeTruthy();

    const compiled = await compileSupportOpsSelector(user!, {
      field: 'last_login_at',
      op: 'lt',
      value: '2026-01-01T00:00:00.000Z',
    });

    expect(compiled.whereSql).toContain(
      'CASE WHEN last_login_at > 0 AND last_login_at < 100000000000'
    );
    expect(compiled.whereSql).toContain('last_login_at * 1000');
    expect(compiled.params).toEqual([1767225600000]);
  });

  it('rejects sensitive fields and unsupported actions', async () => {
    const user = getSupportOpsResource('User');
    expect(user).toBeTruthy();

    await expect(
      compileSupportOpsSelector(user!, { field: 'email', op: 'eq', value: 'a@example.com' })
    ).rejects.toThrow('Field is not filterable: email');

    expect(validateSupportOpsAction(user!, 'suspend').valid).toBe(true);
    expect(validateSupportOpsAction(user!, 'delete').valid).toBe(false);
  });

  it('rejects unsupported enum values inside in selectors', async () => {
    const user = getSupportOpsResource('User');
    expect(user).toBeTruthy();

    await expect(
      compileSupportOpsSelector(user!, {
        field: 'status',
        op: 'in',
        value: ['active', 'bogus'],
      })
    ).rejects.toThrow('Unsupported value for field');
  });

  it('rejects ambiguous selector groups with both all and any branches', async () => {
    const user = getSupportOpsResource('User');
    expect(user).toBeTruthy();

    await expect(
      compileSupportOpsSelector(user!, {
        all: [{ field: 'status', op: 'eq', value: 'active' }],
        any: [{ field: 'email_verified', op: 'eq', value: true }],
      })
    ).rejects.toThrow('Selector group must include exactly one of all or any');
  });

  it('marks low-count support cohorts as suppressed', () => {
    const user = getSupportOpsResource('User');
    expect(user).toBeTruthy();

    const low = buildSupportOpsRiskSummary({ resource: user!, matchedCount: 4, action: 'suspend' });
    const large = buildSupportOpsRiskSummary({
      resource: user!,
      matchedCount: 1200,
      action: 'suspend',
    });

    expect(low.lowCountSuppressed).toBe(true);
    expect(low.approvalRequired).toBe(true);
    expect(large.lowCountSuppressed).toBe(false);
    expect(large.riskLevel).toBe('medium');
  });
});
