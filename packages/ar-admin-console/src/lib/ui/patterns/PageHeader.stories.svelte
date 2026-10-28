<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import Badge from '../primitives/Badge.svelte';
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
						'Title, one-line purpose and the page’s main action. At most one primary button here. The way back (to the list, to the parent) is a BackLink in `back`, above everything at the top start, always drawn with its frame (a quiet surface and outline) so it reads as a control and not as text; what acts or moves on is in `actions`, at the top end. Badges that say what the page is about (its kind, whether it is active) are in `badges`, under the title. Panels and boxes follow the same rule.'
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
		// The back link shows its frame without being hovered: a surface and an outline.
		const face = getComputedStyle(back);
		await expect(face.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
		await expect(face.borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
		await expect(parseFloat(face.borderTopWidth)).toBeGreaterThan(0);
		// And its frame, not its arrow, lines up with the title.
		await expect(
			Math.abs(back.getBoundingClientRect().left - title.getBoundingClientRect().left)
		).toBeLessThan(2);
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

<!-- What the page is, as badges: under the title, not above it. -->
<Story
	name="Badges under the title"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const title = canvas.getByRole('heading', { level: 1 });
		const badge = canvas.getByText(sample('flowsTitle'), { selector: '.badge' });
		await expect(badge.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			title.getBoundingClientRect().bottom
		);
	}}
>
	{#snippet template()}
		<PageHeader title={sample('flowLogin')} description={sample('flowsDesc')}>
			{#snippet badges()}<Badge>{sample('flowsTitle')}</Badge>{/snippet}
		</PageHeader>
	{/snippet}
</Story>
