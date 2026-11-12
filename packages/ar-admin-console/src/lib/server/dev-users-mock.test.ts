import { describe, expect, it } from 'vitest';
import { createFakeAdminUsers } from '#lib/api/fake/admin-users-fake.js';
import { userActivityFrom, userDetailFrom, userSessionsFrom } from '#lib/api/admin-users.js';
import { answerSessionsMock, answerUserMock } from './dev-users-mock.js';

const setup = () => createFakeAdminUsers({ restricted: true, legalHold: false });
const ask = (
	users: ReturnType<typeof setup>,
	path: string[],
	method: string,
	body: Record<string, unknown> = {}
) => answerUserMock(users, path, method, body);

describe('the dev mock for one user', () => {
	it('answers in the wire shapes the client reads', async () => {
		const users = setup();
		const detail = await ask(users, ['usr_1006'], 'GET');
		expect(userDetailFrom(detail!.body as Record<string, unknown>).passkeys.length).toBeGreaterThan(
			0
		);
		const sessions = await answerSessionsMock(users, new URLSearchParams({ user_id: 'usr_1006' }));
		expect(
			userSessionsFrom(sessions.body as Record<string, unknown>).sessions.length
		).toBeGreaterThan(0);
		const activity = await ask(users, ['usr_1006', 'activity-log'], 'GET');
		expect(userActivityFrom(activity!.body as Record<string, unknown>).entries).toHaveLength(10);
	});

	it('keeps to the period it is asked for', async () => {
		const users = setup();
		const all = userActivityFrom(
			(await ask(users, ['usr_1006', 'activity-log'], 'GET'))!.body as Record<string, unknown>
		).entries;
		const cut = new Date(all[0]!.at! - 1).toISOString();
		const answer = await answerUserMock(
			users,
			['usr_1006', 'activity-log'],
			'GET',
			{},
			new URLSearchParams({ from: cut })
		);
		const kept = userActivityFrom(answer!.body as Record<string, unknown>).entries;
		expect(kept.length).toBeLessThan(all.length);
		expect(kept.every((entry) => entry.at! >= Date.parse(cut))).toBe(true);
	});

	it('walks edit, suspend, reactivate and delete', async () => {
		const users = setup();
		await ask(users, ['usr_1006'], 'PUT', { name: 'Changed' });
		await ask(users, ['usr_1006', 'suspend'], 'POST', { reason_code: 'other', duration_hours: 5 });
		const suspended = await ask(users, ['usr_1006'], 'GET');
		expect(suspended!.body).toMatchObject({ restricted: true, user: { name: 'Changed' } });
		await ask(users, ['usr_1006', 'activate'], 'POST', { reason_code: 'other' });
		expect((await ask(users, ['usr_1006'], 'GET'))!.body).not.toHaveProperty('restricted');
		expect((await ask(users, ['usr_1006'], 'DELETE'))!.status).toBe(200);
		expect((await ask(users, ['usr_1006'], 'GET'))!.status).toBe(404);
	});

	it('refuses a reason the API does not know, as the API does', async () => {
		const answer = await ask(setup(), ['usr_1006', 'lock'], 'POST', { reason_code: 'nope' });
		expect(answer!.status).toBe(400);
	});

	it('names a legal hold with its hold id', async () => {
		const users = createFakeAdminUsers({ legalHold: true });
		const answer = await ask(users, ['usr_1006'], 'DELETE');
		expect(answer).toMatchObject({
			status: 409,
			body: { error: 'legal_hold_active', hold_id: 'hold_1' }
		});
	});
});
