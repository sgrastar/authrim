import { describe, expect, it } from 'vitest';
import app from '../index';

describe('async auth CORS', () => {
  it('reflects public API origins without allowing credentials', async () => {
    const res = await app.fetch(
      new Request('https://auth.example.com/device_authorization', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example.com',
          'Access-Control-Request-Method': 'POST',
        },
      }),
      {} as never
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
