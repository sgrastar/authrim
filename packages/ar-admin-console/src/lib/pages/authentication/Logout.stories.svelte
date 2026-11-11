<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { within } from 'storybook/test';
	import { persona } from '#lib/access/personas.js';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { DEMO_TENANT, demoSettings } from './session-profiles.fixtures';
	import Logout from './Logout.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Authentication/Logout',
		component: Logout,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Authentication → Logout: how the tenant tells apps that a person signed out (back-channel logout delivery: what happens when an app does not answer, retries, the logout token’s lifetime). Built from Settings API `session` settings by its placement (`LOGOUT` in `settings/placement.ts`); each app’s own logout addresses stay with the app.'
				}
			}
		}
	});
</script>

<Story
	name="Tenant settings"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByRole('heading', { name: t('set.section.logout') });
	}}
>
	{#snippet template()}
		<Logout client={demoSettings()} tenantId={DEMO_TENANT} />
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
		<Logout
			client={demoSettings({ access: () => support })}
			tenantId={DEMO_TENANT}
			access={support}
		/>
	{/snippet}
</Story>
