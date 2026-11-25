import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryCoreAuditWrites, siteActionMatches } from './helpers/core-audit-inventory';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inventory(source: string, path = 'packages/example/src/handler.ts') {
  const root = mkdtempSync(join(tmpdir(), 'core-audit-inventory-'));
  roots.push(root);
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), source);
  return inventoryCoreAuditWrites(root);
}

const HEADER = `import { createAuditLog, createAuditLogFromContext } from '@authrim/ar-lib-core';\n`;

describe('core audit write inventory', () => {
  it('reads the action, resource, end user and ID of each form', () => {
    const sites = inventory(
      HEADER +
        `export async function a(c, env, id) {
          await createAuditLogFromContext(c, 'screen.updated', 'screen', id, {});
          await createAuditLogFromContext(c, 'user.suspend', 'user', id, {}, 'info', 'stable-id');
          await createAuditLogFromContext(c, 'thing.created', 'thing', id, { user_id: id }, 'info', undefined);
          await createAuditLogFromContext(c, \`tenant.lifecycle.\${id}\`, 'tenant', id, {}, 'info', id);
          await createAuditLog(env, { action: 'x.done', resource: 'x', id: 'fixed', metadata: JSON.stringify({ userId: id }) });
        }`
    );
    expect(
      sites.map(({ action, resource, namesUser, fixedId }) => ({
        action,
        resource,
        namesUser,
        fixedId,
      }))
    ).toEqual([
      { action: 'screen.updated', resource: 'screen', namesUser: false, fixedId: false },
      { action: 'user.suspend', resource: 'user', namesUser: true, fixedId: true },
      { action: 'thing.created', resource: 'thing', namesUser: true, fixedId: false },
      { action: 'tenant.lifecycle.*', resource: 'tenant', namesUser: false, fixedId: null },
      { action: 'x.done', resource: 'x', namesUser: true, fixedId: true },
    ]);
    expect(siteActionMatches(sites[3], 'tenant.lifecycle.suspend')).toBe(true);
    expect(siteActionMatches(sites[3], 'tenant.updated')).toBe(false);
  });

  it('tells a caller that carries on from one that fails the request', () => {
    const sites = inventory(
      HEADER +
        `export async function a(c, id) {
          try { await createAuditLogFromContext(c, 'a.swallowed', 'r', id, {}); } catch { log(); }
          try { await createAuditLogFromContext(c, 'a.rethrown', 'r', id, {}); } catch (e) { throw e; }
          try { await createAuditLogFromContext(c, 'a.answered', 'r', id, {}); } catch { return c.json({}, 500); }
          try { await createAuditLogFromContext(c, 'a.sometimes', 'r', id, {}); } catch (e) { if (x) throw e; log(); }
          await createAuditLogFromContext(c, 'a.caught', 'r', id, {}).catch(() => undefined);
          await createAuditLogFromContext(c, 'a.recaught', 'r', id, {}).catch((e) => { throw e; });
          await createAuditLogFromContext(c, 'a.returned', 'r', id, {}).catch(() => { return undefined; });
          await createAuditLogFromContext(c, 'a.rejected', 'r', id, {}).catch((e) => Promise.reject(e));
          await createAuditLogFromContext(c, 'a.handed', 'r', id, {}).catch((e) => handle(e));
          await createAuditLogFromContext(c, 'a.plain', 'r', id, {});
        }`
    );
    expect(Object.fromEntries(sites.map((site) => [site.action, site.callerSwallows]))).toEqual({
      'a.swallowed': true,
      'a.rethrown': false,
      'a.answered': false,
      'a.sometimes': null,
      'a.caught': true,
      'a.recaught': false,
      'a.returned': true,
      'a.rejected': false,
      'a.handed': null,
      'a.plain': false,
    });
  });

  it('reads a quoted user ID key', () => {
    const sites = inventory(
      HEADER +
        `export async function a(c, id) {
          await createAuditLogFromContext(c, 'thing.created', 'thing', id, { "user_id": id });
        }`
    );
    expect(sites.map((site) => site.namesUser)).toEqual([true]);
  });

  it("lists a known wrapper's calls, with the wrapper's own catch", () => {
    const sites = inventory(
      HEADER +
        `async function recordScreenAudit(c, event, screenId, metadata) {
          try { await createAuditLogFromContext(c, event, 'screen', screenId, metadata); }
          catch { log(); }
        }
        export async function a(c, id) {
          await recordScreenAudit(c, 'screen.created', id, {});
          await recordScreenAudit(c, 'screen.deleted', id, { user_id: id });
        }`,
      'packages/ar-management/src/admin-screens.ts'
    );
    expect(
      sites.map(({ helper, action, resource, namesUser, callerSwallows }) => ({
        helper,
        action,
        resource,
        namesUser,
        callerSwallows,
      }))
    ).toEqual([
      {
        helper: 'wrapper',
        action: 'screen.created',
        resource: 'screen',
        namesUser: false,
        callerSwallows: true,
      },
      {
        helper: 'wrapper',
        action: 'screen.deleted',
        resource: 'screen',
        namesUser: true,
        callerSwallows: true,
      },
    ]);
  });

  it('finds calls through a namespace import', () => {
    const sites = inventory(
      `import * as core from '@authrim/ar-lib-core';
       export async function a(env) {
         await core.createAuditLog(env, { action: 'ns.done', resource: 'ns' });
       }`
    );
    expect(sites.map((site) => site.action)).toEqual(['ns.done']);
  });
});
