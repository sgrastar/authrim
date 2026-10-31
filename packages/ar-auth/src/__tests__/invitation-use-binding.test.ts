import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import authApp from '../index';

// An invitation is applied only inside the sign-up that creates the account (the user the
// sign-up challenge is bound to). A public endpoint that took `{ token, user_id }` let anyone
// holding a link that names no email give its role and organisation to any user of the tenant.
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const publicUsePath = ['/api/v1/invitations', 'use'].join('/');
const readRepositoryFile = (path: string) => readFileSync(`${repositoryRoot}/${path}`, 'utf8');

describe('invitation use is bound to the account being signed up', () => {
  it('does not register a public endpoint that applies an invitation to a named user', () => {
    const registeredRoutes = authApp.routes.map(({ method, path }) => `${method} ${path}`);

    expect(registeredRoutes).not.toContain(`POST ${publicUsePath}`);
    expect(registeredRoutes).toContain('GET /api/v1/invitations/validate');
  });

  it('does not forward, publish or call the removed endpoint', () => {
    for (const path of [
      'packages/ar-router/src/index.ts',
      'packages/ar-auth/openapi/auth.openapi.yaml',
      'packages/ar-auth/src/invitation-handlers.ts',
      'packages/ar-login-ui/src/routes/signup/+page.svelte',
    ]) {
      expect(readRepositoryFile(path), path).not.toContain(publicUsePath);
    }
  });
});
