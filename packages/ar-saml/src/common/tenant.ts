import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { isValidTenantIdentifier } from '@authrim/ar-lib-core';

export class SAMLTenantResolutionError extends Error {
  constructor(message = 'SAML tenant context is required') {
    super(message);
    this.name = 'SAMLTenantResolutionError';
  }
}

export function requireSAMLTenantId(
  tenantId: string | null | undefined,
  source = 'SAML tenant context'
): string {
  const normalized = tenantId?.trim();
  if (normalized && isValidTenantIdentifier(normalized)) {
    return normalized;
  }

  throw new SAMLTenantResolutionError(`${source} is required`);
}

export function resolveSAMLTenantIdFromContext(c: Context<{ Bindings: Env }>): string {
  const contextTenantId = getHonoContextTenantId(c);
  const requestedTenantId = getRequestHeaderTenantId(c);
  if (contextTenantId) {
    if (requestedTenantId && requestedTenantId !== contextTenantId) {
      throw new SAMLTenantResolutionError(
        'SAML tenant header conflicts with resolved tenant context'
      );
    }
    return contextTenantId;
  }

  if (isMultiTenantSAMLRuntime(c.env)) {
    throw new SAMLTenantResolutionError(
      'SAML tenant context is missing; multi-tenant runtime requires request context resolution'
    );
  }

  const deploymentDefaultTenantId = c.env.DEFAULT_TENANT_ID?.trim();
  if (deploymentDefaultTenantId && isValidTenantIdentifier(deploymentDefaultTenantId)) {
    return deploymentDefaultTenantId;
  }

  throw new SAMLTenantResolutionError(
    'SAML tenant context is missing; configure request context or DEFAULT_TENANT_ID'
  );
}

function getRequestHeaderTenantId(c: Context<{ Bindings: Env }>): string | null {
  const requestedTenantId = c.req.header('X-Tenant-Id')?.trim();
  if (!requestedTenantId) {
    return null;
  }
  return requireSAMLTenantId(requestedTenantId, 'SAML tenant header');
}

function getHonoContextTenantId(c: Context<{ Bindings: Env }>): string | null {
  try {
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId');
    return typeof tenantId === 'string' ? requireSAMLTenantId(tenantId) : null;
  } catch (error) {
    if (error instanceof SAMLTenantResolutionError) {
      throw error;
    }
    return null;
  }
}

function isMultiTenantSAMLRuntime(env: Env): boolean {
  return Boolean(env.BASE_DOMAIN?.trim());
}
