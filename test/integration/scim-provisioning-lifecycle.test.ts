import { expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { describeScimTestHarness } from '../../packages/ar-management/src/__tests__/scim-test-harness';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

describeScimTestHarness('SCIM provisioning lifecycle integration', (harness) => {
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env as Env);

  it('creates asynchronously, completes the operation, and reads active:false', async () => {
    harness.accountCreation.deliveryStatus = 202;
    const create = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'integration-inactive',
        emails: [{ value: 'integration.inactive@example.com', primary: true }],
        active: false,
      }),
    });
    expect(create.status).toBe(202);
    const pending = (await create.json()) as { operationId: string };
    const call = harness.accountCreation.calls[0] as { candidateUserId: string };

    harness.accountOperation.operation = {
      operationId: pending.operationId,
      tenantId: 'default',
      actorId: `scim-token:${'a'.repeat(64)}`,
      userId: call.candidateUserId,
      status: 'succeeded',
    };
    const operation = await fetchScim(`/scim/v2/Operations/${pending.operationId}`);
    expect(operation.status).toBe(200);
    await expect(operation.json()).resolves.toMatchObject({ status: 'succeeded' });

    const read = await fetchScim(`/scim/v2/Users/${call.candidateUserId}`);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      id: call.candidateUserId,
      active: false,
    });
  });

  it('deactivates and reactivates by PUT without creating a duplicate account', async () => {
    const deactivate = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      body: JSON.stringify({
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });
    expect(deactivate.status).toBe(200);
    await expect(deactivate.json()).resolves.toMatchObject({ active: false });

    const replace = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PUT',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'johndoe',
        emails: [{ value: 'john.doe@example.com', primary: true }],
        active: true,
      }),
    });
    expect(replace.status).toBe(200);
    await expect(replace.json()).resolves.toMatchObject({ id: 'user-001', active: true });
    expect(harness.users.size).toBe(2);
    expect(harness.accountCreation.calls).toHaveLength(0);
  });

  it('enforces userName uniqueness and mapping/email validation at the HTTP boundary', async () => {
    const duplicate = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'JOHNDOE',
        emails: [{ value: 'unique@example.com' }],
      }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      status: '409',
      scimType: 'uniqueness',
    });

    const missingMappedEmail = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({ schemas: [USER_SCHEMA], userName: 'missing-email' }),
    });
    expect(missingMappedEmail.status).toBe(400);
    await expect(missingMappedEmail.json()).resolves.toMatchObject({
      status: '400',
      scimType: 'invalidValue',
    });

    const invalidEmail = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'invalid-email',
        emails: [{ value: 'lookup_email_invalid' }],
      }),
    });
    expect(invalidEmail.status).toBe(400);
    const invalidBody = (await invalidEmail.json()) as Record<string, unknown>;
    expect(invalidBody).toMatchObject({ status: '400', scimType: 'invalidValue' });
    expect(JSON.stringify(invalidBody)).not.toContain('lookup_email_invalid');
  });

  it('rejects stale ETags and preserves the resource', async () => {
    const before = { ...harness.users.get('user-001') };
    const response = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      headers: { 'If-Match': 'W/"stale"' },
      body: JSON.stringify({
        schemas: [PATCH_SCHEMA],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      }),
    });

    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      status: '412',
      scimType: 'invalidVers',
    });
    expect(harness.users.get('user-001')).toMatchObject(before);
  });

  it('does not list or resolve a resource owned by another tenant', async () => {
    harness.users.set('foreign-user', {
      id: 'foreign-user',
      tenant_id: 'tenant-b',
      email: 'foreign@example.com',
      preferred_username: 'foreign-user',
      active: 1,
      lifecycle_state: 'active',
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    });

    const list = await fetchScim('/scim/v2/Users');
    const body = (await list.json()) as { Resources: Array<{ id: string }> };
    expect(body.Resources.map((resource) => resource.id)).not.toContain('foreign-user');
    expect((await fetchScim('/scim/v2/Users/foreign-user')).status).toBe(404);
  });
});
