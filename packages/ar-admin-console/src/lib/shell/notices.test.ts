import { describe, expect, it, vi } from 'vitest';
import type { AdminNotice, AdminNoticesClient } from '#lib/api/admin-notices.js';
import { noticeFromRow } from '#lib/api/admin-notices.js';
import { createNoticeInbox } from './notices.svelte';

const notice = (id: string): AdminNotice =>
	noticeFromRow({ id, scope_type: 'tenant', severity: 'info', title: id, dismissible: true });

function deferred() {
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((_, fail) => (reject = fail));
	return { promise, reject };
}

describe('header inbox', () => {
	it('puts a notice back when dismissing it fails', async () => {
		const client: Partial<AdminNoticesClient> = {
			list: async () => [notice('a'), notice('b')],
			dismiss: async () => {
				throw new Error('offline');
			}
		};
		const inbox = createNoticeInbox(client as AdminNoticesClient);
		await inbox.refresh();
		await inbox.dismiss('a');
		expect(inbox.items.map((item) => item.id)).toEqual(['a', 'b']);
	});

	it('does not bring back the previous tenant’s list when a late dismissal fails', async () => {
		const pending = deferred();
		let tenant = 'a';
		let failListing = false;
		const client: Partial<AdminNoticesClient> = {
			list: async () => {
				if (failListing) throw new Error('offline');
				return tenant === 'a' ? [notice('a1'), notice('a2')] : [notice('b1')];
			},
			dismiss: () => pending.promise
		};
		const inbox = createNoticeInbox(client as AdminNoticesClient);
		await inbox.refresh();

		const dismissing = inbox.dismiss('a1');
		tenant = 'b';
		await inbox.refresh({ reset: true });
		failListing = true;
		pending.reject(new Error('offline'));
		await dismissing;

		expect(inbox.items.map((item) => item.id)).toEqual(['b1']);
	});

	it('does not bring a dismissed notice back with a list read before the dismissal', async () => {
		let answer!: (items: AdminNotice[]) => void;
		const client: Partial<AdminNoticesClient> = {
			list: (signal) =>
				new Promise<AdminNotice[]>((resolve, reject) => {
					answer = resolve;
					signal?.addEventListener('abort', () => reject(new Error('aborted')));
				}),
			dismiss: async () => undefined
		};
		const inbox = createNoticeInbox(client as AdminNoticesClient);
		const first = inbox.refresh();
		answer([notice('a'), notice('b')]);
		await first;

		const stale = inbox.refresh();
		const staleAnswer = answer;
		await inbox.dismiss('a');
		staleAnswer([notice('a'), notice('b')]);
		await stale;

		expect(inbox.items.map((item) => item.id)).toEqual(['b']);
	});

	it('keeps a notice away that a list read during its dismissal still has', async () => {
		let finish!: () => void;
		const client: Partial<AdminNoticesClient> = {
			list: async () => [notice('a'), notice('b')],
			dismiss: () => new Promise<void>((resolve) => (finish = resolve))
		};
		const inbox = createNoticeInbox(client as AdminNoticesClient);
		await inbox.refresh();

		const dismissing = inbox.dismiss('a');
		await inbox.refresh();
		expect(inbox.items.map((item) => item.id)).toEqual(['b']);
		finish();
		await dismissing;
		expect(inbox.items.map((item) => item.id)).toEqual(['b']);
	});

	it('drops a list read during the dismissal that only arrives after it', async () => {
		let finish!: () => void;
		const answers: Array<(items: AdminNotice[]) => void> = [];
		const client: Partial<AdminNoticesClient> = {
			list: (signal) =>
				new Promise<AdminNotice[]>((resolve, reject) => {
					answers.push(resolve);
					signal?.addEventListener('abort', () => reject(new Error('aborted')));
				}),
			dismiss: () => new Promise<void>((resolve) => (finish = resolve))
		};
		const inbox = createNoticeInbox(client as AdminNoticesClient);
		const first = inbox.refresh();
		answers[0]([notice('a'), notice('b')]);
		await first;

		const dismissing = inbox.dismiss('a');
		const stale = inbox.refresh();
		finish();
		// The stale read is dropped and a new one asked for; the server no longer lists `a`.
		await vi.waitFor(() => expect(answers).toHaveLength(3));
		answers[1]([notice('a'), notice('b')]);
		answers[2]([notice('b')]);
		await Promise.all([dismissing, stale]);
		expect(inbox.items.map((item) => item.id)).toEqual(['b']);
	});

	it('reads the new tenant again when an earlier dismissal ends during its first read', async () => {
		let finish!: () => void;
		let tenant = 'a';
		const client: Partial<AdminNoticesClient> = {
			list: async () => (tenant === 'a' ? [notice('a1')] : [notice('b1')]),
			dismiss: () => new Promise<void>((resolve) => (finish = resolve))
		};
		const inbox = createNoticeInbox(client as AdminNoticesClient);
		await inbox.refresh();

		const dismissing = inbox.dismiss('a1');
		tenant = 'b';
		const switching = inbox.refresh({ reset: true });
		finish();
		await dismissing;
		await switching;
		expect(inbox.items.map((item) => item.id)).toEqual(['b1']);
	});
});
