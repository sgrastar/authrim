import { dispatchScheduled } from './scheduled';
import { loadConfig } from './config';
import { handleStart, handleStartPage, handleStatus, handleWaitPage, langOf } from './handlers';
import { SCENE_JS, SITE_CSS, WAIT_JS } from './html';
import { logError } from './log';
import { assetResponse, errorResponse, withSecurityHeaders } from './respond';
import { createDeps, type Deps, type Env, type Lifetime } from './types';

const ROUTES: Record<string, string[]> = {
  '/': ['GET', 'HEAD'],
  '/start': ['POST'],
  '/wait': ['GET', 'HEAD'],
  '/status': ['GET'],
  '/healthz': ['GET', 'HEAD'],
  '/assets/site.css': ['GET', 'HEAD'],
  '/assets/scene.js': ['GET', 'HEAD'],
  '/assets/wait.js': ['GET', 'HEAD'],
};

async function route(
  request: Request,
  env: Env,
  deps: Deps,
  lifetime?: Lifetime
): Promise<Response> {
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
  if (url.pathname === '/assets/scene.js') {
    return assetResponse(SCENE_JS, 'text/javascript; charset=utf-8');
  }
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
      return handleStartPage(request, env, config, deps, lifetime);
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
  deps: Deps = createDeps(env),
  lifetime?: Lifetime
): Promise<Response> {
  let response: Response;
  try {
    response = await route(request, env, deps, lifetime);
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
  fetch: (request: Request, env: Env, ctx?: Lifetime): Promise<Response> =>
    handleRequest(request, env, createDeps(env), ctx),
  scheduled: async (controller: { cron: string }, env: Env): Promise<void> => {
    await dispatchScheduled(controller.cron, env, createDeps(env));
  },
};
