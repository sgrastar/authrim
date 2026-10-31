import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_METHODS_DEFAULTS,
  AUTHENTICATION_METHODS_SETTINGS_META,
} from '../authentication-methods';

describe('DID login setting', () => {
  const key = 'authentication-methods.did.login_enabled';

  it('is off unless the tenant turns it on, in the meta and in the defaults', () => {
    expect(AUTHENTICATION_METHODS_SETTINGS_META[key].type).toBe('boolean');
    expect(AUTHENTICATION_METHODS_SETTINGS_META[key].default).toBe(false);
    expect(AUTHENTICATION_METHODS_DEFAULTS[key]).toBe(false);
  });

  it('is the only DID switch: linking and listing DIDs are credential management, not login', () => {
    expect(
      Object.keys(AUTHENTICATION_METHODS_SETTINGS_META).filter((k) => k.includes('.did.'))
    ).toEqual([key]);
  });

  it('keeps every login switch of the other methods as it was', () => {
    expect(AUTHENTICATION_METHODS_DEFAULTS['authentication-methods.passkey.login_enabled']).toBe(
      true
    );
    expect(AUTHENTICATION_METHODS_DEFAULTS['authentication-methods.email_otp.login_enabled']).toBe(
      false
    );
    expect(AUTHENTICATION_METHODS_DEFAULTS['authentication-methods.totp.login_enabled']).toBe(
      false
    );
  });
});
