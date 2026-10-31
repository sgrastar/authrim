<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, fn, userEvent, within } from 'storybook/test';
	import { sample } from '../stories/sample';
	import BackLink from './BackLink.svelte';

	const { Story } = defineMeta({
		title: 'Primitives/Back link',
		component: BackLink,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'The way back from where you are: to the list, to the overview, to the parent. It sits at the **top start**, above the heading it leaves (Page header has a `back` slot for it; a panel or box puts it above its title), while what acts or moves on sits at the **top end**. A link when it leads to a page (`href`), a button when it only changes what is shown (`onclick`). The arrow mirrors in right-to-left layouts.'
				}
			}
		}
	});
</script>

<Story
	name="Button"
	args={{ onclick: fn() }}
	play={async ({ canvasElement, args }) => {
		await userEvent.click(within(canvasElement).getByRole('button', { name: sample('allFlows') }));
		await expect(args.onclick).toHaveBeenCalled();
	}}
>
	{#snippet template(args)}<BackLink onclick={args.onclick}>{sample('allFlows')}</BackLink
		>{/snippet}
</Story>

<Story name="Link" args={{ href: '/admin/applications/all' }}>
	{#snippet template(args)}<BackLink href={args.href}>{sample('allFlows')}</BackLink>{/snippet}
</Story>
