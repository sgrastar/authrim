import { describe, expect, it } from 'vitest';
import { adminSignInMethodsProblem, resolveAdminSignInMethods } from '../admin-step-up';

describe('security.admin_sign_in_methods', () => {
  it('accepts a list of known methods that includes passkey', () => {
    expect(adminSignInMethodsProblem(['passkey'])).toBeNull();
    expect(adminSignInMethodsProblem(['passkey', 'vc'])).toBeNull();
    expect(adminSignInMethodsProblem(['vc', 'passkey'])).toBeNull();
  });

  it('refuses a list that would turn the passkey off, repeats, or names an unknown method', () => {
    expect(adminSignInMethodsProblem(['vc'])).toMatch(/must include passkey/);
    expect(adminSignInMethodsProblem([])).toMatch(/must include passkey/);
    expect(adminSignInMethodsProblem(['passkey', 'passkey'])).toMatch(/listed twice/);
    expect(adminSignInMethodsProblem(['passkey', 'password'])).toMatch(/unknown method password/);
    expect(adminSignInMethodsProblem(['passkey', 1])).toMatch(/unknown method number/);
    expect(adminSignInMethodsProblem('passkey')).toMatch(/must be a list/);
    expect(adminSignInMethodsProblem({ passkey: true })).toMatch(/must be a list/);
  });

  it('reads anything it cannot accept as passkey only', () => {
    expect([...resolveAdminSignInMethods(undefined)]).toEqual(['passkey']);
    expect([...resolveAdminSignInMethods(['vc'])]).toEqual(['passkey']);
    expect([...resolveAdminSignInMethods('{"vc":true}')]).toEqual(['passkey']);
    expect([...resolveAdminSignInMethods(['passkey', 'vc'])].sort()).toEqual(['passkey', 'vc']);
  });
});
