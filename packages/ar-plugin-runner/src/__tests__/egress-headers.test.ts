import { describe, expect, it } from 'vitest';
import {
  isApprovedCredentialInjectionHeader,
  STRIPPED_PLUGIN_EGRESS_HEADERS,
} from '../egress-headers';

describe('credential injection header policy', () => {
  it.each(STRIPPED_PLUGIN_EGRESS_HEADERS)(
    'blocks host-managed or sensitive header %s for named injection',
    (name) => {
      expect(isApprovedCredentialInjectionHeader('header', name)).toBe(false);
      expect(isApprovedCredentialInjectionHeader('header', name.toUpperCase())).toBe(false);
    }
  );

  it.each(['content-type', 'content-encoding'])(
    'prevents credentials from replacing payload metadata %s',
    (name) => {
      expect(isApprovedCredentialInjectionHeader('header', name)).toBe(false);
    }
  );

  it('allows only authorization for bearer injection, regardless of case', () => {
    expect(isApprovedCredentialInjectionHeader('bearer', 'Authorization')).toBe(true);
    expect(isApprovedCredentialInjectionHeader('bearer', 'AUTHORIZATION')).toBe(true);
    expect(isApprovedCredentialInjectionHeader('bearer', 'x-api-key')).toBe(false);
    expect(isApprovedCredentialInjectionHeader('bearer', 'cookie')).toBe(false);
  });

  it('allows a provider-specific header without allowing ordinary authorization injection', () => {
    expect(isApprovedCredentialInjectionHeader('header', 'X-Resend-Key')).toBe(true);
    expect(isApprovedCredentialInjectionHeader('header', 'Authorization')).toBe(false);
  });
});
