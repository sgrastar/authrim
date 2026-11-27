import { describe, expect, it } from 'vitest';
import { changedServiceGroups } from '../plan-diff';
import type { Expression, Field, GroupPlan, ServiceGroup } from '../model';

const TENANT = 'tenant-a';

function group(id: string, condition: Expression | null, extra: Partial<ServiceGroup> = {}) {
  return {
    id,
    tenantId: TENANT,
    key: id.toLowerCase(),
    displayName: id,
    description: '',
    enabled: true,
    condition,
    ...extra,
  } satisfies ServiceGroup;
}

function plan(groups: ServiceGroup[], fields: Record<string, Field> = {}): GroupPlan {
  return {
    tenantId: TENANT,
    groups,
    fields: { 'custom.team': { type: 'string' }, ...fields },
    nodes: {},
    order: [],
    roots: {},
    attributes: {},
    dependents: {},
    dependencies: {},
  };
}

const team = (value: string): Expression => ({
  op: 'attribute',
  field: 'custom.team',
  compare: 'eq',
  value,
});

describe('changedServiceGroups', () => {
  it('ignores presentation: display name, description and key', () => {
    const before = plan([group('A', team('x'))]);
    const after = plan([
      group('A', team('x'), { displayName: 'Renamed', description: 'New', key: 'renamed' }),
    ]);
    expect([...changedServiceGroups(before, after)]).toEqual([]);
  });

  it('marks a group whose condition, state or SCIM role changed', () => {
    const before = plan([
      group('A', team('x')),
      group('B', team('y')),
      group('C', team('z')),
      group('D', team('w')),
    ]);
    const after = plan([
      group('A', team('changed')),
      group('B', team('y'), { enabled: false }),
      group('C', team('z'), { scimRoleId: 'role-1' }),
      group('D', team('w')),
    ]);
    expect([...changedServiceGroups(before, after)].sort()).toEqual(['A', 'B', 'C']);
  });

  it('marks a group whose condition reads a field whose definition changed', () => {
    const before = plan([group('A', team('x')), group('B', null)]);
    const after = plan([group('A', team('x')), group('B', null)], {
      'custom.team': { type: 'string', normalize: 'email' },
    });
    expect([...changedServiceGroups(before, after)]).toEqual(['A']);
  });

  it('marks a removed group, and a group whose rule references a changed one', () => {
    const before = plan([
      group('A', team('x')),
      group('B', { op: 'member', groupId: 'A' }),
      group('C', { op: 'not', arg: { op: 'member', groupId: 'B' } }),
      group('D', team('y')),
      group('E', team('z')),
    ]);
    const after = plan([
      group('A', team('changed')),
      group('B', { op: 'member', groupId: 'A' }),
      group('C', { op: 'not', arg: { op: 'member', groupId: 'B' } }),
      group('D', team('y')),
    ]);
    expect([...changedServiceGroups(before, after)].sort()).toEqual(['A', 'B', 'C', 'E']);
  });
});
