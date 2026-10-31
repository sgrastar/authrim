<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import { createFakeIdentityMapping, DEMO_TENANT } from '$lib/api/fake/identity-mapping-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import MappingPageContent from './MappingPageContent.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Mapping/Applications/Mapping',
		component: MappingPageContent,
		// UI prototype: in-memory data, not connected to the deployed Admin API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Service flows → selected app → user information. Content for the existing Shell; integration into the full service-flow detail is pending. What applies now and how each level decided it; then the app’s choice — follow the tenant default (Not set), a set for this app only (App-specific), or no mapping (Not used) — with what each choice would give, from the API.'
				}
			}
		}
	});
</script>

<Story name="Follows the tenant default">
	{#snippet template()}
		<MappingPageContent
			page="app"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			clientId="app_library"
		/>
	{/snippet}
</Story>

<Story name="App-specific set">
	{#snippet template()}
		<MappingPageContent
			page="app"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			clientId="app_intranet"
		/>
	{/snippet}
</Story>

<Story name="Not used">
	{#snippet template()}
		<MappingPageContent
			page="app"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			clientId="app_conformance"
		/>
	{/snippet}
</Story>

<Story
	name="Choose not to use a mapping"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const follow = await canvas.findByRole('radio', { name: t('mc.app.follow') });
		const help = canvas.getByRole('button', {
			name: `${t('common.moreInfo')}: ${t('mc.app.follow')}`
		});
		const helpId = follow.getAttribute('aria-describedby');
		await expect(helpId).toBeTruthy();
		await expect(document.getElementById(helpId!)).toHaveTextContent(t('mc.app.follow.desc'));
		await expect(help.closest('label')).toBeNull();
		await expect(help).toHaveAttribute('aria-describedby', helpId);
		const wasChecked = (follow as HTMLInputElement).checked;
		await userEvent.click(help);
		await expect((follow as HTMLInputElement).checked).toBe(wasChecked);
		await userEvent.click(
			await canvas.findByRole('radio', { name: new RegExp(`^${t('mc.app.none')}`) })
		);
		await userEvent.click(
			await within(document.body).findByRole('button', { name: t('common.save') })
		);
		await canvas.findAllByText(t('mc.none.client_opt_out'));
	}}
>
	{#snippet template()}
		<MappingPageContent
			page="app"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			clientId="app_library"
		/>
	{/snippet}
</Story>
