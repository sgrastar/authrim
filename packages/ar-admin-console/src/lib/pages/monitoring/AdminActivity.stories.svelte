<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import {
		AUDIT_NOW,
		createFakeAdminAudit,
		sampleAuditEntries
	} from '#lib/api/fake/admin-audit-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import AdminActivity from './AdminActivity.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Monitoring/Admin activity',
		component: AdminActivity,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Monitoring → Admin activity: the admin audit log of the selected tenant (`/api/admin/admin-audit-log`), newest first, narrowed by period, operation, result and admin ID, with one entry in full above the list. Step-ups carry a **Step-up** badge and say which operation was checked at which level. What changed (before / after) is loaded only when asked for, by an admin with `admin:admin_audit:detail:read` (the read is itself recorded). Admins without `admin:admin_audit:read` see only that they cannot see it, and the navigation leaves the item out for them. The stories use an in-memory API with the same filters and paging.'
				}
			}
		}
	});

	const now = () => new Date(AUDIT_NOW);
	/** A clock that moves on with every reading, as the real one does between two pages. */
	function ticking() {
		let tick = 0;
		return () => new Date(AUDIT_NOW + tick++ * 1000);
	}
	/** Reads the log but not what changed (a support-style auditor). */
	const reader: AdminAccess = {
		platform: false,
		roles: ['custom_auditor'],
		permissions: ['admin:admin_audit:read']
	};
</script>

<Story name="Activity">
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ delay: 200 })} {now} />
	{/snippet}
</Story>

<Story
	name="Step-up entry in full"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const rows = await canvas.findAllByRole('button', {
			name: t('aud.row.open', { name: 'Bob Suzuki' })
		});
		// Bob's step-up for the role grant (the older of his two entries is the step-up).
		await userEvent.click(rows[1]);
		await canvas.findByText(t('aud.detail.title'));
		await canvas.findByText(t('aud.level.L2'));
		await userEvent.click(canvas.getByRole('button', { name: t('aud.detail.loadChanges') }));
		await canvas.findByText(t('aud.detail.changesNone'));
	}}
>
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ delay: 0 })} {now} />
	{/snippet}
</Story>

<Story
	name="What changed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [first] = await canvas.findAllByRole('button', {
			name: t('aud.row.open', { name: 'Alice Tanaka' })
		});
		await userEvent.click(first);
		await userEvent.click(await canvas.findByRole('button', { name: t('aud.detail.loadChanges') }));
		await canvas.findByText(t('aud.detail.before'));
		await canvas.findByText(t('aud.detail.after'));
	}}
>
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ delay: 0 })} {now} />
	{/snippet}
</Story>

<Story
	name="Without access to what changed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [first] = await canvas.findAllByRole('button', {
			name: t('aud.row.open', { name: 'Alice Tanaka' })
		});
		await userEvent.click(first);
		await canvas.findByText(t('aud.detail.title'));
		expect(canvas.queryByRole('button', { name: t('aud.detail.loadChanges') })).toBeNull();
	}}
>
	{#snippet template()}
		<AdminActivity
			client={createFakeAdminAudit({ delay: 0, detail: false })}
			access={reader}
			{now}
		/>
	{/snippet}
</Story>

<Story
	name="Failures only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByRole('button', { name: t('aud.row.open', { name: 'Alice Tanaka' }) });
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('aud.filter.result') }),
			'failure'
		);
		await waitFor(() =>
			expect(
				canvas.queryAllByRole('button', { name: t('aud.row.open', { name: 'Alice Tanaka' }) })
			).toHaveLength(0)
		);
		await canvas.findByRole('button', { name: t('aud.row.open', { name: 'Bob Suzuki' }) });
	}}
>
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ delay: 0 })} {now} />
	{/snippet}
</Story>

<Story
	name="More than one page (archive)"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const more = await canvas.findByRole('button', { name: t('aud.more') });
		await userEvent.click(more);
		await waitFor(() => expect(canvas.queryByRole('button', { name: t('aud.more') })).toBeNull());
		// The next page asked with the same period: no error, every entry listed.
		expect(canvas.queryByText(t('aud.moreFailed'))).toBeNull();
		expect(canvas.getAllByRole('button', { name: /^Open the entry|の記録を開く$/ }).length).toBe(8);
	}}
>
	{#snippet template()}
		<AdminActivity
			client={createFakeAdminAudit({ delay: 0, cursor: true, pageSize: 5, mayLag: true })}
			now={ticking()}
		/>
	{/snippet}
</Story>

<Story
	name="Period the wrong way round"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('button', { name: t('aud.more') });
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('range.preset') }),
			'custom'
		);
		const from = canvasElement.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]');
		await fireEvent.change(from[0], { target: { value: '2026-11-07T12:00' } });
		await fireEvent.change(from[1], { target: { value: '2026-11-01T12:00' } });
		await canvas.findByText(t('range.order'));
		// Nothing listed for it, and no next page of the previous list to ask for.
		await canvas.findByText(t('aud.empty'));
		expect(canvas.queryByRole('button', { name: t('aud.more') })).toBeNull();
	}}
>
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ delay: 0, cursor: true, pageSize: 5 })} {now} />
	{/snippet}
</Story>

<Story
	name="Nothing in the period"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('aud.empty'));
	}}
>
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ entries: [] })} {now} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('aud.noAccess'));
	}}
>
	{#snippet template()}
		<AdminActivity
			client={createFakeAdminAudit({ fail: 403 })}
			access={persona('support').access}
			{now}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ hang: true })} {now} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('aud.loadFailed'));
	}}
>
	{#snippet template()}
		<AdminActivity client={createFakeAdminAudit({ fail: 500 })} {now} />
	{/snippet}
</Story>

<Story
	name="Period too long to read"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('aud.incomplete.title'));
	}}
>
	{#snippet template()}
		<AdminActivity
			client={createFakeAdminAudit({ fail: 'incomplete' })}
			{now}
			initialRange={{ preset: '30d' }}
		/>
	{/snippet}
</Story>

<Story name="Many entries">
	{#snippet template()}
		{@const many = Array.from({ length: 60 }, (_, i) => ({
			...sampleAuditEntries()[i % 8],
			id: `aud_m${i}`,
			created_at: AUDIT_NOW - i * 600_000
		}))}
		<AdminActivity client={createFakeAdminAudit({ entries: many })} {now} />
	{/snippet}
</Story>
