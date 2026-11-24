/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { describe, expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const BULK_REQUEST = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
const BULK_RESPONSE = 'urn:ietf:params:scim:api:messages:2.0:BulkResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

type Op = Record<string, unknown>;

describeScimTestHarness('SCIM Bulk operations (mutation coverage)', (harness) => {
  const bulkRaw = (body: string, headers?: Record<string, string>) =>
    harness.app.fetch(
      harness.createRequest('/scim/v2/Bulk', { method: 'POST', body, headers }),
      harness.env
    );
  const bulk = (operations: Op[], extra: Record<string, unknown> = {}) =>
    bulkRaw(JSON.stringify({ schemas: [BULK_REQUEST], Operations: operations, ...extra }));

  async function results(res: Response): Promise<Array<Record<string, any>>> {
    expect(res.status).toBe(200);
    const body = await res.json<{
      schemas: string[];
      Operations: Array<Record<string, any>>;
    }>();
    expect(body.schemas).toEqual([BULK_RESPONSE]);
    return body.Operations;
  }

  const groupPost = (bulkId: string, data: Op = {}): Op => ({
    method: 'POST',
    path: '/Groups',
    bulkId,
    data: { schemas: [GROUP_SCHEMA], displayName: `G-${bulkId}`, ...data },
  });

  async function currentVersion(path: string): Promise<string> {
    const res = await harness.app.fetch(harness.createRequest(path), harness.env);
    const body = await res.json<{ meta: { version: string } }>();
    return body.meta.version.replace(/^W\/"|"$/g, '');
  }

  describe('request level validation', () => {
    it('rejects an oversized Content-Length with 413', async () => {
      harness.settings.bulkMaxPayloadSize = 100;
      const res = await bulkRaw('{}', { 'Content-Length': '101' });
      expect(res.status).toBe(413);
      const body = await res.json<Record<string, unknown>>();
      expect(body.detail).toBe('Request payload exceeds maximum size of 100 bytes');
      expect(body.scimType).toBe('tooMany');
      expect(body.status).toBe('413');
    });

    it('rejects an oversized actual body even without a trustworthy header', async () => {
      harness.settings.bulkMaxPayloadSize = 100;
      const res = await bulkRaw(JSON.stringify({ pad: 'x'.repeat(200) }));
      expect(res.status).toBe(413);
      const body = await res.json<Record<string, unknown>>();
      expect(body.detail).toBe('Request payload exceeds maximum size of 100 bytes');
      expect(body.scimType).toBe('tooMany');
    });

    it('rejects a body that is not JSON', async () => {
      const res = await bulkRaw('{not json');
      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.detail).toBe('Invalid JSON request body');
      expect(body.scimType).toBe('invalidSyntax');
    });

    it('requires the BulkRequest schema and an Operations array', async () => {
      const noSchema = await bulkRaw(JSON.stringify({ Operations: [] }));
      expect(noSchema.status).toBe(400);
      const noSchemaBody = await noSchema.json<Record<string, unknown>>();
      expect(noSchemaBody.detail).toBe(`Request must include schema: ${BULK_REQUEST}`);
      expect(noSchemaBody.scimType).toBe('invalidSyntax');

      const notArray = await bulkRaw(
        JSON.stringify({ schemas: [BULK_REQUEST], Operations: 'nope' })
      );
      expect(notArray.status).toBe(400);
      const notArrayBody = await notArray.json<Record<string, unknown>>();
      expect(notArrayBody.detail).toBe('Operations must be an array');
      expect(notArrayBody.scimType).toBe('invalidSyntax');
    });

    it('rejects more operations than the configured maximum', async () => {
      harness.settings.bulkMaxOperations = 1;
      const res = await bulk([groupPost('a'), groupPost('b')]);
      expect(res.status).toBe(413);
      const body = await res.json<Record<string, unknown>>();
      expect(body.detail).toBe('Number of operations (2) exceeds maximum of 1');
      expect(body.scimType).toBe('tooMany');
    });
  });

  describe('operation level validation', () => {
    const errorOf = (r: Record<string, any>) => r.response as Record<string, any>;

    it('refuses invalid paths and disabled resource types', async () => {
      const [badPath] = await results(
        await bulk([{ method: 'POST', path: '/Widgets', bulkId: 'w' }])
      );
      expect(badPath.status).toBe('400');
      expect(badPath.bulkId).toBe('w');
      expect(errorOf(badPath).schemas).toEqual([ERROR_SCHEMA]);
      expect(errorOf(badPath).detail).toBe(
        'Invalid path: /Widgets. Must be /Users, /Users/{id}, /Groups, or /Groups/{id}'
      );

      harness.settings.groupsEnabled = false;
      const [groups] = await results(await bulk([groupPost('g')]));
      expect(groups.status).toBe('403');
      expect(errorOf(groups).detail).toBe('SCIM Groups provisioning is disabled');
      expect(errorOf(groups).status).toBe('403');

      harness.settings.usersEnabled = false;
      const [users] = await results(
        await bulk([{ method: 'POST', path: '/Users', bulkId: 'u', data: {} }])
      );
      expect(users.status).toBe('403');
      expect(errorOf(users).detail).toBe('SCIM Users provisioning is disabled');
    });

    it('validates path ids, bulkId and body presence per method', async () => {
      const out = await results(
        await bulk([
          { method: 'POST', path: '/Groups/abc', bulkId: 'p1', data: {} },
          { method: 'POST', path: '/Groups', data: {} },
          { method: 'POST', path: '/Groups', bulkId: '', data: {} },
          { method: 'POST', path: '/Groups', bulkId: 'x'.repeat(129), data: {} },
          { method: 'POST', path: '/Groups', bulkId: 'bad\u0001id', data: {} },
          { method: 'PUT', path: '/Groups', data: {} },
          { method: 'PATCH', path: '/Groups' },
          { method: 'DELETE', path: '/Groups' },
          { method: 'POST', path: '/Groups', bulkId: 'nobody' },
          { method: 'PUT', path: '/Groups/group-001' },
          { method: 'PATCH', path: '/Groups/group-001' },
        ])
      );
      expect(out.map((r) => r.status)).toEqual(Array(11).fill('400'));
      expect(errorOf(out[0]).detail).toBe('POST operations must not include resource ID in path');
      for (const i of [1, 2, 3, 4]) {
        expect(errorOf(out[i]).detail).toBe('POST operations require a valid bulkId');
        expect(errorOf(out[i]).scimType).toBe('invalidValue');
      }
      expect(errorOf(out[5]).detail).toBe('PUT operations require resource ID in path');
      expect(errorOf(out[6]).detail).toBe('PATCH operations require resource ID in path');
      expect(errorOf(out[7]).detail).toBe('DELETE operations require resource ID in path');
      expect(errorOf(out[8]).detail).toBe('POST operations require request body');
      expect(errorOf(out[9]).detail).toBe('PUT operations require request body');
      expect(errorOf(out[10]).detail).toBe('PATCH operations require request body');
      expect(out[0].bulkId).toBe('p1');
      expect(out[0].method).toBe('POST');
    });

    it('reports an unsupported method', async () => {
      const [r] = await results(await bulk([{ method: 'GET', path: '/Groups/group-001' }]));
      expect(r.status).toBe('400');
      expect(errorOf(r).detail).toBe('Unsupported method: GET');
      const [u] = await results(await bulk([{ method: 'GET', path: '/Users/user-001' }]));
      expect(u.status).toBe('400');
      expect(errorOf(u).detail).toBe('Unsupported method: GET');
    });

    it('stops after failOnErrors errors', async () => {
      const out = await results(
        await bulk(
          [
            { method: 'POST', path: '/Widgets', bulkId: 'e1' },
            { method: 'POST', path: '/Widgets', bulkId: 'e2' },
            groupPost('ok'),
          ],
          { failOnErrors: 2 }
        )
      );
      expect(out.map((r) => r.bulkId)).toEqual(['e1', 'e2']);
      expect([...harness.groups.values()].some((g) => g.name === 'G-ok')).toBe(false);
    });
  });

  describe('group operations', () => {
    it('creates a group, reports version and location, and resolves later bulkId members', async () => {
      const out = await results(
        await bulk(
          [
            groupPost('g1', { externalId: 'ext-g1', members: [{ value: 'user-001' }] }),
            {
              method: 'PUT',
              path: '/Groups/bulkId:g1',
              data: { schemas: [GROUP_SCHEMA], displayName: 'G-renamed' },
            },
          ],
          { failOnErrors: 1 }
        )
      );
      expect(out[0].status).toBe('201');
      expect(out[0].bulkId).toBe('g1');
      expect(out[0].location).toMatch(/^http:\/\/localhost\/scim\/v2\/Groups\/.+/);
      expect(out[0].version).toBe(out[0].response.meta.version);
      expect(out[0].response.displayName).toBe('G-g1');
      const id = out[0].location.split('/').pop();
      expect(harness.groups.get(id).external_id).toBe('ext-g1');
      // The path is not rewritten, only data is: the PUT therefore targets the literal id.
      expect(out[1].status).toBe('404');
    });

    it('rejects an invalid group, a duplicate name and an unknown member', async () => {
      const out = await results(
        await bulk([
          { method: 'POST', path: '/Groups', bulkId: 'v', data: { schemas: [GROUP_SCHEMA] } },
          groupPost('dup', { displayName: 'Administrators' }),
          groupPost('ghost', { members: [{ value: 'nobody' }] }),
        ])
      );
      expect(out[0].status).toBe('400');
      expect(out[0].response.scimType).toBe('invalidValue');
      expect(out[0].response.detail).toContain('displayName');
      expect(out[1].status).toBe('409');
      expect(out[1].bulkId).toBe('dup');
      expect(out[1].response.detail).toBe('Group with this name already exists');
      expect(out[1].response.scimType).toBe('uniqueness');
      expect(out[2].status).toBe('400');
      expect(out[2].bulkId).toBe('ghost');
      expect(out[2].method).toBe('POST');
      expect(out[2].response).toEqual({
        schemas: [ERROR_SCHEMA],
        status: '400',
        detail: 'Group member does not exist in this tenant',
        scimType: 'invalidValue',
      });
    });

    it('replaces, patches and deletes an existing group', async () => {
      const version = await currentVersion('/scim/v2/Groups/group-001');
      const put = await results(
        await bulk([
          {
            method: 'PUT',
            path: '/Groups/group-001',
            version,
            data: { schemas: [GROUP_SCHEMA], displayName: 'Replaced', externalId: 'ext-new' },
          },
        ])
      );
      expect(put[0].status).toBe('200');
      expect(put[0].method).toBe('PUT');
      expect(put[0].location).toBe('http://localhost/scim/v2/Groups/group-001');
      expect(put[0].response.displayName).toBe('Replaced');
      expect(put[0].version).toBe(put[0].response.meta.version);
      expect(harness.groups.get('group-001').name).toBe('Replaced');

      const patch = await results(
        await bulk([
          {
            method: 'PATCH',
            path: '/Groups/group-001',
            data: {
              schemas: [PATCH_SCHEMA],
              Operations: [{ op: 'replace', path: 'displayName', value: 'Patched' }],
            },
          },
        ])
      );
      expect(patch[0].status).toBe('200');
      expect(patch[0].method).toBe('PATCH');
      expect(patch[0].response.displayName).toBe('Patched');
      expect(harness.groups.get('group-001').name).toBe('Patched');

      const del = await results(await bulk([{ method: 'DELETE', path: '/Groups/group-001' }]));
      expect(del[0]).toEqual({ method: 'DELETE', status: '204' });
    });

    it('answers 404 for unknown groups on PUT, PATCH and DELETE', async () => {
      const out = await results(
        await bulk([
          {
            method: 'PUT',
            path: '/Groups/none',
            data: { schemas: [GROUP_SCHEMA], displayName: 'x' },
          },
          {
            method: 'PATCH',
            path: '/Groups/none',
            data: { schemas: [PATCH_SCHEMA], Operations: [] },
          },
          { method: 'DELETE', path: '/Groups/none' },
        ])
      );
      expect(out.map((r) => [r.method, r.status])).toEqual([
        ['PUT', '404'],
        ['PATCH', '404'],
        ['DELETE', '404'],
      ]);
      for (const r of out) {
        expect(r.response).toEqual({
          schemas: [ERROR_SCHEMA],
          status: '404',
          detail: 'Resource not found',
        });
      }
    });

    it('answers 412 when the version no longer matches and leaves the group alone', async () => {
      const out = await results(
        await bulk([
          {
            method: 'PUT',
            path: '/Groups/group-001',
            version: 'stale',
            data: { schemas: [GROUP_SCHEMA], displayName: 'x' },
          },
          {
            method: 'PATCH',
            path: '/Groups/group-001',
            version: 'stale',
            data: { schemas: [PATCH_SCHEMA], Operations: [] },
          },
          { method: 'DELETE', path: '/Groups/group-001', version: 'stale' },
        ])
      );
      expect(out.map((r) => [r.method, r.status])).toEqual([
        ['PUT', '412'],
        ['PATCH', '412'],
        ['DELETE', '412'],
      ]);
      for (const r of out) {
        expect(r.response).toEqual({
          schemas: [ERROR_SCHEMA],
          status: '412',
          detail: 'Precondition failed - resource was modified',
          scimType: 'invalidVers',
        });
      }
      expect(harness.groups.get('group-001').name).toBe('Administrators');
    });

    it('validates PUT and PATCH payloads and unknown members', async () => {
      const out = await results(
        await bulk([
          { method: 'PUT', path: '/Groups/group-001', data: { schemas: [GROUP_SCHEMA] } },
          {
            method: 'PUT',
            path: '/Groups/group-001',
            data: { schemas: [GROUP_SCHEMA], displayName: 'x', members: [{ value: 'nobody' }] },
          },
          { method: 'PATCH', path: '/Groups/group-001', data: { schemas: [PATCH_SCHEMA] } },
          {
            method: 'PATCH',
            path: '/Groups/group-001',
            data: {
              schemas: [PATCH_SCHEMA],
              Operations: [{ op: 'remove', path: 'displayName' }],
            },
          },
          {
            method: 'PATCH',
            path: '/Groups/group-001',
            data: {
              schemas: [PATCH_SCHEMA],
              Operations: [{ op: 'add', path: 'members', value: [{ value: 'nobody' }] }],
            },
          },
        ])
      );
      expect(out.map((r) => r.status)).toEqual(['400', '400', '400', '400', '400']);
      expect(out[0].response.scimType).toBe('invalidValue');
      expect(out[0].response.detail).toContain('displayName');
      expect(out[1].response.detail).toBe('Group member does not exist in this tenant');
      expect(out[1].method).toBe('PUT');
      expect(out[2].response.scimType).toBe('invalidSyntax');
      expect(out[3].response.scimType).toBe('invalidValue');
      expect(out[3].response.detail).toContain('displayName');
      expect(out[4].method).toBe('PATCH');
      expect(out[4].response.detail).toBe('Group member does not exist in this tenant');
      expect(harness.groups.get('group-001').name).toBe('Administrators');
    });
  });

  describe('bulkId references', () => {
    it('replaces resolvable bulkId strings with the created id and keeps unresolved ones', async () => {
      const out = await results(
        await bulk(
          [
            groupPost('first'),
            {
              method: 'POST',
              path: '/Groups',
              bulkId: 'second',
              data: {
                schemas: [GROUP_SCHEMA],
                displayName: 'Second',
                externalId: 'bulkId:first',
                members: [{ value: 'user-001' }],
              },
            },
            {
              method: 'POST',
              path: '/Groups',
              bulkId: 'third',
              data: {
                schemas: [GROUP_SCHEMA],
                displayName: 'Third',
                externalId: 'bulkId:never-created',
              },
            },
          ],
          { failOnErrors: 1 }
        )
      );
      expect(out.map((r) => r.status)).toEqual(['201', '201', '201']);
      const firstId = out[0].location.split('/').pop();
      const secondId = out[1].location.split('/').pop();
      const thirdId = out[2].location.split('/').pop();
      expect(harness.groups.get(secondId).external_id).toBe(firstId);
      expect(harness.groups.get(thirdId).external_id).toBe('bulkId:never-created');
    });

    it('treats an unresolved bulkId member as a missing user and resolves array elements', async () => {
      const out = await results(
        await bulk(
          [
            groupPost('first'),
            {
              method: 'POST',
              path: '/Groups',
              bulkId: 'second',
              data: {
                schemas: [GROUP_SCHEMA],
                displayName: 'Second',
                members: [{ value: 'bulkId:unknown' }],
              },
            },
            {
              method: 'POST',
              path: '/Groups',
              bulkId: 'fourth',
              data: {
                schemas: [GROUP_SCHEMA],
                displayName: 'Fourth',
                members: [{ value: 'bulkId:first' }],
              },
            },
          ],
          { failOnErrors: 5 }
        )
      );
      expect(out[1].status).toBe('400');
      expect(out[1].response.detail).toBe('Group member does not exist in this tenant');
      // bulkId:first resolves to the created group id, which is not a user in this tenant.
      expect(out[2].status).toBe('400');
      expect(out[2].response.detail).toBe('Group member does not exist in this tenant');
    });
  });

  describe('user operations', () => {
    const userData = (over: Op = {}) => ({
      schemas: [USER_SCHEMA],
      userName: 'bulk-user',
      emails: [{ value: 'bulk.user@example.com', primary: true }],
      ...over,
    });

    it('answers 404 for unknown users on PUT, PATCH and DELETE', async () => {
      const out = await results(
        await bulk([
          { method: 'PUT', path: '/Users/none', data: userData() },
          {
            method: 'PATCH',
            path: '/Users/none',
            data: { schemas: [PATCH_SCHEMA], Operations: [] },
          },
          { method: 'DELETE', path: '/Users/none' },
        ])
      );
      expect(out.map((r) => [r.method, r.status])).toEqual([
        ['PUT', '404'],
        ['PATCH', '404'],
        ['DELETE', '404'],
      ]);
      for (const r of out) expect(r.response.detail).toBe('Resource not found');
    });

    it('answers 412 for a stale version on PUT, PATCH and DELETE', async () => {
      const out = await results(
        await bulk([
          { method: 'PUT', path: '/Users/user-001', version: 'stale', data: userData() },
          {
            method: 'PATCH',
            path: '/Users/user-001',
            version: 'stale',
            data: { schemas: [PATCH_SCHEMA], Operations: [] },
          },
          { method: 'DELETE', path: '/Users/user-001', version: 'stale' },
        ])
      );
      expect(out.map((r) => [r.method, r.status])).toEqual([
        ['PUT', '412'],
        ['PATCH', '412'],
        ['DELETE', '412'],
      ]);
      for (const r of out) {
        expect(r.response.detail).toBe('Precondition failed - resource was modified');
        expect(r.response.scimType).toBe('invalidVers');
      }
      expect(harness.users.get('user-001').active).toBe(1);
    });
  });
});
