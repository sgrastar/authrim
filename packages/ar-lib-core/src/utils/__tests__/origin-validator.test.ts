import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../origin-validator';

const baseHost = ['example', 'com'].join('.');
const appOrigin = `https://app.${baseHost}`;
const deepAppOrigin = `https://deep.app.${baseHost}`;
const wildcardOrigin = `https://*.${baseHost}`;

describe('origin wildcard validation', () => {
  it('allows exact origins and HTTPS single-label subdomain wildcards', () => {
    expect(isAllowedOrigin(appOrigin, [appOrigin])).toBe(true);
    expect(isAllowedOrigin(appOrigin, [wildcardOrigin])).toBe(true);
  });

  it('does not let single-label wildcards match deeper subdomains', () => {
    expect(isAllowedOrigin(deepAppOrigin, [wildcardOrigin])).toBe(false);
  });

  it('rejects broad or misplaced wildcard origin patterns', () => {
    expect(isAllowedOrigin(appOrigin, [`https://*${baseHost}`])).toBe(false);
    expect(isAllowedOrigin(appOrigin, [['https://app', '*', 'com'].join('.')])).toBe(false);
    expect(isAllowedOrigin(`http://app.${baseHost}`, [`http://*.${baseHost}`])).toBe(false);
  });
});
