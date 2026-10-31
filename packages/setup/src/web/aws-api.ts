import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { AwsSetupWebRunner, AwsWebError, type AwsWebRunnerOptions } from './aws-setup-runner.js';

type Runner = Pick<
  AwsSetupWebRunner,
  'configure' | 'check' | 'plan' | 'dsqlCheck' | 'start' | 'status'
>;
export interface AwsSetupApiOptions extends AwsWebRunnerOptions {
  getToken: () => string | undefined;
  runner?: Runner;
}
const LIMIT = 16 * 1024;
function fail(code: string): never {
  throw new AwsWebError(`aws_web_${code}`);
}
function sameOrigin(url: string, origin?: string): boolean {
  if (!origin) return false;
  try {
    const request = new URL(url);
    const source = new URL(origin);
    return (
      request.origin === source.origin &&
      ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)
    );
  } catch {
    return false;
  }
}
async function body(
  c: Context,
  allowed: string[],
  required = allowed
): Promise<Record<string, unknown>> {
  const contentLength = c.req.header('Content-Length');
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > LIMIT))
    fail('body_too_large');
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json'))
    fail('content_type_invalid');
  const reader = c.req.raw.body?.getReader();
  if (!reader) fail('body_invalid');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > LIMIT) {
        await reader.cancel();
        fail('body_too_large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('body_invalid');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  )
    fail('body_invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string') fail('body_invalid');
  return value;
}

/** Every AWS operation, including status and read-only checks, requires the local setup session. */
export function createAwsSetupApi(options: AwsSetupApiOptions): Hono {
  const api = new Hono();
  const runner = options.runner ?? new AwsSetupWebRunner(options);
  api.use('*', async (c, next) => {
    const expected = options.getToken();
    const supplied = c.req.header('X-Session-Token');
    const expectedBytes = Buffer.from(expected ?? '');
    const suppliedBytes = Buffer.from(supplied ?? '');
    if (
      !expected ||
      !supplied ||
      suppliedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(suppliedBytes, expectedBytes)
    )
      return c.json({ success: false, code: 'aws_web_unauthorized' }, 401);
    if (!sameOrigin(c.req.url, c.req.header('Origin')))
      return c.json({ success: false, code: 'aws_web_origin_invalid' }, 403);
    if (c.req.method !== 'POST')
      return c.json({ success: false, code: 'aws_web_method_invalid' }, 405);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  api.onError((error, c) => {
    const code = error instanceof AwsWebError ? error.code : 'aws_web_operation_failed';
    return c.json(
      { success: false, status: 'blocked', code },
      code === 'aws_web_operation_running' ? 409 : code === 'aws_web_body_too_large' ? 413 : 400
    );
  });
  api.post('/check', async (c) => {
    const input = await body(c, ['accountId', 'region', 'profile']);
    return c.json(
      await runner.check({
        accountId: text(input.accountId),
        region: text(input.region),
        profile: text(input.profile),
      })
    );
  });
  api.post('/configuration', async (c) => {
    const input = await body(c, ['configuration']);
    return c.json(await runner.configure(input.configuration), 201);
  });
  api.post('/plan', async (c) => {
    const input = await body(c, ['configPath', 'accountId', 'region']);
    return c.json(
      await runner.plan({
        configPath: text(input.configPath),
        accountId: text(input.accountId),
        region: text(input.region),
      }),
      202
    );
  });
  api.post('/dsql/check', async (c) => {
    const input = await body(c, ['configPath', 'accountId', 'region', 'profile']);
    return c.json(
      await runner.dsqlCheck({
        configPath: text(input.configPath),
        accountId: text(input.accountId),
        region: text(input.region),
        profile: text(input.profile),
      }),
      202
    );
  });
  api.post('/operations/:runId/status', async (c) => {
    await body(c, []);
    return c.json(await runner.status(c.req.param('runId')));
  });
  for (const mode of ['apply', 'resume', 'verify'] as const) {
    api.post(`/operations/:runId/${mode}`, async (c) => {
      const input = await body(
        c,
        mode === 'verify' ? ['planSha256', 'userCount'] : ['planSha256'],
        ['planSha256']
      );
      if (
        input.userCount !== undefined &&
        (typeof input.userCount !== 'number' ||
          !Number.isSafeInteger(input.userCount) ||
          input.userCount < 1 ||
          input.userCount > 2000)
      )
        fail('body_invalid');
      return c.json(
        await runner.start(
          c.req.param('runId'),
          mode,
          text(input.planSha256),
          input.userCount as number | undefined
        ),
        202
      );
    });
  }
  return api;
}
