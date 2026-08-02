import { describe, expect, it } from 'vitest';
import { authorizePluginEgressUrl } from '../egress-policy';

describe('authorizePluginEgressUrl', () => {
  it('allows exact hosts and proper suffix children only', () => {
    expect(
      authorizePluginEgressUrl('https://api.example.com/path', [
        { kind: 'exact', host: 'api.example.com' },
      ]).hostname
    ).toBe('api.example.com');
    expect(
      authorizePluginEgressUrl('https://hooks.eu.example.com/path', [
        { kind: 'suffix_wildcard', suffix: '*.example.com' },
      ]).hostname
    ).toBe('hooks.eu.example.com');
    expect(() =>
      authorizePluginEgressUrl('https://example.com/path', [
        { kind: 'suffix_wildcard', suffix: '*.example.com' },
      ])
    ).toThrow('plugin_egress_host_denied');
  });

  it.each([
    'http://api.example.com/',
    'https://user:password@api.example.com/',
    'https://api.example.com:8443/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://api.example.com./',
    'https://xn--e1afmkfd.example.com/',
    'https://%61pi.example.com/',
    'https://api.example.com/#fragment',
  ])('rejects unsafe URL %s', (url) => {
    expect(() =>
      authorizePluginEgressUrl(url, [{ kind: 'exact', host: 'api.example.com' }])
    ).toThrow(/plugin_egress_(url|host)_invalid/u);
  });

  it('rejects broad suffix wildcard rules', () => {
    expect(() =>
      authorizePluginEgressUrl('https://api.example.com/', [
        { kind: 'suffix_wildcard', suffix: '*.com' },
      ])
    ).toThrow('plugin_egress_rule_too_broad');
  });
});
