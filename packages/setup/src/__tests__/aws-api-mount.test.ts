import { describe, expect, it } from 'vitest';
import { createApiRoutes, generateSessionToken, getSessionToken } from '../web/api.js';

describe('AWS setup API mounted in the setup server', () => {
  it('requires the setup session and same loopback origin before reading input or spawning work', async () => {
    generateSessionToken();
    const app = createApiRoutes();
    const missing = await app.request('http://localhost:3456/aws/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3456' },
      body: '{}',
    });
    expect(missing.status).toBe(401);
    const foreign = await app.request('http://localhost:3456/aws/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': getSessionToken(),
        Origin: 'https://foreign.example.test',
      },
      body: '{}',
    });
    expect(foreign.status).toBe(403);
    const invalid = await app.request('http://localhost:3456/aws/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': getSessionToken(),
        Origin: 'http://localhost:3456',
      },
      body: '{}',
    });
    expect(invalid.status).toBe(400);
  });
});
