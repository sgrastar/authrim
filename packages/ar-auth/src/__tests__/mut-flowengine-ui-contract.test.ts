/**
 * UIContractGenerator - full feature-flag matrix per profile, flow-context copying,
 * and action labels per node type.
 */

import { describe, expect, it } from 'vitest';
import type { FlowContext } from '@authrim/ar-lib-core';
import type { CompiledNode, GraphNodeType } from '../flow-engine/types';
import { createUIContractGenerator } from '../flow-engine/ui-contract-generator';

const gen = createUIContractGenerator();

function compiledNode(type: string): CompiledNode {
  return {
    id: `node-${type}`,
    type: type as GraphNodeType,
    intent: 'authenticate_user',
    capabilities: [],
    nextOnSuccess: null,
    nextOnError: null,
  };
}

const generate = (type: string, extra: Record<string, unknown> = {}) =>
  gen.generate({ compiledNode: compiledNode(type), flowId: 'f', ...extra });

const noTargets = { human: false, iot: false, ai_agent: false, ai_mcp: false, service: false };
const noMethods = {
  passkey: false,
  totp: false,
  email_code: false,
  password: false,
  external_idp: false,
  did: false,
};

describe('feature flags per profile', () => {
  const humanBasic = {
    policy: { rbac: 'simple', abac: false, rebac: false },
    targets: { ...noTargets, human: true },
    authMethods: { ...noMethods, passkey: true, totp: true, email_code: true },
  };

  it.each([
    ['human-basic', humanBasic],
    [
      'human-org',
      {
        policy: { rbac: 'full', abac: false, rebac: true },
        targets: { ...noTargets, human: true },
        authMethods: {
          ...noMethods,
          passkey: true,
          totp: true,
          email_code: true,
          external_idp: true,
        },
      },
    ],
    [
      'ai-agent',
      {
        policy: { rbac: 'full', abac: true, rebac: true },
        targets: { ...noTargets, ai_agent: true, ai_mcp: true },
        authMethods: { ...noMethods, passkey: true, totp: true, did: true },
      },
    ],
    [
      'iot-device',
      {
        policy: { rbac: 'simple', abac: true, rebac: false },
        targets: { ...noTargets, iot: true },
        authMethods: { ...noMethods, did: true },
      },
    ],
    ['unknown-profile', humanBasic],
  ])('%s', (profileId, expected) => {
    expect(generate('identifier', { profileId }).features).toEqual(expected);
  });

  it('defaults to human-basic when no profile is given', () => {
    expect(generate('identifier').features).toEqual(humanBasic);
  });
});

describe('flow context', () => {
  it('copies only the provided fields', () => {
    const result = generate('identifier', {
      flowContext: { locale: 'ja' },
    });
    expect(result.context).toEqual({ locale: 'ja' });
    expect(Object.keys(result.context ?? {})).toEqual(['locale']);
  });

  it('copies every supported field when present', () => {
    const flowContext = {
      branding: { name: 'B' },
      user: { id: 'u1' },
      organization: { id: 'o1', name: 'O' },
      client: { id: 'c1', name: 'C' },
      error: { code: 'e', message: 'm' },
      locale: 'en',
    } as unknown as Partial<FlowContext>;
    expect(generate('identifier', { flowContext }).context).toEqual(flowContext);
  });

  it('returns an empty context when nothing is provided', () => {
    expect(generate('identifier', { flowContext: {} }).context).toEqual({});
  });
});

describe('actions per node type', () => {
  const back = { type: 'BACK', label: 'Back', variant: 'secondary' };

  it.each([
    ['start', { type: 'CONTINUE', label: 'Get Started' }, undefined],
    ['identifier', { type: 'SUBMIT', label: 'Continue' }, [back]],
    ['auth_method', { type: 'SUBMIT', label: 'Sign in' }, [back]],
    ['mfa', { type: 'SUBMIT', label: 'Verify' }, [back]],
    [
      'consent',
      { type: 'SUBMIT', label: 'Allow' },
      [back, { type: 'DENY', label: 'Deny', variant: 'secondary' }],
    ],
    ['end', { type: 'COMPLETE', label: 'Done' }, undefined],
    [
      'error',
      { type: 'RETRY', label: 'Try again' },
      [back, { type: 'CANCEL', label: 'Cancel', variant: 'secondary' }],
    ],
    ['custom_form', { type: 'SUBMIT', label: 'Continue' }, [back]],
  ])('%s', (type, primary, secondary) => {
    expect(generate(type).actions).toEqual({ primary, secondary });
  });

  it('builds state and version from flow and node ids', () => {
    const result = generate('mfa');
    expect(result.state).toBe('f:node-mfa');
    expect(result.version).toBe('0.1');
    expect(result.intent).toBe('authenticate_user');
  });
});
