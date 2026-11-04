<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeAdminNotices } from '#lib/api/fake/admin-notices-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import Notifications from './Notifications.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Operations/Notifications',
		component: Notifications,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Operations → Notifications: the notices open for the signed-in admin in the selected tenant (the same ones the header’s bell shows), the detail of one with the link to the page that deals with it, and the action that closes it. Information is cleared from the admin’s own screen; critical, high and caution notices are marked as handled for everyone. Admins who may change settings can publish an announcement (platform announcements only with platform authority). Built on `/api/admin/notices`; the stories use an in-memory API with the same rules.'
				}
			}
		}
	});
</script>

<Story
	name="Default"
	globals={{ admin: 'tenant' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(
			t('notice.msg.second_factor_recovery_requested', { email: 'sam@example.com' })
		);
		// The platform notice is not for a tenant admin.
		await expect(canvas.queryByText(t('notice.msg.control_plane_drift'))).toBeNull();
		await canvas.findByRole('button', { name: t('nt.publish') });
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices()} />
	{/snippet}
</Story>

<Story
	name="Platform admin"
	globals={{ admin: 'platform' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('notice.msg.control_plane_drift'));
		await canvas.findByText(t('nt.scope.platform'));
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices({ platform: true })} />
	{/snippet}
</Story>

<Story
	name="Opened from the header"
	globals={{ admin: 'tenant' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('heading', { name: t('nt.detail.title') });
		await canvas.findByRole('button', { name: t('nt.resolve') });
		await canvas.findByRole('link', { name: '/admin/me' });
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices()} focusId="ntc_recovery" />
	{/snippet}
</Story>

<Story
	name="Mark as handled"
	globals={{ admin: 'tenant' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('nt.resolve') }));
		// The notice stays open on screen, now marked as handled, and leaves the list.
		await canvas.findByText(t('nt.detail.resolved'));
		await expect(canvas.queryByRole('button', { name: t('nt.resolve') })).toBeNull();
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices()} focusId="ntc_dlq" />
	{/snippet}
</Story>

<Story
	name="Handled by someone else"
	globals={{ admin: 'tenant' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('nt.resolve') }));
		await canvas.findByText(t('nt.err.resolved'));
	}}
>
	{#snippet template()}
		<Notifications
			client={createFakeAdminNotices({ failOn: { resolve: 409 } })}
			focusId="ntc_dlq"
		/>
	{/snippet}
</Story>

<Story
	name="Information"
	globals={{ admin: 'tenant' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Information is cleared from the admin's own screen, not marked as handled.
		await canvas.findByRole('button', { name: t('nt.dismiss') });
		await expect(canvas.queryByRole('button', { name: t('nt.resolve') })).toBeNull();
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices()} focusId="ntc_announce" />
	{/snippet}
</Story>

<Story
	name="Publish an announcement"
	globals={{ admin: 'platform' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('nt.publish') }));
		const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog');
		const scope = within(dialog).getByRole('combobox', { name: t('nt.pub.scope') });
		// Platform authority adds the platform as an audience.
		await expect(
			within(scope).getByRole('option', { name: t('nt.pub.scope.platform') })
		).toBeInTheDocument();
		await userEvent.type(
			within(dialog).getByRole('textbox', { name: /^見出し|Headline/ }),
			'Hello'
		);
		await userEvent.click(within(dialog).getByRole('button', { name: t('nt.pub.submit') }));
		await waitFor(() => expect(canvas.getByText('Hello')).toBeInTheDocument());
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices({ platform: true })} />
	{/snippet}
</Story>

<Story
	name="Cannot publish"
	globals={{ admin: 'viewer' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findAllByText(t('notice.msg.logging_dlq_backlog'));
		await expect(canvas.queryByRole('button', { name: t('nt.publish') })).toBeNull();
		await expect(canvas.queryByRole('button', { name: t('nt.resolve') })).toBeNull();
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices({ canWrite: false })} focusId="ntc_dlq" />
	{/snippet}
</Story>

<Story
	name="Nothing open"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('nt.empty'));
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices({ notices: [] })} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<Notifications client={createFakeAdminNotices({ delay: 60_000 })} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('nt.loadFailed'));
		await canvas.findByRole('button', { name: t('common.retry') });
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices({ fail: 500 })} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('nt.noAccess'));
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices({ fail: 403 })} />
	{/snippet}
</Story>

<Story
	name="Notice not found"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('nt.detail.missing'));
	}}
>
	{#snippet template()}
		<Notifications client={createFakeAdminNotices()} focusId="ntc_unknown" />
	{/snippet}
</Story>
