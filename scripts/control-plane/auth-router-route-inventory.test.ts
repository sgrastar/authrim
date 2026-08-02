import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RouteDeclaration {
  method: string;
  path: string;
}

function routeDeclarations(source: string): RouteDeclaration[] {
  return Array.from(
    source.matchAll(/app\.(get|post|put|patch|delete|all)\('([^']+)'/gu),
    ([, method, path]) => ({ method: method.toUpperCase(), path })
  );
}

function covers(routerRoute: RouteDeclaration, authRoute: RouteDeclaration): boolean {
  if (routerRoute.method !== 'ALL' && routerRoute.method !== authRoute.method) return false;
  if (routerRoute.path === authRoute.path) return true;
  if (!routerRoute.path.endsWith('/*')) return false;
  return authRoute.path.startsWith(routerRoute.path.slice(0, -1));
}

describe('Auth public route ownership', () => {
  it('routes every Auth-owned /api/v1 endpoint through Router with the same method', () => {
    const root = resolve(import.meta.dirname, '../..');
    const authSource = readFileSync(resolve(root, 'packages/ar-auth/src/index.ts'), 'utf8');
    const routerSource = readFileSync(resolve(root, 'packages/ar-router/src/index.ts'), 'utf8');
    const authRoutes = routeDeclarations(authSource).filter(({ path }) =>
      path.startsWith('/api/v1/')
    );
    const routerRoutes = routeDeclarations(routerSource);

    const missing = authRoutes.filter(
      (authRoute) => !routerRoutes.some((routerRoute) => covers(routerRoute, authRoute))
    );

    expect(missing).toEqual([]);
  });
});
