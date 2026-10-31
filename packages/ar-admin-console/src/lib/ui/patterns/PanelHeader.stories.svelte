<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, within } from 'storybook/test';
	import BackLink from '../primitives/BackLink.svelte';
	import { sample } from '../stories/sample';
	import PageHeader from './PageHeader.svelte';
	import PanelHeader from './PanelHeader.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Panel header',
		component: PanelHeader,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The head of a panel or box with a way back (one setting of a flow, returning to its overview): the BackLink above, then the title. It follows the page header’s rule one level down — back above the title, the same room under it (`--space-back`, 12px), the frame always drawn — so the two read as one pattern. Use `PageHeader` for the page itself.'
				}
			}
		}
	});
</script>

<Story
	name="With a way back"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const back = canvas.getByRole('button', { name: sample('allFlows') });
		const title = canvas.getByRole('heading', { level: 2 });
		await expect(
			Math.round(title.getBoundingClientRect().top - back.getBoundingClientRect().bottom)
		).toBe(12);
		await expect(
			Math.abs(back.getBoundingClientRect().left - title.getBoundingClientRect().left)
		).toBeLessThan(2);
	}}
>
	{#snippet template()}
		<PanelHeader title={sample('flowLogin')}>
			{#snippet back()}<BackLink>{sample('allFlows')}</BackLink>{/snippet}
		</PanelHeader>
	{/snippet}
</Story>

<Story name="Without a way back">
	{#snippet template()}
		<PanelHeader title={sample('flowLogin')} />
	{/snippet}
</Story>

<!-- The page header and the panel header leave the same room under the back link. -->
<Story
	name="Same room as the page header"
	play={async ({ canvasElement }) => {
		const gap = (root: Element) => {
			const back = root.querySelector('button')!;
			const title = root.querySelector('h1, h2')!;
			return Math.round(title.getBoundingClientRect().top - back.getBoundingClientRect().bottom);
		};
		const [page, panel] = [
			canvasElement.querySelector('.page-head')!,
			canvasElement.querySelector('.panel-head')!
		];
		await expect(gap(page)).toBe(gap(panel));
	}}
>
	{#snippet template()}
		<PageHeader title={sample('flowsTitle')}>
			{#snippet back()}<BackLink>{sample('allFlows')}</BackLink>{/snippet}
		</PageHeader>
		<PanelHeader title={sample('flowLogin')}>
			{#snippet back()}<BackLink>{sample('allFlows')}</BackLink>{/snippet}
		</PanelHeader>
	{/snippet}
</Story>
