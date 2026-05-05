import { Hono, type Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  cancelStepUpAction,
  completeStepUpAction,
  createStepUpErrorResponse,
  getStepUpActionStatus,
  requiredIdempotencyMiddleware,
  resendStepUpAction,
  startStepUpAction,
  StepUpFlowError,
  StepUpPolicyError,
  type StepUpPreferredMethod,
} from '@authrim/ar-lib-core';

export const stepUpRouter = new Hono<{ Bindings: Env }>();

type StepUpContext = Context<{ Bindings: Env }>;

function withNoStore(c: { header: (name: string, value: string) => void }): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

function jsonNoStore(
  c: StepUpContext,
  body: unknown,
  status: 200 | 400 | 404 | 500 = 200
): Response {
  withNoStore(c);
  return c.json(body, status);
}

async function readJson(c: StepUpContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePreferredMethod(value: unknown): StepUpPreferredMethod | Response | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    return new Response(
      JSON.stringify({
        error: 'invalid_request',
        error_description: 'preferred_method must be an object',
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      }
    );
  }
  const category = typeof value.category === 'string' ? value.category.trim() : undefined;
  const method = typeof value.method === 'string' ? value.method.trim() : undefined;
  if (!category && !method) {
    return new Response(
      JSON.stringify({
        error: 'invalid_request',
        error_description: 'preferred_method must include category or method',
      }),
      {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      }
    );
  }
  return {
    ...(category ? { category } : {}),
    ...(method ? { method } : {}),
  };
}

function stepUpFlowErrorToResponse(error: StepUpFlowError): Response {
  const headers: Record<string, string> = {};
  if (error.retryAfterSeconds) {
    headers['Retry-After'] = String(error.retryAfterSeconds);
  }

  if (!error.detailCode) {
    return new Response(
      JSON.stringify({
        error: error.error,
        error_description: error.message,
      }),
      {
        status: error.httpStatus,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
          ...headers,
        },
      }
    );
  }

  const response = createStepUpErrorResponse(
    {
      error: error.error,
      error_description: error.message,
      code: error.detailCode,
      ...(error.stepUp ? { step_up: error.stepUp } : {}),
      ...(error.statusObject ? { status: error.statusObject } : {}),
      ...(error.inputState ? { input_state: error.inputState } : {}),
      ...(error.nextAction ? { next_action: error.nextAction } : {}),
    },
    error.httpStatus === 404 ? 400 : error.httpStatus
  );
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

function unknownErrorToResponse(error: unknown): Response {
  if (error instanceof StepUpFlowError) {
    return stepUpFlowErrorToResponse(error);
  }
  const description =
    error instanceof StepUpPolicyError
      ? error.message
      : 'Step-up request could not be processed';
  return new Response(
    JSON.stringify({
      error: 'server_error',
      error_description: description,
    }),
    {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  );
}

stepUpRouter.post('/start', async (c) => {
  try {
    const body = await readJson(c);
    if (!isObject(body) || typeof body.step_up_token !== 'string') {
      return jsonNoStore(
        c,
        {
          error: 'invalid_request',
          error_description: 'step_up_token is required',
        },
        400
      );
    }

    const preferredMethod = parsePreferredMethod(body.preferred_method);
    if (preferredMethod instanceof Response) {
      return preferredMethod;
    }

    const response = await startStepUpAction(c.env, {
      stepUpToken: body.step_up_token,
      preferredMethod,
    });
    return jsonNoStore(c, response);
  } catch (error) {
    return unknownErrorToResponse(error);
  }
});

stepUpRouter.get('/actions/:actionId', async (c) => {
  try {
    const response = await getStepUpActionStatus(c.env, c.req.param('actionId'));
    return jsonNoStore(c, response);
  } catch (error) {
    return unknownErrorToResponse(error);
  }
});

stepUpRouter.post(
  '/actions/:actionId/complete',
  requiredIdempotencyMiddleware({ ttlSeconds: 300 }),
  async (c) => {
    try {
      const body = await readJson(c);
      if (!isObject(body) || typeof body.method !== 'string') {
        return jsonNoStore(
          c,
          {
            error: 'invalid_request',
            error_description: 'method is required',
          },
          400
        );
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'input')) {
        return jsonNoStore(
          c,
          {
            error: 'invalid_request',
            error_description: 'input is required',
          },
          400
        );
      }

      const response = await completeStepUpAction(c.env, {
        actionId: c.req.param('actionId'),
        method: body.method,
        input: body.input,
      });
      return jsonNoStore(c, response);
    } catch (error) {
      return unknownErrorToResponse(error);
    }
  }
);

stepUpRouter.post(
  '/actions/:actionId/resend',
  requiredIdempotencyMiddleware({ ttlSeconds: 300 }),
  async (c) => {
    try {
      const response = await resendStepUpAction(c.env, {
        actionId: c.req.param('actionId'),
      });
      return jsonNoStore(c, response);
    } catch (error) {
      return unknownErrorToResponse(error);
    }
  }
);

stepUpRouter.delete('/actions/:actionId', async (c) => {
  try {
    const response = await cancelStepUpAction(c.env, c.req.param('actionId'));
    return jsonNoStore(c, response);
  } catch (error) {
    return unknownErrorToResponse(error);
  }
});
