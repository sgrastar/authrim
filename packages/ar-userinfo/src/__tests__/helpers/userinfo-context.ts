import { vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

/** A Hono-like context whose json/body/header calls are recorded, for calling userinfoHandler. */
export interface RecordingContext {
  c: Context<{ Bindings: Env }>;
  json: ReturnType<typeof vi.fn>;
  body: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

export function recordingContext(
  options: { env?: Record<string, unknown>; tenantId?: string } = {}
): RecordingContext {
  const logger = {
    module: () => logger,
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const env = { ISSUER_URL: 'https://op.example.com', ...options.env };
  const json = vi.fn(
    (payload: unknown, status?: number): Response =>
      new Response(JSON.stringify(payload), { status: status ?? 200 })
  );
  const body = vi.fn(
    (text: string, status?: number): Response => new Response(text, { status: status ?? 200 })
  );
  const header = vi.fn();
  const c = {
    req: {
      header: (name: string) => (name === 'x-fapi-interaction-id' ? undefined : undefined),
      method: 'GET',
      raw: new Request('https://op.example.com/userinfo'),
    },
    env,
    json,
    body,
    header,
    get: (key: string) => {
      if (key === 'logger') return logger;
      if (key === 'tenantId') return options.tenantId ?? 'default';
      return undefined;
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { c, json, body, header, logger };
}

/** The first (body, status) pair passed to c.json, or c.body. */
export function lastJson(ctx: RecordingContext): { body: Record<string, unknown>; status: number } {
  const call = ctx.json.mock.calls.at(-1) as [Record<string, unknown>, number | undefined];
  return { body: call[0], status: call[1] ?? 200 };
}

export function headerValue(ctx: RecordingContext, name: string): string | undefined {
  const call = ctx.header.mock.calls.find((entry) => entry[0] === name) as
    | [string, string]
    | undefined;
  return call?.[1];
}
