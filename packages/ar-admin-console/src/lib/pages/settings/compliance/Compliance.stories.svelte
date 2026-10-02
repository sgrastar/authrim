<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { createFakeCompliance } from '$lib/api/fake/compliance-fake';
	import { t } from '$lib/i18n/i18n.svelte';
	import ComplianceSettings from './ComplianceSettings.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Settings/Compliance',
		component: ComplianceSettings,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Settings → Compliance: the compliance status (each check a fact read from what Authrim enforces, with the frameworks it supports), access reviews (decide each item, then complete to apply revocations), reports (generated now, kept encrypted for 30 days) and how long each kind of data is kept. Built on `/api/admin/compliance/*` and `/api/admin/data-retention/*`; the stories use an in-memory API.'
				}
			}
		}
	});

	const TENANT = 'acme';
</script>

<Story name="Overview">
	{#snippet template()}
		<ComplianceSettings client={createFakeCompliance()} tenantId={TENANT} />
	{/snippet}
</Story>

<Story name="All compliant">
	{#snippet template()}
		<ComplianceSettings client={createFakeCompliance({ status: 'compliant' })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Status unavailable"
	play={async ({ canvasElement }) => {
		await within(canvasElement).findByText(t('cmp.unavailable'));
	}}
>
	{#snippet template()}
		<ComplianceSettings
			client={createFakeCompliance({ statusUnavailable: true })}
			tenantId={TENANT}
		/>
	{/snippet}
</Story>

<Story name="Loading">
	{#snippet template()}
		<ComplianceSettings client={createFakeCompliance({ delay: 60_000 })} tenantId={TENANT} />
	{/snippet}
</Story>

<Story
	name="Access review"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('cmp.review.open') }));
		// Completing needs every item decided first.
		await userEvent.click(await canvas.findByRole('button', { name: t('cmp.complete') }));
		const dialog = await within(document.body).findByRole('dialog');
		await userEvent.click(within(dialog).getByRole('button', { name: t('cmp.complete') }));
		await canvas.findByText(t('cmp.complete.undecided', { count: 3 }));
		// Revoke an undecided item, with a reason.
		await userEvent.click(
			await canvas.findByRole('checkbox', { name: t('table.selectRow', { name: 'Chen Wei' }) })
		);
		await userEvent.type(
			await canvas.findByRole('textbox', { name: t('cmp.justification') }),
			'Left the team'
		);
		await userEvent.click(canvas.getByRole('button', { name: t('cmp.revoke') }));
		await waitFor(() =>
			expect(
				canvas.getByText(
					t('cmp.review.counts', {
						reviewed: 3,
						total: 5,
						approved: 1,
						revoked: 2
					})
				)
			).toBeTruthy()
		);
	}}
>
	{#snippet template()}
		<ComplianceSettings client={createFakeCompliance()} tenantId={TENANT} initialTab="reviews" />
	{/snippet}
</Story>

<Story name="No reviews or reports">
	{#snippet template()}
		<ComplianceSettings
			client={createFakeCompliance({ empty: true })}
			tenantId={TENANT}
			initialTab="reviews"
		/>
	{/snippet}
</Story>

<Story name="Reports">
	{#snippet template()}
		<ComplianceSettings client={createFakeCompliance()} tenantId={TENANT} initialTab="reports" />
	{/snippet}
</Story>

<Story
	name="Data retention"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(await canvas.findByRole('button', { name: t('cmp.ret.change') }));
		const dialog = await within(document.body).findByRole('dialog');
		const days = within(dialog).getByRole('textbox', { name: t('cmp.ret.lookupDays') });
		await userEvent.clear(days);
		await userEvent.type(days, '90');
		await userEvent.click(within(dialog).getByRole('button', { name: t('cmp.save') }));
		// Shortening is confirmed against the retention read now.
		await within(dialog).findByText(t('cmp.ret.lookupShorten', { from: 180, to: 90 }));
	}}
>
	{#snippet template()}
		<ComplianceSettings client={createFakeCompliance()} tenantId={TENANT} initialTab="retention" />
	{/snippet}
</Story>
