/**
 * hasNonSAMLMappingOutput: which mapping targets count as a release to something other than SAML.
 */

import { describe, expect, it } from 'vitest';
import { hasNonSAMLMappingOutput } from '../mapping-output-validation';

type Binding = Parameters<typeof hasNonSAMLMappingOutput>[0];

const entry = (
  id: string,
  namespace: string,
  path: string,
  targetType: string,
  aliases?: Array<{ namespace: string; path: string }>
) => ({
  id,
  namespace,
  path,
  valueType: 'string',
  cardinality: 'single',
  classification: 'pii',
  targetType,
  ...(aliases ? { aliases } : {}),
});

const catalog = {
  identity: { id: 'catalog-1', version: '1', contentHash: 'h', compatibilityRange: '^0.3.0' },
  entries: [
    entry('canon.email', 'authrim.canonical', 'email', 'canonical'),
    entry('canon.name', 'authrim.canonical', 'name', 'canonical', [
      { namespace: 'authrim.profile', path: 'name' },
    ]),
    entry('oidc.x', 'oidc.claim', 'x', 'destination'),
    entry('canon.dup', 'authrim.canonical', 'dup', 'canonical'),
    entry('dup.alias', 'other.ns', 'y', 'canonical', [
      { namespace: 'authrim.canonical', path: 'dup' },
    ]),
  ],
} as unknown as Binding['catalog'];

const target = (namespace: string, path: string, extra: Record<string, unknown> = {}) => ({
  side: 'destination',
  namespace,
  path,
  ...extra,
});

function binding(partial: Record<string, unknown>): Binding {
  return { catalog, ...partial } as unknown as Binding;
}

describe('targets that are SAML releases', () => {
  it.each([
    ['saml.attribute', 'mail'],
    ['saml.nameid', 'value'],
  ])('allows a stored profile target in %s', (namespace, path) => {
    expect(
      hasNonSAMLMappingOutput(binding({ storedProfileTargets: [target(namespace, path)] }))
    ).toBe(false);
  });

  it('allows a binding without any targets', () => {
    expect(hasNonSAMLMappingOutput(binding({}))).toBe(false);
    expect(
      hasNonSAMLMappingOutput(
        binding({ graphRules: [], edges: [], transforms: [], storedProfileTargets: [] })
      )
    ).toBe(false);
  });
});

describe('targets that are not SAML releases', () => {
  it('flags a stored profile target in another namespace', () => {
    expect(
      hasNonSAMLMappingOutput(binding({ storedProfileTargets: [target('oidc.claim', 'x')] }))
    ).toBe(true);
  });

  it('flags any non-SAML target when there is no catalog', () => {
    expect(
      hasNonSAMLMappingOutput({
        storedProfileTargets: [target('authrim.canonical', 'email')],
      } as unknown as Binding)
    ).toBe(true);
  });

  it('flags a saml-prefixed lookalike namespace', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({ storedProfileTargets: [target('saml.attributes', 'mail')] })
      )
    ).toBe(true);
    expect(
      hasNonSAMLMappingOutput(
        binding({ storedProfileTargets: [target('xsaml.attribute', 'mail')] })
      )
    ).toBe(true);
  });
});

describe('canonical inputs are not releases', () => {
  it('treats a catalogued canonical field named by place as an input', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({ storedProfileTargets: [target('authrim.canonical', 'email')] })
      )
    ).toBe(false);
  });

  it('treats a canonical field reached through a catalog alias as an input', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({ storedProfileTargets: [target('authrim.profile', 'name')] })
      )
    ).toBe(false);
  });

  it('accepts the legacy authrim.profile namespace when the entry id names a canonical field', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [
            target('authrim.profile', 'email', { catalogEntryId: 'canon.email' }),
          ],
        })
      )
    ).toBe(false);
  });

  it('rejects the legacy form without an entry id', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({ storedProfileTargets: [target('authrim.profile', 'email')] })
      )
    ).toBe(true);
  });

  it('rejects the legacy form when the entry id names a field at another path', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [
            target('authrim.profile', 'name', { catalogEntryId: 'canon.email' }),
          ],
        })
      )
    ).toBe(true);
  });

  it('rejects the legacy form when the entry id names a canonical field the target place does not match', () => {
    // No catalog entry sits at authrim.profile:zzz, so the entry id alone must tie the target to
    // a canonical field, and that needs the same subject path.
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [
            target('authrim.profile', 'zzz', { catalogEntryId: 'canon.email' }),
          ],
        })
      )
    ).toBe(true);
  });

  it('rejects a canonical entry id used for a target in an unrelated namespace', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [target('oidc.claim', 'email', { catalogEntryId: 'canon.email' })],
        })
      )
    ).toBe(true);
  });

  it('rejects a non-canonical catalog entry', () => {
    expect(
      hasNonSAMLMappingOutput(binding({ storedProfileTargets: [target('oidc.claim', 'x')] }))
    ).toBe(true);
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [
            target('authrim.canonical', 'email', { catalogEntryId: 'oidc.x' }),
          ],
        })
      )
    ).toBe(true);
  });

  it('rejects a canonical id that disguises a different field at the same place', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [
            target('authrim.canonical', 'dup', { catalogEntryId: 'dup.alias' }),
          ],
        })
      )
    ).toBe(true);
  });

  it('never accepts a reference that names a profile, snake case included', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [target('authrim.canonical', 'email', { profileId: 'p-1' })],
        })
      )
    ).toBe(true);
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [target('authrim.canonical', 'email', { profile_id: 'p-1' })],
        })
      )
    ).toBe(true);
  });

  it('rejects a canonical field that is a destination-profile target', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [
            target('authrim.canonical', 'email', { profileId: 'destination-profile-saml' }),
          ],
        })
      )
    ).toBe(true);
  });
});

describe('graphs, edges and transforms', () => {
  const oidc = target('oidc.claim', 'x');
  const samlTarget = target('saml.attribute', 'mail');

  it('judges the final target of a graph rule', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({ graphRules: [{ targetRef: oidc, edges: [], transforms: [] }] })
      )
    ).toBe(true);
    expect(
      hasNonSAMLMappingOutput(
        binding({ graphRules: [{ targetRef: samlTarget, edges: [], transforms: [] }] })
      )
    ).toBe(false);
  });

  it('ignores intermediate edges and transforms owned by a graph rule', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          graphRules: [
            {
              targetRef: samlTarget,
              edges: [{ id: 'e-graph' }],
              transforms: [{ id: 't-graph' }],
            },
          ],
          edges: [{ id: 'e-graph', targetRef: oidc }],
          transforms: [{ id: 't-graph', outputTargetRef: oidc }],
        })
      )
    ).toBe(false);
  });

  it('judges edges that no graph rule owns, but only those released to the destination side', () => {
    expect(hasNonSAMLMappingOutput(binding({ edges: [{ id: 'e1', targetRef: oidc }] }))).toBe(true);
    expect(
      hasNonSAMLMappingOutput(
        binding({ edges: [{ id: 'e1', targetRef: { ...oidc, side: 'source' } }] })
      )
    ).toBe(false);
    expect(hasNonSAMLMappingOutput(binding({ edges: [{ id: 'e1', targetRef: samlTarget }] }))).toBe(
      false
    );
  });

  it('judges the output of transforms that no graph rule owns', () => {
    expect(
      hasNonSAMLMappingOutput(binding({ transforms: [{ id: 't1', outputTargetRef: oidc }] }))
    ).toBe(true);
    expect(
      hasNonSAMLMappingOutput(binding({ transforms: [{ id: 't1', outputTargetRef: samlTarget }] }))
    ).toBe(false);
  });

  it('flags a binding when any one of several targets is not SAML', () => {
    expect(
      hasNonSAMLMappingOutput(
        binding({
          storedProfileTargets: [samlTarget],
          edges: [{ id: 'e1', targetRef: samlTarget }],
          transforms: [{ id: 't1', outputTargetRef: oidc }],
        })
      )
    ).toBe(true);
  });
});
