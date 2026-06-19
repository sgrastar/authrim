import { describe, expect, it } from 'vitest';
import { app } from '../index';

describe('management HTTPS redirect', () => {
  it('redirects external HTTP requests to HTTPS before route handling', async () => {
    const response = await app.request('http://admin.test.authrim.com/admin');

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://admin.test.authrim.com/admin');
  });
});
