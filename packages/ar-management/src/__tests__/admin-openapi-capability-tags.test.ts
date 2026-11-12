/**
 * The OpenAPI `x-authrim-capability` tags cannot drift from the route access table: an operation
 * carries the tag exactly when the rule that guards its route carries that capability.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { findAdminRouteAccessRule } from '../admin-route-access';

interface Spec {
  paths: Record<string, Record<string, { 'x-authrim-capability'?: string }>>;
}
const spec = parse(
  readFileSync(new URL('../../openapi/admin.openapi.yaml', import.meta.url), 'utf8')
) as Spec;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function operations() {
  const found: Array<{ method: string; path: string; sample: string; tag: string | undefined }> =
    [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      found.push({
        method: method.toUpperCase(),
        path,
        sample: path.replace(/\{[^}]+\}/g, 'x'),
        tag: operation['x-authrim-capability'],
      });
    }
  }
  return found;
}

describe('x-authrim-capability in the Admin OpenAPI', () => {
  const all = operations();

  it('tags operations at all', () => {
    expect(all.filter((operation) => operation.tag).length).toBeGreaterThan(10);
  });

  it('matches the capability of the access rule of every operation, both ways', () => {
    const mismatches = all
      .filter((operation) => operation.sample.startsWith('/api/admin/'))
      .map((operation) => ({
        operation: `${operation.method} ${operation.path}`,
        spec: operation.tag,
        table: findAdminRouteAccessRule(operation.method, operation.sample)?.capability,
      }))
      .filter((entry) => entry.spec !== entry.table);
    expect(mismatches).toEqual([]);
  });

  it('tags nothing outside the Admin API', () => {
    expect(
      all.filter((operation) => operation.tag && !operation.sample.startsWith('/api/admin/'))
    ).toEqual([]);
  });
});
