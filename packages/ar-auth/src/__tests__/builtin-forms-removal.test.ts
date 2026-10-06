import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import authApp from '../index';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const removedPaths = ['/flow/login', '/flow/confirm'];

describe('built-in conformance forms removal contract', () => {
  it('does not register the credential-free login and re-authentication forms', () => {
    const registeredRoutes = authApp.routes.map(({ method, path }) => `${method} ${path}`);

    for (const path of removedPaths) {
      expect(registeredRoutes).not.toContain(`GET ${path}`);
      expect(registeredRoutes).not.toContain(`POST ${path}`);
    }
    // The JSON consent API used by the Login UI stays.
    expect(registeredRoutes).toContain('GET /auth/consent');
    expect(registeredRoutes).toContain('POST /auth/consent');
  });

  it('does not publish the removed forms', () => {
    const openapi = readFileSync(
      `${repositoryRoot}/packages/ar-auth/openapi/auth.openapi.yaml`,
      'utf8'
    );

    for (const path of removedPaths) expect(openapi).not.toContain(`${path}:`);
  });
});
