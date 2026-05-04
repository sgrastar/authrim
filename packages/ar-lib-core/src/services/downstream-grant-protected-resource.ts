import type { Context, MiddlewareHandler, Next } from 'hono';
import {
  authorizeDownstreamGrantServiceAccess,
  createDownstreamGrantDeniedResponse,
  downstreamGrantMiddleware,
  getDownstreamGrantMiddlewareContext,
  type DownstreamGrantHonoMiddlewareOptions,
  type DownstreamGrantMiddlewareContextDecision,
  type DownstreamGrantServiceAuthorizationInput,
  type DownstreamGrantServiceAuthorizationResult,
  type DownstreamGrantServiceAuthorizer,
  type DownstreamGrantServiceDecision,
  type DownstreamGrantServiceEvaluationResult,
} from './downstream-elevation-grant';

const DOWNSTREAM_GRANT_PROTECTED_RESOURCE_KEY = 'downstreamGrantProtectedResource';

type HonoContext = Context<any, any, any>;

export interface DownstreamGrantProtectedResourceContext<Resource> {
  resourceId: string;
  requiredResourceIds: string[];
  requiredDetailClasses: string[];
  resource: Resource | null;
  authorization: DownstreamGrantServiceEvaluationResult;
  decision: DownstreamGrantServiceDecision | null;
}

export interface DownstreamGrantProtectedResourceResolutionInput<Resource> {
  c: HonoContext;
  resourceId: string;
  resource: Resource;
}

export interface DownstreamGrantProtectedResourceLocalAuthorizationInput<Resource>
  extends DownstreamGrantProtectedResourceResolutionInput<Resource> {
  decision: DownstreamGrantServiceDecision;
}

export interface DownstreamGrantProtectedResourceOptions<Resource> {
  authorizer: DownstreamGrantServiceAuthorizer;
  verifyToken?: DownstreamGrantHonoMiddlewareOptions['verifyToken'];
  introspectToken?: DownstreamGrantHonoMiddlewareOptions['introspectToken'];
  resolveResourceId: (c: HonoContext) => Promise<string> | string;
  loadResource: (
    input: { c: HonoContext; resourceId: string }
  ) => Promise<Resource | null | undefined> | Resource | null | undefined;
  resolveRequiredResourceIds?: (
    input: DownstreamGrantProtectedResourceResolutionInput<Resource>
  ) => Promise<string[] | null | undefined> | string[] | null | undefined;
  resolveRequiredDetailClasses?: (
    input: DownstreamGrantProtectedResourceResolutionInput<Resource>
  ) => Promise<string[] | null | undefined> | string[] | null | undefined;
  resolveLocalAuthorization?: (
    input: DownstreamGrantProtectedResourceLocalAuthorizationInput<Resource>
  ) =>
    | Promise<DownstreamGrantServiceAuthorizationInput['localAuthorization']>
    | DownstreamGrantServiceAuthorizationInput['localAuthorization'];
  onNotFound?: (input: { c: HonoContext; resourceId: string }) => Promise<Response> | Response;
  onDeny?: (input: {
    c: HonoContext;
    authorization: DownstreamGrantServiceEvaluationResult;
    resourceId: string;
    resource: Resource;
  }) => Promise<Response> | Response;
}

function normalizeStringArray(values: string[] | null | undefined): string[] {
  if (!values?.length) {
    return [];
  }

  return Array.from(
    new Set(
      values.map((value) => value.trim()).filter((value): value is string => value.length > 0)
    )
  );
}

function getStoredProtectedResourceContext<Resource>(
  c: HonoContext
): DownstreamGrantProtectedResourceContext<Resource> | null {
  return (
    (c.get(
      DOWNSTREAM_GRANT_PROTECTED_RESOURCE_KEY
    ) as DownstreamGrantProtectedResourceContext<Resource> | null | undefined) ?? null
  );
}

function setStoredProtectedResourceContext<Resource>(
  c: HonoContext,
  context: DownstreamGrantProtectedResourceContext<Resource>
): void {
  c.set(DOWNSTREAM_GRANT_PROTECTED_RESOURCE_KEY, context);
}

export function createDownstreamGrantProtectedResourceMiddleware<Resource>(
  options: DownstreamGrantProtectedResourceOptions<Resource>
): MiddlewareHandler<any> {
  const authorizationMiddleware = downstreamGrantMiddleware({
    authorizer: options.authorizer,
    verifyToken: options.verifyToken,
    introspectToken: options.introspectToken,
    async resolveOverride(c) {
      const context = getStoredProtectedResourceContext<Resource>(c);
      if (!context) {
        return undefined;
      }

      return {
        requiredResourceIds: context.requiredResourceIds,
        requiredDetailClasses: context.requiredDetailClasses,
      };
    },
    async resolveLocalAuthorization({ c, decision }) {
      const context = getStoredProtectedResourceContext<Resource>(c);
      if (!context || !options.resolveLocalAuthorization || !context.resource) {
        return null;
      }

      return options.resolveLocalAuthorization({
        c,
        decision,
        resourceId: context.resourceId,
        resource: context.resource,
      });
    },
    async onDeny({ c, authorization }) {
      const context = getStoredProtectedResourceContext<Resource>(c);
      if (!context || !options.onDeny || !context.resource) {
        return createDownstreamGrantDeniedResponse(authorization);
      }

      return options.onDeny({
        c,
        authorization,
        resourceId: context.resourceId,
        resource: context.resource,
      });
    },
  });

  return async (c: HonoContext, next: Next) => {
    const resourceId = await options.resolveResourceId(c);
    setStoredProtectedResourceContext(c, {
      resourceId,
      resource: null,
      requiredResourceIds: [resourceId],
      requiredDetailClasses: [],
      authorization: {
        allowed: false,
        reasonCode: 'grant_missing',
        correlationId: null,
        redactionLevel: null,
        context: null,
        enforcement: null,
        decision: null,
        requiresOnlineCheck: false,
        failClosed: false,
      },
      decision: null,
    });

    const authorizationResponse = await authorizationMiddleware(c, async () => {
      const decisionContext =
        getDownstreamGrantMiddlewareContext(c) as DownstreamGrantMiddlewareContextDecision | null;
      const current = getStoredProtectedResourceContext<Resource>(c);
      if (!current || !decisionContext) {
        await next();
        return;
      }

      const resource = await options.loadResource({ c, resourceId });
      if (!resource) {
        c.res = options.onNotFound
          ? await options.onNotFound({ c, resourceId })
          : c.json(
              {
                error: 'resource_not_found',
                error_description: 'The requested protected resource was not found.',
              },
              404
            );
        return;
      }

      const resolutionInput = {
        c,
        resourceId,
        resource,
      };
      const requiredResourceIds = normalizeStringArray(
        (await options.resolveRequiredResourceIds?.(resolutionInput)) ?? [resourceId]
      );
      const requiredDetailClasses = normalizeStringArray(
        await options.resolveRequiredDetailClasses?.(resolutionInput)
      );
      const localAuthorization = decisionContext.decision
        ? await options.resolveLocalAuthorization?.({
            c,
            decision: decisionContext.decision,
            resourceId,
            resource,
          })
        : null;
      const finalAuthorizationBase = authorizeDownstreamGrantServiceAccess({
        ...options.authorizer.defaults,
        decision: decisionContext.decision,
        requiredResourceIds,
        requiredDetailClasses,
        localAuthorization: localAuthorization ?? null,
      });
      const finalAuthorization: DownstreamGrantServiceEvaluationResult = {
        ...decisionContext.authorization,
        ...finalAuthorizationBase,
      };

      if (!finalAuthorization.allowed) {
        c.res = options.onDeny
          ? await options.onDeny({
              c,
              authorization: finalAuthorization,
              resourceId,
              resource,
            })
          : createDownstreamGrantDeniedResponse(finalAuthorization);
        return;
      }

      setStoredProtectedResourceContext(c, {
        ...current,
        resource,
        requiredResourceIds,
        requiredDetailClasses,
        authorization: finalAuthorization,
        decision: decisionContext.decision,
      });
      await next();
    });

    return authorizationResponse ?? c.res;
  };
}

export function getDownstreamGrantProtectedResourceContext<Resource>(
  c: HonoContext
): DownstreamGrantProtectedResourceContext<Resource> | null {
  return getStoredProtectedResourceContext<Resource>(c);
}
