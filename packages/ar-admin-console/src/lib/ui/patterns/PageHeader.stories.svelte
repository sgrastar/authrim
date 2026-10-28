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
						'Title, one-line purpose and the page’s main action. At most one primary button here. The way back (to the list, to the parent) is a BackLink in `back`, above everything at the top start, always drawn with its frame (a quiet surface and outline) so it reads as a control and not as text; what acts or moves on is in `actions`, at the top end. Badges that say what the page is (its kind, whether it is active) are in `badges`, at the top end of the title row: a detail page gathers its status at the top right. Panels and boxes follow the same rule.'
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

<!-- What the page is, as badges: at the top end of the title row, level with the title. -->
<Story
	name="Badges at the top end"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const title = canvas.getByRole('heading', { level: 1 });
		const badge = canvas.getByText(sample('flowsTitle'), { selector: '.badge' });
		const t = title.getBoundingClientRect();
		const b = badge.getBoundingClientRect();
		// On the title's row, not under it …
		await expect(b.top).toBeLessThan(t.bottom);
		// … at the far end, away from the title's text.
		await expect(b.left).toBeGreaterThan(t.left + 200);
		// Level with the first line of the title.
		await expect(Math.abs(b.top + b.height / 2 - (t.top + t.height / 2))).toBeLessThan(10);
	}}
>
	{#snippet template()}
		<div style="max-width: 900px">
			<PageHeader title={sample('flowLogin')} description={sample('flowsDesc')}>
				{#snippet badges()}<Badge>{sample('flowsTitle')}</Badge>{/snippet}
			</PageHeader>
		</div>
	{/snippet}
</Story>
