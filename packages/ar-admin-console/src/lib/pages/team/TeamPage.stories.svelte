<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { persona } from '#lib/access/personas.js';
	import { fakeAdminTeam, sampleAdmins } from '#lib/api/fake/admin-team-fake.js';
	import { createFakeSettings } from '#lib/api/fake/settings-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { waitForSettledToasts } from '#lib/ui/stories/toast-settled.js';
	import Toaster from '#lib/ui/toast/Toaster.svelte';
	import { toast } from '#lib/ui/toast/toast.svelte.js';
	import TeamPage from './TeamPage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Administrators/Team',
		component: TeamPage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Administrators: the administrators who belong to this tenant (`/api/admin/admins`: searched by email, narrowed by status and second factor, a page at a time), the invitations sent to new ones (`/api/admin/admin-invitations`: waiting ones first, the rest on request, the latest 100) and the sign-in settings (the `TEAM` settings page, without its own header). A tab is shown only to an admin who can use it: the lists need `admin:admin_users:read`, the sign-in settings those settings. With `admin:admin_users:write` a row’s menu suspends, reactivates or unlocks; inviting, resending and revoking also need `admin:admin_roles:write` (an invitation is a role grant). Refusals name their reason (the last administrator, a pending invitation already…), read from the API’s code rather than the status, since several of them are 409.\n\nUse the **Admin** toolbar to see it as each kind of admin.'
				}
			}
		}
	});

	const TENANT = 'acme';
	const settings = () =>
		createFakeSettings({ access: () => adminAccess.current, latency: 150, stored: {} });
</script>

<Story
	name="Administrators"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Aiko Sato');
		await expect(canvas.getByRole('link', { name: t('tm.invite') })).toBeVisible();
		await userEvent.type(canvas.getByRole('searchbox'), 'ken');
		await waitFor(() => expect(canvas.queryByText('Aiko Sato')).toBeNull());
		await canvas.findByText('Ken Ito');
	}}
>
	{#snippet template()}
		<TeamPage
			team={fakeAdminTeam({ delay: 150 })}
			settings={settings()}
			tenantId={TENANT}
			inviteHref="#invite"
			access={persona('tenant').access}
		/>
	{/snippet}
</Story>

<Story
	name="Last administrator"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			await canvas.findByRole('button', { name: t('tm.admins.col.actions', { name: 'Aiko Sato' }) })
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('tm.action.suspend') }));
		await userEvent.click(await body.findByRole('button', { name: t('tm.action.suspend') }));
		await body.findByText(t('tm.error.lastTenantAdmin'));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<TeamPage
			team={fakeAdminTeam({ admins: sampleAdmins().slice(0, 1) })}
			settings={settings()}
			tenantId={TENANT}
			inviteHref="#invite"
			access={persona('tenant').access}
		/>
	{/snippet}
</Story>

<Story
	name="Invitations"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Riku Abe');
		// A tenant admin cannot send again or revoke the invitation for every tenant.
		await expect(
			canvas.queryByRole('button', {
				name: t('tm.inv.col.actions', { name: 'platform.ops@example.com' })
			})
		).toBeNull();
		await expect(canvas.queryByText('old.invite@example.com')).toBeNull();
		await userEvent.click(canvas.getByRole('checkbox', { name: t('tm.inv.showCompleted') }));
		await canvas.findByText('old.invite@example.com');
	}}
>
	{#snippet template()}
		<TeamPage
			team={fakeAdminTeam()}
			settings={settings()}
			tenantId={TENANT}
			inviteHref="#invite"
			access={persona('tenant').access}
			initialTab="invitations"
		/>
	{/snippet}
</Story>

<Story
	name="Email not sent on resend"
	play={async ({ canvasElement }) => {
		toast.dismissAll();
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			await canvas.findByRole('button', {
				name: t('tm.inv.col.actions', { name: 'new.member@example.com' })
			})
		);
		await userEvent.click(await body.findByRole('menuitem', { name: t('tm.inv.action.resend') }));
		await userEvent.click(await body.findByRole('button', { name: t('tm.inv.action.resend') }));
		await body.findByText(t('tm.toast.resentNotDelivered', { email: 'new.member@example.com' }));
		await waitForSettledToasts();
	}}
>
	{#snippet template()}
		<Toaster />
		<TeamPage
			team={fakeAdminTeam({ emailDown: true })}
			settings={settings()}
			tenantId={TENANT}
			inviteHref="#invite"
			access={persona('tenant').access}
			initialTab="invitations"
		/>
	{/snippet}
</Story>

<Story
	name="Read only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText('Aiko Sato');
		await expect(canvas.queryByRole('link', { name: t('tm.invite') })).toBeNull();
		await expect(
			canvas.queryByRole('button', { name: t('tm.admins.col.actions', { name: 'Aiko Sato' }) })
		).toBeNull();
	}}
>
	{#snippet template()}
		<TeamPage
			team={fakeAdminTeam()}
			settings={settings()}
			tenantId={TENANT}
			inviteHref="#invite"
			access={{ platform: false, roles: [], permissions: ['admin:admin_users:read'] }}
		/>
	{/snippet}
</Story>

<Story
	name="Sign-in settings only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole('tab', { name: t('tm.tab.signin') });
		await expect(canvas.queryByRole('tab', { name: t('tm.tab.admins') })).toBeNull();
	}}
>
	{#snippet template()}
		<TeamPage
			team={fakeAdminTeam()}
			settings={createFakeSettings({ access: () => persona('viewer').access, stored: {} })}
			tenantId={TENANT}
			inviteHref="#invite"
			access={persona('viewer').access}
		/>
	{/snippet}
</Story>

<Story name="Cannot load">
	{#snippet template()}
		<TeamPage
			team={fakeAdminTeam({ failOn: { listAdmins: 500 } })}
			settings={settings()}
			tenantId={TENANT}
			inviteHref="#invite"
			access={persona('tenant').access}
		/>
	{/snippet}
</Story>
