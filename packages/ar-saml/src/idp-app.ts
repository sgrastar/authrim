/**
 * SAML IdP-only HTTP entrypoint for runtimes that do not expose the full Worker.
 *
 * This registers the existing protocol handlers. The caller supplies a trusted tenant resolver
 * before the SAML enabled gate; resolving a tenant from an untrusted request header is unsafe.
 * The Cloudflare Worker continues to use its existing app in index.ts.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { AR_ERROR_CODES, createErrorResponse, getLogger } from '@authrim/ar-lib-core';
import { isSamlProtocolPath, samlEnabledMiddleware } from './common/saml-enabled';
import { handleIdPMetadataWithOptions } from './idp/metadata';
import { handleIdPAttributeReleaseConsent, handleIdPSSO } from './idp/sso';
import { handleIdPSLO } from './idp/slo';
import {
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_POST_PATH,
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_REDIRECT_PATH,
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_POST_PATH,
  GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_REDIRECT_PATH,
} from './idp/shibboleth-compat';

export interface SAMLIdPAppOptions {
  /** Resolve tenant from a trusted host-to-tenant mapping and set Hono's `tenantId` context. */
  tenantMiddleware: MiddlewareHandler<{ Bindings: Env }>;
  /** Expose SLO only when the runtime implements its session and fanout state. */
  sloEnabled?: boolean;
}

export function createSAMLIdPApp(options: SAMLIdPAppOptions): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // The gate must see every route spelling Hono could accept, including encoded paths. Only
  // protocol requests require tenant resolution; health stays independent of tenant storage.
  app.use('*', (c, next) => {
    const paths = [c.req.path];
    try {
      paths.push(new URL(c.req.url).pathname);
    } catch {
      // Hono's path is sufficient when the request URL is malformed.
    }
    return paths.some(isSamlProtocolPath)
      ? options.tenantMiddleware(
          c as Context<{ Bindings: Env }, string, Record<string, never>>,
          next
        )
      : next();
  });
  app.use('*', samlEnabledMiddleware());

  app.get('/saml/health', (c) =>
    c.json({ status: 'ok', service: 'ar-saml-idp', timestamp: new Date().toISOString() })
  );

  app.get('/saml/idp/metadata', (c) =>
    handleIdPMetadataWithOptions(c, { includeSLO: options.sloEnabled === true })
  );
  app.get('/saml/idp/sso', handleIdPSSO);
  app.post('/saml/idp/sso', handleIdPSSO);
  app.get(GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_REDIRECT_PATH, handleIdPSSO);
  app.post(GAKUNIN_SHIBBOLETH_SAML2_IDP_SSO_POST_PATH, handleIdPSSO);
  app.post('/saml/idp/attribute-release-consent', handleIdPAttributeReleaseConsent);
  if (options.sloEnabled === true) {
    app.get('/saml/idp/slo', handleIdPSLO);
    app.post('/saml/idp/slo', handleIdPSLO);
    app.get(GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_REDIRECT_PATH, handleIdPSLO);
    app.post(GAKUNIN_SHIBBOLETH_SAML2_IDP_SLO_POST_PATH, handleIdPSLO);
  }

  app.notFound((c) => createErrorResponse(c, AR_ERROR_CODES.ADMIN_RESOURCE_NOT_FOUND));
  app.onError((error, c) => {
    getLogger(c).module('SAML').error('SAML IdP runtime error', {}, error);
    return createErrorResponse(c, AR_ERROR_CODES.INTERNAL_ERROR);
  });

  return app;
}
