/** Lazy Lambda entrypoint. Deployment code supplies verified local inputs and secrets. */
import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import { createAwsSamlRuntime, type AwsTenantRuntime } from '../http-runtime';

export interface LoadedAwsSamlTenants {
  tenants: readonly AwsTenantRuntime[];
  close(): Promise<void>;
}

export interface LazyAwsSamlLambdaHandlerInput {
  /** Called once per successful cold start; each loader must close its own partial resources on error. */
  loadTenants(): Promise<LoadedAwsSamlTenants>;
}

function unavailable() {
  return {
    statusCode: 503,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'temporarily_unavailable' }),
    isBase64Encoded: false,
  };
}

/** Shares concurrent initialization, then delegates every request to the existing Hono gateway. */
export function createLazyAwsSamlLambdaHandler(input: LazyAwsSamlLambdaHandlerInput) {
  let initialized:
    | Promise<{
        loaded: LoadedAwsSamlTenants;
        handler: ReturnType<typeof createAwsSamlRuntime>['handler'];
      }>
    | undefined;
  let closed = false;

  const initialize = async () => {
    const loaded = await input.loadTenants();
    try {
      const runtime = createAwsSamlRuntime({ tenants: loaded.tenants });
      await Promise.all(loaded.tenants.map((tenant) => tenant.assertReady()));
      return { loaded, handler: runtime.handler };
    } catch {
      await loaded.close().catch(() => undefined);
      throw new Error('aws_lambda_initialization_failed');
    }
  };

  const handler = async (event: LambdaEvent, context?: LambdaContext) => {
    if (closed) return unavailable();
    const pending = (initialized ??= initialize());
    let ready: Awaited<typeof pending>;
    try {
      ready = await pending;
    } catch {
      if (initialized === pending) initialized = undefined;
      return unavailable();
    }
    if (closed) return unavailable();
    try {
      return await ready.handler(event, context);
    } catch {
      return unavailable();
    }
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    const pending = initialized;
    initialized = undefined;
    if (!pending) return;
    const ready = await pending.catch(() => null);
    await ready?.loaded.close();
  };

  return { handler, close };
}
