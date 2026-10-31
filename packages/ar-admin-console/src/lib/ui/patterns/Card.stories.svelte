<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '../primitives/Button.svelte';
	import { sample } from '../stories/sample';
	import Card from './Card.svelte';
	import { expect, within } from 'storybook/test';

	const { Story } = defineMeta({
		title: 'Patterns/Card',
		component: Card,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Panel for one topic. Drawn through the material tokens (`--surface-bg`, `--surface-backdrop`), so translucent themes work unchanged. `flush` removes body padding for tables and row lists.\n\n**An explanation of the box goes behind a “?” beside its title (`info`), not in a line under it.** A line such as “These are the features that use the attribute. While one cannot be deleted, the attribute cannot be deleted” explains how to read the box; it crowds the title and is read once. What a person needs in order to decide or to recover (a warning, what a button will do, why something is locked) stays visible: a callout, a hint under the field, or `description` when the line is part of what the box is.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<Card title={sample('signingKeys')} description={sample('signingKeysDesc')}>
			{#snippet actions()}<Button size="sm">{sample('rotate')}</Button>{/snippet}
			<p style="margin:0">{sample('keyExpires')}</p>
			{#snippet footer()}{sample('lastRotation')}{/snippet}
		</Card>
	{/snippet}
</Story>

<!-- What the box is, behind a "?" beside the title: the line under it is gone. -->
<Story
	name="Explanation behind a ?"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const tip = canvas.getByRole('button', { name: /Used by/ });
		await expect(tip).toBeVisible();
		// Beside the title, level with it.
		const heading = canvas.getByRole('heading', { name: 'Used by' });
		await expect(
			Math.abs(tip.getBoundingClientRect().top - heading.getBoundingClientRect().top)
		).toBeLessThan(12);
		// The explanation is the "?"'s description, not a paragraph in the box.
		await expect(
			canvas.queryByText(/While one cannot be deleted/, { selector: 'p.card__desc' })
		).toBeNull();
	}}
>
	{#snippet template()}
		<Card
			title="Used by"
			info="These are the features that use the attribute. While one cannot be deleted, the attribute cannot be deleted."
		>
			<p style="margin:0">{sample('keyExpires')}</p>
		</Card>
	{/snippet}
</Story>
