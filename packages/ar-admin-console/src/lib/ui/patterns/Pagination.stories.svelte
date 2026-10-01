<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect, userEvent, within } from 'storybook/test';
	import PaginationDemo from '../stories/PaginationDemo.svelte';
	import Pagination from './Pagination.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Pagination',
		component: Pagination,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Paging for long lists: the visible range, page buttons (first, last, the current page with neighbours, and gaps — the button count stays constant while paging so nothing jumps under the pointer) and an optional rows-per-page choice. 1-based; the page decides whether to page on the client or pass `page`/`pageSize` to the API. Previous/next arrows mirror in RTL.'
				}
			}
		}
	});
</script>

<Story
	name="Default"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getAllByRole('button').at(-1)!);
		await expect(canvas.getByRole('button', { current: 'page' })).toHaveTextContent('2');
	}}
>
	{#snippet template()}<PaginationDemo />{/snippet}
</Story>

<Story name="In the middle, with rows per page">
	{#snippet template()}<PaginationDemo initialPage={31} pageSizes={[20, 50, 100]} />{/snippet}
</Story>

<Story name="Few pages">
	{#snippet template()}<PaginationDemo total={48} />{/snippet}
</Story>
