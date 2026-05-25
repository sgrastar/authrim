import { describe, expect, it } from 'vitest';
import { assertSAMLRelayStateSize, SAMLRelayStateTooLargeError } from '../relay-state';

describe('SAML RelayState limits', () => {
  it('accepts empty and short RelayState values', () => {
    expect(() => assertSAMLRelayStateSize(undefined)).not.toThrow();
    expect(() => assertSAMLRelayStateSize(null)).not.toThrow();
    expect(() => assertSAMLRelayStateSize('opaque-state')).not.toThrow();
  });

  it('rejects RelayState values over 80 bytes', () => {
    expect(() => assertSAMLRelayStateSize('a'.repeat(81))).toThrow(SAMLRelayStateTooLargeError);
  });

  it('counts UTF-8 bytes, not JavaScript string length', () => {
    expect(() => assertSAMLRelayStateSize('あ'.repeat(27))).toThrow(SAMLRelayStateTooLargeError);
  });
});
