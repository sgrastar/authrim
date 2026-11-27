import { describe, expect, it, vi } from 'vitest';
import { declaresTuplesetRelation, ruleOnRelationshipTupleSource } from '../tuple-type-rules';

function store(definitions: Record<string, unknown[]>) {
  return {
    query: vi.fn(async (_sql: string, params?: unknown[]) =>
      (definitions[String(params?.[1])] ?? []).map((definition) => ({
        definition_json: typeof definition === 'string' ? definition : JSON.stringify(definition),
      }))
    ),
  };
}

const PARENT_VIEWER = {
  type: 'union',
  children: [
    { type: 'direct', relation: 'viewer' },
    {
      type: 'tuple_to_userset',
      tupleset: { relation: 'parent' },
      computed_userset: { relation: 'viewer' },
    },
  ],
};

describe('ReBAC tuple type rules', () => {
  it('stores a direct subject as subject, whether sent as subject or user', async () => {
    for (const fromType of ['subject', 'user', ' user ']) {
      expect(
        await ruleOnRelationshipTupleSource(store({}), {
          tenantId: 't',
          fromType,
          relationshipType: 'viewer',
        })
      ).toEqual({ allowed: true, kind: 'subject', fromType: 'subject' });
    }
  });

  it('accepts a group userset (stored, not evaluated yet)', async () => {
    expect(
      await ruleOnRelationshipTupleSource(store({}), {
        tenantId: 't',
        fromType: 'group',
        relationshipType: 'viewer',
      })
    ).toEqual({ allowed: true, kind: 'group_userset', fromType: 'group' });
  });

  it('accepts from_relation only as the member userset of a group', async () => {
    const rule = (fromType: string, fromRelation: unknown) =>
      ruleOnRelationshipTupleSource(store({}), {
        tenantId: 't',
        fromType,
        relationshipType: 'viewer',
        fromRelation,
      });
    expect(await rule('group', 'member')).toMatchObject({ allowed: true, kind: 'group_userset' });
    expect(await rule('group', undefined)).toMatchObject({ allowed: true });
    for (const [fromType, fromRelation] of [
      ['group', 'owner'],
      ['group', null],
      ['group', ''],
      ['subject', 'member'],
      ['document', 'member'],
    ] as const) {
      expect(await rule(fromType, fromRelation)).toEqual({
        allowed: false,
        reason: 'unsupported_from_relation',
      });
    }
  });

  it('accepts an object edge declared as the tupleset of a tuple_to_userset', async () => {
    const definitions = store({ document: [PARENT_VIEWER] });
    expect(
      await ruleOnRelationshipTupleSource(definitions, {
        tenantId: 't',
        fromType: 'document',
        relationshipType: 'parent',
      })
    ).toEqual({ allowed: true, kind: 'object_edge', fromType: 'document' });
    expect(definitions.query).toHaveBeenCalledWith(expect.stringContaining('is_active = 1'), [
      't',
      'document',
    ]);
  });

  it.each([
    ['an undeclared relation of a declared type', 'document', 'owner'],
    ['a type with no definition', 'folder', 'parent'],
    ['a service subject type', 'service', 'viewer'],
  ])('refuses %s', async (_label, fromType, relationshipType) => {
    expect(
      await ruleOnRelationshipTupleSource(store({ document: [PARENT_VIEWER] }), {
        tenantId: 't',
        fromType,
        relationshipType,
      })
    ).toEqual({ allowed: false, reason: 'undeclared_object_edge' });
  });

  it('refuses a missing type or relation without reading definitions', async () => {
    const definitions = store({});
    for (const [fromType, relationshipType] of [
      ['', 'viewer'],
      [undefined, 'viewer'],
      ['document', ''],
    ] as const) {
      expect(
        await ruleOnRelationshipTupleSource(definitions, {
          tenantId: 't',
          fromType,
          relationshipType,
        })
      ).toEqual({ allowed: false, reason: 'missing_type' });
    }
    expect(definitions.query).not.toHaveBeenCalled();
  });

  it('skips a definition that is not valid JSON', async () => {
    expect(
      await ruleOnRelationshipTupleSource(store({ document: ['{not json', PARENT_VIEWER] }), {
        tenantId: 't',
        fromType: 'document',
        relationshipType: 'parent',
      })
    ).toMatchObject({ allowed: true });
  });

  it('treats a definition the relation parser rejects as declaring nothing (never throws)', async () => {
    for (const malformed of [
      // tuple_to_userset without computed_userset: the parser refuses it
      { type: 'tuple_to_userset', tupleset: { relation: 'parent' } },
      // a union with no children: parsed, but invalid
      {
        type: 'union',
        children: [],
        tupleset: { relation: 'parent' },
      },
      { type: 'no_such_type', tupleset: { relation: 'parent' } },
      'null',
    ]) {
      await expect(
        ruleOnRelationshipTupleSource(store({ document: [malformed] }), {
          tenantId: 't',
          fromType: 'document',
          relationshipType: 'parent',
        })
      ).resolves.toEqual({ allowed: false, reason: 'undeclared_object_edge' });
    }
  });

  it('finds the tupleset inside intersection and exclusion', () => {
    const ttu = {
      type: 'tuple_to_userset',
      tupleset: { relation: 'parent' },
      computed_userset: { relation: 'viewer' },
    } as const;
    expect(
      declaresTuplesetRelation(
        { type: 'intersection', children: [{ type: 'direct', relation: 'viewer' }, ttu] },
        'parent'
      )
    ).toBe(true);
    expect(
      declaresTuplesetRelation(
        { type: 'exclusion', base: { type: 'direct', relation: 'viewer' }, subtract: ttu },
        'parent'
      )
    ).toBe(true);
    expect(declaresTuplesetRelation({ type: 'direct', relation: 'parent' }, 'parent')).toBe(false);
  });
});
