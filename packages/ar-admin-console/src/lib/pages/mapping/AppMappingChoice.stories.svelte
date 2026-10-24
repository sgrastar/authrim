<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { userEvent, within } from 'storybook/test';
	import { createFakeIdentityMapping, DEMO_TENANT } from '$lib/api/fake/identity-mapping-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import AppMappingChoice from './AppMappingChoice.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Mapping/An app’s mapping (MAP-03)',
		component: AppMappingChoice,
		// draft: not wired to a route. api-pending: what each choice would give, unsaved
		// (POST /api/admin/identity-mapping/preview-effective), does not exist yet. The current
		// state (effective) and saving the choice (PUT /api/admin/clients/{id}) do.
		tags: ['autodocs', 'draft', 'api-pending'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'An app → Identity mapping (tenant admins, app developers). What applies now and how each level decided it; then the app’s choice — follow the tenant default (Not set), a set for this app only (App-specific), or no mapping (Not used) — with what each choice would give, from the API.'
				}
			}
		}
	});
</script>

<Story name="Follows the tenant default">
	{#snippet template()}
		<AppMappingChoice
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			clientId="app_library"
		/>
	{/snippet}
</Story>

<Story name="App-specific set">
	{#snippet template()}
		<AppMappingChoice
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			clientId="app_intranet"
		/>
	{/snippet}
</Story>

<Story name="Not used">
	{#snippet template()}
		<AppMappingChoice
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
		<AppMappingChoice
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			clientId="app_library"
		/>
	{/snippet}
</Story>
