import { describe, expect, it } from 'vitest';
import type { CompiledNode, GraphNodeType } from './types';
import type { ProfileId } from '@authrim/ar-lib-core';
import { createUIContractGenerator, UIContractGenerator } from './ui-contract-generator';

function compiledNode(
  type: GraphNodeType,
  capabilities: CompiledNode['capabilities'] = []
): CompiledNode {
  return {
    id: `node-${type}`,
    type,
    intent: 'authenticate_user',
    capabilities,
    nextOnSuccess: null,
    nextOnError: null,
  };
}

describe('UIContractGenerator contract mapping', () => {
  it.each([
    ['human-basic', 'simple', true, false],
    ['human-org', 'full', true, false],
    ['ai-agent', 'full', false, true],
    ['iot-device', 'simple', false, true],
    ['custom.unknown-profile', 'simple', true, false],
  ] as const)('maps profile %s to stable feature flags', (profileId, rbac, human, did) => {
    const result = createUIContractGenerator().generate({
      compiledNode: compiledNode('identifier'),
      flowId: 'login',
      profileId: profileId as ProfileId,
    });

    expect(result.features.policy.rbac).toBe(rbac);
    expect(result.features.targets.human).toBe(human);
    expect(result.features.authMethods.did).toBe(did);
  });

  it('preserves capability validation and hints without widening the contract', () => {
    const result = createUIContractGenerator().generate({
      compiledNode: compiledNode('identifier', [
        {
          type: 'collect_identifier',
          id: 'email',
          stability: 'stable',
          required: true,
          hints: { label: 'Email', inputType: 'email' },
          validationRules: [],
        },
      ]),
      flowId: 'login',
    });

    expect(result.capabilities).toEqual([
      expect.objectContaining({
        type: 'collect_identifier',
        id: 'email',
        required: true,
        hints: expect.objectContaining({ label: 'Email', inputType: 'email' }),
        validation: [],
      }),
    ]);
  });

  it('prefers authenticated flow context over untrusted runtime identity data', () => {
    const result = createUIContractGenerator().generate({
      compiledNode: compiledNode('identifier'),
      flowId: 'login',
      flowContext: {
        user: { id: 'trusted-user', email: 'trusted@example.com' },
        locale: 'ja',
        branding: { name: 'Tenant' },
        organization: { id: 'org-1', name: 'Organization' },
        client: { clientId: 'client-1' },
        error: { code: 'retry', message: 'Retry' },
      },
      runtimeState: {
        userId: 'runtime-user',
        collectedData: { identifier_email: { email: 'runtime@example.com' } },
      },
    });

    expect(result.context?.user).toMatchObject({
      id: 'trusted-user',
      email: 'runtime@example.com',
    });
    expect(result.context).toMatchObject({ locale: 'ja' });
  });

  it('hydrates a pending user email only from the typed identifier result', () => {
    const generator = new UIContractGenerator();
    const withEmail = generator.generate({
      compiledNode: compiledNode('identifier'),
      flowId: 'login',
      runtimeState: { collectedData: { identifier_email: { email: 'user@example.com' } } },
    });
    const malformed = generator.generate({
      compiledNode: compiledNode('identifier'),
      flowId: 'login',
      runtimeState: { collectedData: { identifier_email: 'user@example.com' } },
    });

    expect(withEmail.context?.user).toEqual({ id: 'pending', email: 'user@example.com' });
    expect(malformed.context?.user).toBeUndefined();
  });

  it('hydrates a runtime user ID when no trusted user exists', () => {
    const result = createUIContractGenerator().generate({
      compiledNode: compiledNode('identifier'),
      flowId: 'login',
      runtimeState: { userId: 'runtime-user' },
    });
    expect(result.context?.user).toEqual({ id: 'runtime-user' });
  });

  it.each([
    ['start', 'CONTINUE', undefined],
    ['identifier', 'SUBMIT', ['BACK']],
    ['auth_method', 'SUBMIT', ['BACK']],
    ['mfa', 'SUBMIT', ['BACK']],
    ['consent', 'SUBMIT', ['BACK', 'DENY']],
    ['end', 'COMPLETE', undefined],
    ['error', 'RETRY', ['BACK', 'CANCEL']],
    ['custom_form', 'SUBMIT', ['BACK']],
  ] as const)(
    'maps %s node actions without exposing unsupported operations',
    (type, primary, secondary) => {
      const result = createUIContractGenerator().generate({
        compiledNode: compiledNode(type),
        flowId: 'login',
      });

      expect(result.state).toBe(`login:node-${type}`);
      expect(result.actions.primary.type).toBe(primary);
      expect(result.actions.secondary?.map((action) => action.type)).toEqual(secondary);
    }
  );
});
