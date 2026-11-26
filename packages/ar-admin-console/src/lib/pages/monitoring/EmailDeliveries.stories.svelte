<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import type { AdminAccess } from '#lib/access/access.js';
	import { createFakeEmailDeliveries } from '#lib/api/fake/email-deliveries-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import EmailDeliveries from './EmailDeliveries.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Monitoring/Email deliveries',
		component: EmailDeliveries,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Monitoring → Email deliveries: the mails Authrim asked its provider to send for the selected tenant (`/api/admin/email-deliveries`), newest first, narrowed by status, with one record in full above the list. "Delivered" is the provider reporting arrival; "Accepted" is the provider taking the request; a final status may never come. The API has no period and no cursor: the newest 50 or 100 records. Recipients are masked, in full or omitted as the server decides from the caller\'s permissions (a full read is audited there); the page says which. Bodies and codes are never shown. Admins without `admin:email_deliveries:read` see that they cannot, and the navigation leaves the item out for them. The stories use an in-memory API that answers the real wire format.'
				}
			}
		}
	});

	/** Reads deliveries and users (the user behind a record can be opened). */
	const supporter: AdminAccess = {
		platform: false,
		roles: ['custom_support'],
		permissions: ['admin:email_deliveries:read', 'admin:users:read']
	};
	const noAccess: AdminAccess = {
		platform: false,
		roles: ['custom_none'],
		permissions: ['admin:users:read']
	};
	const rowName = (kind: string) => t('edel.row.open', { kind });
</script>

<Story
	name="Email deliveries"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await waitFor(() =>
			expect(
				canvas.queryAllByText(t('edel.status.delivered'), { selector: 'span' }).length
			).toBeGreaterThan(0)
		);
		// Recipients come masked by default, and the page says so.
		await expect(canvas.getByText(t('edel.visibility.masked.title'))).toBeInTheDocument();
		await expect(canvas.getByText('t***@example.com')).toBeInTheDocument();
		// A retry shows its attempt count and its last error.
		await expect(canvas.getByText(t('edel.attempts', { count: 3 }))).toBeInTheDocument();
		await expect(canvas.getByText('provider_timeout')).toBeInTheDocument();
	}}
>
	{#snippet template()}
		<EmailDeliveries client={createFakeEmailDeliveries({ delay: 0 })} access={supporter} />
	{/snippet}
</Story>

<Story
	name="A record in full"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const rows = await canvas.findAllByRole('button', {
			name: rowName(t('edel.kind.admin.admin-invitation'))
		});
		await userEvent.click(rows[0]);
		await canvas.findByText(t('edel.detail.title'));
		await expect(canvas.getByText(t('edel.detail.final.no'))).toBeInTheDocument();
		await expect(canvas.getByText('pin_mailer_primary')).toBeInTheDocument();
		await userEvent.click(canvas.getByRole('button', { name: t('edel.detail.close') }));
		await waitFor(() => expect(canvas.queryByText(t('edel.detail.title'))).not.toBeInTheDocument());
	}}
>
	{#snippet template()}
		<EmailDeliveries
			client={createFakeEmailDeliveries({ delay: 0, visibility: 'full' })}
			access={supporter}
		/>
	{/snippet}
</Story>

<Story
	name="Narrowed to one status"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Badges only: the status filter's options carry the same words.
		const badges = (text: string) => canvas.queryAllByText(text, { selector: 'span' });
		await waitFor(() => expect(badges(t('edel.status.delivered')).length).toBeGreaterThan(0));
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('edel.filter.status') }),
			'bounced'
		);
		await waitFor(() => expect(badges(t('edel.status.delivered'))).toHaveLength(0));
		await expect(badges(t('edel.status.bounced')).length).toBeGreaterThan(0);
	}}
>
	{#snippet template()}
		<EmailDeliveries client={createFakeEmailDeliveries({ delay: 0 })} access={supporter} />
	{/snippet}
</Story>

<Story
	name="Recipients not shown"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('edel.visibility.none.title'));
		await expect(canvas.queryByText('t***@example.com')).not.toBeInTheDocument();
	}}
>
	{#snippet template()}
		<EmailDeliveries
			client={createFakeEmailDeliveries({ delay: 0, visibility: 'none' })}
			access={supporter}
		/>
	{/snippet}
</Story>

<Story name="No records">
	{#snippet template()}
		<EmailDeliveries client={createFakeEmailDeliveries({ empty: true })} access={supporter} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<EmailDeliveries client={createFakeEmailDeliveries({ hang: true })} access={supporter} />
	{/snippet}
</Story>

<Story
	name="Failed to load"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('edel.loadFailed'));
	}}
>
	{#snippet template()}
		<EmailDeliveries client={createFakeEmailDeliveries({ fail: 500 })} access={supporter} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('edel.noAccess'));
	}}
>
	{#snippet template()}
		<EmailDeliveries client={createFakeEmailDeliveries({ delay: 0 })} access={noAccess} />
	{/snippet}
</Story>
