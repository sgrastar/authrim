import { describe, expect, it } from 'vitest';
import { buildSetupUiUrl, isAllowedSetupOrigin } from '../web/server.js';

describe('setup web server security helpers', () => {
  it('allows only loopback browser origins for WSL-bound API CORS', () => {
    expect(isAllowedSetupOrigin('http://localhost:3456', 3456)).toBe(true);
    expect(isAllowedSetupOrigin('http://127.0.0.1:3456', 3456)).toBe(true);
    expect(isAllowedSetupOrigin('http://192.168.1.20:3456', 3456)).toBe(false);
    expect(isAllowedSetupOrigin('http://localhost:4567', 3456)).toBe(false);
  });

  it('places the setup capability token in the URL only when requested', () => {
    expect(buildSetupUiUrl('http://localhost:3456', { lang: 'ja' })).toBe(
      'http://localhost:3456/?lang=ja'
    );
    expect(buildSetupUiUrl('http://localhost:3456', { lang: 'ja', token: 'setup-secret' })).toBe(
      'http://localhost:3456/?lang=ja&setup_token=setup-secret'
    );
  });
});
