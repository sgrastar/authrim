import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../origin-validator';

describe('origin wildcard validation', () => {
  it('allows exact origins and HTTPS single-label subdomain wildcards', () => {
    expect(isAllowedOrigin('https://app.example.com', ['https://app.example.com'])).toBe(true);
    expect(isAllowedOrigin('https://app.example.com', ['https://*.example.com'])).toBe(true);
  });

  it('does not let single-label wildcards match deeper subdomains', () => {
    expect(isAllowedOrigin('https://deep.app.example.com', ['https://*.example.com'])).toBe(false);
  });

  it('rejects broad or misplaced wildcard origin patterns', () => {
    expect(isAllowedOrigin('https://app.example.com', ['https://*example.com'])).toBe(false);
    expect(isAllowedOrigin('https://app.example.com', ['https://app.*.com'])).toBe(false);
    expect(isAllowedOrigin('http://app.example.com', ['http://*.example.com'])).toBe(false);
  });
});
