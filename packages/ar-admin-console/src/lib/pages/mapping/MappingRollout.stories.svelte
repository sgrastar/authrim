<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeIdentityMapping } from '$lib/api/fake/identity-mapping-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import MappingPageContent from './MappingPageContent.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Mapping/Tenants/List',
		component: MappingPageContent,
		// UI prototype: in-memory data, not connected to the deployed Admin API.
		tags: ['autodocs', 'draft'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Platform → mapping defaults (operators). Choose a platform set and the tenants, check the impact (the bulk apply’s preview: which tenants change, the apps reached, the apps left as they are and why, the tenants left out and why), type the number of tenants to run it, and see the result by tenant. A tenant that could not be changed keeps the others changed and is retried alone; the source column is read again afterwards.'
				}
			}
		}
	});

	/** The steps of the scenario: every tenant but two, with the platform's affiliation set. */
	async function chooseAndCheck(canvasElement: HTMLElement, apps = 96) {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('checkbox', { name: t('table.selectAllRows') }));
		for (const name of ['Thyme', 'Willow']) {
			await userEvent.click(canvas.getByRole('checkbox', { name: t('table.selectRow', { name }) }));
		}
		await userEvent.click(canvas.getByRole('button', { name: t('mc.nav.changeDefault') }));
		await expect(canvas.getByRole('combobox', { name: t('mc.ro.setLabel') })).toHaveFocus();
		await userEvent.selectOptions(
			canvas.getByRole('combobox', { name: t('mc.ro.setLabel') }),
			'fms_affil'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.check') }));
		await canvas.findByText(t('mc.ro.impact.summary', { tenants: 18, apps }));
		return canvas;
	}

	async function typeAndApply(count: string) {
		const dialog = within(await within(document.body).findByRole('dialog'));
		const field = dialog.getByRole('textbox', { name: t('mc.ro.confirm.label') });
		await userEvent.clear(field);
		await userEvent.type(field, count);
		await userEvent.click(dialog.getByRole('button', { name: t('mc.ro.confirm.submit') }));
		return dialog;
	}
</script>

<Story name="Tenants">
	{#snippet template()}
		<MappingPageContent page="tenants" client={createFakeIdentityMapping()} />
	{/snippet}
</Story>

<Story
	name="Give a set to 18 tenants"
	play={async ({ canvasElement }) => {
		const canvas = await chooseAndCheck(canvasElement);
		await canvas.findByText(t('mc.ro.impact.unchanged', { own: 5, optedOut: 2 }));
		// The tenant that already has its own default is left out, with the reason.
		await canvas.findByText(t('mc.ro.impact.skipped', { count: 1 }));
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.run', { count: 18 }) }));
		// A wrong number does not run it.
		const dialog = await typeAndApply('17');
		await dialog.findByText(t('mc.ro.confirm.mismatch'));
		await typeAndApply('18');
		await canvas.findByText(t('mc.ro.result.done'));
		await canvas.findByText(t('mc.ro.result.summary', { applied: 18, skipped: 0, failed: 0 }));
		// Read again after running: the tenants now take the tenant default.
		await waitFor(() =>
			expect(canvas.getAllByText(t('mc.tier.tenant_default')).length).toBeGreaterThanOrEqual(19)
		);
	}}
>
	{#snippet template()}
		<MappingPageContent page="tenants" client={createFakeIdentityMapping()} />
	{/snippet}
</Story>

<Story
	name="Sent in batches"
	play={async ({ canvasElement }) => {
		// The API takes 8 tenants a request here: 19 go as 3 requests, and read as one result.
		const canvas = await chooseAndCheck(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.run', { count: 18 }) }));
		await typeAndApply('18');
		await canvas.findByText(t('mc.ro.result.summary', { applied: 18, skipped: 0, failed: 0 }));
	}}
>
	{#snippet template()}
		<MappingPageContent page="tenants" client={createFakeIdentityMapping({ bulkLimit: 8 })} />
	{/snippet}
</Story>

<Story
	name="A request lost midway"
	play={async ({ canvasElement }) => {
		// The second of three requests is lost: its tenants and the third's are listed as not
		// sent, the first's stay applied, and a retry finishes the rest.
		const canvas = await chooseAndCheck(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.run', { count: 18 }) }));
		await typeAndApply('18');
		await canvas.findByText(t('mc.ro.result.summary', { applied: 8, skipped: 0, failed: 10 }));
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.retry', { count: 10 }) }));
		await canvas.findByText(t('mc.ro.result.summary', { applied: 18, skipped: 0, failed: 0 }));
	}}
>
	{#snippet template()}
		<MappingPageContent
			page="tenants"
			client={createFakeIdentityMapping({ bulkLimit: 8, failApplyRequest: 2 })}
		/>
	{/snippet}
</Story>

<Story
	name="Some tenants not changed, then retried"
	play={async ({ canvasElement }) => {
		const canvas = await chooseAndCheck(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.run', { count: 18 }) }));
		await typeAndApply('18');
		await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
		// The tenants changed stay changed; the two that were not are listed with the reason.
		await canvas.findByText(t('mc.ro.result.partial'));
		await canvas.findByText(t('mc.ro.result.summary', { applied: 16, skipped: 0, failed: 2 }));
		await userEvent.click(canvas.getByRole('button', { name: t('mc.ro.retry', { count: 2 }) }));
		await canvas.findByText(t('mc.ro.result.done'));
		await canvas.findByText(t('mc.ro.result.summary', { applied: 18, skipped: 0, failed: 0 }));
	}}
>
	{#snippet template()}
		<MappingPageContent
			page="tenants"
			client={createFakeIdentityMapping({ failOnce: ['rowan', 'sage'] })}
		/>
	{/snippet}
</Story>

<Story
	name="Some apps not counted"
	play={async ({ canvasElement }) => {
		const canvas = await chooseAndCheck(canvasElement, 90);
		// A tenant whose apps could not be counted is named, not counted as zero.
		await canvas.findByText(t('mc.ro.impact.unavailable', { names: 'Kelp' }));
	}}
>
	{#snippet template()}
		<MappingPageContent
			page="tenants"
			client={createFakeIdentityMapping({ impactUnavailable: ['kelp'] })}
		/>
	{/snippet}
</Story>

<Story
	name="Paged list, settings not readable"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		// Every page is read (8 tenants a page here): the last tenant is listed too.
		await canvas.findByRole('checkbox', { name: t('table.selectRow', { name: 'Willow' }) });
		await canvas.findByText(t('mc.failed.settings_unreadable'));
	}}
>
	{#snippet template()}
		<MappingPageContent
			page="tenants"
			client={createFakeIdentityMapping({ pageSize: 8, settingsUnreadable: ['nettle'] })}
		/>
	{/snippet}
</Story>

<Story name="With a platform default">
	{#snippet template()}
		<MappingPageContent
			page="tenants"
			client={createFakeIdentityMapping({ platformDefault: 'fms_groups' })}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<MappingPageContent page="tenants" client={createFakeIdentityMapping({ delay: 60_000 })} />
	{/snippet}
</Story>
