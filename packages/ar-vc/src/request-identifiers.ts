import type { Context } from 'hono';
import { buildRequestIdentifier, buildRequestIssuerUrl, getTenantIdFromContext } from '@authrim/ar-lib-core';
import type { Env } from './types';

type RequestIssuerEnv = Parameters<typeof buildRequestIssuerUrl>[1];

export function getRequestIssuerUrl(c: Context<{ Bindings: Env }>): string {
  return buildRequestIssuerUrl(
    c.req.raw,
    c.env as unknown as RequestIssuerEnv,
    getTenantIdFromContext(c as never)
  );
}

export function getRequestIssuerIdentifier(c: Context<{ Bindings: Env }>): string {
  return buildRequestIdentifier(
    c.req.raw,
    c.env as unknown as RequestIssuerEnv,
    getTenantIdFromContext(c as never),
    c.env.ISSUER_IDENTIFIER
  );
}

export function getRequestVerifierIdentifier(c: Context<{ Bindings: Env }>): string {
  return buildRequestIdentifier(
    c.req.raw,
    c.env as unknown as RequestIssuerEnv,
    getTenantIdFromContext(c as never),
    c.env.VERIFIER_IDENTIFIER
  );
}
