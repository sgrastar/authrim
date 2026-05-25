import { describe, expect, it } from 'vitest';
import app from '../index';

describe('SAML CORS', () => {
  it('does not allow credentialed wildcard CORS', async () => {
    const res = await app.fetch(
      new Request('https://auth.example.com/saml/metadata', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'GET',
        },
      }),
      {} as never
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
