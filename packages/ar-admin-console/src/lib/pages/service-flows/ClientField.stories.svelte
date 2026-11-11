<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ClientFieldHarness from './ClientFieldHarness.svelte';

	const { Story } = defineMeta({
		title: 'Pages/Service flows/Client choice',
		component: ClientFieldHarness,
		tags: ['autodocs', 'draft'],
		parameters: {
			docs: {
				description: {
					component:
						'Choosing one of the tenant’s services (clients) from a list, as after sign-up the person can go on to sign in to one. A tenant with none, an admin who may not see them, and a list that could not be read are told apart.'
				}
			}
		}
	});
</script>

<Story
	name="Some to choose from"
	args={{ answer: 'some' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const service = await canvas.findByRole('combobox', { name: /Service to sign in to/ });
		await expect(
			[...(service as HTMLSelectElement).options].map((option) => option.value)
		).toContain('client_member_app');
	}}
></Story>

<!-- Read, and there is none: not an error. -->
<Story
	name="None yet"
	args={{ answer: 'none' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('af.client.none'))).toBeInTheDocument();
		await expect(canvas.queryByText(t('af.client.loadFailed'))).toBeNull();
		await expect(canvas.queryByRole('combobox')).toBeNull();
	}}
></Story>

<Story
	name="Not allowed to see them"
	args={{ answer: 'denied' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('af.client.denied'))).toBeInTheDocument();
		await expect(canvas.queryByRole('button', { name: t('common.retry') })).toBeNull();
	}}
></Story>

<Story
	name="Could not be read"
	args={{ answer: 'failed' }}
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(t('af.client.loadFailed'))).toBeInTheDocument();
		await expect(canvas.getByRole('button', { name: t('common.retry') })).toBeInTheDocument();
	}}
></Story>
