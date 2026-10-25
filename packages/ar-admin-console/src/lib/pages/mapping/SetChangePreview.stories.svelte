<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeIdentityMapping, DEMO_TENANT } from '$lib/api/fake/identity-mapping-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import MappingWorkspace from './MappingWorkspace.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Mapping/Mapping sets/Details',
		component: MappingWorkspace,
		// UI prototype: in-memory data, not connected to the deployed Admin API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'A set → edit (tenant admins, operators). Before saving, “See the changes” sends the draft to the API’s preview, which answers for every app that uses the set: what changes in its tokens (added, removed, renamed, from another attribute, type), what does not reach it for lack of a scope, and where the app takes the set from. A test user’s made-up values can be compared; real users’ never are. The preview is optional: Save works without it.'
				}
			}
		}
	});

	/** The scenario's edit: department dropped, organization renamed to org, groups added. */
	const EDITS = {
		mappings: [
			{ target: 'affiliation', sources: ['affiliation'] },
			{ target: 'org', sources: ['org_name'] },
			{ target: 'groups', sources: ['groups'] }
		]
	};
</script>

<Story name="Saved set">
	{#snippet template()}
		<MappingWorkspace
			page="set"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			setId="fms_aster"
		/>
	{/snippet}
</Story>

<Story
	name="Changes by app"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.ch.check') }));
		const renamed = await canvas.findAllByText(
			t('mc.ch.kind.renamed', { claim: 'org', from: 'organization' })
		);
		expect(renamed.length).toBeGreaterThan(0);
		// An app without the scope does not see the change, and says why.
		await canvas.findAllByText(t('mc.ch.heldBack', { claim: 'org', scope: 'affiliation' }));
		await canvas.findByRole('table', { name: t('mc.ch.sampleTitle') });
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="set"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			setId="fms_aster"
			edits={EDITS}
			sampleUserId="test_full"
		/>
	{/snippet}
</Story>

<Story
	name="Save without the preview"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// The preview is optional: saving asks for confirmation and works without it.
		const save = await canvas.findByRole('button', { name: t('mc.ch.save') });
		await waitFor(() => expect(save).toBeEnabled());
		await userEvent.click(save);
		const dialog = within(await within(document.body).findByRole('dialog'));
		await userEvent.click(dialog.getByRole('button', { name: t('mc.ch.save') }));
		await waitFor(() =>
			expect(canvas.getByRole('button', { name: t('mc.ch.save') })).toBeDisabled()
		);
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="set"
			client={createFakeIdentityMapping()}
			tenantId={DEMO_TENANT}
			setId="fms_aster"
			edits={EDITS}
		/>
	{/snippet}
</Story>

<Story
	name="Platform set, by tenant"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('mc.ch.check') }));
		await canvas.findByRole('table', { name: t('mc.ch.tenants') });
	}}
>
	{#snippet template()}
		<MappingWorkspace
			page="set"
			client={createFakeIdentityMapping({ platformDefault: 'fms_affil' })}
			tenantId="platform"
			setId="fms_affil"
		/>
	{/snippet}
</Story>
