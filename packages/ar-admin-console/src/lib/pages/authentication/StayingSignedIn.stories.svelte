<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { persona } from '$lib/access/personas';
	import { t } from '$lib/i18n/i18n.svelte';
	import { settingText } from '$lib/settings/setting-text';
	import { DEMO_TENANT, demoSettings } from './staying-signed-in.fixtures';
	import StayingSignedIn from './StayingSignedIn.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Staying signed in',
		component: StayingSignedIn,
		// api-pending: while a value is set here, the API does not say what the deployment would
		// give instead, so "Default: …" shows Authrim's built-in default (see settings-model.ts).
		tags: ['autodocs', 'api-pending'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Authentication → Staying signed in: how long people and their apps stay signed in. Built from Settings API `session` and `oauth` settings by its placement (`STAYING_SIGNED_IN` in `settings/placement.ts`): the few settings most tenants look at on view, the rest under each section’s Advanced (whose closed heading counts what is set for this tenant). Every value says whether it is set for this tenant or taken from the deployment / Authrim’s default, with the way to switch.\n\nUse the **Admin** toolbar to see it as each kind of admin: a tenant admin edits, a viewer reads, support does not see it (nor its navigation item).'
				}
			}
		}
	});

	const label = (key: string) => t(settingText(key).label);
	const startsWith = (text: string) =>
		new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
</script>

<Story name="Tenant settings">
	{#snippet template()}
		<StayingSignedIn client={demoSettings()} tenantId={DEMO_TENANT} />
	{/snippet}
</Story>

<Story
	name="View only"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('settings.readOnly.title'));
		// Values as text: no controls to change them.
		expect(canvas.queryByRole('checkbox')).toBeNull();
		expect(canvas.queryByRole('button', { name: t('common.save') })).toBeNull();
		// A setting still in development says so here too, not only where it can be edited.
		expect(await canvas.findAllByText(t('settings.badge.inDevelopment'))).not.toHaveLength(0);
	}}
>
	{#snippet template()}
		{@const viewer = persona('viewer').access}
		<StayingSignedIn
			client={demoSettings({ access: () => viewer })}
			tenantId={DEMO_TENANT}
			access={viewer}
		/>
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
		<StayingSignedIn
			client={demoSettings({ access: () => support })}
			tenantId={DEMO_TENANT}
			access={support}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<StayingSignedIn client={demoSettings({ failGet: 'hang' })} tenantId={DEMO_TENANT} />
	{/snippet}
</Story>

<Story
	name="Load failed"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('load.error.title'));
		// The page fades in; wait until it has.
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('load.retry') })).toBeVisible()
		);
	}}
>
	{#snippet template()}
		<StayingSignedIn client={demoSettings({ failGet: 'error' })} tenantId={DEMO_TENANT} />
	{/snippet}
</Story>

<Story
	name="Another admin saved first"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		// Turn single sign-on off (it is set for this tenant) and save.
		const sso = await canvas.findByRole('combobox', {
			name: startsWith(label('oauth.sso_enabled'))
		});
		await userEvent.selectOptions(sso, 'false');
		await userEvent.click(await body.findByRole('button', { name: t('common.save') }));
		// Someone else changed the access token lifetime meanwhile: the admin is asked.
		const dialog = within(await body.findByRole('dialog', { name: t('settings.conflict.title') }));
		await waitFor(() => expect(dialog.getByText(label('oauth.access_token_expiry'))).toBeVisible());
		await userEvent.click(dialog.getByRole('button', { name: t('settings.conflict.overwrite') }));
		// Saved on top of their change: nothing left unsaved, their value kept.
		await waitFor(() => expect(sso).toHaveValue('false'));
		await waitFor(() =>
			expect(body.queryByRole('dialog', { name: t('settings.conflict.title') })).toBeNull()
		);
	}}
>
	{#snippet template()}
		{@const admin = persona('tenant').access}
		<StayingSignedIn
			client={demoSettings({
				access: () => admin,
				latency: 0,
				othersSaveFirst: { 'oauth.access_token_expiry': 600 }
			})}
			tenantId={DEMO_TENANT}
			access={admin}
		/>
	{/snippet}
</Story>

<Story
	name="Fixed by the platform"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Follows the Admin toolbar. A fixed setting says why and shows its value; there is
		// nothing to check or change.
		await waitFor(() =>
			expect(canvas.getAllByText(t('settings.locked.platform')).length).toBeGreaterThan(0)
		);
		expect(
			canvas.queryByRole('checkbox', { name: new RegExp(label('oauth.access_token_expiry')) })
		).toBeNull();
	}}
>
	{#snippet template()}
		<StayingSignedIn
			client={demoSettings({
				locked: ['oauth.access_token_expiry', 'oauth.refresh_token_rotation']
			})}
			tenantId={DEMO_TENANT}
		/>
	{/snippet}
</Story>
