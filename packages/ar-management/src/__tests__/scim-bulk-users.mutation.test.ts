/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { describe, expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const BULK_REQUEST = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

type Op = Record<string, unknown>;

describeScimTestHarness('SCIM Bulk user operations (mutation coverage)', (harness) => {
  async function bulk(operations: Op[]): Promise<Array<Record<string, any>>> {
    const res = await harness.app.fetch(
      harness.createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({ schemas: [BULK_REQUEST], Operations: operations }),
      }),
      harness.env
    );
    expect(res.status).toBe(200);
    return (await res.json<{ Operations: Array<Record<string, any>> }>()).Operations;
  }

  const userData = (over: Op = {}) => ({
    schemas: [USER_SCHEMA],
    userName: 'bulk-user',
    emails: [{ value: 'bulk.user@example.com', primary: true }],
    ...over,
  });
  const post = (bulkId: string, data: Op = userData()): Op => ({
    method: 'POST',
    path: '/Users',
    bulkId,
    data,
  });
  const put = (data: Op = userData({ userName: 'johndoe' }), extra: Op = {}): Op => ({
    method: 'PUT',
    path: '/Users/user-001',
    data,
    ...extra,
  });
  const patch = (ops: unknown[], extra: Op = {}): Op => ({
    method: 'PATCH',
    path: '/Users/user-001',
    data: { schemas: [PATCH_SCHEMA], Operations: ops },
    ...extra,
  });

  describe('POST', () => {
    it('creates a user and reports its location, version and resource', async () => {
      const [r] = await bulk([post('b1')]);
      expect(r.status).toBe('201');
      expect(r.method).toBe('POST');
      expect(r.bulkId).toBe('b1');
      expect(r.location).toMatch(/^http:\/\/localhost\/scim\/v2\/Users\/.+/);
      expect(r.response.userName).toBe('bulk-user');
      expect(r.version).toBe(r.response.meta.version);
      expect(harness.accountCreation.calls).toHaveLength(1);
    });

    it('answers 202 with a pending operation when creation is delivered asynchronously', async () => {
      harness.accountCreation.deliveryStatus = 202;
      const [r] = await bulk([post('b2')]);
      expect(r.status).toBe('202');
      expect(r.bulkId).toBe('b2');
      expect(r.location).toMatch(/^http:\/\/localhost\/scim\/v2\/Operations\/.+/);
      expect(r.response).toBeDefined();
    });

    it('rejects an invalid user and a password credential', async () => {
      const out = await bulk([
        post('v1', { schemas: [USER_SCHEMA] }),
        post('v2', userData({ password: 'secret-value' })),
      ]);
      expect(out[0].status).toBe('400');
      expect(out[0].bulkId).toBe('v1');
      expect(out[0].response.schemas).toEqual([ERROR_SCHEMA]);
      expect(out[0].response.scimType).toBe('invalidValue');
      expect(out[0].response.detail).toContain('userName');
      expect(out[1].status).toBe('400');
      expect(out[1].bulkId).toBe('v2');
      expect(out[1].response.scimType).toBe('invalidValue');
      expect(JSON.stringify(out[1])).not.toContain('secret-value');
      expect(harness.accountCreation.calls).toHaveLength(0);
    });

    it('rejects a user missing a required custom claim and names the field', async () => {
      harness.setCustomClaimSchemas([harness.createCustomClaimSchemaRow()]);
      const [r] = await bulk([post('c1')]);
      expect(r.status).toBe('400');
      expect(r.method).toBe('POST');
      expect(r.response.scimType).toBe('invalidValue');
      expect(r.response.missing_required_fields).toEqual([
        { field_key: 'department', label: 'Department', field_type: 'string' },
      ]);
      expect(harness.accountCreation.calls).toHaveLength(0);
    });

    it('maps a capacity shortage and a propagating binding to 503', async () => {
      harness.accountCreation.capacityUnavailable = true;
      const [capacity] = await bulk([post('cap')]);
      expect(capacity.status).toBe('503');
      expect(capacity.bulkId).toBe('cap');
      expect(capacity.response.detail).toBe('Account storage capacity is temporarily unavailable');
      expect(capacity.response.status).toBe('503');

      harness.accountCreation.capacityUnavailable = false;
      harness.accountCreation.bindingUnavailable = true;
      const [binding] = await bulk([post('bind')]);
      expect(binding.status).toBe('503');
      expect(binding.response.detail).toBe(
        'Runtime database binding is propagating; retry shortly'
      );
    });
  });

  describe('PUT', () => {
    it('replaces a user and returns the new representation', async () => {
      const [r] = await bulk([
        put(
          userData({
            userName: 'john-renamed',
            emails: [{ value: 'j@example.com', primary: true }],
          })
        ),
      ]);
      expect(r.status).toBe('200');
      expect(r.method).toBe('PUT');
      expect(r.location).toBe('http://localhost/scim/v2/Users/user-001');
      expect(r.version).toBe(r.response.meta.version);
      expect(harness.identifierReplacement.calls).toHaveLength(1);
      expect(harness.identifierReplacement.calls[0]).toMatchObject({
        tenantId: 'default',
        accountId: 'user-001',
        newValues: { userName: 'john-renamed' },
      });
    });

    it('rejects an invalid body and a password credential without writing', async () => {
      const out = await bulk([
        put({ schemas: [USER_SCHEMA] }),
        put(userData({ userName: 'johndoe', password: 'secret-value' })),
      ]);
      expect(out[0].status).toBe('400');
      expect(out[0].response.scimType).toBe('invalidValue');
      expect(out[0].response.detail).toContain('userName');
      expect(out[1].status).toBe('400');
      expect(out[1].method).toBe('PUT');
      expect(out[1].response.scimType).toBe('invalidValue');
      expect(harness.identifierReplacement.calls).toHaveLength(0);
    });

    it('rejects a replacement that drops a required custom claim', async () => {
      harness.setCustomClaimSchemas([harness.createCustomClaimSchemaRow()]);
      const [r] = await bulk([put()]);
      expect(r.status).toBe('400');
      expect(r.response.missing_required_fields).toEqual([
        { field_key: 'department', label: 'Department', field_type: 'string' },
      ]);
      expect(harness.identifierReplacement.calls).toHaveLength(0);
    });

    it('maps identifier replacement failures per operation', async () => {
      const cases: Array<[string, string, string, string | undefined]> = [
        [
          'identifier_replacement_reservation_conflict',
          '409',
          'User identifier already exists or is being changed',
          'uniqueness',
        ],
        [
          'identifier_replacement_operation_active',
          '409',
          'User identifier already exists or is being changed',
          'uniqueness',
        ],
        [
          'identifier_replacement_idempotency_conflict',
          '409',
          'User identifier already exists or is being changed',
          'uniqueness',
        ],
        [
          'identifier_replacement_old_route_invalid',
          '409',
          'User identifier already exists or is being changed',
          'uniqueness',
        ],
        [
          'identifier_replacement_unexpected',
          '503',
          'User identifier update is temporarily unavailable',
          undefined,
        ],
        ['lookup_email_invalid', '400', 'A mapped email address is invalid', 'invalidValue'],
        ['boom', '500', 'Internal server error processing operation', undefined],
      ];
      for (const [message, status, detail, scimType] of cases) {
        harness.identifierReplacement.error = new Error(message);
        const [r] = await bulk([put()]);
        expect(r.status).toBe(status);
        expect(r.response.status).toBe(status);
        expect(r.response.detail).toBe(detail);
        expect(r.response.schemas).toEqual([ERROR_SCHEMA]);
        expect(r.response.scimType).toBe(scimType);
      }
    });
  });

  describe('PATCH', () => {
    it('applies a patch and returns the updated user', async () => {
      const [r] = await bulk([patch([{ op: 'replace', path: 'displayName', value: 'JD' }])]);
      expect(r.status).toBe('200');
      expect(r.method).toBe('PATCH');
      expect(r.location).toBe('http://localhost/scim/v2/Users/user-001');
      expect(r.version).toBe(r.response.meta.version);
    });

    it('rejects a patch that makes the user invalid or sets a password', async () => {
      const out = await bulk([
        patch([{ op: 'remove', path: 'userName' }]),
        patch([{ op: 'add', path: 'password', value: 'secret-value' }]),
      ]);
      expect(out[0].status).toBe('400');
      expect(out[0].response.scimType).toBe('invalidValue');
      expect(out[0].response.detail).toContain('userName');
      expect(out[1].status).toBe('400');
      expect(out[1].method).toBe('PATCH');
      expect(out[1].response.scimType).toBe('invalidValue');
      expect(JSON.stringify(out[1])).not.toContain('secret-value');
    });

    it('rejects a patch when a required custom claim is missing', async () => {
      harness.setCustomClaimSchemas([harness.createCustomClaimSchemaRow()]);
      const [r] = await bulk([patch([{ op: 'replace', path: 'displayName', value: 'JD' }])]);
      expect(r.status).toBe('400');
      expect(r.method).toBe('PATCH');
      expect(r.response.scimType).toBe('invalidValue');
      expect(r.response.missing_required_fields).toEqual([
        { field_key: 'department', label: 'Department', field_type: 'string' },
      ]);
    });
  });
});
