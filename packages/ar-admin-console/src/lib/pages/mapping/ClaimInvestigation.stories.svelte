<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { userEvent, within } from 'storybook/test';
	import { createFakeIdentityMapping, DEMO_TENANT } from '$lib/api/fake/identity-mapping-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import MappingWorkspace from './MappingWorkspace.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Mapping/Applications/Test',
		component: MappingWorkspace,
		// UI prototype: in-memory data, not connected to the deployed Admin API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'An app → Investigate claims (tenant admins; app developers look too). For an app and a test user, stage by stage: the mapping used and where it was decided, whether each item has a value (never the value), what scopes and consent hold back, and the claims sent. Each claim not sent has a reason and the place to fix it. When the set in use cannot be used, no token is issued, and that comes first (MAP-06).'
				}
			}
		}
	});

	const fake = (options = {}) => createFakeIdentityMapping(options);
</script>

<Story name="Application test tab (MAP-04)">
	{#snippet template()}
		<MappingWorkspace
			page="app"
			tab="test"
			client={fake()}
			tenantId={DEMO_TENANT}
			clientId="app_printing"
		/>
	{/snippet}
</Story>

<Story
	name="No affiliation value"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('mc.ex.reason.value_missing'));
		await canvas.findByText(t('mc.ex.fix.value_missing'));
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="app"
			tab="test"
			client={fake()}
			tenantId={DEMO_TENANT}
			clientId="app_library"
			userId="test_no_affiliation"
			autorun
		/>
	{/snippet}
</Story>

<Story
	name="Scope not granted"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const reasons = await canvas.findAllByText(t('mc.ex.reason.scope_not_granted'));
		await canvas.findByText(t('mc.ex.filter.summary', { count: reasons.length }));
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="app"
			tab="test"
			client={fake()}
			tenantId={DEMO_TENANT}
			clientId="app_timetable"
			userId="test_full"
			autorun
		/>
	{/snippet}
</Story>

<Story name="Consent missing">
	{#snippet template()}
		<MappingWorkspace
			page="app"
			tab="test"
			client={fake()}
			tenantId={DEMO_TENANT}
			clientId="app_events"
			userId="test_full"
			consent="none"
			autorun
		/>
	{/snippet}
</Story>

<Story
	name="App does not use a mapping"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByText(t('mc.none.client_opt_out'));
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="app"
			tab="test"
			client={fake()}
			tenantId={DEMO_TENANT}
			clientId="app_conformance"
			userId="test_full"
			autorun
		/>
	{/snippet}
</Story>

<Story name="Set switched off: no token (MAP-06)">
	{#snippet template()}
		<MappingWorkspace
			page="app"
			tab="test"
			client={fake({ inactiveTenantSet: true })}
			tenantId={DEMO_TENANT}
			clientId="app_library"
			userId="test_full"
			autorun
		/>
	{/snippet}
</Story>

<Story
	name="Investigate"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);

		await userEvent.selectOptions(
			await canvas.findByRole('combobox', { name: t('mc.ex.user') }),
			'test_empty_department'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ex.run') }));
		await canvas.findByText(t('mc.ex.stage.final'));
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="app"
			tab="test"
			client={fake()}
			tenantId={DEMO_TENANT}
			clientId="app_printing"
		/>
	{/snippet}
</Story>
