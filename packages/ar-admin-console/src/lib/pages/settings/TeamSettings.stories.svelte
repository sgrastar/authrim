<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { adminAccess } from '#lib/access/admin-access.svelte.js';
	import { persona } from '#lib/access/personas.js';
	import { createFakeSettings, type FakeSettingsOptions } from '#lib/api/fake/settings-fake.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { settingText } from '#lib/settings/setting-text.js';
	import TeamSettings from './TeamSettings.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Administrators/Sign-in settings',
		component: TeamSettings,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						"Settings → Administrators: how admins sign in to the console. The tenant’s part (how long an admin stays signed in after a passkey, and the operations that ask for a stronger check than built in, as a JSON object) and, for platform admins only, a second section saved for the whole deployment (`level: 'platform'` in `TEAM`, `settings/placement.ts`): whether admin step-up is enforced and whether Keyring may be presented through the Digital Credentials API. In the console, saving a change the API guards with step-up (relaxing the step-up policy, turning enforcement off) asks for the passkey and second factor first.\n\nUse the **Admin** toolbar to see it as each kind of admin: a platform admin sees both sections, a tenant admin only the tenant’s, a viewer reads, support does not see it."
				}
			}
		}
	});

	const TENANT = 'acme';
	const label = (key: string) => t(settingText(key).label);

	function settings(options: FakeSettingsOptions = {}) {
		return createFakeSettings({
			access: () => adminAccess.current,
			latency: 200,
			stored: {
				[`tenant:${TENANT}`]: {
					'session.ttl.admin_passkey': 28_800_000,
					'security.admin_step_up_overrides': { 'client.secret.rotate': 'L2' }
				}
			},
			...options
		});
	}
</script>

<Story name="Tenant settings">
	{#snippet template()}
		<TeamSettings client={settings()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Platform admin"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('set.section.adminSignInPlatform'));
		await canvas.findAllByText(label('security.admin_step_up_enforced'));
		await canvas.findAllByText(label('security.admin_keyring_dc_api'));
		await canvas.findByText(t('set.section.adminInvitationsPlatform'));
		await canvas.findAllByText(label('admin_invitations.code_handoff_enabled'));
	}}
>
	{#snippet template()}
		{@const platform = persona('platform').access}
		<TeamSettings
			client={settings({ access: () => platform })}
			tenantId={TENANT}
			access={platform}
		/>
	{/snippet}
</Story>

<Story
	name="Tenant admin"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('set.section.adminSignIn'));
		// The deployment-wide switches are the platform's: not shown to a tenant admin.
		expect(canvas.queryByText(t('set.section.adminSignInPlatform'))).toBeNull();
		expect(canvas.queryByText(t('set.section.adminInvitationsPlatform'))).toBeNull();
	}}
>
	{#snippet template()}
		{@const admin = persona('tenant').access}
		<TeamSettings client={settings({ access: () => admin })} tenantId={TENANT} access={admin} />
	{/snippet}
</Story>

<Story
	name="Not JSON"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const field = await canvas.findByRole('textbox', {
			name: new RegExp(label('security.admin_step_up_overrides'))
		});
		// The admin's own spacing stays as typed.
		await userEvent.clear(field);
		await userEvent.type(field, '{{ }');
		await waitFor(() => expect(field).toHaveValue('{ }'));
		await userEvent.clear(field);
		await userEvent.type(field, '[[1]');
		await canvas.findByText(t('settings.json.object'));
		// Save stops on the field instead of sending.
		await userEvent.click(await body.findByRole('button', { name: t('common.save') }));
		await waitFor(() => expect(field).toHaveFocus());
	}}
>
	{#snippet template()}
		{@const admin = persona('tenant').access}
		<TeamSettings
			client={settings({ access: () => admin, latency: 0 })}
			tenantId={TENANT}
			access={admin}
		/>
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.readOnly.title'));
		expect(canvas.queryByRole('textbox')).toBeNull();
	}}
>
	{#snippet template()}
		{@const viewer = persona('viewer').access}
		<TeamSettings client={settings({ access: () => viewer })} tenantId={TENANT} access={viewer} />
	{/snippet}
</Story>

<Story
	name="No access"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('access.none.title'));
	}}
>
	{#snippet template()}
		{@const support = persona('support').access}
		<TeamSettings client={settings({ access: () => support })} tenantId={TENANT} access={support} />
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<TeamSettings client={settings({ failGet: 'hang' })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('load.error.title'));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('load.retry') })).toBeVisible()
		);
	}}
>
	{#snippet template()}
		<TeamSettings client={settings({ failGet: 'error' })} tenantId={TENANT} />
	{/snippet}
</Story>
