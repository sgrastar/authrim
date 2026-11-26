/**
 * App-link host for Keyring (`keyring.authrim.com`, `keyring-staging.authrim.com`): serves the
 * `apple-app-site-association` file for `/oauth/callback` and a plain fallback page for browsers
 * that do not hand the link to the app. No bindings, no state, no secrets.
 */

export interface ApplinkEnv {
  /** Comma separated `<appIdPrefix>.<bundleId>` allowed to open `/oauth/callback` (a var). */
  APP_IDS: string;
}

const CALLBACK_PATH = '/oauth/callback';
const AASA_PATH = '/.well-known/apple-app-site-association';
const SECURITY_HEADERS = {
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function appSiteAssociation(appIds: string): string {
  const ids = appIds
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(id));
  return JSON.stringify({
    applinks: { details: [{ appIDs: ids, components: [{ '/': CALLBACK_PATH }] }] },
  });
}

const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Keyring</title></head>
<body><p>Open this link on the iPhone where Keyring is installed.</p></body></html>`;

export default {
  fetch(request: Request, env: ApplinkEnv): Response {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (url.pathname === AASA_PATH) {
      return new Response(request.method === 'HEAD' ? null : appSiteAssociation(env.APP_IDS), {
        headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' },
      });
    }
    if (url.pathname === CALLBACK_PATH) {
      return new Response(request.method === 'HEAD' ? null : FALLBACK_HTML, {
        headers: {
          ...SECURITY_HEADERS,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'none'",
        },
      });
    }
    return new Response('Not Found', { status: 404, headers: SECURITY_HEADERS });
  },
};
