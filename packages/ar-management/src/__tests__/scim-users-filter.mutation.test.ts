/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- SCIM JSON bodies and the shared SCIM test harness fakes are untyped in these route tests */
import { describe, expect, it } from 'vitest';
import { describeScimTestHarness } from './scim-test-harness';

describeScimTestHarness('SCIM Users filter semantics (mutation coverage)', (harness) => {
  const fetchScim = (path: string) => harness.app.fetch(harness.createRequest(path), harness.env);

  async function filtered(filter: string) {
    const res = await fetchScim(`/scim/v2/Users?filter=${encodeURIComponent(filter)}`);
    const body = await res.json<Record<string, any>>();
    return { res, body };
  }
  const userNames = (body: Record<string, any>) =>
    (body.Resources as Array<{ userName: string }>).map((u) => u.userName).sort();

  function addUser(id: string, over: Record<string, unknown> = {}) {
    harness.users.set(id, {
      id,
      tenant_id: 'default',
      email: `${id}@example.test`,
      email_verified: 1,
      name: id,
      given_name: id,
      family_name: id,
      preferred_username: id,
      active: 1,
      lifecycle_state: 'active',
      external_id: null,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
      ...over,
    });
  }

  describe('unsupported filters are refused as invalidFilter', () => {
    it.each([
      'userName pr',
      'userName ne "johndoe"',
      'userName gt "a"',
      'unknownAttr eq "x"',
      'userName eq 5',
      'userName eq true',
      'active co true',
      'active eq "true"',
      'active sw false',
      'userName eq "a" and active eq true',
    ])('%s', async (filter) => {
      const { res, body } = await filtered(filter);
      expect(res.status).toBe(400);
      expect(body.scimType).toBe('invalidFilter');
      expect(body.detail).toBe('Invalid filter syntax');
    });
  });

  describe('operators are case-insensitive substring/prefix/suffix/equality tests', () => {
    it('co matches anywhere in the value', async () => {
      const { res, body } = await filtered('userName co "OHN"');
      expect(res.status).toBe(200);
      expect(userNames(body)).toEqual(['johndoe']);
      expect(body.totalResults).toBe(1);
    });

    it('sw matches only the beginning', async () => {
      expect(userNames((await filtered('userName sw "JANE"')).body)).toEqual(['janesmith']);
      expect((await filtered('userName sw "smith"')).body.totalResults).toBe(0);
    });

    it('ew matches only the end', async () => {
      expect(userNames((await filtered('userName ew "DOE"')).body)).toEqual(['johndoe']);
      expect((await filtered('userName ew "john"')).body.totalResults).toBe(0);
    });

    it('eq on a non-indexed attribute compares the whole value', async () => {
      expect(userNames((await filtered('name.givenName eq "JOHN"')).body)).toEqual(['johndoe']);
      expect((await filtered('name.givenName eq "joh"')).body.totalResults).toBe(0);
    });
  });

  describe('attributes', () => {
    it('filters on given and family name and display name', async () => {
      expect(userNames((await filtered('name.givenName sw "Ja"')).body)).toEqual(['janesmith']);
      expect(userNames((await filtered('given_name sw "Ja"')).body)).toEqual(['janesmith']);
      expect(userNames((await filtered('name.familyName ew "ith"')).body)).toEqual(['janesmith']);
      expect(userNames((await filtered('family_name ew "oe"')).body)).toEqual(['johndoe']);
      expect(userNames((await filtered('displayName co "doe"')).body)).toEqual(['johndoe']);
      expect(userNames((await filtered('name co "smith"')).body)).toEqual(['janesmith']);
    });

    it('filters on email, both exact and partial', async () => {
      expect(userNames((await filtered('emails.value eq "JOHN.DOE@example.com"')).body)).toEqual([
        'johndoe',
      ]);
      expect(userNames((await filtered('email eq "jane.smith@example.com"')).body)).toEqual([
        'janesmith',
      ]);
      expect(userNames((await filtered('emails.value co "smith@"')).body)).toEqual(['janesmith']);
      expect((await filtered('emails.value eq "nobody@example.com"')).body.totalResults).toBe(0);
    });

    it('filters on externalId and external_id', async () => {
      expect(userNames((await filtered('externalId eq "ext-001"')).body)).toEqual(['johndoe']);
      expect(userNames((await filtered('external_id sw "ext-002"')).body)).toEqual(['janesmith']);
    });

    it('filters on id', async () => {
      expect(userNames((await filtered('id eq "user-002"')).body)).toEqual(['janesmith']);
      expect((await filtered('id eq "user-999"')).body.totalResults).toBe(0);
    });

    it('filters on preferred_username', async () => {
      expect(userNames((await filtered('preferred_username eq "JohnDoe"')).body)).toEqual([
        'johndoe',
      ]);
    });

    it('falls back to the email when a user has no preferred username', async () => {
      addUser('user-003', { preferred_username: null, email: 'fallback@example.test' });
      const { body } = await filtered('userName sw "fallback"');
      expect(body.totalResults).toBe(1);
      expect(body.Resources[0].id).toBe('user-003');
    });

    it('treats a missing value as the empty string', async () => {
      addUser('user-004', { family_name: null });
      expect((await filtered('family_name eq ""')).body.totalResults).toBe(1);
      expect((await filtered('family_name co "x"')).body.totalResults).toBe(0);
    });
  });

  describe('active', () => {
    it('lists active and inactive users by the boolean filter', async () => {
      addUser('user-off', { active: 0, lifecycle_state: 'deprovisioned' });
      const on = await filtered('active eq true');
      expect(on.res.status).toBe(200);
      expect(userNames(on.body)).toEqual(['janesmith', 'johndoe']);
      const off = await filtered('active eq false');
      expect(userNames(off.body)).toEqual(['user-off']);
      expect(off.body.Resources[0].active).toBe(false);
      expect(off.body.totalResults).toBe(1);
    });
  });

  describe('paging a filtered result', () => {
    it('slices the matches after filtering', async () => {
      addUser('user-005', { preferred_username: 'johnny' });
      const res = await fetchScim(
        `/scim/v2/Users?filter=${encodeURIComponent('userName sw "john"')}&sortBy=userName&count=1&startIndex=2`
      );
      const body = await res.json<Record<string, any>>();
      expect(body.totalResults).toBe(2);
      expect(body.startIndex).toBe(2);
      expect(body.itemsPerPage).toBe(1);
      expect(userNames(body)).toEqual(['johnny']);
    });
  });
});
