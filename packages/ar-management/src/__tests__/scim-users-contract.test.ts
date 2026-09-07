import { describe, expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { describeScimTestHarness } from './scim-test-harness';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const BULK_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:BulkRequest';

describeScimTestHarness('SCIM Users HTTP contract', (harness) => {
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env as Env);

  function userBody(overrides: Record<string, unknown> = {}) {
    return {
      schemas: [USER_SCHEMA],
      userName: 'contract-user',
      emails: [{ value: 'contract.user@example.com', primary: true }],
      ...overrides,
    };
  }

  async function expectScimError(
    response: Response,
    status: number,
    scimType?: string
  ): Promise<Record<string, unknown>> {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/scim+json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.schemas).toEqual([ERROR_SCHEMA]);
    expect(body.status).toBe(String(status));
    if (scimType) expect(body.scimType).toBe(scimType);
    return body;
  }

  describe('create, read, filter, and pagination', () => {
    it('creates a user and reads the same SCIM resource', async () => {
      const created = await fetchScim('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(userBody()),
      });

      expect(created.status).toBe(201);
      expect(created.headers.get('content-type')).toContain('application/scim+json');
      const resource = (await created.json()) as { id: string; userName: string };
      expect(resource.userName).toBe('contract-user');

      const read = await fetchScim(`/scim/v2/Users/${resource.id}`);
      expect(read.status).toBe(200);
      await expect(read.json()).resolves.toMatchObject({
        schemas: [USER_SCHEMA],
        id: resource.id,
        userName: 'contract-user',
      });
    });

    it('uses the durable directory reservation instead of scanning every user for uniqueness', async () => {
      for (let index = 0; index < 1_003; index += 1) {
        harness.users.set(`existing-${index}`, {
          id: `existing-${index}`,
          tenant_id: 'default',
          email: `existing-${index}@example.test`,
          preferred_username: `existing-${index}`,
          active: 1,
          lifecycle_state: 'active',
          created_at: index + 1,
          updated_at: index + 1,
        });
      }

      const created = await fetchScim('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(
          userBody({
            userName: 'constant-time-create',
            emails: [{ value: 'constant-time-create@example.test', primary: true }],
          })
        ),
      });

      expect(created.status).toBe(201);
      expect(harness.crossShardList.calls).toBe(0);
    });

    it('supports an exact userName filter without returning unrelated users', async () => {
      const response = await fetchScim('/scim/v2/Users?filter=userName%20eq%20%22johndoe%22');

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        totalResults: 1,
        itemsPerPage: 1,
        Resources: [{ id: 'user-001', userName: 'johndoe' }],
      });
    });

    it('uses SCIM one-based pagination and preserves totalResults for count=0', async () => {
      const page = await fetchScim('/scim/v2/Users?startIndex=2&count=1');
      expect(page.status).toBe(200);
      await expect(page.json()).resolves.toMatchObject({
        totalResults: 2,
        startIndex: 2,
        itemsPerPage: 1,
      });

      const empty = await fetchScim('/scim/v2/Users?count=0');
      expect(empty.status).toBe(200);
      await expect(empty.json()).resolves.toMatchObject({
        totalResults: 2,
        itemsPerPage: 0,
        Resources: [],
      });
    });

    it('reports and filters the complete collection when it exceeds 1,000 users', async () => {
      const createdAt = Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000);
      for (let index = 0; index < 1_003; index += 1) {
        harness.users.set(`large-${index}`, {
          id: `large-${index}`,
          email: `large-${index}@example.com`,
          preferred_username: `large-${index}`,
          active: 1,
          created_at: createdAt,
          updated_at: createdAt,
        });
      }

      const page = await fetchScim('/scim/v2/Users?startIndex=1001&count=10');
      expect(page.status).toBe(200);
      await expect(page.json()).resolves.toMatchObject({
        totalResults: 1_005,
        startIndex: 1001,
        itemsPerPage: 5,
      });

      const filtered = await fetchScim('/scim/v2/Users?filter=userName%20eq%20%22large-1002%22');
      expect(filtered.status).toBe(200);
      await expect(filtered.json()).resolves.toMatchObject({
        totalResults: 1,
        Resources: [{ id: 'large-1002', userName: 'large-1002' }],
      });
    });
  });

  describe('uniqueness', () => {
    it('rejects a duplicate email with 409 uniqueness', async () => {
      const response = await fetchScim('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(
          userBody({
            userName: 'different-user-name',
            emails: [{ value: 'JOHN.DOE@example.com', primary: true }],
          })
        ),
      });

      await expectScimError(response, 409, 'uniqueness');
      expect(harness.accountCreation.calls).toHaveLength(1);
    });

    it.each(['johndoe', 'JohnDoe', 'JOHNDOE'])(
      'rejects duplicate userName %s case-insensitively at the durable directory reservation',
      async (userName) => {
        const response = await fetchScim('/scim/v2/Users', {
          method: 'POST',
          body: JSON.stringify(
            userBody({
              userName,
              emails: [{ value: `${userName.toLowerCase()}.duplicate@example.com` }],
            })
          ),
        });

        await expectScimError(response, 409, 'uniqueness');
        expect(harness.accountCreation.calls).toHaveLength(1);
      }
    );

    it('allows only one winner when the same userName is created concurrently', async () => {
      const beforeSize = harness.users.size;
      const [first, second] = await Promise.all([
        fetchScim('/scim/v2/Users', {
          method: 'POST',
          body: JSON.stringify(
            userBody({
              userName: 'Concurrent-User',
              emails: [{ value: 'concurrent.one@example.com', primary: true }],
            })
          ),
        }),
        fetchScim('/scim/v2/Users', {
          method: 'POST',
          body: JSON.stringify(
            userBody({
              userName: 'concurrent-user',
              emails: [{ value: 'concurrent.two@example.com', primary: true }],
            })
          ),
        }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(harness.users.size).toBe(beforeSize + 1);
      const conflict = first.status === 409 ? first : second;
      await expectScimError(conflict, 409, 'uniqueness');
    });
  });

  describe('input validation', () => {
    it.each([
      ['missing userName', { schemas: [USER_SCHEMA], emails: [] }, 'invalidValue'],
      ['missing schemas', { userName: 'missing-schemas' }, 'invalidValue'],
      [
        'wrong resource schema',
        { schemas: [ERROR_SCHEMA], userName: 'wrong-schema' },
        'invalidValue',
      ],
      ['password provisioning', userBody({ password: 'must-not-be-stored' }), 'invalidValue'],
      [
        'invalid email',
        userBody({ emails: [{ value: 'lookup_email_invalid secret@example.com' }] }),
        'invalidValue',
      ],
      [
        'email containing a control character',
        userBody({ emails: [{ value: 'control\u0000@example.com' }] }),
        'invalidValue',
      ],
    ])('returns a SCIM 400 for %s', async (_label, body, scimType) => {
      const response = await fetchScim('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const error = await expectScimError(response, 400, scimType);
      expect(JSON.stringify(error)).not.toContain('lookup_email_invalid');
      expect(JSON.stringify(error)).not.toContain('secret@example.com');
    });

    it('converts a missing mapping-required email to 400 without exposing an internal code', async () => {
      const response = await fetchScim('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'mapping-missing-email' }),
      });

      const error = await expectScimError(response, 400, 'invalidValue');
      expect(error.detail).toBe('SCIM Mapping Set must produce authrim.profile.email');
      expect(error).not.toHaveProperty('code');
      expect(harness.accountCreation.calls).toHaveLength(0);
    });

    it('does not expose mapping implementation codes from a Bulk operation', async () => {
      const response = await fetchScim('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({
          schemas: [BULK_SCHEMA],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              bulkId: 'missing-email',
              data: { schemas: [USER_SCHEMA], userName: 'bulk-mapping-missing-email' },
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        Operations: Array<{ status: string; response: Record<string, unknown> }>;
      };
      expect(body.Operations[0]).toMatchObject({
        status: '400',
        response: {
          schemas: [ERROR_SCHEMA],
          status: '400',
          scimType: 'invalidValue',
        },
      });
      expect(body.Operations[0]?.response).not.toHaveProperty('code');
    });

    it('rejects unsupported filters as invalidFilter', async () => {
      const response = await fetchScim(
        '/scim/v2/Users?filter=unknownAttribute%20eq%20%22private-value%22'
      );

      const error = await expectScimError(response, 400, 'invalidFilter');
      expect(error.detail).toBe('Invalid filter syntax');
      expect(JSON.stringify(error)).not.toContain('private-value');
    });
  });

  describe('conditional requests and disabled capabilities', () => {
    it('returns 412 invalidVers for a stale If-Match value', async () => {
      const response = await fetchScim('/scim/v2/Users/user-001', {
        method: 'PUT',
        headers: { 'If-Match': 'W/"stale"' },
        body: JSON.stringify(userBody({ userName: 'johndoe' })),
      });

      await expectScimError(response, 412, 'invalidVers');
    });

    it('returns 403 SCIM errors when Groups and Bulk are disabled', async () => {
      harness.settings.groupsEnabled = false;
      const groups = await fetchScim('/scim/v2/Groups');
      await expectScimError(groups, 403);

      harness.settings.groupsEnabled = true;
      harness.settings.bulkEnabled = false;
      const bulk = await fetchScim('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({ schemas: [BULK_SCHEMA], Operations: [] }),
      });
      await expectScimError(bulk, 403);
    });
  });

  describe('identifier replacement', () => {
    it('routes changed userName and email through durable identifier replacement on PUT', async () => {
      const response = await fetchScim('/scim/v2/Users/user-001', {
        method: 'PUT',
        body: JSON.stringify(
          userBody({
            userName: 'john-renamed',
            emails: [{ value: 'john.renamed@example.com', primary: true }],
          })
        ),
      });

      expect(response.status).toBe(200);
      expect(harness.identifierReplacement.calls).toHaveLength(1);
      expect(harness.identifierReplacement.calls[0]).toMatchObject({
        tenantId: 'default',
        accountId: 'user-001',
        oldValues: { userName: 'johndoe', email: 'john.doe@example.com' },
        newValues: { userName: 'john-renamed', email: 'john.renamed@example.com' },
      });
    });

    it('returns 409 uniqueness and leaves the canonical user unchanged on reservation conflict', async () => {
      harness.identifierReplacement.error = new Error(
        'identifier_replacement_reservation_conflict'
      );
      const response = await fetchScim('/scim/v2/Users/user-001', {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'replace', path: 'userName', value: 'reserved-user' }],
        }),
      });

      await expectScimError(response, 409, 'uniqueness');
      expect(harness.users.get('user-001')?.preferred_username).toBe('johndoe');
    });
  });

  it('does not expose internal allocation errors or submitted PII', async () => {
    harness.accountCreation.capacityUnavailable = true;
    const response = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify(
        userBody({
          userName: 'capacity-user',
          emails: [{ value: 'capacity.private@example.com', primary: true }],
        })
      ),
    });

    const error = await expectScimError(response, 503);
    expect(error.detail).toBe('Account storage capacity is temporarily unavailable');
    expect(JSON.stringify(error)).not.toContain('control_account_allocation_capacity_unavailable');
    expect(JSON.stringify(error)).not.toContain('capacity.private@example.com');
  });

  it('does not expose a propagating binding name or submitted PII', async () => {
    harness.accountCreation.bindingUnavailable = true;
    const response = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify(
        userBody({
          userName: 'binding-user',
          emails: [{ value: 'binding.private@example.com', primary: true }],
        })
      ),
    });

    const error = await expectScimError(response, 503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(error.detail).toBe('Runtime database binding is propagating; retry shortly');
    expect(JSON.stringify(error)).not.toContain('account_directory_write_binding_unavailable');
    expect(JSON.stringify(error)).not.toContain('binding.private@example.com');
  });
});
