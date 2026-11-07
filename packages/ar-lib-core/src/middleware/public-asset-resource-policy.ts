import type { MiddlewareHandler } from 'hono';

/** The public Login UI images: `/api/assets/<tenant>/login-ui/<kind>/<file>` (and the presets below). */
const PUBLIC_LOGIN_UI_ASSET = /^\/api\/assets\/[^/]+\/login-ui\/[^/]+\/[^/]+$/u;

/**
 * The background presets shared by every tenant: placed in PUBLIC_ASSETS by the setup tool at
 * `presets/login-ui/backgrounds/<category>/<name>.<ext>` and served at
 * `/api/assets/presets/login-ui/backgrounds/<category>/<name>.<ext>`. A theme refers to one by
 * that path instead of a copy of its own. They sit outside `public/<tenant>/`, so the orphan
 * cleanup and tenant backups (both tenant-scoped) leave them alone.
 */
export const LOGIN_UI_PRESET_KEY_PREFIX = 'presets/login-ui/backgrounds/';
export const LOGIN_UI_PRESET_URL_PREFIX = '/api/assets/presets/login-ui/backgrounds/';
const LOGIN_UI_PRESET_SEGMENTS = /^([a-z0-9-]{1,64})\/([a-z0-9-]{1,128})\.(webp|jpe?g|png)$/u;

export interface LoginUiPresetName {
  category: string;
  name: string;
  extension: string;
}

/** `<category>/<name>.<ext>` (a key or a path without its prefix), or null when it is not one. */
export function parseLoginUiPresetName(rest: string): LoginUiPresetName | null {
  const match = LOGIN_UI_PRESET_SEGMENTS.exec(rest);
  return match ? { category: match[1], name: match[2], extension: match[3] } : null;
}

export function isLoginUiPresetAssetPath(path: string): boolean {
  return (
    path.startsWith(LOGIN_UI_PRESET_URL_PREFIX) &&
    parseLoginUiPresetName(path.slice(LOGIN_UI_PRESET_URL_PREFIX.length)) !== null
  );
}

export function isPublicLoginUiAssetPath(path: string): boolean {
  return PUBLIC_LOGIN_UI_ASSET.test(path) || isLoginUiPresetAssetPath(path);
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
