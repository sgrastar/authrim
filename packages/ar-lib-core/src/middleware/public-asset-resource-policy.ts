import type { MiddlewareHandler } from 'hono';

/** The public Login UI images: `/api/assets/<tenant>/login-ui/<kind>/<file>`. */
const PUBLIC_LOGIN_UI_ASSET = /^\/api\/assets\/[^/]+\/login-ui\/[^/]+\/[^/]+$/u;

export function isPublicLoginUiAssetPath(path: string): boolean {
  return PUBLIC_LOGIN_UI_ASSET.test(path);
}

/**
 * Lets pages on other origins show the public Login UI images (logos, backgrounds): the admin
 * console when it is served apart from the API, a tenant's vanity domain. The security headers
 * make every response same-origin only (Cross-Origin-Resource-Policy), which a browser enforces
 * on <img> and CSS images too. These images are public by design, so a successful GET or HEAD of
 * one is opened to other origins; nothing else changes.
 *
 * Register it before the security headers middleware: it then runs after them and has the last
 * word on this header.
 */
export function publicLoginUiAssetResourcePolicy(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return;
    if (!isPublicLoginUiAssetPath(c.req.path) || !c.res.ok) return;
    // A response from a service binding has immutable headers: copy it before changing one.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  };
}
