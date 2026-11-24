/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { describe, expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const MISSING_EMAIL = 'SCIM Mapping Set must produce authrim.profile.email';

describeScimTestHarness(
  'SCIM Users mapping, patch paths and listing (mutation coverage)',
  (harness) => {
    const send = (method: string, path: string, body?: unknown) =>
      harness.app.fetch(
        harness.createRequest(path, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        harness.env
      );
    const patchBody = (ops: unknown[]) => ({ schemas: [PATCH_SCHEMA], Operations: ops });

    async function expectBadRequest(res: Response, detail: string) {
      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.status).toBe('400');
      expect(body.scimType).toBe('invalidValue');
      expect(body.detail).toBe(detail);
    }

    describe('a mapping that cannot produce the required email', () => {
      it('is refused with 400 on POST, PUT and PATCH', async () => {
        await expectBadRequest(
          await send('POST', '/scim/v2/Users', { schemas: [USER_SCHEMA], userName: 'no-email' }),
          MISSING_EMAIL
        );
        await expectBadRequest(
          await send('PUT', '/scim/v2/Users/user-001', {
            schemas: [USER_SCHEMA],
            userName: 'johndoe',
          }),
          MISSING_EMAIL
        );
        await expectBadRequest(
          await send(
            'PATCH',
            '/scim/v2/Users/user-001',
            patchBody([{ op: 'remove', path: 'emails' }])
          ),
          MISSING_EMAIL
        );
        expect(harness.accountCreation.calls).toHaveLength(0);
        expect(harness.identifierReplacement.calls).toHaveLength(0);
      });

      it('is refused per operation in a bulk request', async () => {
        const res = await send('POST', '/scim/v2/Bulk', {
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              bulkId: 'm1',
              data: { schemas: [USER_SCHEMA], userName: 'no-email' },
            },
          ],
        });
        const [r] = (await res.json<{ Operations: Array<Record<string, any>> }>()).Operations;
        expect(r.status).toBe('400');
        expect(r.bulkId).toBe('m1');
        expect(r.response.detail).toBe(MISSING_EMAIL);
        expect(r.response.scimType).toBe('invalidValue');
      });
    });

    describe('an invalid lookup email', () => {
      it('is reported as 400 on PUT and PATCH without leaking the cause', async () => {
        harness.identifierReplacement.error = new Error('lookup_email_invalid');
        await expectBadRequest(
          await send('PUT', '/scim/v2/Users/user-001', {
            schemas: [USER_SCHEMA],
            userName: 'johndoe',
            emails: [{ value: 'x@example.com', primary: true }],
          }),
          'A mapped email address is invalid'
        );
        await expectBadRequest(
          await send(
            'PATCH',
            '/scim/v2/Users/user-001',
            patchBody([{ op: 'replace', path: 'userName', value: 'renamed' }])
          ),
          'A mapped email address is invalid'
        );
      });
    });

    describe('PATCH remove with a nested path', () => {
      it('is applied to the nested attribute and keeps its siblings', async () => {
        const res = await send(
          'PATCH',
          '/scim/v2/Users/user-001',
          patchBody([{ op: 'remove', path: 'name.givenName' }])
        );
        expect(res.status).toBe(200);
        const body = await res.json<Record<string, any>>();
        expect(body.name?.familyName).toBe('Doe');
        expect(body.userName).toBe('johndoe');
      });

      it('ignores a removal below a parent that does not exist', async () => {
        const res = await send(
          'PATCH',
          '/scim/v2/Users/user-001',
          patchBody([{ op: 'remove', path: 'nickName.deeper' }])
        );
        expect(res.status).toBe(200);
        const body = await res.json<Record<string, any>>();
        expect(body.userName).toBe('johndoe');
      });
    });

    describe('GET /Users without filter or sort', () => {
      it('lists newest first with the total and pages by startIndex/count', async () => {
        const all = await (await send('GET', '/scim/v2/Users')).json<Record<string, any>>();
        expect(all.totalResults).toBe(2);
        expect(all.startIndex).toBe(1);
        expect(all.itemsPerPage).toBe(2);
        expect(all.Resources.map((u: any) => u.id)).toEqual(['user-002', 'user-001']);

        const second = await (
          await send('GET', '/scim/v2/Users?startIndex=2&count=1')
        ).json<Record<string, any>>();
        expect(second.totalResults).toBe(2);
        expect(second.startIndex).toBe(2);
        expect(second.itemsPerPage).toBe(1);
        expect(second.Resources.map((u: any) => u.id)).toEqual(['user-001']);
      });
    });

    describe('Group members', () => {
      /** Makes the fake answer the member lookup the way the real user_roles table would. */
      function seedMembers(members: Array<{ user_id: string }>): void {
        const db = harness.env.DB as any;
        const original = db.prepare;
        db.prepare = (sql: string) => {
          const stmt = original.call(db, sql);
          if (!sql.includes('SELECT user_id FROM user_roles')) return stmt;
          const bind = stmt.bind.bind(stmt);
          stmt.bind = (...params: unknown[]) => ({
            ...bind(...params),
            all: async () => ({ results: members }),
          });
          return stmt;
        };
      }

      it('lists members with $ref, type and the email read from the PII store', async () => {
        seedMembers([{ user_id: 'user-001' }, { user_id: 'user-002' }]);
        const res = await send('GET', '/scim/v2/Groups/group-001');
        expect(res.status).toBe(200);
        const body = await res.json<Record<string, any>>();
        expect(body.members).toEqual([
          {
            value: 'user-001',
            $ref: 'http://localhost/scim/v2/Users/user-001',
            type: 'User',
            display: 'john.doe@example.com',
          },
          {
            value: 'user-002',
            $ref: 'http://localhost/scim/v2/Users/user-002',
            type: 'User',
            display: 'jane.smith@example.com',
          },
        ]);
      });

      it('shows an empty display for a member whose account cannot be routed', async () => {
        seedMembers([{ user_id: 'user-gone' }]);
        const res = await send('GET', '/scim/v2/Groups/group-001');
        const body = await res.json<Record<string, any>>();
        expect(body.members).toEqual([
          {
            value: 'user-gone',
            $ref: 'http://localhost/scim/v2/Users/user-gone',
            type: 'User',
            display: '',
          },
        ]);
      });

      it('keeps members through a PATCH that does not touch them', async () => {
        seedMembers([{ user_id: 'user-001' }]);
        const res = await send(
          'PATCH',
          '/scim/v2/Groups/group-001',
          patchBody([{ op: 'replace', path: 'displayName', value: 'Renamed' }])
        );
        expect(res.status).toBe(200);
        const body = await res.json<Record<string, any>>();
        expect(body.displayName).toBe('Renamed');
        expect(body.members.map((m: any) => m.value)).toEqual(['user-001']);
      });

      it('creates a group whose schema is checked before anything is written', async () => {
        const res = await send('POST', '/scim/v2/Groups', {
          schemas: ['urn:other'],
          displayName: 'Bad schema',
        });
        expect(res.status).toBe(400);
        const body = await res.json<Record<string, unknown>>();
        expect(body.detail).toBe(`schemas must include ${GROUP_SCHEMA}`);
        expect(body.scimType).toBe('invalidValue');
      });
    });
  }
);
