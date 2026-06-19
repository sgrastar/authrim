import { describe, expect, it } from 'vitest';
import app from '../index';

describe('auth HTTPS redirect', () => {
  it('redirects external HTTP requests to HTTPS before route handling', async () => {
    const response = await app.request('http://first.test.authrim.com/login');

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://first.test.authrim.com/login');
  });
});
