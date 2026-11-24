/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

describeScimTestHarness('SCIM Users list, filter and sort (mutation coverage)', (harness) => {
  const fetchScim = (path: string, options?: RequestInit) =>
    harness.app.fetch(harness.createRequest(path, options), harness.env);

  async function list(query: string) {
    const res = await fetchScim(`/scim/v2/Users?${query}`);
    return { res, body: await res.json<Record<string, any>>() };
  }

  const names = (body: Record<string, any>) =>
    (body.Resources as Array<{ userName: string }>).map((u) => u.userName);

  async function expectError(res: Response, status: number, detail: string, scimType?: string) {
    expect(res.status).toBe(status);
    const body = await res.json<Record<string, unknown>>();
    expect(body.schemas).toEqual([ERROR_SCHEMA]);
    expect(body.status).toBe(String(status));
    expect(body.detail).toBe(detail);
    if (scimType) expect(body.scimType).toBe(scimType);
  }

  it('rejects attributes together with excludedAttributes', async () => {
    const res = await fetchScim('/scim/v2/Users?attributes=userName&excludedAttributes=emails');
    await expectError(
      res,
      400,
      'attributes and excludedAttributes are mutually exclusive',
      'invalidValue'
    );
  });

  it('rejects a filter that cannot be parsed without leaking parser details', async () => {
    const res = await fetchScim(`/scim/v2/Users?filter=${encodeURIComponent('userName ??? "x"')}`);
    await expectError(res, 400, 'Invalid filter syntax', 'invalidFilter');
  });

  it('rejects an unknown sortBy and lists the allowed attributes', async () => {
    const res = await fetchScim('/scim/v2/Users?sortBy=password');
    expect(res.status).toBe(400);
    const body = await res.json<{ detail: string; scimType: string }>();
    expect(body.scimType).toBe('invalidValue');
    expect(body.detail).toMatch(/^Invalid sortBy attribute: password\. Allowed values: userName, /);
    expect(body.detail).toContain('lastModified');
  });

  it('sorts ascending by default and descending on request', async () => {
    const asc = await list('sortBy=userName');
    expect(asc.res.status).toBe(200);
    expect(names(asc.body)).toEqual(['janesmith', 'johndoe']);
    expect(asc.body.totalResults).toBe(2);
    expect(asc.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:ListResponse']);

    const desc = await list('sortBy=userName&sortOrder=descending');
    expect(names(desc.body)).toEqual(['johndoe', 'janesmith']);

    const explicitAsc = await list('sortBy=userName&sortOrder=ascending');
    expect(names(explicitAsc.body)).toEqual(['janesmith', 'johndoe']);
  });

  it('sorts by other whitelisted attributes', async () => {
    const byGiven = await list('sortBy=name.givenName&sortOrder=descending');
    expect(names(byGiven.body)).toEqual(['johndoe', 'janesmith']);
    const byEmail = await list('sortBy=emails.value');
    expect(names(byEmail.body)).toEqual(['janesmith', 'johndoe']);
  });

  it('paginates a sorted list after sorting and reports the unpaged total', async () => {
    const page1 = await list('sortBy=userName&count=1&startIndex=1');
    expect(names(page1.body)).toEqual(['janesmith']);
    expect(page1.body.totalResults).toBe(2);
    expect(page1.body.startIndex).toBe(1);
    expect(page1.body.itemsPerPage).toBe(1);

    const page2 = await list('sortBy=userName&count=1&startIndex=2');
    expect(names(page2.body)).toEqual(['johndoe']);
    expect(page2.body.startIndex).toBe(2);

    const beyond = await list('sortBy=userName&count=1&startIndex=3');
    expect(beyond.body.Resources).toEqual([]);
    expect(beyond.body.totalResults).toBe(2);
    expect(beyond.body.itemsPerPage).toBe(0);
  });

  it('filters with a sort and counts only the matches', async () => {
    const { res, body } = await list(
      `filter=${encodeURIComponent('userName co "john"')}&sortBy=userName`
    );
    expect(res.status).toBe(200);
    expect(names(body)).toEqual(['johndoe']);
    expect(body.totalResults).toBe(1);
  });

  it('answers an exact userName filter with the matching user only', async () => {
    const { res, body } = await list(`filter=${encodeURIComponent('userName eq "janesmith"')}`);
    expect(res.status).toBe(200);
    expect(names(body)).toEqual(['janesmith']);
    expect(body.totalResults).toBe(1);
    expect(body.Resources[0].schemas).toContain(USER_SCHEMA);
  });

  it('projects attributes on every listed user', async () => {
    const { body } = await list('sortBy=userName&attributes=userName');
    expect(body.Resources.every((u: any) => u.emails === undefined)).toBe(true);
    expect(names(body)).toEqual(['janesmith', 'johndoe']);
  });

  it('scans every page of accounts when sorting and orders across page boundaries', async () => {
    for (let index = 0; index < 205; index += 1) {
      const id = `bulk-${String(index).padStart(3, '0')}`;
      harness.users.set(id, {
        id,
        tenant_id: 'default',
        email: `${id}@example.test`,
        preferred_username: id,
        active: 1,
        lifecycle_state: 'active',
        created_at: 1_000 + index,
        updated_at: 1_000 + index,
      });
    }
    const { res, body } = await list('sortBy=userName&sortOrder=descending&count=3&startIndex=1');
    expect(res.status).toBe(200);
    expect(body.totalResults).toBe(207);
    expect(names(body)).toEqual(['johndoe', 'janesmith', 'bulk-204']);
    expect(harness.crossShardList.calls).toBe(3);

    const tail = await list('sortBy=userName&count=2&startIndex=206');
    expect(names(tail.body)).toEqual(['janesmith', 'johndoe']);
    expect(tail.body.itemsPerPage).toBe(2);
  });

  it('answers 500 when the account route binding is missing', async () => {
    delete (harness.env as { DB_PII?: unknown }).DB_PII;
    await expectError(
      await fetchScim('/scim/v2/Users?sortBy=userName'),
      500,
      'Internal server error'
    );
  });
});
