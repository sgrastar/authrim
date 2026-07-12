import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  generateId,
  getChallengeStoreByChallengeId,
  getTenantIdFromContext,
  SELF_SERVICE_DEFAULTS,
  validateAccountPagePath,
} from '@authrim/ar-lib-core';

const ACCOUNT_RETURN_TTL_SECONDS = 5 * 60;

function setNoStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function parseSettingsRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function resolveAccountPageSettings(
  env: Env,
  tenantId: string
): Promise<{ enabled: boolean; path: string }> {
  const raw = await env.SETTINGS?.get(`settings:tenant:${tenantId}:self-service`);
  const record = parseSettingsRecord(raw);
  const configuredPath = record['self-service.account_page_path'];
  return {
    enabled:
      typeof record['self-service.account_page_enabled'] === 'boolean'
        ? record['self-service.account_page_enabled']
        : SELF_SERVICE_DEFAULTS['self-service.account_page_enabled'],
    path: validateAccountPagePath(configuredPath)
      ? configuredPath
      : SELF_SERVICE_DEFAULTS['self-service.account_page_path'],
  };
}

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value, 'https://authrim.invalid');
    if (url.origin !== 'https://authrim.invalid') {
      return null;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function matchesPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isAllowedAccountReturnPath(pathWithSearch: string, accountPagePath: string): boolean {
  const pathname = pathWithSearch.split('?')[0] || '/';
  return matchesPathPrefix(pathname, accountPagePath) || matchesPathPrefix(pathname, '/account');
}

export async function createAccountReturnHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  setNoStore(c);

  let body: { path?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }

  const path = normalizePath(body.path);
  const tenantId = getTenantIdFromContext(c);
  const accountPage = await resolveAccountPageSettings(c.env, tenantId);
  if (!accountPage.enabled) {
    return c.json(
      { error: 'account_page_disabled', error_description: 'Account Page is not enabled' },
      404
    );
  }
  if (!path || !isAllowedAccountReturnPath(path, accountPage.path)) {
    return c.json(
      { error: 'invalid_request', error_description: 'path must be under Account Page path' },
      400
    );
  }

  const id = generateId();
  const challengeStore = await getChallengeStoreByChallengeId(c.env, id, tenantId);
  await challengeStore.storeChallengeRpc({
    id: `account_page_return:${id}`,
    tenantId,
    type: 'account_page_return',
    challenge: id,
    ttl: ACCOUNT_RETURN_TTL_SECONDS,
    metadata: {
      path,
      accountPagePath: accountPage.path,
    },
  });

  return c.json(
    {
      account_return: id,
      expires_in: ACCOUNT_RETURN_TTL_SECONDS,
    },
    201
  );
}

export async function consumeAccountReturnHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  setNoStore(c);

  const id = c.req.param('id');
  if (!id) {
    return c.json({ error: 'not_found', error_description: 'Account return was not found' }, 404);
  }

  const tenantId = getTenantIdFromContext(c);
  const challengeStore = await getChallengeStoreByChallengeId(c.env, id, tenantId);
  let data: {
    metadata?: {
      path?: string;
      accountPagePath?: string;
    };
  };
  try {
    data = (await challengeStore.consumeChallengeRpc({
      id: `account_page_return:${id}`,
      tenantId,
      type: 'account_page_return',
    })) as typeof data;
  } catch {
    return c.json(
      { error: 'invalid_account_return', error_description: 'Account return not found or expired' },
      400
    );
  }

  const accountPage = await resolveAccountPageSettings(c.env, tenantId);
  if (!accountPage.enabled) {
    return c.json(
      { error: 'account_page_disabled', error_description: 'Account Page is not enabled' },
      404
    );
  }
  const path = typeof data.metadata?.path === 'string' ? data.metadata.path : null;
  if (!path || !isAllowedAccountReturnPath(path, accountPage.path)) {
    return c.json(
      { error: 'invalid_account_return', error_description: 'Account return is no longer valid' },
      400
    );
  }

  return c.json({
    redirect_url: path,
  });
}
