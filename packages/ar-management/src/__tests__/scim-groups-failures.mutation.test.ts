/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';
import { must } from './helpers/must';

const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

describeScimTestHarness('SCIM Groups write failures (mutation coverage)', (harness) => {
  const send = (method: string, path: string, body?: unknown) =>
    harness.app.fetch(
      harness.createRequest(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      harness.env
    );

  /** Runs `after` once a statement starting with `prefix` has executed (simulates a lost row). */
  function afterStatement(prefix: string, after: () => void): void {
    const db = harness.env.DB as any;
    const original = db.prepare;
    db.prepare = (sql: string) => {
      const stmt = original.call(db, sql);
      if (!sql.trimStart().startsWith(prefix)) return stmt;
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...params: unknown[]) => {
        const bound = bind(...params);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          const result = await run();
          after();
          return result;
        };
        return bound;
      };
      return stmt;
    };
  }

  const failDatabase = () => {
    (harness.env.DB as any).prepare = () => {
      throw new Error('db down');
    };
  };

  async function expectInternal(res: Response, status: number, detail: string) {
    expect(res.status).toBe(status);
    const body = await res.json<Record<string, unknown>>();
    expect(body.status).toBe(String(status));
    expect(body.detail).toBe(detail);
  }

  it('reports a group that vanished right after creation', async () => {
    afterStatement('INSERT INTO roles', () =>
      harness.groups.delete(must([...harness.groups.keys()].pop()))
    );
    const res = await send('POST', '/scim/v2/Groups', {
      schemas: [GROUP_SCHEMA],
      displayName: 'Vanishing',
    });
    await expectInternal(res, 500, 'Failed to create group');
  });

  it('reports a group that vanished right after replacement', async () => {
    afterStatement('UPDATE roles', () => harness.groups.delete('group-001'));
    const res = await send('PUT', '/scim/v2/Groups/group-001', {
      schemas: [GROUP_SCHEMA],
      displayName: 'Replaced',
    });
    await expectInternal(res, 500, 'Failed to fetch updated group');
  });

  it('reports a group that vanished right after a patch', async () => {
    afterStatement('UPDATE roles', () => harness.groups.delete('group-001'));
    const res = await send('PATCH', '/scim/v2/Groups/group-001', {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: 'replace', path: 'displayName', value: 'Patched' }],
    });
    await expectInternal(res, 500, 'Failed to fetch updated group');
  });

  it('answers 500 when the database fails on create', async () => {
    failDatabase();
    const res = await send('POST', '/scim/v2/Groups', {
      schemas: [GROUP_SCHEMA],
      displayName: 'Anything',
    });
    await expectInternal(res, 500, 'Internal server error');
  });

  it('answers 500 when the database fails on patch', async () => {
    failDatabase();
    const res = await send('PATCH', '/scim/v2/Groups/group-001', {
      schemas: [PATCH_SCHEMA],
      Operations: [{ op: 'replace', path: 'displayName', value: 'x' }],
    });
    await expectInternal(res, 500, 'Internal server error');
  });

  it('rejects an empty PATCH body before touching the database', async () => {
    const res = await harness.app.fetch(
      harness.createRequest('/scim/v2/Groups/group-001', { method: 'PATCH', body: ' ' }),
      harness.env
    );
    expect(res.status).toBe(400);
    const body = await res.json<Record<string, unknown>>();
    expect(body.detail).toBe('Request body must contain JSON');
    expect(body.scimType).toBe('invalidSyntax');
  });
});
