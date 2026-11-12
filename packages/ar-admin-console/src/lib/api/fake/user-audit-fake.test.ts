import { describe, expect, it } from 'vitest';
import { UserAuditIncompleteError, userAuditParams } from '../user-audit';
import {
	SAMPLE_USER_IDS,
	USER_AUDIT_NOW,
	answerUserAuditList,
	createFakeUserAudit,
	sampleUserAuditEntries
} from './user-audit-fake';

const to = new Date(USER_AUDIT_NOW);
const day = (n: number) => new Date(USER_AUDIT_NOW - n * 86_400_000);

describe('fake user audit log', () => {
	it('spreads successes and failures over the last seven days, newest first', () => {
		const entries = sampleUserAuditEntries();
		expect(entries.some((e) => e.result === 'failure')).toBe(true);
		expect(entries.some((e) => e.result === 'success')).toBe(true);
		const oldest = Math.min(...entries.map((e) => Date.parse(e.createdAt)));
		expect(USER_AUDIT_NOW - oldest).toBeLessThan(7 * 86_400_000);
		expect(USER_AUDIT_NOW - oldest).toBeGreaterThan(6 * 86_400_000);
	});

	it('honours the user, event and period filters', async () => {
		const client = createFakeUserAudit({ pageSize: 100 });
		const user = SAMPLE_USER_IDS[0];
		const mine = await client.list({ from: day(7), to, userId: user });
		expect(mine.entries.length).toBeGreaterThan(0);
		expect(mine.entries.every((e) => e.userId === user)).toBe(true);

		const failures = await client.list({ from: day(7), to, action: 'auth.password.failed' });
		expect(failures.entries.every((e) => e.action === 'auth.password.failed')).toBe(true);

		const lastDay = await client.list({ from: day(1), to });
		const week = await client.list({ from: day(7), to });
		expect(lastDay.entries.length).toBeLessThan(week.entries.length);
		expect(lastDay.entries.every((e) => Date.parse(e.createdAt) >= day(1).getTime())).toBe(true);
	});

	it('pages by cursor without repeating or dropping an event', async () => {
		const client = createFakeUserAudit({ pageSize: 20 });
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await client.list({ from: day(7), to, cursor });
			seen.push(...page.entries.map((e) => e.id));
			cursor = page.next ?? undefined;
		} while (cursor);
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.length).toBe(sampleUserAuditEntries().length);
	});

	it('refuses a page number and a cursor from another query', () => {
		const all = sampleUserAuditEntries();
		const params = userAuditParams({ from: day(7), to });
		params.set('page', '2');
		expect(answerUserAuditList(params, all).status).toBe(400);
		const first = answerUserAuditList(userAuditParams({ from: day(7), to }), all, { pageSize: 5 });
		const cursor = (first.body.pagination as { next_cursor: string }).next_cursor;
		const other = userAuditParams({ from: day(7), to, cursor, userId: SAMPLE_USER_IDS[1] });
		expect(answerUserAuditList(other, all).status).toBe(400);
	});

	it('plays the failure modes', async () => {
		const range = { from: day(1), to };
		await expect(createFakeUserAudit({ fail: 'incomplete' }).list(range)).rejects.toBeInstanceOf(
			UserAuditIncompleteError
		);
		await expect(createFakeUserAudit({ fail: 403 }).list(range)).rejects.toMatchObject({
			status: 403
		});
		expect((await createFakeUserAudit({ empty: true }).list(range)).entries).toEqual([]);
		expect((await createFakeUserAudit({ mayLag: true }).list(range)).mayLag).toBe(true);
		const hot = await createFakeUserAudit({ hotOnly: true }).list({ from: day(7), to });
		expect(hot.hotOnly).toBe(true);
		expect(hot.entries.every((e) => Date.parse(e.createdAt) >= day(2).getTime())).toBe(true);
	});
});
