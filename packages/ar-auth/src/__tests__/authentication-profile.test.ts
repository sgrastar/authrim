import { describe, expect, it } from 'vitest';
import { narrowHandlesByProfile, profileAllowsHandle } from '../authentication-profile';

const profile = (values: Record<string, unknown>) => ({ kind: 'profile' as const, values });

describe('an authentication method profile', () => {
  it('narrows the tenant’s methods for the use, and never adds one', () => {
    const members = profile({
      'authentication-methods.passkey.signup_enabled': false,
      'authentication-methods.totp.signup_enabled': true,
    });
    expect(narrowHandlesByProfile(['mail_otp', 'passkey'], members, 'signup')).toEqual([
      'mail_otp',
    ]);
    // Login is another use: the profile does not turn passkey off for it.
    expect(narrowHandlesByProfile(['mail_otp', 'passkey'], members, 'login')).toEqual([
      'mail_otp',
      'passkey',
    ]);
    // On in the profile, off for the tenant: not offered (it is not in the tenant's list).
    expect(narrowHandlesByProfile(['mail_otp'], members, 'signup')).not.toContain('totp');
  });

  it('narrows external providers as its own provider list has them', () => {
    const social = profile({
      'authentication-methods.external_provider_usage': JSON.stringify([
        { id: 'Google', enabled: true, signupEnabled: false },
        { id: 'github', enabled: false },
      ]),
    });
    expect(profileAllowsHandle(social, 'google', 'signup')).toBe(false);
    expect(profileAllowsHandle(social, 'google', 'login')).toBe(true);
    expect(profileAllowsHandle(social, 'github', 'login')).toBe(false);
    // A provider the profile does not list: as the tenant has it.
    expect(profileAllowsHandle(social, 'facebook', 'signup')).toBe(true);
  });

  it('offers the tenant’s methods for the default profile, and none for one that is gone', () => {
    expect(narrowHandlesByProfile(['passkey', 'guest'], { kind: 'default' }, 'login')).toEqual([
      'passkey',
      'guest',
    ]);
    expect(narrowHandlesByProfile(['passkey', 'guest'], { kind: 'missing' }, 'login')).toEqual([]);
  });
});
