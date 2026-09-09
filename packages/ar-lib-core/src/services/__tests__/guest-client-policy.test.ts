import { describe, expect, it } from 'vitest';
import {
  areGuestScopesAllowed,
  createDefaultGuestClientPolicy,
  isValidGuestClientPolicy,
} from '../guest-client-policy';

describe('guest client policy', () => {
  it('starts disabled with only explicitly requestable baseline scopes', () => {
    const policy = createDefaultGuestClientPolicy();
    expect(policy.enabled).toBe(false);
    expect(policy.allowedScopes).toEqual(['openid', 'account:lifecycle:read']);
    expect(isValidGuestClientPolicy(policy)).toBe(true);
    expect(areGuestScopesAllowed(policy, 'openid')).toBe(false);
    policy.enabled = true;
    expect(areGuestScopesAllowed(policy, 'openid')).toBe(true);
    expect(areGuestScopesAllowed(policy, 'openid profile')).toBe(false);
  });
  it.each([
    null,
    [],
    {},
    { enabled: 'true' },
    { preserveSubOnUpgrade: false },
    { allowedScopes: ['openid', 'openid'] },
    { allowedScopes: ['profile'] },
    { allowedScopes: ['openid', 'scope with space'] },
    { allowedUpgradeMethods: ['social'] },
    { allowedUpgradeMethods: ['email', 'email'] },
    { extra: 'property' },
  ])('rejects malformed or unsupported guest settings: %j', (invalid) => {
    const value =
      invalid && !Array.isArray(invalid)
        ? { ...createDefaultGuestClientPolicy(), ...invalid }
        : invalid;
    if (invalid && !Array.isArray(invalid) && Object.keys(invalid).length === 0) {
      expect(isValidGuestClientPolicy(invalid)).toBe(false);
    } else expect(isValidGuestClientPolicy(value)).toBe(false);
  });
  it('does not reuse mutable default arrays across clients', () => {
    const first = createDefaultGuestClientPolicy();
    first.allowedScopes.push('private');
    expect(createDefaultGuestClientPolicy().allowedScopes).not.toContain('private');
  });
  it('denies absent policy and never implicitly grants more scopes', () => {
    expect(areGuestScopesAllowed(undefined, 'openid')).toBe(false);
    expect(
      areGuestScopesAllowed(
        { ...createDefaultGuestClientPolicy(), enabled: true },
        'openid account:lifecycle:read'
      )
    ).toBe(true);
    expect(
      areGuestScopesAllowed(
        { ...createDefaultGuestClientPolicy(), enabled: true },
        'offline_access'
      )
    ).toBe(false);
  });
});
