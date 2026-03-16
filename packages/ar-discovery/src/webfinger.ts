import type { Context } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { buildIssuerUrl, getTenantIdFromContext } from '@authrim/ar-lib-core';

interface WebFingerResponse {
  subject: string;
  links: Array<{
    rel: string;
    href: string;
  }>;
}

/**
 * OpenID Connect Discovery WebFinger endpoint.
 *
 * A permissive implementation is sufficient here because Authrim routes are already
 * tenant-scoped by host and the response only advertises the current issuer.
 */
export async function webfingerHandler(c: Context<{ Bindings: Env }>) {
  const tenantId = getTenantIdFromContext(c);
  const issuer = buildIssuerUrl(c.env, tenantId);
  const resource = c.req.query('resource') || issuer;

  const response: WebFingerResponse = {
    subject: resource,
    links: [
      {
        rel: 'http://openid.net/specs/connect/1.0/issuer',
        href: issuer,
      },
    ],
  };

  c.header('Cache-Control', 'public, max-age=300');
  c.header('Vary', 'Accept-Encoding, Host');
  return c.json(response);
}
