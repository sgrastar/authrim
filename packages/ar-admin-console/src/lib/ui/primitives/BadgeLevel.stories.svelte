<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import Badge from './Badge.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Badge/Levels',
		component: Badge,
		tags: ['autodocs'],
		parameters: { a11y: { test: 'error' } }
	});
</script>

<Story name="Level 1">
	{#snippet template()}<Badge variant="level" tone="info">Level 1</Badge>{/snippet}
</Story>

<Story name="Level 2">
	{#snippet template()}<Badge variant="level" tone="warning">Level 2</Badge>{/snippet}
</Story>

<Story name="Level 3">
	{#snippet template()}<Badge variant="level" tone="danger">Level 3</Badge>{/snippet}
</Story>

<Story
	name="All levels"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		for (const label of ['Level 1', 'Level 2', 'Level 3']) {
			const badge = canvas.getByText(label);
			await expect(badge).toBeVisible();
			await expect(getComputedStyle(badge).borderRadius).toBe('0px');
		}
	}}
>
	{#snippet template()}
		<div style="display:flex;flex-wrap:wrap;gap:8px">
			<Badge variant="level" tone="info">Level 1</Badge>
			<Badge variant="level" tone="warning">Level 2</Badge>
			<Badge variant="level" tone="danger">Level 3</Badge>
		</div>
	{/snippet}
</Story>
