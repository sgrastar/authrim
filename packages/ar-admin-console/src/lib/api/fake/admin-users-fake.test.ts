import { describe, expect, it } from 'vitest';
import {
	CursorStaleError,
	LegalHoldError,
	LifecycleConflictError,
	type AdminUsersPosition
} from '../admin-users';
import { StepUpCancelledError } from '../admin-step-up';
import { createFakeAdminUsers, sampleUsers } from './admin-users-fake';

describe('the fake users API', () => {
	it('has about a hundred fictional users in mixed states', () => {
		const users = sampleUsers();
		expect(users.length).toBe(100);
		expect(new Set(users.map((u) => u.id)).size).toBe(100);
		expect(users.every((u) => !u.email || /@example\.(com|invalid)$/.test(u.email))).toBe(true);
		const states = new Set(users.map((u) => u.lifecycle_state));
		expect(states).toEqual(new Set(['active', 'suspended', 'locked', 'deprovisioned']));
		expect(users.some((u) => u.pii_status === 'deleted')).toBe(true);
		expect(users.some((u) => u.last_login_at === null)).toBe(true);
	});

	it('pages by cursor, newest first, with no total', async () => {
		const client = createFakeAdminUsers();
		const first = await client.list({ limit: 40 });
		expect(first.users).toHaveLength(40);
		expect(first.total).toBeUndefined();
		expect(first.next).toHaveProperty('cursor');
		const seen = new Set(first.users.map((u) => u.id));
		let at: AdminUsersPosition | null = first.next;
		while (at) {
			const page = await client.list({ limit: 40, at });
			page.users.forEach((u) => seen.add(u.id));
			at = page.next;
		}
		expect(seen.size).toBe(100);
		const times = first.users.map((u) => u.created_at ?? 0);
		expect(times).toEqual([...times].sort((a, b) => b - a));
	});

	it('searches an exact email or id only', async () => {
		const client = createFakeAdminUsers();
		const [one] = (await client.list({ limit: 1 })).users;
		expect((await client.list({ search: one.email!.toUpperCase() })).users).toHaveLength(1);
		expect((await client.list({ search: one.id })).users).toHaveLength(1);
		expect((await client.list({ search: one.email!.slice(0, 5) })).users).toHaveLength(0);
		expect((await client.list({ search: 'nobody@example.com' })).next).toBeNull();
	});

	it('pages by number with a total, and searches by substring, in the page shape', async () => {
		const client = createFakeAdminUsers({ shape: 'page' });
		const first = await client.list({ limit: 30 });
		expect(first.total).toBe(100);
		expect(first.next).toEqual({ page: 2 });
		expect((await client.list({ limit: 30, at: { page: 4 } })).next).toBeNull();
		expect((await client.list({ search: 'example.invalid' })).users.length).toBeGreaterThan(0);
	});

	it('refuses a bad cursor, and a stale one once', async () => {
		const client = createFakeAdminUsers({ staleOnce: true });
		await expect(client.list({ at: { cursor: '###' } })).rejects.toMatchObject({
			status: 400,
			code: 'invalid_cursor'
		});
		const first = await client.list({ limit: 10 });
		await expect(client.list({ limit: 10, at: first.next! })).rejects.toBeInstanceOf(
			CursorStaleError
		);
		expect((await client.list({ limit: 10, at: first.next! })).users).toHaveLength(10);
	});

	it('fails, is empty or hangs on request', async () => {
		await expect(createFakeAdminUsers({ fail: 403 }).list({})).rejects.toMatchObject({
			status: 403
		});
		await expect(createFakeAdminUsers({ fail: 500 }).list({})).rejects.toMatchObject({
			status: 500
		});
		expect((await createFakeAdminUsers({ empty: true }).list({})).users).toEqual([]);
	});

	it('creates a user at the top, and refuses a taken or malformed address', async () => {
		const client = createFakeAdminUsers();
		const result = await client.create({ email: 'new.person@example.com', name: ' New Person ' });
		expect(result.status === 'created' && result.user.name).toBe('New Person');
		expect((await client.list({ limit: 1 })).users[0].email).toBe('new.person@example.com');
		await expect(client.create({ email: 'NEW.PERSON@example.com' })).rejects.toMatchObject({
			status: 409
		});
		await expect(client.create({ email: 'nope' })).rejects.toMatchObject({ status: 400 });
		await expect(client.create({ email: '' })).rejects.toMatchObject({ status: 400 });
	});
});

describe('one user in the fake', () => {
	it('reads the profile, sign-in methods, sessions and activity of a person who signed in', async () => {
		const client = createFakeAdminUsers();
		const detail = await client.get('usr_1006');
		expect(detail.user.id).toBe('usr_1006');
		expect(detail.passkeys.length).toBeGreaterThan(0);
		expect(detail.totp.length).toBeGreaterThan(0);
		expect(detail.restricted).toBe(false);
		expect((await client.sessions('usr_1006')).sessions.length).toBeGreaterThan(0);
		const activity = await client.activity('usr_1006');
		expect(activity.entries).toHaveLength(10);
		expect(activity.more).toBe(true);
	});

	it('gives nothing to a person who never signed in or whose data was deleted', async () => {
		const client = createFakeAdminUsers();
		for (const id of ['usr_1004', 'usr_1012']) {
			const detail = await client.get(id);
			expect([detail.passkeys, detail.totp]).toEqual([[], []]);
			expect((await client.sessions(id)).sessions).toEqual([]);
			expect((await client.activity(id)).entries).toEqual([]);
		}
	});

	it('refuses a user that does not exist', async () => {
		const client = createFakeAdminUsers();
		await expect(client.get('nope')).rejects.toMatchObject({ status: 404 });
		await expect(client.update('nope', { name: 'x' })).rejects.toMatchObject({ status: 404 });
	});

	it('reads suspended and locked users as restricted when asked', async () => {
		const client = createFakeAdminUsers({ restricted: true });
		const locked = await client.get('usr_1008');
		expect(locked.restricted).toBe(true);
		expect(locked.passkeys).toEqual([]);
		expect((await client.get('usr_1006')).restricted).toBe(false);
	});

	it('refuses to change a restricted user, as the API cannot resolve the account', async () => {
		const users = createFakeAdminUsers({ restricted: true });
		const suspended = sampleUsers().find((user) => user.lifecycle_state === 'suspended')!;
		await expect(users.update(suspended.id, { name: 'X' })).rejects.toMatchObject({ status: 404 });
	});

	it('answers 400 "already active" when someone reactivated the account meanwhile', async () => {
		const users = createFakeAdminUsers({ activatedMeanwhile: true });
		const suspended = sampleUsers().find((user) => user.lifecycle_state === 'suspended')!;
		await expect(users.activate(suspended.id, { reason: 'other' })).rejects.toMatchObject({
			status: 400,
			code: 'invalid_request'
		});
		expect((await users.get(suspended.id)).user.lifecycle_state).toBe('active');
	});

	it('updates the profile, clears an emptied field and records it', async () => {
		const client = createFakeAdminUsers({ now: 5 });
		const updated = await client.update('usr_1006', { name: ' New Name ', phone_number: '' });
		expect(updated).toMatchObject({ name: 'New Name', phone_number: null, updated_at: 5 });
		expect((await client.get('usr_1006')).user.name).toBe('New Name');
		expect((await client.activity('usr_1006')).entries[0].action).toBe('user.updated');
		await expect(client.update('usr_1006', {})).rejects.toMatchObject({ status: 400 });
	});

	it('walks suspend, reactivate and lock, ending sessions on the way', async () => {
		const client = createFakeAdminUsers({ now: 1_000 });
		await client.suspend('usr_1006', { reason: 'other', durationHours: 2 });
		const suspended = (await client.get('usr_1006')).user;
		expect(suspended).toMatchObject({
			lifecycle_state: 'suspended',
			suspended_until: 1_000 + 2 * 3_600_000
		});
		expect((await client.sessions('usr_1006')).sessions).toEqual([]);
		await client.activate('usr_1006', { reason: 'other' });
		expect((await client.get('usr_1006')).user).toMatchObject({
			lifecycle_state: 'active',
			suspended_until: null
		});
		await client.lock('usr_1006', { reason: 'brute_force', unlockAt: 9_000 });
		expect((await client.get('usr_1006')).user).toMatchObject({
			lifecycle_state: 'locked',
			locked_until: 9_000
		});
		await expect(client.activate('usr_1000', { reason: 'other' })).rejects.toMatchObject({
			status: 400
		});
	});

	it('answers a state that changed meanwhile', async () => {
		const client = createFakeAdminUsers({ lifecycleConflict: true });
		await expect(client.suspend('usr_1006', { reason: 'other' })).rejects.toBeInstanceOf(
			LifecycleConflictError
		);
		await expect(client.activate('usr_1003', { reason: 'other' })).rejects.toBeInstanceOf(
			LifecycleConflictError
		);
	});

	it('deletes a user, unless a legal hold stands', async () => {
		const client = createFakeAdminUsers();
		await client.remove('usr_1006');
		await expect(client.get('usr_1006')).rejects.toMatchObject({ status: 404 });
		const held = createFakeAdminUsers({ legalHold: true });
		const failure = await held.remove('usr_1006').catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(LegalHoldError);
		await expect(held.get('usr_1006')).resolves.toBeTruthy();
	});

	it('signs out everywhere, or stops at the step-up', async () => {
		const client = createFakeAdminUsers();
		const count = (await client.sessions('usr_1006')).sessions.length;
		await expect(client.revokeSessions('usr_1006')).resolves.toBe(count);
		expect((await client.sessions('usr_1006')).sessions).toEqual([]);
		await expect(
			createFakeAdminUsers({ stepUp: 'declined' }).revokeSessions('usr_1006')
		).rejects.toBeInstanceOf(StepUpCancelledError);
		await expect(
			createFakeAdminUsers({ stepUp: 'refused' }).revokeSessions('usr_1006')
		).rejects.toMatchObject({ status: 403, code: 'step_up_required' });
	});

	it('fails one section without touching the others', async () => {
		const client = createFakeAdminUsers({ failSessions: true, failActivity: true });
		await expect(client.sessions('usr_1006')).rejects.toMatchObject({ status: 500 });
		await expect(client.activity('usr_1006')).rejects.toMatchObject({ status: 500 });
		await expect(client.get('usr_1006')).resolves.toBeTruthy();
		await expect(createFakeAdminUsers({ failDetail: 500 }).get('usr_1006')).rejects.toMatchObject({
			status: 500
		});
	});
});
