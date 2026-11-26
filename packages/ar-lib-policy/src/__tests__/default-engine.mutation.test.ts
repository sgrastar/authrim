import { describe, expect, it } from 'vitest';
import { createDefaultPolicyEngine } from '../engine';
import type { PolicyContext, PolicyRule } from '../types';

function context(options: {
  roles?: PolicyContext['subject']['roles'];
  ownerId?: string;
  relationships?: Array<{ relatedSubjectId: string; relationshipType: string }>;
}): PolicyContext {
  return {
    subject: {
      id: 'user-1',
      roles: options.roles ?? [],
      relationships: options.relationships,
    } as unknown as PolicyContext['subject'],
    resource: { type: 'doc', id: 'doc-1', ownerId: options.ownerId },
    action: { name: 'read' },
    timestamp: Date.UTC(2025, 0, 1),
  };
}

describe('createDefaultPolicyEngine', () => {
  it('holds the three default rules, in priority order', () => {
    const engine = createDefaultPolicyEngine() as unknown as { rules: PolicyRule[] };
    expect(engine.rules).toStrictEqual([
      {
        id: 'admin_full_access',
        name: 'Admin Full Access',
        description: 'Administrators have full access to all resources',
        priority: 1000,
        effect: 'allow',
        conditions: [{ type: 'has_role', params: { role: 'admin' } }],
      },
      {
        id: 'owner_full_access',
        name: 'Resource Owner Access',
        description: 'Resource owners have full access to their own resources',
        priority: 700,
        effect: 'allow',
        conditions: [{ type: 'is_resource_owner', params: {} }],
      },
      {
        id: 'guardian_access',
        name: 'Guardian Access',
        description: 'Parents and guardians can access resources owned by their children',
        priority: 600,
        effect: 'allow',
        conditions: [{ type: 'has_relationship', params: { types: ['parent_of', 'guardian_of'] } }],
      },
    ]);
  });

  it('allows admins, owners and guardians, and denies everyone else', () => {
    const engine = createDefaultPolicyEngine();
    expect(engine.evaluate(context({ roles: [{ name: 'admin', scope: 'global' }] }))).toMatchObject(
      { allowed: true, decidedBy: 'admin_full_access' }
    );
    expect(engine.evaluate(context({ ownerId: 'user-1' }))).toMatchObject({
      allowed: true,
      decidedBy: 'owner_full_access',
    });
    expect(
      engine.evaluate(
        context({
          ownerId: 'child',
          relationships: [{ relatedSubjectId: 'child', relationshipType: 'guardian_of' }],
        })
      )
    ).toMatchObject({ allowed: true, decidedBy: 'guardian_access' });
    expect(engine.evaluate(context({ ownerId: 'someone' }))).toMatchObject({
      allowed: false,
      decidedBy: 'default',
    });
  });
});
