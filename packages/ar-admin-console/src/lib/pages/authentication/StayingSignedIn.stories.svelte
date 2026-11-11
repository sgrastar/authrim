<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { persona } from '#lib/access/personas.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { settingText } from '#lib/settings/setting-text.js';
	import { DEMO_TENANT, demoSettings } from './session-profiles.fixtures';
	import StayingSignedIn from './StayingSignedIn.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Session profiles',
		component: StayingSignedIn,
		// api-pending: while a value is set here, the API does not say what the deployment would
		// give instead, so "Default: …" shows Authrim's built-in default (see settings-model.ts).
		tags: ['autodocs', 'api-pending'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Authentication → Session profiles: how long people stay signed in and whether single sign-on is on. Built from Settings API `session` and `oauth` settings by its placement (`SESSION_PROFILES` in `settings/placement.ts`): the few settings most tenants look at on view, the rest under each section’s Advanced (whose closed heading counts what is set for this tenant). Every value says whether it is set for this tenant or taken from the deployment / Authrim’s default, with the way to switch.\n\nUse the **Admin** toolbar to see it as each kind of admin: a tenant admin edits, a viewer reads, support does not see it (nor its navigation item).'
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
		// Someone else changed single sign-on meanwhile: the admin is asked.
		const dialog = within(await body.findByRole('dialog', { name: t('settings.conflict.title') }));
		await waitFor(() => expect(dialog.getByText(label('oauth.sso_enabled'))).toBeVisible());
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
				othersSaveFirst: { 'oauth.sso_enabled': false }
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
			canvas.queryByRole('checkbox', { name: new RegExp(label('session.default_ttl')) })
		).toBeNull();
	}}
>
	{#snippet template()}
		<StayingSignedIn
			client={demoSettings({
				locked: ['session.default_ttl', 'oauth.sso_enabled']
			})}
			tenantId={DEMO_TENANT}
		/>
	{/snippet}
</Story>
