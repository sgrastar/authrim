import { vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { handleBackchannelLogout } from '../../handlers/backchannel-logout';

export const NOW_MS = 1_700_000_000_000;
export const NOW_S = NOW_MS / 1000;
export const TENANT = 'tenant-a';

export interface BackchannelResult {
  response: Response;
  waited: Array<Promise<unknown>>;
}

/** Posts a form (or a raw request) to the handler, collecting what was handed to waitUntil. */
export async function postBackchannel(
  env: Env,
  options: {
    body?: string | null;
    contentType?: string | null;
    route?: string;
    url?: string;
    withExecutionContext?: boolean;
  } = {}
): Promise<BackchannelResult> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('tenantId' as never, TENANT);
    await next();
  });
  app.post(options.route ?? '/auth/external/:provider/backchannel-logout', handleBackchannelLogout);
  const waited: Array<Promise<unknown>> = [];
  const headers: Record<string, string> = {};
  const contentType =
    options.contentType === undefined ? 'application/x-www-form-urlencoded' : options.contentType;
  if (contentType !== null) headers['Content-Type'] = contentType;
  const init: RequestInit = { method: 'POST', headers };
  if (options.body !== null) init.body = options.body ?? 'logout_token=signed.logout.token';
  const ctx =
    options.withExecutionContext === false
      ? undefined
      : ({
          waitUntil: vi.fn((p: Promise<unknown>) => void waited.push(p)),
          passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext);
  const response = await app.request(
    options.url ?? 'https://op.example.com/auth/external/google/backchannel-logout',
    init,
    env,
    ctx
  );
  return { response, waited };
}
