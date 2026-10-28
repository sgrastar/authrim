<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import BackLink from '../primitives/BackLink.svelte';
	import Button from '../primitives/Button.svelte';
	import { sample } from '../stories/sample';
	import PageHeader from './PageHeader.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Page header',
		component: PageHeader,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Title, one-line purpose and the page’s main action. At most one primary button here. The way back (to the list, to the parent) is a BackLink in `back`, above everything at the top start; what acts or moves on is in `actions`, at the top end. Panels and boxes follow the same rule.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<PageHeader title={sample('flowsTitle')} description={sample('flowsDesc')}>
			{#snippet actions()}<Button variant="primary" icon="plus">{sample('newFlow')}</Button
				>{/snippet}
		</PageHeader>
	{/snippet}
</Story>

<Story
	name="Back at the start, action at the end"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const back = canvas.getByRole('button', { name: sample('allFlows') });
		const title = canvas.getByRole('heading', { level: 1 });
		const action = canvas.getByRole('button', { name: sample('newFlow') });
		// The way back is above the title and the action is beside it, on the other side.
		await expect(back.getBoundingClientRect().bottom).toBeLessThanOrEqual(
			title.getBoundingClientRect().top
		);
		await expect(action.getBoundingClientRect().left).toBeGreaterThan(
			title.getBoundingClientRect().left
		);
	}}
>
	{#snippet template()}
		<PageHeader title={sample('flowsTitle')} description={sample('flowsDesc')}>
			{#snippet back()}<BackLink>{sample('allFlows')}</BackLink>{/snippet}
			{#snippet actions()}<Button variant="primary" icon="plus">{sample('newFlow')}</Button
				>{/snippet}
		</PageHeader>
	{/snippet}
</Story>
