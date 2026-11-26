import { describe, expect, it } from 'vitest';
import worker, { appSiteAssociation } from '../applink/index';

const env = { APP_IDS: 'BQ23XXWDX8.com.authrim.keyring.staging' };
const get = (path: string, method = 'GET'): Response =>
  worker.fetch(new Request(`https://keyring-staging.authrim.com${path}`, { method }), env);

describe('app-link worker', () => {
  it('serves the AASA file as JSON without redirects', async () => {
    const res = get('/.well-known/apple-app-site-association');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['BQ23XXWDX8.com.authrim.keyring.staging'],
            components: [{ '/': '/oauth/callback' }],
          },
        ],
      },
    });
  });

  it('serves the fallback page on the callback path only', async () => {
    const res = get('/oauth/callback?code=x');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('iPhone where Keyring is installed');
    expect(get('/oauth/callback/extra').status).toBe(404);
    expect(get('/').status).toBe(404);
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    expect(await get('/.well-known/apple-app-site-association', 'HEAD').text()).toBe('');
    expect(get('/oauth/callback', 'POST').status).toBe(405);
  });

  it('drops malformed app ids from the file', () => {
    const parsed = JSON.parse(appSiteAssociation('bad, BQ23XXWDX8.com.authrim.keyring ,"><x')) as {
      applinks: { details: { appIDs: string[] }[] };
    };
    expect(parsed.applinks.details[0].appIDs).toEqual(['BQ23XXWDX8.com.authrim.keyring']);
  });
});
