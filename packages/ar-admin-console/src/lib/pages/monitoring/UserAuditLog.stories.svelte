<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '#lib/access/access.js';
	import { ApiError } from '#lib/api/api-error.js';
	import {
		SAMPLE_USER_IDS,
		USER_AUDIT_NOW,
		createFakeUserAudit
	} from '#lib/api/fake/user-audit-fake.js';
	import type { UserAuditClient } from '#lib/api/user-audit.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import UserAuditLog from './UserAuditLog.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Monitoring/Audit logs',
		component: UserAuditLog,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Monitoring → Audit logs: the end-user event log of the selected tenant (`/api/admin/audit-logs`: sign-ins, sessions, tokens, consents, account changes), newest first, narrowed by period, event and user ID, with one event in full above the list. The API reads the whole period before it filters, so the period is always bounded (the last 24 hours at first) and a period that is too large says so ("Too much data") instead of showing a partial list. Pages are cursors, with no total. Admins without `admin:audit:read` see only that they cannot see it, and the navigation leaves the item out for them. A user\'s page can open this one with the user already chosen (`initialUserId`). The stories use an in-memory API that answers the real wire format.'
				}
			}
		}
	});

	const now = () => new Date(USER_AUDIT_NOW);
	/** A clock that moves on with every reading, as the real one does between two pages. */
	function ticking() {
		let tick = 0;
		return () => new Date(USER_AUDIT_NOW + tick++ * 1000);
	}
	/** Fails the first read, then works (to show Try again). */
	function flaky(): UserAuditClient {
		const ok = createFakeUserAudit({ delay: 0 });
		let calls = 0;
		return {
			async list(query, signal) {
				if (calls++ === 0) throw new ApiError(500, 'server_error', 'Could not list');
				return ok.list(query, signal);
			}
		};
	}
	/** Can read the audit logs and nothing else. */
	const noAccess: AdminAccess = {
		platform: false,
		roles: ['custom_none'],
		permissions: ['admin:users:read']
	};
	const OPEN_ROW = /^Open the event|のイベントを開く$|^Ereignis .* öffnen$/;
	const rowsIn = (canvas: ReturnType<typeof within>) =>
		canvas.queryAllByRole('button', { name: OPEN_ROW });
</script>

<Story name="Audit logs">
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ delay: 200 })} {now} onopenuser={fn()} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ hang: true })} {now} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('uaud.loadFailed'));
	}}
>
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ fail: 500 })} {now} />
	{/snippet}
</Story>

<Story
	name="Try again"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('load.retry') }));
		await waitFor(() => expect(rowsIn(canvas).length).toBeGreaterThan(0));
		expect(canvas.queryByText(t('uaud.loadFailed'))).toBeNull();
	}}
>
	{#snippet template()}
		<UserAuditLog client={flaky()} {now} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('uaud.noAccess'));
	}}
>
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ fail: 403 })} access={noAccess} {now} />
	{/snippet}
</Story>

<Story
	name="Empty period"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('uaud.empty'));
	}}
>
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ empty: true })} {now} />
	{/snippet}
</Story>

<Story
	name="Too much data"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('uaud.incomplete.title'));
		// The period can still be changed.
		expect(canvas.getByRole('combobox', { name: t('range.preset') })).toBeEnabled();
	}}
>
	{#snippet template()}
		<UserAuditLog
			client={createFakeUserAudit({ fail: 'incomplete' })}
			{now}
			initialRange={{ preset: '30d' }}
		/>
	{/snippet}
</Story>

<Story
	name="May lag"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('uaud.lag.title'));
	}}
>
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ delay: 0, mayLag: true })} {now} />
	{/snippet}
</Story>

<Story
	name="Older records missing"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('uaud.hot.title'));
	}}
>
	{#snippet template()}
		<UserAuditLog
			client={createFakeUserAudit({ delay: 0, hotOnly: true })}
			{now}
			initialRange={{ preset: '7d' }}
		/>
	{/snippet}
</Story>

<Story
	name="Filter by event"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('auth.login.succeeded');
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('uaud.filter.event') }),
			'auth.password.failed'
		);
		await waitFor(() => expect(canvas.queryByText('auth.login.succeeded')).toBeNull());
		await canvas.findAllByText('auth.password.failed');
	}}
>
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ delay: 0 })} {now} />
	{/snippet}
</Story>

<Story
	name="Filter by user"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(SAMPLE_USER_IDS[0]);
		await userEvent.type(
			canvas.getByRole('searchbox', { name: t('uaud.filter.user') }),
			`${SAMPLE_USER_IDS[1]}{enter}`
		);
		await waitFor(() => expect(canvas.queryByText(SAMPLE_USER_IDS[0])).toBeNull());
		await canvas.findAllByText(SAMPLE_USER_IDS[1]);
	}}
>
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ delay: 0 })} {now} onopenuser={fn()} />
	{/snippet}
</Story>

<Story
	name="Opened from a user"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(SAMPLE_USER_IDS[2]);
		expect(canvas.queryByText(SAMPLE_USER_IDS[0])).toBeNull();
	}}
>
	{#snippet template()}
		<UserAuditLog
			client={createFakeUserAudit({ delay: 0 })}
			{now}
			initialRange={{ preset: '7d' }}
			initialUserId={SAMPLE_USER_IDS[2]}
			onopenuser={fn()}
		/>
	{/snippet}
</Story>

<Story
	name="Open an entry"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [first] = await canvas.findAllByRole('button', { name: OPEN_ROW });
		await userEvent.click(first);
		await canvas.findByText(t('uaud.detail.title'));
		await canvas.findByText(t('uaud.detail.request'));
		await userEvent.click(canvas.getByRole('button', { name: t('uaud.detail.close') }));
		await waitFor(() => expect(canvas.queryByText(t('uaud.detail.title'))).toBeNull());
	}}
>
	{#snippet template()}
		<UserAuditLog
			client={createFakeUserAudit({ delay: 0 })}
			{now}
			initialRange={{ preset: '7d' }}
			onopenuser={fn()}
		/>
	{/snippet}
</Story>

<Story
	name="Load more"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const more = await canvas.findByRole('button', { name: t('uaud.more') });
		const before = rowsIn(canvas).length;
		await userEvent.click(more);
		await waitFor(() => expect(rowsIn(canvas).length).toBeGreaterThan(before));
		// The next page asked with the same period: no error, no repeated entry.
		expect(canvas.queryByText(t('uaud.moreFailed'))).toBeNull();
	}}
>
	{#snippet template()}
		<UserAuditLog client={createFakeUserAudit({ delay: 0, pageSize: 8 })} now={ticking()} />
	{/snippet}
</Story>

<Story
	name="Load more failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('uaud.more') }));
		await canvas.findByText(t('uaud.moreFailed'));
	}}
>
	{#snippet template()}
		<UserAuditLog
			client={createFakeUserAudit({ delay: 0, pageSize: 8, fail: 500, failMore: true })}
			{now}
		/>
	{/snippet}
</Story>
