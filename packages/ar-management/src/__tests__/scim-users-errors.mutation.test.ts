/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { describe, expect, it, vi } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

describeScimTestHarness('SCIM Users routes error mapping (mutation coverage)', (harness) => {
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env);
  const send = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    fetchScim(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers,
    });

  async function expectError(res: Response, status: number, detail: string, scimType?: string) {
    expect(res.status).toBe(status);
    const body = await res.json<Record<string, unknown>>();
    expect(body.schemas).toEqual([ERROR_SCHEMA]);
    expect(body.status).toBe(String(status));
    expect(body.detail).toBe(detail);
    if (scimType) expect(body.scimType).toBe(scimType);
    else expect(body.scimType).toBeUndefined();
  }

  const userBody = (over: Record<string, unknown> = {}) => ({
    schemas: [USER_SCHEMA],
    userName: 'johndoe',
    emails: [{ value: 'john.doe@example.com', primary: true }],
    ...over,
  });
  const patchBody = (ops: unknown[]) => ({ schemas: [PATCH_SCHEMA], Operations: ops });

  describe('provisioning switch', () => {
    it('refuses everything but discovery while inbound provisioning is disabled', async () => {
      harness.settings.enabled = false;
      await expectError(
        await fetchScim('/scim/v2/Users'),
        403,
        'SCIM inbound provisioning is disabled'
      );
      await expectError(
        await fetchScim('/scim/v2/Groups'),
        403,
        'SCIM inbound provisioning is disabled'
      );
      const discovery = await fetchScim('/scim/v2/ServiceProviderConfig');
      expect(discovery.status).toBe(200);
    });
  });

  describe('request bodies', () => {
    it('rejects a non-object body on POST and PUT', async () => {
      await expectError(
        await send('POST', '/scim/v2/Users', ['x']),
        400,
        'SCIM User must be an object',
        'invalidSyntax'
      );
      await expectError(
        await send('PUT', '/scim/v2/Users/user-001', 'x'),
        400,
        'SCIM User must be an object',
        'invalidSyntax'
      );
    });

    it('rejects an empty body on POST, PUT and PATCH', async () => {
      for (const [method, path] of [
        ['POST', '/scim/v2/Users'],
        ['PUT', '/scim/v2/Users/user-001'],
        ['PATCH', '/scim/v2/Users/user-001'],
      ]) {
        await expectError(
          await fetchScim(path, { method, body: '  ' }),
          400,
          'Request body must contain JSON',
          'invalidSyntax'
        );
      }
    });

    it('rejects a PATCH that is not a PatchOp document', async () => {
      const res = await send('PATCH', '/scim/v2/Users/user-001', { schemas: [PATCH_SCHEMA] });
      expect(res.status).toBe(400);
      const body = await res.json<Record<string, unknown>>();
      expect(body.scimType).toBe('invalidSyntax');
      expect(String(body.detail).length).toBeGreaterThan(0);
    });
  });

  describe('unknown users', () => {
    it('answers 404 on GET, PUT, PATCH and DELETE', async () => {
      const detail = 'The requested resource was not found';
      await expectError(await fetchScim('/scim/v2/Users/ghost'), 404, detail);
      await expectError(await send('PUT', '/scim/v2/Users/ghost', userBody()), 404, detail);
      await expectError(
        await send(
          'PATCH',
          '/scim/v2/Users/ghost',
          patchBody([{ op: 'replace', path: 'userName', value: 'x' }])
        ),
        404,
        detail
      );
      await expectError(await send('DELETE', '/scim/v2/Users/ghost'), 404, detail);
    });
  });

  describe('If-Match', () => {
    const stale = { 'If-Match': 'W/"stale"' };
    const detail = 'Precondition failed - resource was modified';

    it('answers 412 on PUT, PATCH and DELETE with a stale version and changes nothing', async () => {
      await expectError(
        await send('PUT', '/scim/v2/Users/user-001', userBody({ userName: 'changed' }), stale),
        412,
        detail,
        'invalidVers'
      );
      await expectError(
        await send(
          'PATCH',
          '/scim/v2/Users/user-001',
          patchBody([{ op: 'replace', path: 'userName', value: 'changed' }]),
          stale
        ),
        412,
        detail,
        'invalidVers'
      );
      await expectError(
        await send('DELETE', '/scim/v2/Users/user-001', undefined, stale),
        412,
        detail,
        'invalidVers'
      );
      expect(harness.users.get('user-001').preferred_username).toBe('johndoe');
      expect(harness.users.get('user-001').active).toBe(1);
    });

    it('accepts the current version on PUT, returns a new ETag and rejects the old one afterwards', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2024-02-01T00:00:00Z'));
        const current = await fetchScim('/scim/v2/Users/user-001');
        const oldEtag = current.headers.get('ETag') as string;
        expect(oldEtag).toBeTruthy();
        vi.setSystemTime(new Date('2024-02-01T00:10:00Z'));
        const res = await send(
          'PUT',
          '/scim/v2/Users/user-001',
          userBody({ displayName: 'John D.' }),
          { 'If-Match': oldEtag }
        );
        expect(res.status).toBe(200);
        const newEtag = res.headers.get('ETag') as string;
        expect(newEtag).toBeTruthy();
        expect(newEtag).not.toBe(oldEtag);
        const body = await res.json<Record<string, any>>();
        expect(newEtag).toBe(body.meta.version);
        await expectError(
          await send('PUT', '/scim/v2/Users/user-001', userBody({ displayName: 'Again' }), {
            'If-Match': oldEtag,
          }),
          412,
          detail,
          'invalidVers'
        );
        const second = await send(
          'PUT',
          '/scim/v2/Users/user-001',
          userBody({ displayName: 'Again' }),
          { 'If-Match': newEtag }
        );
        expect(second.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('identifier replacement failures', () => {
    it.each([
      'identifier_replacement_reservation_conflict',
      'identifier_replacement_operation_active',
      'identifier_replacement_idempotency_conflict',
      'identifier_replacement_old_route_invalid',
    ])('maps %s to 409 uniqueness on PUT and PATCH', async (code) => {
      harness.identifierReplacement.error = new Error(code);
      const put = await send('PUT', '/scim/v2/Users/user-001', userBody({ userName: 'renamed' }));
      await expectError(
        put,
        409,
        'User identifier already exists or is being changed',
        'uniqueness'
      );
      const patch = await send(
        'PATCH',
        '/scim/v2/Users/user-001',
        patchBody([{ op: 'replace', path: 'userName', value: 'renamed' }])
      );
      await expectError(
        patch,
        409,
        'User identifier already exists or is being changed',
        'uniqueness'
      );
    });

    it('maps any other identifier_replacement_ failure to 503', async () => {
      harness.identifierReplacement.error = new Error('identifier_replacement_something_else');
      const put = await send('PUT', '/scim/v2/Users/user-001', userBody({ userName: 'renamed' }));
      await expectError(put, 503, 'User identifier update is temporarily unavailable');
      const patch = await send(
        'PATCH',
        '/scim/v2/Users/user-001',
        patchBody([{ op: 'replace', path: 'userName', value: 'renamed' }])
      );
      await expectError(patch, 503, 'User identifier update is temporarily unavailable');
    });

    it('does not mask an unrelated failure as an identifier error', async () => {
      harness.identifierReplacement.error = new Error('something_else_entirely');
      const put = await send('PUT', '/scim/v2/Users/user-001', userBody({ userName: 'renamed' }));
      await expectError(put, 500, 'Internal server error');
    });
  });

  describe('routing failures are internal errors', () => {
    it('answers 500 without leaking the cause on GET, PUT, PATCH and DELETE', async () => {
      harness.accountRouting.error = new Error('shard_down_secret');
      const responses = [
        await fetchScim('/scim/v2/Users/user-001'),
        await send('PUT', '/scim/v2/Users/user-001', userBody()),
        await send(
          'PATCH',
          '/scim/v2/Users/user-001',
          patchBody([{ op: 'replace', path: 'userName', value: 'x' }])
        ),
        await send('DELETE', '/scim/v2/Users/user-001'),
      ];
      for (const res of responses) {
        expect(res.status).toBe(500);
        const text = await res.text();
        expect(text).toContain('Internal server error');
        expect(text).not.toContain('shard_down_secret');
      }
    });
  });

  describe('GET /Operations/:id', () => {
    it('answers 404 for an invalid operation id and 500 for other failures', async () => {
      harness.accountOperation.error = new Error('account_creation_operation_id_invalid');
      await expectError(
        await fetchScim('/scim/v2/Operations/bad'),
        404,
        'The requested resource was not found'
      );
      harness.accountOperation.error = new Error('account_creation_tenant_id_invalid');
      await expectError(
        await fetchScim('/scim/v2/Operations/bad'),
        404,
        'The requested resource was not found'
      );
      harness.accountOperation.error = new Error('account_creation_actor_id_invalid');
      await expectError(
        await fetchScim('/scim/v2/Operations/bad'),
        404,
        'The requested resource was not found'
      );
      harness.accountOperation.error = new Error('account_creation_operation_id_invalid_x');
      await expectError(await fetchScim('/scim/v2/Operations/bad'), 500, 'Internal server error');
    });
  });
});
