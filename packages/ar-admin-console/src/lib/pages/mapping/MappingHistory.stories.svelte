<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { userEvent, within } from 'storybook/test';
	import { createFakeIdentityMapping, DEMO_TENANT } from '$lib/api/fake/identity-mapping-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import MappingWorkspace from './MappingWorkspace.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Mapping/Tenants/History',
		component: MappingWorkspace,
		// UI prototype: in-memory data, not connected to the deployed Admin API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Mapping defaults → History (tenant admins, operators). Who changed which level, when, from what to what. Restoring one writes back the value before it, for that level only: the preview says how apps’ tokens change and which later changes to the same level it also undoes, and the restore is refused if the level changed since. A change whose earlier set is gone or switched off says why it cannot be restored.'
				}
			}
		}
	});
</script>

<Story name="History">
	{#snippet template()}
		<MappingWorkspace
			page="tenant"
			tab="history"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
		/>
	{/snippet}
</Story>

<Story
	name="Restore one step"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const [latest] = await canvas.findAllByRole('button', { name: t('mc.hist.restore') });
		await userEvent.click(latest);
		const dialog = within(await within(document.body).findByRole('dialog'));
		await dialog.findByText(t('mc.hist.dialog.apps'));
		await userEvent.click(dialog.getByRole('button', { name: t('mc.hist.dialog.submit') }));
		await canvas.findByText(t('mc.hist.via.restore'));
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="tenant"
			tab="history"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
		/>
	{/snippet}
</Story>
