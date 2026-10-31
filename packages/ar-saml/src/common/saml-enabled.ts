/**
 * The tenant's SAML switch (`federation.saml_enabled`) for the SAML protocol endpoints.
 *
 * When a tenant turns SAML off, every protocol endpoint of this worker answers 403: the IdP and
 * SP endpoints under /saml/idp and /saml/sp, the metadata under /saml/metadata, and the
 * Shibboleth-style aliases under /idp/profile/SAML2. The health check (/saml/health) and the
 * admin API (/api/admin/*) are not protocol endpoints and stay available, so an administrator can
 * still see and manage providers while SAML is off (they are kept, not deleted).
 *
 * Which requests the switch covers is decided on the path itself, not on the routes registered, so
 * a route added later under /saml/ is covered without anyone remembering to list it. The path is
 * compared the way an attacker could vary it (case, trailing and doubled slashes, dot segments,
 * percent-encoding), because the router is more lenient than a plain string comparison.
 *
 * When the tenant's settings cannot be read the endpoints answer 503, not 200. A switch that an
 * outage of the settings store turned back on would let a tenant that disabled SAML be reached
 * (the same direction as the rate limiter, which also refuses when it cannot decide). The
 * refusal is temporary: the answer is retryable and the endpoints come back as soon as the
 * settings can be read.
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import {
  AR_ERROR_CODES,
  createErrorResponse,
  getLogger,
  resolveSamlEnabled,
} from '@authrim/ar-lib-core';
import { resolveSAMLTenantIdFromContext } from './tenant';

/** The prefixes (lower case) under which this worker serves the SAML protocol. */
const SAML_PROTOCOL_PREFIXES = ['/saml/', '/idp/profile/saml2/'];

/** The one path under /saml/ that is not a protocol endpoint. */
const SAML_HEALTH_PATH = '/saml/health';

const MAX_DECODE_ROUNDS = 3;

function normalizePath(path: string): string {
  let current = path;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      break;
    }
    if (decoded === current) break;
    current = decoded;
  }

  const segments: string[] = [];
  for (const segment of current.toLowerCase().replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** Whether the path is one of the SAML protocol endpoints the tenant's switch covers. */
export function isSamlProtocolPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (normalized === SAML_HEALTH_PATH) return false;
  if (normalized === '/saml') return true;
  return SAML_PROTOCOL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function pathsOf(url: string, honoPath: string): string[] {
  const paths = [honoPath];
  try {
    paths.push(new URL(url).pathname);
  } catch {
    // The path Hono routed on is enough.
  }
  return paths;
}

export function samlEnabledMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const paths = pathsOf(c.req.url, c.req.path);
    // Protocol if any reading of the path says so; health only if every reading agrees.
    if (!paths.some((path) => isSamlProtocolPath(path))) {
      await next();
      return;
    }

    // An unresolvable tenant is an error as it always was (the handlers need one too).
    const tenantId = resolveSAMLTenantIdFromContext(c);

    let enabled: boolean;
    try {
      enabled = await resolveSamlEnabled(c.env, tenantId);
    } catch (error) {
      getLogger(c)
        .module('SAML')
        .warn('SAML switch could not be read; refusing the request', { tenantId }, error as Error);
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      c.header('Retry-After', '5');
      return c.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'The service is temporarily unavailable. Please try again later.',
        },
        503
      );
    }

    if (!enabled) {
      c.header('Cache-Control', 'no-store');
      return createErrorResponse(c, AR_ERROR_CODES.POLICY_FEATURE_DISABLED);
    }

    await next();
  };
}
