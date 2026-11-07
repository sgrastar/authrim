import { describe, expect, it } from 'vitest';
import { AUTH_CORS_ALLOW_HEADERS } from '../cors-headers';

describe('ar-auth CORS request headers', () => {
  it('never lets another origin ask for a form post as data (X-Authrim-Relay)', () => {
    expect(AUTH_CORS_ALLOW_HEADERS.map((header) => header.toLowerCase())).not.toContain(
      'x-authrim-relay'
    );
  });
});
