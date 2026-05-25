import { describe, expect, it } from 'vitest';
import { buildSAMLPostBindingResponse } from '../post-binding-form';

describe('buildSAMLPostBindingResponse', () => {
  it('uses nonce-based script CSP instead of inline event handlers', async () => {
    const response = buildSAMLPostBindingResponse({
      title: 'SAML SSO',
      actionUrl: 'https://sp.example.com/acs',
      fields: [{ name: 'SAMLResponse', value: 'response' }],
      buttonText: 'Continue',
    });

    const html = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(html).not.toContain('onload=');
    expect(html).toContain('<script nonce="');
    expect(csp).toContain("script-src 'nonce-");
    expect(csp).toContain("style-src 'none'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('form-action https://sp.example.com https://sp.example.com/');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('allows query-only ACS URLs with pathless and slash origin form-action sources', async () => {
    const response = buildSAMLPostBindingResponse({
      title: 'SAML SSO',
      actionUrl: 'https://samlsp.com/?acs',
      fields: [{ name: 'SAMLResponse', value: 'response' }],
      buttonText: 'Continue',
    });

    const html = await response.text();
    const csp = response.headers.get('content-security-policy') ?? '';

    expect(html).toContain('action="https://samlsp.com/?acs"');
    expect(csp).toContain('form-action https://samlsp.com https://samlsp.com/');
    expect(csp).not.toContain('form-action https://samlsp.com?acs');
  });
});
