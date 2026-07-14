import type { Context, Env as HonoEnv, MiddlewareHandler } from 'hono';
import type { Env as AuthrimEnv } from '../types/env';
import { introspectTokenFromContext } from '../utils/token-introspection';

const CONTEXT_KEY = 'activeAccessTokenProtectedResource';

export interface ActiveAccessTokenProtectedResourceContext {
  subject: string;
  tenantId: string;
  claims: Record<string, unknown>;
}

export interface ActiveAccessTokenProtectedResourceOptions {
  audience: string | ((c: Context<{ Bindings: AuthrimEnv }>) => string);
  requiredScopes?: string[];
}

export function getActiveAccessTokenProtectedResourceContext<T extends HonoEnv>(
  c: Context<T>
): ActiveAccessTokenProtectedResourceContext | null {
  const contextReader = c as unknown as { get(key: string): unknown };
  return (
    (contextReader.get(CONTEXT_KEY) as ActiveAccessTokenProtectedResourceContext | undefined) ??
    null
  );
}

export function createActiveAccessTokenProtectedResourceMiddleware(
  options: ActiveAccessTokenProtectedResourceOptions
): MiddlewareHandler<{
  Bindings: AuthrimEnv;
  Variables: { activeAccessTokenProtectedResource?: ActiveAccessTokenProtectedResourceContext };
}> {
  return async (c, next) => {
    const result = await introspectTokenFromContext(
      c as unknown as Context<{ Bindings: AuthrimEnv }>
    );
    const claims = result.claims as Record<string, unknown> | undefined;
    const subject = typeof claims?.sub === 'string' ? claims.sub : '';
    const tenantId = typeof claims?.tenant_id === 'string' ? claims.tenant_id : '';
    const expectedAudience =
      typeof options.audience === 'function'
        ? options.audience(c as unknown as Context<{ Bindings: AuthrimEnv }>)
        : options.audience;
    const audiences = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
    const scopes = typeof claims?.scope === 'string' ? claims.scope.split(/\s+/u) : [];
    if (
      !result.valid ||
      !claims ||
      !subject ||
      !tenantId ||
      !audiences.includes(expectedAudience)
    ) {
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json(
        { error: 'invalid_token', error_description: 'The access token is invalid or inactive' },
        401
      );
    }
    const missingScopes = (options.requiredScopes ?? []).filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      c.header(
        'WWW-Authenticate',
        `Bearer error="insufficient_scope", scope="${options.requiredScopes?.join(' ') ?? ''}"`
      );
      return c.json(
        {
          error: 'insufficient_scope',
          error_description: 'The access token scope is insufficient',
        },
        403
      );
    }
    c.set(CONTEXT_KEY, { subject, tenantId, claims });
    await next();
  };
}
