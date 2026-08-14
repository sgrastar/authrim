import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { authorizeHandler } from '../../packages/ar-auth/src/authorize';
import { parHandler } from '../../packages/ar-auth/src/par';
import { discoveryHandler } from '../../packages/ar-discovery/src/discovery';
import { registerHandler } from '../../packages/ar-management/src/register';

/**
 * Narrow in-process protocol composition used by canonical integration tests.
 *
 * The production router delegates these paths to separate Workers. Keeping the composition here
 * makes cross-handler flows executable without inventing a root application that does not exist in
 * production. Runtime/service-binding behavior is covered by a separate Workers-runtime suite.
 */
export function createProtocolIntegrationApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/authorize', authorizeHandler);
  app.post('/authorize', authorizeHandler);
  app.post('/par', parHandler);
  app.post('/register', registerHandler);
  app.get('/.well-known/openid-configuration', discoveryHandler);
  app.get('/.well-known/oauth-authorization-server', discoveryHandler);
  return app;
}

export default createProtocolIntegrationApp();
