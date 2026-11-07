<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
	import { teamAccess } from '#lib/access/access.js';
	import { persona } from '#lib/access/personas.js';
	import { fakeAdminTeam } from '#lib/api/fake/admin-team-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import InvitePage from './InvitePage.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Administrators/Invite',
		component: InvitePage,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Administrators → Invite (`/admin/settings/team/invite`, `POST /api/admin/admin-invitations`): who to invite, the role they get, where it applies, until when, the administrator groups they join (up to 10), and how the invitation may be accepted (24 hours to 7 days, optionally only from given addresses). Fields are checked before sending; the API checks again and its refusals (an invitation already waiting, a role above the sender’s, a role for every tenant outside the default tenant…) are shown above the buttons with what was typed kept. The scope choice is there only for an admin who can give roles for every tenant; the super administrator role is always for every tenant. An invitation whose email could not be sent is still made, and the page says so on the way back to the list.'
				}
			}
		}
	});

	const onsent = fn();
	const tenant = teamAccess(persona('tenant').access);
	const platform = teamAccess(persona('platform').access);
</script>

<Story
	name="Invite"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(/^Email address|^メールアドレス/),
			'new.one@example.com'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /^Role|^ロール/ }),
			'role_ar_support'
		);
		await userEvent.click(canvas.getByRole('checkbox', { name: /Operations/ }));
		await userEvent.click(canvas.getByRole('button', { name: t('tm.new.submit') }));
		await waitFor(() => expect(onsent).toHaveBeenCalled());
	}}
>
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam()}
			access={tenant}
			tenantId="acme"
			listHref="#team"
			{onsent}
			zone="utc"
		/>
	{/snippet}
</Story>

<Story
	name="Checked before sending"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('tm.new.submit') }));
		await canvas.findByText(t('tm.new.emailRequired'));
		// Later cards fade in as the page is entered.
		await waitFor(() => expect(canvas.getByText(t('tm.new.roleRequired'))).toBeVisible());
	}}
>
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam()}
			access={tenant}
			tenantId="acme"
			listHref="#team"
			onsent={() => {}}
		/>
	{/snippet}
</Story>

<Story
	name="Already invited"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(/^Email address|^メールアドレス/),
			'new.member@example.com'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /^Role|^ロール/ }),
			'role_ar_support'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('tm.new.submit') }));
		await canvas.findByText(t('tm.error.invitationExists'));
		await expect(canvas.getByLabelText(/^Email address|^メールアドレス/)).toHaveValue(
			'new.member@example.com'
		);
	}}
>
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam()}
			access={tenant}
			tenantId="acme"
			listHref="#team"
			onsent={() => {}}
		/>
	{/snippet}
</Story>

<Story name="Platform admin: every tenant">
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam()}
			access={platform}
			tenantId="acme"
			listHref="#team"
			onsent={() => {}}
		/>
	{/snippet}
</Story>

<Story
	name="Every tenant outside the default tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(/^Email address|^メールアドレス/),
			'ops2@example.com'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /^Role|^ロール/ }),
			'role_ar_super_admin'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('tm.new.submit') }));
		await canvas.findByText(t('tm.error.crossTenant'));
	}}
>
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam({
				failOn: { createInvitation: 'cross_tenant_admin_requires_default_home' }
			})}
			access={platform}
			tenantId="acme"
			listHref="#team"
			onsent={() => {}}
		/>
	{/snippet}
</Story>

<Story
	name="Step-up cancelled"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.type(
			await canvas.findByLabelText(/^Email address|^メールアドレス/),
			'new.one@example.com'
		);
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: /^Role|^ロール/ }),
			'role_ar_support'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('tm.new.submit') }));
		await canvas.findByText(t('tm.error.cancelled'));
		await expect(canvas.getByLabelText(/^Email address|^メールアドレス/)).toHaveValue(
			'new.one@example.com'
		);
	}}
>
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam({ cancelStepUp: true })}
			access={tenant}
			tenantId="acme"
			listHref="#team"
			onsent={() => {}}
		/>
	{/snippet}
</Story>

<Story
	name="Platform admin outside the default tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('tm.new.globalElsewhere'));
		await expect(canvas.queryByRole('radio', { name: t('tm.new.scope.global') })).toBeNull();
	}}
>
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam({ defaultTenant: 'default' })}
			access={platform}
			tenantId="acme"
			listHref="#team"
			onsent={() => {}}
		/>
	{/snippet}
</Story>

<Story name="No groups yet">
	{#snippet template()}
		<InvitePage
			client={fakeAdminTeam({ groups: [] })}
			access={tenant}
			tenantId="acme"
			listHref="#team"
			onsent={() => {}}
		/>
	{/snippet}
</Story>
