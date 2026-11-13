import { loadConfig } from './config';
import { handleStart, handleStartPage, handleStatus, handleWaitPage, langOf } from './handlers';
import { SITE_CSS, WAIT_JS } from './html';
import { logError } from './log';
import { assetResponse, errorResponse, withSecurityHeaders } from './respond';
import { defaultDeps, type Deps, type Env } from './types';

const ROUTES: Record<string, string[]> = {
  '/': ['GET', 'HEAD'],
  '/start': ['POST'],
  '/wait': ['GET', 'HEAD'],
  '/status': ['GET'],
  '/healthz': ['GET', 'HEAD'],
  '/assets/site.css': ['GET', 'HEAD'],
  '/assets/wait.js': ['GET', 'HEAD'],
};

async function route(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const lang = langOf(request);
  const allowed = ROUTES[url.pathname];
  if (!allowed) return errorResponse(lang, 'not_found', 404);
  if (!allowed.includes(request.method)) {
    const response = errorResponse(lang, 'method', 405);
    response.headers.set('Allow', allowed.join(', '));
    return response;
  }

  if (url.pathname === '/healthz') {
    return new Response('ok', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (url.pathname === '/assets/site.css')
    return assetResponse(SITE_CSS, 'text/css; charset=utf-8');
  if (url.pathname === '/assets/wait.js') {
    return assetResponse(WAIT_JS, 'text/javascript; charset=utf-8');
  }

  const loaded = loadConfig(env);
  if (!loaded.ok) {
    logError('config_invalid', { detail: loaded.problems.join(',') });
    return errorResponse(lang, 'config', 503);
  }
  const { config } = loaded;
  switch (url.pathname) {
    case '/':
      return handleStartPage(request, config);
    case '/start':
      return handleStart(request, env, config, deps);
    case '/wait':
      return handleWaitPage(request, config);
    default:
      return handleStatus(request, env, config, deps);
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  deps: Deps = defaultDeps
): Promise<Response> {
  let response: Response;
  try {
    response = await route(request, env, deps);
  } catch {
    logError('unhandled_error');
    response = errorResponse(langOf(request), 'failed', 500);
  }
  if (request.method === 'HEAD') {
    response = new Response(null, { status: response.status, headers: response.headers });
  }
  return withSecurityHeaders(response);
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env),
};
