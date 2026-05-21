import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FLOWS,
  getBuiltinFlow,
  getBuiltinFlowIds,
  HUMAN_BASIC_LOGIN_FLOW,
} from './login-flow';

describe('human-basic login flow definition', () => {
  it('registers the built-in flow by id', () => {
    expect(getBuiltinFlow('human-basic-login')).toBe(HUMAN_BASIC_LOGIN_FLOW);
    expect(BUILTIN_FLOWS['human-basic-login']).toBe(HUMAN_BASIC_LOGIN_FLOW);
    expect(getBuiltinFlowIds()).toEqual(['human-basic-login']);
    expect(getBuiltinFlow('missing-flow')).toBeUndefined();
  });

  it('models the expected identifier, authentication, completion, and retry path', () => {
    expect(HUMAN_BASIC_LOGIN_FLOW.nodes.map((node) => node.id)).toEqual([
      'start',
      'identifier',
      'auth_method',
      'complete',
      'error',
    ]);
    expect(HUMAN_BASIC_LOGIN_FLOW.edges.map((edge) => [edge.source, edge.target, edge.type])).toEqual(
      [
        ['start', 'identifier', 'success'],
        ['identifier', 'auth_method', 'success'],
        ['identifier', 'error', 'error'],
        ['auth_method', 'complete', 'success'],
        ['auth_method', 'error', 'error'],
        ['error', 'identifier', 'conditional'],
      ]
    );
  });

  it('offers passkey first with email-code fallback for human login', () => {
    const authNode = HUMAN_BASIC_LOGIN_FLOW.nodes.find((node) => node.id === 'auth_method');

    expect(authNode?.data.config).toMatchObject({
      preferredMethod: 'passkey',
      fallbackMethod: 'email_code',
    });
    expect(authNode?.data.capabilities.map((capability) => capability.idSuffix)).toEqual([
      'passkey',
      'email_code',
    ]);
  });
});
