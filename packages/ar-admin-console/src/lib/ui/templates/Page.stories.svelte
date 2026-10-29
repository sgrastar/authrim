<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '../primitives/Button.svelte';
	import Card from '../patterns/Card.svelte';
	import EmptyState from '../patterns/EmptyState.svelte';
	import PageHeader from '../patterns/PageHeader.svelte';
	import { sample } from '../stories/sample';
	import SaveModelDemo from '../stories/SaveModelDemo.svelte';
	import { expect } from 'storybook/test';
	import Page from './Page.svelte';

	const { Story } = defineMeta({
		title: 'Templates/Page',
		component: Page,
		tags: ['autodocs'],
		parameters: {
			layout: 'fullscreen',
			docs: {
				description: {
					component:
						'Page body. Every page uses the same 1100px maximum width and shrinks with the viewport. It is start-aligned so the content edge never jumps; children reveal top to bottom when the page is entered.\n\n`withFlow`: a page with a flow diagram beside its settings (a service flow) hides the left nav, so its frame is wider by the nav’s width: its right edge is where every other page’s frame ends.'
				}
			}
		}
	});
</script>

<Story name="Settings">
	{#snippet template()}
		<Page>
			<PageHeader title={sample('authMethodsTitle')} description={sample('authMethodsDesc')} />
			<SaveModelDemo />
		</Page>
	{/snippet}
</Story>

<Story name="List">
	{#snippet template()}
		<Page>
			<PageHeader title={sample('usersTitle')} description={sample('usersDesc')}>
				{#snippet actions()}<Button variant="primary" icon="plus">{sample('createUser')}</Button
					>{/snippet}
			</PageHeader>
			<Card flush>
				<EmptyState icon="users" title={sample('emptyTitle')} description={sample('emptyDesc')} />
			</Card>
		</Page>
	{/snippet}
</Story>

<!-- A flow diagram beside the settings: the frame is wider by the left nav's width. -->
<Story
	name="With a flow diagram"
	play={async ({ canvasElement }) => {
		const page = canvasElement.querySelector<HTMLElement>('.page')!;
		// 1100 (the frame) + 252 (the left nav, which is hidden here).
		await expect(getComputedStyle(page).maxWidth).toBe('1352px');
	}}
>
	{#snippet template()}
		<Page withFlow>
			<PageHeader title={sample('authMethodsTitle')} description={sample('authMethodsDesc')} />
			<SaveModelDemo />
		</Page>
	{/snippet}
</Story>
