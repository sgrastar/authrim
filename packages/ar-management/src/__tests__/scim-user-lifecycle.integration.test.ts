import { expect, it } from 'vitest';
import type { Env } from '@authrim/ar-lib-core/types/env';
import { describeScimTestHarness } from './scim-test-harness';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

describeScimTestHarness('SCIM user and directory lifecycle', (harness) => {
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env as Env);

  const replaceBody = (active: boolean) => ({
    schemas: [USER_SCHEMA],
    userName: 'johndoe',
    displayName: 'John Doe',
    emails: [{ value: 'john.doe@example.com', primary: true }],
    active,
  });

  const activePatch = (active: boolean) => ({
    schemas: [PATCH_SCHEMA],
    Operations: [{ op: 'replace', path: 'active', value: active }],
  });

  it('creates active:false as an inactive canonical account', async () => {
    const response = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'initially-inactive',
        emails: [{ value: 'initially.inactive@example.com', primary: true }],
        active: false,
      }),
    });

    expect(response.status).toBe(201);
    const resource = (await response.json()) as { id: string; active: boolean };
    expect(resource.active).toBe(false);
    expect(harness.users.get(resource.id)).toMatchObject({
      active: 0,
      lifecycle_state: 'deprovisioned',
    });
    expect(harness.accountCreation.calls[0]).toMatchObject({
      tenantId: 'default',
    });
  });

  it('represents asynchronous publication as 202 and exposes its terminal transition', async () => {
    harness.accountCreation.deliveryStatus = 202;
    const response = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'scim-lifecycle-pending-1' },
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'pending-inactive',
        emails: [{ value: 'pending.inactive@example.com', primary: true }],
        active: false,
      }),
    });

    expect(response.status).toBe(202);
    const pending = (await response.json()) as { operationId: string; status: string };
    expect(pending.status).toBe('directory_pending');
    const createdCall = harness.accountCreation.calls[0] as {
      candidateUserId: string;
      candidateOperationId: string;
    };
    expect(harness.users.get(createdCall.candidateUserId)).toMatchObject({
      active: 0,
      lifecycle_state: 'deprovisioned',
    });

    harness.accountOperation.operation = {
      operationId: pending.operationId,
      tenantId: 'default',
      actorId: `scim-token:${'a'.repeat(64)}`,
      userId: createdCall.candidateUserId,
      status: 'succeeded',
    };
    const completed = await fetchScim(`/scim/v2/Operations/${pending.operationId}`);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      operationId: pending.operationId,
      status: 'succeeded',
      userId: createdCall.candidateUserId,
    });
  });

  it('deactivates and reactivates the same resource while enforcing ETags', async () => {
    harness.users.get('user-001').updated_at = Math.floor(Date.now() / 1000) - 30;
    const initial = await fetchScim('/scim/v2/Users/user-001');
    const initialEtag = initial.headers.get('etag');
    expect(initialEtag).toBeTruthy();

    const deactivated = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      headers: { 'If-Match': initialEtag! },
      body: JSON.stringify(activePatch(false)),
    });
    expect(deactivated.status).toBe(200);
    await expect(deactivated.json()).resolves.toMatchObject({ id: 'user-001', active: false });
    const inactiveEtag = deactivated.headers.get('etag');
    expect(inactiveEtag).toBeTruthy();
    expect(inactiveEtag).not.toBe(initialEtag);
    expect(harness.users.get('user-001')).toMatchObject({
      active: 0,
      lifecycle_state: 'deprovisioned',
    });
    expect(harness.sessionRevocationStates.get('account:user-001')?.lifecycle).toBe('inactive');

    const stale = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      headers: { 'If-Match': initialEtag! },
      body: JSON.stringify(activePatch(true)),
    });
    expect(stale.status).toBe(412);

    harness.customClaimRouting.rejectAccountLookup = true;
    const reactivated = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      headers: { 'If-Match': inactiveEtag! },
      body: JSON.stringify(activePatch(true)),
    });
    expect(reactivated.status).toBe(200);
    await expect(reactivated.json()).resolves.toMatchObject({ id: 'user-001', active: true });
    expect(harness.users.size).toBe(2);
    expect(harness.users.get('user-001')).toMatchObject({
      active: 1,
      lifecycle_state: 'active',
    });
    expect(harness.sessionRevocationStates.get('account:user-001')?.lifecycle).toBe('active');
    expect(harness.accountRouting.calls).toContain('user-001');
  });

  it('replaces a deactivated user without allocating a second account', async () => {
    const deactivate = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PATCH',
      body: JSON.stringify(activePatch(false)),
    });
    expect(deactivate.status).toBe(200);

    harness.customClaimRouting.rejectAccountLookup = true;
    const replace = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PUT',
      body: JSON.stringify(replaceBody(true)),
    });

    expect(replace.status).toBe(200);
    await expect(replace.json()).resolves.toMatchObject({ id: 'user-001', active: true });
    expect(harness.users.size).toBe(2);
    expect(harness.users.get('user-001')).toMatchObject({ active: 1, lifecycle_state: 'active' });
    expect(harness.accountCreation.calls).toHaveLength(0);
  });

  it('does not leave an account or directory route after creation fails', async () => {
    const beforeIds = [...harness.users.keys()];
    harness.accountCreation.capacityUnavailable = true;

    const response = await fetchScim('/scim/v2/Users', {
      method: 'POST',
      body: JSON.stringify({
        schemas: [USER_SCHEMA],
        userName: 'failed-create',
        emails: [{ value: 'failed.create@example.com', primary: true }],
      }),
    });

    expect(response.status).toBe(503);
    expect([...harness.users.keys()]).toEqual(beforeIds);
    expect(harness.accountRouting.calls).not.toContain('failed-create');
  });

  it('does not partially replace a user when a required mapped value would be removed', async () => {
    harness.setCustomClaimSchemas([harness.createCustomClaimSchemaRow()]);
    harness.users.get('user-001').custom_attributes_json = JSON.stringify({
      department: 'Engineering',
    });
    const before = { ...harness.users.get('user-001') };

    const response = await fetchScim('/scim/v2/Users/user-001', {
      method: 'PUT',
      body: JSON.stringify(replaceBody(true)),
    });

    expect(response.status).toBe(400);
    expect(harness.users.get('user-001')).toMatchObject(before);
  });

  it('keeps list and lookup operations inside the current tenant', async () => {
    harness.users.set('tenant-b-user', {
      id: 'tenant-b-user',
      tenant_id: 'tenant-b',
      email: 'tenant.b@example.com',
      preferred_username: 'tenant-b-user',
      active: 1,
      lifecycle_state: 'active',
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
    });

    const list = await fetchScim('/scim/v2/Users');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { Resources: Array<{ id: string }> };
    expect(listBody.Resources.map((resource) => resource.id)).not.toContain('tenant-b-user');

    const lookup = await fetchScim('/scim/v2/Users/tenant-b-user');
    expect(lookup.status).toBe(404);
  });
});
