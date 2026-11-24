/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { describe, expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

describeScimTestHarness('SCIM Groups routes (mutation coverage)', (harness) => {
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env);
  const json = (method: string, path: string, body: unknown, headers?: Record<string, string>) =>
    fetchScim(path, { method, body: JSON.stringify(body), headers });

  async function expectError(res: Response, status: number, detail?: string, scimType?: string) {
    expect(res.status).toBe(status);
    const body = await res.json<Record<string, unknown>>();
    expect(body.schemas).toEqual([ERROR_SCHEMA]);
    expect(body.status).toBe(String(status));
    if (detail !== undefined) expect(body.detail).toBe(detail);
    if (scimType !== undefined) expect(body.scimType).toBe(scimType);
    return body;
  }

  /** Records every statement bound against the core fake (SQL plus bound parameters). */
  function recordStatements(): Array<{ sql: string; params: unknown[] }> {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = harness.env.DB as any;
    const original = db.prepare;
    db.prepare = (sql: string) => {
      const stmt = original.call(db, sql);
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...params: unknown[]) => {
        calls.push({ sql, params });
        return bind(...params);
      };
      return stmt;
    };
    return calls;
  }

  async function currentEtag(id: string): Promise<string> {
    const res = await fetchScim(`/scim/v2/Groups/${id}`);
    expect(res.status).toBe(200);
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();
    return etag as string;
  }

  describe('GET /Groups', () => {
    it('rejects attributes together with excludedAttributes', async () => {
      const res = await fetchScim(
        '/scim/v2/Groups?attributes=displayName&excludedAttributes=members'
      );
      await expectError(
        res,
        400,
        'attributes and excludedAttributes are mutually exclusive',
        'invalidValue'
      );
    });

    it('rejects an unsupported sort attribute listing the allowed ones', async () => {
      const res = await fetchScim('/scim/v2/Groups?sortBy=bogus');
      const body = await expectError(res, 400, undefined, 'invalidValue');
      expect(String(body.detail)).toContain('Invalid sortBy attribute: bogus. Allowed values:');
    });

    it('sorts ascending and descending using the whitelisted column', async () => {
      const queries = recordStatements();
      const asc = await fetchScim('/scim/v2/Groups?sortBy=displayName');
      expect(asc.status).toBe(200);
      const desc = await fetchScim('/scim/v2/Groups?sortBy=displayName&sortOrder=descending');
      expect(desc.status).toBe(200);
      const listSql = queries.map((q) => q.sql).filter((s) => s.includes('ORDER BY'));
      expect(listSql.some((s) => /ORDER BY name ASC LIMIT \? OFFSET \?/.test(s))).toBe(true);
      expect(listSql.some((s) => /ORDER BY name DESC LIMIT \? OFFSET \?/.test(s))).toBe(true);
    });

    it('passes the filter condition to both the count and the list query', async () => {
      const statements = recordStatements();
      const filter = (value: string) =>
        `/scim/v2/Groups?filter=${encodeURIComponent(`displayName eq "${value}"`)}`;
      const hit = await fetchScim(filter('Administrators'));
      expect(hit.status).toBe(200);
      const hitBody = (await hit.json()) as any;
      expect(hitBody.totalResults).toBe(1);
      expect(hitBody.Resources.map((r: any) => r.id)).toEqual(['group-001']);
      const roleStatements = statements.filter((s) => s.sql.includes('FROM roles'));
      const count = roleStatements.find((s) => s.sql.includes('COUNT(*)'));
      const list = roleStatements.find((s) => s.sql.includes('LIMIT ? OFFSET ?'));
      for (const stmt of [count, list]) {
        expect(stmt?.sql).toMatch(/AND name = \?\d+/);
        expect(stmt?.params.slice(0, 2)).toEqual(['default', 'Administrators']);
      }
      const bad = await fetchScim(
        `/scim/v2/Groups?filter=${encodeURIComponent('displayName ??? "x"')}`
      );
      await expectError(bad, 400, 'Invalid filter syntax', 'invalidFilter');
    });

    it('lists groups with their members', async () => {
      const res = await fetchScim('/scim/v2/Groups');
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.totalResults).toBe(1);
      expect(body.startIndex).toBe(1);
      expect(body.itemsPerPage).toBe(1);
      expect(body.Resources[0].displayName).toBe('Administrators');
    });

    it('answers 500 when the database fails', async () => {
      (harness.env.DB as any).prepare = () => {
        throw new Error('db down');
      };
      await expectError(await fetchScim('/scim/v2/Groups'), 500, 'Internal server error');
    });
  });

  describe('GET /Groups/:id', () => {
    it('rejects conflicting projection parameters', async () => {
      const res = await fetchScim(
        '/scim/v2/Groups/group-001?attributes=displayName&excludedAttributes=members'
      );
      await expectError(
        res,
        400,
        'attributes and excludedAttributes are mutually exclusive',
        'invalidValue'
      );
    });

    it('returns 404 for an unknown group', async () => {
      await expectError(
        await fetchScim('/scim/v2/Groups/nope'),
        404,
        'The requested resource was not found'
      );
    });

    it('returns the group with an ETag and honours If-None-Match', async () => {
      const res = await fetchScim('/scim/v2/Groups/group-001');
      expect(res.status).toBe(200);
      const etag = res.headers.get('ETag');
      const body = (await res.json()) as any;
      expect(etag).toBe(body.meta.version);
      expect(body.id).toBe('group-001');

      const notModified = await fetchScim('/scim/v2/Groups/group-001', {
        headers: { 'If-None-Match': etag as string },
      });
      expect(notModified.status).toBe(304);
      expect(await notModified.text()).toBe('');

      const changed = await fetchScim('/scim/v2/Groups/group-001', {
        headers: { 'If-None-Match': 'W/"other"' },
      });
      expect(changed.status).toBe(200);
    });

    it('projects attributes', async () => {
      const res = await fetchScim('/scim/v2/Groups/group-001?attributes=displayName');
      const body = (await res.json()) as any;
      expect(body.displayName).toBe('Administrators');
      expect(body.members).toBeUndefined();
    });

    it('answers 500 when the database fails', async () => {
      (harness.env.DB as any).prepare = () => {
        throw new Error('db down');
      };
      await expectError(await fetchScim('/scim/v2/Groups/group-001'), 500, 'Internal server error');
    });
  });

  describe('POST /Groups', () => {
    it('rejects an empty body, a non-object body and an invalid group', async () => {
      await expectError(
        await fetchScim('/scim/v2/Groups', { method: 'POST', body: '   ' }),
        400,
        'Request body must contain JSON',
        'invalidSyntax'
      );
      await expectError(
        await json('POST', '/scim/v2/Groups', [1]),
        400,
        'SCIM Group must be an object',
        'invalidSyntax'
      );
      const body = await expectError(
        await json('POST', '/scim/v2/Groups', { schemas: [GROUP_SCHEMA] }),
        400,
        undefined,
        'invalidValue'
      );
      expect(String(body.detail)).toContain('displayName');
    });

    it('rejects a member that does not exist in the tenant', async () => {
      const res = await json('POST', '/scim/v2/Groups', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Ghosts',
        members: [{ value: 'no-such-user' }],
      });
      await expectError(res, 400, 'Group member does not exist in this tenant', 'invalidValue');
      expect([...harness.groups.values()].some((g) => g.name === 'Ghosts')).toBe(false);
    });

    it('creates a group with members, Location and the stored fields', async () => {
      const statements = recordStatements();
      const res = await json('POST', '/scim/v2/Groups', {
        schemas: [GROUP_SCHEMA],
        displayName: 'Engineers',
        externalId: 'ext-eng',
        members: [{ value: 'user-001' }, { value: 'user-001' }, { value: 'user-002' }],
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.displayName).toBe('Engineers');
      expect(res.headers.get('Location')).toBe(body.meta.location);
      expect(body.meta.location).toContain(`/scim/v2/Groups/${body.id}`);
      const stored = harness.groups.get(body.id);
      expect(stored.name).toBe('Engineers');
      expect(stored.external_id).toBe('ext-eng');
      expect(stored.tenant_id).toBe('default');
      const insert = statements.find((s) => s.sql.includes('INSERT INTO user_roles'));
      expect(insert?.sql).toContain('(?, ?, ?, ?), (?, ?, ?, ?)');
      expect(insert?.params.filter((_, i) => i % 4 === 0)).toEqual(['user-001', 'user-002']);
      expect(insert?.params.filter((_, i) => i % 4 === 1)).toEqual([body.id, body.id]);
      expect(insert?.params.filter((_, i) => i % 4 === 2)).toEqual(['default', 'default']);
    });
  });

  describe('PUT /Groups/:id', () => {
    const valid = (over: Record<string, unknown> = {}) => ({
      schemas: [GROUP_SCHEMA],
      displayName: 'Renamed',
      ...over,
    });

    it('rejects malformed bodies', async () => {
      await expectError(
        await json('PUT', '/scim/v2/Groups/group-001', 'x'),
        400,
        'SCIM Group must be an object',
        'invalidSyntax'
      );
      await expectError(
        await fetchScim('/scim/v2/Groups/group-001', { method: 'PUT', body: '' }),
        400,
        'Request body must contain JSON',
        'invalidSyntax'
      );
      const body = await expectError(
        await json('PUT', '/scim/v2/Groups/group-001', { schemas: [GROUP_SCHEMA] }),
        400,
        undefined,
        'invalidValue'
      );
      expect(String(body.detail)).toContain('displayName');
    });

    it('returns 404 for an unknown group', async () => {
      await expectError(
        await json('PUT', '/scim/v2/Groups/nope', valid()),
        404,
        'The requested resource was not found'
      );
    });

    it('enforces If-Match with 412 and accepts the current ETag', async () => {
      const stale = await json('PUT', '/scim/v2/Groups/group-001', valid(), {
        'If-Match': 'W/"stale"',
      });
      await expectError(stale, 412, 'Precondition failed - resource was modified', 'invalidVers');
      expect(harness.groups.get('group-001').name).toBe('Administrators');

      const etag = await currentEtag('group-001');
      const ok = await json('PUT', '/scim/v2/Groups/group-001', valid(), { 'If-Match': etag });
      expect(ok.status).toBe(200);
    });

    it('rejects unknown members without touching the group', async () => {
      const res = await json(
        'PUT',
        '/scim/v2/Groups/group-001',
        valid({ members: [{ value: 'zzz' }] })
      );
      await expectError(res, 400, 'Group member does not exist in this tenant', 'invalidValue');
      expect(harness.groups.get('group-001').name).toBe('Administrators');
    });

    it('replaces name and members and returns the ETag', async () => {
      const statements = recordStatements();
      const res = await json(
        'PUT',
        '/scim/v2/Groups/group-001',
        valid({ members: [{ value: 'user-002' }] })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.displayName).toBe('Renamed');
      expect(res.headers.get('ETag')).toBe(body.meta.version);
      expect(harness.groups.get('group-001').name).toBe('Renamed');
      const update = statements.find((s) => s.sql.startsWith('UPDATE roles SET'));
      expect(update?.params).toEqual(['Renamed', null, null, 'group-001', 'default']);
      const insert = statements.find((s) => s.sql.includes('INSERT INTO user_roles'));
      expect(insert?.params.slice(0, 3)).toEqual(['user-002', 'group-001', 'default']);
    });

    it('answers 500 when the database fails', async () => {
      (harness.env.DB as any).prepare = () => {
        throw new Error('db down');
      };
      await expectError(
        await json('PUT', '/scim/v2/Groups/group-001', valid()),
        500,
        'Internal server error'
      );
    });
  });

  describe('PATCH /Groups/:id', () => {
    const patch = (ops: unknown[], headers?: Record<string, string>, id = 'group-001') =>
      json('PATCH', `/scim/v2/Groups/${id}`, { schemas: [PATCH_SCHEMA], Operations: ops }, headers);

    it('rejects an invalid patch document', async () => {
      const body = await expectError(
        await json('PATCH', '/scim/v2/Groups/group-001', { schemas: [PATCH_SCHEMA] }),
        400,
        undefined,
        'invalidSyntax'
      );
      expect(String(body.detail).length).toBeGreaterThan(0);
    });

    it('returns 404 for an unknown group', async () => {
      await expectError(
        await patch([{ op: 'replace', path: 'displayName', value: 'x' }], undefined, 'nope'),
        404,
        'The requested resource was not found'
      );
    });

    it('enforces If-Match with 412', async () => {
      const res = await patch([{ op: 'replace', path: 'displayName', value: 'x' }], {
        'If-Match': 'W/"stale"',
      });
      await expectError(res, 412, 'Precondition failed - resource was modified', 'invalidVers');
      expect(harness.groups.get('group-001').name).toBe('Administrators');
    });

    it('rejects a patch that leaves the group without displayName', async () => {
      const res = await patch([{ op: 'remove', path: 'displayName' }]);
      const body = await expectError(res, 400, undefined, 'invalidValue');
      expect(String(body.detail)).toContain('displayName');
    });

    it('rejects adding a member that does not exist', async () => {
      const res = await patch([{ op: 'add', path: 'members', value: [{ value: 'ghost' }] }]);
      await expectError(res, 400, 'Group member does not exist in this tenant', 'invalidValue');
    });

    it('renames the group and replaces members with the current ETag', async () => {
      const etag = await currentEtag('group-001');
      const statements = recordStatements();
      const res = await patch(
        [
          { op: 'replace', path: 'displayName', value: 'Ops' },
          { op: 'add', path: 'members', value: [{ value: 'user-002' }] },
        ],
        { 'If-Match': etag }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.displayName).toBe('Ops');
      expect(res.headers.get('ETag')).toBe(body.meta.version);
      expect(harness.groups.get('group-001').name).toBe('Ops');
      const update = statements.find((s) => s.sql.startsWith('UPDATE roles SET'));
      expect(update?.params[0]).toBe('Ops');
      expect(update?.params.slice(2)).toEqual(['ext-grp-001', 'group-001', 'default']);
      const insert = statements.find((s) => s.sql.includes('INSERT INTO user_roles'));
      expect(insert?.params.slice(0, 3)).toEqual(['user-002', 'group-001', 'default']);
    });

    it('answers 500 when the database fails', async () => {
      (harness.env.DB as any).prepare = () => {
        throw new Error('db down');
      };
      await expectError(
        await patch([{ op: 'replace', path: 'displayName', value: 'x' }]),
        500,
        'Internal server error'
      );
    });
  });

  describe('DELETE /Groups/:id', () => {
    it('returns 404 for an unknown group', async () => {
      await expectError(
        await fetchScim('/scim/v2/Groups/nope', { method: 'DELETE' }),
        404,
        'The requested resource was not found'
      );
    });

    it('enforces If-Match with 412 and keeps the group', async () => {
      const res = await fetchScim('/scim/v2/Groups/group-001', {
        method: 'DELETE',
        headers: { 'If-Match': 'W/"stale"' },
      });
      await expectError(res, 412, 'Precondition failed - resource was modified', 'invalidVers');
      expect(harness.groups.has('group-001')).toBe(true);
    });

    it('deletes the group and its memberships with 204', async () => {
      const etag = await currentEtag('group-001');
      const statements = recordStatements();
      const res = await fetchScim('/scim/v2/Groups/group-001', {
        method: 'DELETE',
        headers: { 'If-Match': etag },
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(harness.groups.has('group-001')).toBe(false);
      const roleDelete = statements.find((s) => s.sql.startsWith('DELETE FROM roles'));
      expect(roleDelete?.params).toEqual(['group-001', 'default']);
      const memberDelete = statements.find((s) => s.sql.startsWith('DELETE FROM user_roles'));
      expect(memberDelete?.params).toEqual(['default', 'group-001']);
    });

    it('answers 500 when the database fails', async () => {
      (harness.env.DB as any).prepare = () => {
        throw new Error('db down');
      };
      await expectError(
        await fetchScim('/scim/v2/Groups/group-001', { method: 'DELETE' }),
        500,
        'Internal server error'
      );
    });
  });
});
